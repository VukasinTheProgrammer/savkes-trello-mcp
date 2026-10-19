# Trello Board ID Reference

Board constants shared by `trello-card-draft` (and its `references/*.md`) and `trello-card-push`. Edit **only here** — every file below points at this one instead of keeping its own copy, so a shared value never needs editing in two places at once.

Empty template — this file is project-specific. Fill in your own board's ids
the first time you set this up (see README's one-time setup), then keep it
updated as sprints/lists/labels change.

## Board ID

The board has two identifiers and they are not interchangeable.

| Board | Form | Value |
|-------|------|-------|
| _(this board's name)_ | full id (24 char) | |
| _(this board's name)_ | shortLink (8 char) | |

`TRELLO_BOARD_ID` in `.mcp.json` must hold the **full 24-character id**. The shortLink is what appears in board URLs (`trello.com/b/<shortLink>`) and it works for read calls, but `addList` rejects it outright with an 8-character format error — that is the symptom of a shortLink sitting in the env var.

Every `mcp__trello-board__*` tool already defaults to that env var, so no skill needs to read either value from here to make a live call. This section exists so the board being synced has one canonical, human-readable source instead of only living inside `.mcp.json`, and so the shortLink is never pasted into the env var again.

## Label ID map

**`mcp__trello-board__getLabels` is the source of truth; this table is a convenience
copy.** Prefer the tool when a run needs a label id — it cannot go stale.

| Name | ID |
|------|----|

## Board members

No table on purpose — one stale table is enough. Call
`mcp__trello-board__getBoardMembers` to resolve a teammate's name or username to the
member id `changeCardMembers` needs, or to map a `getRecentActivity` entry's
`idMemberCreator` back to a person.

## List ID map

Refresh this from a live `getLists` call whenever a list is added, renamed, or archived.

Only the first one or two rows should ever be named as a plan's `Target list` — `trello-card-push` resolves that name to an `idList` for `addCard`, and there is no fallback if the name is missing here.

| Name | ID | Push target? |
|------|-----|---|

## Referenced by

All of these now resolve label IDs with `mcp__trello-board__getLabels` and reach for this file only when that call fails — see `.claude/agents/trello-agent.md` § Output step 1, which holds the rule the others point at.

- `.claude/agents/trello-agent.md` (the label lookup itself, for story and task level)
- `.claude/skills/trello-card-draft/SKILL.md`
- `.claude/skills/trello-card-draft/references/epic.md` (epic level has no subagent, so it calls `getLabels` directly)
- `.claude/skills/trello-card-draft/references/user-story.md`
- `.claude/skills/trello-card-draft/references/task.md`
- `.claude/skills/trello-card-push/SKILL.md`

If a label name a plan references isn't in this table, that's not an error here — the consuming skill's own "skip that label, warn in report" rule still applies unchanged; this file only holds what board constants currently exist.
