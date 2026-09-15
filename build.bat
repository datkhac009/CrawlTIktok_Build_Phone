@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
setlocal enabledelayedexpansion

set "RELEASE=..\Crawl_Data_Tiktok_Phone_release"

REM ============================================================================
REM  BUILD TikTok Phone Crawler  ->  .exe
REM
REM  REPO PHAT HANH: dat qua bien moi truong RELEASE_REPO, KHONG co gia tri mac dinh.
REM    set RELEASE_REPO=owner/repo ^& build.bat
REM
REM  VI SAO KHONG CO MAC DINH: ban PC tung bi doi nham hang phat hanh mot lan va cat dut
REM  duong cap nhat cua moi may da trien khai - phai cai lai bang tay tung may. O day co
REM  them mot rui ro nua: ban phone va ban PC la HAI app khac nhau. Neu ban phone lo phat
REM  hanh len repo cua ban PC thi cac may PC se tu tai ban phone ve va tu cap nhat sang
REM  nham app. Nen: khong set thi CHI build ra .exe, khong phat hanh gi ca.
REM ============================================================================

REM --- Chan tuyet doi: khong bao gio phat hanh len repo cua ban PC ---
set "PC_REPO=Hung13010/Crawl_DataTiktok-releases"
if /i "%RELEASE_REPO%"=="%PC_REPO%" (
  echo [DUNG] RELEASE_REPO dang tro toi repo cua ban PC: %PC_REPO%
  echo        Ban phone PHAI dung repo rieng, neu khong may PC se tu cap nhat nham app.
  pause
  exit /b 1
)

echo ============================================
echo   BUILD TikTok Phone Crawler  -^>  .exe
echo   Output: %RELEASE%
if defined RELEASE_REPO echo   Phat hanh: %RELEASE_REPO%
if not defined RELEASE_REPO echo   Phat hanh: KHONG - chi build .exe tai cho
echo ============================================
echo.

REM --- Kiem tra Node ---
where node >nul 2>nul
if errorlevel 1 (
  echo [LOI] Khong tim thay Node.js trong PATH. Hay cai Node.js roi chay lai.
  pause
  exit /b 1
)

REM --- Cai dependencies neu chua co ---
if not exist "node_modules\electron-builder" (
  echo [1/5] Cai dependencies...
  call npm install
  if errorlevel 1 ( echo [LOI] npm install that bai. & pause & exit /b 1 )
) else (
  echo [1/5] Dependencies da co, bo qua npm install.
)

REM --- Phep thu phai xanh TRUOC khi build ---
REM Build ra mot ban .exe da hong roi moi phat hien la mat ca luot. Chay truoc, re hon nhieu.
echo.
echo [2/5] Chay phep thu...
call node tests\run-all.cjs
if errorlevel 1 ( echo [LOI] Phep thu do - dung build. & pause & exit /b 1 )

REM --- Tang so phien ban ---
echo.
echo [3/5] Tang so phien ban...
for /f %%v in ('node version-bump.cjs') do set "VERSION=%%v"
if "%VERSION%"=="" ( echo [LOI] Khong doc duoc version moi. & pause & exit /b 1 )
echo     v%VERSION%

REM --- Build portable exe ---
echo.
echo [4/5] Dang build electron-builder portable x64...
call "node_modules\.bin\electron-builder.cmd" --win portable --x64
if errorlevel 1 ( echo [LOI] Build that bai. & pause & exit /b 1 )

REM --- Copy platform-tools neu co ---
REM KHONG con copy *.py nua: tu 2026-09-15 chung di THEO ban build qua "extraResources" trong
REM package.json. Ly do: ban cu de .py nam roi canh .exe, nen cap nhat app ma quen chep lai .py
REM la nua JS moi noi chuyen voi nua Python cu - KHONG bao loi, khong canh bao, chi la tinh nang
REM moi lang le khong chay. Loi kieu do rat kho tim.
echo.
echo [5/5] Copy platform-tools ra thu muc release neu co...
if not exist "%RELEASE%" mkdir "%RELEASE%"
if exist "platform-tools\adb.exe" robocopy "platform-tools" "%RELEASE%\platform-tools" /E /NFL /NDL /NJH /NJS /NP >nul
if exist "platform-tools\adb.exe" echo     da chep platform-tools.
if not exist "platform-tools\adb.exe" echo     [BO QUA] khong co platform-tools trong thu muc nguon.
if not exist "platform-tools\adb.exe" echo     App se tu dung adb cua xiaowei tai D:\xiaowei_android\tools\adb.exe

REM --- Phat hanh len GitHub, chi khi da chi dinh repo ---
if not defined RELEASE_REPO goto :xong
echo.
echo [+] Phat hanh v%VERSION% len %RELEASE_REPO% ...
where gh >nul 2>nul
if errorlevel 1 (
  echo [CANH BAO] Khong co gh CLI - bo qua buoc phat hanh. File .exe van nam o %RELEASE%
  goto :xong
)
call gh release create v%VERSION% "%RELEASE%\Crawl_DataTiktok_Phone.exe" -R %RELEASE_REPO% --title "v%VERSION%" --notes "TikTok Phone Crawler v%VERSION%"
if errorlevel 1 (
  echo [CANH BAO] Phat hanh that bai - thuong la do token gh het han.
  echo            Chay: gh auth login   hoac dat GH_TOKEN roi chay lai.
  echo            File .exe van nam o %RELEASE%
)

:xong
echo.
echo ============================================
echo   XONG! File .exe o: %RELEASE%
echo.
echo   LUU Y khi chay tren may khac:
echo    - Can Python 3 va thu vien uiautomator2.
echo      Trong app bam nut Kiem tra - no in ra dung cau lenh can go.
echo    - adb.exe: app tu tim theo thu tu  ADB_PATH  ^>  platform-tools canh .exe
echo      ^>  D:\xiaowei_android\tools\adb.exe
echo    - KHONG can chep *.py nua, chung nam san trong ban build.
echo ============================================
pause
endlocal
