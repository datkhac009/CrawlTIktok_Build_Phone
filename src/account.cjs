// src/account.cjs — Tài khoản TikTok của từng máy: đọc chuỗi, che mật khẩu, gán hàng loạt. Hàm THUẦN:
// không đụng đĩa, không gọi adb — phép thử chạy được mà không cần điện thoại.
//
// VÌ SAO CÓ (2026-09-24): chủ dự án muốn app tự đăng nhập TikTok. Tài khoản dạng `user|pass|khoá2fa`
// (khoá 2FA base32 của app Authenticator — Python tự sinh mã 6 số). Việc đăng nhập nằm ở
// `tiktok_login.py`, chạy khi bấm nút "Đăng nhập TikTok" — lưu tài khoản KHÔNG tự đăng nhập.
'use strict';

const RE_B32 = /^[A-Z2-7]+=*$/;

// → { user, pass, khoa } | null. PHẢI khớp `doc_tai_khoan` bên tiktok_login.py (tests/login.test.cjs
// chạy cả hai trên cùng bộ chuỗi). Tách bằng `|`; dòng không có `|` thì tách bằng `:`.
function docTaiKhoan(chuoi) {
  const s = String(chuoi == null ? '' : chuoi).trim();
  if (!s) return null;
  const phan = s.split(s.includes('|') ? '|' : ':').map((x) => x.trim());
  if (phan.length !== 2 && phan.length !== 3) return null;
  const user = phan[0].replace(/^@+/, '');
  const pass = phan[1];
  const khoa = phan.length === 3 ? phan[2].replace(/\s+/g, '').toUpperCase() : '';
  if (!user || /\s/.test(user) || !pass) return null;
  if (khoa && (khoa.length < 16 || !RE_B32.test(khoa))) return null;
  return { user, pass, khoa };
}

// Chữ hiện trên bảng và trong log: KHÔNG BAO GIỜ có mật khẩu hay khoá 2FA.
function moTa(chuoi) {
  const t = docTaiKhoan(chuoi);
  if (!t) return '';
  return (t.user.includes('@') ? t.user : '@' + t.user) + (t.khoa ? ' · 2FA' : '');
}

// Dán danh sách, gán LẦN LƯỢT cho các máy đã chọn — cùng luật với proxy.ganHangLoat: có dòng sai là
// KHÔNG gán gì, để dòng sau dòng sai không lệch sang máy khác.
function ganHangLoat(ids, text) {
  const dong = String(text || '').split(/\r?\n/)
    .map((s, i) => ({ so: i + 1, s: s.trim() }))
    .filter((x) => x.s);
  const loi = dong.filter((x) => !docTaiKhoan(x.s)).map((x) => ({ dong: x.so, noiDung: x.s }));
  const n = Math.min(ids.length, dong.length);
  return {
    gan: loi.length ? [] : ids.slice(0, n).map((id, i) => ({ id, taiKhoan: dong[i].s })),
    loi,
    thieu: Math.max(0, ids.length - dong.length),
    thua: Math.max(0, dong.length - ids.length),
  };
}

module.exports = { docTaiKhoan, moTa, ganHangLoat };
