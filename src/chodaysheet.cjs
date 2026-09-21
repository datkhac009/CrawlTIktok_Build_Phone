// src/chodaysheet.cjs — HÀNG CHỜ ĐẨY SHEET nằm trên ĐĨA (2026-09-21, chỉ bản phone).
//
// VÌ SAO: chủ dự án hỏi "Google Sheet đang lỗi, để máy cứ quét rồi đẩy sau được không — mà không
// trùng link". Trước đây sound chưa lên được Sheet chỉ nằm trong BỘ NHỚ: buffer thử lại của
// sheets.cjs và bảng "Dữ liệu thu thập". Tắt app (hoặc dừng hết máy rồi chạy lại — bảng tự xoá)
// trước khi Sheet chạy lại là MẤT, mà link đó đã vào kho `known_links.txt` nên cũng không bao giờ
// được quét lại. Mất hẳn, không ai biết.
//
// Nên: mỗi sound ĐẠT ghi vào file này ngay lúc về; lên Sheet thành công mới gỡ ra. File nằm cạnh
// .exe như kho link, sống qua mọi lần tắt app. Mỗi dòng một JSON: { t: mốc thêm, dong: [5 cột] }.
// `sheets.cjs` bị `srcsync` khoá giống bản PC từng byte, nên hàng chờ là module riêng, nối ở main.js.
'use strict';

const fs = require('fs');
const path = require('path');
const { getBaseDir } = require('./paths.cjs');
const { normalizeKey } = require('./linkkey.cjs');

const FILE_NAME = 'cho_day_sheet.jsonl';

let _hang = null;   // Map khoá link → { t, dong }, giữ thứ tự thêm

function getFilePath() { return path.join(getBaseDir(), FILE_NAME); }

function load(force) {
  if (_hang && !force) return _hang;
  _hang = new Map();
  let txt = '';
  try { txt = fs.readFileSync(getFilePath(), 'utf8'); } catch (_) { return _hang; }
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }   // dòng ghi dở (mất điện giữa chừng) → bỏ
    const dong = o && Array.isArray(o.dong) ? o.dong : null;
    const k = dong ? normalizeKey(dong[1]) : '';
    if (k && !_hang.has(k)) _hang.set(k, { t: Number(o.t) || 0, dong });
  }
  // Dòng cuối ghi dở thì dòng thêm sau sẽ DÍNH vào nó và hỏng theo — xuống dòng trước đã.
  if (txt && !/\n$/.test(txt)) {
    try { fs.appendFileSync(getFilePath(), '\n', 'utf8'); } catch (_) {}
  }
  return _hang;
}

// Thêm một dòng [tên, link, số post, thiết bị, 1]. Link đã có trong hàng chờ thì bỏ qua.
function them(dong, t = Date.now()) {
  const m = load();
  const k = normalizeKey(dong && dong[1]);
  if (!k || m.has(k)) return false;
  fs.appendFileSync(getFilePath(), JSON.stringify({ t, dong }) + '\n', 'utf8');
  m.set(k, { t, dong });
  return true;
}

function ghiLai() {
  const f = getFilePath();
  const noiDung = Array.from(_hang.values()).map((x) => JSON.stringify(x) + '\n').join('');
  const tam = f + '.tmp';
  try {
    fs.writeFileSync(tam, noiDung, 'utf8');
    fs.renameSync(tam, f);
  } catch (_) {
    // Đổi tên hỏng (vd file đang mở trong trình soạn thảo): ghi thẳng.
    try { fs.unlinkSync(tam); } catch (__) {}
    fs.writeFileSync(f, noiDung, 'utf8');
  }
}

// Gỡ những link ĐÃ LÊN SHEET. Trả số dòng gỡ được.
function bo(urls) {
  const m = load();
  let n = 0;
  for (const u of urls || []) {
    const k = normalizeKey(u);
    if (k && m.delete(k)) n++;
  }
  if (n) ghiLai();
  return n;
}

function tatCa() { return Array.from(load().values()); }
function dem() { return load().size; }

module.exports = { getFilePath, load, them, bo, tatCa, dem, FILE_NAME };
