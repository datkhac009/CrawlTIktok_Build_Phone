// src/channelstore.cjs — KHO KÊNH CHẤT LƯỢNG của MỘT profile (2026-08-22).
//
// Kênh nào từng cho ra sound HỢP LỆ thì được ghi vào đây; pha "Xem kênh" sẽ lần lượt đi thăm
// chúng để dạy thuật toán và thu thêm sound.
//
// ĐẶT TRONG THƯ MỤC PROFILE, không đặt cạnh .exe như known_links.txt. Hai lý do:
//   • Danh sách này là chân dung sở thích của MỘT tài khoản TikTok — dùng chung giữa các
//     profile là trộn lẫn khẩu vị của những tài khoản khác quốc gia.
//   • Chép thư mục profile sang máy khác là mang theo luôn, đúng như fingerprint.json.
//
// ⚠ TÌNH TRẠNG TỪ 2026-09-05 (QĐ-29): pha đi thăm từng trang cá nhân đã được thay bằng cuộn
// thẳng feed Following, nên `list()` / `recordMiss()` và toàn bộ LUẬT ĐÀO THẢI bên dưới **tạm
// thời không còn ai gọi** — chỉ còn phép thử giữ chúng sống. Kho vẫn được GHI đều (`recordHit`
// mỗi sound hợp lệ, `recordFollow` mỗi lần follow thành công) và vẫn được NÉN định kỳ từ
// `crawler.cjs`.
//
// Giữ nguyên vì cuộn feed thì KHÔNG đo được từng kênh: muốn làm tự unfollow ("kênh thôi ra
// sound thì hủy follow") thì cần đúng luật này cùng dữ liệu đã tích lũy sẵn. Xoá đi là đợt đó
// phải gom lại từ đầu bằng nhiều ngày chạy thật.
//
// ── LUẬT TỰ ĐÀO THẢI (chủ dự án chốt) ──
// "Nếu lượt sau kênh đó không còn video chất lượng nữa thì huỷ đi, đợi khi nào nó có sound
//  chất lượng lại thì thêm vào — để tránh tồn đọng quá nhiều user."
//
//   hit   → kênh vừa cho một sound hợp lệ. Thêm nếu chưa có, ĐẶT LẠI miss = 0.
//   miss  → vừa đi thăm mà không thu được sound hợp lệ mới nào. miss + 1.
//   miss chạm ngưỡng (mặc định 3) → kênh thành KHÔNG hoạt động, pha Xem bỏ qua.
//   Kênh đã bị loại mà sau này lại ra sound hợp lệ → `hit` kéo nó về, miss = 0.
//
// Không có luật này thì danh sách chỉ có tăng, và pha 20 phút sẽ dần chỉ đi thăm kênh chết.
//
// ── VÌ SAO LƯU DẠNG NHẬT KÝ SỰ KIỆN ──
// Mỗi dòng là một sự kiện, đọc lên thì GỘP theo handle. Nhờ vậy đường ghi vẫn là append thuần
// (giữ đúng tính chất "tắt máy giữa chừng chỉ mất dòng đang ghi dở" của linkstore) — không
// bao giờ có khoảnh khắc file bị ghi đè dở dang. Khi nhật ký phình thì NÉN lại một lần.
//
// Ngưỡng `miss` và trần số kênh được áp lúc GỘP, không nướng vào file. Nghĩa là chỉnh ngưỡng
// trong ⚙️ có hiệu lực ngay với lịch sử cũ, không phải viết lại kho.
'use strict';

const path = require('path');
const { normalizeHandle } = require('./followpolicy.cjs');
const { appendLines, readLines, rewriteAll } = require('./textset.cjs');

const FILE_NAME = 'quality_channels.txt';
const SEP = '\t';

const DEFAULTS = {
  missLimit: 3,    // bao nhiêu lần thăm liên tiếp không ra sound thì loại kênh
  max: 300,        // trần cứng số kênh đang hoạt động
  compactRatio: 5, // số dòng > 5× số kênh thì nén
  compactMin: 200, // nhưng file nhỏ thì kệ, nén cũng chẳng để làm gì
};

const HEADER = [
  '# KHO KÊNH CHẤT LƯỢNG của profile này — tác giả của những sound đã qua bộ lọc số video.',
  '# Pha "Xem kênh" lần lượt đi thăm các kênh đang hoạt động ở đây.',
  '#',
  '# Mỗi dòng là MỘT SỰ KIỆN:  @handle <tab> ngày <tab> sự-kiện [<tab> hits <tab> miss]',
  '#   hit   = kênh vừa cho một sound hợp lệ (đặt lại bộ đếm trượt)',
  '#   miss  = vừa thăm mà không thu được sound hợp lệ mới nào',
  '#   drop  = loại thủ công',
  '#   state = dòng tổng hợp do app nén lại, thay cho nhiều dòng cũ',
  '#',
  '# Đọc lên thì GỘP theo handle, dòng sau đè dòng trước. Xoá file này chỉ mất danh sách kênh,',
  '# không ảnh hưởng gì tới phiên đăng nhập hay kho link.',
  '',
].join('\n');

function filePath(profileDir) { return path.join(profileDir, FILE_NAME); }

// Ngày theo GIỜ ĐỊA PHƯƠNG — dùng UTC thì mốc ngày nhảy lúc 7h sáng giờ VN (bài học stats.cjs).
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── GỘP nhật ký → trạng thái. HÀM THUẦN, không đụng đĩa → test được 100%. ──
// Trả về { map, active } với `active` đã sắp xếp và đã áp trần số kênh.
function foldEvents(lines, opts = {}) {
  const { missLimit, max } = { ...DEFAULTS, ...opts };
  const map = new Map();

  for (const line of (lines || [])) {
    const parts = String(line).split(SEP);
    const handle = normalizeHandle(parts[0]);
    if (!handle) continue;                       // dòng rác → bỏ, không làm hỏng cả kho
    const date = (parts[1] || '').trim();
    const ev = (parts[2] || '').trim().toLowerCase();

    const cur = map.get(handle)
      || { handle, hits: 0, miss: 0, seen: 0, dropped: false, followed: false, last: '', followedAt: '' };
    if (date) cur.last = date;

    if (ev === 'hit') {
      cur.hits++;
      cur.miss = 0;
      cur.dropped = false;                       // sound hợp lệ trở lại → kéo kênh về
    } else if (ev === 'miss') {
      cur.miss++;
    } else if (ev === 'drop') {
      cur.dropped = true;
    } else if (ev === 'follow') {
      // Đã bấm Follow kênh này (đã XÁC MINH nút đổi trạng thái). Ghi vào đây thay vì một file
      // kho riêng: mỗi profile một nguồn sự thật, và chép thư mục profile là mang theo cả
      // lịch sử follow. Sau này khi làm unfollow thì `drop` chính là tín hiệu.
      cur.followed = true;
      if (date) cur.followedAt = date;             // để sau này xét "đã follow đủ lâu chưa"
    } else if (ev === 'unfollow') {
      cur.followed = false;
    } else if (ev === 'seen') {
      // ĐÃ XEM bao nhiêu video của kênh này (2026-09-09). Đây là mẫu số để trả lời câu hỏi
      // "kênh này còn ra sound tốt không" — `hits/seen`. Trước đây app KHÔNG có tín hiệu nào
      // như vậy: bộ đếm `miss` chỉ được tăng bởi pha thăm-từng-trang-cá-nhân đã gỡ ở QĐ-29.
      //
      // Cộng DỒN theo số ở cột 4 vì bên ghi gom lô — một lượt chạy xem hàng nghìn video, ghi
      // mỗi video một dòng là phình file rất nhanh.
      cur.seen += Math.max(0, parseInt(parts[3], 10) || 0);
    } else if (ev === 'state') {
      // Dòng tổng hợp do nén sinh ra: đặt thẳng giá trị, không cộng dồn.
      cur.hits = Math.max(0, parseInt(parts[3], 10) || 0);
      cur.miss = Math.max(0, parseInt(parts[4], 10) || 0);
      cur.followed = parts[5] === '1';
      // ⚠ Trường 7 và 8 PHẢI có mặt ở đường nén (xem compactIfNeeded). Quên là mỗi lần nén
      // xoá sạch số `seen` và ngày follow — đúng cái bẫy đã suýt dính với cờ `followed`.
      cur.seen = Math.max(0, parseInt(parts[6], 10) || 0);
      cur.followedAt = (parts[7] || '').trim();
      cur.dropped = false;
    } else {
      continue;                                  // sự kiện lạ → bỏ qua, giữ nguyên trạng thái
    }
    map.set(handle, cur);
  }

  // Đang hoạt động = chưa bị loại tay VÀ chưa trượt quá ngưỡng.
  let live = [...map.values()].filter(e => !e.dropped && e.miss < missLimit);
  // Ưu tiên kênh ra nhiều sound hợp lệ nhất, rồi tới kênh mới có tin gần đây nhất.
  live.sort((a, b) => (b.hits - a.hits) || String(b.last).localeCompare(String(a.last)));
  if (live.length > max) live = live.slice(0, max);   // trần cứng, chống phình vô hạn

  // `active` là mảng CHUỖI @handle — cùng kiểu với thứ `list()` trả ra, để không có hai kiểu
  // dữ liệu cho cùng một khái niệm. Cần chi tiết (hits/miss) thì tra trong `map`.
  return { map, active: live.map(e => e.handle) };
}

function load(profileDir, opts) {
  return foldEvents(readLines(filePath(profileDir)), opts);
}

// Danh sách @handle đang hoạt động, đã sắp xếp — đầu vào của pha "Xem kênh".
function list(profileDir, opts) {
  return load(profileDir, opts).active;
}

function stats(profileDir, opts) {
  const { map, active } = load(profileDir, opts);
  return { total: map.size, active: active.length, dropped: map.size - active.length };
}

function _append(profileDir, handle, ev, extra = []) {
  const h = normalizeHandle(handle);
  if (!h) return false;
  try {
    appendLines(filePath(profileDir), [[h, today(), ev, ...extra].join(SEP)]);
    return true;
  } catch (e) {
    console.error('[channelstore] Không ghi được kho kênh:', e.message);
    return false;
  }
}

// Kênh vừa cho một sound HỢP LỆ. Gọi từ đúng một chỗ: nhánh `if (emit)` trong countLoop.
function recordHit(profileDir, handle) { return _append(profileDir, handle, 'hit'); }

// Vừa thăm kênh mà không thu được sound hợp lệ mới nào.
function recordMiss(profileDir, handle) { return _append(profileDir, handle, 'miss'); }

// Loại tay (dành cho sau này khi có Follow: `drop` chính là tín hiệu unfollow).
function recordDrop(profileDir, handle) { return _append(profileDir, handle, 'drop'); }

// Đã bấm Follow kênh này. ⚠ CHỈ gọi sau khi đã xác minh nút đổi sang trạng thái "đang theo
// dõi" — ghi lúc mới bấm mà bấm hụt thì lần sau app tưởng đã follow rồi và bỏ qua vĩnh viễn.
function recordFollow(profileDir, handle) { return _append(profileDir, handle, 'follow'); }
function recordUnfollow(profileDir, handle) { return _append(profileDir, handle, 'unfollow'); }

// ── ĐÃ XEM bao nhiêu video của các kênh ĐANG FOLLOW (2026-09-09) ──
// `counts` là Map<handle, số> hoặc object thường — GHI GOM LÔ, không phải mỗi video một dòng:
// một lượt chạy đọc hàng nghìn video, append từng cái là phình file rất nhanh.
//
// Đây là MẪU SỐ để trả lời "kênh này còn ra sound tốt không": `hits / seen`. Không có nó thì
// mọi luật unfollow đều là đoán mò — mốc "2 ngày" chẳng hạn thực chất chỉ đo việc kênh đó có
// tình cờ đăng bài gần đây hay không, chứ không đo chất lượng.
function recordSeenBatch(profileDir, counts) {
  const entries = counts instanceof Map ? [...counts.entries()] : Object.entries(counts || {});
  const lines = [];
  const day = today();
  for (const [handle, n] of entries) {
    const h = normalizeHandle(handle);
    const k = Math.max(0, parseInt(n, 10) || 0);
    if (!h || !k) continue;
    lines.push([h, day, 'seen', k].join(SEP));
  }
  if (!lines.length) return 0;
  try {
    appendLines(filePath(profileDir), lines);
    return lines.length;
  } catch (e) {
    console.error('[channelstore] Không ghi được số lần xem:', e.message);
    return 0;
  }
}

// Đã follow kênh này chưa? Dùng để không bấm Follow hai lần cùng một kênh (vừa phí hạn mức
// ngày, vừa là hành vi bất thường trong mắt TikTok).
function isFollowed(profileDir, handle, opts) {
  const h = normalizeHandle(handle);
  if (!h) return false;
  const e = load(profileDir, opts).map.get(h);
  return !!(e && e.followed);
}

// Nén nhật ký: viết lại mỗi kênh một dòng `state`. Chỉ chạy khi file thật sự phình, và ghi
// qua file tạm rồi đổi tên (nguyên tử) nên không có khoảnh khắc nào kho bị rỗng.
// Trả về số dòng đã bỏ đi, hoặc 0 nếu chưa cần nén.
function compactIfNeeded(profileDir, opts = {}) {
  const { compactRatio, compactMin } = { ...DEFAULTS, ...opts };
  const f = filePath(profileDir);
  const lines = readLines(f);
  if (lines.length < compactMin) return 0;
  const { map } = foldEvents(lines, opts);
  if (!map.size || lines.length <= map.size * compactRatio) return 0;
  const out = [...map.values()]
    .filter(e => !e.dropped)
    // ⚠ DÒNG `state` PHẢI CHỞ ĐỦ MỌI TRƯỜNG. Thiếu một cái là mỗi lần nén xoá sạch trường đó:
    //   followed   — quên thì app follow lại từ đầu (phí hạn mức, hành vi bất thường)
    //   seen       — quên thì mất luôn mẫu số để quyết unfollow, phải gom lại từ nhiều ngày chạy
    //   followedAt — quên thì không biết kênh đã follow bao lâu, không xét được "đủ 7 ngày chưa"
    // Thêm trường mới vào bản ghi thì BẮT BUỘC sửa cả đây lẫn nhánh `state` của foldEvents.
    .map(e => [e.handle, e.last || today(), 'state',
      e.hits, e.miss, e.followed ? 1 : 0, e.seen || 0, e.followedAt || ''].join(SEP));
  try {
    rewriteAll(f, out, HEADER.trimEnd());
    return lines.length - out.length;
  } catch (e) {
    console.error('[channelstore] Không nén được kho kênh:', e.message);
    return 0;
  }
}
module.exports = {
  FILE_NAME, DEFAULTS, HEADER,
  filePath, foldEvents, load, list, stats,
  recordHit, recordMiss, recordDrop, recordFollow, recordUnfollow, recordSeenBatch,
  isFollowed, compactIfNeeded,
};
