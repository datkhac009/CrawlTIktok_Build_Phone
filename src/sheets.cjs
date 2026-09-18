// src/sheets.cjs — Đẩy dữ liệu lên Google Sheets (API v4) bằng Service Account.
//
// Cơ chế (học từ CrawlView_App):
//   1. Ký JWT RS256 từ service account (client_email + private_key) → đổi lấy
//      access_token OAuth2 (scope spreadsheets), cache 55 phút.
//   2. Ghi dữ liệu bằng values:append trên phạm vi A:Z (thêm dòng mới vào cuối tab,
//      dò dòng cuối xét MỌI cột — an toàn khi nhiều máy/tiến trình cùng ghi 1 Sheet).
//   3. Gộp lô: buffer nhiều dòng, flush khi đủ 10 dòng hoặc sau 5 giây.
// Không cần thư viện ngoài — dùng crypto + https của Node.
'use strict';

const crypto = require('crypto');
const https = require('https');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const CACHE_TTL_MS = 55 * 60 * 1000;

const BATCH_SIZE = 10;
// Trần số dòng nằm chờ trong buffer khi Sheet lỗi kéo dài. ~200 byte/dòng → 20.000 dòng ≈ 4 MB:
// đủ rộng để chịu được vài giờ gián đoạn mà vẫn có điểm dừng, không phình tới hết bộ nhớ.
const MAX_BUFFER_ROWS = 20000;
const FLUSH_MS = 5000;

// Một số máy có phần mềm diệt virus/proxy can thiệp HTTPS (SSL interception) khiến
// Node không xác minh được chứng chỉ Google ("unable to verify the first certificate").
// Agent này bỏ qua xác minh chứng chỉ để vẫn gọi được API trong môi trường đó.
const _insecureAgent = new https.Agent({ rejectUnauthorized: false });

// ── Tiện ích HTTP (Promise) ──
// ⏱ BẮT BUỘC có timeout (fix 2026-08-04). Trước đây chỉ bắt 'error', nên khi kết nối ĐỨNG IM
// (mạng qua VPN, firewall chặn, Sheet quá lớn phản hồi chậm) thì Promise KHÔNG BAO GIỜ
// resolve. Hậu quả thật: `profile-start` await readLinks để lọc trùng → handler IPC treo vô
// hạn → nhấn "Chạy đã chọn" chỉ hiện "Đang khởi động..." rồi đứng mãi, không báo lỗi gì.
// Hai lớp: idleMs = không nhận được byte nào trong X giây; overallMs = trần tổng thời gian
// (Sheet lớn vẫn tải được vì mỗi byte về đều làm mới đồng hồ idle).
const HTTP_IDLE_MS = 30 * 1000;
const HTTP_OVERALL_MS = 180 * 1000;

function httpRequest(method, url, { headers = {}, body = null,
                                    idleMs = HTTP_IDLE_MS, overallMs = HTTP_OVERALL_MS } = {}) {
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
    if (data) {
      opts.headers['Content-Length'] = Buffer.byteLength(data);
    }
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(overall); fn(arg); };

    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => finish(resolve, { status: res.statusCode, body: buf }));
      res.on('error', e => finish(reject, e));
    });
    const overall = setTimeout(() => {
      req.destroy(new Error(`quá ${Math.round(overallMs / 1000)}s không xong — hủy yêu cầu`));
    }, overallMs);
    if (overall.unref) overall.unref();

    req.setTimeout(idleMs, () => {
      req.destroy(new Error(`không phản hồi trong ${Math.round(idleMs / 1000)}s — hủy yêu cầu`));
    });
    req.on('error', e => finish(reject, e));
    if (data) req.write(data);
    req.end();
  });
}

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Chấp nhận cả JSON tải từ Google (client_email/private_key) lẫn {email,private_key}.
function normalizeServiceAccount(sa) {
  if (!sa) return null;
  const email = sa.client_email || sa.email;
  const privateKey = sa.private_key;
  if (!email || !privateKey) return null;
  return { email, privateKey: privateKey.replace(/\\n/g, '\n') };
}

// ── Token cache theo email ──
const _tokenCache = new Map(); // email -> { token, expiresAt }

async function getToken(sa) {
  const norm = normalizeServiceAccount(sa);
  if (!norm) throw new Error('Service Account không hợp lệ (thiếu client_email/private_key).');

  const cached = _tokenCache.get(norm.email);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: norm.email,
    scope: SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  }));
  const signingInput = `${header}.${claim}`;
  const signature = crypto.createSign('RSA-SHA256')
    .update(signingInput)
    .sign(norm.privateKey);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const resp = await httpRequest('POST', TOKEN_URL, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
  });

  let data;
  try { data = JSON.parse(resp.body); } catch (_) { data = {}; }
  if (!data.access_token) {
    throw new Error(`Lấy token thất bại: ${resp.body.slice(0, 200)}`);
  }

  _tokenCache.set(norm.email, { token: data.access_token, expiresAt: Date.now() + CACHE_TTL_MS });
  return data.access_token;
}

// Tách spreadsheet ID từ URL hoặc trả lại nguyên nếu đã là ID.
function extractSpreadsheetId(idOrUrl) {
  if (!idOrUrl) return '';
  const m = String(idOrUrl).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : String(idOrUrl).trim();
}

// ── Append nhiều dòng vào cuối tab (atomic phía Google — AN TOÀN khi nhiều máy/tiến
// trình cùng ghi vào một Sheet, vì mỗi request được Google xử lý tuần tự, không có
// khoảng hở "đọc dòng cuối rồi tự ghi cứng" như cách tự tính dòng ở client). ──
//
// LƯU Ý phạm vi: dùng A:Z (không phải A:D) để append DÒ ĐÚNG dòng cuối thật của bảng
// xét MỌI cột — nếu chỉ dùng A:D, khi cột E/F (vd cột Tình trạng người dùng tự điền)
// có dữ liệu dài hơn cột A:D, append sẽ bị đánh lừa và điền NHẦM vào giữa bảng (đã gặp
// thực tế: A:D hết ở dòng 7143, E/F tới 15876 → append ghi đè vào 7144 thay vì 15877).
// Values chỉ có 4 cột (Tên/Link/Video/Profile) — Google chỉ ghi đúng 4 cột đó của dòng
// mới, các cột còn lại (E→Z) của dòng mới vẫn để trống, không ảnh hưởng gì.
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

// ── Đọc cột Link (cột B) đã có sẵn trên tab → mảng link, để lọc trùng ──
// Sheet thật của người dùng có ~172.000 dòng → phản hồi rất nặng và mất hàng chục giây.
// Hai điều chỉnh cho vừa với cỡ đó:
//  1) majorDimension=COLUMNS: trả về MỘT mảng ["url", "url", …] thay vì 172.000 mảng con
//     [["url"],["url"],…] — bớt được hàng trăm KB dấu ngoặc, parse cũng nhanh hơn.
//  2) Nới timeout riêng cho lệnh này (mặc định của httpRequest quá chặt với Sheet lớn).
async function readLinks(spreadsheetId, tab, sa, { idleMs = 120000, overallMs = 420000, fromRow = 1 } = {}) {
  const id = extractSpreadsheetId(spreadsheetId);
  if (!id) return [];
  const token = await getToken(sa);
  const start = Math.max(1, parseInt(fromRow, 10) || 1);
  const range = encodeURIComponent(`${tab || 'Data'}!B${start}:B`);
  const resp = await httpRequest('GET',
    `${SHEETS_BASE}/${id}/values/${range}?majorDimension=COLUMNS`,
    { headers: { 'Authorization': `Bearer ${token}` }, idleMs, overallMs });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`đọc Sheet HTTP ${resp.status}: ${resp.body.slice(0, 200)}`);
  }
  let data;
  try { data = JSON.parse(resp.body); } catch (_) { data = {}; }
  const col = (data.values && data.values[0]) || [];   // COLUMNS → phần tử [0] là cả cột B
  const links = col.map(v => String(v || '').trim()).filter(Boolean);
  // rowsRead đếm CẢ ô rỗng — người gọi cần nó để biết lần sau đọc tiếp từ dòng nào.
  // Đặt làm thuộc tính ẩn để không phá kiểu trả về (vẫn là mảng link như trước).
  Object.defineProperty(links, 'rowsRead', { value: col.length, enumerable: false });
  Object.defineProperty(links, 'nextRow', { value: start + col.length, enumerable: false });
  return links;
}

// Khóa so trùng dùng CHUNG với crawler.cjs (src/linkkey.cjs) — trước đây là bản copy
// riêng và ĐÃ TỪNG LỆCH (crawler thêm rút gọn link 2026-07-12, bản ở đây không theo →
// link dài cũ và link ngắn mới bị coi là 2 sound → nút đẩy bù tạo trùng).
const { normalizeKey } = require('./linkkey.cjs');

// ── Link ĐÃ CÓ trên Sheet (từ máy này lẫn máy khác) — chặn trùng LIÊN MÁY ở cửa đẩy ──
// Nạp lúc bắt đầu phiên + cập nhật định kỳ (main.js đọc lại cột B). Mọi đường đẩy tự
// động (enqueue/flush) đều bỏ qua link có trong đây.
const _knownLinks = new Set();

// ── Link ĐÃ GHI THÀNH CÔNG vào tab PENDING trong phiên này (2026-08-06) ──
// TÁCH RIÊNG khỏi _knownLinks ở trên vì hai tập có NGHĨA khác nhau: _knownLinks = "đã có
// trên bảng CHÍNH", mà link Pending thì chưa lên bảng chính. Trộn vào sẽ làm sai nghĩa của
// _knownLinks ở mọi chỗ khác dùng nó.
//
// ⚠ ĐỌC KỸ TRƯỚC KHI SỬA (ghi chú 2026-08-10): việc tách này KHÔNG có nghĩa link Pending sẽ
// được quét lại. Link Pending ghi thành công VẪN đi vào kho `known_links.txt` qua `_onPushed`
// trong `_flushState` — CỐ Ý, theo quyết định của chủ dự án: link Pending được xử lý TAY rồi
// chuyển sang bảng chính, nên app không cần quét lại. Xem QĐ-20 ghi chú 2026-08-10.
const _pendingSentLinks = new Set();

function updateKnownLinks(links) {
  let added = 0;
  for (const u of (links || [])) {
    const k = normalizeKey(u);
    if (k && !_knownLinks.has(k)) { _knownLinks.add(k); added++; }
  }
  // Gỡ luôn khỏi buffer đang chờ những link đã lên Sheet bằng đường khác (máy khác đẩy).
  dropFromBuffer(links);
  return added;
}

// ── ĐẨY BÙ THỦ CÔNG: chỉ đẩy những dòng CHƯA có trên Sheet (idempotent) ──
// rows = [[name, url, count, profile], ...] (toàn bộ bảng "Dữ liệu thu thập").
// Đọc lại cột B mới nhất trên Sheet → lọc bỏ dòng đã có → append phần còn lại theo lô.
// Bấm bao nhiêu lần cũng không tạo trùng. Trả { ok, pushed, skipped, total }.
async function pushDedup(cfgRaw, rows) {
  const spreadsheetId = extractSpreadsheetId(cfgRaw.spreadsheetId);
  const tab = cfgRaw.tab || 'Data';
  const sa = cfgRaw.sa;
  if (!spreadsheetId || !sa) return { ok: false, msg: 'Chưa cấu hình Google Sheet (ID/Service Account).' };
  if (!Array.isArray(rows) || !rows.length) return { ok: false, msg: 'Bảng dữ liệu đang trống.' };

  // Link đã có trên Sheet (đọc MỚI ngay lúc bấm — thấy cả những gì máy khác vừa ghi).
  const existing = new Set((await readLinks(spreadsheetId, tab, sa)).map(normalizeKey));

  const fresh = [];
  const seenInBatch = new Set(); // chống trùng ngay trong chính bảng gửi lên
  for (const r of rows) {
    const key = normalizeKey(r && r[1]);
    if (!key || existing.has(key) || seenInBatch.has(key)) continue;
    seenInBatch.add(key);
    fresh.push(r);
  }
  if (!fresh.length) return { ok: true, pushed: 0, skipped: rows.length, total: rows.length };

  // Append theo lô 200 dòng/lần cho nhẹ request.
  for (let i = 0; i < fresh.length; i += 200) {
    await appendRows(spreadsheetId, tab, fresh.slice(i, i + 200), sa);
  }
  return { ok: true, pushed: fresh.length, skipped: rows.length - fresh.length, total: rows.length };
}

// ── Kiểm tra kết nối: đọc metadata spreadsheet ──
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
    let title = '';
    let tabs = [];
    try {
      const d = JSON.parse(resp.body);
      title = d.properties?.title || '';
      tabs = (d.sheets || []).map(s => s.properties?.title).filter(Boolean);
    } catch (_) {}
    return { ok: true, msg: `Kết nối OK: "${title}"`, title, tabs };
  }
  if (resp.status === 403) {
    return { ok: false, msg: 'Bị từ chối (403). Hãy chia sẻ Sheet cho email service account (quyền Editor).' };
  }
  if (resp.status === 404) {
    return { ok: false, msg: 'Không tìm thấy Sheet (404). Kiểm tra lại Spreadsheet ID.' };
  }
  return { ok: false, msg: `HTTP ${resp.status}: ${resp.body.slice(0, 200)}` };
}

// ── Batch writer (1 sheet chung cho mọi profile, NHIỀU TAB) ──
//
// 2026-08-06: thêm tab PENDING (link không đọc được số video, đẩy đây thay vì bỏ hẳn —
// yêu cầu chủ dự án). TUYỆT ĐỐI KHÔNG copy-paste một bộ máy gộp lô/flush/retry thứ hai cho
// tab Pending — bài học QĐ-10 (đọc DECISIONS.md): "khi có ≥2 bản sao của cùng một logic,
// chúng SẼ lệch nhau", đã xảy ra thật với hàm chuẩn hóa link. Nên ở đây TỔNG QUÁT HÓA: mỗi
// tab có một "state" riêng (rows đang chờ + timer riêng), nhưng dùng CHUNG một hàm
// enqueue/flush/retry, và CHUNG một `_flushChain` để tuần tự hóa mọi request ghi lên cùng
// một spreadsheet (tránh 2 lô của 2 tab chen ngang nhau).
let _cfg = null;          // { enabled, spreadsheetId, tab, pendingTab, sa }
let _flushChain = Promise.resolve();
let _onError = null;      // callback báo lỗi ra UI

// state.sentSet = tập link đã ghi THÀNH CÔNG vào ĐÚNG tab này trong phiên — dùng để (a) lọc
// chốt chặn cuối trước khi gửi lô (link vừa lên Sheet bằng đường khác giữa lúc nằm chờ
// buffer), (b) không xếp hàng lại link vừa flush xong nếu bị enqueue lần nữa.
function _makeTabState(sentSet) {
  return { tabName: null, rows: [], timer: null, sentSet };
}
// Bảng CHÍNH: sentSet CHÍNH LÀ _knownLinks — cố ý dùng chung vì _knownLinks vốn đã đóng vai
// trò "link đã có trên Sheet CHÍNH" cho toàn bộ app (readLinks định kỳ cũng ghi vào đây).
const _mainState = _makeTabState(_knownLinks);
// Tab Pending: null khi chưa cấu hình `pendingTab` — mọi lời gọi enqueuePending() sẽ no-op.
let _pendingState = null;

// Báo cho bên ngoài biết những link vừa GHI THÀNH CÔNG lên Sheet — main.js dùng để ghi luôn
// vào kho link cục bộ (linkstore), không phải đợi vòng đồng bộ sau đọc ngược về. Nếu đợi,
// app tắt giữa chừng là những link vừa đẩy không kịp vào kho.
let _onPushed = null;
function setOnPushed(fn) { _onPushed = typeof fn === 'function' ? fn : null; }

function configure(cfg, onError) {
  _cfg = cfg && cfg.enabled ? {
    enabled: true,
    spreadsheetId: extractSpreadsheetId(cfg.spreadsheetId),
    tab: cfg.tab || 'Data',
    // Để TRỐNG = TẮT hẳn tính năng Pending. KHÔNG tự bật/suy đoán tên tab: Sheet của người
    // khác chưa chắc có tab đó, bật nhầm sẽ làm append lỗi liên tục ở mọi lần đẩy.
    pendingTab: (cfg.pendingTab || '').trim(),
    sa: cfg.sa,
  } : null;
  _onError = onError || null;

  _mainState.tabName = _cfg ? _cfg.tab : null;
  if (_cfg && _cfg.pendingTab) {
    _pendingState = _pendingState || _makeTabState(_pendingSentLinks);
    _pendingState.tabName = _cfg.pendingTab;
  } else {
    // Tắt cấu hình hoặc bỏ trống tên tab Pending → không còn nơi để flush tới. Rows đang
    // chờ (nếu có, hiếm khi xảy ra) coi như mất — chấp nhận được vì đây là do người dùng
    // chủ động tắt tính năng, không phải lỗi mạng.
    _pendingState = null;
  }
}

function isEnabled() { return !!_cfg; }

// Lõi dùng CHUNG cho enqueue() (bảng chính) và enqueuePending() (tab Pending).
// Trả về true nếu dòng THỰC SỰ được xếp vào hàng đợi, false nếu bị bỏ qua (trùng/tắt tính
// năng) — bên gọi (crawler.cjs) dùng giá trị này để log đúng thực tế thay vì đoán.
function _enqueueGeneric(state, row) {
  if (!_cfg || !state) return false;
  const key = normalizeKey(row && row[1]);
  // Chống trùng LIÊN MÁY: link đã có trên bảng CHÍNH (máy khác đẩy, biết qua lần đọc lại
  // định kỳ, hoặc chính máy này vừa ghi) → bỏ ngay từ cửa. Áp dụng cho CẢ Pending: sound đã
  // có số THẬT trên bảng chính rồi thì đẩy nó vào Pending nữa là thừa.
  if (key && _knownLinks.has(key)) return false;
  // Chống trùng: link đã ghi thành công vào ĐÚNG tab này trong phiên rồi.
  if (key && state.sentSet.has(key)) return false;
  // Chống trùng ngay trong buffer của ĐÚNG tab này (vd lô lỗi được trả về từ phiên trước,
  // phiên mới quét lại trúng nó) → bỏ, không xếp hàng 2 lần.
  if (key && state.rows.some(r => normalizeKey(r && r[1]) === key)) return false;
  state.rows.push(row);
  if (state.rows.length >= BATCH_SIZE) _flushState(state);
  else _ensureTimer(state);
  return true;
}

function enqueue(row) { _enqueueGeneric(_mainState, row); }

// Đẩy 1 dòng sang tab PENDING (link không đọc được số video — API lẫn DOM đều lỗi, nhưng
// sound CHƯA CHẮC chết, khác với dead=true đã bị bỏ hẳn ở crawler.cjs). Cột Số Video (index
// 2) LUÔN ép về '' ngay tại đây — không tin caller nhớ đúng, tránh lặp lại kiểu lỗi QĐ-10.
//
// ⚠ GIỚI HẠN CHỐNG TRÙNG còn lại (nêu rõ, KHÔNG tự ý vá thêm): app KHÔNG đọc lại tab Pending
// như nó đọc tab chính (readLinks/updateKnownLinks).
//   - CÙNG MÁY, khác phiên: ĐÃ CHỐNG ĐƯỢC từ 2026-08-10 — link Pending vào kho known_links.txt
//     nên phiên sau không quét lại nó nữa (chặn ngay ở crawler._collected).
//   - KHÁC MÁY: VẪN CÓ THỂ TRÙNG. Máy B không biết máy A vừa pend link nào. Chỉ hết trùng khi
//     người dùng xử lý tay dòng Pending rồi chuyển sang bảng chính — lúc đó vòng đọc tab chính
//     sẽ mang link đó sang mọi máy như bình thường.
function enqueuePending(row) {
  if (!_pendingState) return false; // chưa cấu hình pendingTab → tính năng TẮT, giữ hành vi cũ (bỏ link)
  const safeRow = [(row && row[0]) || '', (row && row[1]) || '', '', (row && row[3]) || ''];
  return _enqueueGeneric(_pendingState, safeRow);
}

// Gỡ khỏi buffer BẢNG CHÍNH những dòng có link nằm trong danh sách đã lên Sheet bằng đường
// khác (nút đẩy bù) — để buffer retry không đẩy lại lần nữa gây trùng. CHỈ áp dụng cho bảng
// chính: nút đẩy bù đọc/ghi tab chính, không liên quan tab Pending.
function dropFromBuffer(links) {
  const keys = new Set((links || []).map(normalizeKey).filter(Boolean));
  if (!keys.size) return;
  _mainState.rows = _mainState.rows.filter(r => !keys.has(normalizeKey(r && r[1])));
}

function _ensureTimer(state) {
  if (state.timer) return;
  state.timer = setTimeout(() => { state.timer = null; _flushState(state); }, FLUSH_MS);
}

function _flushState(state) {
  if (!state) return _flushChain;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (!_cfg || !state.tabName || !state.rows.length) return _flushChain;
  // Lọc lần cuối trước khi ghi: bỏ dòng đã lên Sheet bằng đường khác trong lúc nằm chờ
  // buffer (máy khác đẩy giữa 2 lần đọc lại, hoặc đã tự ghi thành công ở lượt trước đó).
  const rows = state.rows.filter(r => {
    const k = normalizeKey(r && r[1]);
    return !(k && (_knownLinks.has(k) || state.sentSet.has(k)));
  });
  state.rows = [];
  if (!rows.length) return _flushChain;
  const cfg = _cfg;
  const tabName = state.tabName;
  _flushChain = _flushChain
    .then(() => appendRows(cfg.spreadsheetId, tabName, rows, cfg.sa))
    .then(() => {
      // Ghi thành công → các link này giờ ĐÃ có trên tab này, ghi nhớ để mọi đường đẩy
      // sau (kể cả buffer retry) không bao giờ đẩy lại VÀO ĐÚNG TAB NÀY.
      for (const r of rows) { const k = normalizeKey(r && r[1]); if (k) state.sentSet.add(k); }
      // Ghi thẳng vào kho link cục bộ ngay khi Sheet đã nhận — xem `setOnPushed`.
      // ⚠ CỐ Ý áp dụng cho MỌI tab, gồm cả tab PENDING (quyết định 2026-08-10, QĐ-20): link
      // đã pend rồi thì phiên sau không quét lại nữa, vì người dùng xử lý tay dòng Pending rồi
      // tự chuyển sang bảng chính. ĐỪNG thêm điều kiện `state === _mainState` ở đây —
      // tests/sheets-pending.test.cjs phép thử 8 sẽ ĐỎ ngay.
      if (_onPushed) {
        try { _onPushed(rows.map(r => r && r[1]).filter(Boolean)); } catch (_) {}
      }
    })
    .catch(e => {
      console.error(`[sheets] flush lỗi (tab "${tabName}"):`, e.message);
      // KHÔNG bỏ rơi lô lỗi (trước đây lô lỗi bị mất luôn → "nghẽn" là mất data):
      // trả các dòng về ĐẦU buffer để timer thử đẩy lại sau. Nếu lỗi kéo dài, dữ liệu
      // vẫn nằm chờ trong buffer + user có nút "Đẩy lên Sheet" để đẩy bù thủ công (bảng chính).
      state.rows = rows.concat(state.rows);
      // TRẦN BUFFER (bổ sung 2026-08-07): trả lô lỗi về buffer là đúng, nhưng KHÔNG có trần
      // thì Google gián đoạn kéo dài trong lúc crawl mạnh sẽ làm buffer phình vô hạn.
      // Cắt phần CŨ NHẤT và báo THẲNG số dòng mất — thà mất có kiểm soát và biết rõ, còn hơn
      // phình tới lúc hết bộ nhớ rồi mất sạch. Dữ liệu bị cắt vẫn còn trong bảng "Dữ liệu thu
      // thập" trên giao diện, đẩy bù lại được bằng nút ☁ khi Sheet hoạt động trở lại.
      if (state.rows.length > MAX_BUFFER_ROWS) {
        const dropped = state.rows.length - MAX_BUFFER_ROWS;
        state.rows.splice(0, dropped);
        const warn = `Sheet lỗi kéo dài — hàng đợi đẩy vượt ${MAX_BUFFER_ROWS} dòng, đã BỎ ${dropped} dòng cũ nhất `
          + `(tab "${tabName}"). Dùng nút ☁ "Đẩy lên Sheet" để đẩy bù từ bảng khi Sheet chạy lại.`;
        console.error('[sheets]', warn);
        if (_onError) _onError(warn);
      }
      _ensureTimer(state);
      if (_onError) _onError(e.message);
    });
  return _flushChain;
}

function flush() { return _flushState(_mainState); }

async function flushAll() {
  _flushState(_mainState);
  if (_pendingState) _flushState(_pendingState);
  await _flushChain;
}

module.exports = {
  testConnection,
  readLinks,
  extractSpreadsheetId,
  configure,
  setOnPushed,
  isEnabled,
  enqueue,
  enqueuePending,
  flush,
  flushAll,
  pushDedup,
  dropFromBuffer,
  updateKnownLinks,
  // — export phục vụ test (tests/sheets-pending.test.cjs) —
  _mainState,
  _getPendingState: () => _pendingState,
  _knownLinks,
  _pendingSentLinks,
};
