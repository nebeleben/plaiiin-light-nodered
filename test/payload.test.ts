import { describe, expect, it } from 'vitest';
import {
  PayloadError,
  brightnessToPayload,
  colorToHsvPayload,
  hsvToRgb,
  modeToPayload,
  parseState,
  powerToPayload,
  rgbToHsv,
} from '../src/payload';

describe('colorToHsvPayload', () => {
  it('converts #rrggbb hex to firmware HSV (red)', () => {
    expect(colorToHsvPayload('#ff0000')).toBe('0,100,100');
  });

  it('converts #rrggbb hex to firmware HSV (green)', () => {
    expect(colorToHsvPayload('#00ff00')).toBe('120,100,100');
  });

  it('converts an {r,g,b} object to firmware HSV (blue)', () => {
    expect(colorToHsvPayload({ r: 0, g: 0, b: 255 })).toBe('240,100,100');
  });

  it('passes an already-HSV "h,s,v" string through unchanged', () => {
    expect(colorToHsvPayload('30,50,50')).toBe('30,50,50');
  });

  it('accepts an {h,s,v} object', () => {
    expect(colorToHsvPayload({ h: 30, s: 50, v: 50 })).toBe('30,50,50');
  });

  it('throws PayloadError on unparseable input', () => {
    expect(() => colorToHsvPayload('not-a-color')).toThrow(PayloadError);
    expect(() => colorToHsvPayload('#zzzzzz')).toThrow(PayloadError);
    // @ts-expect-error deliberately wrong shape to exercise the runtime guard
    expect(() => colorToHsvPayload(123)).toThrow(PayloadError);
  });

  it('handles white and black at the HSV extremes', () => {
    expect(colorToHsvPayload('#ffffff')).toBe('0,0,100');
    expect(colorToHsvPayload('#000000')).toBe('0,0,0');
  });
});

describe('rgbToHsv / hsvToRgb (firmware-matching round-trip)', () => {
  it('matches the firmware reference points: red=H0, green=H120, blue=H240', () => {
    expect(rgbToHsv(255, 0, 0)).toEqual({ h: 0, s: 100, v: 100 });
    expect(rgbToHsv(0, 255, 0)).toEqual({ h: 120, s: 100, v: 100 });
    expect(rgbToHsv(0, 0, 255)).toEqual({ h: 240, s: 100, v: 100 });
  });

  it('round-trips primary/secondary colors exactly', () => {
    const samples: Array<[number, number, number]> = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
      [0, 255, 255],
      [255, 0, 255],
      [255, 255, 255],
      [0, 0, 0],
      [128, 128, 128],
    ];
    for (const [r, g, b] of samples) {
      const hsv = rgbToHsv(r, g, b);
      const back = hsvToRgb(hsv.h, hsv.s, hsv.v);
      expect(back).toEqual({ r, g, b });
    }
  });
});

describe('powerToPayload', () => {
  it('maps boolean true to "1"', () => {
    expect(powerToPayload(true)).toBe('1');
  });

  it('maps "off" to "0"', () => {
    expect(powerToPayload('off')).toBe('0');
  });

  it('maps "on"/"1"/"true" strings to "1"', () => {
    expect(powerToPayload('on')).toBe('1');
    expect(powerToPayload('1')).toBe('1');
    expect(powerToPayload('true')).toBe('1');
  });

  it('maps false/0/"0"/"false" to "0"', () => {
    expect(powerToPayload(false)).toBe('0');
    expect(powerToPayload(0)).toBe('0');
    expect(powerToPayload('0')).toBe('0');
    expect(powerToPayload('false')).toBe('0');
  });
});

describe('brightnessToPayload', () => {
  it('clamps numbers above 255 down to 255', () => {
    expect(brightnessToPayload(300)).toBe('255');
  });

  it('scales a percentage string and rounds', () => {
    expect(brightnessToPayload('50%')).toBe('128');
  });

  it('clamps negative numbers up to 0', () => {
    expect(brightnessToPayload(-5)).toBe('0');
  });

  it('passes a plain 0-255 number through as an integer string', () => {
    expect(brightnessToPayload(200)).toBe('200');
  });
});

describe('modeToPayload', () => {
  it('maps the "solid" synonym to "color"', () => {
    expect(modeToPayload('solid')).toBe('color');
  });

  it('passes "color" and "js" through unchanged', () => {
    expect(modeToPayload('color')).toBe('color');
    expect(modeToPayload('js')).toBe('js');
  });

  it('throws on "stream" (not settable via mode/set)', () => {
    expect(() => modeToPayload('stream')).toThrow(PayloadError);
  });

  it('throws on an unknown mode', () => {
    expect(() => modeToPayload('rainbow')).toThrow(PayloadError);
  });
});

describe('parseState', () => {
  it('parses color/get HSV into a full color value', () => {
    const { key, value } = parseState('color/get', '0,100,100');
    expect(key).toBe('color');
    expect(value).toMatchObject({ h: 0, s: 100, v: 100, r: 255, g: 0, b: 0, hex: '#ff0000' });
  });

  it('parses brightness/get as an integer', () => {
    expect(parseState('brightness/get', '128')).toEqual({ key: 'brightness', value: 128 });
  });

  it('parses mode/get as a string', () => {
    expect(parseState('mode/get', 'js')).toEqual({ key: 'mode', value: 'js' });
  });

  it('parses power/get as a boolean', () => {
    expect(parseState('power/get', '1')).toEqual({ key: 'power', value: true });
    expect(parseState('power/get', '0')).toEqual({ key: 'power', value: false });
  });

  it('parses status LWT into online/offline booleans', () => {
    expect(parseState('status', 'online')).toEqual({ key: 'online', value: true });
    expect(parseState('status', 'offline')).toEqual({ key: 'online', value: false });
  });

  it('throws PayloadError on an unknown topic suffix', () => {
    expect(() => parseState('bogus/get', 'x')).toThrow(PayloadError);
  });
});
