// Stage 1 — Object Detection Renderer
import { esc, statusTag, timeTag, modelTag, detColor } from '../services/utils.js';

export function renderObjects(el, data) {
    if (!data) { el.innerHTML = ''; return; }
    const frames = data.frames || [];
    const uniq = data.unique_objects || [];
    let h = `<h2>🔍 זיהוי אובייקטים (DETR)
        ${modelTag(data.model)}
        <span class="tag t-info">${uniq.length} סוגים</span>
        <span class="tag t-info">${frames.length} פריימים</span></h2>`;

    if (uniq.length) {
        h += `<div class="det-grid">`;
        for (const o of uniq) {
            const pct = Math.round(o.score * 100);
            const c = detColor(o.score);
            h += `<span class="det-item" style="background:${c}18;color:${c};border:1px solid ${c}35">${esc(o.label)} ${pct}%</span>`;
        }
        h += `</div>`;
    }

    for (const f of frames) {
        const dets = f.detections || [];
        h += `<div class="step"><div class="step-head">`;
        h += `<span class="step-title">🖼️ Frame ${f.frame_index} (${f.timestamp || f.time_sec + 's'})</span>`;
        h += `${timeTag(f.duration_ms)} <span class="tag t-info">${dets.length} זיהויים</span> ${statusTag(f.status)}`;
        h += `</div>`;
        if (dets.length) {
            h += `<div class="det-grid">`;
            for (const d of dets) {
                const pct = Math.round((d.score || 0) * 100);
                const c = detColor(d.score || 0);
                h += `<span class="det-item" style="background:${c}18;color:${c};border:1px solid ${c}35">${esc(d.label)} ${pct}%</span>`;
            }
            h += `</div>`;
        }
        h += `</div>`;
    }
    el.innerHTML = h;
}
