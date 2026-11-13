// Ask GitHub whether a pull request linked on a card was merged. Read-only, one host,
// and no dependency: the caller passes the token and, in tests, a fake fetch.
//
// Only api.github.com is ever called, only with GET, and the URL is built from an owner,
// repo and number that parseGitHubPr has already checked, so a link on a card cannot
// point the token somewhere else. The token goes in one header and nowhere else: no
// result, reason or error carries it, even when the failure message did.

import { pool } from "../trello/client.mjs";
import { hasPullRequest } from "./outcome.mjs";
import { cap } from "./rollup.mjs";

const API = "https://api.github.com";
const NAME = /^[A-Za-z0-9_.-]+$/;
const PULL = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;

// https://github.com/acme/web/pull/42 (also /files, /commits ...) -> { owner, repo, number }.
// Anything else, including another host that merely contains "github.com", is null.
export function parseGitHubPr(url) {
  let u;
  try {
    u = new URL(String(url ?? ""));
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || (u.hostname !== "github.com" && u.hostname !== "www.github.com")) return null;
  if (u.username || u.password) return null;
  const match = PULL.exec(u.pathname);
  if (!match) return null;
  const [, owner, repo, number] = match;
  if (![owner, repo].every((n) => NAME.test(n) && !/^\.+$/.test(n))) return null;
  // Too many digits to hold exactly would ask GitHub about a different pull request.
  if (!Number.isSafeInteger(Number(number))) return null;
  return { owner, repo, number: Number(number) };
}

const keyOf = ({ owner, repo, number }) => `${owner}/${repo}#${number}`;
const unverified = (reason, category, retryable) => ({ state: "unverified", reason, category, retryable });

// Every failure is reported as "unverified" with a category and whether trying again could
// help; none is reported as merged or as not merged. One unreachable link must not fail the
// whole audit, which is why this does not throw.
async function checkOne({ owner, repo, number }, { token, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
    // Anything but a 200 is answered from the status alone; its body is released, not left
    // holding the connection.
    if (res.status !== 200) await res.body?.cancel();
    if (res.status === 404) return unverified("not found or no access", "permission", false);
    if (res.status === 401 || res.status === 403) return unverified("refused by GitHub", "permission", false);
    if (res.status === 429) return unverified("rate limited", "transient", true);
    if (res.status >= 500) return unverified("GitHub error", "transient", true);
    if (res.status !== 200) return unverified("unexpected reply", "validation", false);
    let body;
    try {
      body = await res.json();
    } catch {
      // Cut off by the timeout is a network problem; a body that is not JSON is not.
      if (controller.signal.aborted) throw new Error("timed out");
      return unverified("unexpected reply", "validation", false);
    }
    if (typeof body?.merged !== "boolean") return unverified("unexpected reply", "validation", false);
    if (body.merged) return { state: "merged" };
    return { state: body.state === "open" ? "open" : "closed" };
  } catch {
    return unverified("could not reach GitHub", "transient", true);
  } finally {
    clearTimeout(timer);
  }
}

// The GitHub pull requests linked on `cards` ([{ name, attachments }]), the ones to ask about,
// and how the cards group them. A card whose only pull-request links are on another host
// (GitLab, Bitbucket) is counted in otherHost: it has a link, just not one this can check.
export function pullRequestsOnCards(cards) {
  const prs = [];
  const perCard = [];
  let otherHost = 0;
  for (const card of cards) {
    const keys = [];
    for (const attachment of card.attachments ?? []) {
      const pr = parseGitHubPr(attachment?.url);
      if (!pr) continue;
      prs.push(pr);
      keys.push(keyOf(pr));
    }
    if (keys.length) perCard.push({ name: card.name, keys });
    else if (hasPullRequest(card.attachments)) otherHost++;
  }
  return { prs, perCard, otherHost };
}

// What GitHub said, per pull request and per card. A card is listed when none of its pull
// requests is merged; its state is the most hopeful one it has (open, then closed),
// "unverified" when GitHub could not answer, and "notChecked" when it was over the limit.
export function summarizeVerification({ perCard, otherHost }, { results, notChecked }) {
  const count = { merged: 0, open: 0, closed: 0, unverified: 0 };
  for (const r of results.values()) count[r.state]++;
  const noneMerged = [];
  for (const card of perCard) {
    const states = card.keys.map((k) => results.get(k)?.state ?? "notChecked");
    if (states.includes("merged")) continue;
    const state = ["open", "closed", "unverified"].find((s) => states.includes(s)) ?? "notChecked";
    noneMerged.push({ name: card.name, state });
  }
  return {
    enabled: true,
    pullRequests: { ...count, notChecked },
    cards: { withGitHubPr: perCard.length, noneMerged: cap(noneMerged) },
    otherHost,
  };
}

// `prs`: [{ owner, repo, number }] as parseGitHubPr returns them. Returns
// { results: Map("owner/repo#n" -> { state: "merged" | "open" | "closed" | "unverified", ... }), notChecked }.
// A link repeated on several cards is asked about once; links beyond `limit` are counted, not asked.
export async function checkPullRequests(prs, { token, fetchImpl = fetch, limit = 100, timeoutMs = 10_000 } = {}) {
  if (!token) throw new Error("A GitHub token is required to check pull requests");
  const unique = [...new Map(prs.map((p) => [keyOf(p), p])).values()];
  const asked = unique.slice(0, limit);
  const answers = await pool(asked, 5, (pr) => checkOne(pr, { token, fetchImpl, timeoutMs }));
  return { results: new Map(asked.map((pr, i) => [keyOf(pr), answers[i]])), notChecked: unique.length - asked.length };
}
