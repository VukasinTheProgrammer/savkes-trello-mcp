#!/usr/bin/env node
// trello-board — stdio MCP server for Trello cards, attachments and link graphs.
//
// This file is the protocol layer only: newline-framed stdin, JSON-RPC dispatch,
// and process lifecycle. The Trello HTTP layer lives in trello/client.mjs and the
// tools in tools/cards.mjs and tools/hierarchy.mjs.
//
// Credentials come from env only: TRELLO_API_KEY, TRELLO_TOKEN.
// TRELLO_BOARD_ID is optional — default board for the board-scoped tools when no
// boardId argument is given.
//
// Protocol smoke check (`npm run smoke` from server/):
//   printf '%s\n' \
//     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
//     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
//     '{"jsonrpc":"2.0","id":3,"method":"resources/list"}' \
//     '{"jsonrpc":"2.0","id":4,"method":"prompts/list"}' \
//   | node server/src/index.mjs
// Expect exactly four JSON-RPC frames on stdout, nothing else.
//
// Self-test (no network, no credentials required) — lives in index.test.mjs,
// which imports this module's exports; either command runs it:
//   node server/src/index.mjs --selftest
//   node server/src/index.test.mjs
//

import { spawnSync } from "node:child_process";
import path from "node:path";

import { PROMPTS } from "./prompts.mjs";
import { listResources, readResource } from "./resources.mjs";
import { TOOLS as CARD_TOOLS } from "./tools/cards.mjs";
import { TOOLS as HIERARCHY_TOOLS } from "./tools/hierarchy.mjs";

// The selftest asserts the full name list, so a collision between the two halves shows
// up as a short count — which is also why no total is written here: a number in a
// comment goes stale the first time a tool is added, and the selftest already holds
// the real one.
export const TOOLS = { ...CARD_TOOLS, ...HIERARCHY_TOOLS };

// One source for both the handshake and the stderr log prefix, so they can't drift.
const SERVER = { name: "trello-board", version: "0.4.0" };

// Newest first — [0] is what an unrecognised request negotiates down to. Every wire
// shape this server emits is the 2024-11-05 one, which stays valid in the two later
// revisions; nothing here uses a feature they added, so all three are honest answers.
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const negotiateVersion = (asked) =>
  asked === undefined
    ? PROTOCOL_VERSIONS.at(-1)
    : PROTOCOL_VERSIONS.includes(asked)
      ? asked
      : PROTOCOL_VERSIONS[0];

// Neither source server checked arguments: an unknown key was serialized into
// nothing and the call succeeded with the value silently dropped, which is how a
// `desc:`-instead-of-`description:` typo creates cards with empty bodies. Names the
// offending key rather than reporting a generic validation failure.
export function validateArgs(name, schema = {}, args = {}) {
  const known = Object.keys(schema.properties ?? {});
  const unknown = Object.keys(args).filter((k) => !known.includes(k));
  if (unknown.length) {
    throw new Error(
      `Unknown argument${unknown.length > 1 ? "s" : ""} for ${name}: ${unknown.join(", ")}. ` +
        `Accepted: ${known.join(", ") || "(none)"}`,
    );
  }
  const missing = (schema.required ?? []).filter((k) => args[k] === undefined);
  if (missing.length) {
    throw new Error(
      `Missing required argument${missing.length > 1 ? "s" : ""} for ${name}: ${missing.join(", ")}`,
    );
  }

  // Types too, not just presence. Everything reaches Trello through a query string,
  // so a wrong type doesn't fail — `String([])` is "" and `String({})` is
  // "[object Object]", both of which Trello accepts and acts on. A property with no
  // declared `type` is unconstrained on purpose.
  for (const [key, value] of Object.entries(args)) {
    const want = schema.properties?.[key]?.type;
    if (!want || value === undefined) continue;
    const got = Array.isArray(value) ? "array" : typeof value;
    if (got !== want) {
      throw new Error(`Argument ${key} for ${name} must be ${want}, got ${got}`);
    }
    const itemType = schema.properties[key].items?.type;
    if (want === "array" && itemType) {
      const badIndex = value.findIndex((v) => typeof v !== itemType);
      if (badIndex !== -1) {
        throw new Error(
          `Argument ${key} for ${name} must be an array of ${itemType}, ` +
            `but index ${badIndex} is ${typeof value[badIndex]}`,
        );
      }
    }
  }
}

// Prompt arguments are declared in MCP's wire shape, not as JSON Schema, so map
// them across rather than growing a second validator for the same two checks.
const promptSchema = (prompt) => ({
  properties: Object.fromEntries((prompt.arguments ?? []).map((a) => [a.name, {}])),
  required: (prompt.arguments ?? []).filter((a) => a.required).map((a) => a.name),
});

export async function handle(msg) {
  const { method, params = {} } = msg;

  // Notifications never get a response, not even an error one — so an unknown
  // notification is dropped here rather than falling through to -32601 and
  // logging to stderr on every session start.
  if (method.startsWith("notifications/")) return null;

  if (method === "initialize") {
    return {
      // Negotiated, not echoed. Echoing the client's string back claims support for
      // whatever it asked for — including a version that does not exist — so an
      // unrecognised one gets our latest instead, which is what the spec asks a server
      // to do and what lets the client decide whether it can still talk to us.
      //
      // Omitted is a separate case from unrecognised, and stays on the floor: the field
      // is required, so a client that leaves it out is old or broken, and answering an
      // old client with our newest version is the one reply guaranteed not to help it.
      protocolVersion: negotiateVersion(params.protocolVersion),
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { ...SERVER },
    };
  }

  if (method === "ping") return {};

  if (method === "tools/list") {
    return {
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: t.inputSchema,
        // Hints for the client (e.g. to confirm before a destructive call), not
        // enforcement — the server runs the tool either way.
        ...(t.annotations && { annotations: t.annotations }),
      })),
    };
  }

  if (method === "resources/list") return { resources: listResources() };
  // Declaring the resources capability invites this call, and answering -32601 puts an
  // error frame plus a stderr line into every session start. There are no templated
  // resource URIs here — all three are fixed — so the honest answer is an empty list.
  if (method === "resources/templates/list") return { resourceTemplates: [] };
  if (method === "resources/read") return readResource(params.uri);

  if (method === "prompts/list") {
    return {
      prompts: Object.entries(PROMPTS).map(([name, p]) => ({
        name,
        description: p.description,
        arguments: p.arguments,
      })),
    };
  }

  if (method === "prompts/get") {
    const prompt = PROMPTS[params.name];
    if (!prompt) {
      const err = new Error(
        `Unknown prompt: ${params.name}. Available: ${Object.keys(PROMPTS).join(", ")}`,
      );
      err.code = -32602;
      throw err;
    }
    const args = params.arguments ?? {};
    validateArgs(`prompt ${params.name}`, promptSchema(prompt), args);
    return { description: prompt.description, ...prompt.build(args) };
  }

  if (method === "tools/call") {
    const tool = TOOLS[params.name];
    try {
      if (!tool) throw new Error(`Unknown tool: ${params.name}`);
      const args = params.arguments ?? {};
      validateArgs(params.name, tool.inputSchema, args);
      const result = await tool.run(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: String(err.message ?? err) }], isError: true };
    }
  }

  const err = new Error(`Method not found: ${method}`);
  err.code = -32601;
  throw err;
}

let buffer = "";
// Dispatch is serialized through one promise chain. Framing below is synchronous,
// so a `data` event that arrives mid-await can no longer split a buffer another
// call is still reading, and frames go out in the order they arrived.
let queue = Promise.resolve();

// Synchronous: drain every complete line out of the buffer before any dispatch runs.
function onChunk(chunk) {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    // The .catch() keeps one failure from poisoning the chain: a rejected `queue`
    // makes every later .then() skip, so the server would go silent for the rest of
    // the session with no response and no error. dispatch handles its own errors, so
    // reaching here means something unexpected — log it and keep the chain alive.
    queue = queue
      .then(() => dispatch(line))
      .catch((err) => console.error(`[${SERVER.name}] dispatch failed:`, err?.message ?? err));
  }
}

async function dispatch(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    console.error(`[${SERVER.name}] bad JSON on stdin:`, err.message);
    return;
  }
  const isNotification = msg.id === undefined || msg.id === null;
  try {
    const result = await handle(msg);
    if (!isNotification) send({ jsonrpc: "2.0", id: msg.id, result });
  } catch (err) {
    console.error(`[${SERVER.name}]`, err.message);
    if (!isNotification) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: err.code ?? -32603, message: String(err.message ?? err) },
      });
    }
  }
}

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

// Called only by a process entry point, never on import: the selftest imports this
// module for its exports, and attaching stdin listeners there would hold the event
// loop open and hang the test run instead of letting it exit on its own.
export function main() {
  // The selftest lives in its own module — it never runs on the server path. It's
  // run as a child process rather than imported: the test imports this module, so
  // importing it back here is a cycle, and with top-level await that deadlocks
  // outright (node exits 13). Spawning keeps `--selftest` the documented command
  // with no import cycle.
  if (process.argv[2] === "--selftest") {
    const test = path.join(import.meta.dirname, "index.test.mjs");
    process.exit(spawnSync(process.execPath, [test], { stdio: "inherit" }).status ?? 1);
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onChunk);
  // Exit once the queue drains, not on `end` itself — `finally` so a dispatch that
  // somehow rejects still lets the process exit instead of hanging.
  process.stdin.on("end", () => {
    queue.finally(() => process.exit(0));
  });
}

if (import.meta.filename === process.argv[1]) main();
