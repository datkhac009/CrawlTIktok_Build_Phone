// tests/mainflow.test.cjs — CHẠY THẬT main.js với Electron giả, để kiểm HÀNH VI chứ không soi chữ.
//
// VÌ SAO CÓ FILE NÀY (2026-09-18):
// `wiring.test.cjs` soi mã nguồn tìm đúng dòng cần có. Cách đó bắt được "quên nối dây", nhưng
// KHÔNG chứng minh được dây nối xong thì chạy đúng. Hai lỗi của đợt này đều là lỗi hành vi, không
// lộ ra khi đọc từng dòng:
//   • "máy ma": xoá máy lúc đang nghỉ giữa ca → hết giờ nghỉ máy tự chạy lại dưới id đã xoá.
//   • trùng link lúc đang nạp Sheet: kết quả về sớm lọt qua khi bộ lọc chưa biết link máy khác.
// Nên ở đây nạp NGUYÊN main.js, thay đúng ba thứ không chạy được ngoài app thật (Electron, tiến
// trình Python, Google Sheet) bằng bản giả ghi lại mọi thứ, rồi bấm các nút như người dùng bấm.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
// Kho link, devices.json… đều ghi vào thư mục tạm — KHÔNG BAO GIỜ đụng dữ liệu thật (QĐ-21).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mainflow-'));
process.env.PORTABLE_EXECUTABLE_DIR = TMP;
// Sau khi khởi động lại điện thoại, main.js hỏi máy mỗi 15 giây xem lên chưa — ở đây 5 mili-giây.
process.env.HOI_MAY_LEN_MS = '5';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
// Hẹn giờ DÀI (≥ 1 phút) của main.js: ghi lại độ dài, và khi bật `tuaNhanh` thì cho nổ sau vài
// mili-giây — để thử "tự chạy lại sau lỗi" (hẹn 1–15 phút) mà không phải chờ thật (mục N).
const _setTimeoutGoc = global.setTimeout;
const henDai = [];
let tuaNhanh = false;
global.setTimeout = function (fn, ms, ...a) {
  if (typeof ms === 'number' && ms >= 60000) {
    henDai.push(ms);
    if (tuaNhanh) return _setTimeoutGoc(fn, 5, ...a);
  }
  return _setTimeoutGoc(fn, ms, ...a);
};
const nghi = (ms) => new Promise((r) => setTimeout(r, ms));
// Chờ một lời hứa, quá hạn thì trả `{ ok: 'TREO' }` thay vì chờ mãi.
const toiDa = (p, ms) => Promise.race([p, nghi(ms).then(() => ({ ok: 'TREO', msg: `treo quá ${ms} ms` }))]);

// ⚠ CHỐNG XANH GIẢ. Một lời hứa treo vĩnh viễn mà không còn hẹn giờ nào thì Node thấy hết việc và
// TỰ THOÁT VỚI MÃ 0 — phép thử dừng giữa chừng nhưng trông như đã qua. Đã xảy ra thật khi thử đột
// biến: gỡ bản vá "bấm Chạy hai lần" làm lần bấm thứ hai treo, và cả file vẫn "xanh".
let _xong = false;
process.on('beforeExit', () => {
  if (_xong) return;
  console.log('FAIL  phép thử dừng giữa chừng — có một lời hứa treo không bao giờ xong');
  console.log('\n=== 0/1 PASS ===');
  process.exitCode = 1;
});

// ── Electron giả ──
const handlers = new Map();
const sent = [];                       // mọi thứ main gửi lên giao diện: [kênh, payload]
const fakeElectron = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    getPath: () => TMP,
  },
  BrowserWindow: class {
    constructor() { this.webContents = { send: (c, p) => sent.push([c, p]) }; }
    setMenuBarVisibility() {}
    loadFile() {}
    isDestroyed() { return false; }
    static getAllWindows() { return [this]; }
  },
  ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  dialog: {},
};
class FakeStore {
  constructor() { this.data = {}; FakeStore.last = this; }
  get(k) { return this.data[k]; }
  set(k, v) { this.data[k] = v; }
  get store() { return this.data; }
}

// ── Tiến trình Python giả: ghi lại mỗi lần main khởi động một máy ──
const started = [];                    // { params, onData, onStatus }
const running = new Map();             // deviceId -> serial
const fakeRunner = {
  startDevice(params, onData, onStatus) {
    if (running.has(params.deviceId)) throw new Error('Thiết bị này đang chạy rồi.');
    running.set(params.deviceId, params.serial);
    started.push({ params, onData, onStatus });
    onStatus(params.deviceId, { kind: 'status', state: 'running' });
  },
  stopDevice(id) {
    const co = running.delete(id);
    return co ? { ok: true } : { ok: false, msg: 'Thiết bị không chạy.' };
  },
  stopAll() { running.clear(); },
  runningIds() { return [...running.keys()]; },
  isRunning(id) { return running.has(id); },
  kePhanTuongTac() { return ''; },
};
// Máy tự kết thúc lượt chạy (hết ca, hoặc bị dừng): phát đúng hai sự kiện runner thật phát.
function ketThuc(entry, hetCa) {
  const id = entry.params.deviceId;
  running.delete(id);
  if (hetCa) entry.onStatus(id, { kind: 'status', state: 'cycle_done' });
  entry.onStatus(id, { kind: 'status', state: 'stopped', msg: '' });
}

// ── Google Sheet giả: lần nạp đầu phiên TREO cho tới khi phép thử cho nó xong ──
let sheetBat = false;
let xongNap = null;                    // gọi để lần đọc Sheet đang treo trả kết quả
const pushed = [];
const pendingDay = [];                 // các dòng main.js cất vào tab Pending
const nhanDuoc = { configure: [], readLinks: [], testConnection: [], updateKnownLinks: [], pushDedup: [], drop: [] };   // Sheet giả nhận được gì
let dayHong = null;                    // đặt một Error thì nút "Đẩy lên Sheet" hỏng giữa chừng (mạng / 403)
let tabPendingGia = '';                // tên tab Pending; đọc tab này trả ngay `linkPendingGia`
let linkPendingGia = [];
const fakeSheets = {
  configure(cfg) { sheetBat = !!(cfg && cfg.enabled); nhanDuoc.configure.push(cfg); },
  isEnabled: () => sheetBat,
  setOnPushed(fn) { fakeSheets._onPushed = fn; },
  // Tab chính: TREO tới khi phép thử gọi `xongNap` (mục B cần đúng điều đó). Tab Pending: trả ngay.
  readLinks: (id, tab, sa) => {
    nhanDuoc.readLinks.push({ tab, sa });
    if (tabPendingGia && tab === tabPendingGia) return Promise.resolve(linkPendingGia.slice());
    return new Promise((res) => { xongNap = res; });
  },
  updateKnownLinks: (links) => { nhanDuoc.updateKnownLinks.push(...links); return 0; },
  enqueue: (row) => pushed.push(row),
  enqueuePending: (row) => { pendingDay.push(row); return true; },
  flush() {},
  flushAll: async () => {},
  testConnection: async (id, sa) => { nhanDuoc.testConnection.push({ id, sa }); return { ok: true }; },
  pushDedup: async (cfg, rows) => {
    nhanDuoc.pushDedup.push({ cfg, rows });
    if (dayHong) throw dayHong;
    return { ok: true, pushed: rows.length, skipped: 0, total: rows.length };
  },
  dropFromBuffer(links) { nhanDuoc.drop.push(...(links || [])); },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (request === 'electron-store') return FakeStore;
  return origLoad.apply(this, arguments);
};

// ── Danh sách máy + farm giả (2026-09-19: main.js dò IP của máy ngay trước mỗi lần chạy) ──
// Dùng ĐÚNG hàm ghép thuần `ghepMay` / `khopTen` của devices.cjs thật; chỉ thay phần đọc đĩa và
// gọi adb. `mayGia` = devices.json; `farmGia` = điện thoại đang online: serial → { model, hw }.
const devicesThat = require(path.join(ROOT, 'src', 'devices.cjs'));
const mayGia = new Map();
const farmGia = new Map();
// Điện thoại đã lên lại ở IP đó nhưng CHƯA có trên ADB server (vừa khởi động lại): chỉ `adb connect`
// mới đưa nó vào `farmGia`. `daNoiLai` ghi lại mọi lần app gọi `adb connect`.
const roiAdb = new Map();
const daNoiLai = [];
// Lệnh khởi động lại điện thoại app đã gửi (mục S) — KHÔNG bao giờ gửi `adb reboot` thật.
const daKhoiDongLai = [];
let ketQuaKhoiDongLai = { ok: true, msg: '' };
// Máy sau khi được khởi động lại trả lời gì (`docKhoiDong`): serial → { online, xong, uptime }.
// Không đặt thì: có trong farm = đã lên hẳn, vừa khởi động (uptime 1 giây); không có = còn tắt.
const khoiDongGia = new Map();
const fakeDevices = Object.assign({}, devicesThat, {
  khoiDongLai: async (serial) => { daKhoiDongLai.push(serial); return ketQuaKhoiDongLai; },
  docKhoiDong: async (serial) => khoiDongGia.get(serial)
    || (farmGia.has(serial) ? { online: true, xong: true, uptime: 1 } : { online: false, xong: false, uptime: NaN }),
  noiLai: async (serial) => {
    daNoiLai.push(serial);
    const o = roiAdb.get(serial);
    if (!o) return false;
    roiAdb.delete(serial);
    farmGia.set(serial, o);
    return true;
  },
  loadDevices: () => Array.from(mayGia.values()).map((d) => Object.assign({}, d)),
  updateDevice: ({ id, ...doi }) => {
    const d = mayGia.get(id);
    if (!d) throw new Error('Không tìm thấy thiết bị.');
    for (const [k, v] of Object.entries(doi)) if (v !== undefined) d[k] = v;
    return Object.assign({}, d);
  },
  deleteDevice: ({ id }) => { mayGia.delete(id); return { ok: true }; },
  docDanhTinh: async (serial) => {
    const o = farmGia.get(serial);
    return o ? { online: true, model: o.model, hw: o.hw } : { online: false, model: '', hw: '' };
  },
  dongBoIp: async ({ dangChay = new Map() } = {}) => {
    const online = Array.from(farmGia.entries()).map(([serial, o]) => ({ serial, model: o.model, hwSerial: o.hw }));
    const r = devicesThat.ghepMay(fakeDevices.loadDevices(), online, dangChay);
    for (const d of r.ds) if (mayGia.has(d.id)) Object.assign(mayGia.get(d.id), d);
    return r;
  },
});
// ── Gắn proxy ngay lúc bấm Lưu (src/proxyrun.cjs) giả: ghi lại mọi lần gọi. `proxyTreo` = true thì
// lời gọi TREO tới khi phép thử gọi `thaGan()` — để kiểm "đang gắn" và trần số máy gắn cùng lúc.
const ganGoi = [];
let proxyTreo = false;
const choTha = [];
const thaGan = () => { while (choTha.length) choTha.shift()({ ok: true, ip: '9.9.9.9' }); };
const fakeProxyrun = {
  chayProxy(a) {
    ganGoi.push(a);
    if (proxyTreo) return new Promise((r) => choTha.push(r));
    return Promise.resolve(a.tat ? { ok: true } : { ok: true, ip: '9.9.9.9' });
  },
};
for (const [ten, exp] of [['runner.cjs', fakeRunner], ['sheets.cjs', fakeSheets], ['devices.cjs', fakeDevices], ['proxyrun.cjs', fakeProxyrun]]) {
  const p = require.resolve(path.join(ROOT, 'src', ten));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
}

const devslot = require(path.join(ROOT, 'src', 'devslot.cjs'));
require(path.join(ROOT, 'main.js'));

const soDong = () => sent.filter(([c]) => c === 'crawl-data').length;
const coLog = (id, re) => sent.some(([c, p]) => c === 'crawl-status' && p.deviceId === id
  && re.test(String(p.line || p.msg || '')));
const lanChay = (id) => started.filter((s) => s.params.deviceId === id);
// Bấm Chạy cho một máy. Máy chưa có trong danh sách giả thì thêm vào, kèm một điện thoại online
// đúng ở IP đó (tên = đời máy) — y như farm bình thường.
const start = (id, serial, cfg = {}) => {
  if (!mayGia.has(id)) mayGia.set(id, { id, name: id, serial, note: '' });
  if (!farmGia.has(serial) && !Array.from(farmGia.values()).some((o) => o.model === id)) {
    farmGia.set(serial, { model: id, hw: 'hw-' + id });
  }
  return handlers.get('device-start')({}, { deviceId: id, serial, cfg });
};

(async () => {
  await nghi(20);   // cho app.whenReady() chạy xong: nạp kho link, tạo cửa sổ giả
  // ⚠ Tắt giãn cách khởi động (mặc định 3 giây). Để nguyên thì mọi mốc chờ bên dưới đều quá ngắn,
  // và phép thử "máy KHÔNG tự chạy lại" xanh vô nghĩa — đã xảy ra đúng như vậy ở lần viết đầu, chỉ
  // lộ ra nhờ phép đối chứng C3.
  await handlers.get('set-global-settings')({}, { deviceConcurrency: 6, launchStaggerMs: 0 });

  // ── A. Hai máy báo CÙNG một link → bảng chỉ có MỘT dòng ──
  {
    await start('dA', '192.168.5.101:5555');
    await start('dB', '192.168.5.102:5555');
    const [A, B] = [lanChay('dA')[0], lanChay('dB')[0]];
    const url = 'https://www.tiktok.com/music/original-sound-7633696888679598855';
    const truoc = soDong();
    A.onData('dA', { name: 'thật huy', url, posts: 13900 });
    B.onData('dB', { name: 'thật huy', url, posts: 13900 });
    check('A. Hai máy báo cùng một link → bảng chỉ có một dòng', soDong() - truoc === 1,
      `${soDong() - truoc} dòng`);
    check('A2. Máy báo sau nhận dòng log "đã thu từ trước"', coLog('dB', /đã thu từ trước/));

    // Link cùng sound nhưng khác dạng (tham số, hoa thường) vẫn phải bị coi là một.
    const truoc2 = soDong();
    A.onData('dA', { name: 'x', url: 'https://www.TikTok.com/music/original-sound-7633696888679598855?lang=vi', posts: 1 });
    check('A3. Cùng sound, khác dạng link → vẫn là trùng', soDong() === truoc2);
    ketThuc(A, false); ketThuc(B, false);
  }

  // ── B. Kết quả về LÚC ĐANG NẠP SHEET phải được giữ lại, nạp xong mới qua cổng lọc ──
  // Đây là lỗ thứ hai: bản cũ để máy 2..N quét khi bộ lọc chưa biết link máy khác đã đẩy lên.
  {
    FakeStore.last.set('sheets_config', { enabled: true, spreadsheetId: 'x', sa: { k: 1 }, tab: 'Data' });
    await start('dC', '192.168.5.103:5555');
    const C = lanChay('dC')[0];
    check('B. Máy chạy NGAY, không phải đứng chờ đọc Sheet', !!C);

    const daCoTrenSheet = 'https://www.tiktok.com/music/original-sound-7111111111111111111';
    const moiThat = 'https://www.tiktok.com/music/original-sound-7222222222222222222';
    const truoc = soDong();
    C.onData('dC', { name: 'máy khác đã thu', url: daCoTrenSheet, posts: 5000 });
    C.onData('dC', { name: 'mới thật', url: moiThat, posts: 5000 });
    check('B2. Trong lúc Sheet chưa nạp xong: chưa kết quả nào lên bảng', soDong() === truoc);

    check('B3. Có lượt đọc Sheet đang treo', typeof xongNap === 'function');
    xongNap([daCoTrenSheet]);
    await nghi(10);
    const moi = sent.filter(([c]) => c === 'crawl-data').slice(truoc).map(([, p]) => p.url);
    check('B4. Link máy khác đã đẩy lên Sheet → bị chặn sau khi nạp xong',
      !moi.includes(daCoTrenSheet), moi.join(' | '));
    check('B5. Link mới thật → vẫn lên bảng đúng một lần',
      moi.filter((u) => u === moiThat).length === 1);
    ketThuc(C, false);
    FakeStore.last.set('sheets_config', { enabled: false });
    sheetBat = false;
  }

  // ── C. Xoá máy lúc đang NGHỈ giữa ca → không được tự chạy lại ("máy ma") ──
  {
    const cfg = { cycleBreakMin: 0.005, cycleBreakMax: 0.005 };   // nghỉ 0,3 giây
    await start('dD', '192.168.5.104:5555', cfg);
    await start('dE', '192.168.5.105:5555', cfg);                 // đối chứng: KHÔNG xoá
    ketThuc(lanChay('dD')[0], true);
    ketThuc(lanChay('dE')[0], true);

    const nghiD = sent.find(([c, p]) => c === 'crawl-status' && p.deviceId === 'dD' && p.state === 'resting');
    check('C. Hết ca thì báo trạng thái NGHỈ, kèm giờ chạy lại',
      !!nghiD && nghiD[1].until > Date.now() - 1000);

    await handlers.get('devices-delete')({}, { id: 'dD' });
    await nghi(700);
    check('C2. Máy đã xoá KHÔNG tự chạy lại sau giờ nghỉ', lanChay('dD').length === 1,
      `chạy ${lanChay('dD').length} lần`);
    // Đối chứng — không có dòng này thì C2 có thể xanh chỉ vì cơ chế chạy lại hỏng hẳn.
    check('C3. (đối chứng) Máy KHÔNG bị xoá thì vẫn tự chạy lại', lanChay('dE').length === 2,
      `chạy ${lanChay('dE').length} lần`);
    await handlers.get('device-stop')({}, 'dE');
  }

  // ── D. Bấm Chạy hai lần lúc đang XẾP HÀNG → không sinh lượt thứ hai, không rò khe ──
  {
    await handlers.get('devices-stop-all')({});
    devslot._resetForTest();
    await handlers.get('set-global-settings')({}, { deviceConcurrency: 1, launchStaggerMs: 0 });

    await start('dF', '192.168.5.106:5555');                       // giữ khe duy nhất
    const lanDau = start('dG', '192.168.5.107:5555');              // phải xếp hàng — KHÔNG await
    await nghi(10);
    // Có bản vá thì bị từ chối NGAY; mất bản vá thì lời gọi này treo (xếp hàng lần hai).
    const lanHai = await toiDa(start('dG', '192.168.5.107:5555'), 500);
    check('D. Bấm Chạy lần hai lúc đang xếp hàng → bị từ chối', lanHai.ok === false, lanHai.msg);
    check('D2. Hàng chờ chỉ có MỘT chỗ cho máy đó', devslot.waitingCount() === 1,
      `${devslot.waitingCount()} chỗ chờ`);

    const queued = sent.find(([c, p]) => c === 'crawl-status' && p.deviceId === 'dG' && p.state === 'queued');
    check('D3. Trạng thái xếp hàng có kèm số thứ tự', !!queued && queued[1].pos === 1);

    ketThuc(lanChay('dF')[0], false);                              // dF nhả khe → dG vào
    const r = await lanDau;
    check('D4. Tới lượt thì máy đang xếp hàng được chạy', r.ok === true && lanChay('dG').length === 1);
    check('D5. Số máy chạy không vượt trần', devslot.activeCount() <= 1,
      `${devslot.activeCount()} máy giữ khe`);
    ketThuc(lanChay('dG')[0], false);
  }

  // ── E. "Dừng tất cả" phải rút cả máy đang XẾP HÀNG ──
  {
    devslot._resetForTest();
    await handlers.get('set-global-settings')({}, { deviceConcurrency: 1, launchStaggerMs: 0 });
    await start('dH', '192.168.5.108:5555');
    const choI = start('dI', '192.168.5.109:5555');                // xếp hàng
    await nghi(10);
    await handlers.get('devices-stop-all')({});
    const r = await choI;
    check('E. Dừng tất cả → máy đang xếp hàng bị huỷ, không tự chạy', r.ok === false && lanChay('dI').length === 0,
      r.msg);
  }

  // ── F. Bấm Dừng lúc máy đang CHỜ GIÃN CÁCH: đã giữ khe, chưa có tiến trình ──
  // Khoảng hở này nút Dừng không chạm tới được: máy không còn trong hàng để rút, cũng chưa có
  // tiến trình để giết. Thiếu lần hỏi lại trong `chayMot` là máy vẫn khởi động sau khi bị dừng.
  {
    devslot._resetForTest();
    await handlers.get('set-global-settings')({}, { deviceConcurrency: 6, launchStaggerMs: 400 });
    await start('dJ', '192.168.5.110:5555');                       // lượt đầu: không phải chờ
    const choK = start('dK', '192.168.5.111:5555');                // lượt sau: chờ ~400 ms
    await nghi(60);
    check('F. (tiền đề) Máy đang ở khoảng chờ: đã giữ khe, chưa chạy',
      devslot.isActive('dK') && lanChay('dK').length === 0);
    await handlers.get('device-stop')({}, 'dK');
    const r = await choK;
    check('F2. Dừng trong lúc chờ giãn cách → máy KHÔNG khởi động', r.ok === false && lanChay('dK').length === 0,
      r.msg);
    check('F3. Và khe được trả lại', !devslot.isActive('dK'));
  }

  // ── G. Lưu cài đặt lúc máy đang NGHỈ → lượt chạy lại dùng cài đặt MỚI ──
  // Bản cũ chạy lại bằng bản chụp lúc bấm Chạy: đổi cài đặt xong vẫn chạy cấu hình cũ tới khi
  // Dừng rồi Chạy tay, và không có gì trên màn hình cho biết.
  {
    devslot._resetForTest();
    await handlers.get('set-global-settings')({}, { deviceConcurrency: 6, launchStaggerMs: 0 });
    const cfgCu = { cycleBreakMin: 0.005, cycleBreakMax: 0.005, minPosts: 1000 };
    await start('dL', '192.168.5.112:5555', cfgCu);
    ketThuc(lanChay('dL')[0], true);                               // hết ca → nghỉ 0,3 giây
    const r = await handlers.get('device-update-params')({},
      { deviceId: 'dL', serial: '192.168.5.112:5555', cfg: { ...cfgCu, minPosts: 5000 } });
    check('G. Cập nhật được tham số của máy đang nghỉ', r.ok === true);
    await nghi(500);
    const lan2 = lanChay('dL')[1];
    check('G2. Lượt chạy lại sau giờ nghỉ dùng cài đặt MỚI', !!lan2 && lan2.params.cfg.minPosts === 5000,
      lan2 ? `minPosts=${lan2.params.cfg.minPosts}` : 'không chạy lại');
    await handlers.get('device-stop')({}, 'dL');

    const r2 = await handlers.get('device-update-params')({}, { deviceId: 'dRanh', cfg: {} });
    check('G3. Máy đang RẢNH thì không bị biến thành "đang bận"', r2.ok === false);
  }

  // ── H. QUÉT ⇄ XEM: pha nối pha, và mốc xem tiếp sống qua các pha ──
  {
    devslot._resetForTest();
    await handlers.get('set-global-settings')({}, { deviceConcurrency: 6, launchStaggerMs: 0 });
    const cfg = {
      mode: 'cycle', cycleScanHours: 0.001, cycleViewMinutes: 1,     // quét 3,6 giây, xem 1 phút
      viewLinks: 'https://www.tiktok.com/music/a-111111111\n  \nkhông phải link\nhttps://www.tiktok.com/music/b-222222222',
      cycleBreakMin: 0.001, cycleBreakMax: 0.001,                    // nghỉ 60 ms
    };
    await start('dM', '192.168.5.113:5555', cfg);
    const l1 = lanChay('dM')[0];
    check('H. Chế độ Quét ⇄ Xem bắt đầu bằng pha QUÉT', l1 && l1.params.pha && l1.params.pha.key === 'scan',
      JSON.stringify(l1 && l1.params.pha && { key: l1.params.pha.key, ms: l1.params.pha.ms }));
    check('H2. Thời lượng pha Quét tính bằng GIỜ, đúng như bản PC', l1.params.pha.ms === 3600);
    check('H3. Báo lên giao diện đang ở pha nào',
      sent.some(([c, p]) => c === 'crawl-status' && p.deviceId === 'dM' && p.kind === 'phase' && p.key === 'scan'));

    ketThuc(l1, true);
    await nghi(250);
    const nghi1 = sent.filter(([c, p]) => c === 'crawl-status' && p.deviceId === 'dM' && p.state === 'resting').pop();
    check('H4. Hết pha Quét → nghỉ, và nói rõ pha kế là Xem',
      !!nghi1 && nghi1[1].next === 'Xem' && /Hết pha Quét — nghỉ .* sang pha Xem/.test(nghi1[1].msg), nghi1 && nghi1[1].msg);
    const l2 = lanChay('dM')[1];
    check('H5. Nghỉ xong chạy pha XEM', !!l2 && l2.params.pha.key === 'view');
    check('H6. Danh sách link: bỏ dòng trống và dòng không phải link',
      !!l2 && JSON.stringify(l2.params.pha.links) === JSON.stringify(
        ['https://www.tiktok.com/music/a-111111111', 'https://www.tiktok.com/music/b-222222222']),
      l2 && JSON.stringify(l2.params.pha.links));
    check('H7. Lần Xem đầu bắt đầu từ link 1', !!l2 && l2.params.pha.moc === 0);

    // Pha Xem xem xong link 1 → mốc sang link 2, rồi hết pha.
    l2.onStatus('dM', { kind: 'view', idx: 1, total: 2, moc: true });
    ketThuc(l2, true);
    await nghi(250);
    const l3 = lanChay('dM')[2];
    check('H8. Hết pha Xem → quay lại pha Quét', !!l3 && l3.params.pha.key === 'scan');
    ketThuc(l3, true);
    await nghi(250);
    const l4 = lanChay('dM')[3];
    check('H9. Pha Xem SAU xem tiếp từ link 2 — không quay về link 1 (clone PC v0.1.56)',
      !!l4 && l4.params.pha.key === 'view' && l4.params.pha.moc === 1, l4 && `moc=${l4.params.pha.moc}`);
    const tep = path.join(TMP, 'config', 'devices', 'dM', 'view_cursor.json');
    check('H10. Mốc nằm trên ĐĨA, nên tắt app mở lại vẫn còn', fs.existsSync(tep)
      && JSON.parse(fs.readFileSync(tep, 'utf8')).idx === 1);
    await handlers.get('device-stop')({}, 'dM');
  }

  // ── I. Danh sách link trống → bỏ pha Xem và NÓI RA ──
  {
    await start('dN', '192.168.5.114:5555', { mode: 'cycle', cycleScanHours: 0.001, cycleViewMinutes: 30,
      viewLinks: '', cycleBreakMin: 0.001, cycleBreakMax: 0.001 });
    check('I. Danh sách trống → báo rõ là bỏ pha Xem', coLog('dN', /Danh sách link cần xem đang trống/));
    ketThuc(lanChay('dN')[0], true);
    await nghi(250);
    const l2 = lanChay('dN')[1];
    check('I2. Và chỉ quét theo chu kỳ, không chạy pha Xem rỗng', !!l2 && l2.params.pha.key === 'scan');
    await handlers.get('device-stop')({}, 'dN');
  }

  // ── J. Cả hai pha bằng 0 → từ chối, có lý do ──
  {
    const r = await start('dO', '192.168.5.115:5555', { mode: 'cycle', cycleScanHours: 0, cycleViewMinutes: 0 });
    check('J. Cả hai pha bằng 0 → không chạy, nói rõ vì sao', r.ok === false && /cả hai pha/.test(r.msg || ''), r.msg);
    check('J2. Và không giữ khe', !devslot.isActive('dO'));
  }

  // ── K. Nghỉ 0 phút: chỉ hẹn chạy lại khi tiến trình ĐÃ ĐÓNG ──
  // Python báo 'done' NGAY TRƯỚC khi thoát. Bản cũ hẹn chạy lại ở đó: nghỉ 0 phút thì lượt mới
  // khởi động khi tiến trình cũ còn sống → bị chặn "đang chạy rồi" → máy lặng lẽ ngừng chu kỳ.
  {
    await start('dP', '192.168.5.117:5555', { cycleOn: true, cycleBreakMin: 0, cycleBreakMax: 0 });
    const e = lanChay('dP')[0];
    e.onStatus('dP', { kind: 'status', state: 'cycle_done' });
    e.onStatus('dP', { kind: 'status', state: 'done' });            // tiến trình VẪN còn sống
    await nghi(30);
    running.delete('dP');                                            // giờ mới thoát thật
    e.onStatus('dP', { kind: 'status', state: 'stopped', msg: '' });
    await nghi(100);
    check('K. Nghỉ 0 phút vẫn chạy lại được lượt sau', lanChay('dP').length === 2,
      `chạy ${lanChay('dP').length} lần`);
    await handlers.get('device-stop')({}, 'dP');
  }

  // ── L. Không chạy lại được sau giờ nghỉ → phải NÓI RA, không dừng trong im lặng ──
  {
    const cfg = { mode: 'cycle', cycleScanHours: 0.001, cycleViewMinutes: 0, cycleBreakMin: 0.003, cycleBreakMax: 0.003 };
    await start('dQ', '192.168.5.118:5555', cfg);
    ketThuc(lanChay('dQ')[0], true);
    // Trong giờ nghỉ người dùng Lưu cài đặt thành 0/0 — lượt kế không còn gì để chạy.
    await handlers.get('device-update-params')({}, { deviceId: 'dQ', serial: '192.168.5.118:5555',
      cfg: { ...cfg, cycleScanHours: 0 } });
    await nghi(400);
    // Từ 2026-09-19: không bỏ máy nữa — nói rõ lý do VÀ hẹn thử lại sau 1 phút như mọi lỗi khác.
    check('L. Không chạy lại được → nói rõ lý do và hẹn thử lại sau 1 phút (không bỏ máy)',
      coLog('dQ', /Lỗi \(.*cả hai pha.*\) — tự chạy lại lúc \d\d:\d\d/));
    await handlers.get('device-stop')({}, 'dQ');
  }

  // ── M. GOOGLE SHEET: Service Account dạng chuỗi, tab Pending, kho link cục bộ ──
  // Lỗi thật của v0.1.8: dán đúng JSON mà "Test kết nối" báo "thiếu client_email/private_key".
  {
    const SA = { type: 'service_account', client_email: 'crawler@gia.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\\nX\\n-----END PRIVATE KEY-----\\n' };
    const chuoi = JSON.stringify(SA, null, 2);   // đúng thứ người dùng dán vào ô: một CHUỖI

    // M1–M2. Test kết nối.
    const r1 = await handlers.get('sheets-test')({}, { spreadsheetId: 'x', sa: chuoi });
    const lanTest = nhanDuoc.testConnection.pop();
    check('M1. "Test kết nối" với JSON dán vào ô → sheets.cjs nhận ĐỐI TƯỢNG, không phải chuỗi',
      r1.ok === true && lanTest && typeof lanTest.sa === 'object' && lanTest.sa.client_email === SA.client_email,
      lanTest ? typeof lanTest.sa : 'không gọi');
    const soLanTruoc = nhanDuoc.testConnection.length;
    const r2 = await handlers.get('sheets-test')({}, { spreadsheetId: 'x', sa: '{ "client_email": "a", ' });
    check('M2. JSON dán thiếu/hỏng → báo đúng là HỎNG CÚ PHÁP, không nói sai "thiếu client_email"',
      r2.ok === false && /hỏng cú pháp/.test(r2.msg || '') && nhanDuoc.testConnection.length === soLanTruoc, r2.msg);

    // M3–M5. Chạy máy với Sheet bật: mọi chỗ gọi Sheet đều nhận đối tượng; tab Pending được đọc.
    devslot._resetForTest();
    await handlers.get('set-global-settings')({}, { deviceConcurrency: 6, launchStaggerMs: 0 });
    tabPendingGia = 'Total_Link_Voice_Pending';
    linkPendingGia = ['https://www.tiktok.com/music/original-sound-7555555555555555555'];
    FakeStore.last.set('sheets_config', { enabled: true, spreadsheetId: 'x', tab: 'Data', sa: chuoi,
      pendingTab: tabPendingGia });
    nhanDuoc.configure.length = 0; nhanDuoc.readLinks.length = 0;
    await start('dR', '192.168.5.119:5555');
    const cfgDaNhan = nhanDuoc.configure[nhanDuoc.configure.length - 1];
    check('M3. Khi chạy máy, sheets.configure nhận Service Account dạng ĐỐI TƯỢNG',
      !!cfgDaNhan && typeof cfgDaNhan.sa === 'object' && cfgDaNhan.sa.client_email === SA.client_email);
    const lanChayR = lanChay('dR')[0];
    check('M4. Tab Pending đang bật → báo xuống Python (để lấy link cho sound không đọc được số post)',
      !!lanChayR && lanChayR.params.pendingOn === true);
    xongNap(['https://www.tiktok.com/music/original-sound-7444444444444444444']);   // tab chính xong
    await nghi(30);
    const docTab = nhanDuoc.readLinks.map((x) => x.tab);
    check('M5. Nạp đầu phiên đọc CẢ tab chính LẪN tab Pending, bằng Service Account đối tượng',
      docTab.includes('Data') && docTab.includes(tabPendingGia) && nhanDuoc.readLinks.every((x) => typeof x.sa === 'object'),
      JSON.stringify(docTab));
    // Link trong tab Pending là do MÁY KHÁC cất. Máy này gặp lại đúng sound đó thì phải coi là trùng
    // — tab Pending chỉ có tác dụng lọc trùng nếu link của nó vào được kho cục bộ.
    const dongTruocM5 = soDong();
    lanChayR.onData('dR', { name: 'máy khác đã cất Pending', url: linkPendingGia[0], posts: 5000 });
    check('M5b. Sound máy khác đã cất vào tab Pending → coi là TRÙNG, không lên bảng', soDong() === dongTruocM5);

    // M6–M8. Kết quả PENDING: cất vào tab Pending, KHÔNG lên bảng kết quả, vào kho để khỏi cất lại.
    const urlP = 'https://www.tiktok.com/music/original-sound-7666666666666666666';
    const dongTruoc = soDong();
    lanChayR.onData('dR', { name: 'không đọc được số', url: urlP, posts: null, pending: true });
    check('M6. Sound Pending được cất vào tab Pending: [tên, link, "", thiết bị]',
      pendingDay.length === 1 && pendingDay[0][1] === urlP && pendingDay[0][2] === '', JSON.stringify(pendingDay[0]));
    check('M7. Sound Pending KHÔNG lên bảng kết quả (bảng chỉ chứa sound đã đếm được)', soDong() === dongTruoc);
    lanChayR.onData('dR', { name: 'không đọc được số', url: urlP, posts: null, pending: true });
    check('M8. Gặp lại đúng sound đó → không cất lần hai (đã vào kho cục bộ)', pendingDay.length === 1);
    check('M9. Giao diện được báo để đếm chip "N lỗi → Pending"',
      sent.some(([c, p]) => c === 'crawl-status' && p.kind === 'pending' && p.ok === true));
    ketThuc(lanChayR, false);

    // M10–M12. Ba nút của kho link cục bộ.
    const info = await handlers.get('links-info')({});
    check('M10. "Kho link cục bộ" hiện đường dẫn + số link đang giữ',
      info.ok === true && /known_links\.txt$/.test(info.path) && info.count > 0, `${info.count} link`);
    const rl = await handlers.get('links-reload')({});
    check('M11. "Đọc lại file" đọc lại từ đĩa', rl.ok === true && rl.count === info.count);
    const imp = handlers.get('links-import-from-sheet')({});
    await nghi(20);
    xongNap(['https://www.tiktok.com/music/original-sound-7888888888888888888']);
    const ri = await imp;
    check('M12. "Nạp từ Google Sheet vào kho" đọc tab chính + tab Pending, báo số link thêm mới',
      ri.ok === true && ri.read === 1 && ri.added === 1 && ri.pendingRead === 1, JSON.stringify(ri));
    check('M12b. Link vừa nạp vào luôn bộ lọc ĐANG CHẠY của cổng đẩy Sheet (khỏi phải mở lại app)',
      nhanDuoc.updateKnownLinks.includes('https://www.tiktok.com/music/original-sound-7888888888888888888'));
    FakeStore.last.set('sheets_config', { enabled: false });
    sheetBat = false;
    tabPendingGia = '';
  }

  // ── N. TIẾN TRÌNH PYTHON CHẾT (mã lỗi) → TỰ CHẠY LẠI SAU ĐÚNG 1 PHÚT, Dừng huỷ được (2026-09-19) ──
  // Chủ dự án muốn treo máy: bản cũ để máy nằm "Lỗi" tới khi có người bấm Chạy. Và chốt thêm:
  // "nếu lỗi … tôi chỉ muốn 1 phút thôi" — lần nào cũng 1 phút, không giãn dần.
  {
    const ID = 'dLoi';   // 'dN' đã dùng ở mục I
    const hen = () => sent.filter(([c, p]) => c === 'crawl-status' && p.deviceId === ID && p.state === 'resting');
    // Đúng thứ runner thật làm khi tiến trình đóng với mã khác 0.
    const chet = (entry, msg = 'exit code 1') => {
      running.delete(ID);
      entry.onStatus(ID, { kind: 'status', state: 'error', msg });
    };
    tuaNhanh = true;
    henDai.length = 0;
    await start(ID, '192.168.5.130:5555');
    chet(lanChay(ID)[0]);
    const h1 = hen().pop();
    check('N1. Tiến trình chết → hẹn tự chạy lại sau 1 phút, nói rõ giờ và lần thứ mấy',
      henDai[0] === 60000 && !!h1 && h1[1].loi === true
        && /Lỗi \(exit code 1\) — tự chạy lại lúc \d\d:\d\d \(lần 1\)/.test(h1[1].msg), h1 && h1[1].msg);
    // Tiến trình phát 'error' rồi 'close' — hai sự kiện lỗi cho MỘT lần chết.
    lanChay(ID)[0].onStatus(ID, { kind: 'status', state: 'error', msg: 'exit code 1' });
    check('N2. Lỗi báo hai lần cho một lần chết → vẫn chỉ MỘT hẹn giờ', henDai.length === 1, `${henDai.length} hẹn`);
    await nghi(40);
    check("N3. Hết giờ hẹn → máy tự chạy lại, không cần ai bấm", lanChay(ID).length === 2, `${lanChay(ID).length} lượt`);

    chet(lanChay(ID)[1]);
    check('N4. Chết lần hai ngay sau đó → VẪN 1 phút (không giãn ra), bảng ghi "lần 2"',
      henDai[1] === 60000 && /\(lần 2\)/.test(hen().pop()[1].msg), `${henDai[1]} ms`);
    await nghi(40);

    // Lượt chạy được ≥ 10 phút rồi mới chết = máy đã khoẻ lại → đếm lại từ bậc đầu.
    const nowGoc = Date.now;
    Date.now = () => nowGoc() + 11 * 60000;
    chet(lanChay(ID)[2]);
    Date.now = nowGoc;
    check('N5. Lượt trước chạy được hơn 10 phút → lần lỗi này đếm lại từ đầu (1 phút, lần 1)',
      henDai[2] === 60000 && /\(lần 1\)/.test(hen().pop()[1].msg), `${henDai[2]} ms`);
    await nghi(40);

    // Tới giờ mà chưa khởi động lại được → hẹn tiếp, KHÔNG bỏ máy.
    const startGoc = fakeRunner.startDevice;
    fakeRunner.startDevice = () => { throw new Error('điện thoại đang bận'); };
    chet(lanChay(ID)[3]);
    await nghi(40);
    fakeRunner.startDevice = startGoc;
    check('N6. Tới giờ mà khởi động lại hỏng → tự hẹn lần nữa, không bỏ máy',
      hen().some(([, p]) => /điện thoại đang bận/.test(p.msg)), hen().map(([, p]) => p.msg).slice(-2).join(' | '));
    await nghi(40);
    check('N6b. Hỏng liền nhiều lần (tới "lần 4", "lần 5"…) → lần nào cũng đúng 1 phút',
      henDai.length >= 5 && henDai.every((ms) => ms === 60000), henDai.join(','));
    const soLan = lanChay(ID).length;

    // Bấm Dừng khi đang chờ chạy lại → huỷ hẳn.
    chet(lanChay(ID)[soLan - 1]);
    const r = await handlers.get('device-stop')({}, ID);
    await nghi(40);
    check('N7. Bấm Dừng lúc đang chờ chạy lại → huỷ hẹn, máy KHÔNG tự chạy nữa',
      lanChay(ID).length === soLan && r && r.ok !== false, JSON.stringify(r));

    // Người dùng bấm Dừng khi máy ĐANG CHẠY: runner báo 'stopped' chứ không 'error' → không hẹn gì.
    await start(ID, '192.168.5.130:5555');
    const dem = henDai.length;
    const cuoi = lanChay(ID)[lanChay(ID).length - 1];
    await handlers.get('device-stop')({}, ID);
    cuoi.onStatus(ID, { kind: 'status', state: 'stopped', msg: '' });
    check('N8. Dừng tay (không phải lỗi) → không hẹn chạy lại', henDai.length === dem);
    tuaNhanh = false;
  }

  // ── O. MÁY ĐỔI IP (2026-09-19): cả farm khởi động lại, DHCP xáo IP ──
  // Sự cố thật: M2010J19SG .148 → .158 (app báo "device … not online" và chạy lại mãi), còn dòng
  // "V2031" (.115) lại đang lái chiếc GM1911 vừa nhận IP .115.
  {
    tuaNhanh = true;
    // O1. Máy đã có số máy phần cứng, sang IP mới → chạy đúng IP mới, lưu lại, báo ra.
    mayGia.set('dMi', { id: 'dMi', name: 'M2010J19SG', serial: '192.168.5.148:5555', note: '', hw: 'HW-MI' });
    farmGia.set('192.168.5.158:5555', { model: 'M2010J19SG', hw: 'HW-MI' });
    const r1 = await handlers.get('device-start')({}, { deviceId: 'dMi', serial: '192.168.5.148:5555', cfg: {} });
    const l1 = lanChay('dMi')[0];
    check('O1. IP cũ không còn → tìm theo số máy phần cứng, chạy ĐÚNG IP mới',
      r1.ok === true && !!l1 && l1.params.serial === '192.168.5.158:5555' && l1.params.hw === 'HW-MI',
      l1 && JSON.stringify({ serial: l1.params.serial, hw: l1.params.hw }));
    check('O2. Lưu IP mới vào danh sách, và báo ra (log trên máy + nạp lại bảng)',
      mayGia.get('dMi').serial === '192.168.5.158:5555'
      && coLog('dMi', /Máy M2010J19SG đổi IP 192\.168\.5\.148:5555 → 192\.168\.5\.158:5555/)
      && sent.some(([c, p]) => c === 'crawl-status' && p.kind === 'devices-changed'));
    ketThuc(l1, false);

    // O3. Hai máy CŨ (chưa có số máy) bị DHCP tráo IP cho nhau — đúng cảnh V2031 / GM1911.
    mayGia.set('dV', { id: 'dV', name: 'V2031', serial: '192.168.5.115:5555', note: '' });
    mayGia.set('dG', { id: 'dG', name: 'GM1911', serial: '192.168.5.106:5555', note: '' });
    farmGia.set('192.168.5.115:5555', { model: 'GM1911', hw: 'HW-GM' });
    farmGia.set('192.168.5.125:5555', { model: 'V2031', hw: 'HW-V' });
    await handlers.get('device-start')({}, { deviceId: 'dV', serial: '192.168.5.115:5555', cfg: {} });
    const lV = lanChay('dV')[0];
    check('O3. "V2031" không lái nhầm chiếc GM1911 đang ở .115 — chạy đúng máy V2031 ở .125',
      !!lV && lV.params.serial === '192.168.5.125:5555' && lV.params.hw === 'HW-V', lV && lV.params.serial);
    check('O4. Cùng lượt dò đó, "GM1911" cũng được chuyển sang .115 (nhận theo đời máy, ghi luôn số máy)',
      mayGia.get('dG').serial === '192.168.5.115:5555' && mayGia.get('dG').hw === 'HW-GM');
    ketThuc(lV, false);

    // O5. Điện thoại chưa online ở đâu cả → KHÔNG mở Python, nói rõ, hẹn dò lại sau 1 phút.
    mayGia.set('dOff', { id: 'dOff', name: 'Redmi Note 8 Pro', serial: '192.168.5.140:5555', note: '', hw: 'HW-RN8' });
    const henTruoc = henDai.length;
    const r5 = await handlers.get('device-start')({}, { deviceId: 'dOff', serial: '192.168.5.140:5555', cfg: {} });
    check('O5. Máy chưa online ở đâu cả → không mở tiến trình, báo "Không tìm thấy máy", hẹn dò lại sau 1 phút',
      r5.ok === false && /Không tìm thấy máy Redmi Note 8 Pro/.test(r5.msg || '') && lanChay('dOff').length === 0
      && henDai.length === henTruoc + 1 && henDai[henDai.length - 1] === 60000, r5.msg);
    // Máy lên lại với IP mới → lần dò sau tìm ra và chạy.
    farmGia.set('192.168.5.150:5555', { model: 'Redmi Note 8 Pro', hw: 'HW-RN8' });
    await nghi(60);
    const lOff = lanChay('dOff')[0];
    check('O6. Điện thoại lên lại với IP mới → lần dò sau tự tìm ra và chạy, không cần ai bấm',
      !!lOff && lOff.params.serial === '192.168.5.150:5555', lOff && lOff.params.serial);
    if (lOff) ketThuc(lOff, false);
    await handlers.get('device-stop')({}, 'dOff');
    tuaNhanh = false;
  }

  // ── P. ĐIỆN THOẠI VỪA KHỞI ĐỘNG LẠI: GIỮ IP CŨ NHƯNG RƠI KHỎI ADB SERVER (2026-09-19, GM1901 .110) ──
  // Android trên máy treo → người dùng khởi động lại máy → app đang thử lại mỗi phút phải tự chạy
  // tiếp, không cần ai bấm, kể cả khi chưa ai `adb connect` máy đó.
  {
    tuaNhanh = true;
    mayGia.set('dOn', { id: 'dOn', name: 'HD1911', serial: '192.168.5.212:5555', note: '', hw: 'HW-HD' });
    farmGia.set('192.168.5.212:5555', { model: 'HD1911', hw: 'HW-HD' });
    const noiTruoc = daNoiLai.length;
    await handlers.get('device-start')({}, { deviceId: 'dOn', serial: '192.168.5.212:5555', cfg: {} });
    const lOn = lanChay('dOn')[0];
    check('P1. Máy đang online ở đúng IP → chạy luôn, KHÔNG gọi "adb connect" thừa',
      !!lOn && lOn.params.serial === '192.168.5.212:5555' && daNoiLai.length === noiTruoc,
      JSON.stringify(daNoiLai.slice(noiTruoc)));
    if (lOn) ketThuc(lOn, false);

    // P2. Máy đang khởi động (chưa nối được) → không mở Python, hẹn thử lại sau 1 phút.
    mayGia.set('dGm', { id: 'dGm', name: 'GM1901', serial: '192.168.5.210:5555', note: '', hw: 'HW-GM1901' });
    const henTruoc = henDai.length;
    const r2 = await handlers.get('device-start')({}, { deviceId: 'dGm', serial: '192.168.5.210:5555', cfg: {} });
    check('P2. Điện thoại đang khởi động lại → thử "adb connect" đúng IP cũ, chưa được thì hẹn lại sau 1 phút',
      r2.ok === false && lanChay('dGm').length === 0 && daNoiLai[daNoiLai.length - 1] === '192.168.5.210:5555'
      && henDai.length === henTruoc + 1 && henDai[henDai.length - 1] === 60000, JSON.stringify(r2));
    // P3. Máy lên lại, vẫn IP cũ, nhưng không có trên ADB server → lượt thử lại tự nối rồi chạy.
    roiAdb.set('192.168.5.210:5555', { model: 'GM1901', hw: 'HW-GM1901' });
    await nghi(60);
    const lGm = lanChay('dGm')[0];
    check('P3. Máy lên lại (vẫn IP cũ, chưa có trên ADB server) → lượt thử lại tự nối và CHẠY, không cần ai bấm',
      !!lGm && lGm.params.serial === '192.168.5.210:5555' && lGm.params.hw === 'HW-GM1901',
      lGm ? lGm.params.serial : JSON.stringify(daNoiLai.slice(-3)));
    if (lGm) ketThuc(lGm, false);
    await handlers.get('device-stop')({}, 'dGm');
    tuaNhanh = false;
  }

  // ── Q. NÚT "☁ ĐẨY LÊN SHEET" (2026-09-21, chủ dự án hỏi có đúng quy trình không) ──
  // Quy trình bản PC: gửi CẢ bảng → sheets.pushDedup đọc lại cột Link và chỉ ghi dòng chưa có.
  {
    const saQ = JSON.stringify({ type: 'service_account', client_email: 'q@gia.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\\nQ\\n-----END PRIVATE KEY-----\\n' });
    FakeStore.last.set('sheets_config', { enabled: true, spreadsheetId: 'x', tab: 'Data', sa: saQ });
    const bang = [['Sound A', 'https://www.tiktok.com/music/original-sound-7111111111111111111', 5000, 'GM1911', 1],
      ['Sound B', 'https://www.tiktok.com/music/original-sound-7222222222222222222', 9000, 'V2031', 1]];
    dayHong = null;
    nhanDuoc.pushDedup.length = 0; nhanDuoc.drop.length = 0;
    const q1 = await handlers.get('sheets-push-manual')({}, bang);
    const lan = nhanDuoc.pushDedup[0];
    check('Q1. Gửi NGUYÊN bảng cho pushDedup (tự lọc trùng) bằng Service Account đối tượng, đúng tab chính',
      q1.ok === true && q1.pushed === 2 && !!lan && lan.rows.length === 2 && lan.cfg.tab === 'Data'
      && typeof lan.cfg.sa === 'object' && nhanDuoc.drop.length === 2, JSON.stringify(q1));
    dayHong = new Error('đọc Sheet HTTP 403: The caller does not have permission');
    const q2 = await toiDa(Promise.resolve(handlers.get('sheets-push-manual')({}, bang)).catch((e) => ({ tuChoi: e.message })), 2000);
    check('Q2. Mạng rớt / Sheet từ chối giữa chừng → TRẢ lỗi rõ ràng cho giao diện, không để lời hứa bị từ chối',
      q2.ok === false && /HTTP 403/.test(q2.msg || '') && !q2.tuChoi, JSON.stringify(q2));
    dayHong = null;
  }

  // ── R. SHEET LỖI: CỨ QUÉT, ĐẨY SAU, KHÔNG TRÙNG (2026-09-21) — hàng chờ trên đĩa ──
  // Chủ dự án: "google sheet … đang bị lỗi … để nó quét và đẩy lên được không, mỗi lần đẩy phải
  // tránh bị trùng link". Hàng chờ là module THẬT, ghi vào thư mục tạm của phép thử.
  {
    const cd = require(path.join(ROOT, 'src', 'chodaysheet.cjs'));
    for (const id of [...running.keys()]) await handlers.get('device-stop')({}, id);
    cd.bo(cd.tatCa().map((x) => x.dong[1]));
    const u = (n) => `https://www.tiktok.com/music/original-sound-${n}`;
    const soCho = () => { const e = sent.filter(([c, p]) => c === 'crawl-status' && p.kind === 'cho-day').pop(); return e ? e[1].n : null; };
    const saR = JSON.stringify({ type: 'service_account', client_email: 'r@gia.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\\nR\\n-----END PRIVATE KEY-----\\n' });
    const cfgR = { enabled: true, spreadsheetId: 'x', tab: 'Data', sa: saR };
    FakeStore.last.set('sheets_config', cfgR);
    dayHong = null;

    // Lần mở app TRƯỚC để lại hai sound chưa kịp lên Sheet; một trong hai thật ra ĐÃ lên (app tắt
    // ngay sau khi ghi, chưa kịp gỡ khỏi hàng chờ).
    cd.them(['Sót lần trước', u('7301000000000000001'), 7000, 'Pixel 4 XL', 1]);
    cd.them(['Đã lên rồi', u('7301000000000000002'), 8000, 'Pixel 4 XL', 1]);
    nhanDuoc.pushDedup.length = 0;
    await start('dS', '192.168.5.220:5555');
    await nghi(20);
    xongNap([u('7301000000000000002')]);   // Sheet đọc được: chỉ có sound thứ hai
    await nghi(40);
    const lan1 = nhanDuoc.pushDedup[0];
    check('R1. Sheet chạy lại → tự đẩy bù sound còn chờ từ lần trước, BỎ sound Sheet đã có (không trùng)',
      nhanDuoc.pushDedup.length === 1 && lan1.rows.length === 1 && lan1.rows[0][1] === u('7301000000000000001')
      && lan1.rows[0][3] === 'Pixel 4 XL' && cd.dem() === 0
      && sent.some(([c, p]) => c === 'crawl-status' && p.kind === 'sheet-info' && /Đã đẩy bù 1 sound còn chờ/.test(p.msg || '')),
      JSON.stringify({ lan: nhanDuoc.pushDedup.map((x) => x.rows.map((r) => r[1])), con: cd.dem() }));

    // R2–R3. Quét được sound mới: vào hàng chờ trên đĩa TRƯỚC, rồi mới vào đường đẩy thường.
    const lS = lanChay('dS')[0];
    lS.onData('dS', { name: 'Mới quét', url: u('7302000000000000001'), posts: 9100 });
    check('R2. Sound mới quét → vào hàng chờ trên đĩa (đủ 5 cột) VÀ đường đẩy thường; giao diện thấy "1 chờ lên Sheet"',
      cd.dem() === 1 && cd.tatCa()[0].dong[1] === u('7302000000000000001') && cd.tatCa()[0].dong.length === 5
      && pushed.some((r) => r[1] === u('7302000000000000001')) && soCho() === 1, `còn ${cd.dem()}, chip ${soCho()}`);
    fakeSheets._onPushed([u('7302000000000000001')]);
    check('R3. Lên Sheet thành công → rời hàng chờ, chip về 0', cd.dem() === 0 && soCho() === 0);

    // R4. Sheet LỖI: sound nằm lại trong hàng chờ (buffer thử lại lo). Đồng bộ lại KHÔNG đẩy nó bằng
    // đường thứ hai — hai đường cùng đẩy một dòng là có ngày ghi trùng.
    lS.onData('dS', { name: 'Quét lúc Sheet lỗi', url: u('7303000000000000001'), posts: 9200 });
    nhanDuoc.pushDedup.length = 0;
    await handlers.get('sheets-set-config')({}, cfgR);   // nạp lại Sheet giữa phiên
    await nghi(20);
    xongNap([]);
    await nghi(40);
    check('R4. Sound đang nằm trong buffer thử lại → giữ trong hàng chờ, KHÔNG bị đẩy bù lần hai',
      cd.dem() === 1 && nhanDuoc.pushDedup.length === 0, `đẩy bù ${nhanDuoc.pushDedup.length} lần`);

    // R5–R6. Đẩy bù hỏng (Sheet đọc được mà ghi không được) → giữ nguyên, báo rõ, nghỉ 30 phút.
    cd.them(['Sót khi Sheet tắt', u('7304000000000000001'), 6000, 'V2031', 1]);
    dayHong = new Error('HTTP 400: This action would increase the number of cells in the workbook above the limit');
    await handlers.get('sheets-set-config')({}, cfgR);
    await nghi(20);
    xongNap([]);
    await nghi(40);
    check('R5. Đẩy bù hỏng → sound VẪN trong hàng chờ, báo lỗi rõ và hẹn thử lại',
      nhanDuoc.pushDedup.length === 1 && cd.dem() === 2
      && sent.some(([c, p]) => c === 'crawl-status' && p.kind === 'sheet-error' && /Đẩy bù 1 sound còn chờ lỗi: .*30 phút sau thử lại/.test(p.msg || '')),
      `đẩy bù ${nhanDuoc.pushDedup.length} lần, còn ${cd.dem()}`);
    dayHong = null;
    await handlers.get('sheets-set-config')({}, cfgR);
    await nghi(20);
    xongNap([]);
    await nghi(40);
    check('R6. Vừa hỏng xong → lần đồng bộ ngay sau KHÔNG thử lại (mỗi lần thử là một lượt đọc trọn cột Link)',
      nhanDuoc.pushDedup.length === 1, `đẩy bù ${nhanDuoc.pushDedup.length} lần`);

    // R7. Nút ☁ lúc BẢNG TRỐNG (vd vừa mở lại app): vẫn đẩy được hàng chờ, không chờ 30 phút.
    const r7 = await handlers.get('sheets-push-manual')({}, []);
    const lan7 = nhanDuoc.pushDedup[nhanDuoc.pushDedup.length - 1];
    check('R7. Bấm ☁ Đẩy lên Sheet khi bảng trống → đẩy luôn cả hàng chờ trên đĩa (tự lọc trùng), xong thì gỡ',
      r7.ok === true && !!lan7 && lan7.rows.map((r) => r[1]).sort().join() === [u('7303000000000000001'), u('7304000000000000001')].sort().join()
      && cd.dem() === 0 && soCho() === 0, JSON.stringify({ r7, rows: lan7 && lan7.rows.map((r) => r[1]), con: cd.dem() }));

    // R8. Chưa từng điền Spreadsheet ID → không có Sheet nào để chờ, hàng chờ không phình.
    FakeStore.last.set('sheets_config', { enabled: false });
    lS.onData('dS', { name: 'Không dùng Sheet', url: u('7305000000000000001'), posts: 9300 });
    check('R8. Không cấu hình Sheet → sound vẫn lên bảng nhưng KHÔNG vào hàng chờ',
      cd.dem() === 0 && sent.some(([c, p]) => c === 'crawl-data' && p.url === u('7305000000000000001')));

    ketThuc(lS, false);
    await handlers.get('device-stop')({}, 'dS');
    FakeStore.last.set('sheets_config', { enabled: false });
    sheetBat = false;
  }

  // ── S. MÁY BỊ ĐƠ → TỰ KHỞI ĐỘNG LẠI ĐIỆN THOẠI, CHỜ MÁY LÊN HẲN RỒI MỚI CHẠY (2026-09-22) ──
  // Chủ dự án vẫn làm tay: Dừng → 效卫 Restart → Chạy. Chốt: không giới hạn số lần. Và hỏi lại: "đúng
  // logic phải là restart xong, máy hiện lên rồi mới tự chạy lại — nhỡ hẹn 10:51 mà máy chưa lên?"
  {
    const ID = 'dDo';
    const IP = '192.168.5.230:5555';
    const cuoi = () => { const a = lanChay(ID); return a[a.length - 1]; };
    const hong = (doDo) => {
      const e = cuoi();
      if (doDo) e.onStatus(ID, Object.assign({ kind: 'may_do' }, doDo));
      running.delete(ID);
      e.onStatus(ID, { kind: 'status', state: 'error', msg: 'exit code 1' });
    };
    const CHAC = { chac: true, lyDo: 'Android trên máy treo — lõi Android đã chết' };
    const NGHI = { chac: false, lyDo: 'phục hồi hỏng 3 lần liền' };
    const soLuot = () => lanChay(ID).length;
    const trangThai = () => {
      const e = sent.filter(([c, p]) => c === 'crawl-status' && p.deviceId === ID && p.kind === 'status').pop();
      return e ? e[1] : {};
    };
    const henMoi = (truoc) => henDai.slice(truoc).filter((ms) => ms === 60000).length;
    const MAY = { model: ID, hw: 'hw-' + ID };
    await handlers.get('set-global-settings')({}, { deviceConcurrency: 6, launchStaggerMs: 0, autoReboot: true });
    daKhoiDongLai.length = 0;
    ketQuaKhoiDongLai = { ok: true, msg: '' };
    tuaNhanh = true;
    await start(ID, IP);

    // S1–S2. Android treo hẳn → khởi động lại NGAY, KHÔNG hẹn "tự chạy lại lúc hh:mm".
    const luot1 = soLuot();
    const hen1 = henDai.length;
    farmGia.delete(IP);                                              // máy tắt: rớt khỏi ADB
    khoiDongGia.set(IP, { online: false, xong: false, uptime: NaN });
    hong(CHAC);
    hong(CHAC);                                                      // lỗi báo hai lần
    await nghi(40);
    check('S1. Android treo hẳn → tự khởi động lại NGAY, bảng hiện "đang khởi động lại", KHÔNG hẹn giờ chạy lại',
      daKhoiDongLai[0] === IP && trangThai().state === 'rebooting' && henMoi(hen1) === 0
      && coLog(ID, /🔄 Máy bị đơ \(Android trên máy treo — lõi Android đã chết\) — đang tự khởi động lại điện thoại \(lần 1 hôm nay\)\. Máy lên hẳn mới chạy lại/),
      JSON.stringify({ kdl: daKhoiDongLai, st: trangThai().state, hen: henMoi(hen1) }));
    check('S2. Lỗi báo lại lúc đang khởi động → không gửi lệnh lần hai, không hẹn chạy lại chen vào',
      daKhoiDongLai.length === 1 && henMoi(hen1) === 0);

    // S3. Chưa chạy khi: máy còn tắt; máy trả lời mà CHƯA khởi động lại (uptime cũ); máy lên dở.
    check('S3a. Máy còn đang tắt → CHƯA chạy lại', soLuot() === luot1);
    // Hai ca dưới: máy VẪN trả lời trên ADB (có trong farm) — chỉ riêng phép kiểm "đã lên hẳn" giữ
    // cho app chưa chạy.
    farmGia.set(IP, MAY);
    khoiDongGia.set(IP, { online: true, xong: true, uptime: 90000 });
    await nghi(30);
    check('S3b. Máy còn trả lời bằng uptime CŨ (chưa kịp tắt) → CHƯA chạy lại', soLuot() === luot1);
    khoiDongGia.set(IP, { online: true, xong: false, uptime: 1 });
    await nghi(30);
    check('S3c. Máy đã lên ADB mà Android chưa khởi động xong → CHƯA chạy lại', soLuot() === luot1);
    khoiDongGia.delete(IP);
    farmGia.delete(IP);
    roiAdb.set(IP, MAY);                                             // lên hẳn, nhưng rơi khỏi ADB server
    await nghi(40);
    check('S3d. Máy lên HẲN (app tự nối lại IP cũ) → mới chạy lại, nói rõ đã khởi động lại xong',
      soLuot() === luot1 + 1 && cuoi().params.serial === IP
      && coLog(ID, /✅ Máy đã khởi động lại xong \(sau \d+ giây\) — chạy lại/), `${soLuot() - luot1} lượt mới`);

    // S4. Không giới hạn số lần.
    hong(CHAC);
    await nghi(40);
    check('S4. Lên lại rồi mà lại treo → khởi động lại TIẾP (không giới hạn số lần)',
      daKhoiDongLai.length === 2 && coLog(ID, /đang tự khởi động lại điện thoại \(lần 2 hôm nay\)/), JSON.stringify(daKhoiDongLai));
    await nghi(40);

    // S5. Tắt công tắc → không khởi động lại; lỗi thường chạy lại sau 1 phút như cũ.
    await handlers.get('set-global-settings')({}, { deviceConcurrency: 6, launchStaggerMs: 0, autoReboot: false });
    const luot5 = soLuot();
    const hen5 = henDai.length;
    hong(CHAC);
    await nghi(40);
    check('S5. Tắt "Tự khởi động lại điện thoại khi bị đơ" → KHÔNG khởi động lại, chạy lại sau 1 phút như cũ',
      daKhoiDongLai.length === 2 && henMoi(hen5) >= 1 && soLuot() === luot5 + 1);
    await handlers.get('set-global-settings')({}, { deviceConcurrency: 6, launchStaggerMs: 0, autoReboot: true });

    // S6. NGHI đơ → khởi động lại NGAY lượt đầu (2026-09-23; trước đó đợi đủ 3 lượt liền).
    // Python chỉ báo NGHI sau khi tự thử 3 lần trong lượt — đợi thêm lượt nữa là máy nằm đen vô ích.
    const hen6 = henDai.length;
    hong(NGHI); await nghi(60);
    check('S6. Không điều khiển được máy: khởi động lại ngay lượt NGHI đầu tiên, không hẹn "chạy lại lúc hh:mm"',
      daKhoiDongLai.length === 3 && coLog(ID, /🔄 Máy bị đơ \(phục hồi hỏng 3 lần liền\)/) && henMoi(hen6) === 0,
      JSON.stringify({ tong: daKhoiDongLai.length, hen: henMoi(hen6) }));
    await nghi(40);

    // S7. Máy lên lại mà vẫn NGHI đơ → lại khởi động lại ngay: không còn bộ đếm "đủ N lượt" nào
    // sót từ lượt trước giữ nó lại. (KHÔNG giả Date.now quanh `hong` ở đây: lệnh khởi động lại gửi
    // ngay trong `hong`, giờ giả sẽ thành `guiLuc` và app chờ máy lên mãi — bài học lúc viết mục này.)
    const luot7 = soLuot();
    hong(NGHI); await nghi(60);
    check('S7. Lên lại rồi vẫn không điều khiển được → lại khởi động lại ngay, rồi chạy lại khi máy lên',
      daKhoiDongLai.length === 4 && soLuot() === luot7 + 1, JSON.stringify({ kdl: daKhoiDongLai.length, luot: soLuot() - luot7 }));
    await nghi(40);
    const thatNow = Date.now;

    // S8. Lỗi KHÔNG kèm "máy đơ" (Python crash, mất ADB…) → không bao giờ khởi động lại.
    const truoc8 = daKhoiDongLai.length;
    hong(null); await nghi(40);
    hong(null); await nghi(40);
    hong(null); await nghi(40);
    check('S8. Lỗi không phải "máy đơ" (Python crash, mất ADB…) → không khởi động lại điện thoại',
      daKhoiDongLai.length === truoc8);

    // S9. Gửi lệnh không được → nói rõ, quay về chạy lại mỗi phút; lần đơ sau vẫn thử gửi.
    ketQuaKhoiDongLai = { ok: false, msg: "adb.exe: device '192.168.5.230:5555' not found" };
    const hen9 = henDai.length;
    const luot9 = soLuot();
    const e9 = cuoi();
    farmGia.delete(IP);                                  // máy vừa rớt khỏi ADB: chưa chạy lại được
    hong(CHAC);
    await nghi(40);
    e9.onStatus(ID, { kind: 'status', state: 'error', msg: 'exit code 1' });   // lỗi báo lần hai
    const st9 = trangThai().state;      // đọc NGAY: vòng thử lại mỗi phút sẽ ghi đè trạng thái
    farmGia.set(IP, MAY);
    await nghi(60);
    check('S9. Không gửi được lệnh khởi động lại → báo "cần khởi động lại tay", về vòng chạy lại mỗi phút (không kẹt ở "đang khởi động lại")',
      coLog(ID, /KHÔNG gửi được lệnh khởi động lại \(adb\.exe: device .* not found\) — cần khởi động lại tay/)
      && henMoi(hen9) >= 1 && st9 !== 'rebooting' && soLuot() === luot9 + 1,
      JSON.stringify({ hen: henMoi(hen9), st9, luot: soLuot() - luot9 }));
    ketQuaKhoiDongLai = { ok: true, msg: '' };
    const truoc9b = daKhoiDongLai.length;
    hong(CHAC); await nghi(60);
    check('S9b. Lượt đơ sau đó → vẫn thử gửi lệnh khởi động lại', daKhoiDongLai.length === truoc9b + 1);

    // S10. Lệnh không có tác dụng (3 phút sau máy vẫn chạy liền từ trước) → chạy thử luôn, nói rõ.
    khoiDongGia.set(IP, { online: true, xong: true, uptime: 90000 });
    hong(CHAC);
    await nghi(20);
    const luot10 = soLuot();
    Date.now = () => thatNow() + 4 * 60000;
    await nghi(30);
    Date.now = thatNow;
    khoiDongGia.delete(IP);
    check('S10. 3 phút mà máy không hề khởi động lại → vẫn chạy thử, nói rõ lệnh không có tác dụng',
      soLuot() === luot10 + 1 && coLog(ID, /⚠ Máy không khởi động lại \(lệnh không có tác dụng\) — vẫn chạy lại thử/));
    await nghi(20);

    // S11. 10 phút chưa thấy máy ở IP cũ (có thể đã nhận IP mới) → về vòng dò máy mỗi phút.
    farmGia.delete(IP);
    khoiDongGia.set(IP, { online: false, xong: false, uptime: NaN });
    const hen11 = henDai.length;
    hong(CHAC);
    await nghi(20);
    Date.now = () => thatNow() + 11 * 60000;
    await nghi(30);
    Date.now = thatNow;
    check('S11. 10 phút chưa thấy máy lên ở IP cũ → nói rõ, chuyển sang dò máy mỗi phút',
      coLog(ID, /chưa thấy máy lên lại ở 192\.168\.5\.230:5555 — chuyển sang dò máy mỗi phút/) && henMoi(hen11) >= 1);
    khoiDongGia.delete(IP);
    farmGia.set(IP, MAY);
    await nghi(40);

    // S12. Bấm Dừng lúc đang chờ máy lên → huỷ hẳn, máy lên cũng không tự chạy.
    farmGia.delete(IP);
    khoiDongGia.set(IP, { online: false, xong: false, uptime: NaN });
    hong(CHAC);
    await nghi(20);
    const luot12 = soLuot();
    await handlers.get('device-stop')({}, ID);
    khoiDongGia.delete(IP);
    farmGia.set(IP, MAY);
    await nghi(40);
    check('S12. Bấm Dừng lúc đang chờ máy lên → không tự chạy lại nữa', soLuot() === luot12 && !running.has(ID));

    // S13. Đã bấm Dừng → lỗi về muộn của lượt cũ không làm máy khởi động lại.
    const truoc13 = daKhoiDongLai.length;
    const e13 = cuoi();
    e13.onStatus(ID, Object.assign({ kind: 'may_do' }, CHAC));
    e13.onStatus(ID, { kind: 'status', state: 'error', msg: 'exit code 1' });
    await nghi(30);
    check('S13. Đã bấm Dừng → KHÔNG khởi động lại điện thoại', daKhoiDongLai.length === truoc13);
    tuaNhanh = false;
  }

  // ── P. PROXY CỦA TỪNG MÁY (2026-09-23) ──
  // Proxy nằm trong devices.json, main đọc nó NGAY TRƯỚC mỗi lượt chạy (timMay) rồi giao cho
  // runner. Mật khẩu không bao giờ đi sang giao diện.
  {
    const MK = 'MatKhauBiMat123';
    const P1 = `203.0.113.10:50100:hung:${MK}`;
    const P2 = `103.1.2.3:8080:u2:${MK}`;
    mayGia.set('dPx', { id: 'dPx', name: 'SM-A920F', serial: '520006e9ee546475', note: '', hw: 'HW-PX', proxy: P1 });
    farmGia.set('520006e9ee546475', { model: 'SM-A920F', hw: 'HW-PX' });
    mayGia.set('dPy', { id: 'dPy', name: 'SM-A920F 2', serial: '52001c84c055c4bf', note: '', hw: 'HW-PY' });
    farmGia.set('52001c84c055c4bf', { model: 'SM-A920F', hw: 'HW-PY' });

    await handlers.get('device-start')({}, { deviceId: 'dPx', serial: '520006e9ee546475', cfg: {} });
    const l1 = lanChay('dPx').slice(-1)[0];
    check('P1. Máy có proxy → runner nhận đúng chuỗi proxy', !!l1 && l1.params.proxy === P1, l1 && l1.params.proxy);
    const l0 = lanChay('dA')[0];
    check('P1b. Máy không có proxy → proxy rỗng (chạy mạng thật)', !!l0 && l0.params.proxy === '', l0 && String(l0.params.proxy));

    const ds = await handlers.get('devices-list')({});
    const px = ds.find((d) => d.id === 'dPx');
    check('P2. Danh sách gửi sang giao diện: có host:port, KHÔNG có mật khẩu',
      !!px && px.proxyHien === '203.0.113.10:50100' && !('proxy' in px) && !JSON.stringify(ds).includes(MK),
      JSON.stringify(px));

    const xem = await handlers.get('devices-set-proxies')({}, { ids: ['dPx', 'dPy'], text: `${P2}\n\n${P1}`, thu: true });
    check('P3. Xem trước: ghép đúng thứ tự, KHÔNG ghi gì, không trả mật khẩu',
      xem.ok && xem.gan.map((x) => `${x.id}=${x.hien}`).join(',') === 'dPx=103.1.2.3:8080,dPy=203.0.113.10:50100'
      && mayGia.get('dPx').proxy === P1 && !mayGia.get('dPy').proxy && !JSON.stringify(xem).includes(MK),
      JSON.stringify(xem));

    const sai = await handlers.get('devices-set-proxies')({}, { ids: ['dPx', 'dPy'], text: `${P2}\nkhong-phai-proxy` });
    check('P4. Có dòng sai → KHÔNG gán máy nào (kể cả máy có dòng đúng)',
      !sai.ok && sai.loi.length === 1 && sai.loi[0].dong === 2 && mayGia.get('dPx').proxy === P1 && !mayGia.get('dPy').proxy,
      JSON.stringify(sai));

    // Gán lúc máy đang chạy: lượt đang chạy giữ proxy cũ, lượt KẾ TIẾP dùng proxy mới.
    const ok = await handlers.get('devices-set-proxies')({}, { ids: ['dPx', 'dPy'], text: `${P2}\n${P1}` });
    check('P5. Lưu → ghi đúng máy nào proxy nấy', ok.ok && mayGia.get('dPx').proxy === P2 && mayGia.get('dPy').proxy === P1);
    // Bấm Lưu là máy RẢNH nhận proxy ngay; máy ĐANG CHẠY không bị chen (lượt sau mới gắn).
    await nghi(10);
    const goiPy = ganGoi.filter((g) => g.deviceId === 'dPy');
    check('P5b. Máy rảnh → gắn NGAY lúc Lưu, đúng điện thoại, đúng proxy',
      ok.dangGan.includes('dPy') && goiPy.length === 1 && goiPy[0].serial === '52001c84c055c4bf'
      && goiPy[0].proxy === P1 && !goiPy[0].tat, JSON.stringify(ganGoi));
    check('P5c. Máy đang chạy → KHÔNG chen vào, báo "gắn ở lượt sau"',
      ok.cho.includes('dPx') && !ganGoi.some((g) => g.deviceId === 'dPx')
      && sent.some(([c, p]) => c === 'crawl-status' && p.deviceId === 'dPx' && p.kind === 'proxy' && p.cho));
    const dsSau = await handlers.get('devices-list')({});
    const kq = (dsSau.find((d) => d.id === 'dPy') || {}).proxyKq;
    check('P5e. Kết quả gắn được LƯU (mở lại app vẫn thấy ✓ IP), không kèm mật khẩu',
      !!kq && kq.ok === true && kq.ip === '9.9.9.9' && kq.luc > 0 && !JSON.stringify(dsSau).includes(MK), JSON.stringify(kq));
    check('P5d. Giao diện thấy "đang gắn" rồi kết quả IP của máy vừa gắn',
      sent.some(([c, p]) => c === 'crawl-status' && p.deviceId === 'dPy' && p.kind === 'proxy' && p.dang)
      && sent.some(([c, p]) => c === 'crawl-status' && p.deviceId === 'dPy' && p.kind === 'proxy' && p.ok && p.ip === '9.9.9.9'));
    ketThuc(l1, false);
    await handlers.get('device-start')({}, { deviceId: 'dPx', serial: '520006e9ee546475', cfg: {} });
    const l2 = lanChay('dPx').slice(-1)[0];
    check('P6. Lượt chạy sau dùng proxy MỚI (đọc từ đĩa, không từ tham số cũ)', !!l2 && l2 !== l1 && l2.params.proxy === P2,
      l2 && l2.params.proxy);

    // Kết quả đo IP của Python đi thẳng lên giao diện.
    l2.onStatus('dPx', { kind: 'proxy', ok: true, ip: '203.0.113.10', msg: '' });
    check('P7. Sự kiện proxy (IP đo được) chuyển lên giao diện',
      sent.some(([c, p]) => c === 'crawl-status' && p.deviceId === 'dPx' && p.kind === 'proxy' && p.ip === '203.0.113.10'));
    check('P7b. Kết quả đo lúc bấm Chạy cũng được lưu',
      !!mayGia.get('dPx').proxyKq && mayGia.get('dPx').proxyKq.ip === '203.0.113.10');
    ketThuc(l2, false);

    const truocXoa = ganGoi.length;
    await handlers.get('devices-set-proxies')({}, { ids: ['dPx'], xoa: true });
    await nghi(10);
    check('P8a. Bỏ proxy máy đang rảnh → tắt College Proxy trên máy NGAY',
      ganGoi.slice(truocXoa).some((g) => g.deviceId === 'dPx' && g.tat === true), JSON.stringify(ganGoi.slice(truocXoa)));
    await handlers.get('device-start')({}, { deviceId: 'dPx', serial: '520006e9ee546475', cfg: {} });
    const l3 = lanChay('dPx').slice(-1)[0];
    check('P8. Bỏ proxy → lượt sau chạy mạng thật', !('proxy' in mayGia.get('dPx')) || !mayGia.get('dPx').proxy
      ? !!l3 && l3.params.proxy === '' : false, l3 && String(l3.params.proxy));
    ketThuc(l3, false);

    // Máy vừa chạy XONG bình thường (không nghỉ, không hẹn chạy lại) là máy RẢNH — dù main còn giữ
    // tham số lượt cũ. Bản đầu xét `_lastParams` nên máy đó bị coi là bận mãi, không bao giờ gắn ngay.
    await nghi(10);
    const truocXong = ganGoi.length;
    await handlers.get('devices-set-proxies')({}, { ids: ['dPx'], text: P1 });
    await nghi(10);
    check('P8b. Máy vừa chạy xong (còn tham số lượt cũ) vẫn được gắn NGAY',
      ganGoi.slice(truocXong).some((g) => g.deviceId === 'dPx' && g.proxy === P1));

    // ── Đang gắn: bấm Chạy bị chặn, và KHÔNG để lại dấu "đang bận" ──
    await nghi(10);
    proxyTreo = true;
    await handlers.get('devices-set-proxies')({}, { ids: ['dPy'], text: P2 });
    const soLuotPy = lanChay('dPy').length;
    const rChen = await handlers.get('device-start')({}, { deviceId: 'dPy', serial: '52001c84c055c4bf', cfg: {} });
    check('P9. Bấm Chạy lúc máy đang được gắn proxy → từ chối, nói rõ lý do',
      rChen.ok === false && /đang được gắn proxy/.test(rChen.msg) && lanChay('dPy').length === soLuotPy, JSON.stringify(rChen));
    thaGan();
    await nghi(10);
    const rSau = await handlers.get('device-start')({}, { deviceId: 'dPy', serial: '52001c84c055c4bf', cfg: {} });
    check('P9b. Gắn xong → bấm Chạy được ngay (lần bị từ chối không làm máy kẹt "đang bận")',
      rSau.ok === true && lanChay('dPy').length === soLuotPy + 1, JSON.stringify(rSau));
    ketThuc(lanChay('dPy').slice(-1)[0], false);

    // ── Trần 3 máy gắn cùng lúc (chung một adb server) ──
    await nghi(10);
    const nam = ['dQ1', 'dQ2', 'dQ3', 'dQ4', 'dQ5'];
    nam.forEach((id, i) => {
      mayGia.set(id, { id, name: id, serial: `52000000000000${i}`, note: '', hw: 'HW-' + id });
      farmGia.set(`52000000000000${i}`, { model: id, hw: 'HW-' + id });
    });
    const truocTran = ganGoi.length;
    const rTran = await handlers.get('devices-set-proxies')({}, { ids: nam, text: nam.map((_, i) => `1.1.1.${i + 1}:80:u:p`).join('\n') });
    await nghi(20);
    const dangChayCung = ganGoi.length - truocTran;
    thaGan();
    await nghi(20);
    thaGan();
    await nghi(20);
    check('P10. Lưu 5 máy → gắn tối đa 3 máy một lúc, rồi đủ cả 5',
      rTran.dangGan.length === 5 && dangChayCung === 3 && ganGoi.length - truocTran === 5,
      `${dangChayCung} cùng lúc, tổng ${ganGoi.length - truocTran}`);
    proxyTreo = false;
  }

  _xong = true;
  const failed = results.filter((x) => !x.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  // Thoát thẳng: main.js có thể còn hẹn giờ đồng bộ Sheet 5 phút đang treo.
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log('FAIL  lỗi không bắt được: ' + (e && e.stack || e));
  console.log('\n=== 0/1 PASS ===');
  process.exit(1);
});
