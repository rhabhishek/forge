// Forge credential storage — dependency-free, per-OS secure storage.
//   macOS  : secrets in the login Keychain; profile reads them back at startup.
//   Windows: secrets DPAPI-encrypted (per-user) under ~/.forge/secrets/*.dpapi;
//            the PowerShell $PROFILE decrypts them into env vars at startup.
//   Linux  : secrets in ~/.forge/*.env (chmod 600), sourced from the shell rc.
// Either way the same env vars (JIRA_URL, CONFLUENCE_URL, ATLASSIAN_EMAIL,
// ATLASSIAN_SITE_NAME, ATLASSIAN_API_TOKEN, GITHUB_TOKEN/GH_TOKEN, optional
// HTTPS_PROXY) land in the shell that launches the editor, where the REST/CLI
// skills and the MCP servers (${env:VAR}) pick them up.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureDir } from './core.mjs';

export const IS_MAC = process.platform === 'darwin';
export const IS_WIN = process.platform === 'win32';
const KEYCHAIN_SERVICE = 'forge';
const BEGIN = '# >>> forge (managed) >>>';
const END = '# <<< forge (managed) <<<';

// Escape regex metacharacters so markers (which contain (), >, etc.) match literally.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Single-quote a value for a POSIX sh line: wrap in '...' and escape embedded quotes.
const shq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;

// ---------- shell / profile detection ----------

// Resolve the rc file actually sourced by the user's shell.
export function shellProfilePath() {
  if (IS_WIN) return winProfilePath();
  const home = os.homedir();
  const sh = process.env.SHELL || '';
  if (sh.includes('zsh')) return path.join(home, '.zshrc');
  if (sh.includes('bash')) return path.join(home, '.bashrc');
  // Sensible default per platform when $SHELL is unset.
  return path.join(home, IS_MAC ? '.zshrc' : '.bashrc');
}

function winProfilePath() {
  for (const exe of ['pwsh', 'powershell']) {
    const r = spawnSync(exe, ['-NoProfile', '-Command', '$PROFILE.CurrentUserCurrentHost'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim();
  }
  return path.join(os.homedir(), 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
}

export function writeManagedBlock(profilePath, body) {
  ensureDir(path.dirname(profilePath));
  const block = `${BEGIN}\n${body}\n${END}\n`;
  let content = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : '';
  const re = new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n?`);
  if (re.test(content)) content = content.replace(re, block);
  else content = content.replace(/\s*$/, '') + `\n\n${block}`;
  fs.writeFileSync(profilePath, content);
}

// ---------- macOS Keychain ----------

// NOTE: the secret is passed via argv (-w value), so it is briefly visible in
// `ps` to other processes of the same user. The DPAPI path avoids this by
// passing the secret through the environment instead.
function keychainSet(account, value) {
  const r = spawnSync('security',
    ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', value],
    { stdio: 'ignore' });
  return r.status === 0;
}

// ---------- Windows DPAPI ----------

// Encrypt with DPAPI (CurrentUser). Secret is passed via env, never via argv.
function dpapiEncrypt(plain) {
  const r = spawnSync('powershell',
    ['-NoProfile', '-Command', 'ConvertTo-SecureString -String $env:FORGE_SECRET -AsPlainText -Force | ConvertFrom-SecureString'],
    { env: { ...process.env, FORGE_SECRET: plain }, encoding: 'utf8' });
  return r.status === 0 && r.stdout ? r.stdout.trim() : null;
}

// PowerShell snippet that decrypts a DPAPI file back into $env:<NAME>.
function psDecryptLine(name, file) {
  const p = file.replace(/'/g, "''");
  return [
    `if (Test-Path '${p}') {`,
    `  $sec = ConvertTo-SecureString (Get-Content '${p}' -Raw)`,
    `  $env:${name} = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))`,
    `}`,
  ].join('\n');
}

// ---------- main API ----------

// creds: { email, apiToken, jiraUrl, confluenceUrl, siteName, githubToken, proxy }
// — any may be absent. Returns { mode, stored[], files[], profile }.
export function persistCredentials(creds, { apply = true } = {}) {
  const forgeDir = path.join(os.homedir(), '.forge');
  ensureDir(forgeDir);
  const profilePath = shellProfilePath();

  // Non-secret env (shared across all backends).
  const plain = [];
  if (creds.email) plain.push(['ATLASSIAN_EMAIL', creds.email]);
  if (creds.siteName) plain.push(['ATLASSIAN_SITE_NAME', creds.siteName]);
  if (creds.jiraUrl) plain.push(['JIRA_URL', creds.jiraUrl]);
  if (creds.confluenceUrl) plain.push(['CONFLUENCE_URL', creds.confluenceUrl]);
  if (creds.proxy) plain.push(['HTTPS_PROXY', creds.proxy]);

  // Secrets (token vars). GH_TOKEN mirrors GITHUB_TOKEN for the gh CLI.
  const secrets = [];
  if (creds.apiToken) secrets.push(['ATLASSIAN_API_TOKEN', creds.apiToken]);
  if (creds.githubToken) secrets.push(['GITHUB_TOKEN', creds.githubToken]);

  if (IS_MAC) {
    const summary = { mode: 'keychain', stored: [], files: [], profile: null };
    const lines = plain.map(([k, v]) => `export ${k}=${shq(v)}`);
    for (const [name, value] of secrets) {
      if (apply) {
        if (keychainSet(name, value)) summary.stored.push(name);
        else console.error(`⚠ keychain write failed for ${name} — not stored`);
      }
      lines.push(`export ${name}="$(security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${name}" -w 2>/dev/null)"`);
    }
    if (secrets.some(([n]) => n === 'GITHUB_TOKEN')) lines.push('export GH_TOKEN="$GITHUB_TOKEN"');
    if (apply && profilePath && lines.length) { writeManagedBlock(profilePath, lines.join('\n')); summary.profile = profilePath; }
    return summary;
  }

  if (IS_WIN) {
    const summary = { mode: 'dpapi', stored: [], files: [], profile: null };
    const secretsDir = path.join(forgeDir, 'secrets');
    if (apply) ensureDir(secretsDir);
    const ps = plain.map(([k, v]) => `$env:${k} = '${String(v).replace(/'/g, "''")}'`);
    for (const [name, value] of secrets) {
      const file = path.join(secretsDir, `${name}.dpapi`);
      if (apply) {
        const enc = dpapiEncrypt(value);
        if (enc) { fs.writeFileSync(file, enc); summary.stored.push(name); }
      }
      ps.push(psDecryptLine(name, file));
    }
    if (secrets.some(([n]) => n === 'GITHUB_TOKEN')) ps.push('$env:GH_TOKEN = $env:GITHUB_TOKEN');
    if (apply && profilePath && ps.length) { writeManagedBlock(profilePath, ps.join('\n')); summary.profile = profilePath; }
    return summary;
  }

  // Linux / other: plaintext env files (chmod 600), sourced from the profile.
  const summary = { mode: 'env-file', stored: [], files: [], profile: null };
  const sources = [];
  const atlPlain = plain.filter(([k]) => k !== 'HTTPS_PROXY' || creds.proxy);
  if (creds.email || creds.apiToken || creds.siteName || creds.jiraUrl || creds.confluenceUrl) {
    const atl = ['# Forge Atlassian credentials — DO NOT COMMIT.'];
    for (const [k, v] of atlPlain) if (k !== 'GITHUB_TOKEN') atl.push(`export ${k}=${shq(v)}`);
    if (creds.apiToken) atl.push(`export ATLASSIAN_API_TOKEN=${shq(creds.apiToken)}`);
    const atlFile = path.join(forgeDir, 'atlassian.env');
    if (apply) { fs.writeFileSync(atlFile, atl.join('\n') + '\n'); fs.chmodSync(atlFile, 0o600); summary.files.push(atlFile); }
    sources.push(`[ -f "${atlFile}" ] && source "${atlFile}"`);
  }
  if (creds.githubToken) {
    const ghFile = path.join(forgeDir, 'github.env');
    if (apply) {
      fs.writeFileSync(ghFile, `# Forge GitHub credentials — DO NOT COMMIT.\nexport GITHUB_TOKEN=${shq(creds.githubToken)}\nexport GH_TOKEN=${shq(creds.githubToken)}\n`);
      fs.chmodSync(ghFile, 0o600); summary.files.push(ghFile);
    }
    sources.push(`[ -f "${ghFile}" ] && source "${ghFile}"`);
  }
  if (apply && profilePath && sources.length) { writeManagedBlock(profilePath, sources.join('\n')); summary.profile = profilePath; }
  return summary;
}
