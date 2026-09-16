# Automatic Claims verification boundary

The offline Python tests run a controlled loopback TLS 1.3 server with a
temporary test CA. The real capture implementation obtains its handshake;
the independent verifier checks its CertificateVerify signature, certificate
path, DNS name, challenge and work target. Altered challenges, signatures,
targets, signature policies and the production-root pin are rejected.
The custom CA exception exists only in the test's direct verifier call, not
in `claims_bridge.py` or the wallet's production worker.

The independent native Core regtest checks Beauty's typed transaction wire
encoding, native Schnorr payments, P2C funding and the spending transaction's
exact challenge. Wallet service tests exercise complete bounty snapshots,
journal catch-up, reorg/window cleanup, preparation, cancellation and broadcast
failure handling using controlled RPC responses.

**An entire successful TLS proof claim accepted by the unmodified Core daemon
has not been verified end-to-end offline.** Core uses its immutable public CA
bundle in regtest too. Our generated test CA is deliberately not in that bundle.
Core's `VerifyP2CCertificateProofForTest` permits test roots only as a C++ unit
test API; it is not a runtime RPC or regtest switch. A recorded public proof
also cannot be reused for an arbitrary local claim: ClientHello is bound to
that spending transaction's ID and input index.

A positive daemon-level test requires an authorized TLS endpoint with a
certificate chaining to the pinned public roots, or an explicitly separate
test-only consensus harness. Neither production root enforcement nor the Core
daemon was modified to manufacture a passing test. These checks are not an
independent security audit or evidence of mainnet readiness.
