// Pod: project contract, Claude Code target, project-scoped install, seam
// selection, handoff planning, guards, board, and workflow rendering.
// These are deterministic contract tests. They do not prove that a model obeys
// the protocol or that a host enforces a deny rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  REPO_ROOT, STORE_DIR, adapterNames, planInstall, projectAdapterNames, uninstallActions,
  writeFileSafe, writeManifest,
} from '../lib/core.mjs';
import { planUpdate } from '../lib/update.mjs';
import {
  ROLE_NAMES, ROLES, BASELINE_NEVER, parseYaml, normalizeConfig, validateConfig, loadConfig,
  findConfig, planHandoff, handoffGuards, appendStatus, readStatus, allDenyPatterns, modelFor,
  renderBoard, boardData, renderWorkflow, main,
} from '../lib/pod.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `forge-pod-${name}-`));
const example = () => fs.readFileSync(path.join(STORE_DIR, 'pod', 'project.example.yml'), 'utf8');

function contract(overrides = {}) {
  return normalizeConfig({ ...parseYaml(example()), ...overrides });
}

const WORK = {
  host: 'copilot',
  tracker: {
    type: 'jira', project_key: 'ABC',
    states: { spec: 'Refinement', design: 'In Design', ready: 'Ready', in_progress: 'In Progress', needs_human: 'In Review', blocked: 'Blocked', paused: 'On Hold' },
  },
  docs: { type: 'confluence', space_or_path: 'ENG' },
  runtime: { type: 'copilot-cli' },
};

// ---------- YAML subset ----------

test('yaml subset parses maps, lists, flow values, comments, and scalars', () => {
  const doc = parseYaml([
    '# comment',
    'name: demo   # trailing',
    'count: 3',
    'on: true',
    'quoted: "a # not a comment"',
    'cmd: npm run test -- --ci: yes',
    'flow: [a, "b, c", 2]',
    'map: {x: 1, y: two}',
    'nested:',
    '  type: jira',
    '  deep:',
    '    k: v',
    'items:',
    '  - one',
    '  - two/**',
    'empty:',
  ].join('\n'));
  assert.deepEqual(doc, {
    name: 'demo', count: 3, on: true, quoted: 'a # not a comment', cmd: 'npm run test -- --ci: yes',
    flow: ['a', 'b, c', 2], map: { x: 1, y: 'two' }, nested: { type: 'jira', deep: { k: 'v' } },
    items: ['one', 'two/**'], empty: null,
  });
});

test('yaml subset rejects what it cannot represent instead of guessing', () => {
  assert.throws(() => parseYaml('a: 1\n\tb: 2'), /tabs/);
  assert.throws(() => parseYaml('a: 1\nnot a mapping line'), /expected 'key: value'/);
  assert.throws(() => parseYaml('a: 1\n    b: 2'), /unexpected indentation/);
});

// ---------- contract ----------

test('the example contract is valid as shipped', () => {
  const { errors } = validateConfig(contract());
  assert.deepEqual(errors, []);
});

test('doctor-level validation refuses an unsafe or incomplete contract', () => {
  const errs = (overrides) => validateConfig(contract(overrides)).errors.join('\n');
  assert.match(errs({ never: null }), /never: required/);
  assert.match(errs({ never: ['settings'] }), /never: must include 'merge'/);
  assert.match(errs({ never: ['merge'] }), /must include 'push_default_branch'/);
  assert.match(errs({ commands: null }), /commands: required/);
  assert.match(errs({ commands: { lint: 'x' } }), /commands\.test: required/);
  assert.match(errs({ allowed: null }), /allowed: required/);
  assert.match(errs({ allowed: ['merge'], never: ['merge', 'push_default_branch'] }), /both allowed and never/);
  assert.match(errs({ host: 'emacs' }), /host: must be one of/);
  assert.match(errs({ runtime: 'cron' }), /runtime: must be one of/);
  assert.match(errs({ tracker: { type: 'jira' } }), /project_key: required for jira/);
  assert.match(errs({ tracker: { type: 'jira', project_key: 'ABC' } }), /tracker\.states\.spec: required/);
});

test('github trackers get default state names; jira must name every state', () => {
  assert.equal(contract().tracker.states.needs_human, 'pod: needs-human');
  assert.deepEqual(validateConfig(contract(WORK)).errors, []);
});

test('model tiers resolve per role, with per-role tier or model overrides', () => {
  const cfg = contract({ models: { deep: 'big', standard: 'mid', light: 'small', engineer: 'deep', sre: 'custom-model' } });
  assert.deepEqual(modelFor(cfg, 'reviewer'), { tier: 'deep', model: 'big' });
  assert.deepEqual(modelFor(cfg, 'em'), { tier: 'light', model: 'small' });
  assert.deepEqual(modelFor(cfg, 'engineer'), { tier: 'deep', model: 'big' });
  assert.deepEqual(modelFor(cfg, 'sre'), { tier: 'standard', model: 'custom-model' });
  assert.deepEqual(modelFor(contract(), 'pm'), { tier: 'standard', model: null });
});

test('the contract is found in the host folder, or out of the repo when the repo must stay clean', () => {
  const repo = tmp('find');
  const home = tmp('home');
  const env = { FORGE_POD_HOME: home };
  assert.equal(findConfig(repo, env), null);
  const outside = path.join(home, path.basename(repo).toLowerCase(), 'project.yml');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, example());
  assert.equal(findConfig(repo, env), outside);
  const inside = path.join(repo, '.github', 'pod', 'project.yml');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, example());
  assert.equal(findConfig(repo, env), inside);
  assert.deepEqual(loadConfig(inside).errors, []);
});

// ---------- existing behaviour is untouched ----------

test('the default profile installs no pod agents, prompts, or files on any host', () => {
  for (const tool of adapterNames()) {
    const { actions } = planInstall(tool, { home: tmp('default') });
    for (const a of actions) {
      const rel = a.path.split(path.sep).join('/');
      assert.doesNotMatch(rel, /\/pod-[a-z]+(\.prompt)?\.md$/, `${tool}: pod prompt leaked into the default profile`);
      assert.doesNotMatch(rel, /\/forge\/pod\//, `${tool}: pod file leaked into the default profile`);
      assert.doesNotMatch(rel, /\/(pm|ux|tester|sre|em)(\.agent)?\.md$/, `${tool}: pod agent leaked into the default profile`);
    }
  }
});

test('every pod role maps to an agent in the pod profile and has an entry prompt', () => {
  const profiles = JSON.parse(fs.readFileSync(path.join(STORE_DIR, 'profiles.json'), 'utf8'));
  assert.equal(profiles.default, 'engineer');
  const podAgents = new Set(profiles.profiles.pod.agents);
  for (const agent of profiles.profiles.engineer.agents) assert.ok(podAgents.has(agent), `pod profile drops ${agent}`);
  const prompts = fs.readdirSync(path.join(STORE_DIR, 'prompts')).filter((f) => f.startsWith('pod-'));
  assert.equal(prompts.length, ROLE_NAMES.length);
  for (const role of ROLE_NAMES) {
    assert.ok(podAgents.has(ROLES[role].agent), `${role}: agent ${ROLES[role].agent} not in the pod profile`);
    assert.ok(fs.existsSync(path.join(STORE_DIR, 'agents', `${ROLES[role].agent}.agent.md`)));
    if (ROLES[role].playbook) assert.ok(fs.existsSync(path.join(STORE_DIR, 'pod', 'roles', `${role}.md`)));
  }
});

// ---------- hosts ----------

test('the pod profile renders the same roles through every host adapter', () => {
  for (const tool of adapterNames()) {
    const { actions } = planInstall(tool, { home: tmp('hosts'), role: 'pod' });
    const names = actions.map((a) => path.basename(a.path));
    for (const agent of ['pm', 'ux', 'tester', 'sre', 'em', 'forge', 'reviewer', 'architect']) {
      assert.ok(names.some((n) => n === `${agent}.md` || n === `${agent}.agent.md`), `${tool}: ${agent} agent missing`);
    }
    for (const role of ['pm', 'ux', 'architect', 'build', 'review', 'test', 'sre', 'em']) {
      assert.ok(names.some((n) => n === `pod-${role}.md` || n === `pod-${role}.prompt.md`), `${tool}: pod-${role} prompt missing`);
    }
    assert.ok(actions.some((a) => a.path.endsWith(path.join('forge', 'pod', 'protocol.md'))), `${tool}: protocol missing`);
    assert.ok(actions.some((a) => a.path.endsWith(path.join('forge', 'pod', 'pod.mjs'))), `${tool}: pod script missing`);
    for (const a of actions) {
      assert.equal(a.content.match(/\{\{[A-Z_]+\}\}/g), null, `${tool}: unresolved placeholder in ${a.path}`);
    }
  }
});

test('claude agents restrict specialists to their capabilities and leave routers unrestricted', () => {
  const { actions } = planInstall('claude', { home: tmp('claude'), role: 'pod' });
  const agent = (name) => actions.find((a) => a.path.endsWith(path.join('agents', `${name}.md`))).content;
  assert.match(agent('reviewer'), /^tools: Read, Grep, Glob, Bash$/m);
  assert.match(agent('tester'), /^tools: Read, Grep, Glob, Edit, Write, Bash$/m);
  assert.doesNotMatch(agent('pm'), /Edit|Write/, 'pm must not be able to edit files');
  assert.doesNotMatch(agent('forge'), /^tools:/m, 'a router needs to spawn its specialists');
  for (const a of actions.filter((x) => x.path.includes(`${path.sep}agents${path.sep}`))) {
    assert.doesNotMatch(a.content.split('\n---\n')[0], /^model:/m, `${a.path}: agents inherit their model`);
  }
});

test('claude agent-bound commands run the agent in the main session', () => {
  const { actions } = planInstall('claude', { home: tmp('claude'), role: 'pod' });
  for (const name of ['ship', 'pod-build']) {
    const cmd = actions.find((a) => a.path.endsWith(path.join('commands', `${name}.md`))).content;
    assert.match(cmd, /act as the `forge` agent yourself/);
    assert.match(cmd, /Do not delegate to it as a subagent/);
  }
});

// ---------- project-scoped install ----------

test('a project install is repo-relative, self-contained, and names no machine path', () => {
  const repo = tmp('project');
  const { base, actions } = planInstall('claude', { home: repo, project: repo, role: 'pod' });
  assert.equal(base, path.join(repo, '.claude'));
  for (const a of actions) {
    assert.ok(a.path.startsWith(base + path.sep), `${a.path} escapes the project`);
    assert.ok(!a.content.includes(repo), `${a.path} embeds the install path`);
    assert.ok(!a.content.includes(os.homedir() + path.sep), `${a.path} embeds a home path`);
    assert.ok(!a.content.includes(REPO_ROOT), `${a.path} embeds the Forge checkout path`);
  }
  const protocol = actions.find((a) => a.path.endsWith(path.join('pod', 'protocol.md'))).content;
  assert.match(protocol, /node \.claude\/forge\/pod\/pod\.mjs handoff/);
  assert.match(protocol, /`\.claude\/pod\/project\.yml`/);
  const rules = actions.find((a) => a.path.endsWith('CLAUDE.md'));
  assert.equal(rules.mode, 'managed', 'CLAUDE.md is user-owned: managed block only');
});

test('a project install without the pod profile still ships its CLI shim and nothing else from the pod', () => {
  const repo = tmp('project');
  const { actions } = planInstall('claude', { home: repo, project: repo });
  const pod = actions.filter((a) => a.path.includes(`${path.sep}forge${path.sep}pod${path.sep}`));
  assert.deepEqual(pod.map((a) => path.basename(a.path)), ['pod.mjs']);
});

test('copilot installs to repository-level locations; hosts without one refuse', () => {
  const repo = tmp('project');
  const { actions } = planInstall('copilot', { home: repo, project: repo, role: 'pod' });
  const rels = actions.map((a) => path.relative(repo, a.path).split(path.sep).join('/'));
  assert.ok(rels.includes('.github/agents/pm.agent.md'));
  assert.ok(rels.includes('.github/copilot-instructions.md'));
  assert.equal(actions.find((a) => a.path.endsWith('copilot-instructions.md')).mode, 'managed');
  assert.deepEqual(projectAdapterNames().sort(), ['claude', 'copilot']);
  assert.throws(() => planInstall('cursor', { home: repo, project: repo }), /no project-scoped install yet/);
});

test('a project install applies, reconciles cleanly, and uninstalls from its manifest', () => {
  const repo = tmp('project');
  const opts = { home: repo, project: repo, role: 'pod' };
  const { base, actions } = planInstall('claude', opts);
  for (const a of actions) writeFileSafe(a.path, a.content, { apply: true, mode: a.mode });
  writeManifest('claude', base, actions);
  const plan = planUpdate('claude', opts);
  const changed = plan.entries.filter((e) => !['unchanged', 'current', 'ok'].includes(e.status));
  assert.deepEqual(changed.map((e) => `${e.status} ${e.target}`), [], 'a second pass must be a no-op');
  const un = uninstallActions('claude', opts);
  assert.equal(un.from, 'manifest');
  assert.equal(un.actions.length, actions.length);
});

// ---------- seams ----------

test('only the selected tracker, docs, and runtime notes are installed', () => {
  const podFiles = (pod) => planInstall('copilot', { home: tmp('seams'), role: 'pod', pod }).actions
    .filter((a) => a.path.includes(`${path.sep}forge${path.sep}pod${path.sep}`));
  const names = (list) => list.map((a) => path.basename(a.path));

  const work = podFiles({ tracker: 'jira', docs: 'confluence', runtime: 'copilot-cli' });
  for (const want of ['jira.md', 'confluence.md', 'copilot-cli.md', 'copilot-cli-actions.workflow.yml']) {
    assert.ok(names(work).includes(want), `missing ${want}`);
  }
  for (const not of ['github.md', 'repo.md', 'claude-cloud.md', 'manual.md']) {
    assert.ok(!names(work).includes(not), `${not} should not be installed`);
  }
  // No wording from the other stack leaks into this one (the pod script and the
  // example contract are stack-neutral references that name every option).
  for (const a of work.filter((x) => !/pod\.mjs$|project\.example\.yml$/.test(x.path))) {
    assert.doesNotMatch(a.content, /pod: (spec|ready|needs-human)|Closes #|scheduled task|claude/i, `${a.path} leaks another stack`);
  }

  const home = podFiles({ tracker: 'github', docs: 'repo', runtime: 'claude-cloud' });
  assert.ok(names(home).includes('github.md') && names(home).includes('claude-cloud.md'));
  assert.ok(!names(home).includes('jira.md') && !names(home).includes('copilot-cli-actions.workflow.yml'));

  assert.ok(names(podFiles(undefined)).includes('jira.md') && names(podFiles(undefined)).includes('github.md'));
});

test('role agents and the protocol are stack-neutral', () => {
  const files = [
    ...['pm', 'ux', 'tester', 'sre', 'em'].map((n) => path.join(STORE_DIR, 'agents', `${n}.agent.md`)),
    path.join(STORE_DIR, 'pod', 'protocol.md'),
    ...['engineer', 'reviewer', 'architect'].map((n) => path.join(STORE_DIR, 'pod', 'roles', `${n}.md`)),
    ...fs.readdirSync(path.join(STORE_DIR, 'prompts')).filter((f) => f.startsWith('pod-')).map((f) => path.join(STORE_DIR, 'prompts', f)),
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /\b(GitHub|Jira|Confluence|Claude|Copilot|Cursor|OpenCode)\b/, `${path.relative(STORE_DIR, file)} names a specific tool`);
    assert.doesNotMatch(text, /pull request|\blabel\b|\bissue\b/i, `${path.relative(STORE_DIR, file)} uses tracker-specific wording`);
  }
});

// ---------- handoff ----------

test('copilot-cli handoff builds an unattended run with a deny rule per forbidden action', () => {
  const cfg = contract({ ...WORK, never: ['merge', 'push_default_branch', 'secrets', 'deploy'], deny_tools: { deploy: ['shell(npm run deploy)'] }, models: { deep: 'big' } });
  const plan = planHandoff(cfg, 'reviewer', '- **Goal:** review change 7');
  assert.equal(plan.kind, 'exec');
  assert.deepEqual(plan.argv.slice(0, 3), ['copilot', '--agent', 'reviewer']);
  assert.equal(plan.argv[3], '--prompt');
  assert.match(plan.argv[4], /Reviewer role \(reviewer\)[\s\S]*roles\/reviewer\.md[\s\S]*review change 7/);
  assert.ok(plan.argv.includes('--no-ask-user'));
  for (const pattern of ['shell(gh pr merge)', 'shell(git push origin main)', 'shell(gh secret)', 'shell(npm run deploy)']) {
    assert.ok(plan.argv.includes(`--deny-tool=${pattern}`), `missing deny rule ${pattern}`);
  }
  assert.deepEqual(plan.argv.slice(-2), ['--model', 'big']);
  assert.match(planHandoff(cfg, 'engineer', 'x').argv[2], /^forge$/);
});

test('baseline deny rules apply even if a contract omits them, and gaps are reported', () => {
  const cfg = contract({ ...WORK, never: ['deploy'] });
  for (const key of BASELINE_NEVER) assert.ok(cfg.never.includes(key) || allDenyPatterns(cfg).length >= 3);
  assert.ok(allDenyPatterns(cfg).includes('shell(gh pr merge)'));
  const { warnings } = validateConfig(contract({ ...WORK, never: ['merge', 'push_default_branch', 'deploy'] }));
  assert.ok(warnings.some((w) => /never 'deploy' has no tool pattern/.test(w)));
});

test('copilot-cli on actions dispatches the role workflow; foreground runs the agent', () => {
  const cfg = contract({ ...WORK, runtime: { type: 'copilot-cli', where: 'actions' } });
  assert.deepEqual(planHandoff(cfg, 'tester', 'p').argv.slice(0, 4), ['gh', 'workflow', 'run', 'pod-tester.yml']);
  assert.equal(planHandoff(cfg, 'tester', 'p', { foreground: true }).argv[0], 'copilot');
});

test('claude-cloud handoff names the role task to fire; manual hands the text to the human', () => {
  const cloud = contract({ runtime: 'claude-cloud', tasks: { reviewer: 'task_1' } });
  assert.deepEqual({ kind: planHandoff(cloud, 'reviewer', 'p').kind, task: planHandoff(cloud, 'reviewer', 'p').task }, { kind: 'tool', task: 'task_1' });
  assert.equal(planHandoff(cloud, 'pm', 'p').task, null);
  assert.equal(planHandoff(contract(), 'pm', 'p').kind, 'human');
  assert.throws(() => planHandoff(contract(), 'intern', 'p'), /Unknown role/);
});

test('guards refuse a handoff past the engineer, round-trip, or daily limits, and when paused', () => {
  const env = { FORGE_POD_STATE: tmp('state') };
  const cfg = contract({ limits: { engineers: 2, round_trips: 2, daily_sessions: { pm: 1 } } });
  assert.equal(handoffGuards(cfg, 'engineer', { item: 'A' }, env), null);
  appendStatus(cfg, { role: 'engineer', state: 'working', item: 'A' }, env);
  appendStatus(cfg, { role: 'engineer', state: 'working', item: 'B' }, env);
  assert.match(handoffGuards(cfg, 'engineer', { item: 'C' }, env), /engineer limit reached \(2\/2\)/);
  assert.equal(handoffGuards(cfg, 'engineer', { item: 'A', from: 'reviewer' }, env), null, 'rework on an item already in build is not a new engineer');
  appendStatus(cfg, { role: 'engineer', state: 'done', item: 'B' }, env);
  assert.equal(handoffGuards(cfg, 'engineer', { item: 'C' }, env), null);

  appendStatus(cfg, { event: 'handoff', role: 'reviewer', to: 'engineer', item: 'A' }, env);
  appendStatus(cfg, { event: 'handoff', role: 'tester', to: 'engineer', item: 'A' }, env);
  assert.match(handoffGuards(cfg, 'engineer', { item: 'A', from: 'reviewer' }, env), /round-trip limit reached for A \(2\/2\)/);

  assert.equal(handoffGuards(cfg, 'pm', {}, env), null);
  appendStatus(cfg, { event: 'handoff', role: 'sre', to: 'pm' }, env);
  assert.match(handoffGuards(cfg, 'pm', {}, env), /daily session cap reached for pm/);

  fs.writeFileSync(path.join(env.FORGE_POD_STATE, 'PAUSED'), 'x');
  assert.match(handoffGuards(cfg, 'reviewer', {}, env), /paused/);
  assert.equal(readStatus(cfg, env).length, 6);
});

// ---------- CLI ----------

test('the installed pod script runs on its own: init, doctor, dry-run handoff, pause', async () => {
  const repo = tmp('cli');
  const env = { FORGE_POD_HOME: tmp('home') };
  const lines = [];
  const run = (args) => main(args, { cwd: repo, env, out: (l) => lines.push(l) });

  await assert.rejects(() => run(['doctor']), /No pod contract found/);
  assert.equal(await run(['init', '--host', 'copilot']), 0);
  const file = path.join(repo, '.github', 'pod', 'project.yml');
  assert.ok(fs.existsSync(file));
  assert.equal(await run(['doctor']), 0);

  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^never:\n(  - .*\n)+/m, 'never:\n  - settings\n'));
  assert.equal(await run(['doctor']), 1, 'doctor fails a contract that does not forbid merging');
  await assert.rejects(() => run(['roles']), /Invalid pod contract/);

  fs.writeFileSync(file, example().replace('type: manual ', 'type: copilot-cli '));
  const packet = path.join(repo, 'packet.md');
  fs.writeFileSync(packet, '- **Goal:** g\n');
  lines.length = 0;
  assert.equal(await run(['handoff', 'tester', '--packet', packet, '--item', 'X-1', '--dry-run']), 0);
  assert.match(lines.join('\n'), /'copilot' '--agent' 'tester' '--prompt'[\s\S]*'--no-ask-user'/);
  assert.equal(readStatus(loadConfig(file).cfg, env).length, 0, 'a dry run records nothing');

  assert.equal(await run(['pause']), 0);
  assert.equal(await run(['handoff', 'tester', '--packet', packet]), 3);
  assert.equal(await run(['resume']), 0);
  assert.equal(await run(['status', 'tester', 'working', '--item', 'X-1', '--note', 'checking']), 0);
  assert.equal(await run(['board', '--out', path.join(repo, 'board.html')]), 0);
  assert.match(fs.readFileSync(path.join(repo, 'board.html'), 'utf8'), /"note":"checking"/);

  // The copy the installer ships must work without the rest of Forge.
  const copy = path.join(repo, 'pod.mjs');
  fs.copyFileSync(path.join(REPO_ROOT, 'lib', 'pod.mjs'), copy);
  const res = spawnSync(process.execPath, [copy, 'mem', 'init'], { cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Initialized memory/);
});

// ---------- board + workflows ----------

test('the board embeds its data safely', () => {
  const template = fs.readFileSync(path.join(STORE_DIR, 'pod', 'board.html'), 'utf8');
  const cfg = contract();
  const html = renderBoard(template, boardData(cfg, [{ ts: '2026-01-01T00:00:00Z', role: 'pm', state: 'working', note: '</script><b>' }]));
  assert.ok(!html.includes('</script><b>'), 'row text must not be able to close the script tag');
  assert.match(html, /"project":"my-project"/);
  assert.throws(() => renderBoard('<html></html>', {}), /data marker/);
});

test('workflows give standing roles a heartbeat and never grant more than branch + comment rights', () => {
  const template = fs.readFileSync(path.join(STORE_DIR, 'pod', 'runtimes', 'copilot-cli-actions.workflow.yml'), 'utf8');
  const cfg = contract({ ...WORK, runtime: { type: 'copilot-cli', where: 'actions' }, heartbeats: { sre: '5 5 * * *' } });
  const render = (role) => renderWorkflow(template, cfg, role, { cliPath: '.github/forge/pod/pod.mjs' });
  assert.match(render('pm'), /schedule:\n    - cron: '17 13 \* \* \*'/);
  assert.match(render('sre'), /cron: '5 5 \* \* \*'/);
  assert.doesNotMatch(render('engineer'), /schedule:|__[A-Z_]+__/);
  assert.match(render('engineer'), /node \.github\/forge\/pod\/pod\.mjs handoff engineer --packet - --foreground/);
  assert.doesNotMatch(render('engineer'), /actions: write|administration|deployments/);
});
