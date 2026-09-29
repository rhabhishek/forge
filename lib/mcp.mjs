// Forge MCP provisioning — merge the server catalog into each tool's MCP config.
// Dependency-free. Tokens are referenced as ${env:VAR}, never stored inline.
// Forge is a *polite* provisioner: it only ever writes/updates/removes entries
// it owns (tagged `_source: "forge"`). Any server already present that Forge
// doesn't own — one you added yourself, OR one Cortex provisioned
// (`_source: "cortex"`) — is left untouched and reported as `skipped`, so the
// same server is never overwritten or duplicated.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STORE_DIR, ensureDir } from './core.mjs';

export const OWNER = 'forge';
export const MCP_CATALOG_PATH = path.join(STORE_DIR, 'mcp', 'servers.json');

export function loadMcpCatalog() {
  if (!fs.existsSync(MCP_CATALOG_PATH)) return {};
  return JSON.parse(fs.readFileSync(MCP_CATALOG_PATH, 'utf8')).servers || {};
}

// VS Code reads user-level MCP servers from the User profile's mcp.json — NOT
// ~/.vscode/mcp.json (that's workspace-level). Resolve the per-OS User profile dir.
function vscodeUserMcp(home) {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json');
  return path.join(home, '.config', 'Code', 'User', 'mcp.json');
}

// The MCP config files Forge provisions, per tool. `home` is overridable for tests.
export function mcpTargets(home = os.homedir()) {
  return [
    { label: 'VS Code', path: vscodeUserMcp(home) },
    { label: 'Copilot CLI', path: path.join(home, '.copilot', 'mcp-config.json') },
  ];
}

// Keep `_source` (used to track ownership); drop the display-only `_*` metadata.
function stripMeta(cfg) {
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k.startsWith('_') && k !== '_source') continue;
    out[k] = v;
  }
  return out;
}

function readJson(p) {
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Merge the selected catalog servers into one MCP config file.
// - Adds selected servers Forge owns and that aren't already present.
// - Removes Forge-owned servers that are no longer selected.
// - Skips (leaves untouched) any already-present server Forge doesn't own —
//   whether you added it or Cortex did — so nothing is overwritten or duplicated.
// Other top-level keys (e.g. `inputs`) are preserved.
// Returns { added, skipped, removed } or { error }.
export function mergeMcp(targetPath, serverIds, { apply = false } = {}) {
  const catalog = loadMcpCatalog();
  const doc = readJson(targetPath);
  if (doc === null) return { error: `${targetPath} exists but isn't valid JSON — left untouched` };
  if (!doc.servers || typeof doc.servers !== 'object') doc.servers = {};

  const selected = new Set(serverIds.filter((id) => catalog[id]));
  const res = { added: [], skipped: [], removed: [] };

  // Clean up only Forge's own stale entries; never remove user- or Cortex-owned ones.
  for (const [name, cfg] of Object.entries(doc.servers)) {
    if (cfg && cfg._source === OWNER && !selected.has(name)) {
      delete doc.servers[name];
      res.removed.push(name);
    }
  }
  for (const id of selected) {
    const existing = doc.servers[id];
    // Present but not Forge-owned (yours or Cortex's) → skip, don't duplicate.
    if (existing && existing._source !== OWNER) { res.skipped.push(id); continue; }
    doc.servers[id] = { ...stripMeta(catalog[id]), _source: OWNER };
    res.added.push(id);
  }

  if (apply && (res.added.length || res.removed.length)) {
    ensureDir(path.dirname(targetPath));
    fs.writeFileSync(targetPath, JSON.stringify(doc, null, 2) + '\n');
  }
  return res;
}
