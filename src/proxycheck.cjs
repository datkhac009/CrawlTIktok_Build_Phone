// src/proxycheck.cjs — Nút "🔌 Kiểm tra proxy" trong modal Proxy (2026-09-29).
//
// VÌ SAO CÓ: ngày 2026-09-29 bốn máy USB báo "✕ không chạy" trong khi Lalasoft trên máy báo
// "Connected" — chủ dự án tưởng app hỏng. Đo thật: proxy vẫn sống (thử từ máy tính: HTTP 200), còn
// điện thoại TẮT Wi-Fi nên không có đường nào ra Internet. Một máy khác thì chuỗi proxy sai tên đăng
// nhập (nhà cung cấp trả 407). Cả hai đều thấy được TRONG VÀI GIÂY trước khi bấm Lưu — không phải đợi
// gắn proxy ~40 giây rồi đi đọc log. Chủ dự án: "thêm kiểm tra kết nối proxy, tránh bị lỗi như trước".
//
// Cho từng máy đã chọn, hai việc:
//   1. thử CHÍNH chuỗi proxy từ MÁY TÍNH: GET http://api.ipify.org (proxy ra IP nào) + CONNECT
//      www.tiktok.com:443 (đường TikTok đi). Không qua điện thoại nên không dính cái chập chờn của
//      Lalasoft (đo 2026-09-28: từ máy tính 18/18 lần, 0,5 giây).
//   2. hỏi điện thoại có mạng NỀN (Wi-Fi / di động) không — một lệnh adb chỉ đọc, không bấm gì.
// Mật khẩu không rời tiến trình main: kết quả chỉ có IP / thời gian / lý do.
'use strict';

const http = require('http');
const net = require('net');
const { execFile } = require('child_process');
const { docProxy } = require('./proxy.cjs');
const { adbPath } = require('./adbpath.cjs');

const HAN_MS = 10000;
const DICH_IP = { host: 'api.ipify.org', port: 80 };
const DICH_TIKTOK = 'www.tiktok.com:443';
// Như gắn proxy / đăng nhập (main.js GAN_DONG_THOI): cả farm dồn lệnh qua chung một adb server.
const DONG_THOI = 3;

function _xacThuc(p) {
  return p.user ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${p.user}:${p.pass}`).toString('base64') } : {};
}

// Lỗi mạng của Node → một câu cho người vận hành đọc (không in mã lỗi tiếng Anh trần).
function _lyDoLoi(e) {
  const ma = e && e.code;
  if (ma === 'ECONNREFUSED') return 'proxy từ chối kết nối (sai cổng, hoặc proxy đang tắt)';
  if (ma === 'ENOTFOUND' || ma === 'EAI_AGAIN') return 'không tìm thấy địa chỉ proxy';
  if (ma === 'ECONNRESET' || ma === 'EPIPE') return 'proxy ngắt kết nối giữa chừng';
  if (ma === 'EHOSTUNREACH' || ma === 'ENETUNREACH') return 'máy tính không tới được proxy';
  return `lỗi kết nối tới proxy (${ma || 'không rõ'})`;
}

const _hetGio = (hanMs) => `proxy không trả lời sau ${Math.round(hanMs / 1000)} giây`;

// GET qua proxy → { ma, ip } hoặc { loi }.
function _layIp(p, hanMs, dich) {
  return new Promise((xong) => {
    const req = http.request({
      host: p.host, port: Number(p.port), method: 'GET', agent: false,
      path: `http://${dich.host}${dich.port === 80 ? '' : ':' + dich.port}/`,
      headers: { Host: dich.host, ..._xacThuc(p) },
      timeout: hanMs,
    }, (res) => {
      let than = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (than.length < 200) than += c; });
      res.on('end', () => xong({ ma: res.statusCode, ip: than.trim() }));
      res.on('error', () => xong({ loi: 'proxy ngắt kết nối giữa chừng' }));
    });
    req.on('timeout', () => { xong({ loi: _hetGio(hanMs) }); req.destroy(); });
    req.on('error', (e) => xong({ loi: _lyDoLoi(e) }));
    req.end();
  });
}

// CONNECT qua proxy (đường HTTPS của TikTok) → { ma } hoặc { loi }.
function _moDuongHam(p, hanMs, dich) {
  return new Promise((xong) => {
    const req = http.request({
      host: p.host, port: Number(p.port), method: 'CONNECT', path: dich, agent: false,
      headers: { Host: dich, ..._xacThuc(p) },
      timeout: hanMs,
    });
    req.on('connect', (res, socket) => { socket.destroy(); xong({ ma: res.statusCode }); });
    req.on('response', (res) => { res.resume(); xong({ ma: res.statusCode }); });
    req.on('timeout', () => { xong({ loi: _hetGio(hanMs) }); req.destroy(); });
    req.on('error', (e) => xong({ loi: _lyDoLoi(e) }));
    req.end();
  });
}

// Chuỗi proxy → Promise<{ ok, ip, ms, msg }>. Không ném.
async function thuProxy(chuoi, { hanMs = HAN_MS, dichIp = DICH_IP, dichTiktok = DICH_TIKTOK } = {}) {
  const p = docProxy(chuoi);
  if (!p) return { ok: false, ip: '', ms: 0, msg: 'proxy sai dạng — cần host:port:user:pass' };
  const t0 = Date.now();
  const [g, c] = await Promise.all([_layIp(p, hanMs, dichIp), _moDuongHam(p, hanMs, dichTiktok)]);
  const ms = Date.now() - t0;
  if (g.ma === 407 || c.ma === 407) {
    return { ok: false, ip: '', ms, msg: 'sai tài khoản / mật khẩu proxy (nhà cung cấp trả 407)' };
  }
  const ip = g.ma === 200 && net.isIP(g.ip) ? g.ip : '';
  const quaTiktok = c.ma >= 200 && c.ma < 300;
  if (quaTiktok) return { ok: true, ip, ms, msg: ip ? '' : 'mở được đường tới TikTok nhưng không đọc được IP ra' };
  if (ip) return { ok: false, ip, ms, msg: `proxy không mở được đường HTTPS tới TikTok (${c.loi || 'trả ' + c.ma})` };
  return { ok: false, ip: '', ms, msg: g.loi || c.loi || `proxy trả HTTP ${g.ma || c.ma}` };
}

// `settings get global wifi_on; ip route show table all` → { co, wifiTat }.
// co = true: có đường `default … dev X`, X không phải tun / lo (Wi-Fi, di động đều tính); false: chỉ
// thấy `unreachable default`; null: không đọc được gì — KHÔNG đoán là "không có mạng".
// PHẢI khớp `doc_mang_nen` bên college_proxy.py (tests/proxy.test.cjs chạy cả hai trên cùng bộ mẫu).
function docMangNen(traLoi) {
  const dong = String(traLoi || '').split(/\r?\n/);
  const wifiTat = dong[0].trim() === '0';
  let thayDefault = false;
  for (const l of dong) {
    const t = l.trim().split(/\s+/);
    if (!t.includes('default')) continue;
    thayDefault = true;
    if (['unreachable', 'prohibit', 'blackhole', 'throw'].includes(t[0]) || !t.includes('dev')) continue;
    const dev = t[t.indexOf('dev') + 1] || '';
    if (dev && dev !== 'lo' && !dev.startsWith('tun')) return { co: true, wifiTat };
  }
  return { co: thayDefault ? false : null, wifiTat };
}

// Hỏi một điện thoại → Promise<{ co, wifiTat }>. adb lỗi / máy không online → co = null. Không ném.
function mangNen(serial, hanMs = 8000) {
  return new Promise((xong) => {
    const ADB_PATH = adbPath();
    if (!ADB_PATH || !serial) return xong({ co: null, wifiTat: false });
    execFile(ADB_PATH, ['-s', serial, 'shell', 'settings get global wifi_on; ip route show table all'],
      { timeout: hanMs, encoding: 'utf-8', windowsHide: true },
      (err, stdout) => xong(err ? { co: null, wifiTat: false } : docMangNen(stdout)));
  });
}

// [{ id, chuoi, serial }] → Promise<[{ id, proxy: {…} | null, mang: {…} }]>, giữ đúng thứ tự, tối đa
// `dongThoi` máy một lúc. `chuoi` rỗng = máy chưa có proxy → proxy: null (vẫn hỏi mạng).
async function kiemNhieu(ds, { dongThoi = DONG_THOI, thu = thuProxy, hoiMang = mangNen } = {}) {
  const kq = new Array(ds.length);
  let tiep = 0;
  const tho = async () => {
    while (tiep < ds.length) {
      const i = tiep++;
      const x = ds[i];
      const [proxy, mang] = await Promise.all([
        x.chuoi ? thu(x.chuoi) : null,
        x.serial ? hoiMang(x.serial) : { co: null, wifiTat: false },
      ]);
      kq[i] = { id: x.id, proxy, mang };
    }
  };
  await Promise.all(Array.from({ length: Math.min(dongThoi, ds.length) }, tho));
  return kq;
}

module.exports = { thuProxy, docMangNen, mangNen, kiemNhieu };
