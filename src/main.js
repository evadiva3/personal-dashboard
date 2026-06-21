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
    showView("dashboard-view");
    initDashboard();
  } finally {
    onboardingInFlight = false;
    submitBtn.disabled = false;
  }
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
  const content = document.querySelector("#next-deadline-content");
  const upcoming = latestAssignments
    .filter((a) => a.due_at && !isOverdue(a.due_at))
    .sort((a, b) => new Date(a.due_at) - new Date(b.due_at));

  if (upcoming.length === 0) {
    content.textContent = "No upcoming assignments";
    return;
  }

  const next = upcoming[0];
  content.innerHTML = "";
  content.append(next.title);
  const meta = document.createElement("span");
  meta.className = "deadline-meta";
  meta.textContent = `${next.course} — ${formatDueDate(next.due_at)}`;
  content.appendChild(meta);
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

// replace with live calendar

const MOCK_UP_NEXT = [
  { time: "Today, 2:00 PM", label: "Office hours" },
  { time: "Tomorrow, 10:00 AM", label: "Study group" },
  { time: "Fri, 9:00 AM", label: "Lecture" },
];

function renderUpNext() {
  const list = document.querySelector("#up-next-list");
  list.innerHTML = "";
  for (const item of MOCK_UP_NEXT) {
    const li = document.createElement("li");
    li.className = "up-next-item";

    const time = document.createElement("span");
    time.className = "up-next-time";
    time.textContent = item.time;

    const label = document.createElement("span");
    label.textContent = item.label;

    li.appendChild(time);
    li.appendChild(label);
    list.appendChild(li);
  }
}

// Settings

async function initSettings() {
  const domain = await invoke("stored_domain");
  document.querySelector("#settings-domain").textContent = domain || "—";
}

//Dashboard

async function initDashboard() {
  setGreeting();
  initQuote();
  initSidebarNav();
  initTabs();
  initChecklist();
  renderUpNext();
  initSettings();

  await refreshAssignments();
  if (!dashboardPollHandle) {
    dashboardPollHandle = setInterval(() => {
      refreshAssignments();
      checkForNewAssignments();
    }, DASHBOARD_POLL_MS);
  }
}

async function init() {
  document
    .querySelector("#onboarding-form")
    .addEventListener("submit", handleOnboardingSubmit);

  const hasCredentials = await invoke("has_credentials");
  if (hasCredentials) {
    showView("dashboard-view");
    initDashboard();
  } else {
    showView("onboarding-view");
  }
}

window.addEventListener("DOMContentLoaded", init);
