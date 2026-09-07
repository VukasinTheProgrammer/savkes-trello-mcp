// The 16 tools ported from mcp-trello 0.4.0's `registerTrelloTools`.
//
// Each inputSchema is hand-written from that tool's zod raw shape, keeping the
// `.describe()` text verbatim so the tool surface reads identically to callers.
// Behaviour differences from mcp-trello, all deliberate:
//
//   - board references go through `resolveBoard` instead of a raw `this.boardId`,
//     so `addList` no longer hard-rejects anything that isn't 24 characters
//   - array parameters serialize through `csv`, so `[]` clears labels/members on
//     purpose rather than as a side effect of Array#toString
//   - `addCard` also accepts the `desc`/`idLabels` spellings, which older plan
//     files and trello-card-push's docs used
//   - responses are the raw parsed API payload; server.mjs does the JSON wrapping

import { cardRef, csv, resolveBoard, trello } from "../trello/client.mjs";

export const TOOLS = {
  getMyBoards: {
    description: "Get all boards for the authenticated user (useful for finding board IDs)",
    inputSchema: { type: "object", properties: {} },
    run: () => trello("GET", "/members/me/boards"),
  },

  getCard: {
    description: "Get a specific card by ID with optional comments",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "The ID of the card to retrieve" },
        includeComments: {
          type: "boolean",
          description: "Whether to include comments on the card (default: false)",
        },
      },
      required: ["cardId"],
    },
    run: ({ cardId, includeComments = false }) =>
      trello("GET", `/cards/${cardRef(cardId)}`, {
        actions: includeComments ? "commentCard" : undefined,
      }),
  },

  getCardsByList: {
    description:
      "Get cards by list ID, returning {idShort, shortLink, name, idList} per card. " +
      "Pass `fields` to ask for something else, or \"all\" for the full card object — " +
      "note that an unfiltered read of a large list can exceed the tool output cap " +
      "outright, which is why the filtered set is the default. To read a whole board " +
      "rather than one list, use findCards instead of calling this per list.",
    inputSchema: {
      type: "object",
      properties: {
        listId: { type: "string", description: "The ID of the Trello list to get cards from" },
        fields: {
          type: "string",
          description:
            'Comma-separated Trello card fields, or "all" for every field. ' +
            'Defaults to "idShort,shortLink,name,idList".',
        },
      },
      required: ["listId"],
    },
    // Filtered by default rather than on request: mcp-trello passed no `fields` at
    // all, and an unfiltered list read is what put 369,976 characters through
    // getMyCards. A caller who wants everything back can still say so with "all",
    // so the escape hatch costs one argument instead of a second tool.
    run: ({ listId, fields = "idShort,shortLink,name,idList" }) =>
      trello("GET", `/lists/${listId}/cards`, { fields }),
  },

  getLists: {
    description: "Get all lists from a board; defaults to TRELLO_BOARD_ID",
    inputSchema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "Board to read; defaults to TRELLO_BOARD_ID" },
      },
    },
    run: ({ boardId } = {}) => trello("GET", `/boards/${resolveBoard(boardId)}/lists`),
  },

  getRecentActivity: {
    description: "Get recent activity from a board; defaults to TRELLO_BOARD_ID",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of activity items to return (default: 10)",
        },
        boardId: { type: "string", description: "Board to read; defaults to TRELLO_BOARD_ID" },
      },
    },
    run: ({ limit = 10, boardId } = {}) =>
      trello("GET", `/boards/${resolveBoard(boardId)}/actions`, { limit }),
  },

  addCard: {
    description: "Add a new card to a list",
    inputSchema: {
      type: "object",
      properties: {
        listId: { type: "string", description: "The ID of the list to add the card to" },
        name: { type: "string", description: "The name/title of the card" },
        description: {
          type: "string",
          description: "The description/details of the card (optional)",
        },
        dueDate: {
          type: "string",
          description: "Due date in ISO 8601 format (e.g., 2024-12-31T23:59:59Z)",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Array of label IDs to add to the card",
        },
        // Aliases, not part of mcp-trello's zod shape: trello-card-push's docs and
        // older plan files spell these the way the Trello API does. Declared here
        // so argument validation accepts them instead of rejecting them by name.
        desc: { type: "string", description: "Alias for `description`" },
        idLabels: {
          type: "array",
          items: { type: "string" },
          description: "Alias for `labels`",
        },
      },
      required: ["listId", "name"],
    },
    run: ({ listId, name, description, dueDate, labels, desc, idLabels }) =>
      trello("POST", "/cards", {
        idList: listId,
        name,
        desc: description ?? desc,
        due: dueDate,
        idLabels: csv(labels ?? idLabels),
      }),
  },

  updateCard: {
    description: "Update an existing card",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "The ID of the card to update" },
        name: { type: "string", description: "New name/title for the card" },
        description: { type: "string", description: "New description/details for the card" },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Array of label IDs to set on the card",
        },
        position: {
          type: "string",
          description: "New position: 'top', 'bottom', or a positive number",
        },
        dueDate: { type: "string", description: "New due date in ISO 8601 format" },
        startDate: { type: "string", description: "New start date in ISO 8601 format" },
      },
      required: ["cardId"],
    },
    run: ({ cardId, name, description, labels, position, dueDate, startDate }) =>
      trello("PUT", `/cards/${cardRef(cardId)}`, {
        name,
        desc: description,
        idLabels: csv(labels),
        pos: position,
        due: dueDate,
        start: startDate,
      }),
  },

  moveCard: {
    description: "Move a card to a different list",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "The ID of the card to move" },
        listId: { type: "string", description: "The ID of the destination list" },
        boardId: {
          type: "string",
          description: "The ID of the destination board (if moving to a different board)",
        },
      },
      required: ["cardId", "listId"],
    },
    run: ({ cardId, listId, boardId }) =>
      trello("PUT", `/cards/${cardRef(cardId)}`, {
        idList: listId,
        idBoard: boardId === undefined ? undefined : cardRef(boardId),
      }),
  },

  changeCardMembers: {
    description: "Change the members of a card",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "The ID of the card to modify" },
        members: {
          type: "array",
          items: { type: "string" },
          description: "Array of member IDs to assign to the card",
        },
      },
      required: ["cardId", "members"],
    },
    run: ({ cardId, members }) =>
      trello("PUT", `/cards/${cardRef(cardId)}`, { idMembers: csv(members) }),
  },

  archiveCard: {
    description: "Archive a card",
    inputSchema: {
      type: "object",
      properties: { cardId: { type: "string", description: "The ID of the card to archive" } },
      required: ["cardId"],
    },
    run: ({ cardId }) => trello("PUT", `/cards/${cardRef(cardId)}`, { closed: true }),
  },

  unarchiveCard: {
    description:
      "Return an archived card to its list. The card keeps its list, position, " +
      "labels and attachments — archiving hides a card, it does not dismantle it.",
    inputSchema: {
      type: "object",
      properties: { cardId: { type: "string", description: "The ID of the card to unarchive" } },
      required: ["cardId"],
    },
    run: ({ cardId }) => trello("PUT", `/cards/${cardRef(cardId)}`, { closed: false }),
  },

  addList: {
    description: "Add a new list to a board; defaults to TRELLO_BOARD_ID",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the new list" },
        boardId: { type: "string", description: "Board to add to; defaults to TRELLO_BOARD_ID" },
      },
      required: ["name"],
    },
    run: ({ name, boardId }) =>
      trello("POST", "/lists", { name, idBoard: resolveBoard(boardId) }),
  },

  archiveList: {
    description: "Archive a list",
    inputSchema: {
      type: "object",
      properties: { listId: { type: "string", description: "The ID of the list to archive" } },
      required: ["listId"],
    },
    run: ({ listId }) => trello("PUT", `/lists/${listId}/closed`, { value: true }),
  },

  addComment: {
    description: "Add a comment to a card",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "The ID of the card to comment on" },
        text: { type: "string", description: "The text content of the comment" },
      },
      required: ["cardId", "text"],
    },
    run: ({ cardId, text }) =>
      trello("POST", `/cards/${cardRef(cardId)}/actions/comments`, { text }),
  },

  updateComment: {
    description: "Update the text of an existing comment",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "The ID of the card" },
        commentId: { type: "string", description: "The ID of the comment action to update" },
        text: { type: "string", description: "The new text content for the comment" },
      },
      required: ["cardId", "commentId", "text"],
    },
    run: ({ cardId, commentId, text }) =>
      trello("PUT", `/cards/${cardRef(cardId)}/actions/${commentId}/comments`, { text }),
  },

  deleteComment: {
    description: "Delete a comment from a card",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "The ID of the card" },
        commentId: { type: "string", description: "The ID of the comment action to delete" },
      },
      required: ["cardId", "commentId"],
    },
    run: ({ cardId, commentId }) =>
      trello("DELETE", `/cards/${cardRef(cardId)}/actions/${commentId}/comments`),
  },

  getMyCards: {
    description: "Get cards assigned to the authenticated user",
    inputSchema: { type: "object", properties: {} },
    run: () => trello("GET", "/members/me/cards"),
  },

  // --- Beyond mcp-trello 0.4.0 -------------------------------------------------
  //
  // These have no counterpart in the ported surface. The first two exist so
  // trello-board-ids.md's hand-maintained label and list tables stop being the only
  // way to resolve a name to an id — that file says of itself that it "goes stale by
  // design". The checklist tools are new capability: mcp-trello shipped none, and
  // Given/When/Then acceptance criteria map onto real Trello checklists far better
  // than onto markdown bullets buried in a card description.

  getLabels: {
    description:
      "List every label on a board as [{id, name, color}]. Use this to resolve a " +
      "label name to the idLabels value addCard/updateCard need, instead of reading a " +
      "checked-in table that goes stale when someone edits labels in Trello. boardId " +
      "accepts a board URL, shortLink, or 24-char id; defaults to TRELLO_BOARD_ID.",
    inputSchema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "Board to read; defaults to TRELLO_BOARD_ID" },
      },
    },
    run: ({ boardId } = {}) =>
      trello("GET", `/boards/${resolveBoard(boardId)}/labels`, { fields: "id,name,color" }),
  },

  getBoardMembers: {
    description:
      "List a board's members as [{id, fullName, username}]. Use this to resolve a " +
      "teammate's name to the member id changeCardMembers needs, or to map the " +
      "idMemberCreator on a getRecentActivity entry back to a person. boardId defaults " +
      "to TRELLO_BOARD_ID.",
    inputSchema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "Board to read; defaults to TRELLO_BOARD_ID" },
      },
    },
    run: ({ boardId } = {}) =>
      trello("GET", `/boards/${resolveBoard(boardId)}/members`, {
        fields: "id,fullName,username",
      }),
  },

  getCardChecklists: {
    description:
      "List a card's checklists with their items, as [{id, name, checkItems: [{id, " +
      "name, state, pos}]}]. Use it to find the checklistId addChecklistItem needs when " +
      "adding to a checklist that already exists.",
    inputSchema: {
      type: "object",
      properties: { cardId: { type: "string", description: "Card to inspect" } },
      required: ["cardId"],
    },
    run: ({ cardId }) =>
      trello("GET", `/cards/${cardRef(cardId)}/checklists`, {
        fields: "id,name",
        checkItem_fields: "id,name,state,pos",
      }),
  },

  addChecklist: {
    description:
      "Add a checklist to a card and return it, including its id. Trello renders a " +
      "checklist as real checkboxes with a progress count on the card face, which is " +
      "what markdown bullets in a description cannot do. Pass the returned id to " +
      "addChecklistItem.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "Card to add the checklist to" },
        name: { type: "string", description: "Checklist title, e.g. \"Acceptance Criteria\"" },
      },
      required: ["cardId", "name"],
    },
    run: ({ cardId, name }) =>
      trello("POST", `/cards/${cardRef(cardId)}/checklists`, { name }),
  },

  updateChecklistItem: {
    description:
      "Tick, untick or rename one checklist item. Takes the CARD id plus the check " +
      "item id — Trello's update endpoint is card-scoped, so a checklistId is the one " +
      "id that does not work here. Both ids come from getCardChecklists: the card you " +
      "asked about, and checkItems[].id inside it. state is \"complete\" or " +
      "\"incomplete\"; pass name to reword an item without touching its state.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "Card holding the checklist" },
        checkItemId: {
          type: "string",
          description: "Check item to update, from getCardChecklists' checkItems[].id",
        },
        state: {
          type: "string",
          description: 'Either "complete" or "incomplete"; omit to leave unchanged',
        },
        name: { type: "string", description: "New item text; omit to leave unchanged" },
      },
      required: ["cardId", "checkItemId"],
    },
    run: ({ cardId, checkItemId, state, name }) => {
      // Checked here rather than left to Trello: `state` reaches the API as a query
      // string, and an unrecognised value is ignored rather than rejected — the call
      // returns 200 with the item untouched, which reads as a successful tick.
      if (state !== undefined && state !== "complete" && state !== "incomplete") {
        throw new Error(`state must be "complete" or "incomplete", got ${JSON.stringify(state)}`);
      }
      if (state === undefined && name === undefined) {
        throw new Error("updateChecklistItem needs at least one of state or name");
      }
      return trello("PUT", `/cards/${cardRef(cardId)}/checkItem/${checkItemId}`, { state, name });
    },
  },

  deleteChecklist: {
    description:
      "Delete a checklist and every item on it. Permanent — Trello has no undo for " +
      "this, and the items go with it. To remove one item instead, there is no " +
      "delete: reword it with updateChecklistItem, or delete the checklist and rebuild it.",
    inputSchema: {
      type: "object",
      properties: {
        checklistId: {
          type: "string",
          description: "Checklist to delete, from addChecklist or getCardChecklists",
        },
      },
      required: ["checklistId"],
    },
    run: ({ checklistId }) => trello("DELETE", `/checklists/${checklistId}`),
  },

  addChecklistItem: {
    description:
      "Add one item to an existing checklist. checklistId comes from addChecklist's " +
      "result or from getCardChecklists — it is not the card id.",
    inputSchema: {
      type: "object",
      properties: {
        checklistId: {
          type: "string",
          description: "Checklist to add to, from addChecklist or getCardChecklists",
        },
        name: { type: "string", description: "Item text" },
        checked: { type: "boolean", description: "Start the item checked (default: false)" },
      },
      required: ["checklistId", "name"],
    },
    run: ({ checklistId, name, checked }) =>
      trello("POST", `/checklists/${checklistId}/checkItems`, {
        name,
        // Omitted rather than sent as false: Trello defaults it, and an explicit
        // `checked=false` is indistinguishable from the caller asking to uncheck.
        checked: checked === undefined ? undefined : checked,
      }),
  },
};
