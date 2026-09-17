// src/adbpath.cjs — Tìm adb.exe. MỘT nơi duy nhất quyết định đường dẫn adb.
//
// VÌ SAO PHẢI CÓ (2026-09-15):
// App này vốn nằm ở `D:\ADB\Crawl_Data_Tiktok_Phone`, cạnh `D:\ADB\platform-tools`. Ba nơi
// tự viết lấy đường dẫn `../platform-tools/adb.exe` — tức TRỎ RA NGOÀI thư mục app:
//
//   src/runner.cjs:10   ADB_PATH = path.join(getBaseDir(), '..', 'platform-tools', 'adb.exe')
//   src/devices.cjs:9   (y hệt)
//   adb_helper.py:21    (y hệt, phía Python)
//
// Chủ dự án copy app sang `D:\tiktok-crawl\` thì `platform-tools` ở lại, `D:\ADB` bị xoá. Mọi
// lệnh adb hỏng, bảng thiết bị hiện đúng một chữ **"Lỗi"** không nói gì thêm. Mất một buổi mới
// tìm ra, mà nguyên nhân chỉ là một thư mục không đi theo.
//
// Hai bài học gộp vào file này:
//   1. Ba bản sao của cùng một đường dẫn = ba chỗ phải sửa và chắc chắn có chỗ bị quên (QĐ-10).
//   2. Đường dẫn trỏ RA NGOÀI thư mục app thì app không tự mang theo được. Ưu tiên bản NẰM
//      TRONG app, rồi mới dò ra ngoài.
//
// ⚠ VÌ SAO ƯU TIÊN adb CỦA 效卫 HƠN adb TỰ TẢI:
// Máy của chủ dự án đang chạy 效卫 (xiaowei) soi 19 máy Android, và nó giữ sẵn một adb server.
// adb có luật: client thấy server đang chạy KHÁC PHIÊN BẢN thì nó GIẾT server đó rồi dựng lại
// bản của mình. Hai binary khác phiên bản trên cùng một máy nghĩa là hai bên thay nhau giết
// server của nhau — 效卫 mất kết nối giữa chừng, app cũng mất. Dùng ĐÚNG binary mà 效卫 đang
// dùng thì không có chuyện đó.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getBaseDir, getResourcesDir } = require('./paths.cjs');

// Nơi 效卫 (xiaowei) cài adb kèm theo. Đo được trên máy chủ dự án 2026-09-15: bản 34.0.1.
const XIAOWEI_ADB = 'D:\\xiaowei_android\\tools\\adb.exe';

const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';

// Thứ tự dò. Mỗi mục ghi rõ NGUỒN để preflight nói được cho người dùng biết nó đang dùng cái nào
// — "không tìm thấy adb" và "đang dùng adb của 效卫" là hai tình huống rất khác nhau.
function _candidates() {
  const out = [];
  if (process.env.ADB_PATH) {
    out.push({ p: process.env.ADB_PATH, from: 'biến môi trường ADB_PATH' });
  }
  // Đóng gói kèm bản build (extraResources) — chỗ tốt nhất, vì nó đi theo app mọi lúc.
  const res = getResourcesDir();
  if (res) out.push({ p: path.join(res, 'platform-tools', EXE), from: 'platform-tools đóng gói kèm app' });
  // TRONG thư mục app — dùng khi chạy từ mã nguồn.
  out.push({ p: path.join(getBaseDir(), 'platform-tools', EXE), from: 'platform-tools trong thư mục app' });
  // Chỗ cũ, giữ lại để máy nào đang bày theo kiểu D:\ADB vẫn chạy được như trước.
  out.push({ p: path.join(getBaseDir(), '..', 'platform-tools', EXE), from: 'platform-tools cạnh thư mục app (kiểu cũ)' });
  if (process.platform === 'win32') {
    out.push({ p: XIAOWEI_ADB, from: 'adb đi kèm 效卫 (xiaowei)' });
  }
  return out;
}

let _cache = null;

// Trả { path, from } hoặc null. KHÔNG ném lỗi: nơi gọi cần phân biệt "chưa có adb" với "adb chạy
// lỗi", nếu ném thì hai thứ đó trộn vào nhau ở cùng một khối catch (QĐ-31).
function findAdb({ fresh = false } = {}) {
  if (_cache && !fresh) return _cache;
  for (const c of _candidates()) {
    try {
      if (c.p && fs.existsSync(c.p)) {
        _cache = { path: c.p, from: c.from };
        return _cache;
      }
    } catch (_) { /* đường dẫn hỏng thì thử mục kế */ }
  }
  // Cuối cùng mới tới PATH: có thì tốt, nhưng không biết là bản nào nên để sau cùng.
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(which, ['adb'], { timeout: 5000, encoding: 'utf-8' });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) {
      _cache = { path: first, from: 'PATH hệ thống' };
      return _cache;
    }
  } catch (_) { /* không có trong PATH */ }
  _cache = null;
  return null;
}

// Đường dẫn để truyền cho tiến trình con. Trả chuỗi rỗng khi không tìm thấy — nơi gọi PHẢI kiểm,
// đừng để lọt chuỗi rỗng xuống execFile rồi nhận về một lỗi ENOENT khó hiểu.
function adbPath() {
  const f = findAdb();
  return f ? f.path : '';
}

// `adb version` -> "1.0.41 (34.0.1-9680074)" hoặc null. Không dựng server nên gọi thoải mái.
function adbVersion(p) {
  const exe = p || adbPath();
  if (!exe) return null;
  try {
    const out = execFileSync(exe, ['version'], { timeout: 8000, encoding: 'utf-8' });
    const m1 = String(out).match(/version\s+([\d.]+)/i);
    const m2 = String(out).match(/Version\s+([\w.\-]+)/);
    if (!m1 && !m2) return null;
    return m2 ? `${m1 ? m1[1] : '?'} (${m2[1]})` : m1[1];
  } catch (_) {
    return null;
  }
}

// ── CỔNG của ADB SERVER mà CẢ APP dùng chung ──
//
// VÌ SAO NẰM Ở ĐÂY, CẠNH `adbPath()` (2026-09-16):
// `scan_feed_sounds.py` từng TỰ suy một cổng riêng cho mỗi máy (`5100 + crc32(serial) % 800`),
// với lý do "nhiều tiến trình dồn lệnh vào một adb server thì nghẽn". Kết quả là hai phía nói
// chuyện với hai server khác nhau: `preflight.cjs` hỏi 5037 thấy đủ máy nên báo XANH, còn tiến
// trình quét hỏi 5112 thì `adb devices` RỖNG. Đo được trong một lần chạy thật: `adb connect`
// treo trọn 60 giây, rồi mọi `adb shell` trả `device not found`, `setup_device` hỏng ba lần,
// tiến trình thoát mã 1 — mà bảng kiểm tra vẫn xanh từ đầu tới cuối.
//
// Đây đúng bài học mà file này mở đầu bằng: ba bản sao của một quyết định = ba chỗ phải sửa và
// chắc chắn quên một chỗ (QĐ-10). Đường dẫn adb đã học rồi; cổng server là cùng một bài.
//
// ⚠ VÌ SAO MẶC ĐỊNH 5037, KHÔNG PHẢI CHỌN BỪA:
// Farm này nối qua MẠNG (`192.168.x.x:5555`), mà `adbd` trên điện thoại chỉ nhận ĐÚNG MỘT adb
// server. 效卫 đã giữ cả 23 máy trên server mặc định rồi — bất kỳ server nào khác cũng vĩnh viễn
// không thấy một máy nào. Không có lựa chọn thứ hai, chỉ có lựa chọn đúng và lựa chọn hỏng câm.
const DEFAULT_ADB_SERVER_PORT = '5037';

function adbServerPort() {
  // Chỉ nhận chuỗi TOÀN CHỮ SỐ. Một giá trị rác lọt xuống tiến trình con thì adb bên đó dựng
  // server ở nơi không ai biết, và triệu chứng lại đúng là "không thấy máy nào" — thứ vừa mất
  // một buổi để tìm ra.
  const v = String(process.env.ANDROID_ADB_SERVER_PORT || '').trim();
  return /^\d+$/.test(v) ? v : DEFAULT_ADB_SERVER_PORT;
}

function _resetForTest() { _cache = null; }

module.exports = {
  findAdb, adbPath, adbVersion, XIAOWEI_ADB, _resetForTest,
  adbServerPort, DEFAULT_ADB_SERVER_PORT,
};
