# FocusGuard

An AI-assisted study productivity app that combines a Pomodoro-style study timer,
study sessions, browser-based focus monitoring, detailed analytics, and a
gamified personal world that grows from the time you actually spend focused.

> **Status: Phase 4 — interface overhaul + camera foundation.**
> Study sessions, the Pomodoro timer, the sand clock, the real-time clock,
> Focus Mode, fullscreen and a working webcam panel are implemented.
> Face detection, attention/distraction scoring, Focus Coins, Supabase,
> analytics and the world builder are **not** implemented yet.

## Planned systems

| System | Status |
| --- | --- |
| Study session + Pomodoro timer | **Done** — focus/short/long periods, auto-cycling, chime, settings |
| Study sessions | **Done** — subject, goal, elapsed/break time, pause/resume, summary, in-memory history |
| Interface (theme, sand clock, clock, Focus Mode, fullscreen) | **Done** |
| Camera monitoring | **Local preview + lifecycle done** — permission states, start/stop, privacy notes |
| Face / attention detection | Scaffold only (`js/faceDetection.js`, no detection) |
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
| `js/faceDetection.js` | Placeholder for the next phase. Returns no results. |
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

`focusedDurationMs` stays `null` on purpose: real focused time needs attention
data, which arrives with face detection. The field exists now so nothing has to
change when it is filled in.

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
- **Webcam frames are not uploaded.** There is no network code in this project.

States: `off`, `starting`, `active`, `denied`, `error`. Permission denials and
missing devices are reported in the panel instead of throwing. `stop()` stops
every track and clears `srcObject`; the webcam is also released on `pagehide`,
on `beforeunload`, and when a study session ends.

### Intentionally not implemented yet

- Face detection, head orientation, distraction detection
- Attention / focus score, focused-minutes accounting
- Focus Coins, Supabase, authentication
- World builder, analytics charts

`js/faceDetection.js` only documents the intended pipeline
(`camera.js → faceDetection.js → attention.js → distraction.js → focusEngine.js`)
and returns `null` from `detect()` — there are no fake results.

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
│   └── faceDetection.js  # Placeholder for the next phase
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
JavaScript: put a `data-timer-*` or `data-session-*` attribute on the element
and the matching controller will keep it in sync.

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
- **Silent chime.** Some browsers expose no `AudioContext`. The sound is skipped
  quietly and the timer still runs.
- **No persistence.** Durations, Pomodoro counts, sessions and history are in
  memory only and reset on reload. Saving them is a later phase.
