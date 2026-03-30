// ═══════════════════════════════════════════════════════════
//  HF Client — Direct HuggingFace API from Browser
//  Enables full analysis on GitHub Pages without backend
// ═══════════════════════════════════════════════════════════

const HF_CLIENT = (() => {

    const HF_INF   = 'https://router.huggingface.co/hf-inference/models';
    const CHAT_URL = 'https://router.huggingface.co/v1/chat/completions';
    const DETR     = 'facebook/detr-resnet-50';
    const AI_CLASS = 'umm-maybe/AI-image-detector';
    const TEXT_LLM = 'deepseek-ai/DeepSeek-V3';
    const WHISPER  = 'openai/whisper-large-v3-turbo';

    const VISION_MODELS = [
        'Qwen/Qwen2.5-VL-72B-Instruct',
        'meta-llama/Llama-4-Scout-17B-16E-Instruct',
        'google/gemma-3-27b-it',
        'Qwen/Qwen3.5-35B-A3B',
        'Qwen/Qwen3.5-27B',
        'zai-org/GLM-4.6V',
        'Qwen/Qwen2.5-VL-7B-Instruct',
    ];

    // ── Prompts (same as backend analyzer.py) ──

    const P_OCR =
        'OUTPUT ONLY THE RAW TEXT visible in this image. No explanations, no formatting.\n' +
        'Include ALL text: banners, tickers, overlays, subtitles, watermarks, logos, signs.\n' +
        'Include ALL languages (Hebrew, Arabic, English, etc). Preserve line breaks.\n' +
        'If unclear character write [?]. If NO text at all write: NO_TEXT_FOUND\n' +
        'CRITICAL: Do NOT write any introduction like \'The text is:\'. Output ONLY the text.';

    const P_CAPTION =
        'Describe this image in detail. Include:\n' +
        '- What is shown (people, objects, scene)\n' +
        '- Text visible on screen\n' +
        '- Setting/environment\n' +
        '- Notable visual elements\n' +
        'Be factual and specific. Output in the language of the visible text, or English.';

    const P_AI_VISION =
        'Analyze this image for signs of AI generation or manipulation.\n' +
        'Check: unnatural textures, warped text, extra fingers, inconsistent lighting,\n' +
        'blurred edges, repetitive patterns, deepfake artifacts.\n' +
        'Return JSON: {"ai_generated": true/false, "confidence": 0.0-1.0, "signals": []}';

    const P_INTELLIGENCE =
        'You are a high-level intelligence analyst.\n\n' +
        'Your job:\n' +
        '- Interpret the content meaning\n' +
        '- Detect: satire, parody, misinformation, propaganda, factual reporting\n' +
        '- Identify key signals (contradictions, humor, nonsense, unsourced claims)\n' +
        '- List factual findings grounded ONLY in the input data\n' +
        '- Note uncertainties\n\n' +
        'STRICT RULES:\n' +
        '- Do NOT assign scores or percentages\n' +
        '- Do NOT estimate reliability, risk, confidence, authenticity, or manipulation\n' +
        '- Do NOT invent facts not supported by input\n' +
        '- If uncertain → say so explicitly\n' +
        '- Base conclusions ONLY on provided data\n' +
        '- Prefer \'insufficient evidence\' over guessing\n\n' +
        'LANGUAGE RULES:\n' +
        '- Write final_assessment in HEBREW (עברית) — 2-3 sentences\n' +
        '- Write key_findings in HEBREW (עברית) — short factual sentences\n' +
        '- Write uncertainties in HEBREW (עברית) — short sentences\n' +
        '- Write recommended_action in HEBREW (עברית)\n' +
        '- Write reasoning in English\n' +
        '- Write key_signals in English\n' +
        '- Write content_type in English\n\n' +
        'OUTPUT FORMAT (STRICT JSON ONLY):\n' +
        '{\n' +
        '  "content_type": "satire | misinformation | propaganda | factual | fiction | unclear",\n' +
        '  "key_signals": ["contradictions", "humor", "nonsense", "unsourced_claims"],\n' +
        '  "key_findings": ["ממצא עובדתי בעברית 1", "..."],\n' +
        '  "final_assessment": "מסקנה קצרה בעברית — 2-3 משפטים",\n' +
        '  "reasoning": "step-by-step reasoning in English based ONLY on input",\n' +
        '  "uncertainties": ["אי ודאות בעברית 1", "..."],\n' +
        '  "recommended_action": "המלצה בעברית"\n' +
        '}';

    const P_NARRATIVE_CLASS =
        'You are a Narrative Intelligence Classifier.\n' +
        'Your job is to classify the TRUE INTENT of the content.\n\n' +
        'You must distinguish between:\n' +
        '1. REAL MISINFORMATION — false claims presented as truth to deceive\n' +
        '2. SATIRE / PARODY / HUMOR — intentionally absurd or comedic content\n' +
        '3. FICTION / ENTERTAINMENT — creative or dramatic content\n' +
        '4. FACTUAL CONTENT — genuine reporting or information\n' +
        '5. PROPAGANDA — intentional manipulation to influence beliefs\n\n' +
        'CRITICAL RULES:\n' +
        '- Do NOT classify as misinformation if:\n' +
        '  • The content contains absurd or unrealistic elements\n' +
        '  • The tone is humorous, exaggerated, or ironic\n' +
        '  • The narrative resembles parody or satire\n' +
        '- If absurd elements are present → Strongly consider SATIRE or FICTION\n' +
        '- Only classify as PROPAGANDA if there is a clear attempt to influence beliefs AND the content appears realistic and deceptive\n' +
        '- Only classify as MISINFORMATION if the false claims are presented seriously with no humor signals\n\n' +
        'OUTPUT (STRICT JSON ONLY):\n' +
        '{\n' +
        '  "narrative_class": "Satire | Propaganda | Misinformation | Fiction | Factual",\n' +
        '  "confidence": 0,\n' +
        '  "reasoning": "Based ONLY on input signals",\n' +
        '  "absurdity_detected": false,\n' +
        '  "humor_signals": [],\n' +
        '  "risk_override": false\n' +
        '}';

    const P_UI_ADAPTER =
        'You are a UI text generator.\n' +
        'Your ONLY job: write a short Hebrew summary of the analysis.\n\n' +
        'STRICT RULES:\n' +
        '- Do NOT produce scores, percentages, or metrics\n' +
        '- Do NOT produce tags, flags, or labels\n' +
        '- Do NOT estimate reliability, risk, confidence\n' +
        '- ONLY produce a ui_summary text in HEBREW\n' +
        '- 2-3 sentences maximum\n' +
        '- If content is satire → explain it neutrally, do not alarm\n' +
        '- Base summary ONLY on the input analysis\n\n' +
        'OUTPUT (STRICT JSON ONLY):\n' +
        '{\n' +
        '  "ui_summary": "סיכום בעברית — 2-3 משפטים"\n' +
        '}';

    const P_QUESTIONS =
        'You are analyzing a video. Below is all extracted data.\n' +
        'Generate 5-10 investigative questions that will help understand the content better.\n' +
        'Focus on:\n' +
        '- Unclear or ambiguous elements\n' +
        '- Possible contradictions\n' +
        '- Missing context\n' +
        '- Visual anomalies\n' +
        '- Claims that need verification\n' +
        'Return JSON array: ["question1", "question2", ...]';

    const P_SUMMARY =
        'Summarize the content of this video based on all collected data below.\n' +
        'Focus ONLY on:\n' +
        '- What is happening\n' +
        '- Key elements and objects\n' +
        '- People and their actions\n' +
        '- Text/speech content\n' +
        'NO assumptions. NO judgments. Keep it factual and structured.\n' +
        'Write in the main language of the content.';



    const P_VALIDATION =
        'You are a validation system.\n' +
        'Your job is to verify that the analysis is strictly grounded in the input.\n\n' +
        'RULES:\n' +
        '- Mark any claim that is not supported by input data\n' +
        '- Reduce confidence if unsupported claims are found\n' +
        '- Ensure no hallucinated facts exist\n\n' +
        'LANGUAGE: Write issues in HEBREW (עברית). Keep is_valid and corrected_confidence in English.\n\n' +
        'OUTPUT (STRICT JSON ONLY):\n' +
        '{\n' +
        '  "is_valid": true,\n' +
        '  "issues": ["בעיה בעברית 1"],\n' +
        '  "corrected_confidence": "Low | Medium | High"\n' +
        '}';

    const P_EVIDENCE_FILTER =
        'You are an evidence-based filtering system.\n' +
        'Your job is to STRICTLY remove or correct any claim that is not directly supported by the input data.\n\n' +
        'RULES:\n' +
        '- If a claim is not explicitly supported by the original data → REMOVE IT\n' +
        '- Do not rephrase unsupported claims — delete them\n' +
        '- Keep only verifiable statements that are grounded in input\n' +
        '- List every removed claim so the user can see what was filtered\n' +
        '- Provide a filtered assessment containing ONLY supported conclusions\n' +
        '- Provide filtered_findings containing ONLY evidence-backed findings\n\n' +
        'LANGUAGE RULES:\n' +
        '- Write filtered_assessment in HEBREW (עברית)\n' +
        '- Write filtered_findings in HEBREW (עברית) — short sentences\n' +
        '- Write removed_claims in HEBREW (עברית)\n' +
        '- Keep evidence_quality value in English\n\n' +
        'OUTPUT (STRICT JSON ONLY):\n' +
        '{\n' +
        '  "filtered_assessment": "מסקנה קצרה בעברית מבוססת ראיות בלבד",\n' +
        '  "filtered_findings": ["ממצא מאומת בעברית 1", "..."],\n' +
        '  "removed_claims": ["טענה שהוסרה בעברית 1", "..."],\n' +
        '  "evidence_quality": "Strong | Moderate | Weak | Insufficient"\n' +
        '}';

    // ── Helpers ──

    function _hf(token) {
        return { 'Authorization': 'Bearer ' + token };
    }

    async function _fetchWithTimeout(url, opts, timeoutMs = 120000) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const r = await fetch(url, { ...opts, signal: ctrl.signal });
            return r;
        } finally {
            clearTimeout(timer);
        }
    }

    // ── Token verification ──

    async function verifyToken(token) {
        const r = await _fetchWithTimeout('https://huggingface.co/api/whoami-v2', {
            headers: _hf(token),
        }, 15000);
        if (r.status === 200) {
            const data = await r.json();
            return { ok: true, name: data.name || data.fullname || 'User' };
        }
        return { ok: false, error: 'HTTP ' + r.status };
    }

    // ── Vision API (with model fallback) ──

    async function _apiVision(b64, prompt, token, maxTok) {
        maxTok = maxTok || 800;
        const errors = [];
        for (const model of VISION_MODELS) {
            const payload = {
                model: model,
                messages: [{ role: 'user', content: [
                    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
                    { type: 'text', text: prompt },
                ]}],
                max_tokens: maxTok,
            };
            try {
                const r = await _fetchWithTimeout(CHAT_URL, {
                    method: 'POST',
                    headers: { ..._hf(token), 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                if (r.status === 200) {
                    const data = await r.json();
                    const ch = data.choices || [];
                    return ch[0]?.message?.content || '';
                }
                const body = await r.text();
                errors.push(model + ': HTTP ' + r.status);
            } catch (e) {
                errors.push(model + ': ' + e.message);
            }
        }
        return 'ERROR: vision failed — ' + errors.slice(0, 3).join(' | ');
    }

    // ── Object Detection (DETR) ──

    async function _apiDetr(imgBytes, token) {
        try {
            const r = await _fetchWithTimeout(HF_INF + '/' + DETR, {
                method: 'POST',
                headers: { ..._hf(token), 'Content-Type': 'image/jpeg' },
                body: imgBytes,
            });
            if (r.status !== 200) return [];
            const data = await r.json();
            return (data || [])
                .filter(o => o && typeof o === 'object' && (o.score || 0) >= 0.5)
                .map(o => ({ label: o.label, score: Math.round(o.score * 1000) / 1000 }));
        } catch (e) {
            return [];
        }
    }

    // ── AI Image Classifier ──

    async function _apiAiClass(imgBytes, token) {
        try {
            const r = await _fetchWithTimeout(HF_INF + '/' + AI_CLASS, {
                method: 'POST',
                headers: { ..._hf(token), 'Content-Type': 'image/jpeg' },
                body: imgBytes,
            });
            if (r.status !== 200) return { error: 'HTTP ' + r.status };
            const data = await r.json();
            const result = { raw: data };
            const items = Array.isArray(data) && data.length && typeof data[0] === 'object' ? data :
                Array.isArray(data) && data.length && Array.isArray(data[0]) ? data[0] : [];
            for (const it of items) {
                const lbl = (it.label || '').toLowerCase();
                const sc = Math.round((it.score || 0) * 10000) / 10000;
                if (lbl.includes('ai') || lbl.includes('artificial')) result.ai_score = sc;
                else if (lbl.includes('human') || lbl.includes('real')) result.human_score = sc;
            }
            result.label = (result.ai_score || 0) > 0.5 ? 'ai_generated' : 'human';
            return result;
        } catch (e) {
            return { error: e.message };
        }
    }

    // ── Text Chat LLM ──

    async function _apiChat(prompt, token, system, maxTok) {
        system = system || 'You are a helpful assistant.';
        maxTok = maxTok || 1024;
        const payload = {
            model: TEXT_LLM,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: prompt },
            ],
            max_tokens: maxTok,
        };
        try {
            const r = await _fetchWithTimeout(CHAT_URL, {
                method: 'POST',
                headers: { ..._hf(token), 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }, 180000);
            if (r.status !== 200) return '';
            const data = await r.json();
            return data.choices?.[0]?.message?.content || '';
        } catch (e) {
            return '';
        }
    }

    function _parseJson(text) {
        if (!text) return {};
        // Try to extract JSON from markdown code blocks
        const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        const raw = m ? m[1].trim() : text.trim();
        try {
            return JSON.parse(raw);
        } catch (e) {
            // Try to find the first { ... } block
            const braceMatch = raw.match(/\{[\s\S]*\}/);
            if (braceMatch) {
                try { return JSON.parse(braceMatch[0]); } catch (_) {}
            }
            return {};
        }
    }

    // ── File to base64 and bytes ──

    function _fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result;
                resolve(dataUrl.split(',')[1]);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    function _fileToArrayBuffer(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(new Uint8Array(reader.result));
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });
    }

    async function _urlToDataAndBase64(url, token) {
        // For URL-based analysis, we skip fetching the image bytes
        // and instead pass the URL directly to the vision model.
        // This avoids CORS issues with arbitrary image URLs.
        return { bytes: null, b64: null, directUrl: url };
    }

    // ── Scoring (deterministic, matches backend _compute_scores) ──

    function _computeScores(output, aiStep, narrativeResult) {
        const narr = narrativeResult || {};
        const narrClass = narr.narrative_class || 'Unclear';
        const rawConf = narr.confidence || 0;
        const narrConf = rawConf <= 1 ? rawConf * 100 : rawConf;
        const absurdity = !!narr.absurdity_detected;

        let aiProb = 0;
        if (aiStep) {
            if (aiStep.ai_score != null) aiProb = Math.round(aiStep.ai_score * 100);
            else if (aiStep.label === 'ai_generated') aiProb = 75;
        }

        const isSatire = ['Satire', 'Fiction'].includes(narrClass) && narrConf >= 50;
        const isMisinfo = ['Misinformation', 'Propaganda'].includes(narrClass);
        const isFactual = narrClass === 'Factual';

        let truthScore, authScore, riskLevel, confLevel;

        if (isSatire) {
            truthScore = 0;
            authScore = aiProb > 50 ? 30 : 70;
            riskLevel = 'Low';
            confLevel = Math.max(narrConf, 60);
        } else if (isMisinfo) {
            truthScore = Math.max(5, 40 - narrConf / 2);
            authScore = aiProb > 50 ? 20 : 50;
            riskLevel = narrConf >= 70 ? 'High' : 'Medium';
            confLevel = narrConf;
        } else if (isFactual) {
            truthScore = Math.min(95, 65 + narrConf / 4);
            authScore = aiProb > 50 ? 40 : 85;
            riskLevel = 'Low';
            confLevel = Math.max(narrConf, 55);
        } else {
            truthScore = 50;
            authScore = aiProb > 50 ? 35 : 65;
            riskLevel = 'Medium';
            confLevel = Math.max(narrConf, 40);
        }

        return {
            truth_score: Math.round(truthScore),
            authenticity_score: Math.round(authScore),
            ai_probability: aiProb,
            narrative: narrClass,
            risk_level: riskLevel,
            confidence_level: Math.round(confLevel),
            satire_detected: isSatire,
            factual_mode: !isSatire,
            content_type: narrClass.toLowerCase(),
        };
    }

    // ── SHA-256 ──

    async function _sha256(bytes) {
        const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // ── Vision API with URL support ──

    async function _apiVisionUrl(imageUrl, prompt, token, maxTok) {
        maxTok = maxTok || 800;
        const errors = [];
        for (const model of VISION_MODELS) {
            const payload = {
                model: model,
                messages: [{ role: 'user', content: [
                    { type: 'image_url', image_url: { url: imageUrl } },
                    { type: 'text', text: prompt },
                ]}],
                max_tokens: maxTok,
            };
            try {
                const r = await _fetchWithTimeout(CHAT_URL, {
                    method: 'POST',
                    headers: { ..._hf(token), 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                if (r.status === 200) {
                    const data = await r.json();
                    const ch = data.choices || [];
                    return ch[0]?.message?.content || '';
                }
                errors.push(model + ': HTTP ' + r.status);
            } catch (e) {
                errors.push(model + ': ' + e.message);
            }
        }
        return 'ERROR: vision failed — ' + errors.slice(0, 3).join(' | ');
    }

    // ═══════════════════════════════════════════════════
    //  MAIN: analyzeImage — full pipeline in the browser
    // ═══════════════════════════════════════════════════

    async function analyzeImage(file, url, token, onProgress) {
        const t0 = Date.now();
        const prog = onProgress || (() => {});
        let b64 = null, imgBytes = null;
        const isUrlMode = !file && !!url;

        // ── Get image data ──
        if (file) {
            b64 = await _fileToBase64(file);
            imgBytes = await _fileToArrayBuffer(file);
        }

        const meta = {
            media_type: 'image',
            file_size_bytes: imgBytes ? imgBytes.length : 0,
            file_size_kb: imgBytes ? Math.round(imgBytes.length / 1024 * 10) / 10 : 0,
            sha256: imgBytes ? await _sha256(imgBytes) : '',
        };

        prog(10, 'שלב 1: חילוץ טקסט OCR...');

        // ── Vision calls: use base64 for files, URL for URLs ──
        const visionCall = isUrlMode
            ? (prompt) => _apiVisionUrl(url, prompt, token)
            : (prompt) => _apiVision(b64, prompt, token);

        // ── Run parallel ──
        const parallelTasks = [
            visionCall(P_OCR).then(r => { prog(20, 'שלב 2: תיאור תמונה...'); return r; }),
            visionCall(P_CAPTION).then(r => { prog(30, 'שלב 3: זיהוי אובייקטים...'); return r; }),
            // DETR & AI Classifier need raw bytes — only for file uploads
            imgBytes ? _apiDetr(imgBytes, token).then(r => { prog(35, 'שלב 4: בדיקת AI...'); return r; }) : Promise.resolve([]),
            visionCall(P_AI_VISION),
            imgBytes ? _apiAiClass(imgBytes, token) : Promise.resolve({ label: 'unknown', error: 'url_mode' }),
        ];

        const [ocrR, capR, objR, aivR, aicR] = await Promise.all(parallelTasks);

        prog(40, 'שלב 5: סיווג נרטיב...');

        const ocrText = (ocrR && !ocrR.includes('NO_TEXT')) ? ocrR : '';

        const output = {
            speech_text: '',
            ocr_text: ocrText,
            merged_text: ocrText,
            frames: [{
                timestamp: '00:00',
                caption: capR,
                objects: objR.filter(d => d.label).map(d => d.label),
                ai_detection: [aivR, aicR],
            }],
            questions: [],
            answers: [],
            summary: '',
        };

        const pipeline = [
            { step: 3, name: 'ocr_extraction', model: VISION_MODELS[0], full_text: ocrText },
            { step: 5, name: 'image_captioning', model: VISION_MODELS[0] },
            { step: 4, name: 'object_detection', model: DETR, unique_objects: objR },
            { step: 6, name: 'ai_detection', models: [VISION_MODELS[0], AI_CLASS] },
        ];

        // ── Narrative Classification ──
        const narrPrompt =
            'Analyze the following content data:\n\n' +
            'OCR Text: ' + (ocrText || '(none)') + '\n' +
            'Caption: ' + capR + '\n' +
            'Objects: ' + objR.map(d => d.label).join(', ') + '\n' +
            'AI Vision: ' + aivR + '\n\n' +
            P_NARRATIVE_CLASS;

        const narrRaw = await _apiChat(narrPrompt, token, 'You are a Narrative Intelligence Classifier.', 512);
        const narrativeResult = _parseJson(narrRaw);

        prog(50, 'שלב 6: ניתוח מודיעיני...');

        // ── Scoring ──
        const scores = _computeScores(output, aicR, narrativeResult);

        // ── Intelligence Analysis ──
        const intelPrompt =
            'Analyze the following media content:\n\n' +
            '== META ==\nType: image\nSize: ' + meta.file_size_kb + ' KB\n\n' +
            '== OCR TEXT ==\n' + (ocrText || '(no text found)') + '\n\n' +
            '== IMAGE DESCRIPTION ==\n' + capR + '\n\n' +
            '== OBJECTS DETECTED ==\n' + objR.map(d => d.label + ' (' + d.score + ')').join(', ') + '\n\n' +
            '== AI DETECTION ==\nVision: ' + aivR + '\nClassifier: ' + JSON.stringify(aicR) + '\n\n' +
            '== NARRATIVE CLASS ==\n' + (narrativeResult.narrative_class || 'Unclear') + ' (confidence: ' + (narrativeResult.confidence || 0) + ')\n\n' +
            P_INTELLIGENCE;

        const intelRaw = await _apiChat(intelPrompt, token, 'You are a senior intelligence analyst.', 1500);
        const intelligence = _parseJson(intelRaw);

        // ── Validation ──
        prog(70, 'אימות תוצאות...');
        const validPrompt =
            'INPUT DATA (original):\n' +
            'OCR: ' + (ocrText || '(none)').slice(0, 300) + '\n' +
            'Caption: ' + capR.slice(0, 300) + '\n\n' +
            'ANALYSIS OUTPUT:\n' +
            JSON.stringify({ intelligence, narrative: narrativeResult, scores }).slice(0, 1500) + '\n\n' +
            P_VALIDATION;
        const validRaw = await _apiChat(validPrompt, token, 'You are a validation system.', 512);
        const validation = _parseJson(validRaw);
        if (!validation.is_valid && validation.is_valid !== false) validation.is_valid = true;
        if (!validation.issues) validation.issues = [];

        // ── Evidence Filter ──
        prog(78, 'סינון ראיות...');
        const evFilterPrompt =
            'ORIGINAL DATA:\n' +
            'OCR: ' + (ocrText || '(none)').slice(0, 300) + '\n' +
            'Caption: ' + capR.slice(0, 300) + '\n\n' +
            'ANALYSIS:\n' +
            JSON.stringify({ intelligence, narrative: narrativeResult }).slice(0, 1000) + '\n\n' +
            'VALIDATION ISSUES:\n' + JSON.stringify(validation.issues) + '\n\n' +
            P_EVIDENCE_FILTER;
        const evFilterRaw = await _apiChat(evFilterPrompt, token, 'You are an evidence filter system.', 800);
        const evidenceFilter = _parseJson(evFilterRaw);

        // ── UI Adapter ──
        prog(83, 'עיבוד סופי...');
        const uiPrompt =
            'Based on the following IMAGE analysis, produce the final UI output.\n\n' +
            '== IMAGE DESCRIPTION ==\n' + capR + '\n' +
            '== OCR TEXT ==\n' + (ocrText || '(none)') + '\n' +
            '== INTELLIGENCE ==\n' + JSON.stringify(intelligence).slice(0, 500) + '\n' +
            '== NARRATIVE ==\n' + JSON.stringify(narrativeResult).slice(0, 300) + '\n' +
            '== EVIDENCE FILTER ==\n' + JSON.stringify(evidenceFilter).slice(0, 300) + '\n\n' +
            P_UI_ADAPTER;

        const uiRaw = await _apiChat(uiPrompt, token, 'You are a UI output generator.', 600);
        const uiParsed = _parseJson(uiRaw);

        const uiData = {
            ui_metrics: {
                truth_score: scores.truth_score,
                authenticity_score: scores.authenticity_score,
                ai_probability: scores.ai_probability,
                narrative: scores.narrative,
                risk_level: scores.risk_level,
                confidence_level: scores.confidence_level,
            },
            content_type: scores.content_type,
            factual_mode: scores.factual_mode,
            satire_detected: scores.satire_detected,
            ui_summary: uiParsed.ui_summary || intelligence.final_assessment || '',
            ui_tags: uiParsed.ui_tags || [scores.content_type],
            ui_flags: uiParsed.ui_flags || [],
            verified_findings: evidenceFilter.filtered_findings || intelligence.key_findings || [],
            removed_claims: evidenceFilter.removed_claims || [],
            evidence_quality: evidenceFilter.evidence_quality || 'Moderate',
            humor_signals: narrativeResult.humor_signals || [],
        };

        prog(90, 'סיום...');

        const totalMs = Date.now() - t0;

        return {
            status: 'ok',
            meta: meta,
            pipeline: pipeline,
            output: output,
            scores: scores,
            narrative: narrativeResult,
            intelligence: intelligence,
            validation: validation,
            evidence_filter: evidenceFilter,
            ui_data: uiData,
            consistency: {
                ...scores,
                ui_summary: uiData.ui_summary,
                ui_tags: uiData.ui_tags,
                satire_detected: scores.satire_detected,
                narrative_class: scores.content_type,
                consistency_applied: true,
            },
            total_duration_ms: totalMs,
        };
    }

    // ═══════════════════════════════════════════════════
    //  WHISPER — Speech-to-Text API
    // ═══════════════════════════════════════════════════

    async function _apiWhisper(audioBytes, token) {
        try {
            const r = await _fetchWithTimeout(HF_INF + '/' + WHISPER, {
                method: 'POST',
                headers: { ..._hf(token), 'Content-Type': 'audio/flac' },
                body: audioBytes,
            }, 180000);
            if (r.status !== 200) {
                // Try WAV fallback
                const r2 = await _fetchWithTimeout(HF_INF + '/' + WHISPER, {
                    method: 'POST',
                    headers: { ..._hf(token), 'Content-Type': 'audio/wav' },
                    body: audioBytes,
                }, 180000);
                if (r2.status !== 200) return { error: 'HTTP ' + r.status + '/' + r2.status, text: '' };
                return await r2.json();
            }
            return await r.json();
        } catch (e) {
            return { error: e.message, text: '' };
        }
    }

    // ═══════════════════════════════════════════════════
    //  FFMPEG.WASM — Video Decomposition in browser
    // ═══════════════════════════════════════════════════

    let _ffmpeg = null;

    async function _loadFFmpeg(prog) {
        if (_ffmpeg) return _ffmpeg;
        prog(2, 'טוען FFmpeg לדפדפן...');

        // Load ffmpeg.wasm from CDN
        if (!window.FFmpeg) {
            await new Promise((resolve, reject) => {
                const s1 = document.createElement('script');
                s1.src = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.min.js';
                s1.onload = resolve;
                s1.onerror = reject;
                document.head.appendChild(s1);
            });
        }

        const { FFmpeg } = window.FFmpegWASM || window;
        const ffmpeg = new FFmpeg();

        // Load core from CDN
        await ffmpeg.load({
            coreURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js',
            wasmURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm',
        });

        _ffmpeg = ffmpeg;
        return ffmpeg;
    }

    async function _decomposeVideo(videoFile, token, prog) {
        let ffmpeg;
        try {
            ffmpeg = await _loadFFmpeg(prog);
        } catch (e) {
            prog(5, 'FFmpeg לא זמין - חילוץ פריים מהווידאו...');
            return await _fallbackDecompose(videoFile, prog);
        }

        const videoBytes = await _fileToArrayBuffer(videoFile);
        const inputName = 'input.mp4';
        await ffmpeg.writeFile(inputName, videoBytes);

        prog(8, 'מחלץ מידע מהווידאו...');

        // Get duration via a quick probe
        let duration = 30;

        // Extract frames at 1fps
        prog(10, 'מחלץ פריימים מהווידאו...');
        try {
            await ffmpeg.exec([
                '-i', inputName,
                '-vf', 'fps=1',
                '-q:v', '3',
                'frame_%04d.jpg'
            ]);
        } catch (e) {
            prog(10, 'שגיאה בחילוץ פריימים, מנסה חלופה...');
            return await _fallbackDecompose(videoFile, prog);
        }

        // Collect ALL frames
        const frames = [];
        for (let i = 1; i <= 300; i++) {
            const fname = 'frame_' + String(i).padStart(4, '0') + '.jpg';
            try {
                const data = await ffmpeg.readFile(fname);
                if (data && data.length > 100) {
                    frames.push({ time: i - 1, data: data });
                }
            } catch (_) {
                break;
            }
        }

        if (frames.length === 0) {
            return await _fallbackDecompose(videoFile, prog);
        }

        duration = frames.length;

        // Extract audio to FLAC 16kHz mono
        prog(15, 'מחלץ אודיו...');
        let audioData = null;
        let audioSegments = [];
        try {
            await ffmpeg.exec([
                '-i', inputName,
                '-vn', '-acodec', 'flac',
                '-ar', '16000', '-ac', '1',
                'audio.flac'
            ]);
            audioData = await ffmpeg.readFile('audio.flac');
            if (audioData && audioData.length < 500) {
                audioData = null;
            }
        } catch (_) {
            audioData = null;
        }

        // Segment audio into 15-second chunks for Whisper
        if (audioData && audioData.length > 500) {
            prog(17, 'מפצל אודיו למקטעים...');
            try {
                await ffmpeg.exec([
                    '-i', 'audio.flac',
                    '-f', 'segment',
                    '-segment_time', '15',
                    '-ar', '16000', '-ac', '1',
                    '-c:a', 'flac',
                    'seg_%03d.flac'
                ]);
                // Collect segments
                for (let i = 0; i < 20; i++) {
                    const segName = 'seg_' + String(i).padStart(3, '0') + '.flac';
                    try {
                        const segData = await ffmpeg.readFile(segName);
                        if (segData && segData.length > 200) {
                            audioSegments.push(segData);
                        }
                    } catch (_) {
                        break;
                    }
                }
            } catch (_) {
                // If segmentation fails, use the whole audio as one segment
                if (audioData) audioSegments = [audioData];
            }
            // If no segments collected but we have full audio, use it
            if (audioSegments.length === 0 && audioData) {
                audioSegments = [audioData];
            }
        }

        // Smart frame selection — same as backend
        const interval = duration <= 30 ? 2 : duration <= 120 ? 3 : 4;
        const timeBased = [];
        for (let t = 0; t < duration; t += interval) timeBased.push(t);
        const allTimes = [...new Set(timeBased)].sort((a, b) => a - b);
        // Deduplicate: keep at least 1s apart
        const selectedTimes = [];
        for (const t of allTimes) {
            if (t >= duration) break;
            if (selectedTimes.length === 0 || t - selectedTimes[selectedTimes.length - 1] >= 1.0) {
                selectedTimes.push(t);
            }
        }
        // Cap at 20 frames for API efficiency
        if (selectedTimes.length > 20) selectedTimes.length = 20;

        const selected = selectedTimes.map(t => {
            const closest = frames.reduce((best, f) => Math.abs(f.time - t) < Math.abs(best.time - t) ? f : best, frames[0]);
            return closest;
        });

        // Cleanup
        try {
            await ffmpeg.deleteFile(inputName).catch(() => {});
            for (let i = 1; i <= frames.length; i++) {
                await ffmpeg.deleteFile('frame_' + String(i).padStart(4, '0') + '.jpg').catch(() => {});
            }
            if (audioData) await ffmpeg.deleteFile('audio.flac').catch(() => {});
            for (let i = 0; i < audioSegments.length; i++) {
                await ffmpeg.deleteFile('seg_' + String(i).padStart(3, '0') + '.flac').catch(() => {});
            }
        } catch (_) {}

        return {
            duration: duration,
            hasAudio: !!audioData,
            audioData: audioData,
            audioSegments: audioSegments,
            allFrames: frames,
            selectedFrames: selected,
            selectedTimes: selectedTimes,
        };
    }

    // Fallback: extract a single frame using <video> + <canvas>
    async function _fallbackDecompose(videoFile, prog) {
        return new Promise((resolve) => {
            const url = URL.createObjectURL(videoFile);
            const video = document.createElement('video');
            video.muted = true;
            video.preload = 'auto';

            const frames = [];
            let duration = 0;

            video.onloadedmetadata = () => {
                duration = Math.floor(video.duration) || 10;
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                let idx = 0;
                const interval = duration <= 30 ? 2 : duration <= 120 ? 3 : 4;
                const times = [];
                for (let t = 0; t < duration; t += interval) times.push(t);
                if (times.length === 0) times.push(0);
                if (times.length > 15) times.length = 15;

                function grabNext() {
                    if (idx >= times.length) {
                        URL.revokeObjectURL(url);
                        resolve({
                            duration: duration,
                            hasAudio: false,
                            audioData: null,
                            allFrames: frames,
                            selectedFrames: frames,
                        });
                        return;
                    }
                    video.currentTime = times[idx];
                }

                video.onseeked = () => {
                    canvas.width = video.videoWidth || 640;
                    canvas.height = video.videoHeight || 480;
                    ctx.drawImage(video, 0, 0);
                    canvas.toBlob((blob) => {
                        if (blob) {
                            blob.arrayBuffer().then(buf => {
                                frames.push({ time: times[idx], data: new Uint8Array(buf) });
                                prog(10 + Math.round(idx / times.length * 10), 'מחלץ פריים ' + (idx + 1) + '/' + times.length + '...');
                                idx++;
                                grabNext();
                            });
                        } else {
                            idx++;
                            grabNext();
                        }
                    }, 'image/jpeg', 0.85);
                };

                grabNext();
            };

            video.onerror = () => {
                URL.revokeObjectURL(url);
                resolve({ duration: 0, hasAudio: false, audioData: null, allFrames: [], selectedFrames: [] });
            };

            video.src = url;
        });
    }

    // ═══════════════════════════════════════════════════
    //  MAIN: analyzeVideo — full video pipeline in browser
    // ═══════════════════════════════════════════════════

    async function analyzeVideo(file, token, onProgress) {
        const t0 = Date.now();
        const prog = onProgress || (() => {});
        const videoBytes = await _fileToArrayBuffer(file);
        const hash = await _sha256(videoBytes);

        prog(3, 'שלב 1: פירוק וידאו...');

        // ═══ Step 1: Decompose ═══
        const decomp = await _decomposeVideo(file, token, prog);

        if (decomp.selectedFrames.length === 0) {
            throw new Error('לא הצלחתי לחלץ פריימים מהווידאו');
        }

        const meta = {
            media_type: 'video',
            file_size_bytes: videoBytes.length,
            file_size_kb: Math.round(videoBytes.length / 1024 * 10) / 10,
            sha256: hash,
            duration_sec: decomp.duration,
            frames_extracted: decomp.allFrames.length,
            audio_extracted: decomp.hasAudio,
            audio_segments: (decomp.audioSegments || []).length,
        };

        // ═══ Step 2: Speech Transcription (segment-by-segment) ═══
        let speechText = '';
        const speechSegments = [];
        if (decomp.hasAudio && (decomp.audioSegments || []).length > 0) {
            prog(20, 'שלב 2: תמלול דיבור (Whisper)...');
            const segs = decomp.audioSegments;
            for (let si = 0; si < segs.length; si++) {
                prog(20 + Math.round(si / segs.length * 5),
                    'תמלול מקטע אודיו ' + (si + 1) + '/' + segs.length + '...');
                const wResult = await _apiWhisper(segs[si], token);
                const segText = (wResult.text || '').trim();
                speechSegments.push({
                    index: si,
                    input: 'Audio segment ' + si + ' (' + Math.round(segs[si].length / 1024) + 'KB)',
                    model: WHISPER,
                    result: segText,
                    status: segText ? 'ok' : 'empty',
                });
                if (segText) speechText += (speechText ? ' ' : '') + segText;
            }
        } else if (decomp.hasAudio && decomp.audioData) {
            // Single full audio fallback
            prog(20, 'שלב 2: תמלול דיבור...');
            const wResult = await _apiWhisper(decomp.audioData, token);
            speechText = (wResult.text || '').trim();
            speechSegments.push({ index: 0, result: speechText, status: speechText ? 'ok' : 'empty' });
        } else {
            prog(20, 'שלב 2: אין אודיו — דולג...');
        }

        // ═══ Steps 3-6: Process frames (parallel per batch) ═══
        prog(25, 'שלב 3-6: ניתוח פריימים...');
        const frameResults = [];
        const batchSize = 3;
        const selectedFrames = decomp.selectedFrames;

        for (let i = 0; i < selectedFrames.length; i += batchSize) {
            const batch = selectedFrames.slice(i, i + batchSize);
            const pct = 25 + Math.round((i / selectedFrames.length) * 30);
            prog(pct, 'מנתח פריים ' + (i + 1) + '-' + Math.min(i + batchSize, selectedFrames.length) + '/' + selectedFrames.length + '...');

            const batchResults = await Promise.all(batch.map(async (frame) => {
                const b64 = _uint8ToBase64(frame.data);
                const [ocr, caption, objects, aiVis] = await Promise.all([
                    _apiVision(b64, P_OCR, token),
                    _apiVision(b64, P_CAPTION, token),
                    _apiDetr(frame.data, token),
                    _apiVision(b64, P_AI_VISION, token),
                ]);
                return {
                    time: frame.time,
                    ocr: (ocr && !ocr.includes('NO_TEXT')) ? ocr : '',
                    caption: caption,
                    objects: objects,
                    aiVision: aiVis,
                };
            }));
            frameResults.push(...batchResults);
        }

        // AI Classifier on first + middle frame (dual like backend)
        prog(56, 'בדיקת AI על פריימים מרכזיים...');
        const aiClassFrames = [];
        const firstFrame = selectedFrames[0];
        const midIdx = Math.floor(selectedFrames.length / 2);
        const midFrame = selectedFrames[midIdx];
        const framesToClassify = [
            { frame: firstFrame, index: 0 },
            { frame: midFrame, index: midIdx },
        ];
        for (const fc of framesToClassify) {
            const cls = await _apiAiClass(fc.frame.data, token);
            aiClassFrames.push({ frame_index: fc.index, ...cls });
        }
        // Use first-frame classifier as primary AI result
        const aiClassResult = aiClassFrames[0] || { label: 'unknown' };

        // ═══ Step 7: Text Merge (local, no API) ═══
        prog(58, 'שלב 7: מיזוג טקסטים...');
        const allOcr = frameResults.map(f => f.ocr).filter(Boolean).join('\n');
        const allCaptions = frameResults.map(f => f.caption).filter(Boolean).join('\n');
        const allObjects = [];
        const seenLabels = new Set();
        for (const f of frameResults) {
            for (const o of f.objects) {
                if (!seenLabels.has(o.label)) {
                    seenLabels.add(o.label);
                    allObjects.push(o);
                }
            }
        }
        // Build merged text exactly like backend step7_text_merge
        let mergedText = '';
        if (speechText) mergedText += '[דיבור] ' + speechText + '\n\n';
        if (allOcr) mergedText += '[OCR] ' + allOcr + '\n\n';
        if (allCaptions) mergedText += '[תיאורים] ' + allCaptions;
        mergedText = mergedText.trim();

        // ═══ Step 8: Investigative Questions ═══
        prog(60, 'שלב 8: שאלות חקירה...');
        const questionsPrompt =
            'VIDEO DATA:\n' +
            mergedText.slice(0, 3000) + '\n\n' +
            'DETECTED OBJECTS: ' + allObjects.map(o => o.label).join(', ') + '\n\n' +
            'Generate 5-10 investigative questions.';
        const questionsRaw = await _apiChat(questionsPrompt, token, P_QUESTIONS, 800);
        let questions = [];
        try {
            const parsed = _parseJson(questionsRaw);
            questions = Array.isArray(parsed) ? parsed :
                        Array.isArray(parsed.questions) ? parsed.questions :
                        questionsRaw.split('\n').filter(l => l.trim().length > 10).slice(0, 10);
        } catch (_) {
            questions = questionsRaw.split('\n').filter(l => l.trim().length > 10).slice(0, 10);
        }

        // ═══ Step 9: Frame Reinvestigation ═══
        prog(65, 'שלב 9: חקירת פריימים לפי שאלות...');
        const answers = [];
        if (questions.length > 0 && selectedFrames.length > 0) {
            const nFrames = selectedFrames.length;
            for (let qi = 0; qi < questions.length; qi++) {
                const q = typeof questions[qi] === 'string' ? questions[qi] : questions[qi]?.question || String(questions[qi]);
                const fidx = (qi * nFrames) % nFrames;
                const frame = selectedFrames[fidx % selectedFrames.length];
                const b64 = _uint8ToBase64(frame.data);
                const ansPrompt = 'Look at this image and answer: ' + q;
                const ansText = await _apiVision(b64, ansPrompt, token, 600);
                answers.push({
                    question: q,
                    frame_index: fidx,
                    timestamp: _formatTime(frame.time),
                    model: VISION_MODELS[0],
                    response: ansText,
                });
                prog(65 + Math.round((qi / questions.length) * 5),
                    'חוקר שאלה ' + (qi + 1) + '/' + questions.length + '...');
            }
        }

        // ═══ Step 11: Summary ═══
        prog(72, 'שלב 11: סיכום תוכן...');
        let qaSection = '';
        for (const a of answers) {
            qaSection += 'Q: ' + a.question + '\nA: ' + (a.response || '').slice(0, 200) + '\n\n';
        }
        const summaryPrompt =
            'MERGED TEXT:\n' + mergedText.slice(0, 2000) + '\n\n' +
            'OBJECTS: ' + allObjects.map(o => o.label).join(', ') + '\n\n' +
            'INVESTIGATION Q&A:\n' + qaSection.slice(0, 1500) + '\n\n' +
            'Write a factual summary.';
        const summaryRaw = await _apiChat(summaryPrompt, token, P_SUMMARY, 1200);
        const summaryText = summaryRaw.trim();

        // Build output structure matching backend
        const output = {
            speech_text: speechText,
            ocr_text: allOcr,
            merged_text: mergedText,
            frames: frameResults.map(f => ({
                timestamp: _formatTime(f.time),
                time_sec: f.time,
                ocr: f.ocr || undefined,
                caption: f.caption,
                objects: f.objects.map(o => o.label),
                ai_detection: [f.aiVision],
            })),
            questions: questions.map(q => typeof q === 'string' ? q : q?.question || String(q)),
            answers: answers,
            summary: summaryText,
        };

        const pipeline = [
            { step: 1, name: 'decompose', duration_ms: 0 },
            { step: 2, name: 'speech_transcription', model: WHISPER, segments: speechSegments, full_text: speechText },
            { step: 3, name: 'ocr_extraction', model: VISION_MODELS[0], full_text: allOcr },
            { step: 4, name: 'object_detection', model: DETR, unique_objects: allObjects },
            { step: 5, name: 'image_captioning', model: VISION_MODELS[0] },
            { step: 6, name: 'ai_detection', models: [VISION_MODELS[0], AI_CLASS], frames: aiClassFrames },
            { step: 7, name: 'text_merge', speech_text: speechText, ocr_text: allOcr, captions_text: allCaptions, merged_text: mergedText },
            { step: 8, name: 'investigative_questions', model: TEXT_LLM, questions: output.questions },
            { step: 9, name: 'frame_reinvestigation', answers: answers },
            { step: 11, name: 'summary', model: TEXT_LLM, summary_text: summaryText },
        ];

        // ═══ Narrative Classification ═══
        prog(76, 'סיווג נרטיב...');
        const narrPrompt =
            'Analyze the following VIDEO content data:\n\n' +
            'Speech Text: ' + (speechText || '(none)') + '\n' +
            'OCR Text: ' + (allOcr || '(none)') + '\n' +
            'Frame Descriptions: ' + allCaptions.slice(0, 1000) + '\n' +
            'Summary: ' + summaryText.slice(0, 500) + '\n' +
            'Objects: ' + allObjects.map(o => o.label).join(', ') + '\n' +
            'Investigation Q&A:\n' + qaSection.slice(0, 500) + '\n\n' +
            P_NARRATIVE_CLASS;
        const narrRaw = await _apiChat(narrPrompt, token, 'You are a Narrative Intelligence Classifier.', 512);
        const narrativeResult = _parseJson(narrRaw);

        // ═══ Scoring ═══
        const scores = _computeScores(output, aiClassResult, narrativeResult);

        // ═══ Intelligence Analysis ═══
        prog(80, 'ניתוח מודיעיני...');
        const intelPrompt =
            'Analyze the following VIDEO content:\n\n' +
            '== META ==\nType: video\nDuration: ' + decomp.duration + 's\nFrames: ' + decomp.allFrames.length + '\nSize: ' + meta.file_size_kb + ' KB\n\n' +
            '== SPEECH TEXT ==\n' + (speechText || '(no speech found)') + '\n\n' +
            '== OCR TEXT ==\n' + (allOcr || '(no text found)') + '\n\n' +
            '== SUMMARY ==\n' + summaryText.slice(0, 500) + '\n\n' +
            '== FRAME DESCRIPTIONS ==\n' + allCaptions.slice(0, 1000) + '\n\n' +
            '== OBJECTS DETECTED ==\n' + allObjects.map(o => o.label + ' (' + o.score + ')').join(', ') + '\n\n' +
            '== AI DETECTION ==\nClassifier: ' + JSON.stringify(aiClassResult) + '\n\n' +
            '== NARRATIVE CLASS ==\n' + (narrativeResult.narrative_class || 'Unclear') + ' (confidence: ' + (narrativeResult.confidence || 0) + ')\n\n' +
            '== INVESTIGATION Q&A ==\n' + qaSection.slice(0, 800) + '\n\n' +
            P_INTELLIGENCE;
        const intelRaw = await _apiChat(intelPrompt, token, 'You are a senior intelligence analyst.', 1500);
        const intelligence = _parseJson(intelRaw);

        // ═══ Validation ═══
        prog(85, 'אימות תוצאות...');
        const validPrompt =
            'INPUT DATA (original):\n' +
            'Speech: ' + (speechText || '(none)').slice(0, 300) + '\n' +
            'OCR: ' + (allOcr || '(none)').slice(0, 300) + '\n' +
            'Summary: ' + summaryText.slice(0, 300) + '\n\n' +
            'ANALYSIS OUTPUT:\n' +
            JSON.stringify({ intelligence, narrative: narrativeResult, scores }).slice(0, 1500) + '\n\n' +
            P_VALIDATION;
        const validRaw = await _apiChat(validPrompt, token, 'You are a validation system.', 512);
        const validation = _parseJson(validRaw);
        if (!validation.is_valid && validation.is_valid !== false) validation.is_valid = true;
        if (!validation.issues) validation.issues = [];

        // ═══ Evidence Filter ═══
        prog(89, 'סינון ראיות...');
        const evFilterPrompt =
            'ORIGINAL DATA:\n' +
            'Speech: ' + (speechText || '(none)').slice(0, 300) + '\n' +
            'OCR: ' + (allOcr || '(none)').slice(0, 300) + '\n' +
            'Summary: ' + summaryText.slice(0, 300) + '\n\n' +
            'ANALYSIS:\n' +
            JSON.stringify({ intelligence: intelligence, narrative: narrativeResult }).slice(0, 1000) + '\n\n' +
            'VALIDATION ISSUES:\n' + JSON.stringify(validation.issues) + '\n\n' +
            P_EVIDENCE_FILTER;
        const evFilterRaw = await _apiChat(evFilterPrompt, token, 'You are an evidence filter system.', 800);
        const evidenceFilter = _parseJson(evFilterRaw);

        // ═══ UI Adapter ═══
        prog(92, 'עיבוד סופי...');
        const uiPrompt =
            'Based on the following VIDEO analysis, produce the final UI output.\n\n' +
            '== SPEECH ==\n' + (speechText || '(none)').slice(0, 500) + '\n' +
            '== SUMMARY ==\n' + summaryText.slice(0, 500) + '\n' +
            '== INTELLIGENCE ==\n' + JSON.stringify(intelligence).slice(0, 500) + '\n' +
            '== NARRATIVE ==\n' + JSON.stringify(narrativeResult).slice(0, 300) + '\n' +
            '== EVIDENCE FILTER ==\n' + JSON.stringify(evidenceFilter).slice(0, 300) + '\n\n' +
            P_UI_ADAPTER;
        const uiRaw = await _apiChat(uiPrompt, token, 'You are a UI output generator.', 600);
        const uiParsed = _parseJson(uiRaw);

        // Build complete ui_data with system-computed scores
        const uiData = {
            ui_metrics: {
                truth_score: scores.truth_score,
                authenticity_score: scores.authenticity_score,
                ai_probability: scores.ai_probability,
                narrative: scores.narrative,
                risk_level: scores.risk_level,
                confidence_level: scores.confidence_level,
            },
            content_type: scores.content_type,
            factual_mode: scores.factual_mode,
            satire_detected: scores.satire_detected,
            ui_summary: uiParsed.ui_summary || intelligence.final_assessment || '',
            ui_tags: uiParsed.ui_tags || [scores.content_type],
            ui_flags: uiParsed.ui_flags || [],
            verified_findings: evidenceFilter.filtered_findings || intelligence.key_findings || [],
            removed_claims: evidenceFilter.removed_claims || [],
            evidence_quality: evidenceFilter.evidence_quality || 'Moderate',
            humor_signals: narrativeResult.humor_signals || [],
        };

        prog(95, 'סיום...');
        const totalMs = Date.now() - t0;

        return {
            status: 'ok',
            meta: meta,
            pipeline: pipeline,
            output: output,
            scores: scores,
            narrative: narrativeResult,
            intelligence: intelligence,
            validation: validation,
            evidence_filter: evidenceFilter,
            ui_data: uiData,
            consistency: {
                ...scores,
                ui_summary: uiData.ui_summary,
                ui_tags: uiData.ui_tags,
                satire_detected: scores.satire_detected,
                narrative_class: scores.content_type,
                consistency_applied: true,
            },
            total_duration_ms: totalMs,
        };
    }

    // ── Uint8Array to base64 ──
    function _uint8ToBase64(u8) {
        let binary = '';
        const chunkSize = 32768;
        for (let i = 0; i < u8.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }

    // ── Format seconds to MM:SS ──
    function _formatTime(sec) {
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }

    // ── Public API ──
    return {
        verifyToken,
        analyzeImage,
        analyzeVideo,
        isFFmpegLoaded: () => !!_ffmpeg,
    };

})();
