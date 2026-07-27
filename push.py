"""Web Push (VAPID, RFC 8292) with pure-stdlib crypto.

Sends PAYLOAD-LESS push messages: the push service (FCM/Mozilla/…) only wakes
the service worker, which then fetches /api/push/pending to learn what to show.
Payload-less pushes need no message encryption (RFC 8291), so the only crypto
required is ES256 (ECDSA over P-256) to sign the VAPID JWT — implemented below
with integer math from the standard library. Keys are generated once and kept
in vapid.json next to the server.
"""
import base64
import hashlib
import json
import os
import secrets
import ssl
import time
import urllib.parse
import urllib.request

# --------------------------------------------------------------------------
# NIST P-256 curve parameters
# --------------------------------------------------------------------------
_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
_A = _P - 3
_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
_GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296
_GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5
_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_G = (_GX, _GY)


def _pt_add(p1, p2):
    """Affine point addition (None = point at infinity)."""
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2 and (y1 + y2) % _P == 0:
        return None
    if p1 == p2:
        lam = (3 * x1 * x1 + _A) * pow(2 * y1, -1, _P) % _P
    else:
        lam = (y2 - y1) * pow(x2 - x1, -1, _P) % _P
    x3 = (lam * lam - x1 - x2) % _P
    y3 = (lam * (x1 - x3) - y1) % _P
    return (x3, y3)


def _pt_mul(k, pt):
    """Double-and-add scalar multiplication."""
    result = None
    addend = pt
    while k:
        if k & 1:
            result = _pt_add(result, addend)
        addend = _pt_add(addend, addend)
        k >>= 1
    return result


def _on_curve(pt):
    if pt is None:
        return False
    x, y = pt
    return (y * y - (x * x * x + _A * x + _B)) % _P == 0


def _b64u(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _b64u_json(obj):
    return _b64u(json.dumps(obj, separators=(",", ":")).encode())


def _sign_es256(priv_int, message):
    """ECDSA-SHA256 over P-256; returns JOSE (r||s, 64 bytes)."""
    h = int.from_bytes(hashlib.sha256(message).digest(), "big")
    while True:
        k = secrets.randbelow(_N - 1) + 1
        R = _pt_mul(k, _G)
        r = R[0] % _N
        if r == 0:
            continue
        s = pow(k, -1, _N) * (h + r * priv_int) % _N
        if s == 0:
            continue
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def _verify_es256(pub_pt, message, sig):
    """Signature check (used by the startup self-test only)."""
    if len(sig) != 64:
        return False
    r = int.from_bytes(sig[:32], "big")
    s = int.from_bytes(sig[32:], "big")
    if not (1 <= r < _N and 1 <= s < _N):
        return False
    h = int.from_bytes(hashlib.sha256(message).digest(), "big")
    w = pow(s, -1, _N)
    u1 = h * w % _N
    u2 = r * w % _N
    X = _pt_add(_pt_mul(u1, _G), _pt_mul(u2, pub_pt))
    return X is not None and X[0] % _N == r


# --------------------------------------------------------------------------
# Key management
# --------------------------------------------------------------------------
def load_or_create_keys(path):
    """Load VAPID keys from `path`, generating (and self-testing) on first run.

    CRITICAL: only a genuinely ABSENT file triggers key generation. If the file
    exists but can't be parsed (corrupt/truncated/half-written), we RAISE rather
    than silently rotating the identity — a rotated VAPID key invalidates every
    existing browser subscription. Writes are atomic (temp + os.replace) so a
    crash mid-write can never leave a torn file that reads as "corrupt".

    Returns {"d": int, "pub": (x, y), "public_b64": str}.
    """
    # Cloud path: a VAPID_JSON env var ({"d","x","y"} hex, same shape as vapid.json)
    # gives a STABLE key across redeploys on an ephemeral filesystem — so existing
    # browser subscriptions keep working without a persistent disk. Checked first.
    env_json = os.environ.get("VAPID_JSON")
    if env_json:
        data = json.loads(env_json)
        d = int(data["d"], 16)
        pub = (int(data["x"], 16), int(data["y"], 16))
        if not _on_curve(pub):
            raise ValueError("VAPID_JSON public key is not on the P-256 curve")
        public_b64 = _b64u(b"\x04" + pub[0].to_bytes(32, "big") + pub[1].to_bytes(32, "big"))
        return {"d": d, "pub": pub, "public_b64": public_b64}
    if os.path.exists(path):
        with open(path) as f:                    # let a parse error propagate — do NOT rotate
            data = json.load(f)
        d = int(data["d"], 16)
        pub = (int(data["x"], 16), int(data["y"], 16))
        if not _on_curve(pub):
            raise ValueError("stored VAPID public key is not on the P-256 curve")
    else:
        d = secrets.randbelow(_N - 1) + 1
        pub = _pt_mul(d, _G)
        probe = b"vapid-self-test"               # self-test the fresh keypair before trusting it
        assert _verify_es256(pub, probe, _sign_es256(d, probe)), "ECDSA self-test failed"
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"d": format(d, "x"),
                       "x": format(pub[0], "x"),
                       "y": format(pub[1], "x")}, f)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.chmod(tmp, 0o600)
        except Exception:
            pass
        os.replace(tmp, path)                     # atomic
    public_b64 = _b64u(b"\x04" + pub[0].to_bytes(32, "big") + pub[1].to_bytes(32, "big"))
    return {"d": d, "pub": pub, "public_b64": public_b64}


def self_test(keys):
    """Round-trip sign/verify with the loaded keys. True if crypto is sound."""
    msg = b"news-intel push self-test " + secrets.token_bytes(8)
    return _verify_es256(keys["pub"], msg, _sign_es256(keys["d"], msg))


# --------------------------------------------------------------------------
# VAPID + send
# --------------------------------------------------------------------------
_JWT_CACHE = {}   # audience -> (jwt, expiry_ts); JWTs are reused until near expiry


def _vapid_jwt(keys, audience, subject):
    cached = _JWT_CACHE.get(audience)
    now = time.time()
    if cached and cached[1] - now > 600:
        return cached[0]
    header = _b64u_json({"typ": "JWT", "alg": "ES256"})
    exp = int(now) + 12 * 3600          # max allowed is 24h
    claims = _b64u_json({"aud": audience, "exp": exp, "sub": subject})
    signing_input = (header + "." + claims).encode()
    jwt = header + "." + claims + "." + _b64u(_sign_es256(keys["d"], signing_input))
    _JWT_CACHE[audience] = (jwt, exp)
    return jwt


def send_push(keys, endpoint, subject="mailto:admin@localhost", ttl=86400, timeout=10):
    """POST a payload-less push message. Returns (status_code, detail).

    2xx = accepted; 404/410 = subscription gone (caller should drop it);
    0 = network / other error.
    """
    try:
        parsed = urllib.parse.urlparse(endpoint)
        if parsed.scheme != "https":
            return (0, "endpoint must be https")
        audience = parsed.scheme + "://" + parsed.netloc
        jwt = _vapid_jwt(keys, audience, subject)
        req = urllib.request.Request(endpoint, data=b"", method="POST", headers={
            "TTL": str(ttl),
            "Urgency": "high",
            "Content-Length": "0",
            "Authorization": "vapid t=" + jwt + ", k=" + keys["public_b64"],
        })
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return (resp.status, "ok")
    except urllib.error.HTTPError as e:
        return (e.code, str(e))
    except Exception as e:
        return (0, str(e))
