# Local vocal remover (goal gca5c04)

Removes vocals from your own MP3/WAV files and writes `<name>_instrumental.mp3` next to the original.
Uses Demucs (MIT) `htdemucs`, two-stems mode, CPU only. Nothing is uploaded.

## Setup (once, needs internet, about 1 GB download)
1. Install Python 3.10 to 3.12 if missing.
2. Double-click `setup.bat`. It makes a `venv` folder with CPU-only PyTorch, Demucs and ffmpeg (imageio-ffmpeg; a system ffmpeg is used if present).
3. The first run downloads the model (about 80 MB).

## Use
- Drag an MP3/WAV (or several) onto `remove-vocals.bat`, or run `remove-vocals.bat "C:\music\song.mp3"`.
- Result: `C:\music\song_instrumental.mp3`.

## Notes and limits
- Speed on an i3 laptop: about 3 minutes of processing per minute of audio (a 4-minute song takes roughly 12 minutes).
- Peak RAM about 1.4 GB, so 8 GB is fine. Close heavy apps for speed.
- Progress bars write to stderr; PowerShell 5.1 may report an error even on success. Check for the output file.
- Quality: some vocal "ghosting" or lost bass/drum punch is normal. mdx_extra_q was tested and rejected: about 2.5x more RAM and slower.
- Only use it on music you have the right to use. `benchmark.py` and `samples/` are test helpers and can be deleted.
