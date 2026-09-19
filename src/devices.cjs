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

function updateDevice({ id, name, serial, note, hw, model }) {
  const list = loadDevices();
  const dev = list.find((d) => d.id === id);
  if (!dev) throw new Error('Không tìm thấy thiết bị.');
  if (name !== undefined) dev.name = name;
  if (serial !== undefined && serial !== dev.serial) {
    dev.serial = serial;
    // Người dùng tự sửa IP = tự khẳng định "máy này ở IP kia". Danh tính cũ không còn đúng nữa,
    // bỏ đi để lần chạy sau đọc lại từ chính IP mới.
    delete dev.hw;
    delete dev.model;
  }
  if (note !== undefined) dev.note = note;
  if (hw !== undefined) dev.hw = hw;
  if (model !== undefined) dev.model = model;
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

// ══════════════════ MÁY ĐỔI IP — DÒ THEO SỐ MÁY PHẦN CỨNG (2026-09-19) ══════════════════
//
// ⚠ SỰ CỐ THẬT: cả farm khởi động lại, DHCP cấp IP MỚI cho 6 máy (.148→.158, .106→.115,
// .115→.125, .127→.137, .139→.149, .140→.150). App vẫn gọi IP cũ: 5 dòng báo "device … not
// online" rồi tự chạy lại mãi, còn dòng "V2031" (.115) lại đang lái chiếc GM1911 vừa nhận đúng IP
// đó — kết quả của GM1911 bị ghi tên V2031.
//
// IP chỉ là thứ DHCP cấp, không phải danh tính của máy. Danh tính thật là `ro.serialno` — số máy
// phần cứng, phân biệt được cả hai máy CÙNG ĐỜI (farm có hai Redmi K20 Pro). Lưu nó vào trường
// `hw` của từng máy, rồi dò theo nó.
//
// Máy thêm từ trước khi có trường này thì chưa có `hw`: nhận theo ĐỜI MÁY (`ro.product.model`) —
// tên trong danh sách vốn là đời máy, hoặc đời máy + hậu tố ("Redmi K20 Pro1"). Nhận được một lần
// là ghi `hw` luôn, lần sau dò bằng `hw`.

function _chuan(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Tên trong danh sách có phải đời máy này không: trùng hẳn, hoặc đời máy + hậu tố ("Redmi K20 Pro1").
function khopTen(ten, model) {
  const a = _chuan(ten);
  const b = _chuan(model);
  return !!b && (a === b || a.startsWith(b));
}

// Ghép danh sách máy với các máy ĐANG ONLINE. Hàm THUẦN: không đụng đĩa, không gọi adb.
//   ds        danh sách trong devices.json
//   online    [{ serial, model, hwSerial }] — chỉ máy ở trạng thái `device`
//   dangChay  Map(deviceId → serial) của các máy đang có tiến trình chạy: KHÔNG đổi IP của chúng,
//             và KHÔNG giao IP chúng đang giữ cho máy khác (hai tiến trình cùng lái một điện thoại)
// Trả { ds: bản mới, doi: [{ id, name, cu, moi }], khongThay: [{ id, name, serial, viSao }], ghiThem }
//   ghiThem = số máy vừa được ghi thêm `hw` (không đổi IP) — để biết có cần lưu đĩa không.
function ghepMay(ds, online, dangChay = new Map()) {
  const moi = ds.map((d) => Object.assign({}, d));
  const daNhan = new Set();                 // serial đã có chủ trong lượt ghép này
  const xong = new Set();                   // id máy đã xếp xong
  const doi = [];
  const khongThay = [];
  let ghiThem = 0;
  const onlineTheoSerial = new Map(online.map((o) => [o.serial, o]));

  // 0. Máy đang chạy: giữ nguyên.
  for (const d of moi) {
    if (dangChay.has(d.id)) {
      daNhan.add(dangChay.get(d.id));
      xong.add(d.id);
    }
  }
  const ganIp = (d, o) => {
    if (o.serial !== d.serial) {
      doi.push({ id: d.id, name: d.name, cu: d.serial, moi: o.serial });
      d.serial = o.serial;
    } else if (!d.hw && o.hwSerial) {
      ghiThem++;
    }
    if (o.hwSerial) d.hw = o.hwSerial;
    if (o.model) d.model = o.model;
    daNhan.add(o.serial);
    xong.add(d.id);
  };

  // 1. Đã có số máy phần cứng: tìm đúng số đó, ở bất cứ IP nào.
  for (const d of moi) {
    if (xong.has(d.id) || !d.hw) continue;
    const o = online.find((x) => x.hwSerial === d.hw && !daNhan.has(x.serial));
    if (o) ganIp(d, o);
  }
  // 2. Chưa có số máy, IP cũ vẫn đúng đời máy: giữ, và ghi số máy luôn.
  for (const d of moi) {
    if (xong.has(d.id) || d.hw) continue;
    const o = onlineTheoSerial.get(d.serial);
    if (o && !daNhan.has(o.serial) && khopTen(d.name, o.model)) ganIp(d, o);
  }
  // 3. Chưa có số máy, IP cũ không còn đúng: tìm đời máy đó trong các máy CHƯA CÓ CHỦ. Chỉ nhận
  //    khi có ĐÚNG MỘT ứng viên — hai máy cùng đời chưa ai có chủ thì không đoán.
  for (const d of moi) {
    if (xong.has(d.id) || d.hw) continue;
    const ungVien = online.filter((x) => !daNhan.has(x.serial) && khopTen(d.name, x.model));
    if (ungVien.length === 1) ganIp(d, ungVien[0]);
  }
  // 4. Những máy còn lại: nói rõ vì sao không tìm thấy.
  for (const d of moi) {
    if (xong.has(d.id)) continue;
    const o = onlineTheoSerial.get(d.serial);
    const cungDoi = d.hw ? 0 : online.filter((x) => !daNhan.has(x.serial) && khopTen(d.name, x.model)).length;
    let viSao;
    if (cungDoi > 1) {
      viSao = `có ${cungDoi} máy cùng đời đang online, chưa rõ máy nào là máy này — bấm ✎ sửa IP một lần là app nhớ luôn`;
    } else if (!o) {
      viSao = `máy không online ở ${d.serial}, cũng không thấy ở IP nào khác`;
    } else if (d.hw && o.hwSerial && o.hwSerial !== d.hw) {
      viSao = `${d.serial} giờ là một điện thoại khác (${o.model || '?'}), còn máy này chưa thấy online`;
    } else if (!d.hw && !khopTen(d.name, o.model)) {
      viSao = `${d.serial} giờ là ${o.model || 'máy khác'}, không phải ${d.name}`;
    } else {
      viSao = `IP ${d.serial} đang được máy khác trong danh sách dùng`;
    }
    khongThay.push({ id: d.id, name: d.name, serial: d.serial, viSao });
  }
  return { ds: moi, doi, khongThay, ghiThem };
}

// Đọc danh tính của máy đang ở một IP: { online, model, hw }. Không ném.
async function docDanhTinh(serial) {
  const ADB_PATH = adbPath();
  if (!ADB_PATH || !serial) return { online: false, model: '', hw: '' };
  const [model, hw] = await Promise.all([
    _getprop(ADB_PATH, serial, 'ro.product.model'),
    _getprop(ADB_PATH, serial, 'ro.serialno'),
  ]);
  return { online: !!(model || hw), model, hw };
}

// Dò lại IP cho CẢ danh sách rồi lưu. Trả kết quả `ghepMay` (thêm `loi` nếu không đọc được adb).
async function dongBoIp({ dangChay = new Map() } = {}) {
  const online = (await listAdbSerials()).filter((x) => x.state === 'device');
  const ds = loadDevices();
  const r = ghepMay(ds, online, dangChay);
  if (r.doi.length || r.ghiThem) {
    // Đọc lại NGAY TRƯỚC khi ghi: người dùng có thể vừa thêm / xoá máy trong lúc đang dò. Chỉ
    // chép sang đúng những trường vừa dò được, không ghi đè cả danh sách.
    const hienTai = loadDevices();
    for (const d of hienTai) {
      const m = r.ds.find((x) => x.id === d.id);
      if (!m) continue;
      d.serial = m.serial;
      if (m.hw) d.hw = m.hw;
      if (m.model) d.model = m.model;
    }
    saveDevices(hienTai);
  }
  return r;
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
  khopTen,
  ghepMay,
  docDanhTinh,
  dongBoIp,
};
