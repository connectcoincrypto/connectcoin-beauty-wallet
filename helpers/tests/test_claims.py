"""Offline bridge tests and a controlled loopback TLS 1.3 server (no public traffic)."""

from __future__ import annotations

import dataclasses
import hashlib
import socket
import ssl
import sys
import tempfile
import threading
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

HELPERS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HELPERS))
import claims_bridge
from connectcoin_p2c_tools.envelope import ConnectionProof
from connectcoin_p2c_tools.generator import GenerationError, resolve_endpoints
from connectcoin_p2c_tools.hashes import internal_hash_to_display
from connectcoin_p2c_tools.protocol import parse_proof
from connectcoin_p2c_tools.tls13 import Endpoint, capture_tls13_proof
from connectcoin_p2c_tools.verify import ROOTS_V1_SHA256, verify_connection_proof
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def request():
    return {"context": {"domain": "example.com", "txid": "01" * 32, "input_index": 0,
                        "connection_work_target": "ff" * 32, "root_certificates_version": 1,
                        "signature_algorithms_mask": 1, "validation_time": 1800000000},
            "options": {"connectionsPerSecond": 5, "concurrency": 5,
                        "overallTimeout": 180, "maxAttempts": 1000}}


def identity():
    root_key = ec.generate_private_key(ec.SECP256R1())
    root_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "ConnectWallet test root")])
    root = (x509.CertificateBuilder().subject_name(root_name).issuer_name(root_name)
            .public_key(root_key.public_key()).serial_number(1)
            .not_valid_before(datetime(2020, 1, 1, tzinfo=UTC))
            .not_valid_after(datetime(2040, 1, 1, tzinfo=UTC))
            .add_extension(x509.BasicConstraints(ca=True, path_length=1), True)
            .add_extension(x509.KeyUsage(True, False, False, False, False, True, True, None, None), True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(root_key.public_key()), False)
            .sign(root_key, hashes.SHA256()))
    leaf_key = ec.generate_private_key(ec.SECP256R1())
    leaf = (x509.CertificateBuilder().subject_name(x509.Name([
                x509.NameAttribute(NameOID.COMMON_NAME, "example.com")]))
            .issuer_name(root_name).public_key(leaf_key.public_key()).serial_number(2)
            .not_valid_before(datetime(2025, 1, 1, tzinfo=UTC))
            .not_valid_after(datetime(2035, 1, 1, tzinfo=UTC))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), True)
            .add_extension(x509.SubjectAlternativeName([x509.DNSName("example.com")]), False)
            .add_extension(x509.KeyUsage(True, False, False, False, False, False, False, None, None), True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), False)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(leaf_key.public_key()), False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()), False)
            .sign(root_key, hashes.SHA256()))
    return (root.public_bytes(serialization.Encoding.PEM),
            leaf.public_bytes(serialization.Encoding.PEM),
            leaf_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                   serialization.NoEncryption()))


class ClaimsTests(unittest.TestCase):
    def test_immutable_root_bundle(self):
        self.assertEqual(hashlib.sha256((HELPERS / "p2c_roots_v1.pem").read_bytes()).hexdigest(), ROOTS_V1_SHA256)

    def test_private_request_data_and_unbounded_options_rejected(self):
        context, options = claims_bridge.parse_request(request())
        self.assertEqual(context.txid, "01" * 32)
        self.assertFalse(options.allow_private_addresses)
        self.assertTrue(options.enforce_root_pin)
        self.assertEqual(options.port, 443)
        for name, value in [("privateKey", "secret"), ("validation_time", 0), ("signature_algorithms_mask", 0), ("root_certificates_version", 2), ("domain", "wallet.local")]:
            value_request = request()
            value_request["context"][name] = value
            with self.assertRaises(ValueError): claims_bridge.parse_request(value_request)
        for name, value in [("concurrency", 257), ("connectionsPerSecond", -1), ("overallTimeout", 0), ("maxAttempts", True), ("allow_private_addresses", True)]:
            value_request = request()
            value_request["options"][name] = value
            with self.assertRaises(ValueError): claims_bridge.parse_request(value_request)

    def test_dns_private_and_mixed_destinations(self):
        private = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 443))
                   for ip in ("127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1")]
        private += [(socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 443, 0, 0))
                    for ip in ("::1", "ff02::1", "64:ff9b::7f00:1", "2002:7f00:1::")]
        with patch("socket.getaddrinfo", return_value=private):
            with self.assertRaises(GenerationError): resolve_endpoints("example.com", 443)
        with patch("socket.getaddrinfo", return_value=private + [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("8.8.8.8", 443))]):
            self.assertEqual([item.ip for item in resolve_endpoints("example.com", 443)], ["8.8.8.8"])

    def test_actual_loopback_tls_capture_verification_and_tampering(self):
        root_pem, cert_pem, key_pem = identity()
        with tempfile.TemporaryDirectory(prefix="connectwallet-claims-test-") as directory:
            directory = Path(directory)
            roots = directory / "roots.pem"
            cert = directory / "cert.pem"
            key = directory / "key.pem"
            roots.write_bytes(root_pem)
            cert.write_bytes(cert_pem)
            key.write_bytes(key_pem)
            server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            server_context.minimum_version = ssl.TLSVersion.TLSv1_3
            server_context.maximum_version = ssl.TLSVersion.TLSv1_3
            server_context.load_cert_chain(cert, key)
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            listener.settimeout(5)
            address = listener.getsockname()

            def server():
                try:
                    peer, _ = listener.accept()
                    peer.settimeout(5)
                    with peer:
                        try:
                            with server_context.wrap_socket(peer, server_side=True): pass
                        except (ssl.SSLError, OSError): pass  # Proof collection ends before Finished.
                finally:
                    listener.close()

            thread = threading.Thread(target=server, daemon=True)
            thread.start()
            context, _ = claims_bridge.parse_request(request())
            try:
                # Direct capture API is used only by this controlled fixture; the bridge
                # never permits private destinations or custom roots.
                endpoint = Endpoint(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, address, "127.0.0.1")
                captured = capture_tls13_proof(endpoint, context.domain, context.challenge,
                                               signature_algorithms_mask=1, timeout=5)
            finally:
                thread.join(6)
            self.assertFalse(thread.is_alive())
            proof = dataclasses.replace(context, proof=captured.encoded_proof)
            result = verify_connection_proof(proof, roots, enforce_root_pin=False)
            parsed = parse_proof(proof.proof, proof.domain, proof.challenge)
            self.assertEqual(result.connection_work_hash, internal_hash_to_display(parsed.connection_work_hash))
            self.assertEqual(result.challenge, context.challenge.hex())
            # Distinct spending txids, wrong work/roots/scheme, and bit flips cannot pass.
            for altered in [dataclasses.replace(proof, txid="03" * 32),
                            dataclasses.replace(proof, signature_algorithms_mask=6),
                            dataclasses.replace(proof, connection_work_target="00" * 32),
                            dataclasses.replace(proof, proof=proof.proof[:-1] + bytes([proof.proof[-1] ^ 1]))]:
                with self.assertRaises(ValueError): verify_connection_proof(altered, roots, enforce_root_pin=False)
            with self.assertRaises(ValueError): verify_connection_proof(proof, roots)


if __name__ == "__main__":
    unittest.main()
