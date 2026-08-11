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

const CONFIG_NODE_TYPE = 'plaiiinlight-config';

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
