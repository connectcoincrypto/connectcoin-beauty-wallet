"""Bounded, key-free NDJSON bridge between Electron main and the TLS worker."""

from __future__ import annotations

import json
import sys
import time
from dataclasses import asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "vendor"))

from connectcoin_p2c_tools.envelope import ConnectionProof  # noqa: E402
from connectcoin_p2c_tools.generator import (  # noqa: E402
    GenerationOptions,
    generate_connection_proof,
)
from connectcoin_p2c_tools.verify import verify_connection_proof  # noqa: E402

CONTEXT_KEYS = {
    "domain", "txid", "input_index", "connection_work_target",
    "root_certificates_version", "signature_algorithms_mask", "validation_time",
}
OPTION_KEYS = {"connectionsPerSecond", "concurrency", "overallTimeout", "maxAttempts"}


def emit(value: dict) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def bounded_int(value: object, name: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer between {minimum} and {maximum}")
    return value


def parse_request(request: object) -> tuple[ConnectionProof, GenerationOptions]:
    if not isinstance(request, dict) or set(request) != {"context", "options"}:
        raise ValueError("request must contain only context and options")
    context = request["context"]
    options = request["options"]
    if not isinstance(context, dict) or set(context) != CONTEXT_KEYS:
        raise ValueError("invalid public claim context")
    if not isinstance(options, dict) or set(options) != OPTION_KEYS:
        raise ValueError("invalid generation options")
    proof = ConnectionProof(**context, proof=b"")
    if "." not in proof.domain or proof.domain.endswith((".localhost", ".local", ".internal")):
        raise ValueError("only public DNS domains are supported")
    if proof.root_certificates_version != 1:
        raise ValueError("unsupported root bundle version")
    generation = GenerationOptions(
        connections_per_second=bounded_int(options["connectionsPerSecond"], "rate", 1, 256),
        concurrency=bounded_int(options["concurrency"], "concurrency", 1, 256),
        overall_timeout=bounded_int(options["overallTimeout"], "timeout", 1, 600),
        max_attempts=bounded_int(options["maxAttempts"], "attempts", 1, 100000),
        connection_timeout=10.0,
        port=443,
        allow_private_addresses=False,
        enforce_root_pin=True,
    )
    return proof, generation


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        from connectcoin_p2c_tools.verify import validate_root_bundle
        validate_root_bundle(ROOT / "p2c_roots_v1.pem", 1)
        emit({"type": "ready", "protocol": 2, "roots": 1})
        return 0
    if sys.argv[1:]:
        raise ValueError("unknown helper arguments")
    line = sys.stdin.buffer.readline(16385)
    if len(line) > 16384 or not line.endswith(b"\n"):
        raise ValueError("request exceeds the 16 KiB limit or is incomplete")
    context, options = parse_request(json.loads(line))
    last_update = 0.0

    def progress(update) -> None:
        nonlocal last_update
        now = time.monotonic()
        if now - last_update >= 1:
            last_update = now
            emit({"type": "progress", "attempts": update.attempts,
                  "elapsed": round(update.elapsed, 3),
                  "bestWorkHash": update.best_work_hash})

    result = generate_connection_proof(context, ROOT / "p2c_roots_v1.pem", options, progress)
    verified = verify_connection_proof(result.envelope, ROOT / "p2c_roots_v1.pem")
    emit({"type": "result", "verified": True, "proof": result.envelope.proof.hex(),
          "context": {key: getattr(context, key) for key in sorted(CONTEXT_KEYS)},
          "attempts": result.attempts, "verification": asdict(verified)})
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, RuntimeError) as exc:
        emit({"type": "error", "message": str(exc)[:500]})
        raise SystemExit(1) from None
