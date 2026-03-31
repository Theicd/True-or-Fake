// ═══════════════════════════════════════════════════════════
//  True or Fake — Main App (Production)
//  מנתח אמינות תוכן מדיה מבוסס AI
//  כל הלוגיקה: ניווט, auth, העלאה, ניתוח, היסטוריה, סיור
// ═══════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);

let currentLang = 'he';
let tokenVerified = false;
let currentScreen = 'history';

const API_BASE_KEY = 'tof_api_base';
const API_BASE_HINT = 'api_base';

function _isGithubPagesHost() {
    const host = (window.location.hostname || '').toLowerCase();
    return host.endsWith('github.io');
}

function _normalizeApiBase(raw) {
    const v = String(raw || '').trim();
    if (!v) return '';
    return v.replace(/\/+$/, '');
}

function getApiBase() {
    const qp = new URLSearchParams(window.location.search).get(API_BASE_HINT);
    if (qp) {
        const fromQuery = _normalizeApiBase(qp);
        if (fromQuery) {
            localStorage.setItem(API_BASE_KEY, fromQuery);
            return fromQuery;
        }
    }

    const fromStorage = _normalizeApiBase(localStorage.getItem(API_BASE_KEY) || '');
    if (fromStorage) return fromStorage;

    if (_isGithubPagesHost()) {
        const fromGlobal = _normalizeApiBase(window.TOF_API_BASE || '');
        if (fromGlobal) {
            localStorage.setItem(API_BASE_KEY, fromGlobal);
            return fromGlobal;
        }
    }
    return '';
}

function apiUrl(path) {
    const base = getApiBase();
    return base ? `${base}${path}` : path;
}

function apiFetch(path, options) {
    return fetch(apiUrl(path), options);
}

function apiHelpMessage(isHe) {
    return isHe
        ? 'נדרש כתובת שרת API. פתח את האתר עם ?api_base=https://your-server.example.com או הגדר localStorage["tof_api_base"].'
        : 'API server URL is required. Open the site with ?api_base=https://your-server.example.com or set localStorage["tof_api_base"].';
}

function _hasBackend() {
    return !!getApiBase() || !_isGithubPagesHost();
}

function maybeWarnMissingApiBase(isHe) {
    // No longer blocking — direct HF API mode available
    return false;
}

// ═══════════════════════════════════════════════
//  SHARED HISTORY ENGINE — היסטוריה משותפת מהשרת
// ═══════════════════════════════════════════════
const HISTORY_KEY = 'analyzer_history_v1';
const HISTORY_MAX = 50;

// cache of shared reports loaded from server
let _sharedHistory = null;
let _sharedLoading = false;

function getDecentralizedClient() {
    return window.TrueOrFakeNet || null;
}

function detectMediaType(file, url) {
    if (file && file.type) {
        if (file.type.startsWith('video/')) return 'video';
        if (file.type.startsWith('image/')) return 'image';
        if (file.type.startsWith('audio/')) return 'audio';
    }
    if (url) return 'image';
    return 'unknown';
}

async function loadRelayHistory(limit = 25) {
    const net = getDecentralizedClient();
    if (!net || typeof net.loadRelayReports !== 'function') return [];
    try {
        return await net.loadRelayReports(limit);
    } catch (_) {
        return [];
    }
}

function mergeHistoryLists(primary, secondary) {
    const map = new Map();
    [...(primary || []), ...(secondary || [])].forEach(item => {
        if (!item || !item.id) return;
        const existing = map.get(item.id);
        if (!existing) {
            map.set(item.id, item);
            return;
        }
        map.set(item.id, {
            ...existing,
            ...item,
            fullData: item.fullData || existing.fullData,
        });
    });
    return Array.from(map.values()).sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
}

async function loadSharedHistory(force = false) {
    if (_sharedHistory && !force) return _sharedHistory;
    if (_sharedLoading) return _sharedHistory || [];
    _sharedLoading = true;
    try {
        let serverHistory = [];
        const r = await apiFetch('/api/reports?limit=50');
        if (r.ok) {
            const data = await r.json();
            serverHistory = data.reports || [];
        }
        const localHistory = getLocalHistory();
        const relayHistory = await loadRelayHistory(25);
        _sharedHistory = mergeHistoryLists(mergeHistoryLists(serverHistory, localHistory), relayHistory);
    } catch (e) {
        // fallback to local + relay if server unreachable
        const local = getLocalHistory();
        const relay = await loadRelayHistory(25);
        _sharedHistory = mergeHistoryLists(local, relay);
    } finally {
        _sharedLoading = false;
    }
    return _sharedHistory || [];
}

function getLocalHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
    catch { return []; }
}

function getHistory() {
    // returns cached shared history or local fallback synchronously
    return _sharedHistory || getLocalHistory();
}

function buildRelaySnapshot(data) {
    const ui = data.ui_data || {};
    const metrics = ui.ui_metrics || {};
    const intel = data.intelligence || {};
    const valid = data.validation || {};

    return {
        meta: {
            media_type: data.meta?.media_type || 'unknown',
            media_url: data.meta?.media_url || '',
        },
        ui_data: {
            ui_metrics: {
                truth_score: metrics.truth_score ?? 0,
                authenticity_score: metrics.authenticity_score ?? 0,
                ai_probability: metrics.ai_probability ?? 0,
                narrative: metrics.narrative || 'Unclear',
                risk_level: metrics.risk_level || 'Low',
                confidence_level: metrics.confidence_level ?? 0,
            },
            ui_summary: ui.ui_summary || '',
            ui_tags: (ui.ui_tags || []).slice(0, 8),
            ui_flags: (ui.ui_flags || []).slice(0, 8),
            verified_findings: (ui.verified_findings || []).slice(0, 12),
            removed_claims: (ui.removed_claims || []).slice(0, 12),
            content_type: ui.content_type || 'unclear',
            factual_mode: ui.factual_mode !== false,
        },
        intelligence: {
            final_assessment: intel.final_assessment || '',
            content_type: intel.content_type || 'unclear',
            recommended_action: intel.recommended_action || '',
            key_signals: (intel.key_signals || []).slice(0, 8),
            key_findings: (intel.key_findings || []).slice(0, 10),
        },
        validation: {
            is_valid: valid.is_valid !== false,
            issues: (valid.issues || []).slice(0, 10),
        },
        diagnostics: {
            degraded_mode: !!(data.diagnostics && data.diagnostics.degraded_mode),
            issues: ((data.diagnostics && data.diagnostics.issues) || []).slice(0, 8),
        },
        pipeline: [],
        output: {
            summary: data.output?.summary || ui.ui_summary || '',
        },
    };
}

function buildFallbackReportFromHistory(item) {
    const isHe = currentLang === 'he';
    const summary = item.summary || (isHe ? 'דוח מקוצר ללא נתוני שרת מלאים.' : 'Compact report without full server payload.');
    return {
        meta: { media_type: item.mediaType || 'unknown', degraded_fallback: true },
        ui_data: {
            ui_metrics: {
                truth_score: item.truthScore ?? 0,
                authenticity_score: item.authenticity ?? 0,
                ai_probability: 0,
                narrative: item.narrative || 'Unclear',
                risk_level: item.riskLevel || 'Low',
                confidence_level: item.confidence ?? 0,
            },
            ui_summary: summary,
            ui_tags: ['history-fallback'],
            ui_flags: [isHe ? 'דוח מקוצר' : 'Compact report'],
            verified_findings: [],
            removed_claims: [],
            content_type: 'unclear',
            factual_mode: true,
        },
        intelligence: {
            final_assessment: summary,
            content_type: item.narrative || 'Unclear',
            key_findings: [isHe ? 'מקור הדוח נטען מהיסטוריה' : 'Report loaded from history source'],
        },
        validation: { is_valid: true, issues: [] },
        output: { summary },
        diagnostics: {
            degraded_mode: true,
            issues: [isHe ? 'אין payload מלא לניתוח זה' : 'Full payload is unavailable for this item'],
        },
        pipeline: [],
    };
}

async function resolveHistoryReport(item) {
    if (!item) return null;
    if (item.fullData) return item.fullData;
    try {
        const r = await apiFetch('/api/reports/' + item.id);
        if (r.ok) {
            const rd = await r.json();
            if (rd && rd.fullData) return rd.fullData;
        }
    } catch (_) {
        // fall back to compact report
    }
    return buildFallbackReportFromHistory(item);
}

async function saveToHistory(data, fileName, extra = {}) {
    const ui = data.ui_data || {};
    const metrics = ui.ui_metrics || {};
    const mediaType = extra.mediaType || data.meta?.media_type || 'unknown';
    const entry = {
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        date: new Date().toISOString(),
        fileName: fileName || 'Unknown',
        mediaType,
        truthScore: metrics.truth_score ?? 0,
        authenticity: metrics.authenticity_score ?? 0,
        narrative: metrics.narrative || 'Unclear',
        riskLevel: metrics.risk_level || 'Low',
        confidence: metrics.confidence_level ?? 0,
        isSatire: !!(ui.satire_detected),
        summary: (ui.ui_summary || '').slice(0, 200),
        mediaUrl: extra.mediaUrl || '',
        relay_saved: false,
        relay_event_id: '',
        fullData: data,
    };

    // ── שמירה לשרת (היסטוריה משותפת) ──
    const token = ($('token') && $('token').value.trim()) || '';
    if (token) {
        try {
            // send entry JSON as request body
            await apiFetch('/api/reports/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...entry, hf_token_hint: token }),
            });
        } catch (e) { /* silent — still save locally */ }
    }

    // ── שמירה מבוזרת ל-Relay (כמו SOS) ──
    try {
        const net = getDecentralizedClient();
        if (net && typeof net.publishReport === 'function') {
            const relayEventId = await net.publishReport({
                id: entry.id,
                date: entry.date,
                fileName: entry.fileName,
                mediaType: entry.mediaType,
                truthScore: entry.truthScore,
                authenticity: entry.authenticity,
                narrative: entry.narrative,
                riskLevel: entry.riskLevel,
                confidence: entry.confidence,
                summary: entry.summary,
                mediaUrl: entry.mediaUrl,
                fullData: buildRelaySnapshot(data),
            });
            if (relayEventId) {
                entry.relay_saved = true;
                entry.relay_event_id = relayEventId;

                if (typeof net.publishTextPost === 'function' && entry.summary) {
                    net.publishTextPost(entry.summary, [
                        ['e', relayEventId],
                        ['t', 'analysis-summary'],
                    ]).catch(() => {});
                }
            }
        }
    } catch (e) {
        // relay publish is best-effort
    }

    // ── שמירה מקומית כגיבוי ──
    const local = getLocalHistory();
    local.unshift(entry);
    if (local.length > HISTORY_MAX) local.length = HISTORY_MAX;
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(local)); } catch (e) { /* quota */ }

    // invalidate cache
    _sharedHistory = null;
    return entry;
}

async function deleteOwnReport(reportId) {
    const token = ($('token') && $('token').value.trim()) || '';
    if (!token) { alert(currentLang === 'he' ? 'נדרש מפתח API כדי למחוק' : 'API key required to delete'); return false; }
    try {
        const r = await apiFetch('/api/reports/' + reportId, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + token },
        });
        if (r.ok) {
            // also remove from local
            const local = getLocalHistory().filter(x => x.id !== reportId);
            try { localStorage.setItem(HISTORY_KEY, JSON.stringify(local)); } catch (e) { /* quota */ }
            _sharedHistory = null;
            return true;
        }
        const err = await r.json();
        alert(err.error || (currentLang === 'he' ? 'לא ניתן למחוק' : 'Cannot delete'));
        return false;
    } catch (e) {
        alert(currentLang === 'he' ? 'שגיאת רשת' : 'Network error');
        return false;
    }
}

function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
    _sharedHistory = null;
    renderHistory();
}

// ═══════════════════════════════════════════════
//  HISTORY RENDERING — תצוגת כרטיסים עם מחיקה
// ═══════════════════════════════════════════════
async function renderHistory() {
    const grid = $('historyGrid');
    const empty = $('historyEmpty');
    const heroCard = $('heroCard');
    if (!grid) return;

    // show loading indicator
    grid.innerHTML = '<div class="hi-loading">⏳</div>';
    if (heroCard) heroCard.classList.add('hidden');

    const history = await loadSharedHistory();
    const myToken = ($('token') && $('token').value.trim()) || '';
    const myPrefix = myToken ? await _tokenPrefix(myToken) : null;
    const isHe = currentLang === 'he';

    if (!history.length) {
        grid.innerHTML = '';
        if (empty) empty.classList.remove('hidden');
        if (heroCard) heroCard.classList.add('hidden');
        $('btnClearHistory').style.display = 'none';
        return;
    }

    if (empty) empty.classList.add('hidden');
    $('btnClearHistory').style.display = '';

    // ── Hero Card — הניתוח האחרון ──
    const heroItem = history.find(x => x.fullData) || history[0];
    if (heroCard && heroItem) {
        heroCard.classList.remove('hidden');
        heroCard.className = `hero-card trust-${truthTone(heroItem.truthScore)} risk-${riskTone(heroItem.riskLevel)} media-${heroItem.mediaType || 'unknown'}`;
        const icon = heroItem.mediaType === 'video' ? '📺' : heroItem.mediaType === 'image' ? '📸' : heroItem.mediaType === 'audio' ? '🎧' : '📄';
        $('heroBadge').textContent = icon;
        $('heroScore').textContent = heroItem.truthScore + '%';
        $('heroScore').className = 'hero-score ' + (heroItem.truthScore >= 60 ? '' : heroItem.truthScore >= 35 ? 'score-med' : 'score-low');
        $('heroNarrative').textContent = isHe ? heT(TR.narrative, heroItem.narrative) : heroItem.narrative;
        $('heroTitle').textContent = heroItem.fileName;
        $('heroTrustState').textContent = truthStateLabel(heroItem.truthScore, isHe);
        $('heroThreat').textContent = riskLabel(heroItem.riskLevel, isHe);
        const d = new Date(heroItem.date);
        $('heroDate').textContent = d.toLocaleDateString('he-IL', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });

        // ── תצוגת מדיה בכרטיס Hero ──
        const heroMedia = $('heroMedia');
        if (heroMedia) {
            heroMedia.innerHTML = '';
            const mUrl = heroItem.mediaUrl || heroItem.fullData?.meta?.media_url || '';
            if (mUrl && heroItem.mediaType === 'video') {
                const vid = document.createElement('video');
                vid.src = mUrl;
                vid.controls = true;
                vid.preload = 'metadata';
                vid.muted = true;
                vid.playsInline = true;
                vid.setAttribute('playsinline', '');
                vid.setAttribute('webkit-playsinline', '');
                heroMedia.appendChild(vid);
            } else if (mUrl && heroItem.mediaType === 'image') {
                const img = document.createElement('img');
                img.src = mUrl;
                img.alt = heroItem.fileName || 'Media';
                img.loading = 'lazy';
                heroMedia.appendChild(img);
            }
        }

        heroCard.onclick = async () => {
            const fd = await resolveHistoryReport(heroItem);
            if (fd) { renderResult(fd); showScreen('result'); }
        };
    }

    // ── כרטיסי היסטוריה ──
    let h = '';
    history.forEach((item, idx) => {
        if (idx === 0 && item === heroItem) return; // skip hero
        const icon = item.mediaType === 'video' ? '📺' : item.mediaType === 'image' ? '📸' : item.mediaType === 'audio' ? '🎧' : '📄';
        const dateStr = new Date(item.date).toLocaleDateString('he-IL', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
        const score = item.truthScore;
        const scoreClass = score >= 60 ? 's-high' : score >= 35 ? 's-med' : 's-low';
        const riskClass = riskTone(item.riskLevel);
        const riskText = riskLabel(item.riskLevel, isHe);
        const narr = isHe ? heT(TR.narrative, item.narrative) : item.narrative;
        const isOwner = myPrefix && item.owner === myPrefix;
        const mUrl = item.mediaUrl || '';

        h += `<div class="history-item" data-report-id="${esc(item.id)}" data-history-idx="${idx}">`;

        // ── תמונת תצוגה מותאמת לסוג מדיה ──
        if (mUrl && item.mediaType === 'video') {
            h += `<div class="hi-media"><video src="${esc(mUrl)}" preload="metadata" muted playsinline></video><span class="hi-play-icon">▶</span></div>`;
        } else if (mUrl && item.mediaType === 'image') {
            h += `<div class="hi-media"><img src="${esc(mUrl)}" alt="" loading="lazy"></div>`;
        } else {
            h += `<div class="hi-icon">${icon}</div>`;
        }
        h += `<div class="hi-body">`;
        h += `<div class="hi-kicker">${isHe ? 'שכבת מודיעין' : 'Intelligence Layer'}</div>`;
        h += `<div class="hi-title-row">`;
        h += `<div class="hi-title">${esc(item.fileName)}</div>`;
        h += `<span class="hi-risk hi-risk-${riskClass}">${riskText}</span>`;
        h += `</div>`;
        h += `<div class="hi-meta"><span class="hi-date">${dateStr}</span><span class="hi-sep">•</span><span class="hi-type">${mediaLabel(item.mediaType, isHe)}</span></div>`;
        h += `</div>`;
        h += `<div class="hi-scores">`;
        h += `<span class="hi-score ${scoreClass}">${score}%</span>`;
        h += `<span class="hi-narr">${narr}</span>`;
        if (isOwner) {
            h += `<button class="btn-hi-delete" data-report-id="${esc(item.id)}" title="${isHe ? 'מחק דוח זה' : 'Delete this report'}">🗑</button>`;
        }
        h += `</div>`;
        h += `</div>`;
    });
    grid.innerHTML = h;

    // ── חיבור לחיצות על כרטיסים ──
    grid.querySelectorAll('.history-item').forEach(card => {
        card.addEventListener('click', async (e) => {
            if (e.target.closest('.btn-hi-delete')) return; // ignore delete btn clicks
            const idx = parseInt(card.dataset.historyIdx);
            const item = history[idx];
            if (!item) return;
            const fd = await resolveHistoryReport(item);
            if (fd) { renderResult(fd); showScreen('result'); }
        });
    });

    // ── מחיקת דוחות של המשתמש ──
    grid.querySelectorAll('.btn-hi-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.reportId;
            if (!confirm(isHe ? 'למחוק דוח זה?' : 'Delete this report?')) return;
            btn.disabled = true;
            btn.textContent = '⏳';
            const ok = await deleteOwnReport(id);
            if (ok) renderHistory();
            else { btn.disabled = false; btn.textContent = '🗑'; }
        });
    });
}

// ── fingerprint מקומי (זהה לשרת) ──
async function _tokenPrefix(token) {
    try {
        const enc = new TextEncoder().encode(token);
        const buf = await crypto.subtle.digest('SHA-256', enc);
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 14);
    } catch (e) { return token.slice(0, 8); }
}

// ═══════════════════════════════════════════════
//  TRANSLATION MAPS — תרגום עברית לערכים מהשרת
// ═══════════════════════════════════════════════
const TR = {
    risk: { 'High': 'גבוה', 'Medium': 'בינוני', 'Low': 'נמוך', 'Critical': 'קריטי' },
    narrative: { 'Factual': 'עובדתי', 'Synthetic': 'סינתטי', 'Misleading': 'מטעה', 'Propaganda': 'תעמולה',
                 'Parody': 'פרודיה', 'Satire': 'סאטירה', 'Opinion': 'דעה', 'Unclear': 'לא ברור',
                 'Misinformation': 'מידע מטעה', 'Fiction': 'בדיון',
                 'Human': 'אנושי', 'Mixed': 'מעורב', 'Authentic': 'אותנטי' },
    confidence: { 'High': 'גבוה', 'Medium': 'בינוני', 'Low': 'נמוך', 'Very High': 'גבוה מאוד', 'Very Low': 'נמוך מאוד' },
    intel: { 'Assessment': 'הערכה', 'Confidence': 'רמת ביטחון', 'Risk': 'סיכון', 'Authenticity': 'אותנטיות',
             'Manipulation': 'מניפולציה', 'AI Score': 'ציון AI', 'Narrative': 'סוג נרטיב', 'Action': 'המלצה',
             'Key Findings': 'ממצאים מרכזיים', 'Reasoning': 'נימוק' },
    valid: { 'Valid': 'תקף', 'Corrected Confidence': 'ביטחון מתוקן', 'Issues': 'בעיות שזוהו' },
    tags: { 'synthetic': 'סינתטי', 'parody': 'פרודיה', 'misinformation': 'מידע מטעה', 'propaganda': 'תעמולה',
            'authentic': 'אותנטי', 'factual': 'עובדתי', 'manipulated': 'עבר מניפולציה', 'deepfake': 'דיפ-פייק',
            'satire': 'סאטירה', 'humor': 'הומור', 'fiction': 'בדיון', 'opinion': 'דעה', 'misleading': 'מטעה',
            'ai-generated': 'נוצר ע"י AI', 'mixed signals': 'אותות מעורבים',
            'low confidence': 'ביטחון נמוך', 'medium confidence': 'ביטחון בינוני', 'high confidence': 'ביטחון גבוה',
            'low risk': 'סיכון נמוך', 'medium risk': 'סיכון בינוני', 'high risk': 'סיכון גבוה',
            'Hebrew': 'עברית', 'English': 'אנגלית', 'Arabic': 'ערבית',
            'Misinformation': 'מידע מטעה', 'Misleading': 'מטעה', 'Factual': 'עובדתי',
            'Satire': 'סאטירה', 'Propaganda': 'תעמולה', 'Synthetic': 'סינתטי',
            'Parody': 'פרודיה', 'Fiction': 'בדיון', 'Opinion': 'דעה', 'Unclear': 'לא ברור' }
};

function heT(map, val) {
    if (currentLang !== 'he' || !val) return val;
    const s = String(val);
    if (map[s]) return map[s];
    const lower = s.toLowerCase();
    for (const [k, v] of Object.entries(map)) { if (k.toLowerCase() === lower) return v; }
    return s;
}

function truthTone(score) {
    if (score >= 60) return 'high';
    if (score >= 35) return 'medium';
    return 'low';
}

function truthStateLabel(score, isHe) {
    if (score >= 75) return isHe ? 'נראה אמין' : 'Likely authentic';
    if (score >= 60) return isHe ? 'נוטה לאמת' : 'Leans true';
    if (score >= 35) return isHe ? 'דורש בדיקה' : 'Needs scrutiny';
    return isHe ? 'חשוד כמטעה' : 'Potentially misleading';
}

function riskTone(level) {
    const value = String(level || '').toLowerCase();
    if (value === 'high' || value === 'critical') return 'high';
    if (value === 'medium') return 'medium';
    return 'low';
}

function riskLabel(level, isHe) {
    const value = String(level || 'Low');
    return isHe ? `סיכון ${heT(TR.risk, value)}` : `${value} Risk`;
}

function mediaLabel(type, isHe) {
    const map = {
        video: isHe ? 'וידאו' : 'Video',
        image: isHe ? 'תמונה' : 'Image',
        text: isHe ? 'טקסט' : 'Text',
        audio: isHe ? 'אודיו' : 'Audio',
        unknown: isHe ? 'מדיה' : 'Media',
    };
    return map[type] || map.unknown;
}

// ═══════════════════════════════════════════════
//  SCREEN NAVIGATION — מעבר בין מסכים
// ═══════════════════════════════════════════════
const ALL_SCREENS = ['screen-history', 'screen-analyze', 'screen-info', 'screen-process', 'screen-result'];

function showScreen(name) {
    currentScreen = name;
    ALL_SCREENS.forEach(id => {
        const el = $(id);
        if (el) el.classList.toggle('hidden', id !== 'screen-' + name);
    });
    // ── עדכון bottom nav — בדף result מסמנים את טאב ניתוחים כ-active ──
    document.querySelectorAll('.nav-tab').forEach(tab => {
        const activeScreen = name === 'result' ? 'history' : name;
        tab.classList.toggle('active', tab.dataset.screen === activeScreen);
    });
    // ── הסתרת bottom nav רק בזמן עיבוד (לא בדף תוצאות) ──
    const nav = $('bottomNav');
    if (nav) nav.classList.toggle('nav-hidden', name === 'process');
    // ── scroll to top ──
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ═══════════════════════════════════════════════
//  AUTH MODAL — חלון התחברות / הרשמה
// ═══════════════════════════════════════════════
function openAuthModal(tab) {
    const modal = $('authModal');
    modal.classList.remove('hidden');
    switchAuthTab(tab || 'login');
    document.body.style.overflow = 'hidden';
}

function closeAuthModal() {
    $('authModal').classList.add('hidden');
    document.body.style.overflow = '';
}

function switchAuthTab(tab) {
    document.querySelectorAll('.modal-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    $('loginTab').classList.toggle('hidden', tab !== 'login');
    $('registerTab').classList.toggle('hidden', tab !== 'register');
}

// ═══════════════════════════════════════════════
//  GUIDED TOUR — סיור מודרך למשתמש חדש
// ═══════════════════════════════════════════════
const TOUR_STEPS = [
    {
        he: '<h4>👋 ברוכים הבאים ל-True or Fake!</h4><p>כלי AI שחושף אים תוכן אמיתי או מבוים. בואו נכיר את המערכת.</p>',
        en: '<h4>👋 Welcome to True or Fake!</h4><p>AI that detects whether media content is real or fabricated. Let\'s explore.</p>'
    },
    {
        he: '<h4>📊 ניתוחים קודמים</h4><p>כאן תראו את כל הניתוחים שביצעתם. לחצו על כל ניתוח כדי לראות את הדוח המלא.</p>',
        en: '<h4>📊 Past Analyses</h4><p>View all your past analyses here. Click any to see the full report.</p>'
    },
    {
        he: '<h4>🔍 ניתוח חדש</h4><p>התחברו עם מפתח API, העלו וידאו או תמונה — המערכת תנתח את האמינות תוך דקות.</p>',
        en: '<h4>🔍 New Analysis</h4><p>Connect with an API key, upload a video or image — the system analyzes credibility in minutes.</p>'
    },
    {
        he: '<h4>ℹ️ יכולות המערכת</h4><p>בלשונית "מידע" תמצאו פירוט על כל מה שהמערכת יודעת לעשות: זיהוי AI, הצלבת מציאות, ניתוח נרטיב ועוד.</p>',
        en: '<h4>ℹ️ Capabilities</h4><p>Check the "About" tab for all system capabilities: AI detection, reality checks, narrative analysis and more.</p>'
    }
];
let tourStep = 0;

function startTour() {
    tourStep = 0;
    $('tourOverlay').classList.remove('hidden');
    renderTourStep();
}

function renderTourStep() {
    const step = TOUR_STEPS[tourStep];
    $('tourContent').innerHTML = currentLang === 'he' ? step.he : step.en;
    $('tourStep').textContent = (tourStep + 1) + '/' + TOUR_STEPS.length;
    const nextBtn = $('tourNext');
    const isLast = tourStep === TOUR_STEPS.length - 1;
    nextBtn.textContent = isLast ? (currentLang === 'he' ? 'סיים' : 'Done') : (currentLang === 'he' ? 'הבא' : 'Next');
}

function endTour() {
    $('tourOverlay').classList.add('hidden');
    localStorage.setItem('tour_done_v2', '1');
}

// ═══════════════════════════════════════════════
//  INIT — אתחול כל ה-handlers
// ═══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    // ── טוקן שמור ──
    const saved = localStorage.getItem('hf_token_v2');
    if (saved) {
        $('token').value = saved;
        // בדיקה אם כבר מאומת
        const wasVerified = localStorage.getItem('hf_verified');
        if (wasVerified === 'true') {
            tokenVerified = true;
            updateAuthUI(true, localStorage.getItem('hf_user') || 'User');
        }
    }

    // ── Token input שמירה אוטומטית ──
    $('token').addEventListener('input', () => {
        localStorage.setItem('hf_token_v2', $('token').value);
        tokenVerified = false;
        updateAuthUI(false);
        $('tokenStatus').className = 'auth-status';
        $('tokenStatus').textContent = '';
    });

    // ── כפתור אימות ──
    $('btnVerify').addEventListener('click', verifyToken);

    // ── API Base (ל-GitHub Pages או שרת חיצוני) ──
    const apiInput = $('apiBase');
    const apiBtn = $('btnSaveApiBase');
    const apiStatus = $('apiBaseStatus');
    if (apiInput) {
        apiInput.value = getApiBase();
    }
    if (apiBtn && apiInput) {
        apiBtn.addEventListener('click', () => {
            const isHe = currentLang === 'he';
            const val = _normalizeApiBase(apiInput.value || '');
            if (!val) {
                localStorage.removeItem(API_BASE_KEY);
                if (apiStatus) {
                    apiStatus.className = 'auth-status';
                    apiStatus.textContent = isHe ? 'נמחק. במצב זה נדרש backend יחסי באותו דומיין.' : 'Cleared. Relative backend on same host is required.';
                }
                return;
            }
            localStorage.setItem(API_BASE_KEY, val);
            if (apiStatus) {
                apiStatus.className = 'auth-status ok';
                apiStatus.textContent = isHe ? 'נשמר בהצלחה' : 'Saved successfully';
            }
        });
    }

    // ── שפה ──
    $('langBtn').addEventListener('click', toggleLang);

    // ── כפתור משתמש (פתיחת מודאל auth) ──
    $('btnUser').addEventListener('click', () => openAuthModal('login'));

    // ── סגירת מודאל auth ──
    $('modalClose').addEventListener('click', closeAuthModal);
    $('authModal').addEventListener('click', (e) => {
        if (e.target === $('authModal')) closeAuthModal();
    });

    // ── טאבים במודאל ──
    document.querySelectorAll('.modal-tab').forEach(tab => {
        tab.addEventListener('click', () => switchAuthTab(tab.dataset.tab));
    });

    // ── הרשמה — הודעה + שמירת מייל ──
    $('btnRegNotify').addEventListener('click', handleRegister);

    // ── לוגו — חזרה למסך ראשי ──
    $('logoBtn').addEventListener('click', () => { showScreen('history'); renderHistory(); });

    // ── Bottom Nav — ניווט תחתון ──
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const screen = tab.dataset.screen;
            showScreen(screen);
            if (screen === 'history') renderHistory();
        });
    });

    // ── Auth Wall — כפתור התחבר מתוך מסך ניתוח ──
    $('btnAuthFromWall').addEventListener('click', () => openAuthModal('login'));

    // ── העלאה ──
    $('btnUpload').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', e => {
        if (e.target.files[0]) showSelectedFile(e.target.files[0]);
    });

    // ── Drag & Drop ──
    const dz = $('dropZone');
    if (dz) {
        dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
        dz.addEventListener('dragleave', e => { e.preventDefault(); dz.classList.remove('over'); });
        dz.addEventListener('drop', e => {
            e.preventDefault(); dz.classList.remove('over');
            if (e.dataTransfer.files?.[0]) showSelectedFile(e.dataTransfer.files[0]);
        });
    }

    // ── כפתור ניתוח ──
    $('btnGo').addEventListener('click', startAnalysis);

    // ── ניתוח חדש (מתוך דוח) ──
    $('btnNewAnalysis').addEventListener('click', () => { showScreen('analyze'); });

    // ── ביטול ──
    $('btnCancel').addEventListener('click', () => { showScreen('history'); renderHistory(); });

    // ── Toggle sections (קיפול/פתיחה) ──
    document.querySelectorAll('.toggle-head').forEach(el => {
        el.addEventListener('click', () => {
            const body = $(el.dataset.target);
            const arrow = el.querySelector('.arrow');
            if (body) body.classList.toggle('collapsed');
            if (arrow) arrow.classList.toggle('open');
        });
    });

    // ── היסטוריה — טעינה ראשונית ──
    renderHistory();
    try {
        const net = getDecentralizedClient();
        if (net && typeof net.getRelayUrls === 'function' && typeof net.getBlossomServers === 'function') {
            const relays = net.getRelayUrls();
            const blossoms = net.getBlossomServers();
            addLog(
                currentLang === 'he'
                    ? `רשת פעילה: ${relays.length} Relay / ${blossoms.length} Blossom`
                    : `Active network: ${relays.length} Relays / ${blossoms.length} Blossom`,
                'ok'
            );
        }
    } catch (_) {
        // ignore network status logging failures
    }

    $('btnClearHistory').addEventListener('click', () => {
        if (confirm(currentLang === 'he' ? 'למחוק את כל ההיסטוריה?' : 'Clear all history?')) {
            clearHistory();
        }
    });

    // ── Auth Wall / Upload visibility ──
    updateAnalyzeScreen();

    // ── סיור למשתמש חדש ──
    $('tourNext').addEventListener('click', () => {
        if (tourStep < TOUR_STEPS.length - 1) { tourStep++; renderTourStep(); }
        else endTour();
    });
    $('tourSkip').addEventListener('click', endTour);

    if (!localStorage.getItem('tour_done_v2') && !getHistory().length) {
        setTimeout(startTour, 800);
    }

    // ── מסך ראשי ──
    showScreen('history');
});

// ═══════════════════════════════════════════════
//  AUTH UI — עדכון ממשק לפי מצב התחברות
// ═══════════════════════════════════════════════
function updateAuthUI(verified, userName) {
    const btn = $('btnUser');
    const label = btn.querySelector('.user-label');
    const icon = btn.querySelector('.user-icon');
    if (verified) {
        btn.classList.add('logged-in');
        icon.textContent = '✓';
        label.textContent = userName || 'מחובר';
        label.setAttribute('data-he', userName || 'מחובר');
        label.setAttribute('data-en', userName || 'Connected');
    } else {
        btn.classList.remove('logged-in');
        icon.textContent = '👤';
        label.textContent = currentLang === 'he' ? 'התחבר' : 'Login';
    }
    updateAnalyzeScreen();
}

function updateAnalyzeScreen() {
    const wall = $('authWall');
    const wrap = $('uploadWrap');
    if (!wall || !wrap) return;
    if (tokenVerified) {
        wall.classList.add('hidden');
        wrap.classList.remove('hidden');
    } else {
        wall.classList.remove('hidden');
        wrap.classList.add('hidden');
    }
}

// ═══════════════════════════════════════════════
//  LANGUAGE — מעבר שפה
// ═══════════════════════════════════════════════
function toggleLang() {
    currentLang = currentLang === 'he' ? 'en' : 'he';
    $('langBtn').textContent = currentLang === 'he' ? 'EN' : 'HE';
    document.documentElement.lang = currentLang;
    document.documentElement.dir = currentLang === 'he' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-he]').forEach(el => {
        el.textContent = el.getAttribute('data-' + currentLang);
    });
    document.querySelectorAll('[data-he-placeholder]').forEach(el => {
        el.placeholder = el.getAttribute('data-' + currentLang + '-placeholder');
    });
    renderHistory();
}

// ═══════════════════════════════════════════════
//  TOKEN VERIFY — אימות מפתח API
// ═══════════════════════════════════════════════
async function verifyToken() {
    const token = $('token').value.trim();
    const isHe = currentLang === 'he';
    if (!token) {
        showStatus('tokenStatus', 'err', isHe ? 'נא להכניס מפתח' : 'Please enter a token');
        return;
    }
    if (!token.startsWith('hf_')) {
        showStatus('tokenStatus', 'err', isHe ? 'מפתח חייב להתחיל ב-hf_' : 'Token must start with hf_');
        return;
    }
    $('btnVerify').disabled = true;
    showStatus('tokenStatus', 'wait', isHe ? 'בודק מפתח...' : 'Checking...');
    try {
        let data;
        if (_hasBackend()) {
            // Use backend proxy
            const fd = new FormData();
            fd.append('hf_token', token);
            const r = await apiFetch('/api/verify-token', { method: 'POST', body: fd });
            data = await r.json();
        } else {
            // Direct HuggingFace API (GitHub Pages mode)
            data = await HF_CLIENT.verifyToken(token);
        }
        if (data.ok) {
            tokenVerified = true;
            const userName = data.name || 'User';
            localStorage.setItem('hf_verified', 'true');
            localStorage.setItem('hf_user', userName);
            localStorage.setItem('hf_token', token);
            showStatus('tokenStatus', 'ok', (isHe ? '✅ מפתח תקין — ' : '✅ Valid — ') + userName);
            updateAuthUI(true, userName);
            setTimeout(closeAuthModal, 1200);
        } else {
            tokenVerified = false;
            localStorage.removeItem('hf_verified');
            showStatus('tokenStatus', 'err', isHe ? '❌ מפתח לא תקין' : '❌ Invalid token');
        }
    } catch (e) {
        tokenVerified = false;
        showStatus('tokenStatus', 'err', (isHe ? '❌ שגיאת רשת: ' : '❌ Network error: ') + e.message);
    }
    $('btnVerify').disabled = false;
}

function showStatus(id, cls, text) {
    const el = $(id);
    el.className = 'auth-status ' + cls;
    el.textContent = text;
}

// ═══════════════════════════════════════════════
//  REGISTER — טיפול ברישום (בקרוב)
// ═══════════════════════════════════════════════
function handleRegister() {
    const email = $('regEmail').value.trim();
    const isHe = currentLang === 'he';
    if (!email || !email.includes('@')) {
        showStatus('regStatus', 'err', isHe ? 'נא להכניס מייל תקין' : 'Please enter a valid email');
        return;
    }
    // ── שמירה מקומית (בהמשך יועבר לשרת) ──
    const emails = JSON.parse(localStorage.getItem('reg_emails') || '[]');
    if (!emails.includes(email)) emails.push(email);
    localStorage.setItem('reg_emails', JSON.stringify(emails));
    showStatus('regStatus', 'ok', isHe ? '✅ נרשם! נודיע לך כשההרשמה תיפתח' : '✅ Registered! We\'ll notify you');
    $('regEmail').value = '';
}

// ═══════════════════════════════════════════════
//  FILE SELECTION — בחירת קובץ
// ═══════════════════════════════════════════════
function showSelectedFile(file) {
    window.__file = file;
    const sf = $('selectedFile');
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    const isHe = currentLang === 'he';
    // מגבלת גודל קובץ
    if (file.size > 50 * 1024 * 1024) {
        alert(isHe ? 'הקובץ גדול מהמותר (50MB)' : 'File exceeds 50MB limit');
        sf.textContent = '';
        sf.classList.add('hidden');
        window.__file = null;
        return;
    }
    // בדיקת אורך וידאו (אם רלוונטי)
    if (file.type && file.type.startsWith('video/')) {
        const url = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.onloadedmetadata = function() {
            URL.revokeObjectURL(url);
            const duration = video.duration;
            if (duration > 120) {
                alert(isHe ? 'הסרטון ארוך מהמותר (120 שניות)' : 'Video exceeds 120 seconds limit');
                sf.textContent = '';
                sf.classList.add('hidden');
                window.__file = null;
                return;
            }
            // הערכת זמן עיבוד
            let est = '';
            if (duration <= 30) est = isHe ? 'העיבוד צפוי להימשך כחצי דקה' : 'Estimated processing: ~30 seconds';
            else if (duration <= 60) est = isHe ? 'העיבוד צפוי להימשך כדקה' : 'Estimated processing: ~1 minute';
            else if (duration <= 90) est = isHe ? 'העיבוד צפוי להימשך כשתי דקות' : 'Estimated processing: ~2 minutes';
            else est = isHe ? 'העיבוד צפוי להימשך 2-3 דקות' : 'Estimated processing: 2-3 minutes';
            sf.textContent = '📎 ' + file.name + ' (' + sizeMB + ' MB, ' + Math.round(duration) + ' שניות) — ' + est;
            sf.classList.remove('hidden');
        };
        video.onerror = function() {
            alert(isHe ? 'שגיאה בקריאת קובץ וידאו' : 'Error reading video file');
            sf.textContent = '';
            sf.classList.add('hidden');
            window.__file = null;
        };
        video.src = url;
    } else {
        sf.textContent = '📎 ' + file.name + ' (' + sizeMB + ' MB)';
        sf.classList.remove('hidden');
    }
}

// ═══════════════════════════════════════════════
//  LOGGING — הודעות במסך עיבוד
// ═══════════════════════════════════════════════
function addLog(text, cls) {
    const box = $('logsBox');
    const line = document.createElement('div');
    line.className = 'log-line ' + (cls || '');
    line.textContent = '> ' + text;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
}

function setProgress(pct, text) {
    $('pBar').style.width = pct + '%';
    $('pText').textContent = Math.round(pct) + '%';
    if (text) $('aiMsg').textContent = text;
}

function setStatus(id, done) {
    const el = $(id);
    if (el) { el.textContent = done ? '✔' : '⏳'; el.style.color = done ? '#009664' : ''; }
}

function buildAudioInspectionResult(file, blossomUrl) {
    const name = file?.name || 'audio';
    const summaryHe = `הקובץ זוהה כאודיו (${name}) והועלה ל-Blossom בהצלחה. ניתוח אמינות מלא לאודיו עדיין לא הופעל בגרסה זו.`;
    const summaryEn = `The file was identified as audio (${name}) and uploaded to Blossom successfully. Full credibility analysis for audio is not yet enabled in this version.`;
    return {
        meta: { media_type: 'audio', media_url: blossomUrl || '' },
        ui_data: {
            ui_metrics: {
                truth_score: 0,
                authenticity_score: 0,
                ai_probability: 0,
                narrative: 'Unclear',
                risk_level: 'Low',
                confidence_level: 0,
            },
            ui_summary: currentLang === 'he' ? summaryHe : summaryEn,
            ui_tags: ['audio'],
            ui_flags: [currentLang === 'he' ? 'ניתוח אודיו עדיין לא פעיל' : 'Audio analysis not enabled yet'],
            confidence_reasons: [],
            factual_mode: false,
            content_type: 'audio',
        },
        intelligence: {
            final_assessment: currentLang === 'he' ? 'זוהה אודיו ונשמר קישור מבוזר' : 'Audio identified and decentralized link stored',
        },
        validation: {
            is_valid: true,
            issues: [currentLang === 'he' ? 'אין מודול ניתוח אודיו פעיל' : 'No active audio analysis module'],
        },
        diagnostics: {
            degraded_mode: true,
            issues: [currentLang === 'he' ? 'אודיו בלבד: שמירה וסיווג' : 'Audio only: storage + classification'],
        },
        pipeline: [],
        output: { summary: currentLang === 'he' ? summaryHe : summaryEn },
    };
}

// ═══════════════════════════════════════════════
//  ANALYSIS — הפעלת ניתוח
// ═══════════════════════════════════════════════
async function startAnalysis() {
    const token = $('token').value.trim();
    const isHe = currentLang === 'he';

    if (!token || !token.startsWith('hf_')) {
        openAuthModal('login');
        return;
    }

    const file = window.__file || null;
    const url = $('urlInput').value.trim();
    if (!file && !url) {
        alert(isHe ? 'נא לבחור קובץ או להכניס URL' : 'Please select a file or enter a URL');
        return;
    }
    // בדיקת מגבלות לפני עיבוד
    if (file) {
        if (file.size > 50 * 1024 * 1024) {
            alert(isHe ? 'הקובץ גדול מהמותר (50MB)' : 'File exceeds 50MB limit');
            return;
        }
        if (file.type && file.type.startsWith('video/')) {
            // נבדוק אם שמרנו את האורך בזיכרון (window.__videoDuration)
            if (typeof window.__videoDuration === 'number') {
                if (window.__videoDuration > 120) {
                    alert(isHe ? 'הסרטון ארוך מהמותר (120 שניות)' : 'Video exceeds 120 seconds limit');
                    return;
                }
            }
        }
    }

    $('btnGo').disabled = true;
    showScreen('process');
    $('logsBox').innerHTML = '';
    ['st-extract', 'st-narrative', 'st-intel', 'st-valid', 'st-evidence', 'st-consistency', 'st-ui'].forEach(id => setStatus(id, false));

    const label = file ? file.name : 'URL';
    const mediaType = detectMediaType(file, url);
    const net = getDecentralizedClient();
    let blossomUrl = '';

    addLog(isHe ? 'מתחיל ניתוח: ' + label : 'Starting analysis: ' + label);
    setProgress(5, isHe ? 'מעלה מדיה...' : 'Uploading media...');

    if (maybeWarnMissingApiBase(isHe)) {
        $('btnGo').disabled = false;
        showScreen('history');
        return;
    }

    try {
        if (file) {
            if (!net || typeof net.uploadToBlossom !== 'function') {
                throw new Error(isHe ? 'Blossom לא זמין כרגע בדפדפן זה' : 'Blossom is not available in this browser');
            }
            addLog(isHe ? 'יוצר זהות Nostr מקומית...' : 'Preparing local Nostr identity...');
            if (typeof net.ensureKeys === 'function') await net.ensureKeys();
            const profileName = localStorage.getItem('hf_user') || 'TrueOrFake User';
            if (typeof net.publishProfile === 'function') {
                net.publishProfile(profileName).catch(() => {});
            }

            addLog(isHe ? 'מעלה קובץ ל-Blossom...' : 'Uploading file to Blossom...');
            let syntheticPct = 8;
            const blossomTicker = setInterval(() => {
                syntheticPct = Math.min(40, syntheticPct + 2);
                setProgress(syntheticPct, isHe ? 'העלאה מבוזרת ל-Blossom...' : 'Decentralized Blossom upload...');
            }, 400);
            try {
                blossomUrl = await net.uploadToBlossom(file);
            } finally {
                clearInterval(blossomTicker);
            }
            addLog((isHe ? 'הקובץ הועלה ל-Blossom: ' : 'Uploaded to Blossom: ') + blossomUrl, 'ok');
            setProgress(42, isHe ? 'העלאה הסתיימה, מתחיל ניתוח...' : 'Upload complete, starting analysis...');

            if (mediaType === 'audio') {
                const audioData = buildAudioInspectionResult(file, blossomUrl);
                const analysisLabel = file.name;
                await saveToHistory(audioData, analysisLabel, { mediaType: 'audio', mediaUrl: blossomUrl });

                window.__file = null;
                $('selectedFile').classList.add('hidden');
                $('fileInput').value = '';

                addLog(isHe ? 'זוהה אודיו ונשמר קישור מבוזר' : 'Audio identified and decentralized link stored', 'ok');
                setProgress(100, isHe ? 'סיום!' : 'Done!');
                renderResult(audioData);
                showScreen('result');
                $('btnGo').disabled = false;
                return;
            }
        }

        let data;

        if (_hasBackend()) {
            // ── Backend mode: send to server ──
            const fd = new FormData();
            fd.append('hf_token', token);
            if (file) fd.append('media', file);
            else fd.append('image_url', url);
            if (blossomUrl) fd.append('media_url', blossomUrl);

            addLog(isHe ? 'שולח לשרת...' : 'Sending to server...');
            setProgress(10, isHe ? 'שלב 1-2: חילוץ נתונים...' : 'Stage 1-2: extracting...');

            let fakePct = 5;
            const shown = {};
            const progressTimer = setInterval(() => {
                if (fakePct < 85) {
                    const speed = fakePct < 30 ? 2 + Math.random() * 2 : fakePct < 60 ? 1 + Math.random() * 1.5 : 0.5 + Math.random();
                    fakePct = Math.min(85, fakePct + speed);
                    setProgress(fakePct);
                    if (fakePct > 5 && !shown.s1) { shown.s1=1; addLog(isHe ? 'פירוק וידאו לפריימים...' : 'Decomposing video...', 'ok'); }
                    if (fakePct > 10 && !shown.s2) { shown.s2=1; addLog(isHe ? 'תמלול דיבור (Whisper)...' : 'Speech (Whisper)...', 'ok'); }
                    if (fakePct > 15 && !shown.s3) { shown.s3=1; addLog(isHe ? 'חילוץ טקסט OCR...' : 'OCR...', 'ok'); }
                    if (fakePct > 19 && !shown.s4) { shown.s4=1; addLog(isHe ? 'זיהוי אובייקטים...' : 'Object detection...', 'ok'); setStatus('st-extract', true); }
                    if (fakePct > 23 && !shown.s5) { shown.s5=1; addLog(isHe ? 'תיאור תמונות...' : 'Captioning...', 'ok'); }
                    if (fakePct > 27 && !shown.s6) { shown.s6=1; addLog(isHe ? 'זיהוי תוכן AI...' : 'AI detection...', 'ok'); }
                    if (fakePct > 36 && !shown.s8) { shown.s8=1; addLog(isHe ? 'שאלות חקירה...' : 'Investigation...', 'ok'); }
                    if (fakePct > 46 && !shown.s10) { shown.s10=1; addLog(isHe ? 'סיכום...' : 'Summary...', 'ok'); }
                    if (fakePct > 51 && !shown.s11) { shown.s11=1; addLog(isHe ? 'סיווג נרטיב...' : 'Narrative...', 'ok'); setStatus('st-narrative', true); setProgress(fakePct, isHe ? 'סיווג נרטיב' : 'Narrative'); }
                    if (fakePct > 56 && !shown.s13) { shown.s13=1; addLog(isHe ? 'ניתוח מודיעיני (120B)...' : 'Intelligence (120B)...', 'ok'); setStatus('st-intel', true); }
                    if (fakePct > 58 && !shown.s13b) { shown.s13b=1; addLog(isHe ? '🔍 Reality Check — חילוץ טענות...' : '🔍 Reality Check — claims...', 'ok'); }
                    if (fakePct > 64 && !shown.s13d) { shown.s13d=1; addLog(isHe ? '🔍 חיפוש רב-מקורי...' : '🔍 Multi-source search...', 'ok'); }
                    if (fakePct > 70 && !shown.s13f) { shown.s13f=1; addLog(isHe ? '🔍 הקשר מודיעיני...' : '🔍 Context intel...', 'ok'); }
                    if (fakePct > 75 && !shown.s14) { shown.s14=1; addLog(isHe ? 'אימות תוצאות...' : 'Validation...', 'ok'); setStatus('st-valid', true); }
                    if (fakePct > 78 && !shown.s15) { shown.s15=1; addLog(isHe ? 'סינון ראיות...' : 'Evidence filter...', 'ok'); setStatus('st-evidence', true); }
                    if (fakePct > 80 && !shown.s16) { shown.s16=1; addLog(isHe ? 'מנוע עקביות...' : 'Consistency...', 'ok'); setStatus('st-consistency', true); }
                    if (fakePct > 83 && !shown.s17) { shown.s17=1; addLog(isHe ? 'עיבוד סופי...' : 'Finalizing...', 'ok'); setStatus('st-ui', true); }
                }
            }, 1500);

            const resp = await apiFetch('/api/analyze', { method: 'POST', body: fd });
            clearInterval(progressTimer);

            if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 200));

            data = await resp.json();
            if (data.error) throw new Error(data.error);
        } else {
            // ── Direct HF mode (GitHub Pages — no backend) ──
            const _hfProgress = (pct, msg) => {
                setProgress(pct, msg);
                addLog(msg, 'ok');
                if (pct >= 15) setStatus('st-extract', true);
                if (pct >= 50) setStatus('st-narrative', true);
                if (pct >= 65) { setStatus('st-intel', true); setStatus('st-valid', true); }
                if (pct >= 80) { setStatus('st-evidence', true); setStatus('st-consistency', true); }
                if (pct >= 90) setStatus('st-ui', true);
            };

            if (mediaType === 'video') {
                addLog(isHe ? 'מנתח וידאו ישירות בדפדפן (ffmpeg.wasm + HuggingFace)...' : 'Analyzing video directly in browser (ffmpeg.wasm + HuggingFace)...', 'ok');
                setProgress(3, isHe ? 'שלב 1: פירוק וידאו...' : 'Stage 1: decomposing video...');
                data = await HF_CLIENT.analyzeVideo(file, token, _hfProgress, currentLang);
            } else {
                addLog(isHe ? 'מנתח ישירות מול HuggingFace API...' : 'Analyzing directly via HuggingFace API...', 'ok');
                setProgress(10, isHe ? 'שלב 1: חילוץ טקסט...' : 'Stage 1: extracting text...');
                setStatus('st-extract', false);
                data = await HF_CLIENT.analyzeImage(file, url, token, _hfProgress, currentLang);
            }
        }

        if (blossomUrl) {
            data.meta = data.meta || {};
            data.meta.media_url = blossomUrl;
        }

        const analysisLabel = file ? file.name : (url ? url.split('/').pop().slice(0, 40) : 'Analysis');
        await saveToHistory(data, analysisLabel, { mediaType, mediaUrl: blossomUrl });

        window.__file = null;
        $('selectedFile').classList.add('hidden');
        $('fileInput').value = '';

        addLog(isHe ? 'ניתוח הושלם!' : 'Analysis complete!', 'ok');
        setProgress(95, isHe ? 'מציג תוצאות...' : 'Rendering...');
        ['st-extract', 'st-narrative', 'st-intel', 'st-valid', 'st-evidence', 'st-consistency', 'st-ui'].forEach(id => setStatus(id, true));

        await new Promise(r => setTimeout(r, 500));
        setProgress(100, isHe ? 'סיום!' : 'Done!');
        await new Promise(r => setTimeout(r, 400));

        renderResult(data);
        showScreen('result');
    } catch (e) {
        addLog('ERROR: ' + e.message, 'err');
        setProgress(0, isHe ? 'נכשל' : 'Failed');
        alert((isHe ? 'שגיאה: ' : 'Error: ') + e.message);
    }
    $('btnGo').disabled = false;
}

// ═══════════════════════════════════════════════
//  RENDER RESULT — הצגת דוח תוצאות
// ═══════════════════════════════════════════════
function renderResult(data) {
    const ui = data.ui_data || {};
    const metrics = ui.ui_metrics || {};
    const intel = data.intelligence || {};
    const valid = data.validation || {};
    const diagnostics = data.diagnostics || {};
    const isHe = currentLang === 'he';

    const truthScore = metrics.truth_score ?? 0;
    const authScore = metrics.authenticity_score ?? 0;
    const aiProb = metrics.ai_probability ?? 0;
    const narrRaw = metrics.narrative || 'Unclear';
    const riskRaw = metrics.risk_level || 'Low';
    const confLevel = metrics.confidence_level ?? 0;
    const isSatire = !!ui.satire_detected;
    const contentType = ui.content_type || 'factual';
    const factualMode = ui.factual_mode !== false;
    const riskType = ui.risk_type || 'general';
    const riskDetail = ui.risk_detail || '';
    const confReasons = ui.confidence_reasons || [];
    const degradedMode = !!diagnostics.degraded_mode;

    const narr = heT(TR.narrative, narrRaw);
    const risk = heT(TR.risk, riskRaw);

    // ── תצוגת מדיה במסך תוצאות ──
    const resultMedia = $('resultMedia');
    if (resultMedia) {
        resultMedia.innerHTML = '';
        const mUrl = data.meta?.media_url || '';
        const mType = data.meta?.media_type || '';
        if (mUrl && mType === 'video') {
            const vid = document.createElement('video');
            vid.src = mUrl;
            vid.controls = true;
            vid.preload = 'metadata';
            vid.muted = true;
            vid.playsInline = true;
            vid.setAttribute('playsinline', '');
            resultMedia.appendChild(vid);
        } else if (mUrl && mType === 'image') {
            const img = document.createElement('img');
            img.src = mUrl;
            img.alt = 'Analyzed media';
            img.loading = 'lazy';
            resultMedia.appendChild(img);
        }
    }

    // ── TRUTH SCORE ──
    $('m-truth').textContent = factualMode ? truthScore + '%' : '—';
    if (!factualMode) {
        $('m-truth').className = 'mc-value metric-value satire';
        $('m-truth-desc').textContent = isHe ? 'לא רלוונטי — תוכן לא מיועד כדיווח עובדתי' : 'N/A';
    } else {
        $('m-truth').className = 'mc-value metric-value' + (truthScore < 40 ? ' danger' : truthScore < 60 ? ' warn' : '');
        $('m-truth-desc').textContent = truthScore >= 70 ? (isHe ? 'תוכן אמין עובדתית' : 'Reliable') : truthScore >= 40 ? (isHe ? 'אמינות בינונית' : 'Moderate') : (isHe ? 'אמינות נמוכה' : 'Low');
    }

    // ── AUTHENTICITY ──
    $('m-authenticity').textContent = authScore + '%';
    $('m-authenticity').className = 'mc-value metric-value' + (authScore < 40 ? ' danger' : authScore < 60 ? ' warn' : '');
    $('m-authenticity-desc').textContent = authScore >= 70 ? (isHe ? 'תוכן אותנטי' : 'Authentic') : authScore >= 40 ? (isHe ? 'סימני שינוי חלקיים' : 'Partial signs') : (isHe ? 'נחשד כמזויף' : 'Suspected');

    // ── NARRATIVE ──
    $('m-narrative').textContent = narr;
    $('m-narrative').className = 'mc-value metric-value' + (isSatire ? ' satire' : ['Misleading','Propaganda','Misinformation'].includes(narrRaw) ? ' danger' : narrRaw === 'Synthetic' ? ' warn' : '');
    $('m-narrative-desc').textContent = isSatire ? (isHe ? 'בידור' : 'Entertainment') : ['Factual','factual'].includes(narrRaw) ? (isHe ? 'דיווח אובייקטיבי' : 'Objective') : (isHe ? 'דורש בדיקה' : 'Review needed');

    // ── RISK ──
    const riskIsHigh = ['High','high'].includes(riskRaw);
    const riskIsMed = ['Medium','medium'].includes(riskRaw);
    $('m-risk').textContent = risk;
    $('m-risk').className = 'mc-value metric-value' + (riskIsHigh ? ' danger' : riskIsMed ? ' warn' : '');
    $('m-risk-desc').textContent = riskIsHigh ? (isHe ? 'סיכון גבוה' : 'High risk') : riskIsMed ? (isHe ? 'סיכון בינוני' : 'Medium') : (isHe ? 'סיכון נמוך' : 'Low risk');

    // ── AI PROBABILITY ──
    $('m-ai').textContent = aiProb + '%';
    $('m-ai').className = 'mc-value metric-value' + (aiProb > 70 ? ' danger' : aiProb > 30 ? ' warn' : '');
    $('m-ai-desc').textContent = aiProb < 30 ? (isHe ? 'ככל הנראה אנושי' : 'Likely human') : aiProb > 70 ? (isHe ? 'ככל הנראה AI' : 'Likely AI') : (isHe ? 'אותות מעורבים' : 'Mixed');

    // ── CONFIDENCE ──
    $('m-confidence').textContent = confLevel + '%';
    $('m-confidence').className = 'mc-value metric-value' + (confLevel < 40 ? ' trust-low' : confLevel >= 70 ? ' trust-high' : '');
    $('m-confidence-desc').textContent = confLevel >= 70 ? (isHe ? 'ביטחון גבוה' : 'High') : confLevel >= 40 ? (isHe ? 'בינוני' : 'Moderate') : (isHe ? 'ביטחון נמוך' : 'Low');

    // ── TAGS ──
    const tags = ui.ui_tags || [];
    const flags = ui.ui_flags || [];
    let tagsH = '';
    if (degradedMode) {
        tagsH += '<span class="tag tag-yellow">⚠ ' + (isHe ? 'תהליך חלקי: תקלה במודל ויזואלי' : 'Partial flow: visual model issue') + '</span>';
    }
    tags.forEach(t => {
        tagsH += '<span class="tag ' + (isSatire ? 'tag-purple' : 'tag-blue') + '">' + esc(heT(TR.tags, t)) + '</span>';
    });
    flags.forEach(f => { if (f.length <= 60) tagsH += '<span class="tag tag-yellow">⚠ ' + esc(heT(TR.tags, f)) + '</span>'; });
    $('tagsSection').innerHTML = tagsH;

    // ── SUMMARY ──
    const summary = ui.ui_summary || intel.final_assessment || data.output?.summary || '';
    if (degradedMode) {
        const issue = (diagnostics.issues && diagnostics.issues[0]) ? diagnostics.issues[0] : (isHe ? 'כשל בתהליך ויזואלי' : 'Visual flow issue');
        const prefix = isHe ? ('⚠ מצב ניתוח חלקי: ' + issue + '\n\n') : ('⚠ Partial analysis mode: ' + issue + '\n\n');
        $('summaryText').textContent = prefix + (summary || (isHe ? 'אין סיכום זמין' : 'No summary'));
    } else {
        $('summaryText').textContent = summary || (isHe ? 'אין סיכום זמין' : 'No summary');
    }

    document.body.classList.toggle('satire-mode', isSatire);
    document.body.classList.toggle('warning-mode', riskIsHigh && !isSatire);

    // ── Evidence section ──
    const verified = ui.verified_findings || [];
    const removed = ui.removed_claims || [];
    const evSection = $('evidence-section');
    if (verified.length || removed.length) {
        evSection.classList.remove('hidden');
        let vH = '';
        verified.forEach(f => { vH += '<li>' + esc(f) + '</li>'; });
        $('verified-findings').innerHTML = vH || '<li style="color:#6b7d94">' + (isHe ? 'אין' : 'None') + '</li>';
        let rH = '';
        removed.forEach(c => { rH += '<li>' + esc(c) + '</li>'; });
        $('removed-claims').innerHTML = rH || '<li style="color:#6b7d94">' + (isHe ? 'לא הוסרו' : 'None removed') + '</li>';
    } else {
        evSection.classList.add('hidden');
    }

    // ── Intel / Validation / Pipeline ──
    renderIntel(intel);
    renderValidation(valid);
    renderPipeline(data.pipeline || []);
    $('rawJson').textContent = JSON.stringify(data, null, 2);
}

// ═══════════════════════════════════════════════
//  RENDER INTEL — ניתוח מודיעיני
// ═══════════════════════════════════════════════
function renderIntel(intel) {
    if (!intel || !Object.keys(intel).length) {
        $('intelContent').innerHTML = '<p style="color:#6b7d94">—</p>';
        return;
    }
    const isHe = currentLang === 'he';
    let h = '';
    [['final_assessment','Assessment'],['content_type','Narrative'],['recommended_action','Action']].forEach(([k,label]) => {
        if (intel[k] != null) {
            let val = typeof intel[k] === 'number' ? intel[k] + '%' : String(intel[k]);
            if (isHe) val = heT(TR.risk, val) !== val ? heT(TR.risk, val) : heT(TR.narrative, val) !== val ? heT(TR.narrative, val) : val;
            const lbl = isHe ? (TR.intel[label] || label) : label;
            h += '<div class="intel-row"><span class="intel-lbl">' + lbl + '</span><span class="intel-val">' + esc(val) + '</span></div>';
        }
    });
    if (intel.key_signals?.length) {
        h += '<div class="intel-signals"><span>' + (isHe ? 'אותות:' : 'Signals:') + '</span>';
        intel.key_signals.forEach(s => { h += '<span class="tag tag-yellow">' + esc(s) + '</span>'; });
        h += '</div>';
    }
    if (intel.key_findings?.length) {
        h += '<div class="intel-findings"><span>' + (isHe ? 'ממצאים:' : 'Findings:') + '</span><ul class="findings-list">';
        intel.key_findings.forEach(f => { h += '<li>' + esc(f) + '</li>'; });
        h += '</ul></div>';
    }
    $('intelContent').innerHTML = h;
}

// ═══════════════════════════════════════════════
//  RENDER VALIDATION — אימות תוצאות
// ═══════════════════════════════════════════════
function renderValidation(valid) {
    if (!valid || !Object.keys(valid).length) {
        $('validContent').innerHTML = '<p style="color:#6b7d94">—</p>';
        return;
    }
    const isHe = currentLang === 'he';
    let h = '<div class="intel-row"><span class="intel-lbl">' + (isHe ? 'תקף' : 'Valid') + '</span><span class="intel-val" style="color:' + (valid.is_valid ? '#009664' : '#ff5555') + '">' + (valid.is_valid ? '✅' : '❌') + '</span></div>';
    if (valid.issues?.length) {
        h += '<ul class="findings-list">';
        valid.issues.forEach(i => { h += '<li style="color:#b47832">' + esc(i) + '</li>'; });
        h += '</ul>';
    }
    $('validContent').innerHTML = h;
}

// ═══════════════════════════════════════════════
//  RENDER PIPELINE — צינור עיבוד
// ═══════════════════════════════════════════════
function renderPipeline(pipeline) {
    if (!pipeline?.length) { $('pipeContent').innerHTML = ''; return; }
    let h = '';
    pipeline.forEach((s, i) => {
        const name = s.name || s.step || 'Step ' + i;
        const model = s.model || (s.models ? s.models.join(', ') : '');
        const ms = s.duration_ms || 0;
        h += '<div class="pipe-step"><div class="pipe-head">';
        h += '<span class="pipe-name">' + esc(name) + '</span>';
        if (model) h += '<span class="pipe-model">' + esc(model) + '</span>';
        if (ms) h += '<span class="pipe-ms">' + ms + 'ms</span>';
        h += '</div></div>';
    });
    $('pipeContent').innerHTML = h;
}

// ═══════════════════════════════════════════════
//  UTILITY
// ═══════════════════════════════════════════════
function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
