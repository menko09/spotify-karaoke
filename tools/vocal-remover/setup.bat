@echo off
rem One-time setup: creates venv with CPU-only PyTorch + Demucs. Needs Python 3.10-3.12 (py launcher).
cd /d "%~dp0"
if exist venv\Scripts\python.exe goto have
py -3.10 -m venv venv
if errorlevel 1 py -3 -m venv venv
if errorlevel 1 (echo Python 3.10+ not found. Install it from python.org & pause & exit /b 1)
:have
venv\Scripts\python.exe -m pip install --upgrade pip
venv\Scripts\python.exe -m pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu
venv\Scripts\python.exe -m pip install demucs imageio-ffmpeg soundfile
if errorlevel 1 (echo Setup failed & pause & exit /b 1)
echo Setup done. Drop an MP3/WAV on remove-vocals.bat.
pause
