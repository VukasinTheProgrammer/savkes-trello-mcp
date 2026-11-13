// Optional, best-effort event publisher. Never blocks Trello operations.
// Only tool name, success flag, and card ID are sent. No tokens or descriptions.
export function reportToolActivity(tool, args = {}, ok = true) {
  const url = process.env.COLLAB_HUB_URL;
  const token = process.env.HUB_BRIDGE_TOKEN;
  if (!url || !token) return;
  let target;
  try {
    target = new URL('/api/mcp-event', url);
    if (!['http:', 'https:'].includes(target.protocol)) return;
  } catch { return; }
  const cardId = typeof args.cardId === 'string' ? args.cardId.slice(0, 80) : '';
  // Fire-and-forget: a stopped hub must never interrupt MCP requests.
  try {
    const timeout = AbortSignal.timeout(800);
    void fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-token': token },
      body: JSON.stringify({ tool, cardId, ok }),
      signal: timeout,
    }).catch(() => {});
  } catch { /* hub is optional */ }
}

// Field-level collaboration preflight. Imported from collaboration-client.mjs
// and wired into index.mjs for write operations that touch specific Trello fields.
// When COLLAB_ENABLED is false, all functions are no-ops that permit the call.
export async function acquireFieldClaims(cardId, fields) {
  const { acquireFieldClaims: impl } = await import('./collaboration-client.mjs');
  return impl(cardId, fields);
}
export async function releaseFieldClaims(cardId, fields) {
  const { releaseFieldClaims: impl } = await import('./collaboration-client.mjs');
  return impl(cardId, fields);
}
export function collaborationEnabled() {
  return process.env.COLLAB_ENABLED !== 'false' && Boolean(process.env.COLLAB_HUB_URL && process.env.HUB_BRIDGE_TOKEN);
}
