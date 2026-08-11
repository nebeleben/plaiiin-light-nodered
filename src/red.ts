// Shared Node-RED runtime type shims for the PlaiiinLightOS palette.
//
// No `@types/node-red` package exists for this Node-RED version, and pulling
// in a hand-rolled community one isn't worth it for the handful of runtime
// calls this package makes — so the RED/runtime shapes below are minimal,
// structural interfaces covering only what's actually called.
//
// This module also exports `plaiiinlight-config`'s public node shape
// (`PlaiiinlightConfigNode`) and the `plaiiinlight:status` event name it
// broadcasts, so dependent nodes (command, state) can depend on that
// contract without config.ts and command.ts/state.ts each redeclaring their
// own copy of the same shim types. config.ts's `export =` still forbids
// named exports from that file itself, which is why these live here instead.

import type { MqttClient } from 'mqtt';
import type { LampRegistry } from './discovery';

export interface NodeStatus {
  fill?: 'red' | 'green' | 'yellow' | 'blue' | 'grey';
  shape?: 'ring' | 'dot';
  text?: string;
}

/** A Node-RED message — always has arbitrary properties, `payload` by far the most-used one. */
export interface NodeMessage {
  payload?: unknown;
  [key: string]: unknown;
}

export interface NodeRedNode {
  id: string;
  credentials?: { username?: string; password?: string };
  on(event: 'close', listener: (done: () => void) => void): void;
  on(
    event: 'input',
    listener: (msg: NodeMessage, send: (msg: unknown) => void, done: (err?: unknown) => void) => void,
  ): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  status(status: NodeStatus | Record<string, never>): void;
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string | Error, msg2?: unknown): void;
}

export interface NodeRedRuntime {
  nodes: {
    createNode(node: unknown, config: unknown): void;
    registerType(type: string, ctor: unknown, opts?: unknown): void;
    getNode(id: string): unknown;
  };
  httpAdmin: {
    get(path: string, ...handlers: unknown[]): void;
  };
  auth: {
    needsPermission(permission: string): unknown;
  };
}

/** Connection lifecycle broadcast to dependent nodes via the `plaiiinlight:status` event. */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
export interface ConnectionStatusEvent {
  status: ConnectionStatus;
  error?: string;
}

export const STATUS_EVENT = 'plaiiinlight:status';

/** The public shape of the `plaiiinlight-config` node, as depended on by command/state nodes. */
export interface PlaiiinlightConfigNode extends NodeRedNode {
  host: string;
  port: number;
  tls: boolean;
  prefix: string;
  /** Returns the shared registry (always available, even before the client connects). */
  getRegistry(): LampRegistry;
  /** Returns the shared MQTT client, connecting lazily on first use. */
  getClient(): MqttClient;
}
