"""
Lapisan autentikasi aplikasi (OAuth2 authorization-code + PKCE) untuk Sensatype Font Tool.

Model: backend Sensatype yang MENEGAKKAN login (password + OTP email + PIN). Font tool
TIDAK menyentuh DB Sensatype dan tak menyimpan secret apa pun — ia hanya:
  1. memulai login PKCE (S256) + `state` (anti-CSRF) di browser sistem,
  2. menukar `code` -> token via POST /app-auth/token,
  3. menyimpan token HANYA di OS keyring (tak pernah di file/log/URL),
  4. mengintrospeksi access token via POST /app-auth/verify (BUKAN verifikasi JWT lokal),
     sehingga logout / penonaktifan akun berlaku ~real-time.

Sengaja BACKEND-CENTRIC: token tinggal di keyring sisi Python, tak pernah dikirim ke
browser. Middleware menggerbangi endpoint lokal dgn mengintrospeksi token tersimpan.
Saat pindah ke Electron, hanya cara membuka browser + menangkap redirect (loopback
sensatype://) yang berubah; modul ini tetap.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import threading
import time
from urllib.parse import urlencode

import httpx
import keyring
from fastapi import Depends, HTTPException, Request

# ── Konfigurasi (via ENV; jangan hardcode rahasia) ─────────────────────────────
API_BASE = os.environ.get("SENSATYPE_API_BASE", "https://project.sensatype.com/api").rstrip("/")
LOGIN_URL = os.environ.get("SENSATYPE_LOGIN_URL", "https://project.sensatype.com/login")
# Mode browser/SPA (default): route React /auth/callback (POST → JSON).
# Mode Electron/loopback (RFC 8252): set ke http://127.0.0.1:8000/api/auth/callback
# (uvicorn melayani GET → HTML). Nilai ini HARUS ada di allowlist redirect_uri server Sensatype.
REDIRECT_URI = os.environ.get("SENSATYPE_REDIRECT_URI", "http://localhost:5173/auth/callback")
DEVICE = os.environ.get("SENSATYPE_DEVICE", "font-tool")
# Default AUTH AKTIF. Untuk dev fitur font tanpa login: SENSATYPE_AUTH_DISABLED=1
AUTH_DISABLED = os.environ.get("SENSATYPE_AUTH_DISABLED", "0") == "1"

# Peta role -> kapabilitas app (satu tempat, mudah diubah). Samakan dgn app/src/auth.ts.
ADMIN_ROLES = {"admin", "atasan"}
KNOWN_ROLES = {"admin", "atasan", "senior", "member", "viewer_eksekutif"}
# Hak masuk Font Tool. Sumber utama: field per-akun dari /app-auth/verify (Sensatype mengatur
# hak akses per akun). Nama field default `access_font_tool` (override via env bila berubah).
# Fallback bila field tak ada di response: allowlist peran SENSATYPE_ALLOWED_ROLES (kosong=semua boleh).
ACCESS_FIELD = os.environ.get("SENSATYPE_ACCESS_FIELD", "access_font_tool")
ACCESS_ROLES = {r for r in (os.environ.get("SENSATYPE_ALLOWED_ROLES") or "").split(",") if r.strip()}


def _access_allowed(role, verify_res):
    if isinstance(verify_res, dict) and ACCESS_FIELD in verify_res:
        return bool(verify_res[ACCESS_FIELD])  # keputusan per-akun dari server Sensatype
    if not ACCESS_ROLES:
        return True                            # field absen & belum ada allowlist → semua boleh
    return role in ACCESS_ROLES

_KR_SERVICE = "SensatypeFontTool"
_KR_USER = "app-auth"

_lock = threading.Lock()               # lindungi baca/tulis token + _pending (CEPAT, tak boleh tahan I/O jaringan)
_refresh_lock = threading.Lock()       # single-flight refresh: satu thread refresh, lain menunggu (bukan _lock)
_pending: dict[str, dict] = {}         # state -> {verifier, redirect_uri, ts}
_verify_cache: dict[str, tuple] = {}   # accessToken -> (result, ts)
_VERIFY_TTL = 45.0
_PENDING_TTL = 600.0
_HTTP_TIMEOUT = 15.0

if AUTH_DISABLED:
    import logging
    logging.getLogger("uvicorn.error").warning(
        "⚠️  SENSATYPE_AUTH_DISABLED=1 — AUTENTIKASI & GERBANG ROLE MATI (mode dev). "
        "JANGAN dipakai/didistribusikan untuk produksi.")


# ── PKCE ───────────────────────────────────────────────────────────────────────
def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _new_pkce() -> tuple[str, str]:
    verifier = _b64url(secrets.token_bytes(64))  # ~86 char (dalam rentang 43..128)
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge


# ── Penyimpanan token (OS keyring) ─────────────────────────────────────────────
def _save_tokens(d: dict) -> None:
    keyring.set_password(_KR_SERVICE, _KR_USER, json.dumps(d))
    _verify_cache.clear()


def _load_tokens() -> dict | None:
    raw = keyring.get_password(_KR_SERVICE, _KR_USER)
    return json.loads(raw) if raw else None


def _clear_tokens() -> None:
    try:
        keyring.delete_password(_KR_SERVICE, _KR_USER)
    except keyring.errors.PasswordDeleteError:
        pass
    _verify_cache.clear()


# ── HTTP ke Sensatype (bungkus {data, error}) ──────────────────────────────────
def _post(path: str, body: dict) -> dict:
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT) as c:
            r = c.post(f"{API_BASE}{path}", json=body)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Tak bisa menghubungi server auth: {e}")
    if r.status_code == 429:
        raise HTTPException(429, "Terlalu banyak percobaan — coba lagi nanti")
    try:
        payload = r.json()
    except ValueError:
        raise HTTPException(502, "Respons auth tidak valid")
    err = payload.get("error")
    if err:
        code = err.get("code")
        if code == "app_auth_disabled":
            raise HTTPException(503, "app_auth_disabled")
        raise HTTPException(400, err.get("message") or code or "Auth gagal")
    return payload.get("data") or {}


def _store_from_token_response(data: dict) -> None:
    """Simpan hasil /token atau /refresh (rotate: refresh lama sudah dicabut server)."""
    expires_in = float(data.get("expiresIn") or 1800)
    _save_tokens({
        "accessToken": data["accessToken"],
        "refreshToken": data["refreshToken"],
        "role": data.get("role"),
        "expiresAt": time.time() + expires_in,
    })


# ── Alur login ─────────────────────────────────────────────────────────────────
def _prune_pending() -> None:
    now = time.time()
    for k in [k for k, v in _pending.items() if now - v["ts"] > _PENDING_TTL]:
        _pending.pop(k, None)


def start_login() -> dict:
    """Buat PKCE + state, kembalikan URL login sistem untuk dibuka browser."""
    verifier, challenge = _new_pkce()
    state = _b64url(secrets.token_bytes(24))
    with _lock:
        _prune_pending()
        _pending[state] = {"verifier": verifier, "redirect_uri": REDIRECT_URI, "ts": time.time()}
    q = urlencode({
        "redirect_uri": REDIRECT_URI,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
    })
    return {"loginUrl": f"{LOGIN_URL}?{q}"}


def complete_login(code: str, state: str) -> dict:
    """Tukar code -> token. Validasi `state` (anti-CSRF) & pasangkan code_verifier-nya."""
    with _lock:
        pend = _pending.pop(state, None)
    if not pend or time.time() - pend["ts"] > _PENDING_TTL:
        raise HTTPException(400, "State tidak valid atau kedaluwarsa — ulangi login")
    data = _post("/app-auth/token", {
        "code": code,
        "redirect_uri": pend["redirect_uri"],
        "code_verifier": pend["verifier"],
        "device": DEVICE,
    })
    with _lock:
        _store_from_token_response(data)
    return {"authenticated": True, "role": data.get("role")}


def logout() -> dict:
    with _lock:
        tok = _load_tokens()
        refresh = tok.get("refreshToken") if tok else None
    if refresh:
        try:
            _post("/app-auth/logout", {"refreshToken": refresh})  # cabut seluruh family
        except HTTPException:
            pass  # tetap hapus lokal walau server tak terjangkau
    with _lock:
        _clear_tokens()
    return {"authenticated": False}


# ── Akses + introspeksi ────────────────────────────────────────────────────────
def get_access_token() -> str | None:
    """Access token valid; refresh (rotate) bila sisa umur < 60 dtk. Thread-safe.
    Network refresh dilakukan di LUAR _lock (single-flight via _refresh_lock) → refresh yang lambat
    (server auth down, timeout 15dtk) TIDAK membekukan seluruh request/login yang cuma butuh baca token."""
    with _lock:  # baca cepat
        tok = _load_tokens()
        if not tok:
            return None
        if time.time() < tok["expiresAt"] - 60:
            return tok["accessToken"]
    # perlu refresh — hanya SATU thread yang benar-benar refresh; lain menunggu _refresh_lock lalu cek ulang
    with _refresh_lock:
        with _lock:
            tok = _load_tokens()
            if tok and time.time() < tok["expiresAt"] - 60:  # thread lain sudah refresh selagi kita menunggu
                return tok["accessToken"]
            refresh = tok.get("refreshToken") if tok else None
        if not refresh:
            with _lock:
                _clear_tokens()
            return None
        try:
            data = _post("/app-auth/refresh", {"refreshToken": refresh})  # network DI LUAR _lock
        except HTTPException:
            with _lock:
                _clear_tokens()  # refresh ditolak/kedaluwarsa/dicabut -> paksa login ulang
            return None
        with _lock:
            _store_from_token_response(data)
            return data["accessToken"]


def _verify(access_token: str) -> dict:
    now = time.time()
    cached = _verify_cache.get(access_token)
    if cached and now - cached[1] < _VERIFY_TTL:
        return cached[0]
    _verify_cache.pop(access_token, None)  # buang entri kedaluwarsa sebelum isi baru (cegah tumbuh tanpa batas)
    data = _post("/app-auth/verify", {"accessToken": access_token})
    _verify_cache[access_token] = (data, now)
    return data


def current_session() -> dict:
    """-> {authenticated, userId?, role?, allowed?}. Introspeksi token tersimpan (cache singkat).
    `allowed` = punya hak masuk Font Tool (fitur #2 — kalau False, UI tampilkan 'akses ditolak')."""
    if AUTH_DISABLED:
        return {"authenticated": True, "userId": "dev", "name": "Developer",
                "email": "dev@sensatype.local", "avatarUrl": None, "role": "admin", "allowed": True}
    at = get_access_token()
    if not at:
        return {"authenticated": False}
    try:
        res = _verify(at)
    except HTTPException:
        return {"authenticated": False}
    if not res.get("valid"):
        return {"authenticated": False}
    role = res.get("role")
    # name/email/avatarUrl dari respons /verify Sensatype (opsional — UI menampilkan bila ada).
    return {"authenticated": True, "userId": res.get("userId"), "role": role,
            "name": res.get("name") or res.get("fullName") or res.get("displayName"),
            "email": res.get("email"),
            "avatarUrl": res.get("avatarUrl") or res.get("avatar") or res.get("photoURL"),
            "allowed": _access_allowed(role, res)}


# ── Dependency FastAPI ─────────────────────────────────────────────────────────
def require_auth(request: Request) -> dict:
    sess = current_session()
    if not sess.get("authenticated"):
        raise HTTPException(401, "Perlu login")
    request.state.userId = sess.get("userId")
    request.state.role = sess.get("role")
    return sess


def require_role(*roles: str):
    allowed = set(roles) or ADMIN_ROLES

    def dep(sess: dict = Depends(require_auth)) -> dict:
        if sess.get("role") not in allowed:
            raise HTTPException(403, "Role tidak diizinkan untuk aksi ini")
        return sess

    return dep
