// tests/runnerresult.test.cjs — `runner.cjs` THẬT nhận kết quả từ Python và quyết cái gì đi tiếp.
//
// VÌ SAO (2026-09-18): đây là cổng cuối cùng trước bảng kết quả và Sheet — luật Original Sound
// của bản PC, cổng ngôn ngữ khi thu, và từ v0.1.9 là nhánh PENDING (sound không đọc được số
// video → cất vào tab Pending). Trước đây chỉ `wiring.test.cjs` soi bằng văn bản, nên xoá một
// điều kiện mà văn bản còn khớp là lọt.
//
// Ở đây chạy `startDevice` thật, chỉ thay `spawn` bằng một tiến trình giả: phép thử viết từng
// dòng `@@EVENT@@` y như Python in ra, rồi xem `onData` nhận gì. Không cần Python, không cần máy.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const R = path.join(__dirname, '..');
// Thư mục riêng từng máy (sổ kênh, bộ đếm) ghi vào thư mục tạm, không vào config thật.
process.env.PORTABLE_EXECUTABLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'runnerresult-'));

// ── Tiến trình giả: ghi lại lệnh và môi trường, để phép thử tự viết stdout ──
const cp = require('child_process');
let lanSpawn = null;
cp.spawn = (cmd, args, opts) => {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.pid = 0;
  proc.kill = () => {};
  lanSpawn = { cmd, args, env: opts.env, proc };
  return proc;
};
// Python và adb giả — `startDevice` kiểm hai thứ này trước khi spawn.
function gia(file, exp) {
  const p = require.resolve(path.join(R, 'src', file));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
}
gia('pythonpath.cjs', { findPython: () => ({ cmd: 'python', args: [], hasU2: true, version: { text: '3.12' } }) });
gia('adbpath.cjs', { adbPath: () => 'adb.exe', adbServerPort: () => '5037' });

const runner = require(path.join(R, 'src', 'runner.cjs'));

const M = 'https://www.tiktok.com/music/';
const ID = '-7633696888679598855';

function chay(params) {
  const nhan = [];
  const log = [];
  runner.startDevice(Object.assign({ deviceId: 'dT', serial: 'SERIAL-T', minPosts: 1000, maxPosts: 100000, hw: 'HW-TEST' }, params),
    (_id, data) => nhan.push(data),
    (_id, st) => { if (st.kind === 'log') log.push(st.line); });
  const { proc, env } = lanSpawn;
  const viet = (obj) => proc.stdout.write('@@EVENT@@' + JSON.stringify(obj) + '\n');
  const xong = () => new Promise((ok) => {
    proc.stdout.end(); proc.stderr.end();
    setImmediate(() => { proc.emit('close', 0); setImmediate(ok); });
  });
  return { nhan, log, env, viet, xong };
}

(async () => {
  // ── 1. Pending BẬT: env, và bốn loại kết quả ──
  {
    const r = chay({ pendingOn: true, cfg: { niBlockCollect: true, niScripts: ['arabic'] } });
    check('1. Bật Pending → Python nhận PENDING_ON=1', r.env.PENDING_ON === '1', r.env.PENDING_ON);
    // Máy đổi IP (2026-09-19): Python phải biết số máy phần cứng của điện thoại lượt này PHẢI lái.
    check('1z. Số máy phần cứng xuống tới Python (DEVICE_HW) — để không lái nhầm máy khi IP đổi chủ',
      r.env.DEVICE_HW === 'HW-TEST', r.env.DEVICE_HW);

    r.viet({ type: 'result', verdict: 'DAT', name: 'thật huy', title: 'Original Sound thật huy',
      url: M + 'original-sound-that-huy' + ID, posts: 13900 });
    r.viet({ type: 'result', verdict: 'PENDING', name: 'Lajico', title: 'Original Sound T Lajico',
      url: M + '%C3%A2m-thanh-g%E1%BB%91c-Lajico' + ID });
    r.viet({ type: 'result', verdict: 'PENDING', name: 'Passport Sky', title: 'Passport Sky T Tommy Alvarez',
      url: M + 'Passport-Sky' + ID });
    r.viet({ type: 'result', verdict: 'PENDING', name: 'Amal', title: 'الصوت الأصلي - Amal',
      url: M + 'original-sound-Amal' + ID });
    r.viet({ type: 'result', verdict: 'LOAI', name: 'ít video', posts: 12 });
    await r.xong();

    const dat = r.nhan.find((x) => x.name === 'thật huy');
    check('1a. DAT đi tiếp kèm số video, KHÔNG gắn cờ pending',
      !!dat && dat.posts === 13900 && !dat.pending, JSON.stringify(dat));
    const p = r.nhan.find((x) => x.name === 'Lajico');
    check('1b. PENDING Original Sound → đi tiếp, gắn cờ pending, số video để trống',
      !!p && p.pending === true && p.posts === null, JSON.stringify(p));
    check('1c. Link PENDING được rút gọn bằng luật bản PC (âm-thanh-gốc → original-sound-<id>)',
      !!p && p.url === M + 'original-sound' + ID, p && p.url);
    check('1d. PENDING là nhạc bản quyền → CHẶN, dù không đọc được số video (Pending không phải cửa sau)',
      !r.nhan.some((x) => x.name === 'Passport Sky')
      && r.log.some((l) => /Passport Sky.*không phải Original Sound/.test(l)), r.log.join(' | '));
    check('1e. PENDING dính bộ lọc ngôn ngữ khi thu → CHẶN, và có tên trong dòng Tổng kết',
      !r.nhan.some((x) => x.name === 'Amal') && r.log.some((l) => /Amal \[arabic\]/.test(l)));
    check('1f. LOAI không đi tiếp', !r.nhan.some((x) => x.name === 'ít video'));
    check('1g. Chỉ đúng hai kết quả đi tiếp', r.nhan.length === 2, r.nhan.map((x) => x.name).join(', '));
  }

  // ── 2. Pending TẮT (chưa đặt tên tab): Python không cất ──
  {
    const r = chay({ deviceId: 'dT2', serial: 'SERIAL-T2' });
    check('2. Không bật Pending → Python nhận PENDING_ON=0', r.env.PENDING_ON === '0', r.env.PENDING_ON);
    await r.xong();
  }

  // ── 3. Python báo "máy đơ" ngay trước khi thoát → tới main.js nguyên vẹn (2026-09-22) ──
  // main.js dựa vào đây để tự khởi động lại điện thoại (mainflow mục S).
  {
    const st = [];
    runner.startDevice({ deviceId: 'dT3', serial: 'SERIAL-T3', minPosts: 1000, maxPosts: 100000, hw: 'HW-T3' },
      () => {}, (_id, s) => st.push(s));
    const { proc } = lanSpawn;
    const viet = (obj) => proc.stdout.write('@@EVENT@@' + JSON.stringify(obj) + '\n');
    viet({ type: 'may_do', chac: true, ly_do: 'Android trên máy treo — lõi Android đã chết' });
    viet({ type: 'may_do', chac: false, ly_do: 'phục hồi hỏng 3 lần liền' });
    await new Promise((ok) => {
      proc.stdout.end(); proc.stderr.end();
      setImmediate(() => { proc.emit('close', 1); setImmediate(ok); });
    });
    const md = st.filter((s) => s.kind === 'may_do');
    check('3. Sự kiện "máy đơ" của Python tới main.js nguyên vẹn (CHẮC / NGHI + lý do)',
      md.length === 2 && md[0].chac === true && md[0].lyDo === 'Android trên máy treo — lõi Android đã chết'
      && md[1].chac === false && md[1].lyDo === 'phục hồi hỏng 3 lần liền', JSON.stringify(md));
    check('3b. Rồi tiến trình thoát mã 1 → vẫn báo lỗi như cũ (để main.js hẹn chạy lại)',
      st.some((s) => s.kind === 'status' && s.state === 'error' && /exit code 1/.test(s.msg || '')), JSON.stringify(st.slice(-2)));
  }

  const failed = results.filter((x) => !x.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
  try { fs.rmSync(process.env.PORTABLE_EXECUTABLE_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log('FAIL  lỗi không bắt được: ' + (e && e.stack || e));
  console.log('\n=== 0/1 PASS ===');
  process.exit(1);
});
