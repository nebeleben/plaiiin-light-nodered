import { describe, expect, it } from 'vitest';
import { HELLO } from '../src/payload';

describe('payload', () => {
  it('exports HELLO', () => {
    expect(HELLO).toBe('plaiiinlight');
  });
});
