// src/paths.cjs — Giải quyết các đường dẫn thư mục dùng chung.
'use strict';

const path = require('path');
const fs = require('fs');

let _app = null;
try {
  _app = require('electron').app;
} catch (_) {
  // Cho phép require ngoài Electron (vd: test) — sẽ fallback về __dirname.
}

function getBaseDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (_app && _app.isPackaged) return path.dirname(_app.getPath('exe'));
  return path.join(__dirname, '..');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getConfigDir() {
  return ensureDir(path.join(getBaseDir(), 'config'));
}

function getDevicesJsonPath() {
  return path.join(getConfigDir(), 'devices.json');
}

// Thư mục tài nguyên đóng gói kèm bản build (electron-builder `extraResources`). Chạy từ mã
// nguồn thì không có, trả null.
function getResourcesDir() {
  if (_app && _app.isPackaged && process.resourcesPath) return process.resourcesPath;
  return null;
}

// Tìm một file tài nguyên: ưu tiên bản ĐÓNG GÓI KÈM, rồi mới tới bản nằm cạnh file chạy.
//
// ⚠ VÌ SAO ƯU TIÊN BẢN ĐÓNG GÓI (2026-09-15):
// Bản cũ chỉ nhìn `getBaseDir()`, còn `package.json` lại LOẠI `*.py` khỏi bản build và nhờ
// `build.bat` copy tay ra cạnh file .exe. Hai nửa của app (JavaScript trong .exe và Python nằm
// ngoài) vì thế có thể LỆCH PHIÊN BẢN: cập nhật app mà quên chép lại .py thì phần JS mới nói
// chuyện với phần Python cũ. Triệu chứng là **không có triệu chứng** — không lỗi, không cảnh
// báo, chỉ là các tính năng mới lặng lẽ không chạy.
//
// Vẫn dò tiếp ra ngoài để ai đang sửa .py cạnh file .exe (cách gỡ rối nhanh) không bị mất đường.
function resolveResource(name) {
  const res = getResourcesDir();
  if (res) {
    const p = path.join(res, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(getBaseDir(), name);
}

function getPythonScriptPath() {
  return resolveResource('scan_feed_sounds.py');
}

function getOutputTxtPath() {
  return path.join(getBaseDir(), 'sound_links.txt');
}

// Thư mục riêng của MỘT thiết bị: sổ kênh chất lượng, bản đồ giao diện đã dò, dữ liệu theo máy.
// Mỗi máy một tài khoản TikTok riêng nên khẩu vị và lịch sử follow của chúng không được trộn.
function getDeviceDir(deviceId) {
  return ensureDir(path.join(getConfigDir(), 'devices', String(deviceId)));
}

module.exports = {
  getBaseDir,
  getResourcesDir,
  resolveResource,
  getConfigDir,
  getDevicesJsonPath,
  getDeviceDir,
  getPythonScriptPath,
  getOutputTxtPath,
  ensureDir,
};
