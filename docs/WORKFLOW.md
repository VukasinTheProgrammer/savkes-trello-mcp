# How the card workflow works

A guide for developers to how this repo's skills, agents and MCP tools turn
an idea into numbered, linked Trello cards. Every diagram is based on the
files it names; the line references are there so you can check them.

**Files involved**

| Piece | File | Role |
|---|---|---|
| Draft skill | `.claude/skills/trello-card-draft/SKILL.md` (+ `references/epic.md`, `user-story.md`, `task.md`) | `/trello-card-draft`: resolves parent and numbers, delegates the writing |
| Writer agent | `.claude/agents/trello-agent.md` | Writes the card text into a plan file. **Cannot create cards.** |
| Push skill | `.claude/skills/trello-card-push/SKILL.md` | `/trello-card-push`: the push procedure, step by step |
| Push agent | `.claude/agents/trello-push-agent.md` | Follows the push skill and creates, attaches and places the cards |
| MCP server | `server/src/` | The Trello tools both agents call (`mcp__trello-board__*`) |
| Plan file | `.claude/tasks/<topic>.md` | The hand-off between draft and push, edited by you in between |

---

## 1. The big picture

```mermaid
flowchart LR
    U([You]) -->|"/trello-card-draft topic"| D[Draft skill<br/>main thread]
    D -->|epic level:<br/>writes itself| PF
    D -->|story / task level:<br/>spawns| W[trello-agent]
    W -->|Write| PF[(".claude/tasks/topic.md<br/>Status: draft")]
    PF -->|you review & edit| PF
    U -->|"/trello-card-push topic"| P[Push skill<br/>main thread]
    P -->|spawns| PA[trello-push-agent]
    PA -->|reads + writes Pushed: lines| PF
    PA -->|addCard · attachCard · placeCards| T[(Trello board)]
    D -. findCard · nextCardNumbers · getCard .-> T
    W -. getLabels .-> T
```

Two phases with **you in the middle**. Drafting writes a plan file, never a
card. Only the push creates cards. Nothing reaches Trello until you've read
the plan, which is also why this flow isn't a Claude Code workflow: a
workflow can't stop halfway for you.

---

## 2. Numbering: the hierarchy lives in the card name

```mermaid
flowchart TD
    E["EPIC 2. Payments<br/>(epic: label Epic)"]
    S1["2.1. Recurring payments<br/>(user story: label User Story)"]
    S2["2.2. Refunds"]
    T1["2.1.1. Add schedule validation<br/>(task: Task + area + priority)"]
    T2["2.1.2. Expose schedule endpoint"]
    E --> S1 & S2
    S1 --> T1 & T2
```

- **Parent = the number minus its last segment.** `2.1.2` → `2.1` → `2`
  (`trello-card-push/SKILL.md:47`, `server/src/utils/numbering.mjs`
  `parentNumber`).
- **New numbers always come from the `nextCardNumbers` tool, "never by
  eye".** It returns `max + 1` and compares numerically, so `2.1.10` comes
  after `2.1.9` (`references/task.md:20`, `references/epic.md:9`).
- **Archived numbers stay retired.** `nextCardNumbers` also reads archived
  cards (`filter: "all"`), so the number of an archived `2.1.2` is never
  handed out again (`numbering.mjs`, `hierarchy.mjs` `nextCardNumbers`).
- In Trello, each child is **attached to its parent** as a card link. The
  name says where a card belongs; the attachment makes it clickable. The
  `auditCardHierarchy` tool checks that the two agree.

---

## 3. Phase 1: drafting

`/trello-card-draft <topic> [--level epic|story|task] [--parent <number>] [--design <file>] [--docs <file>]`
(`trello-card-draft/SKILL.md:17`). The default level is `story`. Each run
works at exactly one level. `--parent` is the epic number at story level
(`--parent 2` → `2.1`, `2.2`, …) or the story number at task level
(`--parent 2.1` → `2.1.1`, …). If it's missing, the skill asks you instead of
guessing.

### Task level (the full path)

```mermaid
sequenceDiagram
    actor You
    participant Main as Draft skill (main thread)
    participant MCP as trello-board MCP
    participant Agent as trello-agent
    participant Plan as .claude/tasks/topic.md

    You->>Main: /trello-card-draft topic --level task --parent 2.1
    Main->>MCP: findCard({number: "2.1"})
    MCP-->>Main: matches: exactly one parent (else stop and ask)
    Main->>MCP: nextCardNumbers({under: ["2.1"]})
    MCP-->>Main: next "2.1.3", parentExists true
    Main->>MCP: getCard(parent shortLink)
    MCP-->>Main: User Story + Acceptance Criteria
    Note over Main,MCP: no AC in description? getCardChecklists.<br/>Still none? stop and ask (task.md:26)
    Main->>Agent: inputs only: parent story + AC, start number,<br/>topic, plan path, Target list, Prefix
    Agent->>MCP: getLabels()
    MCP-->>Agent: [{id, name, color}]
    Agent->>Plan: Write header + one section per card
    Agent-->>Main: receipt manifest only (no card bodies)
    Main->>Plan: check it exists with "Status: draft"
    Main-->>You: receipt, parent, list, path, next number
```

### What each level does differently

| | Epic | User story | Task |
|---|---|---|---|
| Who writes the cards | Main thread itself (`epic.md:11`) | `trello-agent` | `trello-agent` |
| Parent (`--parent`) | none | an epic: `findCard("2")` | a story: `findCard("2.1")` |
| Number source | `nextCardNumbers` → `nextEpic` | `nextUnder[prefix].next` | `nextUnder[prefix].next` |
| Reads the parent's AC | no | no | yes: `getCard`, falling back to `getCardChecklists` |
| Labels | `Epic` | `User Story` | `Task` + area + priority |
| Card body | 2–4 sentence description | As a / I want / so that + Given/When/Then | ≤ 2 sentence description + Given/When/Then |

**Why the agent only gets inputs.** The card format rules live in one place,
`trello-agent.md`, and the skill passes only run-specific values
(`task.md:58`). Two copies of the rules had already drifted apart once.

**Why only a receipt comes back.** The agent writes the cards straight to the
file and returns one line per card. The card text never enters the main
conversation, which keeps it small (`user-story.md:56`).

### The plan file

```markdown
# Task Plan: Recurring payments
Target list: Backlog
Prefix: 2.1
Status: draft

---

## 2.1.3. Add RecurringSchedule interval validation
Labels: Task, Backend, High Priority
Label IDs: <Task id>, <Backend id>, <High Priority id>
Description: Validate the interval field on the schedule schema in models/schedule.py.
**Acceptance Criteria:**
- **Given** a schedule with interval 0. **When** it is saved. **Then** a 422 names the field.
```

Format from `trello-agent.md:70-103`. Tasks are numbered in **execution
order**: setup first, then endpoints, then UI, then end-to-end wiring
(`trello-agent.md:36-38`). This is the moment to **review and edit**: rename
cards, drop some, change labels.

---

## 4. Phase 2: pushing

`/trello-card-push <topic>`. The main thread only starts the push agent and
passes its report back to you. It never reads the plan itself, so the card
text doesn't pass through the conversation twice (`trello-card-push/SKILL.md:19-23`).

```mermaid
sequenceDiagram
    actor You
    participant Main as Push skill (main thread)
    participant PA as trello-push-agent
    participant Plan as .claude/tasks/topic.md
    participant MCP as trello-board MCP

    You->>Main: /trello-card-push topic
    Main->>PA: follow trello-card-push/SKILL.md for topic
    PA->>Plan: Read: status, Pushed: lines, sections
    alt Status: pushed
        PA-->>Main: "Already pushed"
    end
    PA->>MCP: findCards() once for the whole board
    Note over PA: adoption pass (see below) + resolve each<br/>parent by number: exactly one match, else warn
    loop batches of 5 cards
        PA->>MCP: Message A: 5 × addCard(name, listId, description, labels)
        PA->>MCP: Message B: attachCard(parent ← child) for each
        PA->>Plan: Message B: Edit, write "Pushed: [idShort] shortLink"
        PA->>MCP: placeCards({listId, underNumber: Prefix, cardIds})
    end
    PA->>Plan: Status: draft → pushed (only if every card has Pushed:)
    PA-->>Main: Created / Adopted / Attached / Placement / Still failing
    Main-->>You: report
```

### Placement: where new cards land in the list

Trello puts a new card at the bottom of the list. `placeCards` moves the
batch to just after the **last card of the parent's subtree**, so the
backlog keeps reading epic → story → its tasks
(`trello-card-push/SKILL.md:120-132`):

```mermaid
flowchart LR
    subgraph Before["Backlog before placeCards"]
        direction TB
        a1["EPIC 2"] --> a2["2.1"] --> a3["2.1.1"] --> a4["2.1.2"] --> a5["2.2"] --> a6["…"] --> a7["2.1.3 (new, at bottom)"]
    end
    subgraph After["after placeCards underNumber 2.1"]
        direction TB
        b1["EPIC 2"] --> b2["2.1"] --> b3["2.1.1"] --> b4["2.1.2"] --> b5["2.1.3 ✓"] --> b6["2.2"] --> b7["…"]
    end
    Before --> After
```

Epic plans skip `placeCards`: a new epic belongs at the end anyway, after a
`---` separator card (`SKILL.md:136-138`).

### Safe to re-run: the adoption pass

A push can crash halfway, for example after `addCard` but before the
`Pushed:` line is written. Re-running it never creates a card twice. Each
unpushed section is first looked up on the board by its number
(`SKILL.md:58-62`):

```mermaid
flowchart TD
    S[Plan section without Pushed: line] --> L{Cards on board<br/>with this number?}
    L -->|none| C[Create it]
    L -->|one, same name| A[Adopt: write Pushed:,<br/>attach if missing]
    L -->|one, different name| X[Stale plan: STOP the run,<br/>renumber with nextCardNumbers]
    L -->|several| R[Report the collision,<br/>don't create]
```

The `Pushed: [idShort] shortLink` lines are what the push trusts. Sections
that have one are never sent to `addCard` again (`SKILL.md:31`, `:166`).

### When something fails

| What failed | What happens (`SKILL.md:151-166`) |
|---|---|
| Unknown label | Card is created without that label, with a warning |
| Parent not found, or several | Card is created without a parent link; reported |
| `addCard` | No `Pushed:` line; status stays `draft`; re-run retries it |
| `attachCard` | Card kept, `Pushed:` still written; fix with `repairCardHierarchy` |
| `placeCards` | Nothing re-created; reported; re-run is safe |

---

## 5. Who can call what

Each agent's `tools:` line is a hard permission boundary, and it's
deliberate:

| Agent | MCP tools | Can't, by design |
|---|---|---|
| `trello-agent` (writer) | `getLabels` only (`trello-agent.md:4`) | Create or change any card. A draft can never touch the board. |
| `trello-push-agent` | `getLists`, `getCardsByList`, `findCards`, `listCardAttachments`, `addCard`, `attachCard`, `placeCards` (`trello-push-agent.md:4`) | `moveCard`, `updateCard`, `archiveCard`, `repairCardHierarchy`. When it hits a stop condition, all it can do is report. |
| `board-audit` workflow agents | Read tools only, enforced in the prompt | Write anything |

---

## 6. Where the ids come from

| Id | Source | Fallback |
|---|---|---|
| Label ids | `getLabels`, called live by the drafter (`trello-agent.md:63`) | `server/trello-board-ids.md` label table, only if the call fails |
| List id for `Target list` | `getLists`, called live by the push agent and matched by name | The `server/trello-board-ids.md` List ID map, only if the call fails. No match → the push stops before creating anything |
| Board | `TRELLO_BOARD_ID`. The push calls `findCards` with no board (`trello-card-push/SKILL.md:54`) | None |

### Before your first push

1. Set **`TRELLO_BOARD_ID`**. It's optional for the MCP server but
   **required for this workflow**.
2. Make sure the plan's **`Target list`** exists on the board. Drafts
   default to `Backlog`. If your board has no such list, edit the plan's
   `Target list:` line before pushing; otherwise the push stops and lists
   the lists that do exist.
3. Make sure the board has the labels the drafter uses: `Epic`,
   `User Story`, `Task`, `Frontend`, `Backend`, `DevOps`, `Ai Feature`, and
   `High`/`Medium`/`Low Priority`. A missing label is skipped with a warning,
   not created.

---

## 7. Checking the result

```mermaid
flowchart LR
    A[auditCardHierarchy] -->|missing parent links| R[repairCardHierarchy<br/>dryRun first]
    A -->|wrong parent, duplicates| H[a human decides]
    W[board-audit workflow] -->|card-quality findings| H
```

- `auditCardHierarchy` compares the parent links on the board with what the
  numbers imply. It's read-only.
- `repairCardHierarchy` only fills in **missing** links (use
  `dryRun: true` first). Anything ambiguous is left for a person.
- The `board-audit` workflow checks labels and acceptance criteria against
  the conventions above. See the README.
