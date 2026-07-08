const STORAGE_KEYS = {
  papers: "daily-paper-tracker:papers",
  purposeTags: "daily-paper-tracker:purpose-tags",
  monthlyGoals: "daily-paper-tracker:monthly-goals",
  cloudConfig: "daily-paper-tracker:cloud-config",
};

const DEFAULT_PURPOSE_TAGS = ["랩세미나", "Envtox", "기타"];
const MONTH_FORMATTER = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long" });
const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" });
const STAT_COLORS = [
  "var(--blue)",
  "var(--yellow)",
  "var(--mint)",
  "var(--rose)",
  "#d8d2ff",
  "#bfe7e2",
  "#ffd6a8",
  "#c9d8ff",
];
const SUPABASE_SETUP_SQL = `create table if not exists public.paper_tracker_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  papers jsonb not null default '[]'::jsonb,
  purpose_tags jsonb not null default '[]'::jsonb,
  monthly_goals jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.paper_tracker_state
add column if not exists monthly_goals jsonb not null default '{}'::jsonb;

alter table public.paper_tracker_state enable row level security;

drop policy if exists "paper tracker read own state" on public.paper_tracker_state;
drop policy if exists "paper tracker insert own state" on public.paper_tracker_state;
drop policy if exists "paper tracker update own state" on public.paper_tracker_state;

create policy "paper tracker read own state"
on public.paper_tracker_state for select
to authenticated
using (auth.uid() = user_id);

create policy "paper tracker insert own state"
on public.paper_tracker_state for insert
to authenticated
with check (auth.uid() = user_id);

create policy "paper tracker update own state"
on public.paper_tracker_state for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);`;

const els = {
  viewTitle: document.querySelector("#viewTitle"),
  navLinks: [...document.querySelectorAll(".nav-link")],
  views: [...document.querySelectorAll("[data-view]")],
  topbarActions: document.querySelector(".topbar-actions"),
  metrics: document.querySelector("[data-metrics]"),
  calendarTitle: document.querySelector("[data-calendar-title]"),
  calendarGrid: document.querySelector("[data-calendar-grid]"),
  goalMonth: document.querySelector("[data-goal-month]"),
  monthlyGoal: document.querySelector("[data-monthly-goal]"),
  goalStatus: document.querySelector("[data-goal-status]"),
  paperList: document.querySelector("[data-paper-list]"),
  purposeFilter: document.querySelector("[data-purpose-filter]"),
  search: document.querySelector("[data-search]"),
  statsGrid: document.querySelector("[data-stats-grid]"),
  detail: document.querySelector("[data-detail]"),
  modal: document.querySelector("[data-modal]"),
  form: document.querySelector("[data-paper-form]"),
  formTitle: document.querySelector("[data-form-title]"),
  purposeSelect: document.querySelector("[name='purposeTag']"),
  newPurpose: document.querySelector("[data-new-purpose]"),
  detailFields: document.querySelector("[data-detail-fields]"),
  citationInput: document.querySelector("[data-citation-input]"),
  citationStatus: document.querySelector("[data-citation-status]"),
  syncModal: document.querySelector("[data-sync-modal]"),
  syncStatus: document.querySelector("[data-sync-status]"),
  syncUrl: document.querySelector("[data-sync-url]"),
  syncKey: document.querySelector("[data-sync-key]"),
  syncEmail: document.querySelector("[data-sync-email]"),
  syncSql: document.querySelector("[data-sync-sql]"),
  toast: document.querySelector("[data-toast]"),
};

const state = {
  papers: loadPapers(),
  purposeTags: loadPurposeTags(),
  monthlyGoals: loadMonthlyGoals(),
  currentMonth: startOfMonth(new Date()),
  route: "calendar",
  selectedPaperId: null,
  searchTerm: "",
  purposeFilter: "all",
  cloud: {
    config: loadCloudConfig(),
    client: null,
    user: null,
    syncTimer: null,
    applyingRemote: false,
  },
};

let citationParseTimer;
let monthlyGoalStatusTimer;

function normalizeInitialState() {
  const names = new Set(state.purposeTags.map((tag) => tag.name));
  DEFAULT_PURPOSE_TAGS.forEach((name) => {
    if (!names.has(name)) {
      state.purposeTags.push(createPurposeTag(name));
    }
  });

  state.papers.forEach((paper) => {
    if (paper.purposeTag && !state.purposeTags.some((tag) => tag.name === paper.purposeTag)) {
      state.purposeTags.push(createPurposeTag(paper.purposeTag));
    }
  });

  savePurposeTags();
}

function loadPapers() {
  return readStorage(STORAGE_KEYS.papers, []).map((paper) => ({
    id: paper.id,
    title: paper.title || "",
    authors: Array.isArray(paper.authors) ? paper.authors : [],
    year: paper.year ? Number(paper.year) : undefined,
    venue: paper.venue || "",
    doi: paper.doi || "",
    url: paper.url || "",
    abstract: paper.abstract || "",
    memo: paper.memo || "",
    readStartDate: paper.readStartDate,
    readEndDate: paper.readEndDate,
    purposeTag: paper.purposeTag || "기타",
    keywords: Array.isArray(paper.keywords) ? paper.keywords : [],
    topicTags: Array.isArray(paper.topicTags) ? paper.topicTags : [],
    createdAt: paper.createdAt || new Date().toISOString(),
    updatedAt: paper.updatedAt || new Date().toISOString(),
  })).filter((paper) => paper.title && paper.readStartDate && paper.readEndDate);
}

function loadPurposeTags() {
  const saved = readStorage(STORAGE_KEYS.purposeTags, []);
  if (!Array.isArray(saved) || saved.length === 0) {
    return DEFAULT_PURPOSE_TAGS.map(createPurposeTag);
  }

  return saved.map((tag) => {
    if (typeof tag === "string") {
      return createPurposeTag(tag);
    }
    return {
      id: tag.id || createId("purpose"),
      name: tag.name,
      createdAt: tag.createdAt || new Date().toISOString(),
    };
  }).filter((tag) => tag.name);
}

function loadMonthlyGoals() {
  return normalizeMonthlyGoals(readStorage(STORAGE_KEYS.monthlyGoals, {}));
}

function readStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function savePapers() {
  localStorage.setItem(STORAGE_KEYS.papers, JSON.stringify(state.papers));
  queueCloudSave();
}

function savePurposeTags() {
  localStorage.setItem(STORAGE_KEYS.purposeTags, JSON.stringify(state.purposeTags));
  queueCloudSave();
}

function saveMonthlyGoals() {
  localStorage.setItem(STORAGE_KEYS.monthlyGoals, JSON.stringify(state.monthlyGoals));
  queueCloudSave();
}

function loadCloudConfig() {
  const config = readStorage(STORAGE_KEYS.cloudConfig, {});
  return {
    url: config.url || "",
    anonKey: config.anonKey || "",
    email: config.email || "",
  };
}

function saveCloudConfig(config) {
  state.cloud.config = {
    url: (config.url || "").trim().replace(/\/+$/g, ""),
    anonKey: (config.anonKey || "").trim(),
    email: (config.email || "").trim(),
  };
  localStorage.setItem(STORAGE_KEYS.cloudConfig, JSON.stringify(state.cloud.config));
}

function createPurposeTag(name) {
  return {
    id: createId("purpose"),
    name: name.trim(),
    createdAt: new Date().toISOString(),
  };
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseList(value) {
  return [...new Set((value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean))];
}

function formatAuthors(authors) {
  return (Array.isArray(authors) ? authors : []).filter(Boolean).join(", ");
}

function parseDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function toISODate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCurrentMonthKey() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
}

function dateFromMonthKey(key) {
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month - 1, 1);
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function sameMonth(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function dateCompare(a, b) {
  return parseDate(a).getTime() - parseDate(b).getTime();
}

function rangeOverlaps(startA, endA, startB, endB) {
  return parseDate(startA) <= parseDate(endB) && parseDate(endA) >= parseDate(startB);
}

function isDateInRange(dateISO, startISO, endISO) {
  return dateCompare(dateISO, startISO) >= 0 && dateCompare(dateISO, endISO) <= 0;
}

function formatDateRange(startISO, endISO) {
  if (startISO === endISO) return SHORT_DATE_FORMATTER.format(parseDate(startISO));
  return `${SHORT_DATE_FORMATTER.format(parseDate(startISO))} - ${SHORT_DATE_FORMATTER.format(parseDate(endISO))}`;
}

function formatFullDateRange(startISO, endISO) {
  if (startISO === endISO) return startISO;
  return `${startISO} - ${endISO}`;
}

function clampDate(date, min, max) {
  return new Date(Math.min(Math.max(date.getTime(), min.getTime()), max.getTime()));
}

function buildVisibleDays(monthDate) {
  const first = startOfMonth(monthDate);
  const gridStart = addDays(first, -first.getDay());
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
}

function getPapersForMonth(monthDate) {
  const monthStart = toISODate(startOfMonth(monthDate));
  const monthEnd = toISODate(endOfMonth(monthDate));
  return state.papers.filter((paper) => rangeOverlaps(
    paper.readStartDate,
    paper.readEndDate,
    monthStart,
    monthEnd,
  ));
}

function getReadDateSet(papers = state.papers) {
  const dates = new Set();
  papers.forEach((paper) => {
    let cursor = parseDate(paper.readStartDate);
    const end = parseDate(paper.readEndDate);
    while (cursor <= end) {
      dates.add(toISODate(cursor));
      cursor = addDays(cursor, 1);
    }
  });
  return dates;
}

function calculateCurrentStreak() {
  const readDates = getReadDateSet();
  let cursor = parseDate(toISODate(new Date()));
  let count = 0;
  while (readDates.has(toISODate(cursor))) {
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}

function calculateMonthStats(monthDate) {
  const monthPapers = getPapersForMonth(monthDate);
  const monthStart = startOfMonth(monthDate);
  const monthEnd = endOfMonth(monthDate);
  const today = parseDate(toISODate(new Date()));
  const achievementEnd = sameMonth(monthDate, today) ? today : monthEnd;
  const denominator = Math.max(1, Math.floor((achievementEnd - monthStart) / 86400000) + 1);
  const readDates = getReadDateSet(monthPapers);
  let readDays = 0;
  let cursor = new Date(monthStart);
  while (cursor <= achievementEnd) {
    if (readDates.has(toISODate(cursor))) readDays += 1;
    cursor = addDays(cursor, 1);
  }

  return {
    monthPapers: monthPapers.length,
    achievementRate: Math.round((readDays / denominator) * 100),
    currentStreak: calculateCurrentStreak(),
    totalPapers: state.papers.length,
    readDays,
    denominator,
  };
}

function countBy(items, pick) {
  return items.reduce((acc, item) => {
    const keys = pick(item);
    keys.forEach((key) => {
      const label = key || "미기록";
      acc[label] = (acc[label] || 0) + 1;
    });
    return acc;
  }, {});
}

function sortCounts(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
}

function getStats() {
  return {
    purpose: sortCounts(countBy(state.papers, (paper) => [paper.purposeTag])),
    keywords: sortCounts(countBy(state.papers, (paper) => paper.keywords.length ? paper.keywords : ["미기록"])),
    topics: sortCounts(countBy(state.papers, (paper) => paper.topicTags.length ? paper.topicTags : ["미기록"])),
    months: sortCounts(countBy(state.papers, (paper) => [paper.readEndDate.slice(0, 7)])),
    years: sortCounts(countBy(state.papers, (paper) => [paper.year ? String(paper.year) : "미기록"])),
    venues: sortCounts(countBy(state.papers, (paper) => [paper.venue || "미기록"])),
  };
}

function render() {
  renderNavigation();
  renderPurposeOptions();
  renderMetrics();
  renderCalendar();
  renderList();
  renderStats();
  renderDetail();
}

function renderMonthlyGoal() {
  if (!els.monthlyGoal) return;
  const key = getCurrentMonthKey();
  const savedGoal = state.monthlyGoals[key]?.text || "";
  els.goalMonth.textContent = MONTH_FORMATTER.format(dateFromMonthKey(key));
  els.monthlyGoal.value = savedGoal;
  updateMonthlyGoalStatus("자동 저장");
}

function updateMonthlyGoal(value) {
  const key = getCurrentMonthKey();
  const trimmed = value.trim();
  if (trimmed) {
    state.monthlyGoals[key] = {
      text: value,
      updatedAt: new Date().toISOString(),
    };
  } else {
    delete state.monthlyGoals[key];
  }

  saveMonthlyGoals();
  updateMonthlyGoalStatus("저장됨");
}

function updateMonthlyGoalStatus(message) {
  if (!els.goalStatus) return;
  els.goalStatus.textContent = message;
  window.clearTimeout(monthlyGoalStatusTimer);
  if (message !== "자동 저장") {
    monthlyGoalStatusTimer = window.setTimeout(() => {
      if (els.goalStatus) els.goalStatus.textContent = "자동 저장";
    }, 1400);
  }
}

function renderNavigation() {
  const isDetail = state.route === "detail";
  const titles = {
    calendar: "월간 읽기 캘린더",
    list: "논문 목록",
    stats: "읽기 통계",
    detail: "논문 상세",
  };

  els.viewTitle.textContent = titles[state.route] || titles.calendar;
  els.topbarActions.hidden = state.route !== "calendar";

  els.navLinks.forEach((link) => {
    link.classList.toggle("is-active", !isDetail && link.dataset.route === state.route);
  });

  els.views.forEach((view) => {
    view.classList.toggle("is-visible", view.dataset.view === state.route);
  });
}

function renderPurposeOptions() {
  const tagOptions = state.purposeTags
    .map((tag) => `<option value="${escapeHTML(tag.name)}">${escapeHTML(tag.name)}</option>`)
    .join("");

  const currentFormValue = els.purposeSelect.value;
  els.purposeSelect.innerHTML = tagOptions;
  if (currentFormValue && state.purposeTags.some((tag) => tag.name === currentFormValue)) {
    els.purposeSelect.value = currentFormValue;
  }

  const filterValue = els.purposeFilter.value || state.purposeFilter;
  els.purposeFilter.innerHTML = [
    `<option value="all">전체 목적</option>`,
    ...state.purposeTags.map((tag) => `<option value="${escapeHTML(tag.name)}">${escapeHTML(tag.name)}</option>`),
  ].join("");
  els.purposeFilter.value = state.purposeTags.some((tag) => tag.name === filterValue) ? filterValue : "all";
}

function renderMetrics() {
  const stats = calculateMonthStats(state.currentMonth);
  els.metrics.innerHTML = [
    metricCard("이번 달 논문", `${stats.monthPapers}편`, `${MONTH_FORMATTER.format(state.currentMonth)} 기준`),
    metricCard("달성률", `${stats.achievementRate}%`, `${stats.readDays}/${stats.denominator}일 기록`),
    metricCard("연속 달성일", `${stats.currentStreak}일`, "오늘까지 이어진 기록"),
    metricCard("전체 누적", `${stats.totalPapers}편`, "저장된 전체 논문"),
  ].join("");
}

function metricCard(label, value, help) {
  return `
    <article class="metric-card">
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${help}</small>
    </article>
  `;
}

function renderCalendar() {
  const visibleDays = buildVisibleDays(state.currentMonth);
  const readDates = getReadDateSet(getPapersForMonth(state.currentMonth));
  const todayISO = toISODate(new Date());
  els.calendarTitle.textContent = MONTH_FORMATTER.format(state.currentMonth);

  const dayCells = visibleDays.map((date) => {
    const iso = toISODate(date);
    const dayPapers = state.papers.filter((paper) => isDateInRange(iso, paper.readStartDate, paper.readEndDate));
    const classes = [
      "calendar-day",
      sameMonth(date, state.currentMonth) ? "" : "is-muted",
      readDates.has(iso) ? "has-read" : "",
      iso === todayISO ? "is-today" : "",
    ].filter(Boolean).join(" ");

    return `
      <div class="${classes}" data-date="${iso}">
        <span class="day-number">${date.getDate()}</span>
        ${dayPapers.length ? `<span class="day-count">${dayPapers.length}</span>` : ""}
      </div>
    `;
  }).join("");

  els.calendarGrid.innerHTML = dayCells + renderCalendarEvents(visibleDays);
}

function renderCalendarEvents(visibleDays) {
  const visibleStart = visibleDays[0];
  const visibleEnd = visibleDays[visibleDays.length - 1];
  const visibleStartISO = toISODate(visibleStart);
  const visibleEndISO = toISODate(visibleEnd);
  const events = state.papers
    .filter((paper) => rangeOverlaps(paper.readStartDate, paper.readEndDate, visibleStartISO, visibleEndISO))
    .sort((a, b) => dateCompare(a.readStartDate, b.readStartDate) || dateCompare(a.readEndDate, b.readEndDate));

  const rowLanes = Array.from({ length: 6 }, () => []);
  const segments = [];

  events.forEach((paper, paperIndex) => {
    const start = parseDate(paper.readStartDate);
    const end = parseDate(paper.readEndDate);

    for (let row = 0; row < 6; row += 1) {
      const weekStart = visibleDays[row * 7];
      const weekEnd = visibleDays[row * 7 + 6];
      if (start > weekEnd || end < weekStart) continue;

      const segStart = clampDate(start, weekStart, weekEnd);
      const segEnd = clampDate(end, weekStart, weekEnd);
      const colStart = segStart.getDay() + 1;
      const colEnd = segEnd.getDay() + 2;
      const colSpan = colEnd - colStart;
      const lane = findLane(rowLanes[row], colStart, colEnd);
      rowLanes[row][lane].push([colStart, colEnd]);
      const top = 44 + lane * 28;
      const color = paperIndex % 2 === 0 ? "var(--blue)" : "var(--yellow)";
      const classes = [
        "calendar-event",
        start < segStart ? "is-continuing-left" : "",
        end > segEnd ? "is-continuing-right" : "",
      ].filter(Boolean).join(" ");

      segments.push(`
        <button
          type="button"
          class="${classes}"
          data-paper-id="${escapeHTML(paper.id)}"
          style="--event-row:${row + 1};--event-col-start:${colStart};--event-col-span:${colSpan};--event-top:${top}px;--event-color:${color};"
          title="${escapeHTML(paper.title)}"
        >
          ${escapeHTML(paper.title)}
        </button>
      `);
    }
  });

  return segments.join("");
}

function findLane(lanes, colStart, colEnd) {
  for (let lane = 0; lane < lanes.length; lane += 1) {
    const hasCollision = lanes[lane].some(([takenStart, takenEnd]) => colStart < takenEnd && colEnd > takenStart);
    if (!hasCollision) return lane;
  }
  lanes.push([]);
  return lanes.length - 1;
}

function renderList() {
  const papers = filteredPapers();
  if (!papers.length) {
    els.paperList.innerHTML = emptyState(
      "아직 표시할 논문이 없습니다",
      state.papers.length ? "검색어나 목적 태그 필터를 조정해보세요." : "첫 논문을 추가하면 캘린더와 통계가 바로 채워집니다.",
      state.papers.length ? "" : "논문 추가",
    );
    return;
  }

  els.paperList.innerHTML = papers.map((paper) => `
    <article class="paper-card">
      <div>
        <h3><a href="#paper/${encodeURIComponent(paper.id)}">${escapeHTML(paper.title)}</a></h3>
        <p class="paper-authors"><span>저자</span> ${escapeHTML(formatAuthors(paper.authors) || "미기록")}</p>
        <p class="paper-meta">
          <span>${formatFullDateRange(paper.readStartDate, paper.readEndDate)}</span>
          ${paper.venue ? `<span>${escapeHTML(paper.venue)}</span>` : ""}
          ${paper.year ? `<span>${paper.year}</span>` : ""}
        </p>
        <div class="tag-row">
          <span class="pill yellow">${escapeHTML(paper.purposeTag)}</span>
          ${paper.keywords.slice(0, 5).map((keyword) => `<span class="pill">${escapeHTML(keyword)}</span>`).join("")}
          ${paper.topicTags.slice(0, 4).map((tag) => `<span class="pill mint">${escapeHTML(tag)}</span>`).join("")}
        </div>
      </div>
      <div class="paper-actions">
        <button class="icon-button" type="button" data-edit-paper="${escapeHTML(paper.id)}" aria-label="논문 수정">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" /></svg>
        </button>
      </div>
    </article>
  `).join("");
}

function filteredPapers() {
  const term = state.searchTerm.trim().toLowerCase();
  return [...state.papers]
    .sort((a, b) => dateCompare(b.readEndDate, a.readEndDate) || b.updatedAt.localeCompare(a.updatedAt))
    .filter((paper) => state.purposeFilter === "all" || paper.purposeTag === state.purposeFilter)
    .filter((paper) => {
      if (!term) return true;
      const haystack = [
        paper.title,
        paper.venue,
        paper.abstract,
        paper.memo,
        paper.purposeTag,
        ...paper.authors,
        ...paper.keywords,
        ...paper.topicTags,
      ].join(" ").toLowerCase();
      return haystack.includes(term);
    });
}

function exportPaperListToExcel() {
  const papers = filteredPapers();
  if (!papers.length) {
    showToast("내보낼 논문이 없습니다.");
    return;
  }

  const columns = [
    "논문 제목",
    "저자",
    "발행연도",
    "저널/학회명",
    "DOI",
    "URL",
    "초록",
    "개인 메모",
    "읽기 시작 날짜",
    "읽기 종료 날짜",
    "읽은 기간",
    "목적 태그",
    "키워드",
    "주제 태그",
    "생성일",
    "수정일",
  ];

  const rows = papers.map((paper) => [
    paper.title,
    formatAuthors(paper.authors),
    paper.year || "",
    paper.venue,
    paper.doi,
    paper.url,
    paper.abstract,
    paper.memo,
    paper.readStartDate,
    paper.readEndDate,
    formatFullDateRange(paper.readStartDate, paper.readEndDate),
    paper.purposeTag,
    paper.keywords.join(", "),
    paper.topicTags.join(", "),
    paper.createdAt,
    paper.updatedAt,
  ]);

  const table = `
    <table>
      <thead>${excelRow(columns, "th")}</thead>
      <tbody>${rows.map((row) => excelRow(row)).join("")}</tbody>
    </table>
  `;
  const workbook = `<!doctype html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <style>
          body { font-family: Pretendard, Arial, sans-serif; }
          table { border-collapse: collapse; }
          th, td { border: 1px solid #d9e3ea; padding: 8px; vertical-align: top; mso-number-format: "\\@"; }
          th { background: #edf8ff; font-weight: 700; }
        </style>
      </head>
      <body>${table}</body>
    </html>`;

  downloadTextFile(workbook, `paper-list-${toISODate(new Date())}.xls`, "application/vnd.ms-excel;charset=utf-8");
  showToast(`논문 ${papers.length}편을 엑셀로 내보냈습니다.`);
}

function excelRow(values, tagName = "td") {
  return `<tr>${values.map((value) => excelCell(value, tagName)).join("")}</tr>`;
}

function excelCell(value, tagName = "td") {
  const text = String(value ?? "");
  const safeText = /^[=+\-@]/.test(text) ? `\u200B${text}` : text;
  return `<${tagName} style='mso-number-format:"\\@";'>${escapeHTML(safeText).replace(/\r?\n/g, "<br>")}</${tagName}>`;
}

function downloadTextFile(content, filename, type) {
  const blob = new Blob(["\ufeff", content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function renderStats() {
  const stats = getStats();
  const cards = [
    ["목적 태그별 논문 수", "랩세미나, Envtox 등", stats.purpose],
    ["키워드별 논문 수", "서지·초록·메모 기반 저장 키워드", stats.keywords],
    ["주제 태그별 논문 수", "분야와 주제 묶음", stats.topics],
    ["월별 읽은 논문 수", "읽기 종료일 기준", stats.months],
    ["발행연도별 논문 수", "논문 발행연도 기준", stats.years],
    ["저널/학회별 논문 수", "venue 필드 기준", stats.venues],
  ];

  els.statsGrid.innerHTML = cards.map(([title, subtitle, rows]) => renderStatCard(title, subtitle, rows)).join("");
}

function renderStatCard(title, subtitle, rows) {
  const topRows = rows.slice(0, 10);
  const total = rows.reduce((sum, [, count]) => sum + count, 0);
  const segments = buildStatSegments(rows, total);
  return `
    <article class="stat-card">
      <header>
        <div>
          <h3>${title}</h3>
          <span>${subtitle}</span>
        </div>
        <span>${rows.length}개</span>
      </header>
      ${topRows.length ? `
        <div class="share-strip" aria-label="전체 대비 비율">
          ${segments.map((segment) => `
            <span
              class="share-segment"
              style="--share:${segment.percent}%;--segment-color:${segment.color};"
              title="${escapeAttribute(segment.label)} ${formatShare(segment.count, total)}"
            ></span>
          `).join("")}
        </div>
        <div class="share-legend">
          ${segments.slice(0, 5).map((segment) => `
            <span><i style="--legend-color:${segment.color};"></i>${escapeHTML(segment.label)} ${formatShare(segment.count, total)}</span>
          `).join("")}
        </div>
        <p class="stat-share-note">총 ${total}건 기준</p>
        <div class="bar-list">
          ${topRows.map(([label, count], index) => `
            <div class="bar-row" style="--bar-color:${statColor(index)};">
              <span class="bar-label" title="${escapeHTML(label)}">${escapeHTML(label)}</span>
              <span class="bar-track"><span class="bar-fill" style="width:${Math.max(3, (count / total) * 100)}%"></span></span>
              <span class="bar-count"><strong>${count}</strong><em>${formatShare(count, total)}</em></span>
            </div>
          `).join("")}
        </div>
      ` : `<p class="paper-meta">아직 통계가 없습니다.</p>`}
    </article>
  `;
}

function buildStatSegments(rows, total) {
  const visibleRows = rows.slice(0, 7);
  const segments = visibleRows.map(([label, count], index) => ({
    label,
    count,
    color: statColor(index),
    percent: total ? (count / total) * 100 : 0,
  }));
  const visibleTotal = visibleRows.reduce((sum, [, count]) => sum + count, 0);
  const rest = total - visibleTotal;

  if (rest > 0) {
    segments.push({
      label: "기타",
      count: rest,
      color: statColor(visibleRows.length),
      percent: (rest / total) * 100,
    });
  }

  return segments;
}

function statColor(index) {
  return STAT_COLORS[index % STAT_COLORS.length];
}

function formatShare(count, total) {
  if (!total) return "0%";
  const share = (count / total) * 100;
  return share >= 10 ? `${Math.round(share)}%` : `${share.toFixed(1)}%`;
}

function renderDetail() {
  if (state.route !== "detail") return;
  const paper = state.papers.find((item) => item.id === state.selectedPaperId);
  if (!paper) {
    els.detail.innerHTML = emptyState("논문을 찾을 수 없습니다", "목록에서 다시 선택해 주세요.", "");
    return;
  }

  const link = buildPaperLink(paper);
  els.detail.innerHTML = `
    <article class="detail-card">
      <div class="detail-header">
        <div>
          <div class="tag-row">
            <span class="pill yellow">${escapeHTML(paper.purposeTag)}</span>
            ${paper.topicTags.map((tag) => `<span class="pill mint">${escapeHTML(tag)}</span>`).join("")}
          </div>
          <h2 class="detail-title">${escapeHTML(paper.title)}</h2>
          <p class="paper-meta">
            <span>${formatFullDateRange(paper.readStartDate, paper.readEndDate)}</span>
            ${paper.year ? `<span>${paper.year}</span>` : ""}
            ${paper.venue ? `<span>${escapeHTML(paper.venue)}</span>` : ""}
          </p>
        </div>
        <div class="paper-actions">
          <button class="icon-button" type="button" data-edit-paper="${escapeHTML(paper.id)}" aria-label="논문 수정">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" /></svg>
          </button>
          <button class="icon-button" type="button" data-delete-paper="${escapeHTML(paper.id)}" aria-label="논문 삭제">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15" /></svg>
          </button>
        </div>
      </div>

      <div class="tag-row">
        ${paper.keywords.map((keyword) => `<span class="pill">${escapeHTML(keyword)}</span>`).join("")}
      </div>

      <div class="detail-grid">
        <div class="info-box">
          <span>저자</span>
          <p>${escapeHTML(paper.authors.join(", ") || "미기록")}</p>
        </div>
        <div class="info-box">
          <span>DOI 또는 URL</span>
          <p>${link ? `<a href="${escapeAttribute(link.href)}" target="_blank" rel="noreferrer">${escapeHTML(link.label)}</a>` : "미기록"}</p>
        </div>
        <div class="info-box wide">
          <span>초록</span>
          <p>${escapeHTML(paper.abstract || "미기록")}</p>
        </div>
        <div class="info-box wide">
          <span>개인 메모</span>
          <p>${escapeHTML(paper.memo || "미기록")}</p>
        </div>
      </div>
    </article>
  `;
}

function buildPaperLink(paper) {
  const raw = paper.url || paper.doi;
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return { href: raw, label: raw };
  return { href: `https://doi.org/${raw}`, label: raw };
}

function emptyState(title, body, actionLabel) {
  return `
    <div class="empty-state">
      <h3>${title}</h3>
      <p>${body}</p>
      ${actionLabel ? `<button class="primary-action" type="button" data-open-add>${actionLabel}</button>` : ""}
    </div>
  `;
}

function openForm(paper = null) {
  els.form.reset();
  const fields = els.form.elements;
  fields.id.value = paper?.id || "";
  els.citationInput.value = "";
  els.citationStatus.textContent = "";
  els.formTitle.textContent = paper ? "논문 수정" : "논문 추가";
  renderPurposeOptions();

  const today = toISODate(new Date());
  if (paper) {
    fields.title.value = paper.title;
    fields.readStartDate.value = paper.readStartDate;
    fields.readEndDate.value = paper.readEndDate;
    fields.purposeTag.value = paper.purposeTag;
    fields.authors.value = paper.authors.join(", ");
    fields.year.value = paper.year || "";
    fields.venue.value = paper.venue || "";
    fields.doi.value = paper.doi || "";
    fields.url.value = paper.url || "";
    fields.keywords.value = paper.keywords.join(", ");
    fields.topicTags.value = paper.topicTags.join(", ");
    fields.abstract.value = paper.abstract || "";
    fields.memo.value = paper.memo || "";
    setFormMode("detail");
  } else {
    fields.readStartDate.value = today;
    fields.readEndDate.value = today;
    fields.purposeTag.value = state.purposeTags[0]?.name || "기타";
    setFormMode("quick");
  }

  els.modal.hidden = false;
  requestAnimationFrame(() => fields.title.focus());
}

function closeForm() {
  els.modal.hidden = true;
}

function setFormMode(mode) {
  els.form.classList.toggle("is-detail", mode === "detail");
  document.querySelectorAll("[data-form-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.formMode === mode);
  });
}

function parseAndApplyCitation({ overwrite = false, quiet = false } = {}) {
  const citationText = els.citationInput.value.trim();
  if (!citationText) {
    els.citationStatus.textContent = "";
    return;
  }

  if (typeof window.citationParser !== "function") {
    els.citationStatus.textContent = "Citation 정리 기능을 불러오지 못했습니다.";
    if (!quiet) showToast("Citation 정리 기능을 불러오지 못했습니다.");
    return;
  }

  const parsed = window.citationParser(citationText);
  const extractedLabels = getExtractedCitationLabels(parsed);
  const appliedCount = applyCitationFields(parsed, overwrite);

  if (extractedLabels.length) {
    els.citationStatus.textContent = `추출: ${extractedLabels.join(", ")}`;
    if (!quiet) showToast(appliedCount ? "Citation 정보를 폼에 채웠습니다." : "이미 입력된 값은 유지했습니다.");
  } else {
    els.citationStatus.textContent = "추출 가능한 정보를 찾지 못했습니다.";
    if (!quiet) showToast("추출 가능한 정보를 찾지 못했습니다.");
  }
}

function applyCitationFields(parsed, overwrite) {
  const fields = els.form.elements;
  const values = {
    title: parsed.title || "",
    authors: parsed.authors?.join(", ") || "",
    year: parsed.year ? String(parsed.year) : "",
    venue: parsed.venue || "",
    doi: parsed.doi || "",
    url: parsed.url || "",
  };

  let appliedCount = 0;
  Object.entries(values).forEach(([name, value]) => {
    if (!value || !fields[name]) return;
    if (overwrite || !fields[name].value.trim()) {
      fields[name].value = value;
      appliedCount += 1;
    }
  });

  if (values.authors || values.year || values.venue || values.doi || values.url) {
    setFormMode("detail");
  }

  return appliedCount;
}

function getExtractedCitationLabels(parsed) {
  const labels = [];
  if (parsed.title) labels.push("제목");
  if (parsed.authors?.length) labels.push("저자");
  if (parsed.year) labels.push("연도");
  if (parsed.venue) labels.push("저널/학회");
  if (parsed.doi) labels.push("DOI");
  if (parsed.url) labels.push("URL");
  return labels;
}

function renderSyncConfig() {
  if (!els.syncModal) return;
  els.syncUrl.value = state.cloud.config.url || "";
  els.syncKey.value = state.cloud.config.anonKey || "";
  els.syncEmail.value = state.cloud.config.email || "";
  els.syncSql.value = SUPABASE_SETUP_SQL;
  updateSyncStatus();
}

function openSyncModal() {
  renderSyncConfig();
  els.syncModal.hidden = false;
  requestAnimationFrame(() => els.syncUrl.focus());
}

function closeSyncModal() {
  els.syncModal.hidden = true;
}

function updateSyncStatus(message) {
  if (!els.syncStatus) return;
  if (message) {
    els.syncStatus.textContent = message;
    return;
  }

  if (!state.cloud.config.url || !state.cloud.config.anonKey) {
    els.syncStatus.textContent = "로컬 저장 모드입니다. Supabase 정보를 저장하면 PC와 폰 기록을 같은 DB로 동기화할 수 있습니다.";
    return;
  }

  if (!state.cloud.client) {
    els.syncStatus.textContent = "Supabase 설정은 저장됐지만 아직 연결되지 않았습니다.";
    return;
  }

  if (!state.cloud.user) {
    els.syncStatus.textContent = "Supabase 연결됨. 이메일 로그인 링크를 받아 로그인하면 동기화가 시작됩니다.";
    return;
  }

  els.syncStatus.textContent = `${state.cloud.user.email || "로그인된 계정"} 계정으로 동기화 중입니다.`;
}

async function initCloudSync({ silent = false } = {}) {
  const { url, anonKey } = state.cloud.config;
  if (!url || !anonKey) {
    updateSyncStatus();
    return false;
  }

  if (!window.supabase?.createClient) {
    updateSyncStatus("Supabase 스크립트를 불러오지 못했습니다. 인터넷 연결 또는 광고 차단 설정을 확인해 주세요.");
    return false;
  }

  try {
    state.cloud.client = window.supabase.createClient(url, anonKey);
    const { data, error } = await state.cloud.client.auth.getSession();
    if (error) throw error;
    state.cloud.user = data.session?.user || null;

    state.cloud.client.auth.onAuthStateChange((_event, session) => {
      state.cloud.user = session?.user || null;
      updateSyncStatus();
      if (state.cloud.user) syncNow({ quiet: true });
    });

    updateSyncStatus();
    if (state.cloud.user) await syncNow({ quiet: silent });
    return true;
  } catch (error) {
    updateSyncStatus(`Supabase 연결 실패: ${formatCloudError(error)}`);
    if (!silent) showToast("Supabase 연결에 실패했습니다.");
    return false;
  }
}

async function saveSyncConfigFromForm() {
  saveCloudConfig({
    url: els.syncUrl.value,
    anonKey: els.syncKey.value,
    email: els.syncEmail.value,
  });
  renderSyncConfig();
  const ok = await initCloudSync();
  if (ok) showToast("동기화 설정을 저장했습니다.");
}

async function sendLoginLink() {
  if (!state.cloud.client) {
    const ok = await initCloudSync();
    if (!ok) return;
  }

  const email = els.syncEmail.value.trim() || state.cloud.config.email;
  if (!email) {
    showToast("로그인 이메일을 입력해 주세요.");
    return;
  }

  saveCloudConfig({ ...state.cloud.config, email });
  renderSyncConfig();

  const { error } = await state.cloud.client.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: window.location.origin + window.location.pathname,
    },
  });

  if (error) {
    updateSyncStatus(`로그인 링크 전송 실패: ${formatCloudError(error)}`);
    showToast("로그인 링크 전송에 실패했습니다.");
    return;
  }

  updateSyncStatus(`${email}로 로그인 링크를 보냈습니다. 같은 이메일로 PC와 폰에서 로그인하면 기록이 합쳐집니다.`);
  showToast("로그인 링크를 보냈습니다.");
}

async function signOutCloud() {
  if (!state.cloud.client) return;
  await state.cloud.client.auth.signOut();
  state.cloud.user = null;
  updateSyncStatus();
  showToast("동기화 계정에서 로그아웃했습니다.");
}

function queueCloudSave() {
  if (state.cloud.applyingRemote || !state.cloud.client || !state.cloud.user) return;
  window.clearTimeout(state.cloud.syncTimer);
  state.cloud.syncTimer = window.setTimeout(() => {
    upsertCloudState({ quiet: true });
  }, 500);
}

async function syncNow({ quiet = false } = {}) {
  if (!state.cloud.client) {
    const ok = await initCloudSync({ silent: quiet });
    if (!ok) return;
  }

  if (!state.cloud.user) {
    updateSyncStatus("로그인이 필요합니다. 이메일 로그인 링크를 받아 먼저 로그인해 주세요.");
    if (!quiet) showToast("로그인이 필요합니다.");
    return;
  }

  try {
    const remote = await fetchCloudState();
    if (remote) {
      applyCloudSnapshot(remote);
    }
    await upsertCloudState({ quiet: true });
    updateSyncStatus("동기화 완료. 이 계정으로 여는 기기에서 같은 기록을 볼 수 있습니다.");
    if (!quiet) showToast("클라우드 동기화를 마쳤습니다.");
  } catch (error) {
    updateSyncStatus(`동기화 실패: ${formatCloudError(error)}`);
    if (!quiet) showToast("동기화에 실패했습니다.");
  }
}

async function fetchCloudState() {
  const { data, error } = await state.cloud.client
    .from("paper_tracker_state")
    .select("papers,purpose_tags,monthly_goals,updated_at")
    .eq("user_id", state.cloud.user.id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function upsertCloudState({ quiet = false } = {}) {
  if (!state.cloud.client || !state.cloud.user) return;
  const { error } = await state.cloud.client
    .from("paper_tracker_state")
    .upsert({
      user_id: state.cloud.user.id,
      papers: state.papers,
      purpose_tags: state.purposeTags,
      monthly_goals: state.monthlyGoals,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

  if (error) {
    if (!quiet) throw error;
    updateSyncStatus(`클라우드 저장 실패: ${formatCloudError(error)}`);
  }
}

function applyCloudSnapshot(remote) {
  const remotePapers = normalizePaperArray(remote.papers || []);
  const remotePurposeTags = normalizePurposeTagArray(remote.purpose_tags || []);
  const remoteMonthlyGoals = normalizeMonthlyGoals(remote.monthly_goals || {});
  state.cloud.applyingRemote = true;
  state.papers = mergePapers(state.papers, remotePapers);
  state.purposeTags = mergePurposeTags(state.purposeTags, remotePurposeTags);
  state.monthlyGoals = mergeMonthlyGoals(state.monthlyGoals, remoteMonthlyGoals);
  savePapers();
  savePurposeTags();
  saveMonthlyGoals();
  state.cloud.applyingRemote = false;
  renderMonthlyGoal();
  render();
}

function normalizePaperArray(rawPapers) {
  return (Array.isArray(rawPapers) ? rawPapers : []).map((paper) => ({
    id: paper.id || createId("paper"),
    title: paper.title || "",
    authors: Array.isArray(paper.authors) ? paper.authors : [],
    year: paper.year ? Number(paper.year) : undefined,
    venue: paper.venue || "",
    doi: paper.doi || "",
    url: paper.url || "",
    abstract: paper.abstract || "",
    memo: paper.memo || "",
    readStartDate: paper.readStartDate,
    readEndDate: paper.readEndDate,
    purposeTag: paper.purposeTag || "기타",
    keywords: Array.isArray(paper.keywords) ? paper.keywords : [],
    topicTags: Array.isArray(paper.topicTags) ? paper.topicTags : [],
    createdAt: paper.createdAt || new Date().toISOString(),
    updatedAt: paper.updatedAt || new Date().toISOString(),
  })).filter((paper) => paper.title && paper.readStartDate && paper.readEndDate);
}

function normalizePurposeTagArray(rawTags) {
  return (Array.isArray(rawTags) ? rawTags : []).map((tag) => {
    if (typeof tag === "string") return createPurposeTag(tag);
    return {
      id: tag.id || createId("purpose"),
      name: tag.name,
      createdAt: tag.createdAt || new Date().toISOString(),
    };
  }).filter((tag) => tag.name);
}

function normalizeMonthlyGoals(rawGoals) {
  if (!rawGoals || typeof rawGoals !== "object" || Array.isArray(rawGoals)) return {};

  return Object.entries(rawGoals).reduce((goals, [key, value]) => {
    if (!/^\d{4}-\d{2}$/.test(key)) return goals;

    if (typeof value === "string" && value.trim()) {
      goals[key] = {
        text: value,
        updatedAt: "",
      };
      return goals;
    }

    if (value && typeof value === "object" && typeof value.text === "string" && value.text.trim()) {
      goals[key] = {
        text: value.text,
        updatedAt: value.updatedAt || "",
      };
    }

    return goals;
  }, {});
}

function mergePapers(localPapers, remotePapers) {
  const byId = new Map();
  [...localPapers, ...remotePapers].forEach((paper) => {
    const existing = byId.get(paper.id);
    if (!existing || new Date(paper.updatedAt) > new Date(existing.updatedAt)) {
      byId.set(paper.id, paper);
    }
  });
  return [...byId.values()];
}

function mergePurposeTags(localTags, remoteTags) {
  const byName = new Map();
  [...localTags, ...remoteTags].forEach((tag) => {
    if (!byName.has(tag.name)) byName.set(tag.name, tag);
  });
  return [...byName.values()];
}

function mergeMonthlyGoals(localGoals, remoteGoals) {
  const merged = { ...localGoals };

  Object.entries(remoteGoals).forEach(([key, remoteGoal]) => {
    const localGoal = merged[key];
    if (!localGoal || new Date(remoteGoal.updatedAt || 0) > new Date(localGoal.updatedAt || 0)) {
      merged[key] = remoteGoal;
    }
  });

  return merged;
}

function formatCloudError(error) {
  return error?.message || String(error);
}

function handleSubmit(event) {
  event.preventDefault();
  const formData = new FormData(els.form);
  const title = String(formData.get("title") || "").trim();
  const readStartDate = String(formData.get("readStartDate") || "");
  const readEndDate = String(formData.get("readEndDate") || "");
  const purposeTag = String(formData.get("purposeTag") || "").trim();

  if (!title || !readStartDate || !readEndDate || !purposeTag) {
    showToast("필수 항목을 입력해 주세요.");
    return;
  }

  if (parseDate(readStartDate) > parseDate(readEndDate)) {
    showToast("읽기 종료 날짜는 시작 날짜보다 빠를 수 없습니다.");
    return;
  }

  ensurePurposeTag(purposeTag);

  const id = String(formData.get("id") || "");
  const existing = state.papers.find((paper) => paper.id === id);
  const now = new Date().toISOString();
  let doiValue = String(formData.get("doi") || "").trim();
  let urlValue = String(formData.get("url") || "").trim();
  if (/^https?:\/\//i.test(doiValue) && !urlValue) {
    urlValue = doiValue;
    doiValue = "";
  }

  const paper = {
    id: existing?.id || createId("paper"),
    title,
    authors: parseList(String(formData.get("authors") || "")),
    year: formData.get("year") ? Number(formData.get("year")) : undefined,
    venue: String(formData.get("venue") || "").trim(),
    doi: doiValue,
    url: urlValue,
    abstract: String(formData.get("abstract") || "").trim(),
    memo: String(formData.get("memo") || "").trim(),
    readStartDate,
    readEndDate,
    purposeTag,
    keywords: parseList(String(formData.get("keywords") || "")),
    topicTags: parseList(String(formData.get("topicTags") || "")),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  if (existing) {
    state.papers = state.papers.map((item) => item.id === paper.id ? paper : item);
    showToast("논문 정보를 수정했습니다.");
  } else {
    state.papers.push(paper);
    showToast("논문을 추가했습니다.");
  }

  savePapers();
  closeForm();
  render();
}

function ensurePurposeTag(name) {
  if (!state.purposeTags.some((tag) => tag.name === name)) {
    state.purposeTags.push(createPurposeTag(name));
    savePurposeTags();
  }
}

function handleAddPurpose() {
  const name = els.newPurpose.value.trim();
  if (!name) {
    showToast("추가할 목적 태그 이름을 입력해 주세요.");
    return;
  }

  if (state.purposeTags.some((tag) => tag.name === name)) {
    showToast("이미 있는 목적 태그입니다.");
    els.purposeSelect.value = name;
    els.newPurpose.value = "";
    return;
  }

  state.purposeTags.push(createPurposeTag(name));
  savePurposeTags();
  renderPurposeOptions();
  els.purposeSelect.value = name;
  els.newPurpose.value = "";
  showToast("목적 태그를 추가했습니다.");
}

function handleRoute() {
  const hash = window.location.hash || "#calendar";
  if (hash.startsWith("#paper/")) {
    state.route = "detail";
    state.selectedPaperId = decodeURIComponent(hash.replace("#paper/", ""));
  } else {
    state.route = hash.replace("#", "") || "calendar";
    state.selectedPaperId = null;
  }

  if (!["calendar", "list", "stats", "detail"].includes(state.route)) {
    state.route = "calendar";
  }

  render();
}

function deletePaper(id) {
  const paper = state.papers.find((item) => item.id === id);
  if (!paper) return;
  const ok = window.confirm(`'${paper.title}' 논문을 삭제할까요?`);
  if (!ok) return;

  state.papers = state.papers.filter((item) => item.id !== id);
  savePapers();
  showToast("논문을 삭제했습니다.");
  window.location.hash = "#list";
  render();
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 2400);
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHTML(value).replaceAll("`", "&#096;");
}

function bindEvents() {
  window.addEventListener("hashchange", handleRoute);

  document.addEventListener("click", (event) => {
    const target = event.target.closest("button, a");
    if (!target) return;

    if (target.matches("[data-open-add]")) {
      event.preventDefault();
      openForm();
    }

    if (target.matches("[data-open-sync]")) {
      event.preventDefault();
      openSyncModal();
    }

    if (target.matches("[data-close-modal]")) {
      closeForm();
    }

    if (target.matches("[data-close-sync]")) {
      closeSyncModal();
    }

    if (target.matches("[data-form-mode]")) {
      setFormMode(target.dataset.formMode);
    }

    if (target.matches("[data-add-purpose]")) {
      handleAddPurpose();
    }

    if (target.matches("[data-parse-citation]")) {
      parseAndApplyCitation({ overwrite: true });
    }

    if (target.matches("[data-save-sync-config]")) {
      void saveSyncConfigFromForm();
    }

    if (target.matches("[data-send-login-link]")) {
      void sendLoginLink();
    }

    if (target.matches("[data-sync-now]")) {
      void syncNow();
    }

    if (target.matches("[data-export-list]")) {
      exportPaperListToExcel();
    }

    if (target.matches("[data-sign-out]")) {
      void signOutCloud();
    }

    if (target.matches("[data-month-prev]")) {
      state.currentMonth = new Date(state.currentMonth.getFullYear(), state.currentMonth.getMonth() - 1, 1);
      render();
    }

    if (target.matches("[data-month-next]")) {
      state.currentMonth = new Date(state.currentMonth.getFullYear(), state.currentMonth.getMonth() + 1, 1);
      render();
    }

    if (target.matches("[data-month-today]")) {
      state.currentMonth = startOfMonth(new Date());
      render();
    }

    const paperId = target.dataset.paperId || target.dataset.editPaper || target.dataset.deletePaper;
    if (target.dataset.paperId) {
      window.location.hash = `#paper/${encodeURIComponent(paperId)}`;
    }

    if (target.dataset.editPaper) {
      const paper = state.papers.find((item) => item.id === paperId);
      if (paper) openForm(paper);
    }

    if (target.dataset.deletePaper) {
      deletePaper(paperId);
    }
  });

  els.modal.addEventListener("click", (event) => {
    if (event.target === els.modal) closeForm();
  });

  els.syncModal.addEventListener("click", (event) => {
    if (event.target === els.syncModal) closeSyncModal();
  });

  els.form.addEventListener("submit", handleSubmit);

  els.citationInput.addEventListener("paste", () => {
    window.setTimeout(() => parseAndApplyCitation({ overwrite: false, quiet: true }), 0);
  });

  els.citationInput.addEventListener("input", () => {
    window.clearTimeout(citationParseTimer);
    citationParseTimer = window.setTimeout(() => {
      parseAndApplyCitation({ overwrite: false, quiet: true });
    }, 350);
  });

  els.monthlyGoal.addEventListener("input", (event) => {
    updateMonthlyGoal(event.target.value);
  });

  els.newPurpose.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleAddPurpose();
    }
  });

  els.search.addEventListener("input", (event) => {
    state.searchTerm = event.target.value;
    renderList();
  });

  els.purposeFilter.addEventListener("change", (event) => {
    state.purposeFilter = event.target.value;
    renderList();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.modal.hidden) closeForm();
    if (event.key === "Escape" && !els.syncModal.hidden) closeSyncModal();
  });
}

normalizeInitialState();
bindEvents();
handleRoute();
renderMonthlyGoal();
renderSyncConfig();
void initCloudSync({ silent: true });
