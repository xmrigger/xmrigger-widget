import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const win = getCurrentWindow();

const LS = {
  get:  k       => localStorage.getItem(k) ?? '',
  set:  (k, v)  => localStorage.setItem(k, v),
  num:  (k, def) => parseInt(localStorage.getItem(k)) || def,
};

const COMMON_POOLS = [
  // Hetzner-friendly (no datacenter bans known)
  'gulf.moneroocean.stream:10128',
  'pool.supportxmr.com:3333',
  'mine.c3pool.com:13333',
  'xmrpool.eu:3333',
  'xmr.bohemianpool.com:3333',
  // General (may ban datacenter IPs)
  'pool.hashvault.pro:3333',
  'xmr.nanopool.org:14444',
  'xmr.2miners.com:2222',
  'xmr.herominers.com:10191',
  'eu.monero.herominers.com:10191',
  'us.monero.herominers.com:10191',
  'sg.monero.herominers.com:10191',
  'xmrpool.net:3333',
  'xmr.coinfoundry.org:3344',
  // P2Pool (decentralised, no pool — only local node)
  '127.0.0.1:3333',
];

// ── Phases ────────────────────────────────────────────────────────────────────
const P = {
  IDLE:          'idle',
  SEARCHING:     'searching',
  FOUND:         'found',
  NOT_FOUND:     'not_found',
  EDIT:          'edit',
  INSTALLING:    'installing',
  DONE_INSTALL:  'done_install',
};

export default function ConfigApp() {
  // Persist phase so a webview reload doesn't lose state
  const [phase,        setPhase]       = useState(() => {
    const saved = LS.get('_phase');
    // Only restore phases that make sense after a reload
    return (saved === P.EDIT || saved === P.FOUND || saved === P.DONE_INSTALL)
      ? saved : P.IDLE;
  });
  const [xmrigPath,    setXmrigPath]   = useState(() => LS.get('xmrigPath'));
  const [proxyPort,    setProxyPort]   = useState(() => LS.num('proxyPort', 3333));
  const [upstreamPool, setUpstreamPool]= useState(() => {
    const p = LS.get('upstreamPool') || COMMON_POOLS[0];
    if (p.includes('minexmr.com')) { LS.set('upstreamPool', COMMON_POOLS[0]); return COMMON_POOLS[0]; }
    return p;
  });
  const [wallet,       setWallet]      = useState(() => LS.get('wallet'));
  const [password,     setPassword]    = useState(() => LS.get('password') || 'x');
  const [running,       setRunning]      = useState(false);
  const [proxyRunning,  setProxyRunning] = useState(false);
  const [proxyPath,     setProxyPath]    = useState('');
  const [statsUrl,      setStatsUrl]     = useState('');
  const [proxyStarted,  setProxyStarted] = useState(false);
  const [progress,      setProgress]     = useState({ percent: 0, status: '', downloaded: 0, total: 0 });
  const [avInfo,        setAvInfo]       = useState(null);
  const [avState,       setAvState]      = useState('idle');
  const [statusMsg,     setStatusMsg]    = useState('');
  const [poolOpen,      setPoolOpen]     = useState(false);
  const [directMode,    setDirectMode]   = useState(() => LS.get('directMode') === '1');
  const [xmrigExited,   setXmrigExited]  = useState(false);
  const [manualPath,    setManualPath]   = useState('');
  const prevRunningRef = useRef(false);

  // Persist phase on change
  useEffect(() => { LS.set('_phase', phase); }, [phase]);

  // Sync upstream pool from running proxy stats (fixes stale localStorage value)
  useEffect(() => {
    fetch('http://127.0.0.1:9090/stats', { signal: AbortSignal.timeout(1500) })
      .then(r => r.json())
      .then(data => {
        if (data.pool && data.pool !== '—') {
          setUpstreamPool(data.pool);
          LS.set('upstreamPool', data.pool);
        }
      })
      .catch(() => {});
  }, []);

  // On mount: legge da LS direttamente (evita closure stale), valida path, auto-cerca
  useEffect(() => {
    async function initCheck() {
      const savedPath  = LS.get('xmrigPath');
      const savedPhase = LS.get('_phase');

      if (savedPath) {
        const ok = await invoke('check_xmrig_path', { path: savedPath }).catch(() => false);
        if (!ok) {
          // File sparito (Defender, spostato, reinstallazione pulita)
          LS.set('xmrigPath', '');
          LS.set('_phase', P.NOT_FOUND);
          setXmrigPath('');
          setPhase(P.NOT_FOUND);
          setStatusMsg('xmrig non trovato al percorso salvato — reinstalla o cerca di nuovo');
          return;
        }
        // Path valido: assicura di essere in EDIT se non già lì
        if (savedPhase !== P.EDIT && savedPhase !== P.FOUND) {
          setPhase(P.EDIT);
        }
        return;
      }

      // Nessun path salvato → cerca subito (non aspettare click utente)
      setPhase(P.SEARCHING);
      try {
        const found = await invoke('find_xmrig');
        if (found) {
          setXmrigPath(found);
          LS.set('xmrigPath', found);
          setPhase(P.EDIT);
        } else {
          setPhase(P.NOT_FOUND);
        }
      } catch {
        setPhase(P.NOT_FOUND);
      }
    }
    initCheck();
  }, []); // solo al mount

  // Rileva uscita xmrig
  useEffect(() => {
    if (prevRunningRef.current === true && running === false) {
      setXmrigExited(true);
    }
    prevRunningRef.current = running;
  }, [running]);

  const handleDragStart = useCallback(async e => {
    if (e.button !== 0) return;
    try { await win.startDragging(); } catch {}
  }, []);

  // Trova proxy path all'avvio
  useEffect(() => {
    invoke('find_xmrigger_proxy').then(p => { if (p) setProxyPath(p); }).catch(() => {});
  }, []);

  // Aggiorna stats URL quando cambia la pool
  useEffect(() => {
    invoke('known_pool_stats_url', { pool: upstreamPool })
      .then(url => setStatsUrl(url || ''))
      .catch(() => setStatsUrl(''));
  }, [upstreamPool]);

  // Poll xmrig running state
  useEffect(() => {
    const id = setInterval(async () => {
      try { setRunning(await invoke('xmrig_running')); } catch {}
    }, 2000);
    return () => clearInterval(id);
  }, []);

  // Poll proxy via HTTP — works for manually started proxies too
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('http://127.0.0.1:9090/stats', { signal: AbortSignal.timeout(1000) });
        setProxyRunning(res.ok);
      } catch {
        setProxyRunning(false);
      }
    };
    const id = setInterval(check, 2000);
    return () => clearInterval(id);
  }, []);

  // Install progress listener
  useEffect(() => {
    let unProgress, unComplete;
    (async () => {
      unProgress = await listen('xmrig-progress', ({ payload: d }) => {
        setProgress({ percent: d.percent, status: d.status, downloaded: d.downloaded, total: d.total });
      });
      unComplete = await listen('xmrig-install-complete', ({ payload: path }) => {
        setXmrigPath(path);
        LS.set('xmrigPath', path);
        setPhase(P.DONE_INSTALL);
      });
    })();
    return () => { unProgress?.(); unComplete?.(); };
  }, []);

  // Auto-detect AV when entering not_found
  useEffect(() => {
    if (phase !== P.NOT_FOUND) return;
    setAvState('checking');
    invoke('detect_antivirus').then(info => {
      setAvInfo(info);
      setAvState(info.exclusions_configured ? 'configured' : 'detected');
    }).catch(() => setAvState('detected'));
  }, [phase]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  const handleSearch = useCallback(async () => {
    setPhase(P.SEARCHING);
    setStatusMsg('');
    try {
      const path = await invoke('find_xmrig');
      if (!path) { setPhase(P.NOT_FOUND); return; }
      setXmrigPath(path);
      LS.set('xmrigPath', path);
      setPhase(P.FOUND);
    } catch (e) {
      setStatusMsg(String(e));
      setPhase(P.NOT_FOUND);
    }
  }, []);

  const handleLoadConfig = useCallback(async () => {
    try {
      const cfg = await invoke('read_xmrig_config', { exePath: xmrigPath });
      const p0 = cfg?.pools?.[0];
      if (p0?.url && !p0.url.startsWith('127.')) {
        setUpstreamPool(p0.url);
        LS.set('upstreamPool', p0.url);
      }
      if (p0?.user) { setWallet(p0.user); LS.set('wallet', p0.user); }
      if (p0?.pass && p0.pass !== 'x') { setPassword(p0.pass); LS.set('password', p0.pass); }
    } catch {}
    setPhase(P.EDIT);
  }, [xmrigPath]);

  const handleConfigureAV = useCallback(async () => {
    setAvState('configuring');
    try {
      await invoke('setup_antivirus_exclusions');
      const info = await invoke('detect_antivirus');
      setAvInfo(info);
      setAvState(info.exclusions_configured ? 'configured' : 'detected');
    } catch (e) {
      setAvState('detected');
      setStatusMsg(String(e));
    }
  }, []);

  const handleInstall = useCallback(async () => {
    setPhase(P.INSTALLING);
    setProgress({ percent: 0, status: 'Avvio…', downloaded: 0, total: 0 });
    setStatusMsg('');
    try {
      const res = await invoke('install_xmrig');
      if (!res.success) throw new Error(res.message);
    } catch (e) {
      setStatusMsg(String(e));
      setPhase(P.NOT_FOUND);
    }
  }, []);

  const handleSave = useCallback(async () => {
    LS.set('xmrigPath',    xmrigPath);
    LS.set('proxyPort',    String(proxyPort));
    LS.set('upstreamPool', upstreamPool);
    LS.set('wallet',       wallet);
    LS.set('password',     password);

    setStatusMsg('');
    try {
      await invoke('write_xmrig_config', {
        exePath:   xmrigPath,
        proxyPort: Number(proxyPort),
        wallet,
        password,
      });
      setStatusMsg('config.json updated ✓');
    } catch (e) {
      setStatusMsg('Error: ' + String(e));
    }
  }, [xmrigPath, proxyPort, upstreamPool, wallet, password]);

  const handleStart = useCallback(async () => {
    await handleSave();
    setStatusMsg('');
    try {
      if (!directMode) {
        if (!proxyPath) { setStatusMsg('xmrigger-proxy non trovato'); return; }

        // Ferma qualsiasi proxy in esecuzione (spawned o esterno)
        try { await invoke('stop_proxy'); } catch {}
        setProxyRunning(false);
        // Aspetta che il proxy sia davvero morto (porta libera) — max 3s
        for (let i = 0; i < 12; i++) {
          await new Promise(r => setTimeout(r, 250));
          try {
            await fetch('http://127.0.0.1:9090/stats', { signal: AbortSignal.timeout(150) });
          } catch {
            break; // connection refused = porta libera
          }
        }

        // Avvia il proxy con la pool corretta
        await invoke('launch_proxy', {
          proxyPath,
          pool:       upstreamPool,
          listenPort: Number(proxyPort),
          statsUrl:   statsUrl || '',
        });
        setProxyRunning(true);

        // Aspetta che il proxy sia pronto (max 5s)
        let ready = false;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          try {
            const r = await fetch('http://127.0.0.1:9090/stats', { signal: AbortSignal.timeout(400) });
            if (r.ok) { ready = true; break; }
          } catch {}
        }
        if (!ready) setStatusMsg('proxy avviato (stats non ancora disponibili)');
      }

      await invoke('launch_xmrig', {
        exePath:  xmrigPath,
        pool:     directMode ? upstreamPool : `127.0.0.1:${proxyPort}`,
        wallet,
        password,
      });
      setRunning(true);
      setXmrigExited(false);
    } catch (e) {
      setStatusMsg('Start failed: ' + String(e));
    }
  }, [xmrigPath, proxyPort, upstreamPool, wallet, password, directMode, proxyPath, statsUrl, handleSave]);

  const handleStop = useCallback(async () => {
    try { await invoke('stop_xmrig'); setRunning(false); } catch {}
    try { await invoke('stop_proxy'); setProxyRunning(false); } catch {}
  }, []);

  const handleStartProxy = useCallback(async () => {
    if (!proxyPath) { setStatusMsg('xmrigger-proxy non trovato'); return; }
    try {
      await invoke('launch_proxy', {
        proxyPath,
        pool:       upstreamPool,
        listenPort: Number(proxyPort),
        statsUrl:   statsUrl || '',
      });
      setProxyRunning(true);
      setProxyStarted(true);
      setStatusMsg('proxy avviato');
    } catch (e) {
      setStatusMsg('Proxy failed: ' + String(e));
    }
  }, [proxyPath, upstreamPool, proxyPort, statsUrl]);

  const handleStopProxy = useCallback(async () => {
    try { await invoke('stop_proxy'); setProxyRunning(false); } catch {}
  }, []);

  const canStart = xmrigPath.trim() !== '' && wallet.trim() !== '';

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={s.root}>
      {/* Title bar */}
      <div style={s.titleBar} onMouseDown={handleDragStart}>
        <span style={s.title}>xmrigger — settings</span>
        <span style={s.verBadge}>v0.1.0-β</span>
        <button style={s.closeBtn} onMouseDown={e => e.stopPropagation()} onClick={() => win.hide()}>×</button>
      </div>

      <div style={s.body}>

        {/* ── IDLE ──────────────────────────────────────────────────── */}
        {phase === P.IDLE && (
          <div style={s.center}>
            <div style={s.bigHint}>xmrig not configured</div>
            <button style={s.bigBtn} onClick={handleSearch}>
              🔍 Find xmrig
            </button>
            {xmrigPath && (
              <button style={{ ...s.smallBtn, marginTop: 8 }} onClick={() => setPhase(P.EDIT)}>
                Configure existing path
              </button>
            )}
          </div>
        )}

        {/* ── SEARCHING ─────────────────────────────────────────────── */}
        {phase === P.SEARCHING && (
          <div style={s.center}>
            <div style={s.spinner}>⟳</div>
            <div style={s.hint}>searching…</div>
          </div>
        )}

        {/* ── FOUND ─────────────────────────────────────────────────── */}
        {phase === P.FOUND && (
          <div style={s.section}>
            <div style={{ ...s.badge, background: 'rgba(0,230,118,0.1)', borderColor: '#00e676' }}>
              <span style={{ color: '#00e676', fontWeight: 700 }}>✓ xmrig found</span>
              <span style={{ color: '#666', fontSize: '12px', marginTop: 3 }}>{xmrigPath}</span>
            </div>
            <div style={s.row}>
              <button style={s.actionBtn} onClick={handleLoadConfig}>
                Load config
              </button>
              <button style={{ ...s.actionBtn, background: 'rgba(0,230,118,0.12)', color: '#00e676' }} onClick={() => setPhase(P.EDIT)}>
                Configure
              </button>
            </div>
          </div>
        )}

        {/* ── NOT_FOUND ─────────────────────────────────────────────── */}
        {(phase === P.NOT_FOUND || phase === P.INSTALLING) && (
          <div style={s.section}>
            {phase === P.NOT_FOUND && (
              <div style={{ ...s.badge, borderColor: '#ff4444' }}>
                <span style={{ color: '#ff4444', fontWeight: 700 }}>✗ xmrig not found</span>
                {statusMsg && <span style={{ color: '#888', fontSize: '12px' }}>{statusMsg}</span>}
              </div>
            )}

            {/* Antivirus */}
            <div style={s.avBox}>
              <div style={s.label}>ANTIVIRUS</div>
              {avState === 'checking' && <div style={s.hint}>detecting…</div>}
              {avState !== 'checking' && avInfo && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {avInfo.windows_defender && (
                    <div style={{ ...s.avRow, color: avInfo.exclusions_configured ? '#00e676' : '#ffcc00' }}>
                      {avInfo.exclusions_configured ? '✓' : '⚠'} Windows Defender
                      {avInfo.exclusions_configured
                        ? <span style={s.avTag}>exclusions OK</span>
                        : <span style={s.avTagWarn}>xmrig may be blocked</span>}
                    </div>
                  )}
                  {avInfo.malwarebytes && (
                    <div style={{ ...s.avRow, color: '#aaa' }}>
                      ⚠ Malwarebytes detected — add manual exclusion
                    </div>
                  )}
                  {!avInfo.windows_defender && !avInfo.malwarebytes && (
                    <div style={{ ...s.avRow, color: '#555' }}>no antivirus detected</div>
                  )}
                </div>
              )}
              {avState === 'detected' && avInfo?.windows_defender && (
                <button
                  style={{ ...s.smallBtn, marginTop: 6, color: '#ffcc00', borderColor: 'rgba(255,204,0,0.3)' }}
                  onClick={handleConfigureAV}
                >
                  Add Windows Defender exclusions
                </button>
              )}
              {avState === 'configuring' && <div style={s.hint}>configuring… (approve UAC)</div>}
            </div>

            {/* Install button + progress */}
            {phase === P.NOT_FOUND && (
              <button style={{ ...s.bigBtn, marginTop: 4 }} onClick={handleInstall}>
                ↓ Install xmrig v6.21.0
              </button>
            )}
            {phase === P.INSTALLING && (
              <div style={s.progressBox}>
                <div style={s.progressLabel}>
                  <span>{progress.status}</span>
                  <span style={{ color: '#00e676' }}>{progress.percent.toFixed(0)}%</span>
                </div>
                <div style={s.progressTrack}>
                  <div style={{ ...s.progressBar, width: `${progress.percent}%` }} />
                </div>
                {progress.total > 0 && (
                  <div style={s.progressBytes}>
                    {fmtBytes(progress.downloaded)} / {fmtBytes(progress.total)}
                  </div>
                )}
              </div>
            )}

            {/* Manual path entry */}
            {phase === P.NOT_FOUND && (
              <div style={s.fieldGroup}>
                <div style={s.label}>USE EXISTING PATH</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    style={{ ...s.input, fontSize: '11px', flex: 1 }}
                    value={manualPath}
                    onChange={e => setManualPath(e.target.value)}
                    placeholder="C:\path\to\xmrig.exe"
                    spellCheck={false}
                  />
                  <button
                    style={{ ...s.smallBtn, whiteSpace: 'nowrap', color: manualPath ? '#00e676' : '#555', borderColor: manualPath ? 'rgba(0,230,118,0.3)' : undefined }}
                    disabled={!manualPath.trim()}
                    onClick={() => {
                      const p = manualPath.trim();
                      setXmrigPath(p);
                      LS.set('xmrigPath', p);
                      setManualPath('');
                      setPhase(P.EDIT);
                    }}
                  >
                    Use
                  </button>
                </div>
                <div style={s.manualHint}>
                  or download from{' '}
                  <span
                    style={{ color: '#4af', cursor: 'pointer', textDecoration: 'underline' }}
                    onClick={() => window.open('https://github.com/xmrig/xmrig/releases', '_blank')}
                  >
                    github.com/xmrig/xmrig
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── DONE_INSTALL ──────────────────────────────────────────── */}
        {phase === P.DONE_INSTALL && (
          <div style={s.section}>
            <div style={{ ...s.badge, background: 'rgba(0,230,118,0.1)', borderColor: '#00e676' }}>
              <span style={{ color: '#00e676', fontWeight: 700 }}>✓ xmrig installed</span>
              <span style={{ color: '#666', fontSize: '12px', marginTop: 3 }}>{xmrigPath}</span>
            </div>
            <button style={{ ...s.bigBtn, background: 'rgba(0,230,118,0.12)', color: '#00e676' }} onClick={() => setPhase(P.EDIT)}>
              Configure now →
            </button>
          </div>
        )}

        {/* ── EDIT ──────────────────────────────────────────────────── */}
        {phase === P.EDIT && (
          <div style={s.section}>

            {/* xmrig path — editable + re-search */}
            <div style={s.fieldGroup}>
              <div style={s.label}>XMRIG PATH</div>
              <div style={{ display: 'flex', gap: 5 }}>
                <input
                  style={{ ...s.input, fontSize: '11px', color: '#666', flex: 1 }}
                  value={xmrigPath}
                  onChange={e => { setXmrigPath(e.target.value); LS.set('xmrigPath', e.target.value); }}
                  placeholder="C:\path\to\xmrig.exe"
                  spellCheck={false}
                />
                <button
                  style={{ ...s.smallBtn, padding: '4px 7px', flexShrink: 0 }}
                  title="Search again"
                  onClick={handleSearch}
                >
                  🔍
                </button>
              </div>
            </div>

            {/* Modo: diretto vs proxy */}
            <div style={s.modeToggle}>
              <button
                style={{ ...s.modeBtn, ...(directMode ? {} : s.modeBtnActive) }}
                onClick={() => { setDirectMode(false); LS.set('directMode', '0'); }}
              >
                via proxy
              </button>
              <button
                style={{ ...s.modeBtn, ...(directMode ? s.modeBtnActive : {}) }}
                onClick={() => { setDirectMode(true); LS.set('directMode', '1'); }}
              >
                direct
              </button>
            </div>

            {/* Info box */}
            {!directMode ? (
              <div style={s.infoBox}>
                <div style={s.infoTitle}>ℹ Proxy mode</div>
                <div style={s.infoText}>
                  xmrig connects to the local proxy (<code>127.0.0.1:{proxyPort}</code>) which monitors
                  pool hashrate concentration. Start <code>xmrigger-proxy</code> first.
                </div>
              </div>
            ) : (
              <div style={{ ...s.infoBox, borderColor: 'rgba(255,204,0,0.2)', background: 'rgba(255,204,0,0.04)' }}>
                <div style={{ ...s.infoTitle, color: '#ffcc00' }}>⚡ Direct mode</div>
                <div style={s.infoText}>
                  xmrig connects directly to pool. No proxy monitoring.
                  Use to test xmrig works.
                </div>
              </div>
            )}

            {/* Pool config */}
            {!directMode ? (
              <div style={s.twoCol}>
                <div style={{ ...s.fieldGroup, flex: '0 0 80px' }}>
                  <div style={s.label}>PROXY PORT</div>
                  <input
                    style={s.input}
                    type="number"
                    value={proxyPort}
                    onChange={e => { setProxyPort(Number(e.target.value)); LS.set('proxyPort', e.target.value); }}
                    min={1024} max={65535}
                  />
                </div>
                <div style={{ ...s.fieldGroup, flex: 1, position: 'relative' }}>
                  <div style={s.label}>UPSTREAM POOL</div>
                  <input
                    style={s.input}
                    value={upstreamPool}
                    onChange={e => { setUpstreamPool(e.target.value); LS.set('upstreamPool', e.target.value); }}
                    placeholder="host:porta"
                    spellCheck={false}
                    onFocus={() => setPoolOpen(true)}
                    onBlur={() => setTimeout(() => setPoolOpen(false), 150)}
                  />
                  {poolOpen && (
                    <div style={s.dropdown}>
                      {COMMON_POOLS.map(p => (
                        <div
                          key={p}
                          style={{ ...s.dropItem, background: p === upstreamPool ? 'rgba(0,230,118,0.1)' : 'transparent' }}
                          onMouseDown={() => { setUpstreamPool(p); LS.set('upstreamPool', p); setPoolOpen(false); }}
                        >
                          {p}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ ...s.fieldGroup, position: 'relative' }}>
                <div style={s.label}>POOL</div>
                <input
                  style={s.input}
                  value={upstreamPool}
                  onChange={e => { setUpstreamPool(e.target.value); LS.set('upstreamPool', e.target.value); }}
                  placeholder="host:porta"
                  spellCheck={false}
                  onFocus={() => setPoolOpen(true)}
                  onBlur={() => setTimeout(() => setPoolOpen(false), 150)}
                />
                {poolOpen && (
                  <div style={s.dropdown}>
                    {COMMON_POOLS.map(p => (
                      <div
                        key={p}
                        style={{ ...s.dropItem, background: p === upstreamPool ? 'rgba(0,230,118,0.1)' : 'transparent' }}
                        onMouseDown={() => { setUpstreamPool(p); LS.set('upstreamPool', p); setPoolOpen(false); }}
                      >
                        {p}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Target label */}
            <div style={s.autoLabel}>
              xmrig → <span style={{ color: directMode ? '#ffcc00' : '#00e676' }}>
                {directMode ? upstreamPool : `127.0.0.1:${proxyPort}`}
              </span>
            </div>

            {/* Proxy control — solo in proxy mode */}
            {!directMode && (
              <div style={s.proxyCtrl}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ ...s.dot, background: proxyRunning ? '#00e676' : '#333', flexShrink: 0 }} />
                  <span style={{ fontSize: '12px', color: proxyRunning ? '#00e676' : '#555', flex: 1 }}>
                    {proxyRunning ? 'proxy running' : proxyPath ? 'proxy found — not started' : 'xmrigger-proxy not found'}
                  </span>
                  {!proxyRunning ? (
                    <button
                      style={{ ...s.smallBtn, color: proxyPath ? '#00e676' : '#555', borderColor: proxyPath ? 'rgba(0,230,118,0.3)' : 'rgba(255,255,255,0.1)' }}
                      onClick={handleStartProxy}
                      disabled={!proxyPath}
                    >
                      ▶ Start Proxy
                    </button>
                  ) : (
                    <button style={{ ...s.smallBtn, color: '#ff4444', borderColor: 'rgba(255,68,68,0.3)' }} onClick={handleStopProxy}>
                      ■ Stop
                    </button>
                  )}
                </div>
                {!proxyPath && (
                  <ProxyCmd pool={upstreamPool} port={proxyPort} statsUrl={statsUrl} />
                )}
              </div>
            )}

            <hr style={s.hr} />

            {/* Wallet */}
            <div style={s.fieldGroup}>
              <div style={s.label}>MONERO WALLET</div>
              <input
                style={s.input}
                value={wallet}
                onChange={e => setWallet(e.target.value)}
                placeholder="4…"
                spellCheck={false}
              />
            </div>

            {/* Password */}
            <div style={s.fieldGroup}>
              <div style={s.label}>PASSWORD</div>
              <input
                style={s.input}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="x"
                spellCheck={false}
              />
            </div>

            {/* Status */}
            {statusMsg && (
              <div style={{ ...s.statusLine, color: statusMsg.includes('✓') ? '#00e676' : '#ff8800' }}>
                {statusMsg}
              </div>
            )}

            {/* Actions */}
            <div style={s.actions}>
              {running ? (
                <button style={{ ...s.runBtn, background: '#ff2222', color: '#fff' }} onClick={handleStop}>
                  ■ Stop xmrig
                </button>
              ) : (
                <button
                  style={{ ...s.runBtn, background: canStart ? '#00e676' : '#333', color: canStart ? '#000' : '#555', cursor: canStart ? 'pointer' : 'default' }}
                  onClick={handleStart}
                  disabled={!canStart}
                >
                  ▶ Save &amp; Start
                </button>
              )}
              <button style={s.saveOnlyBtn} onClick={handleSave}>
                Save config
              </button>
              <div style={s.runBadge}>
                <span style={{ ...s.dot, background: running ? '#00e676' : '#333' }} />
                <span style={{ color: running ? '#00e676' : '#444' }}>{running ? 'running' : 'stopped'}</span>
              </div>
            </div>


            {/* xmrig uscito inaspettatamente */}
            {xmrigExited && !running && (
              <div style={s.exitedBox}>
                <span style={{ color: '#ff8800', fontWeight: 700 }}>⚠ xmrig stopped</span>
                <button
                  style={{ ...s.smallBtn, color: '#00e676', borderColor: 'rgba(0,230,118,0.3)', marginTop: 4 }}
                  disabled={!canStart}
                  onClick={() => { setXmrigExited(false); handleStart(); }}
                >
                  ▶ Restart
                </button>
              </div>
            )}

          </div>
        )}

      </div>
    </div>
  );
}

// ── ProxyCmd ──────────────────────────────────────────────────────────────────

function ProxyCmd({ pool, port, statsUrl, onCopy }) {
  const [copied, setCopied] = React.useState(false);
  // Usa il percorso locale noto se xmrigger-proxy non è in PATH globale
  const base = 'H:\\xmrigger-proxy\\bin\\xmrigger-proxy.js';
  let cmd = `node "${base}" --pool ${pool} --listen ${port}`;
  if (statsUrl) cmd += ` --stats ${statsUrl}`;

  const copy = () => {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      onCopy?.();
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div style={s.proxyCmdBox}>
      <div style={s.label}>OR START MANUALLY</div>
      <div style={s.cmdRow}>
        <code style={s.cmdText}>{cmd}</code>
        <button style={{ ...s.copyBtn, color: copied ? '#00e676' : '#555' }} onClick={copy} title="Copy">
          {copied ? '✓' : '⎘'}
        </button>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  root: {
    width:        '360px',
    height:       '480px',
    background:   'rgba(13,13,18,0.97)',
    border:       '1px solid rgba(255,255,255,0.1)',
    borderRadius: '8px',
    display:      'flex',
    flexDirection:'column',
    fontFamily:   "'JetBrains Mono','Courier New',monospace",
    fontSize:     '13px',
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
    flex: 1, color: '#00e676', fontWeight: 700, fontSize: '13px', letterSpacing: '0.5px',
  },
  closeBtn: {
    background: 'none', border: 'none', color: '#555', fontSize: '16px',
    cursor: 'pointer', lineHeight: 1, padding: '0 2px',
  },
  verBadge: {
    fontSize:   '11px',
    color:      '#444',
    flexShrink: 0,
    marginRight: 4,
  },
  body: {
    flex: 1, padding: '12px 14px', overflowY: 'auto',
    display: 'flex', flexDirection: 'column',
  },
  center: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 10, textAlign: 'center',
  },
  bigHint: { color: '#555', fontSize: '13px' },
  hint: { color: '#555', fontSize: '12px', fontStyle: 'italic' },
  spinner: {
    fontSize: '24px', color: '#00e676',
    animation: 'spin 1s linear infinite',
  },
  bigBtn: {
    background:   'rgba(0,230,118,0.1)',
    border:       '1px solid rgba(0,230,118,0.25)',
    borderRadius: '5px',
    color:        '#00e676',
    fontSize:     '13px',
    fontWeight:   700,
    cursor:       'pointer',
    padding:      '8px 18px',
    fontFamily:   "'JetBrains Mono','Courier New',monospace",
    letterSpacing:'0.3px',
  },
  smallBtn: {
    background:   'rgba(255,255,255,0.05)',
    border:       '1px solid rgba(255,255,255,0.1)',
    borderRadius: '4px',
    color:        '#888',
    fontSize:     '12px',
    cursor:       'pointer',
    padding:      '4px 10px',
    fontFamily:   "'JetBrains Mono','Courier New',monospace",
    alignSelf:    'flex-start',
  },
  section: {
    display: 'flex', flexDirection: 'column', gap: 10,
  },
  badge: {
    display:      'flex',
    flexDirection:'column',
    padding:      '8px 10px',
    borderRadius: '5px',
    border:       '1px solid rgba(255,255,255,0.1)',
    background:   'rgba(255,255,255,0.03)',
    gap:          2,
  },
  row: {
    display: 'flex', gap: 8,
  },
  actionBtn: {
    flex:         1,
    background:   'rgba(255,255,255,0.05)',
    border:       '1px solid rgba(255,255,255,0.1)',
    borderRadius: '4px',
    color:        '#aaa',
    fontSize:     '12px',
    cursor:       'pointer',
    padding:      '7px 6px',
    fontFamily:   "'JetBrains Mono','Courier New',monospace",
    textAlign:    'center',
  },
  avBox: {
    background:   'rgba(255,255,255,0.02)',
    border:       '1px solid rgba(255,255,255,0.07)',
    borderRadius: '5px',
    padding:      '8px 10px',
    display:      'flex',
    flexDirection:'column',
    gap:          5,
  },
  avRow: {
    display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px',
  },
  avTag: {
    marginLeft: 'auto', color: '#00e676', fontSize: '12px',
  },
  avTagWarn: {
    marginLeft: 'auto', color: '#ffcc00', fontSize: '12px',
  },
  progressBox: {
    display: 'flex', flexDirection: 'column', gap: 5,
  },
  progressLabel: {
    display: 'flex', justifyContent: 'space-between', fontSize: '12px',
  },
  progressTrack: {
    height: '6px', background: 'rgba(255,255,255,0.08)',
    borderRadius: '3px', overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    background: 'linear-gradient(90deg, #00e676, #00bfa5)',
    transition: 'width 0.3s ease',
    borderRadius: '3px',
  },
  progressBytes: {
    fontSize: '12px', color: '#555', textAlign: 'right',
  },
  manualHint: {
    fontSize: '12px', color: '#555', textAlign: 'center', marginTop: 4,
  },
  infoBox: {
    background:   'rgba(0,180,255,0.06)',
    border:       '1px solid rgba(0,180,255,0.15)',
    borderRadius: '5px',
    padding:      '8px 10px',
  },
  infoTitle: {
    color: '#4af', fontSize: '12px', fontWeight: 700, marginBottom: 4,
  },
  infoText: {
    color: '#778', fontSize: '12px', lineHeight: 1.5,
  },
  twoCol: {
    display: 'flex', gap: 8,
  },
  fieldGroup: {
    display: 'flex', flexDirection: 'column', gap: 4,
  },
  label: {
    color: '#555', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.8px',
  },
  input: {
    background:   'rgba(255,255,255,0.06)',
    border:       '1px solid rgba(255,255,255,0.1)',
    borderRadius: '4px',
    color:        '#ccc',
    fontSize:     '13px',
    padding:      '5px 7px',
    fontFamily:   "'JetBrains Mono','Courier New',monospace",
    outline:      'none',
    userSelect:   'text',
    width:        '100%',
    boxSizing:    'border-box',
  },
  dropdown: {
    position:     'absolute',
    top:          '100%',
    left:         0,
    right:        0,
    background:   'rgba(20,20,28,0.98)',
    border:       '1px solid rgba(255,255,255,0.1)',
    borderRadius: '4px',
    zIndex:       100,
    overflow:     'hidden',
    marginTop:    2,
  },
  dropItem: {
    padding:    '6px 8px',
    fontSize:   '12px',
    cursor:     'pointer',
    color:      '#aaa',
  },
  autoLabel: {
    fontSize: '12px', color: '#556', fontStyle: 'italic', marginTop: -4,
  },
  hr: {
    border: 'none', borderTop: '1px solid rgba(255,255,255,0.06)', margin: '0',
  },
  statusLine: {
    fontSize: '12px', wordBreak: 'break-all',
  },
  actions: {
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
  },
  runBtn: {
    border:      'none',
    borderRadius:'4px',
    fontSize:    '13px',
    fontWeight:  700,
    padding:     '7px 14px',
    fontFamily:  "'JetBrains Mono','Courier New',monospace",
    cursor:      'pointer',
  },
  saveOnlyBtn: {
    background:   'rgba(255,255,255,0.05)',
    border:       '1px solid rgba(255,255,255,0.1)',
    borderRadius: '4px',
    color:        '#666',
    fontSize:     '12px',
    cursor:       'pointer',
    padding:      '5px 10px',
    fontFamily:   "'JetBrains Mono','Courier New',monospace",
  },
  runBadge: {
    display: 'flex', alignItems: 'center', gap: 5,
    fontSize: '12px', marginLeft: 'auto',
  },
  dot: {
    width: 7, height: 7, borderRadius: '50%',
    display: 'inline-block', flexShrink: 0,
  },
  backBtn: {
    background:   'none',
    border:       'none',
    color:        '#444',
    fontSize:     '12px',
    cursor:       'pointer',
    padding:      '4px 0',
    fontFamily:   "'JetBrains Mono','Courier New',monospace",
    textAlign:    'left',
    marginTop:    'auto',
  },
  proxyCmdBox: {
    display: 'flex', flexDirection: 'column', gap: 4,
  },
  cmdRow: {
    display:      'flex',
    alignItems:   'center',
    background:   'rgba(255,255,255,0.04)',
    border:       '1px solid rgba(255,255,255,0.08)',
    borderRadius: '4px',
    padding:      '5px 8px',
    gap:          6,
  },
  cmdText: {
    flex:       1,
    fontSize:   '12px',
    color:      '#4af',
    fontFamily: "'JetBrains Mono','Courier New',monospace",
    wordBreak:  'break-all',
    lineHeight: 1.4,
  },
  proxyReminder: {
    background:   'rgba(255,204,0,0.07)',
    border:       '1px solid rgba(255,204,0,0.2)',
    borderRadius: '5px',
    padding:      '8px 10px',
    display:      'flex',
    flexDirection:'column',
    gap:          5,
  },
  copyBtn: {
    background:  'none',
    border:      'none',
    fontSize:    '13px',
    cursor:      'pointer',
    flexShrink:  0,
    padding:     '0 2px',
    lineHeight:  1,
  },
  modeToggle: {
    display:      'flex',
    gap:          0,
    borderRadius: '4px',
    overflow:     'hidden',
    border:       '1px solid rgba(255,255,255,0.1)',
    alignSelf:    'flex-start',
  },
  modeBtn: {
    background:  'transparent',
    border:      'none',
    color:       '#555',
    fontSize:    '12px',
    padding:     '4px 12px',
    cursor:      'pointer',
    fontFamily:  "'JetBrains Mono','Courier New',monospace",
  },
  modeBtnActive: {
    background: 'rgba(255,255,255,0.1)',
    color:      '#ccc',
  },
  exitedBox: {
    background:   'rgba(255,136,0,0.07)',
    border:       '1px solid rgba(255,136,0,0.2)',
    borderRadius: '5px',
    padding:      '8px 10px',
    display:      'flex',
    flexDirection:'column',
  },
  proxyCtrl: {
    background:   'rgba(255,255,255,0.02)',
    border:       '1px solid rgba(255,255,255,0.07)',
    borderRadius: '5px',
    padding:      '7px 10px',
    display:      'flex',
    flexDirection:'column',
    gap:          4,
  },
};
