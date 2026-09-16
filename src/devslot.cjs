// src/devslot.cjs — Trần số máy chạy đồng thời. Máy thứ N+1 xếp hàng chờ.
//
// VÌ SAO PHẢI CÓ (2026-09-15):
// Chủ dự án có 19 máy Android. Mỗi máy đang chạy = **một tiến trình Python + một ADB server
// riêng** (cổng suy từ serial bằng crc32, xem scan_feed_sounds.py). Bật cả 19 cùng lúc là
// ~19 cặp tiến trình trên máy điều khiển, chưa kể phần mềm soi màn hình 效卫 cũng đang mở 19
// khung hình. Máy tính gánh không nổi và adb bắt đầu treo.
//
// ⚠ VÌ SAO KHÔNG BÊ `_enqueueLaunch` CỦA BẢN PC:
// Cổng bên `browser.cjs` là **tuần tự, mỗi lúc đúng MỘT lượt** — hợp với việc mở Chromium rồi
// nhả ngay sau vài giây. Ở đây một máy **giữ khe suốt cả ca chạy**, hàng giờ. Cái đúng để bê là
// cổng chia khe N chỗ của `crawler.cjs` (`_countWaiters`/`_countActive`/`_handOutCountSlots`).
//
// ⚠ VÀ MỘT LỖ HỔNG PHẢI BỊT: với "Giới hạn video = 0" thì máy chạy tới khi bị bấm Dừng, nên 6
// khe bị giữ vĩnh viễn và 13 máy còn lại chờ mãi. Bản PC không gặp vì khe của nó chỉ giữ vài
// giây. Lời giải là **chu kỳ**: hết ca thì máy tự nhả khe cho máy đang chờ (xem phaseplan.cjs).
// File này chỉ lo phần chia khe; ai nhả và khi nào là việc của nơi gọi.
//
// Bài học DUY NHẤT bê từ `browser.cjs`: **nhánh lỗi cũng phải nhả khe**. Một máy hỏng lúc khởi
// động mà không nhả là hàng đợi kẹt vĩnh viễn, và triệu chứng sẽ là "tự nhiên không máy nào
// chạy nữa" — rất khó lần ra.
'use strict';

const DEFAULT_MAX = 6;
const DEFAULT_STAGGER_MS = 3000;

let _max = DEFAULT_MAX;
let _staggerMs = DEFAULT_STAGGER_MS;
let _active = new Set();      // deviceId đang giữ khe
let _waiters = [];            // [{ deviceId, resolve, cancelled }] theo thứ tự tới trước
let _nextStartAt = 0;         // mốc sớm nhất được khởi động lượt kế (giãn cách)

function setMax(n) {
  const v = parseInt(n, 10);
  _max = Math.max(1, Math.min(50, Number.isFinite(v) ? v : DEFAULT_MAX));
  _handOut();
  return _max;
}
function setStaggerMs(ms) {
  const v = parseInt(ms, 10);
  _staggerMs = Math.max(0, Number.isFinite(v) ? v : DEFAULT_STAGGER_MS);
  return _staggerMs;
}
function getMax() { return _max; }
function getStaggerMs() { return _staggerMs; }
function activeCount() { return _active.size; }
function waitingCount() { return _waiters.length; }
function isActive(deviceId) { return _active.has(deviceId); }
function isWaiting(deviceId) { return _waiters.some((w) => w.deviceId === deviceId); }

// Vị trí trong hàng chờ, đếm từ 1. Trả 0 nếu không nằm trong hàng.
function queuePosition(deviceId) {
  const i = _waiters.findIndex((w) => w.deviceId === deviceId);
  return i < 0 ? 0 : i + 1;
}

function _handOut() {
  while (_active.size < _max && _waiters.length) {
    const w = _waiters.shift();
    if (w.cancelled) continue;            // đã bị huỷ lúc còn xếp hàng
    _active.add(w.deviceId);
    w.resolve(true);
  }
}

// Xin một khe. Trả Promise<boolean>:
//   true  = được chạy (đã giữ khe, nơi gọi PHẢI gọi release khi xong)
//   false = đã bị huỷ lúc còn xếp hàng (người dùng bấm Dừng khi đang chờ)
//
// `onWait(position)` được gọi NGAY khi phải xếp hàng, để giao diện báo "đang xếp hàng (3)"
// thay vì trông như treo. Không gọi khi được chạy ngay.
function acquire(deviceId, onWait) {
  if (_active.has(deviceId)) return Promise.resolve(true);   // đã giữ khe rồi
  if (_active.size < _max && !_waiters.length) {
    _active.add(deviceId);
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const w = { deviceId, resolve, cancelled: false };
    _waiters.push(w);
    if (typeof onWait === 'function') {
      try { onWait(_waiters.length); } catch (_) {}
    }
  });
}

// Nhả khe. PHẢI gọi cả khi lượt chạy KẾT THÚC BẰNG LỖI — nếu không hàng đợi kẹt vĩnh viễn.
function release(deviceId) {
  const co = _active.delete(deviceId);
  _handOut();
  return co;
}

// Rút khỏi hàng chờ (người dùng bấm Dừng khi máy còn đang xếp hàng). Lời hứa đang treo được
// giải bằng `false` để nơi gọi biết là bị huỷ chứ không phải được chạy.
function cancel(deviceId) {
  const i = _waiters.findIndex((w) => w.deviceId === deviceId);
  if (i < 0) return false;
  const w = _waiters[i];
  w.cancelled = true;
  _waiters.splice(i, 1);
  w.resolve(false);
  return true;
}

// Giãn cách giữa hai lần khởi động. Gọi SAU khi đã có khe, TRƯỚC khi spawn: hai máy cùng được
// nhả khe một lúc mà spawn cùng lúc thì vẫn dồn cục đúng thứ ta muốn tránh.
function staggerDelay(now = Date.now()) {
  if (_staggerMs <= 0) return 0;
  const at = Math.max(now, _nextStartAt);
  _nextStartAt = at + _staggerMs;
  return at - now;
}

function _resetForTest() {
  _max = DEFAULT_MAX;
  _staggerMs = DEFAULT_STAGGER_MS;
  _active = new Set();
  _waiters.forEach((w) => { w.cancelled = true; w.resolve(false); });
  _waiters = [];
  _nextStartAt = 0;
}

module.exports = {
  DEFAULT_MAX, DEFAULT_STAGGER_MS,
  setMax, getMax, setStaggerMs, getStaggerMs,
  acquire, release, cancel, staggerDelay,
  activeCount, waitingCount, isActive, isWaiting, queuePosition,
  _resetForTest,
};
