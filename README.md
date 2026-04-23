# xmrigger-widget

Always-on-top desktop widget that monitors pool hashrate concentration and manages your local miner + proxy in a single click.

Part of the [xmrigger suite](https://github.com/xmrigger): `xmrigger` · `xmrigger-mesh` · `xmrigger-proxy` · `xmrigger-widget`

---

## What it does

```
XMRig ──► 127.0.0.1:3333 ──► xmrigger-proxy ──► pool
                                      │
                               xmrigger-mesh
                                      │
                          other xmrigger-proxy nodes
```

The widget sits in a corner of your screen. One click starts everything: it stops any existing proxy, starts a fresh one pointed at the right pool, waits for it to be ready, then starts XMRig. One click stops everything.

It polls `http://127.0.0.1:9090/stats` every 3 seconds and shows the live state of the proxy.

---

## Interface

```
┌──────────────────────────────────────────────┐
│ xmrigger β  gulf.moneroocean.stream:10128  ⚙ ×│
│ ▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒          21.4%           │
│ ● SAFE                    ⛏  1m  2p ▼        │
└──────────────────────────────────────────────┘
```

**Top bar** — proxy name, active pool, settings gear, close.

**VU meter** — 18 LED segments showing pool hashrate as a fraction of total Monero network hashrate. Color zones:

| Range | Color | Meaning |
|-------|-------|---------|
| 0–30% | Green | Well within safe limits |
| 30–40% | Yellow | Approaching warning threshold |
| 40–43% | Orange | Warning — close to evacuation |
| >43% | Red | Critical — evacuation imminent |

The threshold (default 43%) is read from the proxy and shown as a tick mark on the bar.

**Status bar** — status label (SAFE / WARN / CRITICAL / EVAC), mining indicator (⛏ when connected), miner count (`1m`), peer count (`2p`).

**▼ / ▲ button** — expands a peer panel showing each federation peer's ID, connected pool, and estimated hashrate.

**⚙ button** — opens the settings panel to the right of the widget.

---

## Settings panel

- **XMRIG PATH** — path to xmrig.exe; editable directly or re-searched with 🔍
- **PROXY PORT** — local port the proxy listens on (default 3333)
- **UPSTREAM POOL** — pool the proxy connects to; dropdown of common pools or type any `host:port`
- **Proxy mode / Direct mode** toggle — proxy mode routes through xmrigger-proxy (recommended); direct mode points XMRig straight at the pool with no guard
- **MONERO WALLET** and **PASSWORD**
- **▶ Save & Start** — saves config, stops any running proxy and miner, starts proxy, waits for it to be ready, starts XMRig
- **■ Stop** — stops XMRig and proxy together

If xmrig is not found, the panel shows a NOT FOUND screen with:
- Auto-search (🔍)
- Manual path entry (paste path → Use)
- Auto-install from GitHub (v6.21.0, SHA256 verified)

---

## Stats endpoint

The widget reads from `http://127.0.0.1:9090/stats`:

```json
{
  "status":      "safe",
  "pool":        "gulf.moneroocean.stream:10128",
  "hashratePct": 0.21,
  "threshold":   0.43,
  "connections": 1,
  "peers":       2,
  "listenPort":  3333,
  "alert":       null,
  "peerList": [
    { "id": "a1b2c3d4", "pool": "pool.hashvault.pro:3333", "hashratePct": null }
  ]
}
```

`peerList` is populated by xmrigger-proxy from mesh peer announcements.

---

## Requirements

- [xmrigger-proxy](https://github.com/xmrigger/xmrigger-proxy) available locally (path auto-detected at `H:\xmrigger-proxy\bin\xmrigger-proxy.js` or globally via `npm install -g`)
- [Rust + Tauri CLI](https://tauri.app/start/prerequisites/) for building from source

---

## Quick start

```bash
git clone https://github.com/xmrigger/xmrigger-widget
cd xmrigger-widget
npm install
npm run tauri:dev
```

Build a distributable binary:

```bash
npm run tauri:build
```

---

## Project

Released under [LGPL-2.1](LICENSE).
