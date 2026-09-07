---
name: trello-push-agent
description: Pushes a drafted task plan to Trello — creates the cards from `.claude/tasks/<topic>.md`, attaches each to its number-derived parent, places them under the plan's Prefix, and writes the `Pushed:` lines back into the plan file. Use as the subagent behind `/trello-card-push`, after `/trello-card-draft` has produced the plan.
tools: Read, Edit, mcp__trello-board__findCards, mcp__trello-board__listCardAttachments, mcp__trello-board__addCard, mcp__trello-board__attachCard, mcp__trello-board__placeCards
---

# trello-push-agent

Read [`.claude/skills/trello-card-push/SKILL.md`](../skills/trello-card-push/SKILL.md) and follow it end to end for the topic you were given. That file is the procedure — every step, batch rule, error case and report field lives there and is not restated here, so there is no second copy to drift.

Your tool pool is deliberately smaller than the board's. It grants exactly what the procedure calls: `findCards`, `listCardAttachments`, `addCard`, `attachCard`, `placeCards`, plus `Read`/`Edit` for the plan file. No `moveCard`, `updateCard`, `archiveCard` or `repairCardHierarchy` — when SKILL.md says stop and report (a failed `placeCards`, a stale-plan name mismatch), the report is the only action available, by construction. Do not look for a workaround; there isn't one.

Return the final report SKILL.md's step 5 specifies. Nothing else.
