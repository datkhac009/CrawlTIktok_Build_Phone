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

// Đọc một thuộc tính của máy. Trả chuỗi rỗng nếu không đọc được — KHÔNG ném, vì đây chỉ là
// thông tin phụ giúp nhận ra máy; hỏng nó không được làm hỏng cả danh sách.
function _getprop(adb, serial, key) {
  return new Promise((resolve) => {
    execFile(adb, ['-s', serial, 'shell', 'getprop', key], { timeout: 6000, encoding: 'utf-8' },
      (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
  });
}

// Chạy `adb devices` để liệt kê serial đang online, KÈM TÊN MÁY.
//
// VÌ SAO CẦN TÊN (2026-09-16):
// Danh sách chỉ có `192.168.5.111:5555` thì không ai biết đó là máy nào trong 21 ô trên màn
// hình soi. `ro.product.model` cho ra đúng chuỗi mà phần mềm soi in trên mỗi ô (GM1911,
// TECNO LC8, SM-A920F...), nên nhìn là khớp được ngay.
//
// ⚠ KHÔNG dùng `settings get global device_name`: đo trên farm thật thấy hai máy khác hẳn nhau
// cùng báo "SM-N950F" — thuộc tính đó bị đặt đè nên vô dụng cho việc phân biệt.
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
      // Đọc tên SONG SONG: hơn 20 máy mà đọc tuần tự thì mất cả chục giây và người dùng tưởng
      // app treo.
      Promise.all(serials.map(async (x) => {
        if (x.state !== 'device') return;
        const [model, brand, hw] = await Promise.all([
          _getprop(ADB_PATH, x.serial, 'ro.product.model'),
          _getprop(ADB_PATH, x.serial, 'ro.product.brand'),
          _getprop(ADB_PATH, x.serial, 'ro.serialno'),
        ]);
        x.model = model;
        x.brand = brand;
        x.hwSerial = hw;    // số máy phần cứng — phân biệt được hai máy CÙNG đời
      })).then(() => resolve(serials), () => resolve(serials));
    });
  });
}

// Làm một máy TỰ LỘ DIỆN trên màn hình soi: kéo thanh thông báo xuống rồi thu lại sau vài giây.
//
// VÌ SAO CẦN: hai máy cùng đời (farm có hai chiếc Redmi K20 Pro) thì `ro.product.model` giống
// hệt nhau, nhìn tên không phân biệt được IP nào ứng với ô nào.
//
// Chọn thanh thông báo vì nó KHÔNG rời khỏi app đang mở, không bấm vào thứ gì, và tự trả lại
// nguyên trạng — khác hẳn mở Cài đặt hay bấm phím nguồn.
function identifyDevice(serial, ms = 4000) {
  return new Promise((resolve) => {
    const ADB_PATH = adbPath();
    if (!ADB_PATH) return resolve({ ok: false, msg: 'Không tìm thấy adb.exe' });
    execFile(ADB_PATH, ['-s', serial, 'shell', 'cmd', 'statusbar', 'expand-notifications'],
      { timeout: 8000 }, (err) => {
        if (err) return resolve({ ok: false, msg: 'Máy không nhận lệnh hiện thanh thông báo' });
        setTimeout(() => {
          execFile(ADB_PATH, ['-s', serial, 'shell', 'cmd', 'statusbar', 'collapse'],
            { timeout: 8000 }, () => resolve({ ok: true }));
        }, ms);
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
  identifyDevice,
  checkDevice,
};
