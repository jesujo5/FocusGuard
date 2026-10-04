# FocusGuard

An AI-assisted study productivity app that combines a Pomodoro-style study timer,
study sessions, browser-based focus monitoring, detailed analytics, and a
gamified personal world that grows from the time you actually spend focused.

> **Status: Phase 5 — local face detection.**
> Study sessions, the Pomodoro timer, the sand clock, the real-time clock,
> Focus Mode, fullscreen, the webcam panel and an **on-device face presence
> detector** are implemented.
> Head orientation, attention/distraction scoring, Focus Coins, Supabase,
> analytics and the world builder are **not** implemented yet.

## Planned systems

| System | Status |
| --- | --- |
| Study session + Pomodoro timer | **Done** — focus/short/long periods, auto-cycling, chime, settings |
| Study sessions | **Done** — subject, goal, elapsed/break time, pause/resume, summary, in-memory history |
| Interface (theme, sand clock, clock, Focus Mode, fullscreen) | **Done** |
| Camera monitoring | **Local preview + lifecycle done** — permission states, start/stop, privacy notes |
| Face detection (presence only) | **Done** — on-device MediaPipe FaceDetector, ~5 fps, nothing uploaded |
| Head orientation & attention | Not started (a later phase) |
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
| `js/faceDetection.js` | On-device face **presence** detection (MediaPipe FaceDetector). Follows `camera.js`; never uploads. |
| `app.js` | Navigation, placeholder dashboard, Focus Mode, fullscreen. |

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

  focusedDurationMs: null,            // reserved — needs camera monitoring
  breakDurationMs:   900000,          // time the timer spent in breaks
  pomodorosCompleted: 3,

  status:            "completed",     // or "endedEarly" (no Pomodoro finished)
  createdAt:         1759480200000,
}
```

`focusedDurationMs` stays `null` on purpose: face presence alone is not focused
time. It needs the attention layer (orientation + rules) from a later phase. The
field exists now so nothing has to change when it is filled in.

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

## Face detection — presence only

`js/faceDetection.js` answers exactly one question, locally: **is a face in
frame?**

| Piece | Choice |
| --- | --- |
| Model | MediaPipe Tasks Vision **FaceDetector** (BlazeFace short-range, ~230 KB) |
| Library | `@mediapipe/tasks-vision` (pinned version, loaded once) |
| Where it runs | This browser tab only — WebAssembly + WebGL |
| Rate | ~5 detections/second (`DETECT_INTERVAL_MS = 200`), one `requestAnimationFrame` loop |
| Threshold | `minDetectionConfidence: 0.5`, `numFaces: 1` |

```
camera.js ──▶ <video data-camera-video> ──▶ faceDetection.js ──▶ face state
 getUserMedia      MediaStream                ~5 Hz, local      FACE_PRESENT
                                                                FACE_MISSING
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

Console: `FocusGuard.faceDetection.getState()` / `.start()` / `.stop()` /
`.detect(video)` / `.on('change', fn)`.

### Intentionally not implemented yet

- Head orientation (left/right/up/down), attention estimation, distraction
  detection, grace periods
- Attention / focus score, focused-minutes accounting
- Focus Coins, Supabase, authentication
- World builder, analytics charts

The wording stays honest on purpose: FocusGuard reports **"Face Detected"** or
**"Face Not Detected"** — never "AI knows you are focused". Attention comes
later, when orientation data exists.

## Project structure

```
FocusGuard/
├── index.html            # App shell: sidebar, views, Focus Mode, summary dialog
├── style.css             # Dark red/black theme, layout, components
├── app.js                # Navigation, Focus Mode, fullscreen, dashboard
├── js/
│   ├── timer.js          # Pomodoro state machine (no DOM)
│   ├── timer-ui.js       # Timer DOM, sand clock, chime, settings
│   ├── session.js        # Study session state machine (no DOM)
│   ├── session-ui.js     # Session DOM, dashboard mirror, summary, history
│   ├── clock.js          # Real-world clock (independent of timer.js)
│   ├── camera.js         # Webcam lifecycle (local only)
│   └── faceDetection.js  # On-device face presence detection (MediaPipe)
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

- **Palette:** near-black backgrounds, deep red accents, light grey/white text,
  subtle red glow on active states.
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
