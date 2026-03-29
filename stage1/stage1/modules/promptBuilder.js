// Stage 1 — Prompts Log Renderer (shows ALL prompts + responses)
import { esc, modelTag, timeTag, statusTag } from '../services/utils.js';

export function renderPromptLog(el, pipeline) {
    if (!pipeline || !pipeline.length) { el.innerHTML = ''; return; }

    let h = `<h2>📋 לוג הנחיות ותשובות (Prompts Log)</h2>`;
    h += `<table class="plog"><thead><tr>`;
    h += `<th>#</th><th>שלב</th><th>מודל</th><th>Prompt</th><th>Response</th><th>זמן</th><th>סטטוס</th>`;
    h += `</tr></thead><tbody>`;

    let row = 0;
    for (const step of pipeline) {
        // Collect all individual calls from this step
        const calls = [];

        // Steps with frames array (OCR, captions, objects, AI)
        if (step.frames) {
            for (const f of step.frames) {
                calls.push({
                    step_name: step.name,
                    model: f.model || step.model || '',
                    prompt: f.prompt || step.prompt_used || step.prompt || '',
                    response: typeof f.response === 'object' ? JSON.stringify(f.response) : (f.response || f.result || ''),
                    ms: f.duration_ms || 0,
                    status: f.status || 'ok',
                });
            }
        }
        // Steps with segments (speech)
        if (step.segments) {
            for (const s of step.segments) {
                calls.push({
                    step_name: step.name,
                    model: s.model || step.model || '',
                    prompt: '(audio bytes)',
                    response: s.result || '',
                    ms: s.duration_ms || 0,
                    status: s.status || 'ok',
                });
            }
        }
        // Steps with answers (reinvestigation)
        if (step.answers) {
            for (const a of step.answers) {
                calls.push({
                    step_name: step.name,
                    model: a.model || '',
                    prompt: a.prompt || a.question || '',
                    response: a.response || '',
                    ms: a.duration_ms || 0,
                    status: 'ok',
                });
            }
        }
        // Single-call steps (questions, summary)
        if (step.response && !step.frames && !step.segments && !step.answers) {
            calls.push({
                step_name: step.name,
                model: step.model || '',
                prompt: step.prompt || '',
                response: step.response || '',
                ms: step.duration_ms || 0,
                status: 'ok',
            });
        }

        for (const c of calls) {
            row++;
            h += `<tr>`;
            h += `<td>${row}</td>`;
            h += `<td>${esc(c.step_name)}</td>`;
            h += `<td style="font-size:.75em">${esc(c.model)}</td>`;
            h += `<td><div class="mini">${esc(trunc(c.prompt, 200))}</div></td>`;
            h += `<td><div class="mini">${esc(trunc(c.response, 200))}</div></td>`;
            h += `<td>${timeTag(c.ms)}</td>`;
            h += `<td>${statusTag(c.status)}</td>`;
            h += `</tr>`;
        }
    }
    h += `</tbody></table>`;
    h += `<div style="margin-top:8px;color:#6b7d94;font-size:.8em">סה"כ ${row} קריאות API. לחץ על prompt/response להרחבה.</div>`;
    el.innerHTML = h;
}

function trunc(s, n) {
    if (!s) return '';
    s = String(s);
    return s.length > n ? s.slice(0, n) + '...' : s;
}
