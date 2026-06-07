const POLL_MS = 2000;
const TELE_POLL_MS = 300;
const SETTINGS_DEBOUNCE_MS = 220;
const ROUTE_DEBOUNCE_MS = 160;

let state = null;
let selectedSlot = Number(localStorage.getItem("v3.selectedSlot")) || 0;
let evStream = null;
let teleStream = null;
let pollTimer = null;
let telePollTimer = null;
let settingsTimer = null;
let pendingState = null;
let activeRouteSlot = 0;
let activeInteractionCount = 0;
let renderPausedUntil = 0;
const routeTimers = new Map();

const accents = ["#56f36e", "#4ce7f2", "#ff66ad", "#a56bff", "#f6bc45"];
const $ = (id) => document.getElementById(id);
const el = {
  enginePill: $("enginePill"),
  systemDot: $("systemDot"),
  systemStatusText: $("systemStatusText"),
  masterVolumeRange: $("masterVolumeRange"),
  masterVolumeValue: $("masterVolumeValue"),
  refreshBtn: $("refreshBtn"),
  syncTickBtn: $("syncTickBtn"),
  autoAlignBtn: $("autoAlignBtn"),
  addOutputBtn: $("addOutputBtn"),
  infoBtn: $("infoBtn"),
  deviceList: $("deviceList"),
  mixerCards: $("mixerCards"),
  activeOutputCount: $("activeOutputCount"),
  routeHealthText: $("routeHealthText"),
  systemLatencyValue: $("systemLatencyValue"),
  detailChannelBadge: $("detailChannelBadge"),
  detailDeviceImage: $("detailDeviceImage"),
  detailName: $("detailName"),
  detailDevice: $("detailDevice"),
  detailStatus: $("detailStatus"),
  detailDeviceSelect: $("detailDeviceSelect"),
  muteDeviceBtn: $("muteDeviceBtn"),
  toastStack: $("toastStack")
};

boot();

async function boot() {
  bindEvents();
  await refreshState(true);
  connectStateStream();
  connectTelemetryStream();
  pollTimer = setInterval(() => refreshState(false), POLL_MS);
  telePollTimer = setInterval(refreshTelemetry, TELE_POLL_MS);
}

function bindEvents() {
  el.enginePill.addEventListener("click", () => {
    if (!state) {
      return;
    }
    mutate(() => api(state.isRunning ? "/api/stop" : "/api/start", { method: "POST" }));
  });

  el.refreshBtn.addEventListener("click", () => mutate(() => api("/api/refresh-devices", { method: "POST" })));
  el.syncTickBtn.addEventListener("click", toggleSyncTickSound);
  el.autoAlignBtn.addEventListener("click", () => mutate(() => api("/api/calibrate", { method: "POST" })));
  el.addOutputBtn.addEventListener("click", () => mutate(() => api("/api/outputs", { method: "POST" })));
  el.infoBtn.addEventListener("click", () => showToast(state?.sessionStatusMessage || "Session status unavailable."));
  el.muteDeviceBtn.addEventListener("click", () => {
    const selected = selectedOutput();
    if (selected) {
      triggerRouteAction(selected.slotIndex, "mute");
    }
  });

  el.masterVolumeRange.addEventListener("input", () => {
    if (!state) {
      return;
    }
    markInteraction();
    state.masterVolumePercent = Number(el.masterVolumeRange.value);
    paintRange(el.masterVolumeRange, state.masterVolumePercent, "#56f36e");
    el.masterVolumeValue.textContent = `${Math.round(state.masterVolumePercent)}%`;
  });
  el.masterVolumeRange.addEventListener("pointerdown", beginInteraction);
  el.masterVolumeRange.addEventListener("pointerup", () => endInteraction(() => queueSettings(0)));
  el.masterVolumeRange.addEventListener("pointercancel", () => endInteraction(() => queueSettings(0)));
  el.masterVolumeRange.addEventListener("change", () => queueSettings(0));

  el.deviceList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-slot]");
    if (!row) {
      return;
    }
    selectSlot(Number(row.dataset.slot));
  });

  el.mixerCards.addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-route-action]");
    if (actionButton) {
      event.stopPropagation();
      triggerRouteAction(Number(actionButton.dataset.slot), actionButton.dataset.routeAction);
      return;
    }

    const card = event.target.closest("[data-slot]");
    if (!card) {
      return;
    }
    selectSlot(Number(card.dataset.slot));
  });

  el.mixerCards.addEventListener("input", handleMixerInput);
  el.mixerCards.addEventListener("change", handleMixerInput);
  el.mixerCards.addEventListener("pointerdown", handleMixerPointerDown);
  el.detailDeviceSelect.addEventListener("change", handleDetailDeviceChange);
  document.addEventListener("pointerup", endRouteInteraction);
  document.addEventListener("pointercancel", endRouteInteraction);
  document.querySelector(".detail-panel")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-detail-action]");
    if (!button) {
      return;
    }
    const selected = selectedOutput();
    if (selected) {
      triggerRouteAction(selected.slotIndex, button.dataset.detailAction);
    }
  });

  document.querySelectorAll(".scene-row").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".scene-row").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
    });
  });

}

async function refreshState(showErrors) {
  try {
    setState(await api("/api/state"));
  } catch (error) {
    if (showErrors) {
      showToast(error.message || "Failed to load dashboard state.");
    }
  }
}

async function refreshTelemetry() {
  if (!state || document.hidden) {
    return;
  }
  try {
    patchTelemetry(await api("/api/telemetry-state"));
  } catch {
  }
}

function connectStateStream() {
  if (!window.EventSource) {
    return;
  }
  evStream?.close();
  evStream = new EventSource("/api/events");
  evStream.addEventListener("state", (event) => {
    try {
      setState(JSON.parse(event.data));
    } catch {
    }
  });
  evStream.onerror = () => {
    evStream?.close();
    evStream = null;
  };
}

function connectTelemetryStream() {
  if (!window.EventSource) {
    return;
  }
  teleStream?.close();
  teleStream = new EventSource("/api/telemetry");
  teleStream.addEventListener("telemetry", (event) => {
    try {
      patchTelemetry(JSON.parse(event.data));
    } catch {
    }
  });
  teleStream.onerror = () => {
    teleStream?.close();
    teleStream = null;
  };
}

function setState(nextState) {
  if (isInteractionActive()) {
    pendingState = nextState;
    setTimeout(flushPendingState, 950);
    return;
  }

  state = nextState;
  normalizeSelection();
  render();
}

function patchTelemetry(telemetry) {
  if (!state || !Array.isArray(telemetry?.outputs) || isInteractionActive()) {
    return;
  }
  for (const teleOut of telemetry.outputs) {
    const output = findOutput(teleOut.slotIndex);
    if (!output) {
      continue;
    }
    output.meterLevel = teleOut.meterLevel ?? output.meterLevel;
    output.statusText = teleOut.statusText || output.statusText;
    output.appliedVolumePercent = teleOut.appliedVolumePercent ?? output.appliedVolumePercent;
    output.delayMilliseconds = teleOut.delayMilliseconds ?? output.delayMilliseconds;
    output.effectiveDelayMilliseconds = teleOut.effectiveDelayMilliseconds ?? output.effectiveDelayMilliseconds;
    output.syncConfidence = teleOut.syncConfidence ?? output.syncConfidence;
    output.syncLockState = teleOut.syncLockState || output.syncLockState;
    output.syncSummary = teleOut.syncSummary || output.syncSummary;
    output.isMuted = teleOut.isMuted ?? output.isMuted;
    output.isSolo = teleOut.isSolo ?? output.isSolo;
  }
  renderHeader();
  renderDeviceList();
  renderCards();
  renderDetail();
  renderMetrics();
}

function render() {
  renderHeader();
  renderDeviceList();
  renderCards();
  renderDetail();
  renderMetrics();
}

function renderHeader() {
  const running = !!state?.isRunning;
  const calibrating = !!state?.isCalibrating;
  const hasError = !!state?.lastErrorMessage;
  el.enginePill.textContent = calibrating ? "CAL" : running ? "LIVE" : "OFF";
  el.enginePill.classList.toggle("offline", !running && !calibrating);
  el.enginePill.classList.toggle("calibrating", calibrating);
  el.enginePill.disabled = calibrating;

  let statusText = running ? "Optimal" : "Offline";
  let tone = running ? "ok" : "warn";
  if (calibrating) {
    statusText = "Aligning";
    tone = "warn";
  }
  if (hasError) {
    statusText = "Needs attention";
    tone = "bad";
  }
  el.systemStatusText.textContent = statusText;
  el.systemStatusText.classList.toggle("warn", tone === "warn");
  el.systemStatusText.classList.toggle("bad", tone === "bad");
  el.systemDot.classList.toggle("warn", tone === "warn");
  el.systemDot.classList.toggle("bad", tone === "bad");

  const master = Math.round(state?.masterVolumePercent ?? 100);
  el.masterVolumeRange.value = master;
  el.masterVolumeValue.textContent = `${master}%`;
  paintRange(el.masterVolumeRange, master, "#56f36e");
  el.masterVolumeRange.disabled = !state || calibrating;
  el.refreshBtn.disabled = !state?.canRefreshDevices;
  el.addOutputBtn.disabled = !state?.canAddOutput;
  el.syncTickBtn.disabled = !state?.canToggleManualSyncTick;
  el.syncTickBtn.classList.toggle("active", !!state?.manualSyncTickEnabled);
  el.syncTickBtn.textContent = state?.manualSyncTickEnabled ? "↭ TICK SOUND ON" : "↭ SYNC TICK SOUND";
  el.syncTickBtn.title = state?.canToggleManualSyncTick
    ? (state?.manualSyncTickEnabled ? "Disable sync tick sound" : "Enable sync tick sound on live outputs")
    : "Start streaming to enable sync tick sound";
  el.syncTickBtn.setAttribute("aria-pressed", String(!!state?.manualSyncTickEnabled));
  el.autoAlignBtn.disabled = !state?.canRunCalibration;
}

function renderDeviceList() {
  const outputs = state?.outputs || [];
  el.deviceList.innerHTML = outputs.map((output) => {
    const accent = channelAccent(output.slotIndex);
    const active = output.slotIndex === selectedSlot ? " active" : "";
    return `
      <button class="device-row${active}" type="button" data-slot="${output.slotIndex}" style="--accent:${accent}">
        <span class="device-mini-icon" aria-hidden="true"><img src="${deviceImage(output)}" alt=""></span>
        <span><strong>CH ${output.slotIndex}</strong><span>${escapeHtml(shortOutputName(output))}</span></span>
        <i class="device-state-dot" aria-hidden="true"></i>
      </button>`;
  }).join("");
}

function renderCards() {
  const outputs = (state?.outputs || []).slice(0, 3);
  if (outputs.length === 0) {
    el.mixerCards.innerHTML = `
      <article class="mixer-card selected" style="--accent:${channelAccent(1)}">
        <div class="card-copy">
          <h3>No outputs configured</h3>
          <p>Add an output to begin routing audio.</p>
        </div>
      </article>`;
    return;
  }
  el.mixerCards.innerHTML = outputs.map((output) => renderCard(output)).join("");
  el.mixerCards.querySelectorAll("input[type='range']").forEach((range) => {
    const color = range.dataset.color || channelAccent(Number(range.dataset.slot));
    const max = Number(range.max || 100);
    const value = Number(range.value || 0);
    paintRange(range, max <= 0 ? 0 : (value / max) * 100, color);
  });
}

function renderCard(output) {
  const accent = channelAccent(output.slotIndex);
  const selected = output.slotIndex === selectedSlot ? " selected" : "";
  const image = deviceImage(output);
  const status = output.isMuted ? "MUTED" : "ACTIVE";
  const role = output.isTimingMaster ? "MASTER" : output.isSolo ? "SOLO" : "";
  const roleClass = output.isMuted ? " muted" : output.isSolo ? " solo" : "";
  const volume = Math.round(output.volumePercent ?? output.appliedVolumePercent ?? 0);
  const delay = Math.round(output.delayMilliseconds ?? 0);
  return `
    <article class="mixer-card${selected}" data-slot="${output.slotIndex}" style="--accent:${accent}">
      <div class="card-top">
        <span class="channel-badge">CH ${output.slotIndex}</span>
        ${role ? `<span class="role-pill${roleClass}">${role}</span>` : ""}
      </div>
      <div class="device-stage" aria-hidden="true">
        <img src="${image}" alt="">
      </div>
      <div class="card-copy">
        <h3>${escapeHtml(shortOutputName(output))}<span class="edit-mark">♢</span></h3>
        <p>${escapeHtml(output.selectedDeviceOriginalName || output.selectedDeviceName || "Unassigned")}</p>
        <div class="active-chip">${status} &nbsp;⌁</div>
        <div class="card-actions" aria-label="Output actions">
          <button class="card-action${output.isMuted ? " active danger" : ""}" type="button" data-route-action="mute" data-slot="${output.slotIndex}">${output.isMuted ? "Unmute" : "Mute"}</button>
          <button class="card-action${output.isSolo ? " active" : ""}" type="button" data-route-action="solo" data-slot="${output.slotIndex}">${output.isSolo ? "Unsolo" : "Solo"}</button>
          <button class="card-action${output.isTimingMaster ? " active master" : ""}" type="button" data-route-action="master" data-slot="${output.slotIndex}">${output.isTimingMaster ? "Master" : "Set Master"}</button>
          <button class="card-action" type="button" data-route-action="ping" data-slot="${output.slotIndex}">Ping</button>
        </div>
      </div>
      <div class="card-controls">
        <div class="control-box">
          <div class="control-label">⌕ Volume</div>
          <div class="control-value">${volume}%</div>
          <div class="range-row">
            <input data-action="volume" data-slot="${output.slotIndex}" data-color="${accent}" type="range" min="0" max="100" step="1" value="${volume}" ${state?.isCalibrating ? "disabled" : ""}>
            <div class="range-scale"><span>0%</span><span>50%</span><span>100%</span></div>
          </div>
        </div>
        <div class="control-box">
          <div class="control-label">◷ Delay</div>
          <div class="control-value">${delay} ms</div>
          <div class="range-row">
            <input data-action="delay" data-slot="${output.slotIndex}" data-color="${accent}" type="range" min="0" max="500" step="1" value="${Math.min(500, delay)}" ${state?.isCalibrating ? "disabled" : ""}>
            <div class="range-scale"><span>0 ms</span><span>250 ms</span><span>500 ms</span></div>
          </div>
        </div>
      </div>
    </article>`;
}

function renderDetail() {
  const output = selectedOutput();
  const accent = output ? channelAccent(output.slotIndex) : channelAccent(1);
  document.documentElement.style.setProperty("--accent", accent);
  if (!output) {
    el.detailChannelBadge.textContent = "CH --";
    el.detailName.textContent = "No output";
    el.detailDevice.textContent = "Choose or add an output";
    el.detailStatus.textContent = "Idle";
    el.detailDeviceImage.src = "/v3/assets/speaker.svg";
    renderDeviceSelect(null);
    resetDetailActions();
    el.muteDeviceBtn.disabled = true;
    return;
  }

  el.detailChannelBadge.textContent = `CH ${output.slotIndex}`;
  el.detailChannelBadge.style.setProperty("--accent", accent);
  el.detailName.textContent = shortOutputName(output);
  el.detailDevice.textContent = `(${output.selectedDeviceOriginalName || output.selectedDeviceName || "Unassigned"})`;
  el.detailStatus.textContent = output.statusText || (state?.isRunning ? "Active" : "Idle");
  el.detailDeviceImage.src = deviceImage(output);
  renderDeviceSelect(output);
  renderDetailActions(output);
  el.muteDeviceBtn.disabled = !state || state.isCalibrating;
  el.muteDeviceBtn.textContent = output.isMuted ? "UNMUTE DEVICE" : "MUTE DEVICE";
}

function renderDetailActions(output) {
  document.querySelectorAll("[data-detail-action]").forEach((button) => {
    button.disabled = !state || state.isCalibrating;
    if (button.dataset.detailAction === "mute") {
      button.textContent = output.isMuted ? "Unmute" : "Mute";
      button.classList.toggle("active", output.isMuted);
      button.classList.toggle("danger", output.isMuted);
    }
    if (button.dataset.detailAction === "solo") {
      button.textContent = output.isSolo ? "Unsolo" : "Solo";
      button.classList.toggle("active", output.isSolo);
    }
    if (button.dataset.detailAction === "master") {
      button.textContent = output.isTimingMaster ? "Timing Master" : "Set Master";
      button.classList.toggle("active", output.isTimingMaster);
      button.classList.toggle("master", output.isTimingMaster);
    }
  });
}

function resetDetailActions() {
  document.querySelectorAll("[data-detail-action]").forEach((button) => {
    button.disabled = true;
    button.classList.remove("active", "danger", "master");
    if (button.dataset.detailAction === "mute") {
      button.textContent = "Mute";
    }
    if (button.dataset.detailAction === "solo") {
      button.textContent = "Solo";
    }
    if (button.dataset.detailAction === "master") {
      button.textContent = "Set Master";
    }
  });
}

function renderDeviceSelect(output) {
  const disabled = !output || !state?.canEditTopology;
  const options = [`<option value="">${output ? "Choose playback device..." : "No output selected"}</option>`]
    .concat((state?.playbackDevices || []).map((device) =>
      `<option value="${escapeHtml(device.id)}" ${device.id === output?.selectedDeviceId ? "selected" : ""}>${escapeHtml(device.displayName)}</option>`));
  el.detailDeviceSelect.innerHTML = options.join("");
  el.detailDeviceSelect.disabled = disabled;
}

function renderMetrics() {
  const outputs = state?.outputs || [];
  const active = outputs.filter((output) => String(output.statusText || "").toLowerCase().includes("play") || state?.isRunning).length;
  el.activeOutputCount.textContent = `${active} Active Output${active === 1 ? "" : "s"}`;
  const faulted = outputs.some((output) => output.syncLockState === "Faulted");
  el.routeHealthText.textContent = faulted ? "Route needs attention" : "All systems connected";
  const latencies = outputs.map((output) => Number(output.estimatedArrivalMilliseconds || output.effectiveDelayMilliseconds || 0)).filter((value) => value > 0);
  const average = latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : 0;
  el.systemLatencyValue.textContent = `${average.toFixed(1)} ms`;
}

function handleMixerInput(event) {
  const input = event.target.closest("[data-action]");
  if (!input || !state) {
    return;
  }

  markInteraction();
  const slot = Number(input.dataset.slot);
  const output = findOutput(slot);
  if (!output) {
    return;
  }
  activeRouteSlot = slot;
  selectSlot(slot, false);
  const value = Number(input.value);
  if (input.dataset.action === "volume") {
    output.volumePercent = clamp(value, 0, 100);
    paintRange(input, output.volumePercent, channelAccent(slot));
    patchCardControl(input, `${Math.round(output.volumePercent)}%`);
  }
  if (input.dataset.action === "delay") {
    output.delayMilliseconds = clamp(value, 0, 500);
    paintRange(input, (output.delayMilliseconds / 500) * 100, channelAccent(slot));
    patchCardControl(input, `${Math.round(output.delayMilliseconds)} ms`);
  }

  if (event.type === "change") {
    queueRoute(slot, 0);
  }
}

function triggerRouteAction(slot, action) {
  const output = findOutput(slot);
  if (!output || !action || state?.isCalibrating) {
    return;
  }

  selectSlot(slot);
  if (action === "mute") {
    mutate(() => api(`/api/outputs/${slot}/mute`, { method: "POST" }));
    return;
  }
  if (action === "solo") {
    mutate(() => api(`/api/outputs/${slot}/solo`, { method: "POST" }));
    return;
  }
  if (action === "ping") {
    mutate(() => api(`/api/outputs/${slot}/ping`, { method: "POST" }));
    return;
  }
  if (action === "master") {
    output.isTimingMaster = true;
    mutate(() => api(`/api/outputs/${slot}`, {
      method: "PUT",
      body: routePayload(slot, true)
    }));
  }
}

function handleDetailDeviceChange() {
  const output = selectedOutput();
  if (!output || !state?.canEditTopology) {
    return;
  }
  output.selectedDeviceId = normalizeEmpty(el.detailDeviceSelect.value);
  queueRoute(output.slotIndex, 0);
}

async function toggleSyncTickSound() {
  await mutate(async () => {
    const nextState = await api("/api/sync-tick/toggle", { method: "POST" });
    showToast(nextState.sessionStatusMessage || (nextState.manualSyncTickEnabled ? "Sync tick sound enabled." : "Sync tick sound disabled."));
    return nextState;
  });
}

function queueSettings(delay = SETTINGS_DEBOUNCE_MS) {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    mutate(() => api("/api/settings", {
      method: "PUT",
      body: settingsPayload()
    }), false);
  }, delay);
}

function queueRoute(slot, delay = ROUTE_DEBOUNCE_MS) {
  clearTimeout(routeTimers.get(slot));
  routeTimers.set(slot, setTimeout(() => {
    routeTimers.delete(slot);
    mutate(() => api(`/api/outputs/${slot}`, {
      method: "PUT",
      body: routePayload(slot)
    }), false);
  }, delay));
}

function settingsPayload() {
  return {
    selectedInputDeviceId: normalizeEmpty(state.selectedInputDeviceId),
    selectedCalibrationInputDeviceId: normalizeEmpty(state.selectedCalibrationInputDeviceId),
    useTestTone: !!state.useTestTone,
    masterVolumePercent: clamp(Number(state.masterVolumePercent ?? 100), 0, 100),
    autoSyncMode: state.autoSyncMode || "MonitorOnly",
    markerLevelPercent: clamp(Number(state.markerLevelPercent ?? 0), 0, 5)
  };
}

function routePayload(slot, forceMaster = false) {
  const output = findOutput(slot);
  return {
    selectedDeviceId: normalizeEmpty(output?.selectedDeviceId),
    volumePercent: clamp(Number(output?.volumePercent ?? 100), 0, 100),
    delayMilliseconds: clamp(Number(output?.delayMilliseconds ?? 0), 0, 2000),
    isTimingMaster: forceMaster || !!output?.isTimingMaster
  };
}

async function mutate(action, showErrors = true) {
  try {
    setState(await action());
  } catch (error) {
    if (showErrors) {
      showToast(error.message || "Action failed.");
    }
    await refreshState(false);
  }
}

async function api(path, options = {}) {
  const request = {
    method: options.method || "GET",
    headers: {},
    body: undefined
  };
  if (options.body !== undefined) {
    request.headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, request);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || payload.detail || payload.title || response.statusText);
  }
  return payload;
}

function normalizeSelection() {
  const outputs = state?.outputs || [];
  if (outputs.length === 0) {
    selectedSlot = 0;
    localStorage.setItem("v3.selectedSlot", "0");
    return;
  }
  if (!outputs.some((output) => output.slotIndex === selectedSlot)) {
    selectedSlot = outputs[0].slotIndex;
  }
  localStorage.setItem("v3.selectedSlot", String(selectedSlot));
}

function selectSlot(slot, renderNow = true) {
  if (slot === selectedSlot) {
    return;
  }
  selectedSlot = slot;
  localStorage.setItem("v3.selectedSlot", String(slot));
  if (renderNow) {
    render();
    return;
  }

  syncSelectedClasses();
}

function selectedOutput() {
  return findOutput(selectedSlot) || (state?.outputs || [])[0] || null;
}

function findOutput(slot) {
  return (state?.outputs || []).find((output) => output.slotIndex === slot) || null;
}

function shortOutputName(output) {
  return String(output?.selectedDeviceName || output?.selectedDeviceOriginalName || `Channel ${output?.slotIndex || ""}`)
    .replace(/\s*\[(Active|Disabled|Unplugged)\]\s*$/i, "")
    .trim();
}

function channelAccent(slot) {
  return accents[(Math.max(1, Number(slot) || 1) - 1) % accents.length];
}

function deviceImage(output) {
  return `/v3/assets/${deviceKind(output)}.svg`;
}

function deviceKind(output) {
  const iconType = String(output?.selectedDeviceIconType || "").toLowerCase();
  const name = `${output?.selectedDeviceName || ""} ${output?.selectedDeviceOriginalName || ""}`.toLowerCase();
  if (iconType.includes("bookshelf") || name.includes("bookshelf") || name.includes("hivi")) {
    return "bookshelf";
  }
  if (
    iconType.includes("portable") ||
    iconType.includes("soundbar") ||
    iconType.includes("headphone") ||
    name.includes("bluetooth") ||
    name.includes("field") ||
    name.includes("virtual cable") ||
    name.includes("soundbar")
  ) {
    return "portable";
  }
  return "speaker";
}

function paintRange(range, percent, color) {
  range.style.setProperty("--range-pct", `${clamp(percent, 0, 100)}%`);
  range.style.setProperty("--range-color", color);
}

function handleMixerPointerDown(event) {
  const input = event.target.closest("[data-action]");
  if (!input) {
    return;
  }

  beginInteraction();
  activeRouteSlot = Number(input.dataset.slot) || 0;
}

function endRouteInteraction() {
  if (activeRouteSlot > 0) {
    queueRoute(activeRouteSlot, 0);
    activeRouteSlot = 0;
  }

  endInteraction();
}

function beginInteraction() {
  activeInteractionCount++;
  markInteraction();
}

function endInteraction(afterEnd) {
  activeInteractionCount = Math.max(0, activeInteractionCount - 1);
  markInteraction(180);
  if (typeof afterEnd === "function") {
    afterEnd();
  }
  setTimeout(flushPendingState, 220);
}

function markInteraction(milliseconds = 900) {
  renderPausedUntil = Math.max(renderPausedUntil, Date.now() + milliseconds);
}

function isInteractionActive() {
  return activeInteractionCount > 0 || Date.now() < renderPausedUntil;
}

function flushPendingState() {
  if (isInteractionActive() || !pendingState) {
    return;
  }

  const nextState = pendingState;
  pendingState = null;
  state = nextState;
  normalizeSelection();
  render();
}

function syncSelectedClasses() {
  document.querySelectorAll("[data-slot]").forEach((node) => {
    node.classList.toggle("selected", Number(node.dataset.slot) === selectedSlot && node.classList.contains("mixer-card"));
    node.classList.toggle("active", Number(node.dataset.slot) === selectedSlot && node.classList.contains("device-row"));
  });
}

function patchCardControl(input, valueText) {
  const controlBox = input.closest(".control-box");
  const valueNode = controlBox?.querySelector(".control-value");
  if (valueNode) {
    valueNode.textContent = valueText;
  }
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  el.toastStack.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function normalizeEmpty(value) {
  return value === "" || value === undefined ? null : value;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

window.addEventListener("beforeunload", () => {
  evStream?.close();
  teleStream?.close();
  clearInterval(pollTimer);
  clearInterval(telePollTimer);
});
