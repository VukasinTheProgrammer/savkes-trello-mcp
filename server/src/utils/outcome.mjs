// Does "Done" have anything behind it? Pure, like rollup.mjs: cards, checklists and
// comments in, plain data and strings out, no network.
//
// Trello can only say that a card sits in a Done list. This reads what the card itself
// carries, and nothing outside Trello: a pull-request link, a comment saying it was
// deployed, a Definition of Done checklist that is fully ticked. It cannot tell whether
// the pull request was merged, only that someone attached one.
//
// Nothing here scores or names a person. A card has a member count and a comment, and
// both are reduced to a yes/no before anything leaves this file.

import { cardNumber } from "./numbering.mjs";
import { DAY_MS, bar, cap, mdText, more, percentOf, tierOf, walk, depthOf } from "./rollup.mjs";

// The team rule, in one place and in these words, so every audit reads it the same way.
// Printed with every result: a reader never has to guess which rule produced the list.
export const TEAM_RULE = Object.freeze([
  Object.freeze({ id: "pull-request", text: "A card reaches Done with a pull request attached." }),
  Object.freeze({ id: "criteria-ticked", text: "A card reaches Done with its met acceptance criteria ticked." }),
  Object.freeze({ id: "blocked", text: "A Blocked card names exactly one member and carries one sentence saying why." }),
]);

// What counts as evidence on a card. Any one of the three is enough.
export const EVIDENCE = Object.freeze([
  Object.freeze({ id: "pull-request", text: "a pull-request or merge-request link attached to the card" }),
  Object.freeze({ id: "deployed-comment", text: 'a comment saying it was deployed, released or shipped (not "not deployed", "will be deployed" or a question)' }),
  Object.freeze({ id: "definition-of-done", text: "a Definition of Done checklist with every item ticked" }),
]);

// --- Reading one card --------------------------------------------------------

// GitHub /pull/12 (and the API's /pulls/12), GitLab /merge_requests/7, Bitbucket
// /pull-requests/3, Azure DevOps /pullrequest/9. Only the path is read, so a PR on a
// self-hosted server counts, and an issue, a commit or a bare /pull/ list does not.
const PR_PATH = /\/(?:pulls?|pull-requests|pullrequest|merge_requests)\/\d+(?:\/|$)/i;

export function hasPullRequest(attachments) {
  return (attachments ?? []).some((attachment) => {
    try {
      const url = new URL(String(attachment?.url ?? ""));
      return /^https?:$/.test(url.protocol) && PR_PATH.test(url.pathname);
    } catch {
      return false;
    }
  });
}

// "deployed" as a word ("undeployed" is not it). A sentence that denies, defers or asks
// about it is not proof, so any of these in the same sentence reads as no. That is
// deliberately strict: a missed proof shows up in the audit and gets fixed in a minute,
// while a false proof is the exact thing this tool exists to catch.
const DEPLOYED = /\b(?:deployed|released|shipped|rolled out|went live|is live|live in prod(?:uction)?)\b/i;
const NOT_PROVEN =
  /\b(?:not|never|yet|will|cannot|to be|going to|until|if|waiting|awaiting|pending|needs?|should|must)\b|n't\b/i;
// "once" and "when" defer a deploy ("deployed when the window opens") unless what follows
// them already happened ("deployed once QA signed off"): a past-tense word within a few
// words of them reads as done.
const DEFERRED = /\b(?:once|when)\b(?!(?:\s+\S+){0,3}?\s+\w+ed\b)/i;
// A later comment saying the deploy was undone takes the proof back.
const UNDONE = /\b(?:rolled[ -]?back|roll(?:ed)?back|reverted|undeployed|unreleased|pulled the release)\b/i;

// A full stop after these is not the end of a sentence ("Acme Inc. replied").
const ABBREVIATION = /\b(?:inc|ltd|llc|co|corp|dr|mr|mrs|ms|st|vs|etc|jr|sr|approx|e\.g|i\.e)\.$/i;
const sentences = (text) => {
  const parts = [];
  for (const line of String(text ?? "").split(/\n+/)) {
    const inLine = [];
    for (const piece of line.trim().split(/(?<=[.!?])\s+/)) {
      if (inLine.length && ABBREVIATION.test(inLine.at(-1))) inLine[inLine.length - 1] += ` ${piece}`;
      else inLine.push(piece);
    }
    parts.push(...inLine);
  }
  return parts.map((s) => s.trim()).filter(Boolean);
};

// Only the clause that names the deploy, and what comes before it, is read for a denial or a
// condition: "If QA passes, deployed tonight" is no proof, but "Deployed to production, ping
// me if anything breaks" is, because the "if" belongs to a later clause.
const upToDeployClause = (s) => {
  const at = s.search(DEPLOYED);
  const end = s.slice(at).search(/[,;:\u2013\u2014]|\s-\s/);
  return end === -1 ? s : s.slice(0, at + end);
};
const isDeployedSentence = (s) => {
  if (!DEPLOYED.test(s) || s.endsWith("?") || UNDONE.test(s)) return false;
  const head = upToDeployClause(s);
  return !NOT_PROVEN.test(head) && !DEFERRED.test(head);
};

export function isDeployedComment(text) {
  return sentences(text).some(isDeployedSentence);
}

// Comments newest first: the newest one that speaks about the deploy decides. A rollback
// after a "deployed" note means there is no proof; a fresh "deployed" after a rollback
// means there is.
export function hasDeployedProof(comments) {
  const newestFirst = [...(comments ?? [])].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  // Inside one comment the last sentence about the deploy decides too: "Rolled back v2.0.
  // Deployed v2.1." is proof, "Deployed v2.1. Rolled it back." is not.
  for (const c of newestFirst) {
    for (const s of sentences(c.text).reverse()) {
      if (UNDONE.test(s)) return false;
      if (isDeployedSentence(s)) return true;
    }
  }
  return false;
}

// Every Definition of Done checklist on the card must be fully ticked, and there must be
// at least one with items. An item with no `state` (data that was not asked for it) is not
// a tick: for evidence, unknown means no, the opposite of how open criteria are counted.
const DOD_NAME = /\b(?:definition of done|dod)\b/i;

export function hasTickedDod(checklists) {
  const lists = (checklists ?? []).filter((c) => DOD_NAME.test(c.name ?? ""));
  return (
    lists.length > 0 &&
    lists.every((c) => (c.checkItems ?? []).length > 0 && c.checkItems.every((i) => i.state === "complete"))
  );
}

// Exactly one sentence: not empty, no second sentence, no second line.
export function isOneSentence(text) {
  return sentences(text).length === 1;
}

// The facts the audit uses, per card. `comments` is [{ text, date }]. The newest one is
// the Blocked reason; the newest one about the deploy decides the "deployed" proof. The text itself stays
// here: nothing downstream receives a comment, only what was concluded from it.
export function readCardFacts(card, checklists = [], comments = [], doneSince = null) {
  const newest = comments.reduce((a, c) => (!a || Date.parse(c.date) > Date.parse(a.date) ? c : a), null);
  return {
    pullRequest: hasPullRequest(card.attachments),
    deployedComment: hasDeployedProof(comments),
    definitionOfDone: hasTickedDod(checklists),
    members: (card.idMembers ?? []).length,
    newestComment: newest?.text ?? null,
    // When the card last moved into a Done list; null if it never did (or the history was not read).
    doneSince: doneSince ?? null,
    // Label names only ever leave this file as a yes/no ("is exempt"), never as text.
    labels: (card.labels ?? []).map((l) => String(l?.name ?? "").trim().toLowerCase()).filter(Boolean),
  };
}

// number -> facts. Of two cards that share a number the first is read, the same one
// buildTree keeps, so the audit and the status report always look at the same card.
export function indexFacts(cards, checklistsByCard = {}, commentsByCard = new Map(), doneSinceByCard = new Map()) {
  const facts = new Map();
  for (const card of cards) {
    const number = cardNumber(card.name);
    if (number === null || facts.has(number)) continue;
    facts.set(number, readCardFacts(card, checklistsByCard[card.id], commentsByCard.get(card.id), doneSinceByCard.get(card.id)));
  }
  return facts;
}

const hasEvidence = (f) => Boolean(f && (f.pullRequest || f.deployedComment || f.definitionOfDone));

// --- The audit ----------------------------------------------------------------

// `roots` as scopeTo returns them; `facts` as indexFacts returns them. `exemptLabels` names
// the kinds of work that never have a pull request (design, docs, meetings): a Done card
// carrying one is not listed for the missing pull request. Its other evidence still counts.
export function buildOutcomeAudit(roots, facts, { exemptLabels = [], now = Date.now() } = {}) {
  const factsOf = (node) => facts.get(node.number);
  const exempt = new Set(exemptLabels.map((l) => String(l).trim().toLowerCase()).filter(Boolean));
  const isExempt = (f) => Boolean(f?.labels?.some((l) => exempt.has(l)));

  // A work item is proven when it is in Done AND shows evidence. Parents add up the same
  // way the done count does, so proven can never exceed done.
  const provenBy = new Map();
  const countProven = (node) => {
    const n = node.children.length
      ? node.children.reduce((sum, child) => sum + countProven(child), 0)
      : node.isDone && hasEvidence(factsOf(node))
        ? 1
        : 0;
    provenBy.set(node.number, n);
    return n;
  };
  roots.forEach(countProven);

  let done = 0;
  let total = 0;
  let proven = 0;
  for (const root of roots) {
    done += root.done;
    total += root.total;
    proven += provenBy.get(root.number);
  }

  const noPullRequest = [];
  const openCriteria = [];
  const blockedIncomplete = [];
  const unprovenSignOff = [];
  const blockedButDone = [];
  const waiting = [];

  walk(roots, (node) => {
    const isLeaf = node.children.length === 0;
    const f = factsOf(node);

    // Stories whose work items are all Done, with nothing to show for it. Acceptance criteria
    // are not required here: a story with none is the easiest one to sign off without proof.
    if (depthOf(node) === 2 && node.total > 0 && node.done === node.total && provenBy.get(node.number) === 0) {
      unprovenSignOff.push({ number: node.number, name: node.name, workItems: node.total });
    }

    // A card counts as Done here when it is a finished work item, or a story whose work
    // items are all finished: criteria are written on stories, so that is where they get ticked.
    const finished = isLeaf ? node.isDone : depthOf(node) === 2 && node.done === node.total;
    if (isLeaf && node.isDone && !f?.pullRequest && !isExempt(f)) noPullRequest.push({ number: node.number, name: node.name });
    // Done by its ticked due date (or Done list) and Blocked at the same time: one of the two
    // is out of date. Said out loud, not resolved, because the status report counts it as Done.
    // Done, but nothing on the card shows it: how long has it been like that?
    if (isLeaf && node.isDone && !hasEvidence(f)) {
      const since = Date.parse(f?.doneSince);
      waiting.push({ number: node.number, name: node.name, days: Number.isNaN(since) ? null : Math.max(0, Math.floor((now - since) / DAY_MS)) });
    }
    if (isLeaf && node.isDone && node.blocked) blockedButDone.push({ number: node.number, name: node.name });
    if (finished && node.criteriaOpen > 0) {
      openCriteria.push({ number: node.number, name: node.name, open: node.criteriaOpen });
    }

    if (isLeaf && !node.isDone && node.blocked) {
      const problems = [];
      if (!f || f.members === 0) problems.push("no member");
      else if (f.members > 1) problems.push("more than one member");
      if (!f?.newestComment?.trim()) problems.push("no reason");
      else if (!isOneSentence(f.newestComment)) problems.push("reason is more than one sentence");
      if (problems.length) blockedIncomplete.push({ number: node.number, name: node.name, problems });
    }
  });

  // Like the status report, a card whose parent is missing is counted in the totals but
  // is not an epic, so it is not a row of the table.
  const placed = roots.filter((r) => !r.orphan);
  const missingParent = roots.length - placed.length;

  return {
    progress: { done, total, percent: percentOf(done, total) },
    provenDone: { done: proven, total, percent: percentOf(proven, total) },
    items: placed.map((root) => ({
      number: root.number,
      name: root.name,
      tier: tierOf(root),
      percent: root.percent,
      done: root.done,
      total: root.total,
      provenDone: provenBy.get(root.number),
      provenPercent: percentOf(provenBy.get(root.number), root.total),
    })),
    unprovenSignOff: cap(unprovenSignOff),
    // Longest waiting first; cards with no known move into Done come last.
    waiting: cap(waiting.sort((a, b) => (b.days ?? -1) - (a.days ?? -1))),
    ruleBreaks: {
      doneWithoutPullRequest: cap(noPullRequest),
      doneWithOpenCriteria: cap(openCriteria),
      blockedIncomplete: cap(blockedIncomplete),
    },
    inconsistent: { doneAndBlocked: cap(blockedButDone) },
    // Cards whose parent number is missing: in the totals above, not rows of the table.
    missingParent,
    exemptLabels: [...exempt],
    rule: TEAM_RULE,
    evidence: EVIDENCE,
  };
}

// --- The write-up -------------------------------------------------------------

// The GitHub part of the write-up, from summarizeVerification (utils/github.mjs), or the plain
// statement that it was asked for and could not run. Counts and card names only.
function renderVerification(v) {
  if (!v.enabled) return [`Not checked: ${v.reason}.`];
  const { merged, open, closed, unverified, notChecked } = v.pullRequests;
  const total = merged + open + closed + unverified + notChecked;
  const lines = [
    `${merged} of ${total} linked pull ${total === 1 ? "request is" : "requests are"} merged, according to GitHub. ` +
      `${open} open, ${closed} closed without a merge, ${unverified} could not be verified${notChecked ? `, ${notChecked} not asked about (over the limit)` : ""}.`,
  ];
  const { withGitHubPr, noneMerged } = v.cards;
  const shown = { open: "open", closed: "closed, not merged", unverified: "could not verify" };
  if (noneMerged.count) {
    lines.push(
      `- None merged on ${noneMerged.count} ${noneMerged.count === 1 ? "card" : "cards"}: ` +
        `${noneMerged.items.map((c) => `${mdText(c.name)} (${shown[c.state]})`).join("; ")}${more(noneMerged)}.`,
    );
  } else if (withGitHubPr) {
    lines.push("- Every Done card with a GitHub pull request has at least one that is merged.");
  }
  if (v.otherHost) {
    lines.push(`- ${v.otherHost} Done ${v.otherHost === 1 ? "card links" : "cards link"} to a host other than GitHub, so ${v.otherHost === 1 ? "it was" : "they were"} not checked.`);
  }
  lines.push("_GitHub says whether a pull request was merged. It does not say the work matches the card, was reviewed, or passed checks._");
  return lines;
}

export function renderOutcomeAudit(boardName, audit, { now = Date.now(), verification } = {}) {
  const { progress, provenDone, items, unprovenSignOff, waiting, ruleBreaks, inconsistent, missingParent, exemptLabels, rule, evidence } = audit;
  const out = [`# Outcome audit: ${boardName}`, `_${new Date(now).toISOString().slice(0, 10)}_`, ""];

  const sit = progress.total === 1 ? "item sits" : "items sit";
  const shows = provenDone.done === 1 ? "shows" : "show";
  out.push(
    `**${progress.percent}% in Done. ${provenDone.percent}% with evidence.** ` +
      `${progress.done} of ${progress.total} work ${sit} in Done; ${provenDone.done} of them ${shows} evidence.` +
      (missingParent
        ? ` The totals include ${missingParent} ${missingParent === 1 ? "card" : "cards"} whose parent is missing, ${missingParent === 1 ? "which is not a row" : "which are not rows"} of the table.`
        : ""),
    "",
    "## Progress",
    "| | In Done | With evidence |",
    "|---|---|---|",
    ...items.map(
      (i) => `| ${mdText(i.name)} | ${bar(i.percent)} ${i.percent}% | ${bar(i.provenPercent)} ${i.provenPercent}% |`,
    ),
    "",
    "## Sign-off without evidence",
  );
  if (unprovenSignOff.count) {
    out.push(
      ...unprovenSignOff.items.map(
        (s) =>
          `- **${mdText(s.name)}**: ` +
          (s.workItems === 1 ? "its only work item is Done, with no evidence" : `all ${s.workItems} work items are Done, none shows evidence`),
      ),
    );
    if (unprovenSignOff.count > unprovenSignOff.items.length) out.push(`- …${more(unprovenSignOff).trim()}`);
  } else {
    out.push("No story is waiting for sign-off without evidence.");
  }
  out.push("");

  out.push("## Done without evidence, longest waiting");
  if (waiting.count) {
    out.push(
      ...waiting.items.map(
        (w) => `- **${mdText(w.name)}**: ` + (w.days === null ? "no date found for when it became Done" : w.days === 0 ? "moved to Done today" : `${w.days} ${w.days === 1 ? "day" : "days"} in Done`),
      ),
    );
    if (waiting.count > waiting.items.length) out.push(`- …${more(waiting).trim()}`);
  } else {
    out.push("Every Done card shows evidence.");
  }
  out.push("");

  const lines = [];
  const add = (label, group, describe) => {
    if (!group.count) return;
    lines.push(`- **${label} (${group.count}):** ${group.items.map(describe).join("; ")}${more(group)}`);
  };
  add("Done without a pull request", ruleBreaks.doneWithoutPullRequest, (c) => mdText(c.name));
  add("Done with acceptance criteria not ticked", ruleBreaks.doneWithOpenCriteria, (c) => `${mdText(c.name)}, ${c.open} open`);
  add("Blocked without exactly one member and one sentence", ruleBreaks.blockedIncomplete, (c) => `${mdText(c.name)} (${c.problems.join(", ")})`);
  out.push("## Where the team rule is not met", ...(lines.length ? lines : ["Every card follows the rule."]), "");

  // Not a rule break: the board contradicts itself, and the numbers above follow the status report.
  if (inconsistent.doneAndBlocked.count) {
    out.push(
      "## Cards that say two things",
      `- **Counted as Done but also Blocked (${inconsistent.doneAndBlocked.count}):** ${inconsistent.doneAndBlocked.items
        .map((c) => mdText(c.name))
        .join("; ")}${more(inconsistent.doneAndBlocked)}. Their due date is ticked complete or they sit in a Done list; one of the two is out of date.`,
      "",
    );
  }

  if (verification) out.push("## Pull requests on GitHub", ...renderVerification(verification), "");

  out.push(
    "## The rule",
    ...rule.map((r) => `- ${r.text}`),
    ...(exemptLabels.length ? [`- Cards labelled ${exemptLabels.map(mdText).join(", ")} are not asked for a pull request.`] : []),
    "",
    "## What counts as evidence",
    ...evidence.map((e) => `- ${e.text}`),
    verification?.enabled
      ? "_Trello and GitHub were read: a pull request on a Done card was asked about, the other evidence comes from the card._"
      : "_Only Trello is read: an attached pull request is seen, not checked for a merge._",
  );

  return out.join("\n").trimEnd();
}
