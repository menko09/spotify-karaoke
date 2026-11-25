'use strict';
/* Spotify Karaoke - static site, no build. Pure helpers are exported for node tests. */

// ---------- pure helpers ----------

/** Parse LRC text into [{t: ms, text}] sorted by time. Supports multiple stamps per line and [offset:]. */
function parseLrc(text) {
  const out = [];
  if (!text) return out;
  let offset = 0;
  const om = /^\s*\[offset:\s*(-?\d+)\s*\]/im.exec(text);
  if (om) offset = parseInt(om[1], 10) || 0; // ms, positive = lyrics appear earlier
  const stamp = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [];
    let m, last = 0;
    stamp.lastIndex = 0;
    while ((m = stamp.exec(raw)) !== null) {
      const frac = m[3] ? parseInt((m[3] + '00').slice(0, 3), 10) : 0;
      stamps.push((+m[1]) * 60000 + (+m[2]) * 1000 + frac - offset);
      last = stamp.lastIndex;
    }
    if (!stamps.length) continue;
    const lyric = raw.slice(last).replace(/<\d+:\d+(?:[.:]\d+)?>/g, '').trim(); // strip word-level tags
    for (const t of stamps) out.push({ t: Math.max(0, t), text: lyric });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Index of the line active at time tMs (last line with t <= tMs), or -1 before the first line. */
function findLineIndex(lines, tMs) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= tMs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Local playback position: last polled progress plus elapsed wall time while playing, clamped to duration. */
function interpolate(progressMs, polledAt, now, playing, durationMs) {
  let p = progressMs + (playing ? now - polledAt : 0);
  if (durationMs > 0) p = Math.min(p, durationMs);
  return Math.max(0, p);
}

/** Pick the best LRCLIB search hit: prefers synced, then closest duration. */
function pickBest(results, durationSec) {
  if (!Array.isArray(results) || !results.length) return null;
  const score = r => (r.syncedLyrics ? 0 : 1000) + Math.abs((r.duration || 0) - durationSec);
  const usable = results.filter(r => r.syncedLyrics || r.plainLyrics);
  usable.sort((a, b) => score(a) - score(b));
  return usable[0] || null;
}

// ---------- v4 helpers: title cleaning, keyless sources ----------

const JUNK_WORDS = /\b(karaoke|instrumentals?|official|video|audio|lyrics?|hd|hq|4k|remaster(?:ed)?|version|backing|sing[- ]?along|minus one|visuali[sz]er|mv|no vocals|full song|with lyrics)\b/i;
const KARAOKE_CHANNEL = /karaoke|sing king|backing|studio|instrumentals?|zoom/i;

/**
 * Clean a messy video title or file name into {artist, title} for the lyrics lookup.
 * "Adele - Hello (Karaoke Version)" -> Adele / Hello. "Artist_-_Song_instrumental.mp3" -> Artist / Song.
 * fallbackArtist (e.g. channel name) is used only when the text has no "Artist - " part.
 */
function cleanTitle(raw, fallbackArtist) {
  let s = String(raw || '');
  s = s.replace(/\.(mp3|wav|m4a|ogg|flac|aac|webm|mp4)$/i, '').replace(/_/g, ' ');
  s = s.replace(/[‒-―−]/g, '-'); // en/em dashes
  s = s.replace(/[\s-]+instrumental\s*$/i, '');
  // "(In the Style of X)", "[Originally performed by X]" name the real artist
  let styleArtist = '';
  s = s.replace(/[(\[]\s*(?:in the style of|originally performed by|as made famous by|made famous by|originally by|karaoke version of)\s+([^)\]]+)[)\]]/i,
    (m, a) => { styleArtist = a.trim(); return ' '; });
  s = s.replace(/[(\[{]\s*(?:feat|ft|featuring)\b[^)\]}]*[)\]}]/gi, ' ');
  s = s.replace(/[(\[{][^)\]}]*[)\]}]/g, m => (JUNK_WORDS.test(m) ? ' ' : m));
  s = s.split(/\s*\|\s*/)[0];
  s = s.replace(/^\s*karaoke\s*[-:]\s*/i, '');
  s = s.replace(/^\s*\d{1,3}\s*[-.)]\s+/, '');
  for (let i = 0; i < 3; i++) { // trailing "- Karaoke Version", " karaoke", "- Official Audio"
    s = s.replace(/\s*[-:]\s*(?:(?:karaoke|instrumental|official|lyrics?|audio|video|hd|hq|with lyrics|sing along)\b[\w\s]*)$/i, '')
         .replace(/\s+(?:karaoke|instrumental)(?:\s+version)?\s*$/i, '');
  }
  s = s.replace(/\s+/g, ' ').trim();
  const unquote = x => x.replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  let artist = '', title = s;
  if (styleArtist) {
    const parts = s.split(/\s+-\s+/).filter(p => p && !KARAOKE_CHANNEL.test(p));
    artist = styleArtist; title = parts[0] || s;
  } else {
    const m = /^(.+?)\s+-\s+(.+)$/.exec(s);
    if (m) { artist = m[1]; title = m[2]; }
    else if (fallbackArtist) {
      artist = String(fallbackArtist).replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
    }
  }
  const stripFeat = x => x.replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, '').trim();
  artist = unquote(stripFeat(artist));
  title = unquote(stripFeat(title)).replace(/[\s\-:,]+$/, '');
  return { artist, title };
}

/** YouTube video id from a pasted watch/share/shorts/embed link, or null. */
function parseYouTubeId(text) {
  const m = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/|live\/|v\/))([\w-]{11})/i.exec(String(text || ''));
  return m ? m[1] : null;
}

/** Drop duplicates, strip trailing slashes, and move the last known-good instance first. */
function orderInstances(list, lastGood) {
  const norm = x => String(x).replace(/\/+$/, '');
  const seen = new Set();
  const out = (list || []).map(norm).filter(x => x && !seen.has(x) && seen.add(x));
  const i = lastGood ? out.indexOf(norm(lastGood)) : -1;
  if (i > 0) out.unshift(out.splice(i, 1)[0]);
  return out;
}

/**
 * Try fn(instance, abortSignal) on each instance in turn; each attempt gets timeoutMs.
 * Resolves {base, result} from the first that succeeds, otherwise throws with err.errors listing why.
 */
async function tryInstances(instances, fn, timeoutMs) {
  const errors = [];
  for (const inst of instances) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer;
    try {
      const result = await Promise.race([
        fn(inst, ctl && ctl.signal),
        new Promise((_, rej) => { timer = setTimeout(() => { if (ctl) ctl.abort(); rej(new Error('timeout')); }, timeoutMs); })
      ]);
      clearTimeout(timer);
      return { base: inst, result };
    } catch (e) {
      clearTimeout(timer);
      errors.push(String(inst) + ': ' + ((e && e.message) || e));
    }
  }
  const err = new Error('All instances failed');
  err.errors = errors;
  throw err;
}

const ytThumb = id => 'https://i.ytimg.com/vi/' + id + '/default.jpg';
const idFromWatchUrl = u => { const m = /[?&]v=([\w-]{11})/.exec(String(u || '')); return m ? m[1] : null; };

/** Piped /search?filter=videos -> [{id,title,channel,duration,thumb}] */
function normPiped(j) {
  return ((j && j.items) || []).map(i => {
    const id = idFromWatchUrl(i.url);
    if (!id || (i.type && i.type !== 'stream')) return null;
    return { id, title: i.title || '', channel: i.uploaderName || '', duration: i.duration > 0 ? i.duration : 0, thumb: ytThumb(id) };
  }).filter(Boolean);
}

/** Invidious /api/v1/search?type=video -> same shape */
function normInvidious(arr) {
  return (Array.isArray(arr) ? arr : []).map(i => {
    if (!i || !i.videoId || (i.type && i.type !== 'video')) return null;
    return { id: i.videoId, title: i.title || '', channel: i.author || '', duration: i.lengthSeconds > 0 ? i.lengthSeconds : 0, thumb: ytThumb(i.videoId) };
  }).filter(Boolean);
}

/** Audius /v1/tracks/search -> [{id,title,artist,duration,art}] (streamable only) */
function normAudius(j) {
  return ((j && j.data) || []).filter(t => t && t.id && t.is_streamable !== false).map(t => ({
    id: String(t.id), title: t.title || '', artist: (t.user && t.user.name) || '', duration: t.duration || 0,
    art: (t.artwork && (t.artwork['150x150'] || t.artwork['480x480'] || t.artwork['1000x1000'])) || ''
  }));
}

/** Friendly text for YouTube IFrame player error codes. */
function ytErrorMessage(code) {
  if (code === 101 || code === 150) return 'The owner of this video does not allow playing it here. Pick another version.';
  if (code === 100) return 'This video is private or has been removed. Pick another.';
  if (code === 2) return 'That does not look like a valid YouTube video.';
  return 'YouTube could not play this video. Try another.';
}

const SCOPE_LIST = ['user-read-currently-playing', 'user-read-playback-state', 'user-modify-playback-state',
  'playlist-read-private', 'user-top-read', 'user-read-recently-played'];

/** True if the space-separated scope string `have` contains every scope in `need`. */
function hasScopes(have, need) {
  if (!have || typeof have !== 'string') return false;
  const set = new Set(have.split(/\s+/).filter(Boolean));
  return need.every(s => set.has(s));
}

/** Search text for Spotify; the karaoke toggle appends " karaoke" (once). Empty input gives ''. */
function searchQuery(text, karaoke) {
  const q = String(text || '').trim().replace(/\s+/g, ' ');
  if (!q) return '';
  if (karaoke && !/\bkaraoke$/i.test(q)) return q + ' karaoke';
  return q;
}

/** Reduce a Spotify track object to what the UI needs; null for episodes, local files or junk. */
function normTrack(t) {
  if (!t || !t.id || !t.uri || t.type === 'episode') return null;
  const imgs = (t.album && t.album.images) || [];
  const img = imgs.length ? imgs[imgs.length - 1] : null; // smallest image is plenty for a list row
  return {
    id: t.id, uri: t.uri, name: t.name || '(untitled)',
    artists: (t.artists || []).map(a => a.name).join(', '),
    art: img ? img.url : '', duration: t.duration_ms || 0
  };
}

/** Drop later duplicates by id (recently-played repeats songs). */
function dedupeTracks(list) {
  const seen = new Set();
  return list.filter(t => t && !seen.has(t.id) && seen.add(t.id));
}

/** Friendly text for a failed Spotify API call. */
function apiErrorMessage(status, body) {
  const e = (body && body.error) || {};
  const reason = e.reason || '', msg = String(e.message || '');
  if (reason === 'NO_ACTIVE_DEVICE' || /no active device/i.test(msg)) {
    return 'Open Spotify on your phone or laptop and press play once, then try again.';
  }
  if (reason === 'PREMIUM_REQUIRED') return 'Spotify Premium is needed to control playback.';
  if (status === 429) return 'Spotify says slow down. Try again in a few seconds.';
  if (status === 401) return 'Your Spotify session expired. Please log in again.';
  if (status === 403) return /scope/i.test(msg) ? 'Missing permission. Please log in again.' : 'Spotify refused that request (403).';
  if (status === 404) return 'Spotify could not find that.';
  return 'Spotify error (' + status + ').';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseLrc, findLineIndex, interpolate, pickBest, SCOPE_LIST, hasScopes, searchQuery, normTrack, dedupeTracks, apiErrorMessage,
    cleanTitle, parseYouTubeId, orderInstances, tryInstances, normPiped, normInvidious, normAudius, ytErrorMessage };
}

// ---------- browser app ----------
if (typeof document !== 'undefined') (function () {
  const $ = id => document.getElementById(id);
  const SCOPES = SCOPE_LIST.join(' ');
  const API_BASE = 'https://api.spotify.com/v1';
  let blockedUntil = 0; // epoch ms; set on 429 so nothing hits Spotify until Retry-After passes
  const AUTH = 'https://accounts.spotify.com/authorize';
  const TOKEN = 'https://accounts.spotify.com/api/token';
  const API = 'https://api.spotify.com/v1/me/player/currently-playing';
  const POLL_MS = 2000;

  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');
  const clientId = () => (typeof CLIENT_ID !== 'undefined' ? CLIENT_ID : '');
  const configured = () => clientId() && clientId() !== 'PASTE_HERE';

  // --- PKCE ---
  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randStr = n => b64url(crypto.getRandomValues(new Uint8Array(n)));

  async function login() {
    const verifier = randStr(64);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const state = randStr(16);
    sessionStorage.setItem('pkce_verifier', verifier);
    sessionStorage.setItem('pkce_state', state);
    localStorage.setItem('pkce_verifier', verifier); // fallback if sessionStorage is lost on redirect
    localStorage.setItem('pkce_state', state);
    const p = new URLSearchParams({
      client_id: clientId(), response_type: 'code', redirect_uri: redirectUri(),
      scope: SCOPES, code_challenge_method: 'S256', code_challenge: challenge, state
    });
    location.href = AUTH + '?' + p;
  }

  function saveTokens(j) {
    const prev = JSON.parse(localStorage.getItem('tokens') || '{}');
    localStorage.setItem('tokens', JSON.stringify({
      access: j.access_token,
      refresh: j.refresh_token || prev.refresh,
      scope: j.scope || prev.scope,
      expires: Date.now() + (j.expires_in - 60) * 1000
    }));
  }
  const getTokens = () => JSON.parse(localStorage.getItem('tokens') || 'null');

  async function tokenRequest(body) {
    const r = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId(), ...body })
    });
    if (!r.ok) throw new Error('token ' + r.status);
    saveTokens(await r.json());
  }

  async function handleCallback() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return;
    const code = q.get('code'), state = q.get('state'), err = q.get('error');
    history.replaceState(null, '', redirectUri());
    if (err || !code) { showMessage('Login cancelled.'); return; }
    const verifier = sessionStorage.getItem('pkce_verifier') || localStorage.getItem('pkce_verifier');
    const expect = sessionStorage.getItem('pkce_state') || localStorage.getItem('pkce_state');
    ['pkce_verifier', 'pkce_state'].forEach(k => { sessionStorage.removeItem(k); localStorage.removeItem(k); });
    if (!verifier || state !== expect) { showMessage('Login state mismatch. Try again.'); return; }
    try {
      await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier });
    } catch (e) { showMessage('Login failed: ' + e.message); }
  }

  async function accessToken() {
    const t = getTokens();
    if (!t) return null;
    if (Date.now() < t.expires) return t.access;
    if (!t.refresh) return null;
    try {
      await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh });
      return getTokens().access;
    } catch (e) {
      if (/token 4/.test(e.message)) localStorage.removeItem('tokens'); // refresh revoked
      return null;
    }
  }

  function logout() { localStorage.removeItem('tokens'); location.reload(); }

  // --- UI helpers ---
  const msgEl = $('message');
  function showMessage(t) { msgEl.textContent = t || ''; msgEl.hidden = !t; }
  // Which source is active: 'spotify' | 'youtube' | 'audius' | 'files'. Only Spotify uses the poll loop.
  let activeName = localStorage.getItem('source') || 'spotify';
  let spotifyLoggedIn = false;
  function layout() {
    const sp = activeName === 'spotify';
    $('login').hidden = !sp || spotifyLoggedIn;
    $('player').hidden = sp && !spotifyLoggedIn;
  }
  function show(loggedIn) { spotifyLoggedIn = loggedIn; layout(); }

  // --- lyrics engine (shared by every source) ---
  // Source interface: { getPosition() -> ms, isPlaying(), getTrackInfo() -> {id,title,artist,album?,duration(s),art?},
  //   play(), pause(), onTrackChange (set by the engine; sources call it with getTrackInfo()) }
  const S = { id: null, progress: 0, at: 0, playing: false, duration: 0, lines: [], plain: false, idx: -2, offset: 0, info: null };
  let lineEls = [];

  function setTrack(item) { // Spotify track object -> engine
    const img = item.album && item.album.images && (item.album.images[1] || item.album.images[0]);
    engineSetTrack({
      id: item.id, title: item.name, artist: (item.artists || []).map(a => a.name).join(', '),
      album: item.album ? item.album.name : '', art: img ? img.url : '', duration: item.duration_ms / 1000,
      lookupArtist: item.artists && item.artists[0] ? item.artists[0].name : ''
    });
    if (curView === 'browse' && curSec === 'queue') loadQueue();
  }

  const offsetKey = () => (activeName === 'spotify' ? 'offset:default' : 'offset:default:' + activeName);
  function engineSetTrack(info) {
    S.id = info.id; S.info = info;
    $('title').textContent = info.title || '-';
    $('artist').textContent = info.artist || '';
    $('album').textContent = info.album || '';
    $('art').src = info.art || '';
    $('art').hidden = !info.art;
    // Per-song offset if set, else the user's last-used offset for this source. Spotify starts 0.8 s early
    // (its reported position lags and singers need time to read ahead); the exact-clock sources start at 0.
    const saved = localStorage.getItem('offset:' + info.id) ?? localStorage.getItem(offsetKey());
    S.offset = saved !== null && !isNaN(parseFloat(saved)) ? parseFloat(saved) : (activeName === 'spotify' ? 0.8 : 0);
    $('offset').value = S.offset;
    $('offset-val').textContent = fmtOffset(S.offset);
    resetLyricsView();
    showMessage('Looking for lyrics...');
    $('edit-box').hidden = true;
    const ed = activeName === 'spotify' ? null : JSON.parse(localStorage.getItem('edit:' + info.id) || 'null');
    if (ed) { info.lookupArtist = ed.artist; info.title = ed.title; $('title').textContent = ed.title; $('artist').textContent = ed.artist; }
    loadLyrics(info);
  }
  function resetLyricsView() {
    S.lines = []; S.idx = -2; lineEls = []; S.plain = false;
    $('lyrics').textContent = ''; $('lyrics').classList.remove('plain');
  }
  const fmtOffset = v => (v > 0 ? '+' : '') + Number(v).toFixed(1) + ' s';

  async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) return null;
    return r.json();
  }

  async function findLyrics(info) {
    const artist = info.lookupArtist != null ? info.lookupArtist : (info.artist || '');
    const title = info.title || '';
    const dur = Math.round(info.duration || 0);
    if (info.album && dur) { // exact lookup needs album + duration
      const p = new URLSearchParams({ artist_name: artist, track_name: title, album_name: info.album, duration: dur });
      try {
        const g = await fetchJson('https://lrclib.net/api/get?' + p);
        if (g && (g.syncedLyrics || g.plainLyrics)) return g;
      } catch (e) { /* fall through to search */ }
    }
    try {
      const res = await fetchJson('https://lrclib.net/api/search?q=' + encodeURIComponent((artist + ' ' + title).trim()));
      return pickBest(res, dur);
    } catch (e) { return null; }
  }

  async function loadLyrics(info) {
    const id = info.id;
    const hit = await findLyrics(info);
    if (S.id !== id) return; // track changed meanwhile
    const box = $('lyrics');
    const synced = hit && hit.syncedLyrics ? parseLrc(hit.syncedLyrics) : [];
    if (synced.length) {
      showMessage('');
      S.lines = synced; S.plain = false;
      lineEls = synced.map(l => {
        const d = document.createElement('div');
        d.className = 'line'; d.textContent = l.text || '♪';
        box.appendChild(d); return d;
      });
      S.idx = -2;
    } else if (hit && hit.plainLyrics) {
      showMessage('');
      S.plain = true; box.classList.add('plain');
      hit.plainLyrics.split(/\r?\n/).forEach(t => {
        const d = document.createElement('div'); d.className = 'line'; d.textContent = t || ' '; box.appendChild(d);
      });
      const n = document.createElement('div');
      n.className = 'line'; n.style.opacity = '.5'; n.textContent = '(unsynced lyrics)';
      box.prepend(n);
    } else {
      if (activeName === 'spotify') showMessage('No lyrics found for this song. Enjoy the music!');
      else { showMessage('No lyrics found. Check the artist and title below.'); openEdit(); }
    }
  }

  // "Edit artist/title" for non-Spotify sources: fix the lookup text and search again.
  function openEdit() {
    if (activeName === 'spotify' || !S.info) return;
    $('edit-artist').value = S.info.lookupArtist != null ? S.info.lookupArtist : (S.info.artist || '');
    $('edit-title').value = S.info.title || '';
    $('edit-box').hidden = false;
  }
  function applyEdit(e) {
    e.preventDefault();
    if (!S.info) return;
    const artist = $('edit-artist').value.trim(), title = $('edit-title').value.trim();
    if (!title) return;
    localStorage.setItem('edit:' + S.id, JSON.stringify({ artist, title }));
    S.info.lookupArtist = artist; S.info.title = title;
    $('title').textContent = title; $('artist').textContent = artist;
    resetLyricsView();
    showMessage('Looking for lyrics...');
    loadLyrics(S.info);
  }

  function render() {
    requestAnimationFrame(render);
    const src = sources[activeName];
    const playing = src.isPlaying();
    $('state').classList.toggle('playing', playing);
    $('state').innerHTML = playing ? '&#9654;' : '&#10074;&#10074;';
    $('state').setAttribute('aria-label', playing ? 'Playing' : 'Paused');
    if (!S.lines.length || S.plain) return;
    const t = src.getPosition() + S.offset * 1000;
    const i = findLineIndex(S.lines, t);
    if (i === S.idx) return;
    S.idx = i;
    lineEls.forEach((el, k) => {
      el.classList.toggle('current', k === i);
      el.classList.toggle('near', k === i - 1 || k === i + 1);
    });
    const el = lineEls[Math.max(i, 0)];
    const box = $('lyrics');
    box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
  }

  // --- polling ---
  // One loop only: a single timer. pollNow() re-arms that timer, it never starts a second loop.
  let pollTimer = null, inflight = false, pollAgain = false;
  function pollNow(wait) {
    if (activeName !== 'spotify' || !spotifyLoggedIn) return; // polling is paused while another source is active
    if (inflight) { pollAgain = true; return; }
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, Math.max(wait || 0, blockedUntil - Date.now()));
  }

  async function poll() {
    if (activeName !== 'spotify') return;
    let delay = POLL_MS;
    inflight = true;
    try {
      const tok = await accessToken();
      if (!tok) { inflight = false; show(false); return; } // logged out; stop polling
      const sent = performance.now();
      const r = await fetch(API, { headers: { Authorization: 'Bearer ' + tok } });
      const recv = performance.now();
      if (activeName !== 'spotify') { inflight = false; return; } // user switched source while waiting
      if (r.status === 429) {
        const ra = parseFloat(r.headers.get('Retry-After'));
        delay = Math.max(POLL_MS, (isNaN(ra) ? 5 : ra) * 1000 + 250);
        blockedUntil = Date.now() + delay;
        showMessage('Spotify is rate limiting; retrying in ' + Math.ceil(delay / 1000) + ' s');
      } else if (r.status === 401) {
        const t = getTokens(); if (t) { t.expires = 0; localStorage.setItem('tokens', JSON.stringify(t)); }
        delay = 300;
      } else if (r.status === 204) {
        S.playing = false;
        if (!S.id) showMessage('Nothing playing. Start a song in your Spotify app.');
      } else if (r.ok) {
        const j = await r.json();
        if (j && j.item && j.currently_playing_type !== 'ad') {
          if (j.item.id !== S.id) setTrack(j.item);
          else if (msgEl.textContent.startsWith('Spotify is rate')) showMessage('');
          S.progress = j.progress_ms || 0;
          S.at = (sent + recv) / 2; // assume symmetric latency
          S.playing = !!j.is_playing;
          S.duration = j.item.duration_ms;
        } else {
          S.playing = false;
          showMessage(j && j.currently_playing_type === 'ad' ? 'Ad playing...' : 'Nothing playing, or not a song.');
        }
      } else {
        delay = 5000;
      }
    } catch (e) { delay = 5000; } // network hiccup
    inflight = false;
    if (activeName !== 'spotify') return;
    if (pollAgain && Date.now() >= blockedUntil) { pollAgain = false; delay = Math.min(delay, 300); }
    pollAgain = false;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay);
  }

  // --- Spotify API helper (browse + controls) ---
  const needsRelogin = () => { const t = getTokens(); return !!t && !hasScopes(t.scope, SCOPE_LIST); };
  function updateBanner() { $('scope-banner').hidden = activeName !== 'spotify' || !needsRelogin(); }

  async function api(method, path, body, retried) {
    if (needsRelogin()) {
      updateBanner();
      throw Object.assign(new Error('Please log in again to enable Browse and playback controls.'), { status: 403 });
    }
    if (Date.now() < blockedUntil) {
      throw Object.assign(new Error(apiErrorMessage(429)), { status: 429 });
    }
    const tok = await accessToken();
    if (!tok) { show(false); throw Object.assign(new Error(apiErrorMessage(401)), { status: 401 }); }
    const r = await fetch(API_BASE + path, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + tok }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { const txt = await r.text(); json = txt ? JSON.parse(txt) : null; } catch (e) { json = null; }
    if (r.status === 401 && !retried) { // token rejected: force a refresh and retry once
      const t = getTokens(); if (t) { t.expires = 0; localStorage.setItem('tokens', JSON.stringify(t)); }
      return api(method, path, body, true);
    }
    if (r.status === 429) {
      const ra = parseFloat(r.headers.get('Retry-After'));
      blockedUntil = Date.now() + (isNaN(ra) ? 5 : ra) * 1000 + 250;
    }
    if (!r.ok) throw Object.assign(new Error(apiErrorMessage(r.status, json)), { status: r.status });
    return json;
  }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  let toastTimer;
  function toast(text, ms) {
    const t = $('toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 3000);
  }
  /** Run a UI action; failures become a toast (NO_ACTIVE_DEVICE gets the friendly Open-Spotify text). */
  async function act(fn) {
    try { await fn(); } catch (e) { toast(e.message || 'Something went wrong.', 7000); }
  }

  // --- playback actions ---
  function afterPlay() { switchView('lyrics'); pollNow(700); }
  const playTrack = t => act(async () => {
    await api('PUT', '/me/player/play', { uris: [t.uri] });
    toast('Playing ' + t.name); afterPlay();
  });
  const playInContext = (contextUri, t) => act(async () => {
    await api('PUT', '/me/player/play', { context_uri: contextUri, offset: { uri: t.uri } });
    toast('Playing ' + t.name); afterPlay();
  });
  const addToQueue = t => act(async () => {
    await api('POST', '/me/player/queue?uri=' + encodeURIComponent(t.uri));
    toast('Added "' + t.name + '" to queue');
    if (queueLoaded) loadQueue();
  });
  const transport = (kind) => act(async () => {
    if (activeName !== 'spotify') {
      const s = sources[activeName];
      if (kind === 'pp') { if (s.isPlaying()) s.pause(); else s.play(); }
      return;
    }
    if (kind === 'pp') {
      const now = performance.now(); // freeze/resume the local clock right away
      S.progress = interpolate(S.progress, S.at, now, S.playing, S.duration); S.at = now;
      S.playing = !S.playing;
      try { await api('PUT', S.playing ? '/me/player/play' : '/me/player/pause'); }
      catch (e) { pollNow(0); throw e; }
    } else {
      await api('POST', '/me/player/' + kind);
    }
    pollNow(kind === 'pp' ? 400 : 700);
  });

  // --- browse UI ---
  function trackRow(t, withActions, ctxUri) {
    const row = el('div', 'row');
    const img = el('img', 'thumb');
    img.alt = ''; img.width = 48; img.height = 48; img.loading = 'lazy';
    if (t.art) img.src = t.art;
    const txt = el('div', 'rtext');
    txt.append(el('div', 'rtitle', t.name), el('div', 'rartist', t.artists));
    row.append(img, txt);
    if (withActions) {
      const play = el('button', 'act', 'Play');
      play.type = 'button'; play.setAttribute('aria-label', 'Play ' + t.name + ' by ' + t.artists);
      play.addEventListener('click', () => (ctxUri ? playInContext(ctxUri, t) : playTrack(t)));
      const add = el('button', 'act ghost', '+ Queue');
      add.type = 'button'; add.setAttribute('aria-label', 'Add ' + t.name + ' to queue');
      add.addEventListener('click', () => addToQueue(t));
      row.append(play, add);
    }
    return row;
  }
  function fillTracks(box, tracks, withActions, ctxUri, emptyText) {
    box.textContent = '';
    if (!tracks.length) { box.append(el('p', 'note', emptyText || 'Nothing here yet.')); return; }
    tracks.forEach(t => box.append(trackRow(t, withActions, ctxUri)));
  }
  const loading = box => { box.textContent = ''; box.append(el('p', 'note', 'Loading...')); };
  const failed = (box, e) => { box.textContent = ''; box.append(el('p', 'note err', e.message || 'Could not load.')); };

  // search
  async function runSearch() {
    const q = searchQuery($('search-input').value, $('karaoke-toggle').checked);
    const box = $('search-results');
    if (!q) { box.textContent = ''; return; }
    loading(box);
    try {
      const j = await api('GET', '/search?type=track&limit=10&q=' + encodeURIComponent(q));
      const tracks = ((j && j.tracks && j.tracks.items) || []).map(normTrack).filter(Boolean);
      fillTracks(box, tracks, true, null, 'No songs found for "' + q + '".');
    } catch (e) { failed(box, e); }
  }

  // playlists
  let plLoaded = false, curPl = null, plOffset = 0;
  async function loadPlaylists() {
    const box = $('pl-list');
    loading(box);
    try {
      const j = await api('GET', '/me/playlists?limit=50');
      const items = ((j && j.items) || []).filter(p => p && p.uri);
      plLoaded = true;
      box.textContent = '';
      if (!items.length) { box.append(el('p', 'note', 'No playlists found.')); return; }
      items.forEach(p => {
        const imgs = p.images || [];
        const total = p.items ? p.items.total : (p.tracks ? p.tracks.total : null);
        const row = el('button', 'row plrow');
        row.type = 'button';
        const img = el('img', 'thumb'); img.alt = ''; img.width = 48; img.height = 48; img.loading = 'lazy';
        if (imgs.length) img.src = imgs[imgs.length - 1].url;
        const txt = el('div', 'rtext');
        txt.append(el('div', 'rtitle', p.name || '(untitled)'), el('div', 'rartist', total == null ? '' : total + ' tracks'));
        row.append(img, txt, el('span', 'chev', '›'));
        row.addEventListener('click', () => openPlaylist(p));
        box.append(row);
      });
    } catch (e) { failed(box, e); }
  }
  async function playlistPage(id, offset) {
    const qs = '?limit=50&offset=' + offset + '&additional_types=track';
    try { return await api('GET', '/playlists/' + encodeURIComponent(id) + '/items' + qs); }
    catch (e) {
      if (e.status === 404) return api('GET', '/playlists/' + encodeURIComponent(id) + '/tracks' + qs); // older API shape
      throw e;
    }
  }
  async function openPlaylist(p, more) {
    curPl = p;
    $('pl-list-view').hidden = true; $('pl-tracks-view').hidden = false;
    $('pl-title').textContent = p.name || 'Playlist';
    const box = $('pl-items');
    if (!more) { plOffset = 0; loading(box); }
    $('pl-more').hidden = true;
    try {
      const j = await playlistPage(p.id, plOffset);
      const raw = (j && j.items) || [];
      plOffset += raw.length;
      const tracks = raw.map(it => normTrack(it && (it.track || it.item))).filter(Boolean);
      if (!more) box.textContent = '';
      if (!more && !tracks.length) box.append(el('p', 'note', 'No playable songs in this playlist.'));
      tracks.forEach(t => box.append(trackRow(t, true, p.uri)));
      $('pl-more').hidden = !(j && j.next);
    } catch (e) { failed(box, e); }
  }

  // suggestions (top tracks + recently played; /recommendations is closed to new apps)
  let suggestLoaded = false;
  async function loadSuggest() {
    const top = $('top-list'), rec = $('recent-list');
    loading(top); loading(rec);
    suggestLoaded = true;
    await Promise.all([
      api('GET', '/me/top/tracks?time_range=short_term&limit=10').then(j => {
        fillTracks(top, ((j && j.items) || []).map(normTrack).filter(Boolean), true, null, 'No top tracks yet.');
      }).catch(e => failed(top, e)),
      api('GET', '/me/player/recently-played?limit=20').then(j => {
        const list = dedupeTracks(((j && j.items) || []).map(i => normTrack(i && i.track)).filter(Boolean));
        fillTracks(rec, list, true, null, 'Nothing played recently.');
      }).catch(e => failed(rec, e))
    ]);
  }

  // queue
  let queueLoaded = false;
  async function loadQueue() {
    const box = $('queue-list');
    if (!queueLoaded) loading(box);
    try {
      const j = await api('GET', '/me/player/queue');
      queueLoaded = true;
      const list = ((j && j.queue) || []).map(normTrack).filter(Boolean).slice(0, 30);
      fillTracks(box, list, false, null, 'The queue is empty. Add songs from Search.');
    } catch (e) { failed(box, e); }
  }

  let curSec = 'search', curView = 'lyrics';
  function showSec(sec) {
    curSec = sec;
    document.querySelectorAll('.subtab').forEach(b => {
      const on = b.dataset.sec === sec;
      b.classList.toggle('active', on); b.setAttribute('aria-selected', on);
    });
    document.querySelectorAll('.sec').forEach(s => { s.hidden = s.id !== 'sec-' + sec; });
    if (sec === 'playlists' && !plLoaded) loadPlaylists();
    if (sec === 'suggest' && !suggestLoaded) loadSuggest();
    if (sec === 'queue') loadQueue();
  }
  function switchView(v) {
    curView = v;
    const b = v === 'browse', other = activeName !== 'spotify';
    $('lyrics').hidden = b; $('browse').hidden = !b || other; $('browse-other').hidden = !b || !other;
    $('player').classList.toggle('browsing', b);
    document.querySelectorAll('.tab').forEach(t => {
      const on = t.dataset.view === v;
      t.classList.toggle('active', on); t.setAttribute('aria-selected', on);
    });
    if (b && !other) showSec(curSec);
    if (!b) S.idx = -2; // force re-centre of the current line
  }

  function initBrowse() {
    updateBanner();
    $('relogin-btn').addEventListener('click', () => { if (configured()) login(); });
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));
    document.querySelectorAll('.subtab').forEach(t => t.addEventListener('click', () => showSec(t.dataset.sec)));
    $('prev').addEventListener('click', () => transport('previous'));
    $('next').addEventListener('click', () => transport('next'));
    $('pp').addEventListener('click', () => transport('pp'));
    $('search-form').addEventListener('submit', e => { e.preventDefault(); runSearch(); });
    $('karaoke-toggle').addEventListener('change', runSearch);
    $('pl-back').addEventListener('click', () => { $('pl-tracks-view').hidden = true; $('pl-list-view').hidden = false; });
    $('pl-more').addEventListener('click', () => openPlaylist(curPl, true));
    $('queue-refresh').addEventListener('click', loadQueue);
    // other sources
    document.querySelectorAll('.src').forEach(b => b.addEventListener('click', () => setSource(b.dataset.src)));
    $('o-form').addEventListener('submit', e => { e.preventDefault(); runOtherSearch(); });
    $('o-karaoke').addEventListener('change', runOtherSearch);
    $('file-input').addEventListener('change', e => {
      const picked = Array.from(e.target.files || []).filter(f => /\.(mp3|wav)$/i.test(f.name) || /^audio\//.test(f.type));
      if (!picked.length) { toast('Please choose an MP3 or WAV file.', 4000); return; }
      fileList = picked; renderFiles();
      if (picked.length === 1) playFile(0);
    });
    $('edit-box').addEventListener('submit', applyEdit);
    $('edit-link').addEventListener('click', () => { if ($('edit-box').hidden) openEdit(); else $('edit-box').hidden = true; });
  }

  // --- sources ---
  const sources = {};
  const audio = $('audio');
  const mediaNote = text => { const n = $('media-note'); n.textContent = text || ''; n.hidden = !text; };
  const jsonOf = async r => { // public servers sometimes answer 200 with a bot-check HTML page: insist on JSON
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text();
    try { return JSON.parse(txt); } catch (e) { throw new Error('not JSON'); }
  };
  const lastGood = (key, val) => {
    try {
      const m = JSON.parse(localStorage.getItem('lastgood') || '{}');
      if (val === undefined) return m[key];
      m[key] = val; localStorage.setItem('lastgood', JSON.stringify(m));
    } catch (e) { /* ignore */ }
  };
  const afterPick = () => switchView('lyrics');

  sources.spotify = {
    getPosition: () => interpolate(S.progress, S.at, performance.now(), S.playing, S.duration),
    isPlaying: () => S.playing,
    getTrackInfo: () => S.info,
    play: () => api('PUT', '/me/player/play'),
    pause: () => api('PUT', '/me/player/pause'),
    onTrackChange: null,
    deactivate() { clearTimeout(pollTimer); }
  };

  // YouTube: IFrame Player API (no key) for playback and exact time, keyless Piped/Invidious for search
  const yt = { player: null, ready: null, state: -1, cur: null, lastT: 0, lastAt: 0 };
  const ytInfo = v => {
    const c = cleanTitle(v.title, v.channel);
    return { id: 'yt:' + v.id, title: c.title || v.title, artist: c.artist || v.channel, lookupArtist: c.artist,
      duration: v.duration, art: v.thumb };
  };
  function loadYT() {
    if (yt.ready) return yt.ready;
    yt.ready = new Promise((res, rej) => {
      if (window.YT && window.YT.Player) return res();
      window.onYouTubeIframeAPIReady = res;
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { yt.ready = null; rej(new Error('Could not load YouTube. Check your connection.')); };
      document.head.appendChild(s);
    }).then(() => new Promise(res => {
      yt.player = new window.YT.Player('yt-player', {
        width: '100%', height: '100%', host: 'https://www.youtube-nocookie.com',
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
        events: {
          onReady: () => res(),
          onStateChange: e => {
            yt.state = e.data;
            if (e.data === 1 && yt.cur && yt.cur.needMeta) { // pasted link without a known title
              const d = yt.player.getVideoData && yt.player.getVideoData();
              if (d && d.title) { yt.cur.needMeta = false; yt.cur.title = d.title; yt.cur.channel = d.author || ''; yt.cur.duration = yt.player.getDuration() || 0; onTrack(ytInfo(yt.cur)); }
            }
          },
          onError: e => { mediaNote(ytErrorMessage(e.data)); }
        }
      });
    }));
    return yt.ready;
  }
  const onTrack = info => { const s = sources[activeName]; if (s.onTrackChange) s.onTrackChange(info); };
  async function playYT(v) {
    yt.cur = v;
    mediaNote('');
    if (v.needMeta) { // pasted link, title unknown yet: wait for the player to tell us
      S.id = 'yt:' + v.id; S.info = null; resetLyricsView(); showMessage('Loading video...');
    } else onTrack(ytInfo(v));
    afterPick();
    try {
      await loadYT();
      if (yt.cur !== v) return;
      yt.player.loadVideoById(v.id);
    } catch (e) { mediaNote(e.message); }
  }
  async function ytSearch(q) {
    const enc = encodeURIComponent(q);
    const groups = [
      { key: 'piped', list: typeof PIPED_INSTANCES !== 'undefined' ? PIPED_INSTANCES : [],
        ms: (typeof YT_TIMEOUTS !== 'undefined' && YT_TIMEOUTS.piped) || 5000,
        run: async (base, signal) => {
          const j = await jsonOf(await fetch(base + '/search?q=' + enc + '&filter=videos', { signal }));
          if (!j || !Array.isArray(j.items)) throw new Error('unexpected response');
          return normPiped(j);
        } },
      { key: 'invidious', list: typeof INVIDIOUS_INSTANCES !== 'undefined' ? INVIDIOUS_INSTANCES : [],
        ms: (typeof YT_TIMEOUTS !== 'undefined' && YT_TIMEOUTS.invidious) || 8000,
        run: async (base, signal) => {
          const j = await jsonOf(await fetch(base + '/api/v1/search?q=' + enc + '&type=video', { signal }));
          if (!Array.isArray(j)) throw new Error('unexpected response');
          return normInvidious(j);
        } }
    ];
    for (const g of groups) {
      const list = orderInstances(g.list, lastGood(g.key));
      if (!list.length) continue;
      try {
        const { base, result } = await tryInstances(list, g.run, g.ms);
        lastGood(g.key, base);
        return result;
      } catch (e) { /* try the next group */ }
    }
    throw new Error('Search is down. Paste a YouTube link instead.');
  }
  async function playYTLink(id) {
    let meta = null;
    try {
      const url = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id);
      meta = (await tryInstances([url], async (u, signal) => jsonOf(await fetch(u, { signal })), 4000)).result;
    } catch (e) { /* the player will tell us the title once it starts */ }
    return playYT({ id, title: (meta && meta.title) || '', channel: (meta && meta.author_name) || '', duration: 0,
      thumb: ytThumb(id), needMeta: !(meta && meta.title) });
  }
  sources.youtube = {
    getPosition() {
      const p = yt.player;
      const t = p && p.getCurrentTime ? p.getCurrentTime() : 0;
      const now = performance.now();
      if (t !== yt.lastT) { yt.lastT = t; yt.lastAt = now; }
      // the iframe reports time in ~250 ms steps: smooth between steps, never more than one step
      return t * 1000 + (yt.state === 1 ? Math.min(now - yt.lastAt, 250) : 0);
    },
    isPlaying: () => yt.state === 1 || yt.state === 3,
    getTrackInfo: () => S.info,
    play() { if (yt.player && yt.player.playVideo) yt.player.playVideo(); },
    pause() { if (yt.player && yt.player.pauseVideo) yt.player.pauseVideo(); },
    onTrackChange: null,
    deactivate() { if (yt.player && yt.player.pauseVideo) yt.player.pauseVideo(); yt.cur = null; yt.state = -1; },
    placeholder: 'Search, or paste a YouTube link',
    hint: 'Search for a karaoke video, or paste a YouTube link.',
    async search(raw, karaoke) {
      const id = parseYouTubeId(raw);
      if (id) { await playYTLink(id); return null; }
      const vids = await ytSearch(searchQuery(raw, karaoke));
      return vids.map(v => ({ art: v.thumb, title: v.title, sub: v.channel + (v.duration ? ' · ' + fmtDur(v.duration) : ''), play: () => playYT(v) }));
    }
  };
  const fmtDur = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

  // Audius + My files share one <audio> element
  const audioSource = extra => Object.assign({
    getPosition: () => audio.currentTime * 1000,
    isPlaying: () => !audio.paused && !audio.ended,
    getTrackInfo: () => S.info,
    play() { audio.play().catch(() => mediaNote('Tap play on the player to start.')); },
    pause() { audio.pause(); },
    onTrackChange: null,
    deactivate() { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  }, extra);

  let audiusHosts = null;
  async function audiusSearch(q) {
    if (!audiusHosts) {
      const { result } = await tryInstances(['https://api.audius.co'], async (u, signal) => {
        const j = await jsonOf(await fetch(u, { signal }));
        if (!j || !Array.isArray(j.data) || !j.data.length) throw new Error('no hosts');
        return j.data;
      }, 4000);
      audiusHosts = result;
    }
    try {
      const { base, result } = await tryInstances(orderInstances(audiusHosts, lastGood('audius')), async (host, signal) => {
        const j = await jsonOf(await fetch(host + '/v1/tracks/search?query=' + encodeURIComponent(q) + '&app_name=spotify-karaoke', { signal }));
        if (!j || !Array.isArray(j.data)) throw new Error('unexpected response');
        return j;
      }, 5000);
      lastGood('audius', base);
      return normAudius(result).map(t => Object.assign(t, { host: base }));
    } catch (e) { throw new Error('Audius search is not responding. Try again in a moment.'); }
  }
  function playAudius(t) {
    mediaNote('');
    const c = cleanTitle(t.title, t.artist);
    const info = { id: 'au:' + t.id, title: c.title || t.title, artist: c.artist || t.artist, lookupArtist: c.artist || t.artist,
      duration: t.duration, art: t.art };
    onTrack(info);
    audio.src = t.host + '/v1/tracks/' + encodeURIComponent(t.id) + '/stream?app_name=spotify-karaoke';
    audio.play().catch(() => mediaNote('Tap play on the player to start.'));
    afterPick();
  }
  sources.audius = audioSource({
    placeholder: 'Search Audius tracks',
    hint: 'Search free music on Audius. Karaoke or instrumental tracks work best.',
    async search(raw, karaoke) {
      const tracks = await audiusSearch(searchQuery(raw, karaoke));
      return tracks.map(t => ({ art: t.art, title: t.title, sub: t.artist + (t.duration ? ' · ' + fmtDur(t.duration) : ''), play: () => playAudius(t) }));
    }
  });

  let fileList = [], fileIdx = -1, fileUrl = null;
  function playFile(i) {
    const f = fileList[i];
    if (!f) return;
    fileIdx = i; mediaNote('');
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = URL.createObjectURL(f);
    const c = cleanTitle(f.name);
    S.pending = { id: 'file:' + f.name + ':' + f.size, title: c.title || f.name, artist: c.artist, lookupArtist: c.artist, duration: 0, art: '' };
    audio.src = fileUrl;
    audio.play().catch(() => { /* user can press play on the player */ });
    afterPick();
  }
  sources.files = audioSource({
    placeholder: '',
    hint: 'Choose MP3 or WAV files from this device. Nothing is uploaded. Names like "Artist - Title.mp3" give the lyrics lookup.',
    deactivate() { audio.pause(); audio.removeAttribute('src'); audio.load(); if (fileUrl) { URL.revokeObjectURL(fileUrl); fileUrl = null; } },
    search: null
  });
  audio.addEventListener('loadedmetadata', () => { // duration known: now look up lyrics (files only)
    if (activeName === 'files' && S.pending) {
      const info = S.pending; S.pending = null;
      info.duration = isFinite(audio.duration) ? audio.duration : 0;
      onTrack(info);
    }
  });
  audio.addEventListener('ended', () => { if (activeName === 'files' && fileIdx + 1 < fileList.length) playFile(fileIdx + 1); });
  audio.addEventListener('error', () => {
    if (!audio.getAttribute('src') || (activeName !== 'files' && activeName !== 'audius')) return;
    mediaNote(activeName === 'files' ? 'This file could not be played. Try an MP3 or WAV.' : 'This track could not be streamed. Pick another.');
  });

  function mediaRow(r) {
    const row = el('div', 'row');
    const img = el('img', 'thumb'); img.alt = ''; img.width = 48; img.height = 48; img.loading = 'lazy';
    if (r.art) img.src = r.art;
    const txt = el('div', 'rtext');
    txt.append(el('div', 'rtitle', r.title), el('div', 'rartist', r.sub || ''));
    const play = el('button', 'act', 'Play');
    play.type = 'button'; play.setAttribute('aria-label', 'Play ' + r.title);
    play.addEventListener('click', () => r.play());
    row.append(img, txt, play);
    return row;
  }
  async function runOtherSearch() {
    const src = sources[activeName];
    const raw = $('o-input').value.trim();
    if (!src.search || !raw) return;
    const box = $('o-results');
    loading(box);
    try {
      const rows = await src.search(raw, $('o-karaoke').checked);
      box.textContent = '';
      if (rows && !rows.length) box.append(el('p', 'note', 'No songs found.'));
      (rows || []).forEach(r => box.append(mediaRow(r)));
    } catch (e) { failed(box, e); }
  }
  function renderFiles() {
    const box = $('o-results');
    box.textContent = '';
    fileList.forEach((f, i) => box.append(mediaRow({ art: '', title: f.name, sub: Math.round(f.size / 1024 / 1024 * 10) / 10 + ' MB', play: () => playFile(i) })));
  }

  const SRC_NAMES = ['spotify', 'youtube', 'audius', 'files'];
  function setSource(name) {
    if (!sources[name]) name = 'spotify';
    const prev = sources[activeName];
    if (prev && prev !== sources[name] && prev.deactivate) prev.deactivate();
    activeName = name;
    localStorage.setItem('source', name);
    const src = sources[name], other = name !== 'spotify';
    src.onTrackChange = engineSetTrack;
    S.id = null; S.info = null; S.pending = null; S.playing = false; S.progress = 0;
    resetLyricsView();
    ['title', 'artist', 'album'].forEach(k => { $(k).textContent = k === 'title' ? '-' : ''; });
    $('art').removeAttribute('src'); $('art').hidden = true;
    $('edit-box').hidden = true; mediaNote('');
    document.querySelectorAll('.src').forEach(b => {
      const on = b.dataset.src === name; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on);
    });
    $('yt-wrap').hidden = name !== 'youtube';
    audio.hidden = !(name === 'audius' || name === 'files');
    $('prev').hidden = $('next').hidden = other;
    $('logout-btn').hidden = other; $('edit-link').hidden = !other;
    $('o-form').hidden = !src.search;
    $('o-file-row').hidden = name !== 'files';
    $('o-karaoke-label').hidden = !src.search;
    $('o-input').placeholder = src.placeholder || '';
    $('o-results').textContent = '';
    $('o-hint').textContent = src.hint || '';
    if (name === 'files') renderFiles();
    layout(); updateBanner();
    if (other) {
      showMessage('Pick a song from Browse.');
      switchView('browse');
    } else {
      showMessage('');
      switchView('lyrics');
      pollNow(0); // resume Spotify polling
    }
  }

  // --- wake lock + fullscreen ---
  let wl = null;
  async function wake() {
    try { if ('wakeLock' in navigator && !wl) { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); } }
    catch (e) { wl = null; }
  }

  function init() {
    const logged = !!getTokens();
    show(logged);
    $('config-warn').hidden = configured();
    $('login-btn').addEventListener('click', () => { if (configured()) login(); else $('config-warn').hidden = false; });
    $('logout-btn').addEventListener('click', logout);
    $('offset').addEventListener('input', e => {
      S.offset = parseFloat(e.target.value);
      $('offset-val').textContent = fmtOffset(S.offset);
      if (S.id) localStorage.setItem('offset:' + S.id, S.offset);
      localStorage.setItem(offsetKey(), S.offset); // new songs start from this (per source)
      S.idx = -2;
    });
    const fs = $('fs-btn');
    if (!document.documentElement.requestFullscreen) fs.hidden = true;
    fs.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
    document.addEventListener('click', wake, { once: true });
    wake();
    initBrowse();
    requestAnimationFrame(render);
    setSource(SRC_NAMES.includes(activeName) ? activeName : 'spotify'); // Spotify polling starts here when logged in
  }

  (async function main() {
    await handleCallback();
    init();
  })();
})();
