// Pure lamp-discovery registry for the PlaiiinLightOS Node-RED palette.
//
// No Node-RED / MQTT dependencies here — this module only tracks which
// lamps have announced themselves over the `<prefix>/<node>/status` LWT
// topic and whether they're currently online.
//
// Firmware reference: lampos/main/plaiiin_mqtt.c
//   - Status topic is built as "<prefix>/<node>/status" (build_topics(),
//     plaiiin_mqtt.c:82,93, where prefix is always "plaiiinlight").
//   - On MQTT_EVENT_CONNECTED the lamp publishes retained "online" to that
//     topic (plaiiin_mqtt.c:188).
//   - The client's LWT (last_will) publishes retained "offline" to the same
//     topic if the lamp drops off ungracefully (plaiiin_mqtt.c:233-239,
//     .msg = "offline", .msg_len = 7).
//   - So the only two payloads this module needs to understand are the
//     literal strings "online" and "offline" (matched case-insensitively,
//     trimmed) — anything else is treated as offline/not-online.
//
// Time is injected (`now` passed into onStatus) rather than read from
// Date.now() here, so the registry stays deterministic and testable
// without wall-clock dependence.

const STATUS_SUFFIX = '/status';

/**
 * Extract the `<node>` from a `<prefix>/<node>/status` topic.
 *
 * Returns null for anything else — including sub-topics like
 * `<prefix>/<node>/color/get` that merely start with the same prefix.
 */
export function parseStatusTopic(topic: string, prefix: string): string | null {
  if (!topic.startsWith(`${prefix}/`)) return null;
  if (!topic.endsWith(STATUS_SUFFIX)) return null;

  const rest = topic.slice(prefix.length + 1, -STATUS_SUFFIX.length);
  if (rest.length === 0 || rest.includes('/')) return null;

  return rest;
}

export interface LampStatus {
  node: string;
  online: boolean;
  lastSeen: number;
}

export class LampRegistry {
  private readonly lamps = new Map<string, LampStatus>();
  private readonly prefix: string;

  constructor(prefix = 'plaiiinlight') {
    this.prefix = prefix;
  }

  onStatus(topic: string, payload: string, now: number): void {
    const node = parseStatusTopic(topic, this.prefix);
    if (node === null) return;

    const online = payload.trim().toLowerCase() === 'online';
    this.lamps.set(node, { node, online, lastSeen: now });
  }

  list(): LampStatus[] {
    return Array.from(this.lamps.values()).sort((a, b) => a.node.localeCompare(b.node));
  }
}
