//! Provider API-key storage in the OS credential store (Phase 3).
//!
//! Keys live in Windows Credential Manager (macOS Keychain / Linux Secret
//! Service via the `keyring` crate) under the fixed service name
//! `vera-terminal`, one entry per provider (the provider id is the entry's
//! user name). Keys are NEVER logged, returned in bulk, or written to disk —
//! the only read path is `key_get`, used by the frontend right before an
//! API call.
//!
//! The keyring crate cannot enumerate entries, so `key_status` probes the
//! fixed provider list one by one.

use keyring::Entry;
use serde::Serialize;

const SERVICE: &str = "vera-terminal";

/// Fixed provider list — the four LLM providers must match
/// `src/agent/providers.ts` on the frontend; "postiz" is the Social suite's
/// Postiz API key (Phase 5), managed from the Social view.
const PROVIDERS: [&str; 5] = ["xai", "openai", "anthropic", "kimi", "postiz"];

#[derive(Serialize)]
pub struct KeyStatus {
    provider: String,
    has_key: bool,
}

fn entry(provider: &str) -> Result<Entry, String> {
    if !PROVIDERS.contains(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    Entry::new(SERVICE, provider).map_err(|e| format!("keyring unavailable: {e}"))
}

#[tauri::command]
pub fn key_set(provider: String, api_key: String) -> Result<(), String> {
    entry(&provider)?
        .set_password(&api_key)
        .map_err(|e| format!("cannot store key for {provider}: {e}"))
}

#[tauri::command]
pub fn key_get(provider: String) -> Result<Option<String>, String> {
    match entry(&provider)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("cannot read key for {provider}: {e}")),
    }
}

#[tauri::command]
pub fn key_delete(provider: String) -> Result<(), String> {
    match entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("cannot delete key for {provider}: {e}")),
    }
}

#[tauri::command]
pub fn key_status() -> Result<Vec<KeyStatus>, String> {
    let mut out = Vec::with_capacity(PROVIDERS.len());
    for provider in PROVIDERS {
        let has_key = match entry(provider)?.get_password() {
            Ok(_) => true,
            Err(keyring::Error::NoEntry) => false,
            Err(e) => return Err(format!("cannot check key for {provider}: {e}")),
        };
        out.push(KeyStatus {
            provider: provider.to_string(),
            has_key,
        });
    }
    Ok(out)
}
