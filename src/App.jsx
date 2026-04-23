import React, { useEffect, useRef, useState, useCallback } from 'react';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';

const win = getCurrentWindow();
const STATS_URL  = 'http://127.0.0.1:9090/stats';
const POLL_MS    = 3_000;
const W          = 220;
const COMPACT_H  = 90;
const PEER_HDR_H = 24;
const PEER_ROW_H = 36;

const STATUS_LABEL = {
  starting: 'STARTING', running: 'RUNNING', safe: 'SAFE',
  warn: 'WARN', crit: 'CRITICAL', evacuating: 'EVAC',
};
const STATUS_COLOR = {
  starting: '#888', running: '#00e676', safe: '#00e676',
  warn: '#ffcc00', crit: '#ff2222', evacuating: '#ff8800', offline: '#555',
};

function segColor(midPct, threshold) {
  if (midPct <= 0.30) return '#00e676';
  if (midPct <= 0.40) return '#ffcc00';
  if (midPct <= threshold) return '#ff8800';
  return '#ff2222';
}

function VUMeter({ pct, threshold = 0.43 }) {
  const SEGS    = 18;
  const safePct = pct != null ? Math.min(Math.max(pct, 0), 1) : null;
  const litCount = safePct != null ? Math.round(safePct * SEGS) : 0;

  return (
    <div style={{ display: 'flex', gap: 2, flex: 1, alignItems: 'center', height: '100%' }}>
      {Array.from({ length: SEGS }, (_, i) => {
        const midPct = (i + 0.5) / SEGS;
        const isLit  = safePct != null && i < litCount;
        const color  = segColor(midPct, threshold);
        const isTick = i === Math.round(threshold * SEGS) - 1;
        return (
          <div key={i} style={{
            flex:         1,
            height:       10,
            borderRadius: 1,
            background:   isLit ? color : 'rgba(255,255,255,0.05)',
            boxShadow:    isLit ? `0 0 4px ${color}88` : 'none',
            transition:   'background 0.15s, box-shadow 0.2s',
            outline:      isTick ? '1px solid rgba(255,136,0,0.5)' : 'none',
            animation:    isLit ? `ledPulse 2s ease-in-out infinite` : 'none',
            animationDelay: `${(i % 4) * 0.15}s`,
          }} />
        );
      })}
    </div>
  );
}

export default function App() {
  const [stats,     setStats]     = useState(null);
  const [offline,   setOffline]   = useState(false);
  const [peersOpen, setPeersOpen] = useState(false);
  const pollRef = useRef(null);

  const handleDragStart = useCallback(async e => {
    if (e.button !== 0) return;
    try { await win.startDragging(); } catch {}
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(STATS_URL, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (!cancelled) { setStats(data); setOffline(false); }
      } catch {
        if (!cancelled) setOffline(true);
      }
    }
    poll();
    pollRef.current = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(pollRef.current); };
  }, []);

  const peerList = stats?.peerList ?? [];
  const peers    = stats?.peers    ?? 0;

  useEffect(() => {
    const rows = peersOpen ? Math.max(peerList.length, 1) : 0;
    const h = COMPACT_H + (peersOpen ? PEER_HDR_H + rows * PEER_ROW_H : 0);
    win.setSize(new LogicalSize(W, h)).catch(() => {});
  }, [peersOpen, peerList.length]);

  const status      = offline ? 'offline' : (stats?.status ?? 'starting');
  const connections = stats?.connections ?? 0;
  const pool        = stats?.pool        ?? '—';
  const threshold   = stats?.threshold   ?? 0.43;
  const isMining    = !offline && connections > 0;
  const pct         = isMining ? (stats?.hashratePct ?? null) : null;
  const label       = STATUS_LABEL[status] ?? status.toUpperCase();
  const color       = STATUS_COLOR[status]  ?? '#888';
  const isCrit      = status === 'crit' || (pct != null && pct > threshold);

  return (
    <div style={{ width: W, background: 'rgba(13,13,18,0.96)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, display: 'flex', flexDirection: 'column', fontFamily: "'JetBrains Mono','Courier New',monospace", fontSize: 13, color: '#ccc', userSelect: 'none', overflow: 'hidden' }}>

      {/* ── Top bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px', background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid rgba(255,255,255,0.06)', cursor: 'move', gap: 5, flexShrink: 0, height: 30 }} onMouseDown={handleDragStart}>
        <span style={{ color: '#00e676', fontWeight: 700, fontSize: 13, letterSpacing: '0.5px', flexShrink: 0 }}>xmrigger</span>
        <span style={{ fontSize: 10, color: '#555', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 3, padding: '1px 3px', flexShrink: 0 }}>β</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: '#888', textAlign: 'right', opacity: offline ? 0.4 : 1 }} title={offline ? 'proxy offline' : pool}>
          {offline ? 'offline' : pool}
        </span>
        <button style={btn} onMouseDown={e => e.stopPropagation()} onClick={() => invoke('toggle_config_panel')} title="Settings">⚙</button>
        <button style={{ ...btn, fontSize: 16 }} onMouseDown={e => e.stopPropagation()} onClick={() => win.close()}>×</button>
      </div>

      {/* ── VU meter row ── */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px', gap: 7, height: 34, flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        <VUMeter pct={pct} threshold={threshold} />
        <span style={{ width: 46, textAlign: 'right', fontSize: 14, fontWeight: 700, letterSpacing: '0.5px', color: pct != null ? color : '#2a2a2a', flexShrink: 0, animation: isCrit ? 'blink 0.8s infinite' : 'none' }}>
          {pct != null ? `${(pct * 100).toFixed(1)}%` : '—'}
        </span>
      </div>

      {/* ── Status bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px', gap: 5, height: 26, flexShrink: 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0, animation: isCrit ? 'blink 0.8s infinite' : 'none' }} />
        <span style={{ fontSize: 11, fontWeight: 700, color, letterSpacing: '0.5px', flex: 1, animation: isCrit ? 'blink 0.8s infinite' : 'none' }}>{label}</span>
        <span style={{ fontSize: 12, color: isMining ? '#00e676' : '#2d2d2d', fontWeight: 700, animation: isMining ? 'pulse 2s ease-in-out infinite' : 'none', flexShrink: 0 }}>
          {isMining ? '⛏' : '○'}
        </span>
        {connections > 0 && <span style={tag}>{connections}m</span>}
        {peers > 0 && (
          <button
            style={{ ...tag, cursor: 'pointer', border: `1px solid ${peersOpen ? 'rgba(0,230,118,0.35)' : 'rgba(255,255,255,0.08)'}`, background: peersOpen ? 'rgba(0,230,118,0.08)' : 'rgba(255,255,255,0.05)', color: peersOpen ? '#00e676' : '#555' }}
            onClick={() => setPeersOpen(o => !o)}
          >
            {peers}p
          </button>
        )}
        <button style={{ background: 'none', border: 'none', color: '#444', fontSize: 11, cursor: 'pointer', padding: '0 2px', flexShrink: 0, lineHeight: 1 }} onClick={() => setPeersOpen(o => !o)}>
          {peersOpen ? '▲' : '▼'}
        </button>
      </div>

      {/* ── Peer panel ── */}
      {peersOpen && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '4px 8px 5px', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, height: PEER_HDR_H - 8 }}>
            <span style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: '1px' }}>Peers</span>
            {peers < 2 && <span style={{ fontSize: 10, color: '#ff8800' }}>≥2 for full analysis</span>}
          </div>
          {peers === 0 && (
            <div style={{ fontSize: 11, color: '#444', fontStyle: 'italic', height: PEER_ROW_H, display: 'flex', alignItems: 'center' }}>no peers connected</div>
          )}
          {peers > 0 && peerList.length === 0 && (
            <div style={{ fontSize: 11, color: '#555', height: PEER_ROW_H, display: 'flex', alignItems: 'center' }}>
              {peers} peer{peers !== 1 ? 's' : ''} — waiting first message…
            </div>
          )}
          {peerList.map((peer, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, height: PEER_ROW_H, padding: '0 4px', background: 'rgba(255,255,255,0.02)', borderRadius: 3, marginBottom: 2 }}>
              <span style={{ fontSize: 10, color: '#555', fontFamily: 'monospace', flexShrink: 0, width: 56 }}>{peer.id ?? `#${i+1}`}</span>
              <span style={{ fontSize: 11, color: '#888', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={peer.pool ?? '—'}>{peer.pool ?? '—'}</span>
              <span style={{ fontSize: 11, color: peer.hashratePct != null ? color : '#444', flexShrink: 0, width: 38, textAlign: 'right' }}>
                {peer.hashratePct != null ? `${(peer.hashratePct*100).toFixed(1)}%` : '—'}
              </span>
            </div>
          ))}
        </div>
      )}

      <style>{`
        @keyframes blink   { 0%,100% { opacity:1; }  50% { opacity:0.2; } }
        @keyframes pulse   { 0%,100% { opacity:1; }  50% { opacity:0.5; } }
        @keyframes ledPulse{ 0%,100% { opacity:0.8; } 50% { opacity:1; } }
        ::-webkit-scrollbar { display:none; }
      `}</style>
    </div>
  );
}

const btn = {
  background: 'none', border: 'none', color: '#555',
  fontSize: 14, cursor: 'pointer', lineHeight: 1,
  padding: '0 2px', flexShrink: 0,
};

const tag = {
  fontSize: 10, color: '#555',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 3, padding: '0 4px',
  lineHeight: '16px', flexShrink: 0,
  fontFamily: "'JetBrains Mono','Courier New',monospace",
};
