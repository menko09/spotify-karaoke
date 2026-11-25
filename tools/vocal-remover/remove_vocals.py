"""Remove vocals from audio files with Demucs (CPU). Writes <name>_instrumental.mp3 next to each input."""
import os, sys, shutil, subprocess, tempfile

MODEL = "htdemucs"

def ffmpeg_exe():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()

def process(src):
    base = os.path.splitext(os.path.basename(src))[0]
    out_mp3 = os.path.join(os.path.dirname(os.path.abspath(src)), base + "_instrumental.mp3")
    ff = ffmpeg_exe()
    with tempfile.TemporaryDirectory() as tmp:
        # Demucs' loader needs ffmpeg on PATH for mp3 input; add ours.
        env = dict(os.environ)
        env["PATH"] = os.path.dirname(ff) + os.pathsep + env["PATH"]
        wav_in = os.path.join(tmp, "in.wav")
        subprocess.run([ff, "-y", "-loglevel", "error", "-i", src, "-ar", "44100", "-ac", "2", wav_in], check=True)
        subprocess.run([sys.executable, "-m", "demucs", "--two-stems=vocals", "-n", MODEL, "-d", "cpu",
                        "-j", "1", "-o", tmp, wav_in], check=True, env=env)
        stem = os.path.join(tmp, MODEL, "in", "no_vocals.wav")
        subprocess.run([ff, "-y", "-loglevel", "error", "-i", stem, "-codec:a", "libmp3lame", "-q:a", "2", out_mp3], check=True)
    print("Wrote", out_mp3)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: remove_vocals.py file1 [file2 ...]"); sys.exit(1)
    bad = 0
    for f in sys.argv[1:]:
        try:
            process(f)
        except Exception as e:
            bad += 1; print("FAILED", f, e)
    sys.exit(1 if bad else 0)
