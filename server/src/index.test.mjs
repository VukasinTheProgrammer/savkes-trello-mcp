// Selftest for the trello-board server — no network, no credentials, no test framework.
//
//   npm test            (from server/)
//   node server/src/index.test.mjs

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
import {
  EVIDENCE,
  TEAM_RULE,
  buildOutcomeAudit,
  hasDeployedProof,
  hasPullRequest,
  hasTickedDod,
  indexFacts,
  isDeployedComment,
  isOneSentence,
  renderOutcomeAudit,
} from "./utils/outcome.mjs";
import {
  buildReport,
  buildTree,
  compareNumbers,
  countCriteria,
  countOpenCriteria,
  doneListTest,
  renderMermaid,
  renderOutline,
  renderReport,
  scopeTo,
} from "./utils/rollup.mjs";

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

// 16 ported from mcp-trello + 9 from the wrapper + 9 added since + 3 report tools = 37. A name
// collision between the halves would silently drop a tool, so the count is asserted
// alongside the names. This is the only place the total is written down.
const list = await handle({ id: 1, method: "tools/list" });
assert.equal(list.tools.length, 37);
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
    "getBoardMap",
    "getBoardMembers",
    "getCard",
    "getCardChecklists",
    "getCardsByList",
    "getLabels",
    "getLists",
    "getMyBoards",
    "getMyCards",
    "getOutcomeAudit",
    "getRecentActivity",
    "getStatusReport",
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
    "getLabels",
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
// Requests are dispatched concurrently, so replies are compared by id as a set:
// JSON-RPC matches replies to requests by id, not by order.
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
  replies.map((r) => r.id).sort((a, b) => a - b),
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
  if (method === "GET" && u.pathname === "/1/members/me") return { id: "member-1" };
  if (method === "GET" && /^\/1\/(members\/me|boards\/[^/]+\/members\/[^/]+)\/cards$/.test(u.pathname)) {
    return [{ id: "c1", name: "Mine", shortLink: "m1", idBoard: "board-1" }];
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
// The old API-style spellings are rejected by name, not silently dropped.
assert.match(
  (await callTool("addCard", { listId: "L1", name: "N", desc: "D" })).res.content[0].text,
  /Unknown argument for addCard: desc/,
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
for (const [uri, path, params, body = { ok: true }] of [
  ["trello://board/6a47826d1fa56f9e07523fd4/lists", "/1/boards/6a47826d1fa56f9e07523fd4/lists", {}],
  ["trello://board/6a47826d1fa56f9e07523fd4/activity", "/1/boards/6a47826d1fa56f9e07523fd4/actions", { limit: "50" }],
  ["trello://me/cards", "/1/members/me/cards", { fields: "name,shortLink,due,dueComplete,idBoard,idList" },
    [{ id: "c1", name: "Mine", shortLink: "m1", idBoard: "board-1" }]],
]) {
  requests.length = 0;
  const read = await handle({ id: 7, method: "resources/read", params: { uri } });
  assert.deepEqual(requests, [{ method: "GET", path, params }]);
  assert.equal(read.contents.length, 1);
  assert.equal(read.contents[0].uri, uri);
  assert.equal(read.contents[0].mimeType, "application/json");
  assert.deepEqual(JSON.parse(read.contents[0].text), body); // whatever the canned fetch returned
}

// The two "me" reads are filtered: unfiltered, they overflow a client's output cap.
const myAll = await callTool("getMyCards");
assert.deepEqual(okText(myAll), [
  { method: "GET", path: "/1/members/me/cards", params: { fields: "name,shortLink,due,dueComplete,idBoard,idList" } },
]);
// Trello's forced `id` is stripped; shortLink identifies the card.
assert.deepEqual(JSON.parse(myAll.res.content[0].text), [{ name: "Mine", shortLink: "m1", idBoard: "board-1" }]);
// One board: resolve the member id first (the per-board endpoint rejects "me").
assert.deepEqual(
  okText(await callTool("getMyCards", { boardId: "https://trello.com/b/BS4JBXTn/team-bravo" })).map((r) => r.path),
  ["/1/members/me", "/1/boards/BS4JBXTn/members/member-1/cards"],
);
assert.deepEqual(okText(await callTool("getMyBoards"))[0].params, { fields: "name,shortLink,url,closed" });

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
// Every request carries an abort signal, so a socket that never answers fails
// the call instead of leaving it pending forever.
let sawSignal;
globalThis.fetch = async (url, opts = {}) => {
  sawSignal = opts.signal;
  return new Response("{}", { status: 200 });
};
await handle({ id: 1, method: "tools/call", params: { name: "getMyCards", arguments: {} } });
assert.ok(sawSignal instanceof AbortSignal, "fetch was called with no abort signal");
assert.equal(sawSignal.aborted, false);

// ---------------------------------------------------------------------------
// Roll-up, status report and board map, against one fixture board.
{
  const DAY = 86_400_000;
  const AC =
    "**Acceptance Criteria:**\n" +
    "- **Given** a user\n  **When** they sign in\n  **Then** they land home\n" +
    "- **Given** a bad password\n  **When** they sign in\n  **Then** they see an error";
  const listNames = { L1: "Backlog", L2: "Current Sprint Backlog", L3: "Done" };
  const checklists = [
    { id: "ch1", idCard: "c22", name: "Acceptance Criteria", checkItems: [{ name: "a" }, { name: "b" }, { name: "c" }] },
  ];
  // Offsets end in .5 so a few milliseconds of test runtime can't tip a day count.
  const makeFixture = (now) => {
    const ago = (days) => new Date(now - days * DAY).toISOString();
    return [
      { id: "c1", name: "EPIC 1. Auth", idList: "L1" },
      { id: "c11", name: "1.1. Login", idList: "L1", desc: AC },
      { id: "c111", name: "1.1.1. Form", idList: "L3", dateLastActivity: ago(3) },
      { id: "c112", name: "1.1.2. API", idList: "L3", dateLastActivity: ago(2) },
      { id: "c12", name: "1.2. Reset password", idList: "L1", desc: "Nothing written yet." },
      { id: "c121", name: "1.2.1. Email", idList: "L2", labels: [{ name: "Blocked" }], due: ago(4.5), dateLastActivity: ago(30.5) },
      { id: "c122", name: "1.2.2. Page", idList: "L1", dateLastActivity: ago(1) },
      { id: "cx", name: "1.3. Archived", idList: "L1", closed: true },
      { id: "c2", name: "EPIC 2. Reports", idList: "L1" },
      { id: "c22", name: "2.2. Export", idList: "L1" },
      { id: "c221", name: "2.2.1. CSV", idList: "L3" },
      { id: "c210", name: "2.10. Archive old reports", idList: "L3" },
      { id: "c111b", name: "1.1.1. Form again", idList: "L1" },
      { id: "c991", name: "9.9.1. Orphan", idList: "L1", dateLastActivity: ago(2) },
      { id: "sep", name: "---", idList: "L1" },
    ];
  };
  const now = Date.parse("2026-11-06T12:00:00Z");
  const cards = makeFixture(now).filter((c) => !c.closed);
  const tree = buildTree({ cards, lists: listNames, checklists: { c22: checklists } });

  // Numbers sort as numbers, so 2.2 comes before 2.10.
  assert.equal(compareNumbers("2.2", "2.10") < 0, true);
  assert.equal(compareNumbers("1", "1.1") < 0, true);
  assert.deepEqual(tree.nodes.get("2").children.map((n) => n.number), ["2.2", "2.10"]);

  // Roll-up counts work items (leaves); orphans stay in as roots; duplicates and the
  // separator are set aside, not counted.
  assert.deepEqual(tree.roots.map((r) => r.number), ["1", "2", "9.9.1"]);
  assert.equal(tree.nodes.get("9.9.1").orphan, true);
  assert.deepEqual(tree.duplicates, [{ number: "1.1.1", shortLink: undefined }]);
  assert.equal(tree.unnumbered, 1);
  const pct = (n) => [tree.nodes.get(n).done, tree.nodes.get(n).total, tree.nodes.get(n).percent];
  assert.deepEqual(pct("1"), [2, 4, 50]);
  assert.deepEqual(pct("1.1"), [2, 2, 100]);
  assert.deepEqual(pct("1.2"), [0, 2, 0]);
  assert.deepEqual(pct("2"), [2, 2, 100]);
  // A parent dragged into Done with open work under it is still unfinished.
  const early = buildTree({
    cards: [
      { id: "a", name: "EPIC 1. X", idList: "L3" },
      { id: "b", name: "1.1. Y", idList: "L1" },
    ],
    lists: listNames,
  });
  assert.equal(early.nodes.get("1").percent, 0);
  // 249 of 250 must not round up to 100.
  const nearly = buildTree({
    cards: Array.from({ length: 250 }, (_, i) => ({ id: `n${i}`, name: `EPIC ${i + 1}. E`, idList: i ? "L3" : "L1" })),
    lists: listNames,
  });
  assert.equal(buildReport(nearly.roots, { now }).progress.percent, 99);

  // What counts as done, and as acceptance criteria.
  const isDone = doneListTest();
  for (const yes of ["Done", " done ", "Shipped", "Completed", "Done (Q3)"]) assert.equal(isDone(yes), true, yes);
  for (const no of ["Doing", "Undone", "Backlog", undefined]) assert.equal(isDone(no), false, String(no));
  assert.equal(doneListTest(["Live"])("live"), true);
  assert.equal(doneListTest(["Live"])("Done"), false);
  assert.equal(
    buildTree({ cards: [{ id: "a", name: "EPIC 1. X", idList: "L1", dueComplete: true }], lists: listNames }).nodes.get("1").isDone,
    true,
  );
  assert.equal(countCriteria(AC), 2);
  assert.equal(countCriteria("Given the above, we ship."), 0, "a sentence starting with Given is not a criterion");
  // The one-line bullet form the card agent writes.
  assert.equal(
    countCriteria("- **Given** a card. **When** I freeze it. **Then** it is blocked.\n- **Given** x. **When** y. **Then** z."),
    2,
  );
  assert.equal(countCriteria("", [{ name: "acceptance criteria", checkItems: [{}, {}, {}] }, { name: "Todo", checkItems: [{}] }]), 3);
  // Lower-case Given/when/then, as people actually type it, counts too.
  assert.equal(countCriteria("- Given I click Sign out, when the page reloads, then I am on the sign-in page."), 1);
  // Only items explicitly not ticked are open; a missing state never blocks anything.
  assert.equal(
    countOpenCriteria([
      { name: "Acceptance Criteria", checkItems: [{ state: "complete" }, { state: "incomplete" }, {}] },
      { name: "Todo", checkItems: [{ state: "incomplete" }] },
    ]),
    1,
  );
  // A card in a list named Blocked is blocked even without the label.
  const parked = buildTree({
    cards: [
      { id: "a", name: "EPIC 1. X", idList: "L9" },
      { id: "b", name: "1.1. Y", idList: "L9", desc: "Given a, when b, then c." },
      { id: "c", name: "1.1.1. Z", idList: "L9" },
    ],
    lists: { L9: "Blocked" },
  });
  assert.equal(parked.nodes.get("1.1.1").blocked, true);
  // The label has to start with "block": Unblocked and Blockchain are not blockers.
  const labelled = (name) =>
    buildTree({ cards: [{ id: "a", name: "EPIC 1. X", idList: "L1", labels: [{ name }] }], lists: listNames }).nodes.get("1").blocked;
  for (const yes of ["Blocked", "blocked: waiting on API", "Blocker", "Blocking"]) assert.equal(labelled(yes), true, yes);
  for (const no of ["Unblocked", "Blockchain", "Not blocked"]) assert.equal(labelled(no), false, no);
  assert.deepEqual(buildReport(parked.roots, { now }).attention.blocked.items.map((c) => c.number), ["1.1.1"]);
  // Blocked and overdue list the work item once, not once per level.
  const stacked = buildTree({
    cards: [
      { id: "a", name: "EPIC 1. X", idList: "L1", labels: [{ name: "Blocked" }], due: new Date(now - DAY).toISOString() },
      { id: "b", name: "1.1. Y", idList: "L1", labels: [{ name: "Blocked" }], due: new Date(now - DAY).toISOString() },
      { id: "c", name: "1.1.1. Z", idList: "L1", labels: [{ name: "Blocked" }], due: new Date(now - DAY).toISOString() },
    ],
    lists: listNames,
  });
  const stackedReport = buildReport(stacked.roots, { now });
  assert.deepEqual(stackedReport.attention.blocked.items.map((c) => c.number), ["1.1.1"]);
  assert.deepEqual(stackedReport.attention.overdue.items.map((c) => c.number), ["1.1.1"]);
  // A story whose work is done but whose criteria are not ticked is not ready for sign-off.
  const unticked = buildTree({
    cards: [
      { id: "a", name: "EPIC 1. X", idList: "L1" },
      { id: "b", name: "1.1. Y", idList: "L1" },
      { id: "c", name: "1.1.1. Z", idList: "L3" },
    ],
    lists: listNames,
    checklists: { b: [{ name: "Acceptance Criteria", checkItems: [{ state: "complete" }, { state: "incomplete" }] }] },
  });
  const untickedReport = buildReport(unticked.roots, { now });
  assert.equal(untickedReport.readyForSignOff.count, 0);
  assert.deepEqual(untickedReport.attention.storiesWithUnmetCriteria.items, [{ number: "1.1", name: "1.1. Y", open: 1 }]);
  assert.match(renderReport("B", untickedReport, { now }), /Done but acceptance criteria not ticked \(1\):\*\* 1\.1\. Y, 1 open/);

  // The data behind the report.
  const report = buildReport(tree.roots, { now, staleDays: 14 });
  assert.deepEqual(report.progress, { done: 4, total: 7, percent: 57 });
  assert.deepEqual(report.readyForSignOff.items.map((s) => [s.number, s.criteria]), [["1.1", 2], ["2.2", 3]]);
  assert.deepEqual(report.attention.storiesWithoutCriteria.items.map((s) => s.number), ["1.2", "2.10"]);
  assert.deepEqual(report.attention.blocked.items.map((c) => c.number), ["1.2.1"]);
  assert.deepEqual(report.attention.overdue.items.map((c) => [c.number, c.daysLate]), [["1.2.1", 5]]);
  assert.deepEqual(report.attention.stale.items.map((c) => [c.number, c.daysIdle]), [["1.2.1", 30]]);
  assert.deepEqual(report.openByList, { "Current Sprint Backlog": 1, Backlog: 2 });
  // Idle time is about work items: an epic nobody touched is not "idle".
  assert.equal(report.attention.stale.items.some((c) => c.number === "1"), false);

  // Lists are capped but the count is not.
  const busy = buildTree({
    cards: Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, name: `EPIC ${i + 1}. E`, idList: "L1", dateLastActivity: "2020-01-01T00:00:00Z" })),
    lists: listNames,
  });
  const busyStale = buildReport(busy.roots, { now }).attention.stale;
  assert.equal(busyStale.count, 25);
  assert.equal(busyStale.items.length, 10);

  const md = renderReport("Acme delivery", report, { now });
  assert.match(md, /^# Delivery status: Acme delivery\n_2026-11-06_/);
  assert.match(md, /\*\*57% complete\.\*\* 4 of 7 work items done across 2 epics, plus 1 card whose parent is missing\./);
  // The orphan is counted in the totals but listed on its own, not as an epic.
  assert.deepEqual(report.items.map((e) => [e.number, e.tier]), [["1", "epic"], ["2", "epic"]]);
  assert.deepEqual(report.attention.missingParent.items, [{ number: "9.9.1", name: "9.9.1. Orphan", expectedParent: "9.9" }]);
  assert.match(md, /\*\*Parent card missing \(1\):\*\* 9\.9\.1\. Orphan \(no 9\.9\)/);
  assert.doesNotMatch(md, /\| 9\.9\.1\. Orphan \|/);
  // Scoped to a story, the report calls it a story and its children tasks.
  const storyReport = buildReport(scopeTo(tree, "1.2"), { now });
  assert.deepEqual(storyReport.items.map((e) => e.tier), ["story"]);
  assert.deepEqual(storyReport.items[0].children.map((c) => c.tier), ["task", "task"]);
  assert.match(renderReport("B", storyReport, { now }), /0 of 2 work items done across 1 story\./);
  assert.match(md, /\| EPIC 1\. Auth \| █████░░░░░ 50% \| 2 \/ 4 \|/);
  assert.match(md, /\| EPIC 2\. Reports \| ██████████ 100% \| 2 \/ 2 \|/);
  assert.match(md, /## Ready for sign-off\n- \*\*1\.1\. Login\*\*: every work item done, 2 acceptance criteria\n- \*\*2\.2\. Export\*\*/);
  assert.match(md, /\*\*Blocked \(1\):\*\* 1\.2\.1\. Email \[Current Sprint Backlog\]/);
  assert.match(md, /\*\*Overdue \(1\):\*\* 1\.2\.1\. Email, 5 days late/);
  assert.match(md, /\*\*No activity for 14\+ days \(1\):\*\* 1\.2\.1\. Email .*idle 30 days/);
  assert.match(md, /Backlog: 2 · Current Sprint Backlog: 1/);
  assert.doesNotMatch(md, /1\.3\. Archived/, "archived cards stay out");
  // A clean board says so instead of printing an empty heading.
  const calm = buildTree({ cards: [{ id: "a", name: "EPIC 1. X", idList: "L3", desc: "" }], lists: listNames });
  assert.match(renderReport("B", buildReport(calm.roots, { now }), { now }), /Nothing needs attention\./);

  // Board map.
  const outline = renderOutline(tree.roots).split("\n");
  assert.equal(outline[0], "EPIC 1. Auth  █████░░░░░ 50% (2/4)");
  assert.ok(outline.includes("├─ 1.1. Login  ██████████ 100% (2/2)"));
  assert.ok(outline.includes("│  └─ 1.1.2. API  ✓ Done"));
  assert.ok(outline.includes("   ├─ 1.2.1. Email  ○ Current Sprint Backlog [blocked]"));
  assert.ok(outline.includes("└─ 1.2. Reset password  ░░░░░░░░░░ 0% (0/2)"));
  assert.equal(renderOutline(tree.roots, 1).split("\n").length, 3, "depth 1 draws epics only");
  assert.equal(renderOutline(scopeTo(tree, "1.2")).split("\n").length, 3, "a scoped story still draws itself");

  const mermaid = renderMermaid(tree.roots);
  assert.match(mermaid, /^flowchart TD\n/);
  assert.match(mermaid, /n1\["EPIC 1\. Auth<br\/>50%"\]:::partial/);
  assert.match(mermaid, /n1_1_1\["1\.1\.1\. Form"\]:::done/);
  assert.match(mermaid, /n1_2_2\["1\.2\.2\. Page"\]:::open/);
  assert.match(mermaid, /n1 --> n1_1\b/);
  assert.match(mermaid, /classDef done /);
  const nasty = buildTree({ cards: [{ id: "q", name: 'EPIC 7. Say "hi" #1 [x]', idList: "L1" }], lists: listNames });
  assert.match(renderMermaid(nasty.roots), /n7\["EPIC 7\. Say #quot;hi#quot; #35;1 \[x\]"\]/);

  assert.deepEqual(scopeTo(tree, "1").map((n) => n.number), ["1"]);
  assert.deepEqual(scopeTo(tree, undefined), tree.roots);
  assert.throws(() => scopeTo(tree, "9"), /No card numbered "9" on this board\. Top-level numbers: 1, 2\./);

  // The tools, over the real dispatch path with a mocked board.
  let mockCards = makeFixture(Date.now());
  const sent = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    sent.push({ path: u.pathname, params: Object.fromEntries(u.searchParams) });
    const bodies = {
      "/1/boards/BX": { name: "Acme delivery" },
      "/1/boards/BX/lists": Object.entries(listNames).map(([id, name]) => ({ id, name })),
      // Like Trello's default "visible" filter: archived cards are not returned.
      "/1/boards/BX/cards": mockCards.filter((c) => !c.closed),
      "/1/boards/BX/checklists": checklists,
    };
    return u.pathname in bodies
      ? new Response(JSON.stringify(bodies[u.pathname]), { status: 200 })
      : new Response(`not mocked: ${u.pathname}`, { status: 404, statusText: "Not Found" });
  };
  const call = async (name, args = {}) => {
    sent.length = 0;
    const r = await handle({ id: 7, method: "tools/call", params: { name, arguments: { boardId: "BX", ...args } } });
    return { ...r, data: r.isError ? null : JSON.parse(r.content[0].text), text: r.content[0].text };
  };

  const rep = await call("getStatusReport");
  assert.notEqual(rep.isError, true, rep.text);
  assert.equal(rep.data.board, "Acme delivery");
  assert.equal(rep.data.format, "markdown");
  assert.match(rep.data.report, /\*\*57% complete\.\*\*/);
  assert.match(rep.data.report, /1\.2\.1\. Email, 5 days late/);
  // The duplicate and the orphan are surfaced, with the tool that sorts them out.
  assert.match(rep.data.report, /1 duplicate and 1 orphaned card numbers.*auditCardHierarchy/);
  // Four reads, all GET, descriptions requested for the criteria count.
  assert.deepEqual(sent.map((r) => r.path).sort(), ["/1/boards/BX", "/1/boards/BX/cards", "/1/boards/BX/checklists", "/1/boards/BX/lists"]);
  assert.match(sent.find((r) => r.path.endsWith("/cards")).params.fields, /\bdesc\b/);
  // Archived lists are read too, and checklist items come with their ticked state.
  assert.equal(sent.find((r) => r.path.endsWith("/lists")).params.filter, "all");
  assert.match(sent.find((r) => r.path.endsWith("/checklists")).params.checkItem_fields, /state/);
  // None of the description text comes back to the caller.
  assert.doesNotMatch(rep.text, /they land home/);

  const json = await call("getStatusReport", { format: "json" });
  assert.deepEqual(json.data.progress, { done: 4, total: 7, percent: 57 });
  assert.deepEqual(json.data.warnings, { duplicateNumbers: 1, orphans: 1, possiblyTruncated: false });
  assert.equal(json.data.report, undefined);

  const scoped = await call("getStatusReport", { epic: "2", format: "json" });
  assert.deepEqual(scoped.data.progress, { done: 2, total: 2, percent: 100 });
  assert.deepEqual(scoped.data.items.map((e) => e.number), ["2"]);

  // doneLists renames the Done list; with a name nothing matches, nothing is finished.
  const noneDone = await call("getStatusReport", { doneLists: ["Live"], format: "json" });
  assert.equal(noneDone.data.progress.done, 0);

  for (const [args, pattern] of [
    [{ epic: "9" }, /No card numbered "9" on this board\. Top-level numbers: 1, 2\./],
    [{ format: "pdf" }, /format must be one of "markdown", "json", got "pdf"/],
    [{ staleDays: 0 }, /staleDays must be a positive number/],
    [{ doneLists: "Done" }, /doneLists for getStatusReport must be array, got string/],
  ]) {
    const bad = await call("getStatusReport", args);
    assert.equal(bad.isError, true, JSON.stringify(args));
    assert.match(bad.text, pattern);
  }

  const outlineMap = await call("getBoardMap");
  assert.equal(outlineMap.data.format, "outline");
  assert.match(outlineMap.data.map, /^EPIC 1\. Auth {2}█████░░░░░ 50% \(2\/4\)\n/);
  // The map needs no criteria, so it reads neither descriptions nor checklists.
  assert.deepEqual(sent.map((r) => r.path).sort(), ["/1/boards/BX", "/1/boards/BX/cards", "/1/boards/BX/lists"]);
  assert.doesNotMatch(sent.find((r) => r.path.endsWith("/cards")).params.fields, /desc/);
  const flow = await call("getBoardMap", { format: "mermaid", epic: "1", depth: 2 });
  assert.match(flow.data.map, /^flowchart TD/);
  assert.match(flow.data.map, /n1_1\[/);
  assert.doesNotMatch(flow.data.map, /n1_1_1\[/, "depth 2 stops at stories");
  assert.doesNotMatch(flow.data.map, /n2\[/, "epic 1 only");
  for (const [args, pattern] of [
    [{ format: "svg" }, /format must be one of "outline", "mermaid", got "svg"/],
    [{ depth: 0 }, /depth must be a whole number of 1 or more/],
    [{ depth: 1.5 }, /depth must be a whole number of 1 or more/],
    [{ epic: "40" }, /No card numbered "40"/],
  ]) {
    const bad = await call("getBoardMap", args);
    assert.equal(bad.isError, true, JSON.stringify(args));
    assert.match(bad.text, pattern);
  }

  // A board with no numbered cards says what the tools look for, rather than printing 0%.
  mockCards = [{ id: "z", name: "Fix the printer", idList: "L1" }];
  const empty = await call("getStatusReport");
  assert.equal(empty.isError, true);
  assert.match(empty.text, /No numbered cards on this board \(1 cards, none named like "EPIC 1\./);
}

// ---------------------------------------------------------------------------
// Outcome audit: is "Done" backed by something on the card? All data below is invented.
{
  // Evidence, part 1: what counts as a pull-request link. Only the URL is read.
  for (const url of [
    "https://github.com/acme/web/pull/42",
    "https://github.com/acme/web/pull/42/files?diff=split#r1",
    "https://gitlab.com/acme/group/web/-/merge_requests/7",
    "https://bitbucket.org/acme/web/pull-requests/3",
    "https://dev.azure.com/acme/proj/_git/web/pullrequest/9",
    "https://git.example.test/acme/web/pull/12",
  ]) assert.equal(hasPullRequest([{ url }]), true, url);
  for (const url of [
    "https://github.com/acme/web/issues/42",
    "https://github.com/acme/web/pull/",
    "https://github.com/acme/web/pulls",
    "https://github.com/acme/web/commit/abc123",
    "https://trello.com/c/AbCd1234/12-card",
    "https://files.example.test/spec.pdf",
    "ftp://git.example.test/acme/web/pull/12",
    "not a url",
    undefined,
  ]) assert.equal(hasPullRequest([{ url }]), false, String(url));
  assert.equal(hasPullRequest([]), false);
  assert.equal(hasPullRequest(undefined), false);
  assert.equal(hasPullRequest([{ url: "https://files.example.test/a.pdf" }, { url: "https://github.com/acme/web/pull/1" }]), true);

  // Evidence, part 2: a comment that says "deployed". A sentence that denies it, defers
  // it or asks about it is not proof, so each of those is read as no.
  for (const yes of [
    "Deployed to staging.",
    "deployed",
    "Merged, then deployed on Friday.",
    "DEPLOYED to prod",
    "Fixed the typo. Deployed after lunch.",
    // "once"/"when" followed by something that already happened is a done deploy.
    "Deployed to production once QA signed off.",
    "Deployed when the tests passed.",
    // "needed" in a past-tense note does not defer anything.
    "Deployed; no further changes needed.",
    // Other ways a team says the same thing.
    "Released to customers on Friday.",
    "Shipped in v2.4.",
    "Rolled out to all users.",
    "The feature went live this morning.",
    "Live in production since 9am.",
  ]) assert.equal(isDeployedComment(yes), true, yes);
  for (const no of [
    "Not deployed yet, waiting for the release window.",
    "It will be deployed tomorrow.",
    "Can't be deployed until review is done.",
    "Ready to be deployed.",
    "Is it deployed?",
    "Not deployed. Looks fine.",
    "Looks good to me.",
    "undeployed",
    // "once"/"when" in front of something still to come is a deferral.
    "Deployed when the release window opens.",
    "Gets deployed once the window opens.",
    "Deployed, then rolled back.",
    // The new wordings are held to the same standard as "deployed".
    "Not released yet.",
    "Will be shipped next sprint.",
    "Is it live in production?",
    "Release is still unreleased.",
    "Shipped, then reverted.",
    "",
    undefined,
  ]) assert.equal(isDeployedComment(no), false, String(no));

  // The newest comment about the deploy decides: a rollback after "deployed" takes the
  // proof back, and a fresh "deployed" after the rollback restores it.
  const at = (text, day) => ({ text, date: `2026-11-0${day}T10:00:00.000Z` });
  assert.equal(hasDeployedProof([at("Deployed to production.", 1)]), true);
  assert.equal(hasDeployedProof([at("Rolled back, it broke checkout.", 2), at("Deployed to production.", 1)]), false);
  assert.equal(hasDeployedProof([at("Deployed to production.", 1), at("Reverted the release.", 2)]), false, "order of the array does not matter");
  assert.equal(hasDeployedProof([at("Deployed again with the fix.", 3), at("Rolled back.", 2), at("Deployed.", 1)]), true);
  assert.equal(hasDeployedProof([at("Looks good.", 2), at("Deployed.", 1)]), true, "an unrelated newer comment changes nothing");
  assert.equal(hasDeployedProof([]), false);
  assert.equal(hasDeployedProof(undefined), false);

  // Evidence, part 3: a Definition of Done checklist with every item ticked. Missing
  // state is not a tick, and every such checklist on the card must be ticked.
  const dod = (states, name = "Definition of Done") => [{ name, checkItems: states.map((state) => ({ name: "x", state })) }];
  assert.equal(hasTickedDod(dod(["complete", "complete"])), true);
  assert.equal(hasTickedDod(dod(["complete"], "DoD")), true);
  assert.equal(hasTickedDod(dod(["complete"], "Team definition of done")), true);
  assert.equal(hasTickedDod(dod(["complete", "incomplete"])), false);
  assert.equal(hasTickedDod(dod([])), false);
  assert.equal(hasTickedDod(dod(["complete"], "Release notes")), false);
  assert.equal(hasTickedDod(dod(["complete"], "Methodology")), false);
  assert.equal(hasTickedDod([{ name: "Definition of Done", checkItems: [{ name: "a" }] }]), false);
  assert.equal(hasTickedDod([...dod(["complete"]), ...dod(["incomplete"])]), false);
  assert.equal(hasTickedDod(undefined), false);

  // The "one sentence" half of the Blocked rule.
  for (const yes of [
    "Waiting for the vendor API key.",
    "Waiting for api.example.test to be fixed",
    "  Blocked on legal review!  ",
    // A full stop after an abbreviation does not end the sentence.
    "Waiting on Acme Inc. to sign the contract.",
    "Needs a decision from Dr. Kaya.",
    "Waiting on design, e.g. the new icons.",
  ]) {
    assert.equal(isOneSentence(yes), true, yes);
  }
  for (const no of [
    "Vendor is down. Retry Monday.",
    "Waiting on legal.\nWill ask again Friday.",
    "Waiting on Acme Inc.\nRetry Monday.",
    "",
    "   ",
    undefined,
  ]) {
    assert.equal(isOneSentence(no), false, String(no));
  }

  // The rule is written once, in code, and printed with every audit.
  assert.deepEqual(TEAM_RULE.map((r) => r.id), ["pull-request", "criteria-ticked", "blocked"]);
  assert.deepEqual(EVIDENCE.map((e) => e.id), ["pull-request", "deployed-comment", "definition-of-done"]);
  assert.equal(Object.isFrozen(EVIDENCE), true);
  assert.equal(Object.isFrozen(TEAM_RULE), true);

  // --- The fixture board ---------------------------------------------------
  const AC = "- **Given** a user\n  **When** they act\n  **Then** it works";
  const lists = { L1: "Backlog", L2: "Doing", L3: "Done" };
  const PR = [{ url: "https://github.com/acme/web/pull/42" }];
  const blocked = [{ name: "Blocked" }];
  const fixtureCards = () => [
    { id: "e1", name: "EPIC 1. Auth", idList: "L1" },
    { id: "s11", name: "1.1. Login", idList: "L1", desc: AC },
    { id: "t111", name: "1.1.1. Form", idList: "L3", attachments: PR },
    { id: "t112", name: "1.1.2. API", idList: "L3", attachments: [] },
    { id: "s12", name: "1.2. Reset password", idList: "L1", desc: AC },
    { id: "t121", name: "1.2.1. Email", idList: "L3" },
    { id: "t122", name: "1.2.2. Page", idList: "L3" },
    { id: "s13", name: "1.3. Profile", idList: "L1", desc: AC },
    { id: "t131", name: "1.3.1. Avatar", idList: "L3" },
    { id: "t132", name: "1.3.2. Bio", idList: "L3" },
    { id: "e2", name: "EPIC 2. Reports", idList: "L1" },
    { id: "s21", name: "2.1. Export", idList: "L1", desc: AC },
    { id: "t211", name: "2.1.1. CSV", idList: "L2", labels: blocked, idMembers: ["m1"] },
    { id: "t212", name: "2.1.2. PDF", idList: "L2", labels: blocked, idMembers: [] },
    { id: "t213", name: "2.1.3. XLSX", idList: "L2", labels: blocked, idMembers: ["m1", "m2"] },
    { id: "s22", name: "2.2. Archive", idList: "L1", desc: AC },
    { id: "t221", name: "2.2.1. Old reports", idList: "L3", attachments: PR },
    { id: "sep", name: "---", idList: "L1" },
  ];
  const fixtureChecklists = [
    {
      id: "k122",
      idCard: "t122",
      name: "Definition of Done",
      checkItems: [{ name: "tests", state: "complete" }, { name: "docs", state: "complete" }],
    },
    {
      id: "k221",
      idCard: "t221",
      name: "Acceptance Criteria",
      checkItems: [{ name: "a", state: "complete" }, { name: "b", state: "incomplete" }],
    },
  ];
  const comment = (id, card, text, date) => ({ id, date, data: { text, ...(card && { card: { id: card } }) } });
  // Newest first, as Trello returns them. t213 has two comments: only the newest counts.
  const fixtureComments = [
    comment("a6", null, "Deployed everywhere.", "2026-11-05T11:00:00.000Z"),
    comment("a5", "t213", "Vendor is down. Retry Monday.", "2026-11-05T10:00:00.000Z"),
    comment("a4", "t132", "Not deployed yet, waiting for the release window.", "2026-11-04T10:00:00.000Z"),
    comment("a3", "t211", "Waiting for the finance team to approve the format.", "2026-11-03T10:00:00.000Z"),
    comment("a2", "t121", "Looks good to me.", "2026-11-02T10:00:00.000Z"),
    comment("a1", "t112", "Deployed to staging.", "2026-11-01T10:00:00.000Z"),
    comment("a0", "t213", "Waiting on the vendor.", "2026-10-31T10:00:00.000Z"),
  ];

  // Moves and creations, newest first, as Trello returns them. Only putting a card in a Done
  // list starts the clock, and the newest one wins: t131 was Done 20 days ago, went back to
  // Doing, and has been Done again for 9 days. t132 was created straight into Done.
  const daysAgo = (n) => new Date(Date.now() - n * 86400000 - 3600000).toISOString();
  const move = (id, card, to, date) => ({ id, type: "updateCard", date, data: { card: { id: card }, listAfter: { id: "x", name: to } } });
  const created = (id, card, inList, date) => ({ id, type: "createCard", date, data: { card: { id: card }, list: { id: "x", name: inList } } });
  const fixtureMoves = [
    move("m4", "t211", "Doing", daysAgo(2)),
    move("m3", "t121", "Done", daysAgo(3)),
    move("m2", "t131", "Done", daysAgo(9)),
    move("m1", "t131", "Doing", daysAgo(15)),
    move("m0", "t131", "Done", daysAgo(20)),
    created("c1", "t132", "Done", daysAgo(12)),
  ];

  // Over the real dispatch path with a mocked board, recording every request.
  let actionPages = () => fixtureComments;
  let movePages = () => fixtureMoves;
  let mockCards = fixtureCards();
  const sent = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    sent.push({ method: opts.method ?? "GET", path: u.pathname, params: Object.fromEntries(u.searchParams) });
    const bodies = {
      "/1/boards/BX": () => ({ name: "Acme delivery" }),
      "/1/boards/BX/lists": () => Object.entries(lists).map(([id, name]) => ({ id, name })),
      "/1/boards/BX/cards": () => mockCards,
      "/1/boards/BX/checklists": () => fixtureChecklists,
      "/1/boards/BX/actions": () => {
        const params = Object.fromEntries(u.searchParams);
        return params.filter === "commentCard" ? actionPages(params) : movePages(params);
      },
    };
    return u.pathname in bodies
      ? new Response(JSON.stringify(bodies[u.pathname]()), { status: 200 })
      : new Response(`not mocked: ${u.pathname}`, { status: 404, statusText: "Not Found" });
  };
  const reqs = (filter) => sent.filter((r) => r.path.endsWith("/actions") && r.params.filter === filter);
  const call = async (args = {}) => {
    sent.length = 0;
    const r = await handle({ id: 9, method: "tools/call", params: { name: "getOutcomeAudit", arguments: { boardId: "BX", ...args } } });
    return { ...r, data: r.isError ? null : JSON.parse(r.content[0].text), text: r.content[0].text };
  };

  const audit = await call({ format: "json" });
  assert.notEqual(audit.isError, true, audit.text);
  assert.equal(audit.data.board, "Acme delivery");
  // The percentage everyone already reads, and the one next to it that has to be earned.
  assert.deepEqual(audit.data.progress, { done: 7, total: 10, percent: 70 });
  assert.deepEqual(audit.data.provenDone, { done: 4, total: 10, percent: 40 });
  assert.deepEqual(
    audit.data.items.map((i) => [i.number, i.done, i.total, i.percent, i.provenDone, i.provenPercent]),
    [["1", 6, 6, 100, 3, 50], ["2", 1, 4, 25, 1, 25]],
  );
  // Evidence of any one kind is enough: a PR (1.1.1), a "deployed" comment (1.1.2), a
  // ticked Definition of Done (1.2.2). A denial ("Not deployed yet") and a bare "Looks
  // good" are not. A comment with no card is ignored.
  // Story 1.3 looks ready for sign-off (every item is Done) and none of its items has
  // evidence. Story 1.1 has evidence on one of its two items, so it is not listed.
  assert.deepEqual(audit.data.unprovenSignOff, { count: 1, items: [{ number: "1.3", name: "1.3. Profile", workItems: 2 }] });
  // The team rule, applied the same way to every card.
  assert.deepEqual(audit.data.ruleBreaks.doneWithoutPullRequest.items.map((c) => c.number), ["1.1.2", "1.2.1", "1.2.2", "1.3.1", "1.3.2"]);
  assert.equal(audit.data.ruleBreaks.doneWithoutPullRequest.count, 5);
  assert.deepEqual(audit.data.ruleBreaks.doneWithOpenCriteria, {
    count: 1,
    items: [{ number: "2.2.1", name: "2.2.1. Old reports", open: 1 }],
  });
  assert.deepEqual(audit.data.ruleBreaks.blockedIncomplete, {
    count: 2,
    items: [
      { number: "2.1.2", name: "2.1.2. PDF", problems: ["no member", "no reason"] },
      { number: "2.1.3", name: "2.1.3. XLSX", problems: ["more than one member", "reason is more than one sentence"] },
    ],
  });
  assert.deepEqual(audit.data.rule, TEAM_RULE);
  assert.deepEqual(audit.data.evidence, EVIDENCE);
  assert.deepEqual(audit.data.warnings, {
    duplicateNumbers: 0,
    orphans: 0,
    possiblyTruncated: false,
    commentsPossiblyTruncated: false,
    movesPossiblyTruncated: false,
  });

  // Done cards with nothing to show for it, longest waiting first. The clock starts when the
  // card was last put in a Done list, by a move or by being created there.
  assert.deepEqual(audit.data.waiting, {
    count: 3,
    items: [
      { number: "1.3.2", name: "1.3.2. Bio", days: 12 },
      { number: "1.3.1", name: "1.3.1. Avatar", days: 9 },
      { number: "1.2.1", name: "1.2.1. Email", days: 3 },
    ],
  });

  // Read-only on the wire: only GETs, and the comment/attachment/member fields it needs.
  assert.equal(sent.every((r) => r.method === "GET"), true, "getOutcomeAudit must only read");
  assert.deepEqual(
    [...new Set(sent.map((r) => r.path))].sort(),
    ["/1/boards/BX", "/1/boards/BX/actions", "/1/boards/BX/cards", "/1/boards/BX/checklists", "/1/boards/BX/lists"],
  );
  const cardsReq = sent.find((r) => r.path.endsWith("/cards")).params;
  assert.equal(cardsReq.attachments, "true");
  assert.equal(cardsReq.attachment_fields, "url");
  assert.match(cardsReq.fields, /\bidMembers\b/);
  assert.deepEqual(
    [...new Set(sent.filter((r) => r.path.endsWith("/actions")).map((r) => r.params.filter))].sort(),
    ["commentCard", "createCard,updateCard:idList"],
  );
  assert.equal(sent.find((r) => r.path.endsWith("/checklists")).params.checkItem_fields, "name,state");

  // Nothing a person wrote and nobody's id comes back: counts and card names only.
  for (const secret of ["finance team", "Vendor is down", "release window", "Deployed to staging", "m1", "m2"]) {
    assert.equal(audit.text.includes(secret), false, `${secret} leaked into the result`);
  }

  // The markdown a person would paste.
  const md = await call();
  assert.notEqual(md.isError, true, md.text);
  assert.equal(md.data.format, "markdown");
  assert.match(md.data.report, /^# Outcome audit: Acme delivery/);
  assert.match(md.data.report, /\*\*70% in Done\. 40% with evidence\.\*\*/);
  assert.match(md.data.report, /7 of 10 work items sit in Done; 4 of them show evidence\./);
  assert.match(md.data.report, /## Sign-off without evidence\n- \*\*1\.3\. Profile\*\*: all 2 work items are Done, none shows evidence/);
  assert.match(
    md.data.report,
    /## Done without evidence, longest waiting\n- \*\*1\.3\.2\. Bio\*\*: 12 days in Done\n- \*\*1\.3\.1\. Avatar\*\*: 9 days in Done\n- \*\*1\.2\.1\. Email\*\*: 3 days in Done/,
  );
  assert.match(md.data.report, /Done without a pull request \(5\)/);
  assert.match(md.data.report, /Done with acceptance criteria not ticked \(1\):\*\* 2\.2\.1\. Old reports, 1 open/);
  assert.match(md.data.report, /Blocked without exactly one member and one sentence \(2\):\*\* 2\.1\.2\. PDF \(no member, no reason\)/);
  assert.match(md.data.report, /## The rule/);
  for (const r of TEAM_RULE) assert.ok(md.data.report.includes(r.text), `rule line missing: ${r.id}`);
  for (const e of EVIDENCE) assert.ok(md.data.report.includes(e.text), `evidence line missing: ${e.id}`);
  assert.equal(md.text.includes("finance team"), false);

  // The rule reads the same on every call, whatever else the caller asks for.
  const scopedJson = await call({ epic: "2", format: "json" });
  assert.deepEqual(scopedJson.data.rule, audit.data.rule);

  // Scoping: one epic, one story.
  assert.deepEqual(scopedJson.data.progress, { done: 1, total: 4, percent: 25 });
  assert.deepEqual(scopedJson.data.provenDone, { done: 1, total: 4, percent: 25 });
  assert.equal(scopedJson.data.unprovenSignOff.count, 0);
  assert.equal(scopedJson.data.ruleBreaks.blockedIncomplete.count, 2);
  const story = await call({ epic: "1.3", format: "json" });
  assert.deepEqual(story.data.progress, { done: 2, total: 2, percent: 100 });
  assert.deepEqual(story.data.provenDone, { done: 0, total: 2, percent: 0 });
  assert.equal(story.data.unprovenSignOff.count, 1);

  // Nothing in a Done list means nothing is proven and nothing is waiting for sign-off.
  const noneDone = await call({ doneLists: ["Live"], format: "json" });
  assert.deepEqual(noneDone.data.progress, { done: 0, total: 10, percent: 0 });
  assert.deepEqual(noneDone.data.provenDone, { done: 0, total: 10, percent: 0 });
  assert.equal(noneDone.data.unprovenSignOff.count, 0);

  // Done with evidence can never exceed done: a card with evidence that is not in Done does not count.
  mockCards = fixtureCards().map((c) => (c.id === "t131" ? { ...c, idList: "L2", attachments: PR } : c));
  const early = await call({ format: "json" });
  assert.deepEqual(early.data.progress, { done: 6, total: 10, percent: 60 });
  assert.deepEqual(early.data.provenDone, { done: 4, total: 10, percent: 40 });
  // Story 1.3 is no longer complete, so it no longer looks ready.
  assert.equal(early.data.unprovenSignOff.count, 0);
  mockCards = fixtureCards();

  // Comments are read a full page at a time, newest first, following `before`. A
  // "deployed" comment on the second page still counts.
  const filler = (page) => Array.from({ length: 1000 }, (_, i) => comment(`p${page}-${i}`, "nobody", "noise", "2026-10-01T00:00:00.000Z"));
  actionPages = ({ before }) =>
    before ? [...fixtureComments, comment("old", "t121", "Deployed on Tuesday.", "2026-09-01T00:00:00.000Z")] : filler(0);
  const paged = await call({ format: "json" });
  const actionReqs = reqs("commentCard");
  assert.equal(actionReqs.length, 2);
  assert.equal(actionReqs[0].params.before, undefined);
  assert.equal(actionReqs[1].params.before, "p0-999");
  assert.equal(paged.data.provenDone.done, 5, "1.2.1 is proven by a comment on page two");
  assert.equal(paged.data.warnings.commentsPossiblyTruncated, false);

  // A board with endless comments stops at a cap and says the answer may be incomplete,
  // instead of looping or claiming certainty.
  actionPages = ({ before }) => filler(before ? Number(before.slice(1).split("-")[0]) + 1 : 0);
  const endless = await call();
  assert.equal(reqs("commentCard").length, 10);
  assert.match(endless.data.report, /_Note: .*comments.*may be incomplete/);

  // If Trello ignored `before` and served the first page again, the read stops at once and
  // says it is incomplete, instead of counting the same comments ten times.
  actionPages = () => filler(0);
  const repeated = await call({ format: "json" });
  assert.equal(reqs("commentCard").length, 2);
  assert.equal(repeated.data.warnings.commentsPossiblyTruncated, true);
  actionPages = () => fixtureComments;

  // The same guard for card moves: a repeated first page stops the read and is reported, and
  // the waiting times that could not be read come back without an age instead of a wrong one.
  movePages = () => Array.from({ length: 1000 }, (_, i) => move(`q${i}`, "nobody", "Backlog", daysAgo(1)));
  const movesRepeated = await call({ format: "json" });
  assert.equal(reqs("createCard,updateCard:idList").length, 2);
  assert.equal(movesRepeated.data.warnings.movesPossiblyTruncated, true);
  assert.equal(movesRepeated.data.waiting.items.every((w) => w.days === null), true);
  const movesNote = await call();
  assert.match(movesNote.data.report, /_Note: .*card moves.*waiting times may be missing/);
  assert.match(movesNote.data.report, /\*\*1\.2\.1\. Email\*\*: no move into Done found/);
  movePages = () => fixtureMoves;

  // Nothing waiting: the section says so instead of vanishing.
  mockCards = fixtureCards().map((c) => (["t121", "t131", "t132"].includes(c.id) ? { ...c, attachments: PR } : c));
  const clean = await call();
  assert.match(clean.data.report, /## Done without evidence, longest waiting\nEvery Done card shows evidence\./);
  mockCards = fixtureCards();

  // Card names are shown as text in the markdown lists, not read as formatting.
  mockCards = fixtureCards().map((c) => (c.id === "t132" ? { ...c, name: "1.3.2. *Bio* [draft]" } : c));
  const escaped = await call();
  assert.ok(escaped.data.report.includes("1.3.2. \\*Bio\\* \\[draft\\]"), escaped.data.report);
  mockCards = fixtureCards();

  // Work that never has a pull request: a Done card with an exempt label is not listed for the
  // missing one (label match ignores case), the rule says so, and nothing else about it changes.
  const design = (c) => (c.id === "t131" ? { ...c, labels: [{ name: "Design" }] } : c);
  mockCards = fixtureCards().map(design);
  const plain = await call({ format: "json" });
  assert.equal(plain.data.ruleBreaks.doneWithoutPullRequest.count, 5, "no exemption by default");
  assert.deepEqual(plain.data.exemptLabels, []);
  const exempt = await call({ format: "json", exemptLabels: [" design "] });
  assert.equal(exempt.data.ruleBreaks.doneWithoutPullRequest.count, 4);
  assert.equal(exempt.data.ruleBreaks.doneWithoutPullRequest.items.some((c) => c.number === "1.3.1"), false);
  assert.deepEqual(exempt.data.exemptLabels, ["design"]);
  assert.deepEqual(exempt.data.provenDone, plain.data.provenDone, "evidence is not changed by an exemption");
  assert.deepEqual(exempt.data.unprovenSignOff, plain.data.unprovenSignOff);
  const exemptMd = await call({ exemptLabels: ["Design", "Docs"] });
  assert.match(exemptMd.data.report, /Done without a pull request \(4\)/);
  assert.match(exemptMd.data.report, /- Cards labelled design, docs are not asked for a pull request\./);
  assert.equal((await call()).data.report.includes("are not asked for a pull request"), false);
  mockCards = fixtureCards();

  // A card that is Done and Blocked at once is named, not silently resolved: the numbers still
  // follow the status report's rule, and the report says one of the two is out of date.
  mockCards = fixtureCards().map((c) => (c.id === "t131" ? { ...c, labels: blocked } : c));
  const both = await call({ format: "json" });
  assert.deepEqual(both.data.inconsistent.doneAndBlocked, { count: 1, items: [{ number: "1.3.1", name: "1.3.1. Avatar" }] });
  assert.equal(both.data.progress.done, 7, "still counted as Done, like the status report");
  assert.match((await call()).data.report, /## Cards that say two things\n- \*\*Counted as Done but also Blocked \(1\):\*\* 1\.3\.1\. Avatar\./);
  mockCards = fixtureCards();
  assert.deepEqual((await call({ format: "json" })).data.inconsistent.doneAndBlocked, { count: 0, items: [] });
  assert.equal((await call()).data.report.includes("Cards that say two things"), false);

  // Arguments are checked before any request goes out.
  for (const [args, pattern] of [
    [{ epic: "9" }, /No card numbered "9" on this board\. Top-level numbers: 1, 2\./],
    [{ format: "pdf" }, /format must be one of "markdown", "json", got "pdf"/],
    [{ doneLists: "Done" }, /doneLists for getOutcomeAudit must be array, got string/],
    [{ exemptLabels: "Design" }, /exemptLabels for getOutcomeAudit must be array, got string/],
    [{ exemptLabels: ["Design", 7] }, /exemptLabels for getOutcomeAudit must be an array of string, but index 1 is number/],
    [{ staleDays: 7 }, /Unknown argument for getOutcomeAudit: staleDays/],
  ]) {
    const bad = await call(args);
    assert.equal(bad.isError, true, JSON.stringify(args));
    assert.match(bad.text, pattern);
  }

  // A board with no numbered cards says what the tool looks for, rather than printing 0%.
  mockCards = [{ id: "z", name: "Fix the printer", idList: "L1" }];
  const empty = await call();
  assert.equal(empty.isError, true);
  assert.match(empty.text, /No numbered cards on this board/);
  mockCards = fixtureCards();

  // Pure layer: the same facts in, the same audit out, and the first of two cards that
  // share a number is the one read, as in the status report.
  const dupes = indexFacts(
    [
      { id: "d1", name: "1.1.1. Twin", attachments: PR },
      { id: "d2", name: "1.1.1. Twin again" },
    ],
    {},
    new Map(),
  );
  assert.equal(dupes.size, 1);
  assert.equal(dupes.get("1.1.1").pullRequest, true);
  const tree = buildTree({ cards: fixtureCards(), lists, checklists: { t122: [fixtureChecklists[0]], t221: [fixtureChecklists[1]] } });
  const facts = indexFacts(fixtureCards(), { t122: [fixtureChecklists[0]], t221: [fixtureChecklists[1]] }, new Map());
  const pure = buildOutcomeAudit(tree.roots, facts);
  assert.deepEqual(pure.progress, { done: 7, total: 10, percent: 70 });
  // No comments were passed here, so the "deployed" card (1.1.2) is the one that drops out.
  assert.deepEqual(pure.provenDone, { done: 3, total: 10, percent: 30 });
  assert.match(renderOutcomeAudit("B", pure, { now: Date.parse("2026-11-07T00:00:00Z") }), /^# Outcome audit: B\n_2026-11-07_/);
}

globalThis.fetch = realFetch;

console.log("ok");
