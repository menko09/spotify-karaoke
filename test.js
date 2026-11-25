// Run: node test.js
const assert = require('assert');
const { parseLrc, findLineIndex, interpolate, pickBest } = require('./app.js');

const lrc = `[ar:Test]
[offset:0]
[00:12.50] First line
[00:20.00]<00:20.00>Second <00:21.00>line
[00:05.1][01:00.25] Chorus
[00:30]
[01:05.5] Last`;
const L = parseLrc(lrc);
assert.deepStrictEqual(L.map(l => l.t), [5100, 12500, 20000, 30000, 60250, 65500]);
assert.strictEqual(L[0].text, 'Chorus');
assert.strictEqual(L[2].text, 'Second line');
assert.strictEqual(L[3].text, '');
assert.strictEqual(parseLrc('').length, 0);
assert.strictEqual(parseLrc('[offset:500]\n[00:10.00] a')[0].t, 9500);

assert.strictEqual(findLineIndex(L, 0), -1);
assert.strictEqual(findLineIndex(L, 5100), 0);
assert.strictEqual(findLineIndex(L, 12499), 0);
assert.strictEqual(findLineIndex(L, 12500), 1);
assert.strictEqual(findLineIndex(L, 61000), 4);
assert.strictEqual(findLineIndex(L, 999999), 5);
assert.strictEqual(findLineIndex([], 100), -1);

assert.strictEqual(interpolate(1000, 100, 600, true, 0), 1500);
assert.strictEqual(interpolate(1000, 100, 600, false, 0), 1000);
assert.strictEqual(interpolate(1000, 100, 5000, true, 2000), 2000);

const best = pickBest([{ duration: 300, plainLyrics: 'x' }, { duration: 250, syncedLyrics: '[00:01.00] a' }, { duration: 201, syncedLyrics: '[00:01.00] b' }], 200);
assert.strictEqual(best.duration, 201);
assert.strictEqual(pickBest([], 1), null);
console.log('all tests passed');
