use std::sync::Mutex;
use tauri::{Emitter, Manager};

struct XmrigState(Mutex<Option<std::process::Child>>);
struct ProxyState(Mutex<Option<std::process::Child>>);
// Prevents concurrent stop+start races on the proxy
struct ProxyStartLock(Mutex<()>);

// ── SHA256 hashes for XMRig v6.21.0 release archives ─────────────────────────
// Source: https://github.com/xmrig/xmrig/releases/tag/v6.21.0
const XMRIG_VERSION: &str = "6.21.0";
const XMRIG_SHA256: &[(&str, &str)] = &[
    ("xmrig-6.21.0-msvc-win64.zip",          "4cf4198354abfee7e502c85f38e62dbb90fec976e4df38d0ecbfd811937c1981"),
    ("xmrig-6.21.0-gcc-win64.zip",           "4b8e7ff95e742973fb9c8c38ac68f6a1e692b05415036e1c92ee201b3b0e6699"),
    ("xmrig-6.21.0-linux-x64.tar.gz",        "7662ccbd97f0b579e9faf025b9872dc20759a791b572946aec247c12334e0d3f"),
    ("xmrig-6.21.0-linux-static-x64.tar.gz", "c5dc12dbb9bb51ea8acf93d6349d5bc7fe5ee11b68d6371c1bbb098e21d0f685"),
    ("xmrig-6.21.0-linux-arm64.tar.gz",      "NO_OFFICIAL_BUILD"),
    ("xmrig-6.21.0-macos-x64.tar.gz",        "ecd98acb25434368b076e915c7e0d4273f1817a08c09ba4fbfa4d93853b2bd21"),
    ("xmrig-6.21.0-macos-arm64.tar.gz",      "8d5c75d5e8ebf118cd0e1add533d9ff71f29ffa317a9e03c669779f61036cfd9"),
];

// ── Shared structs ─────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct InstallProgress {
    pub percent:    f64,
    pub status:     String,
    pub downloaded: u64,
    pub total:      u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct InstallResult {
    pub success:    bool,
    pub message:    String,
    pub xmrig_path: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct AntivirusInfo {
    pub windows_defender:     bool,
    pub malwarebytes:         bool,
    pub exclusions_configured: bool,
}

// ── Existing commands ─────────────────────────────────────────────────────────

#[tauri::command]
fn check_xmrig_path(path: String) -> bool {
    std::path::Path::new(&path).is_file()
}

#[tauri::command]
fn find_xmrig() -> Option<String> {
    // 1. System PATH
    if let Ok(out) = std::process::Command::new("where").arg("xmrig").output() {
        if out.status.success() {
            if let Ok(s) = String::from_utf8(out.stdout) {
                for line in s.lines() {
                    let p = line.trim();
                    if !p.is_empty() && std::path::Path::new(p).exists() {
                        return Some(p.to_string());
                    }
                }
            }
        }
    }

    let home   = std::env::var("USERPROFILE").unwrap_or_default();
    let appdata = std::env::var("LOCALAPPDATA").unwrap_or_default();

    // 2. Known flat paths
    let flat = [
        format!("{appdata}\\xmrigger\\xmrig.exe"),
        format!("{home}\\xmrig\\xmrig.exe"),
        format!("{home}\\Downloads\\xmrig\\xmrig.exe"),
        format!("{home}\\Desktop\\xmrig\\xmrig.exe"),
        "C:\\xmrig\\xmrig.exe".into(),
        "C:\\Program Files\\XMRig\\xmrig.exe".into(),
        "C:\\Program Files (x86)\\XMRig\\xmrig.exe".into(),
    ];
    for p in &flat {
        if std::path::Path::new(p).exists() {
            return Some(p.clone());
        }
    }

    // 3. Ricerca ricorsiva in %LOCALAPPDATA%\xmrigger — gestisce subdir con versione
    //    (es. xmrig\xmrig-6.21.0\xmrig.exe dopo estrazione zip)
    let xmrigger_dir = std::path::PathBuf::from(format!("{appdata}\\xmrigger"));
    if xmrigger_dir.exists() {
        if let Ok(paths) = walkdir(&xmrigger_dir) {
            for p in paths {
                if p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.eq_ignore_ascii_case("xmrig.exe"))
                    .unwrap_or(false)
                {
                    return Some(p.to_string_lossy().to_string());
                }
            }
        }
    }

    None
}

#[tauri::command]
fn read_xmrig_config(exe_path: String) -> Option<serde_json::Value> {
    let dir = std::path::Path::new(&exe_path).parent()?;
    let content = std::fs::read_to_string(dir.join("config.json")).ok()?;
    serde_json::from_str(&content).ok()
}

#[tauri::command]
fn launch_xmrig(
    state: tauri::State<XmrigState>,
    exe_path: String,
    pool: String,
    wallet: String,
    password: String,
) -> Result<(), String> {
    let mut lock = state.0.lock().unwrap();
    if let Some(mut child) = lock.take() {
        let _ = child.kill();
    }

    let dir = std::path::Path::new(&exe_path)
        .parent()
        .ok_or("invalid exe path")?
        .to_path_buf();

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(&exe_path);
    cmd.args(["--url", &pool, "--user", &wallet, "--pass", &password, "--no-color"])
       .current_dir(&dir);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let child = cmd.spawn().map_err(|e| e.to_string())?;
    *lock = Some(child);
    Ok(())
}

#[tauri::command]
fn stop_xmrig(state: tauri::State<XmrigState>) {
    let mut lock = state.0.lock().unwrap();
    if let Some(mut child) = lock.take() {
        let _ = child.kill();
    }
}

#[tauri::command]
fn xmrig_running(state: tauri::State<XmrigState>) -> bool {
    let mut lock = state.0.lock().unwrap();
    let exited = match lock.as_mut() {
        None => return false,
        Some(child) => match child.try_wait() {
            Ok(Some(_)) => true,
            Ok(None)    => return true,
            Err(_)      => true,
        },
    };
    if exited { *lock = None; }
    false
}

#[tauri::command]
fn toggle_config_panel(app: tauri::AppHandle) -> Result<(), String> {
    let cfg = app.get_webview_window("config")
        .ok_or("config window not found")?;

    if cfg.is_visible().unwrap_or(false) {
        cfg.hide().ok();
        return Ok(());
    }

    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(pos), Ok(scale)) = (main.outer_position(), main.scale_factor()) {
            let cw = (360.0 * scale) as i32;
            let ch = (480.0 * scale) as i32;
            let mw = (220.0 * scale) as i32;
            let x  = pos.x + mw + 8;
            let y  = pos.y.max(0);
            cfg.set_position(tauri::PhysicalPosition::new(x, y)).ok();
        }
    }

    cfg.show().ok();
    cfg.set_focus().ok();
    Ok(())
}

// ── New commands ───────────────────────────────────────────────────────────────

/// Write xmrig config.json pointing pools[0].url to the local proxy.
#[tauri::command]
fn write_xmrig_config(
    exe_path: String,
    proxy_port: u16,
    wallet: String,
    password: String,
) -> Result<(), String> {
    let path = std::path::Path::new(&exe_path);

    // Reject traversal attempts and non-exe paths before touching the filesystem
    if exe_path.contains("..") {
        return Err("invalid exe path: traversal not allowed".into());
    }
    if !path.is_file() {
        return Err("exe_path does not point to an existing file".into());
    }
    // Ensure we're writing next to an actual executable, not into a system dir
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if cfg!(windows) && ext != "exe" {
        return Err("exe_path must point to a .exe file".into());
    }

    let dir = path.parent().ok_or("invalid exe path")?;
    let config_path = dir.join("config.json");

    // Read existing config or start from minimal template
    let mut cfg: serde_json::Value = if config_path.exists() {
        let raw = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("read config: {e}"))?;
        serde_json::from_str(&raw).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Ensure pools array exists
    if cfg.get("pools").is_none() || !cfg["pools"].is_array() {
        cfg["pools"] = serde_json::json!([{}]);
    }
    let pools = cfg["pools"].as_array_mut().unwrap();
    if pools.is_empty() {
        pools.push(serde_json::json!({}));
    }

    let pool_url = format!("127.0.0.1:{proxy_port}");
    pools[0]["url"]       = serde_json::Value::String(pool_url);
    pools[0]["user"]      = serde_json::Value::String(wallet);
    pools[0]["pass"]      = serde_json::Value::String(password);
    pools[0]["keepalive"] = serde_json::Value::Bool(true);
    pools[0]["enabled"]   = serde_json::Value::Bool(true);

    let out = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, out).map_err(|e| format!("write config: {e}"))?;
    Ok(())
}

/// Detect antivirus software and exclusion status.
#[tauri::command]
fn detect_antivirus() -> AntivirusInfo {
    #[cfg(windows)]
    {
        let defender = run_ps("(Get-MpComputerStatus).AntivirusEnabled")
            .map(|s| s.trim().to_lowercase() == "true")
            .unwrap_or(false);

        let malwarebytes = run_ps(
            "Test-Path 'C:\\Program Files\\Malwarebytes\\Anti-Malware\\mbam.exe'"
        )
        .map(|s| s.trim().to_lowercase() == "true")
        .unwrap_or(false);

        let exclusions = run_ps(
            "(Get-MpPreference).ExclusionProcess -contains 'xmrig.exe'"
        )
        .map(|s| s.trim().to_lowercase() == "true")
        .unwrap_or(false);

        AntivirusInfo { windows_defender: defender, malwarebytes, exclusions_configured: exclusions }
    }
    #[cfg(not(windows))]
    {
        AntivirusInfo { windows_defender: false, malwarebytes: false, exclusions_configured: true }
    }
}

/// Add Windows Defender exclusion for xmrig.exe (requires admin — UAC prompt).
#[tauri::command]
fn setup_antivirus_exclusions() -> Result<bool, String> {
    #[cfg(windows)]
    {
        let install_dir = dirs::data_local_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("C:\\"))
            .join("xmrigger");

        // Escape single quotes so the path cannot break out of the PS string literal
        let safe_path = install_dir.to_string_lossy().replace('\'', "''");

        // Pass the two commands inline — no temp file, no TOCTOU window
        let inline = format!(
            "Add-MpPreference -ExclusionProcess 'xmrig.exe' -ErrorAction SilentlyContinue; \
             Add-MpPreference -ExclusionPath '{}' -ErrorAction SilentlyContinue",
            safe_path
        );

        let status = std::process::Command::new("powershell")
            .args([
                "-ExecutionPolicy", "Bypass",
                "-Command",
                &format!(
                    "Start-Process powershell -ArgumentList \"-ExecutionPolicy Bypass -Command `\"{}` \"\" -Verb RunAs -Wait",
                    inline.replace('"', "\\\"")
                ),
            ])
            .status()
            .map_err(|e| e.to_string())?;

        Ok(status.success())
    }
    #[cfg(not(windows))]
    { Ok(true) }
}

/// Download and install XMRig into %LOCALAPPDATA%\xmrigger\xmrig\.
/// Emits `xmrig-progress` events and returns the installed exe path.
#[tauri::command]
async fn install_xmrig(app: tauri::AppHandle) -> Result<InstallResult, String> {
    use sha2::{Digest, Sha256};

    let install_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("C:\\"))
        .join("xmrigger")
        .join("xmrig");

    emit_progress(&app, 0.0, "Creazione directory…", 0, 0);
    std::fs::create_dir_all(&install_dir)
        .map_err(|e| format!("mkdir: {e}"))?;

    let (url, archive_name) = xmrig_download_url()?;
    let archive_path = install_dir.join(&archive_name);

    emit_progress(&app, 5.0, "Download XMRig da GitHub…", 0, 0);

    let client = reqwest::Client::builder()
        .user_agent("xmrigger/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    emit_progress(&app, 10.0, &format!("Download ({:.1} MB)…", total as f64 / 1_048_576.0), 0, total);

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() < 1000 {
        return Err(format!("file troppo piccolo ({} B)", bytes.len()));
    }
    emit_progress(&app, 40.0, "Verifica SHA256…", bytes.len() as u64, total);

    // SHA256 check
    let computed = format!("{:x}", Sha256::digest(&bytes));
    let filename = url.rsplit('/').next().unwrap_or("");
    if let Some((_, expected)) = XMRIG_SHA256.iter().find(|(n, _)| filename.contains(n)) {
        if expected.starts_with("NO_OFFICIAL_BUILD") {
            return Err("Nessun build ufficiale verificato per questa piattaforma.".into());
        }
        if &computed != expected {
            return Err(format!("SHA256 mismatch. Atteso: {expected}\nOttenuto: {computed}"));
        }
    }

    std::fs::write(&archive_path, &bytes)
        .map_err(|e| format!("write archive: {e}"))?;
    emit_progress(&app, 50.0, "Estrazione…", bytes.len() as u64, total);

    // Extract
    #[cfg(windows)]
    extract_zip_windows(&archive_path, &install_dir)?;
    #[cfg(not(windows))]
    extract_tar(&archive_path, &install_dir)?;

    let _ = std::fs::remove_file(&archive_path);
    emit_progress(&app, 90.0, "Localizzazione binario…", 0, 0);

    let found = find_xmrig_in_dir(&install_dir)?;

    // Move exe to flat well-known path so find_xmrig() can locate it later.
    // install_dir = %LOCALAPPDATA%\xmrigger\xmrig  →  flat = %LOCALAPPDATA%\xmrigger\xmrig.exe
    let flat = install_dir
        .parent()
        .map(|p| p.join(if cfg!(windows) { "xmrig.exe" } else { "xmrig" }));

    let exe_path = if let Some(ref flat_path) = flat {
        match std::fs::copy(&found, flat_path) {
            Ok(_) => flat_path.to_string_lossy().to_string(),
            Err(_) => found.clone(), // fallback: use nested path
        }
    } else {
        found.clone()
    };

    emit_progress(&app, 100.0, "Installazione completata!", 0, 0);
    let _ = app.emit("xmrig-install-complete", exe_path.clone());

    Ok(InstallResult {
        success: true,
        message: format!("XMRig installato: {exe_path}"),
        xmrig_path: Some(exe_path),
    })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn emit_progress(app: &tauri::AppHandle, percent: f64, status: &str, downloaded: u64, total: u64) {
    let _ = app.emit("xmrig-progress", InstallProgress {
        percent, status: status.to_string(), downloaded, total,
    });
}

fn xmrig_download_url() -> Result<(String, String), String> {
    let v = XMRIG_VERSION;
    if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
        Ok((
            format!("https://github.com/xmrig/xmrig/releases/download/v{v}/xmrig-{v}-msvc-win64.zip"),
            format!("xmrig-{v}-msvc-win64.zip"),
        ))
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        Ok((
            format!("https://github.com/xmrig/xmrig/releases/download/v{v}/xmrig-{v}-linux-x64.tar.gz"),
            format!("xmrig-{v}-linux-x64.tar.gz"),
        ))
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
        Ok((
            format!("https://github.com/xmrig/xmrig/releases/download/v{v}/xmrig-{v}-macos-x64.tar.gz"),
            format!("xmrig-{v}-macos-x64.tar.gz"),
        ))
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        Ok((
            format!("https://github.com/xmrig/xmrig/releases/download/v{v}/xmrig-{v}-macos-arm64.tar.gz"),
            format!("xmrig-{v}-macos-arm64.tar.gz"),
        ))
    } else {
        Err("Piattaforma non supportata".into())
    }
}

#[cfg(windows)]
fn extract_zip_windows(archive: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    let script = format!(
        "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
        archive.to_string_lossy().replace('\'', "''"),
        dest.to_string_lossy().replace('\'', "''"),
    );
    let out = std::process::Command::new("powershell")
        .args(["-ExecutionPolicy", "Bypass", "-Command", &script])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "Estrazione fallita: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn extract_tar(archive: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    let status = std::process::Command::new("tar")
        .args(["-xzf", &archive.to_string_lossy(), "-C", &dest.to_string_lossy()])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("tar extraction failed".into());
    }
    Ok(())
}

fn find_xmrig_in_dir(dir: &std::path::Path) -> Result<String, String> {
    let name = if cfg!(windows) { "xmrig.exe" } else { "xmrig" };
    for entry in walkdir(dir)? {
        if entry.file_name().unwrap_or_default().to_string_lossy() == name {
            return Ok(entry.to_string_lossy().to_string());
        }
    }
    Err(format!("{name} non trovato dopo l'estrazione"))
}

fn walkdir(dir: &std::path::Path) -> Result<Vec<std::path::PathBuf>, String> {
    let mut results = Vec::new();
    fn recurse(p: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        if p.is_file() { out.push(p.to_path_buf()); return; }
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() { recurse(&e.path(), out); }
        }
    }
    recurse(dir, &mut results);
    Ok(results)
}

#[cfg(windows)]
fn run_ps(cmd: &str) -> Option<String> {
    let out = std::process::Command::new("powershell")
        .args(["-ExecutionPolicy", "Bypass", "-Command", cmd])
        .output()
        .ok()?;
    String::from_utf8(out.stdout).ok()
}

// ── xmrigger-proxy commands ───────────────────────────────────────────────────

/// Cerca xmrigger-proxy: PATH globale → bin/ locale
#[tauri::command]
fn find_xmrigger_proxy() -> Option<String> {
    // 1. Globale (npm install -g xmrigger-proxy)
    #[cfg(windows)]
    if let Ok(out) = std::process::Command::new("where").arg("xmrigger-proxy").output() {
        if out.status.success() {
            if let Ok(s) = String::from_utf8(out.stdout) {
                let p = s.lines().next().unwrap_or("").trim().to_string();
                if !p.is_empty() && std::path::Path::new(&p).exists() {
                    return Some(p);
                }
            }
        }
    }
    // 2. Percorso locale H:\xmrigger-proxy\bin\xmrigger-proxy.js
    let candidates = [
        "H:\\xmrigger-proxy\\bin\\xmrigger-proxy.js",
        "H:/xmrigger-proxy/bin/xmrigger-proxy.js",
    ];
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    None
}

#[tauri::command]
fn launch_proxy(
    state:      tauri::State<ProxyState>,
    start_lock: tauri::State<ProxyStartLock>,
    proxy_path: String,
    pool:       String,
    listen_port: u16,
    stats_url:  String,
) -> Result<(), String> {
    // Serialize concurrent start calls — prevents double-proxy on rapid clicks
    let _guard = start_lock.0.lock().unwrap();
    let mut lock = state.0.lock().unwrap();
    if let Some(mut child) = lock.take() {
        let _ = child.kill();
    }

    let is_js = proxy_path.ends_with(".js");

    #[allow(unused_mut)]
    let mut cmd = if is_js {
        let mut c = std::process::Command::new("node");
        c.arg(&proxy_path);
        c
    } else {
        std::process::Command::new(&proxy_path)
    };

    cmd.args(["--pool", &pool, "--listen", &listen_port.to_string()]);
    if !stats_url.is_empty() {
        cmd.args(["--stats", &stats_url]);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let child = cmd.spawn().map_err(|e| format!("avvio proxy fallito: {e}"))?;
    *lock = Some(child);
    Ok(())
}

#[tauri::command]
fn stop_proxy(state: tauri::State<ProxyState>) {
    let mut lock = state.0.lock().unwrap();
    if let Some(mut child) = lock.take() {
        let _ = child.kill();
    }
    drop(lock);
    kill_port(9090);
}

fn kill_port(port: u16) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Synchronous kill — wait for completion so the port is free when we return
        let cmd = format!(
            "Get-NetTCPConnection -LocalPort {port} -ErrorAction SilentlyContinue \
             | Select-Object -ExpandProperty OwningProcess -Unique \
             | ForEach-Object {{ Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }}"
        );
        let _ = std::process::Command::new("powershell")
            .args(["-ExecutionPolicy", "Bypass", "-Command", &cmd])
            .creation_flags(0x08000000)
            .output(); // blocking — returns only after kill is done
    }
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("sh")
            .args(["-c", &format!("fuser -k {port}/tcp 2>/dev/null")])
            .output();
    }
}

#[tauri::command]
fn proxy_running(state: tauri::State<ProxyState>) -> bool {
    let mut lock = state.0.lock().unwrap();
    let exited = match lock.as_mut() {
        None => return false,
        Some(child) => match child.try_wait() {
            Ok(Some(_)) => true,
            Ok(None)    => return true,
            Err(_)      => true,
        },
    };
    if exited { *lock = None; }
    false
}

/// Stats URL per pool note — usato dal frontend per il comando proxy
#[tauri::command]
fn known_pool_stats_url(pool: String) -> Option<String> {
    let host = pool.split(':').next().unwrap_or("").to_lowercase();
    match host.as_str() {
        h if h.contains("supportxmr")  => Some("https://www.supportxmr.com/api/pool/stats".into()),
        h if h.contains("moneroocean") => Some("https://api.moneroocean.stream/pool/stats".into()),
        h if h.contains("c3pool")      => Some("https://mine.c3pool.com/api/pool/stats".into()),
        h if h.contains("xmrpool.eu")  => Some("https://xmrpool.eu/api/pool/stats".into()),
        h if h.contains("bohemian")    => Some("https://xmr.bohemianpool.com/api/pool/stats".into()),
        h if h.contains("hashvault")   => Some("https://hashvault.pro/api/pool/stats".into()),
        h if h.contains("nanopool")    => Some("https://api.nanopool.org/v1/xmr/pool/hashrate".into()),
        h if h.contains("2miners")     => Some("https://xmr.2miners.com/api/stats".into()),
        h if h.contains("herominers")  => Some("https://xmr.herominers.com/api/stats".into()),
        h if h.contains("coinfoundry") => Some("https://xmr.coinfoundry.org/api/pool/stats".into()),
        h if h.contains("xmrpool.net") => Some("https://xmrpool.net/api/pool/stats".into()),
        _ => None,
    }
}

// ── App entry ─────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(XmrigState(Mutex::new(None)))
        .manage(ProxyState(Mutex::new(None)))
        .manage(ProxyStartLock(Mutex::new(())))
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(Some(mon)) = win.primary_monitor() {
                    let size  = mon.size();
                    let scale = mon.scale_factor();
                    let w     = (220.0 * scale) as i32;
                    let h     = (140.0 * scale) as i32;
                    let x     = size.width  as i32 - w - 20;
                    let y     = size.height as i32 - h - 60;
                    win.set_position(tauri::PhysicalPosition::new(x, y)).ok();
                }
                win.show().ok();
            }

            tauri::WebviewWindowBuilder::new(
                app,
                "config",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("xmrigger settings")
            .inner_size(360.0, 480.0)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .visible(false)
            .build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            toggle_config_panel,
            check_xmrig_path,
            find_xmrig,
            read_xmrig_config,
            launch_xmrig,
            stop_xmrig,
            xmrig_running,
            write_xmrig_config,
            detect_antivirus,
            setup_antivirus_exclusions,
            install_xmrig,
            find_xmrigger_proxy,
            launch_proxy,
            stop_proxy,
            proxy_running,
            known_pool_stats_url,
        ])
        .run(tauri::generate_context!())
        .expect("error running xmrigger-widget");
}
