# Spotify Karaoke

Play music in your normal Spotify app (phone or laptop, Premium). Open this page and it shows synced karaoke lyrics from LRCLIB for whatever is playing. Static site: `index.html`, `app.js`, `style.css`, `config.js`. No build, no server, no secrets.

## Setup

1. Go to https://developer.spotify.com/dashboard and log in.
2. Click **Create app**. Any name and description. Tick **Web API**.
3. In the app's settings, add **both** Redirect URIs (exactly, including the trailing slash) and save:
   - `http://127.0.0.1:8000/`
   - `https://menko09.github.io/spotify-karaoke/`
4. Copy the app's **Client ID** and paste it into `config.js`:
   ```js
   var CLIENT_ID = 'your-client-id-here';
   ```
   (The Client ID is public with PKCE. Never use the Client Secret here.)
5. Run locally:
   ```
   python -m http.server 8000 --bind 127.0.0.1
   ```
   then open http://127.0.0.1:8000/ (not `localhost`, Spotify rejects it) and click **Log in with Spotify**.
6. For GitHub Pages, push the folder and enable Pages; use https://menko09.github.io/spotify-karaoke/.

New Spotify apps are in Development mode: only your own account (and users you add under User Management) can log in.

## Using it

- Start a song in Spotify. The page polls every 2 s and keeps time locally in between.
- Timing slider (-3 to +3 s) shifts lyrics earlier/later; saved per track.
- The fullscreen button is for TV/party use (not available on iPhone Safari). The screen is kept awake where the Wake Lock API exists.

## Test

`node test.js` checks the LRC parser, line lookup and progress interpolation.

## Limits

- Lyrics come from LRCLIB; coverage varies. Unsynced lyrics are shown as plain scrolling text, no highlight.
- Spotify's progress is only as fresh as the last poll; use the slider if a device lags (Bluetooth speakers, etc.).
- Wake Lock needs HTTPS or 127.0.0.1 and a user gesture on some browsers.
