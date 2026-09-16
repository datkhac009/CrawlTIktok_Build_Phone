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

const store = new Store({ name: 'settings' });

let mainWindow = null;
let _reseedTimer = null;
let _seededThisSession = false;

// ── NGHỈ GIỮA HAI CHU KỲ ──
// Máy chạy hết ca thì tiến trình Python thoát và NHẢ KHE cho máy đang xếp hàng. Sau khoảng
// nghỉ, máy tự xin khe lại — nên nó vào CUỐI hàng đợi. Đây chính là thứ làm 19 máy xoay vòng
// qua 6 khe: không có nó thì 6 máy giữ khe vĩnh viễn và 13 máy còn lại chờ mãi.
const _lastParams = new Map();    // deviceId -> tham số lượt chạy gần nhất
const _cycleDone = new Set();     // máy vừa kết thúc vì HẾT CA (không phải người dùng bấm Dừng)
const _restTimers = new Map();    // deviceId -> hẹn giờ chạy lại

function huyNghi(deviceId) {
  const t = _restTimers.get(deviceId);
  if (t) { clearTimeout(t); _restTimers.delete(deviceId); }
  _cycleDone.delete(deviceId);
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

app.whenReady().then(createWindow);

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
function applySheetsConfig() {
  const cfg = store.get('sheets_config') || {};
  sheets.configure(cfg, (msg) =>
    sendToRenderer('crawl-status', { deviceId: null, kind: 'sheet-error', msg }));
  return cfg;
}

async function seedKnownLinks(cfg) {
  if (!cfg.enabled || !cfg.spreadsheetId || !cfg.sa) return;
  try {
    const links = await sheets.readLinks(cfg.spreadsheetId, cfg.tab || 'Data', cfg.sa);
    sheets.updateKnownLinks(links);
    sendToRenderer('crawl-status', { deviceId: null, kind: 'sheet-info', msg: `Đã nạp ${links.length} link từ Sheet để lọc trùng` });
  } catch (e) {
    sendToRenderer('crawl-status', { deviceId: null, kind: 'sheet-error', msg: `Đọc Sheet lỗi: ${e.message}` });
  }
}

function startReseedTimer(cfg) {
  if (_reseedTimer) { clearInterval(_reseedTimer); _reseedTimer = null; }
  if (!cfg.enabled || !cfg.spreadsheetId || !cfg.sa) return;
  const everyMs = Math.max(1, parseFloat(cfg.reseedMinutes) || 5) * 60 * 1000;
  _reseedTimer = setInterval(async () => {
    if (!runner.runningIds().length) return;
    try {
      const links = await sheets.readLinks(cfg.spreadsheetId, cfg.tab || 'Data', cfg.sa);
      sheets.updateKnownLinks(links);
    } catch (_) { /* thử lại vòng sau */ }
  }, everyMs);
}

function onDevicesAllStopped() {
  if (!runner.runningIds().length) {
    _seededThisSession = false;
    if (_reseedTimer) { clearInterval(_reseedTimer); _reseedTimer = null; }
  }
}

// ---- App info ----
ipcMain.handle('app-version', () => app.getVersion());

// ---- Devices CRUD ----
ipcMain.handle('devices-list', () => devices.loadDevices());
ipcMain.handle('devices-add', (_e, data) => devices.addDevice(data));
ipcMain.handle('devices-update', (_e, data) => devices.updateDevice(data));
ipcMain.handle('devices-delete', (_e, data) => {
  runner.stopDevice(data.id);
  return devices.deleteDevice(data);
});
ipcMain.handle('devices-list-adb', () => devices.listAdbSerials());
ipcMain.handle('device-check', (_e, serial) => devices.checkDevice(serial));

// ---- Crawl control ----
// Chạy một lượt. Tách riêng để lượt chạy lại sau giờ nghỉ đi qua ĐÚNG đường này — viết hai
// đường khởi động là chắc chắn có ngày chúng lệch nhau.
async function chayMot(params) {
  try {
    const cfg = applySheetsConfig();
    if (sheets.isEnabled() && !_seededThisSession) {
      _seededThisSession = true;
      await seedKnownLinks(cfg);
      startReseedTimer(cfg);
    }
    // ── XẾP HÀNG NẾU ĐÃ CHẠM TRẦN SỐ MÁY ĐỒNG THỜI ──
    // 19 máy bật cùng lúc là ~19 tiến trình Python + 19 ADB server trên máy điều khiển.
    const khe = await devslot.acquire(params.deviceId, (pos) => {
      sendToRenderer('crawl-status', {
        deviceId: params.deviceId, kind: 'status', state: 'queued',
        msg: `Đang xếp hàng (${pos}) — chờ khe trong ${devslot.getMax()} máy chạy đồng thời`,
      });
    });
    // `false` = người dùng đã bấm Dừng trong lúc máy còn đang xếp hàng.
    if (!khe) return { ok: false, msg: 'Đã huỷ khi đang xếp hàng.' };

    // Giãn cách: hai máy cùng được nhả khe một lúc mà spawn cùng lúc thì vẫn dồn cục.
    const cho = devslot.staggerDelay();
    if (cho > 0) await new Promise((r) => setTimeout(r, cho));

    runner.startDevice(
      params,
      (deviceId, data) => {
        sendToRenderer('crawl-data', { deviceId, ...data });
        if (sheets.isEnabled()) {
          const dev = devices.loadDevices().find((d) => d.id === deviceId);
          const deviceName = dev ? dev.name : deviceId;
          // Cột: A=Tên sound, B=Link, C=Số post, D=Thiết bị, E=Tình trạng(=1)
          sheets.enqueue([data.name || '', data.url || '', data.posts ?? '', deviceName, 1]);
        }
      },
      (deviceId, status) => {
        sendToRenderer('crawl-status', { deviceId, ...status });
        // Python báo hết ca TRƯỚC khi thoát. Ghi nhớ để lúc tiến trình đóng thì biết đây là
        // "hết ca" chứ không phải người dùng bấm Dừng hay máy lỗi.
        if (status.kind === 'status' && status.state === 'cycle_done') _cycleDone.add(deviceId);

        if (status.kind === 'status' && ['stopped', 'done', 'error'].includes(status.state)) {
          // NHẢ KHE ở đây, và ở đây thôi. Phải nhả cả khi kết thúc bằng LỖI — quên một lần là
          // hàng đợi kẹt vĩnh viễn và triệu chứng sẽ là "tự nhiên không máy nào chạy nữa".
          devslot.release(deviceId);
          sheets.flush();
          onDevicesAllStopped();

          // ── Hết ca thì nghỉ rồi tự chạy lại ──
          if (_cycleDone.delete(deviceId) && status.state !== 'error') {
            const p = _lastParams.get(deviceId) || {};
            const c = p.cfg || {};
            const lo = Math.max(0, Number(c.cycleBreakMin) || 0);
            const hi = Math.max(lo, Number(c.cycleBreakMax) || lo);
            // Ngẫu nhiên trong khoảng: 19 máy nghỉ đúng bằng nhau rồi cùng xin khe một lúc là
            // lại dồn cục đúng thứ trần song song sinh ra để tránh.
            const phut = lo + Math.random() * (hi - lo);
            const ms = Math.round(phut * 60000);
            sendToRenderer('crawl-status', {
              deviceId, kind: 'status', state: 'resting',
              msg: `Hết ca — nghỉ ${phut.toFixed(1)} phút rồi tự chạy lại (đã nhả khe cho máy đang chờ)`,
            });
            const t = setTimeout(() => {
              _restTimers.delete(deviceId);
              // Người dùng có thể đã xoá máy hoặc bấm Dừng trong lúc nghỉ.
              if (!_lastParams.has(deviceId)) return;
              chayMot(_lastParams.get(deviceId)).catch(() => {});
            }, ms);
            _restTimers.set(deviceId, t);
          }
        }
      }
    );
    return { ok: true };
  } catch (e) {
    // Spawn hỏng (thiếu Python, thiếu adb...) thì khe vừa xin phải trả lại ngay.
    devslot.release(params && params.deviceId);
    return { ok: false, msg: String(e.message || e) };
  }
}

ipcMain.handle('device-start', async (_e, params) => {
  // Bấm Chạy tay thì huỷ mọi hẹn giờ nghỉ đang treo của máy đó, tránh chạy chồng hai lượt.
  huyNghi(params && params.deviceId);
  _lastParams.set(params.deviceId, params);
  return chayMot(params);
});

ipcMain.handle('device-stop', async (_e, deviceId) => {
  // Huỷ hẹn giờ nghỉ TRƯỚC: máy có thể đang trong giờ nghỉ giữa hai ca, lúc đó không có tiến
  // trình nào để giết nhưng vẫn phải chặn lượt chạy lại đã hẹn.
  huyNghi(deviceId);
  _lastParams.delete(deviceId);

  // Máy có thể đang XẾP HÀNG chứ chưa chạy — lúc đó không có tiến trình nào để giết, chỉ cần
  // rút khỏi hàng. Không rút thì lát nữa tới lượt nó, app sẽ spawn cho một máy người dùng đã
  // bảo dừng.
  if (devslot.cancel(deviceId)) {
    sendToRenderer('crawl-status', { deviceId, kind: 'status', state: 'stopped', msg: 'Đã huỷ khi đang xếp hàng.' });
    return { ok: true };
  }
  devslot.release(deviceId);
  const r = runner.stopDevice(deviceId);
  await sheets.flushAll().catch(() => {});
  onDevicesAllStopped();
  return r;
});
ipcMain.handle('devices-stop-all', async () => {
  Array.from(_restTimers.keys()).forEach(huyNghi);
  _lastParams.clear();
  runner.stopAll();
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
    await seedKnownLinks(applied);
    startReseedTimer(applied);
    _seededThisSession = true;
  } else if (!sheets.isEnabled() && _reseedTimer) {
    clearInterval(_reseedTimer); _reseedTimer = null;
  }
  return { ok: true };
});
ipcMain.handle('sheets-test', (_e, cfg) => sheets.testConnection(cfg.spreadsheetId, cfg.sa));
ipcMain.handle('sheets-push-manual', async (_e, rows) => {
  const cfg = store.get('sheets_config') || {};
  if (!cfg.spreadsheetId || !cfg.sa) return { ok: false, msg: 'Chưa cấu hình Google Sheet (ID/Service Account).' };
  await sheets.flushAll().catch(() => {});
  const r = await sheets.pushDedup({ spreadsheetId: cfg.spreadsheetId, tab: cfg.tab, sa: cfg.sa }, rows);
  if (r.ok) sheets.dropFromBuffer((rows || []).map((x) => x && x[1]));
  return r;
});

// ---- Cài đặt toàn app (trần song song + giãn cách khởi động) ----
// Áp NGAY vào devslot chứ không chỉ lưu vào store: một ô cài đặt hiện ra mà không đổi hành vi
// còn tệ hơn không có ô nào (bài học QĐ-38 của bản PC).
ipcMain.handle('set-global-settings', (_e, cfg) => {
  const c = cfg || {};
  const max = devslot.setMax(c.deviceConcurrency);
  const stagger = devslot.setStaggerMs(c.launchStaggerMs);
  return { ok: true, deviceConcurrency: max, launchStaggerMs: stagger };
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
