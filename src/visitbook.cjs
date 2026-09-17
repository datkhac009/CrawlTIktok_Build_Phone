// src/visitbook.cjs — Sổ "đã ghé kênh nào, ngày nào", ghi xuống đĩa theo từng máy.
//
// VÌ SAO PHẢI CÓ (2026-09-17):
// Chống ghé trùng trước giờ KHÔNG tồn tại ở cả hai app. Bản PC chỉ chống trùng trong MỘT lượt
// chạy (`visitqueue.visited`, sống trong RAM, chết theo lượt chạy). Sổ `quality_channels.txt`
// thì chỉ được GHI, không nơi nào đọc lại — nên hôm sau gặp lại đúng kênh đó là ghé lại từ đầu.
//
// ⚠ KHÔNG nhét loại sự kiện mới vào `channelstore.cjs`: file ấy dùng chung với bản PC và đang bị
// `tests/srcsync.test.cjs` khoá từng byte. Sửa là lệch, mà lệch âm thầm giữa hai app chính là
// thứ đã xảy ra với `linkkey.cjs`. Đây là cùng một lý do `daycount.cjs` ra đời — xem đầu file đó.
//
// ⚠ KHOÁ THEO `@handle`, KHÔNG THEO TÊN HIỂN THỊ. Hai kênh trùng tên hiển thị là chuyện thường,
// khoá theo tên là coi hai người thành một rồi bỏ qua oan. Bản PC cũng cảnh báo đúng chỗ này khi
// nói về sổ chống follow trùng. `@handle` chỉ đọc được SAU KHI đã mở trang cá nhân — nên nơi gọi
// phải mở trang trước rồi mới hỏi sổ.
//
// Định dạng: mỗi dòng một lượt ghé, `@handle<TAB>YYYY-MM-DD`. Append-only nên ghi rất rẻ và
// không bao giờ mất sạch giữa chừng; dồn file khi quá dài.
'use strict';

const path = require('path');
const { appendLines, readLines, rewriteAll } = require('./textset.cjs');
const { normalizeHandle } = require('./followpolicy.cjs');

const FILE_NAME = 'visited_channels.txt';
const COMPACT_AT = 4000;     // số dòng thì dồn lại
const COMPACT_KEEP_DAYS = 60; // dồn xong giữ lại bấy nhiêu ngày, rộng hơn mọi cửa sổ hỏi thật

function filePath(dir) { return path.join(dir, FILE_NAME); }

// Ngày theo GIỜ ĐỊA PHƯƠNG — khớp `daycount.today()`, `channelstore.today()`,
// `followquota.today()`. Lệch sang UTC là mốc ngày nhảy lúc 7 giờ sáng thay vì nửa đêm.
function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Số ngày giữa hai mốc `YYYY-MM-DD`. Trả null nếu chuỗi không đọc được — nơi gọi coi như
// "không biết" chứ không coi như 0, vì 0 nghĩa là "vừa ghé hôm nay" và sẽ bỏ qua oan.
function cachNgay(cu, moi) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cu) || !/^\d{4}-\d{2}-\d{2}$/.test(moi)) return null;
  const a = Date.parse(cu + 'T00:00:00');
  const b = Date.parse(moi + 'T00:00:00');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

// Ghi một lượt ghé. Trả true nếu ghi được.
function record(dir, handle, now = new Date()) {
  const h = normalizeHandle(handle);
  if (!dir || !h) return false;
  try {
    appendLines(filePath(dir), [`${h}\t${today(now)}`]);
    return true;
  } catch (_) {
    return false;            // ghi hỏng thì thôi, KHÔNG ném — nơi gọi đang ở giữa vòng quét
  }
}

// Ngày ghé GẦN NHẤT của một kênh, hoặc '' nếu chưa từng ghé.
function lastVisit(dir, handle) {
  const h = normalizeHandle(handle);
  if (!dir || !h) return '';
  let lines;
  try { lines = readLines(filePath(dir)); } catch (_) { return ''; }
  let moi = '';
  for (const line of lines) {
    if (!line || line[0] === '#') continue;
    const t = line.split('\t');
    // Dòng rác thì bỏ qua, không được làm sập — file này có thể bị sửa tay.
    if (t.length < 2) continue;
    if (normalizeHandle(t[0]) !== h) continue;
    const ng = String(t[1] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ng)) continue;
    if (ng > moi) moi = ng;           // chuỗi YYYY-MM-DD so sánh được trực tiếp
  }
  return moi;
}

// Đã ghé kênh này trong `days` ngày gần đây chưa?
//
// ⚠ `days <= 0` nghĩa là TẮT chống trùng — luôn trả false, tức cho ghé. Đây là quy ước NGƯỢC với
// trần follow/tym (ở đó 0 = không làm gì cả), nên phải nói rõ: đây là một BỘ LỌC BỎ QUA, tắt bộ
// lọc thì mọi thứ đi qua. Hiểu ngược là cả farm ngừng ghé thăm mà không ai biết vì sao.
function visitedWithin(dir, handle, days, now = new Date()) {
  const n = Math.max(0, parseInt(days, 10) || 0);
  if (n <= 0) return false;
  const cu = lastVisit(dir, handle);
  if (!cu) return false;
  const d = cachNgay(cu, today(now));
  if (d === null) return false;       // không đọc được ngày -> cho ghé, hướng sai an toàn
  return d < n;
}

// Dồn file khi quá dài: bỏ các dòng cũ hơn `COMPACT_KEEP_DAYS` ngày.
function compactIfNeeded(dir, now = new Date()) {
  let lines;
  try { lines = readLines(filePath(dir)); } catch (_) { return 0; }
  if (lines.length < COMPACT_AT) return 0;
  const hn = today(now);
  const giu = lines.filter((l) => {
    if (!l || l[0] === '#') return false;
    const t = l.split('\t');
    if (t.length < 2) return false;
    const d = cachNgay(String(t[1]).trim(), hn);
    return d === null ? true : d <= COMPACT_KEEP_DAYS;   // không đọc được ngày thì GIỮ, đừng xoá mù
  });
  try {
    rewriteAll(filePath(dir), giu);
    return lines.length - giu.length;
  } catch (_) {
    return 0;
  }
}

module.exports = {
  FILE_NAME, COMPACT_AT, COMPACT_KEEP_DAYS,
  filePath, today, cachNgay, record, lastVisit, visitedWithin, compactIfNeeded,
};
