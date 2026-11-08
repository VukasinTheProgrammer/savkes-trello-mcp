// Read-only views over the numbered hierarchy: a client-ready status report and a
// board map. The arithmetic and the rendering live in utils/rollup.mjs; this file only
// fetches the board and maps tool arguments onto it.

import { resolveBoard, trello } from "../trello/client.mjs";
import { buildOutcomeAudit, indexFacts, renderOutcomeAudit } from "../utils/outcome.mjs";
import {
  buildReport,
  buildTree,
  doneListTest,
  renderMermaid,
  renderOutline,
  renderReport,
  scopeTo,
} from "../utils/rollup.mjs";

const CARD_READ_LIMIT = 1000;

// Reads in parallel. Descriptions and checklists are only needed to count acceptance
// criteria, so the board map (criteria: false) skips both; the report reads them and
// returns counts, never the text. `extraCardFields` and `extraCardParams` let the outcome
// audit ask for members and attachments on the same single cards request.
async function loadTree(board, doneLists, { criteria = true, extraCardFields = "", extraCardParams = {} } = {}) {
  const [info, lists, cards, checklists] = await Promise.all([
    trello("GET", `/boards/${board}`, { fields: "name" }),
    // filter=all, so a card is never shown under "(unknown list)" because its list was archived.
    trello("GET", `/boards/${board}/lists`, { fields: "name", filter: "all" }),
    // Trello's default "visible" filter already leaves archived cards out.
    trello("GET", `/boards/${board}/cards`, {
      fields: `name,shortLink,idList,due,dueComplete,dateLastActivity,labels${criteria ? ",desc" : ""}${extraCardFields ? `,${extraCardFields}` : ""}`,
      ...extraCardParams,
    }),
    criteria
      ? trello("GET", `/boards/${board}/checklists`, { fields: "name,idCard", checkItem_fields: "name,state" })
      : [],
  ]);

  const checklistsByCard = {};
  for (const list of checklists) (checklistsByCard[list.idCard] ??= []).push(list);

  const listNames = Object.fromEntries(lists.map((l) => [l.id, l.name]));
  const tree = buildTree({
    cards,
    lists: listNames,
    checklists: checklistsByCard,
    isDoneList: doneListTest(doneLists),
  });
  if (!tree.roots.length) {
    throw new Error(
      `No numbered cards on this board (${cards.length} cards, none named like "EPIC 1. …", ` +
        '"1.1. …" or "1.1.1. …"). These tools read that numbering; run auditCardHierarchy or ' +
        "findCards to see what the cards are called.",
    );
  }
  return { name: info.name, tree, cardCount: cards.length, cards, checklistsByCard, listNames };
}

// Board actions of one kind, newest first, in whole pages of Trello's maximum size, each
// page continuing `before` the oldest action of the last; `onAction` sees every action.
// Capped, because a board with endless history must not turn one call into an endless loop;
// when the cap is hit the caller is told, since a "deployed" comment or a move into Done
// further back would then be missed.
const ACTION_PAGE = 1000;
const ACTION_PAGES = 10;

async function loadActions(board, filter, onAction) {
  let before;
  let firstId;
  for (let pages = 1; ; pages++) {
    const page = await trello("GET", `/boards/${board}/actions`, {
      filter,
      limit: ACTION_PAGE,
      // No `fields` filter: paging continues from each action's `id`, so it must always be there.
      memberCreator: false,
      before,
    });
    const actions = Array.isArray(page) ? page : [];
    // If Trello ever ignored `before`, every page would be the first one again. Stop and say
    // the read is incomplete rather than count the same actions ten times.
    if (before && actions[0]?.id === firstId) return { truncated: true };
    if (!before) firstId = actions[0]?.id;
    actions.forEach(onAction);
    if (actions.length < ACTION_PAGE) return { truncated: false };
    if (pages >= ACTION_PAGES) return { truncated: true };
    before = actions.at(-1).id;
  }
}

// Every comment on the board, grouped by card.
async function loadComments(board) {
  const byCard = new Map();
  const { truncated } = await loadActions(board, "commentCard", (action) => {
    const cardId = action.data?.card?.id;
    if (!cardId) return;
    if (!byCard.has(cardId)) byCard.set(cardId, []);
    byCard.get(cardId).push({ text: action.data?.text ?? "", date: action.date });
  });
  return { byCard, truncated };
}

// When each Done card became Done: card id -> ISO date. A card is Done by sitting in a Done
// list or by a ticked due date, the same two ways buildTree counts it, so both are read in
// one paged request. Actions come newest first, so a card's first list action (a move or its
// creation) is where it sits now: it starts the clock only if that put it in Done. Likewise
// the newest due-date change counts only if it ticked the date. With both, the earlier one
// is when the card became Done. A card with neither (history out of reach) has no date.
async function loadDoneSince(board, doneLists, cards, listNames) {
  const isDoneList = doneListTest(doneLists);
  const intoList = new Map();
  const ticked = new Map();
  const { truncated } = await loadActions(board, "createCard,updateCard:idList,updateCard:dueComplete", (action) => {
    const card = action.data?.card;
    if (!card?.id) return;
    if (action.type === "createCard" || action.data?.listAfter) {
      const into = action.type === "createCard" ? action.data?.list?.name : action.data.listAfter.name;
      if (!intoList.has(card.id)) intoList.set(card.id, isDoneList(into) ? action.date : null);
    } else if (action.data?.old && "dueComplete" in action.data.old) {
      if (!ticked.has(card.id)) ticked.set(card.id, card.dueComplete === true ? action.date : null);
    }
  });
  const since = new Map();
  for (const card of cards) {
    const dates = [];
    if (isDoneList(listNames[card.idList])) dates.push(intoList.get(card.id));
    if (card.dueComplete === true) dates.push(ticked.get(card.id));
    const known = dates.filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
    if (known.length) since.set(card.id, known[0]);
  }
  return { since, truncated };
}

// What the board says about itself that a reader should know before trusting the numbers.
const boardWarnings = (tree, cardCount) => ({
  duplicateNumbers: tree.duplicates.length,
  orphans: [...tree.nodes.values()].filter((n) => n.orphan).length,
  // One request reads every card. If Trello returned exactly this many it may have
  // stopped there, so say so instead of presenting partial numbers as the whole board.
  possiblyTruncated: cardCount >= CARD_READ_LIMIT,
});

const boardNotes = (warnings, cardCount) => {
  const notes = [];
  if (warnings.duplicateNumbers || warnings.orphans) {
    notes.push(`${warnings.duplicateNumbers} duplicate and ${warnings.orphans} orphaned card numbers on the board; run auditCardHierarchy.`);
  }
  if (warnings.possiblyTruncated) {
    notes.push(`the board returned ${cardCount} cards, which may be Trello's limit for one request, so this report may be partial.`);
  }
  return notes;
};

const noteBlock = (notes) => (notes.length ? `\n\n${notes.map((n) => `_Note: ${n}_`).join("\n")}` : "");

const oneOf = (name, value, allowed) => {
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of ${allowed.map((a) => `"${a}"`).join(", ")}, got "${value}"`);
  }
};

const boardProp = { type: "string", description: "Board to read; defaults to TRELLO_BOARD_ID" };
const epicProp = {
  type: "string",
  description: 'Limit to one card\'s subtree by hierarchy number, e.g. "2" or "2.1". Omit for the whole board',
};

export const TOOLS = {
  getStatusReport: {
    description:
      "Client-ready delivery status for a board that uses the numbered hierarchy (EPIC 1 -> " +
      "1.1 story -> 1.1.1 task). Progress is rolled up from the work items (cards with no " +
      "children), so epic and story percentages are computed from the board, not estimated. " +
      "A card counts as done when it sits in a Done-style list or its due date is ticked " +
      "complete; pass doneLists if the board names that list differently. By default " +
      "returns { boardId, board, format, report } where report is a markdown write-up: " +
      "progress by epic (items, each with its tier), stories ready for sign-off (every work item done and acceptance " +
      "criteria present), what is blocked, overdue or idle, cards whose parent number is " +
      "missing, and where the open work sits. " +
      "With format \"json\" it returns the same numbers as structured fields instead. " +
      "Read-only. Use getBoardMap to see the tree itself and auditCardHierarchy to check " +
      "that the card links match the numbers. boardId defaults to TRELLO_BOARD_ID.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        boardId: boardProp,
        epic: epicProp,
        format: {
          type: "string",
          description: '"markdown" (default; ready to paste into an update) or "json"',
        },
        staleDays: {
          type: "number",
          description: "Days without activity before an open work item is called idle (default: 14)",
        },
        doneLists: {
          type: "array",
          items: { type: "string" },
          description: "Exact names of the lists that hold finished work, e.g. [\"Shipped\"]. Default: Done, Completed, Shipped, Released, Closed",
        },
      },
    },
    async run({ boardId, epic, format = "markdown", staleDays = 14, doneLists } = {}) {
      oneOf("format", format, ["markdown", "json"]);
      if (!(staleDays > 0)) throw new Error(`staleDays must be a positive number, got ${staleDays}`);
      const board = resolveBoard(boardId);
      const { name, tree, cardCount } = await loadTree(board, doneLists);
      const now = Date.now();
      const report = buildReport(scopeTo(tree, epic), { now, staleDays });
      const warnings = boardWarnings(tree, cardCount);
      if (format === "json") return { boardId: board, board: name, format, ...report, warnings };
      return {
        boardId: board,
        board: name,
        format,
        report: renderReport(name, report, { now }) + noteBlock(boardNotes(warnings, cardCount)),
      };
    },
  },

  getOutcomeAudit: {
    description:
      "Checks whether work marked Done has evidence behind it, reading only Trello. Works on " +
      "boards that use the numbered hierarchy (EPIC 1 -> 1.1 story -> 1.1.1 task), like " +
      "getStatusReport. It does five things. (1) Next to the usual percent-done it gives a " +
      "second number, done with evidence: a work item counts only if it sits in a Done-style list AND " +
      "its card carries evidence, which is a pull-request link attached, a comment saying it " +
      "was deployed, or a Definition of Done checklist with every item ticked. (2) It lists " +
      "stories that look ready for sign-off because every work item under them is Done, but " +
      "where none of those work items shows any evidence. (3) It reads the team rule the same " +
      "way on every call: a Done card has a pull request attached and its acceptance-criteria " +
      "checklist ticked, and a Blocked card names exactly one member and has one sentence (its " +
      "newest comment) saying why; cards that break it are listed. (4) It shows how long " +
      "each Done card without evidence has been waiting, oldest first, counted from the day it " +
      "became Done (moved into a Done list, created there, or its due date ticked). (5) The rule and the evidence definitions are printed with every " +
      "result, so they cannot drift between runs. " +
      "Evidence means a link or a note is on the card, not that the pull request was merged. " +
      "Read-only: nothing is moved or changed, cards are reported and people are not (no " +
      "member names, ids or comment text come back). By default returns { boardId, board, " +
      "format, report } with report as markdown; with format \"json\" it returns the same " +
      "numbers as structured fields. Use getStatusReport for the delivery report itself. " +
      "boardId defaults to TRELLO_BOARD_ID.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        boardId: boardProp,
        epic: epicProp,
        format: {
          type: "string",
          description: '"markdown" (default; ready to paste into an update) or "json"',
        },
        doneLists: {
          type: "array",
          items: { type: "string" },
          description: "Exact names of the lists that hold finished work, e.g. [\"Shipped\"]. Default: Done, Completed, Shipped, Released, Closed",
        },
        exemptLabels: {
          type: "array",
          items: { type: "string" },
          description:
            'Label names for work that never has a pull request, e.g. ["Design", "Docs"]. A Done card with one of them is not listed under "Done without a pull request"; a ticked Definition of Done or a deployed comment still counts as its evidence. Default: none',
        },
      },
    },
    async run({ boardId, epic, format = "markdown", doneLists, exemptLabels = [] } = {}) {
      oneOf("format", format, ["markdown", "json"]);
      const board = resolveBoard(boardId);
      // Comments come from their own paged request; everything else is the same four reads
      // the status report makes, plus members and attachment links on the cards.
      const [{ name, tree, cardCount, cards, checklistsByCard, listNames }, comments] = await Promise.all([
        loadTree(board, doneLists, {
          extraCardFields: "idMembers",
          extraCardParams: { attachments: true, attachment_fields: "url" },
        }),
        loadComments(board),
      ]);
      const now = Date.now();
      const roots = scopeTo(tree, epic);
      const audit = (since) =>
        buildOutcomeAudit(roots, indexFacts(cards, checklistsByCard, comments.byCard, since), { exemptLabels, now });
      // The card history is only read when a Done card without evidence needs a waiting time.
      let result = audit(new Map());
      let moves = { truncated: false };
      if (result.waiting.count) {
        moves = await loadDoneSince(board, doneLists, cards, listNames);
        result = audit(moves.since);
      }
      const warnings = {
        ...boardWarnings(tree, cardCount),
        commentsPossiblyTruncated: comments.truncated,
        movesPossiblyTruncated: moves.truncated,
      };
      if (format === "json") return { boardId: board, board: name, format, ...result, warnings };
      const notes = boardNotes(warnings, cardCount);
      if (warnings.commentsPossiblyTruncated) {
        notes.push(
          `the board has more comments than were read (${ACTION_PAGES * ACTION_PAGE}), so a "deployed" comment or a Blocked reason further back may be missed; the numbers above may be incomplete.`,
        );
      }
      if (warnings.movesPossiblyTruncated) {
        notes.push(
          `the board has more card moves and due-date changes than were read (${ACTION_PAGES * ACTION_PAGE}), so some waiting times may be missing.`,
        );
      }
      return {
        boardId: board,
        board: name,
        format,
        report: renderOutcomeAudit(name, result, { now }) + noteBlock(notes),
      };
    },
  },

  getBoardMap: {
    description:
      "Draw the board's numbered hierarchy as one picture: every epic, its stories and their " +
      "tasks, with each parent's progress rolled up from the work items beneath it and each " +
      "work item showing the list it sits in. format \"outline\" (default) is an indented " +
      "text tree that reads anywhere; \"mermaid\" is a flowchart, coloured by progress, to " +
      "show inside a ```mermaid block. Returns { boardId, board, format, map }. Use epic to " +
      "map one subtree and depth to stop at epics (1) or stories (2) on a large board. " +
      "Read-only. Use getStatusReport for a written summary and findCards for the flat card " +
      "list. boardId defaults to TRELLO_BOARD_ID.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        boardId: boardProp,
        epic: epicProp,
        format: { type: "string", description: '"outline" (default) or "mermaid"' },
        depth: {
          type: "number",
          description: "Deepest level to draw: 1 epics, 2 stories, 3 tasks (default: 3)",
        },
        doneLists: {
          type: "array",
          items: { type: "string" },
          description: "Exact names of the lists that hold finished work. Default: Done, Completed, Shipped, Released, Closed",
        },
      },
    },
    async run({ boardId, epic, format = "outline", depth = 3, doneLists } = {}) {
      oneOf("format", format, ["outline", "mermaid"]);
      if (!Number.isInteger(depth) || depth < 1) throw new Error(`depth must be a whole number of 1 or more, got ${depth}`);
      const board = resolveBoard(boardId);
      const { name, tree } = await loadTree(board, doneLists, { criteria: false });
      const roots = scopeTo(tree, epic);
      const map = format === "mermaid" ? renderMermaid(roots, depth) : renderOutline(roots, depth);
      return { boardId: board, board: name, format, map };
    },
  },
};
