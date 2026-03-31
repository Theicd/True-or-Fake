"""
Media Analyzer V2 — Stage 1: Full 11-Step Pipeline
Every API call logs: model, prompt, raw response, duration.
Steps: decompose → speech → OCR → objects → captions → AI detect →
       text merge → questions → reinvestigate → combine → summary
"""
import os, json, time, base64, asyncio, hashlib, tempfile, subprocess, re, logging
import xml.etree.ElementTree as ET
from urllib.parse import quote_plus, urlparse, parse_qs, unquote
from pathlib import Path
import httpx

log = logging.getLogger("analyzer")
logging.basicConfig(level=logging.INFO)

# ═══════════════════════════════════════════════════════════
#  MODELS
# ═══════════════════════════════════════════════════════════
HF_INF   = "https://router.huggingface.co/hf-inference/models"
CHAT_URL  = "https://router.huggingface.co/v1/chat/completions"
WHISPER   = "openai/whisper-large-v3-turbo"
DETR      = "facebook/detr-resnet-50"
AI_CLASS  = "umm-maybe/AI-image-detector"
TEXT_LLM  = "deepseek-ai/DeepSeek-V3"
LLM_120B  = "openai/gpt-oss-120b"


def _load_vision_candidates():
    """Load ordered Vision model candidates from env or defaults."""
    env_val = os.getenv("VISION_MODEL_CANDIDATES", "").strip()
    if env_val:
        candidates = [m.strip() for m in env_val.split(",") if m.strip()]
    else:
        # Prioritize models proven WORKING in live scanner tests on this environment.
        candidates = [
            "Qwen/Qwen2.5-VL-72B-Instruct",
            "meta-llama/Llama-4-Scout-17B-16E-Instruct",
            "google/gemma-3-27b-it",
            "Qwen/Qwen3.5-35B-A3B",
            "Qwen/Qwen3.5-27B",
            "zai-org/GLM-4.6V",
            # Keep failing legacy model last for compatibility only.
            "Qwen/Qwen2.5-VL-7B-Instruct",
        ]
    # Keep order, remove duplicates
    seen = set()
    ordered = []
    for m in candidates:
        if m not in seen:
            seen.add(m)
            ordered.append(m)
    return ordered


VISION_MODELS = _load_vision_candidates()
VISION = VISION_MODELS[0]

TIMEOUT = httpx.Timeout(120.0, connect=15.0)
TIMEOUT_LONG = httpx.Timeout(300.0, connect=15.0)  # for Whisper / large payloads
SEM = asyncio.Semaphore(6)
HF_TRANSIENT_ERRORS = (
    httpx.ReadTimeout,
    httpx.ConnectTimeout,
    httpx.ConnectError,
    httpx.RemoteProtocolError,
)

# ═══════════════════════════════════════════════════════════
#  COST TRACKER — per-request cost from HF billing data
# ═══════════════════════════════════════════════════════════
# Cost per API call (USD), derived from HuggingFace billing:
#   total_accrued_cost / total_requests = cost_per_request
_COST_PER_CALL = {
    "whisper":      0.000320,   # $0.12 / 375 requests
    "vision":       0.000104,   # $0.15 / 1440 requests  (Qwen VL-72B)
    "detr":         0.000286,   # $0.30 / 1050 requests
    "ai_class":     0.000052,   # <$0.01 / 192 requests
    "chat":         0.000502,   # $0.33 / 658 requests   (DeepSeek-V3)
    "chat_120b":    0.000359,   # $0.33 / 918 requests   (gpt-oss-120b)
}

class CostTracker:
    """Counts API calls per model during a single analysis run."""
    def __init__(self):
        self.counts = {k: 0 for k in _COST_PER_CALL}

    def tick(self, model_key: str):
        if model_key in self.counts:
            self.counts[model_key] += 1

    def summary(self) -> dict:
        total_calls = sum(self.counts.values())
        total_cost = sum(self.counts[k] * _COST_PER_CALL[k] for k in self.counts)
        return {
            "calls": dict(self.counts),
            "total_calls": total_calls,
            "estimated_cost_usd": round(total_cost, 6),
            "cost_breakdown": {
                k: round(self.counts[k] * _COST_PER_CALL[k], 6)
                for k in self.counts if self.counts[k] > 0
            },
        }

# Thread-local-ish tracker — set per analysis invocation
_current_tracker: CostTracker | None = None


async def _retry(coro_fn, retries=2, backoff=5):
    """Retry an async callable up to `retries` times with exponential backoff."""
    last_err = None
    for attempt in range(retries + 1):
        try:
            return await coro_fn()
        except HF_TRANSIENT_ERRORS as e:
            last_err = e
            if attempt < retries:
                wait = backoff * (2 ** attempt)
                log.warning(f"API timeout (attempt {attempt+1}/{retries+1}), retrying in {wait}s...")
                await asyncio.sleep(wait)
            else:
                log.error(f"API failed after {retries+1} attempts: {e}")
                raise

# ═══════════════════════════════════════════════════════════
#  PROMPTS
# ═══════════════════════════════════════════════════════════
P_OCR = (
    "OUTPUT ONLY THE RAW TEXT visible in this image. No explanations, no formatting.\n"
    "Include ALL text: banners, tickers, overlays, subtitles, watermarks, logos, signs.\n"
    "Include ALL languages (Hebrew, Arabic, English, etc). Preserve line breaks.\n"
    "If unclear character write [?]. If NO text at all write: NO_TEXT_FOUND\n"
    "CRITICAL: Do NOT write any introduction like 'The text is:'. Output ONLY the text."
)

P_CAPTION = (
    "Describe this image in detail. Include:\n"
    "- What is shown (people, objects, scene)\n"
    "- Text visible on screen\n"
    "- Setting/environment\n"
    "- Notable visual elements\n"
    "Be factual and specific. Output in the language of the visible text, or English."
)

P_AI_VISION = (
    "Analyze this image for signs of AI generation or manipulation.\n"
    "Check: unnatural textures, warped text, extra fingers, inconsistent lighting,\n"
    "blurred edges, repetitive patterns, deepfake artifacts.\n"
    'Return JSON: {"ai_generated": true/false, "confidence": 0.0-1.0, "signals": []}'
)

P_QUESTIONS = (
    "You are analyzing a video. Below is all extracted data.\n"
    "Generate 5-10 investigative questions that will help understand the content better.\n"
    "Focus on:\n"
    "- Unclear or ambiguous elements\n"
    "- Possible contradictions\n"
    "- Missing context\n"
    "- Visual anomalies\n"
    "- Claims that need verification\n"
    'Return JSON array: ["question1", "question2", ...]'
)

P_SUMMARY = (
    "Summarize the content of this video based on all collected data below.\n"
    "Focus ONLY on:\n"
    "- What is happening\n"
    "- Key elements and objects\n"
    "- People and their actions\n"
    "- Text/speech content\n"
    "NO assumptions. NO judgments. Keep it factual and structured.\n"
    "Write in the main language of the content."
)

P_INTELLIGENCE = (
    # ═══════════════════════════════════════════════════════════
    #  Intelligence LLM — מספק SIGNALS בלבד, לא ציונים!
    #  כלל ברזל: המודל נותן DATA — המערכת מחליטה.
    # ═══════════════════════════════════════════════════════════
    "You are a high-level intelligence analyst.\n\n"
    "Your job:\n"
    "- Interpret the content meaning\n"
    "- Detect: satire, parody, misinformation, propaganda, factual reporting\n"
    "- Identify key signals (contradictions, humor, nonsense, unsourced claims)\n"
    "- List factual findings grounded ONLY in the input data\n"
    "- Note uncertainties\n\n"
    "STRICT RULES:\n"
    "- Do NOT assign scores or percentages\n"
    "- Do NOT estimate reliability, risk, confidence, authenticity, or manipulation\n"
    "- Do NOT invent facts not supported by input\n"
    "- If uncertain → say so explicitly\n"
    "- Base conclusions ONLY on provided data\n"
    "- Prefer 'insufficient evidence' over guessing\n\n"
    "LANGUAGE RULES:\n"
    "- Write final_assessment in HEBREW (עברית) — 2-3 sentences\n"
    "- Write key_findings in HEBREW (עברית) — short factual sentences\n"
    "- Write uncertainties in HEBREW (עברית) — short sentences\n"
    "- Write recommended_action in HEBREW (עברית)\n"
    "- Write reasoning in English\n"
    "- Write key_signals in English\n"
    "- Write content_type in English\n\n"
    "OUTPUT FORMAT (STRICT JSON ONLY):\n"
    '{\n'
    '  "content_type": "satire | misinformation | propaganda | factual | fiction | unclear",\n'
    '  "key_signals": ["contradictions", "humor", "nonsense", "unsourced_claims"],\n'
    '  "key_findings": ["ממצא עובדתי בעברית 1", "..."],\n'
    '  "final_assessment": "מסקנה קצרה בעברית — 2-3 משפטים",\n'
    '  "reasoning": "step-by-step reasoning in English based ONLY on input",\n'
    '  "uncertainties": ["אי ודאות בעברית 1", "..."],\n'
    '  "recommended_action": "המלצה בעברית"\n'
    '}'
)

P_VALIDATION = (
    "You are a validation system.\n"
    "Your job is to verify that the analysis is strictly grounded in the input.\n\n"
    "RULES:\n"
    "- Mark any claim that is not supported by input data\n"
    "- Reduce confidence if unsupported claims are found\n"
    "- Ensure no hallucinated facts exist\n\n"
    "LANGUAGE: Write issues in HEBREW (עברית). Keep is_valid and corrected_confidence in English.\n\n"
    "OUTPUT (STRICT JSON ONLY):\n"
    '{\n'
    '  "is_valid": true,\n'
    '  "issues": ["בעיה בעברית 1"],\n'
    '  "corrected_confidence": "Low | Medium | High"\n'
    '}'
)

P_EVIDENCE_FILTER = (
    "You are an evidence-based filtering system.\n"
    "Your job is to STRICTLY remove or correct any claim that is not directly supported by the input data.\n\n"
    "RULES:\n"
    "- If a claim is not explicitly supported by the original data → REMOVE IT\n"
    "- Do not rephrase unsupported claims — delete them\n"
    "- Keep only verifiable statements that are grounded in input\n"
    "- List every removed claim so the user can see what was filtered\n"
    "- Provide a filtered assessment containing ONLY supported conclusions\n"
    "- Provide filtered_findings containing ONLY evidence-backed findings\n\n"
    "LANGUAGE RULES:\n"
    "- Write filtered_assessment in HEBREW (עברית)\n"
    "- Write filtered_findings in HEBREW (עברית) — short sentences\n"
    "- Write removed_claims in HEBREW (עברית)\n"
    "- Keep evidence_quality value in English\n\n"
    "OUTPUT (STRICT JSON ONLY):\n"
    '{\n'
    '  "filtered_assessment": "מסקנה קצרה בעברית מבוססת ראיות בלבד",\n'
    '  "filtered_findings": ["ממצא מאומת בעברית 1", "..."],\n'
    '  "removed_claims": ["טענה שהוסרה בעברית 1", "..."],\n'
    '  "evidence_quality": "Strong | Moderate | Weak | Insufficient"\n'
    '}'
)

# ── NARRATIVE INTELLIGENCE CLASSIFIER — שכבת סיווג נרטיב (חדש) ──
P_NARRATIVE_CLASS = (
    "You are a Narrative Intelligence Classifier.\n"
    "Your job is to classify the TRUE INTENT of the content.\n\n"
    "You must distinguish between:\n"
    "1. REAL MISINFORMATION — false claims presented as truth to deceive\n"
    "2. SATIRE / PARODY / HUMOR — intentionally absurd or comedic content\n"
    "3. FICTION / ENTERTAINMENT — creative or dramatic content\n"
    "4. FACTUAL CONTENT — genuine reporting or information\n"
    "5. PROPAGANDA — intentional manipulation to influence beliefs\n\n"
    "CRITICAL RULES:\n"
    "- Do NOT classify as misinformation if:\n"
    "  • The content contains absurd or unrealistic elements (e.g. aliens, supernatural events, impossible scenarios)\n"
    "  • The tone is humorous, exaggerated, or ironic\n"
    "  • The narrative resembles parody or satire\n"
    "- If absurd elements are present → Strongly consider SATIRE or FICTION\n"
    "- If the content mimics news but includes unrealistic claims → classify as SATIRE / PARODY\n"
    "- Only classify as PROPAGANDA if there is a clear attempt to influence beliefs AND the content appears realistic and deceptive\n"
    "- Only classify as MISINFORMATION if the false claims are presented seriously with no humor signals\n\n"
    "OUTPUT (STRICT JSON ONLY):\n"
    '{\n'
    '  "narrative_class": "Satire | Propaganda | Misinformation | Fiction | Factual",\n'
    '  "confidence": 0,\n'
    '  "reasoning": "Based ONLY on input signals",\n'
    '  "absurdity_detected": false,\n'
    '  "humor_signals": [],\n'
    '  "risk_override": false\n'
    '}'
)

P_UI_ADAPTER = (
    # ═══════════════════════════════════════════════════════════
    #  UI Adapter — PASSIVE. מייצר טקסט סיכום בלבד.
    #  כל הציונים, התגיות, והדגלים מגיעים מ-Consistency Engine.
    #  כלל ברזל: המודל נותן TEXT — המערכת נותנת NUMBERS.
    # ═══════════════════════════════════════════════════════════
    "You are a UI text generator.\n"
    "Your ONLY job: write a short Hebrew summary of the analysis.\n\n"
    "STRICT RULES:\n"
    "- Do NOT produce scores, percentages, or metrics\n"
    "- Do NOT produce tags, flags, or labels\n"
    "- Do NOT estimate reliability, risk, confidence\n"
    "- ONLY produce a ui_summary text in HEBREW\n"
    "- 2-3 sentences maximum\n"
    "- If content is satire → explain it neutrally, do not alarm\n"
    "- Base summary ONLY on the input analysis\n\n"
    "OUTPUT (STRICT JSON ONLY):\n"
    '{\n'
    '  "ui_summary": "סיכום בעברית — 2-3 משפטים"\n'
    '}'
)

# ═══════════════════════════════════════════════════════════
#  REALITY CHECK ENGINE — Prompts
#  מנוע הצלבת מציאות: Claims → Questions → Multi-Search → Verify → Context
#  מטרה: לא רק לנתח — אלא להצליב מול העולם האמיתי ולהסיק מסקנות מודיעיניות
# ═══════════════════════════════════════════════════════════

# ── שלב 1: חילוץ טענות עובדתיות (CLAIM EXTRACTION) ──
P_CLAIM_EXTRACTION = (
    "Extract all factual claims from the content analysis.\n\n"
    "Rules:\n"
    "- Only explicit, verifiable claims\n"
    "- No interpretation or opinion\n"
    "- Short sentences\n"
    "- Maximum 8 claims\n"
    "- Write claims in HEBREW if content is Hebrew, otherwise English\n\n"
    "OUTPUT (STRICT JSON ONLY):\n"
    '{\n'
    '  "claims": ["טענה 1", "טענה 2"]\n'
    '}'
)

# ── שלב 2: שאלות חקירה מתקדמות (INVESTIGATIVE QUESTIONS) ──
P_CRITICAL_QUESTIONS = (
    "You are an investigative intelligence engine.\n\n"
    "INPUT: Claims extracted from media content + speech_text + ocr_text + summary.\n\n"
    "TASK: Generate 5-10 high-value investigative questions that can be VERIFIED "
    "using external sources.\n\n"
    "RULES:\n"
    "- Focus on claims that include: dates, numbers, events, named entities\n"
    "- Avoid generic questions\n"
    "- Each question must be searchable on the internet\n"
    "- Classify each question by type\n"
    "- Assign priority (1=highest, 5=lowest)\n"
    "- Generate BOTH English and Hebrew versions for each question\n"
    "- English: optimized for global web search\n"
    "- Hebrew: optimized for Israeli/Hebrew sources and RSS feeds\n"
    "- Maximum 8 questions\n\n"
    "OUTPUT (STRICT JSON ONLY):\n"
    '{\n'
    '  "questions": [\n'
    '    {"question_en": "...", "question_he": "...", "type": "fact_check", "priority": 1},\n'
    '    {"question_en": "...", "question_he": "...", "type": "timeline", "priority": 2}\n'
    '  ]\n'
    '}\n\n'
    "VALID TYPES: fact_check, timeline, entity_verification, location, statistics, source_check"
)

P_TRANSLATE_TO_HE = (
    "Translate the following investigative questions from English to Hebrew.\n"
    "Return strict JSON only.\n"
    '{"questions_he": ["...", "..."]}'
)

P_TRANSLATE_TO_EN = (
    "Translate the following investigative questions from Hebrew to English.\n"
    "Return strict JSON only.\n"
    '{"questions_en": ["...", "..."]}'
)

# ── שלב 4: Verification Model — דירוג per-claim ──
P_VERIFICATION_MODEL = (
    "You are a fact-checking intelligence model.\n\n"
    "INPUT:\n"
    "- Original claims from the content\n"
    "- Search results from multiple external sources (news, wikipedia, fact-check databases)\n\n"
    "TASK: Determine the verification status of EACH claim.\n\n"
    "CLASSIFICATION PER CLAIM:\n"
    "- VERIFIED: strong evidence supports the claim\n"
    "- PARTIALLY_VERIFIED: some evidence supports but incomplete\n"
    "- NOT_VERIFIED: no evidence found either way\n"
    "- CONTRADICTED: evidence directly contradicts the claim\n\n"
    "STRICT RULES:\n"
    "- Use ONLY provided sources — do NOT hallucinate evidence\n"
    "- If no evidence found → mark as NOT_VERIFIED (not CONTRADICTED)\n"
    "- Cite which source supports the conclusion\n"
    "- Assign confidence 0-100 per claim\n"
    "- Write evidence/reasoning in HEBREW\n\n"
    "OUTPUT (STRICT JSON ONLY):\n"
    '{\n'
    '  "results": [\n'
    '    {\n'
    '      "claim": "...",\n'
    '      "status": "VERIFIED | PARTIALLY_VERIFIED | NOT_VERIFIED | CONTRADICTED",\n'
    '      "confidence": 85,\n'
    '      "evidence": "הסבר + ציטוט מקור בעברית",\n'
    '      "source": "שם המקור"\n'
    '    }\n'
    '  ],\n'
    '  "context_summary": "סיכום הקשר הכולל בעברית"\n'
    '}'
)

# ── שלב 5: Context Intelligence — קישור לאירועים אמיתיים ──
P_CONTEXT_INTELLIGENCE = (
    "You are a strategic intelligence analyst.\n\n"
    "INPUT:\n"
    "- Verified facts from fact-checking step\n"
    "- Original video/image summary\n"
    "- Verification results with sources\n\n"
    "TASK: Determine:\n"
    "1. Is this event part of a larger real-world sequence?\n"
    "2. What known real events relate to it?\n"
    "3. Is the video/image distorting or referencing real events?\n"
    "4. What is the strategic significance?\n\n"
    "Write in HEBREW.\n\n"
    "OUTPUT (STRICT JSON ONLY):\n"
    '{\n'
    '  "is_linked_to_real_events": true,\n'
    '  "related_events": ["אירוע 1", "אירוע 2"],\n'
    '  "distortion_level": "none | low | medium | high",\n'
    '  "event_type": "Geopolitical | Health | Social | Environmental | Military | Economic | Other",\n'
    '  "context_level": "High | Medium | Low",\n'
    '  "explanation": "הסבר מודיעיני מפורט בעברית",\n'
    '  "final_assessment": "הערכה אסטרטגית סופית בעברית"\n'
    '}'
)

# ═══════════════════════════════════════════════════════════
#  API HELPERS (all rate-limited via SEM)
# ═══════════════════════════════════════════════════════════
def _hf(token):
    return {"Authorization": f"Bearer {token}"}


async def _api_whisper(audio_bytes, token):
    async with SEM:
        t0 = time.time()
        try:
            async def _call():
                async with httpx.AsyncClient(timeout=TIMEOUT_LONG) as c:
                    return await c.post(f"{HF_INF}/{WHISPER}",
                                        content=audio_bytes,
                                        headers={**_hf(token), "Content-Type": "audio/flac"})
            r = await _retry(_call, retries=2, backoff=8)
        except HF_TRANSIENT_ERRORS as e:
            ms = int((time.time() - t0) * 1000)
            log.error(f"Whisper timeout after retries: {e}")
            return {"error": f"timeout: {e}", "text": ""}, ms
        ms = int((time.time() - t0) * 1000)
        if r.status_code != 200:
            return {"error": r.text[:300]}, ms
        if _current_tracker: _current_tracker.tick("whisper")
        try:
            return r.json(), ms
        except Exception:
            return {"text": r.text[:500]}, ms


async def _api_vision(b64, prompt, token, max_tok=800):
    async with SEM:
        t0 = time.time()
        errors = []

        for model_name in VISION_MODELS:
            payload = {
                "model": model_name,
                "messages": [{"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                    {"type": "text", "text": prompt},
                ]}],
                "max_tokens": max_tok,
            }
            try:
                async def _call():
                    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
                        return await c.post(CHAT_URL, json=payload, headers=_hf(token))
                r = await _retry(_call)
            except HF_TRANSIENT_ERRORS as e:
                errors.append(f"{model_name}: timeout {e}")
                continue

            if r.status_code == 200:
                try:
                    ch = r.json().get("choices", [])
                    content = ch[0]["message"]["content"] if ch else ""
                    log.info(f"Vision model selected: {model_name}")
                    if _current_tracker: _current_tracker.tick("vision")
                    return content, int((time.time() - t0) * 1000)
                except Exception as e:
                    errors.append(f"{model_name}: parse error {e}")
                    continue

            body = r.text[:220]
            if r.status_code == 400 and "model_not_supported" in body:
                errors.append(f"{model_name}: model_not_supported")
                continue
            errors.append(f"{model_name}: HTTP {r.status_code}: {body}")

        ms = int((time.time() - t0) * 1000)
        short = " | ".join(errors[:3])
        return f"ERROR vision_fallback_failed: {short}", ms


async def _api_detr(img_bytes, token):
    async with SEM:
        t0 = time.time()
        try:
            async def _call():
                async with httpx.AsyncClient(timeout=TIMEOUT) as c:
                    return await c.post(f"{HF_INF}/{DETR}",
                                        content=img_bytes,
                                        headers={**_hf(token), "Content-Type": "image/jpeg"})
            r = await _retry(_call)
        except HF_TRANSIENT_ERRORS as e:
            ms = int((time.time() - t0) * 1000)
            return [{"error": f"timeout: {e}"}], ms
        ms = int((time.time() - t0) * 1000)
        if r.status_code != 200:
            return [{"error": f"HTTP {r.status_code}"}], ms
        if _current_tracker: _current_tracker.tick("detr")
        try:
            data = r.json()
            return ([{"label": o["label"], "score": round(o["score"], 3), "box": o.get("box", {})}
                     for o in data if isinstance(o, dict) and o.get("score", 0) >= 0.5], ms)
        except Exception as e:
            return [{"error": str(e)}], ms


async def _api_ai_class(img_bytes, token):
    async with SEM:
        t0 = time.time()
        try:
            async def _call():
                async with httpx.AsyncClient(timeout=TIMEOUT) as c:
                    return await c.post(f"{HF_INF}/{AI_CLASS}",
                                        content=img_bytes,
                                        headers={**_hf(token), "Content-Type": "image/jpeg"})
            r = await _retry(_call)
        except HF_TRANSIENT_ERRORS as e:
            ms = int((time.time() - t0) * 1000)
            return {"error": f"timeout: {e}"}, ms
        ms = int((time.time() - t0) * 1000)
        if r.status_code != 200:
            return {"error": f"HTTP {r.status_code}"}, ms
        if _current_tracker: _current_tracker.tick("ai_class")
        try:
            data = r.json()
            result = {"raw": data}
            items = data if isinstance(data, list) and data and isinstance(data[0], dict) else (
                data[0] if isinstance(data, list) and data and isinstance(data[0], list) else [])
            for it in items:
                lbl = it.get("label", "").lower()
                sc = round(it.get("score", 0), 4)
                if "ai" in lbl or "artificial" in lbl:
                    result["ai_score"] = sc
                elif "human" in lbl or "real" in lbl:
                    result["human_score"] = sc
            result["label"] = "ai_generated" if result.get("ai_score", 0) > 0.5 else "human"
            return result, ms
        except Exception as e:
            return {"error": str(e)}, ms


async def _api_chat(prompt, token, system="You are a helpful assistant.", max_tok=1024):
    async with SEM:
        t0 = time.time()
        payload = {
            "model": TEXT_LLM,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": max_tok,
        }
        try:
            async def _call():
                async with httpx.AsyncClient(timeout=TIMEOUT) as c:
                    return await c.post(CHAT_URL, json=payload, headers=_hf(token))
            r = await _retry(_call)
        except HF_TRANSIENT_ERRORS as e:
            ms = int((time.time() - t0) * 1000)
            return f"ERROR timeout: {e}", ms
        ms = int((time.time() - t0) * 1000)
        if r.status_code != 200:
            return f"ERROR {r.status_code}: {r.text[:200]}", ms
        if _current_tracker: _current_tracker.tick("chat")
        try:
            ch = r.json().get("choices", [])
            return (ch[0]["message"]["content"] if ch else ""), ms
        except Exception as e:
            return f"ERROR: {e}", ms


async def _api_chat_120b(prompt, token, system="You are a helpful assistant.", max_tok=2048):
    """Call the 120B model for deep intelligence analysis."""
    async with SEM:
        t0 = time.time()
        payload = {
            "model": LLM_120B,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": max_tok,
        }
        try:
            async def _call():
                async with httpx.AsyncClient(timeout=TIMEOUT) as c:
                    return await c.post(CHAT_URL, json=payload, headers=_hf(token))
            r = await _retry(_call)
        except HF_TRANSIENT_ERRORS as e:
            ms = int((time.time() - t0) * 1000)
            log.warning(f"120B timeout, falling back to DeepSeek")
            payload["model"] = TEXT_LLM
            try:
                async def _call2():
                    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
                        return await c.post(CHAT_URL, json=payload, headers=_hf(token))
                r = await _retry(_call2)
            except HF_TRANSIENT_ERRORS as e2:
                return f"ERROR timeout: {e2}", ms
        ms = int((time.time() - t0) * 1000)
        if r.status_code != 200:
            # fallback to DeepSeek
            log.warning(f"120B failed ({r.status_code}), falling back to DeepSeek")
            payload["model"] = TEXT_LLM
            try:
                async def _call3():
                    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
                        return await c.post(CHAT_URL, json=payload, headers=_hf(token))
                r = await _retry(_call3)
            except HF_TRANSIENT_ERRORS as e:
                return f"ERROR timeout: {e}", ms
            ms = int((time.time() - t0) * 1000)
            if r.status_code != 200:
                return f"ERROR {r.status_code}: {r.text[:200]}", ms
        if _current_tracker: _current_tracker.tick("chat_120b")
        try:
            ch = r.json().get("choices", [])
            return (ch[0]["message"]["content"] if ch else ""), ms
        except Exception as e:
            return f"ERROR: {e}", ms


def _extract_json(text):
    """Extract JSON object from LLM response text."""
    if not text:
        return {}
    # try direct parse
    try:
        return json.loads(text)
    except Exception:
        pass
    # find first { ... last }
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except Exception:
            pass
    return {}


# ═══════════════════════════════════════════════════════════
#  PRODUCTION SCORING ENGINE — מנוע ניקוד דטרמיניסטי
#  3 צירים: Truth (אמת) / Authenticity (אותנטיות) / Intent (כוונה)
#  LLM אף פעם לא קובע ציונים — רק הקוד הזה קובע.
# ═══════════════════════════════════════════════════════════

# ── מילות מפתח אבסורד — Humor Detector ──
ABSURDITY_KEYWORDS_EN = [
    "aliens", "ufo", "batman", "superman", "unicorn", "dragon", "zombie",
    "time travel", "teleport", "magic", "wizard", "fairy", "mermaid",
    "giant", "monster", "invisible", "flying car", "abducted",
    "impossible", "absurd", "ridiculous", "nonsense", "satire", "parody",
]
ABSURDITY_KEYWORDS_HE = [
    "חייזרים", "עב\"מ", "באטמן", "סופרמן", "חד קרן", "דרקון", "זומבי",
    "מסע בזמן", "טלפורטציה", "קסם", "קוסם", "פיה", "בת ים",
    "ענק", "מפלצת", "בלתי נראה", "מטורף", "אבסורד", "מגוחך",
    "שטות", "סאטירה", "פרודיה", "מוגזם",
]


def _extract_signals(output, ai_step, narrative_result=None):
    """שלב 1: חילוץ signals גולמיים מכל שלבי הצינור — 0-100 לכל ציר."""
    speech = output.get("speech_text", "") or ""
    ocr = output.get("ocr_text", "") or ""
    merged = output.get("merged_text", "") or ""
    frames = output.get("frames", [])
    questions = output.get("questions", [])
    answers = output.get("answers", [])
    summary = output.get("summary", "") or ""

    # ── (A) contradictions — כמה סתירות נמצאו בחקירה ──
    contradiction_count = 0
    if answers:
        for a in answers:
            if isinstance(a, dict):
                resp_text = (a.get("response", "") or "").lower()
                if any(w in resp_text for w in
                       ["no ", "not ", "cannot", "unlikely", "false", "incorrect",
                        "contradiction", "inconsist", "does not match", "fabricat"]):
                    contradiction_count += 1
    total_q = max(len(questions), 1)
    contradictions = min(100, int((contradiction_count / total_q) * 100))
    # שאלות רבות = חריגות רבות → מגביר סתירות
    if len(questions) > 7:
        contradictions = min(100, contradictions + 15)

    # ── (B) absurdity — רמת אבסורד (Humor Detector) ──
    absurdity = 0
    all_text = (speech + " " + ocr + " " + merged + " " + summary).lower()
    for kw in ABSURDITY_KEYWORDS_EN:
        if kw in all_text:
            absurdity += 20
    for kw in ABSURDITY_KEYWORDS_HE:
        if kw in all_text:
            absurdity += 20
    # LLM narrative classifier absurdity signal
    narr = (narrative_result or {}).get("parsed", {})
    if narr.get("absurdity_detected"):
        absurdity += 30
    humor_signals = narr.get("humor_signals", [])
    absurdity += len(humor_signals) * 10
    absurdity = min(100, absurdity)

    # ── (C) manipulation — סימני זיוף טכני ──
    manipulation = 0
    # AI classifier score
    ai_score = 0.0
    for f in ai_step.get("frames", []):
        resp = f.get("response", {})
        if isinstance(resp, dict):
            ai_score = max(ai_score, resp.get("ai_score", 0))
    ai_probability = int(ai_score * 100)
    manipulation += int(ai_score * 40)  # AI = 40% מניפולציה max
    # שאלות חקירה רבות = אותות חשודים
    if len(questions) > 7:
        manipulation += 10
    if contradiction_count > 2:
        manipulation += 10
    manipulation = min(100, manipulation)

    # ── (D) source_quality — איכות מקורות מידע ──
    has_speech = bool(speech and len(speech.strip()) > 10)
    has_ocr = bool(ocr and len(ocr.strip()) > 5)
    has_captions = any(f.get("caption") for f in frames)
    has_objects = any(f.get("objects") for f in frames)
    has_summary = bool(summary and len(summary) > 50)
    source_count = sum([has_speech, has_ocr, has_captions])

    source_quality = 20  # base
    if has_speech: source_quality += 20
    if has_ocr: source_quality += 15
    if has_captions: source_quality += 15
    if has_objects: source_quality += 10
    if has_summary: source_quality += 10
    # הסכמה בין מקורות → איכות גבוהה
    if has_speech and has_ocr:
        s_words = set(speech.lower().split())
        o_words = set(ocr.lower().split())
        common = s_words & o_words - {'the','a','an','is','are','was','in','on','to','of','and','or',''}
        if len(common) > 5:
            source_quality += 10
        elif len(common) > 2:
            source_quality += 5
    source_quality = min(100, source_quality)

    return {
        "contradictions": contradictions,
        "absurdity": absurdity,
        "manipulation": manipulation,
        "source_quality": source_quality,
        "ai_probability": ai_probability,
        "source_count": source_count,
        "llm_narrative_class": narr.get("narrative_class", ""),
        "llm_narrative_confidence": narr.get("confidence", 50),
    }


def _calculate_truth(signals):
    """שלב 2A: Truth Score — כמה התוכן נכון עובדתית."""
    t = 100.0
    t -= signals["contradictions"] * 0.5
    t -= signals["absurdity"] * 0.7
    t -= (100 - signals["source_quality"]) * 0.6
    return max(0, min(100, int(t)))


def _calculate_authenticity(signals):
    """שלב 2B: Authenticity Score — כמה התוכן אמיתי טכנית."""
    a = 100.0
    a -= signals["manipulation"] * 0.7
    a -= signals["ai_probability"] * 0.3
    return max(0, min(100, int(a)))


def _calculate_confidence(signals):
    """שלב 2C: Confidence Level — כמה אנחנו בטוחים בתוצאות."""
    c = (
        (100 - signals["contradictions"]) * 0.3 +
        signals["source_quality"] * 0.4 +
        (100 - signals["manipulation"]) * 0.3
    )
    return max(0, min(100, int(c)))


def _classify_narrative(signals):
    """שלב 3: סיווג נרטיב — Narrative Override Logic."""
    llm_class = signals.get("llm_narrative_class", "").lower()

    # ── חוק עליון: אבסורד או סתירות גבוהות → סאטירה ──
    if signals["absurdity"] > 60 or (signals["contradictions"] > 60 and signals["absurdity"] > 30):
        return "satire"

    # ── LLM classification (אם זמין ומהימן) ──
    if llm_class in ("satire", "parody"):
        return "satire"
    if llm_class == "fiction":
        return "fiction"
    if llm_class == "propaganda":
        return "propaganda"
    if llm_class == "misinformation":
        return "misinformation"
    if llm_class == "factual":
        return "factual"

    # ── ברירת מחדל לפי signals ──
    if signals["contradictions"] > 50 and signals["source_quality"] < 40:
        return "misinformation"
    return "factual"


def _apply_constraints(truth, authenticity, confidence, narrative_class, signals):
    """שלב 4: חוקים קשיחים — מניעת סתירות (CRITICAL ENGINE RULES)."""
    # ── אסור: truth > 80 AND contradictions > 50 ──
    if signals["contradictions"] > 50:
        truth = min(truth, 40)

    # ── אסור: absurdity > 60 → חובה סאטירה ──
    if signals["absurdity"] > 60:
        narrative_class = "satire"

    # ── חוקים קשיחים לסאטירה ──
    if narrative_class == "satire":
        truth = min(truth, 50)         # סאטירה = truth ≤ 50
        risk = "low"                   # סאטירה = סיכון נמוך תמיד
    elif truth < 40 and narrative_class in ("misinformation", "propaganda"):
        risk = "high"
    elif truth < 60:
        risk = "medium"
    else:
        risk = "low"

    # ── אסור: satire AND risk = high ──
    if narrative_class == "satire" and risk != "low":
        risk = "low"

    return truth, authenticity, confidence, narrative_class, risk


def _compute_scores(output, ai_step, narrative_result=None):
    """מנוע ניקוד ראשי — Production Scoring Engine.
    מחזיר JSON אחיד עם 3 צירים: Truth / Authenticity / Intent."""

    # שלב 1: חילוץ signals
    signals = _extract_signals(output, ai_step, narrative_result)

    # שלב 2: חישוב ציונים
    truth = _calculate_truth(signals)
    authenticity = _calculate_authenticity(signals)
    confidence = _calculate_confidence(signals)

    # שלב 3: סיווג נרטיב
    narrative_class = _classify_narrative(signals)

    # שלב 4: חוקים קשיחים + risk
    truth, authenticity, confidence, narrative_class, risk_level = \
        _apply_constraints(truth, authenticity, confidence, narrative_class, signals)

    is_satire = narrative_class in ("satire", "fiction")

    return {
        # ── ציונים ראשיים (3 צירים) ──
        "truth_score": truth,
        "authenticity_score": authenticity,
        "ai_probability": signals["ai_probability"],
        # ── סיווג ──
        "narrative_class": narrative_class,
        "risk_level": risk_level,
        "confidence_level": confidence,
        # ── signals גולמיים (לשקיפות) ──
        "signals": {
            "contradictions": signals["contradictions"],
            "absurdity": signals["absurdity"],
            "manipulation": signals["manipulation"],
            "source_quality": signals["source_quality"],
        },
        # ── דגלים ──
        "is_satire": is_satire,
        "source_count": signals["source_count"],
        # ── תאימות אחורה (UI ישן) ──
        "reliability": truth,
        "manipulation": signals["manipulation"],
    }


# ═══════════════════════════════════════════════════════════
#  CONSISTENCY ENGINE — Stage 4.5
#  SOURCE OF TRUTH — אף ערך UI לא יכול לסתור אחר.
#  רץ אחרי כל השלבים, כופה חוקי לוגיקה, מייצר output סופי.
# ═══════════════════════════════════════════════════════════
def _enforce_consistency(scores, intel_step, valid_step, evidence_step, narrative_step, research_step=None):
    """Consistency Engine — SOURCE OF TRUTH.
    לוקח את כל הפלטים ומכריח עקביות בין כל המדדים.
    כולל תוצאות מנוע המחקר OSINT.
    מחזיר dict סופי שרק הוא עובר ל-UI (read-only)."""

    intel = intel_step.get("parsed", {})
    valid = valid_step.get("parsed", {})
    evidence = (evidence_step or {}).get("parsed", {})
    narr = (narrative_step or {}).get("parsed", {})
    research = (research_step or {}).get("parsed", {})

    # ── שלב A: שליפת ערכים מהמנוע הדטרמיניסטי (source of truth) ──
    truth = scores["truth_score"]
    auth = scores["authenticity_score"]
    ai_prob = scores["ai_probability"]
    conf = scores["confidence_level"]
    narrative_class = scores["narrative_class"]
    risk = scores["risk_level"]
    signals = scores.get("signals", {})
    is_satire = scores.get("is_satire", False)

    # ── שלב B: קליטת SIGNALS מה-Intelligence LLM (לא ציונים!) ──
    # המודל מחזיר key_signals + content_type — משפיעים על הניקוד הדטרמיניסטי
    intel_signals = intel.get("key_signals", [])
    intel_content_type = intel.get("content_type", "").lower()

    # ── שלב B2: חיזוק ניקוד מ-Intelligence signals ──
    # אם ה-120B זיהה סתירות שהמנוע הדטרמיניסטי פספס — מעדכנים
    for sig in intel_signals:
        sig_lower = sig.lower() if isinstance(sig, str) else ""
        if "contradict" in sig_lower and signals.get("contradictions", 0) < 30:
            signals["contradictions"] = max(signals.get("contradictions", 0), 40)
            truth = min(truth, 55)
        if "humor" in sig_lower or "satire" in sig_lower or "parody" in sig_lower:
            if signals.get("absurdity", 0) < 30:
                signals["absurdity"] = max(signals.get("absurdity", 0), 40)
        if "unsourced" in sig_lower or "unverified" in sig_lower:
            if signals.get("source_quality", 50) > 40:
                signals["source_quality"] = min(signals.get("source_quality", 50), 45)
        if "nonsense" in sig_lower:
            signals["absurdity"] = max(signals.get("absurdity", 0), 50)

    # ── שלב B3: אם Intelligence content_type שונה מ-scoring — שוקלים override ──
    if intel_content_type in ("satire", "parody") and not is_satire:
        # 120B אומר סאטירה אבל scoring לא — אם absurdity כבר > 20, סומכים עליו
        if signals.get("absurdity", 0) > 20:
            narrative_class = "satire"
            is_satire = True
    elif intel_content_type == "misinformation" and narrative_class == "factual":
        # 120B אומר misinformation — אם יש סתירות, סומכים
        if signals.get("contradictions", 0) > 20:
            narrative_class = "misinformation"
    valid_ok = valid.get("is_valid", True)
    valid_issues = valid.get("issues", [])
    evidence_quality = evidence.get("evidence_quality", "Moderate")
    missing_steps = []

    # ── שלב C: זיהוי שגיאות מודל (500 errors / missing data) ──
    for step_name, step_data in [("intelligence", intel_step), ("validation", valid_step)]:
        resp = step_data.get("response", "")
        if isinstance(resp, str) and resp.startswith("ERROR"):
            missing_steps.append(step_name)

    # ── שלב D: הורדת confidence אם יש שלבים חסרים ──
    if missing_steps:
        penalty = len(missing_steps) * 20
        conf = max(10, conf - penalty)
        log.warning(f"Consistency: missing steps {missing_steps}, confidence reduced by {penalty}")

    # ── שלב E: הורדת confidence אם הvalidation נכשל ──
    if not valid_ok:
        conf = min(conf, 50)
        raw_cc = valid.get("corrected_confidence")
        if raw_cc is not None:
            # LLM יכול להחזיר מספר או טקסט ("Low"/"Medium"/"High") — המרה בטוחה
            if isinstance(raw_cc, (int, float)):
                conf = min(conf, int(raw_cc))
            elif isinstance(raw_cc, str) and raw_cc.isdigit():
                conf = min(conf, int(raw_cc))
            else:
                # טקסט כמו "Low", "Medium", "High" → ממפה למספר
                text_map = {"very low": 15, "low": 25, "medium": 50, "high": 75, "very high": 90}
                conf = min(conf, text_map.get(str(raw_cc).lower(), 30))

    # ═══════════════════════════════════════════════
    #  חוקי לוגיקה קשיחים (HARD CONSTRAINTS)
    # ═══════════════════════════════════════════════

    # ── חוק 1: manipulation > 60 → truth ≤ 40 ──
    if signals.get("manipulation", 0) > 60:
        truth = min(truth, 40)

    # ── חוק 2: contradictions > 50 → truth ≤ 40 ──
    if signals.get("contradictions", 0) > 50:
        truth = min(truth, 40)

    # ── חוק 3: סאטירה → truth לא רלוונטי, risk = misinterpretation ──
    if is_satire:
        truth = max(30, min(truth, 50))
        risk = "medium"  # סיכון להטעיה — עלול להטעות אם מוצג ללא הקשר
        narrative_class = "satire"

    # ── חוק 4: incoherent content → manipulation += 20 ──
    absurd = signals.get("absurdity", 0)
    if absurd > 40 and not is_satire:
        # תוכן לא קוהרנטי שאינו סאטירה = חשוד
        signals["manipulation"] = min(100, signals.get("manipulation", 0) + 20)
        auth = max(0, auth - 15)

    # ── חוק 5: confidence תלוי בכמות ראיות ──
    if evidence_quality == "Weak" or evidence_quality == "None":
        conf = min(conf, 40)
    elif evidence_quality == "Strong":
        conf = max(conf, 60)

    # ── חוק 6: authenticity = 0 → risk חייב להיות high (אם לא סאטירה) ──
    if auth <= 10 and not is_satire:
        risk = "high"
    if auth <= 30 and not is_satire and risk == "low":
        risk = "medium"

    # ── חוק 7: truth > 80 AND contradiction > 50 = אסור (כבר ב-compute, כפל ביטחון) ──
    if truth > 80 and signals.get("contradictions", 0) > 50:
        truth = 40  # force fix

    # ── חוק 8: truth > 80 AND "fake content" label → forbidden ──
    intel_findings = intel.get("key_findings", [])
    if truth > 80:
        for finding in intel_findings:
            fl = (finding or "").lower()
            if any(w in fl for w in ["fake", "fabricat", "forged", "deepfake", "misleading"]):
                truth = min(truth, 50)
                break

    # ── חוק 9: satire AND risk = high = forbidden → medium (סיכון להטעיה בלבד) ──
    if is_satire and risk == "high":
        risk = "medium"

    # ── חוק 10.5: misinformation/propaganda AND risk = low → חייב להיות לפחות medium ──
    if narrative_class in ("misinformation", "propaganda", "misleading") and risk == "low":
        risk = "medium"

    # ── חוק 11: ai_probability > 70 → authenticity ≤ 50 ──
    if ai_prob > 70:
        auth = min(auth, 50)

    # ═══════════════════════════════════════════════
    #  חוק 12: REALITY CHECK — השפעת תוצאות הצלבת מציאות על ניקוד
    #  תומך בפורמט חדש (4 סטטוסים + reliability) ובפורמט ישן (backward compat)
    # ═══════════════════════════════════════════════
    r_contradicted = research.get("contradicted", [])
    r_verified = research.get("verified", [])
    r_partially = research.get("partially_verified", [])
    r_not_verified = research.get("not_verified", [])
    r_unverified = research.get("unverified", [])  # backward compat
    reliability = research.get("reliability", {})
    total_claims = (len(r_contradicted) + len(r_verified)
                    + len(r_partially) + len(r_not_verified))
    # fallback לפורמט ישן
    if total_claims == 0:
        total_claims = len(r_contradicted) + len(r_verified) + len(r_unverified)

    if total_claims > 0:
        # ── טענות סותרות → מוריד truth ──
        if len(r_contradicted) > 0:
            penalty = min(30, len(r_contradicted) * 10)
            truth = max(10, truth - penalty)
            if len(r_contradicted) >= 2 and risk == "low":
                risk = "medium"

        # ── טענות מאומתות → מחזק confidence ──
        if len(r_verified) > 0:
            boost = min(15, len(r_verified) * 5)
            conf = min(95, conf + boost)

        # ── טענות מאומתות חלקית → boost קטן ──
        if len(r_partially) > 0:
            boost = min(8, len(r_partially) * 3)
            conf = min(90, conf + boost)

        # ── רוב הטענות לא מאומתות → מוריד confidence ──
        unverified_count = len(r_not_verified) + len(r_unverified)
        unverified_ratio = unverified_count / total_claims if total_claims else 0
        if unverified_ratio > 0.6:
            conf = min(conf, 45)

        # ── distortion level → השפעה על truth ──
        distortion = research.get("distortion_level", "none").lower()
        if distortion == "high":
            truth = min(truth, 30)
            if risk == "low":
                risk = "medium"
        elif distortion == "medium":
            truth = min(truth, 50)

        # ── reliability override: אם final_reliability נמוך מ-truth → מוריד ──
        final_rel = reliability.get("final_reliability", 0)
        if final_rel > 0 and final_rel < truth - 20:
            truth = max(10, int((truth + final_rel) / 2))

    # ═══════════════════════════════════════════════
    #  CONTENT CLASSIFICATION LAYER
    # ═══════════════════════════════════════════════
    # קובע: content_type, intent, factual_mode — UI משתנה אוטומטית לפי זה
    if is_satire:
        content_type = "satire"
        intent = "entertainment"
        factual_mode = False
    elif narrative_class in ("propaganda", "misinformation", "misleading"):
        content_type = "misleading"
        intent = "influence"
        factual_mode = True  # מידע מטעה = מציג עצמו כעובדתי, אז ציון אמינות רלוונטי
    elif narrative_class in ("fiction",):
        content_type = "fiction"
        intent = "entertainment"
        factual_mode = False
    else:
        content_type = "factual"
        intent = "informational"
        factual_mode = True

    # ═══════════════════════════════════════════════
    #  סיבות לביטחון נמוך (להצגה ב-UI)
    # ═══════════════════════════════════════════════
    confidence_reasons = []
    if missing_steps:
        confidence_reasons.append("שלבי ניתוח חסרים")
    if not valid_ok:
        confidence_reasons.append("בעיות שזוהו באימות תוצאות")
    if evidence_quality in ("Weak", "None"):
        confidence_reasons.append("ראיות חלשות או חסרות")
    # בדיקת מקור לא ידוע
    source_unknown = True
    for f in intel.get("key_findings", []):
        fl = (f or "").lower()
        if any(w in fl for w in ["verified source", "known source", "official", "confirmed"]):
            source_unknown = False
            break
    if source_unknown:
        confidence_reasons.append("מקור לא מזוהה")
    # בדיקת OCR פגום
    ocr_issues = signals.get("contradictions", 0) > 30
    if ocr_issues:
        confidence_reasons.append("חוסר עקביות בין מקורות")

    # ═══════════════════════════════════════════════
    #  סוג סיכון מפורט (במקום רק low/medium/high)
    # ═══════════════════════════════════════════════
    if is_satire:
        risk_type = "misinterpretation"  # סיכון להטעיה
        risk_detail = "עלול להטעות אם מוצג ללא הקשר"
    elif narrative_class in ("propaganda", "misinformation", "misleading"):
        risk_type = "misinformation"  # סיכון כמידע שקרי
        risk_detail = "תוכן שעלול להציג מידע שגוי כעובדה"
    elif ai_prob > 70:
        risk_type = "synthetic"  # סיכון כתוכן מלאכותי
        risk_detail = "זוהו סימנים ליצירה מלאכותית"
    else:
        risk_type = "general"
        risk_detail = ""

    # ═══════════════════════════════════════════════
    #  בניית UI DATA סופי (read-only לממשק)
    # ═══════════════════════════════════════════════
    narrative_display = narrative_class.capitalize() if narrative_class else "Unclear"

    # ── filtered assessment + findings ──
    filtered_assessment = evidence.get("filtered_assessment", intel.get("final_assessment", ""))
    filtered_findings = evidence.get("filtered_findings", intel.get("key_findings", []))

    # ── Tags: מילות מפתח קצרות בלבד (לא משפטים שלמים!) ──
    # נבנה תגיות מבוססות מטאדטה — לא מ-findings
    ui_tags = []
    if is_satire:
        ui_tags = ["satire", "parody", "humor"]
    else:
        # תגית narrative
        if narrative_class and narrative_class != "unclear":
            ui_tags.append(narrative_class)
        # תגית risk
        if risk in ("high", "medium"):
            ui_tags.append(f"{risk} risk")
        # תגית evidence quality
        if evidence_quality in ("Weak", "Insufficient"):
            ui_tags.append("low confidence")
        elif evidence_quality == "Strong":
            ui_tags.append("high confidence")
        # תגית AI
        if ai_prob > 70:
            ui_tags.append("ai-generated")
        elif ai_prob > 30:
            ui_tags.append("mixed signals")
        # תגית שפה (מזוהה מ-speech/ocr)
        speech_text = (intel.get("final_assessment", "") or "")
        if any(c in speech_text for c in "אבגדהוזחטיכלמנסעפצקרשת"):
            ui_tags.append("Hebrew")
        # הסרת כפילויות
        ui_tags = list(dict.fromkeys(ui_tags))[:5]
    # ── Flags: רק מילות מפתח קצרות, לא משפטים ארוכים מה-LLM ──
    ui_flags = []
    if not is_satire:
        raw_uncertainties = intel.get("uncertainties", [])
        for u in raw_uncertainties[:3]:
            if isinstance(u, str) and len(u) <= 60:
                ui_flags.append(u)
            # משפטים ארוכים — לא מוצגים כתגיות, נשארים ב-intel section

    # ── system_trust: מבוסס על validation + evidence ──
    system_trust = "HIGH" if valid_ok and evidence_quality in ("Strong", "Moderate") and not missing_steps else "LOW"

    return {
        # ── UI METRICS (source of truth — הערכים היחידים ש-UI רואה) ──
        "ui_metrics": {
            "truth_score": truth,
            "authenticity_score": auth,
            "ai_probability": ai_prob,
            "narrative": narrative_display,
            "risk_level": risk.capitalize(),
            "confidence_level": conf,
            # תאימות אחורה
            "reliability": truth,
            "manipulation": risk.capitalize(),
        },
        # ── CONTENT CLASSIFICATION (UI משתנה לפי זה) ──
        "content_type": content_type,
        "intent": intent,
        "factual_mode": factual_mode,
        # ── RISK DETAIL (סוג סיכון מפורט) ──
        "risk_type": risk_type,
        "risk_detail": risk_detail,
        # ── CONFIDENCE REASONS (הסבר למה ביטחון נמוך) ──
        "confidence_reasons": confidence_reasons,
        # ── UI TEXT (LLM generates, consistency validates) ──
        "ui_summary": filtered_assessment,
        "ui_tags": ui_tags,
        "ui_flags": ui_flags,
        # ── Evidence ──
        "verified_findings": filtered_findings,
        "removed_claims": evidence.get("removed_claims", []),
        "evidence_quality": evidence_quality,
        "system_trust": system_trust,
        # ── Narrative / Satire data ──
        "satire_detected": is_satire,
        "narrative_class": narrative_class,
        "risk_level": risk,
        "signals": signals,
        "humor_signals": narr.get("humor_signals", []),
        # ── OSINT RESEARCH (תוצאות מנוע המחקר) ──
        "research": {
            "claims": research.get("claims", []),
            "verified": research.get("verified", []),
            "contradicted": research.get("contradicted", []),
            "unverified": research.get("unverified", []),
            "context_summary": research.get("context_summary", ""),
            "questions": research.get("questions", []),
            "is_part_of_larger_event": research.get("is_part_of_larger_event", False),
            "event_type": research.get("event_type", "Other"),
            "context_level": research.get("context_level", "Low"),
            "context_explanation": research.get("context_explanation", ""),
            "sources_searched": research.get("sources_searched", 0),
        },
        # ── Meta ──
        "missing_steps": missing_steps,
        "consistency_applied": True,
    }


# ── NARRATIVE CLASSIFIER — שכבת סיווג נרטיב (לפני Intelligence) ──
async def stage_narrative_classifier(output, token):
    """סיווג כוונת הנרטיב: סאטירה / פרודיה / תעמולה / מידע שגוי / עובדתי"""
    speech = (output.get("speech_text", "") or "")[:1500]
    ocr = (output.get("ocr_text", "") or "")[:1000]
    merged = (output.get("merged_text", "") or "")[:2000]
    summary = (output.get("summary", "") or "")[:1000]
    objects = list(set(
        o for f in output.get("frames", [])
        for o in (f.get("objects", []) if isinstance(f.get("objects"), list) else [])
    ))[:20]

    user_msg = json.dumps({
        "speech_text": speech,
        "ocr_text": ocr,
        "merged_text": merged,
        "summary": summary,
        "questions": output.get("questions", []),
        "objects": objects,
    }, ensure_ascii=False)

    resp, ms = await _api_chat_120b(
        f"CONTENT DATA:\n{user_msg}", token,
        system=P_NARRATIVE_CLASS, max_tok=512
    )
    parsed = _extract_json(resp)

    # ── ברירות מחדל אם ה-JSON חלקי ──
    parsed.setdefault("narrative_class", "Factual")
    parsed.setdefault("confidence", 50)
    parsed.setdefault("absurdity_detected", False)
    parsed.setdefault("humor_signals", [])
    parsed.setdefault("risk_override", False)

    return {
        "step": "narrative_classifier", "name": "narrative_classifier",
        "model": LLM_120B, "prompt": P_NARRATIVE_CLASS,
        "response": resp, "parsed": parsed,
        "duration_ms": ms,
    }


# ── STAGE 3: Intelligence LLM (120B) ──
async def stage_intelligence(output, meta, scores, token, narrative_result=None):
    # ── שילוב תוצאת Narrative Classifier אם זמינה ──
    narr_class = (narrative_result or {}).get("parsed", {})
    input_data = {
        "meta": meta,
        "speech_text": (output.get("speech_text", "") or "")[:1500],
        "ocr_text": (output.get("ocr_text", "") or "")[:1000],
        "merged_text": (output.get("merged_text", "") or "")[:2000],
        "summary": (output.get("summary", "") or "")[:1000],
        "questions": output.get("questions", []),
        "preliminary_scores": scores,
        "objects": [f.get("objects", []) for f in output.get("frames", [])[:5]],
    }
    if narr_class:
        input_data["narrative_classification"] = narr_class
    input_json = json.dumps(input_data, ensure_ascii=False)

    user_msg = f"INPUT DATA:\n{input_json}"
    resp, ms = await _api_chat_120b(user_msg, token, system=P_INTELLIGENCE)
    parsed = _extract_json(resp)

    return {
        "step": "intelligence", "name": "intelligence_analysis",
        "model": LLM_120B, "prompt": P_INTELLIGENCE,
        "user_input": user_msg[:600] + "...",
        "response": resp, "parsed": parsed,
        "duration_ms": ms,
    }


# ── STAGE 3.5: Evidence Filter ──
async def stage_evidence_filter(output, intelligence_step, validation_step, token):
    intel = intelligence_step.get("parsed", {})
    valid_issues = validation_step.get("parsed", {}).get("issues", [])
    original_data = json.dumps({
        "speech_text": (output.get("speech_text", "") or "")[:1000],
        "ocr_text": (output.get("ocr_text", "") or "")[:800],
        "summary": (output.get("summary", "") or "")[:800],
        "objects": list(set(
            o for f in output.get("frames", [])
            for o in (f.get("objects", []) if isinstance(f.get("objects"), list) else [])
        ))[:20],
    }, ensure_ascii=False)

    user_msg = (
        f"ORIGINAL STRUCTURED DATA:\n{original_data}\n\n"
        f"LLM ANALYSIS OUTPUT:\n{json.dumps(intel, ensure_ascii=False)}\n\n"
        f"VALIDATION ISSUES:\n{json.dumps(valid_issues, ensure_ascii=False)}"
    )
    resp, ms = await _api_chat_120b(user_msg, token, system=P_EVIDENCE_FILTER, max_tok=1024)
    parsed = _extract_json(resp)

    # Ensure required keys
    if "filtered_assessment" not in parsed:
        parsed["filtered_assessment"] = intel.get("final_assessment", "")
    if "filtered_findings" not in parsed:
        parsed["filtered_findings"] = intel.get("key_findings", [])
    if "removed_claims" not in parsed:
        parsed["removed_claims"] = []
    if "evidence_quality" not in parsed:
        parsed["evidence_quality"] = "Moderate"

    return {
        "step": "evidence_filter", "name": "evidence_filter",
        "model": LLM_120B, "prompt": P_EVIDENCE_FILTER,
        "response": resp, "parsed": parsed,
        "duration_ms": ms,
    }


# ── STAGE 4: Anti-Hallucination Validation ──
async def stage_validation(original_data_summary, intelligence_step, token):
    user_msg = (
        f"ORIGINAL DATA SUMMARY:\n{original_data_summary[:2000]}\n\n"
        f"MODEL OUTPUT:\n{json.dumps(intelligence_step.get('parsed', {}), ensure_ascii=False)}"
    )
    resp, ms = await _api_chat_120b(user_msg, token, system=P_VALIDATION)
    parsed = _extract_json(resp)

    return {
        "step": "validation", "name": "anti_hallucination",
        "model": LLM_120B, "prompt": P_VALIDATION,
        "response": resp, "parsed": parsed,
        "duration_ms": ms,
    }


# ── STAGE 5: UI Adapter (PASSIVE — read-only, no logic) ──
# ה-LLM מייצר טקסט בלבד (סיכום, תיאור).
# כל הציונים, התגיות, והדגלים מגיעים אך ורק מ-Consistency Engine.
async def stage_ui_adapter(intelligence_step, consistency_data, token, narrative_result=None):
    """UI Adapter — PASSIVE. LLM generates text only, all metrics come from Consistency Engine."""
    intel = intelligence_step.get("parsed", {})
    narr = (narrative_result or {}).get("parsed", {})

    # ── LLM call: מייצר טקסט לסיכום UI בלבד ──
    adapter_input = {**intel}
    if narr:
        adapter_input["narrative_classification"] = narr
    # ספק ל-LLM את ה-consistency metrics כקלט כדי שיתאים טקסט
    adapter_input["final_metrics"] = consistency_data.get("ui_metrics", {})
    user_msg = f"ANALYSIS RESULT:\n{json.dumps(adapter_input, ensure_ascii=False)}"
    resp, ms = await _api_chat_120b(user_msg, token, system=P_UI_ADAPTER, max_tok=1024)
    llm_parsed = _extract_json(resp)

    # ══ PASSIVE: ה-LLM לא קובע ציונים — רק טקסט ══
    # לוקחים מה-LLM רק: ui_summary (טקסט סיכום)
    # כל השאר מגיע מ-Consistency Engine (source of truth)
    final = dict(consistency_data)  # copy consistency output

    # ── אם LLM הצליח לייצר סיכום טוב יותר — משתמשים בו ──
    llm_summary = llm_parsed.get("ui_summary", "")
    if llm_summary and len(llm_summary) > 20:
        final["ui_summary"] = llm_summary

    return {
        "step": "ui_adapter", "name": "ui_adapter",
        "model": LLM_120B, "prompt": P_UI_ADAPTER,
        "response": resp, "parsed": final,
        "duration_ms": ms,
    }


# ═══════════════════════════════════════════════════════════
#  REALITY CHECK ENGINE — Multi-Source Research & Verification
#  שלב: אחרי Intelligence, לפני Validation
#  מטרה: להצליב כל טענה מול העולם האמיתי — חדשות, ויקיפדיה, fact-check
#  Flow: Claims → Questions → Multi-Search → Verify → Context → Reliability
# ═══════════════════════════════════════════════════════════

DEFAULT_RSS_FEEDS = [
    "https://www.ynet.co.il/Integration/StoryRss2.xml",
    "https://www.jpost.com/rss/rssfeedsheadlines.aspx",
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.now14.co.il/feed/",
    "https://www.timesofisrael.com/feed/",
    "https://www.abc.net.au/news/feed/51120/rss.xml",
    "https://www.theguardian.com/uk/rss",
    "https://www.theguardian.com/world/rss",
    "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    "https://www.ft.com/world?format=rss",
    "https://rss.dw.com/rdf/rss-en-all",
    "https://www.euronews.com/rss?level=theme&name=news",
    "https://www.scmp.com/rss/91/feed/",
    "https://feeds.npr.org/1004/rss.xml",
    "https://www.cbsnews.com/latest/rss/world",
    "https://feeds.skynews.com/feeds/rss/world.xml",
    "https://www.france24.com/en/rss",
    "https://www.npr.org/rss/rss.php?id=1004",
]


def _load_rss_feeds():
    env_val = (os.getenv("RSS_FEED_URLS", "") or "").strip()
    if env_val:
        feeds = [x.strip() for x in env_val.split(",") if x.strip()]
        if feeds:
            return feeds
    return DEFAULT_RSS_FEEDS


def _strip_html(text):
    cleaned = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", cleaned).strip()


def _contains_hebrew(text):
    return bool(re.search(r"[\u0590-\u05FF]", text or ""))


async def _translate_questions(questions, token, to_lang="he"):
    if not questions:
        return []
    if to_lang == "he":
        system = P_TRANSLATE_TO_HE
        key = "questions_he"
    else:
        system = P_TRANSLATE_TO_EN
        key = "questions_en"
    user_msg = f"QUESTIONS:\n{json.dumps(questions, ensure_ascii=False)}"
    resp, _ = await _api_chat(user_msg, token, system=system, max_tok=800)
    parsed = _extract_json(resp)
    vals = parsed.get(key, []) if isinstance(parsed, dict) else []
    return [v for v in vals if isinstance(v, str) and len(v.strip()) > 2]


def get_connected_sources():
    """Expose connected data sources for CPanel diagnostics."""
    rss_feeds = _load_rss_feeds()
    return {
        "languages": ["he", "en"],
        "engines": [
            {"id": "duckduckgo", "enabled": True, "type": "web_search"},
            {"id": "duckduckgo_web", "enabled": True, "type": "web_search"},
            {"id": "google_web", "enabled": True, "type": "web_search"},
            {"id": "bing_web", "enabled": True, "type": "web_search"},
            {"id": "wikipedia", "enabled": True, "type": "knowledge_base"},
            {"id": "wikidata", "enabled": True, "type": "knowledge_base"},
            {"id": "arxiv", "enabled": True, "type": "research_papers"},
            {"id": "openalex", "enabled": True, "type": "research_papers"},
            {"id": "crossref", "enabled": True, "type": "research_papers"},
            {"id": "pubmed", "enabled": True, "type": "research_papers"},
            {"id": "hackernews", "enabled": True, "type": "tech_news"},
            {"id": "gdelt", "enabled": True, "type": "global_news"},
            {"id": "rss_feeds", "enabled": bool(rss_feeds), "type": "news_feeds", "feed_count": len(rss_feeds)},
            {"id": "reddit_comments", "enabled": True, "type": "user_comments"},
            {"id": "facebook_public", "enabled": True, "type": "public_web_search"},
            {"id": "google_factcheck", "enabled": bool(os.environ.get("GOOGLE_FACTCHECK_KEY", "")), "type": "fact_check"},
            {"id": "newsapi", "enabled": bool(os.environ.get("NEWS_API_KEY", "")), "type": "news_api"},
            {"id": "google_custom_search", "enabled": bool(os.environ.get("GOOGLE_CSE_KEY", "") and os.environ.get("GOOGLE_CSE_CX", "")), "type": "web_search"},
        ],
        "rss_feeds": rss_feeds,
        "notes": {
            "google_ai_overview": "No official public API for Google AI Overview text extraction.",
            "comments": "Reddit public search is integrated as user-comment signal.",
        },
    }

# ── SEARCH LAYER: DuckDuckGo ──
async def _search_duckduckgo(query):
    """חיפוש חינמי ב-DuckDuckGo Instant Answer API — ללא API key"""
    url = "https://api.duckduckgo.com/"
    params = {"q": query, "format": "json", "no_redirect": "1", "no_html": "1"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.get(url, params=params)
            data = resp.json()
            abstract = data.get("Abstract", "")
            source = data.get("AbstractSource", "")
            related = [
                t.get("Text", "") for t in data.get("RelatedTopics", [])[:3]
                if isinstance(t, dict) and t.get("Text")
            ]
            return {"abstract": abstract, "source": source, "related": related, "engine": "duckduckgo"}
    except Exception as e:
        log.warning(f"DuckDuckGo search failed for '{query[:50]}': {e}")
        return {"abstract": "", "source": "", "related": [], "engine": "duckduckgo", "error": str(e)}


async def _search_duckduckgo_web(query):
    """DuckDuckGo HTML results with URLs (no API key)."""
    url = "https://duckduckgo.com/html/"
    params = {"q": query}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(12.0), follow_redirects=True) as client:
            resp = await client.get(url, params=params, headers={"User-Agent": "Mozilla/5.0"})
            html = resp.text
            raw_links = re.findall(r'href="((?:https?:)?//duckduckgo.com/l/\?[^\"]+)"', html)[:20]
            items = []
            for rl in raw_links:
                if rl.startswith("//"):
                    rl = "https:" + rl
                qs = parse_qs(urlparse(rl).query)
                uddg = (qs.get("uddg") or [""])[0]
                link = unquote(uddg) if uddg else ""
                if not link:
                    continue
                if any(bad in link for bad in ["duckduckgo.com", "javascript:"]):
                    continue
                items.append({"title": "", "snippet": "", "link": link})
                if len(items) >= 5:
                    break
            return {"items": items, "engine": "duckduckgo_web"}
    except Exception as e:
        return {"items": [], "engine": "duckduckgo_web", "error": str(e)}


async def _search_google_web(query):
    """Google web search via public HTML (no API key)."""
    url = "https://www.google.com/search"
    params = {"q": query, "num": "7", "hl": "en", "gbv": "1"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(12.0), follow_redirects=True) as client:
            resp = await client.get(
                url,
                params=params,
                headers={
                    "User-Agent": "Mozilla/5.0",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            )
            html = resp.text
            links = re.findall(r'href="/url\?q=(https?://[^&\"]+)', html)[:20]
            if not links:
                links = re.findall(r'href="(https?://[^\"]+)"', html)[:40]
            items = []
            for link in links:
                clean = unquote(link)
                if any(x in clean for x in ["google.com", "webcache.googleusercontent.com"]):
                    continue
                items.append({"title": "", "snippet": "", "link": clean})
                if len(items) >= 5:
                    break
            return {"items": items, "engine": "google_web"}
    except Exception as e:
        return {"items": [], "engine": "google_web", "error": str(e)}


async def _search_bing_web(query):
    """Bing web search via public HTML (no API key)."""
    url = "https://www.bing.com/search"
    params = {"q": query, "count": "8", "setlang": "en"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(12.0), follow_redirects=True) as client:
            resp = await client.get(
                url,
                params=params,
                headers={
                    "User-Agent": "Mozilla/5.0",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            )
            html = resp.text
            links = re.findall(r'<a href="(https?://[^\"]+)" h="ID=', html)[:25]
            items = []
            for link in links:
                clean = unquote(link)
                if any(x in clean for x in ["bing.com", "microsoft.com"]):
                    continue
                items.append({"title": "", "snippet": "", "link": clean})
                if len(items) >= 5:
                    break
            return {"items": items, "engine": "bing_web"}
    except Exception as e:
        return {"items": [], "engine": "bing_web", "error": str(e)}


async def _search_wikidata(query):
    """Wikidata entity search (free, no key)."""
    url = "https://www.wikidata.org/w/api.php"
    params = {
        "action": "wbsearchentities",
        "format": "json",
        "language": "en",
        "uselang": "en",
        "search": query,
        "limit": "5",
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.get(url, params=params, headers={"User-Agent": "MediaAnalyzerV2/1.0"})
            data = resp.json()
            items = []
            for e in data.get("search", [])[:5]:
                items.append(
                    {
                        "id": e.get("id", ""),
                        "label": e.get("label", ""),
                        "description": e.get("description", ""),
                        "url": e.get("concepturi", ""),
                    }
                )
            return {"items": items, "engine": "wikidata"}
    except Exception as e:
        return {"items": [], "engine": "wikidata", "error": str(e)}


async def _search_arxiv(query):
    """arXiv public API search (free, no key)."""
    url = "https://export.arxiv.org/api/query"
    params = {"search_query": f"all:{query}", "start": "0", "max_results": "5"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(12.0)) as client:
            resp = await client.get(url, params=params, headers={"User-Agent": "MediaAnalyzerV2/1.0"})
            if resp.status_code != 200:
                return {
                    "entries": [],
                    "engine": "arxiv",
                    "error": f"HTTP {resp.status_code}",
                    "note": "rate_limited_or_unavailable",
                }
            root = ET.fromstring(resp.text)
            ns = {"a": "http://www.w3.org/2005/Atom"}
            entries = []
            for entry in root.findall("a:entry", ns)[:5]:
                title = _strip_html(entry.findtext("a:title", default="", namespaces=ns))
                summary = _strip_html(entry.findtext("a:summary", default="", namespaces=ns))
                link = ""
                for l in entry.findall("a:link", ns):
                    href = (l.attrib.get("href") or "").strip()
                    rel = (l.attrib.get("rel") or "").strip()
                    if href and (rel == "alternate" or "arxiv.org/abs/" in href):
                        link = href
                        break
                entries.append({"title": title, "summary": summary[:500], "link": link})
            return {"entries": entries, "engine": "arxiv"}
    except Exception as e:
        return {"entries": [], "engine": "arxiv", "error": str(e)}


async def _search_openalex(query):
    """OpenAlex works search (free, no key)."""
    url = "https://api.openalex.org/works"
    params = {"search": query, "per-page": "5"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(12.0)) as client:
            resp = await client.get(url, params=params, headers={"User-Agent": "MediaAnalyzerV2/1.0"})
            data = resp.json()
            items = []
            for w in data.get("results", [])[:5]:
                items.append(
                    {
                        "title": (w.get("title") or "")[:300],
                        "year": w.get("publication_year"),
                        "doi": w.get("doi") or "",
                        "url": w.get("id") or "",
                    }
                )
            return {"items": items, "engine": "openalex"}
    except Exception as e:
        return {"items": [], "engine": "openalex", "error": str(e)}


async def _search_crossref(query):
    """Crossref works search (free, no key)."""
    url = "https://api.crossref.org/works"
    params = {"query": query, "rows": "5"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(12.0)) as client:
            resp = await client.get(url, params=params, headers={"User-Agent": "MediaAnalyzerV2/1.0"})
            data = resp.json().get("message", {})
            items = []
            for w in data.get("items", [])[:5]:
                title = ""
                if isinstance(w.get("title"), list) and w.get("title"):
                    title = w.get("title")[0]
                items.append(
                    {
                        "title": (title or "")[:300],
                        "doi": w.get("DOI") or "",
                        "publisher": w.get("publisher") or "",
                        "url": w.get("URL") or "",
                    }
                )
            return {"items": items, "engine": "crossref"}
    except Exception as e:
        return {"items": [], "engine": "crossref", "error": str(e)}


async def _search_pubmed(query):
    """PubMed search via NCBI E-utilities (free, no key)."""
    base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(12.0)) as client:
            s = await client.get(
                f"{base}/esearch.fcgi",
                params={"db": "pubmed", "term": query, "retmode": "json", "retmax": "5"},
                headers={"User-Agent": "MediaAnalyzerV2/1.0"},
            )
            ids = (s.json().get("esearchresult", {}) or {}).get("idlist", [])[:5]
            if not ids:
                return {"items": [], "engine": "pubmed"}
            d = await client.get(
                f"{base}/esummary.fcgi",
                params={"db": "pubmed", "id": ",".join(ids), "retmode": "json"},
                headers={"User-Agent": "MediaAnalyzerV2/1.0"},
            )
            data = d.json().get("result", {})
            items = []
            for pid in ids:
                row = data.get(pid, {})
                items.append(
                    {
                        "pmid": pid,
                        "title": (row.get("title") or "")[:300],
                        "pubdate": row.get("pubdate") or "",
                        "url": f"https://pubmed.ncbi.nlm.nih.gov/{pid}/",
                    }
                )
            return {"items": items, "engine": "pubmed"}
    except Exception as e:
        return {"items": [], "engine": "pubmed", "error": str(e)}


async def _search_hackernews(query):
    """Hacker News via Algolia API (free, no key)."""
    url = "https://hn.algolia.com/api/v1/search"
    params = {"query": query, "tags": "story", "hitsPerPage": "5"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.get(url, params=params)
            hits = resp.json().get("hits", [])[:5]
            items = []
            for h in hits:
                items.append(
                    {
                        "title": h.get("title") or "",
                        "url": h.get("url") or f"https://news.ycombinator.com/item?id={h.get('objectID','')}",
                        "points": h.get("points", 0),
                    }
                )
            return {"items": items, "engine": "hackernews"}
    except Exception as e:
        return {"items": [], "engine": "hackernews", "error": str(e)}


async def _search_gdelt(query):
    """GDELT DOC API (free, no key) for global news articles."""
    url = "https://api.gdeltproject.org/api/v2/doc/doc"
    params = {
        "query": query,
        "mode": "ArtList",
        "maxrecords": "5",
        "format": "json",
        "sort": "DateDesc",
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(12.0)) as client:
            resp = await client.get(url, params=params, headers={"User-Agent": "MediaAnalyzerV2/1.0"})
            data = resp.json()
            articles = []
            for a in data.get("articles", [])[:5]:
                articles.append(
                    {
                        "title": a.get("title") or "",
                        "source": a.get("domain") or "",
                        "url": a.get("url") or "",
                        "seendate": a.get("seendate") or "",
                    }
                )
            return {"articles": articles, "engine": "gdelt"}
    except Exception as e:
        return {"articles": [], "engine": "gdelt", "error": str(e)}


async def _search_facebook_public(query):
    """Facebook public-web discovery without API key (searches indexed public Facebook URLs)."""
    site_query = f"site:facebook.com {query}"
    google_res = await _search_google_web(site_query)
    links = []
    for it in google_res.get("items", [])[:10]:
        link = (it.get("link") or "").strip()
        if "facebook.com" in link:
            links.append(link)

    if not links:
        ddg_res = await _search_duckduckgo_web(site_query)
        for it in ddg_res.get("items", [])[:10]:
            link = (it.get("link") or "").strip()
            if "facebook.com" in link:
                links.append(link)

    unique = []
    for l in links:
        if l not in unique:
            unique.append(l)
    return {"links": unique[:5], "engine": "facebook_public"}


# ── SEARCH LAYER: Wikipedia REST API ──
async def _search_wikipedia(query):
    """חיפוש בוויקיפדיה — REST API, ללא API key"""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
            # ניסיון ישיר לפי שם ערך
            direct_url = "https://en.wikipedia.org/api/rest_v1/page/summary/" + query.replace(" ", "_")
            resp = await client.get(direct_url, headers={"User-Agent": "MediaAnalyzerV2/1.0"})
            if resp.status_code == 200:
                data = resp.json()
                return {
                    "title": data.get("title", ""),
                    "extract": data.get("extract", ""),
                    "url": data.get("content_urls", {}).get("desktop", {}).get("page", ""),
                    "engine": "wikipedia",
                }
            # fallback — חיפוש חופשי
            search_api = "https://en.wikipedia.org/w/api.php"
            params = {"action": "query", "list": "search", "srsearch": query,
                      "srlimit": "3", "format": "json"}
            resp2 = await client.get(search_api, params=params,
                                     headers={"User-Agent": "MediaAnalyzerV2/1.0"})
            if resp2.status_code == 200:
                results = resp2.json().get("query", {}).get("search", [])
                snippets = [
                    r.get("snippet", "").replace('<span class="searchmatch">', "").replace("</span>", "")
                    for r in results[:3]
                ]
                return {
                    "title": results[0].get("title", "") if results else "",
                    "extract": " | ".join(snippets),
                    "url": "",
                    "engine": "wikipedia",
                }
    except Exception as e:
        log.warning(f"Wikipedia search failed for '{query[:50]}': {e}")
    return {"title": "", "extract": "", "url": "", "engine": "wikipedia", "error": "no results"}


# ── SEARCH LAYER: Google Fact Check Tools API (אופציונלי — דורש GOOGLE_FACTCHECK_KEY) ──
async def _search_factcheck(query):
    """חיפוש ב-Google Fact Check Tools API — אופציונלי, דורש env key"""
    api_key = os.environ.get("GOOGLE_FACTCHECK_KEY", "")
    if not api_key:
        return {"claims": [], "engine": "factcheck", "note": "no API key configured"}
    url = "https://factchecktools.googleapis.com/v1alpha1/claims:search"
    params = {"query": query, "key": api_key, "languageCode": "en"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
            resp = await client.get(url, params=params)
            data = resp.json()
            claims = []
            for c in data.get("claims", [])[:3]:
                reviews = c.get("claimReview", [])
                claims.append({
                    "text": c.get("text", ""),
                    "claimant": c.get("claimant", ""),
                    "rating": reviews[0].get("textualRating", "") if reviews else "",
                    "publisher": reviews[0].get("publisher", {}).get("name", "") if reviews else "",
                    "url": reviews[0].get("url", "") if reviews else "",
                })
            return {"claims": claims, "engine": "factcheck"}
    except Exception as e:
        log.warning(f"FactCheck search failed for '{query[:50]}': {e}")
        return {"claims": [], "engine": "factcheck", "error": str(e)}


# ── SEARCH LAYER: NewsAPI (אופציונלי — דורש NEWS_API_KEY) ──
async def _search_news(query):
    """חיפוש חדשות ב-NewsAPI — אופציונלי, דורש env key"""
    api_key = os.environ.get("NEWS_API_KEY", "")
    if not api_key:
        return {"articles": [], "engine": "newsapi", "note": "no API key configured"}
    url = "https://newsapi.org/v2/everything"
    params = {"q": query, "language": "en", "sortBy": "relevancy",
              "pageSize": "5", "apiKey": api_key}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.get(url, params=params)
            data = resp.json()
            articles = []
            for a in data.get("articles", [])[:5]:
                articles.append({
                    "title": a.get("title", ""),
                    "source": a.get("source", {}).get("name", ""),
                    "description": (a.get("description", "") or "")[:200],
                    "url": a.get("url", ""),
                    "publishedAt": a.get("publishedAt", ""),
                })
            return {"articles": articles, "engine": "newsapi"}
    except Exception as e:
        log.warning(f"NewsAPI search failed for '{query[:50]}': {e}")
        return {"articles": [], "engine": "newsapi", "error": str(e)}


async def _search_google_custom(query):
    """Google Custom Search JSON API (optional)."""
    key = os.environ.get("GOOGLE_CSE_KEY", "")
    cx = os.environ.get("GOOGLE_CSE_CX", "")
    if not key or not cx:
        return {"items": [], "engine": "google_cse", "note": "GOOGLE_CSE_KEY/GOOGLE_CSE_CX not configured"}
    url = "https://www.googleapis.com/customsearch/v1"
    params = {"key": key, "cx": cx, "q": query, "num": 5}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.get(url, params=params)
            data = resp.json()
            items = []
            for it in data.get("items", [])[:5]:
                items.append({
                    "title": it.get("title", ""),
                    "snippet": it.get("snippet", ""),
                    "link": it.get("link", ""),
                })
            return {"items": items, "engine": "google_cse"}
    except Exception as e:
        log.warning(f"Google CSE search failed for '{query[:50]}': {e}")
        return {"items": [], "engine": "google_cse", "error": str(e)}


async def _search_rss(query):
    """Search configured RSS feeds for relevant headlines/snippets."""
    feeds = _load_rss_feeds()
    query_tokens = [t for t in re.findall(r"[\w\u0590-\u05FF]{3,}", query.lower()) if len(t) >= 3][:10]
    if not feeds:
        return {"matches": [], "engine": "rss", "note": "no feeds configured"}

    matches = []
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0), follow_redirects=True) as client:
            for feed_url in feeds[:20]:
                try:
                    resp = await client.get(feed_url, headers={"User-Agent": "MediaAnalyzerV2/1.0"})
                    if resp.status_code != 200:
                        continue
                    root = ET.fromstring(resp.text)
                    items = root.findall(".//item")[:25]
                    for item in items:
                        title = _strip_html((item.findtext("title") or ""))
                        desc = _strip_html((item.findtext("description") or ""))
                        link = (item.findtext("link") or "").strip()
                        blob = f"{title} {desc}".lower()
                        score = sum(1 for tok in query_tokens if tok in blob)
                        if score > 0:
                            matches.append({
                                "title": title[:200],
                                "description": desc[:400],
                                "link": link,
                                "feed": feed_url,
                                "score": score,
                            })
                except Exception:
                    continue
    except Exception as e:
        return {"matches": [], "engine": "rss", "error": str(e)}

    matches.sort(key=lambda x: x.get("score", 0), reverse=True)
    return {"matches": matches[:10], "engine": "rss", "feed_count": len(feeds)}


async def _search_reddit_comments(query):
    """User-comment signal from public Reddit search results."""
    try:
        url = f"https://www.reddit.com/search.json?q={quote_plus(query)}&limit=5&sort=relevance&t=month"
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.get(url, headers={"User-Agent": "MediaAnalyzerV2/1.0"})
            if resp.status_code != 200:
                return {"posts": [], "engine": "reddit_comments", "error": f"HTTP {resp.status_code}"}
            data = resp.json()
            posts = []
            for child in data.get("data", {}).get("children", [])[:5]:
                d = child.get("data", {})
                posts.append({
                    "title": d.get("title", ""),
                    "subreddit": d.get("subreddit", ""),
                    "score": d.get("score", 0),
                    "num_comments": d.get("num_comments", 0),
                    "url": "https://www.reddit.com" + (d.get("permalink", "") or ""),
                    "selftext": (d.get("selftext", "") or "")[:240],
                })
            return {"posts": posts, "engine": "reddit_comments"}
    except Exception as e:
        return {"posts": [], "engine": "reddit_comments", "error": str(e)}


# ── MULTI-SOURCE SEARCH ORCHESTRATOR ──
async def _search_all_sources(query):
    """חיפוש במקביל בכל המקורות הזמינים — Web, Knowledge, RSS, Comments."""
    results = await asyncio.gather(
        _search_duckduckgo(query),
        _search_duckduckgo_web(query),
        _search_google_web(query),
        _search_bing_web(query),
        _search_wikipedia(query),
        _search_wikidata(query),
        _search_arxiv(query),
        _search_openalex(query),
        _search_crossref(query),
        _search_pubmed(query),
        _search_hackernews(query),
        _search_gdelt(query),
        _search_factcheck(query),
        _search_news(query),
        _search_rss(query),
        _search_reddit_comments(query),
        _search_facebook_public(query),
        _search_google_custom(query),
        return_exceptions=True,
    )
    merged = {"query": query, "sources": []}
    engines = [
        "duckduckgo",
        "duckduckgo_web",
        "google_web",
        "bing_web",
        "wikipedia",
        "wikidata",
        "arxiv",
        "openalex",
        "crossref",
        "pubmed",
        "hackernews",
        "gdelt",
        "factcheck",
        "newsapi",
        "rss",
        "reddit_comments",
        "facebook_public",
        "google_cse",
    ]
    for i, r in enumerate(results):
        if isinstance(r, Exception):
            merged["sources"].append({"engine": engines[i], "error": str(r)})
        else:
            merged["sources"].append(r)
    return merged


# ── שלב 1: חילוץ טענות עובדתיות (CLAIM EXTRACTION) ──
async def stage_research_claims(intel_step, output, token):
    """Reality Check Step 1: Extract factual claims from content"""
    intel = intel_step.get("parsed", {})
    input_data = {
        "key_findings": intel.get("key_findings", []),
        "final_assessment": intel.get("final_assessment", ""),
        "content_type": intel.get("content_type", ""),
        "speech_text": (output.get("speech_text", "") or "")[:1000],
        "ocr_text": (output.get("ocr_text", "") or "")[:500],
        "summary": (output.get("summary", "") or "")[:1000],
    }
    user_msg = f"CONTENT ANALYSIS:\n{json.dumps(input_data, ensure_ascii=False)}"
    # ── ניסיון 1: מודל 120B ──
    resp, ms = await _api_chat_120b(user_msg, token, system=P_CLAIM_EXTRACTION, max_tok=512)
    parsed = _extract_json(resp)
    parsed.setdefault("claims", [])
    parsed["claims"] = [c for c in parsed["claims"] if isinstance(c, str) and 5 < len(c) < 200][:8]
    # ── ניסיון 2: fallback ל-DeepSeek אם 120B החזיר ריק ──
    if not parsed["claims"]:
        log.warning("Claim extraction: 120B empty, fallback to DeepSeek")
        resp2, ms2 = await _api_chat(user_msg, token, system=P_CLAIM_EXTRACTION, max_tok=512)
        ms += ms2
        p2 = _extract_json(resp2)
        p2.setdefault("claims", [])
        fb = [c for c in p2["claims"] if isinstance(c, str) and 5 < len(c) < 200][:8]
        if fb:
            parsed["claims"] = fb
            resp = resp2
            log.info(f"Claim extraction: DeepSeek got {len(fb)} claims")
    # ── ניסיון 3: הוריסטי מ-key_findings ──
    if not parsed["claims"]:
        log.warning("Claim extraction: LLMs failed, heuristic from key_findings")
        for f in intel.get("key_findings", []):
            if isinstance(f, str) and 10 < len(f) < 200:
                parsed["claims"].append(f)
        parsed["claims"] = parsed["claims"][:8]
    return {
        "step": "research_claims", "name": "claim_extraction",
        "model": LLM_120B, "prompt": P_CLAIM_EXTRACTION,
        "response": resp, "parsed": parsed, "duration_ms": ms,
    }


# ── שלב 2: שאלות חקירה מתקדמות (INVESTIGATIVE QUESTIONS) ──
async def stage_research_questions(claims_step, output, token):
    """Reality Check Step 2: Generate typed, prioritized investigative questions"""
    claims = claims_step.get("parsed", {}).get("claims", [])
    if not claims:
        return {"step": "research_questions", "name": "investigative_questions",
                "parsed": {"questions": []}, "duration_ms": 0}
    # מספק גם speech + ocr + summary לשאלות חקירה עמוקות יותר
    input_data = {
        "claims": claims,
        "speech_text": (output.get("speech_text", "") or "")[:500],
        "ocr_text": (output.get("ocr_text", "") or "")[:300],
        "summary": (output.get("summary", "") or "")[:500],
    }
    user_msg = f"INVESTIGATION INPUT:\n{json.dumps(input_data, ensure_ascii=False)}"
    # ── ניסיון 1: מודל 120B עם max_tok מספיק ──
    resp, ms = await _api_chat_120b(user_msg, token, system=P_CRITICAL_QUESTIONS, max_tok=1200)
    parsed = _extract_json(resp)
    parsed.setdefault("questions", [])
    # ── ניסיון 2: fallback ל-DeepSeek אם 120B החזיר ריק/חתוך ──
    if not parsed["questions"]:
        log.warning("Questions: 120B empty/truncated, fallback to DeepSeek")
        resp2, ms2 = await _api_chat(user_msg, token, system=P_CRITICAL_QUESTIONS, max_tok=1024)
        ms += ms2
        p2 = _extract_json(resp2)
        p2.setdefault("questions", [])
        if p2["questions"]:
            parsed["questions"] = p2["questions"]
            resp = resp2
    # ── נרמול: תמיכה בפורמט ישן (list of strings) וחדש (list of objects) ──
    normalized = []
    for q in parsed["questions"][:8]:
        if isinstance(q, str) and len(q) > 10:
            if _contains_hebrew(q):
                normalized.append({"question": q, "question_he": q, "type": "fact_check", "priority": 3})
            else:
                normalized.append({"question": q, "question_en": q, "type": "fact_check", "priority": 3})
        elif isinstance(q, dict) and (q.get("question") or q.get("question_en") or q.get("question_he")):
            q_main = (q.get("question") or q.get("question_en") or q.get("question_he") or "").strip()
            q_en = (q.get("question_en") or "").strip()
            q_he = (q.get("question_he") or "").strip()
            if not q_en and not q_he and q_main:
                if _contains_hebrew(q_main):
                    q_he = q_main
                else:
                    q_en = q_main
            if len(q_en or q_he or q_main) < 10:
                continue
            normalized.append({
                "question": q_main or q_en or q_he,
                "question_en": q_en,
                "question_he": q_he,
                "type": q.get("type", "fact_check"),
                "priority": min(5, max(1, int(q.get("priority", 3)))),
            })

    # Ensure both Hebrew and English question variants exist for search.
    need_he = [q for q in normalized if not (q.get("question_he") or "").strip() and (q.get("question_en") or q.get("question"))]
    need_en = [q for q in normalized if not (q.get("question_en") or "").strip() and (q.get("question_he") or q.get("question"))]

    if need_he:
        source_en = [(q.get("question_en") or q.get("question") or "") for q in need_he]
        translated_he = await _translate_questions(source_en, token, to_lang="he")
        for i, q in enumerate(need_he):
            q["question_he"] = (translated_he[i] if i < len(translated_he) else "") or q.get("question_he", "")

    if need_en:
        source_he = [(q.get("question_he") or q.get("question") or "") for q in need_en]
        translated_en = await _translate_questions(source_he, token, to_lang="en")
        for i, q in enumerate(need_en):
            q["question_en"] = (translated_en[i] if i < len(translated_en) else "") or q.get("question_en", "")

    for q in normalized:
        q["question_en"] = (q.get("question_en") or q.get("question") or "").strip()
        q["question_he"] = (q.get("question_he") or "").strip()
        q["question"] = q.get("question_he") or q.get("question_en") or q.get("question") or ""
    # ── מיון לפי priority (1 = הכי חשוב) ──
    normalized.sort(key=lambda x: x["priority"])
    parsed["questions"] = normalized
    return {
        "step": "research_questions", "name": "investigative_questions",
        "model": LLM_120B, "prompt": P_CRITICAL_QUESTIONS,
        "response": resp, "parsed": parsed, "duration_ms": ms,
    }


# ── שלב 3: חיפוש Multi-Source (DuckDuckGo + Wikipedia + FactCheck + News) ──
async def stage_research_search(questions_step):
    """Reality Check Step 3: Multi-source search for each question"""
    t0 = time.time()
    questions = questions_step.get("parsed", {}).get("questions", [])
    if not questions:
        return {"step": "research_search", "name": "multi_source_search",
                "parsed": {"results": [], "sources_searched": 0, "engines_used": []}, "duration_ms": 0}

    # ── חיפוש עד 6 שאלות — כל שאלה ב-4 מקורות במקביל ──
    async def _search_one(q_obj):
        if isinstance(q_obj, dict):
            q_en = (q_obj.get("question_en") or "").strip()
            q_he = (q_obj.get("question_he") or "").strip()
            q_main = (q_obj.get("question") or "").strip()
            queries = []
            for q in [q_en, q_he, q_main]:
                if q and q not in queries:
                    queries.append(q)
            if not queries:
                queries = [str(q_obj)]
            variant_results = await asyncio.gather(*[_search_all_sources(q) for q in queries[:2]])
            flat_sources = []
            for vr in variant_results:
                for s in vr.get("sources", []):
                    flat_sources.append(s)
            return {
                "question": q_he or q_en or q_main,
                "question_en": q_en,
                "question_he": q_he,
                "type": q_obj.get("type", "fact_check"),
                "priority": q_obj.get("priority", 3),
                "multi_source": {
                    "query": q_he or q_en or q_main,
                    "query_variants": queries[:2],
                    "variant_results": variant_results,
                    "sources": flat_sources,
                },
            }
        q_text = str(q_obj)
        result = await _search_all_sources(q_text)
        return {"question": q_text, "type": "fact_check", "priority": 3, "multi_source": result}

    search_tasks = [_search_one(q) for q in questions[:6]]
    search_results = await asyncio.gather(*search_tasks)
    ms = int((time.time() - t0) * 1000)

    # ── סטטיסטיקה: אילו מנועים השיבו בהצלחה ──
    engines_used = set()
    for sr in search_results:
        for src in sr.get("multi_source", {}).get("sources", []):
            if not src.get("error"):
                engines_used.add(src.get("engine", "unknown"))

    return {
        "step": "research_search", "name": "multi_source_search",
        "parsed": {
            "results": list(search_results),
            "sources_searched": len(search_results),
            "engines_used": sorted(engines_used),
        },
        "duration_ms": ms,
    }


# ── שלב 4: Verification Model — דירוג per-claim עם 4 סטטוסים ──
async def stage_research_verification(claims_step, search_step, token):
    """Reality Check Step 4: Per-claim verification with detailed statuses"""
    claims = claims_step.get("parsed", {}).get("claims", [])
    search_results = search_step.get("parsed", {}).get("results", [])
    if not claims:
        return {"step": "research_verification", "name": "verification_model",
                "parsed": {"results": [], "context_summary": "",
                           "verified": [], "contradicted": [], "partially_verified": [],
                           "not_verified": []}, "duration_ms": 0}
    input_data = {"claims": claims, "search_results": search_results}
    user_msg = f"VERIFICATION DATA:\n{json.dumps(input_data, ensure_ascii=False)}"
    resp, ms = await _api_chat_120b(user_msg, token, system=P_VERIFICATION_MODEL, max_tok=1500)
    parsed = _extract_json(resp)
    parsed.setdefault("results", [])
    parsed.setdefault("context_summary", "")

    # ── נרמול: סיווג תוצאות לקטגוריות (תואם גם פורמט ישן) ──
    verified, contradicted, partially, not_verified = [], [], [], []
    for r in parsed["results"]:
        if not isinstance(r, dict):
            continue
        status = (r.get("status", "") or "").upper().replace(" ", "_")
        claim_text = r.get("claim", "")
        evidence_text = r.get("evidence", r.get("reason", ""))
        source_text = r.get("source", "")
        conf = r.get("confidence", 50)
        entry = {"claim": claim_text, "evidence": evidence_text,
                 "source": source_text, "confidence": conf, "status": status}
        if status == "VERIFIED":
            verified.append(entry)
        elif status == "CONTRADICTED":
            contradicted.append(entry)
        elif status == "PARTIALLY_VERIFIED":
            partially.append(entry)
        else:
            entry["status"] = "NOT_VERIFIED"
            not_verified.append(entry)

    # ── backward compatibility: שמירת verified/contradicted/unverified ──
    parsed["verified"] = verified
    parsed["contradicted"] = contradicted
    parsed["partially_verified"] = partially
    parsed["not_verified"] = not_verified
    # ── compat ישן: unverified = partially + not_verified ──
    parsed["unverified"] = partially + not_verified

    return {
        "step": "research_verification", "name": "verification_model",
        "model": LLM_120B, "prompt": P_VERIFICATION_MODEL,
        "response": resp, "parsed": parsed, "duration_ms": ms,
    }


# ── שלב 5: Context Intelligence — קישור לאירועים אמיתיים + distortion level ──
async def stage_research_context(verify_step, intel_step, output, token):
    """Reality Check Step 5: Strategic context intelligence"""
    verify = verify_step.get("parsed", {})
    intel = intel_step.get("parsed", {})
    input_data = {
        "verified_facts": verify.get("verified", []),
        "contradicted_facts": verify.get("contradicted", []),
        "partially_verified": verify.get("partially_verified", []),
        "content_type": intel.get("content_type", ""),
        "key_findings": intel.get("key_findings", []),
        "context_summary": verify.get("context_summary", ""),
        "summary": (output.get("summary", "") or "")[:500],
    }
    user_msg = f"INTELLIGENCE CONTEXT:\n{json.dumps(input_data, ensure_ascii=False)}"
    resp, ms = await _api_chat_120b(user_msg, token, system=P_CONTEXT_INTELLIGENCE, max_tok=800)
    parsed = _extract_json(resp)
    # ── defaults ──
    parsed.setdefault("is_linked_to_real_events", False)
    parsed.setdefault("related_events", [])
    parsed.setdefault("distortion_level", "none")
    parsed.setdefault("event_type", "Other")
    parsed.setdefault("context_level", "Low")
    parsed.setdefault("explanation", "")
    parsed.setdefault("final_assessment", "")
    # ── backward compat ──
    parsed["is_part_of_larger_event"] = parsed["is_linked_to_real_events"]
    return {
        "step": "research_context", "name": "context_intelligence",
        "model": LLM_120B, "prompt": P_CONTEXT_INTELLIGENCE,
        "response": resp, "parsed": parsed, "duration_ms": ms,
    }


# ── שלב 6: Reliability Scoring — הפרדת אמינות תוכן/מקור/נרטיב ──
def compute_reliability(verify_step, narrative_class, base_truth):
    """Reality Check Step 6: Separated reliability scoring —
    content_reliability, source_reliability, verification_score.
    מחזיר dict עם 3 ציונים נפרדים + final_reliability."""
    results = verify_step.get("parsed", {}).get("results", [])
    verified_count = sum(1 for r in results if r.get("status") == "VERIFIED")
    contradicted_count = sum(1 for r in results if r.get("status") == "CONTRADICTED")
    partial_count = sum(1 for r in results if r.get("status") == "PARTIALLY_VERIFIED")
    not_verified_count = sum(1 for r in results if r.get("status") == "NOT_VERIFIED")
    total = len(results) or 1

    # ── ציון אימות: כמה מהטענות אומתו מול המציאות ──
    verification_score = ((verified_count + partial_count * 0.5 - contradicted_count) / total) * 100
    verification_score = max(0, min(100, verification_score))

    # ── ציון אמינות תוכן: שילוב בסיס + אימות ──
    content_reliability = base_truth * 0.4 + verification_score * 0.6

    # ── ציון אמינות מקור: כמה מקורות באמת זמינים ──
    avg_conf = 0
    if results:
        confs = [r.get("confidence", 50) for r in results if isinstance(r.get("confidence"), (int, float))]
        avg_conf = sum(confs) / len(confs) if confs else 50
    source_reliability = avg_conf

    # ── התאמה לנרטיב: סאטירה ≠ שקר, תעמולה = חשוד ──
    narr_lower = (narrative_class or "").lower()
    if narr_lower in ("satire", "parody"):
        # סאטירה — אמינות תוכן לא רלוונטית, אבל לא שקר
        final = 85
    elif narr_lower in ("propaganda", "misinformation", "misleading"):
        final = max(10, content_reliability - 30)
    else:
        final = content_reliability

    final = max(0, min(100, final))

    return {
        "content_reliability": round(content_reliability, 1),
        "source_reliability": round(source_reliability, 1),
        "verification_score": round(verification_score, 1),
        "final_reliability": round(final, 1),
        "verified_count": verified_count,
        "contradicted_count": contradicted_count,
        "partial_count": partial_count,
        "not_verified_count": not_verified_count,
        "total_claims": total,
    }


# ── ORCHESTRATOR: Reality Check Engine — מפעיל את כל 6 השלבים ──
async def stage_intelligent_research(intel_step, output, token, narrative_class=""):
    """Reality Check Engine — מנוע הצלבת מציאות.
    Flow: Claims → Questions → Multi-Search → Verify → Context → Reliability"""
    t0 = time.time()

    # שלב 1: חילוץ טענות
    log.info("  Reality Check [1/6]: extracting claims...")
    claims = await stage_research_claims(intel_step, output, token)

    # שלב 2: שאלות חקירה מתקדמות (עם type + priority)
    log.info("  Reality Check [2/6]: generating investigative questions...")
    questions = await stage_research_questions(claims, output, token)

    # שלב 3: חיפוש Multi-Source (DuckDuckGo + Wikipedia + FactCheck + News)
    log.info("  Reality Check [3/6]: multi-source search...")
    search = await stage_research_search(questions)

    # שלב 4: Verification Model — דירוג per-claim
    log.info("  Reality Check [4/6]: verifying claims against evidence...")
    verification = await stage_research_verification(claims, search, token)

    # שלב 5: Context Intelligence — קישור לאירועים אמיתיים
    log.info("  Reality Check [5/6]: analyzing strategic context...")
    context = await stage_research_context(verification, intel_step, output, token)

    # שלב 6: Reliability Scoring — הפרדת אמינות
    log.info("  Reality Check [6/6]: computing reliability scores...")
    base_truth = intel_step.get("parsed", {}).get("truth_score", 50)
    reliability = compute_reliability(verification, narrative_class, base_truth)

    total_ms = int((time.time() - t0) * 1000)
    log.info(f"  Reality Check Engine complete in {total_ms}ms — "
             f"verified={reliability['verified_count']}, "
             f"contradicted={reliability['contradicted_count']}, "
             f"reliability={reliability['final_reliability']}%")

    return {
        "step": "intelligent_research", "name": "reality_check_engine",
        "duration_ms": total_ms,
        "sub_steps": [claims, questions, search, verification, context],
        "parsed": {
            # ── טענות ──
            "claims": claims.get("parsed", {}).get("claims", []),
            # ── שאלות חקירה (עם type + priority) ──
            "questions": questions.get("parsed", {}).get("questions", []),
            # ── חיפוש ──
            "sources_searched": search.get("parsed", {}).get("sources_searched", 0),
            "engines_used": search.get("parsed", {}).get("engines_used", []),
            # ── תוצאות אימות (פורמט חדש — per-claim עם status) ──
            "verification_results": verification.get("parsed", {}).get("results", []),
            # ── backward compat: verified/contradicted/unverified ──
            "verified": verification.get("parsed", {}).get("verified", []),
            "contradicted": verification.get("parsed", {}).get("contradicted", []),
            "partially_verified": verification.get("parsed", {}).get("partially_verified", []),
            "not_verified": verification.get("parsed", {}).get("not_verified", []),
            "unverified": verification.get("parsed", {}).get("unverified", []),
            "context_summary": verification.get("parsed", {}).get("context_summary", ""),
            # ── Context Intelligence ──
            "is_part_of_larger_event": context.get("parsed", {}).get("is_part_of_larger_event", False),
            "is_linked_to_real_events": context.get("parsed", {}).get("is_linked_to_real_events", False),
            "related_events": context.get("parsed", {}).get("related_events", []),
            "distortion_level": context.get("parsed", {}).get("distortion_level", "none"),
            "event_type": context.get("parsed", {}).get("event_type", "Other"),
            "context_level": context.get("parsed", {}).get("context_level", "Low"),
            "context_explanation": context.get("parsed", {}).get("explanation", ""),
            "strategic_assessment": context.get("parsed", {}).get("final_assessment", ""),
            # ── Reliability Scores (הפרדת אמינות) ──
            "reliability": reliability,
        },
    }


# ═══════════════════════════════════════════════════════════
#  FFMPEG HELPERS
# ═══════════════════════════════════════════════════════════
def _ffprobe_duration(vpath):
    try:
        r = subprocess.run(["ffprobe", "-v", "quiet", "-show_entries",
                            "format=duration", "-of", "csv=p=0", vpath],
                           capture_output=True, text=True, timeout=10)
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def _ffmpeg_audio(vpath, apath):
    try:
        subprocess.run(["ffmpeg", "-y", "-i", vpath, "-vn", "-acodec", "flac",
                        "-ar", "16000", "-ac", "1", apath],
                       capture_output=True, timeout=60)
        return Path(apath).exists() and Path(apath).stat().st_size > 0
    except Exception:
        return False


def _ffmpeg_split_audio(apath, out_dir, seg_sec=15):
    try:
        pat = os.path.join(out_dir, "seg_%03d.flac")
        subprocess.run(["ffmpeg", "-y", "-i", apath, "-f", "segment",
                        "-segment_time", str(seg_sec), "-ar", "16000",
                        "-ac", "1", "-c:a", "flac", pat],
                       capture_output=True, timeout=60)
        return sorted(str(f) for f in Path(out_dir).glob("seg_*.flac"))
    except Exception:
        return []


def _ffmpeg_frames(vpath, out_dir, fps=1):
    try:
        subprocess.run(["ffmpeg", "-y", "-i", vpath, "-vf", f"fps={fps}",
                        "-q:v", "3", os.path.join(out_dir, "frame_%04d.jpg")],
                       capture_output=True, timeout=120)
        return sorted(str(f) for f in Path(out_dir).glob("frame_*.jpg"))
    except Exception:
        return []


def _ffmpeg_scene_detect(vpath, threshold=0.3):
    """Detect scene-change timestamps via ffmpeg."""
    try:
        r = subprocess.run(
            ["ffmpeg", "-i", vpath, "-vf",
             f"select='gt(scene,{threshold})',showinfo",
             "-vsync", "vfr", "-f", "null", "-"],
            capture_output=True, text=True, timeout=60)
        times = []
        for line in r.stderr.split('\n'):
            if 'pts_time' in line:
                for part in line.split():
                    if part.startswith('pts_time:'):
                        try:
                            times.append(float(part.split(':')[1]))
                        except ValueError:
                            pass
        return times
    except Exception:
        return []


def _smart_frame_selection(duration, scene_times):
    """Select frames: time-based (adaptive) + scene changes, deduplicated."""
    if duration <= 30:
        interval = 2
    elif duration <= 120:
        interval = 3
    else:
        interval = 4
    time_based = [i * interval for i in range(int(duration / interval) + 1)]
    all_times = sorted(set(time_based + [round(t, 1) for t in scene_times]))
    # deduplicate: keep at least 1s apart
    selected = []
    for t in all_times:
        if t > duration:
            break
        if not selected or t - selected[-1] >= 1.0:
            selected.append(t)
    return selected


def _frame_at_time(all_frame_paths, time_sec, fps=1):
    """Get frame path closest to given time (frames are at 1fps, 1-indexed filenames)."""
    idx = min(int(time_sec), len(all_frame_paths) - 1)
    idx = max(0, idx)
    return all_frame_paths[idx] if all_frame_paths else None


# ═══════════════════════════════════════════════════════════
#  PIPELINE STEPS
# ═══════════════════════════════════════════════════════════

# ── STEP 1: Decompose video ──
def step1_decompose(video_bytes, tmp):
    vpath = os.path.join(tmp, "input.mp4")
    apath = os.path.join(tmp, "audio.flac")
    fdir  = os.path.join(tmp, "frames")
    sdir  = os.path.join(tmp, "audio_segs")
    os.makedirs(fdir, exist_ok=True)
    os.makedirs(sdir, exist_ok=True)
    Path(vpath).write_bytes(video_bytes)

    duration = _ffprobe_duration(vpath)
    has_audio = _ffmpeg_audio(vpath, apath)
    all_frames = _ffmpeg_frames(vpath, fdir, fps=1)
    scene_times = _ffmpeg_scene_detect(vpath, threshold=0.3)
    selected_times = _smart_frame_selection(duration, scene_times)
    audio_segs = _ffmpeg_split_audio(apath, sdir) if has_audio else []

    return {
        "vpath": vpath, "apath": apath, "fdir": fdir,
        "duration": round(duration, 1),
        "has_audio": has_audio,
        "all_frames": all_frames,
        "scene_times": scene_times,
        "selected_times": selected_times,
        "audio_segs": audio_segs if audio_segs else ([apath] if has_audio else []),
    }


# ── STEP 2: Speech-to-Text ──
async def step2_speech(decomp, token):
    segs_out = []
    full_text = ""
    for i, seg_path in enumerate(decomp["audio_segs"]):
        seg_bytes = Path(seg_path).read_bytes()
        if len(seg_bytes) < 500:
            continue
        resp, ms = await _api_whisper(seg_bytes, token)
        txt = resp.get("text", "").strip()
        segs_out.append({
            "index": i,
            "input": f"Audio segment {i} ({len(seg_bytes)//1024}KB)",
            "model": WHISPER,
            "response": resp,
            "result": txt,
            "language": resp.get("language", "unknown"),
            "duration_ms": ms,
            "status": "ok" if txt else "empty",
        })
        if txt:
            full_text += (" " if full_text else "") + txt
    if not decomp["has_audio"]:
        segs_out.append({"index": 0, "input": "No audio", "model": WHISPER,
                         "status": "skipped", "result": "", "duration_ms": 0})
    return {
        "step": 2, "name": "speech_transcription", "model": WHISPER,
        "segments": segs_out, "full_text": full_text,
    }


# ── STEP 3: OCR (every 3s from selected frames) ──
async def step3_ocr(decomp, token):
    frames_out = []
    ocr_times = [t for t in decomp["selected_times"] if int(t) % 3 < 1]
    if not ocr_times and decomp["selected_times"]:
        ocr_times = decomp["selected_times"][::2]  # fallback: every other selected

    async def _do_ocr(t):
        fp = _frame_at_time(decomp["all_frames"], t)
        if not fp:
            return None
        b64 = base64.b64encode(Path(fp).read_bytes()).decode()
        resp, ms = await _api_vision(b64, P_OCR, token)
        ok = bool(resp and "NO_TEXT" not in resp and "ERROR" not in resp)
        return {
            "frame_index": int(t), "time_sec": round(t, 1), "timestamp": _fmt_time(t),
            "model": VISION, "prompt": P_OCR, "response": resp,
            "duration_ms": ms, "status": "ok" if ok else "empty",
        }

    results = await asyncio.gather(*[_do_ocr(t) for t in ocr_times])
    frames_out = [r for r in results if r]
    full = " ".join(f["response"] for f in frames_out if f["status"] == "ok")
    return {
        "step": 3, "name": "ocr_extraction", "model": VISION,
        "prompt_used": P_OCR, "frames": frames_out,
        "frame_times": ocr_times, "full_text": full,
    }


# ── STEP 4: Object Detection (every 2s) ──
async def step4_objects(decomp, token):
    obj_times = [t for t in decomp["selected_times"] if int(t) % 2 < 1]
    if not obj_times and decomp["selected_times"]:
        obj_times = decomp["selected_times"]

    async def _do_det(t):
        fp = _frame_at_time(decomp["all_frames"], t)
        if not fp:
            return None
        fb = Path(fp).read_bytes()
        dets, ms = await _api_detr(fb, token)
        return {
            "frame_index": int(t), "time_sec": round(t, 1), "timestamp": _fmt_time(t),
            "model": DETR, "detections": dets,
            "duration_ms": ms, "status": "ok" if dets else "empty",
        }

    results = await asyncio.gather(*[_do_det(t) for t in obj_times])
    frames_out = [r for r in results if r]
    # aggregate unique objects
    uniq = {}
    for f in frames_out:
        for d in f.get("detections", []):
            lbl = d.get("label", "")
            sc = d.get("score", 0)
            if lbl and (lbl not in uniq or sc > uniq[lbl]):
                uniq[lbl] = sc
    return {
        "step": 4, "name": "object_detection", "model": DETR,
        "frames": frames_out, "frame_times": obj_times,
        "unique_objects": [{"label": k, "score": v}
                           for k, v in sorted(uniq.items(), key=lambda x: -x[1])],
    }


# ── STEP 5: Image Captioning (every 3s) ──
async def step5_captions(decomp, token):
    cap_times = [t for t in decomp["selected_times"] if int(t) % 3 < 1]
    if not cap_times and decomp["selected_times"]:
        cap_times = decomp["selected_times"][::2]

    async def _do_cap(t):
        fp = _frame_at_time(decomp["all_frames"], t)
        if not fp:
            return None
        b64 = base64.b64encode(Path(fp).read_bytes()).decode()
        resp, ms = await _api_vision(b64, P_CAPTION, token)
        return {
            "frame_index": int(t), "time_sec": round(t, 1), "timestamp": _fmt_time(t),
            "model": VISION, "prompt": P_CAPTION, "response": resp,
            "duration_ms": ms, "status": "ok" if resp and "ERROR" not in resp else "error",
        }

    results = await asyncio.gather(*[_do_cap(t) for t in cap_times])
    return {
        "step": 5, "name": "image_captioning", "model": VISION,
        "prompt_used": P_CAPTION, "frames": [r for r in results if r],
    }


# ── STEP 6: AI Detection ──
async def step6_ai_detection(decomp, token):
    results = []
    if not decomp["all_frames"]:
        return {"step": 6, "name": "ai_detection", "frames": [], "models": [VISION, AI_CLASS]}

    # pick first + middle frame
    idxs = [0]
    mid = len(decomp["all_frames"]) // 2
    if mid > 0 and mid != 0:
        idxs.append(mid)

    for idx in idxs:
        fp = decomp["all_frames"][idx]
        fb = Path(fp).read_bytes()
        b64 = base64.b64encode(fb).decode()

        # Vision analysis
        resp_v, ms_v = await _api_vision(b64, P_AI_VISION, token)
        results.append({
            "module": "ai_vision_check", "model": VISION,
            "frame_index": idx, "prompt": P_AI_VISION,
            "response": resp_v, "duration_ms": ms_v, "status": "ok",
        })
        # Classifier
        resp_c, ms_c = await _api_ai_class(fb, token)
        results.append({
            "module": "ai_classifier", "model": AI_CLASS,
            "frame_index": idx, "response": resp_c,
            "duration_ms": ms_c,
            "status": "ok" if "error" not in resp_c else "error",
        })

    return {"step": 6, "name": "ai_detection", "models": [VISION, AI_CLASS], "frames": results}


# ── STEP 7: Text Merge ──
def step7_text_merge(speech_step, ocr_step, caption_step):
    speech = speech_step.get("full_text", "")
    ocr = ocr_step.get("full_text", "")
    captions = " ".join(
        f.get("response", "") for f in caption_step.get("frames", [])
        if f.get("status") == "ok"
    )
    merged = ""
    if speech:
        merged += f"[דיבור] {speech}\n\n"
    if ocr:
        merged += f"[OCR] {ocr}\n\n"
    if captions:
        merged += f"[תיאורים] {captions}"
    return {
        "step": 7, "name": "text_merge",
        "speech_text": speech, "ocr_text": ocr, "captions_text": captions,
        "merged_text": merged.strip(),
    }


# ── STEP 8: Generate Investigative Questions ──
async def step8_questions(merge_step, objects_step, token):
    context = merge_step["merged_text"]
    objs = ", ".join(o["label"] for o in objects_step.get("unique_objects", []))
    user_msg = (
        f"VIDEO DATA:\n{context[:3000]}\n\n"
        f"DETECTED OBJECTS: {objs}\n\n"
        "Generate 5-10 investigative questions."
    )
    resp, ms = await _api_chat(user_msg, token, system=P_QUESTIONS)
    # parse questions
    questions = []
    try:
        parsed = json.loads(resp[resp.index("["):resp.rindex("]")+1])
        questions = [q for q in parsed if isinstance(q, str)]
    except Exception:
        for line in resp.split("\n"):
            line = line.strip().lstrip("0123456789.-) ")
            if line and len(line) > 10:
                questions.append(line)
    return {
        "step": 8, "name": "investigative_questions", "model": TEXT_LLM,
        "prompt": P_QUESTIONS, "user_input": user_msg[:500] + "...",
        "response": resp, "questions": questions[:10],
        "duration_ms": ms,
    }


# ── STEP 9: Re-investigate Frames with Questions ──
async def step9_reinvestigate(questions_step, decomp, token):
    questions = questions_step.get("questions", [])
    if not questions or not decomp["all_frames"]:
        return {"step": 9, "name": "frame_reinvestigation", "answers": []}

    n_frames = len(decomp["all_frames"])
    answers = []

    async def _ask(i, q):
        # distribute questions across frames
        fidx = (i * n_frames // len(questions)) % n_frames
        fp = decomp["all_frames"][fidx]
        b64 = base64.b64encode(Path(fp).read_bytes()).decode()
        prompt = f"Look at this image and answer: {q}"
        resp, ms = await _api_vision(b64, prompt, token)
        return {
            "question": q, "frame_index": fidx,
            "timestamp": _fmt_time(fidx),
            "model": VISION, "prompt": prompt,
            "response": resp, "duration_ms": ms,
        }

    results = await asyncio.gather(*[_ask(i, q) for i, q in enumerate(questions)])
    return {"step": 9, "name": "frame_reinvestigation", "answers": list(results)}


# ── STEP 11: Summary ──
async def step11_summary(merge_step, objects_step, questions_step, reinvest_step, token):
    answers_text = "\n".join(
        f"Q: {a['question']}\nA: {a.get('response', '')}"
        for a in reinvest_step.get("answers", [])
    )
    objs = ", ".join(o["label"] for o in objects_step.get("unique_objects", []))
    user_msg = (
        f"MERGED TEXT:\n{merge_step['merged_text'][:2000]}\n\n"
        f"OBJECTS: {objs}\n\n"
        f"INVESTIGATION Q&A:\n{answers_text[:2000]}\n\n"
        "Write a factual summary."
    )
    resp, ms = await _api_chat(user_msg, token, system=P_SUMMARY)
    return {
        "step": 11, "name": "summary", "model": TEXT_LLM,
        "prompt": P_SUMMARY, "user_input": user_msg[:500] + "...",
        "response": resp, "summary_text": resp.strip(),
        "duration_ms": ms,
    }


# ═══════════════════════════════════════════════════════════
#  HELPERS
# ═══════════════════════════════════════════════════════════
def _fmt_time(sec):
    m, s = divmod(int(sec), 60)
    return f"{m:02d}:{s:02d}"


# ═══════════════════════════════════════════════════════════
#  MAIN: ANALYZE VIDEO
# ═══════════════════════════════════════════════════════════
async def analyze_video(video_bytes: bytes, token: str) -> dict:
    global _current_tracker
    _current_tracker = CostTracker()
    t_start = time.time()

    with tempfile.TemporaryDirectory() as tmp:
        # STEP 1: Decompose
        log.info("Step 1: decomposing video...")
        decomp = step1_decompose(video_bytes, tmp)

        meta = {
            "media_type": "video",
            "file_size_bytes": len(video_bytes),
            "file_size_kb": round(len(video_bytes) / 1024, 1),
            "sha256": hashlib.sha256(video_bytes).hexdigest(),
            "duration_sec": decomp["duration"],
            "frames_extracted": len(decomp["all_frames"]),
            "scene_changes": len(decomp["scene_times"]),
            "scene_change_times": decomp["scene_times"],
            "selected_frame_times": decomp["selected_times"],
            "audio_extracted": decomp["has_audio"],
            "audio_segments": len(decomp["audio_segs"]),
        }

        # STEPS 2-6: Run in parallel groups
        log.info("Steps 2-6: speech, OCR, objects, captions, AI detection...")
        s2, s3, s4, s5, s6 = await asyncio.gather(
            step2_speech(decomp, token),
            step3_ocr(decomp, token),
            step4_objects(decomp, token),
            step5_captions(decomp, token),
            step6_ai_detection(decomp, token),
        )

        # STEP 7: Text merge
        log.info("Step 7: merging text...")
        s7 = step7_text_merge(s2, s3, s5)

        # STEP 8: Generate questions
        log.info("Step 8: generating investigative questions...")
        s8 = await step8_questions(s7, s4, token)

        # STEP 9: Re-investigate with questions
        log.info("Step 9: re-investigating frames...")
        s9 = await step9_reinvestigate(s8, decomp, token)

        # STEP 10: Combine (implicit — all data gathered)

        # STEP 11: Summary
        log.info("Step 11: generating summary...")
        s11 = await step11_summary(s7, s4, s8, s9, token)

        # Build base output
        output = {
            "speech_text": s2.get("full_text", ""),
            "ocr_text": s3.get("full_text", ""),
            "merged_text": s7.get("merged_text", ""),
            "frames": _build_frames_output(decomp, s3, s4, s5, s6),
            "questions": s8.get("questions", []),
            "answers": s9.get("answers", []),
            "summary": s11.get("summary_text", ""),
        }

        # ── NARRATIVE CLASSIFIER — סיווג נרטיב (לפני Intelligence) ──
        log.info("Narrative Classifier: classifying content intent...")
        snc = await stage_narrative_classifier(output, token)

        # ── SCORING ENGINE — חישוב ציונים דטרמיניסטי ──
        log.info("Scoring Engine: computing deterministic scores...")
        scores = _compute_scores(output, s6, narrative_result=snc)

        # ── STAGE 3: Intelligence LLM (120B) ──
        log.info("Stage 3: running deep intelligence model...")
        si = await stage_intelligence(output, meta, scores, token, narrative_result=snc)

        # ── REALITY CHECK ENGINE — מנוע הצלבת מציאות ──
        narr_class = snc.get("parsed", {}).get("narrative_class", scores.get("narrative_class", ""))
        log.info("Reality Check Engine: verifying against real world...")
        sre = await stage_intelligent_research(si, output, token, narrative_class=narr_class)

        # ── STAGE 4: Anti-Hallucination ──
        log.info("Stage 4: validating output...")
        sv = await stage_validation(s7.get("merged_text", ""), si, token)

        # ── STAGE 3.5: Evidence Filter ──
        log.info("Stage 3.5: filtering evidence...")
        sef = await stage_evidence_filter(output, si, sv, token)

        # ── STAGE 4.5: CONSISTENCY ENGINE (SOURCE OF TRUTH) ──
        log.info("Stage 4.5: enforcing consistency — source of truth...")
        consistency = _enforce_consistency(scores, si, sv, sef, snc, research_step=sre)

        # ── STAGE 5: UI Adapter (PASSIVE — text only) ──
        log.info("Stage 5: UI adapter (passive)...")
        su = await stage_ui_adapter(si, consistency, token, narrative_result=snc)

        total_ms = int((time.time() - t_start) * 1000)
        log.info(f"Full pipeline complete in {total_ms}ms")

        return {
            "status": "ok",
            "meta": meta,
            "pipeline": [s2, s3, s4, s5, s6, s7, s8, s9, s11, snc, si, sre, sv, sef, su],
            "output": output,
            "scores": scores,
            "consistency": consistency,
            "narrative": snc.get("parsed", {}),
            "intelligence": si.get("parsed", {}),
            "research": sre.get("parsed", {}),
            "validation": sv.get("parsed", {}),
            "evidence_filter": sef.get("parsed", {}),
            "ui_data": su.get("parsed", {}),
            "total_duration_ms": total_ms,
            "estimated_cost": _current_tracker.summary(),
        }


def _build_frames_output(decomp, ocr_s, obj_s, cap_s, ai_s):
    """Build per-frame combined data for the output."""
    frame_map = {}
    for f in ocr_s.get("frames", []):
        t = f.get("time_sec", 0)
        frame_map.setdefault(t, {"timestamp": _fmt_time(t), "time_sec": t})
        frame_map[t]["ocr"] = f.get("response", "")
    for f in obj_s.get("frames", []):
        t = f.get("time_sec", 0)
        frame_map.setdefault(t, {"timestamp": _fmt_time(t), "time_sec": t})
        frame_map[t]["objects"] = [d.get("label") for d in f.get("detections", [])]
    for f in cap_s.get("frames", []):
        t = f.get("time_sec", 0)
        frame_map.setdefault(t, {"timestamp": _fmt_time(t), "time_sec": t})
        frame_map[t]["caption"] = f.get("response", "")
    for f in ai_s.get("frames", []):
        t = f.get("frame_index", 0)
        frame_map.setdefault(t, {"timestamp": _fmt_time(t), "time_sec": t})
        frame_map[t].setdefault("ai_detection", []).append(f.get("response"))
    return [frame_map[k] for k in sorted(frame_map.keys())]


# ═══════════════════════════════════════════════════════════
#  MAIN: ANALYZE IMAGE
# ═══════════════════════════════════════════════════════════
async def analyze_image(img_bytes: bytes, token: str) -> dict:
    global _current_tracker
    _current_tracker = CostTracker()
    t_start = time.time()
    b64 = base64.b64encode(img_bytes).decode()
    meta = {
        "media_type": "image",
        "file_size_bytes": len(img_bytes),
        "file_size_kb": round(len(img_bytes) / 1024, 1),
        "sha256": hashlib.sha256(img_bytes).hexdigest(),
    }

    # Run all in parallel
    (ocr_r, ocr_ms), (cap_r, cap_ms), (obj_r, obj_ms), \
        (aiv_r, aiv_ms), (aic_r, aic_ms) = await asyncio.gather(
        _api_vision(b64, P_OCR, token),
        _api_vision(b64, P_CAPTION, token),
        _api_detr(img_bytes, token),
        _api_vision(b64, P_AI_VISION, token),
        _api_ai_class(img_bytes, token),
    )

    pipeline = [
        {"step": 3, "name": "ocr_extraction", "model": VISION,
         "prompt_used": P_OCR,
         "frames": [{"prompt": P_OCR, "response": ocr_r, "duration_ms": ocr_ms,
                      "status": "ok" if ocr_r and "NO_TEXT" not in ocr_r else "empty"}],
         "full_text": ocr_r if "NO_TEXT" not in (ocr_r or "") else ""},
        {"step": 5, "name": "image_captioning", "model": VISION,
         "prompt_used": P_CAPTION,
         "frames": [{"prompt": P_CAPTION, "response": cap_r, "duration_ms": cap_ms, "status": "ok"}]},
        {"step": 4, "name": "object_detection", "model": DETR,
         "frames": [{"detections": obj_r, "duration_ms": obj_ms, "status": "ok"}],
         "unique_objects": [{"label": d["label"], "score": d["score"]}
                            for d in obj_r if isinstance(d, dict) and "label" in d]},
        {"step": 6, "name": "ai_detection", "models": [VISION, AI_CLASS],
         "frames": [
             {"module": "ai_vision_check", "model": VISION, "prompt": P_AI_VISION,
              "response": aiv_r, "duration_ms": aiv_ms, "status": "ok"},
             {"module": "ai_classifier", "model": AI_CLASS,
              "response": aic_r, "duration_ms": aic_ms,
              "status": "ok" if "error" not in aic_r else "error"},
         ]},
    ]

    output = {
        "speech_text": "",
        "ocr_text": ocr_r if "NO_TEXT" not in (ocr_r or "") else "",
        "merged_text": ocr_r if "NO_TEXT" not in (ocr_r or "") else "",
        "frames": [{"timestamp": "00:00", "caption": cap_r,
                     "objects": [d["label"] for d in obj_r if isinstance(d, dict) and "label" in d],
                     "ai_detection": [aiv_r, aic_r]}],
        "questions": [], "answers": [], "summary": "",
    }

    ai_step = pipeline[3]  # ai_detection step

    # ── NARRATIVE CLASSIFIER — סיווג נרטיב (לפני Intelligence) ──
    log.info("Narrative Classifier: classifying content intent (image)...")
    snc = await stage_narrative_classifier(output, token)

    # ── SCORING ENGINE — חישוב ציונים דטרמיניסטי ──
    log.info("Scoring Engine: computing deterministic scores (image)...")
    scores = _compute_scores(output, ai_step, narrative_result=snc)

    # ── STAGE 3: Intelligence LLM ──
    log.info("Stage 3: intelligence analysis (image)...")
    si = await stage_intelligence(output, meta, scores, token, narrative_result=snc)

    # ── REALITY CHECK ENGINE — מנוע הצלבת מציאות ──
    narr_class = snc.get("parsed", {}).get("narrative_class", scores.get("narrative_class", ""))
    log.info("Reality Check Engine: verifying against real world (image)...")
    sre = await stage_intelligent_research(si, output, token, narrative_class=narr_class)

    # ── STAGE 4: Validation ──
    log.info("Stage 4: validating...")
    sv = await stage_validation(output.get("merged_text", ""), si, token)

    # ── STAGE 3.5: Evidence Filter ──
    log.info("Stage 3.5: filtering evidence...")
    sef = await stage_evidence_filter(output, si, sv, token)

    # ── STAGE 4.5: CONSISTENCY ENGINE (SOURCE OF TRUTH) ──
    log.info("Stage 4.5: enforcing consistency (image)...")
    consistency = _enforce_consistency(scores, si, sv, sef, snc, research_step=sre)

    # ── STAGE 5: UI Adapter (PASSIVE — text only) ──
    log.info("Stage 5: UI adapter (passive, image)...")
    su = await stage_ui_adapter(si, consistency, token, narrative_result=snc)

    pipeline.extend([snc, si, sre, sv, sef, su])
    total_ms = int((time.time() - t_start) * 1000)

    return {
        "status": "ok", "meta": meta, "pipeline": pipeline,
        "output": output,
        "scores": scores,
        "consistency": consistency,
        "narrative": snc.get("parsed", {}),
        "intelligence": si.get("parsed", {}),
        "research": sre.get("parsed", {}),
        "validation": sv.get("parsed", {}),
        "evidence_filter": sef.get("parsed", {}),
        "ui_data": su.get("parsed", {}),
        "total_duration_ms": total_ms,
        "estimated_cost": _current_tracker.summary(),
    }
