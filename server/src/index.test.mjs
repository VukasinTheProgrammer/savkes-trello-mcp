// Selftest for the trello-board server — no network, no credentials, no test framework.
//
//   node server/src/index.mjs --selftest
//
// Running this file directly works too; `--selftest` just spawns it.

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { Bucket, authHeader, buildUrl, cardRef, pool, resolveBoard } from "./trello/client.mjs";
import { PROMPTS } from "./prompts.mjs";
import { TOOLS, handle, validateArgs } from "./index.mjs";
import { auditHierarchy, buildLinkGraph, pickCardSummary } from "./tools/hierarchy.mjs";
import {
  belongsUnder,
  cardNumber,
  insertionSlot,
  nextNumbers,
  parentNumber,
  spreadPositions,
} from "./utils/numbering.mjs";

const graph = buildLinkGraph([
  {
    shortLink: "aaa",
    name: "A",
    attachments: [
      { url: "https://trello.com/c/bbb/12-b" },
      { url: "https://trello.com/1/cards/x/attachments/y/download/spec.pdf" },
      { id: "att-gone-1", url: "https://trello.com/c/gone" },
    ],
  },
  { shortLink: "bbb", name: "B", attachments: [] },
]);
const byLink = Object.fromEntries(graph.cards.map((c) => [c.shortLink, c]));
assert.deepEqual(byLink.aaa.attachments, ["bbb"]);
assert.deepEqual(byLink.bbb.attachedTo, ["aaa"]);
assert.deepEqual(byLink.aaa.attachedTo, []);
assert.deepEqual(byLink.bbb.attachments, []);
assert.equal(graph.staleLinks, 1);
assert.deepEqual(graph.staleLinkEntries, [{ shortLink: "aaa", attachmentId: "att-gone-1", target: "gone" }]);

// No stale links: empty list, count 0, rest of the shape unchanged.
const cleanGraph = buildLinkGraph([
  { shortLink: "ccc", name: "C", attachments: [{ id: "att-x", url: "https://trello.com/c/ddd" }] },
  { shortLink: "ddd", name: "D", attachments: [] },
]);
assert.deepEqual(cleanGraph.staleLinkEntries, []);
assert.equal(cleanGraph.staleLinks, 0);
assert.deepEqual(cleanGraph.cards.map((c) => c.shortLink).sort(), ["ccc", "ddd"]);
assert.equal(cardRef("https://trello.com/b/BS4JBXTn/team-bravo"), "BS4JBXTn");
assert.equal(cardRef("BS4JBXTn"), "BS4JBXTn");

// findCards' payload carries exactly these four fields, never Trello's `id` — and
// never labels/idMembers/pos, which no consumer has read since the snapshot renderer
// was deleted. Extra keys on the input must be dropped, not passed through.
const picked = pickCardSummary({
  id: "x",
  idShort: 1,
  shortLink: "y",
  name: "z",
  idList: "w",
  labels: [{ name: "Task" }],
  idMembers: ["m1"],
  pos: 5,
});
assert.deepEqual(Object.keys(picked).sort(), ["idList", "idShort", "name", "shortLink"]);

// Epic 0 is a real case on this board: "EPIC 0" and stories 0.1/0.2/0.3.
assert.equal(cardNumber("EPIC 0. Feature Planning & Trello Card Authoring"), "0");
assert.equal(cardNumber("0.3. Create Claude agents/skills/commands"), "0.3");
assert.equal(cardNumber("0.3.14. Render attachment relations"), "0.3.14");
assert.equal(cardNumber("--- "), null);
assert.equal(parentNumber("0.3.14"), "0.3");
assert.equal(parentNumber("0.3"), "0");
assert.equal(parentNumber("0"), null);
assert.equal(parentNumber("12"), null);

// Self-attachment is dropped, not counted as an edge.
const selfGraph = buildLinkGraph([
  { shortLink: "s1", name: "9.3.3. Self", attachments: [{ url: "https://trello.com/c/s1" }] },
]);
assert.deepEqual(selfGraph.selfLinks, ["s1"]);
assert.equal(selfGraph.cards.length, 0);

const audit = auditHierarchy([
  { shortLink: "e0", name: "EPIC 0. Planning", attachments: [{ url: "https://trello.com/c/s03" }] },
  { shortLink: "s03", name: "0.3. Skills", attachments: [{ url: "https://trello.com/c/t1" }] },
  { shortLink: "t1", name: "0.3.1. Attached right", attachments: [] },
  { shortLink: "t2", name: "0.3.2. Missing parent link", attachments: [] },
  { shortLink: "t3", name: "0.3.3. Wrong parent", attachments: [] },
  { shortLink: "x9", name: "9.9.9. Parent absent", attachments: [] },
  { shortLink: "sep", name: "---", attachments: [] },
]);
assert.equal(audit.ok, 2); // 0.3 under EPIC 0, and 0.3.1 under 0.3
assert.deepEqual(
  audit.missing.map((m) => m.number).sort(),
  ["0.3.2", "0.3.3"],
);
assert.deepEqual(audit.parentNotFound.map((p) => p.number), ["9.9.9"]);
assert.equal(audit.unnumbered, 1);

// findCard's matching rule, exercised through the parser it delegates to: a prefix
// test would wrongly claim "2.1.1" and "2.10" as matches for "2.1".
assert.equal(cardNumber("2.1. Centralize locking"), "2.1");
assert.notEqual(cardNumber("2.1.1 Reuse centralized locking"), "2.1");
assert.notEqual(cardNumber("2.10. Something else"), "2.1");
assert.equal(cardNumber("EPIC 8. Refactor of Backend"), "8");

// belongsUnder: the subtree test, including the two cases a string prefix gets wrong.
assert.equal(belongsUnder("2.1", "2"), true);
assert.equal(belongsUnder("2", "2"), true);
assert.equal(belongsUnder("2.1.3", "2.1"), true);
assert.equal(belongsUnder("2.10", "2.1"), false);
assert.equal(belongsUnder("2", "2.1"), false);

// insertionSlot: new children follow the LAST card of the subtree, not the parent,
// so a second batch lands after the first. The board's own shape, in miniature.
const backlog = [
  { id: "a", name: "EPIC 2. Card Limit Per Account", pos: 1000 },
  { id: "b", name: "2.1. Backend: enforce max active cards", pos: 2000 },
  { id: "c", name: "2.1.1. Add config + validation", pos: 3000 },
  { id: "d", name: "2.2. Frontend: surface the error", pos: 4000 },
  { id: "e", name: "---", pos: 5000 },
];
assert.equal(insertionSlot(backlog, "2.1").anchor.id, "c");
assert.equal(insertionSlot(backlog, "2.1").next.id, "d");
// Under the epic, the last subtree card is 2.2 — the separator is next, not part of it.
assert.equal(insertionSlot(backlog, "2").anchor.id, "d");
assert.equal(insertionSlot(backlog, "2").next.id, "e");
// A story with no tasks yet anchors on itself.
assert.equal(insertionSlot(backlog, "2.2").anchor.id, "d");

// The case that actually happens: cards are created before they are placed, so
// Trello has already dropped them at the bottom of the list. Left in, they are the
// last subtree members and become their own anchor — placement silently no-ops.
const midPush = [
  ...backlog,
  { id: "new1", name: "2.1.2. Wire endpoint", pos: 99000, shortLink: "Ab12Cd34" },
  { id: "new2", name: "2.1.3. Add tests", pos: 99500, shortLink: "Ef56Gh78" },
];
assert.equal(insertionSlot(midPush, "2.1").anchor.id, "new2"); // wrong, without exclude
const slot = insertionSlot(midPush, "2.1", new Set(["new1", "new2"]));
assert.equal(slot.anchor.id, "c");
assert.equal(slot.next.id, "d");
// And a second batch lands after the first: batch one is no longer excluded.
assert.equal(insertionSlot(midPush, "2.1", new Set(["new2"])).anchor.id, "new1");
// Excluding by shortLink works identically — callers hold either form, and keying
// only on `id` made a shortLink caller a silent no-op that still reported success.
const byShortLink = insertionSlot(midPush, "2.1", new Set(["Ab12Cd34", "Ef56Gh78"]));
assert.equal(byShortLink.anchor.id, "c");
assert.equal(byShortLink.next.id, "d");
// Mixed forms in one batch, and a card carrying no shortLink field at all.
assert.equal(insertionSlot(midPush, "2.1", new Set(["new1", "Ef56Gh78"])).anchor.id, "c");
// Unknown parent: no anchor, and placeCards refuses rather than guessing.
assert.equal(insertionSlot(backlog, "9.9").anchor, null);

// spreadPositions: strictly inside the gap, ascending, and past the anchor when
// there is no next card.
const spread = spreadPositions(3000, 4000, 3);
assert.deepEqual(spread, [3250, 3500, 3750]);
assert.equal(spread.every((p, i) => p > 3000 && p < 4000 && (i === 0 || p > spread[i - 1])), true);
assert.deepEqual(spreadPositions(3000, null, 2), [4024, 5048]);

// Archived cards block their own number and nothing more. Without the split, the
// archived 88 becomes the max and the next epic is 89 — every number from 3 to 88
// silently retired by one scratch card somebody archived.
const withOutlier = [
  { name: "EPIC 1. One" },
  { name: "EPIC 2. Two" },
  { name: "88. Scratch (safe to delete)", closed: true },
  { name: "2.1. Story" },
  { name: "2.1.1. Task" },
  { name: "2.1.2. Archived task", closed: true },
];
const outlier = nextNumbers(withOutlier, ["2.1"]);
assert.equal(outlier.nextEpic, "3");
assert.equal(outlier.nextUnder["2.1"].next, "2.1.3");
// A parent that has been archived is not a parent you can plan under.
assert.equal(nextNumbers([{ name: "9.1. Gone", closed: true }], ["9.1"]).nextUnder["9.1"].parentExists, false);
// And with no `closed` anywhere, behaviour is the plain max + 1 it always was.
assert.equal(nextNumbers([{ name: "EPIC 4. Four" }], []).nextEpic, "5");

// A zero-width gap has nothing to divide. Split anyway, all three come back as the
// anchor's own position and the placement silently does nothing — so it falls back to
// appending, which at least keeps them distinct and in order.
assert.deepEqual(spreadPositions(1000, 1000, 3), [2024, 3048, 4072]);
// Reversed bounds can't come out of insertionSlot, which sorts first, but the same
// guard has to cover them or the batch lands in reverse order.
assert.deepEqual(spreadPositions(2000, 1000, 2), [3024, 4048]);
// A gap of 1 is still a gap: tight is fine, Trello renumbers a list that gets too
// tight on its own. Only <= 0 is unusable.
assert.deepEqual(spreadPositions(1000, 1001, 3), [1000.25, 1000.5, 1000.75]);

// 16 ported from mcp-trello + 9 from the wrapper + 9 added since = 34. A name
// collision between the halves would silently drop a tool, so the count is asserted
// alongside the names. This is the only place the total is written down.
const list = await handle({ id: 1, method: "tools/list" });
assert.equal(list.tools.length, 34);
assert.deepEqual(
  list.tools.map((t) => t.name).sort(),
  [
    "addCard",
    "addChecklist",
    "addChecklistItem",
    "addComment",
    "addList",
    "archiveCard",
    "archiveList",
    "attachCard",
    "auditCardHierarchy",
    "changeCardMembers",
    "deleteChecklist",
    "deleteComment",
    "detachCard",
    "findCard",
    "findCards",
    "getBoardMembers",
    "getCard",
    "getCardChecklists",
    "getCardsByList",
    "getLabels",
    "getLists",
    "getMyBoards",
    "getMyCards",
    "getRecentActivity",
    "listBoardCardLinks",
    "listCardAttachments",
    "moveCard",
    "nextCardNumbers",
    "placeCards",
    "repairCardHierarchy",
    "unarchiveCard",
    "updateCard",
    "updateChecklistItem",
    "updateComment",
  ],
);
// Every tool declares an object schema, so the validator always has something to
// check against — a tool added without one would silently accept anything.
assert.equal(
  list.tools.every((t) => t.inputSchema?.type === "object" && t.inputSchema.properties),
  true,
);

const unknown = await handle({ id: 2, method: "tools/call", params: { name: "doesNotExist" } });
assert.equal(unknown.isError, true);

// The handshake advertises three capabilities, so all three method families must
// answer — a capability the server then -32601s is worse than not advertising it.
const init = await handle({ id: 3, method: "initialize", params: {} });
assert.deepEqual(init.capabilities, { tools: {}, resources: {}, prompts: {} });
assert.deepEqual(init.serverInfo, { name: "trello-board", version: "0.4.0" });
// Omitted is not the same as unrecognised: the field is required, so a client that
// leaves it out is old or broken and gets the floor, not our newest.
assert.equal(init.protocolVersion, "2024-11-05");
// A version we know is echoed; one we don't is negotiated down to our latest rather
// than parroted back, which would claim support for a revision — or a typo — whose
// wire shapes this server has never produced.
assert.equal((await handle({ id: 4, method: "initialize", params: { protocolVersion: "2025-06-18" } })).protocolVersion, "2025-06-18");
assert.equal((await handle({ id: 4, method: "initialize", params: { protocolVersion: "9999-99-99" } })).protocolVersion, "2025-06-18");

// Declaring the resources capability invites this call; -32601 here put an error
// frame and a stderr line into every session start.
assert.deepEqual(await handle({ id: 6, method: "resources/templates/list" }), { resourceTemplates: [] });

assert.deepEqual(await handle({ id: 5, method: "ping" }), {});

// ---------------------------------------------------------------------------
// Resources. The two board-scoped ones exist only when a board id is configured —
// their URIs embed it — while My Cards is scoped by the token and is always there.
// The env is set explicitly rather than inherited, since this file also runs from
// an MCP session that already exports TRELLO_BOARD_ID.
const inheritedBoard = process.env.TRELLO_BOARD_ID;
process.env.TRELLO_BOARD_ID = "6a47826d1fa56f9e07523fd4";
assert.deepEqual(
  (await handle({ id: 6, method: "resources/list" })).resources.map((r) => r.uri),
  [
    "trello://board/6a47826d1fa56f9e07523fd4/lists",
    "trello://board/6a47826d1fa56f9e07523fd4/activity",
    "trello://me/cards",
  ],
);
assert.deepEqual(
  (await handle({ id: 6, method: "resources/list" })).resources.map((r) => r.name),
  ["Board Lists", "Recent Activity", "My Cards"],
);
// Every entry carries the wire fields and none leaks the internal `read` fn.
assert.equal(
  (await handle({ id: 6, method: "resources/list" })).resources.every(
    (r) => r.mimeType === "application/json" && r.description && !("read" in r),
  ),
  true,
);
// A board shortLink is accepted where mcp-trello would have taken it verbatim.
process.env.TRELLO_BOARD_ID = "BS4JBXTn";
assert.equal(
  (await handle({ id: 6, method: "resources/list" })).resources[0].uri,
  "trello://board/BS4JBXTn/lists",
);
// No board configured: the conditional drops both board-scoped resources.
delete process.env.TRELLO_BOARD_ID;
assert.deepEqual(
  (await handle({ id: 6, method: "resources/list" })).resources.map((r) => r.uri),
  ["trello://me/cards"],
);
process.env.TRELLO_BOARD_ID = "6a47826d1fa56f9e07523fd4";
await assert.rejects(
  handle({ id: 7, method: "resources/read", params: { uri: "trello://board/nope/lists" } }),
  (e) => e.code === -32602 && /Unknown resource/.test(e.message),
);

// ---------------------------------------------------------------------------
// Prompts: exactly five, in mcp-trello's registration order, with their argument
// declarations intact.
const promptList = (await handle({ id: 8, method: "prompts/list" })).prompts;
assert.deepEqual(
  promptList.map((p) => p.name),
  ["create-task", "board-status", "my-tasks", "card-discussion", "comment-on-card"],
);
assert.equal(promptList.every((p) => p.description && Array.isArray(p.arguments)), true);
assert.deepEqual(
  promptList.map((p) => p.arguments.map((a) => `${a.name}${a.required ? "!" : "?"}`)),
  [["taskName!", "listName?"], [], [], ["cardId!"], ["cardId!", "comment!"]],
);

const promptText = async (name, args) =>
  (await handle({ id: 9, method: "prompts/get", params: { name, arguments: args } })).messages[0]
    .content.text;

// create-task branches on listName — both branches, since only one is reachable
// per call and a broken branch would otherwise go unnoticed. Unlike the other four
// this prompt is deliberately NOT mcp-trello's text: it routes to the two-phase
// plan-then-push path instead of a bare addCard, so assert it names both commands
// and never presents addCard as the normal route.
const createTask = await promptText("create-task", { taskName: "T" });
assert.match(createTask, /\/trello-card-draft "T"/);
assert.match(createTask, /\/trello-card-push/);
assert.match(createTask, /not a direct addCard call/);
assert.match(
  await promptText("create-task", { taskName: "T", listName: "Backlog" }),
  /"T" in the "Backlog" list/,
);

// The prompt names two slash commands by path-bearing name. A skill rename would
// otherwise leave it pointing at a command that no longer exists — which is exactly
// what happened to trello-card-plan when it became trello-card-draft.
for (const skill of ["trello-card-draft", "trello-card-push"]) {
  assert.match(createTask, new RegExp(`/${skill}\\b`), `create-task should name /${skill}`);
  assert.equal(
    fs.existsSync(path.join(import.meta.dirname, "..", "..", ".claude", "skills", skill, "SKILL.md")),
    true,
    `create-task names /${skill} but .claude/skills/${skill}/SKILL.md does not exist`,
  );
}
assert.match(await promptText("board-status", {}), /findCards to fetch every card in one call/);
assert.match(await promptText("my-tasks", {}), /using the getMyCards tool/);
assert.match(await promptText("card-discussion", { cardId: "C1" }), /card "C1" using the getCard tool/);
assert.match(
  await promptText("comment-on-card", { cardId: "C1", comment: "hi" }),
  /card "C1" using the addComment tool: "hi"/,
);

// The prompts hard-code tool names in prose, where nothing type-checks them. Pull
// every tool-shaped identifier out of the built text and require it to be a real
// tool, so a rename can't leave a prompt pointing at something that is gone.
const toolNames = new Set(Object.keys(TOOLS));
// Every tool declares whether it reads, adds, or destroys — clients use this to
// decide what needs a confirmation prompt.
for (const [name, t] of Object.entries(TOOLS)) {
  assert.equal(typeof t.annotations?.readOnlyHint, "boolean", `${name} has no readOnlyHint`);
}
const mentioned = new Set();
for (const [name, prompt] of Object.entries(PROMPTS)) {
  const args = Object.fromEntries(prompt.arguments.map((a) => [a.name, "x"]));
  const text = prompt.build(args).messages[0].content.text;
  for (const ident of text.match(/\b(?:get|add|update|delete|archive|move|change|find|place|attach|detach|audit|next)[A-Z]\w+/g) ?? []) {
    assert.equal(toolNames.has(ident), true, `prompt ${name} names a tool that does not exist: ${ident}`);
    mentioned.add(ident);
  }
}
assert.deepEqual(
  [...mentioned].sort(),
  [
    "addCard",
    "addComment",
    "auditCardHierarchy",
    "findCards",
    "getCard",
    "getLists",
    "getMyCards",
    "getRecentActivity",
    "nextCardNumbers",
  ],
);

await assert.rejects(
  handle({ id: 9, method: "prompts/get", params: { name: "no-such-prompt" } }),
  (e) => e.code === -32602 && /Unknown prompt/.test(e.message),
);
// Prompt arguments go through the same validator as tool arguments.
await assert.rejects(
  handle({ id: 9, method: "prompts/get", params: { name: "create-task", arguments: {} } }),
  /Missing required argument for prompt create-task: taskName/,
);
await assert.rejects(
  handle({ id: 9, method: "prompts/get", params: { name: "my-tasks", arguments: { nope: 1 } } }),
  /Unknown argument for prompt my-tasks: nope/,
);
if (inheritedBoard === undefined) delete process.env.TRELLO_BOARD_ID;
else process.env.TRELLO_BOARD_ID = inheritedBoard;

// Notifications resolve to nothing rather than throwing — the caller then sends no
// frame. A genuinely unknown *request* still gets -32601.
assert.equal(await handle({ method: "notifications/initialized" }), null);
assert.equal(await handle({ method: "notifications/cancelled", params: { requestId: 1 } }), null);
await assert.rejects(handle({ id: 10, method: "no/such/method" }), (err) => err.code === -32601);

// Framing, end to end against a real child process. Writes land at 7-byte
// boundaries so nearly every frame is split mid-JSON across two `data` events —
// the case the partial-line buffer has to survive. The interleaved notification
// must produce no frame and no stderr.
//
// This is NOT a reproduction of the reordering race the serialized dispatch fixes:
// `ping` settles in microtasks, so no chunk ever arrives mid-await and the old
// per-chunk `await` loop passes this too. Reproducing it needs a handler slow
// enough to span a macrotask, i.e. real network I/O, which this selftest refuses
// to do. Treat these as ordering/framing guards; the race fix is structural.
const FRAMES = 20;
const child = spawn(process.execPath, [path.join(import.meta.dirname, "index.mjs")], {
  stdio: ["pipe", "pipe", "pipe"],
});
let out = "";
let err = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (err += d));

const lines = Array.from({ length: FRAMES }, (_, i) =>
  JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "ping" }),
);
lines.splice(FRAMES / 2, 0, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
const payload = lines.join("\n") + "\n";
for (let i = 0; i < payload.length; i += 7) {
  child.stdin.write(payload.slice(i, i + 7));
  await new Promise((r) => setImmediate(r));
}
child.stdin.end();
const exitCode = await new Promise((r) => child.on("close", r));

assert.equal(exitCode, 0);
assert.equal(err, "", `expected empty stderr, got: ${err}`);
const replies = out.trim().split("\n").map((l) => JSON.parse(l));
assert.equal(replies.length, FRAMES); // the notification got no reply
assert.deepEqual(
  replies.map((r) => r.id),
  Array.from({ length: FRAMES }, (_, i) => i + 1),
);
assert.equal(replies.every((r) => r.result && Object.keys(r.result).length === 0), true);

// ---------------------------------------------------------------------------
// Rate limiter arithmetic. `rate` is tokens per millisecond, so the wait for one
// token at 300/10s is 1/0.03 ≈ 33ms. mcp-trello scaled this by 1000 and got 33
// *seconds*, which only stayed usable because it clamped the sleep to 100ms.
const bucket = new Bucket(300, 10_000);
assert.equal(bucket.msUntilToken(), 0); // starts full
bucket.tokens = 0;
const waitMs = bucket.msUntilToken();
assert.equal(waitMs > 25 && waitMs < 40, true, `expected ~33ms, got ${waitMs}`);
// And it actually hands out a token rather than spinning.
bucket.tokens = 5;
await bucket.take();
assert.equal(bucket.tokens < 5, true);

// Date.now() is wall clock, not monotonic. A backward jump (NTP correction, laptop
// resume) puts `last` in the future; unclamped, elapsed goes negative and subtracts
// tokens, so a one-hour jump left the bucket at -108000 tokens and take() sleeping
// for an hour. Clamped, a jump costs nothing beyond the normal 33ms wait.
const skewed = new Bucket(300, 10_000);
skewed.tokens = 0;
skewed.last = Date.now() + 3_600_000;
const skewedWait = skewed.msUntilToken();
assert.equal(skewed.tokens >= 0, true, `clock skew drove tokens to ${skewed.tokens}`);
assert.equal(skewedWait > 25 && skewedWait < 40, true, `expected ~33ms after skew, got ${skewedWait}`);

// Bounded concurrency: results in input order, never more than `limit` in flight.
assert.deepEqual(await pool([1, 2, 3], 2, async (x) => x * 2), [2, 4, 6]);
let live = 0;
let peak = 0;
await pool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
  peak = Math.max(peak, ++live);
  await new Promise((r) => setImmediate(r));
  live -= 1;
});
assert.equal(peak, 4, `expected at most 4 in flight, saw ${peak}`);

// ---------------------------------------------------------------------------
// Request building, asserted against a recording fetch instead of the network.
// Credentials are read per call, so setting them here is enough.
const realFetch = globalThis.fetch;
process.env.TRELLO_API_KEY = "test-key";
process.env.TRELLO_TOKEN = "test-token";
process.env.TRELLO_BOARD_ID = "6a47826d1fa56f9e07523fd4";

// Credentials go in the Authorization header, never the URL.
assert.equal(authHeader(), 'OAuth oauth_consumer_key="test-key", oauth_token="test-token"');
assert.equal(buildUrl("/cards", { name: "x" }).search, "?name=x");

// An unset TRELLO_BOARD_ID arrives as the literal placeholder; it must read as unset.
process.env.TRELLO_BOARD_ID = "${TRELLO_BOARD_ID}";
assert.throws(() => resolveBoard(), /boardId is required/);
assert.equal(resolveBoard("explicit"), "explicit");
process.env.TRELLO_BOARD_ID = "6a47826d1fa56f9e07523fd4";

// An unset variable reaches the server as the unexpanded `${VAR}` text from the
// .mcp.json env block, which Trello answers with a bare 401. Both that and the empty
// case have to name the variable, and neither may reach the network to find out.
for (const [name, bad] of [
  ["TRELLO_API_KEY", "${TRELLO_API_KEY}"],
  ["TRELLO_TOKEN", "${TRELLO_TOKEN}"],
]) {
  for (const value of [bad, "", "   "]) {
    const saved = process.env[name];
    process.env[name] = value;
    assert.throws(
      () => authHeader(),
      (e) => e.message.startsWith(`${name} is not set`),
      `${name}=${JSON.stringify(value)} should fail naming ${name}`,
    );
    process.env[name] = saved;
  }
}
// A credential that merely contains braces is not a placeholder.
process.env.TRELLO_TOKEN = "ATTA${weird}";
assert.match(authHeader(), /oauth_token="ATTA\$\{weird\}"/);
process.env.TRELLO_TOKEN = "test-token";

const requests = [];
const canned = (u, method) => {
  if (method === "GET" && /^\/1\/cards\/[^/]+$/.test(u.pathname)) {
    return { idBoard: "board-1", shortUrl: "https://trello.com/c/TGT9", name: "target card" };
  }
  // Board-level card reads: every hierarchy tool goes through this one. `closed` is
  // present so the archived-card handling in nextCardNumbers has something to filter.
  if (method === "GET" && /^\/1\/boards\/[^/]+\/cards$/.test(u.pathname)) {
    return [
      { id: "e2", shortLink: "e2", name: "EPIC 2. Thing", pos: 100, idList: "L1", closed: false, attachments: [] },
      { id: "s21", shortLink: "s21", name: "2.1. Story", pos: 200, idList: "L1", closed: false,
        attachments: [{ id: "a1", url: "https://trello.com/c/e2" }] },
      { id: "t211", shortLink: "t211", name: "2.1.1. Task", pos: 300, idList: "L1", closed: false, attachments: [] },
      // Archived, and the reason filter=all matters: without it 2.1.2 gets reissued.
      { id: "t212", shortLink: "t212", name: "2.1.2. Archived task", pos: 400, idList: "L1", closed: true, attachments: [] },
    ];
  }
  if (method === "GET" && /^\/1\/lists\/[^/]+\/cards$/.test(u.pathname)) {
    return [
      { id: "p", name: "2.1. Parent", pos: 1000 },
      { id: "sib", name: "2.2. Sibling", pos: 2000 },
      { id: "n1", name: "2.1.1. Fresh", pos: 90000 },
      { id: "n2", name: "2.1.2. Fresh", pos: 91000 },
    ];
  }
  return { ok: true };
};
// Tracked so a tool that fans out can be checked for boundedness, not just for
// which requests it made.
let inFlight = 0;
let fetchPeak = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  requests.push({
    method: opts.method,
    path: u.pathname,
    params: Object.fromEntries(u.searchParams),
  });
  fetchPeak = Math.max(fetchPeak, ++inFlight);
  await new Promise((r) => setImmediate(r)); // yield, so overlap is observable
  inFlight -= 1;
  return new Response(JSON.stringify(canned(u, opts.method)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

// Drives the real dispatch path, so argument validation is exercised too.
async function callTool(name, args = {}) {
  requests.length = 0;
  fetchPeak = 0;
  const res = await handle({ id: 99, method: "tools/call", params: { name, arguments: args } });
  return { res, sent: [...requests] };
}
const okText = (r) => {
  assert.notEqual(r.res.isError, true, `unexpected error: ${r.res.content?.[0]?.text}`);
  return r.sent;
};

// addCard, canonical spelling.
assert.deepEqual(
  okText(await callTool("addCard", { listId: "L1", name: "N", description: "D", labels: ["l1", "l2"] }))[0],
  { method: "POST", path: "/1/cards", params: { idList: "L1", name: "N", desc: "D", idLabels: "l1,l2" } },
);
// The same call spelled the way trello-card-push's docs used to: desc / idLabels.
// Both spellings must build a byte-identical request, or the alias is decoration.
assert.deepEqual(
  okText(await callTool("addCard", { listId: "L1", name: "N", desc: "D", idLabels: ["l1", "l2"] }))[0],
  { method: "POST", path: "/1/cards", params: { idList: "L1", name: "N", desc: "D", idLabels: "l1,l2" } },
);
// dueDate maps to Trello's `due`; omitted optionals must not appear at all.
assert.deepEqual(
  okText(await callTool("addCard", { listId: "L1", name: "N", dueDate: "2026-12-31T23:59:59Z" }))[0].params,
  { idList: "L1", name: "N", due: "2026-12-31T23:59:59Z" },
);

// updateCard: an empty label array clears every label, and it does so because
// `idLabels=` is sent on purpose — not because Array#toString happened to be "".
assert.deepEqual(okText(await callTool("updateCard", { cardId: "C1", labels: [] }))[0], {
  method: "PUT",
  path: "/1/cards/C1",
  params: { idLabels: "" },
});
// Omitting labels must leave them alone: no idLabels key at all, empty or not.
assert.deepEqual(okText(await callTool("updateCard", { cardId: "C1", name: "X" }))[0].params, { name: "X" });
assert.deepEqual(
  okText(await callTool("updateCard", { cardId: "C1", description: "D", position: "top", startDate: "2026-01-01T00:00:00Z" }))[0].params,
  { desc: "D", pos: "top", start: "2026-01-01T00:00:00Z" },
);
// A card URL is accepted anywhere a card id is, via cardRef.
assert.equal(
  okText(await callTool("updateCard", { cardId: "https://trello.com/c/AbCd1234/12-thing", name: "X" }))[0].path,
  "/1/cards/AbCd1234",
);

assert.deepEqual(okText(await callTool("moveCard", { cardId: "C1", listId: "L2" }))[0], {
  method: "PUT",
  path: "/1/cards/C1",
  params: { idList: "L2" },
});
// members: [] unassigns everyone, same deliberate-empty-string rule as labels.
assert.deepEqual(okText(await callTool("changeCardMembers", { cardId: "C1", members: [] }))[0].params, {
  idMembers: "",
});
assert.deepEqual(okText(await callTool("changeCardMembers", { cardId: "C1", members: ["m1", "m2"] }))[0].params, {
  idMembers: "m1,m2",
});
assert.deepEqual(okText(await callTool("archiveCard", { cardId: "C1" }))[0], {
  method: "PUT",
  path: "/1/cards/C1",
  params: { closed: "true" },
});
assert.deepEqual(okText(await callTool("archiveList", { listId: "L1" }))[0], {
  method: "PUT",
  path: "/1/lists/L1/closed",
  params: { value: "true" },
});
assert.deepEqual(okText(await callTool("addComment", { cardId: "C1", text: "hi" }))[0], {
  method: "POST",
  path: "/1/cards/C1/actions/comments",
  params: { text: "hi" },
});
assert.deepEqual(okText(await callTool("updateComment", { cardId: "C1", commentId: "A1", text: "edited" }))[0], {
  method: "PUT",
  path: "/1/cards/C1/actions/A1/comments",
  params: { text: "edited" },
});
assert.deepEqual(okText(await callTool("deleteComment", { cardId: "C1", commentId: "A1" }))[0], {
  method: "DELETE",
  path: "/1/cards/C1/actions/A1/comments",
  params: {},
});
assert.deepEqual(okText(await callTool("detachCard", { cardId: "C1", attachmentId: "A1" }))[0], {
  method: "DELETE",
  path: "/1/cards/C1/attachments/A1",
  params: {},
});

// addList: mcp-trello rejected any board id that wasn't 24 characters, which
// rejected exactly the shortLink form the rest of the surface accepts. Both forms
// must now build a request instead of throwing.
assert.deepEqual(okText(await callTool("addList", { name: "Scratch" }))[0], {
  method: "POST",
  path: "/1/lists",
  params: { name: "Scratch", idBoard: "6a47826d1fa56f9e07523fd4" },
});
process.env.TRELLO_BOARD_ID = "BS4JBXTn";
assert.deepEqual(okText(await callTool("addList", { name: "Scratch" }))[0].params, {
  name: "Scratch",
  idBoard: "BS4JBXTn",
});
process.env.TRELLO_BOARD_ID = "6a47826d1fa56f9e07523fd4";

// attachCard reads both cards first to refuse a cross-board link, then posts the
// target's shortUrl. The canned GETs put both cards on the same board.
const attached = okText(await callTool("attachCard", { cardId: "C1", attachCardId: "C2" }));
assert.equal(attached.length, 3);
assert.deepEqual(attached.filter((r) => r.method === "GET").map((r) => r.path).sort(), [
  "/1/cards/C1",
  "/1/cards/C2",
]);
assert.deepEqual(attached.find((r) => r.method === "POST"), {
  method: "POST",
  path: "/1/cards/C1/attachments",
  params: { url: "https://trello.com/c/TGT9", name: "target card" },
});

// placeCards: one list read, then one bounded PUT per card, positioned strictly
// inside the gap after the subtree's last pre-existing card.
const placed = okText(await callTool("placeCards", { listId: "L1", underNumber: "2.1", cardIds: ["n1", "n2"] }));
assert.equal(placed.length, 3);
assert.deepEqual(placed[0], { method: "GET", path: "/1/lists/L1/cards", params: { fields: "name,pos,shortLink" } });
const puts = placed.slice(1).sort((a, b) => a.path.localeCompare(b.path));
assert.deepEqual(puts.map((r) => `${r.method} ${r.path}`), ["PUT /1/cards/n1", "PUT /1/cards/n2"]);
assert.equal(
  puts.every((r) => Number(r.params.pos) > 1000 && Number(r.params.pos) < 2000),
  true,
  `positions must land between the anchor and the next card: ${JSON.stringify(puts)}`,
);

// One card failing to move must not discard the ones that did. An unbounded reject
// took the whole pool down and reported a bare Trello error, while the moves already
// applied stayed applied — a half-reordered list with no record of which half.
const flaky = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (opts.method === "PUT" && u.pathname === "/1/cards/n2") {
    return new Response("card not found", { status: 404, statusText: "Not Found" });
  }
  return flaky(url, opts);
};
const partial = await callTool("placeCards", { listId: "L1", underNumber: "2.1", cardIds: ["n1", "n2"] });
assert.notEqual(partial.res.isError, true, "one bad card must not fail the whole call");
const partialBody = JSON.parse(partial.res.content[0].text);
assert.deepEqual(partialBody.placed.map((r) => r.cardId), ["n1"]);
assert.deepEqual(partialBody.failed.map((r) => r.cardId), ["n2"]);
assert.match(partialBody.failed[0].error, /Trello 404/);
globalThis.fetch = flaky;

// A big batch still goes out concurrently, but through the bounded pool — reverting
// to `Promise.all` over every id opens one socket per card and burns the shared
// rate-limit budget in a single burst. Asserted on the real placeCards path, since
// the pool test above only proves the primitive works, not that this caller uses it.
const many = Array.from({ length: 12 }, (_, i) => `bulk${i}`);
const bulk = await callTool("placeCards", { listId: "L1", underNumber: "2.1", cardIds: many });
okText(bulk);
assert.equal(bulk.sent.filter((r) => r.method === "PUT").length, 12);
assert.equal(fetchPeak, 4, `expected placeCards bounded to 4 in flight, peaked at ${fetchPeak}`);

// resources/read fetches the underlying endpoint and wraps it in MCP's contents
// shape. Recent Activity keeps mcp-trello's limit of 50.
for (const [uri, path, params] of [
  ["trello://board/6a47826d1fa56f9e07523fd4/lists", "/1/boards/6a47826d1fa56f9e07523fd4/lists", {}],
  ["trello://board/6a47826d1fa56f9e07523fd4/activity", "/1/boards/6a47826d1fa56f9e07523fd4/actions", { limit: "50" }],
  ["trello://me/cards", "/1/members/me/cards", {}],
]) {
  requests.length = 0;
  const read = await handle({ id: 7, method: "resources/read", params: { uri } });
  assert.deepEqual(requests, [{ method: "GET", path, params }]);
  assert.equal(read.contents.length, 1);
  assert.equal(read.contents[0].uri, uri);
  assert.equal(read.contents[0].mimeType, "application/json");
  assert.deepEqual(JSON.parse(read.contents[0].text), { ok: true }); // whatever the canned fetch returned
}

// --- Tools added after the merge -------------------------------------------
// Reads that retire trello-board-ids.md's hand-maintained tables.
assert.deepEqual(okText(await callTool("getLabels"))[0], {
  method: "GET",
  path: "/1/boards/6a47826d1fa56f9e07523fd4/labels",
  params: { fields: "id,name,color" },
});
assert.deepEqual(okText(await callTool("getBoardMembers"))[0], {
  method: "GET",
  path: "/1/boards/6a47826d1fa56f9e07523fd4/members",
  params: { fields: "id,fullName,username" },
});
// Both honour an explicit boardId over the env default, and normalise a board URL.
assert.equal(
  okText(await callTool("getLabels", { boardId: "https://trello.com/b/BS4JBXTn/team-bravo" }))[0].path,
  "/1/boards/BS4JBXTn/labels",
);

// Checklists.
assert.deepEqual(okText(await callTool("getCardChecklists", { cardId: "C1" }))[0], {
  method: "GET",
  path: "/1/cards/C1/checklists",
  params: { fields: "id,name", checkItem_fields: "id,name,state,pos" },
});
assert.deepEqual(okText(await callTool("addChecklist", { cardId: "C1", name: "Acceptance Criteria" }))[0], {
  method: "POST",
  path: "/1/cards/C1/checklists",
  params: { name: "Acceptance Criteria" },
});
assert.deepEqual(okText(await callTool("addChecklistItem", { checklistId: "CL1", name: "Given X" }))[0], {
  method: "POST",
  path: "/1/checklists/CL1/checkItems",
  params: { name: "Given X" },
});
// `checked` is omitted unless asked for — an explicit false would read as "uncheck".
assert.deepEqual(
  okText(await callTool("addChecklistItem", { checklistId: "CL1", name: "Given X", checked: true }))[0].params,
  { name: "Given X", checked: "true" },
);

// repairCardHierarchy. One canned board carrying every case the tool has to sort:
//   2.1  no parent link at all, exactly one candidate parent  -> fixable
//   3.1  its parent "3" is not on the board                   -> parentNotFound
//   9.9  linked, but to 9.1 instead of EPIC 9                  -> wrongParent
//   4.1  two cards are numbered "4", so the parent is ambiguous -> left alone
// Only the first is attachable without guessing; the rest need a human decision,
// which is the distinction the tool exists to make.
const REPAIR_BOARD = [
  { shortLink: "e2", name: "EPIC 2. Card Limit", attachments: [] },
  { shortLink: "s21", name: "2.1. Backend enforcement", attachments: [] },
  { shortLink: "s31", name: "3.1. Orphan", attachments: [] },
  { shortLink: "e9", name: "EPIC 9. Other", attachments: [{ url: "https://trello.com/c/s91" }] },
  { shortLink: "s99", name: "9.9. Wrongly parented", attachments: [] },
  { shortLink: "s91", name: "9.1. Correct", attachments: [{ url: "https://trello.com/c/s99" }] },
  { shortLink: "d4a", name: "EPIC 4. Dup", attachments: [] },
  { shortLink: "d4b", name: "4. Dup again", attachments: [] },
  { shortLink: "s41", name: "4.1. Child of a duplicated number", attachments: [] },
];
const repairFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (opts.method === "GET" && /\/cards$/.test(u.pathname)) {
    requests.push({ method: "GET", path: u.pathname, params: {} });
    return new Response(JSON.stringify(REPAIR_BOARD), { status: 200 });
  }
  return repairFetch(url, opts);
};

// dryRun writes nothing: one board read, no POST.
const dry = await callTool("repairCardHierarchy", { dryRun: true });
const dryOut = JSON.parse(dry.res.content[0].text);
assert.equal(dry.sent.filter((r) => r.method === "POST").length, 0, "dryRun must not write");
assert.deepEqual(
  dryOut.wouldAttach.map((p) => `${p.number}->${p.parent}`),
  ["2.1->e2"],
);
// Everything it declines to touch, and why. A card already linked to the wrong parent
// is NOT `missing` — the audit puts it in wrongParent, and repairing it would mean
// detaching first, which is a decision this tool does not make on its own.
assert.deepEqual(dryOut.untouched.parentNotFound.map((p) => p.number), ["3.1"]);
assert.deepEqual(dryOut.untouched.wrongParent.map((p) => p.number), ["9.9"]);
assert.deepEqual(dryOut.untouched.ambiguousParent.map((p) => p.number), ["4.1"]);
assert.deepEqual(
  dryOut.untouched.ambiguousParent[0].expectedParentShortLinks.sort(),
  ["d4a", "d4b"],
);
assert.deepEqual(dryOut.untouched.duplicateNumbers.map((d) => d.number), ["4"]);

// The real run attaches child-to-parent: POST goes to the PARENT's attachments with
// the CHILD's card URL. Reversed, the parent would render under the child.
const repaired = await callTool("repairCardHierarchy", {});
const repairOut = JSON.parse(repaired.res.content[0].text);
const posts = repaired.sent.filter((r) => r.method === "POST");
assert.deepEqual(
  posts.map((r) => `${r.path} ${r.params.url}`),
  ["/1/cards/e2/attachments https://trello.com/c/s21"],
);
assert.equal(repairOut.attached.length, 1);
assert.equal(repairOut.failed.length, 0);
// A URL it writes must be one buildLinkGraph can read back, or the repaired edge is
// invisible to the very audit that asked for it.
assert.deepEqual(
  buildLinkGraph([
    { shortLink: "e2", name: "EPIC 2", attachments: [{ url: "https://trello.com/c/s21" }] },
    { shortLink: "s21", name: "2.1", attachments: [] },
  ]).cards.find((c) => c.shortLink === "s21").attachedTo,
  ["e2"],
);
globalThis.fetch = repairFetch;

// findCard matches on the parsed number, never a string prefix — "2.1" must claim
// "2.1. Story" and neither "2.1.1" (its child) nor "2.10" (a sibling), which is exactly
// what a startsWith test gets wrong. Driven through dispatch because it never was:
// the one tool this suite had never called is where the archived-number bug lived.
const found21 = JSON.parse(
  (await handle({ id: 1, method: "tools/call", params: { name: "findCard", arguments: { number: "2.1" } } })).content[0].text,
);
assert.deepEqual(found21.matches.map((m) => m.shortLink), ["s21"]);
assert.equal(found21.number, "2.1");
// An epic is found by its bare number, since cardNumber reads "EPIC 2" as "2".
const found2 = JSON.parse(
  (await handle({ id: 1, method: "tools/call", params: { name: "findCard", arguments: { number: "2" } } })).content[0].text,
);
assert.deepEqual(found2.matches.map((m) => m.shortLink), ["e2"]);
// Zero matches is an answer, not an error — the caller decides what it means.
const found9 = JSON.parse(
  (await handle({ id: 1, method: "tools/call", params: { name: "findCard", arguments: { number: "9.9" } } })).content[0].text,
);
assert.deepEqual(found9.matches, []);
// An empty number is rejected before it reaches the board.
const emptyNum = await callTool("findCard", { number: "" });
assert.equal(emptyNum.res.isError, true);
assert.match(emptyNum.res.content[0].text, /number is required/);
assert.equal(emptyNum.sent.length, 0);

// listCardAttachments asks for exactly the three fields detachCard needs to be usable.
assert.deepEqual(okText(await callTool("listCardAttachments", { cardId: "C1" }))[0], {
  method: "GET",
  path: "/1/cards/C1/attachments",
  params: { fields: "id,name,url" },
});

// nextCardNumbers must ask for archived cards. Trello defaults this endpoint to
// `visible`, which hides them — and a number the tool cannot see is a number it hands
// out again, straight onto a card that already exists. Asserted on the request itself,
// because nothing in the returned numbers reveals which filter produced them.
const nextReq = okText(await callTool("nextCardNumbers", { under: ["2.1"] }))[0];
assert.equal(nextReq.params.filter, "all", "nextCardNumbers must include archived cards");
assert.match(nextReq.params.fields, /closed/, "it needs `closed` to keep archived cards out of the link graph");

// And the number it actually returns respects the archived card. The canned board has
// an archived 2.1.2, so the next task under 2.1 is 2.1.3 — reissuing 2.1.2 is the bug
// this whole argument exists to prevent.
const nextBody = JSON.parse(
  (await handle({ id: 1, method: "tools/call", params: { name: "nextCardNumbers", arguments: { under: ["2.1"] } } }))
    .content[0].text,
);
assert.equal(nextBody.nextUnder["2.1"].next, "2.1.3", "an archived number must stay retired");
// ...but an archived card must NOT drag the sequence up to its own number. A scratch
// card archived at 88 made nextEpic 89 on the real board and burned 13..88 with it.
// Live cards set the max; archived numbers are only blocked.
assert.equal(nextBody.nextEpic, "3", "archived outliers must not advance the epic sequence");
assert.equal(nextBody.nextUnder["2.1"].parentExists, true);
// The archived card contributes its number and nothing else: it is not in the graph,
// so it can never show up as a stale link somebody is asked to clean up.
assert.deepEqual(nextBody.staleLinkEntries, []);

// The audit and the board listing stay on the default `visible`: repairing links on an
// archived card, or offering one as a parent, is not something anyone asked for.
for (const t of ["auditCardHierarchy", "findCards", "listBoardCardLinks"]) {
  const sent = okText(await callTool(t, {}))[0];
  assert.equal(sent.params.filter, undefined, `${t} must not widen past visible cards`);
}

// ---------------------------------------------------------------------------
// getCardsByList is fields-filtered by default. Unfiltered was mcp-trello's
// behaviour and is what put 369,976 characters through a single card read.
assert.deepEqual(okText(await callTool("getCardsByList", { listId: "L1" }))[0], {
  method: "GET",
  path: "/1/lists/L1/cards",
  params: { fields: "idShort,shortLink,name,idList" },
});
// The escape hatch is an argument, not a second tool.
assert.equal(
  okText(await callTool("getCardsByList", { listId: "L1", fields: "all" }))[0].params.fields,
  "all",
);

// Archive and unarchive are the same field, so they have to be the same shape.
assert.deepEqual(okText(await callTool("archiveCard", { cardId: "C1" }))[0].params, { closed: "true" });
assert.deepEqual(okText(await callTool("unarchiveCard", { cardId: "C1" }))[0].params, { closed: "false" });

// updateChecklistItem is card-scoped: Trello's endpoint takes the CARD id and the
// check item id, and a checklistId in that first slot is the easy mistake.
assert.deepEqual(okText(await callTool("updateChecklistItem", { cardId: "C1", checkItemId: "ci1", state: "complete" }))[0], {
  method: "PUT",
  path: "/1/cards/C1/checkItem/ci1",
  params: { state: "complete" },
});
// A bogus state is caught here, not sent. Trello ignores an unrecognised value and
// answers 200 with the item untouched, which reads exactly like a successful tick.
const badState = await callTool("updateChecklistItem", { cardId: "C1", checkItemId: "ci1", state: "done" });
assert.equal(badState.res.isError, true);
assert.match(badState.res.content[0].text, /"complete" or "incomplete"/);
assert.equal(badState.sent.length, 0, "a rejected state must not reach the API");
// Neither field given is a no-op call, not a valid one.
const noChange = await callTool("updateChecklistItem", { cardId: "C1", checkItemId: "ci1" });
assert.equal(noChange.res.isError, true);
assert.equal(noChange.sent.length, 0);

assert.deepEqual(okText(await callTool("deleteChecklist", { checklistId: "cl1" }))[0], {
  method: "DELETE",
  path: "/1/checklists/cl1",
  params: {},
});

// ---------------------------------------------------------------------------
// Argument validation. Both servers previously serialized an unknown key into
// nothing and reported success — which is how `desc:` against a `description:`
// schema created cards with empty bodies.
const typo = await callTool("addCard", { listId: "L1", name: "N", descriptionn: "lost" });
assert.equal(typo.res.isError, true);
assert.match(typo.res.content[0].text, /descriptionn/);
assert.equal(typo.sent.length, 0, "a rejected call must not reach the API");

const missing = await callTool("addCard", { listId: "L1" });
assert.equal(missing.res.isError, true);
assert.match(missing.res.content[0].text, /name/);
assert.equal(missing.sent.length, 0);

// A no-argument tool rejects anything at all, and names it. getMyBoards is one of the
// few left: getLists/getRecentActivity/addList all take a boardId now, so a rejection
// there would be testing the old inconsistency rather than the validator.
const noArgs = await callTool("getMyBoards", { boardId: "b1" });
assert.equal(noArgs.res.isError, true);
assert.match(noArgs.res.content[0].text, /boardId/);

// And the three that gained one honour it, instead of silently reading the env board.
assert.equal(
  okText(await callTool("getLists", { boardId: "https://trello.com/b/SHORT8/x" }))[0].path,
  "/1/boards/SHORT8/lists",
);
assert.equal(okText(await callTool("getLists", {}))[0].path, "/1/boards/6a47826d1fa56f9e07523fd4/lists");

// Directly, for the plural wording and the accepted-key list.
assert.throws(
  () => validateArgs("addCard", { type: "object", properties: { a: {}, b: {} }, required: ["a"] }, { x: 1, y: 2 }),
  /Unknown arguments for addCard: x, y\. Accepted: a, b/,
);
assert.throws(
  () => validateArgs("addCard", { type: "object", properties: { a: {}, b: {} }, required: ["a", "b"] }, {}),
  /Missing required arguments for addCard: a, b/,
);
// An explicit undefined is still missing; a falsy-but-present value is not.
assert.throws(() => validateArgs("t", { properties: { a: {} }, required: ["a"] }, { a: undefined }), /Missing/);
validateArgs("t", { properties: { a: {} }, required: ["a"] }, { a: "" });

// Types, not just presence. Everything reaches Trello as a query string, so a wrong
// type never fails on its own — String({}) is "[object Object]" and String([]) is "",
// both of which Trello accepts and acts on.
const wrongType = await callTool("addCard", { listId: 123, name: "N" });
assert.equal(wrongType.res.isError, true);
assert.match(wrongType.res.content[0].text, /listId for addCard must be string, got number/);
assert.equal(wrongType.sent.length, 0);
assert.equal(
  (await callTool("getCard", { cardId: "C1", includeComments: "yes" })).res.content[0].text,
  "Argument includeComments for getCard must be boolean, got string",
);
assert.match(
  (await callTool("getRecentActivity", { limit: "10" })).res.content[0].text,
  /limit for getRecentActivity must be number, got string/,
);
// An object where an array belongs is the case String() hides most completely.
assert.match(
  (await callTool("addCard", { listId: "L1", name: "N", labels: {} })).res.content[0].text,
  /labels for addCard must be array, got object/,
);
// Array item types are checked too, with the offending index named.
assert.match(
  (await callTool("addCard", { listId: "L1", name: "N", labels: ["ok", 7] })).res.content[0].text,
  /labels for addCard must be an array of string, but index 1 is number/,
);
// A property with no declared type stays unconstrained.
validateArgs("t", { properties: { a: {} } }, { a: { anything: true } });
// And correct types still pass — the checks must not reject the normal call.
okText(await callTool("getCard", { cardId: "C1", includeComments: true }));
okText(await callTool("getRecentActivity", { limit: 25 }));

// ---------------------------------------------------------------------------
// A sustained 429 gives up with a clear error instead of recursing forever on a
// flat one-second sleep. Retry-After is honoured, so a tiny value keeps this fast.
let attempts = 0;
globalThis.fetch = async () => {
  attempts += 1;
  return new Response("API rate limit exceeded", {
    status: 429,
    statusText: "Too Many Requests",
    headers: { "retry-after": "0.01" },
  });
};
const throttled = await handle({ id: 1, method: "tools/call", params: { name: "getMyCards", arguments: {} } });
assert.equal(throttled.isError, true);
assert.match(throttled.content[0].text, /Trello 429/);
assert.match(throttled.content[0].text, /gave up after 5 attempts/);
assert.equal(attempts, 5, `expected a hard attempt cap, made ${attempts} calls`);

// ---------------------------------------------------------------------------
// Error bodies are redacted. Trello's 404 handler echoes the request line back
// verbatim, query string included, so an unredacted body puts the live key and
// token into the tool result and from there into the transcript. One malformed
// card id is the whole exploit.
const leaky =
  "Cannot GET /1/cards/?key=test-key&token=test-token";
globalThis.fetch = async () =>
  new Response(leaky, { status: 404, statusText: "Not Found" });
const leaked = await handle({
  id: 1,
  method: "tools/call",
  params: { name: "getCard", arguments: { cardId: "" } },
});
assert.equal(leaked.isError, true);
const leakedText = leaked.content[0].text;
assert.doesNotMatch(leakedText, /test-key|test-token/, `credentials leaked: ${leakedText}`);
assert.match(leakedText, /key=\[redacted\].*token=\[redacted\]/);
// The rest of the body still has to survive, or the error stops being diagnostic.
assert.match(leakedText, /Trello 404 Not Found: Cannot GET \/1\/cards\//);

// ---------------------------------------------------------------------------
// Every request carries an abort signal. Dispatch is one serialized promise chain,
// so a socket that never answers doesn't fail one call — it wedges every later
// request for the rest of the session.
let sawSignal;
globalThis.fetch = async (url, opts = {}) => {
  sawSignal = opts.signal;
  return new Response("{}", { status: 200 });
};
await handle({ id: 1, method: "tools/call", params: { name: "getMyCards", arguments: {} } });
assert.ok(sawSignal instanceof AbortSignal, "fetch was called with no abort signal");
assert.equal(sawSignal.aborted, false);

globalThis.fetch = realFetch;

console.log("ok");
