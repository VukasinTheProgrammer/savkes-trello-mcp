// ---- Constants -------------------------------------------------------------
const API_BASE = '/api';
const HEALTH_URL = `${API_BASE}/health`;

const SPRINT_STATUS_LABELS = {
  not_configured: 'Not configured',
  incomplete_estimates: 'Incomplete estimates',
  at_risk: 'At risk',
  on_track: 'On track'
};

// ---- Helpers ---------------------------------------------------------------
const $ = id => document.getElementById(id);

const el = (tag, value = '', cls = '') => {
  const element = document.createElement(tag);
  element.textContent = String(value);
  if (cls) element.className = cls;
  return element;
};

function addList(id, items) {
  const root = $(id);
  root.replaceChildren();
  for (const item of items ?? []) {
    root.append(el('li', item));
  }
}

function row(name, value) {
  const element = el('div', '', 'list-row');
  element.append(el('span', name), el('strong', value));
  return element;
}

function barChart(rootId, items, emptyText) {
  const root = $(rootId);
  root.replaceChildren();
  if (!items.length) { root.append(el('p', emptyText, 'empty')); return; }
  const max = Math.max(1, ...items.map(x => Number(x.value) || 0));
  for (const item of items) {
    const line = el('div', '', 'chart-line');
    const name = el('span', item.label, 'chart-name'); name.title = item.label;
    const track = el('div', '', 'chart-track');
    const fill = el('div', '', 'chart-fill');
    fill.style.width = Math.max(0, Math.min(100, (Number(item.value) || 0) / max * 100)) + '%';
    track.append(fill);
    line.append(name, track, el('strong', String(item.value), 'chart-value'));
    root.append(line);
  }
}
function completionChart(completed, total) {
  const root = $('completion-chart'); root.replaceChildren();
  const pct = total > 0 ? Math.min(100, Math.max(0, completed / total * 100)) : 0;
  const wrap = el('div', '', 'donut-wrap');
  const donut = el('div', '', 'donut'); donut.style.setProperty('--done', pct + '%');
  const center = el('div', '', 'donut-center');
  center.append(el('div', Math.round(pct) + '%'), el('small', 'complete'));
  donut.append(center);
  const legend = el('div', '', 'legend');
  const a = el('div'); const b = el('div');
  const da = el('i', '', 'dot purple'); const db = el('i', '', 'dot blue');
  a.append(da, el('span', `Completed  `), el('b', completed));
  b.append(db, el('span', `Remaining  `), el('b', Math.max(0, total - completed)));
  legend.append(a, b); wrap.append(donut, legend); root.append(wrap);
}
function render(a) {
  // Supports the flat structure returned by analyzeBoard().
  const m = a.metrics ?? a;

  $('board').textContent =
    a.boardName || 'Configured Trello board';

  $('metrics').replaceChildren();

  const completion = Number(
    m.completionPercentage ?? m.completionRate ?? 0
  );

  const metrics = [
    ['Health score', m.healthScore == null ? 'N/A' : m.healthScore + '/100'],
    ['Completion', completion + '%'],
    ['Active cards', m.activeCards ?? 0],
    ['Overdue', m.overdueCards ?? 0],
    ['Blocked', m.blockedCards ?? 0],
    ['Unassigned', m.unassignedCards ?? 0],
    ['Upcoming deadlines', m.upcomingDeadlines ?? 0],
    ['Completed', m.completedCards ?? 0]
  ];

  for (const [label, value] of metrics) {
    const card = el('article', '', 'metric');
    card.append(
      el('span', label),
      el('strong', value, label === 'Health score' ? 'score' : '')
    );
    $('metrics').append(card);
  }

  // Progress
  const progress = $('progress');
  progress.replaceChildren(
    el('strong', `${m.completedCards ?? 0} of ${m.totalCards ?? 0} cards completed`)
  );

  const bar = el('div', '', 'bar');
  const fill = el('div');

  fill.style.width =
    Math.min(100, Math.max(0, completion)) + '%';

  bar.append(fill);

  progress.append(
    bar,
    el('p', `${m.activeCards ?? 0} cards remain active.`, 'muted')
  );

  // Sprint forecast (never claim on-track if estimates are missing).
  const sprint = $('sprint');
  sprint.replaceChildren();
  const f = a.sprintForecast ?? m.sprintForecast;
  if (f) {
    sprint.append(el('strong', SPRINT_STATUS_LABELS[f.status] || 'Unknown'));
    sprint.append(el('p', f.message || '', 'muted'));
    sprint.append(row('Estimated finish (working in parallel)', `${f.finishHours ?? f.remainingHours} h` +
      (f.estimatedFinishDate ? ` · around ${f.estimatedFinishDate}` : '') +
      (Number(f.missingEstimates) > 0 ? ` + ${f.missingEstimates} unestimated card(s)` : '')));
    sprint.append(row('Total estimated work (all people)', `${f.remainingHours} h`));
    sprint.append(row('Cards without estimates', f.missingEstimates));
    if (Number(f.unassignedCards) > 0) sprint.append(row('Estimated but unassigned', `${f.unassignedCards} card(s), ${f.unassignedHours} h`));
    if (f.capacityHours != null) {
      sprint.append(row('Available capacity', `${f.capacityHours} h (${f.workingDays} working days)`));
      sprint.append(row('Estimated shortfall', `${f.shortfallHours} h`));
      sprint.append(row('Sprint ends', f.sprintEnd));
    }
  } else sprint.append(el('p', 'Forecast unavailable.', 'muted'));

  const listDataForChart = a.listStats ?? a.lists ?? [];
  barChart('list-chart', listDataForChart.map(list => ({
    label: String(list.name ?? list.listName ?? 'Unnamed list'),
    value: Number(list.totalCards ?? list.cardCount ?? 0)
  })), 'No list data available.');
  completionChart(Number(m.completedCards ?? 0), Number(m.totalCards ?? 0));
  const members = a.workloadDistribution ?? m.workloadDistribution ?? [];
  barChart('member-chart', Array.isArray(members) ? members.map(item => ({
    label: String(item.name ?? item.memberName ?? item.memberId ?? 'Member'),
    value: Number(item.cardCount ?? 0)
  })) : [], 'No assigned-member workload data available.');
  const sprintChart = $('sprint-chart'); sprintChart.replaceChildren();
  if (f && f.capacityHours != null && f.remainingHours != null) {
    const cap = Number(f.capacityHours), work = Number(f.remainingHours);
    const max = Math.max(1, cap, work);
    const heading = el('h3', 'Capacity comparison');
    sprintChart.append(heading);
    for (const [label, value] of [['Estimated work', work], ['Available capacity', cap]]) {
      const line = el('div', '', 'chart-line');
      const track = el('div', '', 'chart-track');
      const fill = el('div', '', 'chart-fill');
      fill.style.width = Math.max(0, value / max * 100) + '%';
      track.append(fill); line.append(el('span', label, 'chart-name'), track, el('strong', `${value} h`, 'chart-value'));
      sprintChart.append(line);
    }
    if (Number(f.missingEstimates) > 0) sprintChart.append(el('p', 'Some cards have no estimates. Capacity comparison is incomplete.', 'footnote'));
  }
  // Hours per person: the longest bar is when the team finishes.
  if (f && Array.isArray(f.members) && f.members.length) {
    sprintChart.append(el('h3', 'Estimated hours per person'));
    const max = Math.max(1, ...f.members.map(m => Number(m.hours)));
    for (const m of f.members) {
      const line = el('div', '', 'chart-line');
      const track = el('div', '', 'chart-track');
      const fill = el('div', '', 'chart-fill');
      fill.style.width = Math.max(0, Number(m.hours) / max * 100) + '%';
      track.append(fill);
      line.append(el('span', String(m.name ?? m.memberId), 'chart-name'), track, el('strong', `${m.hours} h`, 'chart-value'));
      sprintChart.append(line);
    }
    sprintChart.append(el('p', 'People work at the same time, so the team is done when the busiest person is done.', 'footnote'));
  }

  // Recommendations
  addList('recommendations', a.recommendations);

  // Work by list: backend returns listStats.
  const lists = $('lists');
  lists.replaceChildren();

  const listData = a.listStats ?? a.lists ?? [];

  if (!listData.length) {
    lists.append(el('p', 'No lists available.', 'muted'));
  }

  for (const list of listData) {
    const name = list.name ?? list.listName ?? 'Unnamed list';
    const count = list.totalCards ?? list.cardCount ?? 0;
    const completed = list.completedCards ?? 0;

    lists.append(
      row(name, `${count} cards (${completed} completed)`)
    );
  }

  // Risks: backend returns counts, not arrays of cards.
  const risks = $('risks');
  risks.replaceChildren();

  const riskItems = [
    ['Overdue cards', m.overdueCards ?? 0],
    ['Blocked cards', m.blockedCards ?? 0],
    ['Due within 7 days', m.upcomingDeadlines ?? 0],
    ['Unassigned cards', m.unassignedCards ?? 0]
  ];

  for (const [label, value] of riskItems) {
    const count = Array.isArray(value) ? value.length : value;
    risks.append(row(label, count));
  }

  addList('limitations', a.limitations);

  $('status').textContent = a.analyzedAt
    ? 'Last analyzed: ' + new Date(a.analyzedAt).toLocaleString()
    : 'Analysis complete';
}

async function load() {
  const button = $('refresh');
  button.disabled = true;

  $('error').textContent = '';
  $('status').textContent = 'Loading current board data…';

  try {
    const response = await fetch(HEALTH_URL, {
      cache: 'no-store'
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Request failed');
    }

    render(data);
  } catch (error) {
    $('error').textContent = error.message;
    $('status').textContent = 'Analysis unavailable';
  } finally {
    button.disabled = false;
  }
}

$('refresh').addEventListener('click', load);
load();
