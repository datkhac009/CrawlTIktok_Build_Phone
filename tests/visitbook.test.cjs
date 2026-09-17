// tests/visitbook.test.cjs — sổ chống ghé trùng qua ngày.
//
// VÌ SAO PHẢI CÓ (2026-09-17): chống ghé trùng QUA NGÀY trước giờ không tồn tại ở cả hai app —
// bản PC chỉ chống trùng trong một lượt chạy, sổ `quality_channels.txt` thì chỉ ghi chứ không
// đọc lại. Sổ này là thứ duy nhất giữ trí nhớ đó, nên nó sai là cả farm ghé lại đúng những kênh
// vừa ghé hôm qua mà không ai nhìn ra — hỏng câm.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const vb = require('../src/visitbook.cjs');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function thuMucMoi() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'visitbook-'));
}
const NGAY = (s) => new Date(s + 'T12:00:00');

// ── 1. Ghi rồi đọc lại ──
{
  const d = thuMucMoi();
  check('1. Chưa ghi gì thì chưa từng ghé', vb.lastVisit(d, '@abc') === '');
  check('1b. Ghi được', vb.record(d, '@abc', NGAY('2026-09-17')) === true);
  check('1c. Đọc lại đúng ngày', vb.lastVisit(d, '@abc') === '2026-09-17');
  check('1d. Kênh khác không bị lây', vb.lastVisit(d, '@xyz') === '');
}

// ── 2. @handle chuẩn hoá bằng ĐÚNG hàm mà mọi nơi khác dùng ──
// Handle TikTok không phân biệt hoa thường. Ghi '@Hira' rồi hỏi '@hira' mà trả "chưa ghé" là
// ghé lại đúng người vừa ghé — và đó chính là lỗi mà sổ này sinh ra để chặn.
{
  const d = thuMucMoi();
  vb.record(d, '@Hira', NGAY('2026-09-17'));
  check('2. Hoa thường coi là một', vb.lastVisit(d, '@hira') === '2026-09-17');
  check('2b. Nhận cả dạng URL', vb.lastVisit(d, 'https://www.tiktok.com/@HIRA/video/744') === '2026-09-17');
  check('2c. Nhận cả dạng không có @', vb.lastVisit(d, 'hira') === '2026-09-17');
  check('2d. Rác thì không ghi', vb.record(d, '   ', NGAY('2026-09-17')) === false);
}

// ── 3. Cửa sổ ngày ──
{
  const d = thuMucMoi();
  vb.record(d, '@abc', NGAY('2026-09-10'));
  check('3. Ghé 7 ngày trước, cửa sổ 7 -> ĐƯỢC ghé lại',
    vb.visitedWithin(d, '@abc', 7, NGAY('2026-09-17')) === false);
  check('3b. Ghé 6 ngày trước, cửa sổ 7 -> BỎ QUA',
    vb.visitedWithin(d, '@abc', 7, NGAY('2026-09-16')) === true);
  check('3c. Ghé hôm nay -> BỎ QUA',
    vb.visitedWithin(d, '@abc', 7, NGAY('2026-09-10')) === true);
  check('3d. Ghé 30 ngày trước, cửa sổ 7 -> ĐƯỢC ghé lại',
    vb.visitedWithin(d, '@abc', 7, NGAY('2026-10-10')) === false);
  check('3e. Chưa từng ghé -> ĐƯỢC ghé',
    vb.visitedWithin(d, '@chua-tung', 7, NGAY('2026-09-17')) === false);
}

// ── 4. `0` là TẮT BỘ LỌC, không phải "chặn tất" ──
// ⚠ Quy ước này NGƯỢC với trần follow/tym (ở đó 0 = không làm gì). Hiểu ngược ở đây là cả farm
// ngừng ghé thăm mà không ai biết vì sao — đúng loại hỏng câm mà QĐ-38 nói tới.
{
  const d = thuMucMoi();
  vb.record(d, '@abc', NGAY('2026-09-17'));
  check('4. days=0 -> tắt lọc, vẫn cho ghé', vb.visitedWithin(d, '@abc', 0, NGAY('2026-09-17')) === false);
  check('4b. days âm -> cũng là tắt', vb.visitedWithin(d, '@abc', -5, NGAY('2026-09-17')) === false);
  check('4c. days rác -> tắt, không ném', vb.visitedWithin(d, '@abc', 'ba', NGAY('2026-09-17')) === false);
}

// ── 5. Lấy lượt ghé GẦN NHẤT, không phải lượt đầu ──
{
  const d = thuMucMoi();
  vb.record(d, '@abc', NGAY('2026-09-01'));
  vb.record(d, '@abc', NGAY('2026-09-16'));
  vb.record(d, '@abc', NGAY('2026-09-05'));   // ghi lộn xộn, không theo thứ tự thời gian
  check('5. Lấy ngày mới nhất dù ghi lộn xộn', vb.lastVisit(d, '@abc') === '2026-09-16');
  check('5b. Cửa sổ tính theo ngày mới nhất',
    vb.visitedWithin(d, '@abc', 7, NGAY('2026-09-17')) === true);
}

// ── 6. File rác không được làm sập ──
// Sổ nằm trong thư mục người dùng mở được, nên phải chịu được sửa tay.
{
  const d = thuMucMoi();
  fs.writeFileSync(vb.filePath(d), [
    '# ghi chu',
    '@abc\t2026-09-16',
    'thieu-cot',
    '@loi\tkhong-phai-ngay',
    '',
    '@abc\t2026-09-17',
  ].join('\n'), 'utf8');
  check('6. Bỏ qua dòng rác, vẫn đọc được dòng lành', vb.lastVisit(d, '@abc') === '2026-09-17');
  check('6b. Dòng có ngày hỏng không thành "đã ghé"', vb.lastVisit(d, '@loi') === '');
  check('6c. Không ném khi thư mục không tồn tại',
    vb.lastVisit(path.join(d, 'khong-co'), '@abc') === '');
}

// ── 7. Dồn file ──
{
  const d = thuMucMoi();
  const dong = [];
  for (let i = 0; i < vb.COMPACT_AT + 10; i++) {
    dong.push(`@u${i}\t${i % 2 ? '2026-09-16' : '2020-01-01'}`);
  }
  fs.writeFileSync(vb.filePath(d), dong.join('\n'), 'utf8');
  const bo = vb.compactIfNeeded(d, NGAY('2026-09-17'));
  check('7. Dồn khi quá dài, bỏ dòng quá cũ', bo > 0, `bỏ ${bo} dòng`);
  check('7b. Giữ lại dòng gần đây', vb.lastVisit(d, '@u1') === '2026-09-16');
  check('7c. Dòng quá cũ đã bị bỏ', vb.lastVisit(d, '@u0') === '');

  const d2 = thuMucMoi();
  vb.record(d2, '@abc', NGAY('2026-09-17'));
  check('7d. File ngắn thì KHÔNG dồn', vb.compactIfNeeded(d2, NGAY('2026-09-17')) === 0);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
process.exit(failed.length ? 1 : 0);
