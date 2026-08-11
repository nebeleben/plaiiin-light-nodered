// Node-RED node-level tests, run against a real (embedded) MQTT broker —
// no external broker needed. `aedes` runs an in-process broker on an
// ephemeral TCP port; `node-red-node-test-helper` boots a mock Node-RED
// runtime and loads our node module into it exactly the way the real editor
// would, including the `credentials` schema declared in registerType().
import { createServer, type Server } from 'node:net';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Aedes from 'aedes';
import helper from 'node-red-node-test-helper';

const require = createRequire(import.meta.url);
helper.init(require.resolve('node-red'));

// `export = function (RED) {...}` (src/config.ts) compiles to
// `module.exports = function (RED) {...}` — a default import picks up that
// same function via esModuleInterop (this file only executes through
// vitest/esbuild, so it never depends on the built dist/config.js).
import configNode from '../src/config';
import commandNode from '../src/command';
import stateNode from '../src/state';

const CONFIG_NODE_TYPE = 'plaiiinlight-config';
const COMMAND_NODE_TYPE = 'plaiiinlight-command';
const STATE_NODE_TYPE = 'plaiiinlight-state';

describe('plaiiinlight-config node', () => {
  let broker: InstanceType<typeof Aedes>;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    broker = new Aedes();
    server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected an AddressInfo from the ephemeral listener');
    }
    port = address.port;
  });

  afterEach(async () => {
    await helper.unload();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });

  function testFlow() {
    return [
      {
        id: 'n1',
        type: CONFIG_NODE_TYPE,
        name: 'test broker',
        host: '127.0.0.1',
        port,
        tls: false,
        prefix: 'plaiiinlight',
      },
    ];
  }

  it('loads with the configured host/port/prefix', async () => {
    await helper.load(configNode, testFlow(), {});
    const n1 = helper.getNode('n1') as any;
    expect(n1.host).toBe('127.0.0.1');
    expect(n1.port).toBe(port);
    expect(n1.prefix).toBe('plaiiinlight');
  });

  it('connects to the broker, subscribes to <prefix>/+/status, and feeds the registry', async () => {
    await helper.load(configNode, testFlow(), {});
    const n1 = helper.getNode('n1') as any;

    const connected = new Promise<void>((resolve) => {
      n1.on('plaiiinlight:status', (evt: { status: string }) => {
        if (evt.status === 'connected') resolve();
      });
    });
    n1.getClient(); // triggers the lazy connect, as a dependent node's constructor would
    await connected;

    await new Promise<void>((resolve, reject) => {
      broker.publish({ topic: 'plaiiinlight/tower8/status', payload: Buffer.from('online'), qos: 0, retain: true }, (err) =>
        err ? reject(err) : resolve(),
      );
    });

    await vi.waitFor(() => {
      const lamps = n1.getRegistry().list();
      expect(lamps).toEqual([expect.objectContaining({ node: 'tower8', online: true })]);
    });
  });

  it('serves the discovered lamp list from the /plaiiinlight/:id/lamps admin endpoint', async () => {
    await helper.load(configNode, testFlow(), {});
    const n1 = helper.getNode('n1') as any;

    const connected = new Promise<void>((resolve) => {
      n1.on('plaiiinlight:status', (evt: { status: string }) => {
        if (evt.status === 'connected') resolve();
      });
    });
    n1.getClient();
    await connected;

    await new Promise<void>((resolve, reject) => {
      broker.publish({ topic: 'plaiiinlight/tower8/status', payload: Buffer.from('online'), qos: 0, retain: true }, (err) =>
        err ? reject(err) : resolve(),
      );
    });

    await vi.waitFor(() => {
      expect(n1.getRegistry().list()).toHaveLength(1);
    });

    const res = await helper.request().get('/plaiiinlight/n1/lamps').expect(200);
    expect(res.body).toEqual([expect.objectContaining({ node: 'tower8', online: true })]);
  });

  it('closes the MQTT client when the node is closed', async () => {
    await helper.load(configNode, testFlow(), {});
    const n1 = helper.getNode('n1') as any;

    const connected = new Promise<void>((resolve) => {
      n1.on('plaiiinlight:status', (evt: { status: string }) => {
        if (evt.status === 'connected') resolve();
      });
    });
    const client = n1.getClient();
    await connected;

    await helper.unload();
    expect(client.disconnecting || client.disconnected).toBe(true);
  });
});

describe('plaiiinlight-command node', () => {
  let broker: InstanceType<typeof Aedes>;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    broker = new Aedes();
    server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected an AddressInfo from the ephemeral listener');
    }
    port = address.port;
  });

  afterEach(async () => {
    await helper.unload();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });

  function testFlow(command: Record<string, unknown>) {
    return [
      {
        id: 'n1',
        type: CONFIG_NODE_TYPE,
        name: 'test broker',
        host: '127.0.0.1',
        port,
        tls: false,
        prefix: 'plaiiinlight',
      },
      {
        id: 'n2',
        type: COMMAND_NODE_TYPE,
        name: 'test command',
        config: 'n1',
        wires: [[]],
        ...command,
      },
    ];
  }

  // The shared MQTT client connects lazily (mqtt.js queues publishes made
  // before 'connect' and flushes them once it's up), so wait for the exact
  // topic to land on the broker instead of racing a fixed delay.
  function waitForPublish(topic: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const onPublish = (packet: { topic: string; payload: Buffer }) => {
        if (packet.topic === topic) {
          broker.removeListener('publish', onPublish);
          resolve(packet.payload.toString());
        }
      };
      broker.on('publish', onPublish);
    });
  }

  it('maps a color msg through payload.ts and publishes HSV to <prefix>/<lamp>/color/set', async () => {
    await helper.load([configNode, commandNode], testFlow({ lamp: 'tower8', action: 'color', usePayload: true }), {});
    const n2 = helper.getNode('n2') as any;

    const published = waitForPublish('plaiiinlight/tower8/color/set');
    n2.receive({ payload: '#ff0000' });

    expect(await published).toBe('0,100,100');
  });

  it('maps a power msg to "1" and publishes to <prefix>/<lamp>/power/set', async () => {
    await helper.load([configNode, commandNode], testFlow({ lamp: 'tower8', action: 'power', usePayload: true }), {});
    const n2 = helper.getNode('n2') as any;

    const published = waitForPublish('plaiiinlight/tower8/power/set');
    n2.receive({ payload: true });

    expect(await published).toBe('1');
  });

  it('publishes an empty payload to <prefix>/<lamp>/effect/next for effect-next', async () => {
    await helper.load([configNode, commandNode], testFlow({ lamp: 'tower8', action: 'effect-next' }), {});
    const n2 = helper.getNode('n2') as any;

    const published = waitForPublish('plaiiinlight/tower8/effect/next');
    n2.receive({});

    expect(await published).toBe('');
  });

  it('on an invalid color value, sets an error status and publishes nothing', async () => {
    await helper.load([configNode, commandNode], testFlow({ lamp: 'tower8', action: 'color', usePayload: true }), {});
    const n2 = helper.getNode('n2') as any;

    const statusEvents: Array<{ fill?: string }> = [];
    n2.on('call:status', (call: { args: [{ fill?: string }] }) => statusEvents.push(call.args[0]));

    let publishedToLamp = false;
    const onPublish = (packet: { topic: string }) => {
      if (packet.topic.startsWith('plaiiinlight/tower8/')) publishedToLamp = true;
    };
    broker.on('publish', onPublish);

    n2.receive({ payload: 'not-a-color' });

    await vi.waitFor(() => {
      expect(statusEvents.length).toBeGreaterThan(0);
    });

    broker.removeListener('publish', onPublish);
    expect(statusEvents[0]).toEqual(expect.objectContaining({ fill: 'red' }));
    expect(publishedToLamp).toBe(false);
  });
});

describe('plaiiinlight-state node', () => {
  let broker: InstanceType<typeof Aedes>;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    broker = new Aedes();
    server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected an AddressInfo from the ephemeral listener');
    }
    port = address.port;
  });

  afterEach(async () => {
    await helper.unload();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });

  function testFlow(state: Record<string, unknown> = {}) {
    return [
      {
        id: 'n1',
        type: CONFIG_NODE_TYPE,
        name: 'test broker',
        host: '127.0.0.1',
        port,
        tls: false,
        prefix: 'plaiiinlight',
      },
      {
        id: 'n2',
        type: STATE_NODE_TYPE,
        name: 'test state',
        config: 'n1',
        lamp: 'tower8',
        wires: [['n3']],
        ...state,
      },
      { id: 'n3', type: 'helper' },
    ];
  }

  // The shared MQTT client connects (and this node subscribes) lazily, so
  // wait for the broker to actually see the SUBSCRIBE for the exact topic
  // before publishing — same rationale as command.ts's waitForPublish, and
  // registered before helper.load() so there's no race with the node's own
  // (synchronous, but async-flushed) subscribe call in its constructor.
  function waitForSubscribe(topic: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const onSubscribe = (subscriptions: Array<{ topic: string }>) => {
        if (subscriptions.some((s) => s.topic === topic)) {
          broker.removeListener('subscribe', onSubscribe);
          resolve();
        }
      };
      broker.on('subscribe', onSubscribe);
    });
  }

  it('parses color/get off the shared client and emits merged state with color.hex', async () => {
    const subscribed = waitForSubscribe('plaiiinlight/tower8/color/get');
    await helper.load([configNode, stateNode], testFlow(), {});
    await subscribed;

    const n3 = helper.getNode('n3') as any;
    const received = new Promise<any>((resolve) => n3.on('input', resolve));

    await new Promise<void>((resolve, reject) => {
      broker.publish(
        { topic: 'plaiiinlight/tower8/color/get', payload: Buffer.from('0,100,100'), qos: 0, retain: false },
        (err) => (err ? reject(err) : resolve()),
      );
    });

    const msg = await received;
    expect(msg.topic).toBe('tower8');
    expect(msg.changed).toBe('color');
    expect(msg.payload.color.hex).toBe('#ff0000');
  });

  it('marks the node grey and payload.online false on an offline status', async () => {
    const subscribed = waitForSubscribe('plaiiinlight/tower8/status');
    await helper.load([configNode, stateNode], testFlow(), {});
    await subscribed;

    const n2 = helper.getNode('n2') as any;
    const n3 = helper.getNode('n3') as any;

    const statusEvents: Array<{ fill?: string }> = [];
    n2.on('call:status', (call: { args: [{ fill?: string }] }) => statusEvents.push(call.args[0]));

    const received = new Promise<any>((resolve) => n3.on('input', resolve));

    await new Promise<void>((resolve, reject) => {
      broker.publish(
        { topic: 'plaiiinlight/tower8/status', payload: Buffer.from('offline'), qos: 0, retain: false },
        (err) => (err ? reject(err) : resolve()),
      );
    });

    const msg = await received;
    expect(msg.changed).toBe('online');
    expect(msg.payload.online).toBe(false);

    await vi.waitFor(() => {
      expect(statusEvents.length).toBeGreaterThan(0);
    });
    expect(statusEvents[statusEvents.length - 1]).toEqual(expect.objectContaining({ fill: 'grey' }));
  });

  it('unsubscribes and stops emitting after the node is closed', async () => {
    const subscribed = waitForSubscribe('plaiiinlight/tower8/power/get');
    await helper.load([configNode, stateNode], testFlow(), {});
    await subscribed;

    const n3 = helper.getNode('n3') as any;
    let messageCount = 0;
    n3.on('input', () => {
      messageCount += 1;
    });

    await helper.unload();

    await new Promise<void>((resolve, reject) => {
      broker.publish(
        { topic: 'plaiiinlight/tower8/power/get', payload: Buffer.from('1'), qos: 0, retain: false },
        (err) => (err ? reject(err) : resolve()),
      );
    });

    // Give any (unwanted) delivery a moment to land before asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messageCount).toBe(0);
  });
});
