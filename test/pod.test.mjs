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
  findConfig, findProject, planHandoff, appendStatus, readStatus, allDenyPatterns, modelFor,
  renderBoard, boardData, renderWorkflow, main, openLedger, checkHandoff, claimHandoff, admitEngineer, ledgerKind, localBuilds, EXIT,
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

// ---------- reporting findings ----------

test('judging roles are told to report findings inline, and the tracker notes say how', () => {
  const read = (...p) => fs.readFileSync(path.join(STORE_DIR, ...p), 'utf8');
  const protocol = read('pod', 'protocol.md');
  const section = protocol.slice(protocol.indexOf('## Reporting findings'), protocol.indexOf('## Questions'));
  assert.ok(section.length > 200, 'protocol has a Reporting findings section');
  for (const rule of [/one comment per finding/, /anchored to the file and line/, /blocker.*major.*minor.*nit/s,
    /summary is short/, /single long block comment is never the report/, /never approve/i, /does not need a separate grant/]) {
    assert.match(section, rule);
  }
  // The roles that judge a change point at the section instead of restating it.
  for (const file of [['agents', 'tester.agent.md'], ['agents', 'ux.agent.md'], ['pod', 'roles', 'reviewer.md']]) {
    assert.match(read(...file), /inline/i, `${file.join('/')} must mention inline findings`);
  }
  assert.match(read('pod', 'roles', 'reviewer.md'), /Reporting findings/);
  assert.match(read('agents', 'tester.agent.md'), /Reporting findings/);
  // How, per tracker: GitHub names the endpoint; Jira says where inline comments go.
  const github = read('pod', 'trackers', 'github.md');
  assert.match(github, /pulls\/<n>\/reviews/);
  assert.match(github, /"event": "COMMENT"/);
  assert.match(github, /GraphQL is not available/);
  assert.match(read('pod', 'trackers', 'jira.md'), /inline on the pull request/);
});

// ---------- ledger: limits are enforced where the pod actually runs ----------

// In-memory GitHub REST double. Timestamps come from a counter, like a server
// clock, so ordering between "concurrent" writers is deterministic.
function fakeGithub({ issues = {}, comments = [] } = {}) {
  const db = { issues: new Map(), comments: [...comments], calls: [], tick: 0, fail: null, onPost: null };
  for (const [n, labels] of Object.entries(issues)) db.issues.set(String(n), { number: Number(n), labels: [...labels] });
  const stamp = () => new Date(Date.UTC(2030, 0, 1, 0, 0, ++db.tick)).toISOString();
  const issue = (n) => db.issues.get(n) || db.issues.set(n, { number: Number(n), labels: [] }).get(n);
  const view = (c) => ({ body: c.body, created_at: c.created_at, issue_url: `https://api.example/repos/acme/app/issues/${c.issue}` });
  db.addComment = (n, body, at) => db.comments.push({ issue: String(n), body, created_at: at || stamp() });
  db.transport = async ({ method = 'GET', path: p, query = {}, body }) => {
    db.calls.push(`${method} ${p}`);
    if (db.fail) throw new Error(db.fail);
    const m = p.match(/^repos\/acme\/app\/issues(?:\/(comments|\d+))?(?:\/(comments|labels))?(?:\/(.+))?$/);
    assert.ok(m, `unexpected path ${p}`);
    const [, first, second, third] = m;
    if (!first) {
      return [...db.issues.values()].filter((i) => i.labels.includes(query.labels))
        .map((i) => ({ number: i.number, labels: i.labels.map((name) => ({ name })), ...(i.pr ? { pull_request: {} } : {}) }));
    }
    if (first === 'comments') return db.comments.filter((c) => c.created_at >= query.since).map(view);
    if (!second) return { number: Number(first), labels: issue(first).labels.map((name) => ({ name })) };
    if (second === 'comments' && method === 'GET') return db.comments.filter((c) => c.issue === first).map(view);
    if (second === 'comments' && method === 'POST') {
      if (db.onPost) { const hook = db.onPost; db.onPost = null; hook(db, stamp); }
      const c = { issue: first, body: body.body, created_at: stamp() };
      db.comments.push(c);
      return view(c);
    }
    if (second === 'labels' && method === 'POST') { issue(first).labels.push(...body.labels); return []; }
    if (second === 'labels' && method === 'DELETE') {
      issue(first).labels = issue(first).labels.filter((l) => l !== decodeURIComponent(third));
      return [];
    }
    throw new Error(`unhandled ${method} ${p}`);
  };
  return db;
}

const CLOUD = { repo: 'acme/app', runtime: 'claude-cloud', tasks: Object.fromEntries(ROLE_NAMES.map((r) => [r, `task_${r}`])) };
const BUILD = 'pod: in-progress';

test('hosted runtimes count limits on the tracker; a local ledger there is rejected', () => {
  assert.equal(ledgerKind(contract(CLOUD)), 'tracker');
  assert.equal(ledgerKind(contract({ ...WORK, runtime: { type: 'copilot-cli', where: 'actions' } })), 'tracker');
  assert.equal(ledgerKind(contract(WORK)), 'local');
  assert.equal(ledgerKind(contract()), 'local');
  assert.equal(ledgerKind(contract({ ...WORK, limits: { ledger: 'tracker' } })), 'tracker');
  for (const hosted of [CLOUD, { ...WORK, runtime: { type: 'copilot-cli', where: 'actions' } }]) {
    const { errors } = validateConfig(contract({ ...hosted, limits: { ledger: 'local' } }));
    assert.ok(errors.some((e) => /hosted runtime .* must use the tracker ledger/.test(e)), 'doctor must reject it');
  }
  assert.ok(validateConfig(contract({ limits: { ledger: 'disk' } })).errors.some((e) => /limits\.ledger/.test(e)));
});

test('on a hosted runtime with an empty machine, every limit and the pause still bind', async () => {
  // The regression: nothing on local disk, so a disk-based count would be zero.
  const env = { FORGE_POD_STATE: tmp('empty-state') };
  const cfg = contract({ ...CLOUD, limits: { engineers: 3, round_trips: 3, daily_sessions: { pm: 2 } } });
  const gh = fakeGithub({ issues: { 1: [BUILD], 2: [BUILD], 3: [BUILD], 4: ['pod: ready'], 9: [BUILD] } });
  gh.issues.get('9').pr = true; // a pull request carrying the label is not a work item
  const ledger = openLedger(cfg, { env, transport: gh.transport });
  assert.equal(ledger.kind, 'tracker');

  assert.match(await claimHandoff(ledger, cfg, 'engineer', { item: '4', from: 'pm' }, env), /engineer limit reached \(3\/3\)/);
  assert.equal(gh.comments.length, 0, 'a refused handoff records nothing');
  assert.deepEqual(gh.issues.get('4').labels, ['pod: ready'], 'and leaves the item where it was');

  // Rework on an item already in build holds its slot; round trips are counted on the item.
  for (let i = 0; i < 3; i++) {
    assert.equal(await claimHandoff(ledger, cfg, 'engineer', { item: '1', from: i % 2 ? 'tester' : 'reviewer' }, env), null);
  }
  assert.match(await claimHandoff(ledger, cfg, 'engineer', { item: '1', from: 'reviewer' }, env), /round-trip limit reached for 1 \(3\/3\)/);
  assert.equal(gh.comments.filter((c) => c.issue === '1').length, 3);
  assert.match(gh.comments[0].body, /^<!-- pod:handoff from=reviewer to=engineer -->/);

  // Daily cap, counted from markers written since midnight UTC.
  const today = new Date().toISOString();
  gh.addComment(5, '<!-- pod:handoff from=sre to=pm -->', today);
  assert.equal(await checkHandoff(ledger, cfg, 'pm', { item: '5', from: 'sre' }, env), null);
  gh.addComment(6, '<!-- pod:handoff from=tester to=pm -->', today);
  assert.match(await checkHandoff(ledger, cfg, 'pm', { item: '5', from: 'sre' }, env), /daily session cap reached for pm \(2\/2\)/);

  // Pause is a tracker state, visible to every machine.
  gh.issues.set('7', { number: 7, labels: ['pod: paused'] });
  assert.match(await claimHandoff(ledger, cfg, 'reviewer', { item: '1', from: 'engineer' }, env), /paused/);
});

test('a slot freed on the tracker is usable, and the handoff command moves the item into build', async () => {
  const env = { FORGE_POD_STATE: tmp('empty-state') };
  const cfg = contract({ ...CLOUD, limits: { engineers: 1 } });
  const gh = fakeGithub({ issues: { 1: [BUILD], 2: ['pod: ready', 'bug'] } });
  const ledger = openLedger(cfg, { env, transport: gh.transport });
  assert.match(await claimHandoff(ledger, cfg, 'engineer', { item: '2', from: 'pm' }, env), /limit reached/);
  gh.issues.get('1').labels = ['pod: needs-human'];
  assert.equal(await claimHandoff(ledger, cfg, 'engineer', { item: '2', from: 'pm' }, env), null);
  assert.deepEqual(gh.issues.get('2').labels.sort(), ['bug', BUILD].sort(), 'state swapped, other labels kept');
});

test('two handoffs racing for the last engineer slot leave exactly one standing', async () => {
  const env = { FORGE_POD_STATE: tmp('empty-state') };
  const cfg = contract({ ...CLOUD, limits: { engineers: 1 } });
  const rival = (earlier) => (db, stamp) => {
    // Another session claims item 8 between our check and our write.
    const at = earlier ? stamp() : null;
    db.issues.set('8', { number: 8, labels: [BUILD] });
    if (earlier) db.addComment(8, '<!-- pod:handoff from=pm to=engineer -->', at);
    else db.later = () => db.addComment(8, '<!-- pod:handoff from=pm to=engineer -->');
  };

  // The rival's marker is older than ours: we withdraw.
  let gh = fakeGithub({ issues: { 5: ['pod: ready'] } });
  gh.onPost = rival(true);
  let ledger = openLedger(cfg, { env, transport: gh.transport });
  assert.match(await claimHandoff(ledger, cfg, 'engineer', { item: '5', from: 'pm' }, env), /concurrent handoff; the item is back in the ready state/);
  assert.deepEqual(gh.issues.get('5').labels, ['pod: ready']);
  assert.match(gh.comments.at(-1).body, /pod:release from=pm to=engineer/);

  // The rival's marker is newer than ours: we stand (the rival's own run withdraws).
  gh = fakeGithub({ issues: { 5: ['pod: ready'] } });
  gh.onPost = rival(false);
  const post = gh.transport;
  gh.transport = async (req) => { const r = await post(req); if (gh.later && req.method === 'POST' && /comments$/.test(req.path)) { gh.later(); gh.later = null; } return r; };
  ledger = openLedger(cfg, { env, transport: gh.transport });
  assert.equal(await claimHandoff(ledger, cfg, 'engineer', { item: '5', from: 'pm' }, env), null);
  assert.deepEqual(gh.issues.get('5').labels, [BUILD]);
});

test('the handoff command fails closed when limits cannot be verified', async () => {
  const repo = tmp('closed');
  fs.mkdirSync(path.join(repo, '.claude', 'pod'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'pod', 'project.yml'), example()
    .replace('repo: owner/name', 'repo: acme/app').replace('type: manual ', 'type: claude-cloud ')
    .replace(/^# tasks: .*$/m, `tasks: {${ROLE_NAMES.map((r) => `${r}: task_${r}`).join(', ')}}`));
  fs.writeFileSync(path.join(repo, 'packet.md'), '- **Goal:** g\n');
  const env = { FORGE_POD_HOME: tmp('home') };
  const lines = [];
  const run = (args, gh) => { lines.length = 0; return main(args, { cwd: repo, env, out: (l) => lines.push(l), transport: gh.transport }); };
  const handoff = ['handoff', 'engineer', '--packet', 'packet.md', '--from', 'pm'];

  const gh = fakeGithub({ issues: { 1: [BUILD], 2: [BUILD], 3: [BUILD], 4: ['pod: ready'] } });
  assert.equal(await run([...handoff, '--item', '4'], gh), EXIT.refused);
  assert.match(lines.join('\n'), /Handoff refused: engineer limit reached \(3\/3\)/);
  assert.doesNotMatch(lines.join('\n'), /task_engineer/, 'a refused handoff must not reveal the task to fire');

  assert.equal(await run(handoff, gh), EXIT.unverified, 'no --item: nothing to count on');
  gh.fail = 'HTTP 502';
  assert.equal(await run([...handoff, '--item', '4'], gh), EXIT.unverified);
  assert.match(lines.join('\n'), /limits could not be verified on the tracker ledger \(HTTP 502\)/);
  assert.doesNotMatch(lines.join('\n'), /task_engineer/);
  assert.equal(await run(['status', 'engineer', 'working', '--item', '4'], gh), EXIT.unverified, 'a role cannot start if pause is unreadable');
  gh.fail = null;

  // Dry run reports the verdict and writes nothing.
  assert.equal(await run([...handoff, '--item', '4', '--dry-run'], gh), EXIT.ok);
  assert.match(lines.join('\n'), /would be refused: engineer limit reached/);
  assert.ok(!gh.calls.some((c) => !c.startsWith('GET')), 'no write reached the tracker');

  // Accepted: recorded on the item, then the task is named.
  gh.issues.get('3').labels = ['pod: needs-human'];
  assert.equal(await run([...handoff, '--item', '4'], gh), EXIT.ok);
  assert.match(lines.join('\n'), /Fire scheduled task task_engineer/);
  assert.match(gh.comments.at(-1).body, /pod:handoff from=pm to=engineer/);
  assert.deepEqual(gh.issues.get('4').labels, [BUILD]);

  // Paused on the tracker: handoffs and role starts both stop.
  gh.issues.get('1').labels.push('pod: paused');
  assert.equal(await run(['handoff', 'reviewer', '--packet', 'packet.md', '--from', 'engineer', '--item', '4'], gh), EXIT.refused);
  assert.equal(await run(['status', 'pm', 'working'], gh), EXIT.refused);
  assert.match(lines.join('\n'), /the pod is paused/);
});

// In-memory Jira REST double covering the calls the ledger makes.
function fakeJira(issues) {
  const db = { issues: new Map(Object.entries(issues).map(([k, status]) => [k, { status, comments: [] }])), tick: 0 };
  const stamp = () => new Date(Date.now() + ++db.tick).toISOString().replace('Z', '+0000');
  db.transport = async ({ method = 'GET', path: p, query = {}, body }) => {
    if (p === '/rest/api/3/search/jql') {
      assert.match(query.jql, /^project = "ABC" AND /);
      const status = query.jql.match(/status = "([^"]+)"/)?.[1];
      return { issues: [...db.issues].filter(([, i]) => !status || i.status === status).map(([key]) => ({ key })) };
    }
    const [, key, what] = p.match(/^\/rest\/api\/2\/issue\/([^/]+)\/(comment|transitions)$/);
    const issue = db.issues.get(key);
    if (what === 'comment' && method === 'GET') return { comments: issue.comments };
    if (what === 'comment') { const c = { body: body.body, created: stamp() }; issue.comments.push(c); return c; }
    if (method === 'GET') return { transitions: (db.transitions || ['In Progress', 'Ready']).map((name, id) => ({ id: String(id), to: { name } })) };
    issue.status = (db.transitions || ['In Progress', 'Ready'])[Number(body.transition.id)];
    return null;
  };
  return db;
}

test('the same limits bind through the jira ledger', async () => {
  const env = { FORGE_POD_STATE: tmp('empty-state') };
  const cfg = contract({ ...WORK, runtime: { type: 'copilot-cli', where: 'actions' }, limits: { engineers: 2, round_trips: 1, daily_sessions: { tester: 1 } } });
  const jira = fakeJira({ 'ABC-1': 'In Progress', 'ABC-2': 'In Progress', 'ABC-3': 'Ready', 'ABC-4': 'Ready' });
  const ledger = openLedger(cfg, { env, transport: jira.transport });

  assert.match(await claimHandoff(ledger, cfg, 'engineer', { item: 'ABC-3', from: 'pm' }, env), /engineer limit reached \(2\/2\)/);
  jira.issues.get('ABC-2').status = 'In Review';
  assert.equal(await claimHandoff(ledger, cfg, 'engineer', { item: 'ABC-3', from: 'pm' }, env), null);
  assert.equal(jira.issues.get('ABC-3').status, 'In Progress', 'moved by a workflow transition');
  assert.equal(jira.issues.get('ABC-3').comments[0].body, '[pod:handoff from=pm to=engineer]');

  assert.equal(await claimHandoff(ledger, cfg, 'engineer', { item: 'ABC-3', from: 'reviewer' }, env), null);
  assert.match(await claimHandoff(ledger, cfg, 'engineer', { item: 'ABC-3', from: 'tester' }, env), /round-trip limit reached for ABC-3 \(1\/1\)/);

  assert.equal(await claimHandoff(ledger, cfg, 'tester', { item: 'ABC-3', from: 'engineer' }, env), null);
  assert.match(await claimHandoff(ledger, cfg, 'tester', { item: 'ABC-1', from: 'engineer' }, env), /daily session cap reached for tester \(1\/1\)/);

  jira.issues.get('ABC-4').status = 'On Hold';
  assert.match(await checkHandoff(ledger, cfg, 'reviewer', { item: 'ABC-1', from: 'engineer' }, env), /paused/);
  jira.issues.get('ABC-4').status = 'Ready';

  // A workflow without the needed transition is an error, never a silent pass.
  jira.issues.get('ABC-2').status = 'Done';
  jira.issues.get('ABC-1').status = 'Done';
  jira.issues.get('ABC-3').status = 'Done';
  jira.transitions = ['Ready'];
  await assert.rejects(() => claimHandoff(ledger, cfg, 'engineer', { item: 'ABC-4', from: 'pm' }, env), /no workflow transition to 'In Progress'/);
  // And without credentials the real transport refuses rather than guessing.
  await assert.rejects(() => openLedger(cfg, { env: {} }).paused(), /Jira credentials missing/);
});

test('a persistent machine may keep its ledger on disk, with the same guards', async () => {
  const env = { FORGE_POD_STATE: tmp('state') };
  const cfg = contract({ limits: { engineers: 2, round_trips: 2, daily_sessions: { pm: 1 } } });
  const ledger = openLedger(cfg, { env });
  assert.equal(ledger.kind, 'local');
  assert.match(await claimHandoff(ledger, cfg, 'engineer', {}, env), /--item is required/);
  assert.equal(await claimHandoff(ledger, cfg, 'engineer', { item: 'A' }, env), null);
  appendStatus(cfg, { role: 'engineer', state: 'working', item: 'A' }, env);
  appendStatus(cfg, { role: 'engineer', state: 'working', item: 'B' }, env);
  assert.match(await claimHandoff(ledger, cfg, 'engineer', { item: 'C' }, env), /engineer limit reached \(2\/2\)/);
  assert.equal(await claimHandoff(ledger, cfg, 'engineer', { item: 'A', from: 'reviewer' }, env), null, 'rework holds its slot');
  appendStatus(cfg, { role: 'engineer', state: 'done', item: 'B' }, env);
  assert.equal(await checkHandoff(ledger, cfg, 'engineer', { item: 'C' }, env), null);
  assert.equal(await claimHandoff(ledger, cfg, 'engineer', { item: 'A', from: 'tester' }, env), null);
  assert.match(await claimHandoff(ledger, cfg, 'engineer', { item: 'A', from: 'reviewer' }, env), /round-trip limit reached for A \(2\/2\)/);
  assert.equal(await claimHandoff(ledger, cfg, 'pm', { from: 'sre' }, env), null);
  assert.match(await claimHandoff(ledger, cfg, 'pm', { from: 'sre' }, env), /daily session cap reached for pm/);
  fs.writeFileSync(path.join(env.FORGE_POD_STATE, 'PAUSED'), 'x');
  assert.match(await claimHandoff(ledger, cfg, 'reviewer', {}, env), /paused/);
});

test('on the local ledger a handoff reserves the engineer slot before the engineer starts', async () => {
  const env = { FORGE_POD_STATE: tmp('state') };
  const cfg = contract({ limits: { engineers: 2 } });
  const ledger = openLedger(cfg, { env });
  // Nobody has reported `working`: the handoffs themselves must hold the slots.
  assert.equal(await claimHandoff(ledger, cfg, 'engineer', { item: 'A', from: 'pm' }, env), null);
  assert.equal(await claimHandoff(ledger, cfg, 'engineer', { item: 'B', from: 'pm' }, env), null);
  assert.match(await claimHandoff(ledger, cfg, 'engineer', { item: 'C', from: 'pm' }, env), /engineer limit reached \(2\/2\)/);
  assert.equal(readStatus(cfg, env).length, 2, 'the refused handoff recorded nothing');

  // Reporting `working` keeps the slot; any other status frees it.
  appendStatus(cfg, { role: 'engineer', state: 'working', item: 'A' }, env);
  assert.match(await checkHandoff(ledger, cfg, 'engineer', { item: 'C' }, env), /limit reached/);
  appendStatus(cfg, { role: 'engineer', state: 'done', item: 'A' }, env);
  assert.equal(await claimHandoff(ledger, cfg, 'engineer', { item: 'C', from: 'pm' }, env), null);

  // A reservation whose engineer never started lapses; one that is working does not.
  const old = new Date(Date.now() - 31 * 60000).toISOString();
  const rows = [
    { ts: old, event: 'handoff', to: 'engineer', item: 'X' },
    { ts: old, event: 'handoff', to: 'engineer', item: 'Y' },
    { ts: old, role: 'engineer', state: 'working', item: 'Y' },
    { ts: new Date().toISOString(), event: 'handoff', to: 'engineer', item: 'Z' },
    { ts: new Date().toISOString(), event: 'release', to: 'engineer', item: 'Z' },
  ];
  assert.deepEqual(localBuilds(rows, cfg), ['Y']);
  assert.deepEqual(localBuilds(rows, contract({ limits: { claim_timeout_minutes: 60 } })).sort(), ['X', 'Y']);
});

test('an engineer whose reservation lapsed cannot start after its slot was given away', async () => {
  const repo = tmp('lapsed');
  fs.mkdirSync(path.join(repo, '.github', 'pod'), { recursive: true });
  const file = path.join(repo, '.github', 'pod', 'project.yml');
  fs.writeFileSync(file, example().replace(/engineers: 3/, 'engineers: 1'));
  fs.writeFileSync(path.join(repo, 'packet.md'), '- **Goal:** g\n');
  const env = { FORGE_POD_HOME: tmp('home'), FORGE_POD_STATE: tmp('state') };
  const lines = [];
  const run = (args) => { lines.length = 0; return main(args, { cwd: repo, env, out: (l) => lines.push(l) }); };
  const cfg = loadConfig(file).cfg;
  const handoff = (item) => run(['handoff', 'engineer', '--packet', 'packet.md', '--item', item, '--from', 'pm']);
  const start = (item) => run(['status', 'engineer', 'working', ...(item ? ['--item', item] : [])]);
  const working = () => readStatus(cfg, env).filter((r) => r.role === 'engineer' && r.state === 'working').map((r) => r.item);

  // A is handed off but its engineer does not start. The reservation lapses.
  appendStatus(cfg, { ts: new Date(Date.now() - 31 * 60000).toISOString(), event: 'handoff', role: 'pm', to: 'engineer', item: 'A' }, env);
  assert.equal(await handoff('B'), EXIT.ok, 'the lapsed slot goes to B');
  assert.equal(await start('B'), EXIT.ok);

  // The delayed engineer for A now turns up. It must not become a second engineer.
  assert.equal(await start('A'), EXIT.refused);
  assert.match(lines.join('\n'), /Stop: no live reservation for A: .* lapsed before work began/);
  assert.deepEqual(working(), ['B'], 'the refused start recorded nothing');

  // Never handed off, or started without naming an item: refused the same way.
  assert.equal(await start('NEVER'), EXIT.refused);
  assert.equal(await start(null), EXIT.refused);
  assert.match(lines.join('\n'), /--item is required/);

  // Reporting `working` again on the item it holds is fine; so are other roles.
  assert.equal(await start('B'), EXIT.ok);
  assert.equal(await run(['status', 'tester', 'working', '--item', 'A']), EXIT.ok);

  // Once B finishes, A needs a new handoff, and then it may start.
  assert.equal(await run(['status', 'engineer', 'done', '--item', 'B']), EXIT.ok);
  assert.equal(await start('A'), EXIT.refused, 'a free slot is not a reservation');
  assert.equal(await handoff('A'), EXIT.ok);
  assert.equal(await start('A'), EXIT.ok);

  // A withdrawn handoff does not admit either.
  appendStatus(cfg, { event: 'release', role: 'pm', to: 'engineer', item: 'A' }, env);
  assert.equal(await start('A'), EXIT.refused);
});

test('on a tracker ledger an engineer may start only on an item that is in build', async () => {
  const repo = tmp('admit');
  fs.mkdirSync(path.join(repo, '.claude', 'pod'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'pod', 'project.yml'), example()
    .replace('repo: owner/name', 'repo: acme/app').replace('type: manual ', 'type: claude-cloud '));
  const env = { FORGE_POD_HOME: tmp('home') };
  const gh = fakeGithub({ issues: { 1: [BUILD], 2: ['pod: ready'] } });
  const lines = [];
  const start = (item) => { lines.length = 0; return main(['status', 'engineer', 'working', '--item', item], { cwd: repo, env, out: (l) => lines.push(l), transport: gh.transport }); };
  assert.equal(await start('1'), EXIT.ok);
  assert.equal(await start('2'), EXIT.refused, 'withdrawn by a race, or never handed off');
  assert.match(lines.join('\n'), /2 is not in the in-progress state, so it holds no engineer slot/);
  gh.fail = 'HTTP 503';
  assert.equal(await start('1'), EXIT.unverified);
  assert.equal(await admitEngineer({ kind: 'tracker', inBuild: async () => ['7'] }, '7'), null);
});

test('interleaved local handoffs cannot both take the last engineer slot', async () => {
  // Eight claims started together interleave at every await: without the lock
  // each one reads the ledger before any of them has written to it.
  const env = { FORGE_POD_STATE: tmp('state') };
  const cfg = contract({ limits: { engineers: 2 } });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    claimHandoff(openLedger(cfg, { env }), cfg, 'engineer', { item: `ITEM-${i}`, from: 'pm' }, env)));
  assert.equal(results.filter((r) => r === null).length, 2, JSON.stringify(results));
  assert.equal(results.filter((r) => /engineer limit reached \(2\/2\)/.test(r || '')).length, 6);
  assert.equal(readStatus(cfg, env).filter((r) => r.event === 'handoff').length, 2);
});

test('concurrent local handoffs from separate processes never exceed the engineer limit', async () => {
  const repo = tmp('concurrent');
  fs.mkdirSync(path.join(repo, '.github', 'pod'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.github', 'pod', 'project.yml'), example().replace(/engineers: 3/, 'engineers: 2'));
  fs.writeFileSync(path.join(repo, 'packet.md'), '- **Goal:** g\n');
  const env = { ...process.env, FORGE_POD_HOME: tmp('home'), FORGE_POD_STATE: tmp('state') };
  delete env.FORGE_POD_CONFIG;
  const script = path.join(REPO_ROOT, 'lib', 'pod.mjs');
  const { spawn } = await import('node:child_process');
  const launch = (item) => new Promise((resolve) => {
    const child = spawn(process.execPath, [script, 'handoff', 'engineer', '--packet', 'packet.md', '--item', item, '--from', 'pm'], { cwd: repo, env, stdio: 'ignore' });
    child.on('exit', (code) => resolve(code));
  });
  // Eight processes start together and race for two slots.
  const codes = await Promise.all(Array.from({ length: 8 }, (_, i) => launch(`ITEM-${i}`)));
  assert.equal(codes.filter((c) => c === EXIT.ok).length, 2, `exit codes: ${codes}`);
  assert.equal(codes.filter((c) => c === EXIT.refused).length, 6, `exit codes: ${codes}`);
  const cfg = loadConfig(path.join(repo, '.github', 'pod', 'project.yml')).cfg;
  const recorded = readStatus(cfg, env).filter((r) => r.event === 'handoff');
  assert.equal(recorded.length, 2, 'only the two accepted handoffs are on the ledger');
  assert.ok(!fs.existsSync(path.join(env.FORGE_POD_STATE, 'ledger.lock')), 'the lock is released');
});

// ---------- project root ----------

test('the project is found from any directory inside it, and paths stay root-relative', async () => {
  const repo = fs.realpathSync(tmp('root'));
  const env = { FORGE_POD_HOME: tmp('home') };
  fs.mkdirSync(path.join(repo, '.git'));
  const nested = path.join(repo, 'packages', 'app', 'src');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findProject(nested, env), null);

  const lines = [];
  const run = (args, cwd = nested) => { lines.length = 0; return main(args, { cwd, env, out: (l) => lines.push(l) }); };
  assert.equal(await run(['init', '--host', 'copilot']), 0, 'init from a subdirectory writes at the repository root');
  const contractFile = path.join(repo, '.github', 'pod', 'project.yml');
  assert.ok(fs.existsSync(contractFile));
  assert.match(fs.readFileSync(contractFile, 'utf8'), new RegExp(`^project: ${path.basename(repo).toLowerCase()}$`, 'm'));
  assert.deepEqual(findProject(nested, env), { root: repo, config: contractFile });
  assert.equal(findConfig(nested, env), contractFile);
  assert.equal(await run(['doctor']), 0);
  assert.match(lines.join('\n'), new RegExp(`root: ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));

  fs.writeFileSync(contractFile, fs.readFileSync(contractFile, 'utf8')
    .replace('type: manual ', 'type: copilot-cli ').replace('  # where: local ', '  where: actions # '));
  fs.writeFileSync(path.join(nested, 'packet.md'), '- **Goal:** g\n');
  assert.equal(await run(['handoff', 'reviewer', '--packet', 'packet.md', '--item', '7', '--dry-run', '--foreground']), 0);
  const fromNested = lines.join('\n');
  assert.equal(await run(['handoff', 'reviewer', '--packet', path.join(nested, 'packet.md'), '--item', '7', '--dry-run', '--foreground'], repo), 0);
  assert.equal(fromNested, lines.join('\n'), 'the same handoff whatever directory it is started from');
  assert.doesNotMatch(fromNested, /\.\.\//, 'no path climbs out of a subdirectory');

  assert.equal(await run(['workflows']), 0);
  assert.ok(fs.existsSync(path.join(repo, '.github', 'workflows', 'pod-pm.yml')), 'workflows land at the root');
  assert.ok(!fs.existsSync(path.join(nested, '.github')));
});

test('an installed pod script knows its own project from where it sits', () => {
  const repo = fs.realpathSync(tmp('installed'));
  const elsewhere = tmp('elsewhere');
  const opts = { home: repo, project: repo, role: 'pod' };
  for (const a of planInstall('claude', opts).actions) writeFileSafe(a.path, a.content, { apply: true, mode: a.mode });
  fs.mkdirSync(path.join(repo, '.claude', 'pod'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'pod', 'project.yml'), example());
  const script = path.join(repo, '.claude', 'forge', 'pod', 'pod.mjs');
  const env = { ...process.env, FORGE_POD_HOME: tmp('home') };
  delete env.FORGE_POD_CONFIG;
  for (const cwd of [elsewhere, path.join(repo, '.claude', 'forge')]) {
    const res = spawnSync(process.execPath, [script, 'doctor'], { cwd, env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, new RegExp(`root: ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
  }
  fs.writeFileSync(path.join(elsewhere, 'p.md'), 'x\n');
  const res = spawnSync(process.execPath, [script, 'handoff', 'reviewer', '--packet', 'p.md', '--dry-run'], { cwd: elsewhere, env, encoding: 'utf8' });
  assert.match(res.stdout, /read: \.claude\/forge\/pod\/protocol\.md, \.claude\/forge\/pod\/roles\/reviewer\.md/);
});

test('an out-of-repo contract is found from a subdirectory, keyed by the repository name', () => {
  const repo = fs.realpathSync(tmp('clean'));
  const home = tmp('home');
  fs.mkdirSync(path.join(repo, '.git'));
  const nested = path.join(repo, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  const outside = path.join(home, path.basename(repo).toLowerCase(), 'project.yml');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, example());
  assert.deepEqual(findProject(nested, { FORGE_POD_HOME: home }), { root: repo, config: outside });
  assert.deepEqual(findProject(nested, { FORGE_POD_CONFIG: outside, FORGE_POD_ROOT: repo }), { root: repo, config: outside });
  const inRepo = path.join(repo, '.claude', 'pod', 'project.yml');
  assert.equal(findProject(tmp('x'), { FORGE_POD_CONFIG: inRepo }).root, repo, 'root derived from an in-repo contract path');
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
