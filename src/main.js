const { invoke } = window.__TAURI__.core;

let backendBaseUrl;

async function getBackendBaseUrl() {
  if (!backendBaseUrl) {
    const port = await invoke("backend_port");
    backendBaseUrl = `http://127.0.0.1:${port}`;
  }
  return backendBaseUrl;
}


let _backendDown = false;
let _healthPollHandle = null;

function _getOrCreateBanner() {
  let el = document.getElementById('reconnect-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'reconnect-banner';
    el.className = 'reconnect-banner hidden';
    el.textContent = 'Reconnecting…';
    document.body.appendChild(el);
  }
  return el;
}

function _showReconnectBanner() {
  if (_backendDown) return;
  _backendDown = true;
  _getOrCreateBanner().classList.remove('hidden');
  if (!_healthPollHandle) {
    _healthPollHandle = setInterval(_checkHealth, 5000);
  }
}

function _hideReconnectBanner() {
  if (!_backendDown) return;
  _backendDown = false;
  _getOrCreateBanner().classList.add('hidden');
  if (_healthPollHandle) {
    clearInterval(_healthPollHandle);
    _healthPollHandle = null;
  }
}

async function waitForBackend(maxWaitMs = 30000) {
  const base = await getBackendBaseUrl();
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function _checkHealth() {
  try {
    const base = await getBackendBaseUrl();
    const resp = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) _hideReconnectBanner();
  } catch {
    _showReconnectBanner();
  }
}

function startHealthMonitor() {
  _healthPollHandle = setInterval(_checkHealth, 5000);
  window.addEventListener('unhandledrejection', (evt) => {
    if (_backendDown && evt.reason instanceof TypeError) {
      evt.preventDefault();
    }
  });
}


function showView(id) {
  for (const view of document.querySelectorAll("body > main, body > div.app-shell")) {
    view.classList.toggle("view-hidden", view.id !== id);
  }
}

let onboardingInFlight = false;

async function handleOnboardingSubmit(event) {
  event.preventDefault();
  if (onboardingInFlight) return; 

  const name = document.querySelector("#name-input").value.trim();
  const domain = document.querySelector("#domain-input").value.trim();
  const token = document.querySelector("#token-input").value;
  const status = document.querySelector("#onboarding-status");
  const submitBtn = event.target.querySelector("button[type=submit]");

  onboardingInFlight = true;
  submitBtn.disabled = true;
  status.textContent = "Validating…";

  try {
    if (name) await invoke("save_display_name", { name });
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

const CALENDAR_OAUTH_POLL_MS = 1_500;
const CALENDAR_OAUTH_MAX_WAIT_MS = 5 * 60_000;
const CALENDAR_OAUTH_CANCELLED_MESSAGE = "Authorization cancelled or timed out. Try again.";

let calendarSetupCancelRequested = false;

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
      continue;
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

const QUOTES = [
  "Success is the sum of small efforts, repeated day in and day out. -Robert Collier",
  "Motivation is what gets you started. Habit is what keeps you going. -Jim Ryun",
  "The way to get started is to quit talking and begin doing. -Walt Disney",
  "The expert in anything was once a beginner. — Helen Hayes",
  "The illiterate of the future will not be the person who cannot read. It will be the person who does not know how to learn. Alvin Toffler",
  "The function of education is to teach one to think intensively and to think critically. Intelligence plus character – that is the goal of true education. – Dr. Martin Luther King, Jr",
  "Education in the most powerful weapon which you can use to change the world.– Nelson Mandela",
  "Education is not preparation for life; education is life itself. – John Dewey",
  "An investment in knowledge pays the best interest. -Benjamin Franklin",
  "The roots of education are bitter, but the fruit is sweet. – Aristotle",
  "It is the mark of an educated mind to be able to entertain a thought without accepting it.– Aristotle",
  "It is better to learn late than never. – Publilius Syrus",
  "The only person who is educated is the one who has learned how to learn and change. – Carl Rogers",
  "The whole purpose of education is to turn mirrors into windows. – Sydney J. Harris",
  "Education is learning what you didn’t even know you didn’t know. – Daniel J. Boorstin",
  "Education’s purpose is to replace and empty mind with an open one.– Malcom Forbes",
  "You are always a student, never a master. You have keep moving forward. – Conrad Hall",
  "Education is not the filling of a pail, but the lighting of a fire. – William Butler Yeats",
  "The beautiful thing about learning is that no one can take it away from you. – B.B. King",
  "Education is the ability to listen to almost anything without losing your temper or your self-confidence.– Robert Frost",
  "Live as if you were to die tomorrow. Learn as if you were to live forever. – Mahatma Gandhi",
  "You can never be overdressed or overeducated.– Oscar Wilde"
];

function timeOfDayGreeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 21) return "Good evening";
  return "Good night";
}

async function setGreeting() {
  let name = null;
  try {
    name = await invoke("display_name");
  } catch {}
  const greeting = timeOfDayGreeting();
  document.querySelector("#greeting-text").textContent = name
    ? `${greeting}, ${name}`
    : greeting;
}

function showRandomQuote() {
  const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  document.querySelector("#quote-text").textContent = quote;
}

function initQuote() {
  showRandomQuote();
  document.querySelector("#quote-refresh").addEventListener("click", showRandomQuote);
}

async function fetchChecklist() {
  const base = await getBackendBaseUrl();
  const resp = await fetch(`${base}/checklist`);
  return resp.json();
}

function renderChecklist(items) {
  const list = document.querySelector("#checklist-list");
  list.innerHTML = "";

  for (const item of items) {
    if (item.done) continue;
    const li = document.createElement("li");
    li.className = "checklist-item";

    const checkbox = document.createElement("button");
    checkbox.className = "checklist-checkbox";
    checkbox.type = "button";
    checkbox.addEventListener("click", () => completeChecklistItem(item.id, li));

    const text = document.createElement("span");
    text.className = "checklist-text";
    text.textContent = item.text;
    text.addEventListener("click", () => completeChecklistItem(item.id, li));

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

async function completeChecklistItem(id, li) {
  if (li.classList.contains("fading-out")) return;
  li.classList.add("fading-out");
  setTimeout(() => li.remove(), 300);

  const base = await getBackendBaseUrl();
  await fetch(`${base}/checklist/${id}`, { method: "PATCH" });
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
}

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
}

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
  }
}

const CALENDAR_WEEK_START_HOUR = 7;
const CALENDAR_WEEK_END_HOUR = 22;
const CALENDAR_HOUR_PX = 48;
const CALENDAR_MIN_EVENT_PX = 24;
const CALENDAR_GRID_MINUTES = (CALENDAR_WEEK_END_HOUR - CALENDAR_WEEK_START_HOUR) * 60;

let calendarWeekStart = null;
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
  const dayIndex = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dayIndex);
  return d;
}

function minutesFromGridStart(date) {
  return (date.getHours() - CALENDAR_WEEK_START_HOUR) * 60 + date.getMinutes();
}

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
  if (axis.children.length) return;
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
  const notConnected = document.querySelector("#up-next-not-connected");
  notConnected.innerHTML = "";

  const icon = document.createElement("span");
  icon.textContent = "📅";
  icon.style.cssText = "font-size: 32px; display: block; margin-bottom: 0.5em; opacity: 0.35;";

  const msg = document.createElement("p");
  msg.className = "text-secondary";
  msg.style.cssText = "font-size: 12px; margin: 0 0 0.8em;";
  msg.textContent = "Google Calendar not connected";

  const btn = document.createElement("button");
  btn.id = "up-next-connect-btn";
  btn.type = "button";
  btn.textContent = "Connect Google Calendar";
  btn.addEventListener("click", handleConnectCalendarClick);

  notConnected.appendChild(icon);
  notConnected.appendChild(msg);
  notConnected.appendChild(btn);
  notConnected.classList.remove("view-hidden");

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
}

const BOOK_COVER_RESOLUTION_TIMEOUT_MS = 25_000;

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
}

let spotifyPlaylists = [];
let activeSpotifyPlaylistId = null;

async function fetchSpotifyPlaylists() {
  const base = await getBackendBaseUrl();
  const resp = await fetch(`${base}/spotify`);
  return resp.json();
}

function renderSpotifyEmbed() {
  const player = document.querySelector("#spotify-player");
  const cover = document.querySelector("#spotify-cover");
  const coverPlaceholder = document.querySelector("#spotify-cover-placeholder");
  const nameEl = document.querySelector("#spotify-name");
  const empty = document.querySelector("#spotify-empty");
  const tabs = document.querySelector("#spotify-tabs");

  if (spotifyPlaylists.length === 0) {
    player.classList.add("view-hidden");
    tabs.classList.add("view-hidden");
    empty.classList.remove("view-hidden");
    return;
  }

  empty.classList.add("view-hidden");
  player.classList.remove("view-hidden");

  if (!spotifyPlaylists.some((p) => p.id === activeSpotifyPlaylistId)) {
    activeSpotifyPlaylistId = spotifyPlaylists[0].id;
  }
  const active = spotifyPlaylists.find((p) => p.id === activeSpotifyPlaylistId);
  if (active.cover_url) {
    if (cover.src !== active.cover_url) cover.src = active.cover_url;
    cover.classList.remove("view-hidden");
    coverPlaceholder.classList.add("view-hidden");
  } else {
    cover.classList.add("view-hidden");
    coverPlaceholder.classList.remove("view-hidden");
  }
  nameEl.textContent = active.name;

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
  document.querySelector("#spotify-player").addEventListener("click", () => {
    const active = spotifyPlaylists.find((p) => p.id === activeSpotifyPlaylistId);
    if (active) window.open(active.playlist_url, "_blank");
  });
}

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
}

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
}

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


const ZONES_KEY = "dashboard-zones";
const ZONE_GAP = 12;
const ZONE_COL_MIN = 1, ZONE_COL_MAX = 4;
const ZONE_HEIGHT_MIN = 100, ZONE_HEIGHT_MAX = 800;
const ZONE_DEFAULT_HEIGHT = 200;
const PHOTO_HEIGHT_PRESETS = [200, 400, 500];

function equalColWidths(n) {
  return Array.from({ length: n }, () => Math.round((100 / n) * 100) / 100);
}

function defaultZones() {
  return [
    { id: "zone-0", cols: 3, colWidths: [33.33, 33.33, 33.33], height: 200 },
    { id: "zone-1", cols: 2, colWidths: [50, 50], height: 300 },
    { id: "zone-2", cols: 4, colWidths: [25, 25, 25, 25], height: 200 },
  ];
}

function loadZones() {
  try {
    const stored = JSON.parse(localStorage.getItem(ZONES_KEY));
    if (
      Array.isArray(stored) &&
      stored.length &&
      stored.every(
        (z) =>
          typeof z.id === "string" &&
          Number.isInteger(z.cols) &&
          z.cols >= ZONE_COL_MIN &&
          z.cols <= ZONE_COL_MAX &&
          Array.isArray(z.colWidths) &&
          z.colWidths.length === z.cols &&
          z.colWidths.every((w) => Number.isFinite(w) && w > 0) &&
          Number.isFinite(z.height) &&
          z.height > 0
      )
    ) {
      return stored;
    }
  } catch {}
  return defaultZones();
}

let zones = loadZones();
let zoneLayout = [];
let zoneSortables = [];

function saveZones() {
  localStorage.setItem(ZONES_KEY, JSON.stringify(zones));
}

function zoneById(id) {
  return zones.find((z) => z.id === id);
}

function nextZoneId() {
  let max = -1;
  for (const z of zones) {
    const m = /^zone-(\d+)$/.exec(z.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `zone-${max + 1}`;
}

function zoneUsedSlots(zoneId, excludeWidgetId = null) {
  return zoneLayout
    .filter((it) => it.zone_id === zoneId && it.widget_id !== excludeWidgetId)
    .reduce((sum, it) => sum + (it.col_span || 1), 0);
}


function defaultZoneLayout() {
  const zoneId = (i) => (zones[i] ?? zones[zones.length - 1]).id;
  const items = [];
  const place = (zoneIndex, widgetIds) => {
    widgetIds.forEach((id, position) =>
      items.push({ widget_id: id, zone_id: zoneId(zoneIndex), position, col_span: 1 })
    );
  };
  place(0, ["widget-timer", "widget-reading", "widget-spotify"]);
  place(1, ["widget-assignments", "widget-calendar"]);
  place(2, ["widget-checklist", "widget-projects", "widget-events", "widget-goals"]);

  const calendar = items.find((it) => it.widget_id === "widget-calendar");
  const zone = zoneById(calendar.zone_id);
  const used = items
    .filter((it) => it.zone_id === calendar.zone_id)
    .reduce((sum, it) => sum + it.col_span, 0);
  if (zone.cols >= used + 1) calendar.col_span = 2;
  return items;
}

function allZoneCards() {
  return [...document.querySelectorAll("#zone-container .card")];
}

function renumberZonePositions() {
  for (const zone of zones) {
    zoneLayout
      .filter((it) => it.zone_id === zone.id)
      .sort((a, b) => a.position - b.position)
      .forEach((it, i) => (it.position = i));
  }
}

function normalizeZoneLayout() {
  const cardIds = new Set(allZoneCards().map((el) => el.id));
  const zoneIds = new Set(zones.map((z) => z.id));
  const lastZoneId = zones[zones.length - 1].id;

  const seen = new Set();
  zoneLayout = zoneLayout.filter((it) => {
    if (!cardIds.has(it.widget_id) || seen.has(it.widget_id)) return false;
    seen.add(it.widget_id);
    return true;
  });
  for (const it of zoneLayout) {
    if (!zoneIds.has(it.zone_id)) {
      it.zone_id = lastZoneId;
      it.position = Number.MAX_SAFE_INTEGER;
    }
  }
  for (const id of cardIds) {
    if (!seen.has(id)) {
      zoneLayout.push({
        widget_id: id,
        zone_id: lastZoneId,
        position: Number.MAX_SAFE_INTEGER,
        col_span: 1,
      });
    }
  }
  renumberZonePositions();
}

function cardFlexBasis(zone, slot, span) {
  const widths = zone.colWidths;
  let pct = 0;
  for (let i = 0; i < span; i++) {
    pct += widths[Math.min(slot + i, widths.length - 1)];
  }
  const gapPx = (ZONE_GAP * (zone.cols - 1) * pct) / 100 - ZONE_GAP * (span - 1);
  return `calc(${pct}% - ${gapPx.toFixed(2)}px)`;
}

function applyZoneStyles() {
  for (const zoneEl of document.querySelectorAll("#zone-container .zone")) {
    const zone = zoneById(zoneEl.dataset.zoneId);
    if (!zone) continue;
    zoneEl.style.height = `${zone.height}px`;
    let slot = 0;
    for (const card of zoneEl.children) {
      let span = Math.min(Math.max(parseInt(card.dataset.colSpan, 10) || 1, 1), zone.cols);
      span = Math.min(span, Math.max(zone.cols - Math.min(slot, zone.cols - 1), 1));
      card.dataset.colSpan = span;
      card.style.flex = `0 0 ${cardFlexBasis(zone, slot, span)}`;
      slot += span;
    }
  }
}

function readZoneLayoutFromDom() {
  const items = [];
  for (const zoneEl of document.querySelectorAll("#zone-container .zone")) {
    [...zoneEl.children].forEach((card, position) => {
      items.push({
        widget_id: card.id,
        zone_id: zoneEl.dataset.zoneId,
        position,
        col_span: parseInt(card.dataset.colSpan, 10) || 1,
      });
    });
  }
  return items;
}

function resolveZoneCapacity() {
  let changed = false;
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const items = zoneLayout
      .filter((it) => it.zone_id === zone.id)
      .sort((a, b) => a.position - b.position);

    while (items.length > zone.cols && zone.cols < ZONE_COL_MAX) {
      zone.cols += 1;
      zone.colWidths = equalColWidths(zone.cols);
      zone.autoExpanded = true;
      changed = true;
    }

    if (items.length > zone.cols) {
      const overflow = items.slice(zone.cols);
      let nextZone = zones[i + 1];
      if (!nextZone) {
        nextZone = {
          id: nextZoneId(),
          cols: 1,
          colWidths: equalColWidths(1),
          height: ZONE_DEFAULT_HEIGHT,
        };
        zones.push(nextZone);
      }
      for (const it of zoneLayout) {
        if (it.zone_id === nextZone.id) it.position += overflow.length;
      }
      overflow.forEach((it, k) => {
        it.zone_id = nextZone.id;
        it.position = k;
      });
      changed = true;
    }
  }

  for (const zone of zones) {
    if (!zone.autoExpanded) continue;
    const needed = Math.max(zoneUsedSlots(zone.id), 1);
    if (needed < zone.cols) {
      zone.cols = needed;
      zone.colWidths = equalColWidths(needed);
      changed = true;
    }
  }
  return changed;
}

function handleZoneDrop() {
  zoneLayout = readZoneLayoutFromDom();
  const changed = resolveZoneCapacity();
  saveZones();

  if (changed) {
    setTimeout(() => {
      renderZones();
      saveZoneLayout();
    }, 0);
  } else {
    applyZoneStyles();
    saveZoneLayout();
  }
}

function renderZones() {
  const container = document.getElementById("zone-container");
  normalizeZoneLayout();
  if (resolveZoneCapacity()) {
    saveZones();
    renderZoneEditor();
  }

  for (const s of zoneSortables) s.destroy();
  zoneSortables = [];

  const cardsById = new Map();
  for (const card of allZoneCards()) {
    cardsById.set(card.id, card);
    card.remove();
  }
  container.innerHTML = "";

  for (const zone of zones) {
    const zoneEl = document.createElement("div");
    zoneEl.className = "zone";
    zoneEl.dataset.zoneId = zone.id;
    container.appendChild(zoneEl);

    const items = zoneLayout
      .filter((it) => it.zone_id === zone.id)
      .sort((a, b) => a.position - b.position);
    for (const item of items) {
      const card = cardsById.get(item.widget_id);
      card.dataset.colSpan = item.col_span || 1;
      zoneEl.appendChild(card);
    }

    zoneSortables.push(
      new window.Sortable(zoneEl, {
        group: "widgets",
        animation: 150,
        forceFallback: true,
        handle: ".widget-drag-handle",
        ghostClass: "zone-drag-ghost",
        chosenClass: "zone-drag-chosen",
        onStart: () => document.body.classList.add("widget-dragging"),
        onEnd: (evt) => {
          document.body.classList.remove("widget-dragging");
          handleZoneDrop(evt);
        },
      })
    );
  }
  applyZoneStyles();
}

async function saveZoneLayout() {
  try {
    const base = await getBackendBaseUrl();
    await fetch(`${base}/layout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(zoneLayout),
    });
  } catch {}
}

async function restoreZoneLayout() {
  let saved = [];
  try {
    const base = await getBackendBaseUrl();
    const resp = await fetch(`${base}/layout`);
    if (resp.ok) saved = await resp.json();
  } catch {}

  zoneLayout = saved.length ? saved : defaultZoneLayout();
  renderZones();
  await saveZoneLayout();
}

function zonesChanged() {
  saveZones();
  renderZones();
  renderZoneEditor();
  saveZoneLayout();
}

function spillZoneOverflow(zone) {
  const items = zoneLayout
    .filter((it) => it.zone_id === zone.id)
    .sort((a, b) => a.position - b.position);
  if (items.length <= zone.cols) return false;

  const overflow = items.slice(zone.cols);
  let nextZone = zones[zones.indexOf(zone) + 1];
  if (!nextZone) {
    nextZone = {
      id: nextZoneId(),
      cols: 1,
      colWidths: equalColWidths(1),
      height: ZONE_DEFAULT_HEIGHT,
    };
    zones.push(nextZone);
    saveZones();
  }
  for (const it of zoneLayout) {
    if (it.zone_id === nextZone.id) it.position += overflow.length;
  }
  overflow.forEach((it, i) => {
    it.zone_id = nextZone.id;
    it.position = i;
  });
  return true;
}

function setZoneCols(zone, cols) {
  cols = Math.min(Math.max(cols, ZONE_COL_MIN), ZONE_COL_MAX);
  if (cols === zone.cols) return;
  const shrinking = cols < zone.cols;

  zone.cols = cols;
  zone.colWidths = equalColWidths(cols);
  zone.autoExpanded = false;

  if (shrinking) {
    for (const it of zoneLayout) {
      if (it.zone_id === zone.id) it.col_span = Math.min(it.col_span || 1, cols);
    }
    spillZoneOverflow(zone);
  }

  zonesChanged();
}

function addZone() {
  zones.push({
    id: nextZoneId(),
    cols: 3,
    colWidths: equalColWidths(3),
    height: ZONE_DEFAULT_HEIGHT,
  });
  zonesChanged();
}

function deleteZone(zone) {
  if (zones.length <= 1) return;
  const index = zones.indexOf(zone);
  const target = zones[index + 1] ?? zones[index - 1];
  const moving = zoneLayout
    .filter((it) => it.zone_id === zone.id)
    .sort((a, b) => a.position - b.position);
  for (const it of zoneLayout) {
    if (it.zone_id === target.id) it.position += moving.length;
  }
  moving.forEach((it, i) => {
    it.zone_id = target.id;
    it.position = i;
  });
  zones.splice(index, 1);
  zonesChanged();
}

function resetZoneLayout() {
  zones = defaultZones();
  zoneLayout = defaultZoneLayout();
  zonesChanged();
}


let widgetMenuEl = null;

function hideWidgetMenu() {
  if (widgetMenuEl) {
    widgetMenuEl.remove();
    widgetMenuEl = null;
  }
}

function widgetMenuItem(label, onClick, { active = false, disabled = false } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "widget-menu-item";
  btn.textContent = label;
  if (active) btn.classList.add("active");
  if (disabled) {
    btn.disabled = true;
  } else {
    btn.addEventListener("click", () => {
      hideWidgetMenu();
      onClick();
    });
  }
  return btn;
}

function setWidgetSpan(widgetId, span) {
  const item = zoneLayout.find((it) => it.widget_id === widgetId);
  if (!item) return;
  item.col_span = span;
  renderZones();
  saveZoneLayout();
}

function moveWidgetToZone(widgetId, zoneId) {
  const item = zoneLayout.find((it) => it.widget_id === widgetId);
  if (!item) return;
  for (const other of zoneLayout) {
    if (other.zone_id === zoneId) other.position += 1;
  }
  item.zone_id = zoneId;
  item.position = 0;
  renderZones();
  saveZoneLayout();
}

function showWidgetMenu(card, x, y) {
  hideWidgetMenu();
  const item = zoneLayout.find((it) => it.widget_id === card.id);
  if (!item) return;
  const zone = zoneById(item.zone_id);

  const menu = document.createElement("div");
  menu.className = "widget-menu";

  if ((item.col_span || 1) === 1) {
    const hasRoom =
      zone && zone.cols >= 2 && zoneUsedSlots(zone.id, card.id) + 2 <= zone.cols;
    menu.appendChild(
      widgetMenuItem("Span 2 columns", () => setWidgetSpan(card.id, 2), {
        disabled: !hasRoom,
      })
    );
  } else {
    menu.appendChild(widgetMenuItem("Span 1 column", () => setWidgetSpan(card.id, 1)));
  }

  const moveWrap = document.createElement("div");
  moveWrap.className = "widget-menu-sub";
  const moveLabel = document.createElement("button");
  moveLabel.type = "button";
  moveLabel.className = "widget-menu-item";
  moveLabel.textContent = "Move to zone… ▸";
  const sub = document.createElement("div");
  sub.className = "widget-menu widget-submenu";
  zones.forEach((z, i) => {
    sub.appendChild(
      widgetMenuItem(`Zone ${i + 1}`, () => moveWidgetToZone(card.id, z.id), {
        active: z.id === item.zone_id,
      })
    );
  });
  moveWrap.appendChild(moveLabel);
  moveWrap.appendChild(sub);
  menu.appendChild(moveWrap);

  if (card.classList.contains("photo-cell") && zone) {
    for (const h of PHOTO_HEIGHT_PRESETS) {
      menu.appendChild(
        widgetMenuItem(
          `Height ${h}px`,
          () => {
            zone.height = h;
            saveZones();
            applyZoneStyles();
            renderZoneEditor();
          },
          { active: zone.height === h }
        )
      );
    }
  }

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  widgetMenuEl = menu;
}

function initWidgetMenu() {
  document.addEventListener("contextmenu", (e) => {
    const card = e.target.closest("#zone-container .card");
    if (!card) {
      hideWidgetMenu();
      return;
    }
    e.preventDefault();
    showWidgetMenu(card, e.clientX, e.clientY);
  });
  document.addEventListener("click", hideWidgetMenu);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideWidgetMenu();
  });
}


let zoneListSortable = null;

function makeZoneColDivider(preview, zone, index) {
  const divider = document.createElement("div");
  divider.className = "zone-col-divider";
  divider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidths = [...zone.colWidths];
    const previewWidth = preview.getBoundingClientRect().width;
    const total = startWidths.reduce((a, b) => a + b, 0);

    const onMove = (ev) => {
      const delta = ((ev.clientX - startX) / previewWidth) * total;
      const pair = startWidths[index] + startWidths[index + 1];
      const minShare = total * 0.08;
      const left = Math.min(Math.max(startWidths[index] + delta, minShare), pair - minShare);
      zone.colWidths[index] = Math.round(left * 100) / 100;
      zone.colWidths[index + 1] = Math.round((pair - left) * 100) / 100;
      const cells = preview.querySelectorAll(".zone-preview-cell");
      cells[index].style.flex = `${zone.colWidths[index]} 1 0`;
      cells[index + 1].style.flex = `${zone.colWidths[index + 1]} 1 0`;
      applyZoneStyles();
    };
    const onUp = () => {
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", onUp);
      saveZones();
    };
    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", onUp);
  });
  return divider;
}

function buildZoneColsPreview(zone) {
  const preview = document.createElement("div");
  preview.className = "zone-cols-preview";
  for (let i = 0; i < zone.cols; i++) {
    const cell = document.createElement("div");
    cell.className = "zone-preview-cell";
    cell.style.flex = `${zone.colWidths[i]} 1 0`;
    preview.appendChild(cell);
    if (i < zone.cols - 1) preview.appendChild(makeZoneColDivider(preview, zone, i));
  }
  return preview;
}

function renderZoneEditor() {
  const list = document.getElementById("zone-editor-list");
  if (!list) return;
  if (zoneListSortable) {
    zoneListSortable.destroy();
    zoneListSortable = null;
  }
  list.innerHTML = "";

  zones.forEach((zone, index) => {
    const row = document.createElement("div");
    row.className = "zone-editor-row";
    row.dataset.zoneId = zone.id;

    const handle = document.createElement("span");
    handle.className = "zone-row-handle";
    handle.title = "Drag to reorder";
    handle.textContent = "⠿";

    const label = document.createElement("span");
    label.className = "zone-row-label";
    label.textContent = `Zone ${index + 1}`;

    const colsLabel = document.createElement("label");
    colsLabel.className = "zone-row-field";
    colsLabel.append("Cols ");
    const colsSelect = document.createElement("select");
    for (let n = ZONE_COL_MIN; n <= ZONE_COL_MAX; n++) {
      const opt = document.createElement("option");
      opt.value = n;
      opt.textContent = n;
      if (n === zone.cols) opt.selected = true;
      colsSelect.appendChild(opt);
    }
    colsSelect.addEventListener("change", () =>
      setZoneCols(zone, parseInt(colsSelect.value, 10))
    );
    colsLabel.appendChild(colsSelect);

    const heightLabel = document.createElement("label");
    heightLabel.className = "zone-row-field";
    heightLabel.append("Height ");
    const heightInput = document.createElement("input");
    heightInput.type = "number";
    heightInput.min = ZONE_HEIGHT_MIN;
    heightInput.max = ZONE_HEIGHT_MAX;
    heightInput.value = zone.height;
    heightInput.addEventListener("change", () => {
      const h = Math.min(
        Math.max(parseInt(heightInput.value, 10) || zone.height, ZONE_HEIGHT_MIN),
        ZONE_HEIGHT_MAX
      );
      heightInput.value = h;
      zone.height = h;
      saveZones();
      applyZoneStyles();
    });
    heightLabel.appendChild(heightInput);

    const preview = buildZoneColsPreview(zone);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "zone-row-delete";
    del.textContent = "×";
    del.title = "Delete row";
    del.disabled = zones.length <= 1;
    del.addEventListener("click", () => deleteZone(zone));

    row.append(handle, label, colsLabel, heightLabel, preview, del);
    list.appendChild(row);
  });

  zoneListSortable = new window.Sortable(list, {
    animation: 150,
    forceFallback: true,
    handle: ".zone-row-handle",
    onEnd: () => {
      const order = [...list.children].map((row) => row.dataset.zoneId);
      zones.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      zonesChanged();
    },
  });
}

function initZoneSettingsUI() {
  document.getElementById("zone-add-btn")?.addEventListener("click", addZone);
  document.getElementById("zone-reset-btn")?.addEventListener("click", resetZoneLayout);
  renderZoneEditor();
}

async function fetchPhotos() {
  const base = await getBackendBaseUrl();
  const resp = await fetch(`${base}/photos`);
  return resp.json();
}

function createPhotoCell(photo, base) {
  const div = document.createElement("div");
  div.className = "card photo-cell";
  div.id = `photo-${photo.id}`;

  const handle = document.createElement("div");
  handle.className = "widget-drag-handle";
  handle.title = "Drag to reorder";
  handle.textContent = "⠿";

  const img = document.createElement("img");
  img.src = `${base}/photos/${photo.id}/file`;
  img.alt = "";
  img.draggable = false;

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "photo-remove-btn";
  removeBtn.title = "Remove photo";
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", () => handleRemovePhoto(photo.id));

  div.appendChild(handle);
  div.appendChild(img);
  div.appendChild(removeBtn);
  return div;
}

async function renderPhotos() {
  const base = await getBackendBaseUrl();
  const photos = await fetchPhotos();
  const container = document.getElementById("zone-container");

  for (const el of [...container.querySelectorAll(".photo-cell")]) el.remove();
  for (const photo of photos) {
    container.appendChild(createPhotoCell(photo, base));
  }
}

function pickZoneForPhoto() {
  return new Promise((resolve) => {
    const overlay = document.getElementById("zone-picker-overlay");
    const list = document.getElementById("zone-picker-list");
    const emptyMsg = document.getElementById("zone-picker-empty");
    const cancelBtn = document.getElementById("zone-picker-cancel");

    function close(result) {
      overlay.classList.add("view-hidden");
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onOverlayClick);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    function onCancel() {
      close(null);
    }
    function onOverlayClick(e) {
      if (e.target === overlay) close(null);
    }
    function onKey(e) {
      if (e.key === "Escape") close(null);
    }

    list.innerHTML = "";
    let anyOpen = false;
    zones.forEach((zone, i) => {
      const used = zoneLayout.filter((it) => it.zone_id === zone.id).length;
      const full = used >= zone.cols;
      if (!full) anyOpen = true;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "zone-picker-item";
      btn.disabled = full;

      const label = document.createElement("span");
      label.textContent = `Zone ${i + 1}`;
      const slots = document.createElement("span");
      slots.className = "zone-picker-item-slots";
      slots.textContent = `${used} of ${zone.cols} slots used`;
      btn.append(label, slots);

      if (!full) btn.addEventListener("click", () => close(zone.id));
      list.appendChild(btn);
    });
    emptyMsg.classList.toggle("view-hidden", anyOpen);

    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onOverlayClick);
    document.addEventListener("keydown", onKey);
    overlay.classList.remove("view-hidden");
  });
}

async function handleAddPhoto() {
  const path = await invoke("pick_image_file");
  if (!path) return;

  const zoneId = await pickZoneForPhoto();
  if (!zoneId) return;

  const base = await getBackendBaseUrl();
  const resp = await fetch(`${base}/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) return;
  const photo = await resp.json();

  const cardId = `photo-${photo.id}`;
  const positions = zoneLayout
    .filter((it) => it.zone_id === zoneId)
    .map((it) => it.position);
  const nextPos = positions.length ? Math.max(...positions) + 1 : 0;
  zoneLayout.push({ widget_id: cardId, zone_id: zoneId, position: nextPos, col_span: 1 });

  document.getElementById("zone-container").appendChild(createPhotoCell(photo, base));
  renderZones();
  await saveZoneLayout();
}

async function handleRemovePhoto(photoId) {
  const base = await getBackendBaseUrl();
  await fetch(`${base}/photos/${photoId}`, { method: "DELETE" });
  document.getElementById(`photo-${photoId}`)?.remove();
  renderZones();
  await saveZoneLayout();
}

function initPhotoPanels() {
  document.querySelector("#photo-add-btn").addEventListener("click", handleAddPhoto);
}

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
  }
  await invoke("disconnect_canvas");

  if (dashboardPollHandle) {
    clearInterval(dashboardPollHandle);
    dashboardPollHandle = undefined;
  }
  latestAssignments = [];
  showView("onboarding-view");
}

async function handleNameChangeSubmit(event) {
  event.preventDefault();
  const input = document.querySelector("#name-change-input");
  const status = document.querySelector("#name-change-status");
  const name = input.value.trim();
  if (!name) return;

  await invoke("save_display_name", { name });
  await setGreeting();
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 2000);
}

function initSettings() {
  document
    .querySelector("#name-change-form")
    .addEventListener("submit", handleNameChangeSubmit);
  document
    .querySelector("#connect-calendar-btn")
    .addEventListener("click", handleConnectCalendarClick);
  document
    .querySelector("#disconnect-calendar-btn")
    .addEventListener("click", handleDisconnectCalendar);
  document
    .querySelector("#disconnect-canvas-btn")
    .addEventListener("click", handleDisconnectCanvas);
  initZoneSettingsUI();
}

async function refreshSettings() {
  const domain = await invoke("stored_domain");
  document.querySelector("#settings-domain").textContent = domain || "—";
  try {
    const name = await invoke("display_name");
    if (name) document.querySelector("#name-change-input").value = name;
  } catch {}
  await refreshCalendarSettingsUI();
}

async function initDashboard() {
  startHealthMonitor();
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
  zoneLayout = defaultZoneLayout();
  renderZones();
  initWidgetMenu();
  await waitForBackend();
  await Promise.allSettled([
    refreshChecklist(),
    refreshGoals(),
    refreshBooks(),
    refreshProjects(),
    refreshEvents(),
    refreshSpotifyPlaylists(),
  ]);
  try {
    await renderPhotos();
  } catch (err) {
    console.error("renderPhotos failed:", err);
  }
  try {
    await restoreZoneLayout();
  } catch (err) {
    console.error("restoreZoneLayout failed:", err);
  }
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
