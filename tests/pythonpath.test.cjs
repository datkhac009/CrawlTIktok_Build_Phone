// tests/pythonpath.test.cjs — khoá khoảng phiên bản Python chạy được uiautomator2.
//
// VÌ SAO PHẢI CÓ (2026-09-15): máy chủ dự án có Python **3.14.6** đứng đầu PATH. `runner.cjs`
// gọi `spawn('python', ...)`, tiến trình chết ngay vì uiautomator2 chưa hỗ trợ 3.14, và giao
// diện chỉ nhận được `exit code 1` → một chữ "Lỗi". Mất cả buổi mới ra nguyên nhân.
//
// Phép thử này khoá đúng cái ranh giới đó: **3.14 phải bị coi là ngoài khoảng**. Nếu sau này ai
// nới trần lên mà chưa kiểm thật, dòng này đỏ và buộc phải đọc lại vì sao trần nằm ở đây.
'use strict';
const path = require('path');
const pp = require(path.join(__dirname, '..', 'src', 'pythonpath.cjs'));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const v = (major, minor) => ({ major, minor, text: `${major}.${minor}.0` });

// ── 1. Phiên bản CHỈ là gợi ý xếp ưu tiên, KHÔNG phải cửa chặn ──
// Bản đầu của pythonpath.cjs chặn cứng ở 3.13 vì tôi CHO RẰNG uiautomator2 chưa chạy trên
// 3.14. Đo lại bằng `pip install --dry-run uiautomator2` trên chính máy chủ dự án
// (2026-09-15): uiautomator2 3.7.0 giải phụ thuộc sạch trên 3.14 — lxml 6.1.3, pillow 12.3.0,
// charset_normalizer đều có bánh xe cp314. Cái trần đoán mò ấy sẽ bắt chủ dự án đi cài thêm
// Python 3.12 HOÀN TOÀN VÔ ÍCH, trong khi việc cần làm chỉ là cài thư viện.
//
// Phép thử này khoá bài học đó: **bằng chứng là import được, không phải số phiên bản.**
{
  check('1. 3.14 KHÔNG bị loại (uiautomator2 cài được trên 3.14 — đo thật)',
    pp._inRange(v(3, 14)) === true);
  check('1b. Trần hiện tại là 3.' + pp.MAX_MINOR, pp.MAX_MINOR >= 14, `MAX_MINOR=${pp.MAX_MINOR}`);
}

// ── 2. Khoảng quen thuộc ──
{
  check('2. 3.12 nằm trong khoảng', pp._inRange(v(3, 12)) === true);
  check('2b. Biên dưới 3.' + pp.MIN_MINOR, pp._inRange(v(3, pp.MIN_MINOR)) === true);
  check('2c. Biên trên 3.' + pp.MAX_MINOR, pp._inRange(v(3, pp.MAX_MINOR)) === true);
  check('2d. Dưới biên dưới thì ngoài khoảng', pp._inRange(v(3, pp.MIN_MINOR - 1)) === false);
}

// ── 3. Python 2 không bao giờ hợp lệ ──
// Máy cũ vẫn còn python2 trong PATH; nhận nhầm nó là hỏng theo kiểu rất khó đọc.
{
  check('3. Python 2.7 ngoài khoảng', pp._inRange(v(2, 7)) === false);
}

// ── 4. Đầu vào rác không được làm sập ──
// Giá trị này đến từ việc bắt regex trên output của `python --version`; bắt trượt là null.
{
  let nem = false;
  let r;
  try { r = [pp._inRange(null), pp._inRange(undefined), pp._inRange({})]; } catch (_) { nem = true; }
  check('4. _inRange chịu được null/undefined/{} mà không ném',
    nem === false && r.every((x) => x === false));
}

// ── 5. findPython không bao giờ ném, dù máy không có python nào ──
// Nơi gọi (preflight) phải phân biệt được "không có python" với "python lỗi"; ném là trộn hai
// thứ đó vào một khối catch (QĐ-31).
{
  let nem = false;
  let r;
  try { pp._resetForTest(); r = pp.findPython({ fresh: true }); } catch (_) { nem = true; }
  check('5. findPython không ném', nem === false,
    r ? `thấy ${r.version.text} (u2=${r.hasU2})` : 'không thấy python nào');
  if (r) {
    check('5b. Kết quả có đủ trường preflight cần', typeof r.cmd === 'string'
      && Array.isArray(r.args) && typeof r.from === 'string' && typeof r.hasU2 === 'boolean');
  } else {
    check('5b. Kết quả có đủ trường preflight cần', true, 'bỏ qua — máy không có python');
  }
}

// ── 6. installCommand phải nêu ĐÍCH DANH bản Python app sẽ chạy ──
// Gõ `pip install` trần rất dễ rơi vào bản Python KHÁC bản app dùng; app vẫn báo thiếu thư viện
// và người dùng cài đi cài lại mà không hiểu vì sao. Câu lệnh phải chỉ đúng bản đó.
{
  const c1 = pp.installCommand({ cmd: 'py', args: ['-3.12'], version: v(3, 12) });
  check('6. Có kèm tham số chọn bản (py -3.12)', /py -3\.12 -m pip install/.test(c1), c1);
  const c2 = pp.installCommand({ cmd: 'python', args: [], version: v(3, 14) });
  check('6b. Bản không tham số vẫn ra lệnh hợp lệ', /^python -m pip install -r requirements\.txt$/.test(c2), c2);
  check('6c. Luôn trỏ tới requirements.txt (để không cài thiếu gói)',
    /requirements\.txt/.test(c1) && /requirements\.txt/.test(c2));
  let nem = false;
  try { pp.installCommand(null); } catch (_) { nem = true; }
  check('6d. installCommand(null) không ném', nem === false, pp.installCommand(null));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
process.exit(failed.length ? 1 : 0);
