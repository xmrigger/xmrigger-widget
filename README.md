# xmrigger-widget

Always-on-top desktop widget for [xmrigger-proxy](https://github.com/xmrigger/xmrigger-proxy). Shows real-time pool hashrate concentration and mesh federation status.

Part of the [xmrigger suite](https://github.com/xmrigger): `xmrigger` · `xmrigger-mesh` · `xmrigger-proxy` · `xmrigger-widget`

---

## What it does

Connects to the local xmrigger-proxy stats endpoint (`http://127.0.0.1:9090/stats`) and displays:

- **Fuel gauge** — pool share of total Monero network hashrate, color-coded by risk level
- **Status indicator** — SAFE / WARN / CRITICAL / EVACUATING
- **Federation panel** (expandable) — mesh peer count, threshold, active alerts

The window is 220×140 px, frameless, always-on-top, transparent background. Double-click or use the expand button to show the federation panel.

---

## Color zones

| Range | Color | Meaning |
|-------|-------|---------|
| 0–30% | Green | Pool well within safe limits |
| 30–40% | Yellow | Elevated — approaching warning threshold |
| 40–43% | Orange | Warning — close to evacuation threshold |
| >43% | Red | Critical — xmrigger-proxy will evacuate |

The threshold (default 43%) is read from the proxy and shown as a tick on the gauge.

---

## Requirements

- [xmrigger-proxy](https://github.com/xmrigger/xmrigger-proxy) running locally with `--stats-port 9090`
- [Rust + Tauri CLI](https://tauri.app/start/prerequisites/) for building from source

---

## Quick start

```bash
git clone https://github.com/xmrigger/xmrigger-widget
cd xmrigger-widget
npm install
npm run tauri:dev
```

To build a distributable binary:

```bash
npm run tauri:build
```

---

## Stats endpoint

The widget expects xmrigger-proxy to expose a JSON endpoint at the configured port:

```json
{
  "status":      "safe",
  "pool":        "pool.hashvault.pro:3333",
  "hashratePct": 0.21,
  "threshold":   0.43,
  "peers":       3,
  "listenPort":  3333,
  "alert":       null
}
```

---

## Project

Released under [LGPL-2.1](LICENSE).
