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
        'Your ONLY job: produce a complete analysis summary JSON.\n\n' +
        'OUTPUT (STRICT JSON ONLY):\n' +
        '{\n' +
        '  "ui_summary": "סיכום בעברית — 2-3 משפטים",\n' +
        '  "ui_tags": ["tag1", "tag2"],\n' +
        '  "ui_flags": ["warning flag if any"],\n' +
        '  "verified_findings": ["ממצא מאומת 1"],\n' +
        '  "removed_claims": ["טענה שהוסרה 1"],\n' +
        '  "ui_metrics": {\n' +
        '    "truth_score": 0,\n' +
        '    "authenticity_score": 0,\n' +
        '    "ai_probability": 0,\n' +
        '    "narrative": "Factual",\n' +
        '    "risk_level": "Low",\n' +
        '    "confidence_level": 0\n' +
        '  }\n' +
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
        const narrConf = narr.confidence || 0;
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

        prog(65, 'שלב 7: עיבוד סופי...');

        // ── UI Adapter (final summary) ──
        const uiPrompt =
            'Based on the following analysis, produce the final UI output JSON.\n\n' +
            '== IMAGE DESCRIPTION ==\n' + capR + '\n' +
            '== OCR TEXT ==\n' + (ocrText || '(none)') + '\n' +
            '== INTELLIGENCE ==\n' + JSON.stringify(intelligence) + '\n' +
            '== NARRATIVE ==\n' + JSON.stringify(narrativeResult) + '\n' +
            '== SCORES (system computed) ==\n' + JSON.stringify(scores) + '\n\n' +
            'IMPORTANT: The ui_metrics values MUST use the scores provided above exactly. Do NOT change them.\n' +
            'Your ONLY creative job is the ui_summary text (Hebrew, 2-3 sentences), ui_tags, ui_flags, verified_findings, removed_claims.\n\n' +
            P_UI_ADAPTER;

        const uiRaw = await _apiChat(uiPrompt, token, 'You are a UI output generator.', 1200);
        const uiData = _parseJson(uiRaw);

        // Force system-computed scores into ui_data
        uiData.ui_metrics = {
            ...(uiData.ui_metrics || {}),
            truth_score: scores.truth_score,
            authenticity_score: scores.authenticity_score,
            ai_probability: scores.ai_probability,
            narrative: scores.narrative,
            risk_level: scores.risk_level,
            confidence_level: scores.confidence_level,
        };
        uiData.satire_detected = scores.satire_detected;
        uiData.factual_mode = scores.factual_mode;
        uiData.content_type = scores.content_type;

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
            research: {},
            validation: { is_valid: true, issues: [] },
            evidence_filter: {},
            ui_data: uiData,
            consistency: scores,
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
            if (r.status !== 200) return { error: 'HTTP ' + r.status, text: '' };
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
            // ffmpeg.wasm failed to load — fall back to frame-from-video using canvas
            prog(5, 'FFmpeg לא זמין - חילוץ פריים מהווידאו...');
            return await _fallbackDecompose(videoFile, prog);
        }

        const videoBytes = await _fileToArrayBuffer(videoFile);
        const inputName = 'input.mp4';
        await ffmpeg.writeFile(inputName, videoBytes);

        prog(8, 'מחלץ מידע מהווידאו...');

        // Get duration
        let duration = 30;
        try {
            await ffmpeg.exec(['-i', inputName, '-f', 'null', '-']);
        } catch (_) {}

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

        // Collect frames
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

        // Extract audio
        prog(15, 'מחלץ אודיו...');
        let audioData = null;
        try {
            await ffmpeg.exec([
                '-i', inputName,
                '-vn', '-acodec', 'flac',
                '-ar', '16000', '-ac', '1',
                'audio.flac'
            ]);
            audioData = await ffmpeg.readFile('audio.flac');
            if (audioData && audioData.length < 500) audioData = null;
        } catch (_) {
            audioData = null;
        }

        // Smart frame selection (every 2-4 seconds)
        const interval = duration <= 30 ? 2 : duration <= 120 ? 3 : 4;
        const selected = frames.filter((_, i) => i % interval === 0).slice(0, 20);

        // Cleanup
        try {
            await ffmpeg.deleteFile(inputName);
            for (let i = 1; i <= frames.length; i++) {
                await ffmpeg.deleteFile('frame_' + String(i).padStart(4, '0') + '.jpg').catch(() => {});
            }
            if (audioData) await ffmpeg.deleteFile('audio.flac').catch(() => {});
        } catch (_) {}

        return {
            duration: duration,
            hasAudio: !!audioData,
            audioData: audioData,
            allFrames: frames,
            selectedFrames: selected,
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

        // Step 1: Decompose
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
        };

        // Step 2: Speech (if audio available)
        let speechText = '';
        if (decomp.hasAudio && decomp.audioData) {
            prog(20, 'שלב 2: תמלול דיבור (Whisper)...');
            const whisperResult = await _apiWhisper(decomp.audioData, token);
            speechText = (whisperResult.text || '').trim();
        } else {
            prog(20, 'שלב 2: אין אודיו — דולג...');
        }

        // Steps 3-6: Process selected frames in parallel
        prog(25, 'שלב 3-6: ניתוח פריימים...');
        const frameResults = [];
        const batchSize = 3;
        const selectedFrames = decomp.selectedFrames;

        for (let i = 0; i < selectedFrames.length; i += batchSize) {
            const batch = selectedFrames.slice(i, i + batchSize);
            const pct = 25 + Math.round((i / selectedFrames.length) * 35);
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

        // AI Classifier on first frame
        let aiClassResult = { label: 'unknown' };
        if (selectedFrames.length > 0) {
            aiClassResult = await _apiAiClass(selectedFrames[0].data, token);
        }

        prog(62, 'שלב 7: מיזוג טקסטים...');

        // Merge all text
        const allOcr = frameResults.map(f => f.ocr).filter(Boolean).join('\n');
        const allCaptions = frameResults.map(f => f.caption).filter(Boolean).join('\n');
        const allObjects = [...new Set(frameResults.flatMap(f => f.objects.map(o => o.label)))];
        const mergedText = [speechText, allOcr].filter(Boolean).join('\n\n');

        const output = {
            speech_text: speechText,
            ocr_text: allOcr,
            merged_text: mergedText,
            frames: frameResults.map(f => ({
                timestamp: _formatTime(f.time),
                caption: f.caption,
                objects: f.objects.map(o => o.label),
                ai_detection: [f.aiVision],
            })),
            questions: [],
            answers: [],
            summary: allCaptions.slice(0, 500),
        };

        const pipeline = [
            { step: 1, name: 'decompose', duration_ms: 0 },
            { step: 2, name: 'speech_transcription', model: WHISPER, full_text: speechText },
            { step: 3, name: 'ocr_extraction', model: VISION_MODELS[0], full_text: allOcr },
            { step: 4, name: 'object_detection', model: DETR, unique_objects: allObjects.map(l => ({ label: l })) },
            { step: 5, name: 'image_captioning', model: VISION_MODELS[0] },
            { step: 6, name: 'ai_detection', models: [VISION_MODELS[0], AI_CLASS] },
        ];

        // Narrative Classification
        prog(65, 'שלב 8: סיווג נרטיב...');
        const narrPrompt =
            'Analyze the following VIDEO content data:\n\n' +
            'Speech Text: ' + (speechText || '(none)') + '\n' +
            'OCR Text: ' + (allOcr || '(none)') + '\n' +
            'Frame Descriptions: ' + allCaptions.slice(0, 1000) + '\n' +
            'Objects: ' + allObjects.join(', ') + '\n\n' +
            P_NARRATIVE_CLASS;
        const narrRaw = await _apiChat(narrPrompt, token, 'You are a Narrative Intelligence Classifier.', 512);
        const narrativeResult = _parseJson(narrRaw);

        // Scoring
        const scores = _computeScores(output, aiClassResult, narrativeResult);

        // Intelligence Analysis
        prog(72, 'שלב 9: ניתוח מודיעיני...');
        const intelPrompt =
            'Analyze the following VIDEO content:\n\n' +
            '== META ==\nType: video\nDuration: ' + decomp.duration + 's\nFrames: ' + decomp.allFrames.length + '\nSize: ' + meta.file_size_kb + ' KB\n\n' +
            '== SPEECH TEXT ==\n' + (speechText || '(no speech found)') + '\n\n' +
            '== OCR TEXT ==\n' + (allOcr || '(no text found)') + '\n\n' +
            '== FRAME DESCRIPTIONS ==\n' + allCaptions.slice(0, 1500) + '\n\n' +
            '== OBJECTS DETECTED ==\n' + allObjects.join(', ') + '\n\n' +
            '== AI DETECTION ==\nClassifier: ' + JSON.stringify(aiClassResult) + '\n\n' +
            '== NARRATIVE CLASS ==\n' + (narrativeResult.narrative_class || 'Unclear') + '\n\n' +
            P_INTELLIGENCE;
        const intelRaw = await _apiChat(intelPrompt, token, 'You are a senior intelligence analyst.', 1500);
        const intelligence = _parseJson(intelRaw);

        // UI Adapter
        prog(82, 'שלב 10: עיבוד סופי...');
        const uiPrompt =
            'Based on the following VIDEO analysis, produce the final UI output JSON.\n\n' +
            '== SPEECH ==\n' + (speechText || '(none)').slice(0, 500) + '\n' +
            '== FRAME DESCRIPTIONS ==\n' + allCaptions.slice(0, 500) + '\n' +
            '== INTELLIGENCE ==\n' + JSON.stringify(intelligence) + '\n' +
            '== NARRATIVE ==\n' + JSON.stringify(narrativeResult) + '\n' +
            '== SCORES (system computed) ==\n' + JSON.stringify(scores) + '\n\n' +
            'IMPORTANT: The ui_metrics values MUST use the scores provided above exactly. Do NOT change them.\n' +
            'Your ONLY creative job is the ui_summary text (Hebrew, 2-3 sentences), ui_tags, ui_flags, verified_findings, removed_claims.\n\n' +
            P_UI_ADAPTER;
        const uiRaw = await _apiChat(uiPrompt, token, 'You are a UI output generator.', 1200);
        const uiData = _parseJson(uiRaw);

        uiData.ui_metrics = {
            ...(uiData.ui_metrics || {}),
            truth_score: scores.truth_score,
            authenticity_score: scores.authenticity_score,
            ai_probability: scores.ai_probability,
            narrative: scores.narrative,
            risk_level: scores.risk_level,
            confidence_level: scores.confidence_level,
        };
        uiData.satire_detected = scores.satire_detected;
        uiData.factual_mode = scores.factual_mode;
        uiData.content_type = scores.content_type;

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
            research: {},
            validation: { is_valid: true, issues: [] },
            evidence_filter: {},
            ui_data: uiData,
            consistency: scores,
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
