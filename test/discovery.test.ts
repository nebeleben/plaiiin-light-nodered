import { describe, expect, it } from 'vitest';
import { LampRegistry, parseStatusTopic } from '../src/discovery';

describe('parseStatusTopic', () => {
  it('extracts the node name from a matching status topic', () => {
    expect(parseStatusTopic('plaiiinlight/tower8/status', 'plaiiinlight')).toBe('tower8');
  });

  it('returns null for a non-status topic (e.g. color/get)', () => {
    expect(parseStatusTopic('plaiiinlight/tower8/color/get', 'plaiiinlight')).toBeNull();
  });

  it('returns null for a topic with the wrong prefix', () => {
    expect(parseStatusTopic('otherprefix/tower8/status', 'plaiiinlight')).toBeNull();
  });
});

describe('LampRegistry', () => {
  it('records a lamp online from an "online" status payload', () => {
    const registry = new LampRegistry();
    registry.onStatus('plaiiinlight/tower8/status', 'online', 1000);
    expect(registry.list()).toEqual([{ node: 'tower8', online: true, lastSeen: 1000 }]);
  });

  it('flips a lamp offline from an "offline" status payload', () => {
    const registry = new LampRegistry();
    registry.onStatus('plaiiinlight/tower8/status', 'online', 1000);
    registry.onStatus('plaiiinlight/tower8/status', 'offline', 2000);
    expect(registry.list()).toEqual([{ node: 'tower8', online: false, lastSeen: 2000 }]);
  });

  it('updates lastSeen on a repeat status for the same node instead of duplicating it', () => {
    const registry = new LampRegistry();
    registry.onStatus('plaiiinlight/tower8/status', 'online', 1000);
    registry.onStatus('plaiiinlight/tower8/status', 'online', 5000);
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ node: 'tower8', online: true, lastSeen: 5000 });
  });

  it('lists multiple lamps sorted by node name', () => {
    const registry = new LampRegistry();
    registry.onStatus('plaiiinlight/zeta/status', 'online', 1000);
    registry.onStatus('plaiiinlight/alpha/status', 'online', 1000);
    registry.onStatus('plaiiinlight/mid/status', 'online', 1000);
    expect(registry.list().map((l) => l.node)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('ignores a non-status topic (no entry is created)', () => {
    const registry = new LampRegistry();
    registry.onStatus('plaiiinlight/tower8/color/get', '0,100,100', 1000);
    expect(registry.list()).toEqual([]);
  });
});
