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

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
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
const fakeSheets = {
  configure(cfg) { sheetBat = !!(cfg && cfg.enabled); },
  isEnabled: () => sheetBat,
  setOnPushed(fn) { fakeSheets._onPushed = fn; },
  readLinks: () => new Promise((res) => { xongNap = res; }),
  updateKnownLinks: () => 0,
  enqueue: (row) => pushed.push(row),
  flush() {},
  flushAll: async () => {},
  testConnection: async () => ({ ok: true }),
  pushDedup: async () => ({ ok: true }),
  dropFromBuffer() {},
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (request === 'electron-store') return FakeStore;
  return origLoad.apply(this, arguments);
};
for (const [ten, exp] of [['runner.cjs', fakeRunner], ['sheets.cjs', fakeSheets]]) {
  const p = require.resolve(path.join(ROOT, 'src', ten));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
}

const devslot = require(path.join(ROOT, 'src', 'devslot.cjs'));
require(path.join(ROOT, 'main.js'));

const soDong = () => sent.filter(([c]) => c === 'crawl-data').length;
const coLog = (id, re) => sent.some(([c, p]) => c === 'crawl-status' && p.deviceId === id
  && re.test(String(p.line || p.msg || '')));
const lanChay = (id) => started.filter((s) => s.params.deviceId === id);
const start = (id, serial, cfg = {}) => handlers.get('device-start')({}, { deviceId: id, serial, cfg });

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
