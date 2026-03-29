// Stage 1 — Questions & Reinvestigation Renderer
import { esc, modelTag, timeTag, hasHeb } from '../services/utils.js';

export function renderQuestions(el, qData, rData) {
    if (!qData && !rData) { el.innerHTML = ''; return; }

    let h = `<h2>🧠 שאלות חקירה ותשובות</h2>`;

    // Questions generation
    if (qData) {
        h += `<div class="blabel">מודל: ${modelTag(qData.model)} ${timeTag(qData.duration_ms)}</div>`;
        h += `<details style="margin-top:6px"><summary style="color:#e0851e;cursor:pointer;font-size:.84em;font-weight:700">📋 Prompt ששלחנו</summary>`;
        h += `<div class="prompt-box">${esc(qData.prompt)}</div>`;
        if (qData.user_input) {
            h += `<div class="blabel">קלט:</div><div class="prompt-box">${esc(qData.user_input)}</div>`;
        }
        h += `</details>`;

        const questions = qData.questions || [];
        h += `<div class="blabel" style="margin-top:10px">🔍 ${questions.length} שאלות שנוצרו:</div>`;
        for (let i = 0; i < questions.length; i++) {
            h += `<div class="q-card"><div class="q-q">${i + 1}. ${esc(questions[i])}</div>`;
            // Find matching answer
            if (rData && rData.answers) {
                const ans = rData.answers[i];
                if (ans) {
                    h += `<div class="blabel">📸 Frame ${ans.frame_index} (${ans.timestamp}) ${timeTag(ans.duration_ms)}</div>`;
                    h += `<div class="q-a ${hasHeb(ans.response) ? 'rtl' : ''}">${esc(ans.response || '(ללא תשובה)')}</div>`;
                    h += `<details style="margin-top:4px"><summary style="color:#6b7d94;cursor:pointer;font-size:.78em">📋 Prompt מלא</summary>`;
                    h += `<div class="prompt-box" style="font-size:.78em">${esc(ans.prompt)}</div></details>`;
                }
            }
            h += `</div>`;
        }
    }

    el.innerHTML = h;
}
