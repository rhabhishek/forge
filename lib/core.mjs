// Forge core - dependency-free helpers shared by the CLI.
// Node >=18, ESM. No external packages. Adapted from the Cortex installer model.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STORE_DIR = path.join(REPO_ROOT, 'store');
export const FORGE_CLI = path.join(REPO_ROOT, 'bin', 'forge.mjs');

export const today = () => new Date().toISOString().slice(0, 10);

// ---------- tiny frontmatter (controlled simple format) ----------

export function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    data[key] = val;
  }
  return { data, body: m[2] };
}

// ---------- placeholder substitution ----------

export function substitute(text, vars) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
  );
}

export function unresolved(text) {
  const out = new Set();
  for (const m of text.matchAll(/\{\{([A-Z_]+)\}\}/g)) out.add(m[1]);
  return [...out];
}

// ---------- profiles ----------

export function loadProfiles() {
  return JSON.parse(fs.readFileSync(path.join(STORE_DIR, 'profiles.json'), 'utf8'));
}

// ---------- capability -> per-tool tool mapping ----------

// MCP tool IDs are `<server-key>/<tool>` (server-key matches the mcp.json key).
// Enumerate explicit IDs — the Copilot client does not reliably expand a
// `server/*` wildcard, so `github/*` granted nothing.
// GitHub's official remote MCP server. Exported so `doctor` can warn when the
// toolset is granted but no such server is configured.
export const GH_SERVER_KEY = 'io.github.github/github-mcp-server';
// Toolset prefix VS Code exposes for the GitHub MCP server in an agent's
// `tools:` list (the server's *name*, not the mcp.json server key above).
const GH_TOOLSET = 'github';
const GITHUB_TOOLS = [
  'add_comment_to_pending_review', 'add_issue_comment', 'add_reply_to_pull_request_comment',
  'assign_copilot_to_issue', 'create_branch', 'create_or_update_file', 'create_pull_request',
  'create_pull_request_with_copilot', 'create_repository', 'delete_file', 'fork_repository',
  'get_commit', 'get_copilot_job_status', 'get_file_contents', 'get_label', 'get_latest_release',
  'get_me', 'get_release_by_tag', 'get_tag', 'get_team_members', 'get_teams', 'issue_read',
  'issue_write', 'list_branches', 'list_commits', 'list_issue_types', 'list_issues',
  'list_pull_requests', 'list_releases', 'list_tags', 'merge_pull_request', 'pull_request_read',
  'pull_request_review_write', 'push_files', 'request_copilot_review', 'run_secret_scanning',
  'search_code', 'search_issues', 'search_pull_requests', 'search_repositories', 'search_users',
  'sub_issue_write', 'update_pull_request', 'update_pull_request_branch',
].map((t) => `${GH_TOOLSET}/${t}`);

export const CAPABILITY_MAP = {
  copilot: {
    // Current VS Code / Copilot **namespaced toolset IDs** (`<group>/<tool>`).
    // VS Code re-serializes an agent's `tools:` to these on load, so emitting
    // them here means a fresh install lands already-enabled and matches what the
    // host writes back. Reconciliation preserves a host-managed `tools:` line
    // from its captured snapshot, so UI-enabled tools aren't reset.
    'read-file': ['read/readFile', 'read/problems', 'search/codebase', 'search/fileSearch', 'search/textSearch', 'search/listDirectory', 'search/usages'],
    'write-file': ['edit/editFiles', 'edit/createFile', 'edit/createDirectory', 'edit/rename'],
    'run-terminal': ['execute/runInTerminal', 'execute/getTerminalOutput', 'execute/sendToTerminal', 'execute/runTests', 'execute/runTask'],
    'web-fetch': ['web/fetch', 'web/githubRepo'],
    github: GITHUB_TOOLS,
  },
  opencode: {
    'read-file': ['read', 'grep', 'glob'],
    'write-file': ['write', 'edit'],
    'run-terminal': ['bash'],
    'web-fetch': ['webfetch'],
    github: [],
  },
};

function mapCaps(tool, caps) {
  const m = CAPABILITY_MAP[tool] || {};
  const out = [];
  for (const c of caps || []) for (const t of m[c] || []) if (!out.includes(t)) out.push(t);
  return out;
}

// ---------- adapters ----------

function asList(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

// Render `key: value` as a YAML literal block scalar so descriptions that
// contain ':' or '->' survive a host re-serializing the file in place. Copilot
// rewrites the primary agent's frontmatter on load; an inline double-quoted
// scalar got line-folded and its wrapped fragments mis-parsed as map keys
// (e.g. `The single: ''`). A literal block is copied verbatim - its boundary is
// defined by indentation, so there is nothing to fold, quote, or mis-read.
function yamlBlock(key, value, indent = '  ') {
  const lines = String(value ?? '').split('\n');
  return [`${key}: |-`, ...lines.map((l) => indent + l)];
}

function walkFiles(absDir) {
  const out = [];
  if (!fs.existsSync(absDir)) return out;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(STORE_DIR, full));
    }
  };
  walk(absDir);
  return out;
}

const ADAPTERS = {
  copilot: {
    label: 'GitHub Copilot (VS Code + CLI + IntelliJ)',
    base: (home) => path.join(home, '.copilot'),
    agentFile: (name) => `agents/${name}.agent.md`,
    promptFile: (name) => `prompts/${name}.prompt.md`,
    rulesFile: 'forge.instructions.md',
    // VS Code owns the `tools:` line once a user toggles tools in the UI (it
    // re-serializes the agent file). Reconciliation injects the line from its
    // authoritative snapshot so enablement isn't reset every time.
    preservesTools: true,
    renderAgent(data, body, opts = {}) {
      // Model policy: emit NO `model:` line for any agent. The store's `model:`
      // value is a Cursor slug (e.g. claude-4.6-sonnet-medium-thinking) that
      // Copilot does not recognize, so pinning it here would break model
      // selection on real Copilot hosts. Without the line every agent inherits
      // its parent's model: `forge` runs on the user's chat model, and the
      // specialists it spawns inherit forge's, so the whole swarm follows the
      // user's choice. (The Cursor renderer is where the store's pin is used.)
      const fm = ['---', `name: ${data.name}`, ...yamlBlock('description', data.description)];
      // Preserve a host-managed tools line verbatim when present (reinstall);
      // otherwise emit the namespaced default set (fresh install).
      let toolsLine = opts.preserveToolsLine || null;
      if (!toolsLine) {
        const tools = mapCaps('copilot', asList(data.capabilities));
        // Only routers dispatch subagents; specialists execute and don't fan out.
        if (data.role === 'router' && !tools.includes('agent/runSubagent')) tools.push('agent/runSubagent');
        // Interactive UX for every agent: structured decision prompt + to-do list.
        for (const t of ['vscode/askQuestions', 'todo']) if (!tools.includes(t)) tools.push(t);
        if (tools.length) toolsLine = `tools: [${tools.join(', ')}]`;
      }
      if (toolsLine) fm.push(toolsLine);
      const delegates = asList(data.delegates);
      if (delegates.length) fm.push(`agents: [${delegates.join(', ')}]`);
      // Only the orchestrator is a user-facing front door; hide specialists from
      // the picker but keep them delegatable as subagents. (Requires VS Code
      // setting chat.customAgentInSubagent.enabled for forge to reach them.)
      if (data.role !== 'router') fm.push('user-invocable: false');
      fm.push('---', '');
      return fm.join('\n') + body;
    },
    renderPrompt(data, body) {
      const fm = ['---'];
      if (data.agent) fm.push(`agent: ${data.agent}`);
      fm.push(...yamlBlock('description', data.description), '---', '');
      return fm.join('\n') + body;
    },
  },
  cursor: {
    label: 'Cursor',
    base: (home) => path.join(home, '.cursor'),
    agentFile: (name) => `agents/${name}.md`,
    promptFile: (name) => `commands/${name}.md`,
    rulesFile: 'rules/forge.md',
    renderAgent(data, body) {
      // Emit `model:` only for an agent that declares one (today: `forge`, which
      // pins the default model - the store's slug is a Cursor model id, so this
      // is the one renderer that may use it). Every other agent omits it and
      // inherits the parent's model (the Cursor default is "same model as the
      // parent agent"), so the swarm runs on forge's default / the user's
      // chosen chat model.
      const fm = ['---', `name: ${data.name}`, ...yamlBlock('description', data.description)];
      if (data.model) fm.push(`model: ${data.model}`);
      const delegates = asList(data.delegates);
      if (delegates.length) fm.push(`agents: [${delegates.join(', ')}]`);
      fm.push('---', '');
      return fm.join('\n') + body;
    },
    renderPrompt(data, body) {
      return ['---', ...yamlBlock('description', data.description), '---', '', ''].join('\n') + body;
    },
  },
  opencode: {
    label: 'OpenCode',
    base: (home) => path.join(home, '.config', 'opencode'),
    agentFile: (name) => `agent/${name}.md`,
    promptFile: (name) => `command/${name}.md`,
    // AGENTS.md is a user-owned global rules file: install into a managed
    // marker block inside it instead of clobbering the whole file.
    rulesFile: 'AGENTS.md',
    sharedRules: true,
    renderAgent(data, body) {
      const tools = mapCaps('opencode', asList(data.capabilities));
      // Block-scalar description, same reason as the copilot renderer: most
      // store descriptions contain ': ', which is invalid in a plain scalar.
      const fm = ['---', ...yamlBlock('description', data.description),
        `mode: ${data.role === 'router' ? 'primary' : 'subagent'}`];
      if (tools.length) {
        fm.push('tools:');
        for (const t of tools) fm.push(`  ${t}: true`);
      }
      fm.push('---', '');
      return fm.join('\n') + body;
    },
    renderPrompt(data, body) {
      const fm = ['---'];
      // OpenCode commands support agent binding; without it /ship would run in
      // whatever agent is current instead of forge.
      if (data.agent) fm.push(`agent: ${data.agent}`);
      fm.push(...yamlBlock('description', data.description), '---', '');
      return fm.join('\n') + body;
    },
  },
};

export function adapterNames() {
  return Object.keys(ADAPTERS);
}

export function rulesContent() {
  return [
    '# Forge - always-on context (code delivery)',
    '',
    '**Intent before setup.** Distinguish answer, advice, and delivery from the actual request. Questions and analysis are read-only by default, including memory and graph state; a short prompt is not evidence of a simple task. Honor the latest user constraints before tools, bootstrap, or delegation.',
    '',
    'For authorized code implementation, refactoring, bug fixes, or test-writing, use **`forge`** as the primary/top-level agent. Do not wrap delivery in a nested subagent when that prevents independent review. Forge owns its canonical implement -> review -> refine workflow and visibly reports any self-review or skipped review.',
    '',
    '**Pass the task, not the strategy.** Carry Intent, Goal, Anchor, Constraints / non-goals, Acceptance evidence, and Allowed effects. Reuse known context; ask only about consequential gaps. A handoff cannot widen permissions or pre-decide decomposition.',
    '',
    'The Forge agent defines ship mode and loads its optional super-mode recipe only for an explicit milestone build-out. Entry prompts do not duplicate the loop. No commits or pushes in ship mode unless the user\'s request lists them in Allowed effects; super mode permits only approved local milestone commits within user permissions.',
    '',
    'Before delivery, follow the agent\'s shared engineering context for quality, permissions, scoped discovery, progress-aware recovery, and resume packets. Prefer a useful existing graph or a nearby source/test; graph generation is not mandatory for a local lookup.',
    '',
    `Authorized Forge audit state belongs under \`${MEMORY_ROOT}\`, never in the working repository. No bootstrap or audit writes for read-only work; when persistence is restricted, retain evidence in the conversation. Durable learning remains opt-in.`,
    '',
    'Preserve user-selected models and specialist inheritance. Keep routine output concise, reuse unchanged context, and checkpoint at genuine task boundaries rather than clearing chats automatically. External coaching is advisory, never a gate or a tool/message quota.',
    '',
    'Use host checklists for non-trivial delivery and structured questions for necessary decisions when available. Confirm before installs, network access, or destructive actions unless already authorized. Never expose secrets. Instruction guidance is not a sandbox; use host restrictions where supported.',
    '',
  ].join('\n');
}

// Build the list of file actions for installing one tool. Pure: returns actions, does not write.
export function planInstall(tool, { home, role, resetTools = false } = {}) {
  const ad = ADAPTERS[tool];
  if (!ad) throw new Error(`Unknown tool '${tool}'. Valid: ${adapterNames().join(', ')}`);
  const profiles = loadProfiles();
  const activeRole = role || profiles.default;
  const profile = profiles.profiles[activeRole];
  if (!profile) throw new Error(`Unknown role '${activeRole}'. Valid: ${Object.keys(profiles.profiles).join(', ')}`);

  const base = ad.base(home);
  // FORGE_HOME points at the store location inside the tool base.
  // FORGE_CLI is the absolute path agents call to resolve memory + record lessons.
  // MEMORY_ROOT is the canonical out-of-repo memory store.
  const localVars = {
    FORGE_HOME: path.join(base, 'forge'),
    FORGE_CLI,
    MEMORY_ROOT: path.join(home, '.forge', 'memory'),
  };
  const actions = [];
  const enabled = new Set(profile.agents);

  // Agents - only those enabled for the active profile.
  for (const file of fs.readdirSync(path.join(STORE_DIR, 'agents'))) {
    if (!file.endsWith('.agent.md')) continue;
    const { data, body } = parseFrontmatter(fs.readFileSync(path.join(STORE_DIR, 'agents', file), 'utf8'));
    if (!enabled.has(data.name)) continue;
    data.delegates = asList(data.delegates).filter((d) => enabled.has(d));
    const target = path.join(base, ad.agentFile(data.name));
    const rendered = ad.renderAgent(data, substitute(body, localVars));
    actions.push({
      type: 'write',
      path: target,
      content: rendered,
      ...(ad.preservesTools ? {
        projection: 'copilot-tools',
        preserveProjection: !resetTools,
      } : {}),
    });
  }

  // Prompts - universal.
  for (const file of fs.readdirSync(path.join(STORE_DIR, 'prompts'))) {
    if (!file.endsWith('.prompt.md')) continue;
    const { data, body } = parseFrontmatter(fs.readFileSync(path.join(STORE_DIR, 'prompts', file), 'utf8'));
    const name = data.name || file.replace(/\.prompt\.md$/, '');
    const rendered = ad.renderPrompt(data, substitute(body, localVars));
    actions.push({ type: 'write', path: path.join(base, ad.promptFile(name)), content: rendered });
  }

  // Shared references + skills - copied under <base>/forge/ with substitution.
  for (const dir of ['_shared', 'skills']) {
    for (const rel of walkFiles(path.join(STORE_DIR, dir))) {
      const content = substitute(fs.readFileSync(path.join(STORE_DIR, rel), 'utf8'), localVars);
      actions.push({ type: 'write', path: path.join(base, 'forge', rel), content });
    }
  }

  // Always-on rules file. A shared rules file (e.g. OpenCode's user-owned
  // AGENTS.md) is written as a managed marker block; forge-owned files are
  // replaced wholesale.
  actions.push({
    type: 'write',
    mode: ad.sharedRules ? 'managed' : 'replace',
    path: path.join(base, ad.rulesFile),
    content: rulesContent(),
  });

  return { base, actions, label: ad.label };
}

// Plan the files a previous install wrote, for uninstall (fallback when no
// install manifest exists - see uninstallActions).
export function planUninstall(tool, { home, role } = {}) {
  const { actions } = planInstall(tool, { home, role });
  return actions.map((a) => ({ path: a.path, mode: a.mode || 'replace' }));
}

// ---------- install manifest ----------
// v2 records only relative ownership metadata and content projections. It never
// stores installed bytes, user content, or secrets.

export const MANIFEST_SCHEMA_VERSION = 2;
export const MANIFEST_PRODUCT = 'forge';

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function compareCodePoints(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < leftText.length && rightIndex < rightText.length) {
    const leftPoint = leftText.codePointAt(leftIndex);
    const rightPoint = rightText.codePointAt(rightIndex);
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  return leftIndex === leftText.length ? (rightIndex === rightText.length ? 0 : -1) : 1;
}

export function manifestMode(mode = 'replace') {
  return mode === 'managed' || mode === 'managed-block' ? 'managed-block' : 'replace';
}

export function actionMode(mode = 'replace') {
  return mode === 'managed-block' ? 'managed' : mode;
}

export function contentProjection(content, { mode = 'replace', projection } = {}) {
  if (manifestMode(mode) === 'managed-block') return renderManagedBlock(content);
  if (projection === 'copilot-tools') {
    return String(content).replace(/^tools:.*$/m, 'tools: [<host-managed>]');
  }
  return content;
}

export function managedBlockProjection(content) {
  const source = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  const beginMarker = Buffer.from(FORGE_BLOCK_BEGIN);
  const endMarker = Buffer.from(FORGE_BLOCK_END);
  const begin = source.indexOf(beginMarker);
  if (begin === -1 || source.indexOf(beginMarker, begin + beginMarker.length) !== -1) return null;
  const endMark = source.indexOf(endMarker, begin);
  if (endMark === -1 || source.indexOf(endMarker, endMark + endMarker.length) !== -1) return null;
  const projection = Buffer.concat([
    source.subarray(begin, endMark + endMarker.length),
    Buffer.from('\n'),
  ]);
  return Buffer.isBuffer(content) ? projection : projection.toString('utf8');
}

export function installedProjection(content, resource) {
  if (resource.mode === 'managed-block') return managedBlockProjection(content);
  return contentProjection(content, resource);
}

function portableRelative(base, target) {
  return path.relative(base, target).split(path.sep).join('/');
}

function normalizeManifestPath(relPath) {
  if (typeof relPath !== 'string' || !relPath) throw new Error('resource path must be a non-empty string');
  if (path.isAbsolute(relPath) || path.win32.isAbsolute(relPath) || path.posix.isAbsolute(relPath)) {
    throw new Error(`path must be relative: ${relPath}`);
  }
  const parts = relPath.split(/[\\/]/);
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`path contains traversal or empty segments: ${relPath}`);
  }
  return parts.join('/');
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateResources(resources, { requireHashes }) {
  if (!Array.isArray(resources)) throw new Error('resources must be an array');
  const seen = new Set();
  return resources.map((resource) => {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
      throw new Error('resource must be an object');
    }
    const resourcePath = normalizeManifestPath(resource.path);
    if (seen.has(resourcePath)) throw new Error(`duplicate resource path: ${resourcePath}`);
    seen.add(resourcePath);
    const mode = manifestMode(resource.mode);
    if (!['replace', 'managed', 'managed-block'].includes(resource.mode)) {
      throw new Error(`invalid resource mode for ${resourcePath}`);
    }
    if (resource.projection !== undefined && resource.projection !== 'copilot-tools') {
      throw new Error(`invalid resource projection for ${resourcePath}`);
    }
    if (mode === 'managed-block' && resource.projection !== undefined) {
      throw new Error(`managed block cannot declare a projection for ${resourcePath}`);
    }
    if (requireHashes && (typeof resource.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(resource.sha256))) {
      throw new Error(`invalid SHA-256 for ${resourcePath}`);
    }
    return {
      path: resourcePath,
      mode,
      ...(resource.projection ? { projection: resource.projection } : {}),
      ...(requireHashes ? { sha256: resource.sha256 } : {}),
    };
  });
}

export function manifestPath(base) {
  return path.join(base, '.forge-manifest.json');
}

export function writeManifest(tool, base, actions) {
  const now = new Date().toISOString();
  let previous = null;
  try { previous = readManifest(base, { tool }); } catch { /* install preserves its overwrite behavior */ }
  const seen = new Set();
  const resources = actions.map((item) => {
    const relativePath = portableRelative(base, item.path);
    resolveManifestPath(base, relativePath);
    if (seen.has(relativePath)) throw new Error(`Duplicate install resource path: ${relativePath}`);
    seen.add(relativePath);
    const mode = manifestMode(item.mode);
    return {
      path: relativePath,
      mode,
      ...(item.projection ? { projection: item.projection } : {}),
      sha256: sha256(contentProjection(item.content, { mode, projection: item.projection })),
    };
  }).sort((left, right) => compareCodePoints(left.path, right.path));
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    product: MANIFEST_PRODUCT,
    tool,
    generation: previous?.schemaVersion === 2 ? previous.generation + 1 : 1,
    installedAt: previous?.installedAt || now,
    updatedAt: now,
    resources,
  };
  ensureDir(base);
  fs.writeFileSync(manifestPath(base), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export function readManifest(base, { tool } = {}) {
  const file = manifestPath(base);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('manifest cannot be a symlink');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.message === 'manifest cannot be a symlink') {
      throw new Error(`Invalid Forge manifest at ${file}: ${error.message}`);
    }
    throw error;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('root must be an object');
    if (manifest.schemaVersion === MANIFEST_SCHEMA_VERSION) {
      if (manifest.product !== MANIFEST_PRODUCT) throw new Error(`product must be '${MANIFEST_PRODUCT}'`);
      if (typeof manifest.tool !== 'string' || (tool && manifest.tool !== tool)) throw new Error('tool does not match install target');
      if (!Number.isSafeInteger(manifest.generation) || manifest.generation < 1) throw new Error('generation must be a positive integer');
      if (!validTimestamp(manifest.installedAt) || !validTimestamp(manifest.updatedAt)) throw new Error('timestamps must be valid ISO dates');
      return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        product: MANIFEST_PRODUCT,
        tool: manifest.tool,
        generation: manifest.generation,
        installedAt: manifest.installedAt,
        updatedAt: manifest.updatedAt,
        resources: validateResources(manifest.resources, { requireHashes: true }),
      };
    }
    if (manifest.version === 1) {
      if (typeof manifest.tool !== 'string' || (tool && manifest.tool !== tool)) throw new Error('tool does not match install target');
      if (!validTimestamp(manifest.installedAt)) throw new Error('installedAt must be a valid ISO date');
      return {
        schemaVersion: 1,
        product: MANIFEST_PRODUCT,
        tool: manifest.tool,
        installedAt: manifest.installedAt,
        resources: validateResources(manifest.files, { requireHashes: false }),
      };
    }
    throw new Error('unsupported schema version');
  } catch (error) {
    throw new Error(`Invalid Forge manifest at ${file}: ${error.message}`);
  }
}

// Resolve a manifest-relative path and refuse entries that escape the install base
// (absolute paths, `..` segments, or other traversal via a tampered manifest).
export function resolveManifestPath(base, relPath) {
  const normalized = normalizeManifestPath(relPath);
  const root = path.resolve(base);
  const resolved = path.resolve(base, ...normalized.split('/'));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Manifest path escapes install base: ${relPath}`);
  }
  return resolved;
}

// Resolve what to remove: prefer the recorded manifest, fall back to replanning
// from the current store (legacy installs predating the manifest).
export function uninstallActions(tool, { home, role } = {}) {
  const ad = ADAPTERS[tool];
  if (!ad) throw new Error(`Unknown tool '${tool}'. Valid: ${adapterNames().join(', ')}`);
  const base = ad.base(home);
  const manifest = readManifest(base, { tool });
  if (manifest) {
    return {
      base,
      from: 'manifest',
      actions: manifest.resources.map((f) => ({
        path: resolveManifestPath(base, f.path),
        mode: actionMode(f.mode),
      })),
    };
  }
  return { base, from: 'store', actions: planUninstall(tool, { home, role }) };
}

// ---------- privacy leak-check ----------

export const LEAK_PATTERNS = [
  { name: 'absolute home path', re: /\/Users\/[A-Za-z0-9._-]+\// },
  { name: 'literal "Ford"', re: /\bFord\b/ },
  { name: 'company email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]*ford/i },
  { name: 'ford.atlassian / internal url', re: /[a-z0-9.-]*\.ford\.com|ford\.atlassian\.net/i },
  { name: 'OneDrive-azureford path', re: /OneDrive-azureford/i },
];

export function leakCheck(roots) {
  const findings = [];
  const scanFile = (full) => {
    if (!/\.(md|json|mjs|js)$/.test(full)) return;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const pat of LEAK_PATTERNS) {
        if (pat.re.test(line)) findings.push({ file: full, line: i + 1, pattern: pat.name, text: line.trim().slice(0, 120) });
      }
    });
  };
  const walk = (p) => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else scanFile(full);
    }
  };
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    if (fs.statSync(r).isDirectory()) walk(r);
    else scanFile(r);
  }
  return findings;
}

// ---------- canonical out-of-repo memory store ----------
// All Forge state lives under ~/.forge/memory, namespaced per project, so the
// target working tree stays clean and Forge never writes into the repo it edits.

// Overridable for tests / non-default layouts; defaults to the canonical store.
export const MEMORY_ROOT = process.env.FORGE_MEMORY_ROOT || path.join(os.homedir(), '.forge', 'memory');

// Derive a stable project identity from git remote (preferred), else worktree root, else abs path.
export function projectIdentity(repoDir = process.cwd()) {
  const run = (cmd) => {
    try { return execSync(cmd, { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; }
    catch { return null; }
  };
  let source = run('git remote get-url origin');
  let kind = source ? 'remote' : null;
  if (!source) { source = run('git rev-parse --show-toplevel'); kind = source ? 'worktree' : null; }
  if (!source) { source = path.resolve(repoDir); kind = 'path'; }
  const slug = source
    .replace(/^https?:\/\//, '').replace(/^git@/, '').replace(/:/g, '-').replace(/\.git$/, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 48);
  const hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 8);
  return { source, kind, ns: `${slug || 'repo'}-${hash}` };
}

export function projectMemDir(repoDir = process.cwd()) {
  return path.join(MEMORY_ROOT, 'projects', projectIdentity(repoDir).ns);
}
export function globalMemDir() { return path.join(MEMORY_ROOT, '_global'); }

export function ensureProjectMem(repoDir = process.cwd()) {
  const id = projectIdentity(repoDir);
  const dir = path.join(MEMORY_ROOT, 'projects', id.ns);
  for (const sub of ['checklists', 'runs', 'graph']) ensureDir(path.join(dir, sub));
  const projFile = path.join(dir, 'project.json');
  if (!fs.existsSync(projFile)) {
    fs.writeFileSync(projFile, JSON.stringify({ id: id.ns, source: id.source, kind: id.kind, createdAt: new Date().toISOString() }, null, 2) + '\n');
  }
  for (const [f, hdr] of [
    ['engineering-lessons.md', '# Engineering Lessons\n\n> Durable, capped, deduped. Each line: lesson, #tags, provenance, confidence. Superseded lessons are removed, not stacked.\n'],
    ['conventions.md', '# Conventions\n\n> Discovered project conventions (style, patterns, naming, error handling).\n'],
    ['toolchain.md', '# Toolchain\n\n> Detected commands: test / lint / typecheck / build, and how to run them.\n'],
  ]) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) fs.writeFileSync(p, hdr + '\n');
  }
  ensureDir(globalMemDir());
  const gl = path.join(globalMemDir(), 'engineering-lessons.md');
  if (!fs.existsSync(gl)) fs.writeFileSync(gl, '# Engineering Lessons (cross-project / personal habits)\n\n');
  return { dir, id };
}

// The documented "capped, deduped" promise for engineering-lessons.md.
export const MAX_LESSONS = 150;

// Record a durable lesson with a privacy leak gate + dedupe. Never writes into the target repo.
export function rememberLesson(text, { repoDir = process.cwd(), global = false, tags = [], confidence = 'proposed' } = {}) {
  text = String(text || '').trim();
  if (!text) return { ok: false, reason: 'empty lesson' };
  const bad = LEAK_PATTERNS.filter((p) => p.re.test(text));
  if (bad.length) return { ok: false, reason: `blocked by leak-check: matches ${bad.map((b) => b.name).join(', ')}` };

  const dir = global ? globalMemDir() : ensureProjectMem(repoDir).dir;
  ensureDir(dir);
  const file = path.join(dir, 'engineering-lessons.md');
  let body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Engineering Lessons\n\n';

  // Dedupe on normalized lesson text (exact match only — not substring containment).
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const lessonNormFromLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) return '';
    return norm(trimmed.slice(2).replace(/\s+_\(added [^)]+\)_\s*$/, ''));
  };
  const key = norm(text);
  const isDup = key && body.split('\n').some((l) => lessonNormFromLine(l) === key);
  if (isDup) return { ok: true, status: 'duplicate', file };

  const tagStr = tags.length ? ' ' + tags.map((t) => `#${String(t).replace(/^#/, '')}`).join(' ') : '';
  const line = `- ${text}${tagStr}  _(added ${today()}, confidence: ${confidence})_`;
  body = body.replace(/\s*$/, '') + '\n' + line + '\n';

  // Cap: keep only the newest MAX_LESSONS bullets (oldest are dropped first).
  const lines = body.split('\n');
  const bulletIdx = lines.map((l, i) => (l.trim().startsWith('- ') ? i : -1)).filter((i) => i >= 0);
  if (bulletIdx.length > MAX_LESSONS) {
    const drop = new Set(bulletIdx.slice(0, bulletIdx.length - MAX_LESSONS));
    body = lines.filter((_, i) => !drop.has(i)).join('\n');
  }
  fs.writeFileSync(file, body);
  return { ok: true, status: 'added', file };
}

// ---------- managed marker block (for shared, user-owned files) ----------
// All marker handling is plain string search - never build a RegExp from a
// marker, since the marker text contains regex metacharacters.

export const FORGE_BLOCK_BEGIN = '<!-- FORGE:BEGIN (managed by the forge installer - do not edit between markers) -->';
export const FORGE_BLOCK_END = '<!-- FORGE:END -->';

const FORGE_BLOCK_BEGIN_BYTES = Buffer.from(FORGE_BLOCK_BEGIN);
const FORGE_BLOCK_END_BYTES = Buffer.from(FORGE_BLOCK_END);

function markerBytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value));
}

function markerResult(original, bytes) {
  return Buffer.isBuffer(original) ? bytes : bytes.toString('utf8');
}

export function renderManagedBlock(content) {
  return `${FORGE_BLOCK_BEGIN}\n${content.replace(/\s*$/, '')}\n${FORGE_BLOCK_END}\n`;
}

// Replace the existing forge block in `existing`, or append one. A BEGIN with
// no END means a corrupted block: everything from BEGIN to EOF is reclaimed.
export function upsertManagedBlock(existing, block) {
  const source = markerBytes(existing);
  const owned = markerBytes(block);
  const begin = source.indexOf(FORGE_BLOCK_BEGIN_BYTES);
  if (begin === -1) {
    if (source.length === 0) return markerResult(existing, owned);
    const separator = source[source.length - 1] === 0x0a ? Buffer.from('\n') : Buffer.from('\n\n');
    return markerResult(existing, Buffer.concat([source, separator, owned]));
  }
  const endMark = source.indexOf(FORGE_BLOCK_END_BYTES, begin);
  const end = endMark === -1 ? source.length : endMark + FORGE_BLOCK_END_BYTES.length;
  const after = source.subarray(source[end] === 0x0a ? end + 1 : end);
  return markerResult(existing, Buffer.concat([source.subarray(0, begin), owned, after]));
}

// Strip the forge block; returns null when no block is present.
export function removeManagedBlock(existing) {
  const source = markerBytes(existing);
  const begin = source.indexOf(FORGE_BLOCK_BEGIN_BYTES);
  if (begin === -1) return null;
  const endMark = source.indexOf(FORGE_BLOCK_END_BYTES, begin);
  let end = endMark === -1 ? source.length : endMark + FORGE_BLOCK_END_BYTES.length;
  if (source[end] === 0x0a) end += 1;
  return markerResult(existing, Buffer.concat([source.subarray(0, begin), source.subarray(end)]));
}

// ---------- fs helpers ----------

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

export function writeFileSafe(target, content, { apply, mode = 'replace' } = {}) {
  const exists = fs.existsSync(target);
  const prev = exists ? fs.readFileSync(target) : null;
  const bak = target + '.forge-bak';
  let desired = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (mode === 'managed') {
    const block = Buffer.from(renderManagedBlock(content));
    if (!exists) desired = block;
    // A markerless file alongside a .forge-bak is a legacy whole-file install:
    // the file is forge-owned, so replace it rather than appending a second copy.
    else if (!prev.includes(FORGE_BLOCK_BEGIN_BYTES) && fs.existsSync(bak)) desired = block;
    else desired = upsertManagedBlock(prev, block);
  }
  if (exists && prev.equals(desired)) return 'unchanged';
  if (!apply) return exists ? 'would-update' : 'would-write';
  ensureDir(path.dirname(target));
  if (exists && !fs.existsSync(bak)) fs.copyFileSync(target, bak);
  fs.writeFileSync(target, desired);
  return 'written';
}

// Undo one installed file. Restores the .forge-bak the installer took where one
// exists, instead of leaving the user's original orphaned in a backup.
export function removeInstalledFile(target, mode = 'replace') {
  const bak = target + '.forge-bak';
  if (!fs.existsSync(target)) return 'absent';
  if (mode === 'managed') {
    const stripped = removeManagedBlock(fs.readFileSync(target));
    if (stripped === null) {
      // No markers: a legacy whole-file install if we hold a backup, else not ours.
      if (fs.existsSync(bak)) { fs.copyFileSync(bak, target); fs.rmSync(bak); return 'restored-backup'; }
      return 'kept';
    }
    if (stripped.length === 0) {
      if (fs.existsSync(bak)) { fs.copyFileSync(bak, target); fs.rmSync(bak); return 'restored-backup'; }
      fs.rmSync(target);
      return 'removed';
    }
    fs.writeFileSync(target, stripped);
    if (fs.existsSync(bak)) fs.rmSync(bak);
    return 'block-removed';
  }
  if (fs.existsSync(bak)) { fs.copyFileSync(bak, target); fs.rmSync(bak); return 'restored-backup'; }
  fs.rmSync(target);
  return 'removed';
}

// Remove now-empty directories left behind by an uninstall, from the removed
// file's parent up to (but never including) stopDir.
export function pruneEmptyParents(target, stopDir) {
  let dir = path.dirname(target);
  while (true) {
    const rel = path.relative(stopDir, dir);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) break;
    try { fs.rmdirSync(dir); } catch { break; } // not empty, or already gone
    dir = path.dirname(dir);
  }
}

export const HOME = os.homedir();
