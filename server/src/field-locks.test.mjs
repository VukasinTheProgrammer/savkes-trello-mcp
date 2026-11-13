import { test } from 'node:test';
import assert from 'node:assert/strict';

// No network: the mocked hub rejects every acquisition and Trello must not be called.
process.env.COLLAB_ENABLED = 'true';
process.env.COLLAB_HUB_URL = 'http://127.0.0.1:9999';
process.env.HUB_BRIDGE_TOKEN = 'local-test-token';
process.env.COLLAB_DEVELOPER_ID = 'test-developer';
process.env.TRELLO_BOARD_ID = 'mock-board';
let calls = [];
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  calls.push({ path, body: options.body && JSON.parse(options.body) });
  if (path === '/api/field-claim' && options.method === 'POST') {
    return new Response(JSON.stringify({ ok: false, conflict: true }), { status: 409, headers: { 'content-type': 'application/json' } });
  }
  if (path === '/api/mcp-event') return new Response('{}', { status: 200 });
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
    assert.match(result.content[0].text, /Collaboration claim unavailable or conflicting/);
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
test('unprotected hierarchy mutations fail closed when collaboration is enabled', async () => {
  calls = [];
  const result = await handle({ method: 'tools/call', params: { name: 'attachCard', arguments: { cardId: 'card', attachCardId: 'other' } } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /protection unavailable/);
  assert.equal(calls.filter(c => c.path === '/api/field-claim').length, 0);
});
