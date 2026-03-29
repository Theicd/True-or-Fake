// Stage 1 — AI Detection Renderer
import { esc, statusTag, timeTag, modelTag, hasHeb } from '../services/utils.js';

export function renderAI(el, data) {
    if (!data) { el.innerHTML = ''; return; }
    const frames = data.frames || [];
    let h = `<h2>🤖 זיהוי AI`;
    if (data.models) h += ` ${data.models.map(m => modelTag(m)).join(' ')}`;
    h += `</h2>`;

    for (const f of frames) {
        h += `<div class="step"><div class="step-head">`;
        h += `<span class="step-title">${f.module === 'ai_classifier' ? '🔬' : '👁️'} ${esc(f.module)} — Frame ${f.frame_index}</span>`;
        h += `${timeTag(f.duration_ms)} ${statusTag(f.status)} ${modelTag(f.model)}`;
        h += `</div>`;

        if (f.prompt) {
            h += `<details><summary style="color:#e0851e;cursor:pointer;font-size:.82em;font-weight:700">📋 Prompt</summary>`;
            h += `<div class="prompt-box">${esc(f.prompt)}</div></details>`;
        }

        // Classifier highlight
        if (f.module === 'ai_classifier' && typeof f.response === 'object' && f.response.label) {
            const r = f.response;
            const aiPct = Math.round((r.ai_score || 0) * 100);
            const humPct = Math.round((r.human_score || 0) * 100);
            const cls = r.label === 'ai_generated' ? 't-err' : 't-ok';
            h += `<div style="margin:8px 0">`;
            h += `<span class="tag ${cls}" style="font-size:1em;padding:5px 14px">${esc(r.label)}</span> `;
            h += `<span class="tag t-info">AI: ${aiPct}%</span> `;
            h += `<span class="tag t-info">אנושי: ${humPct}%</span>`;
            h += `</div>`;
        }

        const resp = typeof f.response === 'object' ? JSON.stringify(f.response, null, 2) : f.response;
        h += `<div class="blabel">📤 תשובה:</div>`;
        h += `<div class="resp-box${hasHeb(resp) ? ' rtl' : ''}">${esc(resp || '(ריק)')}</div>`;
        h += `</div>`;
    }
    el.innerHTML = h;
}
