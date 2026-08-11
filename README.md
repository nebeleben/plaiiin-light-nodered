<p align="center">
  <img src="https://raw.githubusercontent.com/nebeleben/plaiiin-light-nodered/main/branding/icon.png" width="88" height="88" alt="PlaiiinLight logo">
</p>

<h1 align="center">PlaiiinLight for Node-RED</h1>

Node-RED palette for [PlaiiinLightOS](https://github.com/nebeleben/plaiiin-light)
lamps — power, color, brightness, mode and effect commands, plus live state
updates, all over your local network via MQTT (no cloud, no account).

This package is a friendly wrapper around the firmware's plain-MQTT bridge:
it handles topic construction, discovery, and coercing convenient values
(`"#ff8800"`, `{r,g,b}`, `"50%"`, ...) into the exact wire payloads the
firmware expects. It doesn't expose anything the firmware's MQTT bridge
doesn't already publish/subscribe — see [Also works with generic MQTT
nodes](#also-works-with-generic-mqtt-nodes) below.

## Requirements

- A lamp running PlaiiinLightOS, already onboarded to your Wi-Fi, with its
  MQTT broker host/port set (lamp web portal or any PlaiiinLight app).
- An MQTT broker reachable from both the lamp and Node-RED (lampos runs
  Mosquitto locally on most setups; any broker works).
- Node-RED ≥ 3.0, Node ≥ 18.

## Installation

Search for **plaiiinlight** in the Node-RED palette manager (menu → Manage
palette → Install), or from `~/.node-red`:

    npm install node-red-contrib-plaiiinlight

## Nodes

### plaiiinlight-config

A **config node** — one shared MQTT connection + lamp-discovery hub, reused
by every `plaiiinlight-command`/`plaiiinlight-state` node wired to it. The
connection is lazy: a deployed config node with nothing wired to it never
opens a socket.

Editor fields:

| Field | Default | Notes |
|---|---|---|
| Broker host | *(required)* | hostname or IP of the MQTT broker. |
| Port | `1883` | |
| Use TLS | off | connects `mqtts://` instead of `mqtt://` when checked. |
| Topic prefix | `plaiiinlight` | must match the firmware's prefix (the firmware uses the fixed literal `plaiiinlight`). |
| Username / Password | *(optional)* | broker credentials, stored in Node-RED's encrypted credential store — never written into exported flow JSON. |

On connect it subscribes to `<prefix>/+/status` (every lamp's retained
online/offline topic) and feeds it into a small in-memory registry. That
registry is what powers the lamp dropdown described below.

### plaiiinlight-command

Sends one power/color/brightness/mode/effect command to a lamp.

Editor fields: **Config** (a `plaiiinlight-config` node), **Lamp** (target
lamp's MQTT node name, e.g. `tower8` — pick from the discovery dropdown or
type one in manually), **Action**, and either a static **Value** or **Use
msg.payload for value**.

Each action publishes to `<prefix>/<lamp>/<topic suffix>`:

| Action | Topic suffix | Accepted friendly inputs | Wire payload |
|---|---|---|---|
| `power` | `power/set` | string `"on"` / `"1"` / `"true"` (case-insensitive) → on; anything else, or any other truthy/falsy value | `"1"` or `"0"` |
| `color` | `color/set` | `"#rrggbb"` hex string · `{r, g, b}` object · `{h, s, v}` object · bare `"n,n,n"` string (read as **HSV**, not RGB — see note below) | `"h,s,v"` (H 0–360, S 0–100, V 0–100) |
| `brightness` | `brightness/set` | number `0`–`255` · numeric string · percentage string `"NN%"` | `"0"`–`"255"` (clamped, rounded) |
| `mode` | `mode/set` | `"color"` / `"solid"` (synonym) · `"js"` | `"color"` or `"js"` |
| `effect-next` | `effect/next` | *(no value — ignored)* | empty payload |
| `effect-prev` | `effect/prev` | *(no value — ignored)* | empty payload |

Any input that can't be parsed (bad hex, unknown mode string, non-finite
number, ...) raises a `PayloadError`: the node logs it, sets a red status
dot, and **publishes nothing**.

**HSV under the hood:** the firmware's `color/set` topic only speaks HSV
(`"h,s,v"`) — see `lampos/main/plaiiin_mqtt.c`. A `"#rrggbb"` string or
`{r, g, b}` object is converted to HSV in this node before publishing, using
the same rounding the firmware itself uses, so round-tripping a color stays
stable. A bare `"n,n,n"` string is *always* read as HSV, never RGB — there's
no reliable way to tell an `"r,g,b"` string apart from an `"h,s,v"` string by
shape alone. Use the `{r,g,b}` object form or `"#rrggbb"` if you have RGB.

Status: green dot = command published. Red dot = value failed to map to a
payload (nothing sent). Red ring = not configured (missing config node or
lamp).

### plaiiinlight-state

No inputs — subscribes to one lamp's `status`, `power/get`, `color/get`,
`brightness/get` and `mode/get` topics and emits a message on every update:

```js
msg = {
  topic: "tower8",       // the lamp's MQTT node name
  payload: {
    online: true,        // from the retained status/LWT topic
    power: true,
    color: { h: 24, s: 100, v: 100, r: 255, g: 102, b: 0, hex: "#ff6600" },
    brightness: 200,
    mode: "color",        // "color" | "js" | "stream" — whatever the firmware publishes
  },
  changed: "brightness",  // which key in payload just triggered this message
}
```

`payload` only contains keys the node has actually heard a value for since
it started (it merges updates into a running object, so early messages may
be missing keys until the first retained/`status` traffic arrives for each
topic). Multiple `plaiiinlight-state` nodes can watch the same lamp on the
same config node without duplicating broker subscriptions — it's
refcounted.

Status: green dot = lamp online. Grey ring = offline, or nothing heard yet.
Red ring = not configured (missing config node or lamp).

## Discovery / the lamp dropdown

The config node's `<prefix>/+/status` subscription (see above) feeds a
`LampRegistry`. Any `plaiiinlight-command`/`plaiiinlight-state` node's edit
panel calls the config node's admin endpoint
(`GET /plaiiinlight/<config-id>/lamps`) to populate the **Lamp** field's
dropdown with lamps that have announced themselves. Manual entry into the
Lamp field always works too — a lamp that hasn't published a `status`
message yet (freshly flashed, broker not deployed yet, etc.) still won't be
in the dropdown, but you can type its name in directly.

## Also works with generic MQTT nodes

This package doesn't gate any capability behind itself — every topic above
is a plain MQTT topic (`<prefix>/<lamp>/power/set`, `.../color/get`, ...)
that core `mqtt in`/`mqtt out` nodes can read and write directly, with the
raw wire formats documented in the table above (no friendly coercion, no
discovery — you write the exact payload string). Use this package for the
convenience of friendly inputs, shared connection management, and the lamp
picker; use core MQTT nodes if you'd rather not add a dependency, or need a
topic shape this package doesn't cover.

## Example flow

[`examples/flows.json`](./examples/flows.json) — importable via the Node-RED
editor's menu → Import. It wires up:

- an `inject` node with a `"#ff8800"` string payload → a `plaiiinlight-command`
  node (action `color`, using `msg.payload`)
- a `plaiiinlight-state` node → a `debug` node, to watch a lamp's state live
- an `inject` node → a `plaiiinlight-command` node (action `effect-next`)

Edit the included `plaiiinlight-config` node's host to point at your broker
(it ships with a placeholder host and no credentials) before deploying.

## License

Apache-2.0. The plugin talks to the lamp's open, documented MQTT interface from the
[PlaiiinLightOS firmware](https://github.com/nebeleben/plaiiin-light).
