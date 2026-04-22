use std::sync::Mutex;
use tauri::Manager;

struct XmrigState(Mutex<Option<std::process::Child>>);

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn find_xmrig() -> Option<String> {
    // Check PATH via `where`
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

    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let candidates = [
        format!("{home}\\xmrig\\xmrig.exe"),
        format!("{home}\\Downloads\\xmrig\\xmrig.exe"),
        format!("{home}\\Desktop\\xmrig\\xmrig.exe"),
        "C:\\xmrig\\xmrig.exe".into(),
        "C:\\Program Files\\XMRig\\xmrig.exe".into(),
        "C:\\Program Files (x86)\\XMRig\\xmrig.exe".into(),
    ];

    candidates.into_iter().find(|p| std::path::Path::new(p).exists())
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
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
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

    // Position flush to the left of the main widget, bottom-aligned
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(pos), Ok(scale)) = (main.outer_position(), main.scale_factor()) {
            let cw = (360.0 * scale) as i32;
            let ch = (400.0 * scale) as i32;
            let mh = (140.0 * scale) as i32;
            let x  = (pos.x - cw - 8).max(0);
            let y  = (pos.y + mh - ch).max(0);
            cfg.set_position(tauri::PhysicalPosition::new(x, y)).ok();
        }
    }

    cfg.show().ok();
    cfg.set_focus().ok();
    Ok(())
}

// ── App entry ─────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(XmrigState(Mutex::new(None)))
        .setup(|app| {
            // Position main window at bottom-right and show it
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

            // Create config panel window (hidden until user opens it)
            tauri::WebviewWindowBuilder::new(
                app,
                "config",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("xmrigger settings")
            .inner_size(360.0, 400.0)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .visible(false)
            .build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            toggle_config_panel,
            find_xmrig,
            read_xmrig_config,
            launch_xmrig,
            stop_xmrig,
            xmrig_running,
        ])
        .run(tauri::generate_context!())
        .expect("error while running xmrigger-widget");
}
