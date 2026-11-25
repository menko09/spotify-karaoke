// Paste your Spotify app Client ID here (not a secret; PKCE needs no client secret).
var CLIENT_ID = 'a5b0ce0a98bf442f9b9b54ffb65a3899';

// Free, keyless YouTube search servers (public Piped / Invidious instances), tried in order:
// all Piped first, then all Invidious. Public instances come and go: edit these lists when one dies.
// Verified working 2026-11: the two below. Dead/blocked: pipedapi.kavin.rocks, inv.nadeko.net, yewtu.be.
var PIPED_INSTANCES = ['https://api.piped.private.coffee'];
var INVIDIOUS_INSTANCES = ['https://yt.chocolatemoo53.com'];
// Per-attempt timeouts in ms (Invidious answers in ~6 s, Piped in ~3 s).
var YT_TIMEOUTS = { piped: 5000, invidious: 8000 };
