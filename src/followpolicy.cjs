// src/followpolicy.cjs — Chuẩn hóa @handle và luật quyết định follow. THUẦN: không đụng
// Playwright, không đụng đĩa, không đụng Electron → test offline được (bài học QĐ-20/24/26:
// mọi thứ nằm trong crawler.cjs/main.js/renderer đều KHÔNG có phép thử tự động nào).
//
// Vì sao tách riêng (2026-08-22): đây là **nguồn duy nhất** chuẩn hóa handle, đúng vai trò
// mà `normalizeKey` của linkkey.cjs đang giữ cho link sound. Dự án đã trả giá một lần vì để
// hai bản sao của cùng một logic chuẩn hóa (QĐ-10): crawler được sửa, sheets thì không, và
// nút đẩy bù coi link dài với link ngắn là 2 sound khác nhau.
'use strict';

// TikTok cho phép chữ, số, dấu chấm và gạch dưới trong tên tài khoản; và tên KHÔNG phân biệt
// hoa thường (mở tiktok.com/@ABC ra đúng tiktok.com/@abc). Vì vậy khóa chuẩn là CHỮ THƯỜNG —
// nếu không, "@Hira" và "@hira" sẽ bị coi là 2 người và app follow cùng một kênh hai lần.
const _VALID = /^[a-z0-9._]{1,30}$/;

// Rút mọi dạng nhập về `@handle` chữ thường. Nhận:
//   '@abc' · 'abc' · '/@abc' · '/@abc/video/7440...' ·
//   'https://www.tiktok.com/@abc' · '...?lang=vi' · '...#hash' · có/không 'www.' · dấu '/' thừa
// Không đọc được → trả '' để nơi gọi bỏ qua, thay vì đi follow một địa chỉ rác.
function normalizeHandle(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')   // bỏ scheme
       .replace(/^www\./i, '')
       .replace(/^(?:m\.|vm\.)?tiktok\.com\//i, '');
  // `?` và `#` luôn được coi là RANH GIỚI URL, kể cả khi đầu vào không giống URL:
  // '@abc?lang=vi' và '@abc#top' → '@abc'. Đây là chủ ý — mọi đầu vào thật đều đến từ href
  // hoặc từ người dùng dán URL. Hệ quả cần biết: '@a#b' cho ra '@a' chứ không bị loại; tên
  // TikTok không chứa được 2 ký tự này nên không có trường hợp nào bị cắt oan.
  s = s.split(/[?#]/)[0];
  s = s.replace(/^\/+/, '');                       // bỏ '/' đầu
  s = s.split('/')[0];                             // cắt '/video/123...'
  s = s.replace(/^@+/, '');                        // bỏ '@' (có thể lặp do dán tay)
  s = s.toLowerCase();
  if (!s || !_VALID.test(s)) return '';
  return '@' + s;
}

// Link trang cá nhân. Trả '' nếu handle không hợp lệ — nơi gọi KHÔNG được goto('') .
function profileUrl(handle) {
  const h = normalizeHandle(handle);
  return h ? `https://www.tiktok.com/${h}` : '';
}

// Con trỏ vòng tròn theo HANDLE, KHÔNG theo chỉ số (2026-08-22).
//
// ⚠ TẠM THỜI KHÔNG CÒN AI GỌI kể từ 2026-09-05 (QĐ-29): pha Kênh đi thăm từng trang cá nhân
// đã được thay bằng cuộn thẳng feed Following. GIỮ LẠI hàm này cùng 51 phép thử của nó vì
// vòng xoay "kênh nào tới lượt" sẽ cần lại y nguyên khi làm tính năng tự UNFOLLOW — xoá đi
// rồi viết lại là mất luôn lưới an toàn đã có. `profileUrl` cũng ở tình trạng tương tự.
//
// Vì sao không dùng chỉ số như `viewIdx` của pha Xem: danh sách kênh **thay đổi giữa hai lần
// gọi** — pha Quét thêm kênh mới, luật đào thải gỡ kênh chết. Nhớ "đang ở vị trí thứ 7" là
// nhớ một thứ trượt đi mất: chèn một kênh ở đầu danh sách là toàn bộ phần sau lệch một nấc,
// và app sẽ thăm lại kênh vừa thăm hoặc nhảy cóc qua kênh chưa thăm bao giờ.
//
// Handle vừa bị loại khỏi danh sách → không tìm thấy → quay về đầu. Đó là hướng sai an toàn:
// thà thăm lại từ đầu còn hơn đứng im.
function nextAfter(list, lastHandle) {
  const arr = (list || []).map(normalizeHandle).filter(Boolean);
  if (!arr.length) return '';
  const last = normalizeHandle(lastHandle);
  if (!last) return arr[0];
  const i = arr.indexOf(last);
  if (i < 0) return arr[0];
  return arr[(i + 1) % arr.length];
}

module.exports = { normalizeHandle, profileUrl, nextAfter };
