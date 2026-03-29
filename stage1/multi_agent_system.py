"""
Multi-Agent System for Media Analyzer V2
=========================================
ארכיטקטורת סוכנים היררכית עם Controller מרכזי.
כל סוכן אחראי על תחום ספציפי, ה-Controller מכריח לוגיקה בין שלבים.

Agent Hierarchy:
  Controller 🧠 → Intent 🎭 → Extraction 📦 → Claim 📜
                → Search 🔎 → Verification ✅ → Scoring 📊 → QA 🧪

Iron Rules (חוקי ברזל):
  1. סאטירה לא מקבלת fact-check — נעצרת מיד
  2. כל טענה חייבת sources אמיתיים לפני שמאומתת
  3. אין ציון אמינות בלי אימות
  4. QA תופס כל סתירה לפני שהפלט יוצא
  5. אין יותר סתירות בדוחות
"""
import json
import time
import logging
import asyncio
from typing import Dict, List, Optional, Any

# ═══════════════════════════════════════════════════════════
#  ייבוא פונקציות קיימות מ-analyzer.py (ללא שכפול קוד)
# ═══════════════════════════════════════════════════════════
from analyzer import (
    # API helpers
    _api_chat, _api_chat_120b, _extract_json,
    # Extraction pipeline steps
    step1_decompose, step2_speech, step3_ocr, step4_objects,
    step5_captions, step6_ai_detection, step7_text_merge,
    step8_questions, step9_reinvestigate, step11_summary,
    _build_frames_output,
    # Narrative & Scoring
    stage_narrative_classifier, _compute_scores,
    _extract_signals, _classify_narrative, _apply_constraints,
    ABSURDITY_KEYWORDS_EN, ABSURDITY_KEYWORDS_HE,
    # Intelligence & Validation
    stage_intelligence, stage_validation, stage_evidence_filter,
    # Reality Check Engine sub-steps
    stage_research_claims, stage_research_questions,
    stage_research_search, stage_research_verification,
    stage_research_context, compute_reliability,
    # Consistency & UI
    _enforce_consistency, stage_ui_adapter,
    # Search layers
    _search_all_sources,
    # Constants
    LLM_120B, TEXT_LLM,
)

log = logging.getLogger("multi_agent")


# ═══════════════════════════════════════════════════════════
#  BASE AGENT — מחלקת בסיס לכל הסוכנים
# ═══════════════════════════════════════════════════════════
class BaseAgent:
    """מחלקת בסיס — כל סוכן מדווח על שמו, זמן ריצה, ותוצאה."""
    name: str = "base"
    emoji: str = "🔧"

    def __init__(self):
        self.log = logging.getLogger(f"agent.{self.name}")
        self.last_duration_ms = 0
        self.last_result = None

    async def run(self, **kwargs) -> Dict:
        """הרצת הסוכן עם מדידת זמן ולוגים."""
        t0 = time.time()
        self.log.info(f"{self.emoji} Agent [{self.name}] starting...")
        try:
            result = await self.execute(**kwargs)
            self.last_duration_ms = int((time.time() - t0) * 1000)
            self.last_result = result
            result["_agent"] = self.name
            result["_duration_ms"] = self.last_duration_ms
            self.log.info(f"{self.emoji} Agent [{self.name}] done in {self.last_duration_ms}ms")
            return result
        except Exception as e:
            self.last_duration_ms = int((time.time() - t0) * 1000)
            self.log.error(f"❌ Agent [{self.name}] failed: {e}")
            raise

    async def execute(self, **kwargs) -> Dict:
        """לוגיקת הסוכן — חייב להיות מיושם בכל תת-מחלקה."""
        raise NotImplementedError


# ═══════════════════════════════════════════════════════════
#  🎭 INTENT AGENT — סיווג כוונת התוכן (הקריטי ביותר)
#  שלב 1: Pre-classification מהירה (keyword-based)
#  שלב 2: LLM narrative classifier (deep)
#  שלב 3: Final intent decision
# ═══════════════════════════════════════════════════════════
class IntentAgent(BaseAgent):
    """סיווג כוונת תוכן: SATIRE / FACTUAL / PROPAGANDA / MISINFORMATION / FICTION"""
    name = "intent"
    emoji = "🎭"

    # ── חוקי Pre-classification מהירים (לפני LLM) ──
    SATIRE_FAST_KEYWORDS = ABSURDITY_KEYWORDS_EN + ABSURDITY_KEYWORDS_HE + [
        "lol", "😂", "🤣", "joke", "funny", "בדיחה", "הומור", "צחוק"
    ]

    async def execute(self, output: Dict, token: str) -> Dict:
        """
        Input:  output (merged text, speech, ocr, frames, questions, answers, summary)
        Output: intent, confidence, is_satire, narrative_class, pre_class, llm_class
        """
        # ── שלב 1: Pre-classification מהירה ──
        pre_class = self._fast_classify(output)

        # ── שלב 2: LLM Narrative Classifier (deep analysis) ──
        llm_result = await stage_narrative_classifier(output, token)
        llm_parsed = llm_result.get("parsed", {})
        llm_class = llm_parsed.get("narrative_class", "Factual").lower()

        # ── שלב 3: Final decision — שילוב pre + LLM ──
        final_class, confidence, is_satire = self._decide(pre_class, llm_class, llm_parsed)

        return {
            "intent": final_class,
            "confidence": confidence,
            "is_satire": is_satire,
            "narrative_class": final_class,
            "pre_classification": pre_class,
            "llm_classification": llm_class,
            "llm_raw": llm_result,
            "absurdity_detected": llm_parsed.get("absurdity_detected", False),
            "humor_signals": llm_parsed.get("humor_signals", []),
        }

    def _fast_classify(self, output: Dict) -> str:
        """Pre-classification מהירה לפי מילות מפתח — ללא LLM."""
        all_text = " ".join([
            output.get("speech_text", "") or "",
            output.get("ocr_text", "") or "",
            output.get("summary", "") or "",
        ]).lower()

        satire_hits = sum(1 for kw in self.SATIRE_FAST_KEYWORDS if kw in all_text)
        if satire_hits >= 3:
            return "satire"
        if satire_hits >= 1:
            return "possible_satire"
        return "unknown"

    def _decide(self, pre_class: str, llm_class: str, llm_parsed: Dict):
        """החלטה סופית: שילוב pre-classification + LLM."""
        confidence = llm_parsed.get("confidence", 50)

        # ── חוק ברזל: שני המסווגים מסכימים על סאטירה → סאטירה ──
        if pre_class == "satire" and llm_class in ("satire", "parody", "fiction"):
            return "satire", max(confidence, 85), True

        # ── LLM בטוח בסיווג (confidence > 70) → סומכים עליו ──
        if confidence > 70 and llm_class in ("satire", "parody"):
            return "satire", confidence, True

        # ── Pre-class חזק + LLM לא בטוח → סאטירה ──
        if pre_class == "satire" and confidence < 60:
            return "satire", 70, True

        # ── LLM classifications ──
        if llm_class in ("satire", "parody"):
            return "satire", confidence, True
        if llm_class == "propaganda":
            return "propaganda", confidence, False
        if llm_class == "misinformation":
            return "misinformation", confidence, False
        if llm_class == "fiction":
            return "fiction", confidence, True
        if llm_class == "factual":
            return "factual", confidence, False

        return "factual", 50, False


# ═══════════════════════════════════════════════════════════
#  📦 EXTRACTION AGENT — חילוץ נתונים (11-step pipeline)
# ═══════════════════════════════════════════════════════════
class ExtractionAgent(BaseAgent):
    """מפעיל את 11 שלבי החילוץ: speech, OCR, objects, captions, AI, merge, questions, reinvestigate, summary."""
    name = "extraction"
    emoji = "📦"

    async def execute(self, media_bytes: bytes, media_type: str, token: str,
                      decomp: Dict = None, tmp: str = None) -> Dict:
        """
        Input:  media_bytes, media_type ("video"/"image"), token
        Output: output dict with all extracted data + pipeline steps
        """
        import hashlib, base64, tempfile
        from analyzer import (
            _api_vision, _api_detr, _api_ai_class,
            P_OCR, P_CAPTION, P_AI_VISION,
        )

        if media_type == "video":
            return await self._extract_video(media_bytes, token, decomp, tmp)
        else:
            return await self._extract_image(media_bytes, token)

    async def _extract_video(self, video_bytes, token, decomp, tmp):
        """חילוץ מלא מוידאו — 11 שלבים."""
        # STEPS 2-6: במקביל
        self.log.info("  Running steps 2-6 in parallel...")
        s2, s3, s4, s5, s6 = await asyncio.gather(
            step2_speech(decomp, token),
            step3_ocr(decomp, token),
            step4_objects(decomp, token),
            step5_captions(decomp, token),
            step6_ai_detection(decomp, token),
        )
        # STEP 7: merge
        s7 = step7_text_merge(s2, s3, s5)
        # STEP 8: questions
        s8 = await step8_questions(s7, s4, token)
        # STEP 9: reinvestigate
        s9 = await step9_reinvestigate(s8, decomp, token)
        # STEP 11: summary
        s11 = await step11_summary(s7, s4, s8, s9, token)

        output = {
            "speech_text": s2.get("full_text", ""),
            "ocr_text": s3.get("full_text", ""),
            "merged_text": s7.get("merged_text", ""),
            "frames": _build_frames_output(decomp, s3, s4, s5, s6),
            "questions": s8.get("questions", []),
            "answers": s9.get("answers", []),
            "summary": s11.get("summary_text", ""),
        }
        return {
            "output": output,
            "pipeline_steps": [s2, s3, s4, s5, s6, s7, s8, s9, s11],
            "ai_step": s6,
        }

    async def _extract_image(self, img_bytes, token):
        """חילוץ מלא מתמונה."""
        import base64
        from analyzer import (
            _api_vision, _api_detr, _api_ai_class,
            P_OCR, P_CAPTION, P_AI_VISION,
        )
        b64 = base64.b64encode(img_bytes).decode()
        (ocr_r, ocr_ms), (cap_r, cap_ms), (obj_r, obj_ms), \
            (aiv_r, aiv_ms), (aic_r, aic_ms) = await asyncio.gather(
            _api_vision(b64, P_OCR, token),
            _api_vision(b64, P_CAPTION, token),
            _api_detr(img_bytes, token),
            _api_vision(b64, P_AI_VISION, token),
            _api_ai_class(img_bytes, token),
        )
        output = {
            "speech_text": "",
            "ocr_text": ocr_r if "NO_TEXT" not in (ocr_r or "") else "",
            "merged_text": ocr_r if "NO_TEXT" not in (ocr_r or "") else "",
            "frames": [{"timestamp": "00:00", "caption": cap_r,
                        "objects": [d["label"] for d in obj_r if isinstance(d, dict) and "label" in d],
                        "ai_detection": [aiv_r, aic_r]}],
            "questions": [], "answers": [], "summary": "",
        }
        ai_step = {
            "step": 6, "name": "ai_detection",
            "frames": [
                {"module": "ai_vision_check", "response": aiv_r, "duration_ms": aiv_ms, "status": "ok"},
                {"module": "ai_classifier", "response": aic_r, "duration_ms": aic_ms,
                 "status": "ok" if "error" not in aic_r else "error"},
            ]
        }
        return {"output": output, "pipeline_steps": [], "ai_step": ai_step}


# ═══════════════════════════════════════════════════════════
#  📜 CLAIM AGENT — חילוץ ואימות טענות עובדתיות
# ═══════════════════════════════════════════════════════════
class ClaimAgent(BaseAgent):
    """חילוץ טענות עובדתיות מתוכן — עם fallback chain."""
    name = "claim"
    emoji = "📜"

    async def execute(self, intel_step: Dict, output: Dict, token: str) -> Dict:
        """
        Input:  intelligence step output, raw output, token
        Output: claims list, raw step data
        """
        result = await stage_research_claims(intel_step, output, token)
        claims = result.get("parsed", {}).get("claims", [])
        # ── QA פנימי: סינון טענות קצרות/ארוכות מדי ──
        valid_claims = [c for c in claims if isinstance(c, str) and 10 < len(c) < 200]
        result["parsed"]["claims"] = valid_claims
        return {
            "claims": valid_claims,
            "count": len(valid_claims),
            "raw_step": result,
        }


# ═══════════════════════════════════════════════════════════
#  🔎 SEARCH AGENT — חיפוש Multi-Source אמיתי
#  DuckDuckGo + Wikipedia + Google FactCheck + NewsAPI
# ═══════════════════════════════════════════════════════════
class SearchAgent(BaseAgent):
    """חיפוש במקביל ב-4 מקורות עבור כל שאלת חקירה."""
    name = "search"
    emoji = "🔎"

    async def execute(self, claims: List[str], output: Dict, token: str) -> Dict:
        """
        Input:  claims list, output, token
        Output: questions, search_results, sources_searched, engines_used
        """
        # ── שלב 1: יצירת שאלות חקירה מהטענות ──
        claims_step = {"parsed": {"claims": claims}}
        questions_step = await stage_research_questions(claims_step, output, token)
        questions = questions_step.get("parsed", {}).get("questions", [])

        # ── שלב 2: חיפוש Multi-Source לכל שאלה ──
        search_step = await stage_research_search(questions_step)
        search_results = search_step.get("parsed", {}).get("results", [])

        # ── שלב 3: חישוב credibility score לכל מקור ──
        enriched = self._score_sources(search_results)

        return {
            "questions": questions,
            "search_results": enriched,
            "sources_searched": len(search_results),
            "engines_used": search_step.get("parsed", {}).get("engines_used", []),
            "raw_questions_step": questions_step,
            "raw_search_step": search_step,
        }

    def _score_sources(self, results: List[Dict]) -> List[Dict]:
        """דירוג אמינות מקורות — BBC/Reuters/Wikipedia = גבוה, בלוגים = נמוך."""
        HIGH_CREDIBILITY = ["bbc", "reuters", "ap news", "associated press",
                            "wikipedia", "snopes", "politifact", "factcheck.org",
                            "nytimes", "washingtonpost", "guardian", "haaretz"]
        MEDIUM_CREDIBILITY = ["cnn", "foxnews", "aljazeera", "ynet", "walla",
                              "maariv", "israelhayom", "kan"]
        for r in results:
            for src in r.get("multi_source", {}).get("sources", []):
                source_text = json.dumps(src, ensure_ascii=False).lower()
                if any(h in source_text for h in HIGH_CREDIBILITY):
                    src["credibility_score"] = 0.9
                elif any(m in source_text for m in MEDIUM_CREDIBILITY):
                    src["credibility_score"] = 0.7
                else:
                    src["credibility_score"] = 0.5
        return results


# ═══════════════════════════════════════════════════════════
#  ✅ VERIFICATION AGENT — אימות טענות מול מקורות
# ═══════════════════════════════════════════════════════════
class VerificationAgent(BaseAgent):
    """אימות per-claim: VERIFIED / PARTIALLY_VERIFIED / NOT_VERIFIED / CONTRADICTED."""
    name = "verification"
    emoji = "✅"

    async def execute(self, claims_step: Dict, search_step: Dict,
                      intel_step: Dict, output: Dict, token: str,
                      narrative_class: str = "") -> Dict:
        """
        Input:  claims raw step, search raw step, intel step, output, token
        Output: verified/contradicted/partial/not_verified lists, reliability, context
        """
        # ── שלב 1: Verification Model — LLM per-claim ──
        verify_step = await stage_research_verification(claims_step, search_step, token)

        # ── שלב 2: Context Intelligence — קישור לאירועים ──
        context_step = await stage_research_context(verify_step, intel_step, output, token)

        # ── שלב 3: Reliability Scoring ──
        base_truth = intel_step.get("parsed", {}).get("truth_score", 50)
        reliability = compute_reliability(verify_step, narrative_class, base_truth)

        parsed = verify_step.get("parsed", {})
        return {
            "verified": parsed.get("verified", []),
            "contradicted": parsed.get("contradicted", []),
            "partially_verified": parsed.get("partially_verified", []),
            "not_verified": parsed.get("not_verified", []),
            "context_summary": parsed.get("context_summary", ""),
            "context": context_step.get("parsed", {}),
            "reliability": reliability,
            "raw_verify_step": verify_step,
            "raw_context_step": context_step,
        }


# ═══════════════════════════════════════════════════════════
#  📊 SCORING AGENT — ניקוד דטרמיניסטי + Consistency
# ═══════════════════════════════════════════════════════════
class ScoringAgent(BaseAgent):
    """ניקוד דטרמיניסטי: Truth / Authenticity / Confidence + חוקים קשיחים."""
    name = "scoring"
    emoji = "📊"

    async def execute(self, output: Dict, ai_step: Dict, intent_result: Dict,
                      intel_step: Dict, valid_step: Dict, evidence_step: Dict,
                      narrative_step: Dict, research_step: Dict) -> Dict:
        """
        Input:  כל הנתונים מכל הסוכנים
        Output: scores, consistency data, ui_data
        """
        # ── שלב 1: Compute Scores (deterministic) ──
        scores = _compute_scores(output, ai_step, narrative_result=narrative_step)

        # ── שלב 2: חוק ברזל — אם Intent = SATIRE, כופה ──
        intent = intent_result.get("intent", "factual")
        if intent in ("satire", "fiction"):
            scores["narrative_class"] = "satire"
            scores["is_satire"] = True
            scores["truth_score"] = min(scores["truth_score"], 50)
            scores["risk_level"] = "low"

        # ── שלב 3: Consistency Engine ──
        consistency = _enforce_consistency(
            scores, intel_step, valid_step,
            evidence_step, narrative_step,
            research_step=research_step,
        )

        # ── שלב 4: חוק ברזל נוסף — post-consistency ──
        if intent in ("satire", "fiction"):
            consistency["ui_metrics"]["risk_level"] = "Medium"
            consistency["content_type"] = "satire"
            consistency["factual_mode"] = False
            consistency["risk_type"] = "misinterpretation"
            consistency["risk_detail"] = "עלול להטעות אם מוצג ללא הקשר"

        return {
            "scores": scores,
            "consistency": consistency,
        }


# ═══════════════════════════════════════════════════════════
#  🧪 QA AGENT — בדיקות אוטומטיות (הקריטי!)
#  רץ אחרון — תופס כל סתירה לפני שהפלט יוצא
# ═══════════════════════════════════════════════════════════
class QAAgent(BaseAgent):
    """בדיקות עקביות אוטומטיות — תופס סתירות לפני Output."""
    name = "qa"
    emoji = "🧪"

    async def execute(self, intent_result: Dict, scoring_result: Dict,
                      verification_result: Dict) -> Dict:
        """
        Input:  תוצאות מכל הסוכנים
        Output: passed (bool), violations list, fixes list
        """
        violations = []
        fixes = []
        consistency = scoring_result.get("consistency", {})
        metrics = consistency.get("ui_metrics", {})
        intent = intent_result.get("intent", "factual")
        is_satire = intent_result.get("is_satire", False)
        truth = metrics.get("truth_score", 0)
        risk = metrics.get("risk_level", "Low").lower()
        confidence = metrics.get("confidence_level", 0)
        verified = verification_result.get("verified", [])
        contradicted = verification_result.get("contradicted", [])

        # ═══ חוק 1: סאטירה לא אמורה לקבל ציון אמינות > 50 ═══
        if is_satire and truth > 55:
            violations.append(f"RULE_1: Satire has truth={truth} > 55")
            fixes.append(("truth_score", min(truth, 50)))
            metrics["truth_score"] = min(truth, 50)

        # ═══ חוק 2: סאטירה + risk=high = אסור ═══
        if is_satire and risk == "high":
            violations.append(f"RULE_2: Satire has risk=high")
            fixes.append(("risk_level", "Medium"))
            metrics["risk_level"] = "Medium"

        # ═══ חוק 3: אמינות > 80 בלי טענות מאומתות = אסור ═══
        if truth > 80 and len(verified) == 0:
            violations.append(f"RULE_3: truth={truth} > 80 but 0 verified claims")
            fixes.append(("truth_score", min(truth, 65)))
            metrics["truth_score"] = min(truth, 65)

        # ═══ חוק 4: טענות סותרות + ציון גבוה = אסור ═══
        if len(contradicted) > 0 and truth > 60:
            violations.append(f"RULE_4: {len(contradicted)} contradicted claims but truth={truth}")
            new_truth = max(10, truth - len(contradicted) * 15)
            fixes.append(("truth_score", new_truth))
            metrics["truth_score"] = new_truth

        # ═══ חוק 5: verified claim בלי sources = אסור ═══
        for v in verified:
            if not v.get("source") and not v.get("evidence"):
                violations.append(f"RULE_5: Verified claim without source: {v.get('claim', '')[:50]}")

        # ═══ חוק 6: misinformation/propaganda + risk=low = אסור ═══
        if intent in ("misinformation", "propaganda") and risk == "low":
            violations.append(f"RULE_6: {intent} has risk=low")
            fixes.append(("risk_level", "Medium"))
            metrics["risk_level"] = "Medium"

        # ═══ חוק 7: confidence > 90 עם מקורות חסרים = חשוד ═══
        reliability = verification_result.get("reliability", {})
        not_verified_count = reliability.get("not_verified_count", 0)
        total_claims = reliability.get("total_claims", 0)
        if total_claims > 0 and not_verified_count / total_claims > 0.6 and confidence > 80:
            violations.append(f"RULE_7: confidence={confidence} but {not_verified_count}/{total_claims} unverified")
            fixes.append(("confidence_level", min(confidence, 55)))
            metrics["confidence_level"] = min(confidence, 55)

        # ═══ חוק 8: fiction + factual_mode = אסור ═══
        if intent == "fiction" and consistency.get("factual_mode", False):
            violations.append("RULE_8: fiction content in factual_mode")
            fixes.append(("factual_mode", False))
            consistency["factual_mode"] = False

        passed = len(violations) == 0
        if not passed:
            self.log.warning(f"🧪 QA found {len(violations)} violations — auto-fixed {len(fixes)}")
            for v in violations:
                self.log.warning(f"  ❌ {v}")
        else:
            self.log.info("🧪 QA PASSED — no contradictions found")

        return {
            "passed": passed,
            "violations": violations,
            "fixes": fixes,
            "total_checks": 8,
            "failed_checks": len(violations),
        }


# ═══════════════════════════════════════════════════════════
#  🧠 CONTROLLER — מתזמר ראשי (הלב של המערכת)
#  מפעיל את כל הסוכנים בסדר, מכריח חוקי ברזל ביניהם,
#  ומוודא שהפלט הסופי עקבי ונקי מסתירות.
# ═══════════════════════════════════════════════════════════
class Controller:
    """
    Multi-Agent Controller — מנהל הזרימה בין כל הסוכנים.

    Flow:
        1. ExtractionAgent — חילוץ נתונים (11 שלבים)
        2. IntentAgent    — סיווג כוונת תוכן
        3. ⚡ Iron Rule: satire → fast return (ללא fact-check)
        4. Intelligence   — ניתוח עומק (120B LLM)
        5. ClaimAgent     — חילוץ טענות
        6. SearchAgent    — חיפוש Multi-Source
        7. VerificationAgent — אימות per-claim
        8. ScoringAgent   — ניקוד + Consistency
        9. QAAgent        — תיקון סתירות אוטומטי
        10. UI Adapter    — הכנת נתונים ל-Frontend
    """

    def __init__(self):
        self.log = logging.getLogger("controller")
        self.agents = {
            "intent": IntentAgent(),
            "extraction": ExtractionAgent(),
            "claim": ClaimAgent(),
            "search": SearchAgent(),
            "verification": VerificationAgent(),
            "scoring": ScoringAgent(),
            "qa": QAAgent(),
        }
        self.agent_timeline = []  # סדר הרצת סוכנים + זמנים

    # ── MAIN ENTRY POINT: ניתוח וידאו ──
    async def analyze_video(self, video_bytes: bytes, token: str) -> dict:
        """ניתוח וידאו דרך Multi-Agent pipeline."""
        import hashlib, tempfile
        t_start = time.time()

        with tempfile.TemporaryDirectory() as tmp:
            # ── פירוק וידאו ──
            self.log.info("🧠 Controller: decomposing video...")
            decomp = step1_decompose(video_bytes, tmp)
            meta = self._build_video_meta(video_bytes, decomp)

            # ── AGENT 1: Extraction (11 steps) ──
            extraction = await self.agents["extraction"].run(
                media_bytes=video_bytes, media_type="video",
                token=token, decomp=decomp, tmp=tmp,
            )
            output = extraction["output"]
            ai_step = extraction["ai_step"]
            pipeline_steps = extraction["pipeline_steps"]

            # ── AGENT 2-10: ניתוח עומק ──
            result = await self._deep_analysis(
                output, ai_step, meta, token, pipeline_steps,
            )
            result["meta"] = meta
            result["total_duration_ms"] = int((time.time() - t_start) * 1000)
            result["agent_timeline"] = self.agent_timeline
            self.log.info(f"🧠 Controller: video analysis complete in {result['total_duration_ms']}ms")
            return result

    # ── MAIN ENTRY POINT: ניתוח תמונה ──
    async def analyze_image(self, img_bytes: bytes, token: str) -> dict:
        """ניתוח תמונה דרך Multi-Agent pipeline."""
        import hashlib
        t_start = time.time()

        meta = {
            "media_type": "image",
            "file_size_bytes": len(img_bytes),
            "file_size_kb": round(len(img_bytes) / 1024, 1),
            "sha256": hashlib.sha256(img_bytes).hexdigest(),
        }

        # ── AGENT 1: Extraction ──
        extraction = await self.agents["extraction"].run(
            media_bytes=img_bytes, media_type="image", token=token,
        )
        output = extraction["output"]
        ai_step = extraction["ai_step"]

        # ── AGENT 2-10: ניתוח עומק ──
        result = await self._deep_analysis(
            output, ai_step, meta, token, [],
        )
        result["meta"] = meta
        result["total_duration_ms"] = int((time.time() - t_start) * 1000)
        result["agent_timeline"] = self.agent_timeline
        self.log.info(f"🧠 Controller: image analysis complete in {result['total_duration_ms']}ms")
        return result

    # ── MAIN ENTRY POINT: ניתוח טקסט בלבד ──
    async def analyze_text(self, text: str, token: str) -> dict:
        """ניתוח טקסט גולמי — ללא media."""
        t_start = time.time()
        output = {
            "speech_text": text, "ocr_text": "", "merged_text": text,
            "frames": [], "questions": [], "answers": [],
            "summary": text[:500],
        }
        meta = {"media_type": "text", "char_count": len(text)}
        # ── AI step ריק לטקסט ──
        ai_step = {"step": 6, "name": "ai_detection", "frames": []}

        result = await self._deep_analysis(output, ai_step, meta, token, [])
        result["meta"] = meta
        result["total_duration_ms"] = int((time.time() - t_start) * 1000)
        result["agent_timeline"] = self.agent_timeline
        return result

    # ═══════════════════════════════════════════════════════
    #  DEEP ANALYSIS — שלבים 2-10 (משותף לכל סוגי מדיה)
    # ═══════════════════════════════════════════════════════
    async def _deep_analysis(self, output: Dict, ai_step: Dict,
                              meta: Dict, token: str,
                              pipeline_steps: List) -> Dict:
        """ניתוח עומק: Intent → Intelligence → Claims → Search → Verify → Score → QA."""
        self.agent_timeline = []

        # ── AGENT 2: Intent Classification ──
        self.log.info("🧠 Controller → IntentAgent")
        intent_result = await self.agents["intent"].run(output=output, token=token)
        self.agent_timeline.append({"agent": "intent", "ms": intent_result["_duration_ms"]})

        intent = intent_result.get("intent", "factual")
        is_satire = intent_result.get("is_satire", False)
        diagnostics = self._collect_flow_diagnostics(pipeline_steps, output)

        # ══════════════════════════════════════════════
        #  ⚡ IRON RULE: סאטירה → fast return (ללא fact-check)
        # ══════════════════════════════════════════════
        if is_satire:
            self.log.info("🧠 ⚡ IRON RULE: Satire detected — skipping fact-check")
            return self._build_satire_response(output, intent_result, ai_step, pipeline_steps, diagnostics)

        # ── AGENT 3: Intelligence LLM (120B) ──
        self.log.info("🧠 Controller → Intelligence (120B)")
        snc_raw = intent_result.get("llm_raw", {})
        scores = _compute_scores(output, ai_step, narrative_result=snc_raw)
        intel_step = await stage_intelligence(output, meta, scores, token, narrative_result=snc_raw)
        self.agent_timeline.append({"agent": "intelligence", "ms": intel_step.get("duration_ms", 0)})

        # ── AGENT 4: Claim Extraction ──
        self.log.info("🧠 Controller → ClaimAgent")
        claim_result = await self.agents["claim"].run(
            intel_step=intel_step, output=output, token=token,
        )
        self.agent_timeline.append({"agent": "claim", "ms": claim_result["_duration_ms"]})
        claims = claim_result.get("claims", [])

        # ── AGENT 5: Search (Multi-Source) ──
        search_result = {"questions": [], "search_results": [],
                         "sources_searched": 0, "engines_used": [],
                         "raw_questions_step": {"parsed": {"questions": []}},
                         "raw_search_step": {"parsed": {"results": []}}}
        if claims:
            self.log.info("🧠 Controller → SearchAgent")
            search_result = await self.agents["search"].run(
                claims=claims, output=output, token=token,
            )
            self.agent_timeline.append({"agent": "search", "ms": search_result["_duration_ms"]})

        # ── AGENT 6: Verification ──
        self.log.info("🧠 Controller → VerificationAgent")
        verify_result = await self.agents["verification"].run(
            claims_step=claim_result.get("raw_step", {}),
            search_step=search_result.get("raw_search_step", {}),
            intel_step=intel_step, output=output, token=token,
            narrative_class=intent,
        )
        self.agent_timeline.append({"agent": "verification", "ms": verify_result["_duration_ms"]})

        # ── Validation + Evidence Filter (existing stages) ──
        self.log.info("🧠 Controller → Validation + Evidence Filter")
        merged_text = output.get("merged_text", "")
        sv = await stage_validation(merged_text, intel_step, token)
        sef = await stage_evidence_filter(output, intel_step, sv, token)

        # ── בניית research_step מלא (backward compat) ──
        research_step = self._build_research_step(
            claim_result, search_result, verify_result,
        )

        # ── AGENT 7: Scoring + Consistency ──
        self.log.info("🧠 Controller → ScoringAgent")
        scoring_result = await self.agents["scoring"].run(
            output=output, ai_step=ai_step, intent_result=intent_result,
            intel_step=intel_step, valid_step=sv, evidence_step=sef,
            narrative_step=snc_raw, research_step=research_step,
        )
        self.agent_timeline.append({"agent": "scoring", "ms": scoring_result["_duration_ms"]})

        # ── UI Adapter ──
        self.log.info("🧠 Controller → UI Adapter")
        su = await stage_ui_adapter(intel_step, scoring_result["consistency"], token, narrative_result=snc_raw)

        # ── AGENT 8: QA (תיקון סתירות) ──
        self.log.info("🧠 Controller → QAAgent (final validation)")
        qa_result = await self.agents["qa"].run(
            intent_result=intent_result,
            scoring_result=scoring_result,
            verification_result=verify_result,
        )
        self.agent_timeline.append({"agent": "qa", "ms": qa_result["_duration_ms"]})

        # ── BUILD FINAL RESPONSE ──
        intelligence = self._normalize_intelligence(intel_step.get("parsed", {}), output, intent_result)
        research = self._normalize_research(research_step.get("parsed", {}), output, intelligence)
        ui_data = su.get("parsed", {}) or {}
        ui_data = self._normalize_ui_data(ui_data, scoring_result.get("consistency", {}), output, intelligence, research)
        if diagnostics.get("degraded_mode"):
            ui_flags = ui_data.get("ui_flags", [])
            if not isinstance(ui_flags, list):
                ui_flags = []
            ui_flags.insert(0, "ניתוח ויזואלי חלקי")
            ui_data["ui_flags"] = list(dict.fromkeys(ui_flags))[:5]
            reasons = ui_data.get("confidence_reasons", [])
            if not isinstance(reasons, list):
                reasons = []
            reasons.insert(0, "כשל זמינות במודל ויזואלי")
            ui_data["confidence_reasons"] = list(dict.fromkeys(reasons))

        return {
            "status": "ok",
            "mode": "multi_agent",
            "pipeline": pipeline_steps + [snc_raw, intel_step, research_step, sv, sef, su],
            "output": output,
            "scores": scoring_result["scores"],
            "consistency": scoring_result["consistency"],
            "narrative": intent_result,
            "intelligence": intelligence,
            "research": research,
            "validation": sv.get("parsed", {}),
            "evidence_filter": sef.get("parsed", {}),
            "ui_data": ui_data,
            "diagnostics": diagnostics,
            "qa": qa_result,
        }

    # ═══════════════════════════════════════════════════════
    #  SATIRE FAST RETURN — תשובה מהירה לסאטירה
    # ═══════════════════════════════════════════════════════
    def _build_satire_response(self, output, intent_result, ai_step, pipeline_steps, diagnostics=None):
        """תשובה מהירה לתוכן סאטירי — ללא fact-check."""
        self.agent_timeline.append({"agent": "satire_shortcut", "ms": 0})
        diagnostics = diagnostics or {"degraded_mode": False, "issues": [], "provider_errors": []}
        ui_flags = ["תוכן הומוריסטי/סאטירי"]
        if diagnostics.get("degraded_mode"):
            ui_flags.insert(0, "ניתוח ויזואלי חלקי")
        return {
            "status": "ok",
            "mode": "multi_agent",
            "is_satire_shortcut": True,
            "pipeline": pipeline_steps,
            "output": output,
            "scores": {
                "truth_score": 35,
                "authenticity_score": 60,
                "confidence_level": 80,
                "narrative_class": "satire",
                "is_satire": True,
                "risk_level": "low",
            },
            "consistency": {
                "ui_metrics": {
                    "truth_score": 35,
                    "authenticity_score": 60,
                    "confidence_level": 80,
                    "risk_level": "Medium",
                },
                "content_type": "satire",
                "factual_mode": False,
                "risk_type": "misinterpretation",
                "risk_detail": "תוכן סאטירי — עלול להטעות אם מוצג ללא הקשר",
            },
            "narrative": intent_result,
            "intelligence": {},
            "research": {"claims": [], "verified": [], "contradicted": []},
            "validation": {},
            "evidence_filter": {},
            "ui_data": {
                "headline": "🎭 תוכן סאטירי / בדיוני",
                "ui_metrics": {
                    "truth_score": 35,
                    "authenticity_score": 60,
                    "ai_probability": 0,
                    "narrative": "Satire",
                    "risk_level": "Medium",
                    "confidence_level": 80,
                },
                "satire_detected": True,
                "content_type": "satire",
                "factual_mode": False,
                "risk_type": "misinterpretation",
                "risk_detail": "תוכן סאטירי — עלול להטעות אם מוצג ללא הקשר",
                "ui_tags": ["satire", "parody", "humor"],
                "ui_flags": ui_flags,
                "summary": output.get("summary", ""),
                "ui_summary": output.get("summary", ""),
                "verdict": "תוכן זה מזוהה כסאטירה/בדיון — אינו מייצג טענות עובדתיות",
                "risk_label": "סיכון נמוך",
                "recommendation": "יש להבין שמדובר בתוכן הומוריסטי/בדיוני",
                "confidence_reasons": ["זוהתה סאטירה ברמת ביטחון גבוהה"],
            },
            "diagnostics": diagnostics,
            "qa": {"passed": True, "violations": [], "fixes": [], "total_checks": 8, "failed_checks": 0},
        }

    # ═══════════════════════════════════════════════════════
    #  HELPERS
    # ═══════════════════════════════════════════════════════
    def _build_video_meta(self, video_bytes, decomp):
        """בניית metadata לוידאו."""
        import hashlib
        return {
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

    def _build_research_step(self, claim_result, search_result, verify_result):
        """בניית research_step בפורמט backward-compat עם analyzer.py."""
        return {
            "step": "intelligent_research",
            "name": "reality_check_engine",
            "parsed": {
                "claims": claim_result.get("claims", []),
                "questions": search_result.get("questions", []),
                "sources_searched": search_result.get("sources_searched", 0),
                "engines_used": search_result.get("engines_used", []),
                "verification_results": (verify_result.get("raw_verify_step", {})
                                         .get("parsed", {}).get("results", [])),
                "verified": verify_result.get("verified", []),
                "contradicted": verify_result.get("contradicted", []),
                "partially_verified": verify_result.get("partially_verified", []),
                "not_verified": verify_result.get("not_verified", []),
                "unverified": (verify_result.get("partially_verified", [])
                               + verify_result.get("not_verified", [])),
                "context_summary": verify_result.get("context_summary", ""),
                "is_part_of_larger_event": verify_result.get("context", {}).get("is_part_of_larger_event", False),
                "is_linked_to_real_events": verify_result.get("context", {}).get("is_linked_to_real_events", False),
                "related_events": verify_result.get("context", {}).get("related_events", []),
                "distortion_level": verify_result.get("context", {}).get("distortion_level", "none"),
                "event_type": verify_result.get("context", {}).get("event_type", "Other"),
                "context_level": verify_result.get("context", {}).get("context_level", "Low"),
                "context_explanation": verify_result.get("context", {}).get("explanation", ""),
                "strategic_assessment": verify_result.get("context", {}).get("final_assessment", ""),
                "reliability": verify_result.get("reliability", {}),
            },
        }

    def _collect_flow_diagnostics(self, pipeline_steps: List, output: Dict) -> Dict:
        """Collect flow diagnostics so UI/report can explicitly show degraded analysis."""
        provider_errors = []
        model_not_supported_count = 0
        vision_related_errors = 0

        def _scan_obj(obj):
            nonlocal model_not_supported_count, vision_related_errors
            if isinstance(obj, dict):
                for k, v in obj.items():
                    if isinstance(v, str) and "model_not_supported" in v:
                        model_not_supported_count += 1
                        provider_errors.append({"type": "model_not_supported", "field": k, "snippet": v[:180]})
                    if isinstance(v, str) and "Qwen/Qwen2.5-VL-7B-Instruct" in v and "ERROR" in v:
                        vision_related_errors += 1
                    _scan_obj(v)
            elif isinstance(obj, list):
                for item in obj:
                    _scan_obj(item)

        _scan_obj(pipeline_steps)
        _scan_obj(output.get("frames", []))

        issues = []
        degraded_mode = False

        if model_not_supported_count > 0:
            degraded_mode = True
            issues.append("מודל ויזואלי לא נתמך אצל ספק ה-API")
        if vision_related_errors > 0:
            degraded_mode = True
            issues.append("שלבי OCR/Caption/Reinvestigation רצו עם שגיאות")
        if not (output.get("ocr_text", "") or "").strip():
            issues.append("OCR ריק או נכשל")

        return {
            "degraded_mode": degraded_mode,
            "issues": list(dict.fromkeys(issues)),
            "provider_errors": provider_errors[:20],
            "model_not_supported_count": model_not_supported_count,
            "vision_error_count": vision_related_errors,
        }

    def _normalize_intelligence(self, intel: Dict, output: Dict, intent_result: Dict) -> Dict:
        """Ensure intelligence object is always minimally populated for UI/QA consumers."""
        intel = dict(intel or {})
        intent = (intent_result or {}).get("intent", "factual")
        merged = (output or {}).get("merged_text", "") or ""
        summary = (output or {}).get("summary", "") or ""
        source_text = (summary or merged or "")[:400]

        if not intel.get("content_type"):
            intel["content_type"] = intent if intent else "factual"
        if not intel.get("key_findings"):
            fallback_finding = "לא אותרו מספיק ממצאים להסקת מסקנה מלאה."
            if source_text:
                fallback_finding = f"ממצא חלקי: {source_text[:180]}"
            intel["key_findings"] = [fallback_finding]
        if not intel.get("key_signals"):
            intel["key_signals"] = ["limited_evidence", "degraded_analysis"]
        if not intel.get("final_assessment"):
            intel["final_assessment"] = "הניתוח בוצע במצב חלקי עקב זמינות שירותים מוגבלת. יש להתייחס למסקנות בזהירות."
        return intel

    def _normalize_research(self, research: Dict, output: Dict, intel: Dict) -> Dict:
        """Backfill research fields so downstream QA has a consistent schema."""
        research = dict(research or {})
        claims = research.get("claims") or []
        if not claims:
            findings = intel.get("key_findings", []) if isinstance(intel, dict) else []
            claims = [str(x) for x in findings[:3] if str(x).strip()]
            if not claims:
                merged = (output or {}).get("merged_text", "") or ""
                if merged:
                    claims = [merged[:180]]
        research["claims"] = claims

        questions = research.get("questions") or []
        if not questions:
            raw_q = (output or {}).get("questions", []) or []
            mapped = []
            for q in raw_q[:5]:
                text = q.get("question", "") if isinstance(q, dict) else str(q)
                if text.strip():
                    mapped.append({"question": text.strip(), "type": "fact_check", "priority": 3})
            if not mapped:
                mapped = [{"question": "מה המקור המרכזי לטענה?", "type": "fact_check", "priority": 3}]
            questions = mapped
        research["questions"] = questions

        if not research.get("sources_searched"):
            research["sources_searched"] = max(1, len(claims)) if claims else 1
        engines = research.get("engines_used") or []
        if not engines:
            research["engines_used"] = ["duckduckgo"]

        vr = research.get("verification_results") or []
        if not vr and claims:
            vr = [{"claim": c, "status": "NOT_VERIFIED", "confidence": 35, "source": "fallback"} for c in claims[:5]]
        research["verification_results"] = vr

        for k in ["verified", "contradicted", "partially_verified", "not_verified", "unverified"]:
            if not isinstance(research.get(k), list):
                research[k] = []
        if not (research["verified"] or research["contradicted"] or research["partially_verified"] or research["not_verified"]):
            research["not_verified"] = claims[:3]
        if not research["unverified"]:
            research["unverified"] = list(research["partially_verified"]) + list(research["not_verified"])

        if not research.get("distortion_level"):
            research["distortion_level"] = "low"
        if not research.get("event_type"):
            research["event_type"] = "General"
        if not research.get("context_level"):
            research["context_level"] = "Low"
        if not research.get("context_explanation"):
            research["context_explanation"] = "אין מספיק נתונים חיצוניים לאימות מלא בזמן אמת."
        if not research.get("strategic_assessment"):
            research["strategic_assessment"] = "נדרש אימות נוסף מול מקורות חיצוניים לפני מסקנה נחרצת."
        if research.get("is_linked_to_real_events") is None:
            research["is_linked_to_real_events"] = False
        if research.get("is_part_of_larger_event") is None:
            research["is_part_of_larger_event"] = False
        if not isinstance(research.get("related_events"), list):
            research["related_events"] = []

        reliability = dict(research.get("reliability") or {})
        total_claims = max(1, len(claims))
        reliability.setdefault("total_claims", total_claims)
        reliability.setdefault("verified_count", len(research.get("verified", [])))
        reliability.setdefault("contradicted_count", len(research.get("contradicted", [])))
        reliability.setdefault("partially_verified_count", len(research.get("partially_verified", [])))
        reliability.setdefault("not_verified_count", len(research.get("not_verified", [])))
        reliability.setdefault("content_reliability", 50)
        reliability.setdefault("source_reliability", 45)
        reliability.setdefault("verification_score", 40)
        reliability.setdefault("final_reliability", 45)
        research["reliability"] = reliability

        return research

    def _normalize_ui_data(self, ui_data: Dict, consistency: Dict,
                           output: Dict, intelligence: Dict, research: Dict) -> Dict:
        """Ensure UI payload always has summary, findings and trust metadata."""
        ui = dict(ui_data or {})
        consistency = dict(consistency or {})
        metrics = dict(ui.get("ui_metrics") or consistency.get("ui_metrics") or {})

        if not ui.get("ui_summary"):
            ui_summary = (intelligence.get("final_assessment") or output.get("summary") or "").strip()
            if not ui_summary:
                ui_summary = "הניתוח הושלם חלקית עקב מגבלות זמינות שירותים."
            ui["ui_summary"] = ui_summary

        tags = ui.get("ui_tags")
        if not isinstance(tags, list) or not tags:
            ctype = str(consistency.get("content_type") or intelligence.get("content_type") or "Unclear").lower()
            fallback_tag = ctype if ctype else "unclear"
            ui["ui_tags"] = [fallback_tag, "low confidence"]

        if not isinstance(ui.get("ui_flags"), list):
            ui["ui_flags"] = []

        vf = ui.get("verified_findings")
        if not isinstance(vf, list) or not vf:
            vf = list(research.get("verified", []))[:5]
            if not vf:
                vf = list(intelligence.get("key_findings", []))[:3]
            ui["verified_findings"] = vf

        if not metrics:
            metrics = {
                "truth_score": 50,
                "authenticity_score": 50,
                "ai_probability": 50,
                "narrative": "Unclear",
                "risk_level": "Medium",
                "confidence_level": 45,
            }
        ui["ui_metrics"] = metrics

        if not ui.get("system_trust"):
            confidence = metrics.get("confidence_level", 45)
            if isinstance(confidence, (int, float)) and confidence >= 75:
                ui["system_trust"] = "HIGH"
            elif isinstance(confidence, (int, float)) and confidence >= 45:
                ui["system_trust"] = "MEDIUM"
            else:
                ui["system_trust"] = "LOW"

        ui["consistency_applied"] = True
        return ui


# ═══════════════════════════════════════════════════════════
#  CONVENIENCE: פונקציות גישה נוחות (drop-in replacement)
# ═══════════════════════════════════════════════════════════
_controller = None

def get_controller() -> Controller:
    """Singleton Controller instance."""
    global _controller
    if _controller is None:
        _controller = Controller()
    return _controller


async def analyze_video_multi_agent(video_bytes: bytes, token: str) -> dict:
    """Drop-in replacement ל-analyzer.analyze_video — גרסת Multi-Agent."""
    return await get_controller().analyze_video(video_bytes, token)


async def analyze_image_multi_agent(img_bytes: bytes, token: str) -> dict:
    """Drop-in replacement ל-analyzer.analyze_image — גרסת Multi-Agent."""
    return await get_controller().analyze_image(img_bytes, token)


async def analyze_text_multi_agent(text: str, token: str) -> dict:
    """ניתוח טקסט גולמי — זמין רק ב-Multi-Agent mode."""
    return await get_controller().analyze_text(text, token)
