// src/loginrun.cjs — Đăng nhập TikTok trên MỘT điện thoại khi bấm "Đăng nhập TikTok", ngoài lượt quét.
//
// Chạy `python tiktok_login.py <serial>` với tài khoản, proxy và tệp dấu proxy trong biến môi trường
// của RIÊNG tiến trình con (mật khẩu không qua dòng lệnh). Máy có proxy thì Python gắn proxy TRƯỚC khi
// mở TikTok — cùng đường gắn, cùng tệp dấu với lượt quét (src/proxyrun.cjs).
// Máy đang chạy thì main.js KHÔNG gọi tới đây (tiến trình quét đang giữ màn hình).
'use strict';

const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { getBaseDir, resolveResource, getDeviceDir } = require('./paths.cjs');
const { adbPath, adbServerPort } = require('./adbpath.cjs');
const { findPython } = require('./pythonpath.cjs');

const EVENT_PREFIX = '@@EVENT@@';
// Gắn proxy tối đa 4 phút + đăng nhập 8 phút (gồm 5 phút chờ người giải captcha).
const HAN_MS = 13 * 60 * 1000;

// { deviceId, serial, taiKhoan, handleCu, proxy } → Promise<{ ok, trangThai, handle, msg }>.
// `onLog(line)` nhận từng dòng log; `onSuKien(p)` nhận sự kiện giữa chừng (cho_nguoi, proxy…).
function chayDangNhap({ deviceId, serial, taiKhoan, handleCu, proxy }, onLog = () => {}, onSuKien = () => {}) {
  return new Promise((resolve) => {
    const py = findPython();
    if (!py || !py.hasU2) return resolve({ ok: false, trangThai: 'loi', msg: 'Chưa có Python + uiautomator2 — bấm 🔌 Kiểm tra.' });
    const ADB_PATH = adbPath();
    if (!ADB_PATH) return resolve({ ok: false, trangThai: 'loi', msg: 'Không tìm thấy adb.exe — bấm 🔌 Kiểm tra.' });
    const env = Object.assign({}, process.env, {
      PYTHONIOENCODING: 'utf-8',
      ADB_PATH,
      ANDROID_ADB_SERVER_PORT: adbServerPort(),
      TAI_KHOAN: String(taiKhoan || ''),
      TK_HANDLE: String(handleCu || ''),
      PROXY: String(proxy || ''),
      PROXY_MOC: proxy ? path.join(getDeviceDir(deviceId), 'proxy_da_gan.txt') : '',
    });
    let kq = null;
    let xong = false;
    const ket = (r) => { if (!xong) { xong = true; clearTimeout(hen); resolve(r); } };
    const proc = spawn(py.cmd, [...py.args, resolveResource('tiktok_login.py'), serial],
      { cwd: getBaseDir(), env, windowsHide: true });
    const hen = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      ket({ ok: false, trangThai: 'loi', msg: 'đăng nhập quá 13 phút không xong — đã dừng' });
    }, HAN_MS);
    const doc = (line) => {
      if (!line) return;
      if (line.startsWith(EVENT_PREFIX)) {
        try {
          const p = JSON.parse(line.slice(EVENT_PREFIX.length));
          if (p.type === 'login' && p.ok !== undefined) {
            kq = { ok: p.ok === true, trangThai: String(p.trangThai || ''), handle: String(p.handle || ''), msg: String(p.msg || '') };
          } else {
            onSuKien(p);
          }
        } catch (_) {}
        return;
      }
      onLog(line);
    };
    readline.createInterface({ input: proc.stdout }).on('line', doc);
    readline.createInterface({ input: proc.stderr }).on('line', (l) => l && onLog(`[err] ${l}`));
    proc.on('error', (e) => ket({ ok: false, trangThai: 'loi', msg: String(e.message || e).slice(0, 160) }));
    proc.on('close', (code) => ket(kq || { ok: false, trangThai: 'loi', msg: `exit code ${code}` }));
  });
}

module.exports = { chayDangNhap };
