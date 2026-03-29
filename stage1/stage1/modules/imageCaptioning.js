// Stage 1 — Image Captioning Renderer
import { esc, statusTag, timeTag, modelTag, hasHeb } from '../services/utils.js';

export function renderCaptions(el, data) {
    if (!data) { el.innerHTML = ''; return; }
    const frames = data.frames || [];
    let h = `<h2>🖼️ תיאור תמונות (Captioning)
        ${modelTag(data.model)}
        <span class="tag t-info">${frames.length} פריימים</span></h2>`;

    h += `<details style="margin-top:4px"><summary style="color:#e0851e;cursor:pointer;font-size:.84em;font-weight:700">📋 Prompt ששלחנו</summary>`;
    h += `<div class="prompt-box">${esc(data.prompt_used)}</div></details>`;

    for (const f of frames) {
        h += `<div class="step"><div class="step-head">`;
        h += `<span class="step-title">🖼️ Frame ${f.frame_index} (${f.timestamp || f.time_sec + 's'})</span>`;
        h += `${timeTag(f.duration_ms)} ${statusTag(f.status)}`;
        h += `</div>`;
        h += `<div class="blabel">📤 תיאור:</div>`;
        h += `<div class="resp-box${hasHeb(f.response) ? ' rtl' : ''}">${esc(f.response || '(ריק)')}</div>`;
        h += `</div>`;
    }
    el.innerHTML = h;
}
