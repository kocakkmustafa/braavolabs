#!/usr/bin/env python3
"""Create the versioned offline pnpm context from exact, pre-downloaded bytes."""
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile

ORIGIN = "https://registry.npmjs.org/pnpm/-/pnpm-9.15.4.tgz"
ORIGIN_SHA256 = "9bee59c7313a216722c079c1e22160dea7f88df4e0c3450b1d7b01b882336c6a"
INTEGRITY = "sha512-stwg4vxys+GISEWbNzWaMgZGY+VielHkx0ssKd2OjgSRSDw6u0B4nP1Xi/Ni+2uoJhsF8Dh9dnku1uI+o7G2oA=="
EMBEDDED_SHA512 = "b2dc20e2fc72b3e18848459b37359a32064663e5627a51e4c74b2c29dd8e8e0491483c3abb40789cfd578bf362fb6ba8261b05f0387d76792ed6e23ea3b1b6a0"
ARCHIVE = "corepack-pnpm-9.15.4-node26-v1.tgz"
EXPECTED_BYTES = 3858114
EXPECTED_SHA256 = "377e4092a114e8a919900faf6db7ff503de953ea85c587cef79f46ec2628289c"


def produce(upstream: Path, destination: Path) -> dict:
    raw = upstream.read_bytes()
    if hashlib.sha256(raw).hexdigest() != ORIGIN_SHA256 or (
        "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode()
    ) != INTEGRITY:
        raise ValueError("Upstream pnpm bytes do not match the pinned registry artifact")
    files = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as source:
        for member in source.getmembers():
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or name.parts[0] != "package":
                raise ValueError("Unsafe or unexpected package archive path")
            if member.isdir():
                continue
            if not member.isfile() or len(name.parts) < 2:
                raise ValueError("Only regular upstream package files are accepted")
            relative = str(PurePosixPath(*name.parts[1:]))
            if relative in files or relative == ".corepack":
                raise ValueError("Duplicate or reserved upstream file")
            files[relative] = (source.extractfile(member).read(), member.mode & 0o777)
    package = json.loads(files["package.json"][0])
    if package["name"] != "pnpm" or package["version"] != "9.15.4":
        raise ValueError("Wrong package identity")
    rows = [(name, hashlib.sha256(data).hexdigest(), mode)
            for name, (data, mode) in sorted(files.items())]
    tree_hash = hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()
    license_hash = hashlib.sha256(files["LICENSE"][0]).hexdigest()
    corepack = {"locator": {"name": "pnpm", "reference": "9.15.4"},
                "bin": {"pnpm": "./bin/pnpm.cjs", "pnpx": "./bin/pnpx.cjs"},
                "hash": "sha512." + EMBEDDED_SHA512}
    files[".corepack"] = (json.dumps(corepack, separators=(",", ":")).encode(), 0o644)
    output = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
            for name, (data, mode) in sorted(files.items()):
                info = tarfile.TarInfo("pnpm/9.15.4/" + name)
                info.size, info.mode, info.mtime = len(data), mode, 0
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                archive.addfile(info, io.BytesIO(data))
    body = output.getvalue()
    digest = hashlib.sha256(body).hexdigest()
    if (len(body), digest) != (EXPECTED_BYTES, EXPECTED_SHA256):
        raise ValueError("Producer output differs from the accepted offline artifact")
    manifest = {
        "schema": 2, "archive": ARCHIVE, "archiveBytes": len(body), "archiveSha256": digest,
        "corepack": {"name": "pnpm", "version": "9.15.4", "embeddedSha512Hex": EMBEDDED_SHA512},
        "origin": {"url": ORIGIN, "integrity": INTEGRITY, "sha256": ORIGIN_SHA256},
        "producer": {"recipe": "canonical-tar-gzip-v1", "script": "scripts/prepare-offline-pnpm.py",
                     "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},
        "upstreamFileCount": len(rows), "upstreamTreeSha256": tree_hash, "licenseSha256": license_hash,
    }
    # Never replace an existing context, including one with unknown files.
    destination.mkdir(parents=True, exist_ok=False)
    (destination / ARCHIVE).write_bytes(body)
    (destination / "COREPACK-CONTEXT-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: prepare-offline-pnpm.py PINNED_UPSTREAM_TGZ NEW_OUTPUT_DIRECTORY")
    print(json.dumps(produce(Path(sys.argv[1]), Path(sys.argv[2])), indent=2))
