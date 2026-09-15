// tests/adbpath.test.cjs — khoá cách tìm adb.exe.
//
// VÌ SAO PHẢI CÓ (2026-09-15): ba file tự viết lấy `../platform-tools/adb.exe`. Chủ dự án copy
// app sang ổ khác thì thư mục đó ở lại, và toàn bộ app chết với đúng một chữ "Lỗi". Phép thử
// này khoá hai điều: (1) thứ tự ưu tiên, (2) **không ném lỗi khi không tìm thấy** — nơi gọi cần
// phân biệt "chưa có adb" với "adb chạy lỗi", nếu ném thì hai thứ trộn vào cùng một catch.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// Dựng một thư mục giả làm "thư mục app" để không đụng máy thật.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adbpath-'));
process.env.PORTABLE_EXECUTABLE_DIR = TMP;   // paths.getBaseDir() ưu tiên biến này

const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';
const ap = require(path.join(__dirname, '..', 'src', 'adbpath.cjs'));

function lam(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'gia lam adb');
  return p;
}

// ── 1. Không có gì cả thì trả null / chuỗi rỗng, KHÔNG ném ──
{
  delete process.env.ADB_PATH;
  ap._resetForTest();
  let nem = false;
  let r;
  try { r = ap.findAdb({ fresh: true }); } catch (_) { nem = true; }
  // Máy chạy test có thể có adb thật trong PATH hoặc của 效卫 — nên chỉ khẳng định phần
  // KHÔNG ném. Đó mới là hợp đồng, còn tìm thấy hay không phụ thuộc máy.
  check('1. findAdb không ném khi không có adb trong thư mục app', nem === false,
    r ? `thấy ở: ${r.from}` : 'không thấy (đúng, máy này không có adb nào)');
  check('1b. adbPath() trả chuỗi khi không thấy', typeof ap.adbPath() === 'string');
}

// ── 2. platform-tools TRONG thư mục app thắng platform-tools CẠNH thư mục app ──
// Đây chính là hình dạng của sự cố: bản "cạnh app" là bản cũ kiểu D:\ADB, còn bản "trong app"
// là bản đi theo bản build. Bản đi theo phải thắng, nếu không app vẫn phụ thuộc thư mục ngoài.
{
  const canh = lam(path.join(TMP, '..', path.basename(TMP) + '-canh', 'platform-tools', EXE));
  // "cạnh" đúng nghĩa là TMP/../platform-tools
  const canhThat = lam(path.join(TMP, '..', 'platform-tools', EXE));
  const trong = lam(path.join(TMP, 'platform-tools', EXE));
  ap._resetForTest();
  const r = ap.findAdb({ fresh: true });
  check('2. Ưu tiên platform-tools TRONG thư mục app',
    !!r && path.resolve(r.path) === path.resolve(trong),
    r ? r.path : 'không thấy');
  fs.rmSync(trong, { force: true });
  ap._resetForTest();
  const r2 = ap.findAdb({ fresh: true });
  check('2b. Gỡ bản trong app thì rơi về bản cạnh app (kiểu cũ vẫn chạy)',
    !!r2 && path.resolve(r2.path) === path.resolve(canhThat),
    r2 ? `${r2.path} (${r2.from})` : 'không thấy');
  fs.rmSync(canhThat, { force: true });
  fs.rmSync(canh, { force: true });
}

// ── 3. ADB_PATH thắng tất cả ──
// Đường thoát cuối cùng cho máy bày đặt khác thường. Nếu nó không thắng thì nó vô dụng.
{
  const rieng = lam(path.join(TMP, 'rieng', 'adb-cua-toi.exe'));
  lam(path.join(TMP, 'platform-tools', EXE));
  process.env.ADB_PATH = rieng;
  ap._resetForTest();
  const r = ap.findAdb({ fresh: true });
  check('3. ADB_PATH thắng mọi ứng viên khác',
    !!r && path.resolve(r.path) === path.resolve(rieng), r ? r.path : 'không thấy');
  check('3b. Nguồn được ghi lại để preflight nói cho người dùng biết',
    !!r && /ADB_PATH/.test(r.from), r ? r.from : '');
  delete process.env.ADB_PATH;
}

// ── 4. ADB_PATH trỏ vào file KHÔNG tồn tại thì bỏ qua, không kẹt ──
// Bẫy thật: người dùng gõ sai đường dẫn rồi tưởng app hỏng. Phải rơi xuống ứng viên kế tiếp.
{
  process.env.ADB_PATH = path.join(TMP, 'khong-he-co-file-nay.exe');
  ap._resetForTest();
  const r = ap.findAdb({ fresh: true });
  check('4. ADB_PATH sai thì bỏ qua và dò tiếp',
    !!r && !/ADB_PATH/.test(r.from), r ? r.from : 'không thấy (vẫn chấp nhận được)');
  delete process.env.ADB_PATH;
}

// ── 5. Có nhớ kết quả, và `fresh` ép dò lại ──
{
  ap._resetForTest();
  const a = ap.findAdb({ fresh: true });
  const b = ap.findAdb();
  check('5. Lần gọi sau dùng lại kết quả đã nhớ', a === b);
}

// ── 6. adbVersion với đường dẫn rác trả null, không ném ──
// Nơi gọi in thẳng giá trị này ra giao diện; ném ở đây là vỡ cả bảng preflight.
{
  let nem = false;
  let v;
  try { v = ap.adbVersion(path.join(TMP, 'khong-co.exe')); } catch (_) { nem = true; }
  check('6. adbVersion không ném với đường dẫn hỏng', nem === false && v === null, `trả ${v}`);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
try { fs.rmSync(path.join(TMP, '..', 'platform-tools'), { recursive: true, force: true }); } catch (_) {}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
process.exit(failed.length ? 1 : 0);
