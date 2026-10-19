// Card-to-card attachment and hierarchy tools, plus the link-graph readers they
// share.
//
// The Trello REST API has no card-relations endpoint (checked against the Cards
// resource group: no /relations, /links or /connections), and mcp-trello 0.4.0
// ships no attachment tools. A card linked as an attachment is the closest thing
// Trello has to a relation, and the UI renders it as a card preview.

import { cardRef, pool, resolveBoard, trello } from "../trello/client.mjs";
import {
  cardNumber,
  insertionSlot,
  nextNumbers,
  parentNumber,
  spreadPositions,
} from "../utils/numbering.mjs";

const CARD_URL = /^https:\/\/trello\.com\/c\/([^/?#]+)/i;

// Every board-wide tool reads the same endpoint with one of two field sets: the
// 4-field summary, or name + shortLink + card-link attachments for the link graph.
const SUMMARY = { fields: "idShort,shortLink,name,idList" };
const WITH_LINKS = { fields: "name,shortLink", attachments: true, attachment_fields: "id,url" };
const boardCards = (board, params) => trello("GET", `/boards/${board}/cards`, params);

// Trello always includes `id` regardless of a fields filter — strip to exactly
// these four so findCards' payload can't silently grow. It carried labels, idMembers
// and pos until the snapshot renderer that read them was deleted; nothing consumes
// them now, and at ~250 cards a field nobody reads is pure payload.
export const pickCardSummary = ({ idShort, shortLink, name, idList }) => ({
  idShort,
  shortLink,
  name,
  idList,
});

export function buildLinkGraph(cards) {
  const byShortLink = new Map(cards.map((c) => [c.shortLink, c]));
  const entries = new Map();
  const entryFor = (card) => {
    let entry = entries.get(card.shortLink);
    if (!entry) {
      entry = { shortLink: card.shortLink, name: card.name, attachments: [], attachedTo: [] };
      entries.set(card.shortLink, entry);
    }
    return entry;
  };

  const staleLinkEntries = [];
  const selfLinks = [];
  for (const card of cards) {
    for (const att of card.attachments ?? []) {
      const match = CARD_URL.exec(att.url ?? "");
      if (!match) continue;
      const target = byShortLink.get(match[1]);
      if (!target) {
        // The card holding the dead link, the target it points at, and the
        // attachment id needed to actually detachCard it — a bare count
        // can't be cleaned up without re-reading every card to find it.
        staleLinkEntries.push({ shortLink: card.shortLink, attachmentId: att.id, target: match[1] });
        continue;
      }
      // A card attached to itself is bad data, not an edge (board has one today).
      if (target.shortLink === card.shortLink) {
        selfLinks.push(card.shortLink);
        continue;
      }
      entryFor(card).attachments.push(target.shortLink);
      entryFor(target).attachedTo.push(card.shortLink);
    }
  }
  return { cards: [...entries.values()], staleLinks: staleLinkEntries.length, staleLinkEntries, selfLinks };
}

// Compare the real link graph against what the card numbers imply.
export function auditHierarchy(cards) {
  const graph = buildLinkGraph(cards);
  const entryFor = new Map(graph.cards.map((e) => [e.shortLink, e]));
  const byNumber = new Map();
  let unnumbered = 0;

  for (const card of cards) {
    const n = cardNumber(card.name);
    if (n === null) {
      unnumbered += 1;
      continue;
    }
    if (!byNumber.has(n)) byNumber.set(n, []);
    byNumber.get(n).push(card);
  }

  const label = (short) => {
    const card = cards.find((c) => c.shortLink === short);
    return card ? (cardNumber(card.name) ?? short) : short;
  };

  const result = {
    ok: 0,
    missing: [],
    wrongParent: [],
    parentNotFound: [],
    duplicateNumbers: [],
    selfLinks: graph.selfLinks,
    unnumbered,
  };

  for (const [n, list] of byNumber) {
    if (list.length > 1) {
      result.duplicateNumbers.push({ number: n, shortLinks: list.map((c) => c.shortLink) });
    }
  }

  for (const card of cards) {
    const n = cardNumber(card.name);
    if (n === null) continue;
    const wanted = parentNumber(n);
    if (wanted === null) continue; // top-level epic — nothing to attach to

    const parents = byNumber.get(wanted);
    if (!parents) {
      result.parentNotFound.push({ number: n, shortLink: card.shortLink, expectedParent: wanted });
      continue;
    }

    const allowed = new Set(parents.map((p) => p.shortLink));
    const actual = entryFor.get(card.shortLink)?.attachedTo ?? [];
    if (actual.some((s) => allowed.has(s))) {
      result.ok += 1;
    } else if (actual.length === 0) {
      result.missing.push({
        number: n,
        shortLink: card.shortLink,
        expectedParent: wanted,
        expectedParentShortLinks: [...allowed],
      });
    } else {
      result.wrongParent.push({
        number: n,
        shortLink: card.shortLink,
        expectedParent: wanted,
        expectedParentShortLinks: [...allowed],
        attachedToNumbers: actual.map(label),
        attachedToShortLinks: actual,
      });
    }
  }
  return result;
}

export const TOOLS = {
  attachCard: {
    description:
      "Attach one Trello card to another as a linked attachment, rendered as a card " +
      "preview. Each id accepts a full https://trello.com/c/... URL, a bare shortLink, " +
      "or a 24-char id.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "Card that receives the attachment" },
        attachCardId: { type: "string", description: "Card to attach" },
        name: { type: "string", description: "Attachment label; defaults to the attached card's name" },
      },
      required: ["cardId", "attachCardId"],
    },
    async run({ cardId, attachCardId, name }) {
      const [receiver, target] = await Promise.all([
        trello("GET", `/cards/${cardRef(cardId)}`, { fields: "idBoard,name" }),
        trello("GET", `/cards/${cardRef(attachCardId)}`, { fields: "shortUrl,name,idBoard" }),
      ]);
      // Cross-board links are always a mistake: they render as a dead preview to
      // anyone without access to the other board, and listBoardCardLinks can only
      // see one board so they silently degrade into a stale-link count.
      if (receiver.idBoard !== target.idBoard) {
        throw new Error(
          `Refusing cross-board attach: receiving card is on board ${receiver.idBoard}, ` +
            `card to attach is on board ${target.idBoard}.`,
        );
      }
      return trello("POST", `/cards/${cardRef(cardId)}/attachments`, {
        url: target.shortUrl,
        name: name ?? target.name,
      });
    },
  },

  findCard: {
    description:
      "Find the one card whose name carries a given hierarchy number, e.g. \"2.1\" matches " +
      "`2.1. Centralize locking` but not `2.1.1` and not `2.10`. Returns " +
      "{ number, matches: [{idShort, shortLink, name, idList}] } — the caller decides what " +
      "zero, one or several matches mean. Use this to resolve a parent before planning " +
      "under it: it is one card instead of findCards' whole board. boardId defaults to " +
      "TRELLO_BOARD_ID.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        number: {
          type: "string",
          description: 'Hierarchy number to match, e.g. "8" (matches "EPIC 8. ...") or "2.1"',
        },
        boardId: { type: "string", description: "Board to search; defaults to TRELLO_BOARD_ID" },
      },
      required: ["number"],
    },
    async run({ number, boardId }) {
      const board = resolveBoard(boardId);
      if (!number) throw new Error("number is required");
      const cards = await boardCards(board, SUMMARY);
      // Match on the parsed number, never on a string prefix: "2.1" must not match
      // "2.1.1" (a child) or "2.10" (a sibling), which is exactly what a prefix test
      // gets wrong. cardNumber is the same parser the numbering and parent linkage use.
      const matches = cards
        .filter((c) => cardNumber(c.name) === String(number))
        .map(pickCardSummary);
      return { number: String(number), matches };
    },
  },

  placeCards: {
    description:
      "Move already-created cards into hierarchy order inside a list: place them " +
      "directly after the last card of `underNumber`'s subtree, in the order given. " +
      "Backlog reads epic -> its stories -> each story's tasks -> `---` -> next epic, " +
      "and a new card lands at the bottom of the list unless something moves it. Cards " +
      "already in the subtree count as part of it, so pushing a second batch under the " +
      "same parent lands after the first with no bookkeeping. Returns " +
      "{ placed: [{cardId, pos}], failed: [{cardId, pos, error}], anchor } — one card " +
      "failing to move never discards the moves that succeeded, so check `failed` " +
      "rather than assuming an error means nothing happened. Epic-level cards need none of this — a whole " +
      "epic block appends to the end of the list, which is where new cards go anyway.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        listId: { type: "string", description: "List the cards live in" },
        underNumber: {
          type: "string",
          description: 'Parent hierarchy number to place beneath, e.g. "2.1" or "3"',
        },
        cardIds: {
          type: "array",
          items: { type: "string" },
          description: "Cards to place, in the order they should appear",
        },
      },
      required: ["listId", "underNumber", "cardIds"],
    },
    async run({ listId, underNumber, cardIds }) {
      if (!listId) throw new Error("listId is required");
      if (!underNumber) throw new Error("underNumber is required");
      const ids = (cardIds ?? []).map((c) => cardRef(c)).filter(Boolean);
      if (!ids.length) return { placed: [], anchor: null };

      // shortLink comes along because `ids` may hold either form: cardRef normalises a
      // card URL down to its shortLink, and callers read shortLinks off `addCard`. Fetch
      // only `id` and the exclusion below misses every shortLink it was handed.
      const listCards = await trello("GET", `/lists/${listId}/cards`, {
        fields: "name,pos,shortLink",
      });
      // Exclude the cards being placed: Trello already dropped them at the bottom of
      // the list, so they would otherwise be picked as their own anchor.
      const { anchor, next } = insertionSlot(listCards, underNumber, new Set(ids));
      if (!anchor) {
        throw new Error(
          `No card under "${underNumber}" in that list — nothing to place after. ` +
            "Check the parent number, and that the parent card is in this list.",
        );
      }

      const positions = spreadPositions(anchor.pos, next ? next.pos : null, ids.length);

      // Positions are absolute, not relative to each other, so these don't have to be
      // ordered — sequential round trips inside one tool call would be pure latency.
      // Bounded all the same: an unbounded Promise.all over a 40-card placement opens
      // 40 sockets at once and spends the shared rate-limit budget in one burst.
      //
      // Each PUT catches its own failure. Letting one reject would take the whole
      // pool down with it and report a bare Trello error — while the moves that had
      // already landed stay landed, leaving a half-reordered list and no record of
      // which half. A per-card result says exactly what moved.
      const results = await pool(ids, 4, async (id, i) => {
        try {
          await trello("PUT", `/cards/${id}`, { pos: positions[i] });
          return { cardId: id, pos: positions[i], ok: true };
        } catch (err) {
          return { cardId: id, pos: positions[i], ok: false, error: String(err.message ?? err) };
        }
      });
      return {
        placed: results.filter((r) => r.ok).map(({ cardId, pos }) => ({ cardId, pos })),
        failed: results
          .filter((r) => !r.ok)
          .map(({ cardId, pos, error }) => ({ cardId, pos, error })),
        anchor: { name: anchor.name, pos: anchor.pos },
      };
    },
  },

  findCards: {
    description:
      "List every card on a board as {idShort, shortLink, name, idList} in one " +
      "request. Fields are filtered so the payload stays small " +
      "even at ~200 cards — use this instead of scanning mcp__trello-board__getCardsByList per " +
      "list, which returns full unfiltered card objects and can exceed the tool output cap " +
      "outright. boardId accepts a board URL, shortLink, or 24-char id; defaults to " +
      "TRELLO_BOARD_ID.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "Board to list; defaults to TRELLO_BOARD_ID" },
      },
    },
    async run({ boardId }) {
      const board = resolveBoard(boardId);
      const cards = await boardCards(board, SUMMARY);
      return cards.map(pickCardSummary);
    },
  },

  listCardAttachments: {
    description: "List a card's attachments as [{id, name, url}]. Use to find an attachment id for detachCard.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { cardId: { type: "string", description: "Card to inspect" } },
      required: ["cardId"],
    },
    run: ({ cardId }) =>
      trello("GET", `/cards/${cardRef(cardId)}/attachments`, { fields: "id,name,url" }),
  },

  listBoardCardLinks: {
    description:
      "Map every card-to-card link on a board in one request. Returns " +
      "{ boardId, cards: [{shortLink, name, attachments, attachedTo}], staleLinks, " +
      "staleLinkEntries, selfLinks }, where attachments are cards linked FROM this card " +
      "and attachedTo are cards linking TO it. Only cards with at least one link are " +
      "listed. staleLinks is the count of dropped edges pointing at off-board or deleted " +
      "cards; staleLinkEntries names each one as {shortLink, attachmentId, target} — the " +
      "holding card, and exactly what detachCard needs to remove it. boardId accepts a " +
      "https://trello.com/b/... URL, a shortLink, or a 24-char id; defaults to " +
      "TRELLO_BOARD_ID.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "Board to map; defaults to TRELLO_BOARD_ID" },
      },
    },
    async run({ boardId }) {
      const board = resolveBoard(boardId);
      const cards = await boardCards(board, WITH_LINKS);
      return { boardId: board, ...buildLinkGraph(cards) };
    },
  },

  auditCardHierarchy: {
    description:
      "Check the board's real card-to-card links against the hierarchy implied by card " +
      "numbers: '1' is an epic, '1.1' a story under it, '1.1.2' a task under that, so a " +
      "card's parent is its number minus the last segment. Read-only — reports drift, " +
      "changes nothing. Returns { boardId, ok, missing, wrongParent, parentNotFound, " +
      "duplicateNumbers, selfLinks, unnumbered }, where missing/wrongParent entries carry " +
      "the shortLinks needed to fix them via attachCard/detachCard. boardId defaults to " +
      "TRELLO_BOARD_ID.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "Board to audit; defaults to TRELLO_BOARD_ID" },
      },
    },
    async run({ boardId }) {
      const board = resolveBoard(boardId);
      const cards = await boardCards(board, WITH_LINKS);
      return { boardId: board, ...auditHierarchy(cards) };
    },
  },

  nextCardNumbers: {
    description:
      "Report the number the next card gets, computed off a live board fetch that " +
      "includes archived cards, so a number retired by archiving is never handed out " +
      "again. Returns " +
      "{ nextEpic, nextUnder, staleLinkEntries, selfLinks, staleLinks } — never the card " +
      "list, so the payload is a few lines of JSON instead of the whole board. nextEpic is " +
      "the next free top-level number. nextUnder answers for each prefix passed in " +
      "`under`: { next, parentExists } — treat parentExists false as a typo'd prefix. " +
      "staleLinks/selfLinks report bad attachment data on the board. Nothing is written to " +
      "disk: there is no snapshot file, so there is nothing to go stale. boardId defaults " +
      "to TRELLO_BOARD_ID.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "Board to read; defaults to TRELLO_BOARD_ID" },
        under: {
          type: "array",
          items: { type: "string" },
          description:
            'Parent card numbers to get the next child number for, e.g. ["11.3"] -> "11.3.5". ' +
            "Omit if you only need nextEpic.",
        },
      },
    },
    async run({ boardId, under }) {
      const board = resolveBoard(boardId);

      // Only what the two consumers need: `name` for the numbering, `shortLink` plus
      // the attachments for the link graph. Nothing here is returned to the caller.
      //
      // `filter: "all"` is what makes a retired number stay retired. Trello defaults
      // this endpoint to `visible`, which drops archived cards *and* cards sitting in
      // archived lists — so an archived 9.4.2 is absent from the set, max + 1 hands
      // 9.4.2 straight back out, and the board ends up with two unrelated cards under
      // one number. That is not hypothetical: it had already happened three times here
      // (5.4.2, 6.3.3, 9.7.1) before this argument was added.
      const rawCards = await boardCards(board, {
        ...WITH_LINKS,
        fields: "shortLink,name,closed",
        filter: "all",
      });

      // Numbering wants every card ever issued; the link graph wants only live ones —
      // reporting a stale attachment on a card somebody archived months ago is noise
      // nobody can act on.
      const graph = buildLinkGraph(rawCards.filter((c) => !c.closed));
      return {
        ...nextNumbers(rawCards, under ?? []),
        staleLinkEntries: graph.staleLinkEntries,
        selfLinks: graph.selfLinks,
        staleLinks: graph.staleLinks,
      };
    },
  },

  repairCardHierarchy: {
    description:
      "Attach every card auditCardHierarchy reports as `missing` to its expected " +
      "parent, so the board's real links match the hierarchy its numbers imply. Fixes " +
      "only the missing-link case: a card whose number says it has a parent and which " +
      "nothing currently links to. Returns { boardId, attached, failed, untouched }, " +
      "where untouched carries wrongParent / parentNotFound / duplicateNumbers " +
      "verbatim from the audit — those need a decision, not a default. Pass " +
      "dryRun: true to get the same report with nothing written. boardId defaults to " +
      "TRELLO_BOARD_ID.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "Board to repair; defaults to TRELLO_BOARD_ID" },
        dryRun: {
          type: "boolean",
          description: "Report what would be attached without writing (default: false)",
        },
      },
    },
    async run({ boardId, dryRun = false } = {}) {
      const board = resolveBoard(boardId);
      const cards = await boardCards(board, WITH_LINKS);
      const audit = auditHierarchy(cards);

      // One expected parent per fix. `missing` can name several candidate parents when
      // the board has duplicate numbers; attaching to an arbitrary one would invent a
      // hierarchy the numbers don't determine, so leave those for a human.
      const fixable = [];
      const ambiguous = [];
      for (const entry of audit.missing) {
        (entry.expectedParentShortLinks.length === 1 ? fixable : ambiguous).push(entry);
      }

      const plan = fixable.map((entry) => ({
        number: entry.number,
        child: entry.shortLink,
        parent: entry.expectedParentShortLinks[0],
        expectedParent: entry.expectedParent,
      }));

      const untouched = {
        ambiguousParent: ambiguous,
        wrongParent: audit.wrongParent,
        parentNotFound: audit.parentNotFound,
        duplicateNumbers: audit.duplicateNumbers,
        selfLinks: audit.selfLinks,
      };

      if (dryRun) return { boardId: board, dryRun: true, wouldAttach: plan, failed: [], untouched };

      // Bounded like placeCards: a first repair of a drifted board can be dozens of
      // attaches, and each one is a POST.
      const results = await pool(plan, 4, async (step) => {
        try {
          // The attachment URL is built from the child's shortLink rather than fetched:
          // buildLinkGraph parses exactly this form back out, so the repaired edge is
          // the same edge attachCard would have created, with no extra GET per card.
          await trello("POST", `/cards/${step.parent}/attachments`, {
            url: `https://trello.com/c/${step.child}`,
          });
          return { ...step, ok: true };
        } catch (err) {
          return { ...step, ok: false, error: String(err.message ?? err) };
        }
      });

      return {
        boardId: board,
        dryRun: false,
        attached: results.filter((r) => r.ok),
        failed: results.filter((r) => !r.ok),
        untouched,
      };
    },
  },

  detachCard: {
    description: "Delete an attachment from a card by attachment id.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "Card holding the attachment" },
        attachmentId: { type: "string", description: "Attachment id from listCardAttachments" },
      },
      required: ["cardId", "attachmentId"],
    },
    run: ({ cardId, attachmentId }) =>
      trello("DELETE", `/cards/${cardRef(cardId)}/attachments/${attachmentId}`),
  },
};
