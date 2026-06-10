//! Launches the Camoufox sidecar (a Node process) and exposes its CDP-subset
//! WebSocket endpoint to the rest of the CLI.
//!
//! Camoufox is Firefox-based and speaks Juggler via Playwright, not CDP. The
//! sidecar in `packages/camoufox-sidecar` launches Camoufox through Playwright
//! and translates a subset of CDP into Playwright calls, serving a
//! `/json/version` discovery endpoint + CDP WebSocket just like Chrome. From
//! the CLI's perspective this is just another CDP browser, mirroring the
//! Lightpanda integration.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

const CAMOUFOX_STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_LOG_LINES: usize = 60;
const READY_PREFIX: &str = "CAMOUFOX_READY ";
const ERROR_PREFIX: &str = "CAMOUFOX_ERROR ";

pub struct CamoufoxProcess {
    child: Child,
    pub ws_url: String,
    _log_drainer: Option<std::thread::JoinHandle<()>>,
}

impl CamoufoxProcess {
    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for CamoufoxProcess {
    fn drop(&mut self) {
        self.kill();
    }
}

#[derive(Default, Clone)]
pub struct CamoufoxLaunchOptions {
    pub executable_path: Option<String>,
    pub headless: bool,
    pub proxy: Option<String>,
    pub proxy_username: Option<String>,
    pub proxy_password: Option<String>,
    pub user_agent: Option<String>,
    pub ignore_https_errors: bool,
    pub viewport_size: Option<(u32, u32)>,
    pub color_scheme: Option<String>,
    pub extra_args: Vec<String>,
}

/// Locate the Node.js executable used to run the sidecar.
fn find_node() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("AGENT_BROWSER_NODE") {
        return Ok(PathBuf::from(path));
    }
    let finder = if cfg!(windows) { "where" } else { "which" };
    if let Ok(output) = Command::new(finder).arg("node").output() {
        if output.status.success() {
            if let Some(line) = String::from_utf8_lossy(&output.stdout).lines().next() {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    return Ok(PathBuf::from(trimmed));
                }
            }
        }
    }
    Err("Node.js not found on PATH. The Camoufox engine needs Node 18+ to run its sidecar. Install Node or set AGENT_BROWSER_NODE.".to_string())
}

/// Locate the sidecar entry point (`src/index.js`).
///
/// Search order:
///   1. `AGENT_BROWSER_CAMOUFOX_SIDECAR` env var (full path to index.js)
///   2. `~/.agent-browser/camoufox-sidecar/src/index.js` (installed location)
///   3. `packages/camoufox-sidecar/src/index.js` relative to cwd or the binary
///      (running from a source checkout)
pub fn find_sidecar_entry() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("AGENT_BROWSER_CAMOUFOX_SIDECAR") {
        let p = PathBuf::from(path);
        if p.exists() {
            return Ok(p);
        }
        return Err(format!(
            "AGENT_BROWSER_CAMOUFOX_SIDECAR points to a missing file: {}",
            p.display()
        ));
    }

    let rel = PathBuf::from("packages")
        .join("camoufox-sidecar")
        .join("src")
        .join("index.js");

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(
            home.join(".agent-browser")
                .join("camoufox-sidecar")
                .join("src")
                .join("index.js"),
        );
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(&rel));
    }
    // Walk up from the executable directory looking for the workspace package.
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(PathBuf::from);
        for _ in 0..6 {
            let Some(d) = dir else { break };
            candidates.push(d.join(&rel));
            dir = d.parent().map(PathBuf::from);
        }
    }

    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }

    Err(format!(
        "Camoufox sidecar not found. Run `agent-browser install` to set it up, or set \
         AGENT_BROWSER_CAMOUFOX_SIDECAR to the sidecar's src/index.js.\nSearched: {}",
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn build_sidecar_args(options: &CamoufoxLaunchOptions) -> Vec<String> {
    let mut args = vec!["--port".to_string(), "0".to_string()];
    if options.headless {
        args.push("--headless".to_string());
    } else {
        args.push("--headed".to_string());
    }
    if let Some(path) = &options.executable_path {
        args.push("--executable-path".to_string());
        args.push(path.clone());
    }
    if let Some(proxy) = &options.proxy {
        args.push("--proxy".to_string());
        args.push(proxy.clone());
    }
    if let Some(user) = &options.proxy_username {
        args.push("--proxy-username".to_string());
        args.push(user.clone());
    }
    if let Some(pass) = &options.proxy_password {
        args.push("--proxy-password".to_string());
        args.push(pass.clone());
    }
    if let Some(ua) = &options.user_agent {
        args.push("--user-agent".to_string());
        args.push(ua.clone());
    }
    if options.ignore_https_errors {
        args.push("--ignore-https-errors".to_string());
    }
    if let Some((w, h)) = options.viewport_size {
        args.push("--viewport".to_string());
        args.push(format!("{}x{}", w, h));
    }
    for a in &options.extra_args {
        args.push("--arg".to_string());
        args.push(a.clone());
    }
    args
}

pub async fn launch_camoufox(
    options: &CamoufoxLaunchOptions,
) -> Result<CamoufoxProcess, String> {
    let node = find_node()?;
    let sidecar = find_sidecar_entry()?;
    let args = {
        let mut a = vec![sidecar.to_string_lossy().to_string()];
        a.extend(build_sidecar_args(options));
        a
    };

    let mut child = Command::new(&node)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch Camoufox sidecar via {:?}: {}", node, e))?;

    // Drain stderr into a bounded buffer for diagnostics.
    let err_log: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let err_drainer = child.stderr.take().map(|stderr| {
        let buf = err_log.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let mut guard = buf.lock().expect("camoufox stderr buffer poisoned");
                if guard.len() >= MAX_LOG_LINES {
                    guard.pop_front();
                }
                guard.push_back(line);
            }
        })
    });

    // Read stdout on a worker thread, forwarding lines to the async waiter.
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture Camoufox sidecar stdout".to_string())?;
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let ws_url = match wait_for_ready(&mut rx, &err_log, CAMOUFOX_STARTUP_TIMEOUT).await {
        Ok(url) => url,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };

    Ok(CamoufoxProcess {
        child,
        ws_url,
        _log_drainer: err_drainer,
    })
}

async fn wait_for_ready(
    rx: &mut mpsc::UnboundedReceiver<String>,
    err_log: &Arc<Mutex<VecDeque<String>>>,
    timeout: Duration,
) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = match deadline.checked_duration_since(Instant::now()) {
            Some(d) => d,
            None => {
                return Err(format!(
                    "Timed out after {}s waiting for the Camoufox sidecar to start.{}",
                    timeout.as_secs(),
                    format_err_log(err_log)
                ));
            }
        };

        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(line)) => {
                if let Some(url) = line.strip_prefix(READY_PREFIX) {
                    return Ok(url.trim().to_string());
                }
                if let Some(msg) = line.strip_prefix(ERROR_PREFIX) {
                    return Err(format!("Camoufox sidecar failed: {}", msg.trim()));
                }
                // Other stdout lines are informational; keep waiting.
            }
            Ok(None) => {
                return Err(format!(
                    "Camoufox sidecar exited before becoming ready.{}",
                    format_err_log(err_log)
                ));
            }
            Err(_) => {
                return Err(format!(
                    "Timed out after {}s waiting for the Camoufox sidecar to start.{}",
                    timeout.as_secs(),
                    format_err_log(err_log)
                ));
            }
        }
    }
}

fn format_err_log(err_log: &Arc<Mutex<VecDeque<String>>>) -> String {
    let guard = err_log.lock().expect("camoufox stderr buffer poisoned");
    if guard.is_empty() {
        String::new()
    } else {
        format!(
            "\nSidecar output:\n{}",
            guard.iter().cloned().collect::<Vec<_>>().join("\n")
        )
    }
}
