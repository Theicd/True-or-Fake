"""
Storage Module — Blossom Upload + Nostr Relay
===============================================
מודול אחסון מבוזר עבור Media Analyzer V2.
מבוסס על הלוגיקה של SOS-main (blossom.js + config.js + compose.js).

שני שירותים:
  1. Blossom — העלאת קבצים (תמונות/וידאו) לשרתי Blossom
  2. Relay  — שמירת מידע (JSON) לריליי Nostr

תלויות:
  pip install httpx websockets secp256k1
  (או: pip install httpx websockets coincurve)
"""
import os
import json
import time
import hashlib
import logging
import asyncio
from typing import Optional, Dict, List, Any
from pathlib import Path

import httpx

log = logging.getLogger("storage")


# ═══════════════════════════════════════════════════════════
#  CONFIGURATION — שרתים וריליים (מועתק מ-config.js של SOS)
# ═══════════════════════════════════════════════════════════

# ── שרתי Blossom (סדר עדיפות — הראשון שעובד) ──
BLOSSOM_SERVERS = [
    "https://files.sovbit.host",       # עובד עם CORS — נבדק ב-SOS
    "https://blossom.band",            # דורש auth NIP-24242
    "https://blossom.primal.net",
    "https://blossom.nostr.build",
    "https://nostr.build",
]

# ── נתיבי העלאה אפשריים (שרתים שונים משתמשים בנתיבים שונים) ──
UPLOAD_PATHS = ["/upload", "/api/v1/upload", "/api/upload", "/media"]

# ── Fallback: void.cat (אם כל שרתי Blossom נכשלים) ──
VOID_CAT_ENDPOINT = "https://void.cat/upload"

# ── ריליי Nostr (מועתק מ-config.js של SOS) ──
RELAY_URLS = [
    "wss://relay.damus.io",
    "wss://relay.snort.social",
    "wss://nos.lol",
    "wss://purplerelay.com",
    "wss://relay.nostr.band",
]

# ── תג רשת (לסינון אירועים) ──
NETWORK_TAG = "media-analyzer"

# ── Nostr Event Kinds ──
KIND_NOTE = 1           # הודעה רגילה
KIND_GROUP = 30023      # מאמר/קבוצה (NIP-23)
KIND_ANALYSIS = 37701   # kind מותאם לתוצאות ניתוח
KIND_HISTORY = 37702    # kind מותאם להיסטוריית ניתוחים

# ── מפתחות (מ-environment variables — לא hardcoded!) ──
def _get_private_key() -> str:
    """קריאת מפתח פרטי מ-env — חובה לחתימת אירועים."""
    return os.getenv("NOSTR_PRIVATE_KEY", "")

def _get_public_key() -> str:
    """קריאת מפתח ציבורי מ-env."""
    return os.getenv("NOSTR_PUBLIC_KEY", "")


# ═══════════════════════════════════════════════════════════
#  BLOSSOM — העלאת קבצים לשרתי Blossom
#  מבוסס על blossom.js של SOS-main
# ═══════════════════════════════════════════════════════════

def _sha256_hex(data: bytes) -> str:
    """חישוב SHA-256 hex של קובץ — זהה ל-sha256Hex ב-blossom.js."""
    return hashlib.sha256(data).hexdigest()


def _create_auth_header(file_hash: str) -> Optional[str]:
    """
    יצירת Authorization header בסגנון NIP-24242.
    אם אין מפתחות — מחזיר None (שרתים מסוימים עובדים בלי auth).
    """
    private_key = _get_private_key()
    public_key = _get_public_key()
    if not private_key or not public_key:
        return None

    try:
        # ── ניסיון חתימה עם secp256k1 ──
        now = int(time.time())
        event = {
            "kind": 24242,
            "content": "Upload media file",
            "tags": [
                ["t", "upload"],
                ["expiration", str(now + 86400)],
                ["x", file_hash],
            ],
            "created_at": now,
            "pubkey": public_key,
        }
        signed = _sign_event(event, private_key)
        if signed:
            import base64
            header = "Nostr " + base64.b64encode(
                json.dumps(signed).encode()
            ).decode()
            return header
    except Exception as e:
        log.warning(f"Auth header creation failed: {e}")
    return None


async def upload_to_blossom(file_input) -> str:
    """
    העלאת קובץ לשרתי Blossom — מנסה כל שרת + כל נתיב + PUT/POST.
    מבוסס על uploadToBlossom() ב-blossom.js של SOS-main.

    Args:
        file_input: נתיב לקובץ (str/Path) או bytes

    Returns:
        URL של הקובץ שהועלה

    Raises:
        RuntimeError אם כל השרתים נכשלו
    """
    # ── קריאת הקובץ ──
    if isinstance(file_input, (str, Path)):
        file_path = Path(file_input)
        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {file_input}")
        data = file_path.read_bytes()
        content_type = _guess_content_type(str(file_path))
    elif isinstance(file_input, bytes):
        data = file_input
        content_type = "application/octet-stream"
    else:
        raise TypeError(f"Expected str, Path, or bytes, got {type(file_input)}")

    file_hash = _sha256_hex(data)
    auth_header = _create_auth_header(file_hash)
    size_mb = len(data) / (1024 * 1024)
    log.info(f"[BLOSSOM] Uploading {size_mb:.2f}MB, hash={file_hash[:16]}...")

    errors = []

    # ── ניסיון כל שרת Blossom ──
    async with httpx.AsyncClient(timeout=30) as client:
        for server in BLOSSOM_SERVERS:
            for path in UPLOAD_PATHS:
                for method in ["PUT", "POST"]:
                    try:
                        url = f"{server.rstrip('/')}{path}"
                        headers = {
                            "Content-Type": content_type,
                            "Accept": "application/json",
                        }
                        if auth_header:
                            headers["Authorization"] = auth_header

                        log.debug(f"[BLOSSOM] Trying {method} {url}")
                        if method == "PUT":
                            resp = await client.put(url, content=data, headers=headers)
                        else:
                            resp = await client.post(url, content=data, headers=headers)

                        if resp.status_code < 200 or resp.status_code >= 300:
                            errors.append(f"{method} {url}: HTTP {resp.status_code}")
                            continue

                        result = resp.json()
                        # ── תמיכה בפורמטים שונים (כמו ב-blossom.js) ──
                        result_url = (
                            result.get("url")
                            or (result.get("data", {}) or {}).get("url")
                        )
                        if result_url:
                            log.info(f"[BLOSSOM] ✅ Upload OK: {result_url}")
                            return result_url

                    except Exception as e:
                        errors.append(f"{method} {url}: {e}")

        # ── Fallback: void.cat ──
        try:
            log.info("[BLOSSOM] Trying void.cat fallback...")
            resp = await client.post(
                VOID_CAT_ENDPOINT,
                files={"file": ("media", data, content_type)},
            )
            if resp.status_code >= 200 and resp.status_code < 300:
                result = resp.json()
                result_url = result.get("file", {}).get("url") or result.get("url")
                if result_url:
                    log.info(f"[BLOSSOM] ✅ void.cat fallback OK: {result_url}")
                    return result_url
        except Exception as e:
            errors.append(f"void.cat: {e}")

    log.error(f"[BLOSSOM] ❌ All servers failed: {errors}")
    raise RuntimeError(f"Blossom upload failed. Tried {len(errors)} endpoints. Errors: {errors[:3]}")


# ═══════════════════════════════════════════════════════════
#  RELAY — שמירת מידע לריליי Nostr
#  מבוסס על compose.js + feed.js של SOS-main
# ═══════════════════════════════════════════════════════════

def _sign_event(event: Dict, private_key: str) -> Optional[Dict]:
    """
    חתימת Nostr event (NIP-01).
    מנסה coincurve → secp256k1 → None.
    """
    try:
        # ── חישוב event ID (NIP-01) ──
        serialized = json.dumps([
            0,
            event["pubkey"],
            event["created_at"],
            event["kind"],
            event["tags"],
            event["content"],
        ], separators=(",", ":"), ensure_ascii=False)
        event_hash = hashlib.sha256(serialized.encode()).digest()
        event_id = event_hash.hex()
        event["id"] = event_id

        # ── חתימה עם coincurve (אם זמין) ──
        try:
            from coincurve import PrivateKey
            sk = PrivateKey(bytes.fromhex(private_key))
            sig = sk.sign_schnorr(event_hash)
            event["sig"] = sig.hex()
            return event
        except ImportError:
            pass

        # ── חתימה עם secp256k1 (אם זמין) ──
        try:
            import secp256k1
            sk = secp256k1.PrivateKey(bytes.fromhex(private_key))
            sig = sk.schnorr_sign(event_hash)
            event["sig"] = sig.hex()
            return event
        except ImportError:
            pass

        log.warning("No signing library available (install coincurve or secp256k1)")
        return None

    except Exception as e:
        log.error(f"Event signing failed: {e}")
        return None


async def _publish_to_relay(relay_url: str, event: Dict, timeout: float = 10) -> bool:
    """
    פרסום אירוע בודד לריליי בודד.
    מבוסס על pool.publish() של nostr-tools.
    """
    try:
        import websockets
    except ImportError:
        log.error("websockets package not installed. Run: pip install websockets")
        return False

    try:
        async with websockets.connect(relay_url, close_timeout=5) as ws:
            msg = json.dumps(["EVENT", event])
            await ws.send(msg)
            # ── ממתין ל-OK מהריליי ──
            try:
                resp = await asyncio.wait_for(ws.recv(), timeout=timeout)
                parsed = json.loads(resp)
                if isinstance(parsed, list) and len(parsed) >= 3:
                    if parsed[0] == "OK" and parsed[2] is True:
                        return True
                    if parsed[0] == "OK" and parsed[2] is False:
                        log.warning(f"Relay {relay_url} rejected: {parsed}")
                        return False
                # ── חלק מהריליים לא שולחים OK אבל מקבלים ──
                return True
            except asyncio.TimeoutError:
                # ── שלחנו — אין אישור, אבל כנראה בסדר ──
                return True
    except Exception as e:
        log.debug(f"Relay {relay_url} error: {e}")
        return False


async def save_to_relay(data: Dict, kind: int = KIND_ANALYSIS,
                         tags: List = None) -> bool:
    """
    שמירת נתונים לריליי Nostr — מפרסם לכל הריליים במקביל.
    מבוסס על compose.js של SOS-main.

    Args:
        data: dict עם הנתונים לשמירה
        kind: סוג האירוע (ברירת מחדל: KIND_ANALYSIS)
        tags: תגיות נוספות (אופציונלי)

    Returns:
        True אם לפחות ריליי אחד קיבל
    """
    private_key = _get_private_key()
    public_key = _get_public_key()

    if not private_key or not public_key:
        log.warning("[RELAY] No keys configured — skipping relay save. "
                    "Set NOSTR_PRIVATE_KEY and NOSTR_PUBLIC_KEY env vars.")
        return False

    # ── בניית אירוע Nostr (NIP-01) ──
    now = int(time.time())
    event_tags = [
        ["t", NETWORK_TAG],
        ["client", "media-analyzer-v2"],
    ]
    if tags:
        event_tags.extend(tags)

    # ── הוספת תג group אם קיים ──
    if "group" in data:
        event_tags.append(["g", data["group"]])

    event = {
        "kind": kind,
        "content": json.dumps(data, ensure_ascii=False),
        "tags": event_tags,
        "created_at": now,
        "pubkey": public_key,
    }

    # ── חתימה ──
    signed = _sign_event(event, private_key)
    if not signed:
        log.error("[RELAY] Event signing failed")
        return False

    # ── פרסום לכל הריליים במקביל ──
    log.info(f"[RELAY] Publishing event kind={kind} to {len(RELAY_URLS)} relays...")
    results = await asyncio.gather(
        *[_publish_to_relay(url, signed) for url in RELAY_URLS],
        return_exceptions=True,
    )
    ok_count = sum(1 for r in results if r is True)
    log.info(f"[RELAY] Published to {ok_count}/{len(RELAY_URLS)} relays")
    return ok_count > 0


async def create_group(group_id: str, name: str = "", description: str = "") -> bool:
    """
    יצירת קבוצה בריליי — אירוע NIP-23 עם מזהה קבוצה.

    Args:
        group_id: מזהה קבוצה (למשל "media-analyzer")
        name: שם הקבוצה
        description: תיאור

    Returns:
        True אם נשמר בהצלחה
    """
    data = {
        "group": group_id,
        "type": "group_create",
        "name": name or group_id,
        "description": description or f"Media Analyzer group: {group_id}",
        "created_at": int(time.time()),
    }
    tags = [
        ["d", group_id],
        ["title", name or group_id],
    ]
    return await save_to_relay(data, kind=KIND_GROUP, tags=tags)


async def fetch_from_relay(relay_url: str, filters: Dict,
                            timeout: float = 10) -> List[Dict]:
    """
    שליפת אירועים מריליי לפי פילטר (NIP-01 REQ).

    Args:
        relay_url: כתובת הריליי
        filters: פילטר Nostr (kinds, authors, #t, since, until, limit)
        timeout: זמן המתנה

    Returns:
        רשימת אירועים
    """
    try:
        import websockets
    except ImportError:
        log.error("websockets not installed")
        return []

    events = []
    sub_id = f"ma-{int(time.time())}"
    try:
        async with websockets.connect(relay_url, close_timeout=5) as ws:
            await ws.send(json.dumps(["REQ", sub_id, filters]))
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
                    msg = json.loads(raw)
                    if isinstance(msg, list):
                        if msg[0] == "EVENT" and len(msg) >= 3:
                            events.append(msg[2])
                        elif msg[0] == "EOSE":
                            break
                except asyncio.TimeoutError:
                    break
            # ── סגירת subscription ──
            await ws.send(json.dumps(["CLOSE", sub_id]))
    except Exception as e:
        log.debug(f"Fetch from {relay_url} failed: {e}")
    return events


async def fetch_group(group_id: str, limit: int = 50) -> List[Dict]:
    """
    שליפת כל האירועים של קבוצה מהריליים.

    Args:
        group_id: מזהה הקבוצה
        limit: מקסימום אירועים

    Returns:
        רשימת אירועים מפורסמים
    """
    filters = {
        "kinds": [KIND_ANALYSIS, KIND_HISTORY],
        "#t": [NETWORK_TAG],
        "#g": [group_id],
        "limit": limit,
    }
    all_events = []
    tasks = [fetch_from_relay(url, filters) for url in RELAY_URLS[:3]]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    seen_ids = set()
    for result in results:
        if isinstance(result, list):
            for ev in result:
                eid = ev.get("id", "")
                if eid and eid not in seen_ids:
                    seen_ids.add(eid)
                    all_events.append(ev)
    # ── מיון לפי זמן (חדש ראשון) ──
    all_events.sort(key=lambda e: e.get("created_at", 0), reverse=True)
    return all_events[:limit]


# ═══════════════════════════════════════════════════════════
#  HELPERS
# ═══════════════════════════════════════════════════════════

def _guess_content_type(filename: str) -> str:
    """ניחוש MIME type לפי סיומת."""
    ext = Path(filename).suffix.lower()
    types = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".gif": "image/gif",
        ".webp": "image/webp", ".bmp": "image/bmp",
        ".mp4": "video/mp4", ".mov": "video/quicktime",
        ".avi": "video/x-msvideo", ".webm": "video/webm",
        ".mkv": "video/x-matroska",
        ".mp3": "audio/mpeg", ".wav": "audio/wav",
        ".ogg": "audio/ogg", ".flac": "audio/flac",
    }
    return types.get(ext, "application/octet-stream")


# ═══════════════════════════════════════════════════════════
#  SYNC WRAPPERS — גרסאות סינכרוניות לנוחות
# ═══════════════════════════════════════════════════════════

def upload_to_blossom_sync(file_input) -> str:
    """גרסה סינכרונית של upload_to_blossom."""
    return asyncio.get_event_loop().run_until_complete(upload_to_blossom(file_input))


def save_to_relay_sync(data: Dict, kind: int = KIND_ANALYSIS) -> bool:
    """גרסה סינכרונית של save_to_relay."""
    return asyncio.get_event_loop().run_until_complete(save_to_relay(data, kind))
