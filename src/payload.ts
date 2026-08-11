// Pure payload-mapping core for the PlaiiinLightOS Node-RED palette.
//
// No Node-RED / MQTT dependencies here — this module only translates
// between friendly Node-RED values and the exact wire payloads the
// firmware's MQTT bridge expects/publishes.
//
// Firmware reference: lampos/main/plaiiin_mqtt.c
//   - color/set payload is HSV "h,s,v" (H 0-360, S 0-100, V 0-100), NOT rgb
//     (plaiiin_mqtt.c:113-128 parses it with hsv_to_rgb()).
//   - color/get publishes the same HSV "h,s,v" format, produced by
//     rgb_to_hsv() from the base color (plaiiin_mqtt.c:278-287).
//   - power/set|get is "0"|"1"; brightness/set|get is "0".."255"; mode/set
//     accepts "color"|"js" (internal "api" is surfaced to MQTT as "color");
//     status is the LWT topic, retained "online" (connect) / "offline" (LWT).
//
// The rgb<->hsv conversions below are a deliberate line-for-line port of
// hsv_to_rgb()/rgb_to_hsv() in plaiiin_mqtt.c (same float math, same
// "+0.5 then truncate" rounding), not just "a" rgb<->hsv formula — this
// keeps round-trips (rgb -> hsv -> rgb) stable and keeps this package's
// idea of a color bit-identical to what the lamp itself computes.

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadError';
  }
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface HSV {
  h: number;
  s: number;
  v: number;
}

export interface ColorState extends HSV, RGB {
  hex: string;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// Mirrors the firmware's `(uint8_t)(x + 0.5f)` truncating cast — since every
// value going through this is non-negative, floor(x + 0.5) is a round-half-up
// that matches the C cast exactly (and matches for the .5 boundaries the
// firmware itself can produce).
function roundHalfUp(n: number): number {
  return Math.floor(n + 0.5);
}

function clampByte(n: number): number {
  return clamp(Math.round(n), 0, 255);
}

// Guards a numeric field before it reaches clamp()/rounding — clamp() would
// otherwise silently let NaN/Infinity through into the output payload
// instead of failing loud, unlike every other invalid-input path in this
// module (see brightnessToPayload). Only non-finite values throw; a legit
// out-of-range finite number (e.g. h: 999) still clamps as before.
function requireFinite(name: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new PayloadError(`Invalid ${name}: ${value}`);
  }
  return value;
}

// --- rgb <-> hsv, ported from lampos/main/plaiiin_mqtt.c ---

export function hsvToRgb(h: number, s: number, v: number): RGB {
  requireFinite('h', h);
  requireFinite('s', s);
  requireFinite('v', v);
  h = clamp(h, 0, 360);
  s = clamp(s, 0, 100);
  v = clamp(v, 0, 100);

  const sf = s / 100;
  const vf = v / 100;
  const c = vf * sf;
  const hf = h / 60;
  const x = c * (1 - Math.abs((hf % 2) - 1));
  const m = vf - c;

  let rf: number;
  let gf: number;
  let bf: number;
  if (hf < 1) {
    rf = c; gf = x; bf = 0;
  } else if (hf < 2) {
    rf = x; gf = c; bf = 0;
  } else if (hf < 3) {
    rf = 0; gf = c; bf = x;
  } else if (hf < 4) {
    rf = 0; gf = x; bf = c;
  } else if (hf < 5) {
    rf = x; gf = 0; bf = c;
  } else {
    rf = c; gf = 0; bf = x;
  }

  return {
    r: clampByte(roundHalfUp((rf + m) * 255)),
    g: clampByte(roundHalfUp((gf + m) * 255)),
    b: clampByte(roundHalfUp((bf + m) * 255)),
  };
}

export function rgbToHsv(r: number, g: number, b: number): HSV {
  requireFinite('r', r);
  requireFinite('g', g);
  requireFinite('b', b);
  r = clampByte(r);
  g = clampByte(g);
  b = clampByte(b);

  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const mx = Math.max(rf, gf, bf);
  const mn = Math.min(rf, gf, bf);
  const d = mx - mn;

  let hf = 0;
  if (d > 0) {
    if (mx === rf) hf = 60 * (((gf - bf) / d) % 6);
    else if (mx === gf) hf = 60 * ((bf - rf) / d + 2);
    else hf = 60 * ((rf - gf) / d + 4);
  }
  if (hf < 0) hf += 360;

  return {
    h: clamp(roundHalfUp(hf), 0, 360),
    s: mx > 0 ? clamp(roundHalfUp((d / mx) * 100), 0, 100) : 0,
    v: clamp(roundHalfUp(mx * 100), 0, 100),
  };
}

function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new PayloadError(`Invalid hex color: "${hex}"`);
  const int = parseInt(m[1], 16);
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}

function rgbToHex(r: number, g: number, b: number): string {
  const byteHex = (n: number) => clampByte(n).toString(16).padStart(2, '0');
  return `#${byteHex(r)}${byteHex(g)}${byteHex(b)}`;
}

const TRIPLE_RE = /^-?\d+(?:\.\d+)?$/;

function parseNumberTriple(s: string): [number, number, number] | null {
  const parts = s.split(',').map((p) => p.trim());
  if (parts.length !== 3 || !parts.every((p) => TRIPLE_RE.test(p))) return null;
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

function hsvFromTriple(h: number, s: number, v: number): HSV {
  requireFinite('h', h);
  requireFinite('s', s);
  requireFinite('v', v);
  return {
    h: clamp(Math.round(h), 0, 360),
    s: clamp(Math.round(s), 0, 100),
    v: clamp(Math.round(v), 0, 100),
  };
}

/**
 * Resolve any of the friendly color inputs to firmware HSV.
 *
 * Bare "n,n,n" strings are treated as already-HSV — this is the same shape
 * this function outputs and the shape the firmware speaks on the wire, so a
 * value that's already in wire format passes straight through (clamped).
 * To send RGB numerically, use the `{r,g,b}` object form or a "#rrggbb" hex
 * string; there is no reliable way to tell an "r,g,b" string apart from an
 * "h,s,v" string by shape alone (both are three comma-separated numbers), so
 * bare number-triple strings are always read as HSV.
 */
export function colorToHsvPayload(
  input: string | { r: number; g: number; b: number } | { h: number; s: number; v: number },
): string {
  const hsv = resolveHsv(input);
  return `${hsv.h},${hsv.s},${hsv.v}`;
}

function resolveHsv(input: unknown): HSV {
  if (typeof input === 'string') {
    const s = input.trim();
    if (s.startsWith('#')) {
      const rgb = hexToRgb(s);
      return rgbToHsv(rgb.r, rgb.g, rgb.b);
    }
    const triple = parseNumberTriple(s);
    if (triple) return hsvFromTriple(triple[0], triple[1], triple[2]);
    throw new PayloadError(`Unparseable color string: "${input}"`);
  }

  if (input && typeof input === 'object') {
    if ('h' in input && 's' in input && 'v' in input) {
      const { h, s, v } = input as HSV;
      return hsvFromTriple(h, s, v);
    }
    if ('r' in input && 'g' in input && 'b' in input) {
      const { r, g, b } = input as RGB;
      return rgbToHsv(r, g, b);
    }
  }

  throw new PayloadError(`Unparseable color input: ${JSON.stringify(input)}`);
}

// --- power ---

export function powerToPayload(input: unknown): '0' | '1' {
  if (typeof input === 'string') {
    const s = input.trim().toLowerCase();
    return s === 'on' || s === '1' || s === 'true' ? '1' : '0';
  }
  return input ? '1' : '0';
}

// --- brightness ---

export function brightnessToPayload(input: number | string): string {
  let n: number;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.endsWith('%')) {
      const pct = Number(trimmed.slice(0, -1));
      if (!Number.isFinite(pct)) throw new PayloadError(`Invalid brightness percentage: "${input}"`);
      n = (pct / 100) * 255;
    } else {
      n = Number(trimmed);
      if (!Number.isFinite(n)) throw new PayloadError(`Invalid brightness value: "${input}"`);
    }
  } else {
    if (!Number.isFinite(input)) throw new PayloadError(`Invalid brightness value: ${input}`);
    n = input;
  }
  return String(clampByte(n));
}

// --- mode ---

const MODE_SYNONYMS: Record<string, 'color' | 'js'> = {
  color: 'color',
  solid: 'color',
  js: 'js',
};

export function modeToPayload(input: string): 'color' | 'js' {
  const key = String(input).trim().toLowerCase();
  const mapped = MODE_SYNONYMS[key];
  if (!mapped) {
    throw new PayloadError(`Invalid mode: "${input}" (expected "color" or "js")`);
  }
  return mapped;
}

// --- inbound state (topic suffix + retained payload -> friendly value) ---

export interface ParsedState {
  key: string;
  value: unknown;
}

export function parseState(topicSuffix: string, payload: string): ParsedState {
  switch (topicSuffix) {
    case 'color/get': {
      const triple = parseNumberTriple(payload);
      if (!triple) throw new PayloadError(`Invalid HSV payload on color/get: "${payload}"`);
      const hsv = hsvFromTriple(triple[0], triple[1], triple[2]);
      const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
      const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
      const value: ColorState = { ...hsv, ...rgb, hex };
      return { key: 'color', value };
    }
    case 'brightness/get': {
      const n = Number(payload.trim());
      if (!Number.isFinite(n)) throw new PayloadError(`Invalid brightness payload: "${payload}"`);
      return { key: 'brightness', value: Math.round(n) };
    }
    case 'mode/get':
      return { key: 'mode', value: payload.trim() };
    case 'power/get':
      return { key: 'power', value: payload.trim() === '1' };
    case 'status':
      return { key: 'online', value: payload.trim() === 'online' };
    default:
      throw new PayloadError(`Unknown state topic suffix: "${topicSuffix}"`);
  }
}
