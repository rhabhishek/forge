// MCP provisioning: catalog shape + the polite-merge contract. Forge only ever
// touches servers it owns (_source: forge); anything you or Cortex configured is
// skipped, not duplicated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareCodePoints } from '../lib/core.mjs';
import { mergeMcp, loadMcpCatalog } from '../lib/mcp.mjs';

const ATL = 'atlassian';
const GH = 'io.github.github/github-mcp-server';
const CONF = 'confluence';
const FIGMA = 'figma';

function tmpJson(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mcp-'));
  const p = path.join(dir, 'mcp.json');
  if (initial !== undefined) fs.writeFileSync(p, typeof initial === 'string' ? initial : JSON.stringify(initial));
  return p;
}

test('catalog has the four requested forge servers', () => {
  const cat = loadMcpCatalog();
  for (const id of [GH, ATL, CONF, FIGMA]) assert.ok(cat[id], `${id} present in catalog`);
});

test('mergeMcp: adds selected, tags _source: forge, preserves other keys', () => {
  const p = tmpJson({ inputs: [{ id: 'x' }], servers: {} });
  const r = mergeMcp(p, [ATL, CONF, FIGMA], { apply: true });
  assert.deepEqual(r.added.sort(compareCodePoints), [ATL, CONF, FIGMA].sort(compareCodePoints));
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(doc.servers[ATL]._source, 'forge');
  assert.deepEqual(doc.inputs, [{ id: 'x' }], 'non-server keys preserved');
});

test('mergeMcp: catalog display-only _* metadata is stripped, _source kept', () => {
  const p = tmpJson({ servers: {} });
  mergeMcp(p, [GH], { apply: true });
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(!('_label' in doc.servers[GH]) && !('_description' in doc.servers[GH]), 'display meta stripped');
  assert.equal(doc.servers[GH]._source, 'forge');
  assert.ok(doc.servers[GH].headers.Authorization.includes('${env:GITHUB_TOKEN}'), 'token referenced via env, not inlined');
});

test('mergeMcp: skips (never duplicates) a server Cortex already provisioned', () => {
  const p = tmpJson({ servers: { [ATL]: { _source: 'cortex', type: 'http', url: 'https://mcp.atlassian.com/v1/mcp' } } });
  const r = mergeMcp(p, [ATL], { apply: true });
  assert.deepEqual(r.skipped, [ATL], 'reported as skipped');
  assert.deepEqual(r.added, [], 'not added');
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(doc.servers[ATL]._source, 'cortex', 'cortex entry left intact, not overwritten');
  assert.equal(Object.keys(doc.servers).length, 1, 'no duplicate key');
});

test('mergeMcp: never touches user-owned servers', () => {
  const p = tmpJson({ servers: { mine: { type: 'http', url: 'x' } } });
  const r = mergeMcp(p, [ATL], { apply: true });
  assert.deepEqual(r.removed, [], 'user server not removed');
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(doc.servers.mine, 'user server preserved');
  assert.ok(doc.servers[ATL], 'forge server added alongside');
});

test('mergeMcp: removes forge-owned servers no longer selected (empty selection cleans up)', () => {
  const p = tmpJson({ servers: { [ATL]: { _source: 'forge', type: 'http' } } });
  const r = mergeMcp(p, [], { apply: true });
  assert.deepEqual(r.removed, [ATL]);
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(!doc.servers[ATL]);
});

test('mergeMcp: cleanup never removes a cortex-owned server', () => {
  const p = tmpJson({ servers: { [ATL]: { _source: 'cortex', type: 'http' } } });
  const r = mergeMcp(p, [], { apply: true });
  assert.deepEqual(r.removed, [], 'cortex server untouched on empty selection');
  assert.ok(JSON.parse(fs.readFileSync(p, 'utf8')).servers[ATL], 'still present');
});

test('mergeMcp: dry-run reports changes without writing', () => {
  const p = tmpJson({ servers: {} });
  const r = mergeMcp(p, [FIGMA], { apply: false });
  assert.deepEqual(r.added, [FIGMA]);
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(doc.servers, {}, 'nothing written on dry run');
});

test('mergeMcp: invalid JSON is reported, not overwritten', () => {
  const p = tmpJson('{ not valid json');
  const r = mergeMcp(p, [ATL], { apply: true });
  assert.ok(r.error);
  assert.equal(fs.readFileSync(p, 'utf8'), '{ not valid json', 'file left untouched');
});
