// Telemetry is peak amplitude, not PCM: this deliberately plots a level history,
// never an invented waveform or spectrum.
export const peakDb = level => Number.isFinite(level) && level > 0 ? Math.max(-60, Math.min(0, 20 * Math.log10(level))) : -60;
export const dbLabel = level => Number.isFinite(level) && level > 0 ? peakDb(level).toFixed(1) : '−∞';
export class SignalHistory {
  constructor() { this.samples = []; }
  push(at, input, mic) {
    const last = this.samples.at(-1);
    if (last && at - last.at < 100) {
      last.input = Math.max(last.input, input || 0);
      last.mic = Math.max(last.mic, mic || 0);
    } else this.samples.push({at,input:input || 0,mic:mic || 0});
    this.samples = this.samples.filter(sample => at - sample.at <= 30000);
  }
  clear() { this.samples = []; }
}
const text = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export class SignalView {
  constructor() {
    this.map = document.getElementById('signalMap');
    this.canvas = document.getElementById('levelHistory');
    this.history = new SignalHistory();
    this.latest = null; this.snapshot = null; this.peak = 0; this.lastAt = 0; this.online = false;
    this.frame = null; this.frozen = null;
    this.resize = new ResizeObserver(() => this.drawSoon());
    this.resize.observe(this.canvas);
    document.getElementById('resetPeak').onclick = () => { this.peak = 0; this.updateReadouts(); };
    document.getElementById('holdHistory').onclick = e => {
      this.frozen = this.frozen ? null : {samples:this.history.samples.map(s => ({...s})),at:Date.now()};
      e.target.setAttribute('aria-pressed',String(!!this.frozen));
      e.target.textContent = this.frozen ? 'Resume graph' : 'Hold graph';
      this.drawSoon();
    };
    this.staleTimer = setInterval(() => {
      if (!this.isFresh()) { this.updateReadouts(); this.map.classList.remove('flowing'); }
      if (!this.latest?.isRunning || !this.isFresh()) this.drawSoon();
    },1000);
    document.addEventListener('visibilitychange',() => { if (!document.hidden) this.drawSoon(); });
    window.addEventListener('pagehide',() => { clearInterval(this.staleTimer); this.resize.disconnect(); cancelAnimationFrame(this.frame); });
  }
  isFresh() { return this.online && this.lastAt > 0 && ((!this.latest?.isRunning && !this.latest?.isCalibrating) || Date.now()-this.lastAt < 4000); }
  connect(online) {
    this.online = online;
    if (!online) { this.latest = null; this.lastAt = 0; this.map.classList.remove('flowing'); }
    this.updateReadouts(); this.drawSoon();
  }
  topology(state) {
    this.snapshot = state;
    const source = state.useTestTone ? 'Test tone · 440 Hz' : state.inputDevices.find(d => d.id === state.selectedInputDeviceId);
    const sourceName = typeof source === 'string' ? source : source?.alias || source?.name || 'Choose your source';
    const count = state.outputs.length;
    const columns = Math.ceil(count/2), width = count > 6 ? Math.max(900,columns*210) : 900;
    this.map.setAttribute('viewBox',`0 0 ${width} 650`);
    const cx = width/2, cy = 325;
    this.map.innerHTML = `<defs><radialGradient id="roomGlow"><stop stop-color="#d4996955"/><stop offset=".55" stop-color="#77472e16"/><stop offset="1" stop-color="#17171b00"/></radialGradient><radialGradient id="hubGlow"><stop stop-color="#ffcba8"/><stop offset=".18" stop-color="#e49968"/><stop offset=".55" stop-color="#a0644733"/><stop offset="1" stop-color="#201c1b00"/></radialGradient><linearGradient id="hubMetal" x2="1" y2="1"><stop stop-color="#4a403b"/><stop offset=".45" stop-color="#252426"/><stop offset="1" stop-color="#131519"/></linearGradient></defs><ellipse cx="${cx}" cy="${cy}" rx="420" ry="280" fill="url(#roomGlow)"/><ellipse class="room-orbit outer" cx="${cx}" cy="${cy}" rx="335" ry="236"/><ellipse class="room-orbit" cx="${cx}" cy="${cy}" rx="260" ry="182"/><ellipse class="room-orbit inner" cx="${cx}" cy="${cy}" rx="175" ry="122"/><path class="room-axis" d="M ${cx} 35 V 615 M ${cx-400} ${cy} H ${cx+400}"/>`;
    this.map.innerHTML += state.outputs.map((r,i) => {
      const angle = (count === 1 ? -50 : -135 + i*360/count)*Math.PI/180;
      const x = count > 6 ? 100+(i%columns)*(width-200)/Math.max(1,columns-1) : cx+305*Math.cos(angle);
      const y = count > 6 ? (i<columns ? 120 : 525) : cy+220*Math.sin(angle);
      const assigned = !!r.selectedDeviceId;
      const icon = ['speaker','bookshelf','portable','soundbar','headphones'].includes(r.selectedDeviceIconType) ? r.selectedDeviceIconType : 'speaker';
      return `<path class="signal-path" d="M ${cx} ${cy} L ${x} ${y}"/><path id="flow-${r.slotIndex}" class="signal-path signal-flow" d="M ${cx} ${cy} L ${x} ${y}"/><a href="#route-${r.slotIndex}" data-channel="${r.slotIndex}" aria-label="Select output ${r.slotIndex}: ${text(r.selectedDeviceName)}"><g class="speaker-node ${assigned ? 'assigned' : 'unassigned'}" id="node-${r.slotIndex}"><ellipse class="speaker-halo" cx="${x}" cy="${y+23}" rx="72" ry="24"/><ellipse class="speaker-plinth" cx="${x}" cy="${y+23}" rx="58" ry="18"/>${assigned ? `<image href="/device-icons/${icon}.svg" x="${x-62}" y="${y-90}" width="124" height="116" class="speaker-art"/>` : `<circle class="empty-node" cx="${x}" cy="${y-14}" r="31"/><text class="empty-plus" x="${x}" y="${y-4}" text-anchor="middle">+</text>`}<text class="speaker-number" x="${x-65}" y="${y-61}">${String(r.slotIndex).padStart(2,'0')}</text><text x="${x}" y="${y+61}" text-anchor="middle" class="node-label">${assigned ? text(r.selectedDeviceName.replace(/ \[Active\]$/,'').slice(0,29)) : 'Add a device'}</text><text id="node-detail-${r.slotIndex}" x="${x}" y="${y+80}" text-anchor="middle" class="node-detail">${assigned ? 'Ready' : 'Unassigned'}${r.isTimingMaster ? ' · MASTER' : ''}</text><title>${text(r.selectedDeviceName)}</title></g></a>`;
    }).join('');
    this.map.innerHTML += `<a href="#sourceDialog" data-source aria-label="Choose audio source"><circle cx="${cx}" cy="${cy}" r="102" fill="url(#hubGlow)"/><circle class="hub-rim" cx="${cx}" cy="${cy}" r="55"/><circle cx="${cx}" cy="${cy}" r="48" fill="url(#hubMetal)"/><text x="${cx}" y="${cy+12}" text-anchor="middle" class="source-symbol">✳</text><text x="${cx}" y="${cy+89}" text-anchor="middle" class="hub-caption">AUDIO SOURCE</text><text x="${cx}" y="${cy+108}" text-anchor="middle" class="node-detail">${text(sourceName.length > 33 ? sourceName.slice(0,30)+'…' : sourceName)}</text></a>`;
    const assigned = state.outputs.filter(r => r.selectedDeviceId).length;
    document.getElementById('assignedCount').textContent = `${assigned} / ${state.outputs.length}`;
    document.getElementById('assignedHint').textContent = assigned === state.outputs.length ? 'All routes assigned' : `${state.outputs.length-assigned} awaiting a device`;
    this.updateReadouts();
  }
  receive(data) {
    this.latest = data; this.lastAt = Date.now();
    this.history.push(this.lastAt,data.captureLevel,data.roomMicLevel);
    this.peak = Math.max(this.peak,data.captureLevel || 0);
    this.updateReadouts(); this.drawSoon();
  }
  updateReadouts() {
    const fresh = this.isFresh(), data = this.latest;
    if (!fresh) {
      for (const beat of document.querySelectorAll('[data-beat]')) beat.classList.remove('active');
      for (const id of ['capture','room']) document.getElementById(id).value = 0;
      for (const route of this.snapshot?.outputs || []) {
        const meter = document.getElementById('meter-'+route.slotIndex);
        if (meter) meter.value = 0;
        const db = document.getElementById('db-'+route.slotIndex);
        if (db) db.textContent = '— dBFS';
      }
    }
    const status = document.getElementById('telemetryStatus');
    status.textContent = fresh ? (data?.isRunning ? '● Live telemetry' : '● Engine idle') : '○ Telemetry unavailable';
    status.classList.toggle('online',fresh);
    document.getElementById('peakReadout').innerHTML = `${fresh ? dbLabel(data?.captureLevel) : '—'}<em> dBFS</em>`;
    document.getElementById('peakHold').textContent = `Peak hold: ${dbLabel(this.peak)} dBFS`;
    const locked = fresh ? (data?.outputs || []).filter(r => r.syncLockState === 'Locked' || r.syncLockState === 4).length : 0;
    document.getElementById('lockReadout').textContent = fresh ? `${locked} / ${data?.outputs?.length || 0}` : '—';
    document.getElementById('lockHint').textContent = !fresh ? 'Waiting for fresh measurements' : data?.isRunning ? 'Outputs reporting a sync lock' : 'Start streaming to measure sync';
    this.map.classList.toggle('flowing',fresh && !!data?.isRunning);
    for (const r of data?.outputs || []) {
      const node = document.getElementById('node-'+r.slotIndex), detail = document.getElementById('node-detail-'+r.slotIndex), flow = document.getElementById('flow-'+r.slotIndex);
      if (!node) continue;
      const route = this.snapshot?.outputs.find(o => o.slotIndex === r.slotIndex);
      const silent = r.isMuted || r.appliedVolumePercent === 0;
      node.classList.toggle('muted',silent); node.classList.toggle('active',fresh && !silent && r.meterLevel > .001);
      if (flow) flow.style.opacity = fresh && !silent && r.meterLevel > .001 ? String(.35+Math.min(1,r.meterLevel)*.65) : '0';
      detail.textContent = !fresh ? 'Telemetry unavailable' : `${r.isMuted ? 'MUTED' : r.isSolo ? 'SOLO' : r.statusText || 'Idle'} · ${r.effectiveDelayMilliseconds || 0} ms${route?.isTimingMaster ? ' · MASTER' : ''}`;
    }
  }
  drawSoon() {
    if (this.frame || document.hidden) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.draw(); });
  }
  draw() {
    const ctx = this.canvas.getContext('2d'), width = this.canvas.clientWidth, height = 130;
    if (!width) return;
    const dpr = Math.min(devicePixelRatio || 1,2);
    this.canvas.width = width*dpr; this.canvas.height = height*dpr; ctx.scale(dpr,dpr);
    const now = this.frozen?.at || Date.now(), samples = this.frozen?.samples || this.history.samples;
    const left = 32, right = width-12, top = 10, bottom = height-22;
    ctx.font = '10px Segoe UI'; ctx.lineWidth = 1;
    for (const db of [0,-20,-40,-60]) {
      const y = top + (-db/60)*(bottom-top);
      ctx.strokeStyle = '#293d3b'; ctx.beginPath(); ctx.moveTo(left,y); ctx.lineTo(right,y); ctx.stroke();
      ctx.fillStyle = '#819790'; ctx.fillText(String(db),1,y+3);
    }
    for (const [key,color] of [['input','#e5b28d'],['mic','#81dfdc']]) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.7; ctx.beginPath(); let previous;
      for (const sample of samples) {
        if (now-sample.at > 30000) continue;
        const x = left+(1-(now-sample.at)/30000)*(right-left), y = top+(-peakDb(sample[key])/60)*(bottom-top);
        if (!previous || sample.at-previous.at > 1500) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        previous = sample;
      }
      ctx.stroke();
    }
    ctx.fillStyle = '#819790'; ctx.fillText('−30s',left,height-5); ctx.fillText(this.frozen ? 'Held' : 'Now',right-23,height-5);
    document.getElementById('historyDescription').textContent = this.frozen ? 'Graph held for inspection. Audio controls and live readouts remain active.' : !this.isFresh() ? 'No fresh telemetry. Gaps indicate unavailable measurements.' : !this.latest?.isRunning ? 'Engine idle. Start streaming to record input and room-mic levels.' : 'Measured input and room-mic peaks. Silence sits at the −60 dBFS display floor.';
  }
}
