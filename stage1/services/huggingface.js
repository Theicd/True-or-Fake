// Media Analyzer V2 — API Service (calls our backend)
export async function apiAnalyze(token, file, imageUrl) {
    const fd = new FormData();
    fd.append('hf_token', token);
    if (file) {
        fd.append('media', file);
    } else if (imageUrl) {
        fd.append('image_url', imageUrl);
    }
    const resp = await fetch('/api/analyze', { method: 'POST', body: fd });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${text}`);
    }
    return await resp.json();
}

export async function apiHealth() {
    const r = await fetch('/api/health');
    return await r.json();
}
