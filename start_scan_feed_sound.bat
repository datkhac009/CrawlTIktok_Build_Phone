@echo off
chcp 65001 >nul
cd /d "%~dp0"

set DEVICE=192.168.5.104:5555

echo ============================================
echo   SCAN FEED TIKTOK -^> LAY LINK SOUND DAT
echo ============================================
echo.
echo DIEU KIEN BAT BUOC:
echo   1. DA DONG app GenFarmer tren PC.
echo   2. May %DEVICE% dang mo TikTok, dung o feed For You (da dang nhap).
echo.
echo - Dieu kien DAT: Original Sound va 1000 ^< so post ^< 100000
echo - Ket qua ghi vao sound_links.txt (link TAB so_post)
echo - Dung: Ctrl+C hoac dong cua so nay
echo.

python scan_feed_sounds.py %DEVICE%

echo.
echo === Da dung. ===
pause
