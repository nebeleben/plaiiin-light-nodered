// `plaiiinlight-state` — tracks power/color/brightness/mode/online state for
// a single lamp by subscribing to its `.../get` + `status` topics on the
// shared MQTT connection owned by a `plaiiinlight-config` node, and emits a
// merged state message on every update.
//
// Like command.ts, this node never opens its own MQTT connection or
// reimplements payload parsing — it reuses configNode.getClient() (the one
// shared connection every dependent node multiplexes onto — see config.ts's
// header) and payload.ts's parseState() so inbound wire payloads are decoded
// exactly once, in one place, for the whole palette.
//
// The shared client already carries other traffic — config.ts's own
// discovery subscription (`<prefix>/+/status`) and every other command/state
// node's topics — so a client-level 'message' event fires for ALL of that,
// not just this node's own subscriptions. This node's message listener
// therefore filters to just this lamp's five topics before doing anything,
// exactly like config.ts's registry.onStatus() already does for its own
// broader `+/status` subscription.

import type { MqttClient } from 'mqtt';
import { parseState, PayloadError } from './payload';
import type { NodeRedNode, NodeRedRuntime, PlaiiinlightConfigNode } from './red';

// Multiple `plaiiinlight-state` nodes (and, in principle, other node types)
// can share one `plaiiinlight-config` node's MQTT client and target the same
// lamp — e.g. two state nodes both watching `tower8`. The client itself has
// no concept of "how many subscribers want this topic", so without a
// refcount here, closing ONE of those nodes would call `client.unsubscribe()`
// on a topic the OTHER node still depends on, silently killing its broker
// delivery until the next full redeploy. Keyed by the actual client object
// (WeakMap, so it never needs explicit cleanup when a config node's old
// client is replaced/GC'd) -> topic -> number of nodes currently subscribed.
const subscriptionRefcounts = new WeakMap<MqttClient, Map<string, number>>();

function retainSubscriptions(client: MqttClient, topics: string[]): void {
  let counts = subscriptionRefcounts.get(client);
  if (!counts) {
    counts = new Map<string, number>();
    subscriptionRefcounts.set(client, counts);
  }
  for (const topic of topics) counts.set(topic, (counts.get(topic) ?? 0) + 1);
}

/** Returns only the topics whose refcount just dropped to zero — the ones actually safe to unsubscribe. */
function releaseSubscriptions(client: MqttClient, topics: string[]): string[] {
  const counts = subscriptionRefcounts.get(client);
  if (!counts) return topics; // no record — fall back to unsubscribing everything requested
  const toUnsubscribe: string[] = [];
  for (const topic of topics) {
    const next = (counts.get(topic) ?? 1) - 1;
    if (next <= 0) {
      counts.delete(topic);
      toUnsubscribe.push(topic);
    } else {
      counts.set(topic, next);
    }
  }
  return toUnsubscribe;
}

interface StateNodeDef {
  config: string;
  lamp?: string;
}

// NodeRedNode (red.ts) doesn't declare `send` — command.ts never needed it
// (it publishes via configNode.getClient().publish(), triggered by 'input').
// This node has no input; it emits messages on its own, driven by inbound
// MQTT traffic, so it needs `send` directly. Real Node-RED nodes get this
// from Node.prototype once RED.nodes.registerType() runs util.inherits() on
// the constructor (see @node-red/runtime/lib/nodes/index.js), so it's always
// present at runtime — this just documents that on the local type.
interface StateNode extends NodeRedNode {
  send(msg: unknown): void;
}

interface MergedState {
  online?: boolean;
  power?: boolean;
  color?: unknown;
  brightness?: number;
  mode?: string;
}

// Topic suffixes this node cares about (appended to `<prefix>/<lamp>/`),
// matching the firmware's `get` topics (lampos/main/plaiiin_mqtt.c:270-299)
// plus the bare `status` LWT topic.
const GET_SUFFIXES = ['power/get', 'color/get', 'brightness/get', 'mode/get'];

export = function (RED: NodeRedRuntime): void {
  function PlaiiinlightStateNode(this: StateNode, config: StateNodeDef): void {
    RED.nodes.createNode(this, config);
    const node = this;

    const configNode = RED.nodes.getNode(config.config) as PlaiiinlightConfigNode | null;
    const lamp = typeof config.lamp === 'string' ? config.lamp.trim() : '';

    if (!configNode) {
      node.error('plaiiinlight-state: no plaiiinlight-config node configured');
      node.status({ fill: 'red', shape: 'ring', text: 'no config' });
      return;
    }
    if (!lamp) {
      node.error('plaiiinlight-state: no lamp configured');
      node.status({ fill: 'red', shape: 'ring', text: 'no lamp' });
      return;
    }

    const topicPrefix = `${configNode.prefix}/${lamp}/`;
    const statusTopic = `${topicPrefix}status`;
    // suffix -> full topic, used both to subscribe and to match inbound
    // topics back to the exact suffix parseState() expects.
    const suffixToTopic = new Map<string, string>([['status', statusTopic]]);
    for (const suffix of GET_SUFFIXES) suffixToTopic.set(suffix, topicPrefix + suffix);
    const topics = Array.from(suffixToTopic.values());
    const topicToSuffix = new Map<string, string>(Array.from(suffixToTopic, ([suffix, topic]) => [topic, suffix]));

    const state: MergedState = {};
    node.status({ fill: 'grey', shape: 'ring', text: 'unknown' });

    const client = configNode.getClient();

    const onMessage = (topic: string, payload: Buffer): void => {
      const suffix = topicToSuffix.get(topic);
      if (suffix === undefined) return; // not one of this lamp's topics — ignore

      let result;
      try {
        result = parseState(suffix, payload.toString());
      } catch (err) {
        if (err instanceof PayloadError) {
          node.warn(`plaiiinlight-state: ${err.message}`);
          return;
        }
        throw err;
      }

      (state as Record<string, unknown>)[result.key] = result.value;

      if (result.key === 'online') {
        node.status(
          result.value
            ? { fill: 'green', shape: 'dot', text: 'online' }
            : { fill: 'grey', shape: 'ring', text: 'offline' },
        );
      }

      node.send({ topic: lamp, payload: { ...state }, changed: result.key });
    };

    client.on('message', onMessage);
    retainSubscriptions(client, topics);
    client.subscribe(topics, (err) => {
      if (err) node.error(`plaiiinlight-state: failed to subscribe: ${err.message}`);
    });

    node.on('close', (done: () => void) => {
      client.removeListener('message', onMessage);
      // Only unsubscribe topics no other state node on this same shared
      // client still needs (see subscriptionRefcounts above) — otherwise a
      // sibling node watching the same lamp would go silent.
      const topicsToUnsubscribe = releaseSubscriptions(client, topics);
      if (topicsToUnsubscribe.length > 0) {
        // Best-effort — the shared client may already be disconnecting (e.g.
        // the config node closes around the same time on redeploy/undeploy),
        // in which case there's nothing to unsubscribe from. Never end the
        // shared client itself; other nodes may still be using it.
        try {
          client.unsubscribe(topicsToUnsubscribe);
        } catch {
          // ignore — client already gone
        }
      }
      done();
    });
  }

  RED.nodes.registerType('plaiiinlight-state', PlaiiinlightStateNode);
};
