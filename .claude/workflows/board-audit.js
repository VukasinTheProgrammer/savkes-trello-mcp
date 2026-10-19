export const meta = {
  name: 'board-audit',
  description: 'Read-only Trello board audit: hierarchy drift plus per-epic card quality, every finding re-checked',
  whenToUse: 'Check a board against the card conventions in .claude/skills/trello-card-draft. Args: { boardId, epic? }. Changes nothing.',
  phases: [
    { title: 'Structure', detail: 'hierarchy audit, stale links, epic list' },
    { title: 'Review', detail: 'card quality per batch of epics' },
    { title: 'Verify', detail: 're-fetch each flagged card and try to refute' },
  ],
}

// Read-only by design: every agent is told to use only read tools. Fixing what the
// report finds is a human decision (repairCardHierarchy, updateCard, …).

const boardId = args?.boardId
if (!boardId) throw new Error('board-audit needs args.boardId (board URL, shortLink or id)')
const T = 'mcp__trello-board__'
const READ_ONLY = `Use ONLY these read tools: ${T}findCards, ${T}findCard, ${T}getCard, ${T}getLabels, ` +
  `${T}getCardChecklists, ${T}auditCardHierarchy, ${T}listBoardCardLinks. Never call a tool that writes. ` +
  `Always pass boardId "${boardId}" to tools that take it.`

// The card conventions, as written by trello-agent.md and the trello-card-draft references.
const RULES = `Card conventions (number comes from the card name):
- Epic ("EPIC N. …"): exactly one label, "Epic". Has a description. No acceptance criteria required.
- User Story ("N.M. …"): exactly one label, "User Story". Description has "As a … I want … so that …" and
  an Acceptance Criteria block of Given/When/Then bullets (OR a checklist named "Acceptance Criteria").
- Task ("N.M.K. …"): exactly three labels: "Task" + one area (Frontend/Backend/DevOps/Ai Feature) +
  one priority (High/Medium/Low Priority). Description has Given/When/Then bullets.
If a required label does not exist on the board at all (check getLabels once), report it ONCE with
shortLink "board", not once per card.`

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          shortLink: { type: 'string' },
          number: { type: 'string' },
          rule: { type: 'string', description: 'which convention is broken' },
          problem: { type: 'string', description: 'what exactly is wrong, quoting the card' },
        },
        required: ['shortLink', 'number', 'rule', 'problem'],
      },
    },
  },
  required: ['findings'],
}

phase('Structure')
const structure = await agent(
  `Audit the structure of Trello board "${boardId}". ${READ_ONLY}
Call auditCardHierarchy and listBoardCardLinks, and findCards to list the epics (cards named "EPIC N. …").
Return the hierarchy problems (missing / wrongParent / parentNotFound / duplicateNumbers / selfLinks),
the stale links, and every epic's number, name and shortLink.`,
  {
    phase: 'Structure',
    schema: {
      type: 'object',
      properties: {
        hierarchyIssues: { type: 'array', items: { type: 'string' }, description: 'one line per problem, empty if none' },
        staleLinks: { type: 'array', items: { type: 'string' } },
        epics: {
          type: 'array',
          items: {
            type: 'object',
            properties: { number: { type: 'string' }, name: { type: 'string' }, shortLink: { type: 'string' } },
            required: ['number', 'name', 'shortLink'],
          },
        },
      },
      required: ['hierarchyIssues', 'staleLinks', 'epics'],
    },
  },
)
if (!structure) throw new Error('structure agent failed')

const epics = args.epic ? structure.epics.filter((e) => e.number === String(args.epic)) : structure.epics
// ponytail: at most 4 review batches keeps a 13-epic board at 9 agents; a huge epic
// in one batch is the ceiling — split batches by card count if that bites.
const BATCHES = Math.min(4, epics.length)
const batches = Array.from({ length: BATCHES }, (_, i) => epics.filter((_, j) => j % BATCHES === i))
log(`${epics.length} epic(s) in ${BATCHES} batch(es); ${structure.hierarchyIssues.length} hierarchy issue(s)`)

const reviewed = await pipeline(
  batches,
  (batch, _, i) =>
    agent(
      `Review card quality on Trello board "${boardId}" for these epics and every card under them
(a card is under epic N if its number is N or starts with "N."): ${batch.map((e) => `${e.number} (${e.shortLink})`).join(', ')}.
${READ_ONLY}
Use findCards to list the cards, then getCard on each to read its labels and description.
${RULES}
Report only real violations, each with the card's shortLink and number. No findings is a fine answer.`,
      { label: `review:batch-${i + 1}`, phase: 'Review', schema: FINDINGS },
    ),
  (review, batch, i) =>
    !review?.findings.length
      ? { findings: [] }
      : agent(
          `You are a skeptic. Each finding below claims a Trello card on board "${boardId}" breaks a
convention. Re-fetch every card with getCard (and getCardChecklists for missing acceptance criteria, getLabels
for board-level label findings) and try to REFUTE each one. ${READ_ONLY}
${RULES}
Return ONLY the findings that survive, unchanged. If you are unsure, drop it.
Findings: ${JSON.stringify(review.findings)}`,
          { label: `verify:batch-${i + 1}`, phase: 'Verify', schema: FINDINGS },
        ),
)

const raised = reviewed.length
const confirmed = reviewed.filter(Boolean).flatMap((r) => r.findings)
// A board-level finding can come from every batch; keep one.
const seen = new Set()
const findings = confirmed.filter((f) => {
  const k = `${f.shortLink}|${f.rule}`
  return seen.has(k) ? false : (seen.add(k), true)
})
const failedBatches = reviewed.filter((r) => r === null).length
if (failedBatches) log(`${failedBatches} of ${raised} batch(es) failed and are NOT covered by this report`)

return {
  boardId,
  epicsReviewed: epics.map((e) => e.number),
  hierarchyIssues: structure.hierarchyIssues,
  staleLinks: structure.staleLinks,
  findings,
  failedBatches,
}
