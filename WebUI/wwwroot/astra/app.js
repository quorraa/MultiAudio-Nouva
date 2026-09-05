import { SignalView } from './visualizer.mjs';
'use strict';
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k[0].toLowerCase()+k.slice(1),normalize(v)])) : value;
let state, connected = false, busy = false, routeKey = '', profileDevice;
const signalView = new SignalView();
let dimRestore = null, statusTimer, mapKey = '', logKey = '', pickerKey = '', selectedSlot = null;
let previousNoise = {mode:'MonitorOnly',level:1.6};
const clickVoice = slot => ['Low', 'Mid', 'High', 'Bright'][(Math.max(1, slot) - 1) % 4];
const modes = ['Off','MonitorOnly','Control'];
function setValue(id, value) { const el = $(id); if (el && (document.activeElement !== el || el.tagName === 'SELECT')) el.value = value ?? ''; }
function disable(id, value) { $(id).disabled = value; }
function options(devices, selected, placeholder) {
  return `<option value="">${placeholder}</option>` + devices.map(d => `<option value="${escapeHtml(d.id)}" ${d.id === selected ? 'selected' : ''} ${!d.isActive && d.id !== selected ? 'disabled' : ''}>${escapeHtml(d.alias || d.name)}${d.isActive ? '' : ' (unavailable)'}</option>`).join('');
}
function deviceSelect(id, devices, selected, placeholder) {
  const el = $(id), key = JSON.stringify(devices.map(d => [d.id,d.alias,d.name,d.isActive]));
  if (el.dataset.options !== key) { el.innerHTML = options(devices,selected,placeholder); el.dataset.options = key; }
  setValue(id,selected);
}
function accept(data) {
  const next = normalize(data);
  if (state && next.stateRevision < state.stateRevision) return;
  state = next; render();
}
async function request(path, method = 'POST', body) {
  const response = await fetch('/api/'+path,{method,headers: body ? {'Content-Type':'application/json'} : {},body:body ? JSON.stringify(body) : undefined});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.detail || data.title || `Request failed (${response.status})`);
  return data;
}
async function command(path, method = 'POST', body) {
  if (busy && path !== 'calibrate/cancel') return false;
  const cancellation = path === 'calibrate/cancel';
  if (!cancellation) busy = true;
  $('error').hidden = true; clearTimeout(statusTimer); $('commandStatus').hidden = false; $('commandStatus').textContent = 'Applying changes…'; render();
  try { accept(await request(path,method,body)); $('commandStatus').textContent = 'Changes applied'; return true; }
  catch (error) { $('error').textContent = error.message; $('error').hidden = false; $('commandStatus').textContent = 'Could not apply changes'; return false; }
  finally { if (!cancellation) busy = false; statusTimer = setTimeout(() => $('commandStatus').hidden = true,2500); render(); }
}
function settings(patch) {
  return command('settings','PUT',Object.assign({selectedInputDeviceId:state.selectedInputDeviceId,selectedCalibrationInputDeviceId:state.selectedCalibrationInputDeviceId,useTestTone:state.useTestTone,masterVolumePercent:state.masterVolumePercent,autoSyncMode:modes[state.autoSyncMode] || state.autoSyncMode,markerLevelPercent:state.markerLevelPercent},patch));
}
function updateRoute(slot,patch) {
  const r = state.outputs.find(r => r.slotIndex === slot);
  return command(`outputs/${slot}`,'PUT',Object.assign({selectedDeviceId:r.selectedDeviceId,volumePercent:r.volumePercent,delayMilliseconds:r.delayMilliseconds,isTimingMaster:r.isTimingMaster},patch));
}
function render() {
  if (!state) return;
  const locked = busy || !connected, editing = locked || state.isCalibrating;
  document.body.dataset.running = String(connected && state.isRunning);
  $('engine').textContent = !connected ? 'Disconnected' : state.isCalibrating ? 'Calibrating' : state.isRunning ? 'Streaming' : 'Standby';
  $('session').textContent = !state.isRunning && !state.isCalibrating && !state.canStart ? 'Select an active source and a device for every output, or remove unused outputs.' : state.sessionStatusMessage;
  $('count').textContent = state.outputs.length;
  $('lastError').textContent = state.lastErrorMessage || 'Device activity and engine events appear here.';
  $('calibration').textContent = state.calibrationProgressMessage || state.calibrationStatusMessage;
  deviceSelect('input',state.inputDevices,state.selectedInputDeviceId,'Select capture input');
  deviceSelect('mic',state.inputDevices,state.selectedCalibrationInputDeviceId,'Select room microphone');
  setValue('master',state.masterVolumePercent); $('masterValue').textContent = `${Number(state.masterVolumePercent.toFixed(1))}%`;
  setValue('marker',state.markerLevelPercent); $('markerValue').textContent = `${state.markerLevelPercent.toFixed(1)}%`;
  setValue('mode',modes[state.autoSyncMode] || state.autoSyncMode); $('tone').checked = state.useTestTone;
  for (const [id,allowed] of Object.entries({start:state.canStart,stop:state.canStop,refresh:state.canRefreshDevices,add:state.canAddOutput,calibrate:state.canRunCalibration,tick:state.canToggleManualSyncTick})) disable(id,locked || !allowed);
  disable('cancel',!connected || !state.isCalibrating);
  for (const id of ['input','tone']) disable(id,editing || !state.canEditTopology);
  for (const id of ['master','marker','mode','mic']) disable(id,editing);
  disable('config',locked); disable('dim',editing);
  if (dimRestore && state.masterVolumePercent !== dimRestore.dimmed) dimRestore = null;
  $('dim').setAttribute('aria-pressed',String(!!dimRestore)); $('dim').textContent = dimRestore ? 'Restore volume' : 'Dim −20 dB';
  $('tick').setAttribute('aria-pressed',String(state.manualSyncTickEnabled));
  $('tick').textContent = state.manualSyncTickEnabled ? '■ Stop tick' : '▶ 4-beat tick';
  $('tick').title = state.canToggleManualSyncTick ? 'Each speaker has a fixed click pitch; beat 1 is accented' : 'Start streaming to enable the four-beat tick';
  $('tickDialog').textContent = state.manualSyncTickEnabled ? 'Stop four-beat check' : 'Start four-beat check';
  $('tickDialog').setAttribute('aria-pressed',String(state.manualSyncTickEnabled));
  disable('tickDialog',editing || !state.canToggleManualSyncTick);
  const noiseOn = (modes[state.autoSyncMode] || state.autoSyncMode) !== 'Off' && state.markerLevelPercent > 0;
  $('markerNoise').textContent = noiseOn ? 'Sync noise: ON' : 'Sync noise: OFF';
  $('markerNoise').setAttribute('aria-pressed',String(noiseOn));
  $('markerNoise').title = noiseOn ? 'Turn off marker noise and acoustic auto-sync' : 'Enable acoustic auto-sync marker noise';
  disable('markerNoise',editing);
  if (noiseOn) previousNoise = {mode:modes[state.autoSyncMode] || state.autoSyncMode,level:state.markerLevelPercent};
  const key = JSON.stringify(state.outputs.map(r => r.slotIndex));
  if (key !== routeKey) {
    routeKey = key;
    $('routes').innerHTML = state.outputs.map(r => {
      const n = r.slotIndex;
      return `<article class="route" id="route-${n}"><div class="route-top"><span class="route-number">${String(n).padStart(2,'0')}</span><div><h3 id="name-${n}"></h3><p id="status-${n}"></p></div><button class="remove-channel" id="remove-${n}" data-slot="${n}" data-action="remove" aria-label="Remove output ${n}" title="Remove output ${n}">×</button></div><label class="device-select-label">PLAYBACK DEVICE<select id="device-${n}" data-slot="${n}" data-field="selectedDeviceId"></select></label><div class="fader-zone"><label class="fader"><span class="sr-only">Volume</span><input type="range" min="0" max="100" step="1" id="volume-${n}" aria-label="Output ${n} volume" data-slot="${n}" data-field="volumePercent"><span class="fader-scale" aria-hidden="true">100<br>75<br>50<br>25<br>0</span></label><div class="gain-readout"><label><span>OUTPUT GAIN</span><div class="gain-number"><input type="number" required min="0" max="100" step="1" id="exact-${n}" aria-label="Output ${n} exact volume" data-slot="${n}" data-field="volumePercent"><span>%</span></div></label><output class="sr-only" id="volumeValue-${n}"></output><img id="image-${n}" class="device-image" src="/device-icons/speaker.svg" alt=""><meter id="meter-${n}" min="0" max="1" value="0" aria-label="Output ${n} signal level"></meter><span class="db-value" id="db-${n}">— dBFS</span></div></div><div class="route-tools"><button data-action="mute" data-slot="${n}" id="mute-${n}">Mute</button><button data-action="solo" data-slot="${n}" id="solo-${n}">Solo</button><button data-action="ping" data-slot="${n}" id="ping-${n}">Audition</button></div><p class="click-identity">${clickVoice(n)} click · heard first? Add delay ↓</p><div class="timing"><label>DELAY <span>ms</span><input type="number" required min="0" max="2000" step="1" id="delay-${n}" aria-label="Output ${n} delay milliseconds" data-slot="${n}" data-field="delayMilliseconds"></label><div class="delay-nudges"><button data-slot="${n}" data-nudge="-10" aria-label="Output ${n} delay minus 10 milliseconds">−10</button><button data-slot="${n}" data-nudge="-1" aria-label="Output ${n} delay minus 1 millisecond">−1</button><button data-slot="${n}" data-nudge="1" aria-label="Output ${n} delay plus 1 millisecond">+1</button><button data-slot="${n}" data-nudge="10" aria-label="Output ${n} delay plus 10 milliseconds">+10</button></div></div><label class="check master-check"><input type="checkbox" id="timing-${n}" data-slot="${n}" data-field="isTimingMaster"> Timing master</label><details class="route-detail"><summary>Device & synchronization</summary><p id="sync-${n}"></p><span id="confidence-${n}">Confidence —</span><div class="detail-actions"><button data-action="profile" data-slot="${n}" id="profile-${n}">Customize</button></div></details></article>`;
    }).join('');
  }
  for (const r of state.outputs) {
    const n = r.slotIndex;
    $('route-'+n).classList.toggle('master-route',r.isTimingMaster);
    $('route-'+n).classList.toggle('unassigned-route',!r.selectedDeviceId);
    $('name-'+n).textContent = r.selectedDeviceName;
    $('image-'+n).src = `/device-icons/${['speaker','bookshelf','portable','soundbar','headphones'].includes(r.selectedDeviceIconType) ? r.selectedDeviceIconType : 'speaker'}.svg`;
    deviceSelect('device-'+n,state.playbackDevices,r.selectedDeviceId,'Select playback device');
    setValue('volume-'+n,r.volumePercent); setValue('exact-'+n,r.volumePercent); $('volumeValue-'+n).textContent = `${Math.round(r.volumePercent)}%`;
    setValue('delay-'+n,r.delayMilliseconds); $('timing-'+n).checked = r.isTimingMaster;
    for (const action of ['mute','solo']) $(''+action+'-'+n).setAttribute('aria-pressed',String(action === 'mute' ? r.isMuted : r.isSolo));
    for (const id of ['volume','exact','delay','timing','mute','solo']) disable(id+'-'+n,editing);
    disable('device-'+n,editing || !state.canEditTopology);
    disable('remove-'+n,editing || !state.canEditTopology || !r.canRemove);
    disable('ping-'+n,editing || !r.selectedDeviceId);
    disable('profile-'+n,editing || !r.selectedDeviceId);
    for (const button of $('route-'+n).querySelectorAll('[data-nudge]')) button.disabled = editing || r.delayMilliseconds+Number(button.dataset.nudge) < 0 || r.delayMilliseconds+Number(button.dataset.nudge) > 2000;
    for (const option of $('device-'+n).options) { const device = state.playbackDevices.find(d => d.id === option.value); option.disabled = !!option.value && option.value !== r.selectedDeviceId && (!device?.isActive || state.outputs.some(other => other.slotIndex !== n && other.selectedDeviceId === option.value)); }
  }
  renderLogs(); filterRoutes();
  const nextMapKey = JSON.stringify([state.useTestTone,state.selectedInputDeviceId,state.inputDevices,state.outputs.map(r => [r.slotIndex,r.selectedDeviceId,r.selectedDeviceName,r.selectedDeviceIconType,r.isTimingMaster])]);
  if (mapKey !== nextMapKey) { mapKey = nextMapKey; signalView.topology(state); }
  markSelectedNode();
  if (!signalView.latest) telemetry(state);
}
function telemetry(data) {
  for (const beat of document.querySelectorAll('[data-beat]')) beat.classList.toggle('active',Number(beat.dataset.beat) === data.manualSyncTickBeat);
  $('capture').value = data.captureLevel || 0; $('room').value = data.roomMicLevel || 0;
  for (const r of data.outputs || []) {
    if (!$('meter-'+r.slotIndex)) continue;
    $('meter-'+r.slotIndex).value = r.meterLevel || 0;
    $('status-'+r.slotIndex).textContent = r.statusText;
    $('db-'+r.slotIndex).textContent = `${r.meterLevel > 0 ? Math.max(-60,20*Math.log10(r.meterLevel)).toFixed(1) : '−∞'} dBFS`;
    $('confidence-'+r.slotIndex).textContent = `Confidence ${Math.round(Math.min(1,Math.max(0,r.syncConfidence || 0))*100)}%`;
    $('sync-'+r.slotIndex).textContent = `${r.syncSummary || 'Manual timing'} · ${r.effectiveDelayMilliseconds || 0} ms effective delay`;
  }
}
for (const [id,path] of Object.entries({start:'start',stop:'stop',refresh:'refresh-devices',add:'outputs',calibrate:'calibrate',cancel:'calibrate/cancel',tick:'sync-tick/toggle',config:'open-config-folder'})) $(id).onclick = () => command(path);
for (const [id,field] of Object.entries({input:'selectedInputDeviceId',mic:'selectedCalibrationInputDeviceId',tone:'useTestTone',master:'masterVolumePercent',mode:'autoSyncMode',marker:'markerLevelPercent'})) $(id).onchange = e => settings({[field]:e.target.type === 'checkbox' ? e.target.checked : ['master','marker'].includes(id) ? Number(e.target.value) : e.target.value || null});
for (const id of ['master','marker']) $(id).oninput = e => $(id+'Value').textContent = e.target.value+'%';
$('routes').addEventListener('input',e => { if (e.target.dataset.field === 'volumePercent') $('volumeValue-'+e.target.dataset.slot).textContent = e.target.value+'%'; });
async function commitRouteControl(el) {
  const {slot,field} = el.dataset;
  if (!field || busy) return;
  if (!el.checkValidity()) { el.reportValidity(); return; }
  const value = el.type === 'checkbox' ? el.checked : ['volumePercent','delayMilliseconds'].includes(field) ? Number(el.value) : el.value || null;
  const current = state.outputs.find(r => r.slotIndex === Number(slot));
  if (!current || current[field] === value) return;
  await updateRoute(Number(slot),{[field]:value});
  const confirmed = state.outputs.find(r => r.slotIndex === Number(slot));
  if (confirmed && el.type !== 'checkbox') el.value = confirmed[field] ?? '';
}
$('routes').addEventListener('change',e => commitRouteControl(e.target));
$('routes').addEventListener('focusout',e => { if (e.target.type === 'number') commitRouteControl(e.target); });
$('routes').addEventListener('keydown',e => { if (e.key === 'Enter' && e.target.type === 'number') { e.preventDefault(); commitRouteControl(e.target); } });
$('routes').addEventListener('click',e => {
  const nudge = e.target.closest('button[data-nudge]');
  if (nudge) { const r = state.outputs.find(r => r.slotIndex === Number(nudge.dataset.slot)); updateRoute(r.slotIndex,{delayMilliseconds:Math.min(2000,Math.max(0,r.delayMilliseconds+Number(nudge.dataset.nudge)))}); return; }
  const button = e.target.closest('button[data-action]'); if (!button) return;
  const {action,slot} = button.dataset;
  if (action === 'profile') {
    const route = state.outputs.find(r => r.slotIndex === Number(slot));
    profileDevice = state.playbackDevices.find(d => d.id === route.selectedDeviceId);
    $('alias').value = profileDevice.alias || ''; $('icon').value = profileDevice.iconType || 'auto'; $('profileError').textContent = ''; $('profile').showModal(); return;
  }
  command(action === 'remove' ? `outputs/${slot}` : `outputs/${slot}/${action}`, action === 'remove' ? 'DELETE' : 'POST');
});
$('closeProfile').onclick = () => $('profile').close();
$('profileForm').onsubmit = async e => { e.preventDefault(); if (await command('device-profiles','PUT',{deviceId:profileDevice.id,alias:$('alias').value,iconType:$('icon').value})) $('profile').close(); else $('profileError').textContent = $('error').textContent; };
function connection(online) { if (!online && state) state.stateRevision = -1; connected = online; signalView.connect(online); $('connection').textContent = online ? '● Connected locally' : '○ Reconnecting…'; $('connection').classList.toggle('online',online); render(); }
const events = new EventSource('/api/events');
events.addEventListener('state',e => { if (!connected) connection(true); accept(JSON.parse(e.data)); });
events.onerror = () => connection(false);
const meters = new EventSource('/api/telemetry');
meters.addEventListener('telemetry',e => { const data = normalize(JSON.parse(e.data)); telemetry(data); signalView.receive(data); });
meters.onerror = () => { signalView.lastAt = 0; signalView.updateReadouts(); };
window.addEventListener('pagehide',() => { events.close(); meters.close(); });
window.addEventListener('pageshow',e => { if (e.persisted) location.reload(); });

function filterRoutes() {
  if (!state) return;
  const query = $('routeSearch').value.trim().toLowerCase();
  const matches = state.outputs.filter(r => `${r.slotIndex} ${r.selectedDeviceName} ${r.selectedDeviceOriginalName}`.toLowerCase().includes(query));
  if (!matches.some(r => r.slotIndex === selectedSlot)) selectedSlot = matches[0]?.slotIndex ?? null;
  const consoleView = document.body.dataset.view === 'mixer';
  for (const route of state.outputs) $('route-'+route.slotIndex).hidden = !matches.includes(route) || (!consoleView && route.slotIndex !== selectedSlot);
  $('routeSearchEmpty').hidden = matches.length > 0;
  $('inspectorTitle').textContent = consoleView ? 'The mixer' : selectedSlot ? `Output ${String(selectedSlot).padStart(2,'0')}` : 'No output selected';
  $('inspectorEyebrow').textContent = consoleView ? 'ALL CHANNELS' : 'SELECTED OUTPUT';
  const nextPicker = JSON.stringify(matches.map(r => [r.slotIndex,r.selectedDeviceName]));
  if (pickerKey !== nextPicker) { pickerKey = nextPicker; $('channelPicker').innerHTML = matches.map(r => `<button data-select="${r.slotIndex}" aria-label="Select output ${r.slotIndex}" title="${escapeHtml(r.selectedDeviceName)}">${String(r.slotIndex).padStart(2,'0')}</button>`).join(''); }
  for (const button of $('channelPicker').children) button.setAttribute('aria-pressed',String(Number(button.dataset.select) === selectedSlot));
  const selected = state.outputs.find(r => r.slotIndex === selectedSlot);
  $('removeSelected').textContent = selected ? `Remove output ${String(selectedSlot).padStart(2,'0')}` : 'Remove selected output';
  disable('removeSelected',busy || !connected || !state.canEditTopology || !selected?.canRemove);
  $('removeHint').textContent = state.isRunning ? 'Stop streaming to remove outputs.' : state.isCalibrating ? 'Finish or cancel calibration first.' : state.outputs.length === 1 ? 'Keep at least one output.' : '';
  markSelectedNode();
}
function markSelectedNode() {
  for (const node of $('signalMap').querySelectorAll('[data-channel]')) {
    const selected = Number(node.dataset.channel) === selectedSlot;
    node.classList.toggle('selected',selected); node.setAttribute('aria-current',String(selected));
  }
}
function selectChannel(slot) {
  selectedSlot = slot; $('routeSearch').value = ''; filterRoutes();
  const route = $('route-'+slot);
  route?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
}
$('channelPicker').onclick = e => { const button = e.target.closest('[data-select]'); if (button) selectChannel(Number(button.dataset.select)); };
function switchView(view) {
  document.body.dataset.view = view;
  $('roomView').setAttribute('aria-pressed',String(view === 'room'));
  $('mixerView').setAttribute('aria-pressed',String(view === 'mixer'));
  filterRoutes();
}
$('roomView').onclick = () => switchView('room');
$('mixerView').onclick = () => switchView('mixer');
for (const button of document.querySelectorAll('[data-open]')) button.onclick = () => { $(button.dataset.open).showModal(); signalView.drawSoon(); };
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => button.closest('dialog').close();
function renderLogs() {
  if (!state) return;
  const query = $('logSearch').value.trim().toLowerCase(), level = $('logLevel').value;
  const entries = state.logEntries.map(e => e.displayText || e.message || '').filter(line => line.toLowerCase().includes(query) && (level === 'all' || level === 'warnings' && /\[(WARN|ERROR)\]/i.test(line) || level === 'calibration' && /calibrat/i.test(line)));
  const next = JSON.stringify(entries); if (logKey === next) return; logKey = next;
  $('logs').replaceChildren(...(entries.length ? entries.slice().reverse() : ['No matching events.']).map(line => { const li = document.createElement('li'); li.textContent = line; if (/\[(WARN|ERROR)\]/.test(line)) li.classList.add('log-warning'); return li; }));
}
$('routeSearch').oninput = filterRoutes;
$('logSearch').oninput = renderLogs; $('logLevel').onchange = renderLogs;
$('exportLogs').onclick = () => {
  if (!state) return;
  const file = new Blob([state.logEntries.map(e => e.displayText || e.message).join('\n')],{type:'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(file), link = document.createElement('a'); link.href = url; link.download = `astra-session-${new Date().toISOString().replace(/[:.]/g,'-')}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
};
$('dim').onclick = async () => {
  if (!state || busy || !connected) return;
  const original = dimRestore?.original ?? state.masterVolumePercent, dimmed = original/10, restoring = !!dimRestore;
  if (await settings({masterVolumePercent:restoring ? original : dimmed})) { dimRestore = restoring ? null : {original,dimmed}; render(); }
};
$('signalMap').addEventListener('click',e => {
  if (e.target.closest('[data-source]')) { e.preventDefault(); $('sourceDialog').showModal(); return; }
  const node = e.target.closest('[data-channel]'); if (!node) return;
  e.preventDefault(); selectChannel(Number(node.dataset.channel));
});
$('shortcuts').onclick = () => $('shortcutDialog').showModal(); $('closeShortcuts').onclick = () => $('shortcutDialog').close();
document.addEventListener('keydown',e => {
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.target.closest('input,select,textarea,button,a,[contenteditable="true"]') || document.querySelector('dialog[open]')) return;
  if (e.key === '/') { e.preventDefault(); $('routeSearch').focus(); }
  if (e.key.toLowerCase() === 'd' && !$('dim').disabled) { e.preventDefault(); $('dim').click(); }
  if (e.code === 'Space') { const button = state?.isRunning ? $('stop') : $('start'); if (!button.disabled) { e.preventDefault(); button.click(); } }
});


$('removeSelected').onclick = () => { if (selectedSlot !== null) command(`outputs/${selectedSlot}`,'DELETE'); };
$('tickDialog').onclick = () => command('sync-tick/toggle');
$('markerNoise').onclick = () => {
  const noiseOn = (modes[state.autoSyncMode] || state.autoSyncMode) !== 'Off' && state.markerLevelPercent > 0;
  settings(noiseOn ? {autoSyncMode:'Off',markerLevelPercent:0} : {autoSyncMode:previousNoise.mode,markerLevelPercent:previousNoise.level});
};
