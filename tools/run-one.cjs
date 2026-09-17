#!/usr/bin/env node
// tools/run-one.cjs — Chạy THỬ một máy từ dòng lệnh, in thẳng log ra màn hình.
//
// VÌ SAO CÓ FILE NÀY (2026-09-16):
// Trước khi thả cả farm chạy, chủ dự án cần soi log của MỘT máy. Nhưng log của app chỉ sống
// trong bộ nhớ renderer (`MAX_LOG_LINES = 500`, xem qua nút 📄) — không có file, không có cửa
// nào ngoài Electron.
//
// ⚠ VÌ SAO KHÔNG CHẠY THẲNG `python scan_feed_sounds.py <serial>`:
// Làm vậy là chạy THIẾU NỬA APP. Bộ não phán xét (`src/askproto.cjs`), danh sách nhãn nút
// (`src/uilabels.cjs`), cách dò adb/python — tất cả ở phía Node. Python trần thì kênh hỏi/đáp
// hết giờ 3 lần rồi TỰ TẮT lọc & tương tác trong im lặng (`runner.cjs:147-151` kể đúng ca đó):
// không lỗi, vẫn quét, nhìn ngoài không thấy gì sai. Thử kiểu ấy xanh cũng chẳng chứng minh
// được gì cho lúc chạy app thật.
//
// Nên file này dùng lại ĐÚNG `src/runner.cjs` mà app dùng, chỉ thay hai đầu dây `onData` /
// `onStatus` từ IPC sang `console.log`. Cùng đường ống, cùng bộ não, chỉ khác chỗ log chảy ra.
'use strict';

const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
const runner = require(path.join(R, 'src', 'runner.cjs'));
const preflight = require(path.join(R, 'src', 'preflight.cjs'));
const { getDevicesJsonPath } = require(path.join(R, 'src', 'paths.cjs'));

// ── Mặc định lấy từ ĐÚNG MỘT NGUỒN: renderer/renderer.js ──
//
// Chép tay một bản thứ hai vào đây là có ngày công cụ thử và app nói hai giá trị khác nhau,
// mà không ai biết — chạy thử xanh rồi vào app lại khác. Đây đúng là cách `linkkey.cjs` đã lệch.
// `tests/wiring.test.cjs:50` cũng đọc khối này bằng văn bản, nên cách làm không mới.
//
// Cắt hỏng thì NÉM LỖI. Tuyệt đối không âm thầm rơi về bản dự phòng: rơi êm nghĩa là chạy thử
// bằng một bộ số không phải bộ số của app, và đó là thứ tệ hơn cả không chạy thử.
function docMacDinh() {
  const p = path.join(R, 'renderer', 'renderer.js');
  const src = fs.readFileSync(p, 'utf8');
  const dau = src.indexOf('const DEFAULT_SETTINGS = {');
  if (dau < 0) {
    throw new Error(`Không tìm thấy DEFAULT_SETTINGS trong ${p} — renderer.js đã đổi, sửa lại tools/run-one.cjs.`);
  }
  const mo = src.indexOf('{', dau);
  let sau = 0;
  let het = -1;
  for (let i = mo; i < src.length; i++) {
    if (src[i] === '{') sau++;
    else if (src[i] === '}') {
      sau--;
      if (sau === 0) { het = i; break; }
    }
  }
  if (het < 0) throw new Error(`Khối DEFAULT_SETTINGS trong ${p} không đóng ngoặc — không đọc được.`);
  const chu = src.slice(mo, het + 1);
  try {
    return new Function('return ' + chu)();
  } catch (e) {
    throw new Error(`Đọc được khối DEFAULT_SETTINGS nhưng không dịch được: ${e.message}`);
  }
}

// ── Tham số dòng lệnh ──
function docThamSo(argv) {
  const t = { may: '', limit: null, ask: false, full: false, min: null, max: null, dwell: null, log: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const keTiep = () => argv[++i];
    if (a === '-h' || a === '--help') t.help = true;
    else if (a === '--limit') t.limit = parseInt(keTiep(), 10);
    else if (a === '--ask') t.ask = true;
    else if (a === '--full') t.full = true;
    else if (a === '--follow-test') { t.full = true; t.followTest = true; }
    else if (a === '--visit-test') { t.visitTest = true; }
    else if (a === '--min') t.min = parseInt(keTiep(), 10);
    else if (a === '--max') t.max = parseInt(keTiep(), 10);
    else if (a === '--dwell') t.dwell = keTiep();
    else if (a === '--log') t.log = keTiep();
    else if (a.startsWith('-')) throw new Error(`Không hiểu tham số: ${a}`);
    else if (!t.may) t.may = a;
    else throw new Error(`Thừa tham số: ${a}`);
  }
  return t;
}

const HUONG_DAN = `
Chạy thử MỘT máy từ dòng lệnh, in log ra màn hình (không mở app).

  node tools/run-one.cjs <serial | tên | deviceId> [tuỳ chọn]

  --limit N      dừng sau N video (mặc định: theo cài đặt, 0 = chạy tới khi Ctrl+C)
  --min N        số post tối thiểu để một sound được coi là ĐẠT
  --max N        số post tối đa
  --dwell a,b    khoảng nghỉ ngẫu nhiên giữa hai video, tính bằng giây (vd: 3,6)
  --ask          BẬT lọc ngôn ngữ + nhãn AI. Không bấm follow/tym, NHƯNG video dính bộ lọc
                 thì VẪN bị bấm "Not interested" — cú đó dạy feed VĨNH VIỄN, không hoàn tác.
  --visit-test   Lọc + tym + ghé trang, KHÔNG follow. Đây là luồng đang dùng thật:
                 sound hợp lệ -> tym (theo tỉ lệ) -> ghé trang -> mở 1 video ngẫu nhiên
                 -> xem -> tym -> về feed. Không đụng tới nút Follow.
  --follow-test  Như --full, NHƯNG bỏ điều kiện "sound hợp lệ" ở nhánh follow.
                 Chỉ để ĐO xem follow có bấm được không — follow sẽ xảy ra nhiều hơn hẳn
                 lúc chạy thật. ⚠ Vẫn là follow THẬT, vẫn ăn vào trần 30/ngày.
  --full         BẬT hết: follow + tym + ghé trang + Not interested.
                 ⚠ Tác động THẬT lên tài khoản TikTok của máy đó, không hoàn tác được.
  --log <file>   ghi log song song ra file (nối vào cuối, utf-8)

Không cờ nào = chỉ quét thuần, đúng mặc định của app, không đụng tới tài khoản.

Ví dụ:
  node tools/run-one.cjs 192.168.x.y:5555 --limit 20
`;

// ── Tra máy trong danh sách. Không có trong danh sách thì coi tham số là serial thô ──
// Danh sách máy của bản phát hành nằm ở thư mục bản phát hành, không phải ở đây — nên bắt buộc
// phải có trong `config/devices.json` mới chạy được là tự trói tay mình.
function traMay(khoa) {
  let ds = [];
  try {
    ds = JSON.parse(fs.readFileSync(getDevicesJsonPath(), 'utf8'));
  } catch (_) {
    ds = [];
  }
  const k = String(khoa).toLowerCase();
  const thay = ds.find((d) => d && (
    String(d.serial || '').toLowerCase() === k
    || String(d.id || '').toLowerCase() === k
    || String(d.name || '').toLowerCase() === k
  ));
  if (thay) return { deviceId: thay.id, serial: thay.serial, name: thay.name, trongDs: true };
  return {
    deviceId: 'cli_' + String(khoa).replace(/[^A-Za-z0-9]+/g, '_'),
    serial: khoa,
    name: '(không có trong config/devices.json)',
    trongDs: false,
  };
}

// ── In ấn ──
const T0 = Date.now();
let ghiFile = null;

function troi() {
  const s = Math.floor((Date.now() - T0) / 1000);
  return `[+${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}]`;
}

function in_(line) {
  const dong = `${troi()} ${line}`;
  console.log(dong);
  if (ghiFile) {
    try { fs.appendFileSync(ghiFile, dong + '\n', 'utf8'); } catch (_) {}
  }
}

async function main() {
  const t = docThamSo(process.argv.slice(2));
  if (t.help || !t.may) {
    console.log(HUONG_DAN);
    process.exit(t.help ? 0 : 1);
  }

  if (t.log) {
    ghiFile = path.resolve(t.log);
    fs.mkdirSync(path.dirname(ghiFile), { recursive: true });
  }

  const may = traMay(t.may);
  const cfg = docMacDinh();

  // Cờ bật tương tác. Mặc định TẮT HẾT — `ASK_ON` chỉ bật khi có ít nhất một ô bật
  // (`runner.cjs:99`), nên không cờ nào = Python không dump hierarchy, không bấm gì.
  if (t.ask || t.full) { cfg.niEnabled = true; cfg.niAi = true; }
  if (t.full) { cfg.followOn = true; cfg.likeOn = true; cfg.visitOn = true; }
  if (t.followTest) cfg.followAnySound = true;
  // Luồng đang dùng thật: KHÔNG follow (follow chưa xác minh được là trụ lại hay không).
  if (t.visitTest) { cfg.niEnabled = true; cfg.niAi = true; cfg.likeOn = true; cfg.visitOn = true; }
  if (t.min !== null) cfg.minPosts = t.min;
  if (t.max !== null) cfg.maxPosts = t.max;
  if (t.limit !== null) cfg.limit = t.limit;
  if (t.dwell) {
    const [a, b] = String(t.dwell).split(',').map((x) => parseFloat(x));
    if (!isFinite(a) || !isFinite(b)) throw new Error(`--dwell phải dạng "3,6", nhận được: ${t.dwell}`);
    cfg.delayMin = a;
    cfg.delayMax = b;
  }

  in_(`Máy   : ${may.name}  ${may.serial}`);
  in_(`deviceId: ${may.deviceId}${may.trongDs ? '' : '  (serial thô)'}`);
  in_(`Quét  : ${cfg.minPosts}–${cfg.maxPosts} posts, nghỉ ${cfg.delayMin}–${cfg.delayMax}s`
    + `, Original Only=${cfg.originalOnly ? 'bật' : 'tắt'}`
    + `, dừng sau ${cfg.limit ? cfg.limit + ' video' : 'Ctrl+C'}`);
  const batTuongTac = [
    cfg.niEnabled && 'lọc ngôn ngữ', cfg.niAi && 'nhãn AI',
    cfg.followOn && (cfg.followAnySound ? 'FOLLOW (bỏ điều kiện sound — chế độ đo)' : 'FOLLOW'),
    cfg.likeOn && 'TYM', cfg.visitOn && 'GHÉ TRANG',
  ].filter(Boolean);
  in_(`Tương tác: ${batTuongTac.length ? batTuongTac.join(' + ') : 'TẮT HẾT (chỉ quét thuần)'}`);
  in_('');

  // ── Kiểm TRƯỚC khi spawn ──
  // Mỗi mục một nguyên nhân, mỗi nguyên nhân một câu sửa. `preflight.cjs` mở đầu kể lại đợt
  // app gộp ba thứ hỏng khác hẳn nhau thành đúng một chữ "Lỗi" — ở đây không lặp lại chuyện đó.
  in_('── Kiểm tra trước khi chạy ──');
  const kt = await preflight.checkAll(may.serial);
  kt.items.forEach((x) => {
    in_(`${x.ok ? '✓' : '✗'} ${x.label.padEnd(18)} ${x.detail}`);
    if (!x.ok && x.fix) x.fix.split('\n').forEach((d) => in_(`    → ${d}`));
  });
  if (!kt.ok) {
    in_('');
    in_('DỪNG: sửa các mục ✗ ở trên rồi chạy lại. Chưa spawn Python.');
    process.exit(1);
  }
  in_('');
  in_('── Bắt đầu quét (Ctrl+C để dừng sạch) ──');

  const params = {
    deviceId: may.deviceId,
    serial: may.serial,
    minPosts: cfg.minPosts,
    maxPosts: cfg.maxPosts,
    // ⚠ ĐỔI TÊN trên đường đi, đúng như `renderer/renderer.js:249` làm: giao diện gọi là
    // `delayMin/delayMax`, `runner.cjs` nhận vào là `dwellMin/dwellMax`. Quên đổi thì runner
    // rơi về mặc định 3–6s mà không báo gì.
    dwellMin: cfg.delayMin,
    dwellMax: cfg.delayMax,
    originalOnly: cfg.originalOnly,
    limit: cfg.limit,
    cfg,
  };

  let dangDung = false;
  let soDat = 0;

  const xong = (ma) => {
    in_(`── Kết thúc. ĐẠT ${soDat} sound. ${ghiFile ? 'Log: ' + ghiFile : ''}`);
    process.exit(ma);
  };

  const onData = (_id, d) => {
    soDat++;
    in_(`★ DAT  ${d.posts} posts  ${d.name}  ${d.url}`);
  };

  const onStatus = (_id, st) => {
    if (st.kind === 'progress') {
      in_(`   #${st.checked}  đạt ${st.qualified}`);
    } else if (st.kind === 'status') {
      in_(`[${st.state}]${st.msg ? ' ' + st.msg : ''}`);
      if (st.state === 'stopped' || st.state === 'done') xong(0);
      else if (st.state === 'error') xong(1);
    } else {
      in_(st.line);
    }
  };

  try {
    runner.startDevice(params, onData, onStatus);
  } catch (e) {
    in_(`LỖI khởi động: ${e.message}`);
    process.exit(1);
  }

  // ── Ctrl+C phải dừng SẠCH ──
  // `stopDevice` giết cả CÂY tiến trình (`taskkill /t /f`) rồi mới `force-stop` TikTok và bấm
  // HOME. Bỏ qua bước này là để lại tiến trình Python MỒ CÔI vẫn đang vuốt máy thật, không ai
  // dọn — `runner.cjs:120-124` kể đúng ca đó.
  process.on('SIGINT', () => {
    if (dangDung) {
      in_('Ctrl+C lần hai — thoát ngay (có thể còn tiến trình Python sót lại).');
      process.exit(130);
    }
    dangDung = true;
    in_('');
    in_('Ctrl+C — đang dừng sạch: giết tiến trình, đóng TikTok, đưa máy về màn hình chính...');
    runner.stopDevice(may.deviceId);
    // Chốt chặn: nếu `close` không tới (tiến trình con treo cứng) thì vẫn phải thoát, đừng treo
    // cửa sổ dòng lệnh của người dùng mãi mãi.
    setTimeout(() => {
      in_('Quá 15s không thấy tiến trình con đóng — thoát.');
      process.exit(130);
    }, 15000).unref();
  });
}

main().catch((e) => {
  console.error(`LỖI: ${e.message}`);
  process.exit(1);
});
