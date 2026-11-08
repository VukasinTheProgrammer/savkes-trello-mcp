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

  const tree = buildTree({
    cards,
    lists: Object.fromEntries(lists.map((l) => [l.id, l.name])),
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
  return { name: info.name, tree, cardCount: cards.length, cards, checklistsByCard };
}

// Every comment on the board, grouped by card, in whole pages of Trello's maximum size,
// newest first, each page continuing `before` the oldest action of the last. Capped, because
// a board with endless comments must not turn one call into an endless loop; when the cap
// is hit the caller is told, since a "deployed" comment further back would then be missed.
const COMMENT_PAGE = 1000;
const COMMENT_PAGES = 10;

async function loadComments(board) {
  const byCard = new Map();
  let before;
  let firstId;
  for (let pages = 1; ; pages++) {
    const page = await trello("GET", `/boards/${board}/actions`, {
      filter: "commentCard",
      limit: COMMENT_PAGE,
      // No `fields` filter: paging continues from each action's `id`, so it must always be there.
      memberCreator: false,
      before,
    });
    const actions = Array.isArray(page) ? page : [];
    // If Trello ever ignored `before`, every page would be the first one again. Stop and say
    // the read is incomplete rather than count the same comments ten times.
    if (before && actions[0]?.id === firstId) return { byCard, truncated: true };
    if (!before) firstId = actions[0]?.id;
    for (const action of actions) {
      const cardId = action.data?.card?.id;
      if (!cardId) continue;
      if (!byCard.has(cardId)) byCard.set(cardId, []);
      byCard.get(cardId).push({ text: action.data?.text ?? "", date: action.date });
    }
    if (actions.length < COMMENT_PAGE) return { byCard, truncated: false };
    if (pages >= COMMENT_PAGES) return { byCard, truncated: true };
    before = actions.at(-1).id;
  }
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
      "getStatusReport. It does four things. (1) Next to the usual percent-done it gives a " +
      "second number, done with evidence: a work item counts only if it sits in a Done-style list AND " +
      "its card carries evidence, which is a pull-request link attached, a comment saying it " +
      "was deployed, or a Definition of Done checklist with every item ticked. (2) It lists " +
      "stories that look ready for sign-off because every work item under them is Done, but " +
      "where none of those work items shows any evidence. (3) It reads the team rule the same " +
      "way on every call: a Done card has a pull request attached and its acceptance-criteria " +
      "checklist ticked, and a Blocked card names exactly one member and has one sentence (its " +
      "newest comment) saying why; cards that break it are listed. (4) The rule and the " +
      "evidence definitions are printed with every result, so they cannot drift between runs. " +
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
      const [{ name, tree, cardCount, cards, checklistsByCard }, comments] = await Promise.all([
        loadTree(board, doneLists, {
          extraCardFields: "idMembers",
          extraCardParams: { attachments: true, attachment_fields: "url" },
        }),
        loadComments(board),
      ]);
      const facts = indexFacts(cards, checklistsByCard, comments.byCard);
      const audit = buildOutcomeAudit(scopeTo(tree, epic), facts, { exemptLabels });
      const warnings = { ...boardWarnings(tree, cardCount), commentsPossiblyTruncated: comments.truncated };
      if (format === "json") return { boardId: board, board: name, format, ...audit, warnings };
      const notes = boardNotes(warnings, cardCount);
      if (warnings.commentsPossiblyTruncated) {
        notes.push(
          `the board has more comments than were read (${COMMENT_PAGES * COMMENT_PAGE}), so a "deployed" comment or a Blocked reason further back may be missed; the numbers above may be incomplete.`,
        );
      }
      return {
        boardId: board,
        board: name,
        format,
        report: renderOutcomeAudit(name, audit) + noteBlock(notes),
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
