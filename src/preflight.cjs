// src/preflight.cjs — Kiểm tra TRƯỚC khi chạy, và nói rõ hỏng cái gì.
//
// VÌ SAO PHẢI CÓ (2026-09-15):
// Chủ dự án mở app, bảng thiết bị hiện đúng một chữ **"Lỗi"** ở máy 104 và **"Đã dừng"** ở máy
// 114, cả hai 0/0. Không có gì khác. Thực tế lúc đó có BA thứ hỏng cùng lúc:
//
//   1. `adb.exe` không còn (thư mục platform-tools không đi theo khi copy app)
//   2. `uiautomator2` chưa cài
//   3. Python trong PATH là 3.14, bản mà uiautomator2 chưa chạy được
//
// Ba nguyên nhân khác hẳn nhau, ba câu sửa khác hẳn nhau, mà app gộp hết thành một chữ "Lỗi".
// Đó đúng là thứ QĐ-29/30/31 cấm: chẩn đoán sai hoặc rỗng còn tệ hơn không chẩn đoán, vì nó
// đẩy người dùng đi sai hướng.
//
// Nguyên tắc của file này:
//   - Mỗi mục kiểm MỘT thứ, và khi đỏ thì kèm **câu sửa cụ thể gõ được ngay**, không phải lời
//     khuyên chung chung.
//   - Không mục nào được ném lỗi ra ngoài. Một mục hỏng không được che mất các mục sau — người
//     dùng cần thấy CẢ BA vấn đề trong một lần bấm, không phải sửa một cái rồi mới lòi cái kế.
'use strict';

const { execFile } = require('child_process');
const { findAdb, adbVersion, adbServerPort } = require('./adbpath.cjs');
const { findPython, installCommand } = require('./pythonpath.cjs');

const TIKTOK_PKGS = ['com.zhiliaoapp.musically', 'com.ss.android.ugc.trill'];

function _run(exe, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, encoding: 'utf-8', windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, out: String(stdout || ''), errOut: String(stderr || '') });
    });
  });
}

function _item(key, label, ok, detail, fix) {
  return { key, label, ok, detail: detail || '', fix: ok ? '' : (fix || '') };
}

// ── Kiểm phần MÁY TÍNH: adb + Python. Không cần thiết bị, nên chạy được cả khi chưa cắm máy nào.
async function checkHost() {
  const items = [];

  const adb = findAdb({ fresh: true });
  if (!adb) {
    items.push(_item('adb', 'adb.exe', false, 'không tìm thấy ở bất kỳ đâu',
      'Chép thư mục `platform-tools` vào cạnh file chạy của app, '
      + 'hoặc đặt biến môi trường ADB_PATH trỏ tới adb.exe. '
      + 'Máy này đã có sẵn một bản ở D:\\xiaowei_android\\tools\\adb.exe (đi kèm 效卫).'));
  } else {
    const ver = adbVersion(adb.path);
    // Nói luôn CỔNG SERVER, không chỉ đường dẫn. Ngày 2026-09-16 mục này báo xanh trong khi
    // tiến trình quét chết vì "device not found" — nó kiểm trên server 5037 còn lượt chạy đi vào
    // một server khác. Một chẩn đoán xanh mà sai còn tệ hơn không chẩn đoán (QĐ-29), nên cái
    // phân biệt hai tình huống đó phải nằm ngay trên mặt.
    items.push(_item('adb', 'adb.exe', true,
      `${ver || 'không đọc được phiên bản'} — ${adb.from} · server cổng ${adbServerPort()}`));
  }

  const py = findPython({ fresh: true });
  if (!py) {
    items.push(_item('python', 'Python', false, 'không chạy được python nào',
      'Cài Python 3.12 từ python.org và nhớ tích "Add python.exe to PATH".'));
  } else if (!py.hasU2) {
    // ĐÂY LÀ CA ĐÃ GẶP. Câu sửa phải nêu ĐÍCH DANH bản Python app sẽ chạy: gõ `pip install`
    // trần rất dễ rơi vào một bản Python khác, rồi app vẫn báo thiếu thư viện và người dùng
    // cài đi cài lại mà không hiểu vì sao.
    items.push(_item('python', 'Python', false,
      `${py.version.text} (${py.from}) — thiếu thư viện uiautomator2`,
      `Chạy đúng lệnh này rồi bấm "Kiểm tra lại":\n    ${installCommand(py)}`));
  } else {
    items.push(_item('python', 'Python', true, `${py.version.text} + uiautomator2 — ${py.from}`));
  }

  return { ok: items.every((x) => x.ok), items };
}

// ── Kiểm MỘT thiết bị. Trả thêm `tiktokVersion` để nơi gọi so đồng bộ cả farm.
async function checkDevice(serial) {
  const items = [];
  let tiktokVersion = '';

  const adb = findAdb();
  if (!adb) {
    // Không có adb thì mọi mục sau đều vô nghĩa. Nói đúng một câu, đừng đẻ thêm 3 dòng đỏ
    // cùng một nguyên nhân — nhiễu làm người đọc không biết bắt đầu từ đâu.
    items.push(_item('adb', 'adb.exe', false, 'không tìm thấy',
      'Xem mục adb ở phần kiểm tra máy tính.'));
    return { ok: false, items, tiktokVersion };
  }

  const st = await _run(adb.path, ['-s', serial, 'get-state'], 8000);
  const online = !st.err && st.out.trim() === 'device';
  if (!online) {
    const ly = (st.out.trim() || st.errOut.trim() || 'không phản hồi').slice(0, 120);
    items.push(_item('online', 'Kết nối thiết bị', false, ly,
      serial.includes(':')
        ? `Máy nối qua mạng. Kiểm máy đã bật và cùng mạng LAN chưa, rồi chạy:\n    "${adb.path}" connect ${serial}`
        : 'Kiểm cáp USB và bật "USB debugging" trên máy.'));
    return { ok: false, items, tiktokVersion };
  }
  items.push(_item('online', 'Kết nối thiết bị', true, 'đã kết nối'));

  const pk = await _run(adb.path, ['-s', serial, 'shell', 'pm', 'list', 'packages'], 10000);
  const pkg = TIKTOK_PKGS.find((p) => pk.out.includes(p));
  if (!pkg) {
    items.push(_item('tiktok', 'TikTok trên máy', false, 'chưa cài',
      'Cài TikTok lên máy (musically hoặc trill) và ĐĂNG NHẬP sẵn — app không tự đăng nhập được.'));
    return { ok: false, items, tiktokVersion };
  }

  // Phiên bản TikTok quyết định chữ trên nút và cấu trúc màn hình. Cả farm lệch phiên bản là
  // mỗi máy một kiểu, và triệu chứng sẽ là "máy này chạy máy kia không" — rất khó đoán ra.
  const dv = await _run(adb.path, ['-s', serial, 'shell', 'dumpsys', 'package', pkg], 12000);
  const mv = dv.out.match(/versionName=([^\s]+)/);
  tiktokVersion = mv ? mv[1] : '';
  items.push(_item('tiktok', 'TikTok trên máy', true,
    `${pkg}${tiktokVersion ? ' v' + tiktokVersion : ''}`));

  return { ok: items.every((x) => x.ok), items, tiktokVersion };
}

// ── Kiểm cả máy tính lẫn một thiết bị, gộp một danh sách.
async function checkAll(serial) {
  const host = await checkHost();
  const dev = serial ? await checkDevice(serial) : { ok: true, items: [], tiktokVersion: '' };
  const items = [...host.items, ...dev.items];
  return { ok: items.every((x) => x.ok), items, tiktokVersion: dev.tiktokVersion };
}

// ── So phiên bản TikTok giữa các máy. Trả danh sách cảnh báo (rỗng = đồng bộ).
// KHÔNG phải lỗi: farm vẫn chạy được khi lệch, chỉ là nhận diện nút có thể khác nhau. Nên đây
// là CẢNH BÁO, không chặn — chặn nhầm còn phiền hơn.
function versionWarnings(list) {
  const co = (list || []).filter((x) => x && x.tiktokVersion);
  if (co.length < 2) return [];
  const dem = new Map();
  co.forEach((x) => dem.set(x.tiktokVersion, (dem.get(x.tiktokVersion) || 0) + 1));
  if (dem.size < 2) return [];
  const sapXep = [...dem.entries()].sort((a, b) => b[1] - a[1]);
  const chuan = sapXep[0][0];
  return co
    .filter((x) => x.tiktokVersion !== chuan)
    .map((x) => `${x.name || x.serial}: TikTok v${x.tiktokVersion} — phần lớn farm đang v${chuan}. `
      + 'Chữ trên nút có thể khác, nên nhận diện Follow / Not interested có thể trượt ở máy này.');
}

module.exports = { checkHost, checkDevice, checkAll, versionWarnings, TIKTOK_PKGS };
