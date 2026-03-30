(function initTofNetworkConfig(window) {
    'use strict';

    // Default public infrastructure copied from SOS project.
    // These are active public servers for immediate GitHub Pages operation.
    window.TOF_NETWORK_CONFIG = {
        relayUrls: [
            'wss://relay.snort.social',
            'wss://nos.lol',
            'wss://nostr-relay.xbytez.io',
            'wss://nostr-02.uid.ovh',
        ],
        blossomServers: [
            { url: 'https://files.sovbit.host' },
            { url: 'https://blossom.band', pubkey: 'npub1blossomserver' },
            { url: 'https://blossom.primal.net', pubkey: 'npub1primal' },
            { url: 'https://blossom.nostr.build', pubkey: 'npub1nostrbuild' },
            { url: 'https://nostr.build', pubkey: 'npub1nostrbuild' },
        ],
    };
})(window);
