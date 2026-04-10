const POLL_MS = 2000;
const SAFETY_MS = 1000;
const STALE_MS = 4000;
const TELE_STALE_MS = 2500;
const TELE_POLL_MS = 90;
const SETTINGS_DEBOUNCE_MS = 220;
const RETRY_MS = 1600;

let state = null;
let telemetryState = null;
let pollInFlight = false;
let telePollInFlight = false;
let eventStream = null;
let teleStream = null;
let fallbackTimer = null;
let telePollTimer = null;
let settingsTimer = null;
let lastStateAt = 0;
let lastTeleAt = 0;
let calibrationInFlight = false;
let deviceProfileSaveInFlight = false;
let selectedSlot = Number(localStorage.getItem("launchDeck.selectedSlot")) || 0;
const animatedMeters = new Map();
let meterAnimationFrame = 0;

const $ = (id) => document.getElementById(id);
const el = {
  startBtn: $("startBtn"),
  stopBtn: $("stopBtn"),
  calibrateBtn: $("calibrateBtn"),
  refreshBtn: $("refreshBtn"),
  openVariantRouteBtn: $("openVariantRouteBtn"),
  variantRouteSelect: $("variantRouteSelect"),
  enginePill: $("enginePill"),
  inputSelect: $("inputSelect"),
  calibrationSelect: $("calibrationSelect"),
  testToneCheckbox: $("testToneCheckbox"),
  masterVolumeRange: $("masterVolumeRange"),
  masterVolumeValue: $("masterVolumeValue"),
  markerLevelRange: $("markerLevelRange"),
  markerLevelValue: $("markerLevelValue"),
  snapEngine: $("snapEngine"),
  snapMaster: $("snapMaster"),
  bufferHealthText: $("bufferHealthText"),
  latencyVarianceText: $("latencyVarianceText"),
  sessionUptimeText: $("sessionUptimeText"),
  channelPills: $("channelPills"),
  selectedFocusTag: $("selectedFocusTag"),
  selectedName: $("selectedName"),
  selectedDevice: $("selectedDevice"),
  selectedDelay: $("selectedDelay"),
  selectedVolume: $("selectedVolume"),
  selectedDrift: $("selectedDrift"),
  selectedConfidence: $("selectedConfidence"),
  roomCoherenceValue: $("roomCoherenceValue"),
  roomCoherenceFill: $("roomCoherenceFill"),
  latencyPredictabilityValue: $("latencyPredictabilityValue"),
  latencyPredictabilityFill: $("latencyPredictabilityFill"),
  bufferStabilityValue: $("bufferStabilityValue"),
  bufferStabilityFill: $("bufferStabilityFill"),
  tuningDelayText: $("tuningDelayText"),
  tuningDelayFill: $("tuningDelayFill"),
  tuningGainText: $("tuningGainText"),
  tuningGainFill: $("tuningGainFill"),
  tuningDriftText: $("tuningDriftText"),
  tuningDriftFill: $("tuningDriftFill"),
  roomNodes: $("roomNodes"),
  mapSummaryCards: $("mapSummaryCards"),
  copyLogsBtn: $("copyLogsBtn"),
  logOutput: $("logOutput"),
  sessionEngineText: $("sessionEngineText"),
  sessionModeText: $("sessionModeText"),
  sessionMasterText: $("sessionMasterText"),
  sessionBufferText: $("sessionBufferText"),
  openConfigFolderBtn: $("openConfigFolderBtn"),
  openDeviceProfileBtn: $("openDeviceProfileBtn"),
  summaryName: $("summaryName"),
  summaryDevice: $("summaryDevice"),
  summaryDelay: $("summaryDelay"),
  summaryDrift: $("summaryDrift"),
  summaryCoherenceValue: $("summaryCoherenceValue"),
  summaryCoherenceFill: $("summaryCoherenceFill"),
  summaryPredictabilityValue: $("summaryPredictabilityValue"),
  summaryPredictabilityFill: $("summaryPredictabilityFill"),
  calibrationTone: $("calibrationTone"),
  calibrationMicHealth: $("calibrationMicHealth"),
  calibrationStage: $("calibrationStage"),
  calibrationGuidance: $("calibrationGuidance"),
  roomPercent: $("roomPercent"),
  roomFill: $("roomFill"),
  capturePercent: $("capturePercent"),
  captureFill: $("captureFill"),
  attemptsMeta: $("attemptsMeta"),
  attemptsList: $("attemptsList"),
  lastErrorCard: $("lastErrorCard"),
  lastErrorText: $("lastErrorText"),
  toastStack: $("toastStack"),
  deviceProfileDialog: $("deviceProfileDialog"),
  deviceProfileTitle: $("deviceProfileTitle"),
  deviceProfileSubtitle: $("deviceProfileSubtitle"),
  deviceProfileAliasInput: $("deviceProfileAliasInput"),
  deviceProfileTypeSelect: $("deviceProfileTypeSelect"),
  deviceProfileCancelBtn: $("deviceProfileCancelBtn"),
  deviceProfileSaveBtn: $("deviceProfileSaveBtn")
};

boot();

async function boot() {
  bindEvents();
  await refreshState(true);
  connectEvents();
  connectTelemetry();
  startTelemetryPolling();
  window.setInterval(runSafetyChecks, SAFETY_MS);
}

function bindEvents() {
  el.startBtn.addEventListener("click", () => mutate(() => api("/api/start", { method: "POST" })));
  el.stopBtn.addEventListener("click", () => mutate(() => api("/api/stop", { method: "POST" })));
  el.refreshBtn.addEventListener("click", () => mutate(() => api("/api/refresh-devices", { method: "POST" })));
  el.calibrateBtn.addEventListener("click", handleCalibrationButton);
  el.copyLogsBtn.addEventListener("click", copyLogs);
  el.openConfigFolderBtn.addEventListener("click", () => mutate(() => api("/api/open-config-folder", { method: "POST" })));
  el.openDeviceProfileBtn.addEventListener("click", openDeviceProfileEditor);
  el.deviceProfileCancelBtn.addEventListener("click", closeDeviceProfileEditor);
  el.deviceProfileSaveBtn.addEventListener("click", saveDeviceProfile);
  el.deviceProfileDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDeviceProfileEditor();
  });

  [el.inputSelect, el.calibrationSelect, el.testToneCheckbox, el.masterVolumeRange, el.markerLevelRange].forEach((control) => {
    control.addEventListener("input", queueSettingsUpdate);
    control.addEventListener("change", queueSettingsUpdate);
  });

  document.querySelectorAll("[data-sync-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      setSyncMode(button.dataset.syncMode || "Off");
      queueSettingsUpdate();
    });
  });

  document.querySelectorAll("[data-assist]").forEach((button) => {
    button.addEventListener("click", handleAssistAction);
  });

  if (el.variantRouteSelect && el.openVariantRouteBtn) {
    const savedRoute = localStorage.getItem("multiAudio.route") || "/";
    el.variantRouteSelect.value = [...el.variantRouteSelect.options].some((option) => option.value === savedRoute)
      ? savedRoute
      : "/";

    el.variantRouteSelect.addEventListener("change", () => {
      localStorage.setItem("multiAudio.route", el.variantRouteSelect.value);
    });

    el.openVariantRouteBtn.addEventListener("click", () => {
      localStorage.setItem("multiAudio.route", el.variantRouteSelect.value);
      window.location.href = el.variantRouteSelect.value;
    });
  }
}

function connectEvents() {
  if (!window.EventSource) {
    startFallbackPolling();
    return;
  }

  if (eventStream) {
    eventStream.close();
  }

  eventStream = new EventSource("/api/events");
  eventStream.addEventListener("state", (event) => {
    try {
      lastStateAt = Date.now();
      setState(normalizeSsePayload(JSON.parse(event.data)));
      stopFallbackPolling();
    } catch {
      startFallbackPolling();
    }
  });
  eventStream.onopen = () => {
    lastStateAt = Date.now();
    stopFallbackPolling();
  };
  eventStream.onerror = () => {
    startFallbackPolling();
    window.setTimeout(() => {
      if (eventStream?.readyState === EventSource.CLOSED) {
        connectEvents();
      }
    }, RETRY_MS);
  };
}

function connectTelemetry() {
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
      // Next reconnect can recover.
    }
  });
  teleStream.onopen = () => {
    lastTeleAt = Date.now();
  };
  teleStream.onerror = () => {
    window.setTimeout(() => {
      if (teleStream?.readyState === EventSource.CLOSED) {
        connectTelemetry();
      }
    }, RETRY_MS);
  };
}

function startFallbackPolling() {
  if (fallbackTimer) {
    return;
  }
  fallbackTimer = window.setInterval(() => refreshState(), POLL_MS);
}

function stopFallbackPolling() {
  if (!fallbackTimer) {
    return;
  }
  window.clearInterval(fallbackTimer);
  fallbackTimer = null;
}

function startTelemetryPolling() {
  if (telePollTimer) {
    return;
  }
  telePollTimer = window.setInterval(() => refreshTelemetry(), TELE_POLL_MS);
}

function runSafetyChecks() {
  if (Date.now() - lastStateAt > STALE_MS) {
    refreshState(true);
  }
  if ((state?.isRunning || state?.isCalibrating) && Date.now() - lastTeleAt > TELE_STALE_MS) {
    connectTelemetry();
    refreshTelemetry(true);
  }
}

async function refreshState(force = false) {
  if (pollInFlight) {
    return;
  }
  pollInFlight = true;
  try {
    const nextState = await api("/api/state");
    lastStateAt = Date.now();
    setState(nextState);
  } catch (error) {
    if (force) {
      showToast(error.message || "Failed to load state.");
    }
  } finally {
    pollInFlight = false;
  }
}

async function refreshTelemetry(force = false) {
  if (telePollInFlight) {
    return;
  }
  if (!force && !(state?.isRunning || state?.isCalibrating)) {
    return;
  }
  telePollInFlight = true;
  try {
    const nextTelemetry = await api("/api/telemetry-state");
    lastTeleAt = Date.now();
    setTelemetry(nextTelemetry);
  } catch {
    // Quiet by design.
  } finally {
    telePollInFlight = false;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      (typeof payload === "object" && (payload.error || payload.title || payload.detail)) ||
      payload ||
      "Request failed.";
    throw new Error(message);
  }

  return payload;
}

async function mutate(action) {
  try {
    setState(await action());
    refreshTelemetry(true);
  } catch (error) {
    showToast(error.message || "Action failed.");
  }
}

function handleCalibrationButton() {
  if (!state || calibrationInFlight) {
    return;
  }
  if (state.isCalibrating) {
    cancelCalibration();
    return;
  }
  startCalibration();
}

async function startCalibration() {
  calibrationInFlight = true;
  renderControls();
  try {
    setState(await api("/api/calibrate", { method: "POST" }));
  } catch (error) {
    showToast(error.message || "Calibration failed.");
  } finally {
    calibrationInFlight = false;
    renderControls();
  }
}

async function cancelCalibration() {
  calibrationInFlight = true;
  renderControls();
  try {
    setState(await api("/api/calibrate/cancel", { method: "POST" }));
  } catch (error) {
    showToast(error.message || "Failed to cancel calibration.");
  } finally {
    calibrationInFlight = false;
    renderControls();
  }
}

function queueSettingsUpdate() {
  syncSettingsLabels();
  window.clearTimeout(settingsTimer);
  settingsTimer = window.setTimeout(() => {
    settingsTimer = null;
    mutate(() => api("/api/settings", {
      method: "PUT",
      body: {
        selectedInputDeviceId: normalizeEmpty(el.inputSelect.value),
        selectedCalibrationInputDeviceId: normalizeEmpty(el.calibrationSelect.value),
        useTestTone: el.testToneCheckbox.checked,
        masterVolumePercent: Number(el.masterVolumeRange.value),
        autoSyncMode: currentSyncMode(),
        markerLevelPercent: Number(el.markerLevelRange.value)
      }
    }));
  }, SETTINGS_DEBOUNCE_MS);
}

function handleAssistAction(event) {
  const action = event.currentTarget.dataset.assist;
  if (action === "refresh") {
    mutate(() => api("/api/refresh-devices", { method: "POST" }));
    return;
  }
  if (action === "calibrate") {
    handleCalibrationButton();
    return;
  }
  if (action === "control") {
    localStorage.setItem("multiAudio.route", "/v2/");
    window.location.href = "/v2/";
  }
}

function setState(nextState) {
  if (!nextState) {
    return;
  }
  state = nextState;
  const outputs = state.outputs || [];
  if (!outputs.some((output) => output.slotIndex === selectedSlot)) {
    selectedSlot = outputs[0]?.slotIndex ?? 0;
  }
  localStorage.setItem("launchDeck.selectedSlot", String(selectedSlot || 0));
  if (!telemetryState) {
    telemetryState = buildTelemetryFromState(nextState);
  }
  render();
}

function setTelemetry(nextTelemetry) {
  if (!nextTelemetry) {
    return;
  }
  telemetryState = nextTelemetry;
  mergeTelemetryIntoState(nextTelemetry);
  render();
}

function mergeTelemetryIntoState(nextTelemetry) {
  if (!state || !nextTelemetry?.outputs?.length) {
    return;
  }

  const teleBySlot = new Map(nextTelemetry.outputs.map((output) => [output.slotIndex, output]));
  for (const output of state.outputs || []) {
    const teleOut = teleBySlot.get(output.slotIndex);
    if (!teleOut) {
      continue;
    }
    output.meterLevel = teleOut.meterLevel ?? output.meterLevel ?? 0;
    output.statusText = teleOut.statusText || output.statusText;
    output.appliedVolumePercent = teleOut.appliedVolumePercent ?? output.appliedVolumePercent ?? output.volumePercent ?? 0;
    output.delayMilliseconds = teleOut.delayMilliseconds ?? output.delayMilliseconds ?? 0;
    output.effectiveDelayMilliseconds = teleOut.effectiveDelayMilliseconds ?? output.effectiveDelayMilliseconds ?? output.delayMilliseconds ?? 0;
    output.syncConfidence = teleOut.syncConfidence ?? output.syncConfidence ?? 0;
    output.syncLockState = (typeof teleOut.syncLockState === 'string' && teleOut.syncLockState) ? teleOut.syncLockState : output.syncLockState;
    output.playbackRateRatio = teleOut.playbackRateRatio ?? output.playbackRateRatio ?? 1;
    output.isMuted = !!teleOut.isMuted;
    output.isSolo = !!teleOut.isSolo;
    output.bufferedMilliseconds = teleOut.bufferedMilliseconds ?? output.bufferedMilliseconds ?? 0;
  }

  state.captureLevel = nextTelemetry.captureLevel ?? state.captureLevel ?? 0;
  state.roomMicLevel = nextTelemetry.roomMicLevel ?? state.roomMicLevel ?? 0;
  state.calibrationProgressMessage = nextTelemetry.calibrationProgressMessage || state.calibrationProgressMessage;
}

function render() {
  if (!state) {
    return;
  }
  renderControls();
  renderChannelPills();
  renderFocusPanels();
  renderRoomMap();
  renderPulse();
  renderCalibrationWatch();
  renderLogs();
  renderErrors();
}

function renderControls() {
  const master = findMasterOutput();
  const liveText = state.isCalibrating ? "Calibrating" : state.isRunning ? "Live Session" : "Offline";

  el.enginePill.className = `top-pill ${state.isRunning ? "live" : state.isCalibrating ? "calibrating" : "offline"}`;
  el.enginePill.innerHTML = `<span class="dot"></span>${escapeHtml(liveText)}`;
  el.startBtn.disabled = !state.canStart;
  el.stopBtn.disabled = !state.canStop;
  el.refreshBtn.disabled = !state.canRefreshDevices;
  el.calibrateBtn.disabled = calibrationInFlight || (!state.canRunCalibration && !state.isCalibrating);
  el.calibrateBtn.textContent = state.isCalibrating ? "Cancel calibration" : "Calibrate";

  renderSelect(el.inputSelect, state.inputDevices || [], state.selectedInputDeviceId, !state.canEditTopology);
  renderSelect(el.calibrationSelect, state.inputDevices || [], state.selectedCalibrationInputDeviceId, state.isCalibrating);

  if (document.activeElement !== el.masterVolumeRange) {
    el.masterVolumeRange.value = String(Math.round(state.masterVolumePercent || 0));
  }
  if (document.activeElement !== el.markerLevelRange) {
    el.markerLevelRange.value = String(Number(state.markerLevelPercent || 0));
  }
  if (document.activeElement !== el.testToneCheckbox) {
    el.testToneCheckbox.checked = !!state.useTestTone;
  }

  setSyncMode(state.autoSyncMode || "Off");
  syncSettingsLabels();

  el.snapEngine.textContent = state.isRunning ? "Streaming" : state.isCalibrating ? "Calibrating" : "Offline";
  el.snapMaster.textContent = master ? `CH ${master.slotIndex}` : "--";

  const outputs = state.outputs || [];
  const lowConfidence = outputs.filter((output) => (output.syncConfidence || 0) < 0.88).length;
  const faulted = outputs.filter((output) => /fault|error/i.test(output.statusText || "")).length;
  el.bufferHealthText.textContent = faulted ? "Degraded" : lowConfidence ? "Watch" : "Stable";
  el.latencyVarianceText.textContent = latencyVarianceLabel(outputs);
  el.sessionUptimeText.textContent = sessionUptimeLabel();
}

function renderChannelPills() {
  const outputs = state.outputs || [];
  el.channelPills.innerHTML = outputs.map((output) => {
    const accent = channelAccent(output.slotIndex);
    const active = output.slotIndex === selectedSlot ? " active" : "";
    return `
      <button class="channel-pill${active}" type="button" data-slot="${output.slotIndex}" style="--card-accent:${accent.gradient};--icon-bg:${accent.gradient}">
        <div class="channel-pill-top">
          <div class="channel-pill-icon">${channelGlyph(output)}</div>
          <div class="channel-pill-copy">
            <span>Channel ${output.slotIndex}</span>
            <strong>${escapeHtml(outputLabel(output))}</strong>
            <span>${escapeHtml(outputDevice(output))}</span>
          </div>
          <div class="delay-readout">
            <span>Delay</span>
            <strong>${Math.round(output.delayMilliseconds || 0)}<small>ms</small></strong>
          </div>
        </div>
        <div class="channel-pill-bottom">
          <span>${Math.round((output.syncConfidence || 0) * 100)}% sync confidence</span>
          <span class="pill-tag">${escapeHtml(output.isTimingMaster ? "Master" : output.syncLockState || output.statusText || "Idle")}</span>
        </div>
        <div class="progress-track slim"><div class="progress-fill" data-pill-meter="${output.slotIndex}"></div></div>
      </button>
    `;
  }).join("");

  el.channelPills.querySelectorAll("[data-slot]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedSlot = Number(button.dataset.slot);
      localStorage.setItem("launchDeck.selectedSlot", String(selectedSlot));
      render();
    });
  });

  for (const output of outputs) {
    const meter = el.channelPills.querySelector(`[data-pill-meter="${output.slotIndex}"]`);
    updateMeterPercent(meter, Math.round((output.syncConfidence || 0) * 100));
  }
}

function renderFocusPanels() {
  const selected = selectedOutput();
  if (!selected) {
    el.openDeviceProfileBtn.disabled = true;
    return;
  }

  const coherence = Math.round((selected.syncConfidence || 0) * 100);
  const predictability = latencyPredictability(selected);
  const stability = bufferStability(selected);
  const gainValue = Math.round(selected.appliedVolumePercent ?? selected.volumePercent ?? 0);
  const driftMs = driftMilliseconds(selected);

  el.selectedFocusTag.textContent = selected.isTimingMaster ? "Master" : selected.syncLockState || "Focus";
  el.selectedName.textContent = outputLabel(selected);
  el.selectedDevice.textContent = outputDevice(selected);
  el.selectedDelay.innerHTML = `${Math.round(selected.delayMilliseconds || 0)} <small>ms</small>`;
  el.selectedVolume.innerHTML = `${Math.round(selected.volumePercent || 0)} <small>%</small>`;
  el.selectedDrift.innerHTML = `${driftMs.toFixed(1)} <small>ms</small>`;
  el.selectedConfidence.innerHTML = `${coherence} <small>%</small>`;
  el.roomCoherenceValue.textContent = `${coherence}%`;
  el.latencyPredictabilityValue.textContent = `${predictability}%`;
  el.bufferStabilityValue.textContent = `${stability}%`;
  el.tuningDelayText.textContent = `${Math.round(selected.delayMilliseconds || 0)} ms`;
  el.tuningGainText.textContent = `${gainValue}%`;
  el.tuningDriftText.textContent = driftMs > 1.5 ? "Guarded" : driftMs > 0.5 ? "Adaptive" : "Locked";
  updateMeterPercent(el.roomCoherenceFill, coherence);
  updateMeterPercent(el.latencyPredictabilityFill, predictability);
  updateMeterPercent(el.bufferStabilityFill, stability);
  updateMeterPercent(el.tuningDelayFill, scaleDelay(selected.delayMilliseconds || 0));
  updateMeterPercent(el.tuningGainFill, gainValue);
  updateMeterPercent(el.tuningDriftFill, driftGuardPercent(driftMs));

  el.summaryName.textContent = outputLabel(selected);
  el.summaryDevice.textContent = outputDevice(selected);
  el.openDeviceProfileBtn.disabled = !selected.selectedDeviceId;
  el.summaryDelay.innerHTML = `${Math.round(selected.delayMilliseconds || 0)} <small>ms</small>`;
  el.summaryDrift.innerHTML = `${driftMs.toFixed(1)} <small>ms</small>`;
  el.summaryCoherenceValue.textContent = `${coherence}%`;
  el.summaryPredictabilityValue.textContent = `${predictability}%`;
  updateMeterPercent(el.summaryCoherenceFill, coherence);
  updateMeterPercent(el.summaryPredictabilityFill, predictability);
}

function renderRoomMap() {
  const outputs = state.outputs || [];
  const positions = nodePositions(outputs.length);

  el.roomNodes.innerHTML = outputs.map((output, index) => {
    const pos = positions[index] || { x: 50, y: 50 };
    const accent = channelAccent(output.slotIndex);
    const active = output.slotIndex === selectedSlot ? " active" : "";
    return `
      <button class="map-node-button${active}" type="button" data-slot="${output.slotIndex}" style="left:${pos.x}%;top:${pos.y}%">
        ${channelGlyph(output)}
        <span class="map-node-dot" style="--node-color:${accent.color}"></span>
        <span class="map-node-label">${escapeHtml(outputLabel(output))}</span>
      </button>
    `;
  }).join("");

  el.mapSummaryCards.innerHTML = outputs.map((output) => {
    const active = output.slotIndex === selectedSlot ? " active" : "";
    return `
      <button class="map-summary-card${active}" type="button" data-slot="${output.slotIndex}">
        <div class="map-summary-head">
          <span>CH ${output.slotIndex}</span>
          <span>${Math.round(output.delayMilliseconds || 0)} ms</span>
        </div>
        <strong>${escapeHtml(outputLabel(output))}</strong>
        <p>Predicted phase lock in ${arrivalLockSeconds(output).toFixed(1)}s</p>
        <div class="map-summary-foot">
          <span>${Math.round((output.syncConfidence || 0) * 100)}% confidence</span>
        </div>
      </button>
    `;
  }).join("");

  [...el.roomNodes.querySelectorAll("[data-slot]"), ...el.mapSummaryCards.querySelectorAll("[data-slot]")].forEach((button) => {
    button.addEventListener("click", () => {
      selectedSlot = Number(button.dataset.slot);
      localStorage.setItem("launchDeck.selectedSlot", String(selectedSlot));
      render();
    });
  });
}

function renderPulse() {
  const master = findMasterOutput();
  const outputs = state.outputs || [];
  const averageBuffer = outputs.length
    ? Math.round(outputs.reduce((sum, output) => sum + Number(output.bufferedMilliseconds || 0), 0) / outputs.length)
    : 0;
  el.sessionEngineText.textContent = state.isRunning ? "Streaming Mesh" : state.isCalibrating ? "Calibration" : "Offline";
  el.sessionModeText.textContent = titleCase(state.autoSyncMode || "Off");
  el.sessionMasterText.textContent = master ? `CH ${master.slotIndex}` : "--";
  el.sessionBufferText.textContent = `${averageBuffer} ms`;
}

function renderCalibrationWatch() {
  const watch = calibrationModel();
  const roomLevel = Number(state.roomMicLevel || 0);
  const captureLevel = Number(state.captureLevel || 0);

  el.calibrationTone.textContent = watch.title;
  el.calibrationMicHealth.textContent = watch.micHealth;
  el.calibrationStage.textContent = watch.stage;
  el.calibrationGuidance.textContent = watch.guidance;
  el.roomPercent.textContent = percentText(roomLevel);
  el.capturePercent.textContent = percentText(captureLevel);
  updateMeterPercent(el.roomFill, roomLevel * 100);
  updateMeterPercent(el.captureFill, captureLevel * 100);

  const attempts = recentCalibrationEntries();
  el.attemptsMeta.textContent = attempts.length ? `${attempts.length} recent entries` : "No recent attempts";
  el.attemptsList.innerHTML = attempts.map((entry) => `
    <div class="attempt-entry">
      <time>${escapeHtml(entry.time || "--:--:--")}</time>
      <p>${escapeHtml(entry.text || "")}</p>
    </div>
  `).join("");
}

function renderLogs() {
  const lines = (state.logEntries || []).slice(-12).map((entry) => entry.displayText || entry.text || "");
  el.logOutput.textContent = lines.length ? lines.join("\n") : "No log entries yet.";
}

function renderErrors() {
  const hasError = !!state.lastErrorMessage;
  el.lastErrorCard.classList.toggle("hidden", !hasError);
  if (hasError) {
    el.lastErrorText.textContent = state.lastErrorMessage;
  }
}

function renderSelect(element, options, selected, disabled) {
  const next = [`<option value="">Not selected</option>`].concat(
    (options || []).map((option) =>
      `<option value="${escapeHtml(option.id)}" ${option.id === selected ? "selected" : ""}>${escapeHtml(option.displayName || option.name)}</option>`
    )
  ).join("");
  if (element.innerHTML !== next) {
    element.innerHTML = next;
  }
  element.disabled = !!disabled;
}

function syncSettingsLabels() {
  el.masterVolumeValue.textContent = `${Math.round(Number(el.masterVolumeRange.value || 0))}`;
  el.markerLevelValue.textContent = `${Number(el.markerLevelRange.value || 0).toFixed(1)}%`;
}

function setSyncMode(mode) {
  document.querySelectorAll("[data-sync-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.syncMode === mode);
  });
}

function currentSyncMode() {
  const active = document.querySelector("[data-sync-mode].active");
  return active?.dataset.syncMode || "Off";
}

function selectedOutput() {
  return (state?.outputs || []).find((output) => output.slotIndex === selectedSlot) || null;
}

function findMasterOutput() {
  return (state?.outputs || []).find((output) => output.isTimingMaster) || null;
}

function outputLabel(output) {
  return output.selectedDeviceName || output.selectedDeviceDisplayName || output.displayName || `Output ${output.slotIndex}`;
}

function outputDevice(output) {
  return output.selectedDeviceDescription || output.statusText || output.selectedDeviceName || "No device selected";
}

function channelGlyph(output) {
  return iconSvg(resolveDeviceIconKind(output));
}

function resolveDeviceIconKind(output) {
  const explicitType = normalizeIconType(output.selectedDeviceIconType || output.iconType || "auto");
  if (explicitType !== "auto") {
    return explicitType;
  }
  const text = `${outputLabel(output)} ${outputDevice(output)}`.toLowerCase();
  if (text.includes("soundbar") || text.includes("sound bar")) {
    return "soundbar";
  }
  if (text.includes("bookshelf") || text.includes("book shelf")) {
    return "bookshelf";
  }
  if (
    text.includes("ult field") ||
    text.includes("portable speaker") ||
    text.includes("portable") ||
    text.includes("bluetooth")
  ) {
    return "portable";
  }
  if (text.includes("head")) {
    return "headphones";
  }
  if (text.includes("wifi") || text.includes("wireless")) {
    return "wireless-speaker";
  }
  return "speaker";
}

function iconSvg(kind) {
  switch (kind) {
    case "soundbar":
      return `<img class="device-icon-image" data-icon-kind="soundbar" src="/device-icons/soundbar.svg" alt="" aria-hidden="true">`;
    case "bookshelf":
      return `<img class="device-icon-image" data-icon-kind="bookshelf" src="/device-icons/bookshelf.svg" alt="" aria-hidden="true">`;
    case "portable":
      return `<img class="device-icon-image" data-icon-kind="portable" src="/device-icons/portable.svg" alt="" aria-hidden="true">`;
    case "headphones":
      return `<img class="device-icon-image" data-icon-kind="headphones" src="/device-icons/headphones.svg" alt="" aria-hidden="true">`;
    case "wireless-speaker":
      return `<img class="device-icon-image" data-icon-kind="speaker" src="/device-icons/speaker.svg" alt="" aria-hidden="true">`;
    default:
      return `<img class="device-icon-image" data-icon-kind="speaker" src="/device-icons/speaker.svg" alt="" aria-hidden="true">`;
  }
}

function normalizeIconType(value) {
  const normalized = String(value || "auto").trim().toLowerCase();
  return ["auto", "speaker", "bookshelf", "soundbar", "portable", "headphones"].includes(normalized)
    ? normalized
    : "auto";
}

function selectedPlaybackDevice() {
  const selected = selectedOutput();
  if (!selected?.selectedDeviceId) {
    return null;
  }
  return (state?.playbackDevices || []).find((device) => device.id === selected.selectedDeviceId) || null;
}

function openDeviceProfileEditor() {
  const device = selectedPlaybackDevice();
  if (!device || !el.deviceProfileDialog) {
    return;
  }
  el.deviceProfileTitle.textContent = device.name || device.displayName || "Customize output device";
  el.deviceProfileSubtitle.textContent = `Windows device: ${device.name || device.displayName || "Unknown device"}`;
  el.deviceProfileAliasInput.value = device.alias || "";
  el.deviceProfileTypeSelect.value = normalizeIconType(device.iconType || "auto");
  el.deviceProfileDialog.showModal();
}

function closeDeviceProfileEditor() {
  el.deviceProfileDialog?.close();
}

async function saveDeviceProfile() {
  const device = selectedPlaybackDevice();
  if (!device || deviceProfileSaveInFlight) {
    return;
  }
  deviceProfileSaveInFlight = true;
  el.deviceProfileSaveBtn.disabled = true;
  try {
    setState(await api("/api/device-profiles", {
      method: "PUT",
      body: {
        deviceId: device.id,
        alias: normalizeEmpty(el.deviceProfileAliasInput.value),
        iconType: normalizeIconType(el.deviceProfileTypeSelect.value)
      }
    }));
    closeDeviceProfileEditor();
    showToast("Device customization saved.", "success");
  } catch (error) {
    showToast(error.message || "Failed to save device customization.");
  } finally {
    deviceProfileSaveInFlight = false;
    el.deviceProfileSaveBtn.disabled = false;
  }
}

function channelAccent(slotIndex) {
  const accents = [
    { color: "#38bdf8", gradient: "linear-gradient(90deg,#38bdf8,#22d3ee)" },
    { color: "#a855f7", gradient: "linear-gradient(90deg,#a855f7,#8b5cf6)" },
    { color: "#f59e0b", gradient: "linear-gradient(90deg,#f59e0b,#fb7185)" },
    { color: "#34d399", gradient: "linear-gradient(90deg,#34d399,#22c55e)" }
  ];
  return accents[(Math.max(slotIndex, 1) - 1) % accents.length];
}

function latencyPredictability(output) {
  const drift = Math.abs(driftMilliseconds(output));
  return clamp(100 - drift * 10, 48, 99);
}

function bufferStability(output) {
  const buffer = Number(output.bufferedMilliseconds || 0);
  const predicted = 100 - Math.min(42, Math.abs(buffer - 220) / 6);
  return clamp(Math.round(predicted), 42, 99);
}

function driftGuardPercent(drift) {
  return clamp(Math.round(100 - drift * 18), 28, 100);
}

function arrivalLockSeconds(output) {
  const estimate = Number(output.estimatedArrivalMilliseconds || output.bufferedMilliseconds || 300);
  return Math.max(0.1, estimate / 1000);
}

function driftMilliseconds(output) {
  return Math.abs((Number(output.playbackRateRatio || 1) - 1) * 1000);
}

function scaleDelay(delayMs) {
  return clamp(Math.round((Number(delayMs || 0) / 700) * 100), 0, 100);
}

function sessionUptimeLabel() {
  const logs = state?.logEntries || [];
  if (!logs.length) {
    return state?.isRunning ? "Live" : "Idle";
  }
  const first = parseClock(logs[0].displayText || "");
  const last = parseClock(logs[logs.length - 1].displayText || "");
  if (first === null || last === null) {
    return state?.isRunning ? "Live" : "Idle";
  }
  const delta = Math.max(0, last - first);
  return `${Math.max(1, Math.round(delta / 60))}m`;
}

function latencyVarianceLabel(outputs) {
  const worst = outputs.reduce((max, output) => Math.max(max, driftMilliseconds(output)), 0);
  if (worst >= 2.5) {
    return "High";
  }
  if (worst >= 1.2) {
    return "Moderate";
  }
  return "Low";
}

function calibrationModel() {
  const stage = telemetryState?.calibrationProgressMessage || state?.calibrationProgressMessage || state?.calibrationStatusMessage || "Calibration idle.";
  const roomLevel = Number(state?.roomMicLevel || 0);
  const status = String(state?.calibrationStatusMessage || "");
  const lastError = String(state?.lastErrorMessage || "");

  if (state?.isCalibrating) {
    if (roomLevel >= 0.92) {
      return { title: "Too Hot", micHealth: "Overloaded", stage, guidance: "Room mic is overloaded. Lower gain or output level." };
    }
    if (roomLevel >= 0.08) {
      return { title: "Healthy Signal", micHealth: "Usable", stage, guidance: "Bursts are landing clearly. Let calibration continue." };
    }
    if (roomLevel >= 0.025) {
      return { title: "Borderline", micHealth: "Weak", stage, guidance: "Signal is getting through, but the pass is still fragile." };
    }
    return { title: "Too Quiet", micHealth: "Barely hearing bursts", stage, guidance: "Increase speaker volume, move the mic closer, or use a hotter mic input." };
  }

  if (/failed/i.test(status) || /failed/i.test(lastError)) {
    return { title: "Calibration Failed", micHealth: "Needs adjustment", stage: status || "Calibration failed.", guidance: lastError || "Readjust volume or mic placement and try again." };
  }

  if (/applied|complete|finished/i.test(status) || /complete/i.test(stage)) {
    return { title: "Calibration Applied", micHealth: "Finished", stage, guidance: "The latest pass completed and applied delay suggestions." };
  }

  return { title: "Ready", micHealth: "Idle", stage, guidance: "Start calibration to watch the mic response and progress here." };
}

function recentCalibrationEntries() {
  if (telemetryState?.recentCalibrationEntries?.length) {
    return telemetryState.recentCalibrationEntries.slice(-8).map((entry) => ({
      time: entry.time || "",
      text: entry.text || ""
    })).reverse();
  }

  return (state?.logEntries || [])
    .filter((entry) => /Calibration sample|Calibration result|Calibration summary|Calibration diagnostics saved|Calibration failed|stable latency|burst/i.test(entry.displayText || ""))
    .slice(-8)
    .map((entry) => ({
      time: String(entry.displayText || "").slice(0, 8),
      text: String(entry.displayText || "").replace(/^\d{2}:\d{2}:\d{2}\s+\[[A-Z]+\]\s*/, "")
    }))
    .reverse();
}

function nodePositions(count) {
  const base = [
    { x: 23, y: 32 },
    { x: 76, y: 34 },
    { x: 79, y: 76 },
    { x: 28, y: 75 }
  ];
  if (count <= base.length) {
    return base.slice(0, count);
  }

  return Array.from({ length: count }, (_, index) => {
    if (index < base.length) {
      return base[index];
    }
    const angle = ((index - base.length) / Math.max(1, count - base.length)) * Math.PI * 2;
    return { x: 50 + Math.cos(angle) * 34, y: 50 + Math.sin(angle) * 34 };
  });
}

async function copyLogs() {
  try {
    await navigator.clipboard.writeText(el.logOutput.textContent || "");
    showToast("Logs copied to clipboard.", "success");
  } catch {
    showToast("Clipboard access failed.");
  }
}

function showToast(message, tone = "error") {
  const toast = document.createElement("div");
  toast.className = `toast${tone === "success" ? " success" : ""}`;
  toast.textContent = message;
  el.toastStack.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function buildTelemetryFromState(currentState) {
  return {
    captureLevel: currentState.captureLevel || 0,
    roomMicLevel: currentState.roomMicLevel || 0,
    calibrationProgressMessage: currentState.calibrationProgressMessage || currentState.calibrationStatusMessage || "Calibration idle.",
    outputs: (currentState.outputs || []).map((output) => ({
      slotIndex: output.slotIndex,
      meterLevel: output.meterLevel || 0,
      statusText: output.statusText,
      appliedVolumePercent: output.appliedVolumePercent ?? output.volumePercent ?? 0,
      delayMilliseconds: output.delayMilliseconds ?? 0,
      effectiveDelayMilliseconds: output.effectiveDelayMilliseconds ?? output.delayMilliseconds ?? 0,
      syncConfidence: output.syncConfidence ?? 0,
      syncLockState: output.syncLockState,
      playbackRateRatio: output.playbackRateRatio ?? 1,
      isMuted: !!output.isMuted,
      isSolo: !!output.isSolo,
      bufferedMilliseconds: output.bufferedMilliseconds ?? 0
    }))
  };
}

function normalizeEmpty(value) {
  return value ? value : null;
}

function percentText(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function parseClock(text) {
  const match = String(text).match(/^(\d{2}):(\d{2}):(\d{2})/);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function titleCase(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function updateMeterPercent(element, value) {
  if (!element) {
    return;
  }
  const target = clamp(Number(value || 0), 0, 100);
  const current = animatedMeters.get(element)?.current ?? target;
  animatedMeters.set(element, { current, target });
  if (!meterAnimationFrame) {
    meterAnimationFrame = requestAnimationFrame(stepMeters);
  }
}

function stepMeters() {
  meterAnimationFrame = 0;
  let pendingFrame = false;

  for (const [element, meterState] of animatedMeters) {
    if (!element.isConnected) {
      animatedMeters.delete(element);
      continue;
    }
    const delta = meterState.target - meterState.current;
    if (Math.abs(delta) <= 0.35) {
      meterState.current = meterState.target;
    } else {
      meterState.current += delta * 0.28;
      pendingFrame = true;
    }
    element.style.width = `${meterState.current.toFixed(2)}%`;
    if (meterState.current === meterState.target) {
      animatedMeters.delete(element);
    }
  }

  if (pendingFrame || animatedMeters.size) {
    meterAnimationFrame = requestAnimationFrame(stepMeters);
  }
}

// SSE endpoints serialize JSON in PascalCase; REST endpoints use camelCase.
// Normalize SSE event payloads before processing so all code reads consistent camelCase.
function normalizeSsePayload(data) {
  if (Array.isArray(data)) return data.map(normalizeSsePayload);
  if (data && typeof data === 'object') {
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k.charAt(0).toLowerCase() + k.slice(1), normalizeSsePayload(v)])
    );
  }
  return data;
}
