"""Run against an isolated test host. Uses only a muted VB-Audio virtual output."""
import json, time, urllib.request, sys
BASE = sys.argv[1] if len(sys.argv)>1 else 'http://localhost:5100'
def call(path, method='GET', body=None):
    request = urllib.request.Request(BASE+'/api/'+path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=15) as response: return json.load(response)
state=call('state')
assert not state['isRunning'] and not state['isCalibrating'], 'Use an idle isolated host'
virtual=next((d for d in state['playbackDevices'] if d['isActive'] and d['name'] == 'CABLE Input (VB-Audio Virtual Cable)'),None)
assert virtual, 'No VB-Audio virtual endpoint available for a silent test'
for route in reversed(state['outputs'][1:]): call('outputs/'+str(route['slotIndex']),'DELETE')
slot=state['outputs'][0]['slotIndex']
call('outputs/'+str(slot),'PUT',dict(selectedDeviceId=virtual['id'],volumePercent=0,delayMilliseconds=0,isTimingMaster=True))
call('settings','PUT',dict(selectedInputDeviceId=state.get('selectedInputDeviceId'),selectedCalibrationInputDeviceId=None,useTestTone=True,masterVolumePercent=0,autoSyncMode='Off',markerLevelPercent=0))
try:
    call('start','POST'); call('sync-tick/toggle','POST')
    sequence=[]; deadline=time.monotonic()+7
    while time.monotonic()<deadline:
        data=call('telemetry-state'); beat=data['manualSyncTickBeat']
        if not sequence or sequence[-1] != beat: sequence.append(beat)
        if sequence==[1,2,3,4,1]: break
        time.sleep(.08)
    assert sequence==[1,2,3,4,1],sequence
    call('sync-tick/toggle','POST')
    assert call('telemetry-state')['manualSyncTickBeat']==0
    call('sync-tick/toggle','POST')
    assert call('telemetry-state')['manualSyncTickBeat']==1
    print('PASS: engine source beats 1-2-3-4-1, disable=0, re-enable restarts at beat 1; output muted')
finally:
    call('stop','POST')
    assert call('telemetry-state')['manualSyncTickBeat']==0

