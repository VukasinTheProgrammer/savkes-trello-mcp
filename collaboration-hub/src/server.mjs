import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

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
function isExpired(claimedAt) { return now() - claimedAt > CLAIM_TTL_MS; }
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
const claims = new Map(); // cardId -> { owner, claimedAt }
const events = [];
const fieldClaims = new Map(); // cardId:field -> { owner, claimedAt }
const cardVersions = new Map(); // cardId -> { version: number, fields: { [field]: value }, owner, claimedAt }
const dependencies = new Map(); // cardId -> Set of prerequisite card IDs
const statuses = new Map(); // cardId -> todo | doing | review | done

const roles = new Map(); // userId -> { role, joinedAt }
const rolePermissions = new Map();
roles.set("admin", { level: 10, can: ["manage_members", "create_workspaces", "view_audit", "manage_projects"] });
roles.set("project_manager", { level: 8, can: ["view_audit", "manage_projects", "assign_tasks", "approve_changes"] });
roles.set("developer", { level: 5, can: ["view_cards", "claim_tasks", "make_changes", "add_comments"] });
roles.set("reviewer", { level: 3, can: ["view_cards", "add_comments", "review_changes"] });
roles.set("viewer", { level: 1, can: ["view_cards", "read_only"] });

function hasPermission(userId, requiredPermission) {
  const userRole = roles.get(userId);
  if (!userRole) return false;
  const permList = rolePermissions.get(userId) || userRole.can;
  return permList.includes(requiredPermission);
}

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
      const tool = clean(msg.tool, 60);
      const cardId = clean(msg.cardId, 80);
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
      const developerId = clean(msg.developerId, 80);
      const cardId = clean(msg.cardId, 80);
      const fields = Array.isArray(msg.fields) ? msg.fields.map((f) => clean(f, 40)).filter(Boolean) : [];
      if (!developerId) { res.writeHead(400); return res.end('Developer ID required'); }
      if (!cardId) { res.writeHead(400); return res.end('Card ID required'); }
      if (fields.length === 0) { res.writeHead(400); return res.end('At least one field required'); }

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
            field: key.split(':')[1],
            owner: existing.owner,
            message: `Field ${key} is claimed by ${existing.owner}`,
          }));
        }
      }

      // Claim all fields atomically
      const claimedAt = new Date().toISOString();
      for (const key of keys) {
        fieldClaims.set(key, { owner: developerId, claimedAt });
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
      const developerId = clean(msg.developerId, 80);
      const cardId = clean(msg.cardId, 80);
      const fields = Array.isArray(msg.fields) ? msg.fields.map((f) => clean(f, 40)).filter(Boolean) : [];
      if (!developerId) { res.writeHead(400); return res.end('Developer ID required'); }
      if (!cardId) { res.writeHead(400); return res.end('Card ID required'); }

      const keys = fields.length ? fields.map((f) => `${cardId}:${f}`) : [...fieldClaims.keys()].filter((k) => k.startsWith(`${cardId}:`));
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
    const cardId = clean(req.url.slice('/api/field-claims/'.length), 80);
    purgeExpired();
    const claims = {};
    for (const [key, claim] of fieldClaims.entries()) {
      if (key.startsWith(`${cardId}:`)) {
        claims[key.split(':')[1]] = claim;
      }
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
      const developerId = clean(msg.developerId, 80);
      const cardId = clean(msg.cardId, 80);
      if (!developerId) { res.writeHead(400); return res.end("Developer ID required"); }
      if (!cardId) { res.writeHead(400); return res.end("Card ID required"); }
      // Capture current field state as version snapshot
      const snapshot = {};
      for (const [key, claim] of fieldClaims.entries()) {
        if (key.startswith(cardId + ":")) {
          const field = key.slice(cardId.length + 1);
          snapshot[field] = "claimed";
        }
      }
      const versionNum = Date.now();
      cardVersions.set(cardId, { version: versionNum, fields: snapshot, owner: developerId, claimedAt: new Date().toISOString() });
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, cardId, version: versionNum, snapshot }));
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
      const developerId = clean(msg.developerId, 80);
      const cardId = clean(msg.cardId, 80);
      const targetVersion = msg.targetVersion;
      const proposedChanges = msg.proposedChanges;
      if (!developerId) { res.writeHead(400); return res.end("Developer ID required"); }
      if (!cardId) { res.writeHead(400); return res.end("Card ID required"); }
      if (targetVersion === undefined) { res.writeHead(400); return res.end("targetVersion required"); }
      const baseVersion = cardVersions.get(cardId);
      if (!baseVersion) { res.writeHead(404); return res.end(JSON.stringify({ error: "no_base_version" })); }
      const currentRemote = cardVersions.get(cardId);
      const changes = {};
      const proposedFieldList = proposedChanges ? Object.keys(proposedChanges) : [];
      for (const field of proposedFieldList) {
        const baseValue = baseVersion.fields?.[field];
        const currentValue = currentRemote?.fields?.[field];
        const proposedValue = proposedChanges?.[field];
        let conflict = false;
        if (baseValue !== proposedValue && currentRemote?.version > baseVersion.version) {
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
  if (req.url !== '/' && req.url !== '/index.html') { res.writeHead(404); return res.end('Not found'); }
  try {
    const html = await readFile(path.join(root, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } catch { res.writeHead(500); res.end('Dashboard unavailable'); }
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function snapshot() {
  return {
    participants: [...participants.values()],
    claims: [...claims.entries()].map(([cardId, claim]) => ({ cardId, ...claim })),
    fieldClaims: [...fieldClaims.entries()].map(([key, claim]) => ({ key, ...claim })),
    dependencies: [...dependencies.entries()].map(([cardId, needs]) => ({ cardId, needs: [...needs] })),
    statuses: [...statuses.entries()].map(([cardId, status]) => ({ cardId, status })),
    events: events.slice(-40)
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
function clean(value, max = 80) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
wss.on('connection', (ws) => {
  send(ws, { type: 'state', state: snapshot() });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'Invalid JSON' }); }
    const actor = participants.get(ws);
    if (msg.type === 'join') {
      const name = clean(msg.name, 40);
      const role = msg.role || 'developer';
      if (!name) return send(ws, { type: 'error', message: 'Name required' });
      if ([...participants.entries()].some(([socket, person]) => socket !== ws && person.name === name)) return send(ws, { type: 'error', message: 'This name is already connected; choose a different name' });
      participants.set(ws, { name, role, cardId: null, joinedAt: new Date().toISOString() });
      publish('joined', `${name} connected as ${role}`);
      return;
    }
    if (!actor) return send(ws, { type: 'error', message: 'Join first' });
    const cardId = clean(msg.cardId);
    if (msg.type === 'focus') {
      actor.cardId = cardId || null;
      publish('focus', `${actor.name} is viewing ${cardId || 'no card'}`);
    } else if (msg.type === 'claim') {
      if (!cardId) return send(ws, { type: 'error', message: 'Card ID required' });
      const current = claims.get(cardId);
      if (current && current.owner !== actor.name) {
        send(ws, { type: 'conflict', cardId, owner: current.owner, message: `Card ${cardId} is already claimed by ${current.owner}` });
        publish('overlap-warning', `${actor.name} tried to claim ${cardId}, owned by ${current.owner}`);
      } else {
        claims.set(cardId, { owner: actor.name, claimedAt: new Date().toISOString() });
        actor.cardId = cardId;
        publish('claimed', `${actor.name} claimed ${cardId}`);
      }
    } else if (msg.type === 'release') {
      if (claims.get(cardId)?.owner !== actor.name) return send(ws, { type: 'error', message: 'Only claim owner can release' });
      claims.delete(cardId);
      publish('released', `${actor.name} released ${cardId}`);
     } else if (msg.type === 'claim-field') {
      const field = clean(msg.field, 40);
      if (!cardId || !field) return send(ws, { type: 'error', message: 'Card and field required' });
      const key = `${cardId}:${field}`;
      const existing = fieldClaims.get(key);
      if (existing && existing.owner !== actor.name) {
        send(ws, { type: 'conflict', cardId, field, owner: existing.owner, message: `${key} is being edited by ${existing.owner}` });
        publish('field-overlap', `${actor.name} overlaps ${existing.owner} on ${key}`);
      } else {
        fieldClaims.set(key, { owner: actor.name, claimedAt: new Date().toISOString() });
        publish('field-claimed', `${actor.name} is editing ${key}`);
      }
    } else if (msg.type === 'release-field') {
      const field = clean(msg.field, 40);
      const key = `${cardId}:${field}`;
      if (fieldClaims.get(key)?.owner !== actor.name) return send(ws, { type: 'error', message: 'Only field owner can release' });
      fieldClaims.delete(key);
      publish('field-released', `${actor.name} released ${key}`);
    } else if (msg.type === 'depends-on') {
      const needs = clean(msg.needs);
      if (!cardId || !needs || cardId === needs) return send(ws, { type: 'error', message: 'Provide distinct card IDs' });
      const current = dependencies.get(cardId) || new Set();
      current.add(needs);
      dependencies.set(cardId, current);
      publish('dependency', `${cardId} depends on ${needs}`);
    } else if (msg.type === 'status') {
      const status = clean(msg.status, 12);
      if (!cardId || !['todo', 'doing', 'review', 'done'].includes(status)) return send(ws, { type: 'error', message: 'Invalid card or status' });
      if (status === 'done') {
        const blockedBy = [...(dependencies.get(cardId) || [])].filter(id => statuses.get(id) !== 'done');
        if (blockedBy.length) return send(ws, { type: 'conflict', cardId, message: `${cardId} is blocked by ${blockedBy.join(', ')}` });
      }
      statuses.set(cardId, status);
      publish('status', `${actor.name} moved ${cardId} to ${status}`);
    } else if (msg.type === 'activity') {
      const detail = clean(msg.detail, 160);
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
