// tests/bridge.test.cjs — cho Python THẬT nói chuyện với bộ não Node THẬT.
//
// VÌ SAO PHẢI CÓ (2026-09-15):
// Các phép thử khác kiểm từng nửa riêng: `askproto.test.cjs` kiểm phán quyết, và phần Python
// được soi bằng văn bản trong `wiring.test.cjs`. Nhưng thứ hay hỏng nhất lại nằm ĐÚNG GIỮA hai
// nửa — hình dạng JSON, tên trường, số phiên bản, ký tự xuống dòng, bảng mã. Hai nửa đều xanh
// mà ghép vào không chạy là chuyện thường.
//
// Phép thử này chạy `askbridge.py` thật trong một tiến trình con, và trả lời bằng
// `askproto.makeBrain()` thật — đúng đường ống mà `runner.cjs` dùng lúc chạy thật.
//
// Không cần máy Android: chỉ kiểm phần ĐƯỜNG ỐNG, không kiểm phần bấm nút.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function done() {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
  process.exit(failed.length ? 1 : 0);
}

const R = path.join(__dirname, '..');
const askproto = require(path.join(R, 'src', 'askproto.cjs'));

// Máy nào không có Python thì BỎ QUA, đừng báo đỏ oan — đỏ oan dạy người ta bỏ qua màu đỏ.
const { findPython } = require(path.join(R, 'src', 'pythonpath.cjs'));
const py = findPython({ fresh: true });
if (!py) {
  check('0. Có Python để chạy phép thử ghép nối', true, 'KHÔNG có Python — bỏ qua toàn bộ file này');
  done();
}
check('0. Có Python để chạy phép thử ghép nối', true, `${py.version.text} (${py.from})`);

// Kịch bản Python: dùng ĐÚNG askbridge.py thật, hỏi 3 câu rồi in kết quả.
const KICH_BAN = [
  'import sys, os, json',
  'sys.path.insert(0, os.environ["APP_DIR"])',
  'from askbridge import AskBridge',
  'b = AskBridge(enabled=True)',
  '',
  '# 1. video dính bộ lọc ngôn ngữ',
  'a1 = b.ask(author="Afghan Daily @afghan.daily", handle="@afghan.daily", desc="kabul hôm nay", badges=[])',
  'r1 = b.take(a1)',
  'print("R1" + json.dumps(r1), flush=True)',
  '',
  '# 2. video gắn nhãn AI',
  'a2 = b.ask(author="Cat Lover @cat_lover", handle="@cat_lover", desc="so cute puppy cake", badges=["Contains AI-generated media"])',
  'r2 = b.take(a2)',
  'print("R2" + json.dumps(r2), flush=True)',
  '',
  '# 3. video sạch — phải được cấp quyền follow',
  'a3 = b.ask(author="Nguoi Binh Thuong @binh_thuong", handle="@binh_thuong", desc="mot caption hoan toan binh thuong", badges=[])',
  'r3 = b.take(a3)',
  'print("R3" + json.dumps(r3), flush=True)',
  '',
  '# 3b. NHIP HAI (giao thuc v2): da ghe trang ca nhan, doc duoc @handle that -> xin phep',
  '#     Day moi la noi cap phep follow. Nhip 1 o tren chi noi "con ngan sach, dang de ghe".',
  'a3b = b.ask(kind="follow_confirm", handle="@binh_thuong", author="Nguoi Binh Thuong")',
  'r3b = b.take(a3b)',
  'print("R3B" + json.dumps(r3b), flush=True)',
  '# Gui kem @handle that: khong co no thi Node KHONG ghi so duoc, va tran ngay dem hut.',
  'b.acted(a3b, follow="ok", handle="@binh_thuong")',
  '',
  '# 4. video LIVE -> phai bi bo qua sach, khong cap quyen gi',
  'a4 = b.ask(author="Ai Do", handle="", desc="dang live ban oi", badges=[], live=True)',
  'r4 = b.take(a4)',
  'print("R4" + json.dumps(r4), flush=True)',
  'print("XONG", flush=True)',
].join('\n');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
const KB = path.join(TMP, 'kich_ban.py');
fs.writeFileSync(KB, KICH_BAN, 'utf8');

const brain = askproto.makeBrain({
  deviceId: 'may-thu', dir: TMP,
  cfg: {
    niEnabled: true, niAi: true,
    followOn: true, followPerDay: 30,
    likeOn: false, visitOn: false,
  },
  say: () => {},
});

const proc = spawn(py.cmd, [...py.args, KB], {
  env: Object.assign({}, process.env, { APP_DIR: R, PYTHONIOENCODING: 'utf-8', ASK_TIMEOUT: '10' }),
  windowsHide: true,
});

const ra = [];
let soAsk = 0;
let buf = '';
proc.stdout.on('data', (b) => {
  buf += b.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, '');
    buf = buf.slice(i + 1);
    if (!line) continue;
    if (line.startsWith('@@ASK@@')) {
      soAsk++;
      let ask = null;
      try { ask = JSON.parse(line.slice('@@ASK@@'.length)); } catch (_) {}
      const ans = ask ? brain.answer(ask) : askproto.safeAnswer(0);
      // Đúng cách runner.cjs ghi. Tiền tố `@@ANS@@` KHÔNG ĐƯỢC thiếu — chính phép thử này đã
      // bắt được lúc runner quên nó, và hậu quả là toàn bộ tính năng lọc/tương tác tắt trong im lặng.
      proc.stdin.write('@@ANS@@' + JSON.stringify(ans) + String.fromCharCode(10));
    } else if (line.startsWith('@@EVENT@@')) {
      try { brain.noteActed(JSON.parse(line.slice('@@EVENT@@'.length))); } catch (_) {}
    } else {
      ra.push(line);
    }
  }
});

let loiPy = '';
proc.stderr.on('data', (b) => { loiPy += b.toString('utf8'); });

const hetGio = setTimeout(() => { try { proc.kill(); } catch (_) {} }, 30000);

proc.on('close', () => {
  clearTimeout(hetGio);

  // 5 câu: 3 video thường + 1 nhịp xác nhận follow + 1 video LIVE (giao thức v2).
  check('1. Python gửi được câu hỏi qua đường ống', soAsk === 5, `${soAsk} câu hỏi`);
  check('1b. Python chạy tới cuối', ra.includes('XONG'),
    ra.join(' | ').slice(0, 120) + (loiPy ? ` | stderr: ${loiPy.slice(0, 150)}` : ''));

  const lay = (tag) => {
    const d = ra.find((l) => l.startsWith(tag));
    if (!d) return null;
    try { return JSON.parse(d.slice(tag.length)); } catch (_) { return null; }
  };
  const r1 = lay('R1');
  const r2 = lay('R2');
  const r3 = lay('R3');
  const r3b = lay('R3B');
  const r4 = lay('R4');

  check('2. Python nhận được đủ 5 câu trả lời',
    !!r1 && !!r2 && !!r3 && !!r3b && !!r4);

  if (r1) {
    check('3. Video dính ngôn ngữ: Python nhận ni=1, why="lang"',
      r1.ni === 1 && r1.why === 'lang', JSON.stringify(r1));
    check('3b. Và KHÔNG được cấp quyền follow chủ nó', r1.follow === 0, JSON.stringify(r1));
  }
  if (r2) {
    check('4. Video nhãn AI: Python nhận ni=1, why="ai"',
      r2.ni === 1 && r2.why === 'ai', JSON.stringify(r2));
    check('4b. Nhãn AI đi qua đường ống nguyên vẹn (không hỏng bảng mã)', r2.ni === 1);
  }
  if (r3) {
    check('5. Video sạch: không bấm gì, nhưng ĐƯỢC cấp quyền follow',
      r3.ni === 0 && r3.follow === 1, JSON.stringify(r3));
  }

  // Tiếng Việt có dấu trong caption phải đi qua được: dòng ASK in ra thuần ASCII
  // (`ensure_ascii`), nên phía Node phải giải mã lại đúng.
  check('6. Caption tiếng Việt có dấu đi qua đường ống không hỏng',
    brain._dem.lang >= 1, `đếm lang=${brain._dem.lang}`);

  // ── NHỊP HAI: nơi DUY NHẤT cấp phép follow (v2, 2026-09-16) ──
  // @handle không có trên feed, nên nhịp 1 chỉ kiểm ngân sách; chống trùng kênh nằm ở đây.
  if (r3b) {
    check('6b. Ghé trang xong, có @handle thật -> ĐƯỢC cấp phép follow',
      r3b.follow === 1, JSON.stringify(r3b));
  }
  // Livestream: bỏ qua sạch, không cấp quyền nào. Màn LIVE khác cấu trúc nên mọi cú bấm
  // lên nó đều là bấm mù.
  if (r4) {
    check('6c. Video LIVE -> không bấm gì cả',
      r4.ni === 0 && r4.follow === 0 && r4.like === 0 && r4.visit === 0 && r4.why === 'live',
      JSON.stringify(r4));
  }

  // Sổ chỉ được ghi khi Python báo 'ok' — chặng cuối của vòng khép kín.
  const cs = require(path.join(R, 'src', 'channelstore.cjs'));
  check('7. Python báo follow="ok" thì Node ghi sổ', cs.isFollowed(TMP, '@binh_thuong') === true);
  check('7b. Kênh bị lọc KHÔNG bị ghi vào sổ đã follow',
    cs.isFollowed(TMP, '@afghan.daily') === false);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  done();
});
