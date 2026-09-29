// Forge updater - cooperative single-user reconcile with a backup-first safety net.
//
// Threat model: this is a cooperative, single-user tool. It is NOT an adversarial
// atomic-race system. Do not run two Forge updaters at once. Correctness and
// completeness come from three things, not from OS-level race hardening:
//   1. a full backup of every managed file taken BEFORE it is written,
//   2. an append-only JSONL action log recording every touched resource, and
//   3. the install manifest being written LAST, with a rollback-from-backup on
//      any write failure that leaves the prior manifest in place.
// Writes use straightforward atomic temp-file + rename. resolveManifestPath is
// kept purely as path hygiene (reject absolute / '..' / escaping / duplicate).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  MANIFEST_PRODUCT,
  MANIFEST_SCHEMA_VERSION,
  compareCodePoints,
  contentProjection,
  installedProjection,
  manifestMode,
  manifestPath,
  planInstall,
  readManifest,
  removeManagedBlock,
  renderManagedBlock,
  resolveManifestPath,
  sha256,
  upsertManagedBlock,
} from './core.mjs';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const BACKUP_DIR = '.forge-backups';
const UPDATE_LOG = '.forge-update-log.jsonl';

// Delimited section the updater appends to block/line files to preserve a user's
// non-installer additions without duplicating installer content.
const LOCAL_BEGIN = '<!-- FORGE:LOCAL-CHANGES (preserved by the updater; review and reconcile) -->';
const LOCAL_END = '<!-- FORGE:END-LOCAL-CHANGES -->';

function relativeResourcePath(base, target) {
  const relativePath = path.relative(base, target).split(path.sep).join('/');
  resolveManifestPath(base, relativePath); // path hygiene: reject absolute/'..'/escape
  return relativePath;
}

function sameBytes(left, right) {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

// Plain, cooperative snapshot: current bytes + permission bits, or nulls when absent.
function readSnapshot(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return { bytes: null, mode: null };
    throw error;
  }
  if (!stat.isFile()) return { bytes: null, mode: null };
  if (stat.size > MAX_FILE_BYTES) throw new Error(`Update target exceeds ${MAX_FILE_BYTES} bytes: ${target}`);
  return { bytes: fs.readFileSync(target), mode: stat.mode & 0o777 };
}

function currentHash(snapshot, resource) {
  if (snapshot.bytes === null) return null;
  const projection = installedProjection(snapshot.bytes, resource);
  return projection === null ? null : sha256(projection);
}

// The clean installer version projected onto the current file. Managed blocks are
// spliced into surrounding user content; a host-managed Copilot `tools:` line is
// preserved verbatim from the current file.
function freshOutput(current, desired) {
  let content = desired.content;
  if (desired.projection === 'copilot-tools' && desired.preserveProjection && current.bytes !== null) {
    const marker = Buffer.from('tools:');
    let start = current.bytes.indexOf(marker);
    while (start !== -1 && start > 0 && current.bytes[start - 1] !== 0x0a) {
      start = current.bytes.indexOf(marker, start + marker.length);
    }
    if (start !== -1) {
      let end = current.bytes.indexOf(0x0a, start);
      if (end === -1) end = current.bytes.length;
      const toolsLine = current.bytes.subarray(start, end).toString('utf8').replace(/\r$/, '');
      if (/^tools:[^\r\n]*$/.test(toolsLine)) content = content.replace(/^tools:.*$/m, toolsLine);
    }
  }
  if (desired.mode === 'managed-block') {
    const block = Buffer.from(renderManagedBlock(content));
    if (current.bytes === null) return Buffer.from(block);
    return Buffer.from(upsertManagedBlock(current.bytes, block));
  }
  return Buffer.from(content);
}

// Stale (upstream-removed) managed-block handling: strip the owned block, keeping
// surrounding user bytes. Returns null => delete the file, a Buffer => write the
// stripped remainder, or undefined => no forge block present (leave the file).
function staleStrip(current, prior) {
  if (prior.mode !== 'managed-block') return null;
  const stripped = removeManagedBlock(current.bytes);
  if (stripped === null) return undefined;
  return stripped.length === 0 ? null : Buffer.from(stripped);
}

// Classify a managed file so reconciliation knows how to preserve user edits.
// Block/line files inline a preserved-local-changes section; structured files get
// a `.local` + `.diff` sidecar and a clean live file instead.
function isStructured(relativePath, mode, desiredContent) {
  if (mode === 'managed-block') return false;
  if (/\.(json|jsonc|ya?ml)$/i.test(relativePath)) return true;
  if (/(^|\/)(agent|agents|prompt|prompts|command|commands|rules)\//i.test(relativePath)) return false;
  if (/\.(agent|prompt|instructions)\.md$/i.test(relativePath)) return false;
  if (/(^|\/)(SKILL|AGENTS|forge)\.[a-z]+$/i.test(relativePath)) return false;
  if (/(^|\/)_shared\//i.test(relativePath)) return false;
  if (/^---\r?\n/.test(String(desiredContent))) return true; // standalone YAML-frontmatter file
  return false;
}

// Split a block/line file into its non-section body and any lines currently held
// in a preserved-local-changes section, so re-reconciliation is idempotent.
function splitLocalChanges(text) {
  const lines = text.split('\n');
  const beginIndex = lines.indexOf(LOCAL_BEGIN);
  if (beginIndex === -1) return { bodyLines: lines, sectionLines: [] };
  let endIndex = lines.indexOf(LOCAL_END, beginIndex);
  if (endIndex === -1) endIndex = lines.length - 1;
  let bodyEnd = beginIndex;
  while (bodyEnd > 0 && lines[bodyEnd - 1].trim() === '') bodyEnd -= 1; // drop blank separators
  const bodyLines = lines.slice(0, bodyEnd).concat(lines.slice(endIndex + 1));
  const sectionLines = lines.slice(beginIndex + 1, endIndex);
  return { bodyLines, sectionLines };
}

// Fresh installer content plus the user's non-installer additions in one delimited
// section. Never duplicates installer content; adds no section when there are none.
function reconcileAppend(fresh, current) {
  const freshText = fresh.toString('utf8');
  const freshLines = new Set(freshText.split('\n'));
  const { bodyLines, sectionLines } = splitLocalChanges(current.toString('utf8'));
  const extras = [];
  const seen = new Set();
  for (const line of [...bodyLines, ...sectionLines]) {
    if (line.trim() === '' || freshLines.has(line) || seen.has(line)) continue;
    seen.add(line);
    extras.push(line);
  }
  const base = freshText.endsWith('\n') ? freshText : `${freshText}\n`;
  if (extras.length === 0) return Buffer.from(base);
  return Buffer.from(`${base}\n${LOCAL_BEGIN}\n${extras.join('\n')}\n${LOCAL_END}\n`);
}

// Minimal dependency-free unified diff (LCS). `a` is installer-new, `b` is user-old.
function unifiedDiff(name, installerNew, userOld) {
  const a = installerNew.split('\n');
  const b = userOld.split('\n');
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push(` ${a[i]}`); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(`-${a[i]}`); i += 1; }
    else { ops.push(`+${b[j]}`); j += 1; }
  }
  while (i < n) { ops.push(`-${a[i]}`); i += 1; }
  while (j < m) { ops.push(`+${b[j]}`); j += 1; }
  const oldCount = ops.filter((line) => line[0] !== '+').length;
  const newCount = ops.filter((line) => line[0] !== '-').length;
  return `--- ${name}\t(installer-new)\n+++ ${name}\t(user-old)\n`
    + `@@ -1,${oldCount} +1,${newCount} @@\n${ops.join('\n')}\n`;
}

function entry(relativePath, target, status, current, extra = {}) {
  return {
    relativePath,
    target,
    status,
    current,
    reason: extra.reason || null,
    kind: extra.kind || 'none', // 'write' | 'remove' | 'none'
    output: 'output' in extra ? extra.output : undefined, // Buffer to write, or null to delete
    userEdited: !!extra.userEdited,
    sidecarLocal: extra.sidecarLocal || null, // Buffer -> <target>.local
    sidecarDiff: extra.sidecarDiff || null, // string -> <target>.diff
    logAction: extra.logAction || null,
  };
}

function desiredResource(base, item) {
  if (!item || typeof item.path !== 'string' || typeof item.content !== 'string') {
    throw new Error('Desired update actions require string paths and content');
  }
  const relativePath = relativeResourcePath(base, item.path);
  const mode = manifestMode(item.mode);
  if (!['replace', 'managed', 'managed-block', undefined].includes(item.mode)) {
    throw new Error(`Invalid desired mode for ${relativePath}`);
  }
  if (item.projection !== undefined && item.projection !== 'copilot-tools') {
    throw new Error(`Invalid desired projection for ${relativePath}`);
  }
  if (item.preserveProjection !== undefined && typeof item.preserveProjection !== 'boolean') {
    throw new Error(`Invalid desired projection policy for ${relativePath}`);
  }
  if (mode === 'managed-block' && item.projection !== undefined) {
    throw new Error(`Managed block cannot declare a projection for ${relativePath}`);
  }
  return {
    path: relativePath,
    target: item.path,
    mode,
    ...(item.projection ? { projection: item.projection } : {}),
    ...(item.projection ? { preserveProjection: item.preserveProjection !== false } : {}),
    content: item.content,
    sha256: sha256(contentProjection(item.content, { mode, projection: item.projection })),
  };
}

function publicResource(resource) {
  return {
    path: resource.path,
    mode: resource.mode,
    ...(resource.projection ? { projection: resource.projection } : {}),
    sha256: resource.sha256,
  };
}

// Decide how a single managed path reconciles. Pure: reads the current snapshot,
// returns a plan entry describing the write/remove/no-op and any sidecar.
function reconcilePath(base, relativePath, current, wanted, prior, previous) {
  const target = resolveManifestPath(base, relativePath);

  // New desired path (no prior ownership record).
  if (wanted && !prior) {
    const output = freshOutput(current, wanted);
    if (current.bytes === null) {
      return entry(relativePath, target, 'create', current, { kind: 'write', output, logAction: 'created' });
    }
    // Collides with an existing unowned file. With no prior hash we cannot call
    // it a user edit; back it up and write the fresh version (cooperative model).
    if (sameBytes(current.bytes, output)) {
      return entry(relativePath, target, 'unchanged', current, { logAction: 'unchanged' });
    }
    return entry(relativePath, target, 'update', current, { kind: 'write', output, logAction: 'updated' });
  }

  // Stale: previously owned, no longer desired.
  if (!wanted && prior) {
    if (previous.schemaVersion === 1) {
      // v1 has no verifiable hash; preserve untouched rather than risk user data.
      return entry(relativePath, target, 'stale-kept', current, {
        reason: 'unverifiable v1 resource preserved',
      });
    }
    if (current.bytes === null) {
      return entry(relativePath, target, 'absent', current, { logAction: 'absent' });
    }
    const userEdited = currentHash(current, prior) !== prior.sha256;
    const stripped = staleStrip(current, prior);
    if (stripped === undefined) {
      // Managed-block prior but no owned block present: leave the file alone.
      return entry(relativePath, target, 'stale-kept', current, { reason: 'no managed block to remove' });
    }
    return entry(relativePath, target, 'remove', current, {
      kind: 'remove',
      output: stripped, // null => delete file, Buffer => write stripped remainder
      userEdited,
      sidecarLocal: userEdited ? current.bytes : null,
      logAction: 'removed',
      reason: userEdited ? 'stale resource had local edits (kept .local)' : null,
    });
  }

  // Present in both the desired set and the prior manifest.
  const fresh = freshOutput(current, wanted);

  if (previous.schemaVersion === 1) {
    // v1 adopts only an exact match to the currently rendered desired content.
    const exactDesired = wanted.mode === 'managed-block'
      ? contentProjection(wanted.content, wanted)
      : Buffer.from(wanted.content);
    const exactCurrent = wanted.mode === 'managed-block'
      ? installedProjection(current.bytes || Buffer.alloc(0), wanted)
      : current.bytes;
    if (prior.mode === wanted.mode && exactCurrent !== null
      && sameBytes(Buffer.from(exactCurrent), Buffer.from(exactDesired))) {
      return entry(relativePath, target, 'unchanged', current, { logAction: 'unchanged' });
    }
    // Non-exact v1: treat as a user edit and reconcile by type.
    return reconcileEdited(relativePath, target, current, wanted, fresh, base);
  }

  const userEdited = currentHash(current, prior) !== prior.sha256 || prior.mode !== wanted.mode;
  if (userEdited) {
    return reconcileEdited(relativePath, target, current, wanted, fresh, base);
  }
  if (sameBytes(current.bytes, fresh)) {
    return entry(relativePath, target, 'unchanged', current, { logAction: 'unchanged' });
  }
  return entry(relativePath, target, 'update', current, { kind: 'write', output: fresh, logAction: 'updated' });
}

// A user-edited managed file: block/line files inline a preserved section; every
// other (structured) file gets a clean live file plus `.local` + `.diff` sidecars.
function reconcileEdited(relativePath, target, current, wanted, fresh, base) {
  if (isStructured(relativePath, wanted.mode, wanted.content)) {
    const diff = unifiedDiff(relativePath, fresh.toString('utf8'), (current.bytes || Buffer.alloc(0)).toString('utf8'));
    return entry(relativePath, target, 'reconciled-sidecar', current, {
      kind: 'write',
      output: fresh,
      userEdited: true,
      sidecarLocal: current.bytes || Buffer.alloc(0),
      sidecarDiff: diff,
      logAction: 'reconciled-sidecar',
      reason: 'user-edited structured file (wrote .local + .diff)',
    });
  }
  const merged = reconcileAppend(fresh, current.bytes || Buffer.alloc(0));
  if (sameBytes(current.bytes, merged)) {
    return entry(relativePath, target, 'unchanged', current, { logAction: 'unchanged' });
  }
  return entry(relativePath, target, 'reconciled-append', current, {
    kind: 'write',
    output: merged,
    userEdited: true,
    logAction: 'reconciled-append',
    reason: 'user-edited block file (preserved local changes)',
  });
}

export function planReconcile(tool, { base, actions, trustedRoot } = {}) {
  if (!base || !Array.isArray(actions)) throw new Error('Reconcile requires an install base and desired actions');
  const previous = readManifest(base, { tool }) || { schemaVersion: 0, resources: [] };
  const desired = actions.map((item) => desiredResource(base, item))
    .sort((left, right) => compareCodePoints(left.path, right.path));
  const desiredByPath = new Map();
  for (const resource of desired) {
    if (desiredByPath.has(resource.path)) throw new Error(`Duplicate desired resource path: ${resource.path}`);
    desiredByPath.set(resource.path, resource);
  }
  const previousByPath = new Map((previous.resources || []).map((resource) => [resource.path, resource]));
  const allPaths = [...new Set([...desiredByPath.keys(), ...previousByPath.keys()])].sort(compareCodePoints);

  const entries = allPaths.map((relativePath) => {
    const target = resolveManifestPath(base, relativePath);
    const current = readSnapshot(target);
    return reconcilePath(base, relativePath, current, desiredByPath.get(relativePath),
      previousByPath.get(relativePath), previous);
  });

  const desiredResources = desired.map(publicResource);
  const previousResources = previous.schemaVersion === 2 ? previous.resources : null;
  const resourcesChanged = JSON.stringify(desiredResources) !== JSON.stringify(previousResources);

  return {
    tool,
    base,
    trustedRoot: trustedRoot ? path.resolve(trustedRoot) : path.dirname(path.resolve(base)),
    previous,
    manifestSnapshot: readSnapshot(manifestPath(base)),
    desiredResources,
    entries,
    generation: previous.schemaVersion === 2 ? previous.generation + 1 : 1,
    manifestNeedsWrite: previous.schemaVersion !== 2 || resourcesChanged,
  };
}

export function planUpdate(tool, options = {}) {
  const { base, actions, label } = planInstall(tool, options);
  options.onPlanBoundary?.('after-install-plan', { tool, base, actions });
  return { ...planReconcile(tool, { base, actions, trustedRoot: options.home }), label };
}

// ---------- atomic writes + backups ----------

function atomicWrite(target, bytes, mode) {
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`Update output exceeds ${MAX_FILE_BYTES} bytes`);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(target)}.forge-tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  const descriptor = fs.openSync(temp, 'wx', 0o666); // create honors the effective umask
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    if (mode !== null && mode !== undefined) fs.chmodSync(temp, mode); // replacements preserve prior mode
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* keep the original error */ }
    throw error;
  }
  return { bytes, mode: mode ?? (fs.statSync(target).mode & 0o777) };
}

// Copy the current file into <base>/.forge-backups/<stamp>/<relPath>, preserving
// bytes and mode. Absent files return null (logged as "absent", not backed up).
function backupResource(base, stamp, relativePath, snapshot) {
  if (snapshot.bytes === null) return null;
  const backupTarget = path.join(base, BACKUP_DIR, stamp, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(backupTarget), { recursive: true });
  atomicWrite(backupTarget, snapshot.bytes, snapshot.mode ?? 0o600);
  return path.relative(base, backupTarget).split(path.sep).join('/');
}

function appendLog(base, records) {
  if (!records.length) return;
  const target = path.join(base, UPDATE_LOG);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

function manifestDocument(plan, timestamp) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    product: MANIFEST_PRODUCT,
    tool: plan.tool,
    generation: plan.generation,
    installedAt: plan.previous?.installedAt || timestamp,
    updatedAt: timestamp,
    resources: plan.desiredResources,
  };
}

function planGeneration(plan) {
  return plan.manifestNeedsWrite ? plan.generation : (plan.previous?.generation || 1);
}

export function applyUpdatePlans(plans, { force = false, onBoundary = () => {} } = {}) {
  void force; // accepted for signature compatibility; the cooperative model never blocks
  const timestamp = new Date().toISOString();
  const stamp = timestamp.replace(/[:.]/g, '-');

  const operations = plans.flatMap((plan) => plan.entries
    .filter((item) => item.kind === 'write' || item.kind === 'remove')
    .map((item) => ({ plan, item })));
  const manifests = plans.filter((plan) => plan.manifestNeedsWrite
    || operations.some((operation) => operation.plan === plan));

  const applied = []; // { plan, target, before, createdNew, backupRelPath, sidecars: [] }
  const appliedManifests = []; // { plan, before, backupRelPath }
  const logs = [];
  let reconciled = 0;

  try {
    for (const { plan, item } of operations) {
      onBoundary('before-resource', { plan, entry: item });
      const backupRelPath = backupResource(plan.base, stamp, item.relativePath, item.current);
      const record = {
        plan, target: item.target, before: item.current, createdNew: item.current.bytes === null,
        backupRelPath, sidecars: [],
      };
      applied.push(record);

      let afterSha = null;
      const sidecarInfo = {};
      if (item.sidecarLocal) {
        const localTarget = `${item.target}.local`;
        atomicWrite(localTarget, item.sidecarLocal, null);
        record.sidecars.push(localTarget);
        sidecarInfo.local = relativeResourcePath(plan.base, localTarget);
      }
      if (item.sidecarDiff) {
        const diffTarget = `${item.target}.diff`;
        atomicWrite(diffTarget, Buffer.from(item.sidecarDiff), null);
        record.sidecars.push(diffTarget);
        sidecarInfo.diff = relativeResourcePath(plan.base, diffTarget);
      }

      if (item.kind === 'remove' && item.output === null) {
        if (fs.existsSync(item.target)) fs.rmSync(item.target);
      } else {
        const preserveMode = item.current.bytes === null ? null : item.current.mode;
        atomicWrite(item.target, item.output, preserveMode);
        afterSha = sha256(item.output);
      }
      if (item.status === 'reconciled-append' || item.status === 'reconciled-sidecar') reconciled += 1;

      logs.push({
        ts: timestamp, tool: plan.tool, generation: planGeneration(plan), relPath: item.relativePath,
        action: item.logAction, backupPath: backupRelPath,
        sidecar: sidecarInfo.local || sidecarInfo.diff ? { local: sidecarInfo.local || null, diff: sidecarInfo.diff || null } : null,
        beforeSha: item.current.bytes === null ? null : sha256(item.current.bytes),
        afterSha,
      });
      onBoundary('after-resource', { plan, entry: item });
    }

    // Absent stale entries touch no disk but are still recorded for completeness.
    for (const plan of plans) {
      for (const item of plan.entries) {
        if (item.status !== 'absent') continue;
        logs.push({
          ts: timestamp, tool: plan.tool, generation: planGeneration(plan), relPath: item.relativePath,
          action: 'absent', backupPath: null, sidecar: null, beforeSha: null, afterSha: null,
        });
      }
    }

    // Manifest is written LAST so a resource failure never advances ownership.
    for (const plan of manifests) {
      onBoundary('before-manifest', { plan });
      const target = manifestPath(plan.base);
      const before = plan.manifestSnapshot;
      const backupRelPath = backupResource(plan.base, stamp, relativeResourcePath(plan.base, target), before);
      appliedManifests.push({ plan, before, backupRelPath });
      const bytes = Buffer.from(JSON.stringify(manifestDocument(plan, timestamp), null, 2) + '\n');
      atomicWrite(target, bytes, before.bytes === null ? null : before.mode);
      onBoundary('after-manifest', { plan });
    }

    for (const plan of plans) {
      appendLog(plan.base, logs.filter((record) => record.tool === plan.tool));
    }
  } catch (error) {
    // Restore every already-written resource and manifest from the just-made
    // backups; the prior manifest stays authoritative because it is untouched
    // when never written, and restored from backup when it was.
    for (const record of [...appliedManifests, ...applied].reverse()) {
      try {
        for (const sidecar of record.sidecars || []) {
          if (fs.existsSync(sidecar)) fs.rmSync(sidecar);
        }
        if (record.backupRelPath) {
          const backup = path.join(record.plan.base, ...record.backupRelPath.split('/'));
          const bytes = fs.readFileSync(backup);
          atomicWrite(record.target || manifestPath(record.plan.base), bytes, fs.statSync(backup).mode & 0o777);
        } else if (record.createdNew && record.target && fs.existsSync(record.target)) {
          fs.rmSync(record.target);
        } else if (record.before && record.before.bytes === null) {
          const manifestTarget = record.target || manifestPath(record.plan.base);
          if (fs.existsSync(manifestTarget)) fs.rmSync(manifestTarget);
        }
      } catch { /* best-effort restore; keep surfacing the original error */ }
    }
    try {
      for (const plan of plans) {
        appendLog(plan.base, logs
          .filter((record) => record.tool === plan.tool)
          .map((record) => ({ ...record, rolledBack: true })));
      }
    } catch { /* never mask the original failure with a logging error */ }
    throw error;
  }

  return {
    changed: operations.length,
    manifests: manifests.length,
    reconciled,
  };
}

export function applyUpdatePlan(plan, options) {
  return applyUpdatePlans([plan], options);
}
