#!/usr/bin/env node
// Forge CLI - install / update / uninstall / doctor / leak-check.
// Dependency-free. Usage: forge <command> [tool] [--apply]

import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT, STORE_DIR, HOME, MEMORY_ROOT, GH_SERVER_KEY,
  adapterNames, planInstall, uninstallActions, leakCheck,
  writeFileSafe, writeManifest, manifestPath, removeInstalledFile, pruneEmptyParents,
  loadProfiles, unresolved,
  projectIdentity, projectMemDir, ensureProjectMem, globalMemDir, rememberLesson,
} from '../lib/core.mjs';
import { applyUpdatePlans, planUpdate } from '../lib/update.mjs';
import { mergeMcp, mcpTargets, loadMcpCatalog } from '../lib/mcp.mjs';
import { persistCredentials, IS_MAC, IS_WIN } from '../lib/secrets.mjs';
import { confirm, text, isTTY } from '../lib/prompt.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const apply = args.includes('--apply');
const resetTools = args.includes('--reset-tools');
const positional = args.filter((a) => !a.startsWith('--'));
const tool = positional[1];

function tools() {
  return tool && tool !== 'all' ? [tool] : adapterNames();
}

function usage() {
  console.log(`Forge - a staff-engineer code-delivery swarm.

Usage:
  forge install [tool|all] [--apply] [--reset-tools]
                                        Install agents/prompts/skills into a tool (dry-run without --apply).
                                        --reset-tools rewrites Copilot tool lists to defaults (otherwise a
                                        host-managed tools: line is preserved across reinstalls).
                                        After writing files, --apply offers an interactive wizard (in a TTY)
                                        to store credentials and provision MCP servers (GitHub, Jira,
                                        Confluence, Figma) - never overwriting servers you or Cortex already
                                        configured. Non-interactive sessions skip the wizard automatically.
  forge update [tool|all] [--apply]
                                        Reconcile managed resources with the current store (dry-run by default).
                                        Every managed file is backed up before it is written; user edits are
                                        preserved (block/line files gain a delimited local-changes section,
                                        structured files get .local + .diff sidecars beside a clean live file).
                                        Cooperative single-user tool: don't run two updaters at once. Concurrent
                                        external edits during a run are best-effort captured via backups + the log.
  forge uninstall [tool|all] [--apply]  Remove Forge files from a tool
  forge doctor                          Check the store is well-formed and what's installed
  forge leak-check                      Scan the store for company/PII data before sharing

Memory (canonical store at ~/.forge/memory, never written into your repo):
  forge mem path                        Print the memory dir for the current project
  forge mem init                        Create the memory skeleton for the current project
  forge mem show [--global]             Print stored engineering lessons
  forge remember "<lesson>" [--global] [--tag t]
                                        Record a durable lesson (leak-checked + deduped)

Tools: ${adapterNames().join(', ')}, or 'all'. Omitting [tool|all] consistently selects all tools.`);
}

function doMem() {
  const sub = positional[1];
  if (sub === 'path') {
    const id = projectIdentity(process.cwd());
    console.log(`project: ${id.source} (${id.kind})`);
    console.log(`namespace: ${id.ns}`);
    console.log(`memory dir: ${projectMemDir(process.cwd())}`);
    console.log(`global dir: ${globalMemDir()}`);
    return;
  }
  if (sub === 'init') {
    const { dir, id } = ensureProjectMem(process.cwd());
    console.log(`Initialized memory for ${id.source}\n  ${dir}`);
    return;
  }
  if (sub === 'show') {
    const global = args.includes('--global');
    const file = path.join(global ? globalMemDir() : projectMemDir(process.cwd()), 'engineering-lessons.md');
    console.log(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `(no lessons yet at ${file})`);
    return;
  }
  console.log(`Unknown 'mem' subcommand. Try: path | init | show`);
  process.exitCode = 1;
}

function doRemember() {
  const tagIdx = args.indexOf('--tag');
  const tags = tagIdx >= 0 && args[tagIdx + 1] ? [args[tagIdx + 1]] : [];
  const global = args.includes('--global');
  // text = everything after 'remember' except the known flags (--global, --tag
  // and its value). Unknown '--' tokens stay - a lesson may mention a flag.
  const text = args.slice(1).filter((a, i) => {
    const realIdx = i + 1;
    if (a === '--global' || a === '--tag') return false;
    if (tagIdx >= 0 && realIdx === tagIdx + 1) return false;
    return true;
  }).join(' ').trim();
  if (!text) { console.log('Usage: forge remember "<lesson>" [--global] [--tag t]'); process.exitCode = 1; return; }
  const res = rememberLesson(text, { repoDir: process.cwd(), global, tags });
  if (!res.ok) { console.log(`Not recorded - ${res.reason}`); process.exitCode = 1; return; }
  console.log(`${res.status === 'duplicate' ? 'Already known' : 'Recorded'} -> ${res.file}`);
}

async function doInstall() {
  for (const t of tools()) {
    const { base, actions, label } = planInstall(t, { home: HOME, resetTools });
    console.log(`\n${label} -> ${base}`);
    if (fs.existsSync(manifestPath(base))) {
      const plan = planUpdate(t, { home: HOME, resetTools });
      for (const entry of plan.entries) {
        console.log(`  [${entry.status}] ${path.relative(HOME, entry.target)}${entry.reason ? ` (${entry.reason})` : ''}`);
      }
      if (apply) {
        applyUpdatePlans([plan]);
        console.log(`  [manifest] ${path.relative(HOME, manifestPath(base))}`);
      }
      continue;
    }
    for (const a of actions) {
      const status = writeFileSafe(a.path, a.content, { apply, mode: a.mode });
      console.log(`  [${status}] ${path.relative(HOME, a.path)}`);
    }
    if (apply) {
      writeManifest(t, base, actions);
      console.log(`  [manifest] ${path.relative(HOME, manifestPath(base))}`);
    }
  }
  if (!apply) { console.log('\nDry run. Re-run with --apply to write files.'); return; }
  await maybeRunWizard();
}

// After file install, offer the guided wizard once (credentials + MCP servers).
// Non-interactive sessions (CI, piped input) skip it automatically - there's
// no one to answer the prompts, and we never want to silently apply defaults.
async function maybeRunWizard() {
  if (!isTTY()) {
    console.log("\nNon-interactive session - skipping the setup wizard (MCP servers + credentials).");
    console.log('Re-run `node bin/forge.mjs install --apply` in an interactive terminal to open it, or see docs/GETTING-STARTED.md to wire things up by hand.');
    return;
  }
  const run = await confirm('\nRun the setup wizard now? (store credentials + provision MCP servers)', true);
  if (!run) {
    console.log('Skipped. Re-run `node bin/forge.mjs install --apply` anytime to open the wizard.');
    return;
  }
  await runWizard();
}

function doUpdate() {
  const plans = tools().map((selectedTool) => planUpdate(selectedTool, { home: HOME }));
  for (const plan of plans) {
    console.log(`\n${plan.label} -> ${plan.base}`);
    for (const entry of plan.entries) {
      console.log(`  [${entry.status}] ${path.relative(HOME, entry.target)}${entry.reason ? ` (${entry.reason})` : ''}`);
    }
  }
  if (!apply) {
    console.log('\nDry run. Re-run with --apply to reconcile managed resources.');
    return;
  }
  const result = applyUpdatePlans(plans);
  console.log(`\nUpdate applied: ${result.changed} resource change(s), ${result.reconciled} reconciled, ${result.manifests} manifest(s).`);
}

function doUninstall() {
  for (const t of tools()) {
    const { base, actions, from } = uninstallActions(t, { home: HOME });
    console.log(`\n${t} (${from === 'manifest' ? 'from install manifest' : 'no manifest - replanned from current store'}):`);
    for (const a of actions) {
      if (!apply) {
        let status = 'absent';
        if (fs.existsSync(a.path)) {
          status = fs.existsSync(a.path + '.forge-bak') ? 'would-restore-backup'
            : a.mode === 'managed' ? 'would-remove-block' : 'would-remove';
        }
        console.log(`  [${status}] ${path.relative(HOME, a.path)}`);
        continue;
      }
      let status;
      try { status = removeInstalledFile(a.path, a.mode); }
      catch (e) { status = `error: ${e.message}`; process.exitCode = 1; }
      console.log(`  [${status}] ${path.relative(HOME, a.path)}`);
      if (status === 'removed') pruneEmptyParents(a.path, base);
    }
    if (apply) fs.rmSync(manifestPath(base), { force: true });
  }
  if (!apply) console.log('\nDry run. Re-run with --apply to remove files.');
}

function doDoctor() {
  let ok = true;
  const agentsDir = path.join(STORE_DIR, 'agents');
  const profiles = loadProfiles();
  const declared = new Set(profiles.profiles[profiles.default].agents);
  const onDisk = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.agent.md')).map((f) => f.replace(/\.agent\.md$/, ''));

  console.log('Store:', STORE_DIR);
  console.log(`Profile '${profiles.default}' agents: ${[...declared].join(', ')}`);

  for (const a of declared) {
    if (!onDisk.includes(a)) { console.log(`  MISSING agent file: ${a}.agent.md`); ok = false; }
  }
  for (const a of onDisk) {
    if (!declared.has(a)) console.log(`  note: ${a}.agent.md on disk but not in profile`);
  }

  for (const dir of ['prompts', 'skills', '_shared']) {
    const p = path.join(STORE_DIR, dir);
    console.log(`  ${dir}/: ${fs.existsSync(p) ? 'present' : 'MISSING'}`);
    if (!fs.existsSync(p)) ok = false;
  }

  // Rendered output must contain no unresolved {{PLACEHOLDERS}}.
  for (const t of adapterNames()) {
    for (const a of planInstall(t, { home: HOME }).actions) {
      const un = unresolved(a.content);
      if (un.length) { console.log(`  UNRESOLVED placeholders (${t}) in ${path.relative(HOME, a.path)}: ${un.join(', ')}`); ok = false; }
    }
  }

  console.log('\nInstalled tool bases:');
  for (const t of adapterNames()) {
    const { base } = planInstall(t, { home: HOME });
    console.log(`  ${t}: ${fs.existsSync(base) ? base + ' (exists)' : base + ' (not present)'}`);
  }

  console.log(`\nMemory store: ${MEMORY_ROOT} ${fs.existsSync(MEMORY_ROOT) ? '(exists)' : '(not yet created)'}`);

  // MCP servers Forge provisioned (its own entries, tagged _source: forge).
  console.log('\nMCP servers (forge-owned):');
  for (const t of mcpTargets(HOME)) {
    if (!fs.existsSync(t.path)) { console.log(`  · ${t.label.padEnd(12)} no config at ${path.relative(HOME, t.path)}`); continue; }
    let mine = [], others = [];
    try {
      const doc = JSON.parse(fs.readFileSync(t.path, 'utf8'));
      for (const [k, c] of Object.entries(doc.servers || {})) (c && c._source === 'forge' ? mine : others).push(k);
    } catch { console.log(`  ⚠ ${t.label.padEnd(12)} ${path.relative(HOME, t.path)} is not valid JSON`); continue; }
    const note = others.length ? `  (${others.length} not forge-owned, left untouched)` : '';
    console.log(`  ${mine.length ? '✓' : '·'} ${t.label.padEnd(12)} ${mine.length ? mine.join(', ') : 'none'}${note}`);
  }

  for (const w of doctorWarnings()) console.log(`\nwarning: ${w}`);

  console.log(ok ? '\nDoctor: OK' : '\nDoctor: problems found');
  if (!ok) process.exitCode = 1;
}

// Host-environment warnings: real limitations the installer cannot fix, only
// surface. These never fail doctor.
function doctorWarnings() {
  const warns = [];

  // The copilot render grants the GitHub MCP toolset; without the server
  // configured those tools are dead. Probe the locations hosts actually use:
  // VS Code User mcp.json (servers key) and Copilot CLI mcp-config.json.
  if (fs.existsSync(path.join(HOME, '.copilot'))) {
    const mcpPaths = [
      path.join(HOME, '.copilot', 'mcp-config.json'),
      path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      path.join(HOME, '.config', 'Code', 'User', 'mcp.json'),
      path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json'),
    ];
    let hasGh = false;
    for (const p of mcpPaths) {
      if (!fs.existsSync(p)) continue;
      try {
        const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
        const servers = doc.servers || doc.mcpServers || {};
        if (servers[GH_SERVER_KEY] || Object.keys(servers).some((k) => k.includes('github'))) {
          hasGh = true;
          break;
        }
      } catch { /* unparsable — try next */ }
    }
    if (!hasGh) {
      warns.push(`copilot: GitHub MCP server '${GH_SERVER_KEY}' not found in VS Code User mcp.json or ~/.copilot/mcp-config.json — the forge agent's GitHub tools will be unavailable.`);
    }
  }

  // Specialists are hidden from the picker (user-invocable: false), so on
  // VS Code forge can only reach them when custom agents are allowed as
  // subagents - an experimental setting that defaults off.
  const vscodeSettings = [
    path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'settings.json'), // macOS
    path.join(HOME, '.config', 'Code', 'User', 'settings.json'), // Linux
    path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Code', 'User', 'settings.json'), // Windows
  ].filter((p) => fs.existsSync(p));
  for (const p of vscodeSettings) {
    const text = fs.readFileSync(p, 'utf8'); // JSONC - just look for the enabled flag
    if (!/"chat\.customAgentInSubagent\.enabled"\s*:\s*true/.test(text)) {
      warns.push(`VS Code: 'chat.customAgentInSubagent.enabled' is not enabled in ${p} - forge cannot spawn its specialists there and every run will degrade to a self-reviewed single pass.`);
    }
  }
  return warns;
}

function doLeakCheck() {
  // Scan shippable content (store + docs + README). The tooling (lib/bin) legitimately
  // contains the leak patterns themselves as detection rules, so it is excluded.
  const findings = leakCheck([STORE_DIR, path.join(REPO_ROOT, 'docs'), path.join(REPO_ROOT, 'README.md')]);
  if (!findings.length) { console.log('leak-check: clean'); return; }
  console.log(`leak-check: ${findings.length} finding(s):`);
  for (const f of findings) console.log(`  ${path.relative(REPO_ROOT, f.file)}:${f.line} [${f.pattern}] ${f.text}`);
  process.exitCode = 1;
}

const normUrl = (u) => (u || '').trim().replace(/\/+$/, '');

// Interactive wizard: store credentials securely (per-OS) and provision the MCP
// servers Forge owns. Forge never overwrites a server you or Cortex already set
// up — those are skipped, not duplicated. Run from `install --apply` (see
// maybeRunWizard above); not a standalone CLI command.
async function runWizard() {
  const home = HOME;
  const catalog = loadMcpCatalog();
  console.log('\nForge wizard — store credentials + provision MCP servers.\n');
  console.log(`Secrets are stored ${IS_MAC ? 'in your macOS Keychain' : IS_WIN ? 'DPAPI-encrypted (per-user)' : 'in ~/.forge/*.env (chmod 600)'} and loaded by your shell.`);
  console.log('Tokens are referenced from MCP config as ${env:VAR} — never written inline.\n');

  let email, apiToken, siteName, jiraUrl, confluenceUrl, githubToken;

  const wantJira = await confirm('Wire up Jira (Atlassian Rovo MCP, OAuth)?', true);
  const wantConfluence = await confirm('Wire up Confluence (community MCP, API token)?', true);
  if (wantJira || wantConfluence) {
    console.log('  Atlassian API token: https://id.atlassian.com/manage-profile/security/api-tokens');
    email = await text('  Atlassian account email', '');
    apiToken = await text('  Atlassian API token', '', { hidden: true });
    siteName = await text('  Atlassian site name (the <name> in <name>.atlassian.net)', '');
    if (wantJira) jiraUrl = normUrl(await text('  Jira base URL', siteName ? `https://${siteName}.atlassian.net` : 'https://your-org.atlassian.net'));
    if (wantConfluence) confluenceUrl = normUrl(await text('  Confluence base URL', siteName ? `https://${siteName}.atlassian.net/wiki` : ''));
  }

  const wantGithub = await confirm('Wire up GitHub (official MCP, PAT)?', true);
  if (wantGithub) {
    console.log('  GitHub PAT: https://github.com/settings/personal-access-tokens/new');
    githubToken = await text('  GitHub token', '', { hidden: true });
    if (!githubToken) console.log('  ⚠ No token entered — GitHub MCP needs it; skipping the GitHub server.');
  }

  const wantFigma = await confirm('Wire up Figma (remote MCP, OAuth)?', true);

  // 1. Persist credentials (secure per-OS store + a managed shell-profile block).
  console.log('\n── Credentials ───────────────────────────────────────────────');
  const cred = persistCredentials({ email, apiToken, siteName, jiraUrl, confluenceUrl, githubToken }, { apply: true });
  if (cred.stored.length) console.log(`   Secured (${cred.mode}): ${cred.stored.join(', ')}`);
  for (const f of cred.files) console.log(`   Wrote ${path.relative(home, f)} (chmod 600)`);
  if (cred.profile) console.log(`   Wired into ${path.relative(home, cred.profile)}`);
  if (!cred.stored.length && !cred.files.length && !cred.profile) console.log('   (no credentials entered)');

  // 2. Provision the selected MCP servers. mergeMcp is polite: it adds only the
  //    servers Forge owns and that aren't already there, skips anything you or
  //    Cortex configured, and removes only Forge's own stale entries.
  console.log('\n── MCP servers ───────────────────────────────────────────────');
  const serverIds = [];
  if (wantJira) serverIds.push('atlassian');
  if (wantConfluence) serverIds.push('confluence');
  if (wantGithub && githubToken) serverIds.push('io.github.github/github-mcp-server');
  if (wantFigma) serverIds.push('figma');
  const unknown = serverIds.filter((id) => !catalog[id]);
  if (unknown.length) console.log(`   ⚠ not in catalog (ignored): ${unknown.join(', ')}`);

  for (const t of mcpTargets(home)) {
    const r = mergeMcp(t.path, serverIds, { apply: true });
    if (r.error) { console.log(`   ⚠ ${t.label}: ${r.error}`); continue; }
    const changes = [
      ...r.added.map((s) => '+ ' + s),
      ...r.skipped.map((s) => '= ' + s + ' (already configured — skipped)'),
      ...r.removed.map((s) => '- ' + s),
    ];
    console.log(`   ${t.label.padEnd(12)} ${changes.length ? changes.join(', ') : '(no changes)'}  → ${path.relative(home, t.path)}`);
  }
  if (wantJira) console.log('   Jira MCP: sign in via OAuth in your editor on first use.');
  if (wantFigma) console.log('   Figma MCP: sign in via OAuth in your editor on first use.');
  if (!serverIds.length) console.log('   No servers selected — removed any previously forge-provisioned servers.');

  console.log('\n✅ Forge wizard complete.');
  if (cred.profile) console.log(`   • Load credentials now: ${IS_WIN ? `. ${path.relative(home, cred.profile)}` : `source ${cred.profile.replace(home, '~')}`}  (or open a new terminal)`);
  console.log('   • Restart VS Code so Copilot picks up the new MCP servers.');
  console.log('   • Verify anytime: node bin/forge.mjs doctor\n');
}

async function main() {
  switch (cmd) {
    case 'install': await doInstall(); break;
    case 'update': doUpdate(); break;
    case 'uninstall': doUninstall(); break;
    case 'doctor': doDoctor(); break;
    case 'leak-check': doLeakCheck(); break;
    case 'mem': doMem(); break;
    case 'remember': doRemember(); break;
    default: usage();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
