// preload.cjs — contextBridge API lộ ra cho renderer (contextIsolation bật, nodeIntegration tắt).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getVersion: () => ipcRenderer.invoke('app-version'),

  devicesList: () => ipcRenderer.invoke('devices-list'),
  devicesAdd: (data) => ipcRenderer.invoke('devices-add', data),
  devicesUpdate: (data) => ipcRenderer.invoke('devices-update', data),
  devicesDelete: (data) => ipcRenderer.invoke('devices-delete', data),
  devicesListAdb: () => ipcRenderer.invoke('devices-list-adb'),
  deviceCheck: (serial) => ipcRenderer.invoke('device-check', serial),
  deviceIdentify: (serial) => ipcRenderer.invoke('device-identify', serial),

  deviceStart: (params) => ipcRenderer.invoke('device-start', params),
  deviceStop: (deviceId) => ipcRenderer.invoke('device-stop', deviceId),
  deviceUpdateParams: (params) => ipcRenderer.invoke('device-update-params', params),
  devicesStopAll: () => ipcRenderer.invoke('devices-stop-all'),
  crawlRunningIds: () => ipcRenderer.invoke('crawl-running-ids'),

  onCrawlData: (cb) => ipcRenderer.on('crawl-data', (_e, payload) => cb(payload)),
  onCrawlStatus: (cb) => ipcRenderer.on('crawl-status', (_e, payload) => cb(payload)),

  setGlobalSettings: (cfg) => ipcRenderer.invoke('set-global-settings', cfg),

  storeGet: (keys) => ipcRenderer.invoke('store-get', keys),
  storeSet: (data) => ipcRenderer.invoke('store-set', data),

  exportResults: (rows) => ipcRenderer.invoke('export-results', rows),

  sheetsGetConfig: () => ipcRenderer.invoke('sheets-get-config'),
  sheetsSetConfig: (cfg) => ipcRenderer.invoke('sheets-set-config', cfg),
  sheetsTest: (cfg) => ipcRenderer.invoke('sheets-test', cfg),
  sheetsPushManual: (rows) => ipcRenderer.invoke('sheets-push-manual', rows),

  // Kho link cục bộ (known_links.txt) — nguồn lọc trùng chính (clone bản PC)
  linksInfo: () => ipcRenderer.invoke('links-info'),
  linksReload: () => ipcRenderer.invoke('links-reload'),
  linksOpenFile: () => ipcRenderer.invoke('links-open-file'),
  linksImportFromSheet: () => ipcRenderer.invoke('links-import-from-sheet'),

  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
