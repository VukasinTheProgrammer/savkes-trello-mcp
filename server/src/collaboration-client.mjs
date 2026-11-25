// Collaboration Hub HTTP client for the trello-board MCP server.
// Provides developer identity, field claim acquisition, and release.
// Developer identity: COLLAB_DEVELOPER_ID env var takes priority;
// otherwise a UUID is stored per-instance at .collaboration-dev-id
// in the working directory (never committed to Git).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEV_ID_FILE = path.resolve(process.cwd(), '.collaboration-dev-id');

export function developerId() {
  const env = process.env.COLLAB_DEVELOPER_ID;
  if (env && env.trim()) return env.trim();
  return null;
}

// Resolved once per process so acquire and release always use the same identity;
// otherwise concurrent first calls could each mint a different UUID and a release
// would be rejected by the hub's owner check.
let developerIdPromise = null;
export function resolveDeveloperId() {
  const fromEnv = developerId();
  if (fromEnv) return Promise.resolve(fromEnv);
  developerIdPromise ??= loadOrCreateDeveloperId();
  return developerIdPromise;
}

async function loadOrCreateDeveloperId() {
  try {
    const existing = await fs.readFile(DEV_ID_FILE, 'utf8');
    const trimmed = existing.trim();
    if (trimmed) return trimmed;
  } catch { /* file doesn't exist yet */ }
  const generated = crypto.randomUUID();
  try {
    // 'wx' so another process that won the race keeps its ID and we adopt it.
    await fs.writeFile(DEV_ID_FILE, generated, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err?.code === 'EEXIST') {
      try {
        const winner = (await fs.readFile(DEV_ID_FILE, 'utf8')).trim();
        if (winner) return winner;
      } catch { /* fall through to in-memory identity */ }
    }
    /* otherwise best-effort; identity still works in memory */
  }
  return generated;
}

const HUB_URL = process.env.COLLAB_HUB_URL;
const HUB_TOKEN = process.env.HUB_BRIDGE_TOKEN;

export function isEnabled() {
  return process.env.COLLAB_ENABLED !== 'false' && Boolean(HUB_URL && HUB_TOKEN);
}

function hubHeaders() {
  return { 'content-type': 'application/json', 'x-hub-token': HUB_TOKEN };
}

export async function acquireFieldClaims(cardId, fields) {
  if (!isEnabled()) return { ok: true, skipped: true };
  const devId = await resolveDeveloperId();
  let target;
  try {
    target = new URL('/api/field-claim', HUB_URL);
    if (!['http:', 'https:'].includes(target.protocol)) return { ok: true, skipped: true, degraded: true, error: 'Unsupported hub URL protocol' };
  } catch { return { ok: true, skipped: true, degraded: true, error: 'Invalid hub URL' }; }

  // A stopped or misbehaving hub must never block Trello writes: only a real 409
  // conflict is reported as a conflict. Everything else is "degraded" and the caller
  // proceeds in standalone mode (unless COLLAB_REQUIRE_HUB=true).
  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: hubHeaders(),
      body: JSON.stringify({ developerId: devId, cardId, fields }),
      signal: AbortSignal.timeout(2000),
    });
  } catch (err) {
    return { ok: true, skipped: true, degraded: true, error: String(err?.message ?? err) };
  }

  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    return { ...body, ok: false, conflict: true };
  }
  if (!res.ok) {
    return { ok: true, skipped: true, degraded: true, error: `HTTP ${res.status}` };
  }
  const body = await res.json().catch(() => ({}));
  return { ok: true, devId, claimedAt: body.claimedAt };
}

export async function releaseFieldClaims(cardId, fields) {
  if (!isEnabled()) return { ok: true, skipped: true };
  const devId = await resolveDeveloperId();
  let target;
  try {
    target = new URL('/api/field-claim', HUB_URL);
    if (!['http:', 'https:'].includes(target.protocol)) return { ok: false, error: 'Unsupported hub URL protocol' };
  } catch { return { ok: false, error: 'Invalid hub URL' }; }

  const timeout = AbortSignal.timeout(2000);
  await fetch(target, {
    method: 'DELETE',
    headers: hubHeaders(),
    body: JSON.stringify({ developerId: devId, cardId, fields }),
    signal: timeout,
  }).catch(() => {}); // best-effort release

  return { ok: true };
}

export async function getFieldClaims(cardId) {
  if (!isEnabled()) return { ok: true, claims: {}, skipped: true };
  let target;
  try {
    target = new URL(`/api/field-claims/${encodeURIComponent(cardId)}`, HUB_URL);
    if (!['http:', 'https:'].includes(target.protocol)) return { ok: true, claims: {}, skipped: true };
  } catch { return { ok: true, claims: {}, skipped: true }; }

  try {
    const res = await fetch(target, { headers: hubHeaders(), signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, claims: {} };
    return await res.json();
  } catch {
    return { ok: false, claims: {} };
  }
}