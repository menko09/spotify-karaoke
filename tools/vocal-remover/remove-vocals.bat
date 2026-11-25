@echo off
rem Drop one or more MP3/WAV files on this file, or run: remove-vocals.bat song.mp3
cd /d "%~dp0"
if not exist venv\Scripts\python.exe (echo Run setup.bat first. & pause & exit /b 1)
if "%~1"=="" (echo Drag an MP3/WAV onto this file, or pass it as an argument. & pause & exit /b 1)
:next
if "%~1"=="" goto done
echo Processing "%~1" - this takes a few minutes per song on CPU...
venv\Scripts\python.exe "%~dp0remove_vocals.py" "%~f1"
shift
goto next
:done
pause
