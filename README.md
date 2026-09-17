# Beauty Wallet

A calmer home for ConnectCoin. **Beauty Wallet is a desktop light wallet**: it keeps your keys on your computer and uses the restricted ConnectCoin JSON-RPC service for chain information. No full node, blockchain download, or CPU miner is included.

[ConnectCoin](https://connectcoincrypto.com/) · [Community](https://discord.gg/JYWbz5PsPp) · [Explorer](https://explorer.connectcoincrypto.com/) · [Whitepaper](https://connectcoincrypto.com/whitepaper.pdf)

**Initial testnet release. This application has not received an independent security audit. Use test coins, not valuable funds.** Mainnet is deliberately unavailable in the UI.

## What you can do

- Create or restore a wallet with **12, 18 or 24 BIP39 recovery words**; 24 is the default.
- Protect the local wallet with a password before creating it, and verify your recovery backup.
- Receive using a QR code; send native ConnectCoin payments with a recipient/amount/fee review before broadcast.
- Create Pay-to-Connect bounties with a domain, reward and hash target, expressed as an expected number of candidate evaluations—not a guaranteed count of physical connections.
- Opt into **Automatic Claims**, with local TLS proof generation and local proof verification.
- Browse balances and transaction history, create receive addresses, export an encrypted backup and lock your wallet.
- Use a light or dark interface. **System** is the default and follows your operating system automatically; override it in **Settings → Appearance**. Your choice is saved without interrupting Automatic Claims or reconnecting RPC.

Automatic Claims are **off by default**, stop when the wallet locks, and are not resumed automatically after an unlock or app restart. Defaults are **100 connection starts per second and 100 simultaneous connections**; existing saved limits are preserved. Values over 100 show a warning; the local maximum is 256. The configurable discovery window is 1–600 recent blocks, matching the public API. These are network-intensive tasks, not CPU mining. Only interact with destinations you are authorized to test; rewards are not guaranteed, and other claimers may spend a bounty first.

## Run from source

Install **Node.js 24 or newer**, npm and Git. For Automatic Claims development, also install **Python 3.11 or newer** with venv/pip support.

```sh
git clone https://github.com/connectcoincrypto/connectcoin-beauty-wallet.git
cd connectcoin-beauty-wallet
npm ci
npm run setup:claims
npm start
```

On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`. `setup:claims` creates an isolated `.claims-venv`, installs pinned proof-helper dependencies and runs its local TLS tests. It does not install or start a blockchain node. The wallet remains usable for ordinary payments if the optional claims helper is absent; enabling claims then displays an explicit installation error.

## Build a desktop package

Build on the operating system you intend to distribute for. The helper must be built **on that same OS and architecture**.

```sh
npm ci
npm run build:claims
npm run pack
```

`build:claims` uses PyInstaller to include the Python runtime and verification dependencies. Packaged users do **not** need Python or a node. `npm run dist` produces an installer/package for the current platform: Windows NSIS, Linux AppImage or macOS DMG. Code signing/notarization requires the distributor's certificates; this repository does not claim its builds are signed. Generated installers are in `dist/` and are not committed.

## RPC configuration

On first launch, a `config.json` is created alongside the encrypted wallet in the application's data folder:

- Windows: `%APPDATA%/ConnectCoin Beauty Wallet/`
- Linux: `$XDG_CONFIG_HOME/ConnectCoin Beauty Wallet/` (normally `~/.config/ConnectCoin Beauty Wallet/`)
- macOS: `~/Library/Application Support/ConnectCoin Beauty Wallet/`

The defaults are **`connectcoin4.com`, TCP port `48190`, testnet4**. Change hostname and port in Settings or edit the file while the app is closed. See [config.example.json](config.example.json).

This is **raw, newline-delimited TCP JSON-RPC, not HTTP or HTTPS**. No node username/password is required. Never point it at an unrestricted administrative node RPC service. The corresponding server is [connectcoin-json-rpc](https://github.com/connectcoincrypto/connectcoin-json-rpc).

**Trust and privacy:** network traffic is unencrypted. Your queried addresses, history and transactions can be observed, censored or modified in transit. The wallet pins the expected chain/genesis identity, but that check is not proof of consensus: a dishonest server can repeat the expected identity while lying about chain state. This is not an SPV wallet or an independently validating node. Choose a server you trust.

Private keys, passwords and recovery words are never sent to RPC. Before signing, the wallet parses funding transaction bytes, recomputes their transaction IDs, and checks the amounts and ownership against the locally derived keys. Recipients and fees are constructed locally. These checks do **not** prove inclusion, confirmations or unspentness.

## Recovery and encryption

Recovery uses the English **BIP39 word list and checksum**, backed by the OS cryptographic random generator through `node:crypto.randomBytes`. There is **no clock-derived seed, `Math.random`, handwritten-phrase generator or weak fallback**. The entropy sizes are 128, 192 and 256 bits for 12, 18 and 24 words respectively.

Keys use BIP32 with this documented Beauty Wallet convention on testnet:

```text
m/44'/1'/0'/0/index    receive addresses
m/44'/1'/0'/1/index    change addresses
```

The child key is used as a **native ConnectCoin x-only P2PK key**, with no Bitcoin Taproot/BIP86 key tweak. Amounts use 10 decimal places: **1 CC = 10,000,000,000 connects**. Bitcoin transaction libraries cannot be substituted for ConnectCoin's typed-output serialization.

Restoration scans both chains with a **20-unused-address gap**. Restored wallets continue watching that lookahead for later payments to previously issued, unused addresses. Creating receive addresses is bounded by the same gap. Discovery can take time because requests respect the public API's rate limits. This release has a 1,000-address safety limit per chain; it reports an error instead of silently claiming complete recovery beyond that limit. Keep the derivation convention with your offline backup. A BIP39 phrase alone does not make the wallet compatible with every other application's derivation scheme. This is not an importer for ConnectCoin Core's `wallet.dat`.

The wallet-file password is **not a BIP39 passphrase** and does not change the addresses. This initial UI uses an empty BIP39 passphrase. Passwords must have at least 12 characters. The local encrypted file uses **scrypt (`N=131072, r=8, p=1`) and AES-256-GCM**, with a fresh 32-byte salt and 12-byte nonce. Format/KDF metadata is authenticated and KDF parameters are strictly bounded. Writes are atomic, and newly created files are restricted to the current OS account where supported. Windows also depends on your profile's access-control permissions.

The recovery phrase bypasses the local password: anyone with it controls the keys. Write it offline; do not send it to support. An encrypted-file backup still needs its password. To restore that file, close the application and place your backup at `wallet.beauty.json` in the data folder; preserve any existing wallet elsewhere first. Alternatively, use the phrase on a fresh profile.

Locking drops the decrypted session, invalidates payment reviews and stops claims. The default inactivity lock is 15 minutes, configurable from 1–60. OS lock/suspend also locks the application. **JavaScript cannot guarantee physical erasure of all string copies from memory**, and no software wallet protects against malware controlling your unlocked computer.

## Automatic Claims architecture

The main process requests recent block hashes and complete bounty streams. Partial streams are rejected; journal updates and reorganizations are reconciled. Metadata is limited to the server's recent window, but address history is chain-wide.

The lookback window selects new work; it does not expire P2C outputs. An attempt already preparing, searching or submitting may finish after its bounty leaves that window. Unstarted candidates leave the discovery queue, and an aged-out attempt is not retried after failure. Known spends, reorganizations, resynchronization and wallet locking still cancel affected work. The wallet uses the validated chain median time from its shared wallet/discovery refresh for proof preparation, without two extra chain-tip requests per claim; the full node validates the submitted proof against its own current consensus state.

For each candidate, funding bytes are verified locally. An immutable spending transaction is prepared before TLS work. The **spending transaction ID**, input index, domain, target, allowed signature schemes, pinned roots and chain median time define the proof context. No private wallet data is passed to the helper. A verified proof is attached without changing the prepared transaction's non-witness data.

The helper uses a hash-pinned consensus root bundle, validates the TLS signature and certificate path, rejects private/local destinations and bounds concurrency/time/output. Claims reserve a conservative fee for the maximum supported proof size; this can cost more than the minimum for a smaller actual proof. The full node remains the final consensus validator. See [helper provenance](helpers/PROVENANCE.md).

## Tests

```sh
npm run check
npm test
npm run test:ui
npm run setup:claims
```

Unit tests cover mnemonic vectors, encryption/tampering, exact amounts, funding verification, Schnorr signing, transaction serialization, TCP transport, configuration, claims cancellation and hostile responses. UI tests use temporary isolated profiles and do not touch your real wallet. Helper tests use a controlled local TLS server, never a third-party website.

CI runs the unit and helper tests on Linux, Windows and macOS, plus the Electron UI smoke test on Linux under Xvfb. For a headless Linux machine, install the runtime dependencies with `npx playwright install-deps chromium`, then run `xvfb-run --auto-servernum npm run test:ui`. Playwright's Linux Electron test launcher supplies `--no-sandbox` by default: these automated tests exercise the UI, preload restrictions and wallet lifecycle, **not enforcement of the operating-system sandbox**. The normal application requests sandboxing and does not add this test flag; do not add it to normal wallet launches.

With an existing compatible ConnectCoin binary:

```sh
# Set CONNECTCOIND to your binary path first if it is not in the neighboring checkout.
npm run test:regtest
```

The integration test launches its own network-disabled regtest node. It verifies native Schnorr payments, P2C funding and claim-challenge parity against Core. It does not start mining on a public network or access existing wallets. This optional Core integration test is not part of the default CI matrix; it requires the compatible binary described above.

## Security boundary

The renderer has no Node.js access, no network permission and a narrow, allowlisted preload interface. Secrets are handled by the main process, except for deliberately displayed backup/recovery words and password entry. No analytics, remote scripts, webviews or automatic update downloads are included. A locally compromised renderer/OS remains a serious threat; this is not hardware-wallet isolation.

MIT licensed. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
