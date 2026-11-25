import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoardCache, boardConfigured } from '../src/trello-board.mjs';

const env = { TRELLO_API_KEY: 'k', TRELLO_TOKEN: 'secret-token', TRELLO_BOARD_ID: 'b1' };
function fakeTrello({ fail = false } = {}) {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (fail) return { ok: false, status: 401, json: async () => ({}) };
    const path = new URL(url).pathname;
    const body = path.endsWith('/lists') ? [{ id: 'l1', name: 'Doing' }]
      : path.endsWith('/cards') ? [{ id: 'a'.repeat(24), name: 'Login page', idList: 'l1', shortLink: 'abc123', idMembers: ['m1'] }]
      : { id: 'b1', name: 'Team board', url: 'https://trello.com/b/b1' };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls: () => calls };
}

test('demo mode without credentials', async () => {
  assert.equal(boardConfigured({}), false);
  const cache = createBoardCache({ env: {} });
  assert.equal((await cache.get()).mode, 'demo');
  assert.equal(cache.findCard('anything'), null);
});

test('loads real lists and cards, caches them, and finds cards by id or short link', async () => {
  const t = fakeTrello();
  const cache = createBoardCache({ env, fetchImpl: t.fetchImpl });
  const { mode, board } = await cache.get();
  assert.equal(mode, 'trello');
  assert.equal(board.name, 'Team board');
  assert.equal(board.cards[0].list, 'Doing');
  await cache.get();
  assert.equal(t.calls(), 3, 'second call is served from cache');
  assert.equal(cache.findCard('abc123').id, 'a'.repeat(24));
  assert.equal(cache.findCard('nope'), undefined);
});

test('errors never leak the token', async () => {
  const cache = createBoardCache({ env, fetchImpl: fakeTrello({ fail: true }).fetchImpl });
  const result = await cache.get();
  assert.equal(result.mode, 'error');
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});
