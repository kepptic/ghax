//! The one place that builds reqwest clients.
//!
//! reqwest is compiled with `rustls-no-provider` so the TLS stack is rustls +
//! ring (no aws-lc, no OpenSSL, no C toolchain). That feature makes reqwest
//! panic on the first `Client` unless a rustls crypto provider is installed
//! process-wide, so every client goes through here.

use std::sync::Once;

static PROVIDER: Once = Once::new();

fn ensure_provider() {
    PROVIDER.call_once(|| {
        // Err means a provider is already installed: nothing to do.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// `reqwest::blocking::Client::builder()` with the TLS provider installed.
pub fn client_builder() -> reqwest::blocking::ClientBuilder {
    ensure_provider();
    reqwest::blocking::Client::builder()
}

/// `reqwest::blocking::Client::new()` with the TLS provider installed.
#[cfg(test)]
pub fn client() -> reqwest::blocking::Client {
    client_builder().build().expect("build test client")
}
