// src/textset.cjs — Phần CƠ HỌC dùng chung cho các kho dữ liệu dạng file text cạnh .exe
// (hoặc trong thư mục profile). Tách ra 2026-08-22 khi cần kho thứ hai (danh sách kênh).
//
// VÌ SAO PHẢI TÁCH: `linkstore.cjs` giữ `_keys` và `FILE_NAME` ở **cấp module**, mà `require()`
// cache module lại, nên mọi nơi require đều dùng CHUNG một biến — không thể tạo instance thứ
// hai trỏ file khác. Chép nguyên file ra rồi đổi tên là cách nhanh nhất, và cũng là cách chắc
// chắn nhất để hai bản lệch nhau sau vài tháng (bài học QĐ-10: crawler được sửa, sheets thì
// không, nút đẩy bù coi link dài và link ngắn là 2 sound khác nhau).
//
// ⚠ `linkstore` đang gác hơn 424.000 link — nó là bộ lọc trùng của toàn hệ thống. Vì vậy
// module này được viết để `linkstore` chỉ việc BỌC lại, giữ nguyên 7 tên export cũ, và
// `tests/linkstore.test.cjs` (17 phép thử) là lưới an toàn cho việc bọc đó.
'use strict';

const fs = require('fs');

// ── Ghi NỐI ĐUÔI, không bao giờ ghi đè cả file ──
// Ghi đè cả file nghĩa là có một khoảnh khắc file rỗng; tắt máy đúng lúc đó là mất sạch.
// Append thì tệ nhất chỉ mất dòng đang ghi dở.
//
// Trước khi ghi phải dò 1 BYTE CUỐI để biết có cần chèn '\n' hay không: người dùng mở file
// dán tay rồi lưu mà thiếu dòng trống cuối là chuyện thường, và nếu không chèn thì dòng mới
// dính liền vào dòng cũ thành một chuỗi rác.
function appendLines(filePath, lines) {
  if (!lines || !lines.length) return true;
  let needNewline = false;
  try {
    const st = fs.statSync(filePath);
    if (st.size > 0) {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, st.size - 1);
      fs.closeSync(fd);
      needNewline = buf.toString('utf8') !== '\n';
    }
  } catch (_) { /* chưa có file → không cần chèn gì */ }
  fs.appendFileSync(filePath, (needNewline ? '\n' : '') + lines.join('\n') + '\n', 'utf8');
  return true;
}

// Đọc file thành mảng dòng, đã bỏ dòng trống và dòng ghi chú `#`. File chưa có → mảng rỗng.
function readLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('#'));
  } catch (_) {
    return [];
  }
}

// Ghi đè TRỌN file — chỉ dùng khi NÉN nhật ký, không dùng cho đường ghi thường.
// Ghi ra file tạm rồi đổi tên: đổi tên là thao tác nguyên tử trên cùng ổ đĩa, nên không có
// khoảnh khắc nào file đích rỗng hay dở dang.
function rewriteAll(filePath, lines, header) {
  const tmp = filePath + '.tmp';
  const body = (header ? header + '\n' : '') + lines.join('\n') + (lines.length ? '\n' : '');
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, filePath);
}

// ── Kho TẬP HỢP chuỗi (mỗi dòng một mục, đã chuẩn hóa) ──
// Đây là hình dạng mà `linkstore` cần. Kho kênh dùng hình dạng khác (nhật ký sự kiện) nên nó
// chỉ dùng 3 hàm cơ học ở trên, không dùng factory này.
//
//   getPath  : hàm trả về đường dẫn file (tiêm vào để test đổi được chỗ ghi)
//   normalize: hàm chuẩn hóa MỘT mục — dùng chung cho cả lúc nạp lẫn lúc ghi
//   header   : phần ghi chú đầu file khi tạo mới
//   label    : tên hiện trong log lỗi
function createStore({ getPath, normalize, header = '', label = 'store' }) {
  // Tập đã nạp (null = chưa nạp lần nào). Nằm TRONG closure nên mỗi kho một tập riêng —
  // đây chính là điều mà bản cũ không làm được.
  let _keys = null;

  function getFilePath() { return getPath(); }

  function load(force = false) {
    if (_keys && !force) return _keys;
    const set = new Set();
    for (const line of readLines(getFilePath())) {
      const k = normalize(line);
      if (k) set.add(k);
    }
    _keys = set;
    return _keys;
  }

  function count() { return load().size; }
  function all() { return [...load()]; }

  function addUrls(urls) {
    const set = load();
    const fresh = [];
    for (const u of (urls || [])) {
      const k = normalize(u);
      if (!k || set.has(k)) continue;
      set.add(k);
      fresh.push(k);
    }
    if (!fresh.length) return 0;
    try {
      appendLines(getFilePath(), fresh);
    } catch (e) {
      // Ghi lỗi → gỡ khỏi tập trong bộ nhớ để lần sau còn thử ghi lại, tránh tình trạng
      // "bộ nhớ bảo đã có, đĩa thì chưa" khiến mục biến mất vĩnh viễn khỏi kho.
      for (const k of fresh) set.delete(k);
      console.error(`[${label}] Không ghi được kho:`, e.message);
      return 0;
    }
    return fresh.length;
  }

  function ensureFile() {
    const f = getFilePath();
    if (fs.existsSync(f)) return f;
    try { fs.writeFileSync(f, header, 'utf8'); } catch (e) {
      console.error(`[${label}] Không tạo được kho:`, e.message);
    }
    return f;
  }

  return { getFilePath, load, count, all, addUrls, ensureFile };
}

module.exports = { createStore, appendLines, readLines, rewriteAll };
