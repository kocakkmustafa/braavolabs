import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';

const compose = readFileSync(new URL('../ENV/compose.prod.yaml', import.meta.url), 'utf8');
const service = compose.split('\n  postgres-backup:\n')[1]?.split('\nvolumes:\n')[0];
assert.ok(service, 'actual backup service exists');
const command = service.match(/    entrypoint: \|\n      sh -c '\n([\s\S]*?)\n      '\n/)?.[1];
assert.ok(command, 'test executes actual Compose shell body, not a parallel implementation');

function run(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'braavo-backup-contract-'));
  const bin = join(dir, 'bin'); const backups = join(dir, 'backups');
  mkdirSync(bin); mkdirSync(backups);
  const exe = (name, body) => writeFileSync(join(bin, name), '#!/bin/sh\n' + body + '\n', { mode: 0o700 });
  // No command reaches a database, AWS, Docker, scheduler or user backup path.
  exe('pg_dump', 'case "$CASE" in dump-fail) exit 42;; partial-fail) printf "partial SQL"; exit 42;; *) printf "SELECT 1;\\n";; esac');
  exe('gzip', 'if [ "$CASE" = gzip-fail ]; then exit 43; fi\nif [ "$CASE" = integrity-fail ] && [ "${1:-}" = -t ]; then exit 44; fi\nexec /usr/bin/gzip "$@"');
  exe('aws', 'printf "upload\\n" >> "$RECORD"\n[ -f "$3" ] || exit 45\n/usr/bin/gzip -t "$3"');
  exe('mv', '[ ! -e "$2" ] || exit 46\nprintf "rename\\n" >> "$RECORD"\nexec /bin/mv "$@"');
  exe('date', 'printf "20260908-030000\\n"');
  exe('find', 'exit 0'); // Do not exercise production retention deletions in this fixture.
  exe('sleep', 'exit 91'); // End precisely one real loop iteration, no waiting.
  const body = command.replaceAll('$$', '$').replaceAll('/backups', backups);
  const result = spawnSync('/bin/bash', ['-c', body], { encoding: 'utf8', timeout: 15000,
    env: { PATH: bin + ':/usr/bin:/bin', CASE: mode, RECORD: join(dir, 'events'), BACKUP_S3_BUCKET: 'fixture', AWS_ACCESS_KEY_ID: 'synthetic-not-a-key', BACKUP_S3_PREFIX: 'test/' } });
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 91, result.stderr);
    const files = readdirSync(backups);
    const events = (() => { try { return readFileSync(join(dir, 'events'), 'utf8'); } catch { return ''; } })();
    if (mode === 'success') {
      assert.match(result.stdout, /dump done/);
      assert.deepEqual(files, ['aicos_prod_20260908-030000.sql.gz']);
      assert.equal(events, 'rename\nupload\n', 'publish final name before uploading');
      const file = join(backups, files[0]);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(gunzipSync(readFileSync(file)).toString(), 'SELECT 1;\n');
    } else {
      assert.doesNotMatch(result.stdout, /dump done|off-site sync done/);
      assert.match(result.stdout, /ERROR: backup creation failed/);
      assert.deepEqual(files, [], 'failed data never becomes a final backup; own partial removed');
      assert.equal(events, '', 'no rename or upload after any pipeline/integrity failure');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true }); // Exact test-created temporary directory only.
  }
}

for (const mode of ['dump-fail', 'partial-fail', 'gzip-fail', 'integrity-fail', 'success']) {
  test('actual backup command: ' + mode, () => run(mode));
}
test('backup mutable storage is outside sealed release inputs', () => {
  assert.match(service, /- postgres_backup_data:\/backups/);
  assert.doesNotMatch(service, /- \.\/backups:\/backups/);
  assert.match(compose, /\nvolumes:\n(?:[\s\S]*\n)?  postgres_backup_data:\s*$/);
});
