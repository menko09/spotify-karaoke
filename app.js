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
  module.exports = { parseLrc, findLineIndex, interpolate, pickBest, SCOPE_LIST, hasScopes, searchQuery, normTrack, dedupeTracks, apiErrorMessage };
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
    // Per-song offset if set, else the user's last-used offset, else a 0.8 s lead
    // (Spotify's reported position runs a bit behind and singers need time to read ahead).
    const saved = localStorage.getItem('offset:' + item.id) ?? localStorage.getItem('offset:default');
    S.offset = saved !== null && !isNaN(parseFloat(saved)) ? parseFloat(saved) : 0.8;
    $('offset').value = S.offset;
    $('offset-val').textContent = fmtOffset(S.offset);
    S.lines = []; S.idx = -2; lineEls = [];
    $('lyrics').textContent = ''; $('lyrics').classList.remove('plain');
    showMessage('Looking for lyrics...');
    loadLyrics(item);
    if (curView === 'browse' && curSec === 'queue') loadQueue();
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
  // One loop only: a single timer. pollNow() re-arms that timer, it never starts a second loop.
  let pollTimer = null, inflight = false, pollAgain = false;
  function pollNow(wait) {
    if (inflight) { pollAgain = true; return; }
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, Math.max(wait || 0, blockedUntil - Date.now()));
  }

  async function poll() {
    let delay = POLL_MS;
    inflight = true;
    try {
      const tok = await accessToken();
      if (!tok) { inflight = false; show(false); return; } // logged out; stop polling
      const sent = performance.now();
      const r = await fetch(API, { headers: { Authorization: 'Bearer ' + tok } });
      const recv = performance.now();
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
    if (pollAgain && Date.now() >= blockedUntil) { pollAgain = false; delay = Math.min(delay, 300); }
    pollAgain = false;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay);
  }

  // --- Spotify API helper (browse + controls) ---
  const needsRelogin = () => { const t = getTokens(); return !!t && !hasScopes(t.scope, SCOPE_LIST); };
  function updateBanner() { $('scope-banner').hidden = !needsRelogin(); }

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
    const b = v === 'browse';
    $('lyrics').hidden = b; $('browse').hidden = !b;
    $('player').classList.toggle('browsing', b);
    document.querySelectorAll('.tab').forEach(t => {
      const on = t.dataset.view === v;
      t.classList.toggle('active', on); t.setAttribute('aria-selected', on);
    });
    if (b) showSec(curSec); else S.idx = -2; // force re-centre of the current line
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
      localStorage.setItem('offset:default', S.offset); // new songs start from this
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
    if (logged) { initBrowse(); requestAnimationFrame(render); poll(); }
  }

  (async function main() {
    await handleCallback();
    init();
  })();
})();
