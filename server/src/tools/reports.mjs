// Read-only views over the numbered hierarchy: a client-ready status report and a
// board map. The arithmetic and the rendering live in utils/rollup.mjs; this file only
// fetches the board and maps tool arguments onto it.

import { resolveBoard, trello } from "../trello/client.mjs";
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

// Four reads, in parallel. Descriptions come along only because acceptance criteria are
// counted from them; none of that text reaches the caller, which gets counts.
async function loadTree(board, doneLists) {
  const [info, lists, cards, checklists] = await Promise.all([
    trello("GET", `/boards/${board}`, { fields: "name" }),
    // filter=all: cards in an archived list still need the list's name to be read as done.
    trello("GET", `/boards/${board}/lists`, { fields: "name", filter: "all" }),
    trello("GET", `/boards/${board}/cards`, {
      fields: "name,shortLink,idList,due,dueComplete,dateLastActivity,desc,labels,closed",
    }),
    trello("GET", `/boards/${board}/checklists`, { fields: "name,idCard", checkItem_fields: "name,state" }),
  ]);

  const checklistsByCard = {};
  for (const list of checklists) (checklistsByCard[list.idCard] ??= []).push(list);

  const tree = buildTree({
    // Archived cards come back with closed: true when the endpoint is asked for them.
    cards: cards.filter((c) => !c.closed),
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
  return { name: info.name, tree, cardCount: cards.length };
}

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
      "progress by epic, stories ready for sign-off (every work item done and acceptance " +
      "criteria present), what is blocked, overdue or idle, and where the open work sits. " +
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
      const warnings = {
        duplicateNumbers: tree.duplicates.length,
        orphans: [...tree.nodes.values()].filter((n) => n.orphan).length,
        // One request reads every card. If Trello returned exactly this many it may have
        // stopped there, so say so instead of presenting partial numbers as the whole board.
        possiblyTruncated: cardCount >= CARD_READ_LIMIT,
      };
      if (format === "json") return { boardId: board, board: name, format, ...report, warnings };
      const notes = [];
      if (warnings.duplicateNumbers || warnings.orphans) {
        notes.push(`${warnings.duplicateNumbers} duplicate and ${warnings.orphans} orphaned card numbers on the board; run auditCardHierarchy.`);
      }
      if (warnings.possiblyTruncated) {
        notes.push(`the board returned ${cardCount} cards, which may be Trello's limit for one request, so this report may be partial.`);
      }
      const note = notes.length ? `\n\n${notes.map((n) => `_Note: ${n}_`).join("\n")}` : "";
      return { boardId: board, board: name, format, report: renderReport(name, report, { now }) + note };
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
      const { name, tree } = await loadTree(board, doneLists);
      const roots = scopeTo(tree, epic);
      const map = format === "mermaid" ? renderMermaid(roots, depth) : renderOutline(roots, depth);
      return { boardId: board, board: name, format, map };
    },
  },
};
