// src/linkkey.cjs — Chuẩn hóa link sound, dùng CHUNG cho crawler.cjs (lọc trùng khi quét,
// bộ lọc "Chỉ lấy Original Sound") và sheets.cjs (lọc trùng khi đẩy lên Google Sheet).
//
// Vì sao tách riêng (2026-07-16): trước đây mỗi file giữ một bản copy normalizeKey và đã
// LỆCH NHAU thật — 2026-07-12 crawler được thêm rút gọn link nhưng bản trong sheets.cjs
// không được cập nhật theo → nút đẩy bù coi link dài (cũ trên Sheet) và link ngắn (mới)
// là 2 sound khác nhau → đẩy trùng. Một nguồn duy nhất thì không bao giờ lệch nữa.
'use strict';

// ════════ "Original sound" theo NGÔN NGỮ GIAO DIỆN (2026-08-21, QĐ-23) ════════
//
// TikTok dịch chữ "original sound" theo ngôn ngữ của tài khoản đang xem, và slug trong link
// lấy đúng cái tên đã dịch đó. Cùng một loại sound ra hàng chục dạng:
//
//   profile Anh       → /music/original-sound-7419...
//   profile Pháp      → /music/son-original-<tên user>-7440...
//   profile Hàn       → /music/오리지널-사운드-<tên user>-7658...
//   profile Indonesia → /music/suara-asli-<tên user>-7642...
//
// Trước 2026-08-21 danh sách chỉ có tiếng Anh + tiếng Việt nên mọi dạng còn lại KHÔNG được
// rút gọn. Hai hậu quả, cái thứ hai nặng hơn cái người dùng nhìn thấy:
//   1. Link trên Sheet mang cả tên user + emoji — dài, khó đọc, khó dò tay.
//   2. Cùng MỘT sound do 2 profile khác quốc gia quét ra 2 key khác nhau → lọt bộ lọc
//      trùng → đẩy 2 dòng. Chạy nhiều máy với profile nhiều quốc gia thì đây là rò rỉ
//      liên tục, không phải trường hợp hiếm.
//
// ⚠ ĐÂY LÀ NGUỒN DUY NHẤT của danh sách này (bài học QĐ-10). crawler.cjs KHÔNG giữ bản
// copy — nó import isOriginalSound() từ file này. Thêm ngôn ngữ mới thì sửa ĐÚNG chỗ này.
//
// Viết dạng có DẤU CÁCH và CHỮ THƯỜNG. Bên dưới tự suy ra dạng slug (dấu cách → '-').

// Nhóm A — ĐÃ THẤY THẬT trong dữ liệu (Google Sheet của dự án, soát 2026-08-21).
const _LABELS_SEEN = [
  'original sound',      // en — dạng chuẩn, đích của phép rút gọn
  'nhạc nền',            // vi — có trong mã từ trước
  // vi — THÊM 2026-09-18. Đo trên farm điện thoại (`probe_screen.py --origin`, TikTok 46.9.3):
  // 3/8 sound gốc có slug `âm-thanh-gốc-<tên user>`. Thiếu nhãn này thì (1) sound gốc có tên
  // lẫn link đều tiếng Việt bị coi là "không phải Original Sound" và BỊ BỎ, và (2) cùng một
  // sound ra hai khoá lọc trùng — `âm-thanh-gốc-lajico-7633…` và `original-sound-7633…`.
  'âm thanh gốc',
  'son original',        // fr
  'suara asli',          // id / ms
  'som original',        // pt
  '오리지널 사운드',        // ko
  'originalton',         // de
  'الصوت الأصلي',          // ar
  // THÊM 2026-09-21 — đo trên kho link THẬT của farm điện thoại (`known_links.txt`, 338.517 link),
  // chủ dự án thấy `…/music/оригінальний-аудіозапис-7609…` nằm nguyên trên bảng. Slug là TRỌN nhãn
  // hoặc "<nhãn>-–-<tên user>", lặp lại ở nhiều sound khác nhau (số trong ngoặc = số link thấy).
  // Vài nhãn ĐOÁN ở nhóm B hoá ra sai chữ TikTok thật dùng ('suono originale', 'oryginalny dźwięk',
  // 'originální zvuk', 'оригінальний звук') — cứ để đó vì vô hại; chữ thật là mấy dòng dưới.
  'audio originale',          // it (12)
  'dźwięk oryginalny',        // pl (11)
  'оригінальний аудіозапис',  // uk (7)
  'původní zvuk',             // cs (5)
  'pôvodný zvuk',             // sk (2)
  'orijinal səs',             // az (2)
  '原創音樂',                  // zh-Hant (1)
  'សំឡេង​ដើម',            // km (1) — TikTok chèn ký tự RỖNG U+200B giữa hai chữ
  'សំឡេងដើម',                 // km, dạng không có ký tự rỗng
  'アップロード楽曲',            // ja (1) — "bản nhạc tải lên"
];

// Nhóm B — thêm theo hiểu biết về bản địa hóa của TikTok, CHƯA đối chiếu được với dữ liệu
// thật vì dự án chưa có profile ở những quốc gia đó. Nhãn sai thì chỉ đơn giản là KHÔNG
// BAO GIỜ KHỚP — không gây hại, không âm thầm bắt nhầm thứ khác. Gặp dạng lạ trên Sheet
// thì thêm một dòng vào đây là xong.
const _LABELS_UNVERIFIED = [
  'sonido original',       // es
  'suono originale',       // it
  'origineel geluid',      // nl
  'oryginalny dźwięk',     // pl
  'sunet original',        // ro
  'originální zvuk',       // cs
  'originalljud',          // sv
  'original lyd',          // da / no
  'alkuperäinen ääni',     // fi
  'eredeti hang',          // hu
  'αρχικός ήχος',          // el
  'orijinal ses',          // tr
  'оригинальный звук',     // ru
  'оригінальний звук',     // uk
  'orihinal na tunog',     // tl
  'เสียงต้นฉบับ',            // th
  'オリジナル楽曲',          // ja
  'オリジナル音源',          // ja (dạng thứ hai)
  '原声',                   // zh-Hans
  '原聲',                   // zh-Hant
  'צליל מקורי',             // he
  'صدای اصلی',              // fa
  'मूल ध्वनि',               // hi
  'আসল সাউন্ড',              // bn
  'اصل آواز',               // ur
];

const ORIGINAL_SOUND_LABELS = [..._LABELS_SEEN, ..._LABELS_UNVERIFIED];

// Chuẩn hóa chữ để so: NFC + chữ thường.
// NFC là BẮT BUỘC, không phải cho đẹp: tiếng Hàn và tiếng Việt có 2 cách mã hóa cùng một
// chữ (dựng sẵn / tổ hợp). Hai dạng nhìn y hệt nhau nhưng khác byte → so chuỗi trượt mà
// không ai hiểu tại sao.
function _norm(s) {
  let x = String(s == null ? '' : s);
  try { x = x.normalize('NFC'); } catch (_) {}
  return x.toLowerCase();
}

const _SLUG_LABELS = ORIGINAL_SOUND_LABELS.map(l => _norm(l).replace(/\s+/g, '-'));
const _NAME_LABELS = ORIGINAL_SOUND_LABELS.map(l => _norm(l));

// Khớp nhãn ở ĐẦU chuỗi, và phải hết chuỗi hoặc gặp dấu ngăn cách.
//
// ⚠ Vì sao PHẢI có ràng buộc ngăn cách (đây là chỗ đổi hành vi so với bản trước
// 2026-08-21): bản cũ dùng startsWith trơn nên '/music/original-soundtrack-of-my-life-763...'
// bị coi là sound gốc — vừa rút gọn sai, vừa lọt bộ lọc "Chỉ lấy Original Sound" dù đó là
// nhạc phim có bản quyền. Yêu cầu nhãn phải đứng trọn một từ thì hết cả hai lỗi.
function _hasLabelPrefix(text, labels, seps) {
  const t = _norm(text).trim();
  if (!t) return false;
  for (const l of labels) {
    if (!l || !t.startsWith(l)) continue;
    if (t.length === l.length) return true;        // nhãn là trọn chuỗi
    if (seps.includes(t[l.length])) return true;   // nhãn + dấu ngăn cách
  }
  return false;
}

// Slug của link là "<nhãn>-<tên user>" (TikTok nối bằng '-').
function isOriginalSoundSlug(slug) { return _hasLabelPrefix(slug, _SLUG_LABELS, '-'); }

// Tên sound là "<nhãn> - <tên user>". Với ngôn ngữ RTL (Ả Rập) chuỗi vẫn bắt đầu bằng nhãn
// theo thứ tự logic, chỉ khi HIỂN THỊ mới thấy nhãn nhảy về cuối — nên startsWith vẫn đúng.
function isOriginalSoundName(name) { return _hasLabelPrefix(name, _NAME_LABELS, ' -'); }

// Tách slug + id từ link /music/. slug = null nếu không phải link sound.
function _splitMusicUrl(u) {
  const clean = String(u || '').trim().split(/[?#]/)[0].replace(/\/+$/, '');
  let dec = clean;
  try { dec = decodeURIComponent(clean); } catch (_) {}   // giải mã %-encode (slug tiếng Việt/emoji)
  const m = dec.match(/\/music\/([^/]*)-(\d{8,})$/);
  return m ? { clean, slug: m[1], id: m[2] } : { clean, slug: null, id: null };
}

// Rút gọn link sound gốc về dạng chuẩn /music/original-sound-<id>: TikTok nhét cả tên user
// vào slug ("original-sound-Nhatty-on-Air-763...", "son-original-<tên user>-744...") nhưng
// thực tế chỉ resolve theo ID số ở cuối — rút gọn để link đồng nhất trong bảng/Sheet VÀ
// lọc trùng chính xác (cùng 1 sound với 2 slug khác nhau không còn bị tính là 2 sound).
//
// CHỈ rút gọn slug là sound gốc (mọi ngôn ngữ — xem danh sách trên); link nhạc bản quyền
// (slug = tên bài hát, vd "Whiskey-In-The-Jar-694...") GIỮ NGUYÊN, vì đổi nó thành
// "original-sound-..." là ghi sai loại sound vào dữ liệu người dùng phải soát tay.
function canonicalSoundUrl(u) {
  const { clean, slug, id } = _splitMusicUrl(u);
  if (!slug || !isOriginalSoundSlug(slug)) return clean;
  return `https://www.tiktok.com/music/original-sound-${id}`;
}

// Khóa so trùng: rút gọn về link chuẩn rồi đồng nhất hoa/thường. Link cũ dạng dài trên
// Sheet và link mới rút gọn cho ra CÙNG key.
function normalizeKey(u) {
  return canonicalSoundUrl(u).toLowerCase();
}

// Nhận diện sound gốc cho bộ lọc "Chỉ lấy Original Sound". Hai dấu hiệu, chỉ cần một:
// slug trong link, HOẶC tên sound. Giữ cả hai vì TikTok không luôn đồng bộ hai chỗ này —
// đã gặp dòng thật có tên tiếng Ả Rập nhưng slug lại là tiếng Anh.
//
// Gọi được với link THÔ (chưa qua canonicalSoundUrl) hay link đã rút gọn đều đúng.
function isOriginalSound(url, name) {
  const { slug } = _splitMusicUrl(url);
  if (slug && isOriginalSoundSlug(slug)) return true;
  return isOriginalSoundName(name);
}

module.exports = {
  canonicalSoundUrl,
  normalizeKey,
  isOriginalSound,
  isOriginalSoundSlug,
  isOriginalSoundName,
  ORIGINAL_SOUND_LABELS,
};
