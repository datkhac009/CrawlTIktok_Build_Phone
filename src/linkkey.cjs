// src/linkkey.cjs — Chuẩn hóa link sound, dùng CHUNG cho lọc trùng khi đẩy Google Sheet.
// Link của app này đã ở dạng /music/original-sound-<id> nên rút gọn khớp hoàn toàn.
'use strict';

// Rút gọn link sound về /music/original-sound-<id>: TikTok đôi khi nhét tên user vào slug
// nhưng resolve theo ID số ở cuối. Rút gọn để cùng 1 sound (2 slug khác nhau) không bị
// tính là 2. Chỉ rút gọn slug original-sound / nhạc-nền; link bản quyền giữ nguyên.
function canonicalSoundUrl(u) {
  const clean = String(u || '').trim().split(/[?#]/)[0].replace(/\/+$/, '');
  let dec = clean;
  try { dec = decodeURIComponent(clean); } catch (_) {}
  const m = dec.match(/\/music\/([^/]*)-(\d{8,})$/);
  if (!m) return clean;
  const slug = m[1].toLowerCase();
  if (!slug.startsWith('original-sound') && !slug.startsWith('nhạc-nền') && slug !== 'x') return clean;
  return `https://www.tiktok.com/music/original-sound-${m[2]}`;
}

// Khóa so trùng: rút gọn rồi đồng nhất hoa/thường.
function normalizeKey(u) {
  return canonicalSoundUrl(u).toLowerCase();
}

module.exports = { canonicalSoundUrl, normalizeKey };
