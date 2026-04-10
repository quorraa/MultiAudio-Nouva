const POLL_MS = 2000;
const SAFETY_MS = 1000;
const STALE_MS = 4000;
const TELE_STALE_MS = 2500;
const TELE_POLL_MS = 90;
const INTERACT_PAUSE_MS = 900;
const SETTINGS_DEBOUNCE_MS = 220;
const ROUTE_DEBOUNCE_MS = 140;
const HOLD_MS = 120;
const RETRY_MS = 1600;

let state = null;
let telemetryState = null;
let pollInFlight = false;
let telePollInFlight = false;
let interactionPauseUntil = 0;
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
let selectedSlot = Number(localStorage.getItem("v2Tactile.selectedSlot")) || 0;
let layoutLocked = readBool("v2Tactile.layoutLocked", true);
let railScale = clamp(Number(localStorage.getItem("v2Tactile.railScale")) || 1.85, 0.72, 1.85);
let resizeState = null;
let stripDragState = null;
const animatedMeters = new Map();
let meterAnimationFrame = 0;

const routeTimers = new Map();
const drafts = new Map();
const pending = new Set();
const BASE_LEFT_PANEL = 188;
const BASE_RIGHT_PANEL = 212;
const BASE_PANEL_TOTAL = BASE_LEFT_PANEL + BASE_RIGHT_PANEL;

const $ = (id) => document.getElementById(id);
const el = {
  startBtn: $("startBtn"),
  stopBtn: $("stopBtn"),
  calibrateBtn: $("calibrateBtn"),
  refreshBtn: $("refreshBtn"),
  addOutputBtn: $("addOutputBtn"),
  copyLogsBtn: $("copyLogsBtn"),
  enginePill: $("enginePill"),
  inputSelect: $("inputSelect"),
  calibrationSelect: $("calibrationSelect"),
  testToneCheckbox: $("testToneCheckbox"),
  masterVolRange: $("masterVolRange"),
  masterVolValue: $("masterVolValue"),
  layoutLockBtn: $("layoutLockBtn"),
  markerLevelRange: $("markerLevelRange"),
  markerLevelValue: $("markerLevelValue"),
  engineReadout: $("engineReadout"),
  vuCapture: $("vuCapture"),
  vuRoom: $("vuRoom"),
  vuCapturePct: $("vuCapturePct"),
  vuRoomPct: $("vuRoomPct"),
  snapEngine: $("snapEngine"),
  snapAutoSync: $("snapAutoSync"),
  snapMaster: $("snapMaster"),
  snapLocked: $("snapLocked"),
  lastErrorBanner: $("lastErrorBanner"),
  lastErrorText: $("lastErrorText"),
  calTitle: $("calTitle"),
  calMicHealth: $("calMicHealth"),
  calGuidance: $("calGuidance"),
  calAttemptsList: $("calAttemptsList"),
  channelStrips: $("channelStrips"),
  roomScopeNodes: $("roomScopeNodes"),
  selectedChannelTape: $("selectedChannelTape"),
  selectedChannelStatus: $("selectedChannelStatus"),
  selectedChannelName: $("selectedChannelName"),
  selectedChannelDevice: $("selectedChannelDevice"),
  selectedDeviceSelect: $("selectedDeviceSelect"),
  selectedLatencyValue: $("selectedLatencyValue"),
  selectedLatencyMeter: $("selectedLatencyMeter"),
  selectedBufferValue: $("selectedBufferValue"),
  selectedBufferMeter: $("selectedBufferMeter"),
  selectedConfidenceValue: $("selectedConfidenceValue"),
  selectedConfidenceMeter: $("selectedConfidenceMeter"),
  selectedRateValue: $("selectedRateValue"),
  selectedRateMeter: $("selectedRateMeter"),
  selectedVolumeRange: $("selectedVolumeRange"),
  selectedVolumeValue: $("selectedVolumeValue"),
  selectedDelayMinusBtn: $("selectedDelayMinusBtn"),
  selectedDelayPlusBtn: $("selectedDelayPlusBtn"),
  selectedDelayNumber: $("selectedDelayNumber"),
  selectedDelayRange: $("selectedDelayRange"),
  selectedDelayValue: $("selectedDelayValue"),
  selectedDelayFoot: $("selectedDelayFoot"),
  selectedMuteBtn: $("selectedMuteBtn"),
  selectedSoloBtn: $("selectedSoloBtn"),
  selectedPingBtn: $("selectedPingBtn"),
  selectedCopyBtn: $("selectedCopyBtn"),
  selectedPasteBtn: $("selectedPasteBtn"),
  selectedMasterBtn: $("selectedMasterBtn"),
  selectedRemoveBtn: $("selectedRemoveBtn"),
  leftResizeHandle: $("leftResizeHandle"),
  rightResizeHandle: $("rightResizeHandle"),
  sessionStatus: $("sessionStatus"),
  captureStatus: $("captureStatus"),
  calibrationStatus: $("calibrationStatus"),
  openConfigFolderBtn: $("openConfigFolderBtn"),
  logOutput: $("logOutput"),
  logCountLabel: $("logCountLabel"),
  toastStack: $("toastStack")
};

boot();

async function boot() {
  applyRailLayout();
  bindEvents();
  await refreshState(true);
  connectEv();
  connectTele();
  startTelePoll();
  setInterval(safety, SAFETY_MS);
}

function bindEvents() {
  el.startBtn.onclick = () => mutate(() => api("/api/start", { method: "POST" }));
  el.stopBtn.onclick = () => mutate(() => api("/api/stop", { method: "POST" }));
  el.refreshBtn.onclick = () => mutate(() => api("/api/refresh-devices", { method: "POST" }));
  el.addOutputBtn.onclick = () => mutate(() => api("/api/outputs", { method: "POST" }));
  el.calibrateBtn.onclick = handleCalibrate;
  el.copyLogsBtn.onclick = copyLogs;
  el.openConfigFolderBtn.onclick = () => mutate(() => api("/api/open-config-folder", { method: "POST" }));
  el.layoutLockBtn.onclick = toggleLayoutLock;
  bindRoutePicker();

  [el.inputSelect, el.calibrationSelect, el.testToneCheckbox, el.masterVolRange, el.markerLevelRange].forEach((control) => {
    control.addEventListener("input", handleSettings);
    control.addEventListener("change", handleSettings);
  });

  [el.selectedDeviceSelect, el.selectedVolumeRange, el.selectedDelayNumber, el.selectedDelayRange].forEach((control) => {
    control.addEventListener("input", handleSelectedRouteInput);
    control.addEventListener("change", handleSelectedRouteInput);
  });
  el.selectedDelayMinusBtn.addEventListener("click", () => nudgeSelectedRoute(-1));
  el.selectedDelayPlusBtn.addEventListener("click", () => nudgeSelectedRoute(1));
  el.selectedMuteBtn.addEventListener("click", () => triggerSelectedAction("mute"));
  el.selectedSoloBtn.addEventListener("click", () => triggerSelectedAction("solo"));
  el.selectedPingBtn.addEventListener("click", () => triggerSelectedAction("ping"));
  el.selectedCopyBtn.addEventListener("click", handleSelectedCopy);
  el.selectedPasteBtn.addEventListener("click", handleSelectedPaste);
  el.selectedMasterBtn.addEventListener("click", () => triggerSelectedAction("make-master"));
  el.selectedRemoveBtn.addEventListener("click", () => triggerSelectedAction("remove"));

  document.querySelectorAll("[data-sync-mode]").forEach((button) => {
    button.onclick = () => {
      if (!state) {
        return;
      }
      markInteract();
      setSyncMode(button.dataset.syncMode);
      queueSettings();
    };
  });

  el.channelStrips.addEventListener("input", handleChInput);
  el.channelStrips.addEventListener("change", handleChInput);
  el.channelStrips.addEventListener("click", handleChClick);
  el.channelStrips.addEventListener("pointerdown", handleChPointerDown);
  el.channelStrips.addEventListener("pointerup", handleStripPointerUp);
  el.channelStrips.addEventListener("pointercancel", handleStripPointerUp);
  el.channelStrips.addEventListener("wheel", handleChWheel, { passive: false });
  el.channelStrips.addEventListener("keydown", handleChKey);
  document.addEventListener("pointerup", stopHold);
  document.addEventListener("pointerup", handleStripPointerUp);
  document.addEventListener("pointercancel", stopHold);
  document.addEventListener("pointercancel", handleStripPointerUp);
  el.roomScopeNodes.addEventListener("click", handleScopeClick);
  el.leftResizeHandle.addEventListener("pointerdown", (event) => beginRailResize(event, "left"));
  el.rightResizeHandle.addEventListener("pointerdown", (event) => beginRailResize(event, "right"));
  document.addEventListener("pointermove", handleStripPointerMove);
  document.addEventListener("pointermove", handleRailResizeMove);
  document.addEventListener("pointerup", endRailResize);
  document.addEventListener("pointercancel", endRailResize);
}

function bindRoutePicker() {
  const routeSelect = $("variantRouteSelect");
  const routeOpenBtn = $("openVariantRouteBtn");
  if (!routeSelect || !routeOpenBtn) {
    return;
  }
  const savedRoute = localStorage.getItem("multiAudio.route") || "/v2/";
  if ([...routeSelect.options].some((option) => option.value === savedRoute)) {
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

function connectEv() {
  if (!window.EventSource) {
    startFb();
    return;
  }
  if (evStream) {
    evStream.close();
  }
  evStream = new EventSource("/api/events");
  evStream.addEventListener("state", (event) => {
    stopFb();
    try {
      lastStateAt = Date.now();
      setState(normalizeSsePayload(JSON.parse(event.data)));
    } catch {
      startFb();
    }
  });
  evStream.onopen = () => {
    lastStateAt = Date.now();
    stopFb();
  };
  evStream.onerror = () => {
    startFb();
    setTimeout(() => {
      if (evStream?.readyState === 2) {
        connectEv();
      }
    }, RETRY_MS);
  };
}

function connectTele() {
  if (!window.EventSource) {
    return;
  }
  if (teleStream) {
    teleStream.close();
  }
  teleStream = new EventSource("/api/telemetry");
  teleStream.addEventListener("telemetry", (event) => {
    try {
      lastTeleAt = Date.now();
      setTelemetry(normalizeSsePayload(JSON.parse(event.data)));
    } catch {
      // ignore malformed telemetry frame
    }
  });
  teleStream.onopen = () => {
    lastTeleAt = Date.now();
  };
  teleStream.onerror = () => {
    setTimeout(() => {
      if (teleStream?.readyState === 2) {
        connectTele();
      }
    }, RETRY_MS);
  };
}

function startFb() {
  if (fbTimer) {
    return;
  }
  fbTimer = setInterval(() => refreshState(), POLL_MS);
}

function stopFb() {
  if (!fbTimer) {
    return;
  }
  clearInterval(fbTimer);
  fbTimer = null;
}

function startTelePoll() {
  if (telePollTimer) {
    return;
  }
  telePollTimer = setInterval(() => refreshTele(), TELE_POLL_MS);
}

async function refreshState(force) {
  if (pollInFlight) {
    return;
  }
  if (!force && Date.now() < interactionPauseUntil) {
    return;
  }
  pollInFlight = true;
  try {
    lastStateAt = Date.now();
    setState(await api("/api/state"));
  } catch (error) {
    toast(error.message || "Failed to load state.");
  } finally {
    pollInFlight = false;
  }
}

async function refreshTele(force) {
  if (telePollInFlight) {
    return;
  }
  if (!force && !(state?.isRunning || state?.isCalibrating)) {
    return;
  }
  telePollInFlight = true;
  try {
    lastTeleAt = Date.now();
    setTelemetry(await api("/api/telemetry-state"));
  } catch {
    // handled by retry loops
  } finally {
    telePollInFlight = false;
  }
}

function safety() {
  if (!window.EventSource) {
    return;
  }
  if (Date.now() - lastStateAt > STALE_MS) {
    refreshState(true);
  }
  if ((state?.isRunning || state?.isCalibrating) && Date.now() - lastTeleAt > TELE_STALE_MS) {
    connectTele();
  }
}

async function api(path, opts = {}) {
  const response = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error((typeof payload === "object" && (payload.error || payload.title || payload.detail)) || payload || "Request failed.");
  }
  return payload;
}

async function mutate(fn) {
  try {
    setState(await fn());
  } catch (error) {
    toast(error.message || "Request failed.");
  }
}

function setState(next) {
  if (!next) {
    return;
  }
  if (state && (next.stateRevision || 0) < (state.stateRevision || 0)) {
    return;
  }
  state = next;
  // Re-apply the last known telemetry into the fresh state snapshot so that
  // renderStrips() and renderRack() use telemetry-consistent values (syncLockState,
  // captureLevel, per-route metrics etc.) without waiting for the next telemetry tick.
  if (telemetryState) mergeTele(telemetryState);
  // isRunning / isCalibrating must come from the state snapshot — it is the
  // authoritative source for engine lifecycle. mergeTele() overwrites them with the
  // telemetry frame values which can be stale (e.g. from before the engine started),
  // causing the engine pill to show OFFLINE even when streaming is active.
  state.isRunning = next.isRunning;
  state.isCalibrating = next.isCalibrating;
  reconcileDrafts();
  ensureSelectedRoute();
  render();
}

function setTelemetry(next) {
  if (!next) {
    return;
  }
  if (telemetryState && (next.telemetryRevision || 0) < (telemetryState.telemetryRevision || 0)) {
    return;
  }
  telemetryState = next;
  mergeTele(next);
  patchTele(next);
}

function mergeTele(frame) {
  if (!state || !frame) {
    return;
  }
  state.isRunning = !!frame.isRunning;
  state.isCalibrating = !!frame.isCalibrating;
  state.captureLevel = frame.captureLevel || 0;
  state.roomMicLevel = frame.roomMicLevel || 0;
  state.captureStatusText = frame.captureStatusText || state.captureStatusText;
  state.sessionStatusMessage = frame.sessionStatusMessage || state.sessionStatusMessage;
  state.calibrationStatusMessage = frame.calibrationStatusMessage || state.calibrationStatusMessage;
  state.calibrationProgressMessage = frame.calibrationProgressMessage || state.calibrationProgressMessage;
  for (const teleOut of frame.outputs || []) {
    const output = findRoute(teleOut.slotIndex);
    if (!output) {
      continue;
    }
    output.meterLevel = teleOut.meterLevel || 0;
    output.statusText = teleOut.statusText || output.statusText;
    output.appliedVolumePercent = teleOut.appliedVolumePercent ?? output.appliedVolumePercent ?? output.volumePercent ?? 0;
    output.delayMilliseconds = teleOut.delayMilliseconds ?? output.delayMilliseconds ?? 0;
    output.effectiveDelayMilliseconds = teleOut.effectiveDelayMilliseconds ?? output.effectiveDelayMilliseconds ?? output.delayMilliseconds ?? 0;
    output.syncConfidence = teleOut.syncConfidence || 0;
    output.syncLockState = (typeof teleOut.syncLockState === 'string' && teleOut.syncLockState) ? teleOut.syncLockState : output.syncLockState;
    output.syncSummary = teleOut.syncSummary || output.syncSummary;
    output.isMuted = !!teleOut.isMuted;
    output.isSolo = !!teleOut.isSolo;
    output.bufferedMilliseconds = teleOut.bufferedMilliseconds ?? output.bufferedMilliseconds ?? 0;
    output.playbackRateRatio = teleOut.playbackRateRatio ?? output.playbackRateRatio ?? 1;
    output.estimatedArrivalMilliseconds = teleOut.estimatedArrivalMilliseconds ?? output.estimatedArrivalMilliseconds ?? 0;
  }
}

function render() {
  if (!state) {
    return;
  }
  renderTransport();
  renderRack();
  if (!shouldDeferStripRender()) {
    renderStrips();
  }
  renderScope();
  renderSelectedPanel();
  renderCalibration();
  renderLogs();
}

function renderTransport() {
  const mode = state.isCalibrating ? "calibrating" : state.isRunning ? "live" : "offline";
  el.enginePill.className = `engine-pill ${mode}`;
  el.enginePill.textContent = mode.toUpperCase();
  el.engineReadout.textContent = state.isCalibrating ? "CAL" : state.isRunning ? "STRM" : "STOP";
  el.startBtn.disabled = !state.canStart;
  el.stopBtn.disabled = !state.canStop;
  el.refreshBtn.disabled = !state.canRefreshDevices;
  el.addOutputBtn.disabled = !state.canAddOutput;
  el.calibrateBtn.textContent = state.isCalibrating ? "Cancel" : "Calibrate";
  el.calibrateBtn.disabled = calibInFlight || (!state.canRunCalibration && !state.isCalibrating);
  setRange(el.masterVolRange, state.masterVolumePercent);
  el.masterVolRange.disabled = state.isCalibrating;
  el.masterVolValue.textContent = Math.round(+el.masterVolRange.value);
}

function renderRack() {
  renderSelect(el.inputSelect, state.inputDevices, state.selectedInputDeviceId, !state.canEditTopology, "Choose input...");
  renderSelect(el.calibrationSelect, state.inputDevices, state.selectedCalibrationInputDeviceId, state.isCalibrating, "Choose mic...");
  if (!dirty(el.testToneCheckbox)) {
    el.testToneCheckbox.checked = state.useTestTone;
  }
  el.testToneCheckbox.disabled = !state.canEditTopology;
  setRange(el.markerLevelRange, state.markerLevelPercent);
  el.markerLevelRange.disabled = state.isCalibrating;
  el.markerLevelValue.textContent = `${(+el.markerLevelRange.value).toFixed(1)}%`;
  document.querySelectorAll("[data-sync-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.syncMode === state.autoSyncMode);
    button.disabled = state.isCalibrating;
  });

  meterFill(el.vuCapture, state.captureLevel);
  meterFill(el.vuRoom, state.roomMicLevel);
  el.vuCapturePct.textContent = Math.round((state.captureLevel || 0) * 100);
  el.vuRoomPct.textContent = Math.round((state.roomMicLevel || 0) * 100);

  el.snapEngine.textContent = state.isCalibrating ? "Calibrating" : state.isRunning ? "Streaming" : "Offline";
  el.snapAutoSync.textContent = titleCase(state.autoSyncMode);
  const master = state.outputs?.find((output) => output.isTimingMaster);
  el.snapMaster.textContent = master ? `CH ${master.slotIndex}` : "--";
  el.snapLocked.textContent = String(state.lockedOutputCount || state.lockedOutputsCount || 0);

  el.sessionStatus.textContent = state.sessionStatusMessage || "Ready";
  el.captureStatus.textContent = state.captureStatusText || "Idle";
  el.calibrationStatus.textContent = state.calibrationStatusMessage || "Idle";
  el.openConfigFolderBtn.title = state.configPath || "Config path unavailable";
  el.openConfigFolderBtn.disabled = !state.configPath;

  if (state.lastErrorMessage) {
    el.lastErrorBanner.classList.remove("hidden");
    el.lastErrorText.textContent = state.lastErrorMessage;
  } else {
    el.lastErrorBanner.classList.add("hidden");
  }
}

function renderStrips() {
  el.channelStrips.innerHTML = (state.outputs || []).map((output) => renderStrip(mergeDraft(output))).join("");
}

function renderStrip(output) {
  const color = channelColor(output.slotIndex);
  const active = output.slotIndex === selectedSlot;
  return `<section class="tactile-strip ${active ? "is-selected" : ""}" data-slot="${output.slotIndex}" style="--strip-color:${color}">
    <div class="strip-led"></div>
    <div class="strip-head">
      <div class="tape-label">CH ${output.slotIndex}</div>
      <h3 class="strip-name">${escapeHtml(output.selectedDeviceName || `Output ${output.slotIndex}`)}</h3>
      <div class="strip-subtitle">${escapeHtml(output.statusText || "Idle")}</div>
    </div>
    <div class="led-grid">
      <div class="led-box"><span>Delay</span><strong data-led-delay="${output.slotIndex}">${Math.round(output.delayMilliseconds)}<small>ms</small></strong></div>
      <div class="led-box"><span>Sync</span><strong data-led-sync="${output.slotIndex}">${Math.round((output.syncConfidence || 0) * 100)}<small>%</small></strong></div>
      <div class="led-box"><span>Drift</span><strong data-led-rate="${output.slotIndex}">${Math.abs((Number(output.playbackRateRatio || 1) - 1) * 1000).toFixed(1)}<small>ms</small></strong></div>
      <div class="led-box"><span>Volume</span><strong data-led-volume="${output.slotIndex}">${Math.round(output.volumePercent)}<small>%</small></strong></div>
    </div>
    <div class="mini-meter-stack">
      <div class="mini-meter-card">
        <span>Confidence</span>
        <div class="mini-segments" data-segments="confidence" data-slot="${output.slotIndex}">${renderSegments(Math.round((output.syncConfidence || 0) * 100), color)}</div>
      </div>
      <div class="mini-meter-card">
        <span>Coherence</span>
        <div class="mini-segments" data-segments="coherence" data-slot="${output.slotIndex}">${renderSegments(routeMeterPct(output.meterLevel), color)}</div>
      </div>
    </div>
    <div class="knob-pair">
      <button
        class="virtual-knob"
        type="button"
        data-action="knob"
        data-knob-field="volume"
        data-slot="${output.slotIndex}"
        style="--knob-color:${color};--knob-angle:${knobAngle(output.volumePercent, 100)}deg">
        <div class="virtual-knob-face"></div>
        <span>Vol</span>
        <strong class="knob-readout" data-knob-readout="volume" data-slot="${output.slotIndex}">${Math.round(output.volumePercent)}%</strong>
      </button>
      <button
        class="virtual-knob"
        type="button"
        data-action="knob"
        data-knob-field="delay"
        data-slot="${output.slotIndex}"
        style="--knob-color:${color};--knob-angle:${knobAngle(output.delayMilliseconds, 2000)}deg">
        <div class="virtual-knob-face"></div>
        <span>Delay</span>
        <strong class="knob-readout" data-knob-readout="delay" data-slot="${output.slotIndex}">${Math.round(output.delayMilliseconds)} ms</strong>
      </button>
    </div>
    <div class="fader-wrap">
      <span>Level</span>
      <div class="fader-track" data-action="fader-track">
        <div class="fader-fill" style="height:${Math.round(output.volumePercent)}%;background:${color}"></div>
        <div class="fader-cap" data-fader-cap="${output.slotIndex}" style="top:${faderCapTop(output.volumePercent)}px">
          <div class="fader-cap-line"></div>
        </div>
      </div>
      <div class="fader-value" data-fader-value="${output.slotIndex}">${Math.round(output.volumePercent)}%</div>
      <div class="strip-master-tag ${output.isTimingMaster ? "is-active" : ""}">${output.isTimingMaster ? "Master" : output.syncLockState || "Manual"}</div>
      <div class="strip-device-foot">${escapeHtml(output.selectedDeviceName || `Output ${output.slotIndex}`)}</div>
    </div>
  </section>`;
}

function renderScope() {
  const outputs = state.outputs || [];
  const positions = [
    { x: 22, y: 24 },
    { x: 76, y: 26 },
    { x: 80, y: 76 },
    { x: 24, y: 80 },
    { x: 50, y: 15 },
    { x: 50, y: 86 }
  ];
  el.roomScopeNodes.innerHTML = outputs.map((output, index) => {
    const pos = positions[index % positions.length];
    const active = output.slotIndex === selectedSlot;
    return `<button class="scope-node ${active ? "active" : ""}" data-slot="${output.slotIndex}" style="left:${pos.x}%;top:${pos.y}%;--strip-color:${channelColor(output.slotIndex)}">CH${output.slotIndex}</button>`;
  }).join("");
}

function renderSelectedPanel() {
  const selectedRoute = findRoute(selectedSlot) || state.outputs?.[0] || null;
  const selected = selectedRoute ? mergeDraft(selectedRoute) : null;
  if (!selected) {
    el.selectedChannelTape.textContent = "Selected Route";
    el.selectedChannelStatus.textContent = "Idle";
    el.selectedChannelStatus.style.color = "";
    el.selectedChannelName.textContent = "No route selected";
    el.selectedChannelDevice.textContent = "Add or select an output strip.";
    el.selectedDeviceSelect.innerHTML = `<option value="">No route selected</option>`;
    return;
  }

  const color = channelColor(selected.slotIndex);
  el.selectedChannelTape.textContent = `CH ${selected.slotIndex} · Detail`;
  el.selectedChannelTape.style.background = activeTapeColor(selected.slotIndex);
  el.selectedChannelStatus.textContent = selected.syncLockState || "Manual";
  el.selectedChannelStatus.style.color = color;
  el.selectedChannelName.textContent = selected.selectedDeviceName || `Output ${selected.slotIndex}`;
  el.selectedChannelDevice.textContent = `${selected.statusText || "Idle"} · ${selected.syncSummary || "Manual"}`;
  renderSelect(el.selectedDeviceSelect, state.playbackDevices, selected.selectedDeviceId, !state.canEditTopology, "Choose device...");
  setRange(el.selectedVolumeRange, selected.volumePercent);
  el.selectedVolumeValue.textContent = `${Math.round(selected.volumePercent)}%`;
  setRange(el.selectedDelayRange, selected.delayMilliseconds);
  if (document.activeElement !== el.selectedDelayNumber) {
    el.selectedDelayNumber.value = Math.round(selected.delayMilliseconds);
  }
  el.selectedDelayValue.textContent = `${Math.round(selected.delayMilliseconds)} ms`;
  el.selectedDelayFoot.textContent = `Effective ${Math.round(selected.effectiveDelayMilliseconds || selected.delayMilliseconds)} ms`;

  const latency = Math.max(0, Number(selected.estimatedArrivalMilliseconds || 0));
  const buffer = Math.max(0, Number(selected.bufferedMilliseconds || 0));
  const confidence = Math.round((selected.syncConfidence || 0) * 100);
  const rate = Number(selected.playbackRateRatio || 1);

  el.selectedLatencyValue.textContent = `${latency.toFixed(1)} ms`;
  el.selectedBufferValue.textContent = `${Math.round(buffer)} ms`;
  el.selectedConfidenceValue.textContent = `${confidence}%`;
  el.selectedRateValue.textContent = `${rate.toFixed(4)}x`;

  meterFill(el.selectedLatencyMeter, clamp(latency / 500, 0, 1));
  meterFill(el.selectedBufferMeter, clamp(buffer / 500, 0, 1));
  meterFill(el.selectedConfidenceMeter, clamp(confidence / 100, 0, 1));
  meterFill(el.selectedRateMeter, clamp(Math.abs(rate - 1) * 12, 0, 1));

  const mutePending = pending.has(`${selected.slotIndex}:mute`);
  const soloPending = pending.has(`${selected.slotIndex}:solo`);
  const pingPending = pending.has(`${selected.slotIndex}:ping`);
  const masterPending = pending.has(`${selected.slotIndex}:make-master`);
  const removePending = pending.has(`${selected.slotIndex}:remove`);
  el.selectedMuteBtn.textContent = selected.isMuted ? "Unmute" : "Mute";
  el.selectedSoloBtn.textContent = selected.isSolo ? "Unsolo" : "Solo";
  el.selectedPingBtn.textContent = pingPending ? "Pinging" : "Ping";
  el.selectedMasterBtn.textContent = selected.isTimingMaster ? "Timing Master" : "Set Master";
  el.selectedRemoveBtn.textContent = removePending ? "Removing" : "Remove";
  el.selectedMuteBtn.disabled = state.isCalibrating || mutePending;
  el.selectedSoloBtn.disabled = state.isCalibrating || soloPending;
  el.selectedPingBtn.disabled = state.isCalibrating || pingPending || !selected.selectedDeviceId;
  el.selectedMasterBtn.disabled = state.isCalibrating || masterPending;
  el.selectedRemoveBtn.disabled = !selected.canRemove || removePending;
  el.selectedPasteBtn.disabled = !copyBuf;
  el.selectedDeviceSelect.disabled = !state.canEditTopology;
  el.selectedVolumeRange.disabled = state.isCalibrating;
  el.selectedDelayRange.disabled = state.isCalibrating;
  el.selectedDelayNumber.disabled = state.isCalibrating;
  el.selectedDelayMinusBtn.disabled = state.isCalibrating;
  el.selectedDelayPlusBtn.disabled = state.isCalibrating;
}

function renderCalibration() {
  const model = calibrationModel(telemetryState || state);
  el.calTitle.textContent = `${model.title} — ${model.stage}`;
  el.calMicHealth.textContent = model.micHealth;
  el.calGuidance.textContent = model.guidance;
  const entries = getCalibrationEntries();
  el.calAttemptsList.innerHTML = entries.length
    ? entries.map((entry) => `<div class="cal-attempt ${entry.tone}"><time>${escapeHtml(entry.time)}</time><span>${escapeHtml(entry.text)}</span></div>`).join("")
    : `<div class="cal-attempt"><span>No recent calibration attempts yet.</span></div>`;
}

function renderLogs() {
  const lines = (state.logEntries || []).map((entry) => entry.displayText);
  const errors = (state.logEntries || []).filter((entry) => /error|fail|exception/i.test(entry.displayText)).length;
  el.logOutput.textContent = lines.length ? lines.join("\n") : "No log entries yet.";
  el.logCountLabel.textContent = errors > 0 ? `${lines.length} / ${errors} err` : String(lines.length);
}

function patchTele(frame) {
  if (!frame || !state) {
    return;
  }

  const mode = frame.isCalibrating ? "calibrating" : frame.isRunning ? "live" : "offline";
  el.enginePill.className = `engine-pill ${mode}`;
  el.enginePill.textContent = mode.toUpperCase();

  meterFill(el.vuCapture, frame.captureLevel || 0);
  meterFill(el.vuRoom, frame.roomMicLevel || 0);
  el.vuCapturePct.textContent = Math.round((frame.captureLevel || 0) * 100);
  el.vuRoomPct.textContent = Math.round((frame.roomMicLevel || 0) * 100);

  for (const teleOut of frame.outputs || []) {
    const strip = el.channelStrips.querySelector(`[data-slot="${teleOut.slotIndex}"]`);
    if (!strip) {
      continue;
    }
    const meter = strip.querySelector(`[data-meter="${teleOut.slotIndex}"]`);
    const meterLabel = strip.querySelector(`[data-meter-label="${teleOut.slotIndex}"]`);
    const delayLed = strip.querySelector(`[data-led-delay="${teleOut.slotIndex}"]`);
    const syncLed = strip.querySelector(`[data-led-sync="${teleOut.slotIndex}"]`);
    const rateLed = strip.querySelector(`[data-led-rate="${teleOut.slotIndex}"]`);
    const volumeReadout = strip.querySelector(`[data-volume-readout="${teleOut.slotIndex}"]`);
    const status = strip.querySelector(".strip-subtitle");
    const coherence = strip.querySelector('[data-segments="coherence"]');
    const confidence = strip.querySelector('[data-segments="confidence"]');
    const faderFill = strip.querySelector(".fader-fill");
    const faderCap = strip.querySelector(`[data-fader-cap="${teleOut.slotIndex}"]`);
    const faderValue = strip.querySelector(`[data-fader-value="${teleOut.slotIndex}"]`);
    const masterTag = strip.querySelector(".strip-master-tag");
    const volumeKnob = strip.querySelector('[data-knob-field="volume"]');
    const delayKnob = strip.querySelector('[data-knob-field="delay"]');
    const volumeKnobReadout = strip.querySelector('[data-knob-readout="volume"]');
    const delayKnobReadout = strip.querySelector('[data-knob-readout="delay"]');
    // volumePercent is NOT in OutputTelemetryState (only appliedVolumePercent is).
    // Using route.volumePercent (configured value from state) keeps patchTele and
    // renderStrips() in agreement, eliminating fader/knob/LED flicker.
    const route = findRoute(teleOut.slotIndex);
    const liveVolume = Math.round(route?.volumePercent ?? teleOut.appliedVolumePercent ?? 0);
    const liveDelay = Math.round(teleOut.delayMilliseconds || 0);

    if (meter) {
      setMeterPercent(meter, routeMeterPct(teleOut.meterLevel));
    }
    if (meterLabel) {
      meterLabel.textContent = routeMeterLabel(teleOut.meterLevel);
    }
    if (delayLed) {
      delayLed.innerHTML = `${Math.round(teleOut.delayMilliseconds || 0)}<small>ms</small>`;
    }
    if (syncLed) {
      syncLed.innerHTML = `${Math.round((teleOut.syncConfidence || 0) * 100)}<small>%</small>`;
    }
    if (rateLed) {
      rateLed.innerHTML = `${Math.abs((Number(teleOut.playbackRateRatio || 1) - 1) * 1000).toFixed(1)}<small>ms</small>`;
    }
    if (volumeReadout) {
      volumeReadout.textContent = `${liveVolume}%`;
    }
    if (status) {
      status.textContent = teleOut.statusText || "Idle";
    }
    if (coherence) {
      coherence.innerHTML = renderSegments(routeMeterPct(teleOut.meterLevel), channelColor(teleOut.slotIndex));
    }
    if (confidence) {
      confidence.innerHTML = renderSegments(Math.round((teleOut.syncConfidence || 0) * 100), channelColor(teleOut.slotIndex));
    }
    if (faderFill) {
      faderFill.style.height = `${liveVolume}%`;
    }
    if (faderCap) {
      faderCap.style.top = `${faderCapTop(liveVolume)}px`;
    }
    if (faderValue) {
      faderValue.textContent = `${liveVolume}%`;
    }
    if (volumeKnob) {
      volumeKnob.style.setProperty("--knob-angle", `${knobAngle(liveVolume, 100)}deg`);
    }
    if (delayKnob) {
      delayKnob.style.setProperty("--knob-angle", `${knobAngle(liveDelay, 2000)}deg`);
    }
    if (volumeKnobReadout) {
      volumeKnobReadout.textContent = `${liveVolume}%`;
    }
    if (delayKnobReadout) {
      delayKnobReadout.textContent = `${liveDelay} ms`;
    }
    if (masterTag) {
      // isTimingMaster is NOT in OutputTelemetryState — always read from state.
      // syncLockState IS in telemetry but as an integer enum (e.g. 0 for Disabled)
      // while the REST state returns it as a string ("Disabled"). The integer is falsy
      // so teleOut.syncLockState || "Manual" would incorrectly show "Manual" every tick.
      // Use route (state-sourced) for both fields to stay consistent with renderStrip().
      const isMaster = !!route?.isTimingMaster;
      masterTag.textContent = isMaster ? "Master" : route?.syncLockState || "Manual";
      masterTag.classList.toggle("is-active", isMaster);
    }
  }

  el.sessionStatus.textContent = frame.sessionStatusMessage || state.sessionStatusMessage || "Ready";
  el.captureStatus.textContent = frame.captureStatusText || state.captureStatusText || "Idle";
  el.calibrationStatus.textContent = frame.calibrationStatusMessage || state.calibrationStatusMessage || "Idle";

  renderCalibration();
  renderSelectedPanel();
}

function handleChInput(event) {
  const strip = event.target.closest("[data-slot]");
  if (!strip) {
    return;
  }
  if (!event.target.matches("[data-field]")) {
    return;
  }
  markInteract();
  syncStripLabels(strip, event.target.dataset.field);
  syncDraft(strip);
  queueRouteUpdate(strip, event.type === "change");
}

function handleChClick(event) {
  const strip = event.target.closest("[data-slot]");
  if (strip && !event.target.closest("[data-action], input, select, button")) {
    setSelectedRoute(+strip.dataset.slot);
    return;
  }
}

function handleChPointerDown(event) {
  const knob = event.target.closest('[data-action="knob"]');
  if (knob) {
    const strip = event.target.closest("[data-slot]");
    if (!strip || state?.isCalibrating) {
      return;
    }
    const slot = Number(strip.dataset.slot || 0);
    const current = mergeDraft(findRoute(slot) || { slotIndex: slot, volumePercent: 100, delayMilliseconds: 0 });
    const field = knob.dataset.knobField;
    stripDragState = {
      slot,
      field,
      source: "knob",
      startY: event.clientY,
      startValue: field === "delay" ? Number(current.delayMilliseconds || 0) : Number(current.volumePercent || 0)
    };
    selectedSlot = slot;
    localStorage.setItem("v2Tactile.selectedSlot", String(slot));
    paintSelectedStrip(slot);
    renderSelectedPanel();
    try {
      knob.requestPointerLock?.();
    } catch {
      // fall back to regular pointer tracking if pointer lock is unavailable
    }
    event.preventDefault();
    return;
  }
  const faderTrack = event.target.closest('[data-action="fader-track"]');
  if (faderTrack) {
    const strip = event.target.closest("[data-slot]");
    if (!strip || state?.isCalibrating) {
      return;
    }
    stripDragState = {
      slot: Number(strip.dataset.slot || 0),
      field: "volume",
      source: "fader"
    };
    updateStripFaderFromPointer(strip, event.clientY, true);
    event.preventDefault();
    return;
  }
  const stepButton = event.target.closest('[data-action="step-delay"]');
  if (!stepButton || event.button !== 0 || stepButton.disabled) {
    return;
  }
  const strip = event.target.closest("[data-slot]");
  if (!strip) {
    return;
  }
  event.preventDefault();
  startHold(strip, +stepButton.dataset.step);
}

function handleStripPointerUp() {
  if (!stripDragState) {
    return;
  }
  if (stripDragState.source === "knob" && document.pointerLockElement) {
    document.exitPointerLock?.();
  }
  window.setTimeout(() => {
    stripDragState = null;
  }, 0);
}

function handleStripPointerMove(event) {
  if (!stripDragState) {
    return;
  }
  const strip = el.channelStrips.querySelector(`[data-slot="${stripDragState.slot}"]`);
  if (!strip) {
    return;
  }
  if (stripDragState.source === "fader") {
    updateStripFaderFromPointer(strip, event.clientY, false);
    return;
  }
  if (document.pointerLockElement) {
    updateStripKnobFromMotion(strip, event.movementY, true);
    return;
  }
  updateStripKnobFromPointer(strip, event.clientY, true);
}

function handleChWheel(event) {
  const input = event.target.closest('[data-field="delay"], [data-field="delay-number"]');
  if (!input) {
    return;
  }
  event.preventDefault();
  const strip = event.target.closest("[data-slot]");
  if (strip) {
    nudge(strip, event.deltaY < 0 ? 1 : -1);
  }
}

function handleChKey(event) {
  const input = event.target.closest('[data-field="delay"], [data-field="delay-number"]');
  if (!input) {
    return;
  }
  let delta = 0;
  if (event.key === "ArrowUp" || event.key === "ArrowRight") {
    delta = event.shiftKey ? 10 : 1;
  } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
    delta = event.shiftKey ? -10 : -1;
  }
  if (!delta) {
    return;
  }
  event.preventDefault();
  const strip = event.target.closest("[data-slot]");
  if (strip) {
    nudge(strip, delta);
  }
}

function handleScopeClick(event) {
  const node = event.target.closest("[data-slot]");
  if (!node) {
    return;
  }
  setSelectedRoute(+node.dataset.slot);
}

function handleSettings() {
  if (!state) {
    return;
  }
  markInteract();
  el.masterVolValue.textContent = Math.round(+el.masterVolRange.value);
  el.markerLevelValue.textContent = `${(+el.markerLevelRange.value).toFixed(1)}%`;
  queueSettings();
}

function toggleLayoutLock() {
  layoutLocked = !layoutLocked;
  localStorage.setItem("v2Tactile.layoutLocked", layoutLocked ? "1" : "0");
  if (layoutLocked) {
    endRailResize();
  }
  applyRailLayout();
}

function applyRailLayout() {
  document.documentElement.style.setProperty("--rail-scale", railScale.toFixed(4));
  document.body.classList.toggle("layout-unlocked", !layoutLocked);
  el.layoutLockBtn.textContent = layoutLocked ? "Layout Locked" : "Layout Edit";
}

function beginRailResize(event, side) {
  if (layoutLocked || window.innerWidth <= 1120) {
    return;
  }
  resizeState = {
    side,
    startX: event.clientX,
    startScale: railScale
  };
  event.currentTarget.classList.add("is-dragging");
  event.currentTarget.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function handleRailResizeMove(event) {
  if (!resizeState) {
    return;
  }
  const sign = resizeState.side === "left" ? 1 : -1;
  const delta = (event.clientX - resizeState.startX) * sign;
  railScale = clamp(resizeState.startScale + (delta / BASE_PANEL_TOTAL), 0.72, 1.85);
  localStorage.setItem("v2Tactile.railScale", railScale.toFixed(4));
  applyRailLayout();
}

function endRailResize() {
  if (!resizeState) {
    return;
  }
  el.leftResizeHandle.classList.remove("is-dragging");
  el.rightResizeHandle.classList.remove("is-dragging");
  resizeState = null;
}

function handleSelectedRouteInput(event) {
  const selected = findRoute(selectedSlot);
  if (!selected) {
    return;
  }
  markInteract();
  if (event.target === el.selectedDelayNumber) {
    const next = clamp(+el.selectedDelayNumber.value, 0, 2000);
    el.selectedDelayNumber.value = next;
    el.selectedDelayRange.value = next;
  }
  if (event.target === el.selectedDelayRange) {
    el.selectedDelayNumber.value = el.selectedDelayRange.value;
  }
  if (event.target === el.selectedVolumeRange) {
    el.selectedVolumeValue.textContent = `${Math.round(+el.selectedVolumeRange.value)}%`;
  }
  if (event.target === el.selectedDelayRange || event.target === el.selectedDelayNumber) {
    el.selectedDelayValue.textContent = `${Math.round(+el.selectedDelayRange.value)} ms`;
  }
  queueSelectedRouteUpdate(event.type === "change");
}

function queueSelectedRouteUpdate(immediate) {
  const selected = findRoute(selectedSlot);
  if (!selected) {
    return;
  }
  const send = () => mutate(() => api(`/api/outputs/${selectedSlot}`, { method: "PUT", body: selectedRoutePayload(false) }));
  clearRouteTimer(selectedSlot);
  if (immediate) {
    send();
    return;
  }
  routeTimers.set(selectedSlot, setTimeout(() => {
    routeTimers.delete(selectedSlot);
    send();
  }, ROUTE_DEBOUNCE_MS));
}

function selectedRoutePayload(forceMaster) {
  const selected = findRoute(selectedSlot);
  return {
    selectedDeviceId: normalizeEmpty(el.selectedDeviceSelect.value),
    volumePercent: +el.selectedVolumeRange.value,
    delayMilliseconds: +el.selectedDelayRange.value,
    isTimingMaster: forceMaster || !!selected?.isTimingMaster
  };
}

function nudgeSelectedRoute(delta) {
  const selected = findRoute(selectedSlot);
  if (!selected || state?.isCalibrating) {
    return;
  }
  const next = clamp(+el.selectedDelayRange.value + delta, 0, 2000);
  el.selectedDelayRange.value = next;
  el.selectedDelayNumber.value = next;
  el.selectedDelayValue.textContent = `${Math.round(next)} ms`;
  queueSelectedRouteUpdate(true);
}

function triggerSelectedAction(action) {
  const selected = findRoute(selectedSlot);
  if (!selected) {
    return;
  }
  if (action === "remove") {
    runAction(selectedSlot, action, () => api(`/api/outputs/${selectedSlot}`, { method: "DELETE" }));
    return;
  }
  if (action === "mute" || action === "solo") {
    const rollback = optimisticToggle(selectedSlot, action);
    runAction(selectedSlot, action, () => api(`/api/outputs/${selectedSlot}/${action}`, { method: "POST" }), rollback);
    return;
  }
  if (action === "ping") {
    runAction(selectedSlot, action, () => api(`/api/outputs/${selectedSlot}/ping`, { method: "POST" }));
    return;
  }
  if (action === "make-master") {
    runAction(selectedSlot, action, () => api(`/api/outputs/${selectedSlot}`, { method: "PUT", body: selectedRoutePayload(true) }));
  }
}

function handleSelectedCopy() {
  const selected = findRoute(selectedSlot);
  if (!selected) {
    return;
  }
  copyBuf = {
    volumePercent: +el.selectedVolumeRange.value,
    delayMilliseconds: +el.selectedDelayRange.value
  };
  renderSelectedPanel();
  toast(`Copied CH ${selected.slotIndex}.`, "success");
}

function handleSelectedPaste() {
  if (!copyBuf || !findRoute(selectedSlot)) {
    return;
  }
  el.selectedVolumeRange.value = copyBuf.volumePercent;
  el.selectedDelayRange.value = copyBuf.delayMilliseconds;
  el.selectedDelayNumber.value = copyBuf.delayMilliseconds;
  el.selectedVolumeValue.textContent = `${Math.round(copyBuf.volumePercent)}%`;
  el.selectedDelayValue.textContent = `${Math.round(copyBuf.delayMilliseconds)} ms`;
  queueSelectedRouteUpdate(true);
}

function handleCalibrate() {
  if (!state || calibInFlight) {
    return;
  }
  state.isCalibrating ? cancelCalibration() : startCalibration();
}

async function startCalibration() {
  calibInFlight = true;
  renderTransport();
  try {
    const request = api("/api/calibrate", { method: "POST" });
    setTimeout(() => {
      refreshState(true);
      refreshTele(true);
    }, 60);
    setState(await request);
  } catch (error) {
    toast(error.message || "Calibration failed.");
    await refreshState(true);
  } finally {
    calibInFlight = false;
    renderTransport();
  }
}

async function cancelCalibration() {
  calibInFlight = true;
  renderTransport();
  try {
    setState(await api("/api/calibrate/cancel", { method: "POST" }));
    refreshTele(true);
  } catch (error) {
    toast(error.message || "Failed to cancel calibration.");
    await refreshState(true);
  } finally {
    calibInFlight = false;
    renderTransport();
  }
}

function queueSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    settingsTimer = null;
    mutate(() => api("/api/settings", { method: "PUT", body: settingsPayload() }));
  }, SETTINGS_DEBOUNCE_MS);
}

function queueRouteUpdate(strip, immediate) {
  const slot = +strip.dataset.slot;
  const send = () => mutate(() => api(`/api/outputs/${slot}`, { method: "PUT", body: routePayload(slot, false) }));
  clearRouteTimer(slot);
  if (immediate) {
    send();
    return;
  }
  routeTimers.set(slot, setTimeout(() => {
    routeTimers.delete(slot);
    send();
  }, ROUTE_DEBOUNCE_MS));
}

function clearRouteTimer(slot) {
  const timer = routeTimers.get(slot);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  routeTimers.delete(slot);
}

function startHold(strip, step) {
  stopHold();
  if (!step) {
    return;
  }
  markInteract();
  nudge(strip, step);
  holdState = { id: setInterval(() => nudge(strip, step), HOLD_MS) };
}

function stopHold() {
  if (!holdState) {
    return;
  }
  clearInterval(holdState.id);
  holdState = null;
}

function nudge(strip, delta) {
  const delayRange = strip.querySelector('[data-field="delay"]');
  const delayNumber = strip.querySelector('[data-field="delay-number"]');
  if (!delayRange || !delayNumber) {
    return;
  }
  const next = clamp(+delayRange.value + delta, 0, 2000);
  if (next === +delayRange.value) {
    return;
  }
  delayRange.value = next;
  delayNumber.value = next;
  syncStripLabels(strip);
  syncDraft(strip);
  queueRouteUpdate(strip, true);
}

function settingsPayload() {
  return {
    selectedInputDeviceId: normalizeEmpty(el.inputSelect.value),
    selectedCalibrationInputDeviceId: normalizeEmpty(el.calibrationSelect.value),
    useTestTone: el.testToneCheckbox.checked,
    masterVolumePercent: +el.masterVolRange.value,
    autoSyncMode: document.querySelector("[data-sync-mode].active")?.dataset.syncMode || "MonitorOnly",
    markerLevelPercent: +el.markerLevelRange.value
  };
}

function routePayload(strip, forceMaster) {
  const slot = typeof strip === "number" ? strip : +strip.dataset.slot;
  const current = mergeDraft(findRoute(slot) || { slotIndex: slot });
  return {
    selectedDeviceId: normalizeEmpty(current.selectedDeviceId),
    volumePercent: clamp(Number(current.volumePercent ?? 100), 0, 100),
    delayMilliseconds: clamp(Number(current.delayMilliseconds ?? 0), 0, 2000),
    isTimingMaster: forceMaster || !!findRoute(slot)?.isTimingMaster
  };
}

async function runAction(slot, action, request, rollback) {
  const key = `${slot}:${action}`;
  if (pending.has(key)) {
    return;
  }
  pending.add(key);
  renderStrips();
  try {
    setState(await request());
  } catch (error) {
    rollback?.();
    toast(error.message || "Route action failed.");
  } finally {
    pending.delete(key);
    renderStrips();
    renderScope();
    renderSelectedPanel();
  }
}

function optimisticToggle(slot, action) {
  const route = findRoute(slot);
  if (!route) {
    return null;
  }
  const previous = { isMuted: route.isMuted, isSolo: route.isSolo };
  if (action === "mute") {
    route.isMuted = !route.isMuted;
  }
  if (action === "solo") {
    route.isSolo = !route.isSolo;
  }
  renderStrips();
  renderScope();
  renderSelectedPanel();
  return () => {
    route.isMuted = previous.isMuted;
    route.isSolo = previous.isSolo;
    renderStrips();
    renderScope();
    renderSelectedPanel();
  };
}

function syncDraft(strip) {
  const slot = +strip.dataset.slot;
  const current = mergeDraft(findRoute(slot) || { slotIndex: slot });
  const nextDraft = {
    selectedDeviceId: normalizeEmpty(current.selectedDeviceId),
    volumePercent: clamp(Number(current.volumePercent ?? 100), 0, 100),
    delayMilliseconds: clamp(Number(current.delayMilliseconds ?? 0), 0, 2000)
  };
  const volume = strip.querySelector('[data-field="volume"]');
  const delay = strip.querySelector('[data-field="delay"]');
  const device = strip.querySelector('[data-field="device"]');
  if (volume) {
    nextDraft.volumePercent = clamp(Number(volume.value), 0, 100);
  }
  if (delay) {
    nextDraft.delayMilliseconds = clamp(Number(delay.value), 0, 2000);
  }
  if (device) {
    nextDraft.selectedDeviceId = normalizeEmpty(device.value);
  }
  drafts.set(slot, nextDraft);
}

function reconcileDrafts() {
  if (!state) {
    return;
  }
  const validSlots = new Set((state.outputs || []).map((output) => output.slotIndex));
  for (const [slot, draft] of drafts) {
    if (!validSlots.has(slot)) {
      drafts.delete(slot);
      continue;
    }
    const output = findRoute(slot);
    if (!output) {
      drafts.delete(slot);
      continue;
    }
    if (
      normalizeEmpty(draft.selectedDeviceId) === normalizeEmpty(output.selectedDeviceId) &&
      +draft.volumePercent === +output.volumePercent &&
      +draft.delayMilliseconds === +output.delayMilliseconds
    ) {
      drafts.delete(slot);
    }
  }
}

function mergeDraft(output) {
  const draft = drafts.get(output.slotIndex);
  return draft ? { ...output, ...draft } : output;
}

function ensureSelectedRoute() {
  const outputs = state?.outputs || [];
  if (!outputs.length) {
    selectedSlot = 0;
    localStorage.removeItem("v2Tactile.selectedSlot");
    return;
  }
  if (!outputs.some((output) => output.slotIndex === selectedSlot)) {
    selectedSlot = outputs[0].slotIndex;
    localStorage.setItem("v2Tactile.selectedSlot", String(selectedSlot));
  }
}

function setSelectedRoute(slot) {
  selectedSlot = slot;
  localStorage.setItem("v2Tactile.selectedSlot", String(slot));
  renderStrips();
  renderScope();
  renderSelectedPanel();
}

function paintSelectedStrip(slot) {
  el.channelStrips.querySelectorAll("[data-slot]").forEach((node) => {
    node.classList.toggle("is-selected", Number(node.dataset.slot) === slot);
  });
  el.roomScopeNodes.querySelectorAll("[data-slot]").forEach((node) => {
    node.classList.toggle("active", Number(node.dataset.slot) === slot);
  });
}

function renderSelect(select, options, selected, disabled, placeholder) {
  const html = [`<option value="">${placeholder}</option>`, ...(options || []).map((option) =>
    `<option value="${escapeHtml(option.id)}" ${option.id === selected ? "selected" : ""}>${escapeHtml(option.displayName)}</option>`)].join("");
  if (!dirty(select)) {
    select.innerHTML = html;
  }
  select.disabled = disabled;
}

function setRange(input, value) {
  if (!dirty(input)) {
    input.value = value;
  }
}

function dirty(input) {
  return document.activeElement === input || settingsTimer !== null;
}

function setSyncMode(mode) {
  document.querySelectorAll("[data-sync-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.syncMode === mode);
  });
}

function syncStripLabels(strip, changedField) {
  const volume = strip.querySelector('[data-field="volume"]');
  const delay = strip.querySelector('[data-field="delay"]');
  const delayNumber = strip.querySelector('[data-field="delay-number"]');
  if (changedField === "delay-number" && delay && delayNumber) {
    delay.value = clamp(+delayNumber.value, 0, 2000);
    delayNumber.value = delay.value;
  }
  if (changedField === "delay" && delay && delayNumber) {
    delayNumber.value = delay.value;
  }
  const slot = +strip.dataset.slot;
  const volumeReadout = strip.querySelector(`[data-volume-readout="${slot}"]`);
  const delayReadout = strip.querySelector(`[data-delay-readout="${slot}"]`);
  const delayLed = strip.querySelector(`[data-led-delay="${slot}"]`);
  const volumeLed = strip.querySelector(`[data-led-volume="${slot}"]`);
  const faderFill = strip.querySelector(".fader-fill");
  const faderCap = strip.querySelector(`[data-fader-cap="${slot}"]`);
  const faderValue = strip.querySelector(`[data-fader-value="${slot}"]`);
  if (volumeReadout && volume) {
    volumeReadout.textContent = `${Math.round(+volume.value)}%`;
  }
  if (volumeLed && volume) {
    volumeLed.innerHTML = `${Math.round(+volume.value)}<small>%</small>`;
  }
  if (faderFill && volume) {
    faderFill.style.height = `${Math.round(+volume.value)}%`;
  }
  if (faderCap && volume) {
    faderCap.style.top = `${faderCapTop(+volume.value)}px`;
  }
  if (faderValue && volume) {
    faderValue.textContent = `${Math.round(+volume.value)}%`;
  }
  if (delayReadout && delay) {
    delayReadout.textContent = `${Math.round(+delay.value)} ms`;
  }
  if (delayLed && delay) {
    delayLed.innerHTML = `${Math.round(+delay.value)}<small>ms</small>`;
  }
}

function updateStripFaderFromPointer(strip, clientY, immediate) {
  const track = strip.querySelector('[data-action="fader-track"]');
  if (!track) {
    return;
  }
  const rect = track.getBoundingClientRect();
  const capHeight = 24;
  const usable = Math.max(1, rect.height - capHeight);
  const relative = clamp(clientY - rect.top - capHeight / 2, 0, usable);
  const next = Math.round((1 - relative / usable) * 100);
  const slot = +strip.dataset.slot;
  const volumeLed = strip.querySelector(`[data-led-volume="${slot}"]`);
  const faderFill = strip.querySelector(".fader-fill");
  const faderCap = strip.querySelector(`[data-fader-cap="${slot}"]`);
  const faderValue = strip.querySelector(`[data-fader-value="${slot}"]`);
  if (volumeLed) {
    volumeLed.innerHTML = `${next}<small>%</small>`;
  }
  if (faderFill) {
    faderFill.style.height = `${next}%`;
  }
  if (faderCap) {
    faderCap.style.top = `${faderCapTop(next)}px`;
  }
  if (faderValue) {
    faderValue.textContent = `${next}%`;
  }
  const current = mergeDraft(findRoute(slot) || {
    slotIndex: slot,
    selectedDeviceId: null,
    delayMilliseconds: 0,
    volumePercent: next
  });
  drafts.set(slot, {
    selectedDeviceId: normalizeEmpty(current.selectedDeviceId),
    delayMilliseconds: +(current.delayMilliseconds ?? 0),
    volumePercent: next,
  });
  queueRouteUpdate(strip, immediate);
}

function updateStripKnobFromPointer(strip, clientY, immediate) {
  const slot = +strip.dataset.slot;
  const current = mergeDraft(findRoute(slot) || {
    slotIndex: slot,
    selectedDeviceId: null,
    delayMilliseconds: 0,
    volumePercent: 100
  });
  const deltaY = stripDragState ? (stripDragState.startY - clientY) : 0;
  const isDelay = stripDragState?.field === "delay";
  const nextValue = isDelay
    ? clamp(Math.round((stripDragState?.startValue ?? current.delayMilliseconds ?? 0) + deltaY * 5), 0, 2000)
    : clamp(Math.round((stripDragState?.startValue ?? current.volumePercent ?? 0) + deltaY * 0.35), 0, 100);
  const delayLed = strip.querySelector(`[data-led-delay="${slot}"]`);
  const volumeLed = strip.querySelector(`[data-led-volume="${slot}"]`);
  const delayKnob = strip.querySelector('[data-knob-field="delay"]');
  const volumeKnob = strip.querySelector('[data-knob-field="volume"]');
  const delayKnobReadout = strip.querySelector('[data-knob-readout="delay"]');
  const volumeKnobReadout = strip.querySelector('[data-knob-readout="volume"]');
  const faderFill = strip.querySelector(".fader-fill");
  const faderCap = strip.querySelector(`[data-fader-cap="${slot}"]`);
  const faderValue = strip.querySelector(`[data-fader-value="${slot}"]`);
  if (isDelay) {
    if (delayLed) {
      delayLed.innerHTML = `${nextValue}<small>ms</small>`;
    }
    if (delayKnob) {
      delayKnob.style.setProperty("--knob-angle", `${knobAngle(nextValue, 2000)}deg`);
    }
    if (delayKnobReadout) {
      delayKnobReadout.textContent = `${nextValue} ms`;
    }
  } else {
    if (volumeLed) {
      volumeLed.innerHTML = `${nextValue}<small>%</small>`;
    }
    if (volumeKnob) {
      volumeKnob.style.setProperty("--knob-angle", `${knobAngle(nextValue, 100)}deg`);
    }
    if (volumeKnobReadout) {
      volumeKnobReadout.textContent = `${nextValue}%`;
    }
    if (faderFill) {
      faderFill.style.height = `${nextValue}%`;
    }
    if (faderCap) {
      faderCap.style.top = `${faderCapTop(nextValue)}px`;
    }
    if (faderValue) {
      faderValue.textContent = `${nextValue}%`;
    }
  }
  drafts.set(slot, {
    selectedDeviceId: normalizeEmpty(current.selectedDeviceId),
    delayMilliseconds: isDelay ? nextValue : clamp(Number(current.delayMilliseconds ?? 0), 0, 2000),
    volumePercent: isDelay ? clamp(Number(current.volumePercent ?? 100), 0, 100) : nextValue
  });
  if (slot === selectedSlot) {
    renderSelectedPanel();
  }
  queueRouteUpdate(strip, immediate);
}

function updateStripKnobFromMotion(strip, movementY, immediate) {
  const slot = +strip.dataset.slot;
  const current = mergeDraft(findRoute(slot) || {
    slotIndex: slot,
    selectedDeviceId: null,
    delayMilliseconds: 0,
    volumePercent: 100
  });
  const isDelay = stripDragState?.field === "delay";
  const currentValue = isDelay ? Number(current.delayMilliseconds ?? 0) : Number(current.volumePercent ?? 0);
  const step = isDelay ? 5 : 0.35;
  const nextValue = isDelay
    ? clamp(Math.round(currentValue - movementY * step), 0, 2000)
    : clamp(Math.round(currentValue - movementY * step), 0, 100);

  applyStripKnobVisuals(strip, slot, isDelay, nextValue);
  drafts.set(slot, {
    selectedDeviceId: normalizeEmpty(current.selectedDeviceId),
    delayMilliseconds: isDelay ? nextValue : clamp(Number(current.delayMilliseconds ?? 0), 0, 2000),
    volumePercent: isDelay ? clamp(Number(current.volumePercent ?? 100), 0, 100) : nextValue
  });
  if (slot === selectedSlot) {
    renderSelectedPanel();
  }
  queueRouteUpdate(strip, immediate);
}

function applyStripKnobVisuals(strip, slot, isDelay, nextValue) {
  const delayLed = strip.querySelector(`[data-led-delay="${slot}"]`);
  const volumeLed = strip.querySelector(`[data-led-volume="${slot}"]`);
  const delayKnob = strip.querySelector('[data-knob-field="delay"]');
  const volumeKnob = strip.querySelector('[data-knob-field="volume"]');
  const delayKnobReadout = strip.querySelector('[data-knob-readout="delay"]');
  const volumeKnobReadout = strip.querySelector('[data-knob-readout="volume"]');
  const faderFill = strip.querySelector(".fader-fill");
  const faderCap = strip.querySelector(`[data-fader-cap="${slot}"]`);
  const faderValue = strip.querySelector(`[data-fader-value="${slot}"]`);

  if (isDelay) {
    if (delayLed) {
      delayLed.innerHTML = `${nextValue}<small>ms</small>`;
    }
    if (delayKnob) {
      delayKnob.style.setProperty("--knob-angle", `${knobAngle(nextValue, 2000)}deg`);
    }
    if (delayKnobReadout) {
      delayKnobReadout.textContent = `${nextValue} ms`;
    }
    return;
  }

  if (volumeLed) {
    volumeLed.innerHTML = `${nextValue}<small>%</small>`;
  }
  if (volumeKnob) {
    volumeKnob.style.setProperty("--knob-angle", `${knobAngle(nextValue, 100)}deg`);
  }
  if (volumeKnobReadout) {
    volumeKnobReadout.textContent = `${nextValue}%`;
  }
  if (faderFill) {
    faderFill.style.height = `${nextValue}%`;
  }
  if (faderCap) {
    faderCap.style.top = `${faderCapTop(nextValue)}px`;
  }
  if (faderValue) {
    faderValue.textContent = `${nextValue}%`;
  }
}

function meterFill(target, value) {
  setMeterPercent(target, Number(value || 0) * 100);
}

function setMeterPercent(target, percent) {
  if (!target) {
    return;
  }

  const targetPercent = Math.max(0, Math.min(100, Number(percent || 0)));
  const current = animatedMeters.get(target)?.current ?? targetPercent;
  animatedMeters.set(target, { current, target: targetPercent });

  if (!meterAnimationFrame) {
    meterAnimationFrame = requestAnimationFrame(stepMeters);
  }
}

function stepMeters() {
  meterAnimationFrame = 0;
  let keepRunning = false;

  for (const [target, stateEntry] of animatedMeters) {
    if (!target.isConnected) {
      animatedMeters.delete(target);
      continue;
    }

    const delta = stateEntry.target - stateEntry.current;
    if (Math.abs(delta) <= 0.35) {
      stateEntry.current = stateEntry.target;
    } else {
      stateEntry.current += delta * 0.28;
      keepRunning = true;
    }

    target.style.width = `${stateEntry.current.toFixed(2)}%`;

    if (stateEntry.current === stateEntry.target) {
      animatedMeters.delete(target);
    }
  }

  if (keepRunning || animatedMeters.size) {
    meterAnimationFrame = requestAnimationFrame(stepMeters);
  }
}

function routeMeterDisplay(value) {
  const raw = Math.max(0, Math.min(1, Number(value || 0)));
  if (raw <= 0.0005) {
    return 0;
  }
  const db = 20 * Math.log10(raw);
  const normalized = Math.max(0, Math.min(1, (db + 48) / 48));
  return Math.max(0, Math.min(1, Math.pow(normalized, 0.72)));
}

function routeMeterPct(value) {
  return Math.round(routeMeterDisplay(value) * 100);
}

function routeMeterLabel(value) {
  return `${routeMeterPct(value)}%`;
}

function renderSegments(percent, color) {
  const lit = Math.max(0, Math.min(6, Math.round((percent || 0) / (100 / 6))));
  return Array.from({ length: 6 }, (_, index) => {
    const active = index < lit;
    return `<span class="mini-segment ${active ? "is-active" : ""}" style="${active ? `background:${color};box-shadow:0 0 8px ${color}55` : ""}"></span>`;
  }).join("");
}

function knobAngle(value, max) {
  return ((Math.max(0, Math.min(max, value)) / max) * 270 - 135).toFixed(1);
}

function faderCapTop(value) {
  const clamped = clamp(Number(value || 0), 0, 100);
  return Math.round(((100 - clamped) / 100) * 122);
}

function shouldDeferStripRender() {
  if (!stripDragState) {
    return false;
  }
  return !!el.channelStrips.querySelector(`[data-slot="${stripDragState.slot}"]`);
}

function markInteract() {
  interactionPauseUntil = Date.now() + INTERACT_PAUSE_MS;
}

async function copyLogs() {
  try {
    await navigator.clipboard.writeText(el.logOutput.textContent || "");
    toast("Logs copied.", "success");
  } catch {
    toast("Clipboard copy failed.");
  }
}

function toast(message, tone) {
  const item = document.createElement("div");
  item.className = `toast ${tone || ""}`.trim();
  item.textContent = message;
  el.toastStack.appendChild(item);
  setTimeout(() => item.remove(), 4800);
}

function calibrationModel(source) {
  const stage = source?.calibrationProgressMessage || source?.calibrationStatusMessage || "Idle";
  const room = source?.roomMicLevel || 0;
  const status = String(source?.calibrationStatusMessage || "");
  if (source?.isCalibrating) {
    if (room >= 0.92) {
      return { title: "Too Hot", stage, micHealth: "Overloaded", guidance: "Lower mic gain or speaker volume." };
    }
    if (room >= 0.08) {
      return { title: "Healthy", stage, micHealth: "Usable", guidance: "Signal looks healthy for calibration." };
    }
    if (room >= 0.025) {
      return { title: "Weak", stage, micHealth: "Borderline", guidance: "You may need more speaker level or a closer mic." };
    }
    return { title: "Quiet", stage, micHealth: "Low", guidance: "Raise playback or move the mic closer." };
  }
  if (/failed/i.test(status)) {
    return { title: "Failed", stage, micHealth: "Adjust", guidance: state?.lastErrorMessage || "Calibration did not lock cleanly." };
  }
  if (/applied|complete/i.test(status)) {
    return { title: "Done", stage, micHealth: "Stable", guidance: "Suggested delays were applied." };
  }
  return { title: "Ready", stage, micHealth: "Idle", guidance: "Start calibration to see attempt-by-attempt progress here." };
}

function getCalibrationEntries() {
  if (telemetryState?.recentCalibrationEntries?.length) {
    return telemetryState.recentCalibrationEntries.map((entry) => ({
      time: entry.time || "",
      text: entry.text || "",
      tone: entry.tone || ""
    }));
  }
  return (state?.logEntries || [])
    .filter((entry) => /Calibration|burst|stable|result|summary/i.test(entry.displayText))
    .slice(-8)
    .map((entry) => ({
      time: entry.displayText.slice(0, 8),
      text: entry.displayText.replace(/^\d{2}:\d{2}:\d{2}\s+\[[A-Z]+\]\s*/, ""),
      tone: /ERROR|fail/i.test(entry.displayText) ? "danger" : /WARN/i.test(entry.displayText) ? "warn" : ""
    }))
    .reverse();
}

function findRoute(slot) {
  return state?.outputs?.find((output) => output.slotIndex === slot) || null;
}

function channelColor(slot) {
  const palette = ["#ff5f57", "#34c759", "#ff9f41", "#5fa7ff", "#d17dff", "#ffd84d", "#62e2ff", "#ff7aa2"];
  return palette[(slot - 1) % palette.length];
}

function activeTapeColor(slot) {
  const tapes = ["#f0e2ca", "#ead9be", "#f2e7d4", "#efe0bf"];
  return tapes[(slot - 1) % tapes.length];
}

function normalizeEmpty(value) {
  return value || null;
}

function titleCase(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// SSE endpoints serialize JSON with PascalCase keys while REST endpoints use camelCase.
// This normalizes SSE event payloads so all downstream code reads consistent camelCase.
function normalizeSsePayload(data) {
  if (Array.isArray(data)) return data.map(normalizeSsePayload);
  if (data && typeof data === 'object') {
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k.charAt(0).toLowerCase() + k.slice(1), normalizeSsePayload(v)])
    );
  }
  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function readBool(key, fallback) {
  const value = localStorage.getItem(key);
  if (value === null) {
    return fallback;
  }
  return value === "1" || value === "true";
}
