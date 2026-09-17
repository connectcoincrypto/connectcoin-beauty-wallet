# Automatic Claims helper

`vendor/connectcoin_p2c_tools` contains the MIT-licensed, independent TLS 1.3
P2C implementation from [connectcoin-p2c-tools](https://github.com/connectcoincrypto/connectcoin-p2c-tools),
commit `ad35a58a0c59ed985b3566d352053773269e76d2` (0.3.0). The CLI and tests
are not required at runtime. The upstream license is retained alongside it.
Beauty Wallet's local hardening in `generator.py` also rejects multicast,
reserved and IPv6 translation/tunnel destinations: `is_global` by itself is
not a sufficient SSRF boundary. Protocol encoding and verification are unchanged.

`p2c_roots_v1.pem` is the immutable Mozilla-derived consensus trust bundle from
ConnectCoin Core. Its SHA-256 is
`f66dff1bdf8f96060b8177976f8b7d9254bc89bc4db933d769f7384d28480bc9`.
The provider verifies this pin before connecting. Do not refresh it with the
operating system's current roots: a new consensus bundle requires a new version.
The bundle's source and attribution are in its header.

The bridge accepts only a prepared claim's public context. It never accepts a
mnemonic, private key, wallet password, cookie, or RPC credentials. A proof is
bound to the **spending transaction ID**, not the bounty's funding transaction
ID. Validation uses the chain's median time past supplied by the main process.
The main process independently checks the funding transaction and builds the
claim before starting this helper. An unencrypted, untrusted RPC is not SPV;
the helper does not prove that the advertised chain is the canonical chain.

The helper uses TLS 1.3 with ephemeral X25519 keys from the cryptographic
provider and OS-backed random session IDs (`secrets.token_bytes`). Connections
are restricted to public IPs after DNS resolution, and DNS results are pinned
for each job. The TLS port is always 443. No HTTP requests are sent. Every
returned result passes work, domain, pinned-root certificate path, output
signature-mask, challenge, and CertificateVerify verification. This independent
X.509 implementation can reject some encodings accepted by Core; the node's
consensus validation remains authoritative.

Limits are finite: one bounty job at a time, default 100 starts/sec and 100
simultaneous connections, maximum 256 of either, 10-second socket deadlines,
180 seconds and 1,000 attempts per job. Automatic Claims are off by default;
locking or stopping the wallet terminates the helper. The engine never starts
another worker until the old one exits. There is no private-network or
unpinned-root bypass in the bridge.

For development, run `node scripts/setup-claims.mjs`. It creates a private
Python virtual environment and installs the pinned provider. Python 3.11+
must already be installed. This is a local setup operation, never an automatic
download triggered by a remote bounty. For desktop packaging, run
`node scripts/setup-claims.mjs --build` on each target OS. The resulting
`helpers/bin/beauty-claims/` directory must be copied unchanged into Electron's
external resources (not inside ASAR). Its launcher is `beauty-claims.exe` on
Windows and `beauty-claims` on macOS/Linux. A user-created source installation
can use the virtual environment instead.

The build copies original Python, provider, CFFI, parser and bootloader notices
into `_internal/licenses/dependencies`. It includes the installed provider's
SBOMs and obtains the original OpenSSL notices from version-tagged upstream
sources. Rust dependency license archives are checked against the exact crate
SHA-256 checksums in the provider's SBOM; their text is retained unchanged.
`manifest.json` records the provenance and hash of each copied notice. A fresh
packaging build therefore needs Internet access for these license sources;
the resulting desktop helper does not download them at runtime.
