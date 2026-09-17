// src/followquota.cjs — NƠI DUY NHẤT trả lời: "máy này, kênh này, lúc này — được follow không?"
//
// VÌ SAO PHẢI CÓ (2026-09-15):
// Bản PC **không follow được ai** — `crawler.cjs:1537-1539` ghi rõ, sau ba ngày đo trên ba môi
// trường: TikTok Web chặn follow với các nick này, IP trung tâm dữ liệu chặn luôn cả tym. Vì
// vậy `followpolicy.cjs` bên PC, dù tên nghe như chứa luật follow, **không có một dòng quota
// nào** — nó chỉ chuẩn hoá @handle.
//
// Bản phone là môi trường ĐẦU TIÊN follow được thật: app TikTok thật, tài khoản đăng nhập thật,
// IP dân dụng. Nên phần hạn mức phải viết mới, và phải viết cẩn thận: **mỗi cú follow tác động
// lên một tài khoản THẬT và không hoàn tác được bằng cách chạy lại chương trình.**
//
// ⚠ BỐN HÀNG RÀO, VÀ VÌ SAO TỪNG CÁI CÓ MẶT:
//
//  1. TRẦN NGÀY — đếm từ SỔ `channelstore`, KHÔNG đếm trong RAM.
//     Giữ bộ đếm trong RAM thì tắt app mở lại là **về 0 và follow quá tay**. Người dùng mở lại
//     app vài lần một ngày là chuyện thường. Sổ nằm trên đĩa nên không có chuyện đó.
//
//  2. GIÃN CÁCH giữa hai cú follow — thứ này thì đúng là giữ trong RAM.
//     Sổ chỉ ghi NGÀY (`followedAt` dạng YYYY-MM-DD), không ghi giờ, nên không suy ra được
//     khoảng cách. Mở lại app mà quên giãn cách chỉ làm một cú follow đến sớm hơn dự định —
//     hướng sai này nhẹ hơn nhiều so với vượt trần ngày.
//
//  3. KHÔNG FOLLOW TRÙNG — `channelstore.isFollowed`, khoá là `normalizeHandle` nên `@Hira` và
//     `@hira` là MỘT. Follow lại người đã follow vừa phí hạn mức vừa là hành vi lạ.
//
//  4. CHỈ KÊNH CÓ SOUND HỢP LỆ — hàng rào này nằm ở nơi gọi, không ở đây: chỉ khi Python báo
//     sound đạt ngưỡng thì mới hỏi tới module này.
'use strict';

const channelstore = require('./channelstore.cjs');
const { normalizeHandle } = require('./followpolicy.cjs');

const DEFAULTS = {
  perDay: 30,          // trần ngày, mặc định thận trọng
  gapMinSec: 120,      // giãn cách tối thiểu
  gapMaxSec: 300,      // giãn cách tối đa (chọn ngẫu nhiên trong khoảng)
};

// Ngày theo GIỜ ĐỊA PHƯƠNG, khớp đúng `today()` của channelstore.cjs. Dùng UTC ở đây là lệch
// múi giờ: trần ngày sẽ đổi lúc 7 giờ sáng thay vì nửa đêm.
function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── Bộ nhớ đệm cho SỔ, theo từng thư mục máy ──
// `channelstore.load()` đọc file rồi gấp lại toàn bộ sự kiện — đồng bộ, đụng đĩa. Quyết định
// follow nằm trên đường xử lý của tiến trình chính, nên không được đụng đĩa mỗi lần hỏi.
// Tự huỷ đệm khi CHÍNH TA ghi; hết hạn ngắn để thay đổi từ ngoài cũng vào được.
const CACHE_MS = 10000;
const _cache = new Map();     // dir -> { at, map }

function _load(dir) {
  const c = _cache.get(dir);
  const now = Date.now();
  if (c && now - c.at < CACHE_MS) return c.map;
  let map;
  try {
    map = channelstore.load(dir).map;
  } catch (_) {
    map = new Map();          // không đọc được sổ = coi như sổ rỗng, KHÔNG ném
  }
  _cache.set(dir, { at: now, map });
  return map;
}

function invalidate(dir) { _cache.delete(dir); }

// Số cú follow ĐÃ THỰC HIỆN hôm nay trên máy này.
//
// Đếm theo `followedAt === hôm nay`, KHÔNG theo cờ `followed`. Lý do: nếu sau đó có unfollow
// thì cờ về false nhưng **cú follow vẫn đã xảy ra** và vẫn tính vào hạn mức trong mắt TikTok.
// Đếm theo cờ là tự cho mình thêm lượt bằng cách unfollow — đúng thứ hạn mức phải chặn.
function followedToday(dir, now = new Date()) {
  const hn = today(now);
  let n = 0;
  for (const e of _load(dir).values()) {
    if (e && e.followedAt === hn) n++;
  }
  return n;
}

// Bộ nhớ giãn cách, theo từng máy. Chỉ trong RAM — xem lý do ở đầu file.
const _lastAt = new Map();    // deviceId -> mốc thời gian cú follow gần nhất
const _nextAt = new Map();    // deviceId -> sớm nhất được follow lượt kế

function noteFollowed(deviceId, dir, opts = {}, now = Date.now(), rnd = Math.random) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  _lastAt.set(deviceId, now);
  const lo = Math.max(0, o.gapMinSec) * 1000;
  const hi = Math.max(lo, o.gapMaxSec * 1000);
  _nextAt.set(deviceId, now + lo + Math.floor(rnd() * (hi - lo + 1)));
  invalidate(dir);            // ta vừa ghi sổ, đệm cũ không còn đúng
}

// ── HÀNG RÀO 1 + 2: GIÃN CÁCH và TRẦN NGÀY. Chưa cần biết @handle ──
//
// VÌ SAO TÁCH RA (2026-09-16):
// `@handle` **không tồn tại trên feed** — đo trên máy thật, TikTok v46.1.1: 0/3 mẫu. Nó chỉ hiện
// trên TRANG CÁ NHÂN. Mà ghé trang cá nhân là việc tốn thời gian, nên không thể ghé mọi video
// rồi mới hỏi "có được follow không" — phải hỏi ngược lại: **còn ngân sách thì mới ghé**.
//
// Nên quyết định follow giờ đi hai nhịp:
//   1. Trên feed, chưa có @handle: hỏi `canFollowBudget` — còn lượt trong ngày và đã qua giãn
//      cách chưa? Không còn thì khỏi ghé, khỏi tốn gì.
//   2. Ghé trang, đọc được @handle thật: hỏi `canFollow` — đủ cả ba hàng rào, kể cả chống trùng.
//
// ⚠ Nhịp 1 KHÔNG được coi là đã cấp phép. Nó chỉ nói "đáng để đi xem", và hàng rào chống trùng
// vẫn nguyên vẹn ở nhịp 2. Bỏ nhịp 2 đi là follow lại người đã follow — vừa phí trần ngày vừa
// là hành vi lạ.
function canFollowBudget({ deviceId, dir, opts = {}, now = Date.now() }) {
  const o = { ...DEFAULTS, ...(opts || {}) };

  const next = _nextAt.get(deviceId) || 0;
  if (now < next) {
    return { ok: false, reason: `chưa tới giãn cách (còn ${Math.ceil((next - now) / 1000)}s)` };
  }

  // Trần 0 = TẮT hẳn, không phải "không giới hạn". Ở đây 0 phải mang nghĩa an toàn: người dùng
  // gõ 0 vào ô trần follow là muốn ngừng follow, không phải muốn follow vô hạn.
  const tran = Math.max(0, parseInt(o.perDay, 10) || 0);
  if (tran <= 0) return { ok: false, reason: 'trần ngày đang đặt 0 — không follow' };

  const daLam = followedToday(dir, new Date(now));
  if (daLam >= tran) {
    return { ok: false, reason: `đã đạt trần ngày (${daLam}/${tran})` };
  }

  return { ok: true, reason: `còn ${tran - daLam}/${tran} lượt hôm nay`, used: daLam, cap: tran };
}

// Quyết định ĐẦY ĐỦ, dùng khi đã đọc được @handle thật trên trang cá nhân.
// Trả { ok, reason } — `reason` là chuỗi tiếng Việt để ghi log cho người đọc.
// KHÔNG bao giờ ném: nơi gọi nằm trên đường xử lý sự kiện, ném ở đây là chết cả vòng quét.
function canFollow({ deviceId, dir, handle, opts = {}, now = Date.now() }) {
  const h = normalizeHandle(handle);
  if (!h) return { ok: false, reason: 'không đọc được @handle' };

  // Ngân sách trước: cùng một luật, một nơi viết. Chép lại ở đây là có ngày hai nhịp lệch nhau.
  const ns = canFollowBudget({ deviceId, dir, opts, now });
  if (!ns.ok) return ns;
  const tran = ns.cap;
  const daLam = ns.used;

  let daFollow = false;
  try {
    daFollow = channelstore.isFollowed(dir, h);
  } catch (_) {
    daFollow = false;         // đọc sổ hỏng thì coi như chưa follow; hàng rào trần vẫn giữ
  }
  if (daFollow) return { ok: false, reason: `đã follow ${h} từ trước` };

  return { ok: true, reason: `còn ${tran - daLam}/${tran} lượt hôm nay`, handle: h, used: daLam, cap: tran };
}

function _resetForTest() {
  _cache.clear();
  _lastAt.clear();
  _nextAt.clear();
}

module.exports = {
  DEFAULTS, canFollow, canFollowBudget, followedToday, noteFollowed, invalidate, today,
  _resetForTest,
};
