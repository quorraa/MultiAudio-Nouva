import assert from 'node:assert/strict';
import { test } from 'node:test';
import { peakDb, dbLabel, SignalHistory } from '../WebUI/wwwroot/astra/visualizer.mjs';

test('peak amplitude uses logarithmic dBFS and a finite display floor', () => {
  assert.equal(peakDb(1),0);
  assert.equal(peakDb(.1),-20);
  assert.equal(peakDb(.001),-60);
  for (const value of [0,-1,NaN,undefined]) assert.equal(peakDb(value),-60);
  assert.equal(peakDb(2),0);
  assert.equal(dbLabel(0),'−∞');
});

test('history retains peaks between plot samples instead of discarding short transients', () => {
  const history = new SignalHistory();
  history.push(1000,.1,.2); history.push(1033,.9,.1); history.push(1066,.2,.7);
  assert.deepEqual(history.samples,[{at:1000,input:.9,mic:.7}]);
  history.push(1100,.3,.4);
  assert.equal(history.samples.length,2);
});

test('history remains bounded and preserves outage gaps', () => {
  const history = new SignalHistory();
  for (let t=0;t<120000;t+=33) history.push(t,.2,0);
  assert.ok(history.samples.length <= 301);
  assert.ok(history.samples.at(-1).at-history.samples[0].at <= 30000);
  history.push(125000,.4,.3);
  assert.ok(history.samples.at(-1).at-history.samples.at(-2).at > 1500);
  history.clear(); assert.deepEqual(history.samples,[]);
});
