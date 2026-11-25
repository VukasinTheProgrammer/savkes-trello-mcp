import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { splitTrelloCard } from './trello-split.mjs';
import { createBoardCache } from './trello-board.mjs';
import { LIMITS, checkLength, cleanText, cleanFieldList, fieldNameError, isValidRole, isValidStatus } from './utils/validators.mjs';
import { redactSecrets } from './utils/formatters.mjs';
import { WebSocketServer, WebSocket } from 'ws';

// Read Trello credentials from the repo-root .env (the same file the MCP server uses).
// Variables already set in the environment win. Tests set COLLAB_SKIP_ENV_FILE=true.
if (process.env.COLLAB_SKIP_ENV_FILE !== 'true' && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url))); } catch { /* no .env: demo mode */ }
}

const PORT = Number(process.env.PORT || 8787);
const BRIDGE_TOKEN = process.env.HUB_BRIDGE_TOKEN || '';
const MAX_BODY = 2048;
const CLAIM_TTL_MS = Number(process.env.CLAIM_TTL_MS || 600_000); // 10 minutes default
function authorized(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(BRIDGE_TOKEN);
  return !!BRIDGE_TOKEN && a.length === b.length && timingSafeEqual(a, b);
}
function now() { return Date.now(); }
function isExpired(claimedAt) {
  // claimedAt is stored as an ISO string; Date.parse turns it into epoch ms.
  const at = typeof claimedAt === 'number' ? claimedAt : Date.parse(claimedAt);
  return Number.isFinite(at) && now() - at > CLAIM_TTL_MS;
}
function purgeExpired() {
  const expired = [];
  for (const [key, claim] of fieldClaims.entries()) {
    if (isExpired(claim.claimedAt)) expired.push(key);
  }
  for (const key of expired) fieldClaims.delete(key);
  return expired.length;
}
const HOST = process.env.HOST || '127.0.0.1'; // local-only demo; do not expose without authentication
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const participants = new Map(); // websocket -> { name, role, cardId, joinedAt }
const collaborationRequests = new Map(); // requestId -> pending/approved/declined/split
const workSplits = new Map(); // cardId -> { owner, collaborator, ownerWork, collaboratorWork, ... }
let requestSequence = 0;
const claims = new Map(); // cardId -> { owner, claimedAt }
const events = [];
const fieldClaims = new Map(); // cardId:field -> { owner, claimedAt }
const cardVersions = new Map(); // cardId -> latest { version: number, fields: { [field]: value }, owner, claimedAt }
const cardVersionHistory = new Map(); // cardId -> Map(version -> record), newest 20 kept
const MAX_VERSION_HISTORY = 20;
const dependencies = new Map(); // cardId -> Set of prerequisite card IDs
const statuses = new Map(); // cardId -> todo | doing | review | done

const board = createBoardCache();

let sequence = 0;

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') return json(res, { ok: true, service: 'collaboration-hub' });
  if (req.url === '/api/mcp-event' && req.method === 'POST') {
    if (!authorized(req.headers['x-hub-token'])) { res.writeHead(401); return res.end('Unauthorized'); }
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) { res.writeHead(413); return res.end('Too large'); }
      }
      const msg = JSON.parse(body);
      const tool = cleanText(msg.tool, LIMITS.tool);
      const cardId = cleanText(msg.cardId, LIMITS.cardId);
      const status = msg.ok === true ? 'completed' : 'failed';
      if (!tool) { res.writeHead(400); return res.end('Tool required'); }
      publish('mcp-tool', `MCP ${tool} ${status}${cardId ? ' on ' + cardId : ''}`);
      res.writeHead(202); return res.end('Accepted');
    } catch { res.writeHead(400); return res.end('Invalid event'); }
  }
  if (req.url === '/api/field-claim' && req.method === 'POST') {
    if (!authorized(req.headers['x-hub-token'])) { res.writeHead(401); return res.end('Unauthorized'); }
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) { res.writeHead(413); return res.end('Too large'); }
      }
      const msg = JSON.parse(body);
      const developerId = cleanText(msg.developerId, LIMITS.developerId);
      const cardId = cleanText(msg.cardId, LIMITS.cardId);
      const fields = cleanFieldList(msg.fields);
      if (!developerId) { res.writeHead(400); return res.end('Developer ID required'); }
      if (!cardId) { res.writeHead(400); return res.end('Card ID required'); }
      if (fields.length === 0) { res.writeHead(400); return res.end('At least one field required'); }
      const badField = fields.map(fieldNameError).find(Boolean);
      if (badField) { res.writeHead(400); return res.end(badField); }

      purgeExpired();

      // Atomic: check all fields are available before claiming any
      const keys = fields.map((f) => `${cardId}:${f}`);
      for (const key of keys) {
        const existing = fieldClaims.get(key);
        if (existing && existing.owner !== developerId) {
          res.writeHead(409);
          return res.end(JSON.stringify({
            error: 'field_claim_conflict',
            cardId,
            field: existing.field,
            owner: existing.owner,
            message: `Field ${key} is claimed by ${existing.owner}`,
          }));
        }
      }

      // Claim all fields atomically
      const claimedAt = new Date().toISOString();
      for (const [i, key] of keys.entries()) {
        fieldClaims.set(key, { owner: developerId, claimedAt, cardId, field: fields[i] });
      }
      publish('field-claimed', `${developerId} claimed ${keys.join(', ')} on ${cardId}`);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, cardId, fields, claimedAt }));
    } catch { res.writeHead(400); return res.end('Invalid request'); }
  }
  if (req.url === '/api/field-claim' && req.method === 'DELETE') {
    if (!authorized(req.headers['x-hub-token'])) { res.writeHead(401); return res.end('Unauthorized'); }
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) { res.writeHead(413); return res.end('Too large'); }
      }
      const msg = JSON.parse(body);
      const developerId = cleanText(msg.developerId, LIMITS.developerId);
      const cardId = cleanText(msg.cardId, LIMITS.cardId);
      const fields = cleanFieldList(msg.fields);
      if (!developerId) { res.writeHead(400); return res.end('Developer ID required'); }
      if (!cardId) { res.writeHead(400); return res.end('Card ID required'); }

      const keys = fields.length
        ? fields.map((f) => `${cardId}:${f}`)
        : [...fieldClaims.entries()].filter(([, c]) => c.cardId === cardId).map(([k]) => k);
      const released = [];
      for (const key of keys) {
        const existing = fieldClaims.get(key);
        if (existing && existing.owner === developerId) {
          fieldClaims.delete(key);
          released.push(key);
        }
      }
      if (released.length) publish('field-released', `${developerId} released ${released.join(', ')} on ${cardId}`);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, cardId, released }));
    } catch { res.writeHead(400); return res.end('Invalid request'); }
  }
  if (req.url.startsWith('/api/field-claims/') && req.method === 'GET') {
    // Resource IDs are namespaced ("cardId:abc") and sent URL-encoded, so decode the
    // path segment and match on the stored cardId rather than parsing the key.
    let cardId;
    try { cardId = cleanText(decodeURIComponent(req.url.slice('/api/field-claims/'.length).split('?')[0]), LIMITS.cardId); }
    catch { res.writeHead(400); return res.end('Invalid card ID'); }
    purgeExpired();
    const claims = {};
    for (const claim of fieldClaims.values()) {
      if (claim.cardId === cardId) claims[claim.field] = claim;
    }
    return json(res, { cardId, claims });
  }
  if (req.url === "/api/field-version" && req.method === "POST") {
    if (!authorized(req.headers["x-hub-token"])) { res.writeHead(401); return res.end("Unauthorized"); }
    let body = "";
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) { res.writeHead(413); return res.end("Too large"); }
      }
      const msg = JSON.parse(body);
      const developerId = cleanText(msg.developerId, LIMITS.developerId);
      const cardId = cleanText(msg.cardId, LIMITS.cardId);
      if (!developerId) { res.writeHead(400); return res.end("Developer ID required"); }
      if (!cardId) { res.writeHead(400); return res.end("Card ID required"); }
      // Capture current field state as version snapshot
      const snapshot = {};
      for (const [key, claim] of fieldClaims.entries()) {
        if (key.startsWith(cardId + ":")) {
          const field = key.slice(cardId.length + 1);
          snapshot[field] = "claimed";
        }
      }
      const versionNum = Date.now();
      // Strictly increasing even for two snapshots in the same millisecond.
      const prev = cardVersions.get(cardId);
      const version = prev && prev.version >= versionNum ? prev.version + 1 : versionNum;
      const record = { version, fields: snapshot, owner: developerId, claimedAt: new Date().toISOString() };
      cardVersions.set(cardId, record);
      const history = cardVersionHistory.get(cardId) || new Map();
      history.set(version, record);
      while (history.size > MAX_VERSION_HISTORY) history.delete(history.keys().next().value);
      cardVersionHistory.set(cardId, history);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, cardId, version, snapshot }));
    } catch { res.writeHead(400); return res.end("Invalid request"); }
  }
  if (req.url === "/api/field-compare" && req.method === "POST") {
    if (!authorized(req.headers["x-hub-token"])) { res.writeHead(401); return res.end("Unauthorized"); }
    let body = "";
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) { res.writeHead(413); return res.end("Too large"); }
      }
      const msg = JSON.parse(body);
      const developerId = cleanText(msg.developerId, LIMITS.developerId);
      const cardId = cleanText(msg.cardId, LIMITS.cardId);
      const targetVersion = msg.targetVersion;
      const proposedChanges = msg.proposedChanges;
      if (!developerId) { res.writeHead(400); return res.end("Developer ID required"); }
      if (!cardId) { res.writeHead(400); return res.end("Card ID required"); }
      if (targetVersion === undefined) { res.writeHead(400); return res.end("targetVersion required"); }
      // targetVersion is the version the client based its edit on; compare it with
      // whatever is stored now.
      const currentRemote = cardVersions.get(cardId);
      if (!currentRemote) { res.writeHead(404); return res.end(JSON.stringify({ error: "no_base_version" })); }
      const baseVersion = cardVersionHistory.get(cardId)?.get(Number(targetVersion));
      if (!baseVersion) { res.writeHead(404); return res.end(JSON.stringify({ error: "base_version_not_found", currentVersion: currentRemote.version })); }
      const changes = {};
      const proposedFieldList = proposedChanges ? Object.keys(proposedChanges) : [];
      for (const field of proposedFieldList) {
        const baseValue = baseVersion.fields?.[field];
        const currentValue = currentRemote?.fields?.[field];
        const proposedValue = proposedChanges?.[field];
        let conflict = false;
        // Conflict: the remote moved on since the client's base AND changed this field.
        if (currentRemote.version > baseVersion.version && baseValue !== currentValue && proposedValue !== currentValue) {
          conflict = true;
        }
        changes[field] = {
          originalValue: baseValue,
          currentRemoteValue: currentValue,
          proposedLocalValue: proposedValue,
          conflicting: conflict
        };
      }
      const conflictFields = Object.entries(changes).filter(([, c]) => c.conflicting).map(([f]) => f);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, cardId, baseVersion: baseVersion.version, currentVersion: currentRemote?.version, changes, conflictFields }));
    } catch { res.writeHead(400); return res.end("Invalid request"); }
  }

  if (req.url === '/api/state') return json(res, snapshot());
  if (req.url === '/api/board' || req.url === '/api/board?refresh=1') {
    const result = await board.get({ force: req.url.endsWith('refresh=1') });
    return json(res, result);
  }
  if (req.url !== '/' && req.url !== '/index.html') { res.writeHead(404); return res.end('Not found'); }
  try {
    const html = await readFile(path.join(root, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } catch { res.writeHead(500); res.end('Dashboard unavailable'); }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
// Browsers don't apply CORS to WebSockets, so any page open in the developer's
// browser could otherwise drive this hub. Browser connections must come from the
// dashboard origin; non-browser clients (no Origin header) must present the bridge token.
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`,
  `http://${HOST}:${PORT}`,
  ...String(process.env.COLLAB_ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
]);
function wsAllowed(req) {
  const origin = req.headers.origin;
  if (origin !== undefined) return ALLOWED_ORIGINS.has(origin);
  return authorized(req.headers['x-hub-token']);
}
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') return;
  if (!wsAllowed(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});
function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function snapshot() {
  return {
    participants: [...participants.values()],
    collaborationRequests: [...collaborationRequests.values()],
    workSplits: [...workSplits.values()],
    claims: [...claims.entries()].map(([cardId, claim]) => ({ cardId, ...claim })),
    fieldClaims: [...fieldClaims.entries()].map(([key, claim]) => ({ key, ...claim })),
    dependencies: [...dependencies.entries()].map(([cardId, needs]) => ({ cardId, needs: [...needs] })),
    statuses: [...statuses.entries()].map(([cardId, status]) => ({ cardId, status })),
    events: events.slice(-40),
    limits: LIMITS
  };
}
function send(ws, value) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); }
function broadcast(value) { for (const ws of wss.clients) send(ws, value); }
function publish(type, detail) {
  const event = { id: ++sequence, type, detail, at: new Date().toISOString() };
  events.push(event);
  if (events.length > 100) events.shift();
  broadcast({ type: 'event', event });
  broadcast({ type: 'state', state: snapshot() });
}
// With the real board loaded, only its cards can be used. Accepts a card ID or short link
// and returns the full card ID. In demo mode (no Trello config) any ID is accepted.
// Card name for messages ("Login page" instead of a 24-character ID) when the board is loaded.
function label(cardId) {
  const card = cardId && board.findCard(cardId);
  return card ? `"${card.name}"` : cardId;
}
async function resolveCard(cardId) {
  if (!cardId || !board.configured()) return { cardId };
  await board.get();
  const card = board.findCard(cardId);
  if (card === null) return { cardId }; // board could not be loaded; don't block the team
  if (!card) return { error: `Card ${cardId} is not an open card on the Trello board` };
  return { cardId: card.id, card };
}
wss.on('connection', (ws) => {
  send(ws, { type: 'state', state: snapshot() });
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'Invalid JSON' }); }
    const actor = participants.get(ws);
    if (msg.type === 'join') {
      const checked = checkLength(msg.name || msg.developerId, 'name', 'Name');
      if (checked.error) return send(ws, { type: 'error', message: checked.error });
      const name = checked.value;
      const role = msg.role === undefined ? 'developer' : msg.role;
      if (!isValidRole(role)) return send(ws, { type: 'error', message: 'Unknown role' });
      if (!name) return send(ws, { type: 'error', message: 'Name required' });
      if ([...participants.entries()].some(([socket, person]) => socket !== ws && person.name === name)) return send(ws, { type: 'error', message: 'This name is already connected; choose a different name' });
      participants.set(ws, { name, role, cardId: null, joinedAt: new Date().toISOString() });
      publish('joined', `${name} connected as ${role}`);
      return;
    }
    if (!actor) return send(ws, { type: 'error', message: 'Join first' });
    const typedCard = checkLength(msg.cardId, 'cardId', 'Card ID');
    if (typedCard.error) return send(ws, { type: 'error', message: typedCard.error });
    const resolved = await resolveCard(typedCard.value);
    if (resolved.error) return send(ws, { type: 'error', message: resolved.error });
    const cardId = resolved.cardId;
    if (msg.type === 'focus') {
      actor.cardId = cardId || null;
      publish('focus', `${actor.name} is viewing ${cardId ? label(cardId) : 'no card'}`);
    } else if (msg.type === 'claim') {
      if (!cardId) return send(ws, { type: 'error', message: 'Card ID required' });
      const current = claims.get(cardId);
      if (current && current.owner === actor.name) {
        return send(ws, { type: 'info', message: `You already claimed ${label(cardId)}` });
      }
      if (current) {
        send(ws, { type: 'conflict', cardId, owner: current.owner, message: `${label(cardId)} is already claimed by ${current.owner}` });
        publish('overlap-warning', `${actor.name} tried to claim ${label(cardId)}, owned by ${current.owner}`);
      } else {
        claims.set(cardId, { owner: actor.name, claimedAt: new Date().toISOString() });
        actor.cardId = cardId;
        publish('claimed', `${actor.name} claimed ${label(cardId)}`);
      }

    } else if (msg.type === 'request-collaboration') {
      if (!cardId) return send(ws, { type: 'error', message: 'Card ID required' });
      const owner = claims.get(cardId)?.owner;
      if (!owner) return send(ws, { type: 'error', message: 'Card must be claimed first' });
      if (owner === actor.name) return send(ws, { type: 'error', message: 'You already own this card' });
      const existing = [...collaborationRequests.values()].find(r => r.cardId === cardId && r.requester === actor.name && r.status === 'pending');
      if (existing) return send(ws, { type: 'error', message: 'Request already pending' });
      const note = checkLength(msg.note, 'note', 'Message');
      if (note.error) return send(ws, { type: 'error', message: note.error });
      const request = { id: ++requestSequence, cardId, owner, requester: actor.name, note: note.value, status: 'pending', createdAt: new Date().toISOString() };
      collaborationRequests.set(request.id, request);
      publish('collaboration-request', `${actor.name} requested to collaborate with ${owner} on ${cardId}`);
    } else if (msg.type === 'respond-collaboration') {
      const request = collaborationRequests.get(Number(msg.requestId));
      if (!request || request.status !== 'pending') return send(ws, { type: 'error', message: 'Pending request not found' });
      if (request.owner !== actor.name || claims.get(request.cardId)?.owner !== actor.name) return send(ws, { type: 'error', message: 'Only the current card owner can respond' });
      if (!['approved', 'declined', 'split'].includes(msg.decision)) return send(ws, { type: 'error', message: 'Invalid decision' });
      if (msg.decision === 'split') {
        const ownerCheck = checkLength(msg.ownerWork, 'work', 'Your part');
        const collabCheck = checkLength(msg.collaboratorWork, 'work', 'Collaborator part');
        const tooLong = ownerCheck.error || collabCheck.error;
        if (tooLong) return send(ws, { type: 'error', message: tooLong });
        const ownerWork = ownerCheck.value;
        const collaboratorWork = collabCheck.value;
        if (!ownerWork || !collaboratorWork) return send(ws, { type: 'error', message: 'Describe both parts of the work before splitting' });
        if (workSplits.has(request.cardId)) return send(ws, { type: 'error', message: 'This card already has a work split. Resolve it before splitting again' });
        workSplits.set(request.cardId, {
          cardId: request.cardId, owner: actor.name, collaborator: request.requester,
          ownerWork, collaboratorWork, createdAt: new Date().toISOString(), requestId: request.id
        });
      }
      request.status = msg.decision;
      request.respondedAt = new Date().toISOString();
      publish('collaboration-response', `${actor.name} ${msg.decision} ${request.requester}'s request on ${request.cardId}`);
    } else if (msg.type === 'create-trello-split') {
      const request = collaborationRequests.get(Number(msg.requestId));
      const split = request && workSplits.get(request.cardId);
      if (!request || request.status !== 'split' || !split || split.requestId !== request.id)
        return send(ws, { type: 'error', message: 'Approved work split not found' });
      if (split.owner !== actor.name || claims.get(split.cardId)?.owner !== actor.name)
        return send(ws, { type: 'error', message: 'Only the current card owner can create a Trello split' });
      if (split.trelloCardId || split.creating)
        return send(ws, { type: 'error', message: 'Split already created or in progress' });
      if (msg.confirm !== true)
        return send(ws, { type: 'error', message: 'Explicit confirmation is required before creating a Trello card' });
      split.creating = true;
      try {
        const result = await splitTrelloCard({
          cardId: split.cardId, ownerWork: split.ownerWork,
          collaboratorWork: split.collaboratorWork, collaboratorName: split.collaborator, ownerName: split.owner,
          key: process.env.TRELLO_API_KEY, token: process.env.TRELLO_TOKEN
        });
        split.trelloCardId = result.newCardId;
        split.trelloCardUrl = result.newCardUrl;
        split.createdOnTrelloAt = new Date().toISOString();
        publish('trello-card-split', `${actor.name} created a Trello split card for ${split.collaborator}`);
        send(ws, { type: 'trello-split-created', ...result });
      } catch (err) {
        send(ws, { type: 'error', message: `Trello split failed: ${redactSecrets(err.message)}` });
      } finally { split.creating = false; }
    } else if (msg.type === 'release') {
      if (claims.get(cardId)?.owner !== actor.name) return send(ws, { type: 'error', message: 'Only claim owner can release' });
      claims.delete(cardId);
      workSplits.delete(cardId);
      publish('released', `${actor.name} released ${label(cardId)}`);
    } else if (msg.type === 'claim-field') {
      const fieldCheck = checkLength(msg.field, 'field', 'Field');
      if (fieldCheck.error) return send(ws, { type: 'error', message: fieldCheck.error });
      const field = fieldCheck.value;
      if (!cardId || !field) return send(ws, { type: 'error', message: 'Card and field required' });
      const badField = fieldNameError(field);
      if (badField) return send(ws, { type: 'error', message: badField });
      purgeExpired();
      const key = `${cardId}:${field}`;
      const existing = fieldClaims.get(key);
      if (existing && existing.owner !== actor.name) {
        send(ws, { type: 'conflict', cardId, field, owner: existing.owner, message: `${field} on ${label(cardId)} is being edited by ${existing.owner}` });
        publish('field-overlap', `${actor.name} overlaps ${existing.owner} on ${key}`);
      } else {
        fieldClaims.set(key, { owner: actor.name, claimedAt: new Date().toISOString(), cardId, field });
        publish('field-claimed', `${actor.name} is editing ${key}`);
      }
    } else if (msg.type === 'release-field') {
      const field = cleanText(msg.field, LIMITS.field);
      const key = `${cardId}:${field}`;
      if (fieldClaims.get(key)?.owner !== actor.name) return send(ws, { type: 'error', message: 'Only field owner can release' });
      fieldClaims.delete(key);
      publish('field-released', `${actor.name} released ${key}`);
    } else if (msg.type === 'depends-on') {
      const neededCard = await resolveCard(cleanText(msg.needs, LIMITS.cardId));
      if (neededCard.error) return send(ws, { type: 'error', message: neededCard.error });
      const needs = neededCard.cardId;
      if (!cardId || !needs || cardId === needs) return send(ws, { type: 'error', message: 'Provide distinct card IDs' });
      const current = dependencies.get(cardId) || new Set();
      current.add(needs);
      dependencies.set(cardId, current);
      publish('dependency', `${cardId} depends on ${needs}`);
    } else if (msg.type === 'status') {
      const status = cleanText(msg.status, 12);
      if (!cardId || !isValidStatus(status)) return send(ws, { type: 'error', message: 'Invalid card or status' });
      if (status === 'done') {
        const blockedBy = [...(dependencies.get(cardId) || [])].filter(id => statuses.get(id) !== 'done');
        if (blockedBy.length) return send(ws, { type: 'conflict', cardId, message: `${label(cardId)} is blocked by ${blockedBy.map(label).join(', ')}` });
      }
      statuses.set(cardId, status);
      publish('status', `${actor.name} moved ${cardId} to ${status}`);
    } else if (msg.type === 'activity') {
      const detail = cleanText(msg.detail, LIMITS.detail);
      if (detail) publish('activity', `${actor.name}: ${detail}`);
    } else {
      send(ws, { type: 'error', message: 'Unknown message type' });
    }
  });
  ws.on('close', () => {
    const actor = participants.get(ws);
    if (!actor) return;
    participants.delete(ws);
    // Claims deliberately persist until released; production needs TTL + reconnect identity.
    publish('left', `${actor.name} disconnected (claims retained)`);
  });
});
server.listen(PORT, HOST, () => console.log(`Hub running at http://${HOST}:${PORT}`));
