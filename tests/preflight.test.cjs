// tests/preflight.test.cjs — khoá hợp đồng của bảng chẩn đoán.
//
// VÌ SAO PHẢI CÓ (2026-09-15): chủ dự án mở app, máy 104 hiện đúng một chữ **"Lỗi"**. Thực tế
// có BA nguyên nhân cùng lúc (thiếu adb, thiếu uiautomator2, Python 3.14) — ba câu sửa khác
// hẳn nhau. Bảng preflight sinh ra để thay chữ "Lỗi" đó.
//
// Hợp đồng bị khoá ở đây, theo đúng QĐ-29/30/31:
//   - Mục ĐỎ thì BẮT BUỘC có câu sửa. Một dòng đỏ không kèm cách sửa chỉ làm người đọc bế tắc.
//   - Không bao giờ ném ra ngoài: một mục hỏng không được che mất các mục còn lại.
//   - Không đẻ nhiều dòng đỏ cho cùng MỘT nguyên nhân (thiếu adb ⇒ đúng một dòng, không phải
//     ba dòng "mất kết nối / chưa cài TikTok / không đọc được phiên bản").
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
process.env.PORTABLE_EXECUTABLE_DIR = TMP;

const pf = require(path.join(__dirname, '..', 'src', 'preflight.cjs'));

(async () => {
  // ── 1. checkHost: mọi mục đỏ phải có câu sửa ──
  {
    const r = await pf.checkHost();
    check('1. checkHost trả danh sách mục', Array.isArray(r.items) && r.items.length >= 2,
      `${r.items.length} mục`);
    const doThieuSua = r.items.filter((x) => !x.ok && !x.fix);
    check('1b. MỌI mục đỏ đều kèm câu sửa', doThieuSua.length === 0,
      doThieuSua.map((x) => x.label).join(', '));
    check('1c. `ok` tổng bằng AND của các mục',
      r.ok === r.items.every((x) => x.ok));
    const khoa = r.items.map((x) => x.key);
    check('1d. Có mục adb và mục python', khoa.includes('adb') && khoa.includes('python'),
      khoa.join(', '));
  }

  // ── 2. Không có adb ⇒ ĐÚNG MỘT dòng đỏ, không phải một chuỗi dòng đỏ ăn theo ──
  // Ép bằng ADB_PATH trỏ vào file không tồn tại + thư mục app rỗng. Nếu máy chạy test vẫn có
  // adb thật (của 效卫 chẳng hạn) thì ca này không dựng được — khi đó bỏ qua, đừng báo đỏ oan.
  {
    const ap = require(path.join(__dirname, '..', 'src', 'adbpath.cjs'));
    ap._resetForTest();
    const co = ap.findAdb({ fresh: true });
    if (co) {
      check('2. Thiếu adb ⇒ đúng một dòng đỏ', true, 'bỏ qua — máy này có adb thật');
    } else {
      const r = await pf.checkDevice('192.168.9.99:5555');
      const do_ = r.items.filter((x) => !x.ok);
      check('2. Thiếu adb ⇒ đúng một dòng đỏ, không đẻ thêm dòng ăn theo',
        do_.length === 1 && do_[0].key === 'adb', do_.map((x) => x.key).join(', '));
    }
  }

  // ── 3. Máy không tồn tại: đỏ, có lý do, có câu sửa, và KHÔNG ném ──
  {
    let nem = false;
    let r;
    try {
      r = await pf.checkDevice('192.168.99.99:5555');
    } catch (_) { nem = true; }
    check('3. checkDevice không ném với máy không tồn tại', nem === false);
    if (r) {
      const do_ = r.items.filter((x) => !x.ok);
      check('3b. Có ít nhất một mục đỏ', do_.length >= 1);
      check('3c. Mục đỏ nào cũng có lý do và câu sửa',
        do_.every((x) => x.detail && x.fix), do_.map((x) => x.key).join(', '));
      check('3d. Serial dạng IP thì câu sửa nhắc `adb connect`',
        do_.some((x) => /connect|adb/i.test(x.fix)));
    }
  }

  // ── 4. checkAll gộp cả máy tính lẫn thiết bị ──
  {
    const r = await pf.checkAll('192.168.99.99:5555');
    const khoa = r.items.map((x) => x.key);
    check('4. checkAll có cả mục máy tính và mục thiết bị',
      khoa.includes('python') && (khoa.includes('online') || khoa.includes('adb')),
      khoa.join(', '));
  }

  // ── 5. versionWarnings — CẢNH BÁO, không phải lỗi ──
  // Cả farm lệch phiên bản TikTok là mỗi máy một kiểu chữ trên nút. Triệu chứng sẽ là "máy này
  // chạy máy kia không", rất khó đoán ra nếu không ai nói.
  {
    check('5. Cùng phiên bản thì không cảnh báo',
      pf.versionWarnings([{ serial: 'a', tiktokVersion: '46.1.1' },
        { serial: 'b', tiktokVersion: '46.1.1' }]).length === 0);

    const w = pf.versionWarnings([
      { name: 'May 1', tiktokVersion: '46.1.1' },
      { name: 'May 2', tiktokVersion: '46.1.1' },
      { name: 'May 3', tiktokVersion: '46.9.3' },
    ]);
    check('5b. Máy lệch thì bị nêu tên', w.length === 1 && /May 3/.test(w[0]), w[0] || '');
    check('5c. Cảnh báo nói rõ phần lớn farm đang ở bản nào', /46\.1\.1/.test(w[0] || ''));

    check('5d. Dưới hai máy có phiên bản thì không cảnh báo',
      pf.versionWarnings([{ serial: 'a', tiktokVersion: '46.1.1' }]).length === 0);
    check('5e. Danh sách rỗng / null không làm sập',
      pf.versionWarnings([]).length === 0 && pf.versionWarnings(null).length === 0);
    check('5f. Máy chưa đọc được phiên bản thì bị bỏ qua, không tính là lệch',
      pf.versionWarnings([{ serial: 'a', tiktokVersion: '46.1.1' },
        { serial: 'b', tiktokVersion: '' },
        { serial: 'c', tiktokVersion: null }]).length === 0);
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
  process.exit(failed.length ? 1 : 0);
})();
