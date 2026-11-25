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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseLrc, findLineIndex, interpolate, pickBest };
}

// ---------- browser app ----------
if (typeof document !== 'undefined') (function () {
  const $ = id => document.getElementById(id);
  const SCOPES = 'user-read-currently-playing user-read-playback-state';
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
  function show(loggedIn) { $('login').hidden = loggedIn; $('player').hidden = !loggedIn; }

  // --- playback state ---
  const S = { id: null, progress: 0, at: 0, playing: false, duration: 0, lines: [], plain: false, idx: -2, offset: 0 };
  let lineEls = [];

  function setTrack(item) {
    S.id = item.id;
    $('title').textContent = item.name;
    $('artist').textContent = (item.artists || []).map(a => a.name).join(', ');
    $('album').textContent = item.album ? item.album.name : '';
    const img = item.album && item.album.images && (item.album.images[1] || item.album.images[0]);
    $('art').src = img ? img.url : '';
    S.offset = parseFloat(localStorage.getItem('offset:' + item.id) || '0') || 0;
    $('offset').value = S.offset;
    $('offset-val').textContent = fmtOffset(S.offset);
    S.lines = []; S.idx = -2; lineEls = [];
    $('lyrics').textContent = ''; $('lyrics').classList.remove('plain');
    showMessage('Looking for lyrics...');
    loadLyrics(item);
  }
  const fmtOffset = v => (v > 0 ? '+' : '') + Number(v).toFixed(1) + ' s';

  async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) return null;
    return r.json();
  }

  async function findLyrics(item) {
    const artist = item.artists && item.artists[0] ? item.artists[0].name : '';
    const dur = Math.round(item.duration_ms / 1000);
    const p = new URLSearchParams({ artist_name: artist, track_name: item.name,
      album_name: item.album ? item.album.name : '', duration: dur });
    try {
      const g = await fetchJson('https://lrclib.net/api/get?' + p);
      if (g && (g.syncedLyrics || g.plainLyrics)) return g;
    } catch (e) { /* fall through to search */ }
    try {
      const res = await fetchJson('https://lrclib.net/api/search?q=' + encodeURIComponent(artist + ' ' + item.name));
      return pickBest(res, dur);
    } catch (e) { return null; }
  }

  async function loadLyrics(item) {
    const id = item.id;
    const hit = await findLyrics(item);
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
      showMessage('No lyrics found for this song. Enjoy the music!');
    }
  }

  function render() {
    requestAnimationFrame(render);
    $('state').classList.toggle('playing', S.playing);
    $('state').innerHTML = S.playing ? '&#9654;' : '&#10074;&#10074;';
    $('state').setAttribute('aria-label', S.playing ? 'Playing' : 'Paused');
    if (!S.lines.length || S.plain) return;
    const t = interpolate(S.progress, S.at, performance.now(), S.playing, S.duration) + S.offset * 1000;
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
  async function poll() {
    let delay = POLL_MS;
    try {
      const tok = await accessToken();
      if (!tok) { show(false); return; } // logged out; stop polling
      const sent = performance.now();
      const r = await fetch(API, { headers: { Authorization: 'Bearer ' + tok } });
      const recv = performance.now();
      if (r.status === 429) {
        const ra = parseFloat(r.headers.get('Retry-After'));
        delay = Math.max(POLL_MS, (isNaN(ra) ? 5 : ra) * 1000 + 250);
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
    setTimeout(poll, delay);
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
    if (!logged) {
      $('config-warn').hidden = configured();
      $('login-btn').addEventListener('click', () => { if (configured()) login(); else $('config-warn').hidden = false; });
    }
    $('logout-btn').addEventListener('click', logout);
    $('offset').addEventListener('input', e => {
      S.offset = parseFloat(e.target.value);
      $('offset-val').textContent = fmtOffset(S.offset);
      if (S.id) localStorage.setItem('offset:' + S.id, S.offset);
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
    if (logged) { requestAnimationFrame(render); poll(); }
  }

  (async function main() {
    await handleCallback();
    init();
  })();
})();
