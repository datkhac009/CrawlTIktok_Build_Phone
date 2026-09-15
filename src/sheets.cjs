// src/sheets.cjs — Đẩy dữ liệu lên Google Sheets (API v4) bằng Service Account.
//
// Cơ chế (học từ Crawl_DataTiktok_build):
//   1. Ký JWT RS256 từ service account (client_email + private_key) → đổi lấy
//      access_token OAuth2 (scope spreadsheets), cache 55 phút.
//   2. Ghi dữ liệu bằng values:append trên phạm vi A:Z (thêm dòng mới vào cuối tab,
//      dò dòng cuối xét MỌI cột — an toàn khi nhiều máy cùng ghi 1 Sheet).
//   3. Gộp lô: buffer nhiều dòng, flush khi đủ 10 dòng hoặc sau 5 giây.
// Không cần thư viện ngoài — dùng crypto + https của Node.
'use strict';

const crypto = require('crypto');
const https = require('https');
const { normalizeKey } = require('./linkkey.cjs');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const CACHE_TTL_MS = 55 * 60 * 1000;

const BATCH_SIZE = 10;
const FLUSH_MS = 5000;

// Một số máy có phần mềm diệt virus/proxy can thiệp HTTPS khiến Node không xác minh
// được chứng chỉ Google. Agent này bỏ qua xác minh để vẫn gọi được API trong môi trường đó.
const _insecureAgent = new https.Agent({ rejectUnauthorized: false });

function httpRequest(method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { ...headers },
      agent: _insecureAgent,
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function normalizeServiceAccount(sa) {
  if (!sa) return null;
  if (typeof sa === 'string') {
    try { sa = JSON.parse(sa); } catch (_) { return null; }
  }
  const email = sa.client_email || sa.email;
  const privateKey = sa.private_key;
  if (!email || !privateKey) return null;
  return { email, privateKey: privateKey.replace(/\\n/g, '\n') };
}

const _tokenCache = new Map(); // email -> { token, expiresAt }

async function getToken(sa) {
  const norm = normalizeServiceAccount(sa);
  if (!norm) throw new Error('Service Account không hợp lệ (thiếu client_email/private_key).');

  const cached = _tokenCache.get(norm.email);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: norm.email, scope: SCOPE, aud: TOKEN_URL, exp: now + 3600, iat: now,
  }));
  const signingInput = `${header}.${claim}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(norm.privateKey);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const resp = await httpRequest('POST', TOKEN_URL, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
  });

  let data;
  try { data = JSON.parse(resp.body); } catch (_) { data = {}; }
  if (!data.access_token) throw new Error(`Lấy token thất bại: ${resp.body.slice(0, 200)}`);

  _tokenCache.set(norm.email, { token: data.access_token, expiresAt: Date.now() + CACHE_TTL_MS });
  return data.access_token;
}

function extractSpreadsheetId(idOrUrl) {
  if (!idOrUrl) return '';
  const m = String(idOrUrl).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : String(idOrUrl).trim();
}

// Append nhiều dòng vào cuối tab. Dùng A:Z để dò ĐÚNG dòng cuối xét mọi cột (kể cả cột
// E Tình trạng) — tránh append ghi nhầm vào giữa bảng.
async function appendRows(spreadsheetId, tab, rows, sa) {
  if (!rows.length) return;
  const token = await getToken(sa);
  const range = encodeURIComponent(`${tab}!A:Z`);
  const url = `${SHEETS_BASE}/${spreadsheetId}/values/${range}:append`
    + `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const resp = await httpRequest('POST', url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: { values: rows },
  });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`append HTTP ${resp.status}: ${resp.body.slice(0, 200)}`);
  }
}

// Đọc cột Link (cột B) đã có trên tab → mảng link, để lọc trùng.
async function readLinks(spreadsheetId, tab, sa) {
  const id = extractSpreadsheetId(spreadsheetId);
  if (!id) return [];
  const token = await getToken(sa);
  const range = encodeURIComponent(`${tab || 'Data'}!B:B`);
  const resp = await httpRequest('GET',
    `${SHEETS_BASE}/${id}/values/${range}?majorDimension=ROWS`,
    { headers: { 'Authorization': `Bearer ${token}` } });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`đọc Sheet HTTP ${resp.status}: ${resp.body.slice(0, 200)}`);
  }
  let data;
  try { data = JSON.parse(resp.body); } catch (_) { data = {}; }
  const rows = data.values || [];
  return rows.map(r => (r && r[0] ? String(r[0]).trim() : '')).filter(Boolean);
}

// Link ĐÃ CÓ trên Sheet (từ máy này lẫn máy khác) — chặn trùng LIÊN MÁY ở cửa đẩy.
const _knownLinks = new Set();
function updateKnownLinks(links) {
  let added = 0;
  for (const u of (links || [])) {
    const k = normalizeKey(u);
    if (k && !_knownLinks.has(k)) { _knownLinks.add(k); added++; }
  }
  dropFromBuffer(links);
  return added;
}

// ĐẨY BÙ THỦ CÔNG: chỉ đẩy dòng CHƯA có trên Sheet (idempotent). rows = [[...], ...] với
// r[1] = link. Đọc lại cột B mới nhất → lọc bỏ dòng đã có → append phần còn lại.
async function pushDedup(cfgRaw, rows) {
  const spreadsheetId = extractSpreadsheetId(cfgRaw.spreadsheetId);
  const tab = cfgRaw.tab || 'Data';
  const sa = cfgRaw.sa;
  if (!spreadsheetId || !sa) return { ok: false, msg: 'Chưa cấu hình Google Sheet (ID/Service Account).' };
  if (!Array.isArray(rows) || !rows.length) return { ok: false, msg: 'Bảng dữ liệu đang trống.' };

  const existing = new Set((await readLinks(spreadsheetId, tab, sa)).map(normalizeKey));
  const fresh = [];
  const seenInBatch = new Set();
  for (const r of rows) {
    const key = normalizeKey(r && r[1]);
    if (!key || existing.has(key) || seenInBatch.has(key)) continue;
    seenInBatch.add(key);
    fresh.push(r);
  }
  if (!fresh.length) return { ok: true, pushed: 0, skipped: rows.length, total: rows.length };

  for (let i = 0; i < fresh.length; i += 200) {
    await appendRows(spreadsheetId, tab, fresh.slice(i, i + 200), sa);
  }
  for (const r of fresh) { const k = normalizeKey(r && r[1]); if (k) _knownLinks.add(k); }
  return { ok: true, pushed: fresh.length, skipped: rows.length - fresh.length, total: rows.length };
}

async function testConnection(spreadsheetId, sa) {
  const id = extractSpreadsheetId(spreadsheetId);
  if (!id) return { ok: false, msg: 'Thiếu Spreadsheet ID.' };
  let token;
  try { token = await getToken(sa); }
  catch (e) { return { ok: false, msg: e.message }; }

  const resp = await httpRequest('GET',
    `${SHEETS_BASE}/${id}?fields=properties.title,sheets.properties.title`,
    { headers: { 'Authorization': `Bearer ${token}` } });

  if (resp.status === 200) {
    let title = '', tabs = [];
    try {
      const d = JSON.parse(resp.body);
      title = d.properties?.title || '';
      tabs = (d.sheets || []).map(s => s.properties?.title).filter(Boolean);
    } catch (_) {}
    return { ok: true, msg: `Kết nối OK: "${title}"`, title, tabs };
  }
  if (resp.status === 403) return { ok: false, msg: 'Bị từ chối (403). Hãy chia sẻ Sheet cho email service account (quyền Editor).' };
  if (resp.status === 404) return { ok: false, msg: 'Không tìm thấy Sheet (404). Kiểm tra lại Spreadsheet ID.' };
  return { ok: false, msg: `HTTP ${resp.status}: ${resp.body.slice(0, 200)}` };
}

// ── Batch writer (1 sheet chung cho mọi thiết bị) ──
let _cfg = null;
let _buffer = [];
let _timer = null;
let _flushChain = Promise.resolve();
let _onError = null;

function configure(cfg, onError) {
  _cfg = cfg && cfg.enabled ? {
    enabled: true,
    spreadsheetId: extractSpreadsheetId(cfg.spreadsheetId),
    tab: cfg.tab || 'Data',
    sa: cfg.sa,
  } : null;
  _onError = onError || null;
}

function isEnabled() { return !!_cfg; }

function enqueue(row) {
  if (!_cfg) return;
  const key = normalizeKey(row && row[1]);
  if (key && _knownLinks.has(key)) return;
  if (key && _buffer.some(r => normalizeKey(r && r[1]) === key)) return;
  _buffer.push(row);
  if (_buffer.length >= BATCH_SIZE) flush();
  else ensureTimer();
}

function dropFromBuffer(links) {
  const keys = new Set((links || []).map(normalizeKey).filter(Boolean));
  if (!keys.size) return;
  _buffer = _buffer.filter(r => !keys.has(normalizeKey(r && r[1])));
}

function ensureTimer() {
  if (_timer) return;
  _timer = setTimeout(() => { _timer = null; flush(); }, FLUSH_MS);
}

function flush() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (!_cfg || !_buffer.length) return _flushChain;
  const rows = _buffer.filter(r => {
    const k = normalizeKey(r && r[1]);
    return !(k && _knownLinks.has(k));
  });
  _buffer = [];
  if (!rows.length) return _flushChain;
  const cfg = _cfg;
  _flushChain = _flushChain
    .then(() => appendRows(cfg.spreadsheetId, cfg.tab, rows, cfg.sa))
    .then(() => {
      for (const r of rows) { const k = normalizeKey(r && r[1]); if (k) _knownLinks.add(k); }
    })
    .catch(e => {
      console.error('[sheets] flush lỗi:', e.message);
      // KHÔNG bỏ rơi lô lỗi: trả về đầu buffer để timer thử lại sau.
      _buffer = rows.concat(_buffer);
      ensureTimer();
      if (_onError) _onError(e.message);
    });
  return _flushChain;
}

async function flushAll() {
  flush();
  await _flushChain;
}

module.exports = {
  testConnection, readLinks, extractSpreadsheetId,
  configure, isEnabled, enqueue, flush, flushAll,
  pushDedup, dropFromBuffer, updateKnownLinks,
};
