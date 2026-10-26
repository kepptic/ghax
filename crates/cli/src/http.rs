//! The one place that builds reqwest clients.
//!
//! TLS is rustls + ring with the Mozilla roots compiled in (`webpki-roots`), so
//! a client builds and verifies the same on every host, with or without an OS
//! CA store. reqwest 0.13's own rustls path always builds
//! `rustls-platform-verifier`, which errors at `build()` on a Linux box with no
//! ca-certificates, and that would break every `ghax` verb, plain-HTTP daemon
//! RPC included. Handing reqwest a finished `rustls::ClientConfig` skips that
//! verifier (and the default-provider lookup) entirely.
//!
//! Proxies: remote clients ([`client_builder`]) honor `HTTP_PROXY` /
//! `HTTPS_PROXY` / `NO_PROXY`. Clients that only talk to the local daemon or
//! browser ([`local_client_builder`]) never use a proxy.

use std::sync::Arc;

fn tls_config() -> rustls::ClientConfig {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .with_root_certificates(roots)
        .with_no_client_auth()
}

/// A client builder for remote hosts (GitHub, user-supplied QA URLs): bundled
/// roots, proxy from the environment.
pub fn client_builder() -> reqwest::blocking::ClientBuilder {
    reqwest::blocking::Client::builder().tls_backend_preconfigured(tls_config())
}

/// A client builder for the daemon and the browser's CDP port on 127.0.0.1:
/// never routed through a proxy, whatever the environment says.
pub fn local_client_builder() -> reqwest::blocking::ClientBuilder {
    client_builder().no_proxy()
}

/// A loopback client for tests.
#[cfg(test)]
pub fn client() -> reqwest::blocking::Client {
    local_client_builder().build().expect("build test client")
}

#[cfg(test)]
mod tests {
    use crate::state::ENV_LOCK;

    /// reqwest 0.13's platform verifier errors at `build()` when the OS has no
    /// CA store; the bundled roots must not care.
    #[test]
    fn client_builds_without_an_os_ca_store() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let saved: Vec<_> = ["SSL_CERT_FILE", "SSL_CERT_DIR"]
            .iter()
            .map(|k| (*k, std::env::var_os(k)))
            .collect();
        // SAFETY: every test that mutates the environment holds ENV_LOCK.
        unsafe {
            std::env::set_var("SSL_CERT_FILE", "/nonexistent");
            std::env::set_var("SSL_CERT_DIR", "/nonexistent");
        }
        let remote = super::client_builder().build();
        let local = super::local_client_builder().build();
        for (k, v) in saved {
            // SAFETY: as above.
            unsafe {
                match v {
                    Some(v) => std::env::set_var(k, v),
                    None => std::env::remove_var(k),
                }
            }
        }
        remote.expect("remote client builds with no CA store");
        local.expect("local client builds with no CA store");
    }

    /// A dead proxy in the environment must not break daemon RPC.
    #[test]
    fn local_client_ignores_proxy_env() {
        use std::io::{Read, Write};
        let _g = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = s.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                );
            }
        });
        let saved = std::env::var_os("HTTP_PROXY");
        // SAFETY: every test that mutates the environment holds ENV_LOCK.
        unsafe { std::env::set_var("HTTP_PROXY", "http://127.0.0.1:1") };
        let res = super::local_client_builder()
            .build()
            .unwrap()
            .get(format!("http://127.0.0.1:{port}/health"))
            .send();
        // SAFETY: as above.
        unsafe {
            match saved {
                Some(v) => std::env::set_var("HTTP_PROXY", v),
                None => std::env::remove_var("HTTP_PROXY"),
            }
        }
        assert_eq!(res.expect("direct connection").text().unwrap(), "ok");
    }
}
