export const PROTOCOL_VERSION = 1;

// Google public STUN only. No TURN: no server ever relays our traffic.
export const ICE_SERVERS = [
  {
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:stun3.l.google.com:19302',
      'stun:stun4.l.google.com:19302',
    ],
  },
];

// Free public Nostr relays, used for signaling (handshake) only.
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://nostr.mom',
];

// Ephemeral event kind range (20000-29999): relays do not store these.
export const NOSTR_KIND = 25133; // app-specific ephemeral kind

export const PAIR_CODE_PREFIX = 'NRD1-';
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
export const SIGNAL_MAX_AGE_S = 120;
export const OFFER_TIMEOUT_MS = 30_000;
export const ICE_GATHER_TIMEOUT_MS = 4_000;
export const HEARTBEAT_MS = 15_000;
export const PEER_TIMEOUT_MS = 45_000;
export const PENDING_TRANSFER_TTL_MS = 5 * 60 * 1000;
export const NOTE_TTL_MS = 15 * 60 * 1000; // notes live in memory only
export const HISTORY_MAX = 50; // received-tab history (URLs/titles only)

export const LIMITS = {
  relayMessageBytes: 64 * 1024,
  frameChunkBytes: 32 * 1024,
  messageBytes: 16 * 1024 * 1024,
  tabsPerTransfer: 50,
  urlLength: 8192,
  titleLength: 1024,
  cookiesPerTab: 300,
  cookieValueLength: 8192,
  storageItemsPerArea: 2000,
  storageValueLength: 1024 * 1024,
  deviceName: 64,
  noteLength: 16 * 1024,
  relays: 12,
};
