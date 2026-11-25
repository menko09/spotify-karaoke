"""Time and peak-RAM benchmark: python benchmark.py <audio> <model>"""
import subprocess, sys, time, psutil, os
here = os.path.dirname(os.path.abspath(__file__))
cmd = [sys.executable, "-m", "demucs", "--two-stems=vocals", "-n", sys.argv[2], "-d", "cpu",
       "-o", os.path.join(here, "bench_out"), sys.argv[1]]
t = time.time(); p = subprocess.Popen(cmd); peak = 0
ps = psutil.Process(p.pid)
while p.poll() is None:
    try:
        rss = ps.memory_info().rss + sum(c.memory_info().rss for c in ps.children(recursive=True))
        peak = max(peak, rss)
    except psutil.Error: pass
    time.sleep(0.2)
print(f"model={sys.argv[2]} rc={p.returncode} time={time.time()-t:.1f}s peakRAM={peak/2**20:.0f}MB")
