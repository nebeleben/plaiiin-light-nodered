// `plaiiinlight-config` — the self-contained broker + discovery hub for the
// PlaiiinLightOS Node-RED palette.
//
// Owns exactly ONE shared `mqtt.MqttClient` per config node (lazy-connected
// on first use, so a deploy with a config node but no command/state nodes
// wired to it never opens a socket). All dependent nodes (command, state)
// call `getClient()` to reuse that same connection instead of each opening
// their own — the lamp fleet's MQTT broker (Mosquitto, run locally by
// lampos) doesn't need N duplicate subscriptions per flow.
//
// Discovery: every connected client subscribes to `<prefix>/+/status` (the
// LWT/retained-online topic every lamp publishes — see discovery.ts for the
// exact wire contract) and feeds each message into a `LampRegistry`, so
// dependent nodes and the editor's lamp-picker panels can list known lamps
// without a separate discovery mechanism.
//
// The RED/runtime type shims (including this node's own public shape,
// `PlaiiinlightConfigNode`) live in ./red — see that file's header for why
// (`export =` below forbids named exports from this file, so dependent
// nodes can't import these shapes from here).

import mqtt, { type MqttClient } from 'mqtt';
import { LampRegistry } from './discovery';
import {
  STATUS_EVENT,
  type ConnectionStatusEvent,
  type NodeRedRuntime,
  type PlaiiinlightConfigNode,
} from './red';

interface ConfigNodeDef {
  host: string;
  port?: number | string;
  tls?: boolean;
  prefix?: string;
}

const DEFAULT_PORT = 1883;
const DEFAULT_PREFIX = 'plaiiinlight';

function buildBrokerUrl(host: string, port: number, tls: boolean): string {
  return `${tls ? 'mqtts' : 'mqtt'}://${host}:${port}`;
}

export = function (RED: NodeRedRuntime): void {
  function PlaiiinlightConfigNode(this: PlaiiinlightConfigNode, config: ConfigNodeDef): void {
    RED.nodes.createNode(this, config);
    const node = this;

    node.host = config.host;
    node.port = Number(config.port) || DEFAULT_PORT;
    node.tls = !!config.tls;
    const trimmedPrefix = typeof config.prefix === 'string' ? config.prefix.trim() : '';
    node.prefix = trimmedPrefix.length > 0 ? trimmedPrefix : DEFAULT_PREFIX;

    const registry = new LampRegistry(node.prefix);
    let client: MqttClient | null = null;

    node.getRegistry = (): LampRegistry => registry;

    node.getClient = (): MqttClient => {
      if (client) return client;

      const { username, password } = node.credentials ?? {};
      const statusTopic = `${node.prefix}/+/status`;

      const c = mqtt.connect(buildBrokerUrl(node.host, node.port, node.tls), {
        username,
        password,
        // mqtt.js auto-reconnects by default; this just makes the interval explicit.
        reconnectPeriod: 5000,
      });
      client = c;

      c.on('connect', () => {
        node.emit(STATUS_EVENT, { status: 'connected' } satisfies ConnectionStatusEvent);
        c.subscribe(statusTopic, (err) => {
          if (err) node.error(`plaiiinlight-config: failed to subscribe to ${statusTopic}: ${err.message}`);
        });
      });

      c.on('reconnect', () => {
        node.emit(STATUS_EVENT, { status: 'connecting' } satisfies ConnectionStatusEvent);
      });

      c.on('close', () => {
        node.emit(STATUS_EVENT, { status: 'disconnected' } satisfies ConnectionStatusEvent);
      });

      c.on('error', (err: Error) => {
        node.emit(STATUS_EVENT, { status: 'error', error: err.message } satisfies ConnectionStatusEvent);
      });

      c.on('message', (topic: string, payload: Buffer) => {
        registry.onStatus(topic, payload.toString(), Date.now());
      });

      return c;
    };

    node.on('close', (done: () => void) => {
      if (client) {
        const c = client;
        client = null;
        c.end(true, {}, () => done());
      } else {
        done();
      }
    });
  }

  RED.nodes.registerType('plaiiinlight-config', PlaiiinlightConfigNode, {
    credentials: {
      username: { type: 'text' },
      password: { type: 'password' },
    },
  });

  // Admin endpoint the editor's command/state edit panels call to populate a
  // lamp dropdown from this config node's live discovery registry.
  RED.httpAdmin.get(
    '/plaiiinlight/:id/lamps',
    RED.auth.needsPermission('flows.read'),
    (req: { params: { id: string } }, res: { status(code: number): { json(body: unknown): void }; json(body: unknown): void }) => {
      const node = RED.nodes.getNode(req.params.id) as PlaiiinlightConfigNode | null;
      if (!node || typeof node.getRegistry !== 'function') {
        res.status(404).json([]);
        return;
      }
      res.json(node.getRegistry().list());
    },
  );
};
