//! Provider-bound HTTP proxy (Phase 6).
//!
//! Why this exists: tauri-plugin-http's reqwest trusts its bundled webpki
//! roots, NOT the Windows root store. TLS-intercepting antivirus (e.g. Avast
//! Web Shield) re-signs HTTPS with its own root, which only lives in the
//! Windows store — so every provider call failed with "error sending request
//! for url". These commands use reqwest with native-tls (schannel on
//! Windows), which trusts the Windows root store, matching what Python,
//! PowerShell, and browsers already do.
//!
//! Only PROVIDER hosts are proxied — a hardcoded, case-insensitive allowlist
//! (mirrors the provider list in src/agent/providers.ts). Localhost stays on
//! the frontend's tauri-plugin-http fetch except when explicitly sent here.
//!
//! Responses carry the HTTP status and raw body back to the frontend even for
//! 4xx/5xx — the frontend renders its own error messages from the body. Err()
//! is reserved for transport/config failures and carries the reqwest error
//! text (no secrets: request headers never appear in error strings).

use std::collections::HashMap;
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;

/// Case-insensitive exact-host allowlist. Anything else is refused before a
/// connection is even attempted.
const ALLOWED_HOSTS: [&str; 8] = [
    "api.x.ai",
    "imgen.x.ai", // xAI's image/video CDN (Grok Imagine downloads)
    "api.openai.com",
    "api.anthropic.com",
    "api.moonshot.ai",
    "api.moonshot.cn",
    "localhost",
    "127.0.0.1",
];

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
/// Cap on the response body (image/video downloads included) so a runaway
/// response cannot exhaust memory — base64 grows it by a further ~33%.
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Serialize)]
pub struct ProxyResponse {
    status: u16,
    #[serde(rename = "bodyBase64")]
    body_base64: String,
}

/// Validate the URL against the allowlist and the HTTPS-only rule (plain
/// HTTP is tolerated for localhost/127.0.0.1 only, e.g. a local gateway).
fn checked_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|e| format!("invalid url: {e}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| "url has no host".to_string())?
        .to_ascii_lowercase();
    if !ALLOWED_HOSTS.contains(&host.as_str()) {
        return Err(format!("host not allowed: {host}"));
    }
    let is_local = host == "localhost" || host == "127.0.0.1";
    if url.scheme() != "https" && !(is_local && url.scheme() == "http") {
        return Err(format!("refusing non-https url for {host}"));
    }
    Ok(url)
}

fn client(timeout_ms: Option<u64>) -> Result<reqwest::Client, String> {
    let ms = timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS);
    reqwest::Client::builder()
        .timeout(Duration::from_millis(ms))
        // Feature unification with tauri-plugin-http compiles rustls into
        // the shared reqwest build too; without this call reqwest would
        // prefer rustls+webpki-roots — exactly the broken trust store we are
        // routing around. Force schannel (Windows root store).
        .use_native_tls()
        .build()
        .map_err(|e| format!("cannot build http client: {e}"))
}

async fn send(
    method: reqwest::Method,
    url: &str,
    headers: HashMap<String, String>,
    body: Vec<u8>,
    timeout_ms: Option<u64>,
) -> Result<ProxyResponse, String> {
    let url = checked_url(url)?;
    let mut req = client(timeout_ms)?.request(method, url);
    for (name, value) in headers {
        req = req.header(name, value);
    }
    if !body.is_empty() {
        req = req.body(body);
    }
    let res = req.send().await.map_err(|e| format!("{e}"))?;
    let status = res.status().as_u16();
    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("error reading response body: {e}"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(format!(
            "response too large: {} bytes (cap is {} bytes)",
            bytes.len(),
            MAX_RESPONSE_BYTES
        ));
    }
    Ok(ProxyResponse {
        status,
        body_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

#[tauri::command]
pub async fn proxy_post(
    url: String,
    headers: HashMap<String, String>,
    body_base64: String,
    timeout_ms: Option<u64>,
) -> Result<ProxyResponse, String> {
    let body = base64::engine::general_purpose::STANDARD
        .decode(body_base64)
        .map_err(|e| format!("invalid base64 request body: {e}"))?;
    send(reqwest::Method::POST, &url, headers, body, timeout_ms).await
}

#[tauri::command]
pub async fn proxy_get(
    url: String,
    headers: HashMap<String, String>,
    timeout_ms: Option<u64>,
) -> Result<ProxyResponse, String> {
    send(reqwest::Method::GET, &url, headers, Vec::new(), timeout_ms).await
}

