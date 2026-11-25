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

// ---- v3 helpers ----
const { SCOPE_LIST, hasScopes, searchQuery, normTrack, dedupeTracks, apiErrorMessage } = require('./app.js');
assert.ok(hasScopes(SCOPE_LIST.join(' '), SCOPE_LIST));
assert.ok(!hasScopes('user-read-currently-playing user-read-playback-state', SCOPE_LIST));
assert.ok(!hasScopes(undefined, SCOPE_LIST));
assert.ok(hasScopes('b  a c', ['a', 'b']));
assert.strictEqual(searchQuery('  hello   world ', false), 'hello world');
assert.strictEqual(searchQuery('hello', true), 'hello karaoke');
assert.strictEqual(searchQuery('hello Karaoke', true), 'hello Karaoke');
assert.strictEqual(searchQuery('   ', true), '');
const tr = normTrack({ id: 'a', uri: 'spotify:track:a', name: 'N', artists: [{ name: 'X' }, { name: 'Y' }], album: { images: [{ url: 'big' }, { url: 'small' }] }, duration_ms: 5 });
assert.deepStrictEqual(tr, { id: 'a', uri: 'spotify:track:a', name: 'N', artists: 'X, Y', art: 'small', duration: 5 });
assert.strictEqual(normTrack(null), null);
assert.strictEqual(normTrack({ id: 'e', uri: 'spotify:episode:e', type: 'episode' }), null);
assert.strictEqual(normTrack({ id: null, uri: 'spotify:local:x' }), null);
assert.strictEqual(normTrack({ id: 'b', uri: 'u', artists: [], album: null }).art, '');
assert.deepStrictEqual(dedupeTracks([{ id: 1 }, { id: 2 }, { id: 1 }]).map(t => t.id), [1, 2]);
assert.match(apiErrorMessage(404, { error: { reason: 'NO_ACTIVE_DEVICE' } }), /Open Spotify on your phone or laptop and press play once/);
assert.match(apiErrorMessage(404, { error: { message: 'Player command failed: No active device found' } }), /press play once/);
assert.match(apiErrorMessage(403, { error: { reason: 'PREMIUM_REQUIRED' } }), /Premium/);
assert.match(apiErrorMessage(429), /slow down/);
assert.match(apiErrorMessage(403, { error: { message: 'Insufficient client scope' } }), /log in again/i);
console.log('v3 tests passed');

// ---- v4: title cleaner ----
const { cleanTitle, parseYouTubeId, orderInstances, tryInstances, normPiped, normInvidious, normAudius, ytErrorMessage } = require('./app.js');
const ct = (raw, fb) => { const r = cleanTitle(raw, fb); return r.artist + ' / ' + r.title; };
assert.strictEqual(ct('Adele - Hello (Karaoke Version)'), 'Adele / Hello');
assert.strictEqual(ct('Adele - Hello [Official Video]'), 'Adele / Hello');
assert.strictEqual(ct('Queen - Bohemian Rhapsody (Official Video Remastered)'), 'Queen / Bohemian Rhapsody');
assert.strictEqual(ct('Hello (In the Style of Adele) [Karaoke Version]'), 'Adele / Hello');
assert.strictEqual(ct('Sing King Karaoke - Hello (In the Style of Adele)'), 'Adele / Hello');
assert.strictEqual(ct('Karaoke - Adele - Hello'), 'Adele / Hello');
assert.strictEqual(ct('Adele - Hello | Karaoke Version | Sing King'), 'Adele / Hello');
assert.strictEqual(ct('Adele - Hello - Karaoke Version'), 'Adele / Hello');
assert.strictEqual(ct('Adele – Hello (Karaoke)'), 'Adele / Hello');
assert.strictEqual(ct('Drake ft. Rihanna - Take Care'), 'Drake / Take Care');
assert.strictEqual(ct('Hello (Karaoke Version)'), ' / Hello');
assert.strictEqual(ct('Wonderwall', 'Oasis - Topic'), 'Oasis / Wonderwall');
assert.strictEqual(ct('Wonderwall', ''), ' / Wonderwall');
assert.strictEqual(ct('Adele - Hello (Live at the Royal Albert Hall)'), 'Adele / Hello (Live at the Royal Albert Hall)');
// file names, incl. Forge3's "_instrumental"
assert.strictEqual(ct('Adele - Hello_instrumental.mp3'), 'Adele / Hello');
assert.strictEqual(ct('Artist_-_Song_Name_instrumental.mp3'), 'Artist / Song Name');
assert.strictEqual(ct('Song Only_instrumental.wav'), ' / Song Only');
assert.strictEqual(ct('01 - Coldplay - Yellow.mp3'), 'Coldplay / Yellow');
assert.strictEqual(ct(''), ' / ');
assert.strictEqual(ct(null), ' / ');

assert.strictEqual(parseYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(parseYouTubeId('https://www.youtube.com/watch?feature=x&v=dQw4w9WgXcQ&t=5'), 'dQw4w9WgXcQ');
assert.strictEqual(parseYouTubeId('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'dQw4w9WgXcQ');
assert.strictEqual(parseYouTubeId('https://youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(parseYouTubeId('Wonderwalls'), null);
assert.strictEqual(parseYouTubeId('adele hello'), null);

// ---- v4: normalizers ----
assert.deepStrictEqual(normPiped({ items: [{ type: 'stream', url: '/watch?v=abcdefghijk', title: 'T', uploaderName: 'U', duration: 200 }, { type: 'channel', url: '/channel/x' }, { type: 'stream', url: '/watch?v=live1234567', duration: -1 }] }).map(v => [v.id, v.duration]), [['abcdefghijk', 200], ['live1234567', 0]]);
assert.deepStrictEqual(normInvidious([{ type: 'video', videoId: 'abcdefghijk', title: 'T', author: 'A', lengthSeconds: 90 }, { type: 'channel' }]).map(v => [v.id, v.channel, v.duration]), [['abcdefghijk', 'A', 90]]);
assert.deepStrictEqual(normInvidious('<html>'), []);
const au = normAudius({ data: [{ id: 'D7KyD', title: 'Song', duration: 180, user: { name: 'Bob' }, artwork: { '150x150': 'a.jpg' } }, { id: 'x', is_streamable: false }] });
assert.deepStrictEqual(au, [{ id: 'D7KyD', title: 'Song', artist: 'Bob', duration: 180, art: 'a.jpg' }]);
assert.match(ytErrorMessage(150), /does not allow/);
assert.match(ytErrorMessage(101), /does not allow/);

// ---- v4: instance fallback ----
assert.deepStrictEqual(orderInstances(['https://a/', 'https://b', 'https://a'], 'https://b/'), ['https://b', 'https://a']);
assert.deepStrictEqual(orderInstances(['https://a', 'https://b'], 'https://zzz'), ['https://a', 'https://b']);
assert.deepStrictEqual(orderInstances(undefined, null), []);
(async () => {
  const calls = [];
  // first fails, second hangs past the timeout, third answers
  const r = await tryInstances(['bad', 'slow', 'good'], async (base, signal) => {
    calls.push(base);
    if (base === 'bad') throw new Error('HTTP 403');
    if (base === 'slow') { await new Promise((res, rej) => { signal.addEventListener('abort', () => rej(new Error('aborted'))); }); }
    return 'ok:' + base;
  }, 60);
  assert.deepStrictEqual(r, { base: 'good', result: 'ok:good' });
  assert.deepStrictEqual(calls, ['bad', 'slow', 'good']);
  // stops at the first success
  calls.length = 0;
  await tryInstances(['one', 'two'], async b => { calls.push(b); return 1; }, 60);
  assert.deepStrictEqual(calls, ['one']);
  // all fail: error lists every reason
  await assert.rejects(() => tryInstances(['x', 'y'], async b => { throw new Error('boom ' + b); }, 60), e => {
    assert.strictEqual(e.errors.length, 2);
    assert.match(e.errors[0], /x: boom x/);
    return true;
  });
  await assert.rejects(() => tryInstances([], async () => 1, 60));
  console.log('v4 tests passed');
})();
