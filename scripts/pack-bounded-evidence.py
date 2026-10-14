#!/usr/bin/env python3
"""Pack complete CI evidence into one bounded, regular file before upload.

127 MiB of TAR plus 1 MiB for upload-artifact's single-file ZIP metadata keeps
the stored artifact within 128 MiB. Oversize or changing evidence fails closed;
existing evidence is never removed or truncated to make it fit.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tarfile
import secrets

MIB = 1024 * 1024
ARTIFACT_LIMIT = 128 * MIB
PACKED_LIMIT = ARTIFACT_LIMIT - MIB
ROOTS = {"playwright": ("playwright-report", "test-results"), "provenance": ("dist-release",)}


class EvidenceError(Exception):
    pass


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def inventory(base, roots):
    records = []

    def visit(path, name):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) and not stat.S_ISDIR(info.st_mode):
            raise EvidenceError("evidence contains a link or special file")
        records.append((name, info))
        if stat.S_ISDIR(info.st_mode):
            for child in sorted(path.iterdir(), key=lambda p: p.name):
                visit(child, name + "/" + child.name)

    for root in roots:
        path = base / root
        if not stat.S_ISDIR(path.lstat().st_mode):
            raise EvidenceError("required evidence root is not a directory")
        visit(path, root)
    if not any(stat.S_ISREG(info.st_mode) for _, info in records):
        raise EvidenceError("required evidence contains no files")
    return records


def open_regular(base_fd, name, expected):
    # Anchor every parent directory; O_NOFOLLOW on only the leaf is insufficient.
    parent = os.dup(base_fd)
    try:
        parts = name.split("/")
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = next_fd
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        stream = os.fdopen(fd, "rb")
        if not stat.S_ISREG(os.fstat(fd).st_mode) or fingerprint(os.fstat(fd)) != fingerprint(expected):
            stream.close()
            raise EvidenceError("evidence changed before packing")
        return stream
    finally:
        os.close(parent)


def open_output_parent(path, create=True):
    # mkdir, temporary creation, publish and cleanup must share an anchored fd.
    descriptor = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(part, 0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def assert_output_identity(path, descriptor):
    fresh = open_output_parent(path, create=False)
    try:
        old_info, fresh_info = os.fstat(descriptor), os.fstat(fresh)
        if (old_info.st_dev, old_info.st_ino) != (fresh_info.st_dev, fresh_info.st_ino):
            raise EvidenceError("output parent identity changed")
    finally:
        os.close(fresh)


def bounded_digest(stream, limit):
    before = os.fstat(stream.fileno())
    if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
        raise EvidenceError("packed evidence is not bounded and regular")
    stream.seek(0)
    digest, count = hashlib.sha256(), 0
    for chunk in iter(lambda: stream.read(MIB), b""):
        count += len(chunk)
        if count > limit or count > before.st_size:
            raise EvidenceError("packed evidence grew during hashing")
        digest.update(chunk)
    if count != before.st_size or fingerprint(os.fstat(stream.fileno())) != fingerprint(before):
        raise EvidenceError("packed evidence changed during hashing")
    return count, digest.hexdigest()


def assert_packed_leaf(parent_fd, name, original_fd):
    actual = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    original = os.fstat(original_fd)
    if not stat.S_ISREG(actual.st_mode) or fingerprint(actual) != fingerprint(original):
        raise EvidenceError("packed leaf identity changed")


class BoundedWriter:
    def __init__(self, output, limit):
        self.output, self.limit = output, limit

    def write(self, data):
        if self.tell() + len(data) > self.limit:
            raise EvidenceError("packed evidence exceeds byte limit")
        return self.output.write(data)

    def tell(self):
        return self.output.tell()

    def flush(self):
        return self.output.flush()


def pack(kind, output, limit):
    if not 0 < limit <= PACKED_LIMIT:
        raise EvidenceError("invalid packed byte limit")
    if output.name != "evidence.tar":
        raise EvidenceError("output must be the fixed evidence.tar filename")
    base = Path.cwd().resolve()
    roots = ROOTS[kind]
    records = inventory(base, roots)
    if sum(info.st_size for _, info in records if stat.S_ISREG(info.st_mode)) > limit:
        raise EvidenceError("evidence payload exceeds byte limit")
    resolved_output = output.resolve()
    if any(resolved_output.is_relative_to(base / root) for root in roots):
        raise EvidenceError("output must be outside evidence roots")
    if output.exists() or output.is_symlink():
        raise EvidenceError("output already exists")
    # Check before mkdir as well as packing; a linked parent must not receive writes.
    for parent in (output.parent, *output.parent.parents):
        if parent.is_symlink():
            raise EvidenceError("output parent is a symlink")
    output = output.absolute()
    output_fd = open_output_parent(output.parent)
    base_fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = None
    temporary_identity = None
    published = False
    published_identity = None
    try:
        temporary = ".packing-" + secrets.token_hex(16)
        descriptor = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=output_fd)
        created = os.fstat(descriptor)
        temporary_identity = (created.st_dev, created.st_ino)
        # Keep this original regular fd through hashing and publication. A temp
        # pathname replacement must never become a new read or upload source.
        with os.fdopen(descriptor, "w+b") as raw:
            writer = BoundedWriter(raw, limit)
            with tarfile.open(fileobj=writer, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for name, expected in records:
                    entry = tarfile.TarInfo(name)
                    entry.mode = 0o755 if stat.S_ISDIR(expected.st_mode) else 0o644
                    entry.mtime = 0
                    if stat.S_ISDIR(expected.st_mode):
                        entry.type = tarfile.DIRTYPE
                        archive.addfile(entry)
                    else:
                        entry.size = expected.st_size
                        with open_regular(base_fd, name, expected) as source:
                            archive.addfile(entry, source)
                            if fingerprint(os.fstat(source.fileno())) != fingerprint(expected):
                                raise EvidenceError("evidence changed while packing")
            raw.flush()
            os.fsync(raw.fileno())
            after = inventory(base, roots)
            if [(name, fingerprint(info)) for name, info in records] != [(name, fingerprint(info)) for name, info in after]:
                raise EvidenceError("evidence membership changed while packing")
            size, digest = bounded_digest(raw, limit)
            assert_output_identity(output.parent, output_fd)
            assert_packed_leaf(output_fd, temporary, raw.fileno())
            # Refuse overwrites and verify the actual newly-created leaf as
            # well as its parent; link() can race a temp pathname replacement.
            os.link(temporary, output.name, src_dir_fd=output_fd, dst_dir_fd=output_fd,
                    follow_symlinks=False)
            published = True
            created_link = os.stat(output.name, dir_fd=output_fd, follow_symlinks=False)
            published_identity = (created_link.st_dev, created_link.st_ino)
            assert_output_identity(output.parent, output_fd)
            assert_packed_leaf(output_fd, output.name, raw.fileno())
            if bounded_digest(raw, limit) != (size, digest):
                raise EvidenceError("published bytes differ from receipt")
            assert_packed_leaf(output_fd, output.name, raw.fileno())
            assert_output_identity(output.parent, output_fd)
            return {"kind": kind, "packed_bytes": size, "max_packed_bytes": limit,
                    "stored_artifact_limit_bytes": ARTIFACT_LIMIT,
                    "file_count": sum(stat.S_ISREG(info.st_mode) for _, info in records),
                    "retention_days": 3, "sha256": digest}
    except BaseException:
        if published:
            info = os.stat(output.name, dir_fd=output_fd, follow_symlinks=False)
            if (info.st_dev, info.st_ino) == published_identity:
                os.unlink(output.name, dir_fd=output_fd)
        raise
    finally:
        os.close(base_fd)
        if temporary is not None:
            try:
                info = os.stat(temporary, dir_fd=output_fd, follow_symlinks=False)
                if (info.st_dev, info.st_ino) == temporary_identity:
                    os.unlink(temporary, dir_fd=output_fd)
            except FileNotFoundError:
                pass
        os.close(output_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", choices=ROOTS, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-bytes", type=int, default=PACKED_LIMIT)
    args = parser.parse_args()
    try:
        result = pack(args.kind, args.output, args.max_bytes)
    except (EvidenceError, OSError, tarfile.TarError):
        print("bounded-evidence: packing rejected; original evidence retained", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
