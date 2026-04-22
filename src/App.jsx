import React, { useEffect, useRef, useState, useCallback } from 'react';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import FuelGauge from './components/FuelGauge.jsx';

const win = getCurrentWindow();

const STATS_URL  = 'http://127.0.0.1:9090/stats';
const POLL_MS    = 3_000;

const COMPACT_H  = 140;
const EXPANDED_H = 320;
const W          = 220;

const STATUS_LABEL = {
  starting:   'STARTING',
  running:    'RUNNING',
  safe:       'SAFE',
  warn:       'WARN',
  crit:       'CRITICAL',
  evacuating: 'EVACUATING',
};

const STATUS_COLOR = {
  starting:   '#888',
  running:    '#00e676',
  safe:       '#00e676',
  warn:       '#ffcc00',
  crit:       '#ff2222',
  evacuating: '#ff8800',
  offline:    '#555',
};

export default function App() {
  const [stats,    setStats]    = useState(null);
  const [offline,  setOffline]  = useState(false);
  const [expanded, setExpanded] = useState(false);
  const pollRef = useRef(null);

  const toggleExpand = useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
    try {
      await win.setSize(new LogicalSize(W, next ? EXPANDED_H : COMPACT_H));
    } catch {}
  }, [expanded]);

  const handleDragStart = useCallback(async (e) => {
    if (e.button !== 0) return;
    try { await win.startDragging(); } catch {}
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(STATS_URL, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) throw new Error('non-200');
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

  const status = offline ? 'offline' : (stats?.status ?? 'starting');
  const pct    = stats?.hashratePct ?? null;
  const pool   = stats?.pool   ?? '—';
  const peers  = stats?.peers  ?? 0;
  const threshold = stats?.threshold ?? 0.43;
  const label  = STATUS_LABEL[status] ?? status.toUpperCase();
  const color  = STATUS_COLOR[status] ?? '#888';
  const isCrit = status === 'crit' || pct > threshold;

  return (
    <div style={{ ...styles.root, height: expanded ? `${EXPANDED_H}px` : `${COMPACT_H}px` }}
         onDoubleClick={toggleExpand}>

      {/* Drag region — top bar */}
      <div style={styles.topBar} onMouseDown={handleDragStart}>
        <span style={styles.appName}>xmrigger</span>
        <span style={{ ...styles.poolName, opacity: offline ? 0.4 : 1 }}>
          {offline ? 'proxy offline' : pool}
        </span>
        <button style={styles.gearBtn} onMouseDown={e => e.stopPropagation()} onClick={() => invoke('toggle_config_panel')} title="Settings">⚙</button>
        <button style={styles.closeBtn} onMouseDown={e => e.stopPropagation()} onClick={() => win.close()}>×</button>
      </div>

      {/* Fuel gauge */}
      <div style={styles.gaugeArea}>
        <FuelGauge pct={pct} threshold={threshold} />
        <div style={{ ...styles.pctText, color, animation: isCrit ? 'blink 0.8s infinite' : 'none' }}>
          {pct != null ? `${(pct * 100).toFixed(1)}%` : '—'}
        </div>
      </div>

      {/* Status bar */}
      <div style={styles.statusBar}>
        <span style={{ ...styles.statusDot, background: color, animation: isCrit ? 'blink 0.8s infinite' : 'none' }} />
        <span style={{ ...styles.statusLabel, color }}>{label}</span>
        {peers > 0 && <span style={styles.peers}>{peers} peer{peers !== 1 ? 's' : ''}</span>}
        <button style={styles.expandBtn} onClick={toggleExpand} title={expanded ? 'Collapse' : 'Expand'}>
          {expanded ? '▲' : '▼'}
        </button>
      </div>

      {/* Federation panel — visible when expanded */}
      {expanded && (
        <div style={styles.fedPanel}>
          <div style={styles.fedTitle}>Federation</div>
          {offline && <div style={styles.fedOffline}>proxy not running</div>}
          {!offline && peers === 0 && <div style={styles.fedOffline}>no mesh peers</div>}
          {!offline && peers > 0 && (
            <div style={styles.fedOffline}>{peers} peer{peers !== 1 ? 's' : ''} connected</div>
          )}
          <hr style={styles.hr} />
          <div style={styles.fedTitle}>Stats</div>
          <div style={styles.fedRow}>
            <span style={styles.fedKey}>Threshold</span>
            <span style={styles.fedVal}>{(threshold * 100).toFixed(0)}%</span>
          </div>
          <div style={styles.fedRow}>
            <span style={styles.fedKey}>Listen</span>
            <span style={styles.fedVal}>{stats?.listenPort ? `:${stats.listenPort}` : '—'}</span>
          </div>
          {stats?.alert && (
            <div style={styles.alert}>⚠ {stats.alert}</div>
          )}
          <hr style={styles.hr} />
          <div style={styles.fedRow}>
            <span style={{ ...styles.fedKey, fontSize: '10px', opacity: 0.5 }}>
              double-click to toggle
            </span>
          </div>
        </div>
      )}

      <style>{`
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
        ::-webkit-scrollbar { display: none; }
      `}</style>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = {
  root: {
    width:        `${W}px`,
    background:   'rgba(13, 13, 18, 0.96)',
    border:       '1px solid rgba(255,255,255,0.08)',
    borderRadius: '8px',
    display:      'flex',
    flexDirection:'column',
    fontFamily:   "'JetBrains Mono', 'Courier New', monospace",
    fontSize:     '11px',
    color:        '#ccc',
    userSelect:   'none',
    overflow:     'hidden',
  },
  topBar: {
    display:      'flex',
    alignItems:   'center',
    padding:      '5px 8px',
    background:   'rgba(255,255,255,0.04)',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    cursor:       'move',
    gap:          '6px',
    flexShrink:   0,
  },
  appName: {
    color:        '#00e676',
    fontWeight:   700,
    fontSize:     '11px',
    letterSpacing:'0.5px',
    flexShrink:   0,
  },
  poolName: {
    flex:         1,
    overflow:     'hidden',
    textOverflow: 'ellipsis',
    whiteSpace:   'nowrap',
    fontSize:     '10px',
    color:        '#888',
    textAlign:    'right',
  },
  gearBtn: {
    background: 'none',
    border:     'none',
    color:      '#555',
    fontSize:   '12px',
    cursor:     'pointer',
    lineHeight: 1,
    padding:    '0 2px',
    flexShrink: 0,
  },
  closeBtn: {
    background:   'none',
    border:       'none',
    color:        '#555',
    fontSize:     '14px',
    cursor:       'pointer',
    lineHeight:   1,
    padding:      '0 2px',
    flexShrink:   0,
  },
  gaugeArea: {
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    flex:           1,
    padding:        '4px 0 0',
    position:       'relative',
  },
  pctText: {
    position:     'absolute',
    bottom:       '10px',
    fontSize:     '18px',
    fontWeight:   700,
    letterSpacing:'1px',
  },
  statusBar: {
    display:    'flex',
    alignItems: 'center',
    padding:    '4px 8px',
    borderTop:  '1px solid rgba(255,255,255,0.06)',
    gap:        '5px',
    flexShrink: 0,
  },
  statusDot: {
    width:      7,
    height:     7,
    borderRadius:'50%',
    flexShrink: 0,
  },
  statusLabel: {
    fontSize:     '10px',
    fontWeight:   700,
    letterSpacing:'0.5px',
    flex:         1,
  },
  peers: {
    fontSize: '10px',
    color:    '#555',
  },
  expandBtn: {
    background: 'none',
    border:     'none',
    color:      '#555',
    fontSize:   '10px',
    cursor:     'pointer',
    padding:    '0 2px',
  },
  fedPanel: {
    padding:    '8px 10px',
    borderTop:  '1px solid rgba(255,255,255,0.06)',
    overflowY:  'auto',
    maxHeight:  `${EXPANDED_H - COMPACT_H}px`,
    flexShrink: 0,
  },
  fedTitle: {
    fontSize:     '10px',
    color:        '#555',
    textTransform:'uppercase',
    letterSpacing:'1px',
    marginBottom: '4px',
  },
  fedOffline: {
    fontSize:     '10px',
    color:        '#555',
    fontStyle:    'italic',
    marginBottom: '6px',
  },
  fedRow: {
    display:        'flex',
    justifyContent: 'space-between',
    marginBottom:   '3px',
  },
  fedKey: {
    color:    '#666',
    fontSize: '11px',
  },
  fedVal: {
    color:    '#aaa',
    fontSize: '11px',
  },
  hr: {
    border:    'none',
    borderTop: '1px solid rgba(255,255,255,0.06)',
    margin:    '6px 0',
  },
  alert: {
    color:      '#ff8800',
    fontSize:   '10px',
    marginTop:  '4px',
    fontWeight: 700,
  },
};
