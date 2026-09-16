// src/daycount.cjs — Bộ đếm "đã làm bao nhiêu lần hôm nay", ghi xuống đĩa.
//
// VÌ SAO PHẢI CÓ (2026-09-15):
// Trần follow đọc được từ `channelstore` vì mỗi kênh follow một lần và sổ có ghi `followedAt`.
// **Tym thì không**: cùng một kênh tym nhiều video khác nhau, và sổ không có chỗ ghi.
//
// Đếm trong RAM là **tắt app mở lại về 0**. Chủ dự án mở lại app vài lần một ngày là chuyện
// thường — đúng cái bẫy đã phải tránh ở `followquota.cjs`. Nên đếm phải nằm trên đĩa.
//
// ⚠ KHÔNG sửa `channelstore.cjs` để nhét thêm loại sự kiện mới vào đó: file ấy dùng chung với
// bản PC và đang bị `tests/srcsync.test.cjs` khoá từng byte. Sửa là lệch, mà lệch âm thầm giữa
// hai app chính là thứ đã xảy ra với `linkkey.cjs`.
//
// Định dạng: mỗi dòng một sự kiện, `YYYY-MM-DD<TAB>khoá`. Append-only nên ghi rất rẻ và không
// bao giờ mất dữ liệu giữa chừng; dồn file khi quá dài.
'use strict';

const path = require('path');
const { appendLines, readLines, rewriteAll } = require('./textset.cjs');

const FILE_NAME = 'day_counts.txt';
const COMPACT_AT = 5000;     // số dòng thì dồn lại, chỉ giữ hôm nay

function filePath(dir) { return path.join(dir, FILE_NAME); }

// Ngày theo GIỜ ĐỊA PHƯƠNG — khớp `channelstore.today()` và `followquota.today()`. Lệch sang
// UTC là trần ngày đổi lúc 7 giờ sáng thay vì nửa đêm.
function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Ghi một lần đã làm. Trả true nếu ghi được.
function record(dir, key, now = new Date()) {
  const k = String(key || '').trim();
  if (!dir || !k) return false;
  try {
    appendLines(filePath(dir), [`${today(now)}\t${k}`]);
    return true;
  } catch (_) {
    return false;            // ghi hỏng thì thôi, KHÔNG ném — nơi gọi đang ở giữa vòng quét
  }
}

// Đếm số lần `key` đã làm trong ngày `now`.
function count(dir, key, now = new Date()) {
  const k = String(key || '').trim();
  if (!dir || !k) return 0;
  const hn = today(now);
  let n = 0;
  let lines;
  try { lines = readLines(filePath(dir)); } catch (_) { return 0; }
  for (const line of lines) {
    if (!line || line[0] === '#') continue;
    const t = line.split('\t');
    // Dòng rác thì bỏ qua, không được làm sập — file này có thể bị sửa tay.
    if (t.length < 2) continue;
    if (t[0] === hn && t[1] === k) n++;
  }
  return n;
}

// Còn bao nhiêu lượt. `cap <= 0` nghĩa là TẮT, trả 0.
//
// ⚠ 0 ở đây là "không làm", KHÔNG phải "không giới hạn". Hiểu ngược là bấm tym vô hạn lên tài
// khoản thật. Cùng quy ước với `followquota.canFollow`.
function remaining(dir, key, cap, now = new Date()) {
  const c = Math.max(0, parseInt(cap, 10) || 0);
  if (c <= 0) return 0;
  return Math.max(0, c - count(dir, key, now));
}

// Dồn file khi quá dài: chỉ giữ lại các dòng của HÔM NAY. Ngày cũ không còn ai hỏi tới.
function compactIfNeeded(dir, now = new Date()) {
  let lines;
  try { lines = readLines(filePath(dir)); } catch (_) { return 0; }
  if (lines.length < COMPACT_AT) return 0;
  const hn = today(now);
  const giu = lines.filter((l) => l && l.split('\t')[0] === hn);
  try {
    rewriteAll(filePath(dir), giu);
    return lines.length - giu.length;
  } catch (_) {
    return 0;
  }
}

module.exports = { FILE_NAME, COMPACT_AT, filePath, today, record, count, remaining, compactIfNeeded };
