(function initTrueOrFakeNet(window){
    'use strict';

    const App = window.TrueOrFakeNet || (window.TrueOrFakeNet = {});
    const USER_CFG = window.TOF_NETWORK_CONFIG || {};

    const DEFAULT_RELAYS = [
        'wss://relay.damus.io',
        'wss://relay.snort.social',
        'wss://nos.lol',
        'wss://purplerelay.com',
        'wss://relay.nostr.band',
    ];

    const DEFAULT_BLOSSOM_SERVERS = [
        { url: 'https://blossom.band' },
    ];

    const STORAGE_RELAY_KEY = 'tof_relay_urls';
    const STORAGE_BLOSSOM_KEY = 'tof_blossom_servers';

    let relayUrls = [];
    let blossomServers = [];

    function bytesToHex(arr) {
        return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    function hexToBytes(hex) {
        const clean = (hex || '').trim().replace(/^0x/, '');
        if (clean.length % 2 !== 0) throw new Error('Invalid hex length');
        const out = new Uint8Array(clean.length / 2);
        for (let i = 0; i < clean.length; i += 2) out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
        return out;
    }

    function normalizePrivateKey(raw) {
        if (!raw) return null;
        let key = String(raw).trim();
        if (key.startsWith('0x')) key = key.slice(2);
        if (!/^[0-9a-fA-F]{64}$/.test(key)) return null;
        return key.toLowerCase();
    }

    function getNostrTools() {
        return window.NostrTools || null;
    }

    function getStoredKey() {
        return normalizePrivateKey(window.localStorage.getItem('nostr_private_key'));
    }

    function setStoredKey(key) {
        window.localStorage.setItem('nostr_private_key', key);
    }

    function fixUrl(u) {
        return typeof u === 'string' && u.includes('/net/') ? u.replace('/net/', '.net/') : u;
    }

    function isValidUrl(u) {
        try { new URL(fixUrl(u)); return true; } catch { return false; }
    }

    function normalizeRelayUrls(list) {
        return (Array.isArray(list) ? list : [])
            .map(x => String(x || '').trim())
            .map(fixUrl)
            .filter(isValidUrl);
    }

    function normalizeBlossomServers(list) {
        return (Array.isArray(list) ? list : [])
            .map(x => typeof x === 'string' ? { url: x } : x)
            .map(x => ({ url: fixUrl(String((x && x.url) || '').trim()) }))
            .filter(x => isValidUrl(x.url));
    }

    function readJsonStorage(key) {
        try { return JSON.parse(window.localStorage.getItem(key) || 'null'); }
        catch (_) { return null; }
    }

    function saveNetworkConfig() {
        try {
            window.localStorage.setItem(STORAGE_RELAY_KEY, JSON.stringify(relayUrls));
            window.localStorage.setItem(STORAGE_BLOSSOM_KEY, JSON.stringify(blossomServers));
        } catch (_) {
            // ignore storage quota errors
        }
    }

    function initNetworkConfig() {
        const fromStorageRelays = normalizeRelayUrls(readJsonStorage(STORAGE_RELAY_KEY));
        const fromStorageBlossom = normalizeBlossomServers(readJsonStorage(STORAGE_BLOSSOM_KEY));
        const fromUserRelays = normalizeRelayUrls(USER_CFG.relayUrls);
        const fromUserBlossom = normalizeBlossomServers(USER_CFG.blossomServers);

        // Explicit config file has highest priority for deterministic deployments.
        relayUrls = fromUserRelays.length
            ? fromUserRelays
            : (fromStorageRelays.length ? fromStorageRelays : DEFAULT_RELAYS);

        blossomServers = fromUserBlossom.length
            ? fromUserBlossom
            : (fromStorageBlossom.length ? fromStorageBlossom : DEFAULT_BLOSSOM_SERVERS);

        saveNetworkConfig();
    }

    function getRelayUrls() {
        return [...relayUrls];
    }

    function getBlossomServers() {
        return blossomServers.map(x => ({ ...x }));
    }

    function setRelayUrls(list) {
        const normalized = normalizeRelayUrls(list);
        if (!normalized.length) throw new Error('invalid-relay-list');
        relayUrls = normalized;
        saveNetworkConfig();
        return getRelayUrls();
    }

    function setBlossomServers(list) {
        const normalized = normalizeBlossomServers(list);
        if (!normalized.length) throw new Error('invalid-blossom-list');
        blossomServers = normalized;
        saveNetworkConfig();
        return getBlossomServers();
    }

    async function ensureKeys() {
        const nt = getNostrTools();
        if (!nt || typeof nt.getPublicKey !== 'function') throw new Error('nostr-tools-not-ready');

        let privateKey = getStoredKey();
        if (!privateKey) {
            if (typeof nt.generateSecretKey !== 'function') throw new Error('generate-secret-key-missing');
            const generated = nt.generateSecretKey();
            privateKey = Array.isArray(generated) || generated instanceof Uint8Array ? bytesToHex(generated) : String(generated);
            privateKey = normalizePrivateKey(privateKey);
            if (!privateKey) throw new Error('failed-to-generate-private-key');
            setStoredKey(privateKey);
        }

        const publicKey = nt.getPublicKey(privateKey);
        App.privateKey = privateKey;
        App.publicKey = publicKey;
        return { privateKey, publicKey };
    }

    async function sha256Hex(blob) {
        const buf = await blob.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', buf);
        return bytesToHex(new Uint8Array(hash));
    }

    async function createAuthEvent(verb, content, sha256) {
        const nt = getNostrTools();
        if (!nt || typeof nt.finalizeEvent !== 'function') throw new Error('missing-finalize-event');
        const { privateKey, publicKey } = await ensureKeys();

        const now = Math.floor(Date.now() / 1000);
        const tags = [['t', verb], ['expiration', String(now + 24 * 3600)]];
        if (sha256 && (verb === 'upload' || verb === 'delete')) tags.push(['x', sha256]);

        const draft = { kind: 24242, content, tags, created_at: now, pubkey: publicKey };
        return nt.finalizeEvent(draft, privateKey);
    }

    async function uploadToBlossom(blob) {
        const hash = await sha256Hex(blob);
        const auth = await createAuthEvent('upload', 'Upload true-or-fake media', hash);
        const header = 'Nostr ' + btoa(JSON.stringify(auth));

        for (const s of blossomServers) {
            const base = fixUrl(s.url);
            if (!isValidUrl(base)) continue;
            try {
                const url = new URL('/upload', base).toString();
                const res = await fetch(url, {
                    method: 'PUT',
                    body: blob,
                    headers: {
                        'Content-Type': blob.type || 'application/octet-stream',
                        'Content-Length': String(blob.size || 0),
                        'Accept': 'application/json',
                        'Authorization': header,
                        'Origin': window.location.origin,
                    },
                    mode: 'cors',
                    credentials: 'omit',
                });

                if (!res.ok) continue;
                const data = await res.json();
                if (!data || !data.url) continue;
                if (data.sha256 && data.sha256 !== hash) continue;
                return fixUrl(data.url);
            } catch (_) {
                // try next server
            }
        }

        throw new Error('blossom-upload-failed');
    }

    function getPool() {
        const nt = getNostrTools();
        if (!nt || typeof nt.SimplePool !== 'function') throw new Error('nostr-pool-unavailable');
        if (!App._pool) App._pool = new nt.SimplePool();
        return App._pool;
    }

    async function publishReport(report) {
        const nt = getNostrTools();
        if (!nt || typeof nt.finalizeEvent !== 'function') throw new Error('finalize-event-unavailable');
        const { privateKey, publicKey } = await ensureKeys();

        const now = Math.floor(Date.now() / 1000);
        const content = JSON.stringify({
            app: 'true-or-fake',
            type: 'analysis-report',
            created_at: now,
            report,
        });

        const draft = {
            kind: 1,
            created_at: now,
            content,
            pubkey: publicKey,
            tags: [
                ['t', 'true-or-fake'],
                ['t', 'analysis-report'],
                ['client', 'true-or-fake-web'],
            ],
        };

        const signed = nt.finalizeEvent(draft, privateKey);
        const pool = getPool();
        await Promise.any(pool.publish(relayUrls, signed));
        return signed.id;
    }

    async function publishTextPost(text, extraTags) {
        const nt = getNostrTools();
        if (!nt || typeof nt.finalizeEvent !== 'function') throw new Error('finalize-event-unavailable');
        const { privateKey, publicKey } = await ensureKeys();

        const tags = [
            ['t', 'true-or-fake'],
            ['t', 'analysis-text'],
            ['client', 'true-or-fake-web'],
        ];
        (extraTags || []).forEach(t => {
            if (Array.isArray(t) && t.length >= 2) tags.push([String(t[0]), String(t[1])]);
        });

        const event = nt.finalizeEvent({
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content: String(text || '').slice(0, 4000),
            pubkey: publicKey,
        }, privateKey);

        const pool = getPool();
        await Promise.any(pool.publish(relayUrls, event));
        return event.id;
    }

    async function publishComment(parentEventId, text) {
        const nt = getNostrTools();
        if (!nt || typeof nt.finalizeEvent !== 'function') throw new Error('finalize-event-unavailable');
        const { privateKey, publicKey } = await ensureKeys();

        const event = nt.finalizeEvent({
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['t', 'true-or-fake'],
                ['t', 'analysis-comment'],
                ['e', String(parentEventId || ''), '', 'reply'],
                ['p', publicKey],
                ['client', 'true-or-fake-web'],
            ],
            content: String(text || '').slice(0, 1000),
            pubkey: publicKey,
        }, privateKey);

        const pool = getPool();
        await Promise.any(pool.publish(relayUrls, event));
        return event.id;
    }

    async function loadComments(parentEventId, limit = 50) {
        if (!parentEventId) return [];
        try {
            const pool = getPool();
            const events = await pool.querySync(relayUrls, {
                kinds: [1],
                '#e': [parentEventId],
                '#t': ['analysis-comment'],
                limit,
            });
            return (events || [])
                .sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
                .map(ev => ({
                    id: ev.id,
                    pubkey: ev.pubkey,
                    content: ev.content,
                    created_at: ev.created_at,
                }));
        } catch (_) {
            return [];
        }
    }

    async function publishProfile(displayName) {
        const nt = getNostrTools();
        if (!nt || typeof nt.finalizeEvent !== 'function') throw new Error('finalize-event-unavailable');
        const { privateKey, publicKey } = await ensureKeys();

        const profile = {
            name: (displayName || 'TrueOrFake User').slice(0, 64),
            about: 'True or Fake user profile',
            display_name: (displayName || 'TrueOrFake User').slice(0, 64),
        };

        const event = nt.finalizeEvent({
            kind: 0,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['client', 'true-or-fake-web']],
            content: JSON.stringify(profile),
            pubkey: publicKey,
        }, privateKey);

        const pool = getPool();
        await Promise.any(pool.publish(relayUrls, event));
        return event.id;
    }

    async function loadRelayReports(limit = 25) {
        const nt = getNostrTools();
        if (!nt) return [];
        try {
            const pool = getPool();
            const events = await pool.querySync(relayUrls, {
                kinds: [1],
                '#t': ['analysis-report'],
                limit,
            });

            const out = [];
            for (const ev of (events || [])) {
                try {
                    const parsed = JSON.parse(ev.content || '{}');
                    if (parsed.app !== 'true-or-fake' || parsed.type !== 'analysis-report' || !parsed.report) continue;
                    const report = parsed.report;
                    out.push({
                        ...report,
                        relay_saved: true,
                        relay_event_id: ev.id,
                        owner: String(ev.pubkey || '').slice(0, 14),
                    });
                } catch (_) {
                    // invalid event format
                }
            }

            return out.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
        } catch (_) {
            return [];
        }
    }

    initNetworkConfig();

    Object.assign(App, {
        relayUrls,
        blossomServers,
        getRelayUrls,
        getBlossomServers,
        setRelayUrls,
        setBlossomServers,
        ensureKeys,
        uploadToBlossom,
        publishReport,
        publishTextPost,
        publishComment,
        loadComments,
        publishProfile,
        loadRelayReports,
    });

    // Keep exposed arrays in sync for external code.
    Object.defineProperty(App, 'relayUrls', {
        get: getRelayUrls,
        set: setRelayUrls,
        configurable: true,
    });
    Object.defineProperty(App, 'blossomServers', {
        get: getBlossomServers,
        set: setBlossomServers,
        configurable: true,
    });
})(window);
