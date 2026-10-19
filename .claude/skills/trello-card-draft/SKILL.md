---
name: trello-card-draft
description: Draft Trello-ready cards for a topic into `.claude/tasks/<topic>.md`, ready to review and edit before `/trello-card-push` creates them. Resolves the parent card and the next hierarchy number, then hands the writing to the `trello-agent` subagent. Use for sprint planning or breaking a feature into cards.
---

Draft Trello-ready cards for a topic into `.claude/tasks/<topic>.md`, for review before `/trello-card-push` creates them.

## What this skill does, and what it doesn't

**It does not write the cards.** At story and task level this skill is orchestration: it resolves the parent card, gets the next hierarchy number, reads the parent story's acceptance criteria (task level only), and hands all of that to the `trello-agent` subagent — which digs through the codebase, decides the breakdown, writes each card's name, description and acceptance criteria, resolves label IDs, and writes the file. This skill then confirms the file exists and prints the agent's receipt.

`--level epic` is the exception: epics need no codebase digging, so there is no subagent and the main thread drafts them directly.

The output is a **draft**, not a push. Nothing reaches Trello until `/trello-card-push <topic>` runs, which is deliberate — the file is where the cards get reviewed and edited first.

## Usage
Call as: `/trello-card-draft <topic> [--level epic|story|task] [--parent <number>] [--design <file>] [--docs <file>]`
Default level: `story` (breaking a parent epic into user story cards).
`--parent` is the number of the card everything in this run hangs under: an **epic** number at story level (`--parent 2` → stories `2.1`, `2.2`, …), a **story** number at task level (`--parent 2.1` → tasks `2.1.1`, …). Not used at epic level. If it is missing at story or task level, **ask the user which parent** — never guess it from the topic name.
`--design` is optional, story/task levels only (skip for epic — too high-level for page markup). File lives in `.claude/references/designs/` (HTML page markup for the page in scope) so cards reflect real UI structure instead of guessing. Pass just the filename (resolved against `.claude/references/designs/`) or a full path.
`--docs` is optional, story/task levels only. File lives in `.claude/references/docs/` (a markdown spec/requirements doc) so cards are grounded in the written requirements. Pass just the filename (resolved against `.claude/references/docs/`) or a full path.
Both are passed to the subagent as **paths**, never read here — see "Where the files live" below.
Example: `/trello-card-draft playwright-tests --parent 11` (story level), `/trello-card-draft q4-feature-set --level epic`, `/trello-card-draft card-limit-account --level task --parent 2.1 --design card-limit.html --docs card-limit-spec.md`

## Board ID reference
Label IDs are resolved live with `mcp__trello-board__getLabels` (by `trello-agent` at story/task level, by the main thread at epic level). [`../../../server/trello-board-ids.md`](../../../server/trello-board-ids.md) holds a fallback copy, used only if that call fails. The plan file names its list (`Target list: Backlog`); `/trello-card-push` resolves that name to an id.

## Where the files live

`references/` here holds only what **this skill** reads: the three level docs below, and `app-routes.md`.

The inputs you pass with `--design` and `--docs` live in `.claude/references/designs/` and `.claude/references/docs/`, outside this skill. This skill never opens them — it resolves a bare filename to a path and passes the path to the subagent, which reads it. Keeping 600K of product docs inside a skill that never opens them made the skill look like their consumer and buried its own four files. `.claude/references/` in, `.claude/tasks/` out.

## Dispatch

Only one of these ever applies per run — the other two stay unloaded.

**Only load when `--level epic`.** See [epic.md](references/epic.md) for steps and card format.

**Only load when `--level story` (default, or no `--level` given).** See [user-story.md](references/user-story.md) for steps and card format.

**Only load when `--level task`.** See [task.md](references/task.md) for steps and card format.

Each reference doc is self-contained: it tells you what to look up, how to number cards, and the exact card format to emit.

## Where cards land

**Every tier targets `Backlog`.** The board keeps the whole hierarchy there, in order — an epic, then its stories, each story followed by its own tasks, then a `---` card before the next epic. `Current Sprint Backlog` is a *pull-in* list: work is dragged there when it starts, and it holds task cards with no epics, stories or separators. Pushing a plan straight into it would put unstarted work in the sprint and break the ordering the Backlog carries.

`trello-card-push` is what places cards in that order; a plan file only needs to name the list and number its cards correctly.

## Snapshot file header (shared across all levels)

For `--level story` and `--level task` the **subagent** writes this file, header included (see [`../../agents/trello-agent.md`](../../agents/trello-agent.md) § Output) — this section is the spec it follows, and the one the main thread follows directly at `--level epic`, which has no subagent.

```markdown
# Task Plan: <Topic>
Target list: Backlog
Prefix: <the --parent number: e.g. 2 for stories, 2.1 for tasks; EPIC for epic level>
Status: draft

---
```

Follow the header with one card section per the format given in the level's reference doc.

**No `Parent:` line is needed** in the normal case. `trello-card-push` derives each card's parent from its own number — drop the last segment (`11.3.1` → parent `11.3`; `11.3` → parent `11`) — so a task numbered under its story, or a story numbered under its epic, attaches automatically with no explicit line anywhere in the file.

Add an explicit `Parent: [idShort] <name>` line — file-level header, or a per-group line above a set of sections — **only** for a one-off cross-tree link that the numbering itself wouldn't produce (e.g. a task that also needs to reference a card outside its own numeric lineage). When present, the explicit line overrides the number-derived parent, and `trello-card-push` reports the mismatch rather than silently picking one.

`Status: draft` means not yet pushed. After `/trello-card-push` it becomes `Status: pushed`.

For `--level task`, card order in the file follows execution order, not discovery order: task 1 is whatever must be done first, and each later task should only need what an earlier one already built (see [task.md](references/task.md) for the full rule and shape).

## Report
Report: N cards planned, level used, parent (if applicable), target list, path written, next number to use for future additions.

At story/task level the subagent returns a receipt manifest — one line per card, numbers and names only. Print it verbatim; do not expand it back into full card text. The card bodies live in the plan file, which is what the user reviews and edits before `/trello-card-push`.
