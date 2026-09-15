// src/devices.cjs — Quản lý danh sách thiết bị (thay cho "Chrome profile" ở bản gốc).
// Model đơn giản hơn nhiều: 1 thiết bị = 1 serial ADB, không có folder/session riêng.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { getDevicesJsonPath } = require('./paths.cjs');
const { adbPath } = require('./adbpath.cjs');
const preflight = require('./preflight.cjs');

function loadDevices() {
  const p = getDevicesJsonPath();
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, '[]', 'utf-8');
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (_) {
    return [];
  }
}

function saveDevices(list) {
  fs.writeFileSync(getDevicesJsonPath(), JSON.stringify(list, null, 2), 'utf-8');
}

function addDevice({ name, serial, note }) {
  if (!serial || !serial.trim()) throw new Error('Thiếu serial thiết bị.');
  const list = loadDevices();
  if (list.some((d) => d.serial === serial.trim())) {
    throw new Error(`Serial ${serial} đã được thêm rồi.`);
  }
  const device = {
    id: 'd_' + Date.now(),
    name: (name || serial).trim(),
    serial: serial.trim(),
    note: note || '',
  };
  list.push(device);
  saveDevices(list);
  return device;
}

function updateDevice({ id, name, serial, note }) {
  const list = loadDevices();
  const dev = list.find((d) => d.id === id);
  if (!dev) throw new Error('Không tìm thấy thiết bị.');
  if (name !== undefined) dev.name = name;
  if (serial !== undefined) dev.serial = serial;
  if (note !== undefined) dev.note = note;
  saveDevices(list);
  return dev;
}

function deleteDevice({ id }) {
  const list = loadDevices();
  const next = list.filter((d) => d.id !== id);
  saveDevices(next);
  return { ok: true };
}

// Chạy `adb devices` để liệt kê serial đang online, đánh dấu cái nào đã được thêm.
function listAdbSerials() {
  return new Promise((resolve) => {
    const ADB_PATH = adbPath();
    // Không có adb thì trả rỗng NGAY — đừng gọi execFile với chuỗi rỗng rồi nhận ENOENT, vì
    // lỗi đó trông y hệt "chạy adb bị lỗi" và người sửa sẽ đi nhầm hướng (QĐ-31).
    if (!ADB_PATH) return resolve([]);
    execFile(ADB_PATH, ['devices'], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve([]);
      const added = new Set(loadDevices().map((d) => d.serial));
      const serials = [];
      stdout.split(/\r?\n/).slice(1).forEach((line) => {
        const m = line.match(/^(\S+)\t(device|unauthorized|offline)$/);
        if (m) serials.push({ serial: m[1], state: m[2], added: added.has(m[1]) });
      });
      resolve(serials);
    });
  });
}

// Kiểm một thiết bị. Giờ gọi thẳng preflight để người dùng thấy ĐỦ nguyên nhân trong một lần
// bấm — kể cả nguyên nhân nằm ở MÁY TÍNH (thiếu adb, sai bản Python) chứ không ở điện thoại.
// Bản cũ chỉ trả `{online, hasTiktok}`, nên khi hỏng vì Python nó vẫn báo "đang online, đã cài
// TikTok" rồi lát sau chạy là "Lỗi" — đúng kiểu chẩn đoán gây hiểu nhầm mà QĐ-31 cấm.
//
// Vẫn giữ nguyên hai trường `online` / `hasTiktok` cho phần giao diện cũ đang đọc chúng.
async function checkDevice(serial) {
  const r = await preflight.checkAll(serial);
  const find = (k) => r.items.find((x) => x.key === k);
  return {
    online: !!(find('online') && find('online').ok),
    hasTiktok: !!(find('tiktok') && find('tiktok').ok),
    ok: r.ok,
    items: r.items,
    tiktokVersion: r.tiktokVersion,
  };
}

module.exports = {
  loadDevices,
  addDevice,
  updateDevice,
  deleteDevice,
  listAdbSerials,
  checkDevice,
};
