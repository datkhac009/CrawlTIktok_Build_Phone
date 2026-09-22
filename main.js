// main.js — Electron main process: tạo cửa sổ, khai báo ipcMain handlers.
'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const devices = require('./src/devices.cjs');
const runner = require('./src/runner.cjs');
const sheets = require('./src/sheets.cjs');
const devslot = require('./src/devslot.cjs');
const linkstore = require('./src/linkstore.cjs');
const chodaysheet = require('./src/chodaysheet.cjs');
const { normalizeKey } = require('./src/linkkey.cjs');
const phaseplan = require('./src/phaseplan.cjs');
const { getDeviceDir } = require('./src/paths.cjs');

const store = new Store({ name: 'settings' });

let mainWindow = null;
let _reseedTimer = null;
let _reseedBusy = false;
// Lỗi đồng bộ Sheet gần nhất. Chỉ báo lên màn hình khi lỗi ĐỔI hoặc khi đọc lại được — lỗi mạng
// kéo dài mà báo mỗi 5 phút thì người dùng quen mắt và bỏ qua luôn cả lỗi thật.
let _reseedLoi = '';
// ĐỌC TĂNG DẦN (clone PC QĐ-09/21): lần đồng bộ sau chỉ đọc từ dòng chưa đọc trở đi.
let _sheetNextRow = 1;

// ── NẠP SHEET ĐẦU PHIÊN ──
// Một lời hứa DÙNG CHUNG cho cả phiên. Máy thứ nhất tạo, mọi máy sau dùng lại — không đọc Sheet
// hai lần song song.
//
// ⚠ KHÔNG bắt máy đứng chờ nó. Bản PC từng `await` việc đọc Sheet trước khi khởi động và giao
// diện treo vô hạn ở "Đang khởi động..." với Sheet 172.000 dòng (QĐ-09). Ở đây máy chạy ngay;
// chỉ những KẾT QUẢ về sớm, lúc bộ lọc chưa biết link của máy khác, là bị giữ lại chờ — xem
// `nhanKetQua`.
let _seedPromise = null;
let _seedDone = false;

// ── NGHỈ GIỮA HAI CHU KỲ ──
// Máy chạy hết ca thì tiến trình Python thoát và NHẢ KHE cho máy đang xếp hàng. Sau khoảng
// nghỉ, máy tự xin khe lại — nên nó vào CUỐI hàng đợi. Đây chính là thứ làm 19 máy xoay vòng
// qua 6 khe: không có nó thì 6 máy giữ khe vĩnh viễn và 13 máy còn lại chờ mãi.
const _lastParams = new Map();    // deviceId -> tham số lượt chạy gần nhất
const _cycleDone = new Set();     // máy vừa kết thúc vì HẾT CA (không phải người dùng bấm Dừng)
const _restTimers = new Map();    // deviceId -> hẹn giờ chạy lại

// ── QUÉT ⇄ XEM (2026-09-18, clone chế độ `cycle` bản PC) ──
//
// Chia pha bằng ĐÚNG `phaseplan.cjs` của bản PC — file đã nằm sẵn ở đây (bị `srcsync` khoá từng
// byte) mà chưa nơi nào gọi. Hai pha `scan` (tính bằng GIỜ) và `view` (tính bằng PHÚT), pha 0
// tự bị bỏ. Mỗi pha là MỘT lượt chạy Python: hết pha thì Python báo `cycle_done` rồi thoát, ở
// đây cho nghỉ rồi chạy pha kế — đi đúng đường "hết ca → nghỉ → chạy lại" đã có, không viết
// đường thứ hai. Hết pha máy nhả khe và xếp lại CUỐI hàng: đó là thứ giúp 19 máy chia 6 khe.
const _pha = new Map();   // deviceId -> chỉ số pha của lượt SẮP chạy / đang chạy

const TEN_PHA = { scan: 'Quét', view: 'Xem' };

function docDanhSachLink(raw) {
  return String(raw || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
}

// Kế hoạch pha của một cấu hình; `null` = không phải chế độ Quét ⇄ Xem.
function keHoachPha(cfg) {
  if (!cfg || cfg.mode !== 'cycle') return null;
  const links = docDanhSachLink(cfg.viewLinks);
  let plan = phaseplan.buildPhasePlan('cycle', {
    cycleScanHours: cfg.cycleScanHours, cycleViewMinutes: cfg.cycleViewMinutes,
  });
  // Không có link thì pha Xem không có gì để làm → bỏ, và NÓI RA (xem `chayMot`).
  const boXem = !links.length && plan.some((p) => p.key === 'view');
  if (boXem) plan = plan.filter((p) => p.key !== 'view');
  return { plan, links, boXem };
}

// Mốc "xem tới link nào" — theo TỪNG máy, trên đĩa, nên tắt app mở lại vẫn xem tiếp đúng chỗ.
function tepMoc(id) { return path.join(getDeviceDir(id), 'view_cursor.json'); }
function docMoc(id) {
  try { return Math.max(0, JSON.parse(fs.readFileSync(tepMoc(id), 'utf8')).idx | 0); } catch (_) { return 0; }
}
function ghiMoc(id, idx) {
  try { fs.writeFileSync(tepMoc(id), JSON.stringify({ idx, at: new Date().toISOString() }), 'utf8'); } catch (_) {}
}

function huyNghi(deviceId) {
  const t = _restTimers.get(deviceId);
  if (t) { clearTimeout(t); _restTimers.delete(deviceId); }
  _cycleDone.delete(deviceId);
}

// ── TỰ CHẠY LẠI KHI TIẾN TRÌNH PYTHON CHẾT (2026-09-19) ──
//
// Chủ dự án muốn TREO MÁY: không có gì được làm máy dừng hẳn. Bản cũ thì Python thoát với mã lỗi
// là máy nằm "Lỗi" tới khi có người bấm Chạy — kể cả khi lỗi chỉ thoáng qua (mất mạng một lúc lúc
// khởi động, dịch vụ trên máy đứng). Python giờ tự thoát mã 1 khi phục hồi tại chỗ hỏng 3 lần liền
// (xem scan_feed_sounds.py: "TREO MAY KHONG BI DUNG") — đó là tín hiệu để ở đây chạy lại một tiến
// trình MỚI từ đầu.
//
// LUÔN CHỜ ĐÚNG 1 PHÚT rồi chạy lại, lần nào cũng vậy, KHÔNG BỎ CUỘC tới khi người dùng bấm Dừng.
// Chủ dự án chốt (2026-09-19): "nếu lỗi … tôi chỉ muốn 1 phút thôi" — bản v0.1.11 giãn dần
// 1 → 2 → 5 → 10 → 15 phút. Số "lần n" hiện trên bảng vẫn đếm các lần lỗi LIỀN NHAU (lượt nào chạy
// được ≥ 10 phút thì đếm lại từ 1), để nhìn là biết máy đang hỏng lặp lại hay chỉ vấp một lần.
const _batDau = new Map();          // deviceId -> lúc lượt đang chạy khởi động (ms)
const _loiLien = new Map();         // deviceId -> số lần lỗi liên tiếp của các lượt ngắn
const CHO_CHAY_LAI_MS = 60 * 1000;
const LUOT_KHOE_MS = 10 * 60000;

// ── MÁY BỊ ĐƠ → TỰ KHỞI ĐỘNG LẠI ĐIỆN THOẠI (2026-09-22) ──
// Chủ dự án vẫn làm tay: bấm Dừng, vào 效卫 Restart → Confirm, rồi bấm Chạy lại. Python báo
// `may_do` ngay trước khi thoát (scan_feed_sounds.py: `bao_may_do`), ở đây quyết:
//   • CHẮC (Android treo hẳn)       → khởi động lại ngay;
//   • NGHI (không điều khiển được)  → đủ DO_NGHI_TOI_DA lượt ngắn liền mới khởi động lại.
// KHÔNG giới hạn số lần — chủ dự án chốt: "nếu cứ bị lỗi như thế thì khởi động xong rồi chạy lại là
// được". Và CHỈ chạy lại khi máy đã LÊN HẲN (chủ dự án hỏi 2026-09-22: "nhỡ hẹn 10:51 mà máy vẫn
// chưa restart xong thì sao?") — xem `choMayLenRoiChay`.
const _doLuot = new Map();      // deviceId -> { chac, lyDo } Python báo trong lượt đang chạy
const _doLien = new Map();      // deviceId -> số lượt ngắn LIÊN TIẾP kết thúc vì "nghi đơ"
const _kdlCho = new Set();      // đang khởi động lại: đã gửi lệnh, CHƯA có lượt mới nào chạy
const _kdlHomNay = new Map();   // deviceId -> { ngay, n } — số lần tự khởi động lại trong ngày
const DO_NGHI_TOI_DA = 3;
let _tuKhoiDongLai = true;      // ô "Tự khởi động lại điện thoại khi bị đơ" (Cài đặt → Toàn app)
// Sau khi gửi lệnh: hỏi máy mỗi 15 giây xem đã lên hẳn chưa (biến môi trường chỉ để phép thử chạy nhanh).
const HOI_MAY_LEN_MS = Number(process.env.HOI_MAY_LEN_MS) || 15 * 1000;
// Quá 10 phút chưa thấy máy ở IP cũ (có thể đã nhận IP mới) → về vòng chạy lại mỗi phút, vòng đó
// có dò IP theo số máy. Vẫn không chạy khi chưa tìm thấy máy.
const CHO_MAY_LEN_TOI_DA_MS = 10 * 60000;

function thoiLuong(giay) {
  const s = Math.max(0, Math.round(giay));
  return s < 60 ? `${s} giây` : `${Math.floor(s / 60)} phút${s % 60 ? ` ${s % 60} giây` : ''}`;
}

// Gọi khi một lượt chạy kết thúc bằng LỖI. Trả `true` nếu máy đang / vừa được khởi động lại — khi
// đó việc chạy lại do `choMayLenRoiChay` lo, KHÔNG hẹn "tự chạy lại lúc hh:mm" như lỗi thường.
function xetKhoiDongLai(id, serial) {
  const do_ = _doLuot.get(id);
  _doLuot.delete(id);
  // Đang khởi động lại dở (lỗi báo hai lần, hoặc lệnh chưa trả lời) — đừng hẹn chạy lại chen vào,
  // và kéo dòng trạng thái về lại "đang khởi động lại" (sự kiện 'error' vừa đổi nó thành "Lỗi").
  if (_kdlCho.has(id)) {
    sendToRenderer('crawl-status', { deviceId: id, kind: 'status', state: 'rebooting' });
    return true;
  }
  // Lượt vừa rồi chạy khoẻ (≥ 10 phút) thì đếm lại từ đầu, y như bộ đếm "lần n" của nhánh chạy lại.
  if (Date.now() - (_batDau.get(id) || 0) >= LUOT_KHOE_MS) _doLien.delete(id);
  if (!do_ || !_tuKhoiDongLai || !_lastParams.has(id) || !serial) return false;
  const n = do_.chac ? DO_NGHI_TOI_DA : (_doLien.get(id) || 0) + 1;
  if (n < DO_NGHI_TOI_DA) {
    _doLien.set(id, n);
    return false;
  }
  _doLien.delete(id);
  _kdlCho.add(id);
  const hom = new Date().toDateString();
  const truoc = _kdlHomNay.get(id);
  const lan = truoc && truoc.ngay === hom ? truoc.n + 1 : 1;
  _kdlHomNay.set(id, { ngay: hom, n: lan });
  sendToRenderer('crawl-status', {
    deviceId: id, kind: 'status', state: 'rebooting',
    msg: `🔄 Máy bị đơ (${do_.lyDo}) — đang tự khởi động lại điện thoại (lần ${lan} hôm nay). Máy lên hẳn mới chạy lại.`,
  });
  const guiLuc = Date.now();
  devices.khoiDongLai(serial).then((r) => {
    if (r.ok) return choMayLenRoiChay(id, serial, guiLuc);
    _kdlCho.delete(id);
    sendToRenderer('crawl-status', {
      deviceId: id, kind: 'log',
      line: `⚠ KHÔNG gửi được lệnh khởi động lại (${r.msg}) — cần khởi động lại tay. App vẫn thử chạy lại mỗi phút.`,
    });
    henChayLaiSauLoi(id, 'không gửi được lệnh khởi động lại');
  }, () => { _kdlCho.delete(id); henChayLaiSauLoi(id, 'không gửi được lệnh khởi động lại'); });
  return true;
}

// Máy vừa nhận lệnh khởi động lại: hỏi máy mỗi `HOI_MAY_LEN_MS`, và CHỈ chạy lại khi máy đã THẬT
// SỰ khởi động lại (uptime ít hơn thời gian từ lúc gửi lệnh — trước khi tắt, máy còn trả lời bằng
// uptime cũ) VÀ Android báo khởi động xong (`sys.boot_completed` = 1). Hẹn giờ nằm trong
// `_restTimers`, nên Dừng / Xoá huỷ được như mọi lịch chạy lại khác.
function choMayLenRoiChay(id, serial, guiLuc, baoLuc = guiLuc) {
  if (!_lastParams.has(id)) return;
  const t = setTimeout(async () => {
    _restTimers.delete(id);
    if (!_lastParams.has(id)) return;
    let tt = await devices.docKhoiDong(serial);
    // Máy lên lại thì thường rơi khỏi ADB server — nối lại đúng IP cũ (xem devices.noiLai).
    if (!tt.online && await devices.noiLai(serial)) tt = await devices.docKhoiDong(serial);
    if (!_lastParams.has(id)) return;
    const troiQua = (Date.now() - guiLuc) / 1000;
    const daLen = tt.online && tt.xong && Number.isFinite(tt.uptime);
    let cau = '';
    if (daLen && tt.uptime < troiQua + 5) {
      cau = `✅ Máy đã khởi động lại xong (sau ${thoiLuong(troiQua)}) — chạy lại.`;
    } else if (daLen && troiQua >= 180 && tt.uptime > troiQua + 60) {
      // 3 phút mà máy vẫn chạy liền từ trước lúc gửi lệnh: lệnh không có tác dụng. Chạy thử luôn —
      // còn đơ thì lượt đó báo lại và app gửi lệnh lần nữa.
      cau = '⚠ Máy không khởi động lại (lệnh không có tác dụng) — vẫn chạy lại thử.';
    } else if (Date.now() - guiLuc >= CHO_MAY_LEN_TOI_DA_MS) {
      _kdlCho.delete(id);
      sendToRenderer('crawl-status', {
        deviceId: id, kind: 'log',
        line: `⚠ Đã ${thoiLuong(troiQua)} mà chưa thấy máy lên lại ở ${serial} — chuyển sang dò máy mỗi phút (máy có thể đã nhận IP mới).`,
      });
      henChayLaiSauLoi(id, 'máy chưa lên lại sau khi khởi động lại');
      return;
    } else {
      if (Date.now() - baoLuc >= 2 * 60000) {
        baoLuc = Date.now();
        sendToRenderer('crawl-status', {
          deviceId: id, kind: 'log',
          line: `⏳ Vẫn đang chờ máy lên lại (${thoiLuong(troiQua)})…`,
        });
      }
      choMayLenRoiChay(id, serial, guiLuc, baoLuc);
      return;
    }
    sendToRenderer('crawl-status', { deviceId: id, kind: 'log', line: cau });
    chayMot(_lastParams.get(id)).then((r) => {
      if (r && !r.ok) henChayLaiSauLoi(id, r.msg);
    }, () => henChayLaiSauLoi(id, 'không khởi động được'));
  }, HOI_MAY_LEN_MS);
  _restTimers.set(id, t);
}

// ── MÁY ĐỔI IP (2026-09-19) — xem devices.cjs: "MÁY ĐỔI IP" ──
// Báo lên giao diện những máy vừa được dò ra IP mới: một dòng log trên chính máy đó, và một sự
// kiện để giao diện nạp lại danh sách (cột Serial phải hiện IP mới).
function baoDoiIp(r) {
  if (!r || !r.doi || !r.doi.length) return;
  for (const x of r.doi) {
    sendToRenderer('crawl-status', {
      deviceId: x.id, kind: 'log',
      line: `Máy ${x.name} đổi IP ${x.cu} → ${x.moi} (điện thoại vừa khởi động lại / nhận IP mới) — đã cập nhật.`,
    });
  }
  sendToRenderer('crawl-status', { deviceId: null, kind: 'devices-changed', doi: r.doi });
}

// Máy `id` đang ở IP nào. Trả `{ serial, hw }`, hoặc `{ loi }` nếu không tìm thấy.
//   • Đường nhanh (mọi lần chạy): IP cũ còn online VÀ đúng máy — theo số máy phần cứng nếu đã
//     biết, theo đời máy nếu chưa. Chỉ tốn hai lệnh getprop.
//   • Đường chậm (khi IP cũ hỏng / đã là máy khác): dò lại cả farm bằng `devices.dongBoIp`.
async function timMay(id) {
  const d = devices.loadDevices().find((x) => x.id === id);
  if (!d) return { loi: 'Máy này không còn trong danh sách.' };
  let tt = await devices.docDanhTinh(d.serial);
  // Không có trên ADB server ở IP cũ (vd điện thoại vừa khởi động lại): nối lại đúng IP đó MỘT lần
  // rồi mới đi dò IP khác — xem `noiLai` trong devices.cjs.
  if (!tt.online && await devices.noiLai(d.serial)) tt = await devices.docDanhTinh(d.serial);
  const dungMay = tt.online && (d.hw ? tt.hw === d.hw : devices.khopTen(d.name, tt.model));
  if (dungMay) {
    if (!d.hw && tt.hw) {
      try { devices.updateDevice({ id, hw: tt.hw, model: tt.model }); } catch (_) {}
    }
    return { serial: d.serial, hw: tt.hw || d.hw || '' };
  }
  const dangChay = runner.dangChayMap ? runner.dangChayMap() : new Map();
  const r = await devices.dongBoIp({ dangChay });
  baoDoiIp(r);
  const kt = r.khongThay.find((x) => x.id === id);
  if (kt) return { loi: `Không tìm thấy máy ${d.name}: ${kt.viSao}.` };
  const d2 = devices.loadDevices().find((x) => x.id === id);
  if (!d2) return { loi: 'Máy này không còn trong danh sách.' };
  return { serial: d2.serial, hw: d2.hw || '' };
}

function henChayLaiSauLoi(deviceId, lyDo) {
  // Người dùng đã bấm Dừng/Xoá (không còn tham số), hoặc đã hẹn rồi ('error' có thể tới hai lần).
  if (!_lastParams.has(deviceId) || _restTimers.has(deviceId)) return;
  const chayDuoc = Date.now() - (_batDau.get(deviceId) || 0);
  const n = chayDuoc >= LUOT_KHOE_MS ? 1 : (_loiLien.get(deviceId) || 0) + 1;
  _loiLien.set(deviceId, n);
  const ms = CHO_CHAY_LAI_MS;
  const luc = new Date(Date.now() + ms)
    .toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
  sendToRenderer('crawl-status', {
    deviceId, kind: 'status', state: 'resting', until: Date.now() + ms, next: '', loi: true,
    msg: `Lỗi (${lyDo || 'không rõ'}) — tự chạy lại lúc ${luc} (lần ${n}).`,
  });
  const t = setTimeout(() => {
    _restTimers.delete(deviceId);
    if (!_lastParams.has(deviceId)) return;
    chayMot(_lastParams.get(deviceId)).then((r) => {
      // Chưa khởi động được (vd điện thoại còn đang bị lượt khác giữ) thì hẹn tiếp, không bỏ máy.
      if (r && !r.ok) henChayLaiSauLoi(deviceId, r.msg);
    }, () => henChayLaiSauLoi(deviceId, 'không khởi động được'));
  }, ms);
  _restTimers.set(deviceId, t);
}

// Dừng HẲN một máy, ở BẤT KỲ trạng thái nào: đang chạy, đang xếp hàng, hay đang nghỉ giữa ca.
// Nút Dừng và nút Xoá cùng đi qua đây — hai đường dọn dẹp viết riêng là có ngày một đường quên
// một bước (đúng chuyện đã xảy ra: nút Xoá quên huỷ lịch chạy lại).
// Trả `'queue'` nếu máy chỉ đang xếp hàng, `'run'` nếu có tiến trình để giết, `''` nếu không.
function dungHan(deviceId) {
  huyNghi(deviceId);
  _lastParams.delete(deviceId);
  _pha.delete(deviceId);
  _loiLien.delete(deviceId);
  _doLuot.delete(deviceId);
  _doLien.delete(deviceId);
  _kdlCho.delete(deviceId);
  if (devslot.cancel(deviceId)) return 'queue';
  devslot.release(deviceId);
  return runner.stopDevice(deviceId).ok ? 'run' : '';
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 640,
    backgroundColor: '#0f1216',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  // Nạp kho link cục bộ NGAY khi mở app, trước khi máy nào kịp quét.
  //
  // ⚠ VÌ SAO (2026-09-18): chủ dự án bắt được hai dòng trùng nhau trong bảng kết quả — cùng một
  // link sound, hai máy khác nhau. Bản cũ chỉ lọc trùng ở đường ĐẨY LÊN SHEET (`sheets.enqueue`),
  // nên: tắt Sheet là mất hẳn bộ lọc; bảng trên màn hình thì không lọc gì cả; và tắt app mở lại
  // là quên sạch mọi link đã thu.
  //
  // Kho này chép nguyên từ bản PC (`linkstore.cjs`), nơi nó đã chạy thật — file text nằm cạnh
  // .exe, nạp tức thì, sống qua lần tắt app.
  try {
    linkstore.ensureFile();
    const n = linkstore.load(true).size;
    console.log(`[linkstore] đã nạp ${n} link đã biết từ kho cục bộ`);
  } catch (e) {
    console.error('[linkstore] không nạp được kho link:', e.message);
  }
  // Link đẩy lên Sheet thành công → ghi LUÔN vào kho cục bộ, không đợi vòng đồng bộ sau đọc
  // ngược về: app tắt trước vòng đó là mất (clone bản PC, main.js:435).
  // Và gỡ khỏi hàng chờ đẩy Sheet trên đĩa (src/chodaysheet.cjs).
  sheets.setOnPushed((urls) => {
    try { linkstore.addUrls(urls); } catch (_) {}
    try { if (chodaysheet.bo(urls)) baoHangCho(); } catch (_) {}
  });
  createWindow();
});

app.on('window-all-closed', () => {
  runner.stopAll();
  sheets.flushAll().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  Array.from(_restTimers.keys()).forEach(huyNghi);
  runner.stopAll();
});

// ---- Google Sheet helpers ----

// Cấu hình Sheet với Service Account ĐÃ ĐỔI từ CHUỖI (đúng nguyên văn người dùng dán vào ô) sang
// ĐỐI TƯỢNG. Trả `{ cfg, loiSa }` — `loiSa` khác rỗng khi JSON hỏng cú pháp.
//
// ⚠ VÌ SAO PHẢI Ở ĐÂY (2026-09-18, lỗi thật của v0.1.8): `sheets.cjs` chép nguyên từ bản PC chỉ
// nhận ĐỐI TƯỢNG — bên PC, việc đổi chuỗi nằm ở main.js (`JSON.parse(cfg.saJson)`). `sheets.cjs`
// cũ của bản phone thì tự đổi bên trong. Chép tệp sang mà không chuyển việc đổi ra đây là MỌI thao
// tác Sheet đều hỏng — kiểm tra kết nối, đọc link lọc trùng, đẩy link — với câu "thiếu
// client_email/private_key" dù JSON dán vào hoàn toàn đúng.
// `sheets.cjs` bị `srcsync` khoá giống bản PC từng byte, nên KHÔNG được vá bên trong nó.
function cauHinhSheet(raw) {
  const cfg = Object.assign({}, raw || {});
  let loiSa = '';
  if (typeof cfg.sa === 'string') {
    const t = cfg.sa.trim();
    if (!t) cfg.sa = null;
    else {
      try { cfg.sa = JSON.parse(t); } catch (_) {
        cfg.sa = null;
        loiSa = 'Service Account JSON hỏng cú pháp — mở file .json, chép NGUYÊN VĂN toàn bộ rồi dán lại.';
      }
    }
  }
  return { cfg, loiSa };
}
function docCauHinhSheet() { return cauHinhSheet(store.get('sheets_config') || {}); }

function applySheetsConfig() {
  const { cfg } = docCauHinhSheet();
  sheets.configure(cfg, (msg) =>
    sendToRenderer('crawl-status', { deviceId: null, kind: 'sheet-error', msg }));
  return cfg;
}

// Tab PENDING — clone `reseedFromPendingTab` bản PC. Đọc TRỌN mỗi lần (tab này nhỏ, và dòng bị
// xoá sau khi xử lý tay). Link trong đó vào kho cục bộ: đây là đường DUY NHẤT để máy này biết máy
// khác vừa cất sound nào vào Pending, vì kho link là file riêng từng máy.
async function napTabPending(cfg) {
  const tab = String((cfg && cfg.pendingTab) || '').trim();
  if (!tab || !cfg.spreadsheetId || !cfg.sa) return null;   // để trống = tính năng Pending TẮT
  try {
    const links = await sheets.readLinks(cfg.spreadsheetId, tab, cfg.sa);
    let them = 0;
    try { them = linkstore.addUrls(links); } catch (_) { them = 0; }
    return { read: links.length, added: them };
  } catch (e) {
    return { read: 0, added: 0, error: e.message };
  }
}

// Nạp link từ Sheet vào CẢ HAI bộ lọc: cổng đẩy (`sheets._knownLinks`) và kho cục bộ
// (`linkstore`) — cổng hiển thị hỏi kho cục bộ. Bản cũ lúc nạp thì ghi cả hai, nhưng vòng đồng bộ
// 5 phút lại chỉ ghi cổng đẩy: link máy khác vừa đẩy lên KHÔNG BAO GIỜ tới được cổng hiển thị.
function napVaoBoLoc(links) {
  sheets.updateKnownLinks(links);
  try { return linkstore.addUrls(links); } catch (_) { return 0; }
}

async function seedKnownLinks(cfg) {
  if (!cfg.enabled || !cfg.spreadsheetId || !cfg.sa) return;
  try {
    // Lần đầu đọc TRỌN từ dòng 1, giống bản PC — bắt kịp mọi thứ máy khác đã đẩy lên.
    const links = await sheets.readLinks(cfg.spreadsheetId, cfg.tab || 'Data', cfg.sa);
    const them = napVaoBoLoc(links);
    if (links.nextRow) _sheetNextRow = links.nextRow;
    // Sheet đọc được: dòng nào của hàng chờ đã có trên Sheet thì gỡ, phần còn lại đẩy bù (không chờ).
    try { if (chodaysheet.bo(links)) baoHangCho(); } catch (_) {}
    dayBuHangCho(cfg);
    const p = await napTabPending(cfg);
    sendToRenderer('crawl-status', {
      deviceId: null, kind: 'sheet-info',
      msg: `Đã nạp ${links.length} link từ Sheet để lọc trùng`
        + (them ? ` (${them} link mới, kho cục bộ nay có ${linkstore.count()})` : '')
        + (p && p.read ? ` + ${p.read} link từ tab Pending` : '')
        + (p && p.error ? ` — ⚠ không đọc được tab Pending: ${p.error}` : ''),
    });
  } catch (e) {
    sendToRenderer('crawl-status', {
      deviceId: null, kind: 'sheet-error',
      msg: `Đọc Sheet lỗi: ${e.message} — vẫn quét, nhưng chỉ lọc trùng được với kho link trên máy này.`,
    });
  }
}

function napSheetDauPhien(cfg) {
  if (!_seedPromise) {
    _seedDone = false;
    _seedPromise = seedKnownLinks(cfg).finally(() => {
      _seedDone = true;
      startReseedTimer(cfg);
    });
  }
  return _seedPromise;
}

function startReseedTimer(cfg) {
  if (_reseedTimer) { clearInterval(_reseedTimer); _reseedTimer = null; }
  if (!cfg.enabled || !cfg.spreadsheetId || !cfg.sa) return;
  const phut = Math.max(1, parseFloat(cfg.reseedMinutes) || 5);
  _reseedTimer = setInterval(async () => {
    if (_reseedBusy || !runner.runningIds().length) return;
    _reseedBusy = true;
    try {
      // ĐỌC TĂNG DẦN, TỰ THÍCH ỨNG THEO CỠ SHEET — chép nguyên cách bản PC làm (QĐ-09/21):
      //   • Sheet nhỏ → đọc trọn từ dòng 1: vài giây, và tự khỏi cái bẫy "xoá dòng giữa bảng".
      //   • Sheet lớn → chỉ đọc từ dòng chưa đọc. Đọc trọn 172.000 dòng mất 4,5 phút / 13 MB mà
      //     chu kỳ đồng bộ chỉ 5 phút: app tự bóp nghẹt mạng của chính nó.
      const SMALL_SHEET_ROWS = 5000;
      const from = _sheetNextRow > SMALL_SHEET_ROWS ? _sheetNextRow : 1;
      const links = await sheets.readLinks(cfg.spreadsheetId, cfg.tab || 'Data', cfg.sa, { fromRow: from });
      const them = napVaoBoLoc(links);
      if (links.nextRow) _sheetNextRow = links.nextRow;
      dayBuHangCho(cfg);   // Sheet chạy lại sau khi hỏng → đẩy bù phần còn chờ (không chờ)
      await napTabPending(cfg);
      if (_reseedLoi) {
        _reseedLoi = '';
        sendToRenderer('crawl-status', { deviceId: null, kind: 'sheet-info', msg: 'Đồng bộ Sheet chạy lại được rồi.' });
      }
      if (them) console.log(`[reseed] Sheet từ dòng ${from}: +${them} link mới vào kho (lần sau đọc từ ${_sheetNextRow})`);
    } catch (e) {
      // Bản cũ nuốt lỗi ở đây trong im lặng: Sheet hỏng bao lâu thì bộ lọc liên máy chết bấy lâu
      // mà không ai biết (QĐ-29/30).
      const m = String((e && e.message) || e);
      if (m !== _reseedLoi) {
        _reseedLoi = m;
        sendToRenderer('crawl-status', {
          deviceId: null, kind: 'sheet-error',
          msg: `Đồng bộ Sheet lỗi, thử lại sau ${phut} phút: ${m}`,
        });
      }
    } finally {
      _reseedBusy = false;
    }
  }, phut * 60 * 1000);
}

function onDevicesAllStopped() {
  if (!runner.runningIds().length) {
    // Phiên sau nạp lại Sheet từ đầu. `_sheetNextRow` thì GIỮ: nó vẫn đúng cho Sheet này.
    _seedPromise = null;
    _seedDone = false;
    if (_reseedTimer) { clearInterval(_reseedTimer); _reseedTimer = null; }
  }
}

// ── CỔNG NHẬN KẾT QUẢ: lọc trùng rồi mới gửi lên màn hình và Sheet ──
//
// Đây là chỗ DUY NHẤT mọi máy đi qua, nên cũng là chỗ duy nhất biết được máy khác đã thu link
// này chưa. Khoá so trùng dùng `normalizeKey` — ĐÚNG hàm mà kho link và đường đẩy Sheet dùng. Ba
// nơi tự chuẩn hoá theo cách riêng là có ngày lệch nhau (bài học QĐ-10).
//
// Kết quả về lúc Sheet CHƯA NẠP XONG thì GIỮ LẠI, nạp xong mới cho qua cổng. Không giữ thì máy
// nào quét trúng một link máy khác vừa đẩy lên sẽ được coi là link mới — và bị đẩy lên Sheet lần
// hai. Lời hứa `.then` chạy đúng thứ tự đăng ký nên thứ tự kết quả không bị xáo.
function nhanKetQua(deviceId, data) {
  if (_seedPromise && !_seedDone) {
    _seedPromise.then(() => quaCongLocTrung(deviceId, data));
    return;
  }
  quaCongLocTrung(deviceId, data);
}

function quaCongLocTrung(deviceId, data) {
  const khoa = normalizeKey(data.url || '');
  if (khoa && linkstore.load().has(khoa)) {
    sendToRenderer('crawl-status', {
      deviceId, kind: 'log',
      line: `Bỏ "${data.name || '(không tên)'}" — đã thu từ trước.`,
    });
    return;
  }
  if (khoa) {
    try { linkstore.addUrls([data.url]); } catch (_) { /* ghi hỏng thì thôi, đừng chặn quét */ }
  }

  // ── PENDING: sound không đọc được số video (clone QĐ-20 bản PC) ──
  // Cất vào tab Pending để kiểm tay thay vì bỏ. KHÔNG lên bảng kết quả — bảng chỉ chứa sound ĐÃ
  // đếm được. Đã vào kho cục bộ ở trên, nên không bị quét rồi cất lại lần nữa (bản PC y hệt).
  if (data.pending) {
    const daCat = sheets.isEnabled() && sheets.enqueuePending([data.name || '', data.url || '', '', tenThietBi(deviceId)]);
    sendToRenderer('crawl-status', { deviceId, kind: 'pending', ok: !!daCat });
    sendToRenderer('crawl-status', {
      deviceId, kind: 'log',
      line: daCat
        ? `Cất "${data.name || '(không tên)'}" vào tab Pending — không đọc được số video.`
        : `⚠ Không cất được "${data.name || '(không tên)'}" vào tab Pending — chưa bật Sheet hoặc chưa đặt tên tab Pending.`,
    });
    return;
  }

  sendToRenderer('crawl-data', { deviceId, ...data });
  // Cột: A=Tên sound, B=Link, C=Số post, D=Thiết bị, E=Tình trạng(=1)
  const dong = [data.name || '', data.url || '', data.posts ?? '', tenThietBi(deviceId), 1];
  // Vào HÀNG CHỜ TRÊN ĐĨA trước, kể cả khi Sheet đang tắt / đang lỗi — lên Sheet thành công mới gỡ
  // ra (`setOnPushed`). Tắt app lúc Sheet còn hỏng thì lần sau tự đẩy bù (`dayBuHangCho`).
  // Chưa từng điền Spreadsheet ID thì thôi: không có Sheet để chờ, hàng chờ chỉ phình mãi.
  const coSheet = !!String(docCauHinhSheet().cfg.spreadsheetId || '').trim();
  if (coSheet) {
    try { if (chodaysheet.them(dong)) baoHangCho(); } catch (e) { console.error('[cho-day] không ghi được:', e.message); }
  }
  if (sheets.isEnabled()) {
    if (khoa) _daXepHang.add(khoa);
    sheets.enqueue(dong);
  }
}

// ── HÀNG CHỜ ĐẨY SHEET (2026-09-21) — xem src/chodaysheet.cjs ──
// Link đã xếp vào buffer thử lại của sheets.cjs TRONG LẦN MỞ APP NÀY. Những dòng đó buffer tự đẩy
// khi Sheet chạy lại; đẩy bù chỉ lo phần còn lại (của lần mở app trước, hoặc quét lúc Sheet tắt) —
// đẩy một dòng bằng HAI đường cùng lúc là có ngày ghi trùng.
const _daXepHang = new Set();
const DAY_BU_NGHI_MS = 30 * 60 * 1000;   // đẩy bù hỏng thì nghỉ: mỗi lần thử là một lượt đọc TRỌN cột Link
let _dangDayBu = false;
let _dayBuHongLuc = 0;

function baoHangCho() {
  let n = 0;
  try { n = chodaysheet.dem(); } catch (_) {}
  sendToRenderer('crawl-status', { deviceId: null, kind: 'cho-day', n });
}

// Gọi sau mỗi lần ĐỌC Sheet thành công (nạp đầu phiên, đồng bộ định kỳ) — tức lúc Sheet đã chạy.
// Đẩy qua `pushDedup`: đọc lại cột Link rồi chỉ ghi dòng chưa có, nên dòng lỡ đã lên Sheet (app tắt
// ngay sau khi ghi, chưa kịp gỡ khỏi hàng chờ) cũng không bị ghi lần hai.
async function dayBuHangCho(cfg) {
  if (_dangDayBu || Date.now() - _dayBuHongLuc < DAY_BU_NGHI_MS) return null;
  let sot = [];
  try { sot = chodaysheet.tatCa().map((x) => x.dong).filter((d) => !_daXepHang.has(normalizeKey(d[1]))); } catch (_) {}
  if (!sot.length || !cfg || !cfg.spreadsheetId || !cfg.sa) return null;
  _dangDayBu = true;
  try {
    const r = await sheets.pushDedup({ spreadsheetId: cfg.spreadsheetId, tab: cfg.tab, sa: cfg.sa }, sot);
    if (!r.ok) throw new Error(r.msg || 'không rõ');
    try { chodaysheet.bo(sot.map((d) => d[1])); } catch (_) {}
    baoHangCho();
    sendToRenderer('crawl-status', {
      deviceId: null, kind: 'sheet-info',
      msg: `Đã đẩy bù ${r.pushed} sound còn chờ từ trước lên Sheet` + (r.skipped ? ` (bỏ ${r.skipped} đã có sẵn).` : '.'),
    });
    return r;
  } catch (e) {
    _dayBuHongLuc = Date.now();
    sendToRenderer('crawl-status', {
      deviceId: null, kind: 'sheet-error',
      msg: `Đẩy bù ${sot.length} sound còn chờ lỗi: ${e.message} — vẫn giữ trong hàng chờ, 30 phút sau thử lại (hoặc bấm ☁ Đẩy lên Sheet).`,
    });
    return null;
  } finally {
    _dangDayBu = false;
  }
}

// Tên máy cho cột "Thiết bị" trên Sheet.
function tenThietBi(deviceId) {
  const dev = devices.loadDevices().find((d) => d.id === deviceId);
  // Không thấy tên = máy đã bị xoá mà vẫn còn kết quả chảy về. Nói thẳng ra thay vì để mã
  // `d_…` trần — mã trần là thứ đã khiến lỗi "máy ma" nằm im không ai nhận ra.
  return dev ? dev.name : `máy đã xoá (${deviceId})`;
}

// ---- App info ----
ipcMain.handle('app-version', () => app.getVersion());

// ---- Devices CRUD ----
// Lần ĐẦU giao diện hỏi danh sách (lúc mở app): dò lại IP cả farm trước khi trả — farm vừa khởi
// động lại là DHCP có thể đã xáo IP (devices.cjs: "MÁY ĐỔI IP"). Chờ vài giây lúc mở app còn hơn
// hiện một danh sách IP sai rồi chạy nhầm máy.
let _daDongBoIp = false;
ipcMain.handle('devices-list', async () => {
  if (!_daDongBoIp) {
    _daDongBoIp = true;
    try {
      const r = await devices.dongBoIp({ dangChay: runner.dangChayMap ? runner.dangChayMap() : new Map() });
      // Để giao diện kịp dựng bảng rồi mới báo.
      if (r.doi.length) setTimeout(() => baoDoiIp(r), 1500);
    } catch (e) {
      console.error('[devices] dò lại IP lỗi:', e.message);
    }
  }
  return devices.loadDevices();
});
// Thêm / sửa máy = người dùng khẳng định "máy này ở IP kia": đọc luôn số máy phần cứng ở IP đó để
// lần sau máy đổi IP thì app tự dò ra. Không chờ — đọc hỏng thì lần chạy đầu sẽ đọc lại.
function ghiDanhTinh(dev) {
  if (!dev || !dev.id) return dev;
  devices.docDanhTinh(dev.serial).then((tt) => {
    if (tt.hw) {
      try { devices.updateDevice({ id: dev.id, hw: tt.hw, model: tt.model }); } catch (_) {}
    }
  }, () => {});
  return dev;
}
ipcMain.handle('devices-add', (_e, data) => ghiDanhTinh(devices.addDevice(data)));
ipcMain.handle('devices-update', (_e, data) => ghiDanhTinh(devices.updateDevice(data)));
ipcMain.handle('devices-delete', (_e, data) => {
  // ⚠ XOÁ PHẢI DỌN ĐỦ NHƯ DỪNG (2026-09-18).
  // Bản cũ chỉ gọi `runner.stopDevice` — hàm đó KHÔNG làm gì khi máy đang nghỉ giữa ca hoặc
  // đang xếp hàng, vì lúc đó không có tiến trình nào để giết. Lịch chạy lại vẫn còn, nên hết
  // giờ nghỉ Python chạy lại dưới cái id vừa xoá: không có dòng trong bảng, không có log, không
  // dừng được, chỉ lộ ra ở cột "Thiết bị" dạng `d_1789619803915`. Thêm lại đúng máy đó là hai
  // tiến trình cùng lái một điện thoại.
  dungHan(data.id);
  return devices.deleteDevice(data);
});
ipcMain.handle('devices-list-adb', () => devices.listAdbSerials());
ipcMain.handle('device-check', (_e, serial) => devices.checkDevice(serial));
ipcMain.handle('device-identify', (_e, serial) => devices.identifyDevice(serial));

// ---- Crawl control ----
// Chạy một lượt. Tách riêng để lượt chạy lại sau giờ nghỉ đi qua ĐÚNG đường này — viết hai
// đường khởi động là chắc chắn có ngày chúng lệch nhau.
async function chayMot(params) {
  const id = params && params.deviceId;
  // ── MỘT MÁY CHỈ MỘT LƯỢT (2026-09-18) ──
  // Bấm Chạy lần hai lúc máy đang xếp hàng là có HAI chỗ chờ khe cho cùng một máy. Lượt sau tới
  // khe thì `startDevice` ném "đang chạy rồi", và nhánh lỗi bên dưới nhả khe — nhả mất khe của
  // CHÍNH lượt đầu đang chạy. Kết quả: vượt trần số máy chạy đồng thời mà không ai biết.
  if (runner.isRunning(id) || devslot.isActive(id) || devslot.isWaiting(id)) {
    return { ok: false, msg: 'Máy này đang chạy hoặc đang xếp hàng rồi.' };
  }
  let giuKhe = false;   // chỉ nhả khe ở nhánh lỗi khi CHÍNH lượt này đã giữ khe
  try {
    const cfg = applySheetsConfig();
    // KHÔNG await: máy chạy ngay, kết quả về sớm được giữ lại ở `nhanKetQua` tới khi nạp xong.
    if (sheets.isEnabled()) napSheetDauPhien(cfg);
    // ── XẾP HÀNG NẾU ĐÃ CHẠM TRẦN SỐ MÁY ĐỒNG THỜI ──
    // 19 máy bật cùng lúc là 19 tiến trình Python cùng dồn lệnh qua MỘT adb server dùng chung.
    const khe = await devslot.acquire(params.deviceId, (pos) => {
      sendToRenderer('crawl-status', {
        deviceId: params.deviceId, kind: 'status', state: 'queued', pos,
        msg: `Đang xếp hàng (${pos}) — chờ khe trong ${devslot.getMax()} máy chạy đồng thời`,
      });
    });
    // `false` = người dùng đã bấm Dừng trong lúc máy còn đang xếp hàng.
    if (!khe) return { ok: false, msg: 'Đã huỷ khi đang xếp hàng.' };
    giuKhe = true;

    // Giãn cách: hai máy cùng được nhả khe một lúc mà spawn cùng lúc thì vẫn dồn cục.
    const cho = devslot.staggerDelay();
    if (cho > 0) await new Promise((r) => setTimeout(r, cho));

    // ⚠ HỎI LẠI SAU KHI CHỜ: người dùng có thể đã bấm Dừng/Xoá trong lúc máy chờ giãn cách. Lúc đó
    // máy đã giữ khe (không còn trong hàng để rút) mà chưa có tiến trình (không có gì để giết), nên
    // nút Dừng không chạm được vào nó — thiếu dòng này là máy vẫn khởi động sau khi đã bị dừng.
    // `_lastParams` còn = người dùng còn muốn máy này chạy (Dừng và Xoá đều xoá nó).
    if (!_lastParams.has(id)) {
      devslot.release(id);
      return { ok: false, msg: 'Đã huỷ trước khi kịp khởi động.' };
    }

    // ── MÁY ĐANG Ở IP NÀO — dò ngay trước khi chạy (2026-09-19) ──
    // DHCP có thể đã cấp IP mới sau khi máy khởi động lại (xem devices.cjs). Không tìm thấy máy
    // thì KHÔNG mở tiến trình Python chỉ để nó chết với một trang traceback — trả lỗi gọn, và nhánh
    // tự chạy lại sẽ dò lại sau 1 phút.
    const may = await timMay(id);
    if (!may.serial) {
      devslot.release(id);
      return { ok: false, msg: may.loi, khongThayMay: true };
    }

    // ── GẮN PHA (chế độ Quét ⇄ Xem) ──
    const kh = keHoachPha(params.cfg);
    // Tab Pending có bật không. Tắt thì Python KHÔNG tốn 2–3 giây lấy link cho sound không đọc
    // được số video — không có chỗ nào để cất nó (bản PC: "để trống = tắt, bỏ link luôn").
    let chay = Object.assign({}, params, {
      serial: may.serial,
      hw: may.hw || '',
      pendingOn: !!(sheets.isEnabled() && String(cfg.pendingTab || '').trim()),
    });
    if (kh) {
      if (!kh.plan.length) {
        devslot.release(id);
        return { ok: false, msg: 'Quét ⇄ Xem: cả hai pha đều bằng 0 — không có gì để chạy.' };
      }
      const idx = (_pha.get(id) || 0) % kh.plan.length;
      const pha = kh.plan[idx];
      if (kh.boXem && idx === 0) {
        sendToRenderer('crawl-status', {
          deviceId: id, kind: 'log',
          line: '⚠ Danh sách link cần xem đang trống — bỏ pha Xem, chỉ quét theo chu kỳ.',
        });
      }
      chay = Object.assign({}, chay, {
        pha: { key: pha.key, ms: pha.ms, links: kh.links, moc: docMoc(id) },
      });
      sendToRenderer('crawl-status', {
        deviceId: id, kind: 'phase', key: pha.key, ms: pha.ms, at: Date.now(), total: kh.links.length,
      });
    }

    _batDau.set(id, Date.now());
    _doLuot.delete(id);
    runner.startDevice(
      chay,
      (deviceId, data) => nhanKetQua(deviceId, data),
      (deviceId, status) => {
        // Python báo máy có vẻ ĐƠ, ngay trước khi thoát — xét ở nhánh 'error' bên dưới.
        if (status.kind === 'may_do') {
          _doLuot.set(deviceId, { chac: !!status.chac, lyDo: status.lyDo || 'không rõ' });
          return;
        }
        sendToRenderer('crawl-status', { deviceId, ...status });
        // Mốc xem tiếp của pha Xem: ghi NGAY mỗi lần xem xong một link, không đợi hết pha — app
        // có thể tắt giữa chừng.
        if (status.kind === 'view' && status.moc) ghiMoc(deviceId, status.idx);
        // Python báo hết ca TRƯỚC khi thoát. Ghi nhớ để lúc tiến trình đóng thì biết đây là
        // "hết ca" chứ không phải người dùng bấm Dừng hay máy lỗi.
        if (status.kind === 'status' && status.state === 'cycle_done') _cycleDone.add(deviceId);

        if (status.kind === 'status' && ['stopped', 'done', 'error'].includes(status.state)) {
          // NHẢ KHE ở đây, và ở đây thôi. Phải nhả cả khi kết thúc bằng LỖI — quên một lần là
          // hàng đợi kẹt vĩnh viễn và triệu chứng sẽ là "tự nhiên không máy nào chạy nữa".
          devslot.release(deviceId);
          sheets.flush();
          onDevicesAllStopped();
          if (status.state === 'error') {
            _cycleDone.delete(deviceId);
            // Máy bị đơ → khởi động lại rồi CHỜ máy lên hẳn mới chạy; lỗi thường → chạy lại sau 1 phút.
            if (!xetKhoiDongLai(deviceId, chay.serial)) henChayLaiSauLoi(deviceId, status.msg);
          }

          // ── Hết ca / hết pha thì nghỉ rồi tự chạy lại ──
          // ⚠ CHỈ hẹn khi tiến trình ĐÃ ĐÓNG ('stopped' do runner báo lúc tiến trình thoát).
          // 'done' là Python tự báo NGAY TRƯỚC khi thoát: hẹn ở đó mà giờ nghỉ bằng 0 thì lượt mới
          // khởi động khi tiến trình cũ còn sống, bị chặn "đang chạy rồi", và máy LẶNG LẼ ngừng
          // chu kỳ — Quét ⇄ Xem chạy lại sau MỖI pha nên sẽ gặp đúng ca này.
          if (status.state === 'stopped' && _cycleDone.delete(deviceId)) {
            _doLien.delete(deviceId);   // hết ca bình thường = máy khoẻ: đếm "nghi đơ" lại từ đầu
            const p = _lastParams.get(deviceId) || {};
            const c = p.cfg || {};
            const lo = Math.max(0, Number(c.cycleBreakMin) || 0);
            const hi = Math.max(lo, Number(c.cycleBreakMax) || lo);
            // Ngẫu nhiên trong khoảng: 19 máy nghỉ đúng bằng nhau rồi cùng xin khe một lúc là
            // lại dồn cục đúng thứ trần song song sinh ra để tránh.
            const phut = lo + Math.random() * (hi - lo);
            const ms = Math.round(phut * 60000);
            const phutVi = phut.toFixed(1).replace('.', ',');   // kiểu số Việt: 6,2 phút

            // Quét ⇄ Xem: tiến sang pha kế. Tính theo cấu hình MỚI NHẤT — người dùng có thể vừa
            // Lưu cài đặt trong lúc máy đang chạy (xem 'device-update-params').
            const khSau = keHoachPha(c);
            let sang = '';
            if (khSau && khSau.plan.length) {
              const ke = ((_pha.get(deviceId) || 0) + 1) % khSau.plan.length;
              _pha.set(deviceId, ke);
              sang = TEN_PHA[khSau.plan[ke].key] || '';
            }
            const vua = chay.pha ? TEN_PHA[chay.pha.key] : '';
            sendToRenderer('crawl-status', {
              deviceId, kind: 'status', state: 'resting', until: Date.now() + ms, next: sang,
              msg: sang
                ? `Hết pha ${vua} — nghỉ ${phutVi} phút rồi sang pha ${sang} (đã nhả khe cho máy đang chờ)`
                : `Hết ca — nghỉ ${phutVi} phút rồi tự chạy lại (đã nhả khe cho máy đang chờ)`,
            });
            const t = setTimeout(() => {
              _restTimers.delete(deviceId);
              // Người dùng có thể đã xoá máy hoặc bấm Dừng trong lúc nghỉ.
              if (!_lastParams.has(deviceId)) return;
              // Không chạy lại được thì NÓI RA — bản cũ nuốt kết quả, máy dừng chu kỳ trong im lặng.
              // Không chạy lại được (vd điện thoại đang khởi động lại, chưa online) thì hẹn thử lại sau
              // 1 phút như mọi lỗi khác — bản cũ báo "Không chạy lại được" rồi để máy đứng luôn.
              chayMot(_lastParams.get(deviceId)).then((r) => {
                if (r && !r.ok) henChayLaiSauLoi(deviceId, r.msg);
              }, () => henChayLaiSauLoi(deviceId, 'không khởi động được'));
            }, ms);
            _restTimers.set(deviceId, t);
          }
        }
      }
    );
    // Máy đã lên lại và có lượt mới chạy → từ giờ lại được tự khởi động lại nếu còn đơ.
    _kdlCho.delete(id);
    return { ok: true };
  } catch (e) {
    // Spawn hỏng (thiếu Python, thiếu adb, điện thoại đang bị lượt khác lái...) thì khe vừa xin
    // phải trả lại ngay — nhưng CHỈ khe mà chính lượt này đã giữ.
    if (giuKhe) devslot.release(id);
    return { ok: false, msg: String(e.message || e) };
  }
}

ipcMain.handle('device-start', async (_e, params) => {
  // Bấm Chạy tay thì huỷ mọi hẹn giờ nghỉ đang treo của máy đó, tránh chạy chồng hai lượt.
  huyNghi(params && params.deviceId);
  _lastParams.set(params.deviceId, params);
  // Bấm Chạy tay luôn bắt đầu từ pha ĐẦU (Quét), giống bản PC. Mốc xem tiếp thì GIỮ — nó nằm
  // trên đĩa, riêng cho từng máy.
  _pha.set(params.deviceId, 0);
  _loiLien.delete(params.deviceId);     // bấm tay là bắt đầu lại từ đầu, kể cả số "lần" lỗi
  _doLien.delete(params.deviceId);
  _kdlCho.delete(params.deviceId);
  const r = await chayMot(params);
  // Bấm Chạy lúc điện thoại chưa online (đang khởi động lại, đổi IP chưa kịp hiện) thì cũng không
  // bỏ máy: hẹn dò lại sau 1 phút như mọi lỗi khác.
  if (r && !r.ok && r.khongThayMay) henChayLaiSauLoi(params.deviceId, r.msg);
  return r;
});

// Cài đặt vừa Lưu cho một máy đang bận (chạy / nghỉ / xếp hàng) → lượt chạy KẾ TIẾP dùng bản
// mới. Chỉ cập nhật máy ĐANG có lượt chạy: tạo mới `_lastParams` cho máy đang rảnh là biến nó
// thành "máy đang bận" trong mắt Dừng tất cả và bộ đếm giờ nghỉ.
ipcMain.handle('device-update-params', (_e, params) => {
  const id = params && params.deviceId;
  if (!id || !_lastParams.has(id)) return { ok: false };
  _lastParams.set(id, Object.assign({}, _lastParams.get(id), params));
  return { ok: true };
});

ipcMain.handle('device-stop', async (_e, deviceId) => {
  // Máy có thể đang chạy, đang XẾP HÀNG, hoặc đang NGHỈ giữa hai ca. Hai trạng thái sau không có
  // tiến trình nào để giết, nhưng vẫn phải rút khỏi hàng / huỷ lịch chạy lại — không thì lát nữa
  // app tự chạy một máy người dùng đã bảo dừng.
  const dangNghi = _restTimers.has(deviceId);
  const vua = dungHan(deviceId);
  let msg = '';
  if (vua === 'queue') msg = 'Đã huỷ khi đang xếp hàng.';
  else if (!vua && dangNghi) msg = 'Đã huỷ lượt chạy lại đang hẹn sau giờ nghỉ.';
  // Máy đang chạy thì KHÔNG báo ở đây: tiến trình đóng lại sẽ tự báo 'stopped' kèm dòng tổng kết.
  if (msg) sendToRenderer('crawl-status', { deviceId, kind: 'status', state: 'stopped', msg });
  await sheets.flushAll().catch(() => {});
  onDevicesAllStopped();
  return { ok: true };
});
ipcMain.handle('devices-stop-all', async () => {
  // Gom MỌI máy đang dính líu tới lượt chạy: đang chạy, đang nghỉ, và đang xếp hàng (máy xếp hàng
  // vẫn có mặt trong `_lastParams`). Bản cũ quên nhóm cuối — bấm Dừng tất cả xong, máy đang xếp
  // hàng vẫn tự chạy khi tới lượt.
  // Thứ tự không quan trọng: máy vừa dừng nhả khe và khe đó có thể được trao cho một máy đang
  // chờ ngay trong vòng lặp này — nhưng máy đó sẽ tự huỷ ở lần hỏi lại `_lastParams` trong
  // `chayMot` trước khi kịp khởi động (tests/mainflow.test.cjs mục E + F).
  const ids = new Set([..._lastParams.keys(), ..._restTimers.keys(), ...runner.runningIds()]);
  ids.forEach(dungHan);
  await sheets.flushAll().catch(() => {});
  onDevicesAllStopped();
  return { ok: true };
});
ipcMain.handle('crawl-running-ids', () => runner.runningIds());

// ---- Google Sheet IPC ----
ipcMain.handle('sheets-get-config', () => store.get('sheets_config') || {});
ipcMain.handle('sheets-set-config', async (_e, cfg) => {
  store.set('sheets_config', cfg);
  const applied = applySheetsConfig();
  if (sheets.isEnabled() && runner.runningIds().length) {
    // Đổi cấu hình giữa phiên (có thể là sang một Sheet khác) → nạp lại từ đầu theo cấu hình
    // mới, và bỏ mốc dòng cũ vì nó thuộc về Sheet cũ.
    _seedPromise = null;
    _sheetNextRow = 1;
    napSheetDauPhien(applied);
  } else if (!sheets.isEnabled() && _reseedTimer) {
    clearInterval(_reseedTimer); _reseedTimer = null;
  }
  return { ok: true };
});
ipcMain.handle('sheets-test', async (_e, raw) => {
  // Kiểm ĐÚNG cấu hình đang gõ trong ô (chưa cần bấm Lưu) — y như bản PC.
  const { cfg, loiSa } = cauHinhSheet(raw);
  if (loiSa) return { ok: false, msg: loiSa };
  if (!cfg.sa) return { ok: false, msg: 'Chưa dán Service Account JSON.' };
  try { return await sheets.testConnection(cfg.spreadsheetId, cfg.sa); }
  catch (e) { return { ok: false, msg: e.message }; }
});
ipcMain.handle('sheets-push-manual', async (_e, rows) => {
  const { cfg, loiSa } = docCauHinhSheet();
  if (loiSa) return { ok: false, msg: loiSa };
  if (!cfg.spreadsheetId || !cfg.sa) return { ok: false, msg: 'Chưa cấu hình Google Sheet (ID/Service Account).' };
  try {
    await sheets.flushAll().catch(() => {});
    // Bảng trên màn hình CỘNG hàng chờ trên đĩa (sound của lần mở app trước, hoặc quét lúc Sheet
    // lỗi / tắt) — lấy SAU khi xả buffer, để dòng vừa lên Sheet đã rời hàng chờ.
    const gop = new Map();
    for (const d of [...chodaysheet.tatCa().map((x) => x.dong), ...(rows || [])]) {
      const k = normalizeKey(d && d[1]);
      if (k && !gop.has(k)) gop.set(k, d);
    }
    const tatCa = Array.from(gop.values());
    if (!tatCa.length) return { ok: false, msg: 'Không có gì để đẩy — bảng trống và hàng chờ trống.' };
    const r = await sheets.pushDedup({ spreadsheetId: cfg.spreadsheetId, tab: cfg.tab, sa: cfg.sa }, tatCa);
    if (r.ok) {
      const urls = tatCa.map((x) => x[1]);
      sheets.dropFromBuffer(urls);
      try { chodaysheet.bo(urls); } catch (_) {}
      baoHangCho();
    }
    return r;
  } catch (e) {
    // Mạng rớt / Sheet từ chối (403) giữa chừng: TRẢ lỗi về giao diện (y bản PC). Bản cũ để lời hứa
    // bị từ chối → giao diện không báo gì, người dùng tưởng đã đẩy xong.
    return { ok: false, msg: e.message };
  }
});

// ── KHO LINK CỤC BỘ (clone bản PC, main.js 654-702) ──
// Số sound đang chờ lên Sheet — giao diện hỏi lúc mở app (sau đó nghe sự kiện 'cho-day').
ipcMain.handle('cho-day-count', () => {
  try { return chodaysheet.dem(); } catch (_) { return 0; }
});

// Đường dẫn + số link đang giữ, để hiện trong modal ☁.
ipcMain.handle('links-info', () => {
  try { return { ok: true, path: linkstore.getFilePath(), count: linkstore.count() }; }
  catch (e) { return { ok: false, msg: e.message }; }
});
// Đọc lại file từ đĩa — sau khi người dùng tự mở file dán thêm link bằng tay.
ipcMain.handle('links-reload', () => {
  try { return { ok: true, count: linkstore.load(true).size }; }
  catch (e) { return { ok: false, msg: e.message }; }
});
// Mở file bằng trình soạn thảo mặc định để dán link vào.
ipcMain.handle('links-open-file', async () => {
  try {
    const f = linkstore.ensureFile();
    await require('electron').shell.openPath(f);
    return { ok: true, path: f };
  } catch (e) { return { ok: false, msg: e.message }; }
});
// "Nạp từ Google Sheet vào kho": đọc TRỌN cột Link, ghi những link chưa có vào file. Cách nạp kho
// lần đầu mà không phải dán tay, và cách CHỐT KHO trước khi dọn Sheet (mỗi máy bấm một lần).
ipcMain.handle('links-import-from-sheet', async () => {
  const { cfg, loiSa } = docCauHinhSheet();
  if (loiSa) return { ok: false, msg: loiSa };
  if (!cfg.spreadsheetId || !cfg.sa) return { ok: false, msg: 'Chưa cấu hình Spreadsheet ID hoặc Service Account.' };
  linkstore.ensureFile();   // Sheet trống thì file vẫn phải được tạo
  try {
    const links = await sheets.readLinks(cfg.spreadsheetId, cfg.tab || 'Data', cfg.sa);
    const added = napVaoBoLoc(links);   // vào cả bộ lọc đang chạy — khỏi phải khởi động lại app
    // Tab Pending cũng vào kho — quan trọng nhất ở ĐÚNG nút này: chốt kho trước khi dọn Sheet mà
    // bỏ sót tab Pending là dọn xong mất luôn danh sách đó.
    const p = await napTabPending(cfg);
    return {
      ok: true, read: links.length, added, total: linkstore.count(), path: linkstore.getFilePath(),
      pendingRead: p ? p.read : 0, pendingAdded: p ? p.added : 0, pendingError: p && p.error ? p.error : null,
    };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
});

// ---- Cài đặt toàn app (trần song song + giãn cách khởi động) ----
// Áp NGAY vào devslot chứ không chỉ lưu vào store: một ô cài đặt hiện ra mà không đổi hành vi
// còn tệ hơn không có ô nào (bài học QĐ-38 của bản PC).
ipcMain.handle('set-global-settings', (_e, cfg) => {
  const c = cfg || {};
  const max = devslot.setMax(c.deviceConcurrency);
  const stagger = devslot.setStaggerMs(c.launchStaggerMs);
  _tuKhoiDongLai = c.autoReboot !== false;   // mặc định BẬT (chủ dự án xin, 2026-09-22)
  return { ok: true, deviceConcurrency: max, launchStaggerMs: stagger, autoReboot: _tuKhoiDongLai };
});

// ---- Store (cài đặt) ----
ipcMain.handle('store-get', (_e, keys) => {
  if (!keys) return store.store;
  const out = {};
  (Array.isArray(keys) ? keys : [keys]).forEach((k) => (out[k] = store.get(k)));
  return out;
});
ipcMain.handle('store-set', (_e, data) => {
  Object.entries(data || {}).forEach(([k, v]) => store.set(k, v));
  return { ok: true };
});

// ---- Xuất CSV ----
ipcMain.handle('export-results', async (_e, rows) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất dữ liệu ra CSV',
    defaultPath: `sound_links_${Date.now()}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { ok: false };
  const header = ['#', 'Ten sound', 'Link', 'So post', 'Thiet bi'];
  const lines = [header.join(',')];
  rows.forEach((r, i) => {
    const cells = [i + 1, r.name, r.url, r.posts, r.deviceName].map((v) => {
      const s = String(v ?? '').replace(/"/g, '""');
      return /[,"\n]/.test(s) ? `"${s}"` : s;
    });
    lines.push(cells.join(','));
  });
  fs.writeFileSync(filePath, '﻿' + lines.join('\r\n'), 'utf-8');
  return { ok: true, filePath };
});
