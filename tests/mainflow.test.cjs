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
const pendingDay = [];                 // các dòng main.js cất vào tab Pending
const nhanDuoc = { configure: [], readLinks: [], testConnection: [], updateKnownLinks: [] };   // Sheet giả nhận được gì
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
    check('L. Không chạy lại được → báo "Không chạy lại được" kèm lý do',
      coLog('dQ', /Không chạy lại được: .*cả hai pha/));
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
