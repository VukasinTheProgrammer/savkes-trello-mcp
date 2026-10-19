// Trello REST layer: credential read, rate limiting, URL building, reference
// normalisation, and the 429 retry policy. Every tool goes through
// `trello()`, so there is one place holding the credentials and one shared pair of
// rate-limit buckets covering read and mutating calls alike.
//
// Credentials come from env: TRELLO_API_KEY, TRELLO_TOKEN. They are read per call
// rather than at import so the selftest can set fakes after the module is loaded.
// TRELLO_BOARD_ID is optional — the default board for board-scoped tools when no
// boardId argument is given.

const API = "https://api.trello.com/1";

export const cardRef = (s) =>
  String(s ?? "")
    .trim()
    .replace(/^https?:\/\/trello\.com\/[cb]\/([^/?#]+).*$/i, "$1");

// Every board-scoped tool takes an optional boardId and falls back to
// TRELLO_BOARD_ID, so the fallback and its error live here once. This is also what
// replaces mcp-trello's 24-character board-id check, which rejected the shortLink
// form outright instead of accepting it like the rest of the surface does.
export function resolveBoard(boardId) {
  const board = cardRef(boardId ?? defaultBoard());
  if (!board) throw new Error("boardId is required when TRELLO_BOARD_ID is not set");
  return board;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Token bucket. `rate` is tokens per *millisecond*, which is why msUntilToken does
// not scale by 1000 — mcp-trello's version did, overestimating every wait by a
// factor of a thousand, and only stayed usable because it clamped the result to
// 100ms before sleeping on it.
export class Bucket {
  constructor(maxTokens, windowMs) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.rate = maxTokens / windowMs;
    this.last = Date.now();
  }

  refill() {
    const now = Date.now();
    // Clamped at 0: Date.now() is wall clock, not monotonic, so an NTP correction or
    // a laptop resume can put `last` in the future. Unclamped, that elapsed time goes
    // negative and *subtracts* tokens — a one-hour jump backwards leaves the bucket at
    // -108000 tokens and take() sleeping for an hour on a bucket that owes 33ms.
    const elapsed = Math.max(0, now - this.last);
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.rate);
    this.last = now;
  }

  msUntilToken() {
    this.refill();
    return this.tokens >= 1 ? 0 : (1 - this.tokens) / this.rate;
  }

  async take() {
    for (;;) {
      const ms = this.msUntilToken();
      if (ms === 0) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(ms));
    }
  }
}

// Trello's published limits, as one module-level pair. Every tool draws from the
// same allowance, which is the whole point of merging the two servers.
const BUCKETS = [new Bucket(300, 10_000), new Bucket(100, 10_000)];

const MAX_ATTEMPTS = 5;

// Trello answers in well under a second normally; 30s is "the connection is gone",
// not "the call is slow".
const REQUEST_TIMEOUT_MS = 30_000;

// Retry-After wins when Trello sends one; otherwise exponential from 500ms. Jitter
// is proportional to the wait so a short Retry-After isn't swamped by it.
function backoffMs(res, attempt) {
  const retryAfter = Number(res.headers.get("retry-after"));
  const base =
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** (attempt - 1) * 500;
  return base + Math.random() * Math.min(base, 250);
}

// Trello's 404 handler echoes the request line back verbatim — "Cannot GET
// /1/cards/?key=...&token=..." — so an error body can carry credentials into the
// tool result, the model's context and every transcript on disk. authHeader keeps
// them out of the URL now; this stays as a second guard in case a caller ever
// passes key/token as params.
const redact = (text) =>
  String(text).replace(/([?&](?:key|token)=)[^&\s"'<]+/gi, "$1[redacted]");

// Claude Code substitutes `${VAR}` in the .mcp.json env block only when the variable
// exists in the environment; when it does not, the literal placeholder text is passed
// through as the credential. Trello then answers 401 with nothing that points at the
// real cause, so both that shape and the plain-empty case are named here instead.
const PLACEHOLDER = /^\$\{[^}]*\}$/;

// Same placeholder trap for the optional board: unset must read as "no default",
// not as a board literally named "${TRELLO_BOARD_ID}".
export function defaultBoard() {
  const value = String(process.env.TRELLO_BOARD_ID ?? "").trim();
  return PLACEHOLDER.test(value) ? "" : value;
}

function credential(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is not set — export it before starting the session`);
  if (PLACEHOLDER.test(value)) {
    throw new Error(
      `${name} is not set — .mcp.json passed through the literal ${value}, ` +
        `which means the variable was missing from the environment when the server started`,
    );
  }
  return value;
}

// Credentials travel in a header, not the query string, so they stay out of URLs —
// and out of anything that logs or echoes one. Format per
// https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/
export function authHeader() {
  const key = credential("TRELLO_API_KEY");
  const token = credential("TRELLO_TOKEN");
  return `OAuth oauth_consumer_key="${key}", oauth_token="${token}"`;
}

// Split out from `trello()` so the selftest can assert what a tool builds without
// a network round trip.
export function buildUrl(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url;
}

export async function trello(method, path, params = {}) {
  const headers = { Accept: "application/json", Authorization: authHeader() };
  const url = buildUrl(path, params);
  for (let attempt = 1; ; attempt++) {
    // ponytail: taking both buckets via Promise.all can burn a token in the looser
    // bucket while still waiting on the tighter one. Harmless at this volume —
    // upgrade to a single combined gate if the 100/10s bucket starts throttling.
    await Promise.all(BUCKETS.map((b) => b.take()));
    // Timeout, not just a retry policy: dispatch in index.mjs is one serialized
    // promise chain, so a socket that never answers doesn't fail this one call — it
    // wedges every later request for the rest of the session, with no error to see.
    const res = await fetch(url, {
      method,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // A sustained 429 is bounded: mcp-trello recursed forever on a flat 1s sleep,
    // which hangs the session with no way to tell it apart from a slow call.
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      // Release the unread body before retrying — an undrained response can hold its
      // connection out of the pool, and we never look at a 429's body.
      await res.body?.cancel?.();
      await sleep(backoffMs(res, attempt));
      continue;
    }

    const body = await res.text();
    if (!res.ok) {
      const gaveUp = res.status === 429 ? ` (gave up after ${MAX_ATTEMPTS} attempts)` : "";
      throw new Error(
        `Trello ${res.status} ${res.statusText}${gaveUp}: ${redact(body).slice(0, 500)}`,
      );
    }

    if (!body.trim()) return { ok: true };
    try {
      return JSON.parse(body);
    } catch {
      return { ok: true, body };
    }
  }
}

// Bounded concurrency: `limit` workers pulling from one shared cursor, results kept
// in input order. Keeps a large placeCards batch from opening a socket per card.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Trello reads an empty `idLabels`/`idMembers` as "clear them all", so an empty
// array has to serialize to the empty string deliberately rather than by way of
// Array#toString happening to produce it. `undefined` means "leave unchanged" and
// buildUrl drops it.
export const csv = (arr) => (arr === undefined || arr === null ? undefined : arr.join(","));
