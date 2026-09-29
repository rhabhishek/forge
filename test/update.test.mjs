import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  FORGE_BLOCK_BEGIN,
  FORGE_BLOCK_END,
  manifestPath,
  planInstall,
  readManifest,
  renderManagedBlock,
  sha256,
  writeManifest,
} from '../lib/core.mjs';
import {
  applyUpdatePlan,
  applyUpdatePlans,
  planReconcile,
  planUpdate,
} from '../lib/update.mjs';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-test-'));
}

function action(base, relativePath, content, mode = 'replace', projection) {
  return { path: path.join(base, relativePath), content, mode, projection };
}

function installFixture(tool, base, actions) {
  for (const item of actions) {
    fs.mkdirSync(path.dirname(item.path), { recursive: true });
    fs.writeFileSync(item.path, item.mode === 'managed'
      ? renderManagedBlock(item.content)
      : item.content);
  }
  writeManifest(tool, base, actions);
  return fs.readFileSync(manifestPath(base));
}

function readLog(base) {
  return fs.readFileSync(path.join(base, '.forge-update-log.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('update creates only desired resources and leaves unrelated files untouched', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  const unrelated = path.join(base, 'prompts', 'mine.md');
  fs.mkdirSync(path.dirname(unrelated), { recursive: true });
  fs.writeFileSync(unrelated, 'user prompt\n');

  const plan = planReconcile('cursor', {
    base,
    actions: [action(base, 'agents/forge.md', 'forge v1\n')],
  });
  assert.deepEqual(plan.entries.map((entry) => entry.status), ['create']);
  applyUpdatePlan(plan);

  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'user prompt\n');
  assert.equal(fs.readFileSync(path.join(base, 'agents', 'forge.md'), 'utf8'), 'forge v1\n');
  const manifest = readManifest(base, { tool: 'cursor' });
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.product, 'forge');
  assert.equal(manifest.tool, 'cursor');
  assert.equal(manifest.generation, 1);
  assert.match(manifest.installedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(manifest.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(manifest.resources, [{
    path: 'agents/forge.md',
    mode: 'replace',
    sha256: sha256('forge v1\n'),
  }]);
  assert.doesNotMatch(fs.readFileSync(manifestPath(base), 'utf8'), /forge v1/);
});

test('reconcile creates, then reports unchanged, then updates a managed resource', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  const desired = (content) => [action(base, 'owned.md', content)];

  const created = planReconcile('cursor', { base, actions: desired('v1\n') });
  assert.deepEqual(created.entries.map((entry) => entry.status), ['create']);
  applyUpdatePlan(created);
  assert.equal(fs.readFileSync(path.join(base, 'owned.md'), 'utf8'), 'v1\n');

  const rerun = planReconcile('cursor', { base, actions: desired('v1\n') });
  assert.deepEqual(rerun.entries.map((entry) => entry.status), ['unchanged']);
  applyUpdatePlan(rerun);
  assert.equal(fs.readFileSync(path.join(base, 'owned.md'), 'utf8'), 'v1\n');

  const bumped = planReconcile('cursor', { base, actions: desired('v2\n') });
  assert.deepEqual(bumped.entries.map((entry) => entry.status), ['update']);
  applyUpdatePlan(bumped);
  assert.equal(fs.readFileSync(path.join(base, 'owned.md'), 'utf8'), 'v2\n');
});

test('new resources and manifests honor umask while replacements preserve mode', () => {
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { manifestPath } from './lib/core.mjs';
    import { applyUpdatePlan, planReconcile } from './lib/update.mjs';

    const home = process.env.FORGE_TEST_HOME;
    const base = path.join(home, '.tool');
    const resource = path.join(base, 'owned.md');
    process.umask(Number.parseInt(process.env.FORGE_TEST_UMASK, 8));
    const action = (content) => ({ path: resource, content, mode: 'replace' });

    applyUpdatePlan(planReconcile('cursor', {
      base,
      trustedRoot: home,
      actions: [action('first\\n')],
    }));
    const createdResource = fs.statSync(resource).mode & 0o777;
    const createdManifest = fs.statSync(manifestPath(base)).mode & 0o777;

    fs.chmodSync(resource, 0o640);
    applyUpdatePlan(planReconcile('cursor', {
      base,
      trustedRoot: home,
      actions: [action('second\\n')],
    }));
    process.stdout.write(JSON.stringify({
      createdResource,
      createdManifest,
      replacedResource: fs.statSync(resource).mode & 0o777,
    }));
  `;

  for (const [umask, expectedMode] of [['022', 0o644], ['077', 0o600]]) {
    const execution = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: path.resolve('.'),
      env: { ...process.env, FORGE_TEST_HOME: tmpHome(), FORGE_TEST_UMASK: umask },
      encoding: 'utf8',
    });
    assert.equal(execution.status, 0, execution.stderr);
    assert.deepEqual(JSON.parse(execution.stdout), {
      createdResource: expectedMode,
      createdManifest: expectedMode,
      replacedResource: 0o640,
    });
  }
});

test('every managed file is backed up with exact bytes and mode before it is rewritten', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  const owned = action(base, 'owned.md', 'old\n');
  installFixture('cursor', base, [owned]);
  fs.chmodSync(owned.path, 0o640);

  let backupBeforeWrite = null;
  applyUpdatePlan(planReconcile('cursor', { base, actions: [action(base, 'owned.md', 'new\n')] }), {
    onBoundary(name) {
      if (name !== 'after-resource') return;
      const stamps = fs.readdirSync(path.join(base, '.forge-backups'));
      const backup = path.join(base, '.forge-backups', stamps[0], 'owned.md');
      backupBeforeWrite = { bytes: fs.readFileSync(backup, 'utf8'), mode: fs.statSync(backup).mode & 0o777 };
    },
  });

  // Backup captured the original bytes + mode, proving it happened before the write.
  assert.deepEqual(backupBeforeWrite, { bytes: 'old\n', mode: 0o640 });
  assert.equal(fs.readFileSync(owned.path, 'utf8'), 'new\n');
});

test('managed-block reconciliation hashes only the owned block and preserves user content', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  const rules = action(base, 'AGENTS.md', 'forge old\n', 'managed');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(rules.path, `user before\n\n${renderManagedBlock(rules.content)}\nuser after\n`);
  writeManifest('opencode', base, [rules]);

  fs.writeFileSync(rules.path, fs.readFileSync(rules.path, 'utf8').replace('user before', 'user changed'));
  const plan = planReconcile('opencode', {
    base,
    actions: [action(base, 'AGENTS.md', 'forge new\n', 'managed')],
  });
  assert.equal(plan.entries[0].status, 'update');
  applyUpdatePlan(plan);

  const updated = fs.readFileSync(rules.path, 'utf8');
  assert.match(updated, /user changed/);
  assert.match(updated, /forge new/);
  assert.match(updated, /user after/);
  assert.equal(updated.split(FORGE_BLOCK_BEGIN).length - 1, 1);
  assert.equal(updated.split(FORGE_BLOCK_END).length - 1, 1);
});

test('a user-edited block file inlines a preserved local-changes section idempotently', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  const owned = action(base, 'agents/forge.md', 'installer one\ninstaller two\n');
  installFixture('cursor', base, [owned]);
  fs.writeFileSync(owned.path, 'installer one\ninstaller two\nmy custom line\n');

  const desired = [action(base, 'agents/forge.md', 'installer one\ninstaller two\ninstaller three\n')];
  const first = planReconcile('cursor', { base, actions: desired });
  assert.equal(first.entries[0].status, 'reconciled-append');
  applyUpdatePlan(first);

  const reconciled = fs.readFileSync(owned.path, 'utf8');
  assert.match(reconciled, /installer three/);
  assert.match(reconciled, /FORGE:LOCAL-CHANGES/);
  assert.match(reconciled, /my custom line/);
  assert.equal(reconciled.split('FORGE:LOCAL-CHANGES').length - 1, 1);

  // Re-running the identical plan must not duplicate the section or installer lines.
  const second = planReconcile('cursor', { base, actions: desired });
  assert.deepEqual(second.entries.map((entry) => entry.status), ['unchanged']);
  applyUpdatePlan(second);
  assert.equal(fs.readFileSync(owned.path, 'utf8'), reconciled);
});

test('user-edited structured files get a clean live file plus .local and .diff sidecars', () => {
  for (const [rel, installed, edited, desired] of [
    ['config.json', '{"a":1}\n', '{"a":2}\n', '{"a":3}\n'],
    ['config.yaml', 'a: 1\n', 'a: 2\n', 'a: 3\n'],
    ['notes.md', '---\na: 1\n---\n', '---\na: 2\n---\n', '---\na: 3\n---\n'],
  ]) {
    const home = tmpHome();
    const base = path.join(home, '.tool');
    const owned = action(base, rel, installed);
    installFixture('cursor', base, [owned]);
    fs.writeFileSync(owned.path, edited);

    const plan = planReconcile('cursor', { base, actions: [action(base, rel, desired)] });
    assert.equal(plan.entries[0].status, 'reconciled-sidecar');
    applyUpdatePlan(plan);

    // Clean live file, untouched user bytes in .local, and a unified diff in .diff.
    assert.equal(fs.readFileSync(owned.path, 'utf8'), desired);
    assert.equal(fs.readFileSync(`${owned.path}.local`, 'utf8'), edited);
    const diff = fs.readFileSync(`${owned.path}.diff`, 'utf8');
    assert.match(diff, /^--- /);
    assert.match(diff, /\n\+\+\+ /);
  }
});

test('stale managed blocks preserve whitespace-only user bytes and file existence exactly', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  const rules = action(base, 'AGENTS.md', 'forge old\n', 'managed');
  const prefix = Buffer.from(' \t\n');
  const suffix = Buffer.from('\n \t');
  const outsideBytes = Buffer.concat([prefix, suffix]);
  fs.mkdirSync(base);
  fs.writeFileSync(rules.path, Buffer.concat([prefix, Buffer.from(renderManagedBlock(rules.content)), suffix]));
  writeManifest('opencode', base, [rules]);

  const plan = planReconcile('opencode', { base, actions: [] });
  assert.equal(plan.entries[0].status, 'remove');
  applyUpdatePlan(plan);

  assert.ok(fs.existsSync(rules.path));
  assert.deepEqual(fs.readFileSync(rules.path), outsideBytes);
});

test('managed-block updates preserve invalid UTF-8 bytes outside the owned block exactly', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  const rules = action(base, 'AGENTS.md', 'forge old\n', 'managed');
  const prefix = Buffer.from([0xff, 0xfe, 0x0a]);
  const suffix = Buffer.from([0x0a, 0x80, 0xfd]);
  fs.mkdirSync(base);
  fs.writeFileSync(rules.path, Buffer.concat([
    prefix,
    Buffer.from(renderManagedBlock(rules.content)),
    suffix,
  ]));
  writeManifest('opencode', base, [rules]);

  const plan = planReconcile('opencode', {
    base,
    actions: [action(base, 'AGENTS.md', 'forge new\n', 'managed')],
  });
  applyUpdatePlan(plan);

  assert.deepEqual(fs.readFileSync(rules.path), Buffer.concat([
    prefix,
    Buffer.from(renderManagedBlock('forge new\n')),
    suffix,
  ]));
});

test('a stale unchanged resource is removed cleanly', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  const stale = action(base, 'stale.md', 'old\n');
  installFixture('cursor', base, [stale]);

  const plan = planReconcile('cursor', { base, actions: [] });
  assert.equal(plan.entries[0].status, 'remove');
  assert.equal(plan.entries[0].userEdited, false);
  applyUpdatePlan(plan);

  assert.ok(!fs.existsSync(stale.path));
  assert.ok(!fs.existsSync(`${stale.path}.local`));
});

test('a stale user-edited resource is kept as a .local sidecar', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  const stale = action(base, 'stale.md', 'old\n');
  installFixture('cursor', base, [stale]);
  fs.writeFileSync(stale.path, 'my edit\n');

  const plan = planReconcile('cursor', { base, actions: [] });
  assert.equal(plan.entries[0].status, 'remove');
  assert.equal(plan.entries[0].userEdited, true);
  applyUpdatePlan(plan);

  assert.ok(!fs.existsSync(stale.path));
  assert.equal(fs.readFileSync(`${stale.path}.local`, 'utf8'), 'my edit\n');
});

test('the action log records one entry per touched resource plus absent stale entries', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  installFixture('cursor', base, [
    action(base, 'a.md', 'a1\n'),
    action(base, 'same.md', 'same\n'),
    action(base, 'stale.md', 'stale\n'),
    action(base, 'gone.md', 'gone\n'),
  ]);
  fs.rmSync(path.join(base, 'gone.md')); // previously owned, now missing -> "absent"

  applyUpdatePlan(planReconcile('cursor', {
    base,
    actions: [
      action(base, 'a.md', 'a2\n'),
      action(base, 'same.md', 'same\n'),
      action(base, 'new.md', 'new\n'),
    ],
  }));

  const byPath = new Map(readLog(base).map((record) => [record.relPath, record.action]));
  assert.equal(byPath.get('a.md'), 'updated');
  assert.equal(byPath.get('new.md'), 'created');
  assert.equal(byPath.get('stale.md'), 'removed');
  assert.equal(byPath.get('gone.md'), 'absent');
  assert.ok(!byPath.has('same.md')); // unchanged resources touch no disk and are not logged
  assert.equal(byPath.size, 4);
});

test('v1 resources adopt only exact current desired content and migrate to v2', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  const desired = action(base, 'owned.md', 'same\n');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(desired.path, desired.content);
  fs.writeFileSync(manifestPath(base), JSON.stringify({
    version: 1,
    tool: 'cursor',
    installedAt: '2026-01-01T00:00:00.000Z',
    files: [{ path: 'owned.md', mode: 'replace' }],
  }));

  const plan = planReconcile('cursor', { base, actions: [desired] });
  assert.equal(plan.entries[0].status, 'unchanged');
  applyUpdatePlan(plan);
  assert.equal(readManifest(base, { tool: 'cursor' }).schemaVersion, 2);
});

test('a stale v1 resource without a hash is preserved conservatively, never deleted', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'stale.md'), 'v1 stale\n');
  fs.writeFileSync(manifestPath(base), JSON.stringify({
    version: 1,
    tool: 'cursor',
    installedAt: '2026-01-01T00:00:00.000Z',
    files: [{ path: 'stale.md', mode: 'replace' }],
  }));

  const plan = planReconcile('cursor', { base, actions: [] });
  assert.equal(plan.entries[0].status, 'stale-kept');
  applyUpdatePlan(plan);
  assert.equal(fs.readFileSync(path.join(base, 'stale.md'), 'utf8'), 'v1 stale\n');
});

test('invalid, corrupt, duplicate, absolute, and traversal manifest paths are rejected', () => {
  const cases = [
    '{not json',
    JSON.stringify({ schemaVersion: 2, product: 'forge', tool: 'cursor', generation: 1,
      installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', resources: [] }),
    JSON.stringify({ version: 1, tool: 'cursor', installedAt: '2026-01-01T00:00:00.000Z', files: [{ path: '/tmp/x', mode: 'replace' }] }),
    JSON.stringify({ version: 1, tool: 'cursor', installedAt: '2026-01-01T00:00:00.000Z', files: [{ path: '../x', mode: 'replace' }] }),
    JSON.stringify({ version: 1, tool: 'cursor', installedAt: '2026-01-01T00:00:00.000Z', files: [{ path: 'x' }] }),
    JSON.stringify({ version: 1, tool: 'cursor', installedAt: '2026-01-01T00:00:00.000Z', files: [
      { path: 'x', mode: 'replace' }, { path: 'x', mode: 'replace' },
    ] }),
  ];
  // The second case is invalid because the manifest tool does not match the
  // requested adapter below.
  cases[1] = cases[1].replace('"cursor"', '"opencode"');

  for (const serialized of cases) {
    const home = tmpHome();
    const base = path.join(home, '.tool');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(manifestPath(base), serialized);
    assert.throws(() => planReconcile('cursor', { base, actions: [] }), /manifest/i);
  }

  const home = tmpHome();
  const base = path.join(home, '.tool');
  assert.throws(() => planReconcile('cursor', {
    base,
    actions: [action(base, 'same.md', 'one\n'), action(base, 'same.md', 'two\n')],
  }), /duplicate desired/i);
});

test('reconcile rejects desired resource paths that escape the install base', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  assert.throws(() => planReconcile('cursor', {
    base,
    actions: [{ path: path.join(base, '..', 'escape.md'), content: 'x\n', mode: 'replace' }],
  }), /escape|traversal|relative/i);
});

test('an injected resource write failure rolls back exact bytes and modes and keeps the prior manifest', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  const oldManifest = installFixture('cursor', base, [
    action(base, 'a.md', 'a old\n'),
    action(base, 'b.md', 'b old\n'),
  ]);
  fs.chmodSync(path.join(base, 'a.md'), 0o640);

  const plan = planReconcile('cursor', {
    base,
    actions: [
      action(base, 'a.md', 'a new\n'),
      action(base, 'b.md', 'b new\n'),
      action(base, 'c.md', 'c new\n'),
    ],
  });
  assert.throws(() => applyUpdatePlan(plan, {
    onBoundary(name, context) {
      if (name === 'after-resource' && context.entry.relativePath === 'b.md') {
        throw new Error('injected resource failure');
      }
    },
  }), /injected resource failure/);

  assert.equal(fs.readFileSync(path.join(base, 'a.md'), 'utf8'), 'a old\n');
  assert.equal(fs.statSync(path.join(base, 'a.md')).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(path.join(base, 'b.md'), 'utf8'), 'b old\n');
  assert.ok(!fs.existsSync(path.join(base, 'c.md')));
  assert.deepEqual(fs.readFileSync(manifestPath(base)), oldManifest);

  const log = readLog(base);
  assert.ok(log.length > 0);
  assert.ok(log.every((record) => record.rolledBack === true));
  assert.ok(log.some((record) => record.relPath === 'a.md'));
});

test('manifests are written last and a manifest failure rolls resources back', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  const owned = action(base, 'owned.md', 'old\n');
  const oldManifest = installFixture('cursor', base, [owned]);
  const events = [];
  const plan = planReconcile('cursor', {
    base,
    actions: [action(base, 'owned.md', 'new\n')],
  });

  assert.throws(() => applyUpdatePlan(plan, {
    onBoundary(name) {
      events.push(name);
      if (name === 'after-manifest') throw new Error('injected manifest failure');
    },
  }), /injected manifest failure/);
  assert.ok(events.lastIndexOf('before-manifest') > events.lastIndexOf('after-resource'));
  assert.equal(fs.readFileSync(owned.path, 'utf8'), 'old\n');
  assert.deepEqual(fs.readFileSync(manifestPath(base)), oldManifest);
});

test('multiple tool plans apply together and an unowned collision is backed up then overwritten', () => {
  const home = tmpHome();
  const firstBase = path.join(home, '.one');
  const secondBase = path.join(home, '.two');
  fs.mkdirSync(secondBase, { recursive: true });
  fs.writeFileSync(path.join(secondBase, 'collision.md'), 'user\n');

  const plans = [
    planReconcile('cursor', { base: firstBase, actions: [action(firstBase, 'new.md', 'new\n')] }),
    planReconcile('opencode', { base: secondBase, actions: [action(secondBase, 'collision.md', 'forge\n')] }),
  ];
  assert.equal(plans[1].entries[0].status, 'update');
  applyUpdatePlans(plans);

  assert.equal(fs.readFileSync(path.join(firstBase, 'new.md'), 'utf8'), 'new\n');
  assert.equal(fs.readFileSync(path.join(secondBase, 'collision.md'), 'utf8'), 'forge\n');

  const stamps = fs.readdirSync(path.join(secondBase, '.forge-backups'));
  assert.equal(
    fs.readFileSync(path.join(secondBase, '.forge-backups', stamps[0], 'collision.md'), 'utf8'),
    'user\n',
  );
});

test('an idempotent rerun reports unchanged and does not advance the manifest generation', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  const actions = [action(base, 'owned.md', 'desired\n')];
  const first = planReconcile('cursor', { base, actions });
  applyUpdatePlan(first);
  const manifest = fs.readFileSync(manifestPath(base));

  const second = planReconcile('cursor', { base, actions });
  assert.deepEqual(second.entries.map((entry) => entry.status), ['unchanged']);
  applyUpdatePlan(second);
  assert.deepEqual(fs.readFileSync(manifestPath(base)), manifest);
});

test('Copilot host-managed tools lines survive reconciliation without a conflict', () => {
  const home = tmpHome();
  const first = planInstall('copilot', { home });
  installFixture('copilot', first.base, first.actions);
  const forge = first.actions.find((item) => item.path.endsWith(path.join('agents', 'forge.agent.md')));
  const customized = fs.readFileSync(forge.path, 'utf8').replace(
    /^tools:.*$/m,
    'tools: [read/readFile, browser/openBrowserPage]',
  );
  fs.writeFileSync(forge.path, customized);

  const plan = planUpdate('copilot', { home });
  const forgeEntry = plan.entries.find((entry) => entry.target === forge.path);
  assert.equal(forgeEntry.status, 'unchanged');
  applyUpdatePlan(plan);
  assert.match(fs.readFileSync(forge.path, 'utf8'), /^tools: \[read\/readFile, browser\/openBrowserPage\]$/m);
});

test('Copilot tools preservation uses the snapshot captured after install planning', () => {
  const home = tmpHome();
  const first = planInstall('copilot', { home });
  const forge = first.actions.find((item) => item.path.endsWith(path.join('agents', 'forge.agent.md')));
  const priorTools = 'tools: [read/readFile, browser/prior]';
  const capturedTools = 'tools: [read/readFile, browser/captured]';
  const priorContent = `${forge.content.replace(/^tools:.*$/m, priorTools)}\nlegacy owned byte\n`;
  const priorActions = first.actions.map((item) => item === forge ? { ...item, content: priorContent } : item);
  installFixture('copilot', first.base, priorActions);

  const plan = planUpdate('copilot', {
    home,
    onPlanBoundary(name) {
      if (name !== 'after-install-plan') return;
      fs.writeFileSync(forge.path, priorContent.replace(priorTools, capturedTools));
    },
  });
  const forgeEntry = plan.entries.find((entry) => entry.target === forge.path);
  assert.equal(forgeEntry.status, 'update');
  applyUpdatePlan(plan);

  const updated = fs.readFileSync(forge.path, 'utf8');
  assert.match(updated, /^tools: \[read\/readFile, browser\/captured\]$/m);
  assert.doesNotMatch(updated, /legacy owned byte/);
});

test('all adapters produce deterministic update plans', () => {
  for (const tool of ['copilot', 'cursor', 'opencode']) {
    const home = tmpHome();
    const first = planUpdate(tool, { home });
    const second = planUpdate(tool, { home });
    assert.deepEqual(
      first.entries.map(({ relativePath, status }) => ({ relativePath, status })),
      second.entries.map(({ relativePath, status }) => ({ relativePath, status })),
    );
  }
});

test('resource paths use deterministic codepoint order', () => {
  const home = tmpHome();
  const base = path.join(home, '.tool');
  const ordered = planReconcile('cursor', {
    base,
    actions: ['😀.md', '\uE000.md', 'ä.md', 'a.md', 'Z.md'].map((name) => action(base, name, `${name}\n`)),
  });

  assert.deepEqual(ordered.entries.map((entry) => entry.relativePath), [
    'Z.md',
    'a.md',
    'ä.md',
    '\uE000.md',
    '😀.md',
  ]);
});

test('update help and docs describe the cooperative single-user updater', () => {
  const help = spawnSync(process.execPath, [path.resolve('bin/forge.mjs')], {
    cwd: path.resolve('.'), encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  const surfaces = [
    help.stdout,
    fs.readFileSync(path.resolve('README.md'), 'utf8'),
    fs.readFileSync(path.resolve('docs/GETTING-STARTED.md'), 'utf8'),
  ];
  for (const content of surfaces) {
    const normalized = content.replace(/\s+/g, ' ');
    assert.match(normalized, /cooperative single-user/i);
    assert.match(normalized, /two updaters at once/i);
    assert.match(normalized, /backup/i);
    assert.match(normalized, /reconcil/i);
  }
});

test('update CLI is dry-run by default and writes only with --apply', () => {
  const home = tmpHome();
  const cli = path.resolve('bin/forge.mjs');
  const env = { ...process.env, HOME: home };
  const dryRun = spawnSync(process.execPath, [cli, 'update', 'cursor'], {
    cwd: path.resolve('.'), env, encoding: 'utf8',
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Dry run/);
  assert.deepEqual(
    dryRun.stdout.split('\n')
      .filter((line) => /^  \[create\]/.test(line))
      .map((line) => line.replace(/^  \[create\] /, '')),
    [
      '.cursor/agents/architect.md',
      '.cursor/agents/forge.md',
      '.cursor/agents/implementer.md',
      '.cursor/agents/reviewer.md',
      '.cursor/agents/sme-a11y.md',
      '.cursor/agents/sme-domain.md',
      '.cursor/agents/sme-performance.md',
      '.cursor/agents/sme-security.md',
      '.cursor/commands/babysit.md',
      '.cursor/commands/remember-eng.md',
      '.cursor/commands/ship.md',
      '.cursor/forge/_shared/engineering-context.md',
      '.cursor/forge/_shared/super-mode.md',
      '.cursor/forge/skills/code-review-rubric/SKILL.md',
      '.cursor/forge/skills/confluence/SKILL.md',
      '.cursor/forge/skills/gcp-logging/SKILL.md',
      '.cursor/forge/skills/graphify/SKILL.md',
      '.cursor/forge/skills/graphify/references/add-watch.md',
      '.cursor/forge/skills/graphify/references/exports.md',
      '.cursor/forge/skills/graphify/references/extraction-spec.md',
      '.cursor/forge/skills/graphify/references/github-and-merge.md',
      '.cursor/forge/skills/graphify/references/hooks.md',
      '.cursor/forge/skills/graphify/references/query.md',
      '.cursor/forge/skills/graphify/references/transcribe.md',
      '.cursor/forge/skills/graphify/references/update.md',
      '.cursor/forge/skills/prod-monitor/SKILL.md',
      '.cursor/rules/forge.md',
    ],
  );
  assert.ok(!fs.existsSync(path.join(home, '.cursor')));

  const applied = spawnSync(process.execPath, [cli, 'update', 'cursor', '--apply'], {
    cwd: path.resolve('.'), env, encoding: 'utf8',
  });
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Update applied/);
  assert.equal(readManifest(path.join(home, '.cursor'), { tool: 'cursor' }).schemaVersion, 2);
});
