import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const TOKEN = 'hub-test-token';
const BASE = `http://127.0.0.1:${PORT}`;
let proc;

const api = (p, method = 'GET', body) => fetch(BASE + p, {
  method, headers: { 'x-hub-token': TOKEN, 'content-type': 'application/json' },
  body: body && JSON.stringify(body),
});

before(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  proc = spawn(process.execPath, [path.resolve('src/server.mjs')], {
    cwd: dir,
    env: { ...process.env, PORT: String(PORT), HUB_BRIDGE_TOKEN: TOKEN, CLAIM_TTL_MS: '300', COLLAB_SKIP_ENV_FILE: 'true' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/health')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('hub did not start');
});
after(() => proc?.kill());

test('claims expire after CLAIM_TTL_MS', async () => {
  assert.equal((await api('/api/field-claim', 'POST', { developerId: 'a', cardId: 'ttl', fields: ['name'] })).status, 200);
  assert.equal((await api('/api/field-claim', 'POST', { developerId: 'b', cardId: 'ttl', fields: ['name'] })).status, 409);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal((await api('/api/field-claim', 'POST', { developerId: 'b', cardId: 'ttl', fields: ['name'] })).status, 200);
});

test('namespaced IDs: 409 reports the real field and GET decodes the path', async () => {
  const id = 'cardId:abc';
  await api('/api/field-claim', 'POST', { developerId: 'a', cardId: id, fields: ['name'] });
  const conflict = await api('/api/field-claim', 'POST', { developerId: 'b', cardId: id, fields: ['name'] });
  assert.equal(conflict.status, 409);
  const body = await conflict.json();
  assert.equal(body.field, 'name');
  assert.equal(body.owner, 'a');
  const got = await (await api(`/api/field-claims/${encodeURIComponent(id)}`)).json();
  assert.deepEqual(Object.keys(got.claims), ['name']);
  assert.equal(got.cardId, id);
  // release without a field list releases everything for that card
  await api('/api/field-claim', 'DELETE', { developerId: 'a', cardId: id });
  assert.deepEqual((await (await api(`/api/field-claims/${encodeURIComponent(id)}`)).json()).claims, {});
});

test('field-compare reports a conflict against the supplied base version', async () => {
  const card = 'cmp';
  await api('/api/field-claim', 'POST', { developerId: 'a', cardId: card, fields: ['name'] });
  const v1 = (await (await api('/api/field-version', 'POST', { developerId: 'a', cardId: card })).json()).version;
  await api('/api/field-claim', 'DELETE', { developerId: 'a', cardId: card });
  const v2 = (await (await api('/api/field-version', 'POST', { developerId: 'a', cardId: card })).json()).version;
  assert.ok(v2 > v1);
  const res = await (await api('/api/field-compare', 'POST', {
    developerId: 'b', cardId: card, targetVersion: v1, proposedChanges: { name: 'mine' },
  })).json();
  assert.equal(res.baseVersion, v1);
  assert.equal(res.currentVersion, v2);
  assert.deepEqual(res.conflictFields, ['name']);
  // comparing against the latest version never conflicts
  const same = await (await api('/api/field-compare', 'POST', { developerId: 'b', cardId: card, targetVersion: v2, proposedChanges: { name: 'mine' } })).json();
  assert.deepEqual(same.conflictFields, []);
  const missing = await api('/api/field-compare', 'POST', { developerId: 'b', cardId: card, targetVersion: 1, proposedChanges: {} });
  assert.equal(missing.status, 404);
});

function connect(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers });
    ws.once('open', () => resolve({ ok: true, ws }));
    ws.once('error', () => resolve({ ok: false }));
    ws.once('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
  });
}

test('/ws rejects foreign origins and unauthenticated non-browser clients', async () => {
  assert.equal((await connect({ Origin: 'https://evil.example' })).ok, false);
  assert.equal((await connect({})).ok, false);
  assert.equal((await connect({ 'x-hub-token': 'wrong' })).ok, false);
  const dash = await connect({ Origin: BASE });
  assert.equal(dash.ok, true); dash.ws.close();
  const tool = await connect({ 'x-hub-token': TOKEN });
  assert.equal(tool.ok, true); tool.ws.close();
});

test('/ws validates join role', async () => {
  const { ws } = await connect({ Origin: BASE });
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d)));
  ws.send(JSON.stringify({ type: 'join', name: 'x', role: '<script>' }));
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(msgs.some((m) => m.type === 'error' && /role/i.test(m.message)));
  ws.close();
});

async function joined(name) {
  // Listen before the socket opens: the hub sends its first state message immediately.
  const msgs = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: BASE } });
  ws.on('message', (d) => msgs.push(JSON.parse(d)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'join', name }));
  await new Promise((r) => setTimeout(r, 100));
  return { ws, msgs, send: (m) => ws.send(JSON.stringify(m)) };
}
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

test('over-long names are rejected with the limit, and limits are sent to the dashboard', async () => {
  const { ws, msgs } = await joined('x'.repeat(41));
  assert.ok(msgs.some((m) => m.type === 'error' && /40 characters or fewer/.test(m.message)));
  const state = msgs.find((m) => m.type === 'state').state;
  assert.equal(state.limits.name, 40);
  ws.close();
});

test('collaboration request → split works end to end over /ws', async () => {
  const owner = await joined('Owner');
  const helper = await joined('Helper');
  owner.send({ type: 'claim', cardId: 'CARD-1' });
  await wait();
  helper.send({ type: 'request-collaboration', cardId: 'CARD-1', note: 'I can take the tests' });
  await wait();
  const state = () => owner.msgs.filter((m) => m.type === 'state').at(-1).state;
  const request = state().collaborationRequests.find((r) => r.cardId === 'CARD-1');
  assert.equal(request.requester, 'Helper');
  assert.equal(request.note, 'I can take the tests');
  owner.send({ type: 'respond-collaboration', requestId: request.id, decision: 'split', ownerWork: 'API', collaboratorWork: 'Tests' });
  await wait();
  const split = state().workSplits.find((s) => s.cardId === 'CARD-1');
  assert.deepEqual([split.owner, split.collaborator, split.ownerWork, split.collaboratorWork], ['Owner', 'Helper', 'API', 'Tests']);
  owner.ws.close(); helper.ws.close();
});

test('/api/board reports demo mode when Trello is not configured', async () => {
  const body = await (await fetch(BASE + '/api/board')).json();
  // The test environment may have real Trello vars exported; only assert demo mode when it doesn't.
  if (!process.env.TRELLO_API_KEY) assert.equal(body.mode, 'demo');
});

test('claiming your own card again is not reported as a conflict', async () => {
  const me = await joined('Solo');
  me.send({ type: 'claim', cardId: 'CARD-SELF' });
  await wait();
  me.send({ type: 'claim', cardId: 'CARD-SELF' });
  await wait();
  assert.ok(me.msgs.some((m) => m.type === 'info' && /already claimed/.test(m.message)));
  assert.ok(!me.msgs.some((m) => m.type === 'conflict'));
  me.ws.close();
});
