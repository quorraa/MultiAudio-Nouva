const POLL_INTERVAL_MS = 2000;
const SAFETY_CHECK_INTERVAL_MS = 1000;
const STATE_STALE_REFRESH_MS = 4000;
const TELEMETRY_STALE_RECONNECT_MS = 2500;
const TELEMETRY_POLL_MS = 90;
const INTERACTION_PAUSE_MS = 900;
const SETTINGS_DEBOUNCE_MS = 220;
const ROUTE_DEBOUNCE_MS = 140;
const HOLD_INTERVAL_MS = 120;
const STREAM_RETRY_MS = 1600;

let state = null;
let telemetryState = null;
let pollInFlight = false;
let telemetryPollInFlight = false;
let interactionPauseUntil = 0;
let settingsTimer = null;
let deferredOutputsTimer = null;
let eventStream = null;
let telemetryStream = null;
let fallbackPollTimer = null;
let telemetryPollTimer = null;
let routeCopyBuffer = null;
let delayHoldState = null;
let routeBoardHovered = false;
let routeBoardPointerDown = false;
let lastStateSignalAt = 0;
let lastTelemetrySignalAt = 0;
let calibrationActionInFlight = false;
const routeTimers = new Map();
const routeDrafts = new Map();
const pendingRouteActions = new Set();
const diagnosticsExpanded = new Set(readJsonStorage("multiAudio.diagnosticsExpanded", []));
const layoutMode = {
  current: localStorage.getItem("multiAudio.layout") || "constellation"
};
const animatedMeters = new Map();
let meterAnimationFrame = 0;
const logsUi = {
  open: readBooleanStorage("multiAudio.logsOpen", false)
};

const elements = {
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  calibrateBtn: document.getElementById("calibrateBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  addOutputBtn: document.getElementById("addOutputBtn"),
  copyLogsBtn: document.getElementById("copyLogsBtn"),
  clearToastBtn: document.getElementById("clearToastBtn"),
  dockStartBtn: document.getElementById("dockStartBtn"),
  dockStopBtn: document.getElementById("dockStopBtn"),
  compactDockStartBtn: document.getElementById("compactDockStartBtn"),
  compactDockStopBtn: document.getElementById("compactDockStopBtn"),
  toggleLogsBtn: document.getElementById("toggleLogsBtn"),
  variantRouteSelect: document.getElementById("variantRouteSelect"),
  openVariantRouteBtn: document.getElementById("openVariantRouteBtn"),
  inputSelect: document.getElementById("inputSelect"),
  calibrationSelect: document.getElementById("calibrationSelect"),
  testToneCheckbox: document.getElementById("testToneCheckbox"),
  masterVolumeRange: document.getElementById("masterVolumeRange"),
  markerLevelRange: document.getElementById("markerLevelRange"),
  compactDockMasterRange: document.getElementById("compactDockMasterRange"),
  masterVolumeValue: document.getElementById("masterVolumeValue"),
  markerLevelValue: document.getElementById("markerLevelValue"),
  compactDockMasterValue: document.getElementById("compactDockMasterValue"),
  sessionStatus: document.getElementById("sessionStatus"),
  captureStatus: document.getElementById("captureStatus"),
  calibrationStatus: document.getElementById("calibrationStatus"),
  calibrationWatch: document.getElementById("calibrationWatch"),
  calibrationWatchTone: document.getElementById("calibrationWatchTone"),
  calibrationWatchStage: document.getElementById("calibrationWatchStage"),
  calibrationWatchGuidance: document.getElementById("calibrationWatchGuidance"),
  calibrationWatchRoomFill: document.getElementById("calibrationWatchRoomFill"),
  calibrationWatchRoomPercent: document.getElementById("calibrationWatchRoomPercent"),
  calibrationWatchCaptureFill: document.getElementById("calibrationWatchCaptureFill"),
  calibrationWatchCapturePercent: document.getElementById("calibrationWatchCapturePercent"),
  calibrationWatchMicHealth: document.getElementById("calibrationWatchMicHealth"),
  calibrationWatchMicName: document.getElementById("calibrationWatchMicName"),
  calibrationWatchAttemptsMeta: document.getElementById("calibrationWatchAttemptsMeta"),
  calibrationWatchAttempts: document.getElementById("calibrationWatchAttempts"),
  engineStatePill: document.getElementById("engineStatePill"),
  captureMeterFill: document.getElementById("captureMeterFill"),
  roomMeterFill: document.getElementById("roomMeterFill"),
  capturePercent: document.getElementById("capturePercent"),
  roomMicPercent: document.getElementById("roomMicPercent"),
  configPath: document.getElementById("configPath"),
  outputCount: document.getElementById("outputCount"),
  dockStatus: document.getElementById("dockStatus"),
  dockMode: document.getElementById("dockMode"),
  capturePercentMini: document.getElementById("capturePercentMini"),
  roomMicPercentMini: document.getElementById("roomMicPercentMini"),
  summaryInputDevice: document.getElementById("summaryInputDevice"),
  summaryCalibrationDevice: document.getElementById("summaryCalibrationDevice"),
  summaryAutoSyncMode: document.getElementById("summaryAutoSyncMode"),
  summaryTimingMaster: document.getElementById("summaryTimingMaster"),
  lockedOutputsCount: document.getElementById("lockedOutputsCount"),
  lowConfidenceOutputsCount: document.getElementById("lowConfidenceOutputsCount"),
  faultedOutputsCount: document.getElementById("faultedOutputsCount"),
  calibrationProgressText: document.getElementById("calibrationProgressText"),
  dockCaptureFill: document.getElementById("dockCaptureFill"),
  dockRoomFill: document.getElementById("dockRoomFill"),
  lastErrorCard: document.getElementById("lastErrorCard"),
  lastErrorText: document.getElementById("lastErrorText"),
  layoutOptions: document.getElementById("layoutOptions"),
  routesGrid: document.getElementById("routesGrid"),
  logsPanel: document.querySelector(".logs-panel"),
  logsDrawerBody: document.getElementById("logsDrawerBody"),
  logsBadge: document.getElementById("logsBadge"),
  logOutput: document.getElementById("logOutput"),
  compactDock: document.getElementById("compactDock"),
  compactDockState: document.getElementById("compactDockState"),
  compactDockRoutes: document.getElementById("compactDockRoutes"),
  toastStack: document.getElementById("toastStack")
};

boot();

async function boot() {
  applyLayout(layoutMode.current);
  applyLogsDrawerState();
  bindStaticEvents();
  await refreshState(true);
  connectEventStream();
  connectTelemetryStream();
  startTelemetryPolling();
  window.setInterval(runSafetyRefresh, SAFETY_CHECK_INTERVAL_MS);
}

function bindStaticEvents() {
  const start = () => mutate(() => api("/api/start", { method: "POST" }));
  const stop = () => mutate(() => api("/api/stop", { method: "POST" }));

  elements.startBtn.addEventListener("click", start);
  elements.stopBtn.addEventListener("click", stop);
  elements.dockStartBtn.addEventListener("click", start);
  elements.dockStopBtn.addEventListener("click", stop);
  elements.compactDockStartBtn.addEventListener("click", start);
  elements.compactDockStopBtn.addEventListener("click", stop);
  elements.calibrateBtn.addEventListener("click", handleCalibrationButtonClick);
  elements.refreshBtn.addEventListener("click", () => mutate(() => api("/api/refresh-devices", { method: "POST" })));
  elements.addOutputBtn.addEventListener("click", () => mutate(() => api("/api/outputs", { method: "POST" })));
  elements.copyLogsBtn.addEventListener("click", copyLogsToClipboard);
  elements.clearToastBtn.addEventListener("click", () => {
    elements.toastStack.innerHTML = "";
  });
  elements.toggleLogsBtn.addEventListener("click", toggleLogsDrawer);

  if (elements.variantRouteSelect && elements.openVariantRouteBtn) {
    const savedVariant = localStorage.getItem("multiAudio.route") || localStorage.getItem("multiAudio.variantRoute") || "/v2/";
    elements.variantRouteSelect.value = savedVariant;
    elements.variantRouteSelect.addEventListener("change", () => {
      localStorage.setItem("multiAudio.route", elements.variantRouteSelect.value);
    });
    elements.openVariantRouteBtn.addEventListener("click", () => {
      localStorage.setItem("multiAudio.route", elements.variantRouteSelect.value);
      window.location.href = elements.variantRouteSelect.value;
    });
  }

  [
    elements.inputSelect,
    elements.calibrationSelect,
    elements.testToneCheckbox,
    elements.masterVolumeRange,
    elements.markerLevelRange,
    elements.compactDockMasterRange
  ].forEach((control) => {
    control.addEventListener("input", handleSettingsInput);
    control.addEventListener("change", handleSettingsInput);
  });

  document.querySelectorAll("[data-sync-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state) {
        return;
      }

      markInteraction();
      setSyncMode(button.dataset.syncMode);
      queueSettingsUpdate();
    });
  });

  elements.layoutOptions.addEventListener("click", (event) => {
    const pill = event.target.closest("[data-layout-id]");
    if (!pill) {
      return;
    }

    applyLayout(pill.dataset.layoutId);
    renderLayoutOptions();
    renderOutputs(true);
    renderCompactDock();
  });

  elements.routesGrid.addEventListener("input", handleRouteInput);
  elements.routesGrid.addEventListener("change", handleRouteInput);
  elements.routesGrid.addEventListener("click", handleRouteClick);
  elements.routesGrid.addEventListener("pointerdown", handleRoutePointerDown);
  elements.routesGrid.addEventListener("pointerenter", () => {
    routeBoardHovered = true;
  });
  elements.routesGrid.addEventListener("pointerleave", () => {
    routeBoardHovered = false;
  });
  elements.routesGrid.addEventListener("keydown", handleRouteKeydown);
  elements.routesGrid.addEventListener("wheel", handleRouteWheel, { passive: false });
  elements.compactDockRoutes.addEventListener("click", handleCompactDockClick);
  document.addEventListener("pointerup", handleGlobalPointerRelease);
  document.addEventListener("pointercancel", handleGlobalPointerRelease);
}

function connectEventStream() {
  if (!window.EventSource) {
    startFallbackPolling();
    return;
  }

  if (eventStream) {
    eventStream.close();
  }

  eventStream = new EventSource("/api/events");
  eventStream.addEventListener("state", (event) => {
    stopFallbackPolling();
    try {
      lastStateSignalAt = Date.now();
      setState(JSON.parse(event.data));
    } catch {
      startFallbackPolling();
    }
  });
  eventStream.onopen = () => {
    lastStateSignalAt = Date.now();
    stopFallbackPolling();
  };
  eventStream.onerror = () => {
    startFallbackPolling();
    window.setTimeout(() => {
      if (eventStream && eventStream.readyState === EventSource.CLOSED) {
        connectEventStream();
      }
    }, STREAM_RETRY_MS);
  };
}

function connectTelemetryStream() {
  if (!window.EventSource) {
    return;
  }

  if (telemetryStream) {
    telemetryStream.close();
  }

  telemetryStream = new EventSource("/api/telemetry");
  telemetryStream.addEventListener("telemetry", (event) => {
    try {
      lastTelemetrySignalAt = Date.now();
      setTelemetry(JSON.parse(event.data));
    } catch {
      // Let the reconnect path handle malformed frames.
    }
  });
  telemetryStream.onopen = () => {
    lastTelemetrySignalAt = Date.now();
  };
  telemetryStream.onerror = () => {
    window.setTimeout(() => {
      if (telemetryStream && telemetryStream.readyState === EventSource.CLOSED) {
        connectTelemetryStream();
      }
    }, STREAM_RETRY_MS);
  };
}

function startFallbackPolling() {
  if (fallbackPollTimer) {
    return;
  }

  fallbackPollTimer = window.setInterval(() => {
    refreshState();
  }, POLL_INTERVAL_MS);
}

function stopFallbackPolling() {
  if (!fallbackPollTimer) {
    return;
  }

  window.clearInterval(fallbackPollTimer);
  fallbackPollTimer = null;
}

async function refreshState(force = false) {
  if (pollInFlight) {
    return;
  }

  if (!force && Date.now() < interactionPauseUntil) {
    return;
  }

  pollInFlight = true;

  try {
    const nextState = await api("/api/state");
    lastStateSignalAt = Date.now();
    setState(nextState);
  } catch (error) {
    showToast(error.message || "Failed to load state.");
  } finally {
    pollInFlight = false;
  }
}

async function refreshTelemetry(force = false) {
  if (telemetryPollInFlight) {
    return;
  }

  if (!force && !(state?.isRunning || state?.isCalibrating)) {
    return;
  }

  telemetryPollInFlight = true;

  try {
    const nextTelemetry = await api("/api/telemetry-state");
    lastTelemetrySignalAt = Date.now();
    setTelemetry(nextTelemetry);
  } catch {
    // Keep the lightweight loop quiet; SSE or the next pulse can recover.
  } finally {
    telemetryPollInFlight = false;
  }
}

function runSafetyRefresh() {
  if (!window.EventSource) {
    return;
  }

  if (Date.now() - lastStateSignalAt > STATE_STALE_REFRESH_MS) {
    refreshState(true);
  }

  if ((state?.isRunning || state?.isCalibrating) && Date.now() - lastTelemetrySignalAt > TELEMETRY_STALE_RECONNECT_MS) {
    connectTelemetryStream();
  }
}

function startTelemetryPolling() {
  if (telemetryPollTimer) {
    return;
  }

  telemetryPollTimer = window.setInterval(() => {
    refreshTelemetry();
  }, TELEMETRY_POLL_MS);
}

function handleCalibrationButtonClick() {
  if (!state || calibrationActionInFlight) {
    return;
  }

  if (state.isCalibrating) {
    cancelCalibration();
    return;
  }

  startCalibration();
}

async function startCalibration() {
  calibrationActionInFlight = true;
  applyOptimisticCalibrationState("Preparing route measurements...", "Calibration starting...");
  renderGeneralControls();

  try {
    const request = api("/api/calibrate", { method: "POST" });
    window.setTimeout(() => {
      refreshState(true);
      refreshTelemetry(true);
    }, 60);
    setState(await request);
  } catch (error) {
    showToast(error.message || "Calibration failed.");
    await refreshState(true);
  } finally {
    calibrationActionInFlight = false;
    renderGeneralControls();
  }
}

async function cancelCalibration() {
  calibrationActionInFlight = true;
  applyOptimisticCalibrationState("Stopping the active calibration run...", "Stopping calibration...");
  renderGeneralControls();

  try {
    setState(await api("/api/calibrate/cancel", { method: "POST" }));
    refreshTelemetry(true);
  } catch (error) {
    showToast(error.message || "Failed to cancel calibration.");
    await refreshState(true);
  } finally {
    calibrationActionInFlight = false;
    renderGeneralControls();
  }
}

function applyOptimisticCalibrationState(progressText, sessionText) {
  if (!state) {
    return;
  }

  state.isCalibrating = true;
  state.canRunCalibration = true;
  state.canRefreshDevices = false;
  state.canAddOutput = false;
  state.canEditTopology = false;
  state.calibrationStatusMessage = progressText;
  state.calibrationProgressMessage = progressText;
  state.sessionStatusMessage = sessionText;
  telemetryState = buildTelemetryFromState(state);
  render();
  refreshTelemetry(true);
}

async function mutate(action) {
  try {
    setState(await action());
  } catch (error) {
    showToast(error.message || "Action failed.");
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json"
    },
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

function render() {
  if (!state) {
    return;
  }

  renderLayoutOptions();
  renderGeneralControls();
  renderCalibrationWatch();
  renderSummary();
  renderLogs();
  renderCompactDock();
  renderOutputs();
  patchTelemetryFrame(telemetryState || buildTelemetryFromState(state));
}

function renderLayoutOptions() {
  elements.layoutOptions.innerHTML = state.layoutOptions
    .map((option) => `
      <button class="layout-option ${layoutMode.current === option.id ? "active" : ""}" data-layout-id="${escapeHtml(option.id)}" title="${escapeHtml(option.summary)}">
        <span class="layout-option-label">${escapeHtml(option.name)}</span>
        ${option.isRecommended ? `<span class="recommended-badge">Best Mix</span>` : ""}
      </button>
    `)
    .join("");
}

function renderGeneralControls() {
  const runningText = state.isCalibrating ? "Calibrating" : state.isRunning ? "Live" : "Offline";

  elements.sessionStatus.textContent = state.sessionStatusMessage;
  elements.captureStatus.textContent = state.captureStatusText;
  elements.calibrationStatus.textContent = state.calibrationStatusMessage;
  elements.engineStatePill.textContent = runningText;
  elements.configPath.textContent = state.configPath;
  elements.outputCount.textContent = String(state.outputs.length);
  elements.calibrateBtn.textContent = state.isCalibrating ? "Cancel Calibration" : "Run Calibration";

  elements.startBtn.disabled = !state.canStart;
  elements.stopBtn.disabled = !state.canStop;
  elements.calibrateBtn.disabled = calibrationActionInFlight || (!state.canRunCalibration && !state.isCalibrating);
  elements.refreshBtn.disabled = !state.canRefreshDevices;
  elements.addOutputBtn.disabled = !state.canAddOutput;
  elements.dockStartBtn.disabled = !state.canStart;
  elements.dockStopBtn.disabled = !state.canStop;
  elements.compactDockStartBtn.disabled = !state.canStart;
  elements.compactDockStopBtn.disabled = !state.canStop;

  renderSelect(elements.inputSelect, state.inputDevices, state.selectedInputDeviceId, !state.canEditTopology);
  renderSelect(elements.calibrationSelect, state.inputDevices, state.selectedCalibrationInputDeviceId, state.isCalibrating);

  if (!isControlDirty(elements.testToneCheckbox)) {
    elements.testToneCheckbox.checked = state.useTestTone;
  }
  elements.testToneCheckbox.disabled = !state.canEditTopology;
  setRangeValue(elements.masterVolumeRange, state.masterVolumePercent);
  setRangeValue(elements.compactDockMasterRange, state.masterVolumePercent);
  setRangeValue(elements.markerLevelRange, state.markerLevelPercent);
  elements.masterVolumeRange.disabled = state.isCalibrating;
  elements.compactDockMasterRange.disabled = state.isCalibrating;
  elements.markerLevelRange.disabled = state.isCalibrating;
  syncRangeLabels();

  document.querySelectorAll("[data-sync-mode]").forEach((button) => {
    const isActive = button.dataset.syncMode === state.autoSyncMode;
    button.classList.toggle("active", isActive);
    button.disabled = state.isCalibrating;
  });

  updateMeter(elements.captureMeterFill, state.captureLevel);
  updateMeter(elements.roomMeterFill, state.roomMicLevel);
  updateMeter(elements.dockCaptureFill, state.captureLevel);
  updateMeter(elements.dockRoomFill, state.roomMicLevel);

  elements.capturePercent.textContent = percentText(state.captureLevel);
  elements.roomMicPercent.textContent = percentText(state.roomMicLevel);
}

function renderCalibrationWatch() {
  const selectedCalibration = state.inputDevices.find((device) => device.id === state.selectedCalibrationInputDeviceId);
  const watch = getCalibrationWatchModel(telemetryState || state);

  elements.calibrationWatch.className = `calibration-watch calibration-watch-${watch.tone}`;
  elements.calibrationWatchTone.textContent = watch.title;
  elements.calibrationWatchStage.textContent = watch.stage;
  elements.calibrationWatchGuidance.textContent = watch.guidance;
  elements.calibrationWatchMicHealth.textContent = watch.micHealth;
  elements.calibrationWatchMicName.textContent = selectedCalibration ? selectedCalibration.displayName || selectedCalibration.name : "Not selected";
  elements.calibrationWatchRoomPercent.textContent = percentText(state.roomMicLevel);
  elements.calibrationWatchCapturePercent.textContent = percentText(state.captureLevel);
  renderCalibrationAttempts();

  updateMeter(elements.calibrationWatchRoomFill, state.roomMicLevel);
  updateMeter(elements.calibrationWatchCaptureFill, state.captureLevel);
}

function renderCalibrationAttempts() {
  const entries = getRecentCalibrationEntries();
  elements.calibrationWatchAttemptsMeta.textContent = entries.length
    ? `${entries.length} recent events`
    : "No recent attempts";
  elements.calibrationWatchAttempts.innerHTML = entries.length
    ? entries.map((entry) => `
        <article class="calibration-attempt ${entry.tone}">
          <span class="calibration-attempt-time">${escapeHtml(entry.time)}</span>
          <span class="calibration-attempt-text">${escapeHtml(entry.text)}</span>
        </article>
      `).join("")
    : `<p class="subtle">Attempt-by-attempt calibration feedback will appear here.</p>`;
}

function renderSummary() {
  const statusText = state.isCalibrating ? "Calibrating" : state.isRunning ? "Streaming" : "Offline";
  const selectedInput = state.inputDevices.find((device) => device.id === state.selectedInputDeviceId);
  const selectedCalibration = state.inputDevices.find((device) => device.id === state.selectedCalibrationInputDeviceId);
  const timingMaster = state.outputs.find((output) => output.isTimingMaster);

  elements.dockStatus.textContent = statusText;
  elements.dockMode.textContent = titleCase(layoutMode.current);
  elements.capturePercentMini.textContent = percentText(state.captureLevel);
  elements.roomMicPercentMini.textContent = percentText(state.roomMicLevel);
  elements.summaryInputDevice.textContent = selectedInput ? selectedInput.displayName || selectedInput.name : "Not selected";
  elements.summaryCalibrationDevice.textContent = selectedCalibration ? selectedCalibration.displayName || selectedCalibration.name : "Not selected";
  elements.summaryAutoSyncMode.textContent = titleCase(state.autoSyncMode);
  elements.summaryTimingMaster.textContent = timingMaster
    ? `Output ${timingMaster.slotIndex} · ${timingMaster.selectedDeviceName}`
    : "Not set";
  elements.lockedOutputsCount.textContent = String(state.lockedOutputCount || state.lockedOutputsCount || 0);
  elements.lowConfidenceOutputsCount.textContent = String(state.lowConfidenceOutputCount || state.lowConfidenceOutputsCount || 0);
  elements.faultedOutputsCount.textContent = String(state.faultedOutputCount || state.faultedOutputsCount || 0);
  elements.calibrationProgressText.textContent = state.calibrationProgressMessage || "Calibration idle.";

  if (state.lastErrorMessage) {
    elements.lastErrorCard.classList.remove("hidden");
    elements.lastErrorText.textContent = state.lastErrorMessage;
  } else {
    elements.lastErrorCard.classList.add("hidden");
    elements.lastErrorText.textContent = "";
  }
}

function renderOutputs(force = false) {
  if (!force && shouldDeferOutputsRender()) {
    patchLiveOutputTelemetry();
    scheduleDeferredOutputsRender();
    return;
  }

  elements.routesGrid.innerHTML = state.outputs.map((output) => renderOutputCard(mergeRouteDraft(output))).join("");
}

function renderOutputCard(output) {
  const accent = accentForSlot(output.slotIndex);
  const diagnosticsOpen = layoutMode.current === "rack" || diagnosticsExpanded.has(output.slotIndex);
  const canPaste = !!routeCopyBuffer;
  const pingPending = isRouteActionPending(output.slotIndex, "ping");
  const mutePending = isRouteActionPending(output.slotIndex, "mute");
  const soloPending = isRouteActionPending(output.slotIndex, "solo");
  const masterPending = isRouteActionPending(output.slotIndex, "make-master");
  const removePending = isRouteActionPending(output.slotIndex, "remove");
  const deviceOptions = [
    `<option value="">Choose playback device...</option>`,
    ...state.playbackDevices.map((device) => `
      <option value="${escapeHtml(device.id)}" ${device.id === output.selectedDeviceId ? "selected" : ""}>
        ${escapeHtml(device.displayName)}
      </option>
    `)
  ].join("");

  return `
    <article class="route-card" data-slot="${output.slotIndex}" style="--route-accent:${accent}">
      <div class="route-topline">
        <span class="eyebrow">Output ${output.slotIndex}</span>
        <div class="route-chip-row">
          <span class="pill">${escapeHtml(output.syncLockState)}</span>
          ${output.isTimingMaster ? '<span class="pill master-pill">Master</span>' : ""}
          ${output.isMuted ? '<span class="pill muted-pill">Muted</span>' : ""}
          ${output.isSolo ? '<span class="pill solo-pill">Solo</span>' : ""}
        </div>
      </div>

      <h3 class="route-title" title="${escapeHtml(output.selectedDeviceName)}">${escapeHtml(output.selectedDeviceName)}</h3>
      <div class="route-status-line">
        <span>${escapeHtml(output.statusText)}</span>
        <span>${escapeHtml(output.syncSummary || "Manual")}</span>
      </div>

      <label class="field">
        <span>Playback Device</span>
        <select data-field="device" name="output-${output.slotIndex}-device" ${state.canEditTopology ? "" : "disabled"}>
          ${deviceOptions}
        </select>
      </label>

      <div class="route-control-grid">
        <div class="field range-field">
          <span>Volume <strong>${Math.round(output.volumePercent)}%</strong></span>
          <input data-field="volume" name="output-${output.slotIndex}-volume" type="range" min="0" max="100" step="1" value="${Math.round(output.volumePercent)}" ${state.isCalibrating ? "disabled" : ""}>
          <span class="field-note">Applied ${Math.round(output.appliedVolumePercent ?? output.volumePercent)}%</span>
        </div>

        <div class="field range-field">
          <span>Delay <strong>${Math.round(output.delayMilliseconds)} ms</strong></span>
          <div class="delay-input-row">
            <div class="hold-stepper">
              <button class="btn btn-ghost compact-btn delay-step-btn" data-action="step-delay" data-step="-1" ${state.isCalibrating ? "disabled" : ""}>-</button>
              <button class="btn btn-ghost compact-btn delay-step-btn" data-action="step-delay" data-step="1" ${state.isCalibrating ? "disabled" : ""}>+</button>
            </div>
            <input class="delay-value-input" data-field="delay-number" name="output-${output.slotIndex}-delay-number" type="number" min="0" max="2000" step="1" value="${Math.round(output.delayMilliseconds)}" ${state.isCalibrating ? "disabled" : ""}>
          </div>
          <input data-field="delay" name="output-${output.slotIndex}-delay" type="range" min="0" max="2000" step="1" value="${Math.round(output.delayMilliseconds)}" ${state.isCalibrating ? "disabled" : ""}>
          <span class="field-note">Effective ${Math.round(output.effectiveDelayMilliseconds || output.delayMilliseconds)} ms</span>
        </div>
      </div>

      <div class="meter-card">
        <div class="meter-title-row">
          <span>Route Meter</span>
          <strong>${routeMeterText(output.meterLevel)}</strong>
        </div>
        <div class="meter-track"><div class="meter-fill" style="width:${routeMeterPercent(output.meterLevel)}%"></div></div>
      </div>

      <div class="route-actions">
        <button class="btn btn-ghost compact-btn route-action-btn" data-action="ping" ${!output.selectedDeviceId || state.isCalibrating || pingPending ? "disabled" : ""}>${pingPending ? "Pinging" : "Ping"}</button>
        <button class="btn ${output.isMuted ? "btn-alert" : "btn-ghost"} compact-btn route-action-btn" data-action="mute" ${state.isCalibrating || mutePending ? "disabled" : ""}>${mutePending ? "Working" : output.isMuted ? "Unmute" : "Mute"}</button>
        <button class="btn ${output.isSolo ? "btn-primary" : "btn-ghost"} compact-btn route-action-btn" data-action="solo" ${state.isCalibrating || soloPending ? "disabled" : ""}>${soloPending ? "Working" : output.isSolo ? "Unsolo" : "Solo"}</button>
        <button class="btn btn-ghost compact-btn route-action-btn" data-action="copy-settings">Copy</button>
        <button class="btn btn-ghost compact-btn route-action-btn" data-action="paste-settings" ${canPaste ? "" : "disabled"}>Paste</button>
      </div>

      <div class="route-diagnostics-shell">
        <button class="btn btn-ghost compact-btn route-diagnostics-toggle" data-action="toggle-diagnostics">
          ${diagnosticsOpen ? "Hide Diagnostics" : "Show Diagnostics"}
        </button>
        <div class="route-diagnostics ${diagnosticsOpen ? "expanded" : ""}">
          <div class="route-stats">
            <div class="stat-block">
              <span class="meta-label">Buffered</span>
              <strong>${Math.round(output.bufferedMilliseconds)} ms</strong>
            </div>
            <div class="stat-block">
              <span class="meta-label">Confidence</span>
              <strong>${percentText(output.syncConfidence)}</strong>
            </div>
            <div class="stat-block">
              <span class="meta-label">Playback Rate</span>
              <strong>${Number(output.playbackRateRatio).toFixed(4)}x</strong>
            </div>
            <div class="stat-block">
              <span class="meta-label">Auto-Sync Rate</span>
              <strong>${Number(output.autoSyncPlaybackRateRatio).toFixed(4)}x</strong>
            </div>
            <div class="stat-block">
              <span class="meta-label">Arrival</span>
              <strong>${Number(output.estimatedArrivalMilliseconds || 0).toFixed(1)} ms</strong>
            </div>
            <div class="stat-block">
              <span class="meta-label">Marker Level</span>
              <strong>${Number(output.markerLevelPercent || 0).toFixed(1)}%</strong>
            </div>
          </div>
        </div>
      </div>

      <div class="route-footer">
        <button class="btn ${output.isTimingMaster ? "btn-primary" : "btn-ghost"}" data-action="make-master" ${state.isCalibrating || masterPending ? "disabled" : ""}>
          ${output.isTimingMaster ? "Timing Master" : "Set Master"}
        </button>
        <button class="btn btn-secondary" data-action="remove" ${output.canRemove && !removePending ? "" : "disabled"}>
          ${removePending ? "Removing" : "Remove"}
        </button>
      </div>
    </article>
  `;
}

function renderLogs() {
  const lines = state.logEntries.map((entry) => entry.displayText);
  const errorCount = state.logEntries.filter((entry) => /error|fail|exception/i.test(entry.displayText)).length;
  elements.logOutput.textContent = lines.length ? lines.join("\n") : "No log entries yet.";
  elements.logsBadge.textContent = errorCount > 0
    ? `${lines.length} entries · ${errorCount} errors`
    : `${lines.length} entries`;
}

function renderCompactDock() {
  elements.compactDockState.textContent = state.isCalibrating ? "Calibrating" : state.isRunning ? "Live" : "Offline";
  elements.compactDockRoutes.innerHTML = state.outputs
    .map((output) => mergeRouteDraft(output))
    .map((output) => `
      <div class="compact-dock-route" data-slot="${output.slotIndex}">
        <div class="compact-dock-route-top">
          <span>Out ${output.slotIndex}</span>
          <span>${escapeHtml(output.syncLockState)}</span>
        </div>
        <strong title="${escapeHtml(output.selectedDeviceName)}">${escapeHtml(output.selectedDeviceName)}</strong>
        <div class="compact-dock-delay">
          <button class="btn btn-ghost compact-btn" data-action="dock-step-delay" data-step="-1" ${state.isCalibrating ? "disabled" : ""}>-</button>
          <span>${Math.round(output.delayMilliseconds)} ms</span>
          <button class="btn btn-ghost compact-btn" data-action="dock-step-delay" data-step="1" ${state.isCalibrating ? "disabled" : ""}>+</button>
        </div>
      </div>
    `)
    .join("");
  elements.compactDock.classList.toggle("visible", layoutMode.current === "compact");
  setRangeValue(elements.compactDockMasterRange, state.masterVolumePercent);
}

function patchLiveOutputTelemetry() {
  const frame = telemetryState || buildTelemetryFromState(state);
  if (!frame) {
    return;
  }

  patchTelemetryFrame(frame);
}

function patchTelemetryFrame(frame) {
  if (!frame) {
    return;
  }

  patchTopLevelTelemetry(frame);
  patchOutputTelemetry(frame.outputs || []);
}

function patchTopLevelTelemetry(frame) {
  if (!state) {
    return;
  }

  const runningText = frame.isCalibrating ? "Calibrating" : frame.isRunning ? "Live" : "Offline";
  elements.sessionStatus.textContent = frame.sessionStatusMessage || state.sessionStatusMessage || "Ready";
  elements.captureStatus.textContent = frame.captureStatusText || state.captureStatusText || "Idle";
  elements.calibrationStatus.textContent = frame.calibrationStatusMessage || state.calibrationStatusMessage || "Calibration idle.";
  elements.engineStatePill.textContent = runningText;
  elements.dockStatus.textContent = runningText === "Live" ? "Streaming" : runningText;
  elements.compactDockState.textContent = runningText;
  elements.calibrationProgressText.textContent = frame.calibrationProgressMessage || "Calibration idle.";

  updateMeter(elements.captureMeterFill, frame.captureLevel);
  updateMeter(elements.roomMeterFill, frame.roomMicLevel);
  updateMeter(elements.dockCaptureFill, frame.captureLevel);
  updateMeter(elements.dockRoomFill, frame.roomMicLevel);
  updateMeter(elements.calibrationWatchRoomFill, frame.roomMicLevel);
  updateMeter(elements.calibrationWatchCaptureFill, frame.captureLevel);

  const capturePercent = percentText(frame.captureLevel);
  const roomPercent = percentText(frame.roomMicLevel);
  elements.capturePercent.textContent = capturePercent;
  elements.roomMicPercent.textContent = roomPercent;
  elements.capturePercentMini.textContent = capturePercent;
  elements.roomMicPercentMini.textContent = roomPercent;
  elements.calibrationWatchRoomPercent.textContent = roomPercent;
  elements.calibrationWatchCapturePercent.textContent = capturePercent;

  const watch = getCalibrationWatchModel(frame);
  elements.calibrationWatch.className = `calibration-watch calibration-watch-${watch.tone}`;
  elements.calibrationWatchTone.textContent = watch.title;
  elements.calibrationWatchStage.textContent = watch.stage;
  elements.calibrationWatchGuidance.textContent = watch.guidance;
  elements.calibrationWatchMicHealth.textContent = watch.micHealth;
  renderCalibrationAttempts();
}

function patchOutputTelemetry(outputs) {
  for (const output of outputs) {
    const card = elements.routesGrid.querySelector(`[data-slot="${output.slotIndex}"]`);
    if (!card) {
      continue;
    }

    const routeMeterText = card.querySelector(".meter-card .meter-title-row strong");
    const routeMeterFill = card.querySelector(".meter-card .meter-fill");
    const statusLine = card.querySelectorAll(".route-status-line span");
    const fieldNotes = card.querySelectorAll(".field-note");
    const delayStrong = card.querySelector('.route-control-grid .range-field:nth-child(2) strong');
    const delayNumber = card.querySelector('[data-field="delay-number"]');
    const delayRange = card.querySelector('[data-field="delay"]');

    if (routeMeterText) {
      routeMeterText.textContent = routeMeterTextValue(output.meterLevel);
    }

    if (routeMeterFill) {
      updateMeterPercent(routeMeterFill, routeMeterPercent(output.meterLevel));
    }

    if (statusLine[0]) {
      statusLine[0].textContent = output.statusText;
    }

    if (statusLine[1]) {
      statusLine[1].textContent = output.syncSummary || "Manual";
    }

    if (fieldNotes[0]) {
      fieldNotes[0].textContent = `Applied ${Math.round(output.appliedVolumePercent ?? output.volumePercent)}%`;
    }

    if (fieldNotes[1]) {
      fieldNotes[1].textContent = `Effective ${Math.round(output.effectiveDelayMilliseconds || output.delayMilliseconds)} ms`;
    }

    if (!routeDrafts.has(output.slotIndex)) {
      if (delayStrong) {
        delayStrong.textContent = `${Math.round(output.delayMilliseconds)} ms`;
      }
      if (delayNumber && document.activeElement !== delayNumber) {
        delayNumber.value = String(Math.round(output.delayMilliseconds));
      }
      if (delayRange && document.activeElement !== delayRange) {
        delayRange.value = String(Math.round(output.delayMilliseconds));
      }
    }
  }
}

function buildTelemetryFromState(sourceState) {
  if (!sourceState) {
    return null;
  }

  return {
    telemetryRevision: Number(sourceState.stateRevision || 0),
    isRunning: !!sourceState.isRunning,
    isCalibrating: !!sourceState.isCalibrating,
    captureLevel: Number(sourceState.captureLevel || 0),
    roomMicLevel: Number(sourceState.roomMicLevel || 0),
    captureStatusText: sourceState.captureStatusText || "Idle",
    sessionStatusMessage: sourceState.sessionStatusMessage || "Ready",
    calibrationStatusMessage: sourceState.calibrationStatusMessage || "Calibration idle.",
    calibrationProgressMessage: sourceState.calibrationProgressMessage || "Calibration idle.",
    recentCalibrationEntries: [],
    outputs: (sourceState.outputs || []).map((output) => ({
      slotIndex: output.slotIndex,
      meterLevel: Number(output.meterLevel || 0),
      statusText: output.statusText || "Idle",
      appliedVolumePercent: Number(output.appliedVolumePercent ?? output.volumePercent ?? 0),
      delayMilliseconds: Number(output.delayMilliseconds || 0),
      effectiveDelayMilliseconds: Number(output.effectiveDelayMilliseconds || 0),
      syncConfidence: Number(output.syncConfidence || 0),
      syncLockState: output.syncLockState || "Disabled",
      syncSummary: output.syncSummary || "Manual",
      isMuted: !!output.isMuted,
      isSolo: !!output.isSolo
    }))
  };
}

function mergeTelemetryIntoState(frame) {
  if (!state || !frame) {
    return;
  }

  state.isRunning = !!frame.isRunning;
  state.isCalibrating = !!frame.isCalibrating;
  state.captureLevel = Number(frame.captureLevel || 0);
  state.roomMicLevel = Number(frame.roomMicLevel || 0);
  state.captureStatusText = frame.captureStatusText || state.captureStatusText;
  state.sessionStatusMessage = frame.sessionStatusMessage || state.sessionStatusMessage;
  state.calibrationStatusMessage = frame.calibrationStatusMessage || state.calibrationStatusMessage;
  state.calibrationProgressMessage = frame.calibrationProgressMessage || state.calibrationProgressMessage;

  for (const telemetryOutput of frame.outputs || []) {
    const output = findRouteState(telemetryOutput.slotIndex);
    if (!output) {
      continue;
    }

    output.meterLevel = Number(telemetryOutput.meterLevel || 0);
    output.statusText = telemetryOutput.statusText || output.statusText;
    output.appliedVolumePercent = Number(telemetryOutput.appliedVolumePercent ?? output.appliedVolumePercent ?? output.volumePercent ?? 0);
    output.delayMilliseconds = Number(telemetryOutput.delayMilliseconds ?? output.delayMilliseconds ?? 0);
    output.effectiveDelayMilliseconds = Number(telemetryOutput.effectiveDelayMilliseconds ?? output.effectiveDelayMilliseconds ?? output.delayMilliseconds ?? 0);
    output.syncConfidence = Number(telemetryOutput.syncConfidence || 0);
    output.syncLockState = telemetryOutput.syncLockState || output.syncLockState;
    output.syncSummary = telemetryOutput.syncSummary || output.syncSummary;
    output.isMuted = !!telemetryOutput.isMuted;
    output.isSolo = !!telemetryOutput.isSolo;
  }
}

function renderSelect(element, options, selectedId, disabled) {
  const html = [
    `<option value="">${element === elements.inputSelect ? "Choose capture input..." : "Choose calibration mic..."}</option>`,
    ...options.map((device) => `
      <option value="${escapeHtml(device.id)}" ${device.id === selectedId ? "selected" : ""}>
        ${escapeHtml(device.displayName)}
      </option>
    `)
  ].join("");

  if (!isControlDirty(element)) {
    element.innerHTML = html;
  }
  element.disabled = disabled;
}

function handleRouteInput(event) {
  const card = event.target.closest("[data-slot]");
  if (!card) {
    return;
  }

  markInteraction();
  syncRouteLabel(card, event.target.dataset.field);
  syncRouteDraft(card);

  if (event.type === "input") {
    queueRouteUpdate(card);
  } else {
    queueRouteUpdate(card, true);
  }
}

function handleRouteClick(event) {
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) {
    return;
  }

  const card = event.target.closest("[data-slot]");
  if (!card) {
    return;
  }

  const slotIndex = Number(card.dataset.slot);
  const action = actionButton.dataset.action;
  markInteraction();

  if (action === "step-delay") {
    if (event.detail === 0) {
      nudgeDelay(card, Number(actionButton.dataset.step || 0));
    }
    return;
  }

  if (action === "remove") {
    clearQueuedRouteUpdate(slotIndex);
    runRouteAction(slotIndex, action, () => api(`/api/outputs/${slotIndex}`, { method: "DELETE" }));
    return;
  }

  if (action === "mute" || action === "solo" || action === "ping") {
    clearQueuedRouteUpdate(slotIndex);
    if (action === "mute" || action === "solo") {
      const rollback = applyOptimisticRouteAction(slotIndex, action);
      runRouteAction(
        slotIndex,
        action,
        () => api(`/api/outputs/${slotIndex}/${action}`, { method: "POST" }),
        rollback
      );
      return;
    }
    runRouteAction(slotIndex, action, () => api(`/api/outputs/${slotIndex}/${action}`, { method: "POST" }));
    return;
  }

  if (action === "make-master") {
    clearQueuedRouteUpdate(slotIndex);
    runRouteAction(slotIndex, action, () => api(`/api/outputs/${slotIndex}`, {
      method: "PUT",
      body: routePayloadFromCard(card, true)
    }));
    return;
  }

  if (action === "copy-settings") {
    routeCopyBuffer = {
      volumePercent: Number(card.querySelector('[data-field="volume"]').value),
      delayMilliseconds: Number(card.querySelector('[data-field="delay"]').value)
    };
    renderOutputs(true);
    showToast(`Copied output ${slotIndex} mix settings.`, "success");
    return;
  }

  if (action === "paste-settings") {
    if (!routeCopyBuffer) {
      return;
    }

    card.querySelector('[data-field="volume"]').value = String(routeCopyBuffer.volumePercent);
    card.querySelector('[data-field="delay"]').value = String(routeCopyBuffer.delayMilliseconds);
    card.querySelector('[data-field="delay-number"]').value = String(routeCopyBuffer.delayMilliseconds);
    syncRouteLabel(card);
    syncRouteDraft(card);
    clearQueuedRouteUpdate(slotIndex);
    mutate(() => api(`/api/outputs/${slotIndex}`, {
      method: "PUT",
      body: routePayloadFromCard(card, false)
    }));
    return;
  }

  if (action === "toggle-diagnostics") {
    toggleDiagnostics(slotIndex);
  }
}

function handleRoutePointerDown(event) {
  routeBoardPointerDown = true;
  const stepButton = event.target.closest('[data-action="step-delay"]');
  if (!stepButton) {
    return;
  }

  if (event.button !== 0 || stepButton.disabled) {
    return;
  }

  const card = event.target.closest("[data-slot]");
  if (!card) {
    return;
  }

  event.preventDefault();
  startDelayHold(card, Number(stepButton.dataset.step || 0));
}

function handleGlobalPointerRelease() {
  routeBoardPointerDown = false;
  stopDelayHold();
}

function handleRouteWheel(event) {
  const input = event.target.closest('[data-field="delay"], [data-field="delay-number"]');
  if (!input) {
    return;
  }

  event.preventDefault();
  const card = event.target.closest("[data-slot]");
  if (card) {
    nudgeDelay(card, event.deltaY < 0 ? 1 : -1);
  }
}

function handleRouteKeydown(event) {
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
  const card = event.target.closest("[data-slot]");
  if (card) {
    nudgeDelay(card, delta);
  }
}

function handleCompactDockClick(event) {
  const button = event.target.closest("[data-action='dock-step-delay']");
  if (!button) {
    return;
  }

  const dockRoute = event.target.closest("[data-slot]");
  const card = dockRoute ? elements.routesGrid.querySelector(`[data-slot="${dockRoute.dataset.slot}"]`) : null;
  if (card) {
    nudgeDelay(card, Number(button.dataset.step || 0));
  }
}

function handleSettingsInput(event) {
  if (!state) {
    return;
  }

  markInteraction();
  if (event.target === elements.masterVolumeRange) {
    elements.compactDockMasterRange.value = elements.masterVolumeRange.value;
  }
  if (event.target === elements.compactDockMasterRange) {
    elements.masterVolumeRange.value = elements.compactDockMasterRange.value;
  }

  syncRangeLabels();
  queueSettingsUpdate();
}

function queueSettingsUpdate() {
  clearTimeout(settingsTimer);
  settingsTimer = window.setTimeout(() => {
    settingsTimer = null;
    mutate(() => api("/api/settings", {
      method: "PUT",
      body: settingsPayload()
    }));
  }, SETTINGS_DEBOUNCE_MS);
}

function queueRouteUpdate(card, immediate = false) {
  const slotIndex = Number(card.dataset.slot);
  const send = () => mutate(() => api(`/api/outputs/${slotIndex}`, {
    method: "PUT",
    body: routePayloadFromCard(card, false)
  }));

  clearQueuedRouteUpdate(slotIndex);

  if (immediate) {
    send();
    return;
  }

  const timer = window.setTimeout(() => {
    routeTimers.delete(slotIndex);
    send();
  }, ROUTE_DEBOUNCE_MS);
  routeTimers.set(slotIndex, timer);
}

function startDelayHold(card, step) {
  stopDelayHold();
  if (!step) {
    return;
  }

  markInteraction();
  nudgeDelay(card, step);

  const intervalId = window.setInterval(() => {
    nudgeDelay(card, step);
  }, HOLD_INTERVAL_MS);

  delayHoldState = { intervalId };
}

function stopDelayHold() {
  if (!delayHoldState) {
    return;
  }

  window.clearInterval(delayHoldState.intervalId);
  delayHoldState = null;
}

function nudgeDelay(card, delta) {
  const delayInput = card.querySelector('[data-field="delay"]');
  const delayNumberInput = card.querySelector('[data-field="delay-number"]');
  if (!delayInput || !delayNumberInput) {
    return;
  }

  const current = Number(delayInput.value || 0);
  const next = clamp(current + delta, Number(delayInput.min || 0), Number(delayInput.max || 2000));
  if (next === current) {
    return;
  }

  delayInput.value = String(next);
  delayNumberInput.value = String(next);
  syncRouteLabel(card);
  syncRouteDraft(card);
  queueRouteUpdate(card, true);
}

function settingsPayload() {
  return {
    selectedInputDeviceId: normalizeValue(elements.inputSelect.value),
    selectedCalibrationInputDeviceId: normalizeValue(elements.calibrationSelect.value),
    useTestTone: elements.testToneCheckbox.checked,
    masterVolumePercent: Number(elements.masterVolumeRange.value),
    autoSyncMode: currentSyncMode(),
    markerLevelPercent: Number(elements.markerLevelRange.value)
  };
}

function routePayloadFromCard(card, forceMaster) {
  return {
    selectedDeviceId: normalizeValue(card.querySelector('[data-field="device"]').value),
    volumePercent: Number(card.querySelector('[data-field="volume"]').value),
    delayMilliseconds: Number(card.querySelector('[data-field="delay"]').value),
    isTimingMaster: forceMaster || findRouteState(Number(card.dataset.slot))?.isTimingMaster || false
  };
}

function currentSyncMode() {
  const active = document.querySelector("[data-sync-mode].active");
  return active ? active.dataset.syncMode : "MonitorOnly";
}

function setSyncMode(mode) {
  document.querySelectorAll("[data-sync-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.syncMode === mode);
  });
}

function syncRangeLabels() {
  elements.masterVolumeValue.textContent = `${Math.round(Number(elements.masterVolumeRange.value || 0))}%`;
  elements.compactDockMasterValue.textContent = `${Math.round(Number(elements.compactDockMasterRange.value || 0))}%`;
  elements.markerLevelValue.textContent = `${Number(elements.markerLevelRange.value || 0).toFixed(1)}%`;
}

function syncRouteLabel(card, changedField = "") {
  const volume = card.querySelector('[data-field="volume"]');
  const delay = card.querySelector('[data-field="delay"]');
  const delayNumber = card.querySelector('[data-field="delay-number"]');
  const labels = card.querySelectorAll(".range-field span strong");

  if (changedField === "delay-number" && delay && delayNumber) {
    delay.value = String(clamp(Number(delayNumber.value || 0), 0, 2000));
    delayNumber.value = delay.value;
  }

  if (changedField === "delay" && delay && delayNumber) {
    delayNumber.value = delay.value;
  }

  if (labels[0] && volume) {
    labels[0].textContent = `${Math.round(Number(volume.value))}%`;
  }
  if (labels[1] && delay) {
    labels[1].textContent = `${Math.round(Number(delay.value))} ms`;
  }
}

function syncRouteDraft(card) {
  const slotIndex = Number(card.dataset.slot);
  routeDrafts.set(slotIndex, {
    selectedDeviceId: normalizeValue(card.querySelector('[data-field="device"]').value),
    volumePercent: Number(card.querySelector('[data-field="volume"]').value),
    delayMilliseconds: Number(card.querySelector('[data-field="delay"]').value)
  });
}

async function copyLogsToClipboard() {
  try {
    await navigator.clipboard.writeText(elements.logOutput.textContent || "");
    showToast("Logs copied to clipboard.", "success");
  } catch {
    showToast("Clipboard access failed.");
  }
}

function showToast(message, tone = "error") {
  const toast = document.createElement("div");
  toast.className = "toast";
  if (tone === "success") {
    toast.style.borderColor = "rgba(100, 247, 157, 0.26)";
    toast.style.background = "rgba(7, 45, 24, 0.94)";
  }
  toast.textContent = message;
  elements.toastStack.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4800);
}

async function mutateWithRollback(action, rollback) {
  try {
    setState(await action());
  } catch (error) {
    rollback?.();
    showToast(error.message || "Action failed.");
  }
}

async function runRouteAction(slotIndex, action, request, rollback = null) {
  const key = routeActionKey(slotIndex, action);
  if (pendingRouteActions.has(key)) {
    return;
  }

  pendingRouteActions.add(key);
  if (!shouldDeferOutputsRender()) {
    renderOutputs(true);
  } else {
    scheduleDeferredOutputsRender();
  }
  renderCompactDock();

  try {
    setState(await request());
  } catch (error) {
    rollback?.();
    showToast(error.message || "Action failed.");
  } finally {
    pendingRouteActions.delete(key);
    if (!shouldDeferOutputsRender()) {
      renderOutputs(true);
    } else {
      scheduleDeferredOutputsRender();
    }
    renderCompactDock();
  }
}

function applyLayout(layoutId) {
  layoutMode.current = layoutId;
  localStorage.setItem("multiAudio.layout", layoutId);
  document.body.classList.remove("theme-constellation", "theme-rack", "theme-compact");
  document.body.classList.add(`theme-${layoutId}`);
  elements.dockMode.textContent = titleCase(layoutId);
}

function setState(nextState) {
  if (!nextState) {
    return;
  }

  if (state && Number(nextState.stateRevision || 0) < Number(state.stateRevision || 0)) {
    return;
  }

  state = nextState;
  reconcileRouteDrafts();
  render();
}

function setTelemetry(nextTelemetry) {
  if (!nextTelemetry) {
    return;
  }

  if (telemetryState && Number(nextTelemetry.telemetryRevision || 0) < Number(telemetryState.telemetryRevision || 0)) {
    return;
  }

  telemetryState = nextTelemetry;
  mergeTelemetryIntoState(nextTelemetry);
  patchTelemetryFrame(nextTelemetry);
}

function markInteraction() {
  interactionPauseUntil = Date.now() + INTERACTION_PAUSE_MS;
  scheduleDeferredOutputsRender();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clearQueuedRouteUpdate(slotIndex) {
  const existing = routeTimers.get(slotIndex);
  if (!existing) {
    return;
  }

  clearTimeout(existing);
  routeTimers.delete(slotIndex);
}

function updateMeter(element, value) {
  updateMeterPercent(element, Number(value || 0) * 100);
}

function updateMeterPercent(element, value) {
  if (!element) {
    return;
  }

  const target = Math.max(0, Math.min(100, Number(value || 0)));
  const current = animatedMeters.get(element)?.current ?? target;
  animatedMeters.set(element, { current, target });

  if (!meterAnimationFrame) {
    meterAnimationFrame = requestAnimationFrame(stepMeterAnimations);
  }
}

function stepMeterAnimations() {
  meterAnimationFrame = 0;
  let needsAnotherFrame = false;

  for (const [element, stateEntry] of animatedMeters) {
    if (!element.isConnected) {
      animatedMeters.delete(element);
      continue;
    }

    const delta = stateEntry.target - stateEntry.current;
    if (Math.abs(delta) <= 0.35) {
      stateEntry.current = stateEntry.target;
    } else {
      stateEntry.current += delta * 0.28;
      needsAnotherFrame = true;
    }

    element.style.width = `${stateEntry.current.toFixed(2)}%`;

    if (stateEntry.current === stateEntry.target) {
      animatedMeters.delete(element);
    }
  }

  if (needsAnotherFrame || animatedMeters.size) {
    meterAnimationFrame = requestAnimationFrame(stepMeterAnimations);
  }
}

function percentText(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function routeMeterDisplayLevel(value) {
  const raw = Math.max(0, Math.min(1, Number(value || 0)));
  if (raw <= 0.0005) {
    return 0;
  }

  const db = 20 * Math.log10(raw);
  const normalized = Math.max(0, Math.min(1, (db + 48) / 48));
  return Math.max(0, Math.min(1, Math.pow(normalized, 0.72)));
}

function routeMeterPercent(value) {
  return Math.round(routeMeterDisplayLevel(value) * 100);
}

function routeMeterTextValue(value) {
  return `${routeMeterPercent(value)}%`;
}

function routeMeterText(value) {
  return routeMeterTextValue(value);
}

function accentForSlot(slotIndex) {
  const hue = (slotIndex * 53) % 360;
  return `hsl(${hue} 88% 62%)`;
}

function normalizeValue(value) {
  return value ? value : null;
}

function titleCase(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function getCalibrationWatchModel(source = state) {
  const stage = source?.calibrationProgressMessage || source?.calibrationStatusMessage || "Calibration idle.";
  const roomLevel = Number(source?.roomMicLevel || 0);
  const status = String(source?.calibrationStatusMessage || "");
  const lastError = String(state?.lastErrorMessage || "");

  if (source?.isCalibrating) {
    if (roomLevel >= 0.92) {
      return {
        tone: "danger",
        title: "Too Hot",
        stage,
        micHealth: "Overloaded",
        guidance: "The room mic is extremely hot. Lower mic gain or playback level before trusting this pass."
      };
    }

    if (roomLevel >= 0.08) {
      return {
        tone: "success",
        title: "Healthy Signal",
        stage,
        micHealth: "Usable",
        guidance: "The room mic is hearing the bursts clearly. Let calibration continue."
      };
    }

    if (roomLevel >= 0.025) {
      return {
        tone: "warn",
        title: "Borderline",
        stage,
        micHealth: "Weak",
        guidance: "Calibration is hearing something, but the room mic response is still weak. If it stays here, this pass may be unreliable."
      };
    }

    return {
      tone: "warn",
      title: "Too Quiet",
      stage,
      micHealth: "Barely hearing bursts",
      guidance: "The room mic is barely picking up the calibration bursts. Raise speaker volume, move the mic closer, or use a hotter mic input on the next pass."
    };
  }

  if (/failed/i.test(status) || /failed/i.test(lastError)) {
    return {
      tone: "danger",
      title: "Calibration Failed",
      stage: status || "Calibration failed.",
      micHealth: "Needs adjustment",
      guidance: lastError || "No stable arrivals were detected. Readjust volume or mic placement and try again."
    };
  }

  if (/applied|complete|finished/i.test(status) || /complete/i.test(stage)) {
    return {
      tone: "success",
      title: "Calibration Applied",
      stage,
      micHealth: "Finished",
      guidance: "The latest calibration pass completed and applied delay suggestions."
    };
  }

  return {
    tone: "idle",
    title: "Ready",
    stage,
    micHealth: "Idle",
    guidance: "Start calibration to monitor room-mic strength and progress here without opening the logs."
  };
}

function getRecentCalibrationEntries() {
  if (telemetryState?.recentCalibrationEntries?.length) {
    return telemetryState.recentCalibrationEntries.map((entry) => ({
      time: entry.time || "",
      text: entry.text || "",
      tone: entry.tone || "neutral"
    }));
  }

  const relevant = (state.logEntries || [])
    .filter((entry) => /Calibration sample|Calibration result|Calibration summary|Calibration diagnostics saved|Calibration failed|stable latency|burst/i.test(entry.displayText))
    .slice(-8)
    .map((entry) => {
      const text = entry.displayText.replace(/^\d{2}:\d{2}:\d{2}\s+\[[A-Z]+\]\s*/, "");
      const tone = /\[ERROR\]|failed/i.test(entry.displayText)
        ? "danger"
        : /\[WARN\]|weak|no stable/i.test(entry.displayText)
          ? "warn"
          : "neutral";

      return {
        time: entry.displayText.slice(0, 8),
        text,
        tone
      };
    });

  return relevant.reverse();
}

function shouldDeferOutputsRender() {
  if (routeBoardPointerDown || routeBoardHovered) {
    return true;
  }

  if (Date.now() >= interactionPauseUntil) {
    return false;
  }

  const active = document.activeElement;
  if (!active?.closest?.("#routesGrid")) {
    return false;
  }

  return active.matches?.(
    'input[type="range"], input[type="number"], select, option'
  ) || false;
}

function scheduleDeferredOutputsRender() {
  clearTimeout(deferredOutputsTimer);
  deferredOutputsTimer = window.setTimeout(() => {
    if (state) {
      renderOutputs(true);
    }
  }, INTERACTION_PAUSE_MS + 40);
}

function setRangeValue(element, nextValue) {
  if (!isControlDirty(element)) {
    element.value = String(nextValue);
  }
}

function isControlDirty(element) {
  return document.activeElement === element || settingsTimer !== null;
}

function toggleLogsDrawer() {
  logsUi.open = !logsUi.open;
  localStorage.setItem("multiAudio.logsOpen", logsUi.open ? "1" : "0");
  applyLogsDrawerState();
}

function applyLogsDrawerState() {
  elements.logsPanel.classList.toggle("collapsed", !logsUi.open);
  elements.toggleLogsBtn.textContent = logsUi.open ? "Close Drawer" : "Open Drawer";
}

function toggleDiagnostics(slotIndex) {
  if (diagnosticsExpanded.has(slotIndex)) {
    diagnosticsExpanded.delete(slotIndex);
  } else {
    diagnosticsExpanded.add(slotIndex);
  }

  localStorage.setItem("multiAudio.diagnosticsExpanded", JSON.stringify([...diagnosticsExpanded]));
  renderOutputs(true);
}

function reconcileRouteDrafts() {
  if (!state) {
    return;
  }

  const validSlots = new Set(state.outputs.map((output) => output.slotIndex));
  for (const [slotIndex, draft] of routeDrafts.entries()) {
    if (!validSlots.has(slotIndex)) {
      routeDrafts.delete(slotIndex);
      continue;
    }

    const output = findRouteState(slotIndex);
    if (!output) {
      routeDrafts.delete(slotIndex);
      continue;
    }

    if (
      normalizeValue(draft.selectedDeviceId) === normalizeValue(output.selectedDeviceId) &&
      Number(draft.volumePercent) === Number(output.volumePercent) &&
      Number(draft.delayMilliseconds) === Number(output.delayMilliseconds)
    ) {
      routeDrafts.delete(slotIndex);
    }
  }
}

function mergeRouteDraft(output) {
  const draft = routeDrafts.get(output.slotIndex);
  return draft ? { ...output, ...draft } : output;
}

function findRouteState(slotIndex) {
  return state?.outputs.find((output) => output.slotIndex === slotIndex) || null;
}

function routeActionKey(slotIndex, action) {
  return `${slotIndex}:${action}`;
}

function isRouteActionPending(slotIndex, action) {
  return pendingRouteActions.has(routeActionKey(slotIndex, action));
}

function applyOptimisticRouteAction(slotIndex, action) {
  if (!state) {
    return null;
  }

  const output = findRouteState(slotIndex);
  if (!output) {
    return null;
  }

  const previous = {
    isMuted: output.isMuted,
    isSolo: output.isSolo
  };

  if (action === "mute") {
    output.isMuted = !output.isMuted;
  }

  if (action === "solo") {
    output.isSolo = !output.isSolo;
  }

  renderOutputs(true);
  renderCompactDock();

  return () => {
    output.isMuted = previous.isMuted;
    output.isSolo = previous.isSolo;
    renderOutputs(true);
    renderCompactDock();
  };
}

function readBooleanStorage(key, fallback) {
  const value = localStorage.getItem(key);
  return value === null ? fallback : value === "1";
}

function readJsonStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
