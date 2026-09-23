// src/proxy.cjs — Proxy của từng máy: đọc chuỗi, che mật khẩu, gán hàng loạt. Hàm THUẦN: không đụng
// đĩa, không gọi adb — nên phép thử chạy được mà không cần điện thoại.
//
// Proxy được GẮN lên điện thoại ở phía Python (`college_proxy.py`): app College Proxy đã cài sẵn
// trên máy farm, là một VPN nên mọi traffic của TikTok đi qua. ⚠ App đó CHỈ chạy proxy HTTP — đo trên
// máy 60 ngày 2026-09-23: cổng SOCKS5 vẫn báo "Connected" nhưng máy mất mạng hẳn. Nên ở đây chỉ nhận
// `host:port:user:pass`, và phía Python luôn đo IP công khai trên điện thoại trước khi cho mở TikTok.
'use strict';

// `host:port:user:pass` hoặc `host:port` → { host, port, user, pass }; sai dạng → null.
// Tách từ PHẢI sang: host IPv6 có dấu `:` vẫn tách đúng. PHẢI khớp `doc_proxy` bên college_proxy.py
// (tests/proxy.test.cjs chạy cả hai trên cùng bộ chuỗi).
function docProxy(chuoi) {
  const s = String(chuoi == null ? '' : chuoi).trim();
  if (!s || /\s/.test(s)) return null;
  const phan = s.split(':');
  let host;
  let port;
  let user = '';
  let pass = '';
  if (phan.length >= 4 && /^\d+$/.test(phan[phan.length - 3])) {
    host = phan.slice(0, -3).join(':');
    [port, user, pass] = phan.slice(-3);
  } else if (phan.length >= 2 && /^\d+$/.test(phan[phan.length - 1])) {
    host = phan.slice(0, -1).join(':');
    port = phan[phan.length - 1];
  } else {
    return null;
  }
  const so = Number(port);
  if (!host || !(so >= 1 && so <= 65535)) return null;
  return { host, port, user, pass };
}

// Chữ hiện trên bảng và trong log: KHÔNG BAO GIỜ có mật khẩu.
function moTa(chuoi) {
  const p = docProxy(chuoi);
  if (!p) return '';
  return `${p.host}:${p.port}`;
}

// Dán một danh sách proxy, gán LẦN LƯỢT cho các máy đã chọn (máy thứ nhất ← dòng thứ nhất…).
//   ids    id các máy, đúng thứ tự trên bảng
//   text   nội dung ô dán, mỗi dòng một proxy; dòng trống bị bỏ qua
// Trả { gan: [{ id, proxy }], loi: [{ dong, noiDung }], thieu, thua }.
// Có dòng sai là KHÔNG gán gì cả (`gan` rỗng): gán nửa chừng thì dòng sau dòng sai lệch sang máy
// khác mà người dùng không để ý.
function ganHangLoat(ids, text) {
  const dong = String(text || '').split(/\r?\n/)
    .map((s, i) => ({ so: i + 1, s: s.trim() }))
    .filter((x) => x.s);
  const loi = dong.filter((x) => !docProxy(x.s)).map((x) => ({ dong: x.so, noiDung: x.s }));
  const n = Math.min(ids.length, dong.length);
  return {
    gan: loi.length ? [] : ids.slice(0, n).map((id, i) => ({ id, proxy: dong[i].s })),
    loi,
    thieu: Math.max(0, ids.length - dong.length),   // máy không có dòng nào → giữ proxy cũ
    thua: Math.max(0, dong.length - ids.length),    // dòng không có máy nào → bỏ qua
  };
}

module.exports = { docProxy, moTa, ganHangLoat };
