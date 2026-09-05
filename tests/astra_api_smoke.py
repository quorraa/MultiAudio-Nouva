"""Integration checks. Run only against a host using MULTIAUDIO_CONFIG_PATH for test data.
Usage: python tests/astra_api_smoke.py http://localhost:5099
No audio playback or calibration is started.
"""
import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:5099'

def call(path, method='GET', body=None, headers=None):
    request = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type':'application/json', **(headers or {})})
    try:
        response = urllib.request.urlopen(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        return response.status, json.loads(raw) if 'application/json' in response.headers.get('Content-Type','') else raw

for path in ['/', '/astra', '/astra/', '/legacy/', '/v1/', '/v2/', '/v3/', '/legacy/v1/', '/legacy/v2/', '/legacy/v3/', '/v3/app.js', '/legacy/v3/assets/speaker.svg']:
    assert call(path)[0] == 200, path
assert b'Astra' in call('/')[1]
assert call('/api/missing')[0] == 404
assert call('/missing')[0] == 404
assert call('/api/health')[1]['version'] == 'astra'
assert call('/api/refresh-devices','POST',headers={'Origin':'https://example.com'})[0] == 403
assert call('/api/settings','PUT',{'autoSyncMode':999})[0] == 400
_, initial = call('/api/state')
assert not initial['isRunning'] and not initial['isCalibrating'], 'Use an idle test host'
_, added = call('/api/outputs','POST')
assert len(added['outputs']) == len(initial['outputs']) + 1
new_slot = next(r['slotIndex'] for r in added['outputs'] if r['slotIndex'] not in [x['slotIndex'] for x in initial['outputs']])
assert call(f'/api/outputs/{new_slot}','DELETE')[0] == 200
active = [d for d in initial['playbackDevices'] if d['isActive']]
if active and len(initial['outputs']) >= 2:
    first, second = initial['outputs'][:2]
    def route_body(route, device):
        return dict(selectedDeviceId=device, volumePercent=route['volumePercent'], delayMilliseconds=route['delayMilliseconds'], isTimingMaster=route['isTimingMaster'])
    # Use an unassigned device to avoid conflicting with an existing test route.
    device = next((d['id'] for d in active if d['id'] not in [r.get('selectedDeviceId') for r in initial['outputs']]), first.get('selectedDeviceId'))
    if device:
        assert call(f"/api/outputs/{first['slotIndex']}",'PUT',route_body(first,device))[0] == 200
        _, before = call('/api/state')
        assert call(f"/api/outputs/{second['slotIndex']}",'PUT',route_body(second,device))[0] == 400
        _, after = call('/api/state')
        assert before['outputs'] == after['outputs'], 'Rejected duplicate assignment changed state'
        assert call(f"/api/outputs/{first['slotIndex']}",'PUT',route_body(first,first.get('selectedDeviceId')))[0] == 200
for action, field in [('mute','isMuted'),('solo','isSolo')]:
    slot = initial['outputs'][0]['slotIndex']
    _, before = call('/api/state')
    _, changed = call(f'/api/outputs/{slot}/{action}','POST')
    assert changed['outputs'][0][field] != before['outputs'][0][field]
    assert call(f'/api/outputs/{slot}/{action}','POST')[0] == 200
print('PASS: Astra/legacy routes, 404s, origin guard, invalid enum, output lifecycle, atomic duplicate validation, mute and solo')
