// `plaiiinlight-command` — sends power/color/brightness/mode/effect commands
// to a single lamp over the shared MQTT connection owned by a
// `plaiiinlight-config` node.
//
// This node never opens its own MQTT connection or reimplements payload
// mapping — it resolves the config node via `RED.nodes.getNode()`, calls its
// `getClient()` to reuse the one shared connection (see config.ts's header
// for why), and maps values through payload.ts's pure mappers so every node
// in this palette speaks the exact same wire format the firmware expects.

import { colorToHsvPayload, brightnessToPayload, modeToPayload, powerToPayload, PayloadError } from './payload';
import type { NodeMessage, NodeRedNode, NodeRedRuntime, PlaiiinlightConfigNode } from './red';

type CommandAction = 'power' | 'color' | 'brightness' | 'mode' | 'effect-next' | 'effect-prev';

interface CommandNodeDef {
  config: string;
  lamp?: string;
  action?: CommandAction;
  value?: string;
  usePayload?: boolean;
}

interface CommandNode extends NodeRedNode {}

// Maps each action to the MQTT topic suffix it publishes to (appended to
// `<prefix>/<lamp>/`) and how to turn the resolved input value into the
// exact wire payload the firmware expects. `effect-next`/`effect-prev` take
// no value — the firmware treats an empty payload on those topics as the
// trigger (see lampos/main/plaiiin_mqtt.c).
const ACTIONS: Record<CommandAction, { topicSuffix: string; toPayload: (value: unknown) => string }> = {
  power: { topicSuffix: 'power/set', toPayload: (v) => powerToPayload(v) },
  color: { topicSuffix: 'color/set', toPayload: (v) => colorToHsvPayload(v as never) },
  brightness: { topicSuffix: 'brightness/set', toPayload: (v) => brightnessToPayload(v as never) },
  mode: { topicSuffix: 'mode/set', toPayload: (v) => modeToPayload(String(v)) },
  'effect-next': { topicSuffix: 'effect/next', toPayload: () => '' },
  'effect-prev': { topicSuffix: 'effect/prev', toPayload: () => '' },
};

export = function (RED: NodeRedRuntime): void {
  function PlaiiinlightCommandNode(this: CommandNode, config: CommandNodeDef): void {
    RED.nodes.createNode(this, config);
    const node = this;

    const configNode = RED.nodes.getNode(config.config) as PlaiiinlightConfigNode | null;
    const lamp = typeof config.lamp === 'string' ? config.lamp.trim() : '';
    const action = config.action ?? 'power';
    const staticValue = config.value ?? '';
    const usePayload = !!config.usePayload;

    node.on('input', (msg: NodeMessage, _send, done) => {
      const finish = typeof done === 'function' ? done : undefined;

      if (!configNode) {
        node.error('plaiiinlight-command: no plaiiinlight-config node configured', msg);
        node.status({ fill: 'red', shape: 'ring', text: 'no config' });
        if (finish) finish();
        return;
      }

      if (!lamp) {
        node.error('plaiiinlight-command: no lamp configured', msg);
        node.status({ fill: 'red', shape: 'ring', text: 'no lamp' });
        if (finish) finish();
        return;
      }

      const spec = ACTIONS[action];
      const rawValue = usePayload ? msg.payload : staticValue;

      let payload: string;
      try {
        payload = spec.toPayload(rawValue);
      } catch (err) {
        if (err instanceof PayloadError) {
          node.error(err, msg);
          node.status({ fill: 'red', shape: 'dot', text: err.message });
          if (finish) finish();
          return;
        }
        throw err;
      }

      const topic = `${configNode.prefix}/${lamp}/${spec.topicSuffix}`;
      configNode.getClient().publish(topic, payload);
      node.status({ fill: 'green', shape: 'dot', text: `${action} ✓` });
      if (finish) finish();
    });
  }

  RED.nodes.registerType('plaiiinlight-command', PlaiiinlightCommandNode);
};
