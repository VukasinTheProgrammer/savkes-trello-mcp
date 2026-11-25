import { test } from 'node:test';
import assert from 'node:assert/strict';

// No network: the mocked hub rejects every acquisition and Trello must not be called.
process.env.COLLAB_ENABLED = 'true';
process.env.COLLAB_HUB_URL = 'http://127.0.0.1:9999';
process.env.HUB_BRIDGE_TOKEN = 'local-test-token';
process.env.COLLAB_DEVELOPER_ID = 'test-developer';
process.env.TRELLO_BOARD_ID = 'mock-board';
process.env.TRELLO_API_KEY = 'k';
process.env.TRELLO_TOKEN = 't';
let calls = [];
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  calls.push({ path, body: options.body && JSON.parse(options.body) });
  if (path === '/api/field-claim' && options.method === 'POST') {
    return new Response(JSON.stringify({ ok: false, conflict: true }), { status: 409, headers: { 'content-type': 'application/json' } });
  }
  if (path === '/api/mcp-event') return new Response('{}', { status: 200 });
  // updateChecklistItem looks up the owning checklist before claiming.
  if (path.endsWith('/cards/card/checklists')) {
    return new Response(JSON.stringify([{ id: 'checklist', checkItems: [{ id: 'item' }] }]), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`Unexpected request: ${url}`);
};
const { TOOLS, handle } = await import('./index.mjs');
const mutationArgs = {
  addCard: { listId: 'list', name: 'card' }, updateCard: { cardId: 'card', name: 'new' },
  moveCard: { cardId: 'card', listId: 'list' }, changeCardMembers: { cardId: 'card', members: [] },
  archiveCard: { cardId: 'card' }, unarchiveCard: { cardId: 'card' },
  addList: { name: 'list' }, archiveList: { listId: 'list' },
  addComment: { cardId: 'card', text: 'comment' },
  updateComment: { cardId: 'card', commentId: 'comment', text: 'edit' },
  deleteComment: { cardId: 'card', commentId: 'comment' },
  addChecklist: { cardId: 'card', name: 'checklist' },
  updateChecklistItem: { cardId: 'card', checkItemId: 'item', state: 'complete' },
  deleteChecklist: { checklistId: 'checklist' },
  addChecklistItem: { checklistId: 'checklist', name: 'item' },
};
for (const [name, args] of Object.entries(mutationArgs)) {
  test(`${name} rejects a conflicting claim before Trello`, async () => {
    calls = [];
    const result = await handle({ method: 'tools/call', params: { name, arguments: args } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Collaboration conflict/);
    const claims = calls.filter(c => c.path === '/api/field-claim');
    assert.equal(claims.length, 1);
    assert.equal(claims[0].body.developerId, 'test-developer');
  });
}
test('updateCard claims only provided fields', async () => {
  calls = [];
  await handle({ method: 'tools/call', params: { name: 'updateCard', arguments: { cardId: 'card', description: 'only description' } } });
  assert.deepEqual(calls.find(c => c.path === '/api/field-claim').body.fields, ['description']);
});
test('checklist item locks use checklist resource rather than requiring cardId', async () => {
  calls = [];
  await handle({ method: 'tools/call', params: { name: 'addChecklistItem', arguments: { checklistId: 'checklist', name: 'task' } } });
  assert.equal(calls.find(c => c.path === '/api/field-claim').body.cardId, 'checklistId:checklist');
});
test('hierarchy mutations are claimed instead of failing', async () => {
  const locks = {
    attachCard: [{ cardId: 'card', attachCardId: 'other' }, 'cardId:card', ['attachments']],
    detachCard: [{ cardId: 'card', attachmentId: 'att' }, 'cardId:card', ['attachments']],
    placeCards: [{ listId: 'list', underNumber: '1', cardIds: ['a'] }, 'listId:list', ['cards']],
    repairCardHierarchy: [{ dryRun: true }, 'boardId:mock-board', ['hierarchy']],
  };
  for (const [name, [args, resource, fields]] of Object.entries(locks)) {
    calls = [];
    const result = await handle({ method: 'tools/call', params: { name, arguments: args } });
    assert.equal(result.isError, true); // 409 from the mock hub
    assert.doesNotMatch(result.content[0].text, /protection unavailable/);
    const claim = calls.find(c => c.path === '/api/field-claim');
    assert.ok(claim, `${name} should attempt a claim`);
    assert.equal(claim.body.cardId, resource);
    assert.deepEqual(claim.body.fields, fields);
  }
});
test('conflict message names the owner', async () => {
  const result = await handle({ method: 'tools/call', params: { name: 'updateCard', arguments: { cardId: 'card', name: 'x' } } });
  assert.match(result.content[0].text, /Collaboration conflict/);
});

// --- hub down / misbehaving -------------------------------------------------
const realMock = globalThis.fetch;
function trelloOk(path) {
  if (path.startsWith('/1/')) return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
}
test('network failure falls back to standalone and still writes', async () => {
  calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, host: u.host, body: options.body && JSON.parse(options.body) });
    if (u.host === '127.0.0.1:9999') throw new TypeError('fetch failed');
    return trelloOk(u.pathname) ?? new Response('{}', { status: 200 });
  };
  process.env.TRELLO_API_KEY = 'k'; process.env.TRELLO_TOKEN = 't';
  const result = await handle({ method: 'tools/call', params: { name: 'updateCard', arguments: { cardId: 'card', name: 'x' } } });
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.ok(calls.some(c => c.host === 'api.trello.com'), 'Trello must be called');
});
test('non-409 hub error falls back to standalone', async () => {
  calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    calls.push({ host: u.host });
    if (u.host === '127.0.0.1:9999') return new Response('boom', { status: 500 });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await handle({ method: 'tools/call', params: { name: 'updateCard', arguments: { cardId: 'card', name: 'x' } } });
  assert.notEqual(result.isError, true, result.content[0].text);
});
test('COLLAB_REQUIRE_HUB=true fails closed when the hub is down', async () => {
  calls = [];
  process.env.COLLAB_REQUIRE_HUB = 'true';
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    calls.push({ host: u.host });
    if (u.host === '127.0.0.1:9999') throw new TypeError('fetch failed');
    return new Response('{}', { status: 200 });
  };
  const result = await handle({ method: 'tools/call', params: { name: 'updateCard', arguments: { cardId: 'card', name: 'x' } } });
  delete process.env.COLLAB_REQUIRE_HUB;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /COLLAB_REQUIRE_HUB/);
  assert.ok(!calls.some(c => c.host === 'api.trello.com'));
});

// --- checklist operations share one lock ------------------------------------
test('updateChecklistItem locks the owning checklist, same as delete/add', async () => {
  const claims = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.host === '127.0.0.1:9999') {
      claims.push(JSON.parse(options.body));
      return new Response('{"ok":true,"claimedAt":"x"}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname.endsWith('/checklists')) {
      return new Response(JSON.stringify([{ id: 'CL1', checkItems: [{ id: 'item' }] }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await handle({ method: 'tools/call', params: { name: 'updateChecklistItem', arguments: { cardId: 'card', checkItemId: 'item', state: 'complete' } } });
  await handle({ method: 'tools/call', params: { name: 'deleteChecklist', arguments: { checklistId: 'CL1' } } });
  await handle({ method: 'tools/call', params: { name: 'addChecklistItem', arguments: { checklistId: 'CL1', name: 'n' } } });
  const acquires = claims.filter(c => c.fields);
  const keys = new Set(acquires.map(c => `${c.cardId}|${c.fields.join(',')}`));
  assert.deepEqual([...keys], ['checklistId:CL1|checklist']);
});

// --- developer identity is resolved once ------------------------------------
test('resolveDeveloperId returns the same cached ID for concurrent callers', async () => {
  delete process.env.COLLAB_DEVELOPER_ID;
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os'); const path = await import('node:path');
  const cwd = process.cwd();
  process.chdir(mkdtempSync(path.join(os.tmpdir(), 'devid-')));
  try {
    const { resolveDeveloperId } = await import('./collaboration-client.mjs?fresh=1');
    const ids = await Promise.all(Array.from({ length: 10 }, () => resolveDeveloperId()));
    assert.equal(new Set(ids).size, 1);
  } finally { process.chdir(cwd); process.env.COLLAB_DEVELOPER_ID = 'test-developer'; }
});
globalThis.fetch = realMock;
