# Node 26 offline pnpm bootstrap

Node26.9.0 does not bundle Corepack. Both Dockerfiles install exact pnpm9.15.4 bytes without running package lifecycle scripts or installing another manager. The online stage uses the official registry tar through Docker ADD --checksum; the offline stage uses a read-only two-file named context and RUN --network=none.

Produce the context without network access using Python3 and a pre-downloaded official pnpm9.15.4 tar:

```sh
python3 scripts/prepare-offline-pnpm.py /absolute/pnpm-9.15.4.tgz /absolute/new-offline-context
docker buildx build --target corepack_offline --build-context corepack_archive=/absolute/new-offline-context -f ENV/Dockerfile.api .
```

The producer checks upstream SHA256 and SHA512 before parsing. All899 upstream file bytes, modes and LICENSE are preserved. Only the Corepack locator metadata is added; tar ownership/time and gzip time are normalized. The script checks the exact output hash before writing and refuses an existing destination. Docker validates schema2, artifact identity, producer source, upstream tree/license, exact byte size/hash, regular files and exactly two context members before extraction. There is no network fallback. Full offline dependency installation additionally requires the frozen-lockfile store/Prisma engine acquisition caches; a successful bootstrap alone does not claim a complete air-gapped application build.

Archive migration for the local Node26 candidate:

- Historical archive: `corepack-pnpm-9.15.4.tgz`,3882495bytes, SHA256`d389715b4d2966e8c84103387f83d2ea698d797bf678f56b6895f179be7db6a5`. It was unavailable during this migration.
- Corepack0.34.6 reproduction was different (3895660bytes /1f44eb61dc824bd7d9da18cdae921636b01a5a3fa26bd111ec60b9217b7c19b5); it was never accepted as the old archive.
- Accepted canonical v1 artifact: `corepack-pnpm-9.15.4-node26-v1.tgz`,3858114bytes, SHA256`377e4092a114e8a919900faf6db7ff503de953ea85c587cef79f46ec2628289c`. The pnpm origin/embeddedSHA512 remain unchanged.

Official references: https://github.com/nodejs/corepack#default-installs and https://github.com/nodejs/docker-node. Artifact publication/deployment is a separate approval step.

The accepted producer run used Python 3.14.7 and zlib 1.2.12. Other producer runtimes must match the exact output guard; a compression/runtime difference fails closed and requires an explicit artifact migration. Replaying the accepted context in Docker does not require Python.
