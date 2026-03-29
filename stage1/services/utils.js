// Media Analyzer V2 — Utility functions
export const $ = id => document.getElementById(id);

export function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function hasHeb(s) { return /[\u0590-\u05FF]/.test(s); }

export function toggleSection(id, arrowEl) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('collapsed');
    if (arrowEl) arrowEl.classList.toggle('open');
}

export function statusTag(s) {
    const m = { ok: ['t-ok', '✅'], empty: ['t-warn', '⚠️ ריק'],
        error: ['t-err', '❌'], skipped: ['t-warn', '⏭️'], pending: ['t-info', '⏳'] };
    const [c, t] = m[s] || ['t-info', s];
    return `<span class="tag ${c}">${t}</span>`;
}

export function timeTag(ms) {
    return `<span class="tag t-time">${ms}ms</span>`;
}

export function modelTag(model) {
    return `<span class="tag t-info">${esc(model)}</span>`;
}

export function promptBlock(text) {
    return `<div class="blabel">📋 Prompt:</div><div class="prompt-box">${esc(text)}</div>`;
}

export function responseBlock(text) {
    const rtl = hasHeb(text) ? ' rtl' : '';
    return `<div class="blabel">📤 תשובה:</div><div class="resp-box${rtl}">${esc(text)}</div>`;
}

export function detColor(score) {
    const pct = Math.round(score * 100);
    return pct >= 80 ? '#3edc81' : pct >= 60 ? '#e0851e' : '#e04545';
}
