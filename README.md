# node-red-contrib-plaiiinlight

Node-RED palette for [PlaiiinLightOS](https://github.com/nebeleben/plaiiin-light)
lamps — control power, color and effects, and receive lamp state, over the
local network (MQTT, no cloud, no account).

## Status

Early scaffolding. Nodes are not implemented yet.

## Requirements

- A lamp running PlaiiinLightOS, already onboarded to your Wi-Fi.
- Node-RED ≥ 3.0, Node ≥ 18.

## Installation

Search for **plaiiinlight** in the Node-RED palette manager (Manage
palette → Install), or:

    npm install node-red-contrib-plaiiinlight

## Nodes

- **plaiiinlight-config** — shared connection config for a lamp (host, MQTT
  broker/credentials).
- **plaiiinlight-command** — send commands (power, color, effect) to a lamp.
- **plaiiinlight-state** — emit a message whenever the lamp's state changes.

## Development

    npm install
    npm run build   # tsc -> dist/, then copies editor/*.html -> dist/
    npm test         # vitest

## License

Apache-2.0. See [LICENSE](./LICENSE).
