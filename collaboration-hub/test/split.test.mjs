import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitTrelloCard } from '../src/trello-split.mjs';

test('split card heading names the owner, not the work text', async () => {
  let created;
  const fetchImpl = async (url, opts) => {
    if (!opts) return new Response(JSON.stringify({ id: 'a'.repeat(24), name: 'Orig', idList: 'l', closed: false }), { status: 200 });
    created = new URLSearchParams(opts.body);
    return new Response(JSON.stringify({ id: 'b'.repeat(24) }), { status: 200 });
  };
  await splitTrelloCard({ cardId: 'a'.repeat(24), ownerWork: 'do the API', collaboratorWork: 'do the UI', collaboratorName: 'Bob', ownerName: 'Alice', key: 'k', token: 't', fetchImpl });
  assert.match(created.get('desc'), /Remaining work \(Alice\):\ndo the API/);
  assert.match(created.get('desc'), /Assigned work \(Bob\):\ndo the UI/);
});
