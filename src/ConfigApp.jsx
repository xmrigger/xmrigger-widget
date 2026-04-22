import React, { useState, useEffect, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';

const win = getCurrentWindow();

const LS = {
  get: k => localStorage.getItem(k) ?? '',
  set: (k, v) => localStorage.setItem(k, v),
};

export default function ConfigApp() {
  const [xmrigPath, setXmrigPath] = useState(() => LS.get('xmrigPath'));
  const [pool,      setPool]      = useState(() => LS.get('pool') || 'pool.hashvault.pro:3333');
  const [wallet,    setWallet]    = useState(() => LS.get('wallet'));
  const [password,  setPassword]  = useState(() => LS.get('password') || 'x');
  const [running,   setRunning]   = useState(false);
  const [finding,   setFinding]   = useState(false);
  const [status,    setStatus]    = useState('');

  // Poll xmrig running state
  useEffect(() => {
    const poll = async () => {
      try { setRunning(await invoke('xmrig_running')); } catch {}
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, []);

  const save = useCallback(() => {
    LS.set('xmrigPath', xmrigPath);
    LS.set('pool',      pool);
    LS.set('wallet',    wallet);
    LS.set('password',  password);
  }, [xmrigPath, pool, wallet, password]);

  const handleDragStart = useCallback(async e => {
    if (e.button !== 0) return;
    try { await win.startDragging(); } catch {}
  }, []);

  const handleFind = useCallback(async () => {
    setFinding(true);
    setStatus('');
    try {
      const path = await invoke('find_xmrig');
      if (!path) { setStatus('xmrig.exe not found'); setFinding(false); return; }
      setXmrigPath(path);
      LS.set('xmrigPath', path);
      // Pre-fill from existing xmrig config.json if present
      const cfg = await invoke('read_xmrig_config', { exePath: path });
      const p0  = cfg?.pools?.[0];
      if (p0?.url)  { setPool(p0.url);   LS.set('pool', p0.url); }
      if (p0?.user) { setWallet(p0.user); LS.set('wallet', p0.user); }
      if (p0?.pass && p0.pass !== 'x') { setPassword(p0.pass); LS.set('password', p0.pass); }
      setStatus('Found: ' + path);
    } catch (e) {
      setStatus(String(e));
    }
    setFinding(false);
  }, []);

  const handleStart = useCallback(async () => {
    setStatus('');
    save();
    try {
      await invoke('launch_xmrig', { exePath: xmrigPath, pool, wallet, password });
      setRunning(true);
      setStatus('xmrig started');
    } catch (e) {
      setStatus(String(e));
    }
  }, [xmrigPath, pool, wallet, password, save]);

  const handleStop = useCallback(async () => {
    try {
      await invoke('stop_xmrig');
      setRunning(false);
      setStatus('xmrig stopped');
    } catch (e) {
      setStatus(String(e));
    }
  }, []);

  const canStart = xmrigPath.trim() !== '' && wallet.trim() !== '';

  return (
    <div style={s.root}>
      {/* Title bar / drag */}
      <div style={s.titleBar} onMouseDown={handleDragStart}>
        <span style={s.title}>xmrigger — settings</span>
        <button style={s.closeBtn} onMouseDown={e => e.stopPropagation()} onClick={() => win.hide()}>×</button>
      </div>

      <div style={s.body}>
        {/* ── xmrig binary ───────────────────────────── */}
        <div style={s.section}>
          <div style={s.sectionLabel}>xmrig</div>
          <div style={s.inputRow}>
            <input
              style={s.input}
              value={xmrigPath}
              onChange={e => setXmrigPath(e.target.value)}
              placeholder="path to xmrig.exe"
              spellCheck={false}
            />
          </div>
          <button style={s.smallBtn} onClick={handleFind} disabled={finding}>
            {finding ? 'searching…' : 'Auto-detect'}
          </button>
        </div>

        <hr style={s.hr} />

        {/* ── Pool config ─────────────────────────────── */}
        <div style={s.section}>
          <div style={s.sectionLabel}>Pool</div>
          <input
            style={s.input}
            value={pool}
            onChange={e => setPool(e.target.value)}
            placeholder="host:port"
            spellCheck={false}
          />
        </div>

        <div style={s.section}>
          <div style={s.sectionLabel}>Wallet address</div>
          <input
            style={s.input}
            value={wallet}
            onChange={e => setWallet(e.target.value)}
            placeholder="4…"
            spellCheck={false}
          />
        </div>

        <div style={s.section}>
          <div style={s.sectionLabel}>Password</div>
          <input
            style={s.input}
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="x"
            spellCheck={false}
          />
        </div>

        <hr style={s.hr} />

        {/* ── Status line ─────────────────────────────── */}
        {status && (
          <div style={{ ...s.statusLine, color: status.startsWith('Found') ? '#00e676' : '#ff8800' }}>
            {status}
          </div>
        )}

        {/* ── Actions ─────────────────────────────────── */}
        <div style={s.actions}>
          {running ? (
            <button style={{ ...s.actionBtn, background: '#ff2222', color: '#fff' }} onClick={handleStop}>
              ■ Stop xmrig
            </button>
          ) : (
            <button
              style={{ ...s.actionBtn, background: canStart ? '#00e676' : '#333', color: canStart ? '#000' : '#555', cursor: canStart ? 'pointer' : 'default' }}
              onClick={handleStart}
              disabled={!canStart}
            >
              ▶ Start xmrig
            </button>
          )}
          <div style={s.runningBadge}>
            <span style={{ ...s.dot, background: running ? '#00e676' : '#333' }} />
            <span style={{ color: running ? '#00e676' : '#444' }}>{running ? 'running' : 'stopped'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  root: {
    width:        '360px',
    height:       '400px',
    background:   'rgba(13,13,18,0.97)',
    border:       '1px solid rgba(255,255,255,0.1)',
    borderRadius: '8px',
    display:      'flex',
    flexDirection:'column',
    fontFamily:   "'JetBrains Mono','Courier New',monospace",
    fontSize:     '11px',
    color:        '#ccc',
    userSelect:   'none',
    overflow:     'hidden',
  },
  titleBar: {
    display:     'flex',
    alignItems:  'center',
    padding:     '6px 10px',
    background:  'rgba(255,255,255,0.04)',
    borderBottom:'1px solid rgba(255,255,255,0.06)',
    cursor:      'move',
    flexShrink:  0,
  },
  title: {
    flex:         1,
    color:        '#00e676',
    fontWeight:   700,
    fontSize:     '11px',
    letterSpacing:'0.5px',
  },
  closeBtn: {
    background: 'none',
    border:     'none',
    color:      '#555',
    fontSize:   '14px',
    cursor:     'pointer',
    lineHeight: 1,
    padding:    '0 2px',
  },
  body: {
    flex:          1,
    padding:       '12px 14px',
    overflowY:     'auto',
    display:       'flex',
    flexDirection: 'column',
    gap:           '10px',
  },
  section: {
    display:       'flex',
    flexDirection: 'column',
    gap:           '4px',
  },
  sectionLabel: {
    color:         '#555',
    fontSize:      '10px',
    textTransform: 'uppercase',
    letterSpacing: '1px',
  },
  inputRow: {
    display: 'flex',
    gap:     '6px',
  },
  input: {
    flex:        1,
    background:  'rgba(255,255,255,0.06)',
    border:      '1px solid rgba(255,255,255,0.1)',
    borderRadius:'4px',
    color:       '#ccc',
    fontSize:    '11px',
    padding:     '5px 8px',
    fontFamily:  "'JetBrains Mono','Courier New',monospace",
    outline:     'none',
    userSelect:  'text',
  },
  smallBtn: {
    alignSelf:   'flex-start',
    background:  'rgba(255,255,255,0.06)',
    border:      '1px solid rgba(255,255,255,0.1)',
    borderRadius:'4px',
    color:       '#888',
    fontSize:    '10px',
    cursor:      'pointer',
    padding:     '4px 10px',
    fontFamily:  "'JetBrains Mono','Courier New',monospace",
  },
  hr: {
    border:    'none',
    borderTop: '1px solid rgba(255,255,255,0.06)',
    margin:    '0',
  },
  statusLine: {
    fontSize:  '10px',
    wordBreak: 'break-all',
  },
  actions: {
    display:    'flex',
    alignItems: 'center',
    gap:        '12px',
    marginTop:  'auto',
    paddingTop: '4px',
  },
  actionBtn: {
    border:      'none',
    borderRadius:'4px',
    fontSize:    '11px',
    fontWeight:  700,
    padding:     '7px 16px',
    fontFamily:  "'JetBrains Mono','Courier New',monospace",
  },
  runningBadge: {
    display:    'flex',
    alignItems: 'center',
    gap:        '5px',
    fontSize:   '10px',
  },
  dot: {
    width:       7,
    height:      7,
    borderRadius:'50%',
    display:     'inline-block',
    flexShrink:  0,
  },
};
