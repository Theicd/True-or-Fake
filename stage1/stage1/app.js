// ═══════════════════════════════════════════════════════════
//  True or Fake — Main App (Production)
//  מנתח אמינות תוכן מדיה מבוסס AI
//  כל הלוגיקה: ניווט, auth, העלאה, ניתוח, היסטוריה, סיור
// ═══════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);

let currentLang = 'he';
let tokenVerified = false;
let currentScreen = 'history';

// ═══════════════════════════════════════════════
//  SHARED HISTORY ENGINE — היסטוריה משותפת מהשרת
// ═══════════════════════════════════════════════
const HISTORY_KEY = 'analyzer_history_v1';
const HISTORY_MAX = 50;

// cache of shared reports loaded from server
let _sharedHistory = null;
let _sharedLoading = false;

async function loadSharedHistory(force = false) {
    if (_sharedHistory && !force) return _sharedHistory;
    if (_sharedLoading) return _sharedHistory || [];
    _sharedLoading = true;
    try {
        const r = await fetch('/api/reports?limit=50');
        if (r.ok) {
            const data = await r.json();
            _sharedHistory = data.reports || [];
        }
    } catch (e) {
        // fallback to local if server unreachable
        _sharedHistory = getLocalHistory();
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

async function saveToHistory(data, fileName) {
    const ui = data.ui_data || {};
    const metrics = ui.ui_metrics || {};
    const entry = {
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        date: new Date().toISOString(),
        fileName: fileName || 'Unknown',
        mediaType: data.meta?.media_type || 'unknown',
        truthScore: metrics.truth_score ?? 0,
        authenticity: metrics.authenticity_score ?? 0,
        narrative: metrics.narrative || 'Unclear',
        riskLevel: metrics.risk_level || 'Low',
        confidence: metrics.confidence_level ?? 0,
        isSatire: !!(ui.satire_detected),
        summary: (ui.ui_summary || '').slice(0, 200),
        fullData: data,
    };

    // ── שמירה לשרת (היסטוריה משותפת) ──
    const token = ($('token') && $('token').value.trim()) || '';
    if (token) {
        try {
            const fd = new FormData();
            fd.append('hf_token', token);
            fd.append('data', JSON.stringify(entry));
            // send entry JSON as request body
            await fetch('/api/reports/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...entry, hf_token_hint: token }),
            });
        } catch (e) { /* silent — still save locally */ }
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
        const r = await fetch('/api/reports/' + reportId, {
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
        const icon = heroItem.mediaType === 'video' ? '📺' : heroItem.mediaType === 'image' ? '📸' : '📄';
        $('heroBadge').textContent = icon;
        $('heroScore').textContent = heroItem.truthScore + '%';
        $('heroScore').className = 'hero-score ' + (heroItem.truthScore >= 60 ? '' : heroItem.truthScore >= 35 ? 'score-med' : 'score-low');
        $('heroNarrative').textContent = isHe ? heT(TR.narrative, heroItem.narrative) : heroItem.narrative;
        $('heroTitle').textContent = heroItem.fileName;
        $('heroTrustState').textContent = truthStateLabel(heroItem.truthScore, isHe);
        $('heroThreat').textContent = riskLabel(heroItem.riskLevel, isHe);
        const d = new Date(heroItem.date);
        $('heroDate').textContent = d.toLocaleDateString('he-IL', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
        heroCard.onclick = async () => {
            let fd = heroItem.fullData;
            if (!fd) {
                // load full data from server
                try {
                    const r = await fetch('/api/reports/' + heroItem.id);
                    if (r.ok) { const rd = await r.json(); fd = rd.fullData; }
                } catch (e) { /* no full data */ }
            }
            if (fd) { renderResult(fd); showScreen('result'); }
        };
    }

    // ── כרטיסי היסטוריה ──
    let h = '';
    history.forEach((item, idx) => {
        if (idx === 0 && item === heroItem) return; // skip hero
        const icon = item.mediaType === 'video' ? '📺' : item.mediaType === 'image' ? '📸' : '📄';
        const dateStr = new Date(item.date).toLocaleDateString('he-IL', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
        const score = item.truthScore;
        const scoreClass = score >= 60 ? 's-high' : score >= 35 ? 's-med' : 's-low';
        const riskClass = riskTone(item.riskLevel);
        const riskText = riskLabel(item.riskLevel, isHe);
        const narr = isHe ? heT(TR.narrative, item.narrative) : item.narrative;
        const isOwner = myPrefix && item.owner === myPrefix;

        h += `<div class="history-item" data-report-id="${esc(item.id)}" data-history-idx="${idx}">`;
        h += `<div class="hi-icon">${icon}</div>`;
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
            let fd = item.fullData;
            if (!fd) {
                try {
                    const r = await fetch('/api/reports/' + item.id);
                    if (r.ok) { const rd = await r.json(); fd = rd.fullData; }
                } catch (e) { /* no full data */ }
            }
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
        const fd = new FormData();
        fd.append('hf_token', token);
        const r = await fetch('/api/verify-token', { method: 'POST', body: fd });
        const data = await r.json();
        if (data.ok) {
            tokenVerified = true;
            const userName = data.name || 'User';
            localStorage.setItem('hf_verified', 'true');
            localStorage.setItem('hf_user', userName);
            showStatus('tokenStatus', 'ok', (isHe ? '✅ מפתח תקין — ' : '✅ Valid — ') + userName);
            updateAuthUI(true, userName);
            // ── סגירת מודאל אוטומטית אחרי הצלחה ──
            setTimeout(closeAuthModal, 1200);
        } else {
            tokenVerified = false;
            localStorage.removeItem('hf_verified');
            showStatus('tokenStatus', 'err', isHe ? '❌ מפתח לא תקין' : '❌ Invalid token');
        }
    } catch (e) {
        tokenVerified = false;
        showStatus('tokenStatus', 'err', isHe ? '❌ שגיאת רשת' : '❌ Network error');
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
    sf.textContent = '📎 ' + file.name + ' (' + sizeMB + ' MB)';
    sf.classList.remove('hidden');
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

    $('btnGo').disabled = true;
    showScreen('process');
    $('logsBox').innerHTML = '';
    ['st-extract', 'st-narrative', 'st-intel', 'st-valid', 'st-evidence', 'st-consistency', 'st-ui'].forEach(id => setStatus(id, false));

    const label = file ? file.name : 'URL';
    addLog(isHe ? 'מתחיל ניתוח: ' + label : 'Starting analysis: ' + label);
    setProgress(5, isHe ? 'מעלה מדיה...' : 'Uploading media...');

    try {
        const fd = new FormData();
        fd.append('hf_token', token);
        if (file) fd.append('media', file);
        else fd.append('image_url', url);

        addLog(isHe ? 'שולח לשרת...' : 'Sending to server...');
        setProgress(10, isHe ? 'שלב 1-2: חילוץ נתונים...' : 'Stage 1-2: extracting...');

        let fakePct = 5;
        const shown = {};
        const progressTimer = setInterval(() => {
            if (fakePct < 85) {
                const speed = fakePct < 30 ? 2 + Math.random() * 2 : fakePct < 60 ? 1 + Math.random() * 1.5 : 0.5 + Math.random();
                fakePct = Math.min(85, fakePct + speed);
                setProgress(fakePct);
                // ── שלבי הפייפליין ──
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

        const resp = await fetch('/api/analyze', { method: 'POST', body: fd });
        clearInterval(progressTimer);

        if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 200));

        const data = await resp.json();
        if (data.error) throw new Error(data.error);

        const analysisLabel = file ? file.name : (url ? url.split('/').pop().slice(0, 40) : 'Analysis');
        await saveToHistory(data, analysisLabel);

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

    // ── Research / Intel / Validation / Pipeline ──
    renderResearch(ui.research || data.research || {});
    renderIntel(intel);
    renderValidation(valid);
    renderPipeline(data.pipeline || []);
    $('rawJson').textContent = JSON.stringify(data, null, 2);
}

// ═══════════════════════════════════════════════
//  RENDER REALITY CHECK — הצלבת מציאות
// ═══════════════════════════════════════════════
function renderResearch(research) {
    const section = $('research-section');
    const content = $('researchContent');
    if (!research || (!research.claims?.length && !research.verified?.length && !research.contradicted?.length && !research.unverified?.length && !research.verification_results?.length)) {
        section.classList.add('hidden');
        return;
    }
    section.classList.remove('hidden');
    const isHe = currentLang === 'he';
    let h = '';

    // ── Reliability Bar ──
    const rel = research.reliability || {};
    if (rel.final_reliability > 0) {
        const relColor = rel.final_reliability >= 60 ? '#22c55e' : rel.final_reliability >= 35 ? '#f59e0b' : '#ef4444';
        h += '<div class="rel-bar"><div class="rel-header">';
        h += '<span class="rel-title">' + (isHe ? '🛡️ אמינות כוללת' : '🛡️ Reliability') + '</span>';
        h += '<span class="rel-score" style="color:' + relColor + '">' + Math.round(rel.final_reliability) + '%</span>';
        h += '</div>';
        h += '<div class="rel-track"><div class="rel-fill" style="width:' + rel.final_reliability + '%;background:' + relColor + '"></div></div>';
        h += '<div class="rel-details">';
        h += '<span>' + (isHe ? 'תוכן: ' : 'Content: ') + '<strong>' + Math.round(rel.content_reliability || 0) + '%</strong></span>';
        h += '<span>' + (isHe ? 'מקור: ' : 'Source: ') + '<strong>' + Math.round(rel.source_reliability || 0) + '%</strong></span>';
        h += '<span>' + (isHe ? 'אימות: ' : 'Verify: ') + '<strong>' + Math.round(rel.verification_score || 0) + '%</strong></span>';
        h += '</div></div>';
    }

    // ── Claims ──
    if (research.claims?.length) {
        h += '<div class="rce-section"><span class="rce-label">' + (isHe ? '📝 טענות:' : '📝 Claims:') + '</span>';
        h += '<div class="rce-tags">';
        research.claims.forEach(c => { h += '<span class="tag tag-blue">' + esc(c) + '</span>'; });
        h += '</div></div>';
    }

    function _verifyItem(v, color) {
        const claim = typeof v === 'object' ? v.claim : v;
        const evidence = typeof v === 'object' ? (v.evidence || v.reason || '') : '';
        const conf = typeof v === 'object' ? v.confidence : null;
        let li = '<li style="color:' + color + '"><strong>' + esc(claim) + '</strong>';
        if (conf != null) li += ' <span class="conf-badge">' + conf + '%</span>';
        if (evidence) li += '<br><span class="ev-text">' + esc(evidence) + '</span>';
        li += '</li>';
        return li;
    }

    if (research.verified?.length) {
        h += '<div class="rce-section"><h4 style="color:#009664">✅ ' + (isHe ? 'אומתו' : 'Verified') + ' (' + research.verified.length + ')</h4>';
        h += '<ul class="findings-list">';
        research.verified.forEach(v => { h += _verifyItem(v, '#009664'); });
        h += '</ul></div>';
    }
    if (research.partially_verified?.length) {
        h += '<div class="rce-section"><h4 style="color:#f59e0b">🔶 ' + (isHe ? 'חלקית' : 'Partial') + ' (' + research.partially_verified.length + ')</h4>';
        h += '<ul class="findings-list">';
        research.partially_verified.forEach(v => { h += _verifyItem(v, '#f59e0b'); });
        h += '</ul></div>';
    }
    if (research.contradicted?.length) {
        h += '<div class="rce-section"><h4 style="color:#ff5555">❌ ' + (isHe ? 'נסתרו' : 'Contradicted') + ' (' + research.contradicted.length + ')</h4>';
        h += '<ul class="findings-list">';
        research.contradicted.forEach(c => { h += _verifyItem(c, '#ff5555'); });
        h += '</ul></div>';
    }
    const notVerified = research.not_verified?.length ? research.not_verified : research.unverified || [];
    if (notVerified.length) {
        h += '<div class="rce-section"><h4 style="color:#b47832">⚠ ' + (isHe ? 'לא אומתו' : 'Unverified') + ' (' + notVerified.length + ')</h4>';
        h += '<ul class="findings-list">';
        notVerified.forEach(u => { h += _verifyItem(u, '#b47832'); });
        h += '</ul></div>';
    }

    // ── Context ──
    if (research.context_summary) {
        h += '<div class="rce-context">';
        h += '<strong>' + (isHe ? '🧠 הקשר:' : '🧠 Context:') + '</strong> ' + esc(research.context_summary);
        h += '</div>';
    }

    // ── Questions ──
    if (research.questions?.length) {
        h += '<details class="rce-details"><summary>' + (isHe ? '❓ שאלות חקירה (' + research.questions.length + ')' : '❓ Questions (' + research.questions.length + ')') + '</summary>';
        h += '<ul class="findings-list">';
        research.questions.forEach(q => {
            const qText = typeof q === 'object' ? q.question : q;
            h += '<li style="color:#8aa0b3">' + esc(qText) + '</li>';
        });
        h += '</ul></details>';
    }

    // ── Stats ──
    const total = (research.verified?.length || 0) + (research.contradicted?.length || 0) + (research.partially_verified?.length || 0) + (research.not_verified?.length || 0) || ((research.verified?.length || 0) + (research.contradicted?.length || 0) + (research.unverified?.length || 0));
    if (total > 0) {
        h += '<div class="rce-stats">' + (isHe ? 'סה"כ: ' : 'Total: ') + total + (isHe ? ' טענות נבדקו' : ' checked') + '</div>';
    }

    content.innerHTML = h;
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
