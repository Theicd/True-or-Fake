"""Media Analyzer V2 — Server. Serves Stage 1 UI + API."""
import os, traceback, json, time, hmac, hashlib, secrets
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, Form, Request, Header
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

from analyzer import analyze_video, analyze_image, get_connected_sources
# ── Multi-Agent System (V2) — ארכיטקטורת סוכנים היררכית ──
from multi_agent_system import (
    analyze_video_multi_agent, analyze_image_multi_agent,
    analyze_text_multi_agent,
)

app = FastAPI(title="Media Analyzer V2")
ROOT = Path(__file__).resolve().parent


def _load_env_file() -> None:
    """Load key/value pairs from .env into process environment if missing."""
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    try:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and (key not in os.environ or not os.environ.get(key)):
                os.environ[key] = value
    except Exception:
        # Keep server running even if .env contains malformed lines.
        pass


_load_env_file()

# ═══════════════════════════════════════════════════════════
#  SHARED REPORT STORAGE — קובץ JSON משותף לכל המשתמשים
# ═══════════════════════════════════════════════════════════
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
REPORTS_FILE = DATA_DIR / "shared_reports.json"
REPORTS_MAX = 100  # מקסימום דוחות בהיסטוריה המשותפת

def _load_reports() -> list:
    try:
        if REPORTS_FILE.exists():
            return json.loads(REPORTS_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return []

def _save_reports(reports: list) -> None:
    REPORTS_FILE.write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")

def _token_prefix(token: str) -> str:
    """מחשב fingerprint קצר של הטוקן — לא שומרים את הטוקן עצמו."""
    return hashlib.sha256(token.encode()).hexdigest()[:14]

# ═══════════════════════════════════════════════════════════
#  CPANEL AUTH — אימות מנהל מערכת
# ═══════════════════════════════════════════════════════════
_CPANEL_USER = os.getenv("CPANEL_USER", "admin")
_CPANEL_PASS = os.getenv("CPANEL_PASS", "")
_CPANEL_SECRET = os.getenv("CPANEL_SECRET", secrets.token_hex(32))
_SESSION_TTL = 7200  # שעתיים

# rate-limit: max 5 failures per IP per 60s
_login_failures: dict = {}

def _sign_session(username: str) -> str:
    ts = int(time.time())
    payload = f"{username}:{ts}"
    sig = hmac.new(_CPANEL_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}:{sig}"

def _verify_session(token_str: str) -> bool:
    try:
        parts = token_str.split(":")
        if len(parts) != 3:
            return False
        username, ts_str, sig = parts
        ts = int(ts_str)
        if time.time() - ts > _SESSION_TTL:
            return False
        payload = f"{username}:{ts_str}"
        expected = hmac.new(_CPANEL_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, sig)
    except Exception:
        return False


def _build_v2_degraded_response(error_text: str, media_type: str = "unknown"):
    """Structured fallback payload when V2 analysis cannot complete."""
    return {
        "status": "ok",
        "mode": "multi_agent",
        "partial": True,
        "meta": {"media_type": media_type},
        "output": {
            "speech_text": "",
            "ocr_text": "",
            "merged_text": "",
            "frames": [],
            "questions": [],
            "answers": [],
            "summary": "",
        },
        "scores": {
            "truth_score": 50,
            "authenticity_score": 50,
            "ai_probability": 50,
            "narrative_class": "unclear",
            "risk_level": "medium",
            "confidence_level": 40,
        },
        "consistency": {
            "content_type": "unclear",
            "intent": "unknown",
            "factual_mode": False,
            "ui_metrics": {
                "truth_score": 50,
                "authenticity_score": 50,
                "ai_probability": 50,
                "narrative": "Unclear",
                "risk_level": "Medium",
                "confidence_level": 40,
            },
        },
        "narrative": {
            "intent": "unclear",
            "narrative_class": "unclear",
            "confidence": 40,
            "is_satire": False,
        },
        "intelligence": {
            "content_type": "unclear",
            "key_signals": ["degraded_mode", "provider_connectivity"],
            "key_findings": ["המערכת זיהתה תקלה זמנית בחיבור לספקי הניתוח."],
            "final_assessment": "הניתוח הושלם חלקית עקב בעיית תקשורת זמנית. מומלץ להריץ מחדש.",
        },
        "research": {
            "claims": ["נדרש ניתוח חוזר לאחר שחזור תקשורת לספקים."],
            "questions": [{"question": "האם התקלה זמנית והאם ניתן להריץ מחדש?", "type": "fact_check", "priority": 3}],
            "sources_searched": 1,
            "engines_used": ["duckduckgo"],
            "verification_results": [{"claim": "נדרש ניתוח חוזר לאחר שחזור תקשורת לספקים.", "status": "NOT_VERIFIED", "confidence": 35, "source": "fallback"}],
            "verified": [],
            "contradicted": [],
            "partially_verified": [],
            "not_verified": ["נדרש ניתוח חוזר לאחר שחזור תקשורת לספקים."],
            "unverified": ["נדרש ניתוח חוזר לאחר שחזור תקשורת לספקים."],
            "is_linked_to_real_events": False,
            "is_part_of_larger_event": False,
            "related_events": [],
            "distortion_level": "low",
            "event_type": "General",
            "context_level": "Low",
            "context_explanation": "אין מספיק נתונים חיצוניים עקב תקלה זמנית.",
            "strategic_assessment": "יש להפעיל מחדש את הניתוח לאחר התייצבות החיבור.",
            "reliability": {
                "content_reliability": 45,
                "source_reliability": 40,
                "verification_score": 35,
                "final_reliability": 40,
                "total_claims": 1,
                "verified_count": 0,
                "contradicted_count": 0,
                "partially_verified_count": 0,
                "not_verified_count": 1,
            },
        },
        "validation": {"is_valid": True, "issues": [], "corrected_confidence": "Low"},
        "evidence_filter": {
            "filtered_assessment": "המידע הנוכחי חלקי בלבד ולכן אין מסקנה סופית.",
            "filtered_findings": ["הניתוח הופסק בשל תקלה זמנית בתקשורת."],
            "removed_claims": [],
            "evidence_quality": "Insufficient",
        },
        "ui_data": {
            "headline": "ניתוח חלקי",
            "ui_summary": "הניתוח הושלם חלקית עקב בעיית תקשורת זמנית עם שירותי הניתוח. מומלץ לנסות שוב.",
            "ui_tags": ["unclear", "low confidence"],
            "ui_flags": ["ניתוח חלקי", "תקלה זמנית בספק חיצוני"],
            "ui_metrics": {
                "truth_score": 50,
                "authenticity_score": 50,
                "ai_probability": 50,
                "narrative": "Unclear",
                "risk_level": "Medium",
                "confidence_level": 40,
            },
            "verified_findings": ["המערכת זיהתה כשל זמינות זמני לספק הניתוח."],
            "system_trust": "LOW",
            "consistency_applied": True,
            "confidence_reasons": ["provider_connectivity_error"],
        },
        "diagnostics": {
            "degraded_mode": True,
            "issues": ["provider connectivity error"],
            "provider_errors": [{"type": "exception", "snippet": error_text[:300]}],
        },
        "qa": {"passed": False, "violations": ["degraded_mode"], "fixes": [], "total_checks": 8, "failed_checks": 1},
    }


@app.exception_handler(Exception)
async def global_err(request: Request, exc: Exception):
    tb = traceback.format_exc()
    print(f"ERROR: {exc}\n{tb}")
    return JSONResponse({"error": str(exc)}, 500)


@app.get("/")
async def index():
    return RedirectResponse(url="/stage1/index.html", status_code=307)


@app.get("/index.html")
async def index_html():
    return RedirectResponse(url="/stage1/index.html", status_code=307)


@app.get("/styles.css")
async def root_styles():
    return FileResponse(str(ROOT / "styles.css"), media_type="text/css")


@app.get("/app.js")
async def root_app_js():
    return FileResponse(str(ROOT / "app.js"), media_type="application/javascript")


@app.get("/api/health")
async def health():
    import subprocess
    ffmpeg_ok = False
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=5)
        ffmpeg_ok = True
    except Exception:
        pass
    return {"ok": True, "ffmpeg": ffmpeg_ok, "version": "2.0-stage1"}


@app.post("/api/verify-token")
async def verify_token(hf_token: str = Form("")):
    if not hf_token:
        return JSONResponse({"ok": False, "error": "missing token"}, 400)
    import httpx
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get("https://huggingface.co/api/whoami-v2",
                            headers={"Authorization": f"Bearer {hf_token}"})
        if r.status_code == 200:
            data = r.json()
            return {"ok": True, "name": data.get("name", data.get("fullname", "User"))}
        return JSONResponse({"ok": False, "error": f"HTTP {r.status_code}"}, 401)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, 500)


@app.post("/api/analyze")
async def analyze(
    hf_token: str = Form(""),
    media: UploadFile = File(None),
    image_url: str = Form(""),
    media_url: str = Form(""),
):
    token = hf_token or os.getenv("HF_TOKEN", "")
    if not token:
        return JSONResponse({"error": "נדרש HuggingFace Token"}, 400)

    try:
        if media and media.filename:
            data = await media.read()
            ext = Path(media.filename).suffix.lower()
            if ext in (".mp4", ".mov", ".avi", ".webm", ".mkv"):
                result = await analyze_video(data, token)
                return JSONResponse(result)
            elif ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"):
                result = await analyze_image(data, token)
                return JSONResponse(result)
            return JSONResponse({"error": f"סוג קובץ לא נתמך: {ext}"}, 400)

        if image_url:
            import httpx
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.get(image_url)
            if r.status_code == 200:
                return JSONResponse(await analyze_image(r.content, token))
            return JSONResponse({"error": f"שגיאה בהורדת URL: {r.status_code}"}, 400)

        if media_url:
            import httpx
            from urllib.parse import urlparse

            parsed = urlparse(media_url)
            ext = Path(parsed.path).suffix.lower()

            async with httpx.AsyncClient(timeout=60) as c:
                r = await c.get(media_url)
            if r.status_code != 200:
                return JSONResponse({"error": f"שגיאה בהורדת media_url: {r.status_code}"}, 400)

            if ext in (".mp4", ".mov", ".avi", ".webm", ".mkv"):
                return JSONResponse(await analyze_video(r.content, token))
            if ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"):
                return JSONResponse(await analyze_image(r.content, token))
            return JSONResponse({"error": f"media_url לא נתמך לניתוח: {ext or 'unknown'}"}, 400)
    except Exception as e:
        import traceback, logging
        logging.getLogger("server").error(f"Analysis error: {traceback.format_exc()}")
        return JSONResponse({"error": f"שגיאת ניתוח: {type(e).__name__}: {str(e)[:300]}"}, 500)

    return JSONResponse({"error": "לא סופק מדיה"}, 400)


# ═══════════════════════════════════════════════════════════
#  /api/analyze-v2 — Multi-Agent endpoint (ארכיטקטורה חדשה)
#  תומך בווידאו, תמונה, URL, וטקסט גולמי
# ═══════════════════════════════════════════════════════════
@app.post("/api/analyze-v2")
async def analyze_v2(
    hf_token: str = Form(""),
    media: UploadFile = File(None),
    image_url: str = Form(""),
    text: str = Form(""),
):
    """Multi-Agent analysis — Controller + 7 Agents + QA."""
    token = hf_token or os.getenv("HF_TOKEN", "")
    if not token:
        return JSONResponse({"error": "נדרש HuggingFace Token"}, 400)

    try:
        # ── וידאו / תמונה ──
        if media and media.filename:
            data = await media.read()
            ext = Path(media.filename).suffix.lower()
            if ext in (".mp4", ".mov", ".avi", ".webm", ".mkv"):
                result = await analyze_video_multi_agent(data, token)
                return JSONResponse(result)
            elif ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"):
                result = await analyze_image_multi_agent(data, token)
                return JSONResponse(result)
            return JSONResponse({"error": f"סוג קובץ לא נתמך: {ext}"}, 400)

        # ── URL לתמונה ──
        if image_url:
            import httpx
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.get(image_url)
            if r.status_code == 200:
                return JSONResponse(await analyze_image_multi_agent(r.content, token))
            return JSONResponse({"error": f"שגיאה בהורדת URL: {r.status_code}"}, 400)

        # ── טקסט גולמי (חדש — רק ב-V2) ──
        if text and len(text.strip()) > 10:
            result = await analyze_text_multi_agent(text.strip(), token)
            return JSONResponse(result)

    except Exception as e:
        import traceback, logging
        logging.getLogger("server").error(f"Multi-Agent error: {traceback.format_exc()}")
        media_type = "unknown"
        if media and media.filename:
            ext = Path(media.filename).suffix.lower()
            if ext in (".mp4", ".mov", ".avi", ".webm", ".mkv"):
                media_type = "video"
            elif ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"):
                media_type = "image"
        elif text and len(text.strip()) > 0:
            media_type = "text"
        elif image_url:
            media_type = "image"
        fallback = _build_v2_degraded_response(f"{type(e).__name__}: {str(e)}", media_type=media_type)
        return JSONResponse(fallback, 200)

    return JSONResponse({"error": "לא סופק מדיה או טקסט"}, 400)


# ═══════════════════════════════════════════════════════════
#  SHARED HISTORY API — דוחות משותפים לכל המשתמשים
# ═══════════════════════════════════════════════════════════

@app.get("/api/reports")
async def get_reports(limit: int = 50):
    """החזרת רשימת הדוחות המשותפת (ללא fullData כדי לחסוך נפח)."""
    reports = _load_reports()
    slim = []
    for r in reports[:min(limit, REPORTS_MAX)]:
        row = {k: v for k, v in r.items() if k != "fullData"}
        fd = r.get("fullData") or {}
        # backfill estimatedCost from fullData if missing
        if not row.get("estimatedCost"):
            fd_cost = fd.get("estimated_cost")
            if fd_cost:
                row["estimatedCost"] = fd_cost
        slim.append(row)
    return JSONResponse({"reports": slim, "total": len(reports)})


@app.get("/api/reports/{report_id}")
async def get_report(report_id: str):
    """החזרת דוח בודד עם fullData."""
    reports = _load_reports()
    for r in reports:
        if r.get("id") == report_id:
            return JSONResponse(r)
    return JSONResponse({"error": "דוח לא נמצא"}, 404)


@app.post("/api/reports/save")
async def save_report(request: Request):
    """שמירת דוח חדש מהלקוח אחרי ניתוח מוצלח."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "גוף בקשה לא תקין"}, 400)

    # token can come from JSON body ('hf_token_hint') or env fallback
    token = str(body.get("hf_token_hint", "")).strip() or os.getenv("HF_TOKEN", "")
    if not token:
        return JSONResponse({"error": "נדרש טוקן"}, 400)

    owner = _token_prefix(token)
    report = {
        "id": body.get("id") or (str(int(time.time() * 1000)) + "_" + secrets.token_hex(3)),
        "date": body.get("date") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "fileName": str(body.get("fileName", "Unknown"))[:200],
        "mediaType": str(body.get("mediaType", "unknown"))[:20],
        "mediaUrl": str(body.get("mediaUrl", ""))[:2000],
        "truthScore": int(body.get("truthScore", 0)),
        "authenticity": int(body.get("authenticity", 0)),
        "narrative": str(body.get("narrative", "Unclear"))[:50],
        "riskLevel": str(body.get("riskLevel", "Low"))[:20],
        "confidence": int(body.get("confidence", 0)),
        "isSatire": bool(body.get("isSatire", False)),
        "summary": str(body.get("summary", ""))[:500],
        "estimatedCost": body.get("estimatedCost") or (body.get("fullData") or {}).get("estimated_cost") or None,
        "owner": owner,
        "fullData": body.get("fullData", {}),
    }
    reports = _load_reports()
    reports.insert(0, report)
    if len(reports) > REPORTS_MAX:
        reports = reports[:REPORTS_MAX]
    _save_reports(reports)
    return JSONResponse({"ok": True, "id": report["id"]})


@app.delete("/api/reports/{report_id}")
async def delete_own_report(report_id: str, request: Request, authorization: str = Header("")):
    """מחיקת דוח בידי הבעלים שלו בלבד."""
    # client sends token in Authorization: Bearer <hf_token>
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        return JSONResponse({"error": "נדרש טוקן"}, 401)
    owner = _token_prefix(token)
    reports = _load_reports()
    before = len(reports)
    reports = [r for r in reports if not (r.get("id") == report_id and r.get("owner") == owner)]
    if len(reports) == before:
        return JSONResponse({"error": "לא נמצא או אין הרשאה"}, 403)
    _save_reports(reports)
    return JSONResponse({"ok": True})


# ═══════════════════════════════════════════════════════════
#  CPANEL — ממשק ניהול מנהל מערכת
# ═══════════════════════════════════════════════════════════

@app.get("/cpanel")
async def cpanel_page():
    return FileResponse(str(ROOT / "stage1" / "cpanel.html"), media_type="text/html")


@app.post("/api/admin/login")
async def admin_login(request: Request, username: str = Form(""), password: str = Form("")):
    """כניסת מנהל מערכת — מחזיר session token."""
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()
    # rate-limit: ניקוי רשומות ישנות
    _login_failures[client_ip] = [t for t in _login_failures.get(client_ip, []) if now - t < 60]
    if len(_login_failures.get(client_ip, [])) >= 5:
        return JSONResponse({"ok": False, "error": "יותר מדי ניסיונות. נסה שוב עוד דקה."}, 429)

    if not _CPANEL_PASS:
        return JSONResponse({"ok": False, "error": "CPANEL_PASS לא הוגדר ב-.env"}, 503)

    # Constant-time comparison
    user_ok = hmac.compare_digest(username.encode(), _CPANEL_USER.encode())
    pass_ok = hmac.compare_digest(
        hashlib.sha256(password.encode()).hexdigest(),
        hashlib.sha256(_CPANEL_PASS.encode()).hexdigest(),
    )
    if not (user_ok and pass_ok):
        _login_failures.setdefault(client_ip, []).append(now)
        return JSONResponse({"ok": False, "error": "שם משתמש או סיסמה שגויים"}, 401)

    session = _sign_session(username)
    return JSONResponse({"ok": True, "session": session})


@app.get("/api/admin/reports")
async def admin_get_reports(authorization: str = Header("")):
    """קבלת כל הדוחות — למנהל בלבד."""
    if not _verify_session(authorization.removeprefix("Bearer ").strip()):
        return JSONResponse({"error": "אינך מורשה"}, 401)
    reports = _load_reports()
    slim = []
    for r in reports:
        row = {k: v for k, v in r.items() if k != "fullData"}
        fd = r.get("fullData") or {}
        # backfill estimatedCost from fullData if missing
        if not row.get("estimatedCost"):
            fd_cost = fd.get("estimated_cost")
            if fd_cost:
                row["estimatedCost"] = fd_cost
        # include validation & pipeline for CPANEL detail view
        if fd.get("validation"):
            row["validation"] = fd["validation"]
        if fd.get("pipeline"):
            row["pipeline"] = fd["pipeline"]
        slim.append(row)
    return JSONResponse({"reports": slim, "total": len(reports)})


@app.delete("/api/admin/reports/{report_id}")
async def admin_delete_report(report_id: str, authorization: str = Header("")):
    """מחיקת דוח כלשהו — למנהל בלבד."""
    if not _verify_session(authorization.removeprefix("Bearer ").strip()):
        return JSONResponse({"error": "אינך מורשה"}, 401)
    reports = _load_reports()
    before = len(reports)
    reports = [r for r in reports if r.get("id") != report_id]
    if len(reports) == before:
        return JSONResponse({"error": "דוח לא נמצא"}, 404)
    _save_reports(reports)
    return JSONResponse({"ok": True})


@app.delete("/api/admin/reports")
async def admin_clear_all(authorization: str = Header("")):
    """מחיקת כל הדוחות — למנהל בלבד."""
    if not _verify_session(authorization.removeprefix("Bearer ").strip()):
        return JSONResponse({"error": "אינך מורשה"}, 401)
    _save_reports([])
    return JSONResponse({"ok": True})


@app.get("/api/admin/stats")
async def admin_stats(authorization: str = Header("")):
    """סטטיסטיקות לוח הבקרה."""
    if not _verify_session(authorization.removeprefix("Bearer ").strip()):
        return JSONResponse({"error": "אינך מורשה"}, 401)
    reports = _load_reports()
    by_type = {}
    by_narrative = {}
    for r in reports:
        t = r.get("mediaType", "unknown")
        by_type[t] = by_type.get(t, 0) + 1
        n = r.get("narrative", "Unclear")
        by_narrative[n] = by_narrative.get(n, 0) + 1
    avg_truth = round(sum(r.get("truthScore", 0) for r in reports) / max(len(reports), 1), 1)
    connected_sources = get_connected_sources()
    return JSONResponse({
        "total": len(reports),
        "by_media_type": by_type,
        "by_narrative": by_narrative,
        "avg_truth_score": avg_truth,
        "storage_kb": round(REPORTS_FILE.stat().st_size / 1024, 1) if REPORTS_FILE.exists() else 0,
        "connected_sources": connected_sources,
    })


# Static mounts AFTER routes so routes take priority
app.mount("/stage1", StaticFiles(directory=str(ROOT / "stage1")), name="stage1")
app.mount("/shared", StaticFiles(directory=str(ROOT / "shared")), name="shared")

if __name__ == "__main__":
    uvicorn.run("server:app", host="127.0.0.1", port=8899, reload=False)
