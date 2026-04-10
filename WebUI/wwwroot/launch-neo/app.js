/* ══════════════════════════════════════════════════════
   MultiAudio Nouva · Neo Deck
   State-driven dashboard: whole page shifts appearance
   when engine goes live vs. offline vs. calibrating.

   All patterns from this session applied:
   - normalizeSsePayload (PascalCase→camelCase for SSE)
   - isRunning/isCalibrating restored from state snapshot
   - string-type guard for syncLockState enum
   - Animated vertical meters via requestAnimationFrame
   ══════════════════════════════════════════════════════ */

const POLL_MS   = 2000;
const SAFETY_MS = 1000;
const STALE_MS  = 4000;
const TELE_STALE= 2500;
const TELE_POLL = 90;
const SET_DEB   = 220;
const RETRY_MS  = 1600;

let state        = null;
let teleState    = null;
let pollFlight   = false;
let teleFlight   = false;
let evStream     = null;
let teleStream   = null;
let fbTimer      = null;
let telePollTimer= null;
let setTimer     = null;
let calibFlight  = false;
let lastStateAt  = 0;
let lastTeleAt   = 0;
let interactUntil= 0;
let selectedSlot = Number(localStorage.getItem('nd.slot')) || 0;

const animMeters = new Map();     // element → { current, target } for animated meter bars
let   meterRaf   = 0;
const pending    = new Set();     // in-flight action keys

const $ = id => document.getElementById(id);

/* ── Element references ── */
const E = {
  startBtn:     $('startBtn'),
  stopBtn:      $('stopBtn'),
  calibBtn:     $('calibBtn'),
  refreshBtn:   $('refreshBtn'),
  addOutputBtn: $('addOutputBtn'),
  masterRange:  $('masterVolRange'),
  masterVal:    $('masterVolValue'),
  routeSelect:  $('routeSelect'),
  openRouteBtn: $('openRouteBtn'),
  inputSelect:  $('inputSelect'),
  calibSelect:  $('calibSelect'),
  testToneChk:  $('testToneChk'),
  markerRange:  $('markerRange'),
  markerLbl:    $('markerLbl'),
  syncGroup:    $('syncGroup'),

  engineOrb:    $('engineOrb'),
  engineMode:   $('engineMode'),
  engineSub:    $('engineSub'),
  csMaster:     $('csMaster'),
  csLocked:     $('csLocked'),
  csSync:       $('csSync'),
  csRoutes:     $('csRoutes'),
  csSession:    $('csSession'),
  csCapture:    $('csCapture'),
  csCal:        $('csCal'),
  csError:      $('csError'),
  cmCapFill:    $('cmCapFill'),
  cmMicFill:    $('cmMicFill'),
  cmCapPct:     $('cmCapPct'),
  cmMicPct:     $('cmMicPct'),

  rackStrips:   $('rackStrips'),
  rackEmpty:    $('rackEmpty'),

  focusModule:  $('focusModule'),
  focusLabel:   $('focusLabel'),
  focusActions: $('focusActions'),
  focusContent: $('focusContent'),
  focusOpenLink:$('focusOpenLink'),
  focusDevSel:  null, // queried from focusContent after build

  calHealthBadge: $('calHealthBadge'),
  calTitle:     $('calTitle'),
  calStage:     $('calStage'),
  calGuidance:  $('calGuidance'),
  calAttempts:  $('calAttempts'),

  logOutput:    $('logOutput'),
  logBadge:     $('logBadge'),
  copyLogsBtn:  $('copyLogsBtn'),

  toastStack:   $('toastStack'),
};

/* ══════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════ */
boot();

async function boot() {
  bindEvents();
  // Load initial state (awaited so channels render before first paint completes)
  await refreshState(true);
  connectEv();
  connectTele();
  startTelePoll();
  setInterval(safety, SAFETY_MS);
}

/* ══════════════════════════════════════════════════════
   EVENT BINDING
   ══════════════════════════════════════════════════════ */
function bindEvents() {
  E.startBtn.onclick    = () => mutate(() => api('/api/start',           { method:'POST' }));
  E.stopBtn.onclick     = () => mutate(() => api('/api/stop',            { method:'POST' }));
  E.calibBtn.onclick    = handleCalibrate;
  E.refreshBtn.onclick  = () => mutate(() => api('/api/refresh-devices', { method:'POST' }));
  E.addOutputBtn.onclick = () => mutate(() => api('/api/outputs',        { method:'POST' }));
  E.copyLogsBtn.onclick = copyLogs;

  E.masterRange.addEventListener('input',  handleSettings);
  E.masterRange.addEventListener('change', handleSettings);
  E.markerRange.addEventListener('input',  handleSettings);
  E.markerRange.addEventListener('change', handleSettings);
  [E.inputSelect, E.calibSelect, E.testToneChk].forEach(c => {
    c.addEventListener('input',  handleSettings);
    c.addEventListener('change', handleSettings);
  });

  document.querySelectorAll('[data-sync-mode]').forEach(b => {
    b.onclick = () => { if (!state) return; markInteract(); setSyncMode(b.dataset.syncMode); queueSettings(); };
  });

  // Workspace nav
  const saved = localStorage.getItem('multiAudio.route') || '/launch-neo/';
  if ([...E.routeSelect.options].some(o => o.value === saved)) E.routeSelect.value = saved;
  E.routeSelect.addEventListener('change', () => localStorage.setItem('multiAudio.route', E.routeSelect.value));
  E.openRouteBtn.addEventListener('click', () => { localStorage.setItem('multiAudio.route', E.routeSelect.value); window.location.href = E.routeSelect.value; });

  // Channel rack (delegated)
  E.rackStrips.addEventListener('click', handleRackClick);

  // Focus panel (delegated — rebuilt on channel select)
  E.focusContent.addEventListener('click', handleFocusClick);
  E.focusContent.addEventListener('change', handleFocusChange);
}

/* ══════════════════════════════════════════════════════
   SSE
   ══════════════════════════════════════════════════════ */
function connectEv() {
  if (!window.EventSource) { startFb(); return; }
  if (evStream) evStream.close();
  evStream = new EventSource('/api/events');
  evStream.addEventListener('state', e => {
    stopFb();
    try { lastStateAt = Date.now(); setState(normSse(JSON.parse(e.data))); }
    catch { startFb(); }
  });
  evStream.onopen  = () => { lastStateAt = Date.now(); stopFb(); };
  evStream.onerror = () => { startFb(); setTimeout(() => { if (evStream?.readyState === 2) connectEv(); }, RETRY_MS); };
}

function connectTele() {
  if (!window.EventSource) return;
  if (teleStream) teleStream.close();
  teleStream = new EventSource('/api/telemetry');
  teleStream.addEventListener('telemetry', e => {
    try { lastTeleAt = Date.now(); setTele(normSse(JSON.parse(e.data))); }
    catch {}
  });
  teleStream.onopen  = () => { lastTeleAt = Date.now(); };
  teleStream.onerror = () => { setTimeout(() => { if (teleStream?.readyState === 2) connectTele(); }, RETRY_MS); };
}

function startFb() { if (fbTimer) return; fbTimer = setInterval(() => refreshState(), POLL_MS); }
function stopFb()  { if (!fbTimer) return; clearInterval(fbTimer); fbTimer = null; }
function startTelePoll() { if (telePollTimer) return; telePollTimer = setInterval(() => refreshTele(), TELE_POLL); }

async function refreshState(force) {
  if (pollFlight) return;
  if (!force && Date.now() < interactUntil) return;
  pollFlight = true;
  try { lastStateAt = Date.now(); setState(await api('/api/state')); }
  catch(e) { toast(e.message || 'State load failed.'); }
  finally { pollFlight = false; }
}

async function refreshTele(force) {
  if (teleFlight) return;
  if (!force && !(state?.isRunning || state?.isCalibrating)) return;
  teleFlight = true;
  try { lastTeleAt = Date.now(); setTele(await api('/api/telemetry-state')); }
  catch {}
  finally { teleFlight = false; }
}

function safety() {
  if (!window.EventSource) return;
  if (Date.now() - lastStateAt > STALE_MS) refreshState(true);
  if ((state?.isRunning || state?.isCalibrating) && Date.now() - lastTeleAt > TELE_STALE) connectTele();
}

/* ══════════════════════════════════════════════════════
   API
   ══════════════════════════════════════════════════════ */
async function api(path, opts = {}) {
  const r = await fetch(path, {
    method:  opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body:    opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const ct   = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((typeof data === 'object' && (data.error || data.title || data.detail)) || data || 'Request failed.');
  return data;
}

async function mutate(fn) {
  try { setState(await fn()); }
  catch(e) { toast(e.message || 'Action failed.'); }
}

/* ══════════════════════════════════════════════════════
   STATE MANAGEMENT
   ══════════════════════════════════════════════════════ */
function setState(next) {
  if (!next) return;
  // Reject stale revisions
  if (state && (next.stateRevision || 0) < (state.stateRevision || 0)) return;

  state = next;

  // Re-apply last telemetry so per-route metrics survive state snapshots
  if (teleState) mergeTele(teleState);

  // isRunning / isCalibrating: authoritative from state snapshot
  // (mergeTele overwrites with potentially stale telemetry values)
  state.isRunning     = next.isRunning;
  state.isCalibrating = next.isCalibrating;

  ensureSlot();
  render();
}

function setTele(next) {
  if (!next) return;
  if (teleState && (next.telemetryRevision || 0) < (teleState.telemetryRevision || 0)) return;
  teleState = next;
  mergeTele(next);
  patchTele(next);
}

function mergeTele(f) {
  if (!state || !f) return;
  state.isRunning     = !!f.isRunning;
  state.isCalibrating = !!f.isCalibrating;
  state.captureLevel  = f.captureLevel  || 0;
  state.roomMicLevel  = f.roomMicLevel  || 0;
  state.captureStatusText          = f.captureStatusText          || state.captureStatusText;
  state.sessionStatusMessage       = f.sessionStatusMessage       || state.sessionStatusMessage;
  state.calibrationStatusMessage   = f.calibrationStatusMessage   || state.calibrationStatusMessage;
  state.calibrationProgressMessage = f.calibrationProgressMessage || state.calibrationProgressMessage;

  for (const t of f.outputs || []) {
    const o = findRoute(t.slotIndex);
    if (!o) continue;
    o.meterLevel           = t.meterLevel || 0;
    o.statusText           = t.statusText || o.statusText;
    o.appliedVolumePercent = t.appliedVolumePercent ?? o.appliedVolumePercent ?? o.volumePercent ?? 0;
    o.delayMilliseconds    = t.delayMilliseconds     ?? o.delayMilliseconds   ?? 0;
    o.effectiveDelayMilliseconds = t.effectiveDelayMilliseconds ?? o.effectiveDelayMilliseconds ?? o.delayMilliseconds ?? 0;
    o.syncConfidence       = t.syncConfidence || 0;
    // String-type guard: SSE sends integer enum, REST sends string — never let integer corrupt state
    o.syncLockState = (typeof t.syncLockState === 'string' && t.syncLockState) ? t.syncLockState : o.syncLockState;
    o.syncSummary   = t.syncSummary || o.syncSummary;
    o.isMuted       = !!t.isMuted;
    o.isSolo        = !!t.isSolo;
    o.bufferedMilliseconds = t.bufferedMilliseconds ?? o.bufferedMilliseconds ?? 0;
    o.playbackRateRatio    = t.playbackRateRatio    ?? o.playbackRateRatio    ?? 1;
  }
}

/* ══════════════════════════════════════════════════════
   RENDER
   ══════════════════════════════════════════════════════ */
function render() {
  if (!state) return;
  applyBodyState();
  renderControls();
  renderConsole();
  renderRack();
  renderSignalConfig();
  renderCal();
  renderLog();
  renderFocusPanel();
}

/* Apply body class so CSS transitions drive the whole page appearance */
function applyBodyState() {
  const mode = state.isCalibrating ? 'state-calibrating' : state.isRunning ? 'state-live' : 'state-offline';
  document.body.className = mode;
}

function renderControls() {
  E.startBtn.disabled    = !state.canStart;
  E.stopBtn.disabled     = !state.canStop;
  E.refreshBtn.disabled  = !state.canRefreshDevices;
  E.addOutputBtn.disabled = !state.canAddOutput;
  E.calibBtn.textContent = state.isCalibrating ? '⌖ Cancel' : '⌖ Calibrate';
  E.calibBtn.disabled    = calibFlight || (!state.canRunCalibration && !state.isCalibrating);

  if (!isDirty(E.masterRange)) E.masterRange.value = state.masterVolumePercent;
  E.masterVal.textContent = Math.round(+E.masterRange.value);
}

function renderConsole() {
  const mode = state.isCalibrating ? 'CALIBRATING' : state.isRunning ? 'LIVE' : 'OFFLINE';
  E.engineMode.textContent = mode;
  E.engineSub.textContent  = state.isCalibrating
    ? (state.calibrationStatusMessage || 'Running...')
    : state.isRunning
    ? (state.sessionStatusMessage || 'Session active')
    : 'No session active';

  const master = (state.outputs || []).find(o => o.isTimingMaster);
  E.csMaster.textContent = master ? `CH ${master.slotIndex}` : '--';
  E.csLocked.textContent = String(state.lockedOutputCount || state.lockedOutputsCount || 0);
  E.csSync.textContent   = titleCase(state.autoSyncMode);
  E.csRoutes.textContent = String((state.outputs || []).length);

  E.csSession.textContent = state.sessionStatusMessage || 'Ready';
  E.csCapture.textContent = state.captureStatusText    || 'Idle';
  E.csCal.textContent     = state.calibrationStatusMessage || 'Calibration idle.';

  if (state.lastErrorMessage) {
    E.csError.classList.remove('hidden');
    E.csError.textContent = state.lastErrorMessage;
  } else {
    E.csError.classList.add('hidden');
  }

  // VU meters in console
  setMeterPct(E.cmCapFill, (state.captureLevel || 0) * 100);
  setMeterPct(E.cmMicFill, (state.roomMicLevel || 0) * 100);
  E.cmCapPct.textContent = Math.round((state.captureLevel || 0) * 100);
  E.cmMicPct.textContent = Math.round((state.roomMicLevel || 0) * 100);
}

function renderSignalConfig() {
  renderSel(E.inputSelect,  state.inputDevices, state.selectedInputDeviceId,             !state.canEditTopology, 'Choose input…');
  renderSel(E.calibSelect,  state.inputDevices, state.selectedCalibrationInputDeviceId,  state.isCalibrating,    'Choose mic…');
  if (!isDirty(E.testToneChk)) E.testToneChk.checked = state.useTestTone;
  E.testToneChk.disabled = !state.canEditTopology;
  if (!isDirty(E.markerRange)) E.markerRange.value = state.markerLevelPercent;
  E.markerLbl.textContent = `Marker ${(+E.markerRange.value).toFixed(1)}%`;
  E.markerRange.disabled = state.isCalibrating;

  document.querySelectorAll('[data-sync-mode]').forEach(b => {
    const active = b.dataset.syncMode === state.autoSyncMode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
    b.disabled = state.isCalibrating;
  });
}

/* ─── CHANNEL RACK ─── */
function renderRack() {
  const outputs = state.outputs || [];

  if (!outputs.length) {
    E.rackStrips.innerHTML = `<div class="rack-empty" id="rackEmpty">No output routes. Click + Add Channel to get started.</div>`;
    return;
  }

  // Full rebuild — simple and reliable
  E.rackStrips.innerHTML = outputs.map(o => `
    <div class="strip${o.slotIndex === selectedSlot ? ' selected' : ''}" data-slot="${o.slotIndex}" style="--ch-color:${chColor(o.slotIndex)}">
      <div class="strip-top"></div>
      <div class="strip-hd">
        <span class="strip-ch-num">CH ${o.slotIndex}</span>
        <span class="strip-led${(o.statusText||'').toLowerCase().includes('playing') ? ' playing' : ''}"></span>
      </div>
      <div class="strip-name" title="${esc(o.selectedDeviceName)}">${esc(o.selectedDeviceName || 'Unassigned')}</div>
      <div class="strip-meter-zone">
        <div class="strip-vmeter-wrap">
          <div class="strip-vmeter">
            <div class="strip-vmeter-fill" data-vmeter="${o.slotIndex}" style="height:${routeMeterPct(o.meterLevel)}%"></div>
          </div>
        </div>
        <div class="strip-stats">
          <div class="strip-stat"><div class="strip-stat-val">${Math.round(o.volumePercent)}%</div><div class="strip-stat-lbl">vol</div></div>
          <div class="strip-stat"><div class="strip-stat-val">${Math.round(o.delayMilliseconds)}ms</div><div class="strip-stat-lbl">dly</div></div>
          <div class="strip-stat"><div class="strip-stat-val">${Math.round((o.syncConfidence||0)*100)}%</div><div class="strip-stat-lbl">conf</div></div>
        </div>
      </div>
      <div class="strip-badges">
        ${o.isTimingMaster ? `<span class="strip-badge sb-master">Master</span>` : ''}
        ${o.isMuted  ? `<span class="strip-badge sb-muted">Mute</span>`  : ''}
        ${o.isSolo   ? `<span class="strip-badge sb-solo">Solo</span>`   : ''}
        <span class="strip-badge sb-sync${(o.syncLockState||'Manual')==='Locked'?' locked':''}">${esc(o.syncLockState||'Manual')}</span>
      </div>
    </div>`).join('');
}

function createStripEl(o) {
  const div = document.createElement('div');
  div.className = 'strip' + (o.slotIndex === selectedSlot ? ' selected' : '');
  div.dataset.slot = o.slotIndex;
  div.innerHTML = stripHtml(o);
  return div;
}

function updateStripEl(strip, o) {
  // Update selected state
  strip.classList.toggle('selected', o.slotIndex === selectedSlot);
  // Update playing LED
  strip.classList.toggle('is-playing', o.statusText?.toLowerCase().includes('playing') || false);
  strip.classList.toggle('is-muted',   !!o.isMuted);

  // Update text nodes (non-destructive)
  const q = sel => strip.querySelector(sel);
  if (q('.strip-name'))     q('.strip-name').textContent     = o.selectedDeviceName || 'Unassigned';
  if (q('[data-stat="vol"]'))  q('[data-stat="vol"]').textContent  = `${Math.round(o.volumePercent)}%`;
  if (q('[data-stat="del"]'))  q('[data-stat="del"]').textContent  = `${Math.round(o.delayMilliseconds)}ms`;
  if (q('[data-stat="conf"]')) q('[data-stat="conf"]').textContent = `${Math.round((o.syncConfidence || 0) * 100)}%`;

  // Update badges
  const badgesEl = q('.strip-badges');
  if (badgesEl) badgesEl.innerHTML = stripBadgesHtml(o);

  // Vertical meter via animation
  const fill = q('.strip-vmeter-fill');
  if (fill) setMeterHeight(fill, routeMeterPct(o.meterLevel));
}

function stripHtml(o) {
  const color = chColor(o.slotIndex);
  return `
    <div class="strip-top" style="background:${color}"></div>
    <div class="strip-hd">
      <span class="strip-ch-num" style="color:${color}">CH ${o.slotIndex}</span>
      <span class="strip-led"></span>
    </div>
    <div class="strip-name" title="${esc(o.selectedDeviceName)}">${esc(o.selectedDeviceName || 'Unassigned')}</div>
    <div class="strip-meter-zone">
      <div class="strip-vmeter-wrap">
        <div class="strip-vmeter">
          <div class="strip-vmeter-fill" style="height:0%"></div>
        </div>
      </div>
      <div class="strip-stats">
        <div class="strip-stat"><div class="strip-stat-val" data-stat="vol">${Math.round(o.volumePercent)}%</div><div class="strip-stat-lbl">vol</div></div>
        <div class="strip-stat"><div class="strip-stat-val" data-stat="del">${Math.round(o.delayMilliseconds)}ms</div><div class="strip-stat-lbl">dly</div></div>
        <div class="strip-stat"><div class="strip-stat-val" data-stat="conf">${Math.round((o.syncConfidence||0)*100)}%</div><div class="strip-stat-lbl">conf</div></div>
      </div>
    </div>
    <div class="strip-badges">${stripBadgesHtml(o)}</div>`;
}

function stripBadgesHtml(o) {
  const sync = o.syncLockState || 'Manual';
  return [
    o.isTimingMaster ? `<span class="strip-badge sb-master">Master</span>` : '',
    o.isMuted        ? `<span class="strip-badge sb-muted">Mute</span>`   : '',
    o.isSolo         ? `<span class="strip-badge sb-solo">Solo</span>`    : '',
    `<span class="strip-badge sb-sync${sync === 'Locked' ? ' locked' : ''}">${esc(sync)}</span>`,
  ].join('');
}

/* ─── TELEMETRY PATCH (live, no innerHTML) ─── */
function patchTele(f) {
  if (!f || !state) return;

  // Engine state — apply body class
  const mode = f.isCalibrating ? 'state-calibrating' : f.isRunning ? 'state-live' : 'state-offline';
  if (document.body.className !== mode) document.body.className = mode;

  // Update engine text in console
  E.engineMode.textContent = f.isCalibrating ? 'CALIBRATING' : f.isRunning ? 'LIVE' : 'OFFLINE';
  E.engineSub.textContent  = f.calibrationProgressMessage || f.sessionStatusMessage
    || (f.isRunning ? 'Session active' : 'No session active');

  // Console VU meters
  setMeterPct(E.cmCapFill, (f.captureLevel || 0) * 100);
  setMeterPct(E.cmMicFill, (f.roomMicLevel || 0) * 100);
  E.cmCapPct.textContent = Math.round((f.captureLevel || 0) * 100);
  E.cmMicPct.textContent = Math.round((f.roomMicLevel || 0) * 100);

  // Status text
  E.csSession.textContent = f.sessionStatusMessage || state.sessionStatusMessage || 'Ready';
  E.csCapture.textContent = f.captureStatusText    || state.captureStatusText    || 'Idle';

  // Channel rack: update vertical meters only (targeted, no innerHTML)
  for (const t of f.outputs || []) {
    const fill = E.rackStrips.querySelector(`[data-vmeter="${t.slotIndex}"]`);
    if (fill) setMeterHeight(fill, routeMeterPct(t.meterLevel));
  }

  renderCal();
}

/* ─── CALIBRATION ─── */
function renderCal() {
  const src    = teleState || state;
  const room   = src?.roomMicLevel || 0;
  const status = String(src?.calibrationStatusMessage || '');
  const stage  = src?.calibrationProgressMessage || src?.calibrationStatusMessage || '—';
  let title = 'Ready', health = 'Idle', guidance = 'Start calibration to measure delays.';

  if (src?.isCalibrating) {
    if      (room >= 0.92)  { title='Too Hot'; health='Overloaded'; guidance='Lower mic gain.'; }
    else if (room >= 0.08)  { title='Healthy'; health='Usable';     guidance='Signal looks good.'; }
    else if (room >= 0.025) { title='Weak';    health='Weak';       guidance='May be unreliable.'; }
    else                    { title='Quiet';   health='Low';        guidance='Raise volume or move mic.'; }
  } else if (/failed/i.test(status)) {
    title='Failed'; health='Adjust'; guidance=state?.lastErrorMessage||'No arrivals.';
  } else if (/applied|complete/i.test(status)) {
    title='Done'; health='OK'; guidance='Delays applied.';
  }

  E.calTitle.textContent       = title;
  E.calStage.textContent       = stage;
  E.calGuidance.textContent    = guidance;
  E.calHealthBadge.textContent = health;

  const entries = getCalEntries();
  E.calAttempts.innerHTML = entries.length
    ? entries.map(e => `<div class="cal-entry ${e.tone}"><time>${esc(e.time)}</time><span>${esc(e.text)}</span></div>`).join('')
    : '';
}

/* ─── LOG ─── */
function renderLog() {
  const lines = (state.logEntries || []).map(e => e.displayText);
  const errs  = (state.logEntries || []).filter(e => /error|fail|exception/i.test(e.displayText)).length;
  E.logOutput.textContent     = lines.length ? lines.join('\n') : 'No log entries yet.';
  E.logBadge.textContent      = errs > 0 ? `${lines.length}/${errs}err` : String(lines.length);
}

/* ─── FOCUS PANEL ─── */
function renderFocusPanel() {
  const route = findRoute(selectedSlot);
  if (!route) {
    E.focusLabel.textContent   = 'No Channel Selected';
    E.focusActions.style.display = 'none';
    E.focusContent.innerHTML   = '<p class="focus-empty">Click a channel strip above to inspect it here.</p>';
    return;
  }
  E.focusLabel.textContent   = `CH ${route.slotIndex} · ${esc(route.selectedDeviceName || 'Unassigned')}`;
  E.focusActions.style.display = '';
  E.focusOpenLink.href         = '/v2/';

  const pp = a => pending.has(`${route.slotIndex}:${a}`);
  const devOptions = [
    `<option value="">— unassigned —</option>`,
    ...(state.playbackDevices || []).map(d =>
      `<option value="${esc(d.id)}" ${d.id === route.selectedDeviceId ? 'selected' : ''}>${esc(d.displayName)}</option>`)
  ].join('');

  E.focusContent.innerHTML = `
    <select class="focus-dev-sel" id="focusDevSel" ${state.canEditTopology ? '' : 'disabled'}>
      ${devOptions}
    </select>
    <div class="focus-chips">
      <div class="f-chip"><span>Delay</span><strong>${Math.round(route.delayMilliseconds)}<small>ms</small></strong></div>
      <div class="f-chip"><span>Volume</span><strong>${Math.round(route.volumePercent)}<small>%</small></strong></div>
      <div class="f-chip"><span>Confidence</span><strong>${Math.round((route.syncConfidence||0)*100)}<small>%</small></strong></div>
      <div class="f-chip"><span>Drift</span><strong>${Math.abs((Number(route.playbackRateRatio||1)-1)*1000).toFixed(1)}<small>ms</small></strong></div>
    </div>
    <div class="focus-acts">
      <button class="f-act${route.isMuted?' on':''}" data-action="mute"
        ${state.isCalibrating||pp('mute')?'disabled':''}>
        ${route.isMuted?'Unmute':'Mute'}
      </button>
      <button class="f-act${route.isSolo?' on':''}" data-action="solo"
        ${state.isCalibrating||pp('solo')?'disabled':''}>
        ${route.isSolo?'Unsolo':'Solo'}
      </button>
      <button class="f-act" data-action="ping"
        ${!route.selectedDeviceId||state.isCalibrating||pp('ping')?'disabled':''}>
        ${pp('ping')?'Pinging…':'Ping'}
      </button>
      <button class="f-act${route.isTimingMaster?' on':''}" data-action="make-master"
        ${state.isCalibrating||pp('make-master')?'disabled':''}>
        ${route.isTimingMaster?'Timing Master':'Set Master'}
      </button>
      <button class="f-act danger" data-action="remove"
        ${!route.canRemove||pp('remove')?'disabled':''}>
        ${pp('remove')?'Removing…':'Remove'}
      </button>
    </div>`;
}

/* ══════════════════════════════════════════════════════
   CHANNEL CLICK
   ══════════════════════════════════════════════════════ */
function handleRackClick(e) {
  const strip = e.target.closest('.strip');
  if (!strip) return;
  const slot = +strip.dataset.slot;
  selectedSlot = selectedSlot === slot ? 0 : slot;
  localStorage.setItem('nd.slot', String(selectedSlot));

  // Update selected class immediately (no full re-render)
  E.rackStrips.querySelectorAll('.strip').forEach(s => {
    s.classList.toggle('selected', +s.dataset.slot === selectedSlot);
  });
  renderFocusPanel();
}

/* ══════════════════════════════════════════════════════
   FOCUS PANEL EVENTS
   ══════════════════════════════════════════════════════ */
function handleFocusChange(e) {
  if (!findRoute(selectedSlot)) return;
  if (e.target.id === 'focusDevSel') {
    markInteract();
    const route = findRoute(selectedSlot);
    mutate(() => api(`/api/outputs/${selectedSlot}`, {
      method: 'PUT',
      body: { selectedDeviceId: e.target.value || null, volumePercent: route?.volumePercent || 100, delayMilliseconds: route?.delayMilliseconds || 0, isTimingMaster: route?.isTimingMaster || false },
    }));
  }
}

function handleFocusClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn || !findRoute(selectedSlot)) return;
  const action = btn.dataset.action;
  const slot   = selectedSlot;
  markInteract();

  if (action === 'remove') {
    const name = findRoute(slot)?.selectedDeviceName || `CH ${slot}`;
    if (!confirm(`Remove CH ${slot} — ${name}?\n\nThis cannot be undone.`)) return;
    runAction(slot, action, () => api(`/api/outputs/${slot}`, { method: 'DELETE' }));
    return;
  }
  if (action === 'mute' || action === 'solo') {
    runAction(slot, action, () => api(`/api/outputs/${slot}/${action}`, { method: 'POST' }));
    return;
  }
  if (action === 'ping') {
    runAction(slot, action, () => api(`/api/outputs/${slot}/ping`, { method: 'POST' }));
    return;
  }
  if (action === 'make-master') {
    const route = findRoute(slot);
    runAction(slot, action, () => api(`/api/outputs/${slot}`, {
      method: 'PUT',
      body: { selectedDeviceId: route?.selectedDeviceId || null, volumePercent: route?.volumePercent || 100, delayMilliseconds: route?.delayMilliseconds || 0, isTimingMaster: true },
    }));
  }
}

async function runAction(slot, action, req) {
  const key = `${slot}:${action}`;
  if (pending.has(key)) return;
  pending.add(key);
  renderFocusPanel();
  try { setState(await req()); }
  catch(e) { toast(e.message || 'Action failed.'); }
  finally { pending.delete(key); renderFocusPanel(); }
}

/* ══════════════════════════════════════════════════════
   SETTINGS
   ══════════════════════════════════════════════════════ */
function handleSettings() {
  if (!state) return;
  markInteract();
  E.masterVal.textContent = Math.round(+E.masterRange.value);
  E.markerLbl.textContent = `Marker ${(+E.markerRange.value).toFixed(1)}%`;
  queueSettings();
}

function queueSettings() {
  clearTimeout(setTimer);
  setTimer = setTimeout(() => {
    setTimer = null;
    mutate(() => api('/api/settings', { method: 'PUT', body: {
      selectedInputDeviceId:            E.inputSelect.value  || null,
      selectedCalibrationInputDeviceId: E.calibSelect.value  || null,
      useTestTone:         E.testToneChk.checked,
      masterVolumePercent: +E.masterRange.value,
      autoSyncMode:        document.querySelector('[data-sync-mode].active')?.dataset.syncMode || 'MonitorOnly',
      markerLevelPercent:  +E.markerRange.value,
    }}));
  }, SET_DEB);
}

function setSyncMode(m) {
  document.querySelectorAll('[data-sync-mode]').forEach(b => {
    const active = b.dataset.syncMode === m;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

/* ══════════════════════════════════════════════════════
   CALIBRATE
   ══════════════════════════════════════════════════════ */
function handleCalibrate() {
  if (!state || calibFlight) return;
  state.isCalibrating ? cancelCal() : startCal();
}

async function startCal() {
  calibFlight = true; renderControls();
  try {
    const req = api('/api/calibrate', { method: 'POST' });
    setTimeout(() => { refreshState(true); refreshTele(true); }, 60);
    setState(await req);
  } catch(e) { toast(e.message || 'Calibration failed.'); await refreshState(true); }
  finally { calibFlight = false; renderControls(); }
}

async function cancelCal() {
  calibFlight = true; renderControls();
  try { setState(await api('/api/calibrate/cancel', { method: 'POST' })); }
  catch(e) { toast(e.message || 'Cancel failed.'); await refreshState(true); }
  finally { calibFlight = false; renderControls(); }
}

/* ══════════════════════════════════════════════════════
   ANIMATED METERS
   ══════════════════════════════════════════════════════ */
/** Horizontal meters (width) */
function setMeterPct(el, pct) {
  if (!el) return;
  const target = Math.max(0, Math.min(100, pct || 0));
  const cur    = animMeters.get(el)?.current ?? target;
  animMeters.set(el, { current: cur, target, prop: 'width' });
  if (!meterRaf) meterRaf = requestAnimationFrame(stepMeters);
}

/** Vertical meters (height) */
function setMeterHeight(el, pct) {
  if (!el) return;
  const target = Math.max(0, Math.min(100, pct || 0));
  const cur    = animMeters.get(el)?.current ?? target;
  animMeters.set(el, { current: cur, target, prop: 'height' });
  if (!meterRaf) meterRaf = requestAnimationFrame(stepMeters);
}

function stepMeters() {
  meterRaf = 0;
  let running = false;
  for (const [el, s] of animMeters) {
    if (!el.isConnected) { animMeters.delete(el); continue; }
    const d = s.target - s.current;
    if (Math.abs(d) <= 0.3) { s.current = s.target; }
    else { s.current += d * 0.28; running = true; }
    el.style[s.prop] = `${s.current.toFixed(2)}%`;
    if (s.current === s.target) animMeters.delete(el);
  }
  if (running || animMeters.size) meterRaf = requestAnimationFrame(stepMeters);
}

function routeMeterPct(v) {
  const raw = Math.max(0, Math.min(1, Number(v || 0)));
  if (raw <= 0.0005) return 0;
  const db = 20 * Math.log10(raw);
  return Math.round(Math.max(0, Math.min(100, Math.pow(Math.max(0, Math.min(1, (db + 48) / 48)), 0.72) * 100)));
}

/* ══════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════ */
function renderSel(sel, opts, selected, disabled, placeholder) {
  const html = [`<option value="">${placeholder}</option>`,
    ...(opts||[]).map(d => `<option value="${esc(d.id)}" ${d.id===selected?'selected':''}>${esc(d.displayName)}</option>`)
  ].join('');
  if (document.activeElement !== sel && !setTimer) sel.innerHTML = html;
  sel.disabled = disabled;
}

function isDirty(el) { return document.activeElement === el || setTimer !== null; }
function markInteract() { interactUntil = Date.now() + 900; }

function ensureSlot() {
  const outputs = state?.outputs || [];
  if (selectedSlot && !outputs.some(o => o.slotIndex === selectedSlot)) {
    selectedSlot = 0;
    localStorage.removeItem('nd.slot');
  }
}

function getCalEntries() {
  if (teleState?.recentCalibrationEntries?.length) {
    return teleState.recentCalibrationEntries.map(e => ({ time: e.time||'', text: e.text||'', tone: e.tone||'' }));
  }
  return (state?.logEntries||[])
    .filter(e => /Calibration|burst|stable/i.test(e.displayText))
    .slice(-5)
    .map(e => ({
      time: e.displayText.slice(0,8),
      text: e.displayText.replace(/^\d{2}:\d{2}:\d{2}\s+\[[A-Z]+\]\s*/,''),
      tone: /ERROR|fail/i.test(e.displayText)?'danger':/WARN/i.test(e.displayText)?'warn':'',
    }))
    .reverse();
}

async function copyLogs() {
  try { await navigator.clipboard.writeText(E.logOutput.textContent||''); toast('Logs copied.','success'); }
  catch { toast('Clipboard copy failed.'); }
}

function toast(msg, tone) {
  const t  = document.createElement('div');
  t.className = `toast ${tone||''}`.trim();
  const sp = document.createElement('span'); sp.className='toast-msg'; sp.textContent=msg;
  const xb = document.createElement('button'); xb.className='toast-x'; xb.textContent='×'; xb.setAttribute('aria-label','Dismiss');
  xb.onclick = () => t.remove();
  t.append(sp, xb);
  E.toastStack.appendChild(t);
  const timer = setTimeout(() => t.remove(), 4800);
  xb.addEventListener('click', () => clearTimeout(timer), { once:true });
}

function findRoute(slot) { return state?.outputs?.find(o => o.slotIndex === slot) || null; }
function titleCase(v)    { return String(v||'').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/\b\w/g,c=>c.toUpperCase()); }
function esc(v)          { return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;"); }

function chColor(i) {
  return ['#00e8b8','#60a5fa','#f59e0b','#f43f5e','#a78bfa','#34d399','#fb923c','#e879f9'][(i-1) % 8];
}

/* SSE endpoints → PascalCase; REST → camelCase. Normalize before processing. */
function normSse(data) {
  if (Array.isArray(data)) return data.map(normSse);
  if (data && typeof data === 'object') {
    return Object.fromEntries(Object.entries(data).map(([k,v]) => [k.charAt(0).toLowerCase()+k.slice(1), normSse(v)]));
  }
  return data;
}
