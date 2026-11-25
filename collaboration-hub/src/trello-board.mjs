/** Read-only loader for the real Trello board the hub coordinates around.
 *
 * The hub reads TRELLO_API_KEY, TRELLO_TOKEN and TRELLO_BOARD_ID (from the repo-root
 * .env). With all three set, the dashboard lists the board's real open cards and the hub
 * only accepts claims on cards that exist on that board. Without them the hub runs in
 * demo mode and accepts any typed card ID.
 */
import { redactSecrets as redact } from './utils/formatters.mjs';

const API = 'https://api.trello.com/1';
const CACHE_MS = 30_000;

export function boardConfigured(env = process.env) {
  return Boolean(env.TRELLO_API_KEY && env.TRELLO_TOKEN && env.TRELLO_BOARD_ID);
}


export async function fetchBoard({ key, token, boardId, fetchImpl = fetch }) {
  const auth = new URLSearchParams({ key, token });
  const get = async (path, params) => {
    const res = await fetchImpl(`${API}${path}?${auth}&${new URLSearchParams(params)}`);
    if (!res.ok) throw new Error(`Trello returned ${res.status} for ${path.split('?')[0]}`);
    return res.json();
  };
  const id = encodeURIComponent(boardId);
  const [board, lists, cards] = await Promise.all([
    get(`/boards/${id}`, { fields: 'name,url' }),
    get(`/boards/${id}/lists`, { fields: 'name,pos', filter: 'open' }),
    get(`/boards/${id}/cards`, { fields: 'name,idList,shortLink,url,idMembers,pos', filter: 'open' }),
  ]);
  const listName = new Map(lists.map((l) => [l.id, l.name]));
  return {
    id: board.id,
    name: board.name,
    url: board.url,
    lists: lists.map((l) => ({ id: l.id, name: l.name })),
    cards: cards.map((c) => ({
      id: c.id, name: c.name, shortLink: c.shortLink, url: c.url,
      idList: c.idList, list: listName.get(c.idList) || '', members: c.idMembers?.length || 0,
    })),
    loadedAt: new Date().toISOString(),
  };
}

/** Cached board with a single in-flight request, so many tabs don't hammer Trello. */
export function createBoardCache({ env = process.env, fetchImpl = fetch, cacheMs = CACHE_MS } = {}) {
  let cached = null;
  let cachedAt = 0;
  let inFlight = null;
  let lastError = null;

  async function get({ force = false } = {}) {
    if (!boardConfigured(env)) return { mode: 'demo', message: 'Trello is not configured; set TRELLO_API_KEY, TRELLO_TOKEN and TRELLO_BOARD_ID in .env to load the real board.' };
    if (!force && cached && Date.now() - cachedAt < cacheMs) return { mode: 'trello', board: cached };
    inFlight ||= fetchBoard({ key: env.TRELLO_API_KEY, token: env.TRELLO_TOKEN, boardId: env.TRELLO_BOARD_ID, fetchImpl })
      .then((board) => { cached = board; cachedAt = Date.now(); lastError = null; return board; })
      .catch((err) => { lastError = redact(err.message); throw err; })
      .finally(() => { inFlight = null; });
    try {
      return { mode: 'trello', board: await inFlight };
    } catch {
      // Keep serving the last good copy if Trello is briefly unreachable.
      if (cached) return { mode: 'trello', board: cached, stale: true, error: lastError };
      return { mode: 'error', error: lastError };
    }
  }

  /** null = cannot check (demo mode or board never loaded); otherwise the card or undefined. */
  function findCard(cardId) {
    if (!cached) return null;
    return cached.cards.find((c) => c.id === cardId || c.shortLink === cardId);
  }

  return { get, findCard, configured: () => boardConfigured(env) };
}
