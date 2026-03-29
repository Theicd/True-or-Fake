// Stage 1 — Meta + Summary Renderers
import { esc, hasHeb } from '../services/utils.js';

export function renderMeta(el, meta, totalMs) {
    if (!meta) { el.innerHTML = ''; return; }
    let h = `<h2>📊 מידע בסיסי`;
    if (totalMs) h += ` <span class="tag t-time">סה"כ ${(totalMs / 1000).toFixed(1)}s</span>`;
    h += `</h2><div class="meta-grid">`;
    h += mi('סוג', meta.media_type === 'video' ? '🎬 וידאו' : '🖼️ תמונה');
    h += mi('גודל', (meta.file_size_kb || 0) + ' KB');
    if (meta.duration_sec) h += mi('אורך', meta.duration_sec + ' שניות');
    if (meta.frames_extracted != null) h += mi('פריימים שחולצו', meta.frames_extracted);
    if (meta.scene_changes != null) h += mi('שינויי סצנה', meta.scene_changes);
    if (meta.selected_frame_times) h += mi('פריימים נבחרים', meta.selected_frame_times.length);
    h += mi('אודיו', meta.audio_extracted ? '✅' : '❌');
    if (meta.audio_segments) h += mi('סגמנטי אודיו', meta.audio_segments);
    h += mi('SHA256', (meta.sha256 || '').slice(0, 16) + '...');
    h += `</div>`;

    if (meta.scene_change_times && meta.scene_change_times.length) {
        h += `<div class="blabel" style="margin-top:10px">🎬 זמני שינוי סצנה:</div>`;
        h += `<div class="det-grid">`;
        for (const t of meta.scene_change_times) {
            h += `<span class="det-item" style="background:#4da6ff18;color:#4da6ff;border:1px solid #4da6ff35">${fmtTime(t)}</span>`;
        }
        h += `</div>`;
    }
    if (meta.selected_frame_times && meta.selected_frame_times.length) {
        h += `<div class="blabel" style="margin-top:6px">📸 זמני פריימים נבחרים:</div>`;
        h += `<div class="det-grid">`;
        for (const t of meta.selected_frame_times) {
            h += `<span class="det-item" style="background:#3edc8118;color:#3edc81;border:1px solid #3edc8135">${fmtTime(t)}</span>`;
        }
        h += `</div>`;
    }
    el.innerHTML = h;
}

export function renderSummary(el, sumData, output) {
    let h = `<h2>📦 סיכום Stage 1</h2>`;

    if (sumData && sumData.summary_text) {
        h += `<div class="blabel">מודל: <span class="tag t-info">${esc(sumData.model)}</span> <span class="tag t-time">${sumData.duration_ms}ms</span></div>`;
        h += `<details style="margin-top:6px"><summary style="color:#e0851e;cursor:pointer;font-size:.84em;font-weight:700">📋 Prompt</summary>`;
        h += `<div class="prompt-box">${esc(sumData.prompt)}</div></details>`;
        h += `<div class="summary-box">${esc(sumData.summary_text)}</div>`;
    }

    if (output) {
        h += `<div class="blabel" style="margin-top:14px">📊 סטטיסטיקות:</div>`;
        h += `<div class="meta-grid">`;
        h += mi('דיבור', (output.speech_text || '').length + ' תווים');
        h += mi('OCR', (output.ocr_text || '').length + ' תווים');
        h += mi('טקסט מאוחד', (output.merged_text || '').length + ' תווים');
        h += mi('שאלות', (output.questions || []).length);
        h += mi('תשובות', (output.answers || []).length);
        h += mi('פריימים', (output.frames || []).length);
        h += `</div>`;
    }
    el.innerHTML = h;
}

function mi(label, value) {
    return `<div class="meta-item"><div class="meta-lbl">${label}</div><div class="meta-val">${esc(String(value))}</div></div>`;
}

function fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
