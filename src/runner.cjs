// src/runner.cjs — Thay cho browser.cjs + crawler.cjs của bản gốc.
// Mỗi thiết bị chạy = 1 tiến trình con `python scan_feed_sounds.py <serial>`.
'use strict';

const readline = require('readline');
const { spawn, execFile } = require('child_process');
const { getBaseDir, getPythonScriptPath } = require('./paths.cjs');
const { adbPath } = require('./adbpath.cjs');
const { findPython } = require('./pythonpath.cjs');

const SCRIPT_PATH = getPythonScriptPath();
const TIKTOK_PKGS = ['com.zhiliaoapp.musically', 'com.ss.android.ugc.trill'];
const _active = new Map(); // deviceId -> { proc, serial }

// Dong app TikTok tren may + dua ve man hinh chinh (goi qua adb, khong dung uiautomator2
// vi luc nay tien trinh python da bi kill).
function cleanupDevice(serial) {
  if (!serial) return;
  const ADB_PATH = adbPath();
  if (!ADB_PATH) return;   // không có adb thì không dọn được; im lặng ở đây là đúng (đang tắt máy)
  TIKTOK_PKGS.forEach((pkg) => {
    execFile(ADB_PATH, ['-s', serial, 'shell', 'am', 'force-stop', pkg], { timeout: 8000 }, () => {});
  });
  execFile(ADB_PATH, ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_HOME'], { timeout: 8000 }, () => {});
}

function runningIds() {
  return Array.from(_active.keys());
}

function isRunning(deviceId) {
  return _active.has(deviceId);
}

function startDevice(params, onData, onStatus) {
  const { deviceId, serial, minPosts, maxPosts, dwellMin, dwellMax, originalOnly, limit } = params;
  if (_active.has(deviceId)) {
    throw new Error('Thiết bị này đang chạy rồi.');
  }

  // Kiểm TRƯỚC khi spawn, và ném ra câu người đọc hiểu được. Bản cũ `spawn('python', ...)` với
  // python 3.14 trong PATH thì tiến trình chết ngay vì thiếu uiautomator2, và tất cả những gì
  // giao diện nhận được là `exit code 1` → một chữ "Lỗi". Mất cả buổi mới ra nguyên nhân.
  const py = findPython();
  if (!py) {
    throw new Error('Không tìm thấy Python. Bấm 🔌 Kiểm tra để xem hướng dẫn cài.');
  }
  if (!py.hasU2) {
    throw new Error(`Python ${py.version.text} chưa có thư viện uiautomator2. Bấm 🔌 Kiểm tra để xem lệnh cài.`);
  }
  const ADB_PATH = adbPath();
  if (!ADB_PATH) {
    throw new Error('Không tìm thấy adb.exe. Bấm 🔌 Kiểm tra để xem cách khắc phục.');
  }

  const env = Object.assign({}, process.env, {
    GUI_MODE: '1',
    MIN_POSTS: String(minPosts ?? 1000),
    MAX_POSTS: String(maxPosts ?? 100000),
    DWELL_MIN: String(dwellMin ?? 3.0),
    DWELL_MAX: String(dwellMax ?? 6.0),
    ORIGINAL_ONLY: originalOnly === false ? '0' : '1',
    LIMIT: String(limit || 0),
    PYTHONIOENCODING: 'utf-8',
    // Phía Python dùng ĐÚNG adb mà phía Node đã chọn. Hai bên tự dò riêng là có ngày mỗi bên
    // một binary khác phiên bản, và chúng sẽ thay nhau giết adb server của nhau.
    ADB_PATH,
  });

  const proc = spawn(py.cmd, [...py.args, SCRIPT_PATH, serial], {
    cwd: getBaseDir(),
    env,
    windowsHide: true,
  });

  // stdin sẽ được dùng ở Đợt 2 (kênh hỏi/đáp). Gắn bắt lỗi NGAY từ bây giờ: ghi vào stdin của
  // một tiến trình vừa chết sẽ phát sự kiện 'error' trên stream, mà stream không có người nghe
  // thì Node NÉM lỗi — ở đây là tiến trình main của Electron, tức là **chết cả app và bỏ lại
  // toàn bộ tiến trình Python mồ côi vẫn đang vuốt máy thật**. Lỗi này chỉ hiện trong khe đua
  // giữa "con vừa thoát" và "cha vừa ghi", nên thử tay gần như không bao giờ gặp.
  if (proc.stdin) proc.stdin.on('error', () => {});

  _active.set(deviceId, { proc, serial, stopping: false });
  onStatus(deviceId, { kind: 'status', state: 'running' });

  const handleLine = (line, isErr) => {
    if (!line) return;
    if (line.startsWith('@@EVENT@@')) {
      let payload;
      try {
        payload = JSON.parse(line.slice('@@EVENT@@'.length));
      } catch (_) {
        onStatus(deviceId, { kind: 'log', line });
        return;
      }
      if (payload.type === 'progress') {
        onStatus(deviceId, { kind: 'progress', checked: payload.checked, qualified: payload.qualified });
      } else if (payload.type === 'status') {
        onStatus(deviceId, { kind: 'status', state: payload.state, msg: payload.msg });
      } else if (payload.type === 'result') {
        if (payload.verdict === 'DAT') {
          onData(deviceId, { name: payload.name, url: payload.url, posts: payload.posts });
          onStatus(deviceId, { kind: 'log', line: `DAT  ${payload.posts} posts  ${payload.name}` });
        } else {
          onStatus(deviceId, {
            kind: 'log',
            line: `LOAI ${payload.name || ''} posts=${payload.posts ?? '?'}`,
          });
        }
      }
      return;
    }
    onStatus(deviceId, { kind: 'log', line: isErr ? `[err] ${line}` : line });
  };

  readline.createInterface({ input: proc.stdout }).on('line', (l) => handleLine(l, false));
  readline.createInterface({ input: proc.stderr }).on('line', (l) => handleLine(l, true));

  proc.on('error', (e) => {
    onStatus(deviceId, { kind: 'status', state: 'error', msg: String(e.message || e).slice(0, 200) });
  });

  proc.on('close', (code) => {
    const entry = _active.get(deviceId);
    const wasStopping = !!(entry && entry.stopping);
    _active.delete(deviceId);
    const isError = !!code && !wasStopping;
    onStatus(deviceId, { kind: 'status', state: isError ? 'error' : 'stopped', msg: isError ? `exit code ${code}` : '' });
  });
}

function stopDevice(deviceId) {
  const entry = _active.get(deviceId);
  if (!entry) return { ok: false, msg: 'Thiết bị không chạy.' };
  entry.stopping = true;
  const serial = entry.serial;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(entry.proc.pid), '/t', '/f'], () => cleanupDevice(serial));
  } else {
    entry.proc.kill('SIGKILL');
    setTimeout(() => cleanupDevice(serial), 500);
  }
  return { ok: true };
}

function stopAll() {
  runningIds().forEach(stopDevice);
}

module.exports = { startDevice, stopDevice, stopAll, runningIds, isRunning };
