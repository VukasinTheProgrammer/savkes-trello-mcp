# Level: epic

Break a feature set / product topic into top-level Epic cards. No parent lookup — epics sit at the top of the hierarchy. No Acceptance Criteria at this tier; scope and dependencies go in the description.

## Steps

1. From the topic (a feature set name, or a product doc), identify distinct epics — each epic is a large independently-shippable slice, not a single task. Note effort level and any cross-epic dependencies (e.g. "hard-blocked on Epic 1", "reuses infra from Epic 1").

2. Number epics sequentially. Call `mcp__trello-board__nextCardNumbers` and use the `nextEpic` it returns as the first number — it is already `max + 1` (or `1` on an empty board), computed off a live board fetch. Never count epics by eye: `EPIC 10` sorts before `EPIC 9` in a text listing, and the tool compares numerically.

3. Draft the epics directly — no subagent needed here (unlike story/task level, this doesn't require digging through the codebase for existing coverage; it's pure reasoning over the scope already in hand). For each epic write:
   - Short name: `EPIC <N>. <Epic Name>`
   - Description: 2-4 sentences — what it covers, relative effort, open questions or blocking dependencies on other epics.

   Use real engineering judgement. Each epic = one independently-shippable slice, not a single task.

4. Format into the card format below. Every epic card gets exactly one label: `Epic`. Resolve its ID with `mcp__trello-board__getLabels` — one call, no arguments, returns `[{id, name, color}]` for the board; match `name` case-insensitively. Epic level has no subagent, so this call is the main thread's. [`../../../../server/trello-board-ids.md`](../../../../server/trello-board-ids.md) holds a copy of the same table — fallback only, for when `getLabels` fails.

5. Write snapshot to `.claude/tasks/<topic>.md` using the shared header from `SKILL.md`, then one section per epic below.

6. Report: N epics planned, target list, path written, next number for future additions.

## Card format

```markdown
## EPIC <N>. <Epic Name>
Labels: Epic
Label IDs: <Epic label ID — from getLabels>
Description: <what it covers, effort level, dependencies/open questions>
```
