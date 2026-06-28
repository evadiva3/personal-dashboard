const { invoke } = window.__TAURI__.core;

let backendBaseUrl;

async function getBackendBaseUrl() {
  if (!backendBaseUrl) {
    const port = await invoke("backend_port");
    backendBaseUrl = `http://127.0.0.1:${port}`;
  }
  return backendBaseUrl;
}

function showView(id) {
  for (const view of document.querySelectorAll("body > main, body > div.app-shell")) {
    view.classList.toggle("view-hidden", view.id !== id);
  }
}

//login page

let onboardingInFlight = false;

async function handleOnboardingSubmit(event) {
  event.preventDefault();
  if (onboardingInFlight) return; 

  const domain = document.querySelector("#domain-input").value.trim();
  const token = document.querySelector("#token-input").value;
  const status = document.querySelector("#onboarding-status");
  const submitBtn = event.target.querySelector("button[type=submit]");

  onboardingInFlight = true;
  submitBtn.disabled = true;
  status.textContent = "Validating…";

  try {
    const base = await getBackendBaseUrl();
    let result;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000);
      let resp;
      try {
        resp = await fetch(`${base}/setup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain, token }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
      result = await resp.json();
    } catch (err) {
      status.textContent =
        err.name === "AbortError"
          ? "Timed out waiting for the local backend. Try again."
          : "Could not reach the local backend. Try again.";
      return;
    }

    if (!result.success) {
      status.textContent = result.error || "Could not validate that domain/token.";
      return;
    }

    await invoke("save_credentials", { domain, token });
    status.textContent = "";

    const calendarOnboardingSeen = await invoke("calendar_onboarding_seen");
    if (calendarOnboardingSeen) {
      showView("dashboard-view");
      initDashboard();
    } else {
      showView("calendar-onboarding-view");
    }
  } finally {
    onboardingInFlight = false;
    submitBtn.disabled = false;
  }
}

// Calendar OAuth (shared by the onboarding interstitial and Settings)

const CALENDAR_OAUTH_POLL_MS = 1_500;
const CALENDAR_OAUTH_MAX_WAIT_MS = 5 * 60_000;
const CALENDAR_OAUTH_CANCELLED_MESSAGE = "Authorization cancelled or timed out. Try again.";

// Set by handleCalendarOnboardingCancel so an in-flight poll loop notices
// the cancellation immediately instead of waiting for the next backend
// poll tick (the backend is also told directly, via /calendar/setup/cancel,
// to close its loopback server).
let calendarSetupCancelRequested = false;

/** Starts the Google OAuth flow and polls until it completes. The backend
 * opens the system browser itself (not the webview) and blocks on a
 * background thread until the user finishes the consent screen, so this
 * polls /calendar/setup/status rather than awaiting one long request. */
async function runCalendarOAuthFlow(clientId, clientSecret, statusEl) {
  const base = await getBackendBaseUrl();

  statusEl.textContent = "Opening Google sign-in in your browser…";
  let startResp;
  try {
    startResp = await fetch(`${base}/calendar/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    });
  } catch {
    statusEl.textContent = "Could not reach the local backend. Try again.";
    return false;
  }

  if (startResp.status === 429) {
    statusEl.textContent = "A calendar connection attempt is already in progress.";
    return false;
  }

  const deadline = Date.now() + CALENDAR_OAUTH_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (calendarSetupCancelRequested) {
      statusEl.textContent = CALENDAR_OAUTH_CANCELLED_MESSAGE;
      return false;
    }

    await new Promise((r) => setTimeout(r, CALENDAR_OAUTH_POLL_MS));

    if (calendarSetupCancelRequested) {
      statusEl.textContent = CALENDAR_OAUTH_CANCELLED_MESSAGE;
      return false;
    }

    let status;
    try {
      const resp = await fetch(`${base}/calendar/setup/status`);
      status = await resp.json();
    } catch {
      continue; // transient — keep polling until the deadline
    }

    if (status.state === "success") {
      statusEl.textContent = "";
      return true;
    }
    if (status.state === "error") {
      statusEl.textContent = status.error || "Could not connect to Google Calendar.";
      return false;
    }
    if (status.state === "timeout" || status.state === "cancelled") {
      statusEl.textContent = CALENDAR_OAUTH_CANCELLED_MESSAGE;
      return false;
    }
    statusEl.textContent = "Waiting for you to finish signing in with Google…";
  }

  statusEl.textContent = "Timed out waiting for Google sign-in. Try again.";
  return false;
}

let calendarOnboardingInFlight = false;

async function handleCalendarOnboardingSubmit(event) {
  event.preventDefault();
  if (calendarOnboardingInFlight) return;

  const clientId = document.querySelector("#calendar-onboarding-client-id").value.trim();
  const clientSecret = document.querySelector("#calendar-onboarding-client-secret").value;
  const status = document.querySelector("#calendar-onboarding-status");
  const submitBtn = event.target.querySelector("button[type=submit]");
  const cancelBtn = document.querySelector("#calendar-onboarding-cancel");
  const skipBtn = document.querySelector("#calendar-onboarding-skip");

  calendarOnboardingInFlight = true;
  calendarSetupCancelRequested = false;
  submitBtn.disabled = true;
  cancelBtn.classList.remove("view-hidden");
  skipBtn.classList.add("view-hidden");
  try {
    const ok = await runCalendarOAuthFlow(clientId, clientSecret, status);
    if (!ok) return;

    await invoke("save_calendar_credentials", { clientId, clientSecret });
    await invoke("set_calendar_onboarding_seen");
    showView("dashboard-view");
    initDashboard();
  } finally {
    calendarOnboardingInFlight = false;
    submitBtn.disabled = false;
    cancelBtn.classList.add("view-hidden");
    skipBtn.classList.remove("view-hidden");
  }
}

async function handleCalendarOnboardingSkip() {
  await invoke("set_calendar_onboarding_seen");
  showView("dashboard-view");
  initDashboard();
}

async function handleCalendarOnboardingCancel() {
  // Reset the UI to the idle connect state immediately rather than
  // waiting for the in-flight poll loop to wake up and notice (it sleeps
  // up to CALENDAR_OAUTH_POLL_MS between checks). That loop still bails
  // out on its own once it wakes — see calendarSetupCancelRequested below
  // — but redundantly re-applying the same idle state then is harmless.
  calendarSetupCancelRequested = true;
  calendarOnboardingInFlight = false;

  document.querySelector("#calendar-onboarding-status").textContent = CALENDAR_OAUTH_CANCELLED_MESSAGE;
  document.querySelector("#calendar-onboarding-form button[type=submit]").disabled = false;
  document.querySelector("#calendar-onboarding-cancel").classList.add("view-hidden");
  document.querySelector("#calendar-onboarding-skip").classList.remove("view-hidden");

  const base = await getBackendBaseUrl();
  try {
    await fetch(`${base}/calendar/setup/cancel`, { method: "POST" });
  } catch {
    // best-effort — the frontend still resets to idle regardless, and the
    // backend's own timeout is the fallback if this request never landed
  }
}

function initCalendarOnboarding() {
  document
    .querySelector("#calendar-onboarding-form")
    .addEventListener("submit", handleCalendarOnboardingSubmit);
  document
    .querySelector("#calendar-onboarding-skip")
    .addEventListener("click", handleCalendarOnboardingSkip);
  document
    .querySelector("#calendar-onboarding-cancel")
    .addEventListener("click", handleCalendarOnboardingCancel);
}

// sidebar

function initSidebarNav() {
  const icons = document.querySelectorAll(".nav-icon");
  for (const icon of icons) {
    icon.addEventListener("click", () => {
      for (const other of icons) other.classList.remove("active");
      icon.classList.add("active");
      document
        .querySelector(`#${icon.dataset.scrollTarget}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}

// greeting and ai genrated quote list (replace with actual quotes later)

const QUOTES = [
  "Small steps still move you forward.",
  "Done is better than perfect.",
  "Future you is counting on today you.",
  "Progress, not perfection.",
  "You don't have to see the whole staircase, just the next step.",
  "Discipline is choosing what you want most over what you want now.",
  "Start where you are. Use what you have. Do what you can.",
  "The secret of getting ahead is getting started.",
  "Every assignment finished is one less thing carrying weight.",
  "Consistency beats intensity.",
  "It's okay to go slow, just don't stop.",
  "You've survived every deadline so far.",
  "Action is the antidote to anxiety.",
  "One task at a time is still progress.",
  "Tired and trying still counts.",
  "Your focus determines your reality.",
  "Make today's effort tomorrow's relief.",
  "Showing up is half the battle.",
];

function setGreeting() {
  const hour = new Date().getHours();
  let greeting = "Good evening";
  if (hour < 12) greeting = "Good morning";
  else if (hour < 18) greeting = "Good afternoon";
  document.querySelector("#greeting-text").textContent = greeting;
}

function showRandomQuote() {
  const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  document.querySelector("#quote-text").textContent = quote;
}

function initQuote() {
  showRandomQuote();
  document.querySelector("#quote-refresh").addEventListener("click", showRandomQuote);
}

//Checklist

async function fetchChecklist() {
  const base = await getBackendBaseUrl();
  const resp = await fetch(`${base}/checklist`);
  return resp.json();
}

function renderChecklist(items) {
  const list = document.querySelector("#checklist-list");
  list.innerHTML = "";

  for (const item of items) {
    const li = document.createElement("li");
    li.className = "checklist-item" + (item.done ? " done" : "");

    const checkbox = document.createElement("button");
    checkbox.className = "checklist-checkbox" + (item.done ? " done" : "");
    checkbox.type = "button";
    checkbox.addEventListener("click", () => toggleChecklistItem(item.id));

    const text = document.createElement("span");
    text.className = "checklist-text";
    text.textContent = item.text;
    text.addEventListener("click", () => toggleChecklistItem(item.id));

    const del = document.createElement("button");
    del.className = "checklist-delete";
    del.type = "button";
    del.textContent = "×";
    del.title = "Delete";
    del.addEventListener("click", () => deleteChecklistItem(item.id));

    li.appendChild(checkbox);
    li.appendChild(text);
    li.appendChild(del);
    list.appendChild(li);
  }
}

async function refreshChecklist() {
  renderChecklist(await fetchChecklist());
}

async function toggleChecklistItem(id) {
  const base = await getBackendBaseUrl();
  await fetch(`${base}/checklist/${id}`, { method: "PATCH" });
  refreshChecklist();
}

async function deleteChecklistItem(id) {
  const base = await getBackendBaseUrl();
  await fetch(`${base}/checklist/${id}`, { method: "DELETE" });
  refreshChecklist();
}

let checklistAddInFlight = false;

async function handleChecklistSubmit(event) {
  event.preventDefault();
  if (checklistAddInFlight) return;

  const input = document.querySelector("#checklist-input");
  const text = input.value.trim();
  if (!text) return;

  checklistAddInFlight = true;
  try {
    const base = await getBackendBaseUrl();
    await fetch(`${base}/checklist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    input.value = "";
    refreshChecklist();
  } finally {
    checklistAddInFlight = false;
  }
}

function initChecklist() {
  document
    .querySelector("#checklist-form")
    .addEventListener("submit", handleChecklistSubmit);
  refreshChecklist();
}

// Goals (monthly — distinct from the daily checklist above)

function currentMonthYear() {
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}

async function fetchGoals() {
  const { month, year } = currentMonthYear();
  const base = await getBackendBaseUrl();
  const resp = await fetch(`${base}/goals?month=${month}&year=${year}`);
  return resp.json();
}

function renderGoals(items) {
  const list = document.querySelector("#goal-list");
  list.innerHTML = "";

  for (const item of items) {
    const li = document.createElement("li");
    li.className = "checklist-item" + (item.done ? " done" : "");

    const checkbox = document.createElement("button");
    checkbox.className = "checklist-checkbox" + (item.done ? " done" : "");
    checkbox.type = "button";
    checkbox.addEventListener("click", () => toggleGoal(item.id));

    const text = document.createElement("span");
    text.className = "checklist-text";
    text.textContent = item.text;
    text.addEventListener("click", () => toggleGoal(item.id));

    const del = document.createElement("button");
    del.className = "checklist-delete";
    del.type = "button";
    del.textContent = "×";
    del.title = "Delete";
    del.addEventListener("click", () => deleteGoal(item.id));

    li.appendChild(checkbox);
    li.appendChild(text);
    li.appendChild(del);
    list.appendChild(li);
  }
}

async function refreshGoals() {
  renderGoals(await fetchGoals());
}

async function toggleGoal(id) {
  const base = await getBackendBaseUrl();
  await fetch(`${base}/goals/${id}`, { method: "PATCH" });
  refreshGoals();
}

async function deleteGoal(id) {
  const base = await getBackendBaseUrl();
  await fetch(`${base}/goals/${id}`, { method: "DELETE" });
  refreshGoals();
}

let goalAddInFlight = false;

async function handleGoalSubmit(event) {
  event.preventDefault();
  if (goalAddInFlight) return;

  const input = document.querySelector("#goal-input");
  const text = input.value.trim();
  if (!text) return;

  goalAddInFlight = true;
  try {
    const { month, year } = currentMonthYear();
    const base = await getBackendBaseUrl();
    await fetch(`${base}/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, month, year }),
    });
    input.value = "";
    refreshGoals();
  } finally {
    goalAddInFlight = false;
  }
}

function initGoals() {
  document.querySelector("#goal-form").addEventListener("submit", handleGoalSubmit);
  refreshGoals();
}

// Assignments

const DASHBOARD_POLL_MS = 60_000;
const DUE_SOON_HOURS = 48;
let dashboardPollHandle;
let latestAssignments = [];
let activeFilter = "all";

function formatDueDate(dueAt) {
  if (!dueAt) return "No due date";
  return new Date(dueAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function hoursUntil(dueAt) {
  if (!dueAt) return null;
  return (new Date(dueAt) - Date.now()) / (1000 * 60 * 60);
}

function isOverdue(dueAt) {
  const hours = hoursUntil(dueAt);
  return hours !== null && hours < 0;
}

function isDueSoon(dueAt) {
  const hours = hoursUntil(dueAt);
  return hours !== null && hours >= 0 && hours <= DUE_SOON_HOURS;
}

function filteredAssignments() {
  if (activeFilter === "upcoming") {
    return latestAssignments.filter((a) => !isOverdue(a.due_at));
  }
  if (activeFilter === "overdue") {
    return latestAssignments.filter((a) => isOverdue(a.due_at));
  }
  return latestAssignments;
}

function renderAssignments() {
  const body = document.querySelector("#assignments-body");
  body.innerHTML = "";
  const rows = filteredAssignments();

  if (rows.length === 0) {
    document.querySelector("#dashboard-status").textContent =
      "No assignments to show.";
  } else {
    document.querySelector("#dashboard-status").textContent = "";
  }

  for (const a of rows) {
    const tr = document.createElement("tr");

    const titleTd = document.createElement("td");
    const link = document.createElement("a");
    link.href = a.html_url || "#";
    link.target = "_blank";
    link.textContent = a.title;
    titleTd.appendChild(link);
    if (isOverdue(a.due_at)) {
      const badge = document.createElement("span");
      badge.className = "badge overdue";
      badge.textContent = "Overdue";
      titleTd.appendChild(badge);
    } else if (isDueSoon(a.due_at)) {
      const badge = document.createElement("span");
      badge.className = "badge due-soon";
      badge.textContent = "Due soon";
      titleTd.appendChild(badge);
    }

    const courseTd = document.createElement("td");
    courseTd.textContent = a.course;

    const dueTd = document.createElement("td");
    dueTd.textContent = formatDueDate(a.due_at);

    tr.appendChild(titleTd);
    tr.appendChild(courseTd);
    tr.appendChild(dueTd);
    body.appendChild(tr);
  }
}

function renderNextDeadline() {
  const line = document.querySelector("#next-deadline-line");
  const upcoming = latestAssignments
    .filter((a) => a.due_at && !isOverdue(a.due_at))
    .sort((a, b) => new Date(a.due_at) - new Date(b.due_at));

  if (upcoming.length === 0) {
    line.textContent = "No upcoming assignments";
    return;
  }

  const next = upcoming[0];
  line.innerHTML = "";
  const title = document.createElement("span");
  title.className = "next-deadline-title";
  title.textContent = next.title;
  line.append("Next: ", title, ` — ${next.course}, ${formatDueDate(next.due_at)}`);
}

function initTabs() {
  const tabs = document.querySelectorAll(".tab");
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      for (const t of tabs) t.classList.remove("active");
      tab.classList.add("active");
      activeFilter = tab.dataset.filter;
      renderAssignments();
    });
  }
}

async function refreshAssignments() {
  try {
    const base = await getBackendBaseUrl();
    const resp = await fetch(`${base}/assignments`);
    latestAssignments = await resp.json();
    renderAssignments();
    renderNextDeadline();
  } catch {
    document.querySelector("#dashboard-status").textContent =
      "Could not reach the local backend.";
  }
}

async function checkForNewAssignments() {
  try {
    const base = await getBackendBaseUrl();
    const resp = await fetch(`${base}/notifications/new`);
    const newAssignments = await resp.json();
    for (const a of newAssignments) {
      await invoke("notify_new_assignment", {
        title: "New Canvas assignment",
        body: `${a.title} — ${a.course}`,
      });
    }
  } catch {
    // Backend unreachable this cycle; the next poll will catch up.
  }
}

// Weekly calendar (live Google Calendar data)

const CALENDAR_WEEK_START_HOUR = 7;
const CALENDAR_WEEK_END_HOUR = 22;
const CALENDAR_HOUR_PX = 48;
const CALENDAR_MIN_EVENT_PX = 24;
const CALENDAR_GRID_MINUTES = (CALENDAR_WEEK_END_HOUR - CALENDAR_WEEK_START_HOUR) * 60;

let calendarWeekStart = null; // Date at local midnight, Monday of the displayed week
let calendarWeekHasAutoScrolled = false;

function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function mondayOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dayIndex = (d.getDay() + 6) % 7; // Mon=0 ... Sun=6
  d.setDate(d.getDate() - dayIndex);
  return d;
}

function minutesFromGridStart(date) {
  return (date.getHours() - CALENDAR_WEEK_START_HOUR) * 60 + date.getMinutes();
}

/** Assigns each event in a single day to a column, splitting the column
 * width when events overlap — same idea as Google Calendar's layout.
 * Sweeps events in start order, grouping into clusters of mutually
 * overlapping events, then greedily reuses a column once its previous
 * occupant has ended. */
function layoutDayEvents(dayEvents) {
  const sorted = [...dayEvents].sort((a, b) => a.startDate - b.startDate);
  const placed = [];
  let cluster = [];
  let clusterEnd = -Infinity;

  function finalizeCluster() {
    if (!cluster.length) return;
    const columnEnds = [];
    for (const ev of cluster) {
      let col = columnEnds.findIndex((end) => ev.startDate >= end);
      if (col === -1) {
        col = columnEnds.length;
        columnEnds.push(ev.endDate);
      } else {
        columnEnds[col] = ev.endDate;
      }
      ev._col = col;
    }
    const totalCols = columnEnds.length;
    for (const ev of cluster) {
      ev._totalCols = totalCols;
      placed.push(ev);
    }
    cluster = [];
  }

  for (const ev of sorted) {
    if (ev.startDate >= clusterEnd) {
      finalizeCluster();
      clusterEnd = ev.endDate;
    } else {
      clusterEnd = Math.max(clusterEnd, ev.endDate);
    }
    cluster.push(ev);
  }
  finalizeCluster();
  return placed;
}

function renderCalendarWeekHeader() {
  document.querySelector("#calendar-week-label").textContent = (() => {
    const end = new Date(calendarWeekStart);
    end.setDate(end.getDate() + 6);
    const fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${fmt(calendarWeekStart)} — ${fmt(end)}`;
  })();

  const headersRow = document.querySelector("#calendar-day-headers-row");
  headersRow.innerHTML = "";
  const todayStr = formatLocalDate(new Date());
  for (let i = 0; i < 7; i++) {
    const day = new Date(calendarWeekStart);
    day.setDate(day.getDate() + i);

    const col = document.createElement("div");
    col.className = "calendar-day-header";
    if (formatLocalDate(day) === todayStr) col.classList.add("is-today");

    const name = document.createElement("span");
    name.className = "calendar-day-name";
    name.textContent = day.toLocaleDateString(undefined, { weekday: "short" });
    const num = document.createElement("span");
    num.className = "calendar-day-num";
    num.textContent = String(day.getDate());

    col.appendChild(name);
    col.appendChild(num);
    headersRow.appendChild(col);
  }
}

function buildCalendarTimeAxis() {
  const axis = document.querySelector("#calendar-time-axis");
  if (axis.children.length) return; // hour labels never change, build once
  const gridHeight = CALENDAR_GRID_MINUTES * (CALENDAR_HOUR_PX / 60);
  axis.style.height = `${gridHeight}px`;
  for (let h = CALENDAR_WEEK_START_HOUR; h <= CALENDAR_WEEK_END_HOUR; h++) {
    const label = document.createElement("div");
    label.className = "calendar-hour-label";
    label.style.top = `${(h - CALENDAR_WEEK_START_HOUR) * CALENDAR_HOUR_PX}px`;
    label.textContent = `${String(h).padStart(2, "0")}:00`;
    axis.appendChild(label);
  }
}

function renderCalendarEventBlock(col, ev) {
  const pxPerMin = CALENDAR_HOUR_PX / 60;
  const startMin = Math.max(0, minutesFromGridStart(ev.startDate));
  const endMin = Math.min(CALENDAR_GRID_MINUTES, minutesFromGridStart(ev.endDate));
  if (endMin <= 0 || startMin >= CALENDAR_GRID_MINUTES || endMin <= startMin) return;

  const width = 100 / ev._totalCols;

  const block = document.createElement("div");
  block.className = "calendar-event-block";
  block.style.top = `${startMin * pxPerMin}px`;
  block.style.height = `${Math.max(CALENDAR_MIN_EVENT_PX, (endMin - startMin) * pxPerMin)}px`;
  block.style.width = `calc(${width}% - 4px)`;
  block.style.left = `${ev._col * width}%`;

  const title = document.createElement("div");
  title.className = "calendar-event-title";
  title.textContent = ev.title;
  const time = document.createElement("div");
  time.className = "calendar-event-time";
  const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  time.textContent = `${fmtTime(ev.startDate)} – ${fmtTime(ev.endDate)}`;

  block.appendChild(title);
  block.appendChild(time);
  col.appendChild(block);
}

function renderCalendarWeekGrid(events) {
  buildCalendarTimeAxis();

  const grid = document.querySelector("#calendar-week-grid");
  grid.innerHTML = "";
  grid.style.height = `${CALENDAR_GRID_MINUTES * (CALENDAR_HOUR_PX / 60)}px`;

  const alldayRow = document.querySelector("#calendar-allday-row");
  alldayRow.innerHTML = "";

  const dayBuckets = Array.from({ length: 7 }, () => []);
  const weekStartMidnight = new Date(calendarWeekStart);

  for (const ev of events) {
    if (ev.all_day) {
      const pill = document.createElement("div");
      pill.className = "calendar-allday-pill";
      pill.textContent = ev.title;
      alldayRow.appendChild(pill);
      continue;
    }

    const startDate = new Date(ev.start);
    const endDate = new Date(ev.end);
    const startMidnight = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const dayIndex = Math.round((startMidnight - weekStartMidnight) / 86_400_000);
    if (dayIndex < 0 || dayIndex > 6) continue;

    dayBuckets[dayIndex].push({ ...ev, startDate, endDate });
  }

  const todayStr = formatLocalDate(new Date());
  for (let i = 0; i < 7; i++) {
    const col = document.createElement("div");
    col.className = "calendar-day-column";
    const day = new Date(calendarWeekStart);
    day.setDate(day.getDate() + i);
    if (formatLocalDate(day) === todayStr) col.classList.add("is-today");

    for (const ev of layoutDayEvents(dayBuckets[i])) {
      renderCalendarEventBlock(col, ev);
    }
    grid.appendChild(col);
  }
}

function scrollCalendarToCurrentHour() {
  const scrollEl = document.querySelector("#calendar-week-scroll");
  const hour = Math.max(CALENDAR_WEEK_START_HOUR, Math.min(CALENDAR_WEEK_END_HOUR, new Date().getHours()));
  // One hour of lead-in so "now" isn't pinned to the very top edge.
  const target = (hour - CALENDAR_WEEK_START_HOUR - 1) * CALENDAR_HOUR_PX;
  scrollEl.scrollTop = Math.max(0, target);
}

async function loadAndRenderCalendarWeek() {
  let events = [];
  try {
    const base = await getBackendBaseUrl();
    const resp = await fetch(`${base}/calendar/week?week_start=${formatLocalDate(calendarWeekStart)}`);
    events = await resp.json();
  } catch {
    // Backend unreachable this cycle; the next poll/nav will catch up.
  }

  renderCalendarWeekHeader();
  renderCalendarWeekGrid(events);

  if (!calendarWeekHasAutoScrolled) {
    calendarWeekHasAutoScrolled = true;
    requestAnimationFrame(scrollCalendarToCurrentHour);
  }
}

async function refreshUpNext() {
  const notConnected = document.querySelector("#up-next-not-connected");
  const header = document.querySelector("#calendar-week-header");
  const weekView = document.querySelector("#calendar-week-view");

  const connected = await invoke("has_calendar_credentials");
  if (!connected) {
    notConnected.classList.remove("view-hidden");
    header.classList.add("view-hidden");
    weekView.classList.add("view-hidden");
    return;
  }
  notConnected.classList.add("view-hidden");
  header.classList.remove("view-hidden");
  weekView.classList.remove("view-hidden");

  if (!calendarWeekStart) calendarWeekStart = mondayOf(new Date());
  await loadAndRenderCalendarWeek();
}

function initUpNext() {
  document.querySelector("#calendar-week-prev").addEventListener("click", () => {
    calendarWeekStart.setDate(calendarWeekStart.getDate() - 7);
    loadAndRenderCalendarWeek();
  });
  document.querySelector("#calendar-week-next").addEventListener("click", () => {
    calendarWeekStart.setDate(calendarWeekStart.getDate() + 7);
    loadAndRenderCalendarWeek();
  });
  document.querySelector("#calendar-week-today").addEventListener("click", () => {
    calendarWeekStart = mondayOf(new Date());
    loadAndRenderCalendarWeek();
  });
  document.querySelector("#up-next-connect-btn").addEventListener("click", () => {
    document
      .querySelector("#section-settings")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    document.querySelector("#connect-calendar-btn")?.focus();
  });
}

// Books (currently reading)

const BOOK_COVER_RESOLUTION_TIMEOUT_MS = 25_000; // worst case: fetch page + Google Books lookup, each with its own server-side timeout

async function fetchBooks() {
  const base = await getBackendBaseUrl();
  const resp = await fetch(`${base}/books`);
  return resp.json();
}

function renderBooks(books) {
  const list = document.querySelector("#book-list");
  list.innerHTML = "";

  for (const book of books) {
    const li = document.createElement("li");
    li.className = "book-item";

    let coverEl;
    if (book.cover_url) {
      coverEl = document.createElement("img");
      coverEl.className = "book-cover";
      coverEl.src = book.cover_url;
      coverEl.alt = "";
    } else {
      coverEl = document.createElement("div");
      coverEl.className = "book-cover-placeholder";
      coverEl.textContent = "▤";
    }

    const meta = document.createElement("div");
    meta.className = "book-meta";
    const title = document.createElement("div");
    title.className = "book-title";
    title.textContent = book.title;
    meta.appendChild(title);
    if (book.author) {
      const author = document.createElement("div");
      author.className = "book-author";
      author.textContent = book.author;
      meta.appendChild(author);
    }

    const remove = document.createElement("button");
    remove.className = "book-remove";
    remove.type = "button";
    remove.textContent = "🗑";
    remove.title = "Remove";
    remove.addEventListener("click", () => deleteBook(book.id));

    li.appendChild(coverEl);
    li.appendChild(meta);
    li.appendChild(remove);
    list.appendChild(li);
  }
}

async function refreshBooks() {
  renderBooks(await fetchBooks());
}

async function deleteBook(id) {
  const base = await getBackendBaseUrl();
  await fetch(`${base}/books/${id}`, { method: "DELETE" });
  refreshBooks();
}

let bookAddInFlight = false;

async function handleBookAddSubmit(event) {
  event.preventDefault();
  if (bookAddInFlight) return;

  const input = document.querySelector("#book-url-input");
  const url = input.value.trim();
  const status = document.querySelector("#book-status");
  if (!url) return;

  bookAddInFlight = true;
  status.textContent = "Resolving cover…";
  try {
    const base = await getBackendBaseUrl();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BOOK_COVER_RESOLUTION_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(`${base}/books`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    // fetch() only rejects on network failure — a 4xx/5xx still resolves
    // here, so without this check a backend error would silently look
    // like nothing happened (form clears, no book actually added).
    if (!resp.ok) throw new Error(`book request failed: ${resp.status}`);
    input.value = "";
    status.textContent = "";
    document.querySelector("#book-add-form").classList.add("view-hidden");
    refreshBooks();
  } catch (err) {
    status.textContent =
      err.name === "AbortError" ? "Timed out resolving that cover." : "Could not add that book.";
  } finally {
    bookAddInFlight = false;
  }
}

function initBooks() {
  document.querySelector("#book-add-toggle").addEventListener("click", () => {
    document.querySelector("#book-add-form").classList.toggle("view-hidden");
    document.querySelector("#book-url-input")?.focus();
  });
  document.querySelector("#book-add-form").addEventListener("submit", handleBookAddSubmit);
  refreshBooks();
}

// Spotify playlist embed

let spotifyPlaylists = [];
let activeSpotifyPlaylistId = null;

async function fetchSpotifyPlaylists() {
  const base = await getBackendBaseUrl();
  const resp = await fetch(`${base}/spotify`);
  return resp.json();
}

function renderSpotifyEmbed() {
  const iframe = document.querySelector("#spotify-embed");
  const empty = document.querySelector("#spotify-empty");
  const tabs = document.querySelector("#spotify-tabs");

  if (spotifyPlaylists.length === 0) {
    iframe.classList.add("view-hidden");
    iframe.src = "";
    tabs.classList.add("view-hidden");
    empty.classList.remove("view-hidden");
    return;
  }

  empty.classList.add("view-hidden");
  iframe.classList.remove("view-hidden");

  if (!spotifyPlaylists.some((p) => p.id === activeSpotifyPlaylistId)) {
    activeSpotifyPlaylistId = spotifyPlaylists[0].id;
  }
  const active = spotifyPlaylists.find((p) => p.id === activeSpotifyPlaylistId);
  if (iframe.src !== active.embed_url) iframe.src = active.embed_url;

  tabs.innerHTML = "";
  tabs.classList.remove("view-hidden");
  for (const playlist of spotifyPlaylists) {
    const tab = document.createElement("button");
    tab.className = "tab" + (playlist.id === activeSpotifyPlaylistId ? " active" : "");
    tab.type = "button";
    tab.textContent = playlist.name;
    tab.addEventListener("click", () => {
      activeSpotifyPlaylistId = playlist.id;
      renderSpotifyEmbed();
    });
    tabs.appendChild(tab);
  }

  const addTab = document.createElement("button");
  addTab.className = "tab";
  addTab.type = "button";
  addTab.textContent = "+";
  addTab.title = "Add playlist";
  addTab.addEventListener("click", () => {
    document.querySelector("#spotify-add-form").classList.toggle("view-hidden");
    document.querySelector("#spotify-url-input")?.focus();
  });
  tabs.appendChild(addTab);
}

async function refreshSpotifyPlaylists() {
  spotifyPlaylists = await fetchSpotifyPlaylists();
  renderSpotifyEmbed();
}

let spotifyAddInFlight = false;

async function handleSpotifyAddSubmit(event) {
  event.preventDefault();
  if (spotifyAddInFlight) return;

  const input = document.querySelector("#spotify-url-input");
  const playlistUrl = input.value.trim();
  const status = document.querySelector("#spotify-status");
  if (!playlistUrl) return;

  spotifyAddInFlight = true;
  status.textContent = "Adding…";
  try {
    const base = await getBackendBaseUrl();
    const resp = await fetch(`${base}/spotify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlist_url: playlistUrl }),
    });
    if (!resp.ok) throw new Error("not a Spotify playlist URL");

    input.value = "";
    status.textContent = "";
    document.querySelector("#spotify-add-form").classList.add("view-hidden");
    await refreshSpotifyPlaylists();
  } catch (err) {
    status.textContent = "Could not add that playlist.";
  } finally {
    spotifyAddInFlight = false;
  }
}

function initSpotify() {
  document.querySelector("#spotify-add-toggle").addEventListener("click", () => {
    document.querySelector("#spotify-add-form").classList.toggle("view-hidden");
    document.querySelector("#spotify-url-input")?.focus();
  });
  document.querySelector("#spotify-add-form").addEventListener("submit", handleSpotifyAddSubmit);
  refreshSpotifyPlaylists();
}

// Active projects

async function fetchProjects() {
  const base = await getBackendBaseUrl();
  const resp = await fetch(`${base}/projects`);
  return resp.json();
}

function renderProjects(projects) {
  const list = document.querySelector("#project-list");
  list.innerHTML = "";

  for (const project of projects) {
    const li = document.createElement("li");
    li.className = "project-item" + (project.status === "done" ? " done" : "");

    const dot = document.createElement("span");
    dot.className = "project-dot " + project.status;

    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = project.name;

    li.appendChild(dot);
    li.appendChild(name);

    if (project.url) {
      li.title = project.url;
      li.addEventListener("click", (e) => {
        if (e.target.closest(".project-remove")) return;
        window.open(project.url, "_blank");
      });
    }

    const remove = document.createElement("button");
    remove.className = "project-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove";
    remove.addEventListener("click", () => deleteProject(project.id));
    li.appendChild(remove);

    list.appendChild(li);
  }
}

async function refreshProjects() {
  renderProjects(await fetchProjects());
}

async function deleteProject(id) {
  const base = await getBackendBaseUrl();
  await fetch(`${base}/projects/${id}`, { method: "DELETE" });
  refreshProjects();
}

let projectAddInFlight = false;

async function handleProjectAddSubmit(event) {
  event.preventDefault();
  if (projectAddInFlight) return;

  const nameInput = document.querySelector("#project-name-input");
  const urlInput = document.querySelector("#project-url-input");
  const name = nameInput.value.trim();
  if (!name) return;

  projectAddInFlight = true;
  try {
    const base = await getBackendBaseUrl();
    await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, url: urlInput.value.trim() || null }),
    });
    nameInput.value = "";
    urlInput.value = "";
    refreshProjects();
  } finally {
    projectAddInFlight = false;
  }
}

function initProjects() {
  document
    .querySelector("#project-add-form")
    .addEventListener("submit", handleProjectAddSubmit);
  refreshProjects();
}

// Notable events

function formatEventDate(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

async function fetchEvents() {
  const base = await getBackendBaseUrl();
  const resp = await fetch(`${base}/events`);
  return resp.json();
}

function renderEvents(events) {
  const list = document.querySelector("#events-list");
  list.innerHTML = "";
  const today = new Date().toISOString().slice(0, 10);

  for (const event of events) {
    const li = document.createElement("li");
    li.className = "event-pill" + (event.date < today ? " past" : "");

    const date = document.createElement("span");
    date.className = "event-date";
    date.textContent = formatEventDate(event.date);

    const label = document.createElement("span");
    label.className = "event-label";
    label.textContent = event.label;

    const remove = document.createElement("button");
    remove.className = "book-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove";
    remove.addEventListener("click", () => deleteEvent(event.id));

    li.appendChild(date);
    li.appendChild(label);
    li.appendChild(remove);
    list.appendChild(li);
  }
}

async function refreshEvents() {
  renderEvents(await fetchEvents());
}

async function deleteEvent(id) {
  const base = await getBackendBaseUrl();
  await fetch(`${base}/events/${id}`, { method: "DELETE" });
  refreshEvents();
}

let eventAddInFlight = false;

async function handleEventAddSubmit(event) {
  event.preventDefault();
  if (eventAddInFlight) return;

  const labelInput = document.querySelector("#event-label-input");
  const dateInput = document.querySelector("#event-date-input");
  const label = labelInput.value.trim();
  const date = dateInput.value;
  if (!label || !date) return;

  eventAddInFlight = true;
  try {
    const base = await getBackendBaseUrl();
    await fetch(`${base}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, date }),
    });
    labelInput.value = "";
    dateInput.value = "";
    refreshEvents();
  } finally {
    eventAddInFlight = false;
  }
}

function initEvents() {
  document.querySelector("#event-add-form").addEventListener("submit", handleEventAddSubmit);
  refreshEvents();
}

// Countdown timer (session-only — no persistence, no backend)

let timerRemainingSeconds = 25 * 60;
let timerIntervalHandle = null;
let timerRunning = false;

function formatTimerDisplay(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function updateTimerDisplay() {
  document.querySelector("#timer-display").textContent = formatTimerDisplay(timerRemainingSeconds);
}

async function handleTimerComplete() {
  clearInterval(timerIntervalHandle);
  timerIntervalHandle = null;
  timerRunning = false;
  document.querySelector("#timer-start-btn").textContent = "Start";
  document.querySelector("#timer-start-btn").classList.remove("active");
  document.querySelector("#timer-display").textContent = "done";
  try {
    await invoke("notify_new_assignment", {
      title: "Timer complete",
      body: "Your countdown timer has finished.",
    });
  } catch {
    // notification failure shouldn't block resetting the timer UI
  }
}

function startTimer() {
  timerRunning = true;
  document.querySelector("#timer-start-btn").textContent = "Pause";
  document.querySelector("#timer-start-btn").classList.add("active");
  timerIntervalHandle = setInterval(() => {
    timerRemainingSeconds -= 1;
    if (timerRemainingSeconds <= 0) {
      timerRemainingSeconds = 0;
      updateTimerDisplay();
      handleTimerComplete();
      return;
    }
    updateTimerDisplay();
  }, 1000);
}

function pauseTimer() {
  timerRunning = false;
  clearInterval(timerIntervalHandle);
  timerIntervalHandle = null;
  document.querySelector("#timer-start-btn").textContent = "Start";
  document.querySelector("#timer-start-btn").classList.remove("active");
}

function resetTimer() {
  pauseTimer();
  const minutesInput = document.querySelector("#timer-minutes-input");
  const minutes = Math.min(180, Math.max(1, Number(minutesInput.value) || 25));
  minutesInput.value = minutes;
  timerRemainingSeconds = minutes * 60;
  updateTimerDisplay();
}

function initTimer() {
  document.querySelector("#timer-start-btn").addEventListener("click", () => {
    if (timerRunning) {
      pauseTimer();
    } else {
      startTimer();
    }
  });
  document.querySelector("#timer-reset-btn").addEventListener("click", resetTimer);
  document.querySelector("#timer-minutes-input").addEventListener("change", () => {
    if (!timerRunning) resetTimer();
  });
  resetTimer();
}

// Photo masonry (local files only — no remote URLs, unlike book covers)

async function fetchPhotos() {
  const base = await getBackendBaseUrl();
  const resp = await fetch(`${base}/photos`);
  return resp.json();
}

async function renderPhotos() {
  const masonry = document.querySelector("#photo-masonry");
  const empty = document.querySelector("#photo-empty-state");
  masonry.innerHTML = "";

  const photos = await fetchPhotos();
  if (photos.length === 0) {
    empty.classList.remove("view-hidden");
    return;
  }
  empty.classList.add("view-hidden");

  const base = await getBackendBaseUrl();
  // Newest first, so a newly-added photo lands at the top of the first
  // column — CSS multi-column layout fills column 1 top-down before
  // moving to column 2, so source order is display order.
  for (const photo of [...photos].reverse()) {
    const item = document.createElement("div");
    item.className = "photo-masonry-item";
    item.dataset.photoId = photo.id;

    const img = document.createElement("img");
    img.src = `${base}/photos/${photo.id}/file`;
    img.alt = "";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "photo-remove-btn";
    removeBtn.title = "Remove photo";
    removeBtn.textContent = "🗑";
    removeBtn.addEventListener("click", () => handleRemovePhoto(photo.id));

    item.appendChild(img);
    item.appendChild(removeBtn);
    masonry.appendChild(item);
  }
}

async function handleAddPhoto() {
  const path = await invoke("pick_image_file");
  if (!path) return;

  const base = await getBackendBaseUrl();
  await fetch(`${base}/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  renderPhotos();
}

async function handleRemovePhoto(photoId) {
  const base = await getBackendBaseUrl();
  await fetch(`${base}/photos/${photoId}`, { method: "DELETE" });
  renderPhotos();
}

function initPhotoPanels() {
  document.querySelector("#photo-add-btn").addEventListener("click", handleAddPhoto);
  renderPhotos();
}

// Settings

async function refreshCalendarSettingsUI() {
  const connected = await invoke("has_calendar_credentials");
  const statusText = document.querySelector("#calendar-status-text");
  const connectBtn = document.querySelector("#connect-calendar-btn");
  const disconnectBtn = document.querySelector("#disconnect-calendar-btn");

  statusText.textContent = connected ? "Connected" : "Not connected";
  connectBtn.classList.toggle("view-hidden", connected);
  disconnectBtn.classList.toggle("view-hidden", !connected);
}

async function handleConnectCalendarClick() {
  await invoke("clear_calendar_onboarding_seen");
  showView("calendar-onboarding-view");
}

async function handleDisconnectCalendar() {
  const base = await getBackendBaseUrl();
  try {
    await fetch(`${base}/calendar/disconnect`, { method: "POST" });
  } catch {
    // fall through and clear local state regardless
  }
  await invoke("disconnect_calendar");
  await refreshCalendarSettingsUI();
  await refreshUpNext();
}

async function handleDisconnectCanvas() {
  const base = await getBackendBaseUrl();
  try {
    await fetch(`${base}/canvas/disconnect`, { method: "POST" });
  } catch {
    // fall through and clear local state regardless — the user still
    // needs to be sent back to onboarding even if the backend call failed
  }
  await invoke("disconnect_canvas");

  if (dashboardPollHandle) {
    clearInterval(dashboardPollHandle);
    dashboardPollHandle = undefined;
  }
  latestAssignments = [];
  showView("onboarding-view");
}

function initSettings() {
  document
    .querySelector("#connect-calendar-btn")
    .addEventListener("click", handleConnectCalendarClick);
  document
    .querySelector("#disconnect-calendar-btn")
    .addEventListener("click", handleDisconnectCalendar);
  document
    .querySelector("#disconnect-canvas-btn")
    .addEventListener("click", handleDisconnectCanvas);
}

async function refreshSettings() {
  const domain = await invoke("stored_domain");
  document.querySelector("#settings-domain").textContent = domain || "—";
  await refreshCalendarSettingsUI();
}

//Dashboard

async function initDashboard() {
  setGreeting();
  initQuote();
  initSidebarNav();
  initTabs();
  initChecklist();
  initGoals();
  initBooks();
  initProjects();
  initEvents();
  initTimer();
  initSpotify();
  initPhotoPanels();
  await refreshUpNext();
  await refreshSettings();

  await refreshAssignments();
  if (!dashboardPollHandle) {
    dashboardPollHandle = setInterval(() => {
      refreshAssignments();
      checkForNewAssignments();
      refreshUpNext();
    }, DASHBOARD_POLL_MS);
  }
}

async function init() {
  document
    .querySelector("#onboarding-form")
    .addEventListener("submit", handleOnboardingSubmit);
  initCalendarOnboarding();
  initSettings();
  initUpNext();

  const hasCredentials = await invoke("has_credentials");
  if (hasCredentials) {
    showView("dashboard-view");
    initDashboard();
  } else {
    showView("onboarding-view");
  }
}

window.addEventListener("DOMContentLoaded", init);
