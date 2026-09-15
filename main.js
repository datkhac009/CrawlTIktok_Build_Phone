// main.js — Electron main process: tạo cửa sổ, khai báo ipcMain handlers.
'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const devices = require('./src/devices.cjs');
const runner = require('./src/runner.cjs');
const sheets = require('./src/sheets.cjs');

const store = new Store({ name: 'settings' });

let mainWindow = null;
let _reseedTimer = null;
let _seededThisSession = false;

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
ipcMain.handle('device-start', async (_e, params) => {
  try {
    const cfg = applySheetsConfig();
    if (sheets.isEnabled() && !_seededThisSession) {
      _seededThisSession = true;
      await seedKnownLinks(cfg);
      startReseedTimer(cfg);
    }
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
        if (status.kind === 'status' && ['stopped', 'done', 'error'].includes(status.state)) {
          sheets.flush();
          onDevicesAllStopped();
        }
      }
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: String(e.message || e) };
  }
});

ipcMain.handle('device-stop', async (_e, deviceId) => {
  const r = runner.stopDevice(deviceId);
  await sheets.flushAll().catch(() => {});
  onDevicesAllStopped();
  return r;
});
ipcMain.handle('devices-stop-all', async () => {
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
