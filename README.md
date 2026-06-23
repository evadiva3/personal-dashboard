# canvas-hub

A local, always-on desktop hub that aggregates personal data sources into one dashboard: Canvas assignments, a daily checklist, monthly goals, a reading list, active projects, notable-date countdowns, a focus timer, and photo panels — all in a bento-grid layout. The module/poller pattern is built generically so future sources can be added later as separate modules.

**Stack:** Tauri (Rust shell) + FastAPI (Python backend, spawned as a local subprocess) + SQLite + APScheduler, plain HTML/JS frontend in the webview.

## Prerequisites

- Rust (via [rustup](https://rustup.rs)) targeting `aarch64-apple-darwin`
- Xcode Command Line Tools (`xcode-select --install`)
- Node.js + npm
- A Python 3 environment with `backend/requirements.txt` installed (`fastapi`, `uvicorn`, `apscheduler`, `requests`, `beautifulsoup4`)

By default the app looks for a conda environment named `eva-workspace` at `/opt/anaconda3/envs/eva-workspace/bin/python`. **If you're cloning this for your own machine, this path won't exist for you.** Point the app at your own interpreter instead:

```sh
export CANVAS_HUB_PYTHON=/path/to/your/python   # must have backend/requirements.txt installed
```

Set this env var before running `tauri dev` or launching the built app.

## Setup

```sh
npm install
pip install -r backend/requirements.txt   # into whichever interpreter CANVAS_HUB_PYTHON points at
npm run tauri dev
```

On first launch you'll see an onboarding screen asking for:
- **Canvas domain** — e.g. `school.instructure.com` (no `https://`)
- **Personal access token** — generate one in Canvas under Account → Settings → New Access Token

The token is validated against `GET /api/v1/users/self` before anything is saved. Once validated:
- Domain + token are stored via Tauri's secure store plugin in the OS app-data directory (`~/Library/Application Support/com.canvashub.app/`) — never in this repo.
- The Python backend keeps its own operational copy in `~/Library/Application Support/canvas-hub/` (file permissions `0600`) so the scheduler can poll independently of the GUI being open.

Neither location is inside the git working tree, and neither is ever logged.

## Building

```sh
npm run tauri build
```

The backend is bundled as a resource alongside the binary, but it still requires a Python interpreter at runtime (`CANVAS_HUB_PYTHON` or the conda env above). This is a known Phase 1 limitation — fully self-contained distribution would require freezing the backend into a standalone executable, deferred to a later phase.

## Dashboard widgets

The dashboard is a CSS grid "bento" layout. Assignments + checklist + goals + projects are entirely local (no external calls beyond Canvas itself); books and photos have their own specific behavior worth knowing:

- **Assignments** — unchanged from earlier: tabs (all/upcoming/overdue), due-soon/overdue badges, a "next deadline" line up top.
- **Goals this month** — lives inside the Assignments card, below the table. Distinct from the daily checklist: goals are scoped to the current calendar month and year, so a goal added in June won't show up in July (old goals stay in the database, just filtered out of view).
- **Checklist** — the original daily to-do list, unchanged.
- **Currently reading** — paste any URL (Amazon, Goodreads, a direct image link, anything). The backend resolves a cover image by: using it directly if it's already an image, otherwise scraping the page's `og:image` meta tag, otherwise falling back to a Google Books API lookup by whatever title it can extract from the page. If all three fail, a placeholder icon is shown instead — nothing breaks.
- **Active projects** — name + status (active/paused/done) + optional URL; clicking a project with a URL opens it in your system browser.
- **Up next / Notable events** — "Up next" is still Phase 1.5's mock calendar data (live Google Calendar integration lives on a separate branch, out of scope here). "Notable events" below it are manual countdown entries you add yourself — past events fade rather than disappearing.
- **Timer** — a simple focus countdown, 1-180 minutes. Session-only: it does not persist across an app restart, by design. Fires a native notification when it reaches zero.
- **Photo panels** — right-click anywhere in the bento grid to add one via the native file picker (local images only — no URLs, no scraping). Images are copied into the OS app-data directory, never the repo. Right-click an existing photo panel to resize (cycles 1×1 → 2×1 → 1×2) or remove it. Layout position persists across restarts.

## How it works

- Tauri spawns the FastAPI backend as a localhost-only subprocess (fixed port `8742`, bound to `127.0.0.1`, CORS-restricted to the Tauri webview origin) and kills it on exit. The backend also self-terminates if it ever gets orphaned (e.g. the GUI is force-killed).
- APScheduler polls `GET /api/v1/users/self/upcoming_events` every 30 minutes by default (override with `CANVAS_POLL_INTERVAL_MINUTES`), normalizes results, and dedupes them into SQLite.
- The dashboard polls `GET /assignments` every 60 seconds and flags anything due within 48 hours.
- Newly-discovered assignments (not seen on the very first poll) trigger a native OS notification.
- A tray icon (Show/Hide/Quit) keeps the app running in the background; it auto-launches on system login.

## Project layout

```
src/            frontend (vanilla HTML/JS, runs in the Tauri webview)
src-tauri/      Rust shell: tray, autostart, secure store, backend process lifecycle,
                 native file picker (photo panels)
backend/        FastAPI app
  app/modules/canvas/   Canvas-specific client, poller, credentials cache
  app/modules/books/    cover resolution (direct image / og:image / Google Books)
  app/modules/photos/   local file storage for photo panels
  app/routers/          HTTP endpoints (one router per module, including
                         books/projects/goals/events/photos)
```

Future modules should follow the same `app/modules/<name>/` + a scheduler job pattern rather than being bolted onto the Canvas module.

## Known limitations

- Native notifications and full secure-storage behavior are only reliable from a built `.app` bundle (`npm run tauri build`), not a bare dev binary.
- No Windows/Linux support — macOS Apple Silicon only.
- Backend distribution assumes the end user has their own Python environment with `backend/requirements.txt` installed.

#this read-me was written by claude :)
