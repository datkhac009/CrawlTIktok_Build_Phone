// src/pythonpath.cjs — Tìm Python chạy được uiautomator2. MỘT nơi duy nhất quyết định.
//
// VÌ SAO PHẢI CÓ (2026-09-15):
// `runner.cjs` đang `spawn('python', ...)` — lấy bất kỳ python nào đứng đầu PATH. Trên máy chủ
// dự án, tiến trình con chết ngay với:
//
//     ModuleNotFoundError: No module named 'uiautomator2'
//
// `runner.cjs` chỉ thấy exit code khác 0 và báo **"Lỗi"**. Không có cách nào biết nguyên nhân.
// Chuyện này không hiếm: máy làm việc thật hay có 2–3 bản Python cùng lúc (bản cài tay, bản của
// Store, bản đi kèm phần mềm khác), và `pip install` rất dễ rơi vào bản KHÁC bản mà app chạy.
//
// ⚠ TIÊU CHÍ CHỌN LÀ **IMPORT ĐƯỢC**, KHÔNG PHẢI SỐ PHIÊN BẢN.
// Bản đầu của file này chặn cứng ở 3.13 vì tôi CHO RẰNG uiautomator2 chưa chạy trên 3.14. Sai:
// đo lại bằng `pip install --dry-run uiautomator2` trên đúng máy đó (2026-09-15) thì
// uiautomator2 3.7.0 giải phụ thuộc sạch trên 3.14 — lxml 6.1.3, pillow 12.3.0,
// charset_normalizer đều có bánh xe cp314. Nếu giữ nguyên cái trần đoán mò ấy, app sẽ bắt chủ
// dự án đi cài thêm Python 3.12 hoàn toàn vô ích, trong khi việc cần làm chỉ là cài thư viện.
//
// Nên khoảng phiên bản bên dưới chỉ còn là **gợi ý xếp thứ tự ưu tiên**, không phải cửa chặn:
// bản nào import được uiautomator2 thì bản đó thắng, kể cả khi nó nằm ngoài khoảng. Phiên bản
// là phỏng đoán; import được mới là bằng chứng.
'use strict';

const { execFileSync } = require('child_process');

// Khoảng ĐÃ ĐƯỢC DÙNG NHIỀU, chỉ dùng để xếp ưu tiên khi chưa bản nào cài thư viện. Không chặn.
const MIN_MINOR = 9;
const MAX_MINOR = 14;

// Ứng viên, theo thứ tự. `py` là Python Launcher của Windows: `py -3.12` gọi đúng bản 3.12 dù
// PATH đang trỏ đi đâu — đây là đường thoát cho máy có nhiều bản Python.
function _candidates() {
  const out = [];
  if (process.env.PYTHON_PATH) out.push({ cmd: process.env.PYTHON_PATH, args: [], from: 'biến môi trường PYTHON_PATH' });
  out.push({ cmd: 'python', args: [], from: 'python trong PATH' });
  if (process.platform === 'win32') {
    for (const v of ['3.12', '3.11', '3.13', '3.14', '3.10', '3.9']) {
      out.push({ cmd: 'py', args: [`-${v}`], from: `Python Launcher (py -${v})` });
    }
  } else {
    for (const v of ['3.12', '3.11', '3.13', '3.14', '3.10', '3.9']) {
      out.push({ cmd: `python${v}`, args: [], from: `python${v} trong PATH` });
    }
  }
  return out;
}

// "Python 3.11.9" -> { major:3, minor:11, text:'3.11.9' }; null nếu không chạy được.
function _version(cand) {
  try {
    // stderr phải NUỐT: `py -3.12` khi máy không có bản đó sẽ in
    // "[ERROR] No runtime installed that matches 3.12" ra stderr. Đây là kết quả dò BÌNH
    // THƯỜNG, không phải sự cố — để nó chảy ra console thì mỗi lần kiểm tra lại đổ mấy dòng
    // đỏ làm người đọc tưởng app hỏng.
    const out = execFileSync(cand.cmd, [...cand.args, '--version'], {
      timeout: 8000, encoding: 'utf-8', windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = String(out).match(/Python\s+(\d+)\.(\d+)\.?(\d+)?/i);
    if (!m) return null;
    return { major: +m[1], minor: +m[2], text: `${m[1]}.${m[2]}${m[3] ? '.' + m[3] : ''}` };
  } catch (_) {
    return null;
  }
}

// Bằng chứng thật: import được hay không. Đắt hơn đọc phiên bản nhưng đây là thứ quyết định.
function _hasU2(cand) {
  try {
    execFileSync(cand.cmd, [...cand.args, '-c', 'import uiautomator2'], {
      timeout: 25000, stdio: 'ignore', windowsHide: true,
    });
    return true;
  } catch (_) {
    return false;
  }
}

// Chỉ để XẾP ƯU TIÊN. Không dùng làm cửa chặn — xem khối chú thích đầu file.
function _inRange(v) {
  return !!v && v.major === 3 && v.minor >= MIN_MINOR && v.minor <= MAX_MINOR;
}

let _cache = null;

// Trả { cmd, args, from, version, hasU2 } của bản TỐT NHẤT, hoặc null nếu không có python nào
// chạy nổi. Thứ tự ưu tiên:
//   1. Bản IMPORT ĐƯỢC uiautomator2  — bằng chứng, thắng tuyệt đối
//   2. Bản nằm trong khoảng quen thuộc — để câu hướng dẫn `pip install` trỏ đúng bản nên dùng
//   3. Bản bất kỳ chạy được          — để preflight nói "thiếu thư viện" thay vì "không có Python"
function findPython({ fresh = false } = {}) {
  if (_cache !== null && !fresh) return _cache;
  let trongKhoang = null;
  let chayDuoc = null;
  for (const c of _candidates()) {
    const v = _version(c);
    if (!v) continue;
    const found = { cmd: c.cmd, args: c.args, from: c.from, version: v, hasU2: false };
    if (!chayDuoc) chayDuoc = found;
    if (_inRange(v) && !trongKhoang) trongKhoang = found;
    // Thử import cho MỌI bản chạy được, không loại theo phiên bản.
    if (_hasU2(c)) {
      found.hasU2 = true;
      _cache = found;
      return _cache;
    }
  }
  _cache = trongKhoang || chayDuoc || null;
  return _cache;
}

// Câu lệnh cài thư viện cho ĐÚNG bản Python đã chọn. Quan trọng: `pip install` trần rất dễ rơi
// vào một bản Python khác bản mà app sẽ chạy, rồi app vẫn báo thiếu thư viện — người dùng cài
// đi cài lại mà không hiểu vì sao.
function installCommand(py) {
  if (!py) return 'py -m pip install -r requirements.txt';
  const phan = [py.cmd, ...py.args].join(' ');
  return `${phan} -m pip install -r requirements.txt`;
}

function _resetForTest() { _cache = null; }

module.exports = { findPython, installCommand, MIN_MINOR, MAX_MINOR, _inRange, _resetForTest };
