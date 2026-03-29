// Stage 1 — Speech Transcription Renderer
import { esc, statusTag, timeTag, modelTag, responseBlock, hasHeb } from '../services/utils.js';

export function renderSpeech(el, data) {
    if (!data) { el.innerHTML = ''; return; }
    const segs = data.segments || [];
    const full = data.full_text || '';
    let h = `<h2>🎙️ תמלול דיבור (Whisper)
        ${modelTag(data.model)}
        <span class="tag t-info">${full.length} תווים</span>
        <span class="tag t-info">${segs.length} סגמנטים</span></h2>`;

    if (full) {
        h += `<div class="blabel">📝 טקסט דיבור מלא:</div>`;
        h += `<div class="summary-box">${esc(full)}</div>`;
    } else {
        h += `<div class="tag t-warn" style="margin-top:8px">לא זוהה דיבור</div>`;
    }

    for (const s of segs) {
        h += `<div class="step"><div class="step-head">`;
        h += `<span class="step-title">${esc(s.input || '')}</span>`;
        h += `${timeTag(s.duration_ms)} ${statusTag(s.status)}`;
        if (s.language) h += ` <span class="tag t-info">שפה: ${esc(s.language)}</span>`;
        h += `</div>`;
        h += `<div class="blabel">📤 תוצאה:</div>`;
        h += `<div class="resp-box${hasHeb(s.result) ? ' rtl' : ''}">${esc(s.result || '(ריק)')}</div>`;
        h += `</div>`;
    }
    el.innerHTML = h;
}
