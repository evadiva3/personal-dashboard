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
    try {
      await fetch(`${base}/books`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
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

// Photo panels (local files only — no remote URLs, unlike book covers)

const PHOTO_RESIZE_CYCLE = [
  { grid_col_span: 1, grid_row_span: 1 },
  { grid_col_span: 2, grid_row_span: 1 },
  { grid_col_span: 1, grid_row_span: 2 },
];

async function fetchPhotos() {
  const base = await getBackendBaseUrl();
  const resp = await fetch(`${base}/photos`);
  return resp.json();
}

async function renderPhotos() {
  const grid = document.querySelector("#bento-grid");
  for (const old of grid.querySelectorAll(".bento-photo")) old.remove();

  const photos = await fetchPhotos();
  const base = await getBackendBaseUrl();
  for (const photo of photos) {
    const cell = document.createElement("div");
    cell.className = "card bento-photo";
    cell.dataset.photoId = photo.id;
    cell.style.gridColumn = `${photo.grid_col} / span ${photo.grid_col_span}`;
    cell.style.gridRow = `${photo.grid_row} / span ${photo.grid_row_span}`;

    const img = document.createElement("img");
    img.src = `${base}/photos/${photo.id}/file`;
    img.alt = "";
    cell.appendChild(img);

    grid.appendChild(cell);
  }
}

function nextPhotoGridPosition(existingCount) {
  // Named widgets occupy rows 1-3; photos stack 3-per-row starting at row 4.
  const row = 4 + Math.floor(existingCount / 3);
  const col = (existingCount % 3) + 1;
  return { grid_col: col, grid_row: row };
}

function hideContextMenu() {
  document.querySelector("#photo-context-menu").classList.add("view-hidden");
}

function showContextMenu(x, y, items) {
  const menu = document.querySelector("#photo-context-menu");
  menu.innerHTML = "";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.className = "context-menu-item";
    btn.type = "button";
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      hideContextMenu();
      item.onClick();
    });
    menu.appendChild(btn);
  }
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.remove("view-hidden");
}

async function handleAddPhotoPanel() {
  const path = await invoke("pick_image_file");
  if (!path) return;

  const photos = await fetchPhotos();
  const position = nextPhotoGridPosition(photos.length);
  const base = await getBackendBaseUrl();
  await fetch(`${base}/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, ...position, grid_col_span: 1, grid_row_span: 1 }),
  });
  renderPhotos();
}

async function handleRemovePhoto(photoId) {
  const base = await getBackendBaseUrl();
  await fetch(`${base}/photos/${photoId}`, { method: "DELETE" });
  renderPhotos();
}

async function handleResizePhoto(photoId, currentColSpan, currentRowSpan) {
  const currentIndex = PHOTO_RESIZE_CYCLE.findIndex(
    (s) => s.grid_col_span === currentColSpan && s.grid_row_span === currentRowSpan
  );
  const next = PHOTO_RESIZE_CYCLE[(currentIndex + 1) % PHOTO_RESIZE_CYCLE.length];

  const base = await getBackendBaseUrl();
  await fetch(`${base}/photos/${photoId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next),
  });
  renderPhotos();
}

function initPhotoPanels() {
  document.querySelector("#bento-grid").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const photoCell = e.target.closest(".bento-photo");

    if (photoCell) {
      const photoId = Number(photoCell.dataset.photoId);
      showContextMenu(e.clientX, e.clientY, [
        {
          label: "Resize",
          onClick: () => {
            // Read current span from the inline style set in renderPhotos().
            const colSpan = Number(photoCell.style.gridColumn.match(/span (\d)/)?.[1] || 1);
            const rowSpan = Number(photoCell.style.gridRow.match(/span (\d)/)?.[1] || 1);
            handleResizePhoto(photoId, colSpan, rowSpan);
          },
        },
        { label: "Remove", onClick: () => handleRemovePhoto(photoId) },
      ]);
    } else {
      showContextMenu(e.clientX, e.clientY, [
        { label: "Add photo panel", onClick: handleAddPhotoPanel },
      ]);
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#photo-context-menu")) hideContextMenu();
  });

  renderPhotos();
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
  initGoals();
  initBooks();
  initProjects();
  initEvents();
  initTimer();
  initPhotoPanels();
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
