// src/proxyrun.cjs — Gắn / tắt proxy trên MỘT điện thoại ngay lúc bấm Lưu, ngoài lượt quét.
//
// VÌ SAO CÓ (2026-09-23): chủ dự án: "khi tôi lưu proxy thì máy đó đã phải nhận proxy tôi setup rồi".
// Trước đó proxy chỉ được gắn lúc bấm Chạy, nên bấm Lưu xong cột Proxy hiện host:port mà điện thoại
// vẫn chạy IP thật — nhìn như đã nhận mà chưa.
//
// Chạy `python college_proxy.py <serial> gan|tat` với ĐÚNG các biến mà lượt quét dùng (ADB_PATH,
// cổng ADB server, PROXY, PROXY_MOC) — cùng một đường gắn, cùng tệp dấu, nên lượt chạy sau đi
// đường nhanh luôn. Máy đang chạy thì main.js KHÔNG gọi tới đây (tiến trình quét đang giữ màn hình).
'use strict';

const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { getBaseDir, resolveResource, getDeviceDir } = require('./paths.cjs');
const { adbPath, adbServerPort } = require('./adbpath.cjs');
const { findPython } = require('./pythonpath.cjs');

const EVENT_PREFIX = '@@EVENT@@';
// Gắn đầy đủ đo được ~40 giây, hỏng cả hai lần ~2 phút. Quá 4 phút là tiến trình kẹt.
const HAN_MS = 4 * 60 * 1000;

// { deviceId, serial, proxy, tat } → Promise<{ ok, ip, msg }>. `onLog(line)` nhận từng dòng log.
function chayProxy({ deviceId, serial, proxy, tat }, onLog = () => {}) {
  return new Promise((resolve) => {
    const py = findPython();
    if (!py || !py.hasU2) return resolve({ ok: false, msg: 'Chưa có Python + uiautomator2 — bấm 🔌 Kiểm tra.' });
    const ADB_PATH = adbPath();
    if (!ADB_PATH) return resolve({ ok: false, msg: 'Không tìm thấy adb.exe — bấm 🔌 Kiểm tra.' });
    const env = Object.assign({}, process.env, {
      PYTHONIOENCODING: 'utf-8',
      ADB_PATH,
      ANDROID_ADB_SERVER_PORT: adbServerPort(),
      // Mật khẩu đi qua biến môi trường của RIÊNG tiến trình con, không qua dòng lệnh.
      PROXY: String(proxy || ''),
      PROXY_MOC: path.join(getDeviceDir(deviceId), 'proxy_da_gan.txt'),
    });
    let kq = null;
    let xong = false;
    const ket = (r) => { if (!xong) { xong = true; clearTimeout(hen); resolve(r); } };
    const proc = spawn(py.cmd, [...py.args, resolveResource('college_proxy.py'), serial, tat ? 'tat' : 'gan'],
      { cwd: getBaseDir(), env, windowsHide: true });
    const hen = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      ket({ ok: false, msg: 'gắn proxy quá 4 phút không xong — đã dừng' });
    }, HAN_MS);
    const doc = (line) => {
      if (!line) return;
      if (line.startsWith(EVENT_PREFIX)) {
        try {
          const p = JSON.parse(line.slice(EVENT_PREFIX.length));
          if (p.type === 'proxy') kq = { ok: p.ok === true, ip: String(p.ip || ''), msg: String(p.msg || '') };
        } catch (_) {}
        return;
      }
      onLog(line);
    };
    readline.createInterface({ input: proc.stdout }).on('line', doc);
    readline.createInterface({ input: proc.stderr }).on('line', (l) => l && onLog(`[err] ${l}`));
    proc.on('error', (e) => ket({ ok: false, msg: String(e.message || e).slice(0, 160) }));
    proc.on('close', (code) => ket(kq || { ok: code === 0, msg: code === 0 ? '' : `exit code ${code}` }));
  });
}

module.exports = { chayProxy };
