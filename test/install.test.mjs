// Install/uninstall lifecycle: managed blocks in shared files, backup
// restoration, manifest-driven uninstall, idempotency, and dir pruning.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planInstall, uninstallActions, writeFileSafe, writeManifest, manifestPath,
  removeInstalledFile, pruneEmptyParents, rulesContent,
  FORGE_BLOCK_BEGIN, FORGE_BLOCK_END,
} from '../lib/core.mjs';
import { applyUpdatePlan, planUpdate } from '../lib/update.mjs';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-install-test-'));
}

function applyInstall(tool, home) {
  const { base, actions } = planInstall(tool, { home });
  const statuses = actions.map((a) => writeFileSafe(a.path, a.content, { apply: true, mode: a.mode }));
  writeManifest(tool, base, actions);
  return { base, actions, statuses };
}

function applyUninstall(tool, home) {
  const { base, actions } = uninstallActions(tool, { home });
  const statuses = actions.map((a) => {
    const s = removeInstalledFile(a.path, a.mode);
    if (s === 'removed') pruneEmptyParents(a.path, base);
    return s;
  });
  fs.rmSync(manifestPath(base), { force: true });
  return { base, statuses };
}

test('install preserves a pre-existing AGENTS.md and uninstall restores it exactly', () => {
  const home = tmpHome();
  const agentsFile = path.join(home, '.config', 'opencode', 'AGENTS.md');
  const userContent = '# My own rules\n\nKeep them.\n';
  fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
  fs.writeFileSync(agentsFile, userContent);

  applyInstall('opencode', home);
  const installed = fs.readFileSync(agentsFile, 'utf8');
  assert.ok(installed.startsWith('# My own rules'), 'user content must stay first');
  assert.ok(installed.includes(FORGE_BLOCK_BEGIN) && installed.includes(FORGE_BLOCK_END));

  applyUninstall('opencode', home);
  assert.equal(fs.readFileSync(agentsFile, 'utf8').trim(), userContent.trim());
  assert.ok(!fs.existsSync(agentsFile + '.forge-bak'), 'no orphaned backup');
});

test('double install is idempotent: one managed block, unchanged statuses', () => {
  const home = tmpHome();
  applyInstall('opencode', home);
  const { statuses } = applyInstall('opencode', home);
  assert.ok(statuses.every((s) => s === 'unchanged'), `expected all unchanged, got ${statuses}`);
  const agents = fs.readFileSync(path.join(home, '.config', 'opencode', 'AGENTS.md'), 'utf8');
  assert.equal(agents.split(FORGE_BLOCK_BEGIN).length - 1, 1, 'exactly one managed block');
});

test('install writes the complete code-review rubric', () => {
  const home = tmpHome();
  const { base } = applyInstall('copilot', home);
  const rubric = fs.readFileSync(
    path.join(base, 'forge', 'skills', 'code-review-rubric', 'SKILL.md'),
    'utf8',
  );

  assert.match(rubric, /actual serialized API contract/);
  assert.match(rubric, /loading, empty, success, and error/);
  assert.match(rubric, /disabled indefinitely/);
  assert.match(rubric, /framework build/);
  assert.match(rubric, /module resolution/);
});

test('uninstall removes forge-created files, manifest, and emptied dirs', () => {
  const home = tmpHome();
  const { base } = applyInstall('opencode', home);
  applyUninstall('opencode', home);
  for (const left of ['agent', 'command', 'forge', 'AGENTS.md']) {
    assert.ok(!fs.existsSync(path.join(base, left)), `${left} should be gone`);
  }
  assert.ok(!fs.existsSync(manifestPath(base)));
  assert.ok(fs.existsSync(base), 'tool base itself must survive');
});

test('uninstall restores .forge-bak for replaced files', () => {
  const home = tmpHome();
  const rules = path.join(home, '.cursor', 'rules', 'forge.md');
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(rules, 'my old rules\n');
  applyInstall('cursor', home);
  assert.notEqual(fs.readFileSync(rules, 'utf8'), 'my old rules\n');
  applyUninstall('cursor', home);
  assert.equal(fs.readFileSync(rules, 'utf8'), 'my old rules\n');
  assert.ok(!fs.existsSync(rules + '.forge-bak'));
});

test('legacy whole-file install (no markers, backup present) is recovered', () => {
  const home = tmpHome();
  const agentsFile = path.join(home, '.config', 'opencode', 'AGENTS.md');
  fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
  // Simulate the old clobbering installer: forge content, user original in .forge-bak.
  fs.writeFileSync(agentsFile, rulesContent());
  fs.writeFileSync(agentsFile + '.forge-bak', 'user original\n');

  // Re-install must replace the legacy file with a managed block, not append a duplicate.
  writeFileSafe(agentsFile, rulesContent(), { apply: true, mode: 'managed' });
  const upgraded = fs.readFileSync(agentsFile, 'utf8');
  assert.ok(upgraded.startsWith(FORGE_BLOCK_BEGIN));
  assert.equal(upgraded.split('# Forge - always-on context').length - 1, 1, 'no duplicated rules');

  // And uninstall must restore the original.
  assert.equal(removeInstalledFile(agentsFile, 'managed'), 'restored-backup');
  assert.equal(fs.readFileSync(agentsFile, 'utf8'), 'user original\n');
});

test('a markerless user file is kept untouched by managed uninstall', () => {
  const home = tmpHome();
  const f = path.join(home, 'AGENTS.md');
  fs.writeFileSync(f, 'not ours\n');
  assert.equal(removeInstalledFile(f, 'managed'), 'kept');
  assert.equal(fs.readFileSync(f, 'utf8'), 'not ours\n');
});

test('managed uninstall preserves whitespace-only bytes outside the block exactly', () => {
  const home = tmpHome();
  const file = path.join(home, 'AGENTS.md');
  const prefix = ' \t\n';
  const suffix = '\n\t ';
  fs.writeFileSync(file, prefix + `${FORGE_BLOCK_BEGIN}\nforge\n${FORGE_BLOCK_END}\n` + suffix);

  assert.equal(removeInstalledFile(file, 'managed'), 'block-removed');
  assert.ok(fs.existsSync(file));
  assert.equal(fs.readFileSync(file, 'utf8'), prefix + suffix);
});

test('managed uninstall preserves invalid UTF-8 bytes outside the block exactly', () => {
  const home = tmpHome();
  const file = path.join(home, 'AGENTS.md');
  const prefix = Buffer.from([0xff, 0xfe, 0x0a]);
  const suffix = Buffer.from([0x0a, 0x80, 0xfd]);
  fs.writeFileSync(file, Buffer.concat([
    prefix,
    Buffer.from(`${FORGE_BLOCK_BEGIN}\nforge\n${FORGE_BLOCK_END}\n`),
    suffix,
  ]));

  assert.equal(removeInstalledFile(file, 'managed'), 'block-removed');
  assert.deepEqual(fs.readFileSync(file), Buffer.concat([prefix, suffix]));
});

test('uninstall falls back to the store plan when no manifest exists', () => {
  const home = tmpHome();
  const { base, actions } = planInstall('opencode', { home });
  for (const a of actions) writeFileSafe(a.path, a.content, { apply: true, mode: a.mode });
  const res = uninstallActions('opencode', { home });
  assert.equal(res.from, 'store');
  assert.equal(res.actions.length, actions.length);
  assert.ok(res.base === base);
});

test('copilot tools: preserved across reinstall; --reset-tools regenerates defaults', () => {
  const home = tmpHome();
  // First install writes namespaced default tools for the forge orchestrator.
  const first = applyInstall('copilot', home);
  const forgeAct = first.actions.find((a) => a.path.endsWith(`agents${path.sep}forge.agent.md`));
  assert.match(forgeAct.content, /agent\/runSubagent/, 'default router toolset present on first install');

  // Simulate VS Code re-serializing the agent file with the user's enabled set.
  const edited = forgeAct.content.replace(/^tools:.*$/m, 'tools: [read/readFile, agent/runSubagent, atlassian/searchJiraIssuesUsingJql, browser/openBrowserPage]');
  writeFileSafe(forgeAct.path, edited, { apply: true });

  // Reinstall must keep the host-managed tools line from the updater snapshot.
  applyUpdatePlan(planUpdate('copilot', { home }));
  const preserved = fs.readFileSync(forgeAct.path, 'utf8');
  assert.match(preserved, /^tools: \[read\/readFile, agent\/runSubagent, atlassian\/searchJiraIssuesUsingJql, browser\/openBrowserPage\]$/m,
    'reinstall preserves host-managed tools');

  // --reset-tools restores the template defaults.
  applyUpdatePlan(planUpdate('copilot', { home, resetTools: true }));
  const reset = fs.readFileSync(forgeAct.path, 'utf8');
  assert.doesNotMatch(reset, /browser\/openBrowserPage/, 'reset drops user-added tools');
  assert.match(reset, /agent\/runSubagent/, 'reset re-adds default toolset');
});

test('dry-run reports unchanged/would-update correctly', () => {
  const home = tmpHome();
  const f = path.join(home, 'x.md');
  assert.equal(writeFileSafe(f, 'a\n', {}), 'would-write');
  fs.writeFileSync(f, 'a\n');
  assert.equal(writeFileSafe(f, 'a\n', {}), 'unchanged');
  assert.equal(writeFileSafe(f, 'b\n', {}), 'would-update');
});

test('manifest paths that escape the install base are rejected', () => {
  const home = tmpHome();
  const { base } = applyInstall('cursor', home);
  const manifest = JSON.parse(fs.readFileSync(manifestPath(base), 'utf8'));
  manifest.resources.push({ path: '../../../etc/passwd', mode: 'replace', sha256: '0'.repeat(64) });
  fs.writeFileSync(manifestPath(base), JSON.stringify(manifest));
  assert.throws(() => uninstallActions('cursor', { home }), /manifest/i);
});
