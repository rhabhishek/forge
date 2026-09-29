// Memory store behavior: leak gate, dedupe without prefix collisions, and the
// documented lesson cap. FORGE_MEMORY_ROOT must be set before core.mjs loads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FORGE_MEMORY_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-test-'));

const test = (await import('node:test')).default;
const assert = (await import('node:assert/strict')).default;
const { rememberLesson, ensureProjectMem, projectIdentity, MEMORY_ROOT, MAX_LESSONS } = await import('../lib/core.mjs');

const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-test-repo-'));

test('memory root honors the env override', () => {
  assert.equal(MEMORY_ROOT, process.env.FORGE_MEMORY_ROOT);
});

test('non-git dirs fall back to a path identity', () => {
  const id = projectIdentity(repoDir);
  assert.equal(id.kind, 'path');
  assert.match(id.ns, /-[0-9a-f]{8}$/);
});

test('mem init is idempotent and creates the skeleton', () => {
  const { dir } = ensureProjectMem(repoDir);
  const again = ensureProjectMem(repoDir);
  assert.equal(dir, again.dir);
  for (const f of ['project.json', 'engineering-lessons.md', 'conventions.md', 'toolchain.md']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `${f} missing`);
  }
});

test('leak gate blocks PII-looking lessons', () => {
  const res = rememberLesson('never hardcode /Users/someone/ paths', { repoDir });
  assert.equal(res.ok, false);
  assert.match(res.reason, /leak-check/);
});

test('exact duplicates are rejected, long shared prefixes are not', () => {
  const prefix = 'when refactoring the billing pipeline always re-run the reconciliation suite';
  assert.equal(rememberLesson(`${prefix} before merging`, { repoDir }).status, 'added');
  assert.equal(rememberLesson(`${prefix} before merging`, { repoDir }).status, 'duplicate');
  // Same 48+ char prefix, different ending: must be a distinct lesson.
  assert.equal(rememberLesson(`${prefix} and the smoke tests`, { repoDir }).status, 'added');
});

test('substring lessons are not falsely deduped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-test-sub-'));
  assert.equal(rememberLesson('always run tests before merging', { repoDir: dir }).status, 'added');
  assert.equal(rememberLesson('run tests', { repoDir: dir }).status, 'added');
});

test(`lessons are capped at ${MAX_LESSONS}, dropping the oldest`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-test-cap-'));
  for (let i = 0; i < MAX_LESSONS + 5; i++) {
    const res = rememberLesson(`cap lesson zz${i} qq${i}`, { repoDir: dir });
    assert.equal(res.status, 'added', `lesson ${i}`);
  }
  const file = path.join(ensureProjectMem(dir).dir, 'engineering-lessons.md');
  const bullets = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().startsWith('- '));
  assert.equal(bullets.length, MAX_LESSONS);
  assert.ok(!bullets[0].includes('zz0 '), 'oldest lesson dropped');
  assert.ok(bullets.at(-1).includes(`zz${MAX_LESSONS + 4}`), 'newest lesson kept');
});
