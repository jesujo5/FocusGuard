# FocusGuard

An AI-assisted study productivity app that combines a Pomodoro-style study timer,
study sessions, browser-based focus monitoring, detailed analytics, and a
gamified personal world that grows from the time you actually spend focused.

> **Status: Phase 8 — productivity measurement (focus score + Focus Coins).**
> Study sessions, the Pomodoro timer, the sand clock, the real-time clock,
> Focus Mode, fullscreen, the webcam panel, an **on-device face presence
> detector** (MediaPipe FaceLandmarker), an **approximate head-direction
> readout**, a **screen-facing attention state with a configurable grace
> period** and a **measured Focus Score, rating and Focus Coin ledger** are
> implemented.
> Supabase, cloud persistence, analytics charts and the world builder are
> **not** implemented yet (Focus Coins live in memory for this tab only).

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
| Focus Coins | **Done (in memory)** — 1 focused minute = 1 coin, ledger, duplicate-proof, dashboard + summary |
| Productivity history & analytics | History is live; analytics still a placeholder |
| Gamified personal world | Preview only |

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
| `js/focusEngine.js` | **Productivity layer.** Turns the measured buckets into an estimated Focus Score, a rating, Focus Coins (with an in-memory ledger) and today's totals, and paints them into the dashboard, the live session panel and Focus Mode. Scores, never measures. |
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

> **Focus Coins are currently stored only in memory and are NOT persistent.**
> They are kept for this browser tab, like the session history. Nothing is
> uploaded, and there is no cloud storage in this phase.

Console: `FocusGuard.focusEngine.getState()` / `.getToday()` / `.getLedger()` /
`.getLastSession()` / `.getSessionSnapshot()` / `.peekSession()` /
`.on('change'|'coin', fn)`.

### Intentionally not implemented yet

- Supabase, authentication, cloud persistence, cloud sync
- World builder (terrain, buildings, biomes, item shop), achievements
- Analytics charts
- Webcam uploads, external AI APIs (and they will not be added)

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
│   └── focusEngine.js    # Focus score, rating, Focus Coins, daily totals
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
- **No persistence.** Durations, Pomodoro counts, sessions and history are in
  memory only and reset on reload. Saving them is a later phase.
