// Renderer regression tests: every generated frontmatter block must be safe
// YAML, and host-specific quirks (model pins, agent bindings, visibility)
// must land in the right adapter's output.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { adapterNames, planInstall, rulesContent } from '../lib/core.mjs';

const HOME = path.join(os.tmpdir(), 'forge-render-test-home');

function rendered(tool) {
  return planInstall(tool, { home: HOME }).actions;
}

function rubric(actions) {
  const action = actions.find((item) => item.path.endsWith(
    path.join('forge', 'skills', 'code-review-rubric', 'SKILL.md'),
  ));
  assert.ok(action, 'code-review rubric not rendered');
  return action.content;
}

function frontmatter(content, file) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, `${file}: missing frontmatter`);
  return m[1].split('\n');
}

// A dependency-free YAML sanity check tuned to what the renderers emit:
// every line must be a block-scalar header (+ indented body), a flow list,
// a nested `  tool: true` flag, a bare map header, or a plain scalar that
// contains no ': ' (the failure mode that broke the OpenCode render).
function assertSafeFrontmatter(lines, file) {
  let inBlock = false;
  for (const line of lines) {
    if (inBlock) {
      if (line === '' || line.startsWith('  ')) continue;
      inBlock = false;
    }
    if (/^[A-Za-z0-9_-]+: \|-$/.test(line)) { inBlock = true; continue; }
    if (/^[A-Za-z0-9_-]+:$/.test(line)) continue; // map header (e.g. tools:)
    if (/^  [A-Za-z0-9_./-]+: (true|false)$/.test(line)) continue; // nested flag
    const kv = line.match(/^([A-Za-z0-9_-]+): (.*)$/);
    assert.ok(kv, `${file}: unexpected frontmatter line: ${JSON.stringify(line)}`);
    assert.ok(!kv[2].includes(': '),
      `${file}: plain scalar contains ': ' (invalid YAML): ${JSON.stringify(line)}`);
  }
}

// Agent and prompt/command files are the ones whose frontmatter a host parses.
const FM_DIRS = new Set(['agents', 'agent', 'prompts', 'commands', 'command']);

test('all rendered agent/prompt frontmatter is safe YAML', () => {
  let checked = 0;
  for (const tool of adapterNames()) {
    for (const a of rendered(tool)) {
      const parent = path.basename(path.dirname(a.path));
      if (!FM_DIRS.has(parent)) continue;
      assertSafeFrontmatter(frontmatter(a.content, a.path), path.relative(HOME, a.path));
      checked++;
    }
  }
  assert.ok(checked >= 24, `expected to check all agents+prompts across adapters, got ${checked}`);
});

test('rendered output has no unresolved placeholders', () => {
  for (const tool of adapterNames()) {
    for (const a of rendered(tool)) {
      const un = a.content.match(/\{\{[A-Z_]+\}\}/g);
      assert.equal(un, null, `${path.relative(HOME, a.path)}: unresolved ${un}`);
    }
  }
});

test('forge entry guidance classifies intent before delivery setup', () => {
  for (const tool of adapterNames()) {
    const agent = rendered(tool).find((action) =>
      ['agents', 'agent'].includes(path.basename(path.dirname(action.path)))
      && /^forge(?:\.agent)?\.md$/.test(path.basename(action.path)));
    assert.ok(agent, `${tool}: forge agent not rendered`);
    const intentStart = agent.content.indexOf('## Task intent');
    const deliveryStart = agent.content.indexOf('## Delivery');
    assert.ok(intentStart >= 0 && deliveryStart > intentStart,
      `${tool}: classify intent before delivery setup`);
    const intent = agent.content.slice(intentStart, deliveryStart);
    assert.match(intent, /answer.*advice.*delivery/);
    assert.match(intent, /no writes, including memory and graphs/);
    assert.match(intent, /explicit permission/);
    assert.match(intent, /Diagnostic commands require explicit permission/);
    assert.doesNotMatch(intent, /mem init/);
  }
});

test('ship is a task-packet entry point, not a second workflow', () => {
  for (const tool of adapterNames()) {
    const ship = rendered(tool).find((action) =>
      ['prompts', 'commands', 'command'].includes(path.basename(path.dirname(action.path)))
      && /^ship(?:\.prompt)?\.md$/.test(path.basename(action.path)));
    assert.ok(ship, `${tool}: ship prompt not rendered`);
    assert.match(ship.content, /Goal/);
    assert.match(ship.content, /Allowed effects/);
    assert.match(ship.content, /task intent/);
    assert.doesNotMatch(ship.content, /mem init|## Step [0-9]/);
  }
});

test('babysit is a bounded PR entry point that never merges', () => {
  for (const tool of adapterNames()) {
    const babysit = rendered(tool).find((action) =>
      ['prompts', 'commands', 'command'].includes(path.basename(path.dirname(action.path)))
      && /^babysit(?:\.prompt)?\.md$/.test(path.basename(action.path)));
    assert.ok(babysit, `${tool}: babysit prompt not rendered`);
    assert.match(babysit.content, /--force-with-lease/);
    assert.match(babysit.content, /Allowed effects/);
    assert.match(babysit.content, /never merges/);
    assert.match(babysit.content, /\*\*Not authorized:\*\* merging the PR/);
    assert.match(babysit.content, /never plain `--force`/i);
    assert.match(babysit.content, /never sleep or busy-wait/);
    assert.match(babysit.content, /3 fix cycles/);
    assert.doesNotMatch(babysit.content, /mem init|## Step [0-9]/);
  }
});

test('push rules allow pushes only via Allowed effects', () => {
  for (const tool of adapterNames()) {
    const actions = rendered(tool);
    const shared = actions.find((action) => action.path.endsWith(
      path.join('_shared', 'engineering-context.md')));
    assert.ok(shared, `${tool}: shared context not rendered`);
    assert.match(shared.content, /Never push, never force-push\.[^\n]*Allowed effects/);
    assert.match(shared.content, /Never push, never force-push\.[^\n]*never plain `--force`/);
    const agent = actions.find((action) =>
      ['agents', 'agent'].includes(path.basename(path.dirname(action.path)))
      && /^forge(?:\.agent)?\.md$/.test(path.basename(action.path)));
    assert.ok(agent, `${tool}: forge agent not rendered`);
    assert.match(agent.content, /never auto-commit or push, unless[^\n]*Allowed effects/);
    assert.match(agent.content, /\*\*never push\*\* without an explicit ask[^\n]*Allowed effects/);
    const rules = actions.find((action) => action.content === rulesContent());
    assert.ok(rules, `${tool}: always-on rules not rendered`);
    assert.match(rules.content, /No commits or pushes in ship mode unless[^.;]*Allowed effects/);
  }
});

test('shared and specialist guidance preserves permissions and progress evidence', () => {
  for (const tool of adapterNames()) {
    const actions = rendered(tool);
    const shared = actions.find((action) => action.path.endsWith(
      path.join('_shared', 'engineering-context.md')));
    assert.ok(shared, `${tool}: shared context not rendered`);
    for (const field of ['Intent', 'Goal', 'Anchor', 'Constraints / non-goals',
      'Acceptance evidence', 'Allowed effects']) {
      assert.ok(shared.content.includes(`**${field}**`), `${tool}: missing ${field}`);
    }
    assert.match(shared.content, /without new evidence/);
    assert.match(shared.content, /unchanged inputs/);
    assert.match(shared.content, /reconcile its state before retrying/);
    assert.match(shared.content, /Resume packet/);
    assert.match(shared.content, /Coaching recommendations remain advisory/);
    assert.match(shared.content, /Persist a checkpoint only when allowed/);
    for (const name of ['implementer', 'reviewer']) {
      const agent = actions.find((action) =>
        ['agents', 'agent'].includes(path.basename(path.dirname(action.path)))
        && new RegExp(`^${name}(?:\\.agent)?\\.md$`).test(path.basename(action.path)));
      assert.ok(agent, `${tool}: ${name} not rendered`);
      assert.match(agent.content, /Allowed effects/);
      assert.match(agent.content, /conversation/);
      assert.doesNotMatch(agent.content, /mem init|mem path/);
    }
  }
});

test('Forge concurrency guidance maximizes safe parallel work', () => {
  const shared = rendered('copilot').find((action) => action.path.endsWith(
    path.join('_shared', 'engineering-context.md'))).content;
  const agent = rendered('copilot').find((action) => action.path.endsWith(
    path.join('agents', 'forge.agent.md'))).content;
  assert.match(shared, /concurrency-first/);
  assert.match(shared, /Discovery:.*in parallel/s);
  assert.match(shared, /Implementation:.*a single implementer handling one task may edit multiple independent files directly/s);
  assert.match(shared, /Validation:.*in parallel/s);
  assert.match(shared, /do not impose an arbitrary agent, tool, file, or message cap/);
  assert.match(shared, /a single implementer handling one task may edit multiple independent files directly/);
  assert.match(shared, /separate isolated worktrees or branches.*only when multiple implementer agents work concurrently/s);
  assert.match(shared, /not a requirement for a single implementer's own multi-file edits/);
  assert.match(shared, /shared contract -> dependent consumers/);
  assert.match(shared, /parallel edits -> integration/);
  assert.match(agent, /parallelize read-only discovery/);
  assert.match(agent, /Do not invent an arbitrary dispatch cap/);
});

test('super mode is an installed optional reference with delivery safeguards', () => {
  for (const tool of adapterNames()) {
    const actions = rendered(tool);
    const recipe = actions.find((action) => action.path.endsWith(
      path.join('_shared', 'super-mode.md')));
    assert.ok(recipe, `${tool}: super-mode reference not installed`);
    const agent = actions.find((action) =>
      ['agents', 'agent'].includes(path.basename(path.dirname(action.path)))
      && /^forge(?:\.agent)?\.md$/.test(path.basename(action.path)));
    assert.ok(agent.content.includes(recipe.path), `${tool}: recipe link must resolve`);
    assert.match(agent.content, /Do not load the super-mode recipe for ordinary ship, answer, or advice/);
    assert.doesNotMatch(agent.content, /## Step 0 - Super mode/);
    assert.match(recipe.content, /independent reviewer returns `APPROVED`/);
    assert.match(recipe.content, /clean working tree/);
    assert.match(recipe.content, /Never push or force-push automatically/);
    assert.match(recipe.content, /self-performed, not independent/);
  }
});

test('always-on routing stays permission-first and advisory rather than metric-gated', () => {
  const rules = rulesContent();
  assert.match(rules, /Intent before setup/);
  assert.match(rules, /Allowed effects/);
  assert.match(rules, /No bootstrap or audit writes for read-only work/);
  assert.match(rules, /External coaching is advisory, never a gate/);
  assert.doesNotMatch(rules, /mem init|mem path|## Step [0-9]|clear.*freely/);
});

test('rendered rubric preserves contract, terminal-state, and framework-build checks', () => {
  for (const tool of adapterNames()) {
    const content = rubric(rendered(tool));
    assert.match(content, /actual serialized API contract/);
    assert.match(content, /loading, empty, success, and error/);
    assert.match(content, /disabled indefinitely/);
    assert.match(content, /framework build/);
    assert.match(content, /module resolution/);
  }
});

test('opencode ship command binds to the forge agent', () => {
  const ship = rendered('opencode').find((a) => a.path.endsWith(`command${path.sep}ship.md`));
  assert.ok(ship, 'opencode ship command not rendered');
  assert.ok(frontmatter(ship.content, ship.path).includes('agent: forge'));
});

test('opencode babysit command binds to the forge agent', () => {
  const babysit = rendered('opencode').find((a) => a.path.endsWith(`command${path.sep}babysit.md`));
  assert.ok(babysit, 'opencode babysit command not rendered');
  assert.ok(frontmatter(babysit.content, babysit.path).includes('agent: forge'));
});

test('copilot render pins no model; cursor render pins forge only', () => {
  for (const a of rendered('copilot').filter((x) => x.path.includes(`agents${path.sep}`))) {
    assert.ok(!/^model:/m.test(a.content), `${path.relative(HOME, a.path)}: copilot must not pin a model`);
  }
  for (const a of rendered('cursor').filter((x) => x.path.includes(`agents${path.sep}`))) {
    const hasModel = /^model: /m.test(a.content);
    if (a.path.endsWith(`${path.sep}forge.md`)) assert.ok(hasModel, 'cursor forge.md must pin the default model');
    else assert.ok(!hasModel, `${path.relative(HOME, a.path)}: specialists must inherit, not pin`);
  }
});

test('only the router lists subagents or run_subagent; specialists are hidden', () => {
  for (const a of rendered('copilot').filter((x) => x.path.includes(`agents${path.sep}`))) {
    const isForge = a.path.endsWith(`${path.sep}forge.agent.md`);
    const fm = frontmatter(a.content, a.path).join('\n');
    assert.equal(/^agents: /m.test(fm), isForge, `${path.relative(HOME, a.path)}: agents list`);
    assert.equal(fm.includes('agent/runSubagent'), isForge, `${path.relative(HOME, a.path)}: run_subagent`);
    assert.equal(fm.includes('user-invocable: false'), !isForge, `${path.relative(HOME, a.path)}: visibility`);
  }
});

test('opencode roles map to primary/subagent modes', () => {
  for (const a of rendered('opencode').filter((x) => x.path.includes(`agent${path.sep}`) && !x.path.includes('command'))) {
    const isForge = a.path.endsWith(`${path.sep}forge.md`);
    assert.ok(a.content.includes(`mode: ${isForge ? 'primary' : 'subagent'}`),
      `${path.relative(HOME, a.path)}: wrong mode`);
  }
});
