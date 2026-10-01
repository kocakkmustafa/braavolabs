import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, hash, localIdentity, readPinnedJson, validateEvidence } from './e2e-source-manifest.mjs';

const source = 'packages/ui/messages/tr.json';
const chunk = 'packages/ui/.next/static/chunks/api.js';
function fixture() {
  const sources = { [source]: hash('localized source'), 'pnpm-lock.yaml': hash('dependencies') };
  const outputs = { [chunk]: hash('https://api.operator.example/api/v1'), 'packages/ui/.next/BUILD_ID': hash('fresh') };
  const observed = { baseRevision: 'a'.repeat(40), baseTree: 'b'.repeat(40), sources,
    sourceFingerprint: fingerprint(sources), environment: { publicApiUrl: 'https://api.operator.example/api/v1',
      selfHostedSurfaceHosts: 'operator.example', uiServeMode: 'next-start', locales: ['en', 'tr'] },
    buildId: 'fresh', outputs, outputsFingerprint: fingerprint(outputs), apiOriginFiles: [chunk] };
  return { observed: structuredClone(observed), manifest: { schema: 1, kind: 'uncommitted-candidate-build',
    ...observed, beforeSnapshotSha256: hash('before snapshot'), sourceBeforeFingerprint: observed.sourceFingerprint,
    sourceAfterFingerprint: observed.sourceFingerprint, previousBuildId: 'old' } };
}

test('accepts matching source, dependencies, configuration and compiled artifact', () => {
  const { manifest, observed } = fixture();
  assert.doesNotThrow(() => validateEvidence(manifest, observed, [source, 'pnpm-lock.yaml']));
});
for (const [name, mutate] of [
  ['source changed during build', (m) => { m.sourceAfterFingerprint = hash('changed'); }],
  ['old build served', (m) => { m.buildId = m.previousBuildId; }],
  ['manifest source map changed', (m) => { m.sources[source] = hash('changed'); }],
  ['missing required locale source', (m) => { delete m.sources[source]; m.sourceFingerprint = fingerprint(m.sources); m.sourceBeforeFingerprint = m.sourceAfterFingerprint = m.sourceFingerprint; }],
  ['missing API origin evidence', (m, o) => { m.apiOriginFiles = o.apiOriginFiles = []; }],
  ['unbound origin chunk', (m, o) => { m.apiOriginFiles = o.apiOriginFiles = ['absent.js']; }],
  ['invalid compiled hash', (m, o) => { m.outputsFingerprint = o.outputsFingerprint = hash('bad'); }],
  ['unbound source-before hash', (m) => { m.sourceBeforeFingerprint = m.sourceAfterFingerprint = hash('bad'); }],
  ['invalid manifest kind', (m) => { m.kind = 'commit'; }],
  ['missing input pin', (m) => { delete m.beforeSnapshotSha256; }],
]) test(`rejects ${name}`, () => {
  const { manifest, observed } = fixture();
  mutate(manifest, observed);
  assert.throws(() => validateEvidence(manifest, observed, [source]));
});
for (const [name, mutate] of [
  ['source drift', (o) => { o.sources[source] = hash('new source'); }],
  ['dependency drift', (o) => { o.sources['pnpm-lock.yaml'] = hash('new lock'); }],
  ['base revision drift', (o) => { o.baseRevision = 'c'.repeat(40); }],
  ['compiled output drift', (o) => { o.outputs[chunk] = hash('new output'); }],
  ['BUILD_ID drift', (o) => { o.buildId = 'different'; }],
  ['API URL mismatch', (o) => { o.environment.publicApiUrl = 'https://another.example/api/v1'; }],
  ['surface mismatch', (o) => { o.environment.selfHostedSurfaceHosts = 'another.example'; }],
  ['locale configuration mismatch', (o) => { o.environment.locales.pop(); }],
  ['serve mode mismatch', (o) => { o.environment.uiServeMode = 'standalone'; }],
]) test(`rejects current ${name}`, () => {
  const { manifest, observed } = fixture();
  mutate(observed);
  assert.throws(() => validateEvidence(manifest, observed, [source]), /Current evidence drift/);
});
test('manifest bytes require an explicit exact pin and a regular non-symlink file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'braavo-manifest-test-'));
  try {
    const file = join(dir, 'manifest.json');
    const bytes = JSON.stringify(fixture().manifest);
    writeFileSync(file, bytes);
    assert.deepEqual(readPinnedJson(file, hash(bytes)), JSON.parse(bytes));
    assert.throws(() => readPinnedJson(file), /exact SHA256/);
    assert.throws(() => readPinnedJson(file, hash('other')), /SHA256 mismatch/);
    writeFileSync(file, bytes + ' ');
    assert.throws(() => readPinnedJson(file, hash(bytes)), /SHA256 mismatch/);
    const link = join(dir, 'link.json'); symlinkSync(file, link);
    assert.throws(() => readPinnedJson(link, hash(bytes + ' ')), /non-symlink/);
    assert.throws(() => readPinnedJson(join(dir, 'missing'), hash(bytes)), /ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('default CI path remains active; local evidence cannot bypass GitHub CI', () => {
  assert.equal(localIdentity('/unused', [], {}), null);
  assert.equal(localIdentity('/unused', [], { GITHUB_ACTIONS: 'true' }), null);
  assert.throws(() => localIdentity('/unused', [], { E2E_SOURCE_MANIFEST: '/unused', GITHUB_ACTIONS: 'true' }), /clean-HEAD/);
  assert.throws(() => localIdentity('/unused', [], { E2E_SOURCE_MANIFEST: '/unused' }), /exact SHA256/);
  assert.throws(() => localIdentity('/unused', [], { E2E_SOURCE_MANIFEST_SHA256: hash('pin') }), /both be provided/);
});
