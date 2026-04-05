/* ===== MultiAudio Nouva v2-Codex — Mixer Console JS ===== */

const POLL_MS = 2000;
const SAFETY_MS = 1000;
const STALE_MS = 4000;
const TELE_STALE_MS = 2500;
const TELE_POLL_MS = 90;
const SETTINGS_DEBOUNCE_MS = 220;
const ROUTE_DEBOUNCE_MS = 140;
const HOLD_MS = 120;
const RETRY_MS = 1600;

let state = null;
let telemetryState = null;
let pollInFlight = false;
let telePollInFlight = false;
let settingsTimer = null;
let evStream = null;
let teleStream = null;
let fbTimer = null;
let telePollTimer = null;
let copyBuf = null;
let holdState = null;
let calibInFlight = false;
let lastStateAt = 0;
let lastTeleAt = 0;
const animatedMeters = new Map();
let meterAnimationFrame = 0;

const routeTimers = new Map();
const drafts = new Map();
const pending = new Set();
const diagOpen = new Set(jsonStore("v2_codex.diag", []));

const $ = id => document.getElementById(id);
const el = {
  startBtn: $("startBtn"), stopBtn: $("stopBtn"), calibrateBtn: $("calibrateBtn"),
  refreshBtn: $("refreshBtn"), addOutputBtn: $("addOutputBtn"),
  copyLogsBtn: $("copyLogsBtn"), enginePill: $("enginePill"), engineDetail: $("engineDetail"),
  inputSelect: $("inputSelect"), calibrationSelect: $("calibrationSelect"),
  testToneCheckbox: $("testToneCheckbox"),
  masterVolRange: $("masterVolRange"), masterVolValue: $("masterVolValue"),
  markerLevelRange: $("markerLevelRange"), markerLevelValue: $("markerLevelValue"),
  vuCapture: $("vuCapture"), vuRoom: $("vuRoom"),
  vuCapturePct: $("vuCapturePct"), vuRoomPct: $("vuRoomPct"),
  snapEngine: $("snapEngine"), snapAutoSync: $("snapAutoSync"),
  snapMaster: $("snapMaster"), snapLocked: $("snapLocked"), snapLow: $("snapLow"), snapFaulted: $("snapFaulted"),
  overviewSession: $("overviewSession"), overviewSessionText: $("overviewSessionText"),
  overviewCapture: $("overviewCapture"), overviewCaptureText: $("overviewCaptureText"),
  overviewCalibration: $("overviewCalibration"), overviewCalibrationText: $("overviewCalibrationText"),
  overviewMaster: $("overviewMaster"), overviewSync: $("overviewSync"),
  overviewLocked: $("overviewLocked"), overviewLow: $("overviewLow"), overviewFaulted: $("overviewFaulted"),
  configPathText: $("configPathText"),
  lastErrorBanner: $("lastErrorBanner"), lastErrorText: $("lastErrorText"),
  calTone: $("calTone"), calStage: $("calStage"), calMicHealth: $("calMicHealth"),
  calMicName: $("calMicName"), calGuidance: $("calGuidance"),
  calRoomFill: $("calRoomFill"), calRoomPct: $("calRoomPct"),
  calCaptureFill: $("calCaptureFill"), calCapturePct: $("calCapturePct"),
  calAttemptsMeta: $("calAttemptsMeta"), calAttemptsList: $("calAttemptsList"),
  watchMode: $("watchMode"), sessionMessage: $("sessionMessage"),
  captureMessage: $("captureMessage"), calibrationMessage: $("calibrationMessage"),
  logDrawer: $("logDrawer"), logDrawerToggle: $("logDrawerToggle"),
  logOutput: $("logOutput"), logCountLabel: $("logCountLabel"),
  channelStrips: $("channelStrips"), toastStack: $("toastStack"), zoomLevel: $("zoomLevel"),
};

// ===== ZOOM =====
const ZOOM_MIN = 80;
const ZOOM_MAX = 180;
const ZOOM_STEP = 10;
let zoomLevel = Number(localStorage.getItem("v2_codex.zoom")) || 100;

// ===== THEMES =====
const THEMES = ["midnight", "ember", "blueprint", "hologram"];
let currentTheme = localStorage.getItem("v2_codex.theme") || "midnight";
if (!THEMES.includes(currentTheme)) currentTheme = "midnight";

boot();

async function boot() {
  applyTheme();
  applyZoom();
  bindEvents();
  await refreshState(true);
  connectEv();
  connectTele();
  startTelePoll();
  setInterval(safety, SAFETY_MS);
}

function applyTheme() {
  document.body.className = currentTheme === "midnight" ? "v25-shell" : `v25-shell theme-${currentTheme}`;
  localStorage.setItem("v2_codex.theme", currentTheme);
  document.querySelectorAll(".theme-dot").forEach(b => b.classList.toggle("active", b.dataset.theme === currentTheme));
  if (state) renderStrips();
}

function applyZoom() {
  document.body.style.zoom = `${zoomLevel}%`;
  el.zoomLevel.textContent = zoomLevel;
  localStorage.setItem("v2_codex.zoom", zoomLevel);
}

function bindEvents() {
  el.startBtn.onclick = () => mutate(() => api("/api/start", { method: "POST" }));
  el.stopBtn.onclick = () => mutate(() => api("/api/stop", { method: "POST" }));
  el.refreshBtn.onclick = () => mutate(() => api("/api/refresh-devices", { method: "POST" }));
  el.addOutputBtn.onclick = () => mutate(() => api("/api/outputs", { method: "POST" }));
  el.calibrateBtn.onclick = handleCalibrate;
  el.copyLogsBtn.onclick = copyLogs;

  el.logDrawerToggle.onclick = () => {
    el.logDrawer.classList.toggle("open");
  };

  $("zoomIn").onclick = () => { zoomLevel = Math.min(ZOOM_MAX, zoomLevel + ZOOM_STEP); applyZoom(); };
  $("zoomOut").onclick = () => { zoomLevel = Math.max(ZOOM_MIN, zoomLevel - ZOOM_STEP); applyZoom(); };

  document.querySelectorAll(".theme-dot").forEach(b => {
    b.onclick = () => { currentTheme = b.dataset.theme; applyTheme(); };
  });

  const routeSelect = $("variantRouteSelect");
  const routeOpenBtn = $("openVariantRouteBtn");
  if (routeSelect && routeOpenBtn) {
  const savedRoute = localStorage.getItem("multiAudio.route") || "/v2/";
    if ([...routeSelect.options].some(option => option.value === savedRoute)) {
      routeSelect.value = savedRoute;
    }
    routeSelect.addEventListener("change", () => {
      localStorage.setItem("multiAudio.route", routeSelect.value);
    });
    routeOpenBtn.addEventListener("click", () => {
      localStorage.setItem("multiAudio.route", routeSelect.value);
      window.location.href = routeSelect.value;
    });
  }

  [el.inputSelect, el.calibrationSelect, el.testToneCheckbox, el.masterVolRange, el.markerLevelRange].forEach(c => {
    c.addEventListener("input", handleSettings);
    c.addEventListener("change", handleSettings);
  });

  document.querySelectorAll("[data-sync-mode]").forEach(b => {
    b.onclick = () => { if (!state) return; setSyncMode(b.dataset.syncMode); queueSettings(); };
  });

  el.channelStrips.addEventListener("input", handleChInput);
  el.channelStrips.addEventListener("change", handleChInput);
  el.channelStrips.addEventListener("click", handleChClick);
  el.channelStrips.addEventListener("pointerdown", handleChPointerDown);
  el.channelStrips.addEventListener("wheel", handleChWheel, { passive: false });
  el.channelStrips.addEventListener("keydown", handleChKey);
  document.addEventListener("pointerup", stopHold);
  document.addEventListener("pointercancel", stopHold);
}

// ===== SSE =====
function connectEv() {
  if (!window.EventSource) { startFb(); return; }
  if (evStream) evStream.close();
  evStream = new EventSource("/api/events");
  evStream.addEventListener("state", e => { stopFb(); try { lastStateAt = Date.now(); setState(JSON.parse(e.data)); } catch { startFb(); } });
  evStream.onopen = () => { lastStateAt = Date.now(); stopFb(); };
  evStream.onerror = () => { startFb(); setTimeout(() => { if (evStream?.readyState === 2) connectEv(); }, RETRY_MS); };
}

function connectTele() {
  if (!window.EventSource) return;
  if (teleStream) teleStream.close();
  teleStream = new EventSource("/api/telemetry");
  teleStream.addEventListener("telemetry", e => { try { lastTeleAt = Date.now(); setTelemetry(JSON.parse(e.data)); } catch {} });
  teleStream.onopen = () => { lastTeleAt = Date.now(); };
  teleStream.onerror = () => { setTimeout(() => { if (teleStream?.readyState === 2) connectTele(); }, RETRY_MS); };
}

function startFb() { if (fbTimer) return; fbTimer = setInterval(() => refreshState(), POLL_MS); }
function stopFb() { if (!fbTimer) return; clearInterval(fbTimer); fbTimer = null; }
function startTelePoll() { if (telePollTimer) return; telePollTimer = setInterval(() => refreshTele(), TELE_POLL_MS); }

async function refreshState(force) {
  if (pollInFlight) return;
  pollInFlight = true;
  try { lastStateAt = Date.now(); setState(await api("/api/state")); }
  catch (e) { if (force) toast(e.message || "Failed to load state."); }
  finally { pollInFlight = false; }
}

async function refreshTele(force) {
  if (telePollInFlight) return;
  if (!force && !(state?.isRunning || state?.isCalibrating)) return;
  telePollInFlight = true;
  try { lastTeleAt = Date.now(); setTelemetry(await api("/api/telemetry-state")); } catch {}
  finally { telePollInFlight = false; }
}

function safety() {
  if (Date.now() - lastStateAt > STALE_MS) refreshState(true);
  if (shouldTreatAsLive() && Date.now() - lastTeleAt > TELE_STALE_MS) connectTele();
}

// ===== API =====
async function api(path, opts = {}) {
  const res = await fetch(path, { method: opts.method || "GET", headers: { "Content-Type": "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((typeof data === "object" && (data.error || data.title || data.detail)) || data || "Failed.");
  return data;
}

async function mutate(fn) { try { setState(await fn()); } catch (e) { toast(e.message || "Failed."); } }

// ===== STATE =====
function setState(next) {
  if (!next) return;
  if (state && (next.stateRevision || 0) < (state.stateRevision || 0)) return;
  state = next;
  reconcileDrafts();
  render();
}

function setTelemetry(next) {
  if (!next) return;
  if (telemetryState && (next.telemetryRevision || 0) < (telemetryState.telemetryRevision || 0)) return;
  telemetryState = next;
  mergeTele(next);
  patchTele(next);
}

function mergeTele(f) {
  if (!state || !f) return;
  state.isRunning = !!f.isRunning; state.isCalibrating = !!f.isCalibrating;
  state.captureLevel = f.captureLevel || 0; state.roomMicLevel = f.roomMicLevel || 0;
  state.captureStatusText = f.captureStatusText || state.captureStatusText;
  state.sessionStatusMessage = f.sessionStatusMessage || state.sessionStatusMessage;
  state.calibrationStatusMessage = f.calibrationStatusMessage || state.calibrationStatusMessage;
  state.calibrationProgressMessage = f.calibrationProgressMessage || state.calibrationProgressMessage;
  for (const t of f.outputs || []) {
    const o = findRoute(t.slotIndex); if (!o) continue;
    o.meterLevel = t.meterLevel || 0; o.statusText = t.statusText || o.statusText;
    o.appliedVolumePercent = t.appliedVolumePercent ?? o.appliedVolumePercent ?? o.volumePercent ?? 0;
    o.delayMilliseconds = t.delayMilliseconds ?? o.delayMilliseconds ?? 0;
    o.effectiveDelayMilliseconds = t.effectiveDelayMilliseconds ?? o.effectiveDelayMilliseconds ?? o.delayMilliseconds ?? 0;
    o.syncConfidence = t.syncConfidence || 0; o.syncLockState = t.syncLockState || o.syncLockState;
    o.syncSummary = t.syncSummary || o.syncSummary; o.isMuted = !!t.isMuted; o.isSolo = !!t.isSolo;
  }
}

// ===== RENDER =====
function render() {
  if (!state) return;
  renderTransport();
  renderRack();
  renderOverview();
  renderStrips();
  renderCal();
  renderLogs();
}

function renderTransport() {
  const mode = currentMode();
  el.enginePill.className = `engine-pill ${mode}`;
  el.enginePill.textContent = modeLabel(mode).toUpperCase();
  el.engineDetail.textContent = state.sessionStatusMessage || "Session idle";
  el.startBtn.disabled = !state.canStart; el.stopBtn.disabled = !state.canStop;
  el.refreshBtn.disabled = !state.canRefreshDevices; el.addOutputBtn.disabled = !state.canAddOutput;
  el.calibrateBtn.title = state.isCalibrating ? "Cancel Calibration" : "Run Calibration";
  el.calibrateBtn.setAttribute("aria-label", state.isCalibrating ? "Cancel calibration" : "Run calibration");
  el.calibrateBtn.disabled = calibInFlight || (!state.canRunCalibration && !state.isCalibrating);
  setR(el.masterVolRange, state.masterVolumePercent);
  syncLabels();
}

function renderRack() {
  renderSel(el.inputSelect, state.inputDevices, state.selectedInputDeviceId, !state.canEditTopology, "Choose input...");
  renderSel(el.calibrationSelect, state.inputDevices, state.selectedCalibrationInputDeviceId, state.isCalibrating, "Choose mic...");
  if (!dirty(el.testToneCheckbox)) el.testToneCheckbox.checked = state.useTestTone;
  el.testToneCheckbox.disabled = !state.canEditTopology;
  setR(el.masterVolRange, state.masterVolumePercent); setR(el.markerLevelRange, state.markerLevelPercent);
  el.masterVolRange.disabled = state.isCalibrating; el.markerLevelRange.disabled = state.isCalibrating;
  syncLabels();
  document.querySelectorAll("[data-sync-mode]").forEach(b => { b.classList.toggle("active", b.dataset.syncMode === state.autoSyncMode); b.disabled = state.isCalibrating; });

  vu(el.vuCapture, state.captureLevel); vu(el.vuRoom, state.roomMicLevel);
  el.vuCapturePct.textContent = Math.round((state.captureLevel || 0) * 100);
  el.vuRoomPct.textContent = Math.round((state.roomMicLevel || 0) * 100);

  el.snapEngine.textContent = modeLabel(currentMode());
  el.snapAutoSync.textContent = titleCase(state.autoSyncMode);
  const master = state.outputs?.find(o => o.isTimingMaster);
  el.snapMaster.textContent = master ? `CH${master.slotIndex}` : "--";
  el.snapLocked.textContent = String(state.lockedOutputCount || state.lockedOutputsCount || 0);
  el.snapLow.textContent = String(state.lowConfidenceOutputCount || state.lowConfidenceOutputsCount || 0);
  el.snapFaulted.textContent = String(state.faultedOutputCount || state.faultedOutputsCount || 0);

  if (state.lastErrorMessage) { el.lastErrorBanner.classList.remove("hidden"); el.lastErrorText.textContent = state.lastErrorMessage; }
  else el.lastErrorBanner.classList.add("hidden");
}

function renderOverview() {
  const master = state.outputs?.find(o => o.isTimingMaster);
  el.overviewSession.textContent = modeLabel(currentMode());
  el.overviewSessionText.textContent = state.sessionStatusMessage || "Waiting for the engine to start.";
  el.overviewCapture.textContent = state.captureStatusText || "Idle";
  el.overviewCaptureText.textContent = selectedInputName();
  el.overviewCalibration.textContent = state.calibrationProgressMessage || "Calibration idle.";
  el.overviewCalibrationText.textContent = state.calibrationStatusMessage || "Ready when you are.";
  el.overviewMaster.textContent = master ? `CH${master.slotIndex}` : "--";
  el.overviewSync.textContent = `Sync mode ${titleCase(state.autoSyncMode)}`;
  el.overviewLocked.textContent = String(state.lockedOutputCount || state.lockedOutputsCount || 0);
  el.overviewLow.textContent = String(state.lowConfidenceOutputCount || state.lowConfidenceOutputsCount || 0);
  el.overviewFaulted.textContent = String(state.faultedOutputCount || state.faultedOutputsCount || 0);
  el.configPathText.textContent = state.configPath || "Loading...";
}

function renderStrips() {
  el.channelStrips.innerHTML = (state.outputs || []).map(o => renderStrip(mergeDraft(o))).join("");
}

function renderStrip(o) {
  const color = chColor(o.slotIndex);
  const dOpen = diagOpen.has(o.slotIndex);
  const pp = a => pending.has(`${o.slotIndex}:${a}`);
  const devOpts = [`<option value="">--</option>`, ...(state.playbackDevices || []).map(d =>
    `<option value="${esc(d.id)}" ${d.id === o.selectedDeviceId ? "selected" : ""}>${esc(d.displayName)}</option>`)].join("");

  return `<div class="ch-strip" data-slot="${o.slotIndex}" style="--ch-color:${color};--holo-delay:${holoDelay(o.slotIndex)}">
    <div class="ch-head">
      <span class="ch-number">CH ${o.slotIndex}</span>
      <div class="ch-name" title="${esc(o.selectedDeviceName)}">${esc(o.selectedDeviceName)}</div>
      <div class="ch-status">${esc(o.statusText)} · ${esc(o.syncSummary || "Manual")}</div>
      <div class="ch-pills">
        <span class="ch-pill ch-pill-sync ${esc(o.syncLockState)}">${esc(o.syncLockState)}</span>
        ${o.isTimingMaster ? '<span class="ch-pill ch-pill-master">MASTER</span>' : ""}
        ${o.isMuted ? '<span class="ch-pill ch-pill-muted">MUTE</span>' : ""}
        ${o.isSolo ? '<span class="ch-pill ch-pill-solo">SOLO</span>' : ""}
      </div>
    </div>
    <div class="ch-device"><select data-field="device" name="channel-${o.slotIndex}-device" aria-label="Playback device for channel ${o.slotIndex}" ${state.canEditTopology ? "" : "disabled"}>${devOpts}</select></div>
    <div class="ch-controls">
      <div class="ch-fld">
        <div class="ch-fld-head"><span class="ch-fld-label">VOL</span><span class="ch-fld-val">${Math.round(o.volumePercent)}</span></div>
        <input data-field="volume" name="channel-${o.slotIndex}-volume" aria-label="Volume for channel ${o.slotIndex}" type="range" min="0" max="100" step="1" value="${Math.round(o.volumePercent)}" class="ch-range" ${state.isCalibrating ? "disabled" : ""}>
        <span class="ch-fld-sub">Applied ${Math.round(o.appliedVolumePercent ?? o.volumePercent)}%</span>
      </div>
      <div class="ch-fld">
        <div class="ch-fld-head"><span class="ch-fld-label">DELAY</span><span class="ch-fld-val">${Math.round(o.delayMilliseconds)}<small>ms</small></span></div>
        <div class="ch-delay-row">
          <button class="ch-delay-step" data-action="step-delay" data-step="-1" aria-label="Decrease delay for channel ${o.slotIndex}" ${state.isCalibrating ? "disabled" : ""}>-</button>
          <input class="ch-delay-input" data-field="delay-number" name="channel-${o.slotIndex}-delay-number" aria-label="Delay value for channel ${o.slotIndex}" type="number" min="0" max="2000" step="1" value="${Math.round(o.delayMilliseconds)}" ${state.isCalibrating ? "disabled" : ""}>
          <button class="ch-delay-step" data-action="step-delay" data-step="1" aria-label="Increase delay for channel ${o.slotIndex}" ${state.isCalibrating ? "disabled" : ""}>+</button>
        </div>
        <input data-field="delay" name="channel-${o.slotIndex}-delay" aria-label="Delay slider for channel ${o.slotIndex}" type="range" min="0" max="2000" step="1" value="${Math.round(o.delayMilliseconds)}" class="ch-range" ${state.isCalibrating ? "disabled" : ""}>
        <span class="ch-fld-sub">Eff ${Math.round(o.effectiveDelayMilliseconds || o.delayMilliseconds)} ms</span>
      </div>
    </div>
    <div class="ch-meter">
      <div class="ch-meter-bar"><div class="ch-meter-fill" data-meter="${o.slotIndex}" style="width:${routeMeterPct(o.meterLevel)}%"></div></div>
      <div class="ch-meter-readout"><span data-pct="${o.slotIndex}">${routeMeterLabel(o.meterLevel)}</span><span data-lock="${o.slotIndex}">${esc(o.syncLockState)}</span></div>
    </div>
    <div class="ch-actions">
      <button class="ch-act ${o.isMuted ? "act-muted" : ""}" data-action="mute" ${state.isCalibrating||pp("mute")?"disabled":""}>${o.isMuted?"UNMUTE":"MUTE"}</button>
      <button class="ch-act ${o.isSolo ? "act-solo" : ""}" data-action="solo" ${state.isCalibrating||pp("solo")?"disabled":""}>${o.isSolo?"UNSOLO":"SOLO"}</button>
      <button class="ch-act" data-action="ping" ${!o.selectedDeviceId||state.isCalibrating||pp("ping")?"disabled":""}>${pp("ping")?"PINGING":"PING"}</button>
      <button class="ch-act" data-action="copy-settings">COPY</button>
      <button class="ch-act" data-action="paste-settings" ${copyBuf?"":"disabled"}>PASTE</button>
      <button class="ch-act ${o.isTimingMaster?"act-on":""}" data-action="make-master" ${state.isCalibrating||pp("make-master")?"disabled":""}>${o.isTimingMaster?"MASTER":"SET MASTER"}</button>
    </div>
    <button class="ch-diag-toggle" data-action="toggle-diagnostics">${dOpen ? "- DIAG" : "+ DIAG"}</button>
    <div class="ch-diag ${dOpen ? "open" : ""}">
      <div class="ch-diag-stat"><span>Buffer</span><strong>${Math.round(o.bufferedMilliseconds)} ms</strong></div>
      <div class="ch-diag-stat"><span>Conf</span><strong>${Math.round((o.syncConfidence||0)*100)}%</strong></div>
      <div class="ch-diag-stat"><span>Rate</span><strong>${Number(o.playbackRateRatio).toFixed(4)}x</strong></div>
      <div class="ch-diag-stat"><span>Arrival</span><strong>${Number(o.estimatedArrivalMilliseconds||0).toFixed(1)}</strong></div>
    </div>
    <div class="ch-footer">
      <button class="ch-act" data-action="remove" ${o.canRemove&&!pp("remove")?"":"disabled"}>${pp("remove")?"REMOVING":"REMOVE"}</button>
    </div>
  </div>`;
}

function renderCal() {
  const w = calModel(telemetryState || state);
  el.calTone.textContent = w.title;
  el.calStage.textContent = w.stage;
  el.calMicHealth.textContent = w.micHealth;
  el.calGuidance.textContent = w.guidance;
  el.calMicName.textContent = selectedCalibrationName();
  el.watchMode.textContent = modeLabel(currentMode()).toUpperCase();
  el.sessionMessage.textContent = state.sessionStatusMessage || "Ready";
  el.captureMessage.textContent = state.captureStatusText || "Idle";
  el.calibrationMessage.textContent = state.calibrationStatusMessage || "Calibration idle.";
  vu(el.calRoomFill, (telemetryState || state).roomMicLevel || 0);
  vu(el.calCaptureFill, (telemetryState || state).captureLevel || 0);
  el.calRoomPct.textContent = pct((telemetryState || state).roomMicLevel || 0);
  el.calCapturePct.textContent = pct((telemetryState || state).captureLevel || 0);
  const entries = getCalEntries();
  el.calAttemptsMeta.textContent = entries.length ? `${entries.length} recent events` : "No recent attempts";
  el.calAttemptsList.innerHTML = entries.length
    ? entries.map(e => `<div class="cal-ev ${e.tone}"><span class="cal-ev-time">${esc(e.time)}</span>${esc(e.text)}</div>`).join("")
    : `<p class="rack-cal-hint">Attempt-by-attempt calibration feedback will appear here.</p>`;
}

function renderLogs() {
  const lines = (state.logEntries || []).map(e => e.displayText);
  const errs = (state.logEntries || []).filter(e => /error|fail|exception/i.test(e.displayText)).length;
  el.logOutput.textContent = lines.length ? lines.join("\n") : "No log entries yet.";
  el.logCountLabel.textContent = errs > 0 ? `${lines.length} / ${errs}err` : String(lines.length);
}

// ===== TELEMETRY PATCH =====
function patchTele(f) {
  if (!f || !state) return;
  const mode = currentMode();
  el.enginePill.className = `engine-pill ${mode}`;
  el.enginePill.textContent = modeLabel(mode).toUpperCase();
  el.engineDetail.textContent = f.sessionStatusMessage || state.sessionStatusMessage || "Session idle";

  vu(el.vuCapture, f.captureLevel || 0); vu(el.vuRoom, f.roomMicLevel || 0);
  el.vuCapturePct.textContent = Math.round((f.captureLevel || 0) * 100);
  el.vuRoomPct.textContent = Math.round((f.roomMicLevel || 0) * 100);
  el.snapEngine.textContent = modeLabel(mode);
  renderOverview();

  for (const t of f.outputs || []) {
    const strip = el.channelStrips.querySelector(`[data-slot="${t.slotIndex}"]`);
    if (!strip) continue;
    const fill = strip.querySelector(`[data-meter="${t.slotIndex}"]`);
    const pctEl = strip.querySelector(`[data-pct="${t.slotIndex}"]`);
    const lockEl = strip.querySelector(`[data-lock="${t.slotIndex}"]`);
    if (fill) setMeterPercent(fill, routeMeterPct(t.meterLevel));
    if (pctEl) pctEl.textContent = routeMeterLabel(t.meterLevel);
    if (lockEl) lockEl.textContent = t.syncLockState || "Disabled";

    const status = strip.querySelector(".ch-status");
    if (status) status.textContent = `${t.statusText} · ${t.syncSummary || "Manual"}`;

    const subs = strip.querySelectorAll(".ch-fld-sub");
    if (subs[0]) subs[0].textContent = `Applied ${Math.round(t.appliedVolumePercent ?? t.volumePercent)}%`;
    if (subs[1]) subs[1].textContent = `Eff ${Math.round(t.effectiveDelayMilliseconds || t.delayMilliseconds)} ms`;

    if (!drafts.has(t.slotIndex)) {
      const dv = strip.querySelector(".ch-fld:nth-child(2) .ch-fld-val");
      const dn = strip.querySelector('[data-field="delay-number"]');
      const dr = strip.querySelector('[data-field="delay"]');
      if (dv) dv.innerHTML = `${Math.round(t.delayMilliseconds)}<small>ms</small>`;
      if (dn && document.activeElement !== dn) dn.value = Math.round(t.delayMilliseconds);
      if (dr && document.activeElement !== dr) dr.value = Math.round(t.delayMilliseconds);
    }
  }
  renderCal();
}

// ===== CHANNEL EVENT HANDLERS =====
function handleChInput(e) {
  const strip = e.target.closest("[data-slot]"); if (!strip) return;
  syncChLabel(strip, e.target.dataset.field); syncDraft(strip);
  queueRouteUpdate(strip, e.type === "change");
}

function handleChClick(e) {
  const btn = e.target.closest("[data-action]"); if (!btn) return;
  const strip = e.target.closest("[data-slot]"); if (!strip) return;
  const slot = +strip.dataset.slot; const action = btn.dataset.action;
  if (action === "step-delay") { if (e.detail === 0) nudge(strip, +btn.dataset.step); return; }
  if (action === "remove") { clearRT(slot); runAction(slot, action, () => api(`/api/outputs/${slot}`, { method: "DELETE" })); return; }
  if (action === "mute" || action === "solo") { clearRT(slot); const rb = optToggle(slot, action); runAction(slot, action, () => api(`/api/outputs/${slot}/${action}`, { method: "POST" }), rb); return; }
  if (action === "ping") { clearRT(slot); runAction(slot, action, () => api(`/api/outputs/${slot}/ping`, { method: "POST" })); return; }
  if (action === "make-master") { clearRT(slot); runAction(slot, action, () => api(`/api/outputs/${slot}`, { method: "PUT", body: chPayload(strip, true) })); return; }
  if (action === "copy-settings") { copyBuf = { v: +strip.querySelector('[data-field="volume"]').value, d: +strip.querySelector('[data-field="delay"]').value }; renderStrips(); toast("Copied.", "success"); return; }
  if (action === "paste-settings" && copyBuf) {
    strip.querySelector('[data-field="volume"]').value = copyBuf.v;
    strip.querySelector('[data-field="delay"]').value = copyBuf.d;
    strip.querySelector('[data-field="delay-number"]').value = copyBuf.d;
    syncChLabel(strip); syncDraft(strip); clearRT(slot);
    mutate(() => api(`/api/outputs/${slot}`, { method: "PUT", body: chPayload(strip, false) })); return;
  }
  if (action === "toggle-diagnostics") { if (diagOpen.has(slot)) diagOpen.delete(slot); else diagOpen.add(slot); localStorage.setItem("v2_codex.diag", JSON.stringify([...diagOpen])); renderStrips(); }
}

function handleChPointerDown(e) {
  const s = e.target.closest('[data-action="step-delay"]'); if (!s || e.button || s.disabled) return;
  const strip = e.target.closest("[data-slot]"); if (!strip) return;
  e.preventDefault(); startHold(strip, +s.dataset.step);
}

function handleChWheel(e) {
  const inp = e.target.closest('[data-field="delay"],[data-field="delay-number"]'); if (!inp) return;
  e.preventDefault(); const strip = e.target.closest("[data-slot]"); if (strip) nudge(strip, e.deltaY < 0 ? 1 : -1);
}

function handleChKey(e) {
  const inp = e.target.closest('[data-field="delay"],[data-field="delay-number"]'); if (!inp) return;
  let d = 0;
  if (e.key === "ArrowUp" || e.key === "ArrowRight") d = e.shiftKey ? 10 : 1;
  else if (e.key === "ArrowDown" || e.key === "ArrowLeft") d = e.shiftKey ? -10 : -1;
  if (!d) return; e.preventDefault(); const strip = e.target.closest("[data-slot]"); if (strip) nudge(strip, d);
}

// ===== SETTINGS =====
function handleSettings() { if (!state) return; syncLabels(); queueSettings(); }

function handleCalibrate() {
  if (!state || calibInFlight) return;
  state.isCalibrating ? cancelCal() : startCal();
}

async function startCal() {
  calibInFlight = true;
  applyOptimisticCalibrationState("Preparing route measurements...", "Calibration starting...");
  renderTransport();
  try { const r = api("/api/calibrate", { method: "POST" }); setTimeout(() => { refreshState(true); refreshTele(true); }, 60); setState(await r); }
  catch (e) { toast(e.message); await refreshState(true); }
  finally { calibInFlight = false; renderTransport(); }
}

async function cancelCal() {
  calibInFlight = true;
  applyOptimisticCalibrationState("Stopping the active calibration run...", "Stopping calibration...");
  renderTransport();
  try { setState(await api("/api/calibrate/cancel", { method: "POST" })); refreshTele(true); }
  catch (e) { toast(e.message); await refreshState(true); }
  finally { calibInFlight = false; renderTransport(); }
}

function applyOptimisticCalibrationState(progress, session) {
  if (!state) return;
  state.isCalibrating = true;
  state.canRefreshDevices = false;
  state.canAddOutput = false;
  state.canEditTopology = false;
  state.calibrationStatusMessage = progress;
  state.calibrationProgressMessage = progress;
  state.sessionStatusMessage = session;
  renderTransport();
  renderOverview();
  renderCal();
}

function queueSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => { settingsTimer = null; mutate(() => api("/api/settings", { method: "PUT", body: settingsPayload() })); }, SETTINGS_DEBOUNCE_MS);
}

function queueRouteUpdate(strip, imm) {
  const slot = +strip.dataset.slot;
  const send = () => mutate(() => api(`/api/outputs/${slot}`, { method: "PUT", body: chPayload(strip, false) }));
  clearRT(slot);
  if (imm) { send(); return; }
  routeTimers.set(slot, setTimeout(() => { routeTimers.delete(slot); send(); }, ROUTE_DEBOUNCE_MS));
}

function clearRT(s) { const t = routeTimers.get(s); if (t) { clearTimeout(t); routeTimers.delete(s); } }

function startHold(strip, step) { stopHold(); if (!step) return; nudge(strip, step); holdState = { id: setInterval(() => nudge(strip, step), HOLD_MS) }; }
function stopHold() { if (!holdState) return; clearInterval(holdState.id); holdState = null; }

function nudge(strip, d) {
  const dr = strip.querySelector('[data-field="delay"]'), dn = strip.querySelector('[data-field="delay-number"]');
  if (!dr || !dn) return;
  const n = clamp(+dr.value + d, 0, 2000); if (n === +dr.value) return;
  dr.value = n; dn.value = n; syncChLabel(strip); syncDraft(strip); queueRouteUpdate(strip, true);
}

function settingsPayload() {
  return { selectedInputDeviceId: norm(el.inputSelect.value), selectedCalibrationInputDeviceId: norm(el.calibrationSelect.value),
    useTestTone: el.testToneCheckbox.checked, masterVolumePercent: +el.masterVolRange.value,
    autoSyncMode: (document.querySelector("[data-sync-mode].active")?.dataset.syncMode) || "MonitorOnly",
    markerLevelPercent: +el.markerLevelRange.value };
}

function chPayload(strip, fm) {
  return { selectedDeviceId: norm(strip.querySelector('[data-field="device"]')?.value),
    volumePercent: +(strip.querySelector('[data-field="volume"]')?.value),
    delayMilliseconds: +(strip.querySelector('[data-field="delay"]')?.value),
    isTimingMaster: fm || findRoute(+strip.dataset.slot)?.isTimingMaster || false };
}

async function runAction(slot, action, req, rb) {
  const k = `${slot}:${action}`; if (pending.has(k)) return;
  pending.add(k); renderStrips();
  try { setState(await req()); } catch (e) { rb?.(); toast(e.message || "Failed."); }
  finally { pending.delete(k); renderStrips(); }
}

function optToggle(slot, action) {
  const o = findRoute(slot); if (!o) return null;
  const prev = { isMuted: o.isMuted, isSolo: o.isSolo };
  if (action === "mute") o.isMuted = !o.isMuted;
  if (action === "solo") o.isSolo = !o.isSolo;
  renderStrips();
  return () => { o.isMuted = prev.isMuted; o.isSolo = prev.isSolo; renderStrips(); };
}

// ===== DRAFTS =====
function syncDraft(strip) {
  drafts.set(+strip.dataset.slot, { selectedDeviceId: norm(strip.querySelector('[data-field="device"]')?.value),
    volumePercent: +(strip.querySelector('[data-field="volume"]')?.value),
    delayMilliseconds: +(strip.querySelector('[data-field="delay"]')?.value) });
}

function reconcileDrafts() {
  if (!state) return;
  const valid = new Set(state.outputs.map(o => o.slotIndex));
  for (const [s, d] of drafts) {
    if (!valid.has(s)) { drafts.delete(s); continue; }
    const o = findRoute(s); if (!o) { drafts.delete(s); continue; }
    if (norm(d.selectedDeviceId) === norm(o.selectedDeviceId) && +d.volumePercent === +o.volumePercent && +d.delayMilliseconds === +o.delayMilliseconds) drafts.delete(s);
  }
}

function mergeDraft(o) { const d = drafts.get(o.slotIndex); return d ? { ...o, ...d } : o; }

// ===== HELPERS =====
function renderSel(el, opts, sel, dis, ph) {
  const h = [`<option value="">${ph}</option>`, ...(opts||[]).map(d => `<option value="${esc(d.id)}" ${d.id===sel?"selected":""}>${esc(d.displayName)}</option>`)].join("");
  if (!dirty(el)) el.innerHTML = h; el.disabled = dis;
}

function setR(el, v) { if (!dirty(el)) el.value = v; }
function dirty(el) { return document.activeElement === el || settingsTimer !== null; }
function syncLabels() { el.masterVolValue.textContent = Math.round(+el.masterVolRange.value); el.markerLevelValue.textContent = (+el.markerLevelRange.value).toFixed(1) + "%"; }
function setSyncMode(m) { document.querySelectorAll("[data-sync-mode]").forEach(b => b.classList.toggle("active", b.dataset.syncMode === m)); }

function syncChLabel(strip, changed) {
  const vol = strip.querySelector('[data-field="volume"]'), delay = strip.querySelector('[data-field="delay"]'), dn = strip.querySelector('[data-field="delay-number"]');
  const vals = strip.querySelectorAll(".ch-fld-val");
  if (changed === "delay-number" && delay && dn) { delay.value = clamp(+dn.value, 0, 2000); dn.value = delay.value; }
  if (changed === "delay" && delay && dn) dn.value = delay.value;
  if (vals[0] && vol) vals[0].textContent = Math.round(+vol.value);
  if (vals[1] && delay) vals[1].innerHTML = `${Math.round(+delay.value)}<small>ms</small>`;
}

function vu(el, v) { setMeterPercent(el, Number(v || 0) * 100); }
function setMeterPercent(el, percent) {
  if (!el) return;
  const target = Math.max(0, Math.min(100, Number(percent || 0)));
  const current = animatedMeters.get(el)?.current ?? target;
  animatedMeters.set(el, { current, target });
  if (!meterAnimationFrame) meterAnimationFrame = requestAnimationFrame(stepMeters);
}
function stepMeters() {
  meterAnimationFrame = 0;
  let keepRunning = false;
  for (const [el, stateEntry] of animatedMeters) {
    if (!el.isConnected) {
      animatedMeters.delete(el);
      continue;
    }
    const delta = stateEntry.target - stateEntry.current;
    if (Math.abs(delta) <= 0.35) {
      stateEntry.current = stateEntry.target;
    } else {
      stateEntry.current += delta * 0.28;
      keepRunning = true;
    }
    el.style.width = `${stateEntry.current.toFixed(2)}%`;
    if (stateEntry.current === stateEntry.target) {
      animatedMeters.delete(el);
    }
  }
  if (keepRunning || animatedMeters.size) meterAnimationFrame = requestAnimationFrame(stepMeters);
}
function routeMeterDisplay(v) {
  const raw = Math.max(0, Math.min(1, Number(v || 0)));
  if (raw <= 0.0005) return 0;
  const db = 20 * Math.log10(raw);
  const normalized = Math.max(0, Math.min(1, (db + 48) / 48));
  return Math.max(0, Math.min(1, Math.pow(normalized, 0.72)));
}
function routeMeterPct(v) { return Math.round(routeMeterDisplay(v) * 100); }
function routeMeterLabel(v) { return `${routeMeterPct(v)}%`; }
async function copyLogs() { try { await navigator.clipboard.writeText(el.logOutput.textContent || ""); toast("Copied.", "success"); } catch { toast("Failed."); } }

function toast(msg, tone) {
  const t = document.createElement("div"); t.className = `toast ${tone||""}`.trim(); t.textContent = msg;
  el.toastStack.appendChild(t); setTimeout(() => t.remove(), 4800);
}

function calModel(src) {
  const stage = src?.calibrationProgressMessage || src?.calibrationStatusMessage || "Idle";
  const room = src?.roomMicLevel || 0; const status = String(src?.calibrationStatusMessage || "");
  if (src?.isCalibrating) {
    if (room >= 0.92) return { title: "TOO HOT", stage, micHealth: "Overloaded", guidance: "Lower mic gain." };
    if (room >= 0.08) return { title: "GOOD", stage, micHealth: "Usable", guidance: "Signal is clear." };
    if (room >= 0.025) return { title: "WEAK", stage, micHealth: "Weak", guidance: "May be unreliable." };
    return { title: "QUIET", stage, micHealth: "Low", guidance: "Raise volume or move mic." };
  }
  if (/failed/i.test(status)) return { title: "FAILED", stage, micHealth: "Adjust", guidance: state?.lastErrorMessage || "No arrivals detected." };
  if (/applied|complete/i.test(status)) return { title: "DONE", stage, micHealth: "OK", guidance: "Delays applied." };
  return { title: "READY", stage, micHealth: "Idle", guidance: "Start calibration to measure delays." };
}

function getCalEntries() {
  if (telemetryState?.recentCalibrationEntries?.length) return telemetryState.recentCalibrationEntries.map(e => ({ time: e.time || "", text: e.text || "", tone: e.tone || "" }));
  return (state?.logEntries || []).filter(e => /Calibration|burst|stable/i.test(e.displayText)).slice(-6)
    .map(e => ({ time: e.displayText.slice(0,8), text: e.displayText.replace(/^\d{2}:\d{2}:\d{2}\s+\[[A-Z]+\]\s*/,""), tone: /ERROR|fail/i.test(e.displayText)?"danger":/WARN/i.test(e.displayText)?"warn":"" })).reverse();
}

function currentMode() {
  if (state?.isCalibrating || telemetryState?.isCalibrating) return "calibrating";
  if (state?.isRunning || telemetryState?.isRunning) return "live";
  return "offline";
}

function modeLabel(mode) {
  if (mode === "calibrating") return "Calibrating";
  if (mode === "live") return "Streaming";
  return "Offline";
}

function shouldTreatAsLive() {
  return currentMode() !== "offline";
}

function selectedInputName() {
  return state?.inputDevices?.find(d => d.id === state?.selectedInputDeviceId)?.displayName || "Not selected";
}

function selectedCalibrationName() {
  return state?.inputDevices?.find(d => d.id === state?.selectedCalibrationInputDeviceId)?.displayName || "Not selected";
}

function pct(v) {
  return `${Math.round((v || 0) * 100)}%`;
}

function findRoute(s) { return state?.outputs?.find(o => o.slotIndex === s) || null; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function norm(v) { return v || null; }
function titleCase(v) { return String(v||"").replace(/([a-z])([A-Z])/g,"$1 $2").replace(/\b\w/g,c=>c.toUpperCase()); }
function chColor(i) {
  const palettes = {
    midnight:  ["#4ea8ff","#00e5a0","#ff8a3d","#ff4d6a","#ffcc00","#a78bfa","#f472b6","#34d399"],
    ember:     ["#f97316","#ef4444","#fbbf24","#fb923c","#f59e0b","#dc2626","#d97706","#ea580c"],
    blueprint: ["#2970ff","#ff3b3b","#2970ff","#ff3b3b","#2970ff","#ff3b3b","#2970ff","#ff3b3b"],
    hologram:  ["#ff6baa","#ffb86b","#ffe76b","#6bffb8","#6bb8ff","#b86bff","#ff6bda","#6bfff0"],
  };
  const colors = palettes[currentTheme] || palettes.midnight;
  return colors[(i-1)%colors.length];
}
function holoDelay(i) { return `${(((i - 1) % 8) * -0.55).toFixed(2)}s`; }
function jsonStore(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } }
function esc(v) { return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;"); }
