// Labels and Custom Fields: naming and creating labels, and the board "table" of
// fields (Area, Owner, ...) shown at the top of a card.
//
// The Custom Fields endpoints need the Custom Fields Power-Up enabled on the board:
// with it off, listing returns [] and creating answers 403. Creating a field and
// setting a value send nested JSON, so they use trello()'s `body` argument.

import { cardRef, resolveBoard, trello } from "../trello/client.mjs";

const FIELD_TYPES = ["text", "number", "checkbox", "date", "list"];

export const TOOLS = {
  getCustomFields: {
    description:
      "List a board's Custom Field definitions as [{id, name, type, options}], where " +
      "options (list fields only) are [{id, value: {text}}]. Use it to find the " +
      "customFieldId and optionId setCustomFieldValue needs. An empty list can also mean " +
      "the Custom Fields Power-Up is off. boardId defaults to TRELLO_BOARD_ID.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "Board to read; defaults to TRELLO_BOARD_ID" },
      },
    },
    run: ({ boardId } = {}) => trello("GET", `/boards/${resolveBoard(boardId)}/customFields`),
  },

  getCardCustomFields: {
    description:
      "List the Custom Field values set on one card as [{idCustomField, idValue, value}]. " +
      "Match idCustomField against getCustomFields to read the field's name.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { cardId: { type: "string", description: "Card to inspect" } },
      required: ["cardId"],
    },
    run: ({ cardId }) => trello("GET", `/cards/${cardRef(cardId)}/customFieldItems`),
  },

  createLabel: {
    description:
      "Create a named label on a board and return it as {id, name, color}. color is a " +
      "Trello colour (green, yellow, orange, red, purple, blue, sky, lime, pink, black, " +
      "optionally with _dark or _light). Check getLabels first: a board accepts several " +
      "labels of the same colour and name. boardId defaults to TRELLO_BOARD_ID.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Label text, e.g. Mythic Priority" },
        color: { type: "string", description: "Trello colour name" },
        boardId: { type: "string", description: "Board to add to; defaults to TRELLO_BOARD_ID" },
      },
      required: ["name", "color"],
    },
    run: ({ name, color, boardId }) =>
      trello("POST", "/labels", { name, color, idBoard: resolveBoard(boardId) }),
  },

  updateLabel: {
    description:
      "Rename a label or change its colour. Every card carrying it shows the change at " +
      "once. Get the labelId from getLabels. Pass at least one of name and color.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        labelId: { type: "string", description: "Label to change" },
        name: { type: "string", description: "New label text" },
        color: { type: "string", description: "New Trello colour name" },
      },
      required: ["labelId"],
    },
    run: ({ labelId, name, color }) => {
      if (name === undefined && color === undefined) throw new Error("Pass name, color, or both");
      return trello("PUT", `/labels/${labelId}`, { name, color });
    },
  },

  createCustomField: {
    description:
      "Create a Custom Field on a board and return its definition. type is text, number, " +
      "checkbox, date or list; a list field needs options (the dropdown choices). The " +
      "field shows on the card front. Requires the Custom Fields Power-Up on the board " +
      "(403 otherwise). boardId defaults to TRELLO_BOARD_ID.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Field name, e.g. Area" },
        type: { type: "string", description: `One of: ${FIELD_TYPES.join(", ")}` },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Dropdown choices; required for type list, not allowed otherwise",
        },
        boardId: { type: "string", description: "Board to add to; defaults to TRELLO_BOARD_ID" },
      },
      required: ["name", "type"],
    },
    run: ({ name, type, options, boardId }) => {
      if (!FIELD_TYPES.includes(type)) {
        throw new Error(`type must be one of ${FIELD_TYPES.join(", ")}, got ${type}`);
      }
      if (type === "list" && !options?.length) throw new Error("A list field needs options");
      if (type !== "list" && options?.length) throw new Error("options is only for type list");
      return trello("POST", "/customFields", {}, {
        idModel: resolveBoard(boardId),
        modelType: "board",
        name,
        type,
        pos: "bottom",
        display_cardFront: true,
        ...(type === "list" && {
          options: options.map((text, i) => ({ value: { text }, pos: (i + 1) * 1000 })),
        }),
      });
    },
  },

  setCustomFieldValue: {
    description:
      "Set one Custom Field on one card. Pass exactly one of optionId (list field, from " +
      "getCustomFields), text, number, date (ISO 8601) or checked. Replaces any value " +
      "already there. Clearing a value is not supported by this tool.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "Card to set the value on" },
        customFieldId: { type: "string", description: "Field id from getCustomFields" },
        optionId: { type: "string", description: "Option id, for a list field" },
        text: { type: "string", description: "Value for a text field" },
        number: { type: "number", description: "Value for a number field" },
        date: { type: "string", description: "ISO 8601 value for a date field" },
        checked: { type: "boolean", description: "Value for a checkbox field" },
      },
      required: ["cardId", "customFieldId"],
    },
    run: ({ cardId, customFieldId, optionId, text, number, date, checked }) => {
      const given = { optionId, text, number, date, checked };
      const used = Object.keys(given).filter((k) => given[k] !== undefined);
      if (used.length !== 1) {
        throw new Error(
          `Pass exactly one of optionId, text, number, date, checked; got ${used.join(", ") || "none"}`,
        );
      }
      // Trello wants number and checkbox values as strings inside `value`.
      const body =
        optionId !== undefined
          ? { idValue: optionId }
          : text !== undefined
            ? { value: { text } }
            : number !== undefined
              ? { value: { number: String(number) } }
              : date !== undefined
                ? { value: { date } }
                : { value: { checked: String(checked) } };
      return trello("PUT", `/cards/${cardRef(cardId)}/customField/${customFieldId}/item`, {}, body);
    },
  },
};
