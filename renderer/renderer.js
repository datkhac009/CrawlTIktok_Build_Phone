'use strict';

// ---- State ----
let devices = [];               // [{id,name,serial,note}]
let deviceSettings = {};        // deviceId -> {minPosts,maxPosts,delayMin,delayMax,originalOnly,limit}
let deviceState = {};           // deviceId -> {status, checked, qualified, log:[]}
let crawlResults = [];          // full data giữ trong JS để export
let settingsTargetIds = [];     // danh sách deviceId đang sửa trong modal cài đặt
let currentLogDeviceId = null;

// Nguồn sự thật cho giá trị mặc định. Thuộc tính `value=` trong HTML chỉ là trang trí —
// `openSettingsModal` luôn ghi đè từ đây, đúng như bản PC làm.
const DEFAULT_SETTINGS = {
  minPosts: 1000,
  maxPosts: 100000,
  delayMin: 3,
  delayMax: 6,
  // Trần chờ, không phải giấc ngủ — Python dò thấy rồi là đi tiếp ngay.
  musicWaitSec: 8,
  settleSec: 1.2,
  originalOnly: true,
  limit: 0,

  // Chu kỳ — thứ làm hàng đợi chảy khi số máy nhiều hơn trần song song
  cycleOn: false,
  cycleScanMinutes: 30,
  cycleBreakMin: 5,
  cycleBreakMax: 10,

  // ── Chế độ (2026-09-18) ──
  // 'foryou' = quét For You như trước. 'cycle' = Quét ⇄ Xem, clone chế độ cùng tên bản PC.
  // Tên khoá và mặc định GIỮ ĐÚNG như bản PC (`cycleScanHours` 5 giờ, `cycleViewMinutes` 30
  // phút, `viewScroll*` 20–30) — sau này chép qua lại giữa hai app không phải dịch tên.
  mode: 'foryou',
  cycleScanHours: 5,
  cycleViewMinutes: 30,
  viewLinks: '',
  // Khác bản PC: bản PC xem 40–70% ĐỘ DÀI video (`viewPctMin/Max`). Điện thoại không đọc được
  // độ dài video (đã đo trên máy thật), nên tính bằng GIÂY — khoá mới, không mượn tên cũ.
  viewSecMin: 10,
  viewSecMax: 20,
  viewScrollMin: 20,
  viewScrollMax: 30,

  // Lọc nội dung. Hai ô bấm mặc định TẮT: cú "Not interested" dạy feed vĩnh viễn.
  niEnabled: false,
  niAi: false,
  // KHÔNG THU sound khớp bộ lọc — mặc định BẬT, ngược với hai ô trên, vì giá khác hẳn: bỏ một
  // link là rẻ và đảo ngược được (clone bản PC v0.1.102).
  niBlockCollect: true,
  niScripts: ['bengali', 'urdu', 'pashto', 'perso', 'arabic', 'indic'],
  // (Cờ `niScriptsV2` KHÔNG nằm ở đây: nó không phải một cài đặt mà là dấu "đã nâng cấp" của cấu
  // hình ĐÃ LƯU — xem `nangCapLocNgonNgu()`. Máy chưa lưu gì thì vốn đã dùng mặc định mới này.)
  niKeywords: [
    'afghan', 'afghanistan', 'kabul', 'pashto', 'pashtun', 'kandahar',
    'pakistan', 'pakistani', 'urdu', 'karachi', 'lahore', 'islamabad',
    'bangladesh', 'bangladeshi', 'bangla', 'dhaka',
  ].join('\n'),

  // Tương tác — mặc định TẮT hết. Follow tác động lên tài khoản thật.
  followOn: false,
  followPerDay: 30,
  followGapMin: 120,
  followGapMax: 300,
  likeOn: false,
  likePerDay: 60,
  // Tỉ lệ tym: KHÔNG tym mọi video. Bốc một lần cho cả lượt chạy (xem askproto.cjs).
  likeRateMin: 40,
  likeRateMax: 60,
  visitOn: false,
  visitSecMin: 5,
  visitSecMax: 10,
  // Xem video mở trong trang cá nhân bao lâu trước khi tym.
  profileVideoSecMin: 3,
  profileVideoSecMax: 7,
  visitMaxUsers: 0,
  // Số ngày KHÔNG ghé lại một kênh đã ghé. ⚠ `0` ở đây là TẮT BỘ LỌC — ngược với trần
  // follow/tym (0 = không làm gì). Đây là bộ lọc bỏ qua, tắt lọc thì mọi kênh đi qua.
  visitSkipDays: 7,
};

// Nhóm ký tự cho bộ lọc ngôn ngữ. Danh sách này phải khớp SCRIPT_GROUPS trong
// src/langfilter.cjs — thêm nhóm bên đó mà quên ở đây thì người dùng không bật được nó.
const NI_SCRIPTS = [
  { key: 'bengali', label: 'Bengali' },
  { key: 'urdu', label: 'Urdu' },
  { key: 'pashto', label: 'Pashto' },
  { key: 'perso', label: 'Perso-Arabic' },
  { key: 'arabic', label: 'Arabic' },
  { key: 'indic', label: 'Indic' },
];

// Cài đặt TOÀN APP, không theo từng máy.
const DEFAULT_GLOBAL = {
  deviceConcurrency: 6,
  launchStaggerMs: 3000,
};
let globalSettings = { ...DEFAULT_GLOBAL };

const MAX_RESULT_ROWS = 5000;
const MAX_LOG_LINES = 500;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toast(msg, ok = true) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + (ok ? 'ok' : 'err');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 2600);
}

function getSettingsFor(deviceId) {
  return Object.assign({}, DEFAULT_SETTINGS, deviceSettings[deviceId] || {});
}

// ── NÂNG CẤP CẤU HÌNH MỘT LẦN: bật chặn chữ Ả Rập + chữ Ấn Độ (2026-09-18, y hệt bản PC) ──
//
// VÌ SAO CẦN: đổi DEFAULT_SETTINGS là VÔ TÁC DỤNG với máy đã lưu cài đặt — `getSettingsFor()`
// trộn mặc định với cấu hình ĐÃ LƯU, và mảng `niScripts` đã lưu thắng tuyệt đối. Không có hàm
// này thì cập nhật xong, chạy lại, vẫn thấy y nguyên sound chữ Ả Rập, và kết luận là bản vá
// không chạy.
//
// Chạy ĐÚNG MỘT LẦN nhờ cờ `niScriptsV2`: sau đó ai bỏ tích thì nó ở yên đã bỏ tích. Có báo ra
// bằng toast — không đổi cấu hình của người ta trong im lặng.
function nangCapLocNgonNgu() {
  const daDoi = [];
  for (const id of Object.keys(deviceSettings)) {
    const st = deviceSettings[id];
    if (!st || st.niScriptsV2) continue;
    const ds = Array.isArray(st.niScripts) ? st.niScripts.slice() : DEFAULT_SETTINGS.niScripts.slice();
    for (const k of ['arabic', 'indic']) if (!ds.includes(k)) ds.push(k);
    st.niScripts = ds;
    if (st.niBlockCollect === undefined) st.niBlockCollect = true;
    st.niScriptsV2 = true;
    daDoi.push(id);
  }
  return daDoi;
}

// ---- Bootstrap ----
async function init() {
  const ver = await window.api.getVersion();
  document.getElementById('appVersion').textContent = ver ? `v${ver}` : '';

  const stored = await window.api.storeGet(['device_settings', 'global_settings']);
  deviceSettings = stored.device_settings || {};
  const daNang = nangCapLocNgonNgu();
  if (daNang.length) {
    await window.api.storeSet({ device_settings: deviceSettings });
    toast(`Đã bật chặn chữ Ả Rập + chữ Ấn Độ cho ${daNang.length} máy. Bỏ tích trong Cài đặt nếu không muốn.`, true);
  }
  globalSettings = Object.assign({}, DEFAULT_GLOBAL, stored.global_settings || {});
  // Day xuong tien trinh chinh NGAY luc khoi dong: neu chi day luc bam Luu thi lan chay dau
  // tien sau khi mo app se dung tran mac dinh chu khong phai tran nguoi dung da dat.
  await window.api.setGlobalSettings(globalSettings);
  refreshPendingConfigured();

  devices = await window.api.devicesList();
  devices.forEach((d) => {
    deviceState[d.id] = { status: 'stop', checked: 0, qualified: 0, log: [] };
  });

  const runningIds = await window.api.crawlRunningIds();
  runningIds.forEach((id) => {
    if (deviceState[id]) deviceState[id].status = 'run';
  });

  renderDeviceTable();
  renderResultCount();

  window.api.onCrawlData((payload) => onCrawlData(payload));
  window.api.onCrawlStatus((payload) => onCrawlStatus(payload));
}

// ---- Crawl events từ main process ----
function onCrawlData(payload) {
  const { deviceId, name, url, posts } = payload;
  const dev = devices.find((d) => d.id === deviceId);
  // Không thấy tên = máy đã bị xoá mà kết quả vẫn chảy về. Ghi thẳng ra thay vì để mã `d_…`
  // trần — chính mã trần đã khiến lỗi "máy ma" nằm im không ai nhận ra.
  const row = { name, url, posts, deviceId, deviceName: dev ? dev.name : `máy đã xoá (${deviceId})` };
  crawlResults.push(row);
  addResultRow(row, crawlResults.length);
  renderResultCount();
}

function onCrawlStatus(payload) {
  const { deviceId, kind } = payload;

  // Sự kiện Sheet toàn cục (deviceId = null)
  if (kind === 'sheet-info') { toast(payload.msg, true); return; }
  if (kind === 'sheet-error') { toast(`Sheet: ${payload.msg}`, false); return; }
  // Một sound vừa được cất vào tab Pending (không đọc được số post).
  if (kind === 'pending') { if (payload.ok) { soPending++; renderPendingChip(); } return; }
  // Máy vừa được dò ra IP mới (main.js: baoDoiIp) — nạp lại danh sách để cột Serial hiện IP mới.
  if (kind === 'devices-changed') { napLaiDanhSachMay(payload.doi || []); return; }

  const st = deviceState[deviceId];
  if (!st) return;

  // ── Quét ⇄ Xem: pha nào, xem tới đâu ──
  if (kind === 'phase') {
    st.phase = { key: payload.key, ms: payload.ms || 0, at: payload.at || Date.now() };
    st.viewIdx = -1;
    st.viewTotal = payload.total || 0;
    renderDeviceRow(deviceId);
    return;
  }
  if (kind === 'view') {
    if (!payload.moc) { st.viewIdx = payload.idx; st.viewTotal = payload.total; renderDeviceRow(deviceId); }
    return;
  }

  if (kind === 'status') {
    if (payload.state === 'running') st.status = 'run';
    else if (payload.state === 'queued') { st.status = 'queue'; st.queuePos = payload.pos || 0; }
    else if (payload.state === 'resting') {
      st.status = 'rest'; st.restUntil = payload.until || 0; st.restNext = payload.next || '';
      st.restLoi = !!payload.loi;     // nghỉ vì LỖI, sẽ tự chạy lại (main.js: henChayLaiSauLoi)
    }
    // Python đang chờ điện thoại nối lại ADB (scan_feed_sounds.py: cho_noi_lai).
    else if (payload.state === 'offline') st.status = 'offline';
    // Hết lượt thì bỏ thông tin pha: lượt sau có thể là For You (không có pha nào), và nhãn
    // "Quét 2g13/5g" cũ mà còn treo trên dòng là nói sai chỗ máy đang đứng.
    else if (payload.state === 'stopped') { st.status = 'stop'; st.phase = null; }
    else if (payload.state === 'error') { st.status = 'err'; toast(`Thiết bị lỗi: ${payload.msg || ''}`, false); }
    else if (payload.state === 'done') st.status = 'stop';
    if (payload.msg) appendLog(deviceId, payload.msg);
    renderDeviceRow(deviceId);
  } else if (kind === 'progress') {
    st.checked = payload.checked;
    st.qualified = payload.qualified;
    renderDeviceRow(deviceId);
  } else if (kind === 'log') {
    appendLog(deviceId, payload.line);
  }
}

// ⚠ ĐÓNG DẤU GIỜ Ở ĐÂY, MỘT CHỖ DUY NHẤT (2026-09-18).
// Trước đây Python tự thêm `[HH:MM:SS]` còn các dòng do Node viết thì không, nên nửa log có giờ
// nửa không. Đóng dấu lúc hiển thị thì mọi dòng đều có giờ, và đều theo đồng hồ của máy tính —
// không lệch theo đồng hồ từng điện thoại. Bản PC làm đúng chỗ này.
function appendLog(deviceId, line) {
  const st = deviceState[deviceId];
  if (!st) return;
  const gio = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  line = `[${gio}] ${line}`;
  st.log.push(line);
  if (st.log.length > MAX_LOG_LINES) st.log.shift();
  if (currentLogDeviceId === deviceId) {
    const body = document.getElementById('logBody');
    body.textContent += line + '\n';
    body.scrollTop = body.scrollHeight;
  }
}

// ---- Render: bảng thiết bị ----
function renderDeviceTable() {
  const tbody = document.getElementById('deviceTableBody');
  const placeholder = document.getElementById('deviceEmptyPlaceholder');
  tbody.innerHTML = '';
  placeholder.style.display = devices.length > 0 ? 'none' : 'flex';
  devices.forEach((d) => tbody.appendChild(buildDeviceRow(d)));
}

// Nạp lại danh sách máy từ đĩa khi app vừa dò ra IP mới cho vài máy (2026-09-19: DHCP xáo IP sau
// khi cả farm khởi động lại). Giữ nguyên trạng thái chạy và các ô đã tích — chỉ cột Serial đổi.
async function napLaiDanhSachMay(doi) {
  const daTich = new Set(Array.from(document.querySelectorAll('#deviceTableBody .row-check:checked'))
    .map((el) => el.dataset.id));
  devices = await window.api.devicesList();
  devices.forEach((d) => {
    if (!deviceState[d.id]) deviceState[d.id] = { status: 'stop', checked: 0, qualified: 0, log: [] };
  });
  renderDeviceTable();
  document.querySelectorAll('#deviceTableBody .row-check').forEach((el) => {
    if (daTich.has(el.dataset.id)) el.checked = true;
  });
  if (doi.length) {
    toast(`Đã cập nhật IP cho ${doi.length} máy (điện thoại nhận IP mới): `
      + doi.map((x) => `${x.name} → ${String(x.moi).split(':')[0]}`).join(', '), true);
  }
}

function buildDeviceRow(d) {
  const tr = document.createElement('tr');
  tr.dataset.id = d.id;
  tr.innerHTML = deviceRowHtml(d);
  return tr;
}

// ── MÁY "ĐANG BẬN" (2026-09-18) ──
// Đang chạy, đang XẾP HÀNG chờ khe, hoặc đang NGHỈ giữa hai ca chờ tự chạy lại — cả ba đều đang
// có một lượt chạy dính líu, nên cả ba phải hiện nút Dừng. Bản cũ vẽ hai trạng thái sau thành
// "Đã dừng": người dùng bấm Chạy lần nữa (sinh lượt thứ hai tranh khe), hoặc bấm Xoá tưởng an
// toàn (sinh "máy ma" chạy tiếp dưới mã `d_…` sau giờ nghỉ).
const TRANG_THAI_BAN = new Set(['run', 'queue', 'rest', 'offline']);
function dangBan(id) {
  const st = deviceState[id];
  return !!st && TRANG_THAI_BAN.has(st.status);
}

// 8.100.000 ms → "2g15"; 1.800.000 → "30p"; 18.000.000 → "5g".
function gioPhut(ms) {
  const tong = Math.max(0, Math.floor(ms / 60000));
  const g = Math.floor(tong / 60);
  const p = tong % 60;
  if (!g) return `${p}p`;
  return p ? `${g}g${String(p).padStart(2, '0')}` : `${g}g`;
}

function nhanTrangThai(st) {
  if (st.status === 'queue') return `Xếp hàng (${st.queuePos || '…'})`;
  if (st.status === 'rest') {
    const luc = st.restUntil
      ? new Date(st.restUntil).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false })
      : '…';
    if (st.restLoi) return `Lỗi → tự chạy lại ${luc}`;
    return `Nghỉ → ${luc}${st.restNext ? ` → ${st.restNext}` : ''}`;
  }
  if (st.status === 'offline') return 'Mất kết nối — đang chờ';
  // Quét ⇄ Xem: nói rõ máy đang ở pha nào — "Đang chạy" không cho biết máy đang thu sound hay
  // đang xem để nuôi tài khoản.
  if (st.status === 'run' && st.phase) {
    if (st.phase.key === 'view') {
      return st.viewIdx >= 0 && st.viewTotal ? `Xem link ${st.viewIdx + 1}/${st.viewTotal}` : 'Xem';
    }
    return `Quét ${gioPhut(Date.now() - st.phase.at)}/${gioPhut(st.phase.ms)}`;
  }
  return { run: 'Đang chạy', stop: 'Đã dừng', err: 'Lỗi' }[st.status] || 'Đã dừng';
}

// Đồng hồ pha Quét chỉ đổi khi có sự kiện — mà pha Quét 5 giờ có thể im cả chục phút. Vẽ lại
// mỗi 30 giây, chỉ những dòng đang ở pha Quét.
setInterval(() => {
  for (const [id, st] of Object.entries(deviceState)) {
    if (st.status === 'run' && st.phase && st.phase.key === 'scan') renderDeviceRow(id);
  }
}, 30000);

function deviceRowHtml(d) {
  const st = deviceState[d.id] || { status: 'stop', checked: 0, qualified: 0 };
  const ban = TRANG_THAI_BAN.has(st.status);
  return `
    <td><input type="checkbox" class="row-check" data-id="${d.id}"></td>
    <td class="pname">${esc(d.name)}</td>
    <td class="pserial">${esc(d.serial)}</td>
    <td><span class="pstat-badge ${st.status}">${esc(nhanTrangThai(st))}</span></td>
    <td class="pchecked">${st.checked || 0}</td>
    <td class="pvalid">${st.qualified || 0}</td>
    <td class="prow-actions">
      <button class="btn btn-sm" data-act="toggle" data-id="${d.id}">${ban ? '■ Dừng' : '▶ Chạy'}</button>
      <button class="btn-icon" data-act="settings" data-id="${d.id}" title="Cài đặt riêng">⚙️</button>
      <button class="btn-icon" data-act="log" data-id="${d.id}" title="Xem log">📄</button>
      <button class="btn-icon" data-act="check" data-id="${d.id}" title="Kiểm tra kết nối">🔌</button>
      <button class="btn-icon" data-act="delete" data-id="${d.id}" title="Xóa">✕</button>
    </td>`;
}

function renderDeviceRow(deviceId) {
  const tr = document.querySelector(`#deviceTableBody tr[data-id="${deviceId}"]`);
  const d = devices.find((x) => x.id === deviceId);
  if (!tr || !d) return;
  const checked = tr.querySelector('.row-check').checked;
  tr.innerHTML = deviceRowHtml(d);
  tr.querySelector('.row-check').checked = checked;
}

// ---- Render: bảng kết quả ----
function renderResultCount() {
  document.getElementById('crawlCount').textContent = `${crawlResults.length} sound`;
}

// Máy đang nghỉ giữa ca hay đang xếp hàng CŨNG tính là phiên còn sống — không thì bấm Chạy một
// máy khác lúc cả farm đang nghỉ sẽ xoá sạch bảng kết quả của cả phiên.
function anyDeviceRunning() {
  return Object.values(deviceState).some((s) => TRANG_THAI_BAN.has(s.status));
}

// Lam moi bang "Du lieu thu thap" khi BAT DAU 1 phien chay moi (khong con may nao dang chay).
// Neu da co may dang chay thi GIU nguyen (tranh xoa mat du lieu may kia dang do ve).
function clearResultsIfIdle() {
  if (anyDeviceRunning()) return;
  crawlResults = [];
  document.getElementById('resultBody').innerHTML = '';
  renderResultCount();
  soPending = 0;
  renderPendingChip();
}

function addResultRow(row, idx) {
  const tbody = document.getElementById('resultBody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="result-idx">${idx}</td>
    <td>${esc(row.name)}</td>
    <td><a href="${esc(row.url)}" target="_blank">${esc(row.url)}</a></td>
    <td class="result-count">${row.posts}</td>
    <td class="result-device">${esc(row.deviceName)}</td>`;
  tbody.appendChild(tr);
  while (tbody.children.length > MAX_RESULT_ROWS) tbody.removeChild(tbody.firstChild);
}

// Tham số một lượt chạy — MỘT chỗ dựng duy nhất, cho cả nút Chạy lẫn nút Lưu cài đặt. Hai chỗ
// dựng riêng là có ngày một chỗ thiếu trường mới (QĐ-10).
function paramsFor(d) {
  const s = getSettingsFor(d.id);
  return {
    deviceId: d.id,
    serial: d.serial,
    minPosts: s.minPosts,
    maxPosts: s.maxPosts,
    dwellMin: s.delayMin,
    dwellMax: s.delayMax,
    originalOnly: s.originalOnly,
    limit: s.limit,
    // Gui NGUYEN ca goi cai dat xuong. Liet ke tung truong o day la kieu de quen: them mot o
    // moi trong modal ma quen them vao day thi o do hien ra nhung KHONG lam gi ca - dung loai
    // hong cam ma ban PC ghi lai o QD-38.
    cfg: s,
  };
}

// ---- Chạy / dừng ----
async function startDeviceById(id) {
  const d = devices.find((x) => x.id === id);
  if (!d) return;
  clearResultsIfIdle();               // lam moi bang neu day la phien chay moi
  const st = deviceState[id];
  if (st) { st.checked = 0; st.qualified = 0; }   // reset dem cua may nay
  const res = await window.api.deviceStart(paramsFor(d));
  if (!res.ok) {
    toast(res.msg || 'Không chạy được', false);
    return;
  }
  // Lời gọi trên có thể treo rất lâu (máy xếp hàng chờ khe), và trong lúc đó máy có thể đã bị xoá.
  if (!deviceState[id]) return;
  deviceState[id].status = 'run';
  renderDeviceRow(id);
}

async function stopDeviceById(id) {
  await window.api.deviceStop(id);
  deviceState[id].status = 'stop';
  renderDeviceRow(id);
}

function getSelectedIds() {
  return Array.from(document.querySelectorAll('.row-check:checked')).map((el) => el.dataset.id);
}

// ---- Modal: Kiểm tra (preflight) ----
//
// VÌ SAO CÓ MODAL RIÊNG THAY VÌ MỘT DÒNG TOAST (2026-09-15):
// Bản cũ chỉ báo "mất kết nối ADB" hoặc "đang online, đã cài TikTok". Lúc chủ dự án gặp sự cố,
// có BA thứ hỏng cùng lúc (thiếu adb, thiếu uiautomator2, Python 3.14) mà toast chỉ nói được
// một thứ — và nói sai thứ tự ưu tiên. Bảng liệt kê từng mục kèm CÂU SỬA GÕ ĐƯỢC NGAY thì
// người dùng sửa một lượt, không phải sửa-chạy-lại-lòi-lỗi-mới ba vòng.
let _preflightDevice = null;

async function openPreflightModal(d) {
  _preflightDevice = d;
  const modal = document.getElementById('preflightModal');
  const body = document.getElementById('preflightBody');
  document.getElementById('preflightTarget').textContent = d ? `${d.name} — ${d.serial}` : '';
  body.innerHTML = '<div class="pf-wait">Đang kiểm tra…</div>';
  modal.classList.add('open');

  let r;
  try {
    r = await window.api.deviceCheck(d.serial);
  } catch (e) {
    body.innerHTML = `<div class="pf-item err"><div class="pf-head">✕ Không kiểm tra được</div>
      <div class="pf-detail">${esc(String((e && e.message) || e))}</div></div>`;
    return;
  }

  const items = r.items || [];
  if (!items.length) {
    body.innerHTML = '<div class="pf-wait">Không có mục nào để kiểm.</div>';
    return;
  }
  body.innerHTML = items.map((it) => `
    <div class="pf-item ${it.ok ? 'ok' : 'err'}">
      <div class="pf-head">${it.ok ? '✓' : '✕'} ${esc(it.label)}</div>
      <div class="pf-detail">${esc(it.detail)}</div>
      ${it.fix ? `<pre class="pf-fix">${esc(it.fix)}</pre>` : ''}
    </div>`).join('');
}

// ---- Modal: Quản lý thiết bị ----
function openDeviceModal() {
  renderDeviceList();
  document.getElementById('adbScanList').innerHTML = '';
  document.getElementById('deviceModal').classList.add('open');
}
function closeDeviceModal() {
  document.getElementById('deviceModal').classList.remove('open');
}

function renderDeviceList() {
  const wrap = document.getElementById('deviceList');
  if (!devices.length) {
    wrap.innerHTML = '<div class="device-empty">Chưa có thiết bị nào.</div>';
    return;
  }
  // Tên là ô NHẬP ĐƯỢC NGAY, không phải nhãn tĩnh: sửa xong Enter hoặc bấm ra ngoài là lưu.
  // Làm một modal đổi tên riêng cho 21 máy thì mỗi lần sửa mất ba cú bấm.
  wrap.innerHTML = devices.map((d) => `
    <div class="device-item" data-id="${d.id}">
      <div class="device-item-info">
        <input class="input input-sm device-name-input" data-id="${d.id}"
               value="${esc(d.name)}" placeholder="Tên máy" title="Sửa rồi Enter để lưu">
        <div class="device-item-serial">${esc(d.serial)}</div>
      </div>
      <button class="btn-icon" data-act="modal-identify" data-id="${d.id}"
              title="Nháy thanh thông báo trên máy để biết là ô nào">💡</button>
      <button class="btn-icon" data-act="modal-delete" data-id="${d.id}" title="Xóa">✕</button>
    </div>`).join('');
}

// Đổi tên máy. Trả về true nếu có đổi.
async function renameDevice(id, ten) {
  const d = devices.find((x) => x.id === id);
  const moi = String(ten || '').trim();
  if (!d || !moi || moi === d.name) return false;
  try {
    await window.api.devicesUpdate({ id, name: moi });
    d.name = moi;
    renderDeviceRow(id);          // bảng chính cũng phải đổi theo, không chỉ trong modal
    toast(`Đã đổi tên thành "${moi}"`);
    return true;
  } catch (e) {
    toast(String((e && e.message) || e), false);
    return false;
  }
}

// Làm máy tự lộ diện trên màn hình soi.
async function identifyDevice(serial, nut) {
  if (!serial) return;
  const cu = nut ? nut.textContent : '';
  if (nut) { nut.textContent = '⏳'; nut.disabled = true; }
  try {
    const r = await window.api.deviceIdentify(serial);
    if (!r || !r.ok) toast((r && r.msg) || 'Máy không nhận lệnh', false);
  } finally {
    if (nut) { nut.textContent = cu || '💡'; nut.disabled = false; }
  }
}

async function addDevice() {
  const name = document.getElementById('newDeviceName').value.trim();
  const serial = document.getElementById('newDeviceSerial').value.trim();
  if (!serial) { toast('Nhập serial ADB trước đã', false); return; }
  try {
    const dev = await window.api.devicesAdd({ name, serial });
    devices.push(dev);
    deviceState[dev.id] = { status: 'stop', checked: 0, qualified: 0, log: [] };
    document.getElementById('newDeviceName').value = '';
    document.getElementById('newDeviceSerial').value = '';
    danhDauDaThem(serial);
    renderDeviceList();
    renderDeviceTable();
    toast(`Đã thêm ${dev.name}`);
  } catch (e) {
    toast(String(e.message || e), false);
  }
}

async function deleteDeviceById(id) {
  await window.api.devicesDelete({ id });
  devices = devices.filter((d) => d.id !== id);
  delete deviceState[id];
  renderDeviceList();
  renderDeviceTable();
}

// Danh sách quét, có TÊN MÁY để biết IP nào ứng với ô nào trên màn hình soi.
//
// `ro.product.model` cho ra đúng chuỗi mà phần mềm soi in trên mỗi ô (GM1911, TECNO LC8...),
// nên nhìn là khớp được. Hai máy CÙNG ĐỜI thì tên trùng nhau — lúc đó dùng nút 💡 để làm máy
// tự lộ diện.
// Đánh dấu một dòng trong danh sách quét là "đã thêm", thay vì quét lại adb.
//
// VÌ SAO PHẢI CÓ (2026-09-17): thêm máy xong, dòng đó trong danh sách quét vẫn hiện nút
// "+ Thêm" y như cũ, vì danh sách chỉ dựng lại khi bấm "Quét ADB". Nhìn vào thì tưởng bấm hụt
// nên bấm thêm lần nữa — và chính cú bấm thừa đó đẻ ra lỗi lệch tên/serial ở trên. Quét lại adb
// cũng đúng nhưng đọc `ro.product.model` của 22 máy mất vài giây; sửa đúng một dòng thì tức thì.
function danhDauDaThem(serial) {
  const wrap = document.getElementById('adbScanList');
  if (!wrap || !serial) return;
  const btn = wrap.querySelector(`[data-act="quick-add"][data-serial="${CSS.escape(serial)}"]`);
  if (!btn) return;
  const nhan = document.createElement('span');
  nhan.className = 'hint';
  nhan.textContent = 'đã thêm';
  btn.replaceWith(nhan);
}

async function scanAdb() {
  const wrap = document.getElementById('adbScanList');
  wrap.innerHTML = '<div class="hint">Đang quét và đọc tên máy…</div>';
  const list = await window.api.devicesListAdb();
  if (!list.length) {
    wrap.innerHTML = '<div class="hint">Không thấy thiết bị nào qua adb devices.</div>';
    return;
  }
  // Máy cùng đời thì đánh dấu, để người dùng biết là phải dùng nút 💡 mới phân biệt được.
  const demModel = {};
  list.forEach((s) => { if (s.model) demModel[s.model] = (demModel[s.model] || 0) + 1; });

  wrap.innerHTML = list.map((s) => {
    const trung = s.model && demModel[s.model] > 1;
    const ten = s.model ? `${esc(s.model)}${s.brand ? ` · ${esc(s.brand)}` : ''}` : '(không đọc được tên)';
    return `
    <div class="adb-scan-item">
      <span class="serial">
        <b>${ten}</b>${trung ? ' <span class="hint">⚠ có máy cùng đời</span>' : ''}
        <span class="hint">${esc(s.serial)} · ${s.state}</span>
      </span>
      <span class="row gap">
        <button class="btn-icon" data-act="identify" data-serial="${esc(s.serial)}"
                title="Nháy thanh thông báo trên máy để biết là ô nào">💡</button>
        ${s.added
          ? '<span class="hint">đã thêm</span>'
          : `<button class="btn btn-sm" data-act="quick-add" data-serial="${esc(s.serial)}"
                     data-name="${esc(s.model || '')}">+ Thêm</button>`}
      </span>
    </div>`;
  }).join('');
}

// ---- Modal: Cài đặt crawl ----
function openSettingsModal(ids) {
  settingsTargetIds = ids;
  const label = ids.length === 1
    ? (devices.find((d) => d.id === ids[0])?.name || ids[0])
    : `${ids.length} thiết bị đã chọn`;
  document.getElementById('settingsTarget').textContent = label;

  const base = getSettingsFor(ids[0]);
  const $ = (id) => document.getElementById(id);

  $('cfgMinPosts').value = base.minPosts;
  $('cfgMaxPosts').value = base.maxPosts;
  $('cfgDelayMin').value = base.delayMin;
  $('cfgDelayMax').value = base.delayMax;
  $('cfgOriginalOnly').checked = base.originalOnly;
  $('cfgLimit').value = base.limit;

  $('cfgCycleOn').checked = !!base.cycleOn;
  $('cfgCycleScanMinutes').value = base.cycleScanMinutes;
  $('cfgCycleBreakMin').value = base.cycleBreakMin;
  $('cfgCycleBreakMax').value = base.cycleBreakMax;

  $('cfgMode').value = base.mode === 'cycle' ? 'cycle' : 'foryou';
  $('cfgCycleScanHours').value = base.cycleScanHours;
  $('cfgCycleViewMinutes').value = base.cycleViewMinutes;
  $('cfgViewLinks').value = base.viewLinks;
  $('cfgViewSecMin').value = base.viewSecMin;
  $('cfgViewSecMax').value = base.viewSecMax;
  $('cfgViewScrollMin').value = base.viewScrollMin;
  $('cfgViewScrollMax').value = base.viewScrollMax;
  apCheDo();

  $('cfgNiBlockCollect').checked = base.niBlockCollect !== false;
  $('cfgNiEnabled').checked = !!base.niEnabled;
  $('cfgNiAi').checked = !!base.niAi;
  $('cfgNiKeywords').value = base.niKeywords;
  renderNiScripts(base.niScripts);

  $('cfgFollowOn').checked = !!base.followOn;
  $('cfgFollowPerDay').value = base.followPerDay;
  $('cfgFollowGapMin').value = base.followGapMin;
  $('cfgFollowGapMax').value = base.followGapMax;
  $('cfgLikeOn').checked = !!base.likeOn;
  $('cfgLikePerDay').value = base.likePerDay;
  $('cfgLikeRateMin').value = base.likeRateMin;
  $('cfgLikeRateMax').value = base.likeRateMax;
  $('cfgMusicWaitSec').value = base.musicWaitSec;
  $('cfgSettleSec').value = base.settleSec;
  $('cfgProfileVideoSecMin').value = base.profileVideoSecMin;
  $('cfgProfileVideoSecMax').value = base.profileVideoSecMax;
  $('cfgVisitOn').checked = !!base.visitOn;
  $('cfgVisitSecMin').value = base.visitSecMin;
  $('cfgVisitSecMax').value = base.visitSecMax;
  $('cfgVisitMaxUsers').value = base.visitMaxUsers;
  $('cfgVisitSkipDays').value = base.visitSkipDays;

  // Hai o toan app - khong theo tung may, nen doc tu globalSettings
  $('cfgDeviceConcurrency').value = globalSettings.deviceConcurrency;
  $('cfgLaunchStaggerMs').value = globalSettings.launchStaggerMs;

  document.getElementById('settingsModal').classList.add('open');
}
// Ẩn/hiện theo chế độ. Một ô hiện ra mà không có tác dụng ở chế độ đang chọn thì tệ hơn ô
// không hiện (QĐ-38): "Chạy theo chu kỳ" vô nghĩa ở Quét ⇄ Xem vì chế độ đó vốn chạy theo chu kỳ.
function apCheDo() {
  const xenKe = document.getElementById('cfgMode').value === 'cycle';
  document.getElementById('cfgXenKeSection').style.display = xenKe ? '' : 'none';
  document.getElementById('khoiChuKyForYou').style.display = xenKe ? 'none' : '';
  document.getElementById('nhanNghiGiuaLuot').textContent = xenKe
    ? 'Nghỉ giữa hai pha … – … phút (máy nhả khe cho máy đang chờ)'
    : 'Rồi nghỉ … – … phút';
}

function closeSettingsModal() {
  document.getElementById('settingsModal').classList.remove('open');
}

// Doc mot o so. Dung `??` chu KHONG dung `||`: voi `||` thi 0 bi coi la "chua nhap" va bi
// thay bang mac dinh. Ma 0 la gia tri HOP LE va mang nghia that o day - "0 follow/ngay" nghia
// la khong follow, khong phai "dung mac dinh 30". Ban PC ghi ro bai hoc nay (QD-27).
function numOf(id, mac) {
  const raw = document.getElementById(id).value;
  if (raw === '' || raw === null || raw === undefined) return mac;
  const n = Number(raw);
  return Number.isFinite(n) ? n : mac;
}

async function saveSettings() {
  const D = DEFAULT_SETTINGS;
  const s = {
    minPosts: numOf('cfgMinPosts', D.minPosts),
    maxPosts: numOf('cfgMaxPosts', D.maxPosts),
    delayMin: numOf('cfgDelayMin', D.delayMin),
    delayMax: numOf('cfgDelayMax', D.delayMax),
    musicWaitSec: numOf('cfgMusicWaitSec', D.musicWaitSec),
    settleSec: numOf('cfgSettleSec', D.settleSec),
    likeRateMin: numOf('cfgLikeRateMin', D.likeRateMin),
    likeRateMax: numOf('cfgLikeRateMax', D.likeRateMax),
    profileVideoSecMin: numOf('cfgProfileVideoSecMin', D.profileVideoSecMin),
    profileVideoSecMax: numOf('cfgProfileVideoSecMax', D.profileVideoSecMax),
    originalOnly: document.getElementById('cfgOriginalOnly').checked,
    limit: numOf('cfgLimit', 0),

    cycleOn: document.getElementById('cfgCycleOn').checked,
    cycleScanMinutes: numOf('cfgCycleScanMinutes', D.cycleScanMinutes),
    cycleBreakMin: numOf('cfgCycleBreakMin', D.cycleBreakMin),
    cycleBreakMax: numOf('cfgCycleBreakMax', D.cycleBreakMax),

    mode: document.getElementById('cfgMode').value === 'cycle' ? 'cycle' : 'foryou',
    // `numOf` giữ 0 là 0 (QĐ-27): Xem = 0 phút là HỢP LỆ — nghĩa là chỉ quét theo chu kỳ.
    cycleScanHours: numOf('cfgCycleScanHours', D.cycleScanHours),
    cycleViewMinutes: numOf('cfgCycleViewMinutes', D.cycleViewMinutes),
    viewLinks: document.getElementById('cfgViewLinks').value,
    viewSecMin: numOf('cfgViewSecMin', D.viewSecMin),
    viewSecMax: numOf('cfgViewSecMax', D.viewSecMax),
    viewScrollMin: numOf('cfgViewScrollMin', D.viewScrollMin),
    viewScrollMax: numOf('cfgViewScrollMax', D.viewScrollMax),

    niBlockCollect: document.getElementById('cfgNiBlockCollect').checked,
    niEnabled: document.getElementById('cfgNiEnabled').checked,
    niAi: document.getElementById('cfgNiAi').checked,
    niScripts: readNiScripts(),
    niKeywords: document.getElementById('cfgNiKeywords').value,
    // ⚠ PHẢI ghi lại cờ này: hàm lưu dựng một object MỚI hoàn toàn. Thiếu cờ là lần mở app sau
    // `nangCapLocNgonNgu()` tưởng chưa nâng cấp và TÍCH LẠI hai nhóm người dùng vừa cố ý bỏ.
    niScriptsV2: true,

    followOn: document.getElementById('cfgFollowOn').checked,
    followPerDay: numOf('cfgFollowPerDay', D.followPerDay),
    followGapMin: numOf('cfgFollowGapMin', D.followGapMin),
    followGapMax: numOf('cfgFollowGapMax', D.followGapMax),
    likeOn: document.getElementById('cfgLikeOn').checked,
    likePerDay: numOf('cfgLikePerDay', D.likePerDay),
    visitOn: document.getElementById('cfgVisitOn').checked,
    visitSecMin: numOf('cfgVisitSecMin', D.visitSecMin),
    visitSecMax: numOf('cfgVisitSecMax', D.visitSecMax),
    visitMaxUsers: numOf('cfgVisitMaxUsers', D.visitMaxUsers),
    visitSkipDays: numOf('cfgVisitSkipDays', D.visitSkipDays),
  };
  settingsTargetIds.forEach((id) => { deviceSettings[id] = s; });

  globalSettings = {
    deviceConcurrency: numOf('cfgDeviceConcurrency', DEFAULT_GLOBAL.deviceConcurrency),
    launchStaggerMs: numOf('cfgLaunchStaggerMs', DEFAULT_GLOBAL.launchStaggerMs),
  };

  await window.api.storeSet({ device_settings: deviceSettings, global_settings: globalSettings });
  await window.api.setGlobalSettings(globalSettings);

  // ── ĐẨY CÀI ĐẶT MỚI XUỐNG MÁY ĐANG BẬN (2026-09-18) ──
  // Máy đang chạy theo chu kỳ tự chạy lại sau mỗi giờ nghỉ bằng BẢN CÀI ĐẶT CHỤP LÚC BẤM CHẠY.
  // Không đẩy xuống thì bấm Lưu xong vẫn chạy cấu hình cũ tới khi Dừng rồi Chạy tay — và không
  // có gì trên màn hình cho biết điều đó.
  let banMay = 0;
  for (const id of settingsTargetIds) {
    const d = devices.find((x) => x.id === id);
    if (!d || !dangBan(id)) continue;
    banMay++;
    await window.api.deviceUpdateParams(paramsFor(d));
  }
  closeSettingsModal();
  toast(banMay
    ? `Đã lưu cài đặt — ${banMay} máy đang chạy sẽ dùng cài đặt mới từ lượt chạy kế tiếp.`
    : 'Đã lưu cài đặt');
}

// ---- O tich nhom ky tu, dung khuon cua ban PC ----
function renderNiScripts(daChon) {
  const chon = new Set(Array.isArray(daChon) ? daChon : []);
  document.getElementById('cfgNiScripts').innerHTML = NI_SCRIPTS.map((g) => `
    <label class="ni-script">
      <input type="checkbox" class="ni-script-cb" value="${g.key}"${chon.has(g.key) ? ' checked' : ''}>
      <span>${esc(g.label)}</span>
    </label>`).join('');
}

function readNiScripts() {
  return Array.from(document.querySelectorAll('.ni-script-cb:checked')).map((el) => el.value);
}

// ---- Modal: Log ----
function openLogModal(id) {
  currentLogDeviceId = id;
  const d = devices.find((x) => x.id === id);
  document.getElementById('logTitle').textContent = `📄 Log — ${d ? d.name : id}`;
  document.getElementById('logBody').textContent = (deviceState[id]?.log || []).join('\n');
  document.getElementById('logModal').classList.add('open');
}
function closeLogModal() {
  currentLogDeviceId = null;
  document.getElementById('logModal').classList.remove('open');
}

// ---- Xuất CSV ----
async function exportResults() {
  if (!crawlResults.length) { toast('Chưa có dữ liệu để xuất', false); return; }
  const res = await window.api.exportResults(crawlResults);
  if (res.ok) toast(`Đã xuất: ${res.filePath}`);
}

// ---- Modal: Cài đặt Google Sheet ----
async function openSheetsModal() {
  const cfg = await window.api.sheetsGetConfig();
  document.getElementById('sheetsEnabled').checked = !!cfg.enabled;
  document.getElementById('sheetsId').value = cfg.spreadsheetId || '';
  document.getElementById('sheetsTab').value = cfg.tab || 'Data';
  document.getElementById('sheetsReseedMin').value = cfg.reseedMinutes || 5;
  document.getElementById('sheetsSa').value = cfg.sa || '';
  document.getElementById('sheetsPendingTab').value = cfg.pendingTab || '';
  document.getElementById('sheetsTestResult').textContent = '';
  document.getElementById('sheetsModal').classList.add('open');
  refreshLinksInfo();
}

// ── KHO LINK CỤC BỘ trong modal ☁ (clone bản PC) ──
const soVi = (n) => Number(n || 0).toLocaleString('vi-VN');
async function refreshLinksInfo() {
  const el = document.getElementById('linksInfo');
  if (!el) return;
  try {
    const r = await window.api.linksInfo();
    el.innerHTML = r && r.ok
      ? `Đang giữ <b>${soVi(r.count)}</b> link · <code style="font-size:11px">${esc(r.path)}</code>`
      : 'Không đọc được kho link.';
  } catch (_) { el.textContent = 'Không đọc được kho link.'; }
}

function initLinkStore() {
  const btnImport = document.getElementById('linksImportBtn');
  const btnOpen = document.getElementById('linksOpenBtn');
  const btnReload = document.getElementById('linksReloadBtn');
  btnImport.addEventListener('click', async () => {
    const nhan = btnImport.textContent;
    btnImport.disabled = true;
    // Sheet lớn có thể mất vài phút — phải báo rõ, không thì người dùng tưởng app treo (QĐ-09).
    btnImport.textContent = '⏳ Đang đọc Sheet...';
    try {
      const r = await window.api.linksImportFromSheet();
      if (r && r.ok) {
        // Báo tách bạch tab chính / tab Pending: nút này dùng để CHỐT KHO trước khi dọn Sheet.
        let msg = `Đã đọc ${soVi(r.read)} link từ Sheet, ghi thêm ${soVi(r.added)} link mới vào kho `
          + `(kho hiện có ${soVi(r.total)} link).`;
        if (r.pendingRead) msg += ` Tab Pending: đọc ${soVi(r.pendingRead)}, thêm ${soVi(r.pendingAdded)} link.`;
        toast(msg, true);
        if (r.pendingError) toast('Không đọc được tab Pending: ' + r.pendingError, false);
        await refreshLinksInfo();
      } else {
        toast('Nạp từ Sheet thất bại: ' + ((r && r.msg) || 'lỗi không rõ'), false);
      }
    } catch (e) {
      toast('Nạp từ Sheet thất bại: ' + e.message, false);
    } finally {
      btnImport.disabled = false;
      btnImport.textContent = nhan;
    }
  });
  btnOpen.addEventListener('click', async () => {
    const r = await window.api.linksOpenFile();
    if (!(r && r.ok)) toast('Không mở được file: ' + ((r && r.msg) || ''), false);
  });
  btnReload.addEventListener('click', async () => {
    const r = await window.api.linksReload();
    if (r && r.ok) { toast(`Đã đọc lại kho: ${soVi(r.count)} link.`, true); await refreshLinksInfo(); }
    else toast('Đọc lại thất bại: ' + ((r && r.msg) || ''), false);
  });
}

// ── Chip "N lỗi → Pending" (clone bản PC) ──
// HIỆN/ẨN theo CẤU HÌNH, không theo con số: đã đặt tên tab Pending thì LUÔN hiện, kể cả đang 0 —
// để biết tính năng đang bật. Chưa đặt thì ẩn hẳn: hiện "0 lỗi" lúc đó là nói sai, vì sound lỗi
// vẫn đang bị bỏ luôn chứ không phải không có.
let soPending = 0;
let pendingDaBat = false;
function renderPendingChip() {
  const el = document.getElementById('crawlPendingCount');
  if (!el) return;
  el.textContent = `${soPending} lỗi → Pending`;
  el.style.display = (pendingDaBat || soPending > 0) ? '' : 'none';
}
async function refreshPendingConfigured() {
  try {
    const cfg = await window.api.sheetsGetConfig();
    pendingDaBat = !!(cfg && cfg.enabled && String(cfg.pendingTab || '').trim());
  } catch (_) { pendingDaBat = false; }
  renderPendingChip();
}
function closeSheetsModal() {
  document.getElementById('sheetsModal').classList.remove('open');
}
function readSheetsForm() {
  return {
    enabled: document.getElementById('sheetsEnabled').checked,
    spreadsheetId: document.getElementById('sheetsId').value.trim(),
    tab: document.getElementById('sheetsTab').value.trim() || 'Data',
    reseedMinutes: Number(document.getElementById('sheetsReseedMin').value) || 5,
    sa: document.getElementById('sheetsSa').value.trim(),
    // Để TRỐNG = TẮT Pending. Không tự đặt tên mặc định: Sheet chưa chắc có tab đó, tự bật sẽ làm
    // mọi lần cất Pending lỗi liên tục (bản PC ghi rõ lý do này).
    pendingTab: document.getElementById('sheetsPendingTab').value.trim(),
  };
}
async function testSheets() {
  const cfg = readSheetsForm();
  const el = document.getElementById('sheetsTestResult');
  el.textContent = 'Đang kiểm tra...';
  const r = await window.api.sheetsTest(cfg);
  el.textContent = r.msg || (r.ok ? 'OK' : 'Lỗi');
}
async function saveSheets() {
  const cfg = readSheetsForm();
  await window.api.sheetsSetConfig(cfg);
  closeSheetsModal();
  await refreshPendingConfigured();   // bật/tắt Pending phải thấy ngay, không đợi mở lại app
  toast('Đã lưu cài đặt Google Sheet');
}

// ---- Đẩy dữ liệu lên Sheet (thủ công, lọc trùng) ----
async function pushToSheet() {
  if (!crawlResults.length) { toast('Chưa có dữ liệu để đẩy', false); return; }
  const rows = crawlResults.map((r) => [r.name, r.url, r.posts, r.deviceName, 1]);
  toast('Đang đẩy lên Sheet...', true);
  const r = await window.api.sheetsPushManual(rows);
  if (!r.ok) { toast(`Đẩy lỗi: ${r.msg || ''}`, false); return; }
  toast(`Đã đẩy ${r.pushed} dòng mới (bỏ ${r.skipped} trùng)`, true);
}

// ---- Wiring sự kiện ----
document.addEventListener('DOMContentLoaded', () => {
  init();

  document.getElementById('manageDevicesBtn').addEventListener('click', openDeviceModal);
  document.getElementById('deviceModalClose').addEventListener('click', closeDeviceModal);
  document.getElementById('deviceModalDone').addEventListener('click', closeDeviceModal);
  document.getElementById('addDeviceBtn').addEventListener('click', addDevice);
  document.getElementById('scanAdbBtn').addEventListener('click', scanAdb);

  document.getElementById('settingsModalClose').addEventListener('click', closeSettingsModal);
  document.getElementById('settingsCancel').addEventListener('click', closeSettingsModal);
  document.getElementById('settingsSave').addEventListener('click', saveSettings);
  document.getElementById('cfgMode').addEventListener('change', apCheDo);
  document.getElementById('settingsSelectedBtn').addEventListener('click', () => {
    const ids = getSelectedIds();
    if (!ids.length) { toast('Chưa chọn thiết bị nào', false); return; }
    openSettingsModal(ids);
  });

  document.getElementById('sheetsBtn').addEventListener('click', openSheetsModal);
  document.getElementById('sheetsModalClose').addEventListener('click', closeSheetsModal);
  document.getElementById('sheetsCancel').addEventListener('click', closeSheetsModal);
  document.getElementById('sheetsTestBtn').addEventListener('click', testSheets);
  initLinkStore();
  document.getElementById('sheetsSaveBtn').addEventListener('click', saveSheets);
  document.getElementById('pushSheetBtn').addEventListener('click', pushToSheet);

  document.getElementById('logModalClose').addEventListener('click', closeLogModal);
  document.getElementById('logDone').addEventListener('click', closeLogModal);

  const closePreflight = () => document.getElementById('preflightModal').classList.remove('open');
  document.getElementById('preflightModalClose').addEventListener('click', closePreflight);
  document.getElementById('preflightDone').addEventListener('click', closePreflight);
  document.getElementById('preflightRetry').addEventListener('click', () => {
    // Nhớ máy đang xem để bấm "Kiểm tra lại" sau khi vừa cài xong thứ còn thiếu.
    if (_preflightDevice) openPreflightModal(_preflightDevice);
  });
  document.getElementById('logClear').addEventListener('click', () => {
    if (currentLogDeviceId) {
      deviceState[currentLogDeviceId].log = [];
      document.getElementById('logBody').textContent = '';
    }
  });

  document.getElementById('runSelectedBtn').addEventListener('click', () => {
    const ids = getSelectedIds();
    if (!ids.length) { toast('Chưa chọn thiết bị nào', false); return; }
    // Bỏ qua máy đang bận: bấm Chạy cho máy đang xếp hàng là sinh lượt thứ hai tranh khe.
    ids.filter((id) => !dangBan(id)).forEach(startDeviceById);
  });
  document.getElementById('stopSelectedBtn').addEventListener('click', () => {
    const ids = getSelectedIds();
    ids.forEach(stopDeviceById);
  });

  document.getElementById('selectAll').addEventListener('change', (e) => {
    document.querySelectorAll('.row-check').forEach((cb) => (cb.checked = e.target.checked));
  });

  document.getElementById('exportExcelBtn').addEventListener('click', exportResults);

  // Event delegation cho các hành động theo từng dòng thiết bị
  document.getElementById('deviceTableBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    if (act === 'toggle') {
      dangBan(id) ? stopDeviceById(id) : startDeviceById(id);
    } else if (act === 'settings') {
      openSettingsModal([id]);
    } else if (act === 'log') {
      openLogModal(id);
    } else if (act === 'check') {
      const d = devices.find((x) => x.id === id);
      openPreflightModal(d);
    } else if (act === 'delete') {
      deleteDeviceById(id);
    }
  });

  const dsList = document.getElementById('deviceList');
  dsList.addEventListener('click', (e) => {
    const xoa = e.target.closest('[data-act="modal-delete"]');
    if (xoa) { deleteDeviceById(xoa.dataset.id); return; }
    const nhay = e.target.closest('[data-act="modal-identify"]');
    if (nhay) {
      const d = devices.find((x) => x.id === nhay.dataset.id);
      if (d) identifyDevice(d.serial, nhay);
    }
  });
  // Enter để lưu ngay; rời ô cũng lưu — người dùng sửa xong hay bấm đi chỗ khác luôn.
  dsList.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const inp = e.target.closest('.device-name-input');
    if (inp) { renameDevice(inp.dataset.id, inp.value); inp.blur(); }
  });
  dsList.addEventListener('focusout', (e) => {
    const inp = e.target.closest('.device-name-input');
    if (inp) renameDevice(inp.dataset.id, inp.value);
  });

  document.getElementById('adbScanList').addEventListener('click', (e) => {
    const nhay = e.target.closest('[data-act="identify"]');
    if (nhay) { identifyDevice(nhay.dataset.serial, nhay); return; }

    const btn = e.target.closest('[data-act="quick-add"]');
    if (!btn) return;
    document.getElementById('newDeviceSerial').value = btn.dataset.serial;
    // Tự điền tên máy đọc được. Vẫn để người dùng sửa trước khi bấm Thêm — 21 máy mà gõ tay
    // từng cái thì vừa lâu vừa dễ gõ nhầm.
    //
    // TÊN LUÔN GHI ĐÈ THEO SERIAL VỪA CHỌN (2026-09-17). Bản trước giữ tên cũ nếu ô tên đã có
    // chữ, trong khi ô serial thì ghi đè vô điều kiện — nên bấm "+ Thêm" máy thứ hai là ô tên
    // còn tên máy THỨ NHẤT còn serial đã là máy thứ hai. Chủ dự án bắt được đúng cảnh đó: ô tên
    // "GM1911" mà serial là 192.168.5.110, vốn là GM1901. Thêm vào thì máy mang tên máy khác,
    // và tên chính là thứ duy nhất để biết IP nào ứng với ô nào trên màn hình soi.
    const oTen = document.getElementById('newDeviceName');
    oTen.value = btn.dataset.name || '';
    oTen.focus();
    oTen.select();
  });
});
