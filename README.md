# FocusGuard

An AI-assisted study productivity app that combines a Pomodoro-style study timer,
study sessions, browser-based focus monitoring, detailed analytics, and a
gamified personal world that grows from the time you actually spend focused.

> **Status: Phase 10 — Focus World.**
> Everything from Phases 1–9 is still here: study sessions, the Pomodoro timer,
> the sand clock, the real-time clock, Focus Mode, fullscreen, the webcam panel,
> an **on-device face presence detector** (MediaPipe FaceLandmarker), an
> **approximate head-direction readout**, a **screen-facing attention state with
> a configurable grace period**, a **measured Focus Score, rating and Focus Coin
> ledger**, and the **Phase 9 persistence layer** (IndexedDB, an offline-first
> sync queue, Supabase accounts with Row-Level Security).
> Phase 10 adds the **Focus World**: a persistent, grid-based personal world you
> build by spending the Focus Coins your focused study time earns — a
> data-driven catalog, unlock milestones, land expansion, a world level and a
> dashboard preview, synced through the same queue.
> Cloud sync stays inert until you paste in your own Supabase URL and anon key
> (see *Configuring Supabase* below); analytics charts are **not** implemented yet.

## Planned systems

| System | Status |
| --- | --- |
| Study session + Pomodoro timer | **Done** — focus/short/long periods, auto-cycling, chime, settings |
| Study sessions | **Done** — subject, goal, elapsed/break time, pause/resume, summary, in-memory history |
| Interface (theme, sand clock, clock, Focus Mode, fullscreen) | **Done** |
| Camera monitoring | **Local preview + lifecycle done** — permission states, start/stop, privacy notes |
| Face detection (presence only) | **Done** — on-device MediaPipe FaceLandmarker, ~5 fps, nothing uploaded |
| Head direction (approximate) | **Done** — Forward / Looking Left / Right / Up / Down, from local landmarks + smoothing |
| Attention / distraction engine | **Done** — Focused / Attention drifting / Distracted / Face not detected / Detection unavailable, 5 s grace (2–15 s), one event per away episode, focused-time accounting |
| Estimated Focus Score & rating | **Done** — focused ÷ (focused + distracted + face-missing), 0–100, Excellent / Strong / Moderate / Needs Improvement |
| Focus Coins | **Done** — 1 focused minute = 1 coin, ledger, duplicate-proof, dashboard + summary; persisted |
| Productivity history & analytics | History is live **and persistent**; analytics still a placeholder |
| Local persistence (IndexedDB) | **Done** — sessions, distraction events, coin ledger, daily goals, settings, sync queue |
| Offline operation + sync queue | **Done** — every write lands locally first, then drains to the cloud in a priority order |
| Accounts (Supabase email/password) | **Done** — sign up, log in, log out, session restoration, friendly errors |
| Cloud sync (Supabase + RLS) | **Done** — architecture, SQL schema and client are wired; needs your own project URL + anon key |
| Focus World builder | **Done** — 5×5 → 7×7 → 10×10 → 15×15 grid, 16-item coin-priced catalog, move/rotate/delete, expansion |
| World progression | **Done** — unlock tiers by focused minutes (0/60/180/500) and a 5-step world level, all driven by measured focused time |
| World persistence & sync | **Done** — IndexedDB `worlds` / `worldObjects` / `worldExpansions` + the Phase 9 sync queue; purchases extend the coin ledger (`WORLD_PURCHASE`) |

## Modules

Everything lives in a small, single-purpose file. Each one owns one concern and
never reaches into another's state.

| File | Responsibility |
| --- | --- |
| `js/timer.js` | Pomodoro state machine. **No DOM.** Source of truth for all timing. |
| `js/timer-ui.js` | Timer DOM, the sand clock, the chime, settings inputs. |
| `js/session.js` | Study session state machine. **No DOM.** |
| `js/session-ui.js` | Session form, live panel, dashboard mirror, summary dialog, history. |
| `js/clock.js` | Real-world clock (hours, minutes, seconds + date). **Independent of `timer.js`.** |
| `js/camera.js` | Webcam lifecycle: permission, start, stop, release. |
| `js/faceDetection.js` | On-device face **presence** detection (MediaPipe FaceLandmarker). Follows `camera.js`, exposes raw landmark/pose samples; never uploads. |
| `js/attention.js` | Approximate **head direction** from those samples. No camera, no network, no loop of its own. |
| `js/distraction.js` | **Attention / distraction engine.** Turns presence + direction + a time-based grace period into one screen-facing state, times distraction events and accumulates focused time. No camera, no model, no rAF loop of its own. |
| `js/focusEngine.js` | **Productivity layer.** Turns the measured buckets into an estimated Focus Score, a rating, Focus Coins (with a ledger) and today's totals, and paints them into the dashboard, the live session panel and Focus Mode. Scores, never measures. |
| `js/supabase.js` | **The only Supabase-aware file.** Holds the config, lazily loads the client, and exposes a cloud adapter (`upsert`/`list`/`remove`) plus an auth backend (`getSession`/`signIn`/`signUp`/`signOut`). Nothing else imports Supabase. |
| `js/localStore.js` | **Local persistence.** Promise-based IndexedDB wrapper: the database, the eleven stores, per-user namespacing, an in-memory fallback and a privacy audit. |
| `js/auth.js` | **Accounts.** Email/password sign up, log in, log out, session restore and friendly error messages. Owns the account modal and header chip. Stores no passwords. |
| `js/sync.js` | **Persistence coordinator.** Writes records, queues and drains cloud writes, merges remote data, hydrates the engine, restores an interrupted session, and persists settings, the daily goal and the Focus World. |
| `js/worldCatalog.js` | **Focus World catalog.** Items, categories, coin costs, unlock tiers, expansion steps and world-level thresholds — all in one pure data file. |
| `js/world.js` | **World state + rules.** Grid size, placed objects, selection, purchase/move/rotate/remove/expand, statistics and level. No DOM, no storage — persistence is delegated to `sync.js`. |
| `js/worldRenderer.js` | **World visuals.** Turns world state into a CSS grid of cells (the My World stage and the small Dashboard preview). No WebGL, no canvas. |
| `js/worldUI.js` | **World controls.** Build panel, mode buttons, selection, delete confirmation and gentle feedback. |
| `app.js` | Navigation, dashboard values (delegated to the focus engine), Focus Mode, fullscreen. |

### How the pieces connect

```
timer.js ──▶ timer-ui.js ──▶ countdown, sand clock, chime, settings
   │
   └── complete event ──▶ session.js (counts Pomodoros + break time)

session.js ──▶ session-ui.js ──▶ form, live panel, dashboard, summary, history
                  │
                  └── change/end ──▶ camera.js (monitoring-available note,
                                             release the webcam on session end)

clock.js    ──▶ every [data-clock-time] / [data-clock-date] element
camera.js   ──▶ every [data-camera-*] element
     │
     └── change event ──▶ faceDetection.js ──▶ FACE_PRESENT / FACE_MISSING
                                              ──▶ every [data-face-*] element
                                  │
                                  └── sample event ──▶ attention.js
                                                       FORWARD / LEFT / RIGHT /
                                                       UP / DOWN / FACE_MISSING
                                                       ──▶ every [data-head-*] element
                                                              │
                                                              └── change + 250 ms
                                                                  heartbeat ──▶ distraction.js
                                                                  FOCUSED / GRACE /
                                                                  DISTRACTED / FACE_MISSING /
                                                                  UNKNOWN
                                                                  ──▶ every [data-focus-*] element
                                                                  ──▶ measured buckets:
                                                                     focused / distracted /
                                                                     face-missing time
                                                                              │
                                                              ┌───────────────┘
                                                              ▼
                                                       focusEngine.js (1 Hz)
                                                       Focus Score + rating
                                                       Focus Coins + ledger
                                                       today's totals
                                                              │
                                    ┌─────────────────────────┼──────────────────┐
                                    ▼                         ▼                  ▼
                              dashboard                live session panel    session record
                              [data-engine]            [data-engine]          (summary + history)
                                                                                     │
                                                                                     ▼
                                                                          sync.js ─▶ localStore.js
                                                                          (queue)     IndexedDB
                                                                                     │
                                                                                     ▼
                                                                            supabase.js ─▶ cloud
                                                                        (only when signed in)

Focus World (Phase 10)
worldCatalog.js ──▶ world.js ──▶ worldRenderer.js ──▶ My World stage + Dashboard preview
                       │               ▲
                       │               └── worldUI.js (Build / Move / Rotate / Delete / Expand)
                       │
                       └── purchase ──▶ focusEngine.spend()
                                        (negative WORLD_PURCHASE ledger entry)
                                             │
                                        sync.js ──▶ localStore.js ──▶ supabase.js
```

## The study session record

`js/session.js` holds one live session and an in-memory history array. When a
session ends it is frozen into this plain object:

```js
{
  id:                "s-1a2b3c4d",
  subject:           "Linear algebra",
  goal:              "Finish chapter 4 exercises",

  startTime:         1759480200000,   // epoch ms
  endTime:           1759483800000,   // epoch ms
  totalDurationMs:   3600000,         // wall clock: end - start
  activeDurationMs:  3540000,         // total minus paused time
  pausedDurationMs:     60000,

  focusedDurationMs:     2460000,     // screen-facing time (measured)
  distractedDurationMs:   240000,     // attention elsewhere (head away)
  faceMissingDurationMs:  150000,     // face not in frame
  unclassifiedDurationMs: 300000,     // grace / detection unavailable
  distractionCount:            3,     // one event per away episode

  focusScore:                 79,     // estimated, 0-100 (null if unmeasured)
  focusRating:         'Strong',      // Excellent / Strong / Moderate / ...
  focusCoinsEarned:           41,     // 1 focused minute = 1 coin
  measured:                 true,     // was anything measurable?

  breakDurationMs:   900000,          // time the timer spent in breaks
  pomodorosCompleted: 3,

  status:            "completed",     // or "endedEarly" (no Pomodoro finished)
  createdAt:         1759480200000,
}
```

Every measured second belongs to exactly one of the four duration fields, so
they never overlap and can never double-count. They stay `null` (and the score
stays `null`) when nothing was measurable — the history table and the summary
show a dash instead of a fake zero. The session neither measures nor scores
anything itself: `js/distraction.js` owns the timing and `js/focusEngine.js`
owns the score, the rating and the coins.

## The sand clock

`js/timer-ui.js` injects the hourglass markup into every `[data-hourglass-slot]`
and re-renders it from the Pomodoro snapshot — there is **no second timer**.

| Timer phase | Hourglass |
| --- | --- |
| `running` | `is-running` — sand falls, `--sand-top` shrinks, `--sand-bottom` grows |
| `paused` | `is-paused` — the falling stream stops, fill freezes |
| `reset` / idle | fill returns to 100% top / 0% bottom |
| period finished | `is-done` for ~0.9s — every grain lands, then the next period loads |

```css
--sand-top:    /* percentage of the upper chamber still full */
--sand-bottom: /* percentage of the lower chamber filled   */
```

## Focus Mode and fullscreen

Focus Mode (`[data-focus-mode]`) is a distraction-minimised overlay containing
the countdown, sand clock, subject, goal, focus status, camera panel, real-time
clock, pause/resume and end-session controls.

It reuses the same `data-timer-*` and `data-session-*` attributes as the
dashboard, so it stays in sync automatically — no duplicate state.

Fullscreen uses the browser **Fullscreen API** (`requestFullscreen()` /
`exitFullscreen()`), never a CSS imitation. Entering fullscreen opens Focus Mode;
leaving fullscreen restores the normal dashboard.

## Camera monitoring — privacy

`js/camera.js` calls `getUserMedia()` and attaches the resulting `MediaStream`
to `<video>` elements. That is all it does.

- **Camera processing happens locally in your browser.**
- **Webcam frames are not uploaded.** No frame, crop or detection result is ever
  sent anywhere. The only network requests in the whole project are the one-time
  downloads of the face-detection library and its model file (see below).

States: `off`, `starting`, `active`, `denied`, `error`. Permission denials and
missing devices are reported in the panel instead of throwing. `stop()` stops
every track and clears `srcObject`; the webcam is also released on `pagehide`,
on `beforeunload`, and when a study session ends.

## Face landmarks — presence and head direction

`js/faceDetection.js` answers one question, locally: **is a face in frame?**
It also hands the raw landmark and head-pose numbers to `js/attention.js`,
which answers a second one: **roughly which way is the head turned?**

| Piece | Choice |
| --- | --- |
| Model | MediaPipe Tasks Vision **FaceLandmarker** (BlazeFace short-range detector + 478-point face landmarks, ~3.8 MB) |
| Library | `@mediapipe/tasks-vision` (pinned version, loaded once) |
| Where it runs | This browser tab only — WebAssembly + WebGL |
| Rate | ~5 detections/second (`DETECT_INTERVAL_MS = 200`), one `requestAnimationFrame` loop |
| Thresholds | `minFaceDetectionConfidence: 0.5`, `minFacePresenceConfidence: 0.5`, `minTrackingConfidence: 0.5`, `numFaces: 1` |
| Extra output | `outputFacialTransformationMatrixes: true` — the 4x4 head-pose matrix attention.js reads |

```
camera.js ──▶ <video data-camera-video> ──▶ faceDetection.js ──▶ face state
 getUserMedia      MediaStream                ~5 Hz, local      FACE_PRESENT
                                              + landmarks /     FACE_MISSING
                                                pose matrix
                                                        │
                                                        └──▶ attention.js
                                                             FORWARD · LEFT ·
                                                             RIGHT · UP · DOWN
                                                             · FACE_MISSING
```

| Status | Meaning |
| --- | --- |
| `● Camera Off` | No camera, so nothing can be detected |
| `● Camera Starting` | Permission prompt / stream opening |
| `● Camera Active` | Camera live, detection layer not engaged |
| `● Detection Loading` | Model downloading / initialising |
| `● Detecting Face` | Loop running, no verdict yet |
| `● Face Detected` | A face is in frame |
| `● Face Not Detected` | No face in frame |
| `● Detection Error` | Model or processing failed — the app keeps working |

The smaller line under it shows the model state: `Loading face detection…` →
`Face detection ready`, or `Face detection unavailable` on failure.

Lifecycle rules:

- Starting the camera loads the model **once**, then starts exactly **one** loop.
- Stopping the camera — or ending a study session — stops the loop, resets the
  verdict and releases the webcam. The loaded model stays warm, so starting again
  never re-downloads or re-initialises it and never creates a second loop.
- Frames are read from whichever `[data-camera-video]` is visible, so detection
  keeps working in Focus Mode and fullscreen.
- Two agreeing frames are required for "detected" and three for "not detected".
  That only removes flicker; it is not an attention rule and it never gates the
  Pomodoro timer or the session.
- If the model cannot load, the panel shows `Detection Error` and everything else
  (timer, sessions, clock, camera preview) continues normally.
- `attention.js` does not run a second loop and never touches the camera or the
  network: it only transforms the samples it is handed. `distraction.js` follows
  the same rule — it reads the latest state of the modules above it and adds a
  250 ms heartbeat for time-based transitions, nothing more.

Console: `FocusGuard.faceDetection.getState()` / `.getSample()` / `.start()` /
`.stop()` / `.detect(video)` / `.on('change', fn)` / `.on('sample', fn)`.

## Head direction — approximate

A small row under the face indicator shows the estimate:

| State | Meaning |
| --- | --- |
| `Forward` | The head is within a few degrees of facing the screen |
| `Looking Left` / `Looking Right` | The head is turned past the turn threshold |
| `Looking Up` / `Looking Down` | The head is pitched past the turn threshold |
| `Face Missing` | No face in frame, so no direction can be reported |
| `Unknown` | Camera off, model loading, or no usable reading yet |

How the estimate is made (all local):

1. The model's facial transformation matrix gives the direction the face is
   pointing (`yaw` = horizontal, `pitch` = vertical). If the matrix is missing,
   a coarser landmark-ratio fallback (nose position relative to the eyes and the
   face oval) is used instead.
2. Both angles are smoothed with a rolling **median over 5 samples** (~1 s at
   the 5 Hz rate).
3. A direction is only reported when it clears the turn thresholds
   (`yaw 16°`, `pitch 20°`); coming back to `Forward` needs `yaw 10° / pitch 14°`.
   The gap is a dead zone that keeps the previous reading, and a change needs
   **3 consecutive agreeing samples** before the row moves.

The pitch zone is deliberately roomier than the yaw zone: webcam geometry can
give a perfectly forward-facing head a natural downward pitch bias (up to a
two-digit negative angle on reference photos), and that must not read as
`Looking Down`.

Measured behaviour: an obvious turn shows up in about a second, small natural
movements (a few degrees) never flicker the row, and no direction ever changes
the timer, pauses a session or raises a warning.

Console: `FocusGuard.attention.getState()` / `.getPose()`.

## Focus status — screen-facing attention

A second row under the head direction turns the camera signals into one calm
verdict. It reports whether the user is **facing the study screen**, never
whether they are concentrating.

| State | Row shows | Meaning |
| --- | --- | --- |
| `FOCUSED` | ● Focused | Face detected, head forward, and stable for ~1.2 s |
| `GRACE` | ● Attention drifting / "Returning to screen…" | Was focused, looked away, grace period not over |
| `DISTRACTED` | ● Distracted / "Attention has been away for 7s" | Away longer than the grace period |
| `FACE_MISSING` | ● Face not detected | No face in frame (already debounced by the detector) |
| `UNKNOWN` | ● Detection unavailable | Camera off, model loading/failed, no usable reading |

The grace period (default **5 s**, settable **2–15 s** in *Settings → Focus
defaults*) exists so small, human movements do not count as distraction:

```
FOCUSED ──▶ GRACE ──(grace expires)──▶ DISTRACTED
   ▲          │                            │
   └──────────┴────── looking forward ─────┘
```

Rules:

- One **distraction event per away episode**, created when `GRACE` becomes
  `DISTRACTED` and closed when the user is focused again. Metadata only, held in
  memory: `{ id, startTime, endTime, duration, reason }` with `reason` being
  `HEAD_AWAY` or `FACE_MISSING`. No frame, image or landmark is ever stored.
- A long face-absence opens the same kind of event, but only **after** the grace
  period — a single missed detection never counts.
- Focused time is accumulated by entering/leaving `FOCUSED`. It feeds the session
  record, so the summary and history finally show a real *Focused time*.
- **Monitoring is not tracking:** camera on without a study session only updates
  this status row — no records are created. Records require an active session.
- **The Pomodoro is untouched.** This module has no reference to `timer.js`: it
  can never pause, reset, skip or end a period, and it never ends a session.
- The engine runs on the detector's own samples plus a light 250 ms heartbeat —
  no second camera stream, no second detector, no second `requestAnimationFrame`
  loop. Every duration comes from timestamps.
- Camera stop, session end and page hide all reset it; ending a session while
  distracted closes the open event with the current timestamp. Listeners and the
  heartbeat are never duplicated by starting the camera again.

The wording stays honest on purpose: FocusGuard reports **"Face Detected"**,
**"Face Not Detected"**, an approximate head direction and a screen-facing
attention state — never "AI knows you are focused". A turned head is not proof
of anything, and the interface says so.

Console: `FocusGuard.distraction.getState()` / `.getSessionData()` /
`.getEvents()` / `.getLastSessionData()` / `.setGracePeriod(s)` /
`.on('change'|'event', fn)` / `.reset()`.

## Productivity layer — estimated score, rating and Focus Coins

`js/focusEngine.js` is the only module that scores anything. It reads the
measured buckets from `distraction.js`, adds scoring and rewards, and paints
them into the dashboard, the live session panel, Focus Mode and the session
summary about once a second (never per animation frame).

**What counts as focused time.** A second is filed as *focused* only when all of
this is true: the attention state is `FOCUSED`, a study session is running (not
paused), the Pomodoro is not paused and not on a break, and the tab is visible.
Everything else measures nothing at all:

| Attention state | Filed as |
| --- | --- |
| `FOCUSED` | focused time |
| `DISTRACTED` | distracted time (the same seconds as the distraction events) |
| `FACE_MISSING` | face-missing time (kept separate from head-away time) |
| `GRACE` / `UNKNOWN` | unclassified time (never counted as focused) |

**Estimated Focus Score (0–100).**

```
score = focused / (focused + distracted + faceMissing) × 100
```

Rounded, clamped to 0–100, and `null` (shown as “—”) when there is nothing
measurable yet — never NaN, never Infinity, never negative. Unclassified time is
deliberately left out of the denominator: it is neither positive nor negative
evidence.

| Score | Rating |
| --- | --- |
| 90–100 | Excellent |
| 75–89 | Strong |
| 60–74 | Moderate |
| below 60 | Needs Improvement |

**Focus Coins.** The rule is fixed and not configurable: **1 focused minute =
1 Focus Coin**. Coins come from measured focused time only — never from the
Pomodoro merely running, and never during breaks, pauses, distraction or
face-missing time.

```
earnedCoins = floor(lifetimeFocusedSeconds / 60)
newCoins    = earnedCoins - alreadyAwardedCoins     // never negative
```

Only the difference is ever awarded, so the dashboard can refresh as often as it
likes without paying the same minute twice, and fractional seconds are kept so
no focused time is lost. Every award is written to an in-memory ledger:

```js
{ id, type: 'FOCUSED_TIME', amount, timestamp, sessionId, focusedSeconds, rule }
```

> **Focus Coins are persistent as of Phase 9.** Every award is written to
> IndexedDB as it happens, so the ledger and the lifetime total survive a
> reload. Nothing is uploaded unless you sign in — and even then only the coin
> *entry* (session id, amount, timestamp) is sent, never anything derived from
> the camera. See *Persistence, accounts and cloud sync* below.

Console: `FocusGuard.focusEngine.getState()` / `.getToday()` / `.getLedger()` /
`.getLastSession()` / `.getSessionSnapshot()` / `.peekSession()` /
`.on('change'|'coin', fn)`.

## Persistence, accounts and cloud sync (Phase 9)

FocusGuard is still a static site with no build step and no backend of its own.
Persistence is layered so the app is fully usable before you ever create an
account:

```
camera ─▶ face detection ─▶ landmarks ─▶ head direction ─▶ attention engine
                                                              │
                                                      focus engine
                                                              │
                                                       study session
                                                              │
                          IndexedDB (local, written first — always)
                                                              │
                                                          sync queue
                                                              │
                                        Supabase (only when signed in)
```

A study session is written to IndexedDB the moment it ends, and the coin ledger
is written one entry at a time as coins are earned. Syncing to the cloud is a
*second* step: a queue drains it in the background. If that fails, the data is
still safely on the device and the chip reads `Offline` or `Error`.

### The four new modules

| File | Responsibility |
| --- | --- |
| `js/supabase.js` | The only file that knows Supabase exists. Holds the config, lazily loads the client, and exposes two small seams — a **cloud adapter** (`upsert` / `list` / `remove`) and an **auth backend** (`getSession` / `signIn` / `signUp` / `signOut`). Everything else talks to those seams, which is why the whole layer can be tested against a fake. |
| `js/localStore.js` | A thin, promise-based wrapper over IndexedDB. Owns the database, the stores, per-user namespacing, the in-memory fallback and the privacy audit. |
| `js/auth.js` | Email/password accounts: sign up, log in, log out, restore an existing session on load, and turn Supabase's errors into plain English. Owns the account modal and header chip. |
| `js/sync.js` | The persistence coordinator: records, queue, flush order, merge, hydration, session recovery, status chip and toasts. |

### IndexedDB structure

One database (`focusguard`, version 1) with eight object stores. Every
user-owned row carries a `userId` field and a `byUser` index; IndexedDB has no
folders, so **namespacing is a field plus an index that every read filters on**.
The signed-out namespace is the literal string `local`.

| Store | Key | Indexes | Holds |
| --- | --- | --- | --- |
| `sessions` | `id` | `byUser`, `byUserStart` | study session records |
| `distractionEvents` | `id` | `byUser`, `bySession` | one row per away episode |
| `coinLedger` | `id` | `byUser`, `bySession` | one row per coin award |
| `dailyGoals` | `id` | `byUser`, `byUserDate` | target + derived completed minutes |
| `settings` | `userId` | — | timer durations, sound, grace period, goal |
| `syncQueue` | `id` | `byUser`, `byUserStatus` | pending cloud writes |
| `profiles` | `userId` | — | email + timestamps (no other personal data) |
| `meta` | `key` | — | bookkeeping, e.g. the in-progress session snapshot |

If IndexedDB is missing or blocked (private window, storage disabled), the same
API runs against an in-memory map and `describe()` reports
`backend: "memory"` — the app keeps working, it just does not save.

### The sync queue

Cloud writes never happen inline; they become queue rows:

```js
{ id: 'q-<entity>-<entityId>-<op>', userId, entityType, entityId,
  operation, table, payload, createdAt, retryCount, status: 'PENDING' }
```

`flush()` walks the queue in a fixed priority order, so a coin can never reach
the cloud before the session it belongs to:

```
profiles ─▶ sessions ─▶ distractionEvents ─▶ coinLedger ─▶ dailyGoals ─▶ settings
```

It stops at the first failure (so ordering is preserved), marks that row `ERROR`
with an incremented `retryCount`, and retries every 30 seconds, on `online`, and
when the tab becomes visible again. **While a study session is running, `flush()`
short-circuits**: writes still land locally, and the cloud catches up when the
session ends. A 900 ms debounce coalesces bursts of writes.

### Offline behaviour

There is no "offline mode" to switch on — offline *is* the default. Every write
is local first and always succeeds; sync is opportunistic. The chip in the
header (and the *Account & cloud sync* card in Settings) always shows exactly
one of:

| Chip | Meaning |
| --- | --- |
| `Local` | Signed out. Everything works; nothing is queued for upload. |
| `Syncing` | A flush is in flight. |
| `Synced` | Queue empty and the last flush succeeded. |
| `Offline` | The browser reports no network. Data is safe on the device. |
| `Error` | A flush failed. Rows stay queued and retry automatically. |
| `Unavailable` | Supabase is not configured (placeholder config). |

### How duplicates are prevented

Every cloud write is an **upsert on a deterministic key**, so replaying the same
write twice can only ever produce one row:

| Table | Conflict key | Why it is stable |
| --- | --- | --- |
| `study_sessions` | `id` | the session's own id (`s-…`), generated once when the session starts |
| `distraction_events` | `id` | `de-<sessionId>-<n>` — the nth away episode of that session |
| `coin_ledger` | `id` | `cl-<sessionId>-<focusedSeconds>` — the focused-minute mark that paid the coin |
| `daily_goals` | `id` | `<userId>:<YYYY-MM-DD>` — one goal per user per day |
| `user_settings` | `user_id` | primary key |
| `profiles` | `user_id` | primary key |

Because a coin's id is derived from *what the coin is for* rather than *when it
was sent*, re-sending the same award is a no-op. Combined with the ledger, which
awards only the **difference** between coins earned and coins already awarded, a
focused minute can be paid exactly once — locally and in the cloud.

### How multi-user isolation works

Three independent layers agree on the same rule, the authenticated Supabase user
id:

1. **Locally**, every read filters on the `byUser` index with the current
   namespace (`local` when signed out).
2. **At the client seam**, `cloud.list(table, userId)` filters, and the adapter
   refuses to overwrite a row owned by a different user.
3. **On the server**, every table has Row Level Security enabled with
   `using (auth.uid() = user_id) with check (auth.uid() = user_id)`, so a request
   for someone else's rows returns nothing even if the client asked for it.

Signing out switches the namespace back to `local` and leaves the previous
user's rows untouched. Signing in hydrates the app from that user's local rows
and then merges the cloud copy — *last-updated wins*, and a newer unsynced local
edit is never overwritten.

### Privacy

The persistence layer stores **derived numbers only**: timings, counts, scores,
ratings and coin amounts. It never stores a frame, an image, a video, a
landmark, a mesh, a canvas or a data URL, and there is no column for any of
them. `js/localStore.js` ships an audit that proves it:

```js
const report = await FocusGuard.localStore.describe();
// { available: true, backend: 'indexeddb', userId: 'local',
//   forbiddenKeys: [], clean: true }
```

`forbiddenKeys` lists stored keys matching `frame`, `image`, `photo`, `video`,
`webcam`, `landmark`, `mesh`, `blob`, `dataurl`, `base64`, `canvas` or
`password`. It must stay empty. Passwords are handled by Supabase Auth and are
never written to IndexedDB or `localStorage`.

### Configuring Supabase (required before cloud sync works)

Cloud sync is **architecturally complete but inert until you supply your own
project**. Out of the box the config holds documented placeholders,
`isConfigured()` returns `false`, the chip reads `Local`, and the app runs
exactly as it did in Phase 8 — no request is ever made to Supabase.

**1. Create the project and the database**

1. Create a project at <https://supabase.com>.
2. Open **SQL Editor**, paste `supabase/schema.sql`, and run it. This creates the
   six tables, their indexes, all Row Level Security policies and the grants.
   It is idempotent — running it twice is safe, and it never drops a table.
3. In **Table Editor → any table → RLS**, confirm Row Level Security is enabled.

**2. Enable email/password auth**

4. **Authentication → Providers → Email**: enable Email/Password. If you would
   rather not confirm addresses while developing, turn *Confirm email* off;
   `auth.js` handles both flows and explains the confirmation step in the modal.
5. **Authentication → URL Configuration**: add the URL you serve FocusGuard
   from (for example `http://localhost:5173`) to the allowed redirect URLs.

**3. Put the public config in the frontend**

6. **Project Settings → API**: copy the **Project URL** and the **anon public**
   key.
7. Paste them into the `CONFIG` block at the top of `js/supabase.js`:

```js
var CONFIG = {
  SUPABASE_URL: 'https://your-project.supabase.co',
  SUPABASE_ANON_KEY: 'your-anon-public-key',
};
```

   You can also override them without editing the file — handy for a quick
   local test — by setting either of these *before* the scripts run:

```html
<script>window.FOCUSGUARD_SUPABASE = { url: '…', anonKey: '…' };</script>
<script>
  localStorage.setItem('focusguard.supabase.url', '…');
  localStorage.setItem('focusguard.supabase.anonKey', '…');
</script>
```

> **Never put the `service_role` key in the frontend.** It bypasses Row Level
> Security entirely. The browser only ever needs the **anon public** key, which
> is safe to ship *because* every table is protected by RLS.

With the placeholders in place the app is fully usable and nothing is uploaded.
Once real credentials are added, the chip moves through `Syncing` → `Synced`,
and the same account on a second device pulls the same sessions and coins down.

### Console helpers

```js
FocusGuard.localStore.describe();       // privacy audit + backend in use
FocusGuard.localStore.stats();          // row counts per store
FocusGuard.sync.getState();             // status, namespace, pending, last sync
FocusGuard.sync.pendingCount();         // queued cloud writes
FocusGuard.sync.flush();                // force a drain now
FocusGuard.sync.loadRows('sessions');   // read rows for the current namespace
FocusGuard.auth.getState();             // signed-in status, email, availability
FocusGuard.cloud.isConfigured();        // have real credentials been supplied?
FocusGuard.cloud.instructions();        // the setup steps, from inside the app
```

## Focus World (Phase 10)

Study → focus → focused time → Focus Coins → build your world. The Focus World
is the visual reward for the time you actually spend focused. It is deliberately
calm: no animation loop, no WebGL, no canvas — a CSS grid with one glyph per
object, drawn only when the world changes.

```
focused minute   →  +1 Focus Coin        (the rule is unchanged)
buy an object    →  −cost Focus Coins     (a WORLD_PURCHASE ledger entry)
build your world →  it grows as you study
```

### The four modules

| File | Responsibility |
| --- | --- |
| `js/worldCatalog.js` | All data: 16 items with category, cost, tier and rotation; four unlock tiers; three expansion steps; five world levels. Prices live here only. |
| `js/world.js` | State and rules: grid size, placed objects, the selection, purchase / move / rotate / remove / expand, statistics and level. |
| `js/worldRenderer.js` | Paints the world as a CSS grid — the interactive My World stage and the read-only Dashboard preview share one renderer. |
| `js/worldUI.js` | The controls: Build panel, Move, Rotate, Delete, Expand, selection panel, delete confirmation and short feedback lines. |

`world.js` never touches IndexedDB or Supabase itself: it hands rows to
`js/sync.js`, which already owns the local store and the cloud queue.

### Starting state

A new world is a mostly empty **5 × 5** meadow (25 cells) — small enough to feel
like your own, with room to grow. The Dashboard "My World" card and the My World
page read the same state; there is no second world.

### The catalog

Costs are starting values, centralised in `js/worldCatalog.js`.

| Category | Item | Cost | Unlock |
| --- | --- | --- | --- |
| Nature | Grass | 2 | Basic (0 min) |
| Nature | Flower | 3 | Basic (0 min) |
| Nature | Rock | 5 | Basic (0 min) |
| Nature | Mushroom | 5 | Basic (0 min) |
| Nature | Bush | 8 | Basic (0 min) |
| Nature | Small Tree | 15 | Basic (0 min) |
| Nature | Large Tree | 25 | Intermediate (60 min) |
| Terrain | Hill | 30 | Intermediate (60 min) |
| Terrain | Small Mountain | 50 | Advanced (180 min) |
| Terrain | Large Mountain | 120 | Advanced (180 min) |
| Water | Pond | 60 | Intermediate (60 min) |
| Water | Lake | 100 | Advanced (180 min) |
| Structures | Path | 3 | Basic (0 min) |
| Structures | Campfire | 35 | Intermediate (60 min) |
| Structures | Bridge | 40 | Intermediate (60 min) |
| Structures | Small Cabin | 100 | Advanced (180 min) |

Unlock tiers use **focused study minutes only**: Basic 0 · Intermediate 60 ·
Advanced 180 · Master 500. Break time and distracted time never count.

### Land expansion

| Step | Cost |
| --- | --- |
| 5 × 5 → 7 × 7 | 100 |
| 7 × 7 → 10 × 10 | 250 |
| 10 × 10 → 15 × 15 | 500 |

Expansion only ever adds land: every existing object keeps its exact
coordinates.

### World level

Focused-minute thresholds: **L1 0–59 · L2 60–179 · L3 180–499 · L4 500–999 ·
L5 1000+**.

### How purchases touch the coin ledger

The ledger stays the single source of truth. `js/world.js` keeps no balance of
its own — it asks the engine, where `available = earned − spent`.

- A purchase calls `focusEngine.spend(cost, { purchaseId })`, which appends a
  **negative** `WORLD_PURCHASE` entry (e.g. `−15`). `FOCUSED_TIME` entries are
  never modified.
- `availableCoins` is `totalCoinsEarned − totalCoinsSpent`, clamped at zero. A
  purchase that would go below zero is refused and **no ledger entry is created**.
- The dashboard "Focus Coins" figure is this available balance; lifetime earned
  and spent totals sit next to it, so the two can never be confused.

**Idempotency.** Every purchase carries a stable `purchaseId` (derived from the
object it creates, or an expansion's target size). `focusEngine.spend` returns
the existing entry instead of charging again when it sees the same id, and the
sync queue upserts by id — so a refresh, a double click or a retried flush can
never charge twice.

### Collision, rotation and deletion

- **One primary object per cell.** Placing onto an occupied cell is refused with
  a visible message — never a silent overwrite.
- **Rotation** cycles 0° → 90° → 180° → 270° and persists. Only items marked
  `rotatable` (Path, Bridge, Small Cabin) can turn.
- **Deletion does not refund coins.** It removes the object after a confirmation
  ("Remove this object?") and soft-deletes the row (`deleted: true`) so the
  removal syncs like any other update.

### Persistence and sync

| Layer | Where |
| --- | --- |
| IndexedDB | `worlds`, `worldObjects`, `worldExpansions` (per-user, same `userId` / `byUser` namespacing) |
| Cloud | `worlds`, `world_objects`, `world_expansions` (RLS: `auth.uid() = user_id`) |
| Sync | the same Phase 9 queue; priorities put `worlds` before `worldObjects` before `worldExpansions` |

Objects merge individually, so two devices building different objects both keep
them. For the **same** object the newest `updated_at` wins (last-write-wins) —
deterministic, documented, no CRDT machinery.

### Offline building

Building works fully offline: the object and its `WORLD_PURCHASE` entry are
written to IndexedDB and queued, the balance updates immediately, and the queue
drains (without ever charging twice) when the connection returns.

### Console helpers

```js
FocusGuard.world.getState();        // grid size + placed objects
FocusGuard.world.stats();           // level, land, counts, coins earned/spent/available
FocusGuard.world.catalogView();     // the Build panel data (unlocked + affordable)
FocusGuard.worldCatalog.items();    // every item with its cost and unlock tier
FocusGuard.world.availableCoins();  // spendable balance, straight from the ledger
FocusGuard.sync.loadRows('worldObjects');
```

### Not included (on purpose)

Deleting a whole world, a user-facing reset, weather/day-night, biomes beyond
Meadow, animals, achievements, streaks, social and multiplayer worlds. The
catalog, the biome field and the level list are shaped so these can be added
later without a rewrite — but none of them ship in this phase.

## Intentionally not implemented yet

- Analytics charts, streaks, leaderboards, social features
- World extras: more biomes, weather, day/night, animals, achievements, seasonal
  events, multiplayer (the world model leaves room for them)
- Webcam uploads, external AI APIs (and they will not be added)
- Any camera-derived data in the cloud: only timings, scores and coin entries
  ever leave the device

## Project structure

```
FocusGuard/
├── index.html            # App shell: sidebar, views, Focus Mode, summary dialog
├── style.css             # Red/black dark theme, layout, components
├── app.js                # Navigation, Focus Mode, fullscreen, dashboard wiring
├── js/
│   ├── timer.js          # Pomodoro state machine (no DOM)
│   ├── timer-ui.js       # Timer DOM, sand clock, chime, settings
│   ├── session.js        # Study session state machine (no DOM)
│   ├── session-ui.js     # Session DOM, dashboard mirror, summary, history
│   ├── clock.js          # Real-world clock (independent of timer.js)
│   ├── camera.js         # Webcam lifecycle (local only)
│   ├── faceDetection.js  # On-device face presence + landmarks (MediaPipe)
│   ├── attention.js      # Approximate head direction from those landmarks
│   ├── distraction.js    # Screen-facing attention state, grace, focus timing
│   ├── focusEngine.js    # Focus score, rating, Focus Coins, daily totals
│   ├── supabase.js       # The only Supabase-aware file: config, client, adapters
│   ├── localStore.js     # IndexedDB wrapper (local persistence + offline layer)
│   ├── auth.js           # Email/password accounts, session restore, auth modal
│   ├── sync.js           # Persistence coordinator: queue, sync, merge, recovery
│   ├── worldCatalog.js   # Focus World catalog: items, costs, unlocks, expansions
│   ├── world.js          # Focus World state + operations (no DOM, no storage)
│   ├── worldRenderer.js  # World visuals: My World stage + dashboard preview
│   └── worldUI.js        # World controls: build panel, mode buttons, dialogs
├── supabase/
│   └── schema.sql        # 9 tables (incl. worlds/world_objects/world_expansions) + RLS
├── assets/
│   ├── images/           # Reserved for artwork
│   ├── icons/            # Reserved for icons
│   └── sounds/           # Reserved for sounds (unused: chime is synthesised)
└── README.md
```

## Running it locally

There is no build step and no dependencies.

**Option A — just open the file**

Double-click `index.html`.

**Option B — serve it locally (recommended)**

Camera access requires a secure context, so `http://localhost` (or
`http://127.0.0.1`) is needed — `file://` will not work for the webcam.

```bash
# Node
npx serve .

# or Python 3
python -m http.server 5173
```

Then visit <http://localhost:5173>.

## Design notes

- **Palette:** near-black backgrounds (`#0a0608` / `#1c0e10`), deep red
  surfaces and accents (`#e5484d` / `#ff8f94`), light grey text (`#f3ecec`),
  with a subtle red glow on active states. Amber (`#e0b46a`) is reserved for
  warnings, so colour carries meaning.
- **Interface:** rounded dark cards, generous spacing, one clear focal point per
  screen. No gratuitous gradients or animation.
- **Visual identity:** the logo, "world" preview and all decorative shapes are
  original CSS artwork. No third-party app assets are used.
- **Accessibility:** keyboard-focus states, ARIA roles on interactive parts, and
  support for `prefers-reduced-motion`.

## How to extend it

Keep new features in small, focused files under `js/` and load them from
`index.html`. `window.FocusGuard` is **merged** rather than replaced, so a new
module can add its own key (`FocusGuard.timer`, `.session`, `.camera`, …)
without touching the foundation.

To add UI for a new timer-driven or session-driven element, you rarely need new
JavaScript: put a `data-timer-*`, `data-session-*` or `data-face-*` attribute the element and the matching controller will keep it in sync.

## Known browser limitations

- **Autoplay policy.** Browsers block audio until the user interacts with the
  page, so the chime only works after the first click or keypress.
- **Background tabs.** Chrome, Firefox and Safari throttle timers in hidden
  tabs. The countdown is computed from a wall-clock end time, so returning to
  the tab shows the correct remaining time; only the exact moment of the chime
  may shift slightly.
- **Fullscreen.** `requestFullscreen()` must be called from a user gesture, and
  some embedded webviews disable it entirely. It fails quietly and the button
  simply stays in its "Enter full screen" state.
- **Camera.** `getUserMedia()` requires `http://localhost`/`https://` (a secure
  context). If no camera exists, or permission is denied, the panel reports it
  and the app keeps working.
- **Face detection needs its model.** The library and the model file (~370 KB in
  total) are fetched once, the first time the camera starts, then served from the
  browser cache. If that download fails (offline, CDN blocked), the panel shows
  `Detection Error` with `Face detection unavailable` and nothing else breaks.
- **Embedded webviews.** Where the permission prompt never resolves, the camera
  panel stays in `Camera Starting`. Face detection was verified in such an
  environment using a synthetic `canvas.captureStream()` video, which reaches the
  detector as an ordinary `MediaStream`.
- **Silent chime.** Some browsers expose no `AudioContext`. The sound is skipped
  quietly and the timer still runs.
- **Persistence is per browser profile and origin.** Data lives in IndexedDB
  for the origin you are using, so `http://localhost:5173` and
  `http://127.0.0.1:5188` are different databases. Private/incognito windows
  discard it when they close.
- **IndexedDB can be unavailable.** When storage is blocked, `describe()`
  reports `backend: "memory"` and the app keeps running without saving. Nothing
  else breaks.
- **Cloud sync needs credentials.** With the placeholder config FocusGuard runs
  fully offline and the chip reads `Local`. Add your own Supabase URL and anon
  key (see *Configuring Supabase*) to turn it on.
