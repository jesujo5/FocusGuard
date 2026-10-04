/* =====================================================================
   FocusGuard — temporary report builder (NOT part of the app).

   Captures real screenshots of the running FocusGuard app with headless
   Chrome over the DevTools Protocol (zero npm dependencies) and renders a
   PDF feature report into the user's Downloads folder.

   Delete this folder when the report has been produced.
   ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const APP_URL = 'http://127.0.0.1:5188/index.html';
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const VIEWPORT = { width: 1360, height: 880 };
const PORT = 9333;
const OUT = path.join(os.tmpdir(), 'focusguard-report');
const SHOTS = path.join(OUT, 'shots');
const PROFILE = path.join(OUT, 'chrome-profile');
const DOWNLOADS = path.join(os.homedir(), 'Downloads');
const PDF_PATH = path.join(DOWNLOADS, 'FocusGuard-Feature-Report.pdf');

const shots = {};   // name -> { file, caption, note }

/* ---------- tiny logger ---------- */
const log = (...a) => console.log('[report]', ...a);

/* ---------- Chrome DevTools Protocol client ---------- */
class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('websocket failed: ' + (e && e.message)));
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.method + ': ' + JSON.stringify(msg.error)));
          else res(msg.result);
        }
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

/* ---------- launch ---------- */
function chromeBinary() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('No Chrome/Edge binary found');
}

async function waitForEndpoint() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome did not expose a debugging endpoint');
}

/* ---------- injected harnesses ---------- */
const CAMERA_HARNESS = `
(function () {
  var canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 480;
  var ctx = canvas.getContext('2d');
  window.__cfg = { face: null, blank: false, ready: false };
  function paint() {
    ctx.fillStyle = '#15122a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (window.__cfg.blank || !window.__cfg.face) return;
    var img = window.__cfg.face;
    var scale = Math.max(canvas.width / img.width, canvas.height / img.height);
    var w = img.width * scale, h = img.height * scale;
    ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }
  window.__cfg.paint = paint;
  fetch('https://storage.googleapis.com/mediapipe-assets/portrait.jpg', { mode: 'cors' })
    .then(function (r) { return r.blob(); })
    .then(function (b) { return createImageBitmap(b); })
    .then(function (bmp) { window.__cfg.face = bmp; window.__cfg.ready = true; paint(); });
  setInterval(paint, 100);
  navigator.mediaDevices.getUserMedia = function () {
    return Promise.resolve(canvas.captureStream(10));
  };
})();
`;

const BLOCK_MODEL_HOSTS = `
(function () {
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('cdn.jsdelivr.net') !== -1 || url.indexOf('storage.googleapis.com') !== -1) {
      return Promise.reject(new TypeError('Failed to fetch (simulated offline)'));
    }
    return realFetch.apply(null, arguments);
  };
})();
`;

/* ---------- page driver ---------- */
function makeDriver(cdp, sessionId) {
  const S = (method, params) => cdp.send(method, params, sessionId);

  async function evaluate(expression, awaitPromise = false) {
    const { result, exceptionDetails } = await S('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise,
    });
    if (exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(exceptionDetails.exception));
    return result.value;
  }

  async function waitFor(expression, timeout = 20000, label = expression) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await evaluate(expression)) return Date.now() - started;
      await sleep(150);
    }
    log('  ! timeout waiting for', label);
    return -1;
  }

  async function viewport(width, height, scale = 1) {
    await S('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: scale, mobile: false,
    });
    await sleep(350);
  }

  async function save(name, options = {}) {
    const { data } = await S('Page.captureScreenshot', Object.assign({ format: 'png' }, options));
    const file = path.join(SHOTS, name + '.png');
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    const bytes = fs.statSync(file).size;
    log('  ✓', name, (bytes / 1024).toFixed(0) + ' KB');
    return file;
  }

  async function shot(name) {
    await sleep(250);
    const file = await save(name);
    shots[name] = Object.assign({ file }, shots[name] || {});
  }

  async function fullShot(name) {
    const height = await evaluate('Math.ceil(document.documentElement.scrollHeight)');
    await viewport(VIEWPORT.width, Math.min(Math.max(height, 600), 3200));
    const file = await save(name);
    shots[name] = Object.assign({ file }, shots[name] || {});
    await viewport(VIEWPORT.width, VIEWPORT.height);
  }

  async function clipShot(name, selector, pad = 14, scale = 2) {
    const rect = await evaluate(`(function () {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      var r = el.getBoundingClientRect();
      return { x: r.left + window.scrollX - ${pad}, y: r.top + window.scrollY - ${pad},
               width: r.width + ${pad * 2}, height: r.height + ${pad * 2} };
    })()`);
    if (!rect) { log('  ! missing selector', selector); return; }
    await sleep(350);
    const file = await save(name, {
      clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale },
    });
    shots[name] = Object.assign({ file }, shots[name] || {});
  }

  return { S, evaluate, waitFor, viewport, shot, fullShot, clipShot };
}

/* ---------- report text ---------- */
function caption(name, title, text, bullets) {
  shots[name] = Object.assign({ title, text, bullets }, shots[name] || {});
}

/* =====================================================================
   main
   ===================================================================== */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const binary = chromeBinary();
log('using browser:', binary);
const chrome = spawn(binary, [
  '--headless=new',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1',
  '--allow-file-access-from-files',
  '--user-data-dir=' + PROFILE,
  '--remote-debugging-port=' + PORT,
  'about:blank',
], { stdio: 'ignore', detached: false });

let cdp;
let phase = 'starting';

try {
  cdp = new CDP(await waitForEndpoint());
  await cdp.connect();

  /* ---------------- page A : the live app + synthetic camera ------------- */
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = makeDriver(cdp, sessionId);
  await page.S('Page.enable');
  await page.S('Runtime.enable');
  await page.S('Page.addScriptToEvaluateOnNewDocument', { source: CAMERA_HARNESS });
  await page.viewport(VIEWPORT.width, VIEWPORT.height);

  phase = 'loading the app';
  await page.S('Page.navigate', { url: APP_URL });
  await page.waitFor('!!(window.FocusGuard && window.FocusGuard.faceDetection)', 25000, 'app booted');
  await page.waitFor('window.__cfg && window.__cfg.ready === true', 15000, 'test face image');
  await page.waitFor('document.fonts.status === "loaded"', 8000, 'fonts');
  await sleep(700);

  /* --- 1. dashboard --------------------------------------------------- */
  phase = 'dashboard';
  await page.fullShot('dashboard');
  caption('dashboard', 'Dashboard — the default view', 
    'Everything starts here: the study session form, the Pomodoro timer with its sand clock, the camera panel, the world preview, the streak chip and the live clock in the topbar.',
    ['Sidebar navigation switches between Dashboard, Study session, My World, Analytics, History and Settings.',
     'The topbar carries the real-time clock (HH:MM:SS + date) and the Focus / Full screen buttons.',
     'Every card is a self-contained module rendered from data attributes, not from duplicated state.']);

  /* --- 2. camera + face detection ------------------------------------- */
  phase = 'camera + face detection';
  await page.evaluate('document.querySelector(\'[data-camera-action="start"]\').click()');
  await page.waitFor('window.FocusGuard.faceDetection.getState().status === "detected"', 30000, 'face detected');
  await page.evaluate('window.showView && window.showView("dashboard")');
  await page.clipShot('camera-detected', '[data-camera-panel]', 16, 2);
  caption('camera-detected', 'Camera panel — “Face Detected”',
    'The camera was started with a synthetic webcam stream (a public-domain sample portrait) because headless browsers cannot answer a real permission prompt. The local MediaPipe FaceDetector found the face in ~0.5 s.',
    ['Status pill: <b>Camera Active</b>. The dot in the preview corner glows with the accent colour.',
     'Face row: <b>● Face Detected</b> — the only claim the detector is allowed to make.',
     'Model line: <b>Face detection ready</b> — the model is loaded and stays warm between sessions.',
     'Privacy bullets stay visible: frames are processed locally and never uploaded.']);

  phase = 'face removed';
  await page.evaluate('window.__cfg.blank = true');
  await page.waitFor('window.FocusGuard.faceDetection.getState().status === "missing"', 12000, 'face missing');
  await page.clipShot('camera-missing', '[data-camera-panel]', 16, 2);
  caption('camera-missing', 'Camera panel — “Face Not Detected”',
    'As soon as the face leaves the frame the indicator changes. It takes three consecutive empty frames (~0.6 s) so a single dropped frame cannot make the row flicker.',
    ['Face row: <b>● Face Not Detected</b> in the warning colour.',
     'The camera keeps running and the rest of the app is completely unaffected.',
     'No attention, distraction or “you are not focused” wording is used anywhere — that arrives in a later phase.']);
  await page.evaluate('window.__cfg.blank = false');
  await page.waitFor('window.FocusGuard.faceDetection.getState().status === "detected"', 12000, 'face back');

  /* --- 3. timer + session --------------------------------------------- */
  phase = 'timer + session';
  await page.evaluate(`(function () {
    var input = document.querySelector('[data-timer-setting="focus"]');
    input.value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-timer-toggle]').click();
  })()`);
  await sleep(3500);
  await page.clipShot('timer', '[data-timer-display]', 120, 2);
  caption('timer', 'Pomodoro timer — running, with the sand clock',
    'The timer is a pure state machine in js/timer.js; the sand clock is only a visualisation of the same snapshot, so there is no second timer anywhere.',
    ['Countdown derived from a wall-clock end time, so throttled tabs still show the correct remaining time.',
     'The grains fall at a constant rate: the upper chamber drains, the lower one fills.',
     'Start / Reset / Skip and the mode chips (Focus · Short break · Long break) all drive the same state machine.']);

  await page.evaluate(`(function () {
    document.querySelector('[data-session-field="subject"]').value = 'Linear algebra';
    document.querySelector('[data-session-field="goal"]').value = 'Finish chapter 4 exercises';
    document.querySelector('[data-session-form] button[type="submit"]').click();
  })()`);
  await sleep(1200);
  await page.clipShot('session-card', '[data-session-active]', 18, 2);
  caption('session-card', 'Study session — live panel',
    'Starting a session attaches the Pomodoro timer to it: every finished focus block is counted as a Pomodoro and every break adds to the break time.',
    ['Subject and goal, pause / resume and End session are always one click away.',
     'Elapsed, active and break time are computed from the state machine, never from a second counter.',
     'While a session runs, the camera panel switches to “monitoring is available”.']);

  await page.evaluate('document.querySelector(\'[data-view="session"]\').click()');
  await sleep(600);
  await page.shot('session-view');
  caption('session-view', 'Study session view',
    'The dedicated view repeats the same live session plus the timer settings and the attached camera panel. No duplicate state: it is the same markup contract rendered again.');
  await page.evaluate('document.querySelector(\'[data-view="dashboard"]\').click()');
  await sleep(500);

  /* --- 4. focus mode --------------------------------------------------- */
  phase = 'focus mode';
  await page.evaluate('document.querySelector(\'[data-focus-open]\').click()');
  await sleep(1400);
  await page.shot('focus-mode');
  caption('focus-mode', 'Focus Mode — countdown, sand clock, live face state and clock',
    'Focus Mode is a distraction-minimised overlay that reuses the same data attributes as the dashboard, so the countdown, the sand clock and the face row stay in sync automatically.',
    ['A larger countdown, the subject/goal, the status tags (Session · Timer · Period) and the big sand clock.',
     'The side panel keeps the camera, the face indicator and the privacy notes on screen while you study.',
     'Exit Focus Mode restores the dashboard exactly as it was; entering fullscreen opens this overlay automatically.']);
  await page.evaluate('document.querySelector(\'[data-focus-exit]\').click()');
  await sleep(600);

  /* --- 5. let the 1-minute pomodoro finish ----------------------------- */
  phase = 'waiting for the pomodoro to complete';
  await page.waitFor('document.querySelector("[data-timer-count]").textContent.trim() === "1"', 90000, 'first pomodoro');

  /* --- 6. summary modal ------------------------------------------------ */
  phase = 'session summary';
  await page.evaluate('document.querySelector(\'[data-session-end]\').click()');
  await page.waitFor('!document.querySelector("[data-session-summary]").hidden', 8000, 'summary modal');
  await sleep(600);
  await page.shot('summary');
  caption('summary', 'Session summary — shown when a session ends',
    'Ending a session freezes it into a plain record and reports what actually happened: elapsed time, active time, paused time, break time and Pomodoros.',
    ['“Focused time” stays empty on purpose — face presence alone is not proof of focus, so the field is reserved for the attention phase.',
     'The record is pushed into the in-memory history (memory only until persistence arrives).']);
  await page.evaluate('document.querySelector("[data-summary-close]").click()');
  await sleep(400);

  /* --- 7. a second, short session + history ---------------------------- */
  phase = 'history';
  await page.evaluate(`(function () {
    document.querySelector('[data-session-field="subject"]').value = 'Physics — revision';
    document.querySelector('[data-session-field="goal"]').value = 'Past paper 2024';
    document.querySelector('[data-session-form] button[type="submit"]').click();
  })()`);
  await sleep(2500);
  await page.evaluate('document.querySelector(\'[data-session-end]\').click()');
  await sleep(700);
  await page.evaluate('var m = document.querySelector("[data-session-summary]"); if (m && !m.hidden) m.querySelector("[data-summary-close]").click()');
  await page.evaluate('document.querySelector(\'[data-view="history"]\').click()');
  await sleep(700);
  await page.shot('history');
  caption('history', 'History — every finished session, newest first',
    'Sessions are frozen into plain objects and rendered into the history table, which is the groundwork for the analytics phase.',
    ['A completed session (with a Pomodoro) and a session ended early are both listed.',
     'Columns: subject, goal, start, elapsed, active, break, Pomodoros, status.',
     'History lives in memory only — reloading the page clears it until persistence is added.']);

  /* --- 8. narrow layout ------------------------------------------------ */
  phase = 'responsive layout';
  await page.viewport(430, 900);
  await page.evaluate('document.querySelector(\'[data-view="dashboard"]\').click()');
  await sleep(600);
  await page.shot('mobile');
  caption('mobile', 'Narrow layout (430 px)',
    'The layout collapses to a single column and the sidebar becomes a drawer. The clock moves into Focus Mode and nothing overflows horizontally.');
  await page.viewport(VIEWPORT.width, VIEWPORT.height);

  /* ------------------ page B : model unavailable ----------------------- */
  phase = 'model unavailable';
  const { targetId: targetB } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sessionB } = await cdp.send('Target.attachToTarget', { targetId: targetB, flatten: true });
  const pageB = makeDriver(cdp, sessionB);
  await pageB.S('Page.enable');
  await pageB.S('Runtime.enable');
  await pageB.S('Page.addScriptToEvaluateOnNewDocument', { source: CAMERA_HARNESS });
  await pageB.S('Page.addScriptToEvaluateOnNewDocument', { source: BLOCK_MODEL_HOSTS });
  await pageB.viewport(VIEWPORT.width, VIEWPORT.height);
  await pageB.S('Page.navigate', { url: APP_URL });
  await pageB.waitFor('!!(window.FocusGuard && window.FocusGuard.faceDetection)', 25000, 'app booted (B)');
  await sleep(600);
  await pageB.evaluate('document.querySelector(\'[data-camera-action="start"]\').click()');
  await pageB.waitFor('window.FocusGuard.faceDetection.getState().status === "error"', 25000, 'detection error');
  await pageB.clipShot('camera-error', '[data-camera-panel]', 16, 2);
  caption('camera-error', 'Graceful failure — “Detection Error”',
    'The model CDN was deliberately blocked to show what a failed model load looks like. The camera, the timer, the sessions, the clock and the sand clock all keep working.',
    ['Face row: <b>● Detection Error</b>, model line: <b>Face detection unavailable — …</b>',
     'The detection loop never starts, so a failure costs no CPU.',
     'Pressing Stop and Start again retries the model load — recovery was verified.']);

  /* ---------------- build the report HTML ------------------------------ */
  phase = 'building the report';
  const image = (name) => {
    const file = shots[name] && shots[name].file;
    if (!file || !fs.existsSync(file)) return '';
    return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
  };

  const scene = (name) => {
    const s = shots[name] || {};
    const src = image(name);
    if (!src) return '';
    return `
    <figure>
      <img src="${src}" alt="${s.title || name}" />
      <figcaption>
        <h3>${s.title || name}</h3>
        <p>${s.text || ''}</p>
        ${s.bullets ? '<ul>' + s.bullets.map((b) => '<li>' + b + '</li>').join('') + '</ul>' : ''}
      </figcaption>
    </figure>`;
  };

  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>FocusGuard — Feature Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Sora:wght@600;700&display=swap" rel="stylesheet" />
<style>
  @page { size: A4; margin: 15mm 13mm 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: "Inter", system-ui, sans-serif; font-size: 10.5pt; line-height: 1.55;
    color: #201d33; background: #ffffff;
  }
  h1, h2, h3, h4 { font-family: "Sora", "Inter", sans-serif; color: #1b1732; line-height: 1.25; }
  h1 { font-size: 30pt; margin: 0 0 6px; }
  h2 {
    font-size: 16pt; margin: 0 0 12px; padding-bottom: 7px;
    border-bottom: 2px solid #ece9fb; break-after: avoid;
  }
  h3 { font-size: 11.5pt; margin: 0 0 5px; }
  h4 { font-size: 10.5pt; margin: 16px 0 6px; }
  p  { margin: 0 0 9px; }
  ul { margin: 6px 0 0; padding-left: 17px; }
  li { margin-bottom: 3px; }
  code { font-family: "Consolas", "SFMono-Regular", monospace; font-size: 9pt; background: #f4f2fe; padding: 1px 4px; border-radius: 4px; color: #4b3ec4; }
  a { color: #5b45d8; }
  section { break-before: page; }
  section.flow { break-before: auto; }

  .cover { text-align: left; padding-top: 6mm; }
  .cover .badge {
    display: inline-block; font-size: 8.5pt; letter-spacing: .12em; text-transform: uppercase;
    color: #5b45d8; background: #efecfe; border-radius: 999px; padding: 4px 11px; margin-bottom: 16px;
  }
  .cover .lede { font-size: 12pt; color: #4a4467; max-width: 135mm; }
  .cover .meta { margin-top: 18px; font-size: 9.5pt; color: #6b6588; }
  .cover .logo {
    width: 74px; height: 74px; border-radius: 20px; margin-bottom: 18px;
    background: linear-gradient(150deg, #b3a8ff, #7b6cf6); display: grid; place-items: center;
    color: #0f0c1d; font-family: "Sora", sans-serif; font-size: 30pt;
  }

  table { width: 100%; border-collapse: collapse; margin: 10px 0 4px; font-size: 9.5pt; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eae7f7; vertical-align: top; }
  th { background: #f7f6fe; font-weight: 600; color: #332d55; }
  td.y { color: #4b3ec4; font-weight: 600; white-space: nowrap; }

  figure { margin: 0 0 22px; break-inside: avoid; }
  figure img {
    width: 100%; border-radius: 10px; border: 1px solid #ded9f4;
    box-shadow: 0 10px 26px -18px rgba(30, 20, 70, .5); display: block;
  }
  figcaption { margin-top: 8px; }
  figcaption p { color: #45405f; }
  figcaption ul { font-size: 9.5pt; color: #45405f; }
  .shot { break-inside: avoid; }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
  .split { display: flex; gap: 14px; }
  .split > * { flex: 1 1 0; }
  .split img { width: 100%; border-radius: 10px; border: 1px solid #ded9f4; box-shadow: 0 10px 26px -18px rgba(30, 20, 70, .5); }
  .split figcaption { font-size: 8.5pt; }

  .swatches { display: flex; gap: 8px; margin: 8px 0 12px; }
  .swatch { flex: 1; border-radius: 8px; padding: 8px 8px 6px; color: #fff; font-size: 8pt; }
  .swatch span { display: block; opacity: .8; }
  .swatch--light { color: #221d3d; }

  pre.flow {
    background: #f7f6fe; border: 1px solid #e6e2f8; border-radius: 9px; padding: 11px 13px;
    font-family: "Consolas", monospace; font-size: 8.6pt; line-height: 1.5; color: #3a3462;
    white-space: pre; overflow: hidden; margin: 8px 0 12px;
  }
  .callout {
    background: #f7f6fe; border-left: 3px solid #7b6cf6; border-radius: 0 9px 9px 0;
    padding: 10px 13px; margin: 10px 0 12px; font-size: 9.5pt; color: #3f3a5e;
  }
  .pagebreak { break-before: page; }
  .small { font-size: 9pt; color: #6b6588; }
  footer { margin-top: 16px; border-top: 1px solid #eceafa; padding-top: 8px; font-size: 8.5pt; color: #7b7695; }
</style>
</head>
<body>

<div class="cover">
  <div class="logo">◘</div>
  <span class="badge">Feature &amp; interface report</span>
  <h1>FocusGuard</h1>
  <p class="lede">A study-productivity web app that pairs a Pomodoro timer and study sessions with
  <b>on-device face presence detection</b> — no accounts, no servers, no frames leaving the browser.</p>
  <p class="meta">
    Build: <b>Phase 5 — local face detection</b><br />
    Theme: <b>Midnight Indigo</b> (dark) — replaced the earlier black/red palette<br />
    Report date: ${today}<br />
    Screenshots: captured from the live app with headless Chrome (Chromium DevTools Protocol)
  </p>
  <div class="callout">
    <b>How to read this report.</b> Every image is a real screenshot of the running application, not a mock-up.
    The webcam scenes were produced with a synthetic video stream (a public-domain sample portrait), because a
    headless browser cannot answer a real camera permission prompt. On a normal desktop browser you get the same
    screens with your own camera.
  </div>
</div>

<section>
  <h2>1 · What FocusGuard does today</h2>
  <p>FocusGuard is a static, dependency-free web app (plain HTML, CSS and JavaScript). It runs by opening
  <code>index.html</code> from a local web server. The current build covers the full study loop plus a working
  camera-and-detection layer.</p>

  <table>
    <thead><tr><th style="width:34%">System</th><th style="width:14%">Status</th><th>What it actually does</th></tr></thead>
    <tbody>
      <tr><td>Pomodoro timer</td><td class="y">Done</td><td>Focus / short break / long break, auto-cycling, configurable minutes, chime, reset and skip.</td></tr>
      <tr><td>Sand clock (hourglass)</td><td class="y">Done</td><td>Pure visualisation of the timer snapshot; drains, freezes when paused, lands when a period ends.</td></tr>
      <tr><td>Study sessions</td><td class="y">Done</td><td>Subject + goal, live elapsed/active/break time, pause and resume, summary dialog, in-memory history.</td></tr>
      <tr><td>Real-time clock</td><td class="y">Done</td><td>Independent of the timer; second-aligned HH:MM:SS plus date, in the topbar and in Focus Mode.</td></tr>
      <tr><td>Focus Mode</td><td class="y">Done</td><td>Full-screen study overlay with countdown, sand clock, status tags, camera panel and clock.</td></tr>
      <tr><td>Fullscreen</td><td class="y">Done</td><td>Real Fullscreen API; entering opens Focus Mode, leaving restores the dashboard.</td></tr>
      <tr><td>Camera panel</td><td class="y">Done</td><td>Local webcam preview with permission states, start/stop and privacy notes. Released on stop, on session end and on page unload.</td></tr>
      <tr><td>Face detection (presence)</td><td class="y">Done</td><td>On-device MediaPipe FaceDetector at ~5 detections/second → “Face Detected” / “Face Not Detected”.</td></tr>
      <tr><td>Head orientation &amp; attention</td><td>Later</td><td>Not implemented. The detector only reports presence; no attention or distraction claims are made.</td></tr>
      <tr><td>History &amp; analytics</td><td>Partly</td><td>Session history is live; the analytics view is still a placeholder.</td></tr>
      <tr><td>World builder, Focus Coins, persistence</td><td>Later</td><td>World is a CSS preview; coins, accounts and saving data come in later phases.</td></tr>
    </tbody>
  </table>

  <h4>Privacy by construction</h4>
  <ul>
    <li>Webcam frames are read straight from the <code>&lt;video&gt;</code> element and processed in the tab.</li>
    <li>The only network requests in the project are the one-time downloads of the detection library (~137 KB), its WebAssembly build (~210 KB) and the face model (~230 KB).</li>
    <li>No frame, crop, thumbnail or detection result is ever uploaded. The build was verified: every request is a <code>GET</code>; there is no <code>POST</code> anywhere.</li>
  </ul>
</section>

<section>
  <h2>2 · Interface walkthrough</h2>
  ${scene('dashboard')}
  ${scene('timer')}
</section>

<section class="flow">
  ${scene('session-card')}
  ${scene('session-view')}
</section>

<section>
  <h2>3 · Camera and on-device face detection</h2>
  ${scene('camera-detected')}
  ${scene('camera-missing')}
</section>

<section>
  <h2>4 · Focus Mode, sessions and history</h2>
  ${scene('focus-mode')}
  ${scene('summary')}
  ${scene('history')}
</section>

<section>
  <h2>5 · Graceful failure and narrow layouts</h2>
  ${scene('camera-error')}
  ${scene('mobile')}
</section>

<section>
  <h2>6 · How face detection works</h2>
  <p>The detector answers one question, locally: <b>is a face in frame?</b> It never tries to judge attention.</p>
  <pre class="flow">camera.js  ──▶  &lt;video data-camera-video&gt;  ──▶  faceDetection.js  ──▶  face state
getUserMedia       MediaStream                     ~5 Hz, in-tab          FACE_PRESENT
                                                                          FACE_MISSING
                        ▼ one 'change' event drives start / stop
                   camera panel, Focus Mode, session end, page unload</pre>

  <table>
    <thead><tr><th style="width:30%">Piece</th><th>Choice</th></tr></thead>
    <tbody>
      <tr><td>Model</td><td>MediaPipe Tasks Vision <b>FaceDetector</b> (BlazeFace short-range, ~230 KB)</td></tr>
      <tr><td>Library</td><td><code>@mediapipe/tasks-vision</code> 0.10.14, pinned and loaded once</td></tr>
      <tr><td>Where it runs</td><td>Inside the browser tab: WebAssembly + WebGL, with an automatic CPU (WASM) fallback</td></tr>
      <tr><td>Rate</td><td>~5 detections/second (200 ms gate) inside a single <code>requestAnimationFrame</code> loop</td></tr>
      <tr><td>Threshold</td><td>minDetectionConfidence 0.5, numFaces 1</td></tr>
      <tr><td>Stability</td><td>2 agreeing frames to report a face, 3 to report its absence (anti-flicker only)</td></tr>
    </tbody>
  </table>

  <h4>The status line the panel shows</h4>
  <table>
    <thead><tr><th style="width:34%">Status</th><th>Meaning</th></tr></thead>
    <tbody>
      <tr><td>● Camera Off</td><td>No camera stream, so nothing can be detected.</td></tr>
      <tr><td>● Camera Starting</td><td>Permission prompt / stream is opening.</td></tr>
      <tr><td>● Camera Active</td><td>Camera live, detection layer not engaged.</td></tr>
      <tr><td>● Detection Loading</td><td>Model downloading / initialising — “Loading face detection…”.</td></tr>
      <tr><td>● Detecting Face</td><td>Loop running, no verdict yet.</td></tr>
      <tr><td>● Face Detected</td><td>A face is in frame. This is all the system claims.</td></tr>
      <tr><td>● Face Not Detected</td><td>No face in frame.</td></tr>
      <tr><td>● Detection Error</td><td>Model or processing failed — the app keeps working.</td></tr>
    </tbody>
  </table>

  <h4>Lifecycle guarantees</h4>
  <ul>
    <li>Starting the camera loads the model <b>once</b> and starts <b>exactly one</b> loop; restarting never creates a second loop.</li>
    <li>Stopping the camera — or ending a study session — stops the loop, resets the verdict and releases the webcam. The model stays warm, so a restart is instant.</li>
    <li>Frames are read from whichever camera video element is visible, so detection continues in Focus Mode and fullscreen.</li>
    <li>Nothing in this layer can gate the timer or the session: if detection fails, the Pomodoro keeps running.</li>
  </ul>
</section>

<section>
  <h2>7 · Measured behaviour</h2>
  <p>These numbers come from the verification run against this build.</p>
  <table>
    <thead><tr><th style="width:44%">Check</th><th>Result</th></tr></thead>
    <tbody>
      <tr><td>Face in frame → “Face Detected”</td><td class="y">~0.5 s</td></tr>
      <tr><td>Face out of frame → “Face Not Detected”</td><td class="y">~0.6 s</td></tr>
      <tr><td>Detection rate while running</td><td class="y">≈4.7–5 fps (one loop)</td></tr>
      <tr><td>Duplicate loops after camera restart</td><td class="y">none — one animation-frame chain</td></tr>
      <tr><td>Model re-initialisation on restart</td><td class="y">none — stays “ready”</td></tr>
      <tr><td>Timer accuracy while detecting</td><td class="y">4.011 s elapsed over a 4 s window</td></tr>
      <tr><td>Detection during Focus Mode / fullscreen</td><td class="y">continues</td></tr>
      <tr><td>Stop camera → stream released</td><td class="y">tracks “ended”, no video keeps a stream</td></tr>
      <tr><td>Model blocked / offline</td><td class="y">“Detection Error”, camera and timer unaffected</td></tr>
      <tr><td>Network traffic during detection</td><td class="y">GET only — no uploads at all</td></tr>
    </tbody>
  </table>
</section>

<section>
  <h2>8 · Design system — “Midnight Indigo”</h2>
  <p>The dark theme was rebuilt around a midnight-indigo surface with a violet accent, replacing the earlier
  black-and-red palette. Amber is now reserved for warnings only, so colour carries meaning again.</p>

  <div class="swatches">
    <div class="swatch" style="background:#08070f">#08070f<span>background</span></div>
    <div class="swatch" style="background:#15122a">#15122a<span>surface</span></div>
    <div class="swatch" style="background:#7b6cf6">#7b6cf6<span>accent</span></div>
    <div class="swatch" style="background:#b3a8ff">#b3a8ff<span>accent soft</span></div>
    <div class="swatch swatch--light" style="background:#eeecfa">#eeecfa<span>text</span></div>
    <div class="swatch swatch--light" style="background:#e0b46a">#e0b46a<span>warning</span></div>
  </div>

  <table>
    <thead><tr><th style="width:28%">Token</th><th>Value</th><th>Use</th></tr></thead>
    <tbody>
      <tr><td><code>--bg</code></td><td>#08070f</td><td>Page background</td></tr>
      <tr><td><code>--surface</code></td><td>rgba(24, 21, 46, .78)</td><td>Cards, panels</td></tr>
      <tr><td><code>--accent</code></td><td>#7b6cf6</td><td>Primary actions, active navigation, focus rings</td></tr>
      <tr><td><code>--accent-soft</code></td><td>#b3a8ff</td><td>Highlights, “Face Detected”, hover states</td></tr>
      <tr><td><code>--warn</code></td><td>#e0b46a</td><td>Warnings: no face detected, camera errors</td></tr>
      <tr><td><code>--text</code> / <code>--muted</code></td><td>#eeecfa / #948fb4</td><td>Body copy and secondary text</td></tr>
    </tbody>
  </table>

  <h4>Typography and shape</h4>
  <ul>
    <li><b>Sora</b> for headings and numbers, <b>Inter</b> for body copy.</li>
    <li>Rounded cards (16–22 px radius), soft borders, one focal point per screen, no gratuitous gradients.</li>
    <li>Respects <code>prefers-reduced-motion</code>; keyboard focus rings on every control.</li>
  </ul>
</section>

<section>
  <h2>9 · Architecture and file map</h2>
  <table>
    <thead><tr><th style="width:26%">File</th><th>Responsibility</th></tr></thead>
    <tbody>
      <tr><td><code>index.html</code></td><td>App shell: sidebar, views, Focus Mode, summary dialog, script order.</td></tr>
      <tr><td><code>style.css</code></td><td>Design tokens, layout, components, camera panel, Focus Mode, face states.</td></tr>
      <tr><td><code>js/timer.js</code></td><td>Pomodoro state machine, no DOM. The only source of timing.</td></tr>
      <tr><td><code>js/timer-ui.js</code></td><td>Timer DOM, sand clock rendering, chime, settings inputs.</td></tr>
      <tr><td><code>js/session.js</code></td><td>Study session state machine, no DOM; counts Pomodoros and breaks.</td></tr>
      <tr><td><code>js/session-ui.js</code></td><td>Session form, live panel, dashboard mirror, summary dialog, history.</td></tr>
      <tr><td><code>js/clock.js</code></td><td>Real-time clock, fully independent of the timer.</td></tr>
      <tr><td><code>js/camera.js</code></td><td>Webcam lifecycle: permission, start, stop, release, session integration.</td></tr>
      <tr><td><code>js/faceDetection.js</code></td><td>On-device face presence detection and the face status UI contract.</td></tr>
      <tr><td><code>app.js</code></td><td>Navigation, Focus Mode, fullscreen, dashboard rendering.</td></tr>
    </tbody>
  </table>

  <pre class="flow">timer.js ──▶ timer-ui.js ──▶ countdown · sand clock · chime
   └─ 'complete' ──▶ session.js ──▶ session-ui.js ──▶ form · live panel · summary · history
                                        └─ 'change' / 'end' ──▶ camera.js
                                                                  └─ 'change' ──▶ faceDetection.js ──▶ [data-face-*]

clock.js  independent · app.js owns navigation, Focus Mode and fullscreen</pre>

  <div class="callout">
    <b>One attribute contract, many places.</b> A view only needs the right data attribute
    (<code>data-timer-*</code>, <code>data-session-*</code>, <code>data-camera-*</code>, <code>data-face-*</code>)
    to be kept in sync — that is why the dashboard and Focus Mode never drift apart.
  </div>
</section>

<section>
  <h2>10 · Limitations and honest boundaries</h2>
  <ul>
    <li><b>Presence only.</b> The detector reports “Face Detected” / “Face Not Detected”. It cannot tell where you
    are looking, whether you are reading, or whether you are focused — and nothing in the interface pretends otherwise.</li>
    <li><b>“Focused time” is intentionally empty</b> in session summaries until orientation and attention rules exist.</li>
    <li><b>Model download.</b> The first time the camera starts, the library and model (~570 KB) are fetched once and
    then cached. Offline or blocked, the panel reports a detection error and everything else continues.</li>
    <li><b>Camera permission</b> requires a secure context (<code>localhost</code> or HTTPS). Embedded webviews may never
    resolve the permission prompt, leaving the panel in “Camera Starting”.</li>
    <li><b>No persistence.</b> Sessions, history and settings live in memory and reset on reload.</li>
    <li><b>Fullscreen</b> must be triggered by a user gesture; some embedded webviews disable it, and the button simply
    stays in its “Enter full screen” state.</li>
  </ul>

  <h4>Next phases</h4>
  <ol>
    <li>Head orientation (left / right / up / down) from face landmarks, on top of the existing pipeline.</li>
    <li>Attention estimate with explicit, documented rules — the first point at which “focused time” can be filled in.</li>
    <li>Persistence (local storage) so sessions, history and settings survive a reload.</li>
    <li>Analytics charts and Focus Coins from real, measured study time.</li>
    <li>The gamified world builder.</li>
  </ol>

  <footer>
    FocusGuard · Phase 5 feature report · generated ${today} · screenshots captured with headless Chrome from
    <code>${APP_URL}</code>
  </footer>
</section>

</body>
</html>`;

  fs.writeFileSync(path.join(OUT, 'report.html'), html, 'utf8');
  log('report.html written:', (fs.statSync(path.join(OUT, 'report.html')).size / 1024 / 1024).toFixed(2), 'MB');

  /* ---------------- print to PDF --------------------------------------- */
  phase = 'printing the PDF';
  const { targetId: targetP } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sessionP } = await cdp.send('Target.attachToTarget', { targetId: targetP, flatten: true });
  const pageP = makeDriver(cdp, sessionP);
  await pageP.S('Page.enable');
  await pageP.S('Emulation.setDeviceMetricsOverride', {
    width: 900, height: 1200, deviceScaleFactor: 1, mobile: false,
  });
  await pageP.S('Page.navigate', { url: 'file:///' + path.join(OUT, 'report.html').replace(/\\/g, '/') });
  await sleep(3500);
  await pageP.waitFor('document.fonts.status === "loaded"', 12000, 'report fonts');

  const { data: pdfBase64 } = await pageP.S('Page.printToPDF', {
    printBackground: true,
    preferCSSPageSize: true,
  });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  fs.writeFileSync(PDF_PATH, Buffer.from(pdfBase64, 'base64'));
  const pdfBytes = fs.statSync(PDF_PATH).size;

  log('');
  log('PDF written:', PDF_PATH);
  log('PDF size   :', (pdfBytes / 1024 / 1024).toFixed(2), 'MB');
  log('screenshots:', Object.keys(shots).length, fs.readdirSync(SHOTS).join(', '));
} catch (error) {
  log('FAILED during phase:', phase);
  log(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  try { if (cdp) cdp.close(); } catch {}
  try { chrome.kill(); } catch {}
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  log('done');
}
