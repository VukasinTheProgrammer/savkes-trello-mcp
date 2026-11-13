import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportToolActivity } from '../../server/src/collaboration-bridge.mjs';

test('bridge is disabled by default and never throws', () => {
  const oldUrl = process.env.COLLAB_HUB_URL;
  const oldToken = process.env.HUB_BRIDGE_TOKEN;
  delete process.env.COLLAB_HUB_URL;
  delete process.env.HUB_BRIDGE_TOKEN;
  assert.doesNotThrow(() => reportToolActivity('updateCard', { cardId: '123' }));
  if (oldUrl === undefined) delete process.env.COLLAB_HUB_URL; else process.env.COLLAB_HUB_URL = oldUrl;
  if (oldToken === undefined) delete process.env.HUB_BRIDGE_TOKEN; else process.env.HUB_BRIDGE_TOKEN = oldToken;
});

test('bridge sends MCP tool activity to /api/mcp-event with auth header and correct body', async () => {
  const oldUrl = process.env.COLLAB_HUB_URL;
  const oldToken = process.env.HUB_BRIDGE_TOKEN;
  const originalFetch = globalThis.fetch;
  let captured = null;

  try {
    process.env.COLLAB_HUB_URL = 'http://127.0.0.1:8787';
    process.env.HUB_BRIDGE_TOKEN = 'test-token-123';

    globalThis.fetch = async (url, opts = {}) => {
      captured = {
        url: String(url),
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
      };
      return new Response('Accepted', { status: 202 });
    };

    reportToolActivity('getMyBoards', {}, true);

    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.ok(captured, 'fetch should have been called');
    assert.equal(captured.url, 'http://127.0.0.1:8787/api/mcp-event');
    assert.equal(captured.method, 'POST');
    assert.equal(captured.headers['x-hub-token'], 'test-token-123');
    assert.equal(captured.headers['content-type'], 'application/json');

    const body = JSON.parse(captured.body);
    assert.equal(body.tool, 'getMyBoards');
    assert.equal(body.cardId, '');
    assert.equal(body.ok, true);
  } finally {
    if (oldUrl === undefined) delete process.env.COLLAB_HUB_URL; else process.env.COLLAB_HUB_URL = oldUrl;
    if (oldToken === undefined) delete process.env.HUB_BRIDGE_TOKEN; else process.env.HUB_BRIDGE_TOKEN = oldToken;
    globalThis.fetch = originalFetch;
  }
});

test('bridge sends failed status when ok is false', async () => {
  const oldUrl = process.env.COLLAB_HUB_URL;
  const oldToken = process.env.HUB_BRIDGE_TOKEN;
  const originalFetch = globalThis.fetch;
  let captured = null;

  try {
    process.env.COLLAB_HUB_URL = 'http://127.0.0.1:8787';
    process.env.HUB_BRIDGE_TOKEN = 'test-token-123';

    globalThis.fetch = async (url, opts = {}) => {
      captured = { body: opts.body };
      return new Response('Accepted', { status: 202 });
    };

    reportToolActivity('updateCard', { cardId: 'abc123' }, false);

    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.ok(captured, 'fetch should have been called');
    const body = JSON.parse(captured.body);
    assert.equal(body.tool, 'updateCard');
    assert.equal(body.cardId, 'abc123');
    assert.equal(body.ok, false);
  } finally {
    if (oldUrl === undefined) delete process.env.COLLAB_HUB_URL; else process.env.COLLAB_HUB_URL = oldUrl;
    if (oldToken === undefined) delete process.env.HUB_BRIDGE_TOKEN; else process.env.HUB_BRIDGE_TOKEN = oldToken;
    globalThis.fetch = originalFetch;
  }
});

test('bridge does not throw when fetch rejects', async () => {
  const oldUrl = process.env.COLLAB_HUB_URL;
  const oldToken = process.env.HUB_BRIDGE_TOKEN;
  const originalFetch = globalThis.fetch;

  try {
    process.env.COLLAB_HUB_URL = 'http://127.0.0.1:8787';
    process.env.HUB_BRIDGE_TOKEN = 'test-token-123';

    globalThis.fetch = async () => {
      throw new Error('hub unreachable');
    };

    // Should not throw even though fetch rejects.
    await Promise.resolve().then(() => reportToolActivity('getMyBoards', {}, true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(true, 'bridge did not throw on fetch failure');
  } finally {
    if (oldUrl === undefined) delete process.env.COLLAB_HUB_URL; else process.env.COLLAB_HUB_URL = oldUrl;
    if (oldToken === undefined) delete process.env.HUB_BRIDGE_TOKEN; else process.env.HUB_BRIDGE_TOKEN = oldToken;
    globalThis.fetch = originalFetch;
  }
})
