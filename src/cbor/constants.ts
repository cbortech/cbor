// ─── CBOR Major Types ─────────────────────────────────────────────────────────

export const MT_UINT = 0; // Major Type 0: unsigned integer
export const MT_NINT = 1; // Major Type 1: negative integer
export const MT_BYTES = 2; // Major Type 2: byte string
export const MT_TEXT = 3; // Major Type 3: text string
export const MT_ARRAY = 4; // Major Type 4: array
export const MT_MAP = 5; // Major Type 5: map
export const MT_TAG = 6; // Major Type 6: tagged item
export const MT_SIMPLE = 7; // Major Type 7: float / simple value

// ─── Additional Info values ───────────────────────────────────────────────────

export const AI_1BYTE = 24; // argument in next 1 byte
export const AI_2BYTE = 25; // argument in next 2 bytes
export const AI_4BYTE = 26; // argument in next 4 bytes
export const AI_8BYTE = 27; // argument in next 8 bytes
export const AI_INDEFINITE = 31; // indefinite-length / break code

export const BREAK_CODE = 0xff; // 0xff = MT7 ai=31
