// tests/srcsync.test.cjs — bảy module dùng chung với bản PC phải GIỐNG HỆT, từng byte.
//
// VÌ SAO PHẢI CÓ (2026-09-15):
// Hai app nằm hai thư mục, đóng gói portable nên không chia sẻ `node_modules` được. Cách duy
// nhất là CHÉP file. Mà chép file thì sớm muộn hai bản lệch nhau.
//
// ⚠ CHUYỆN NÀY ĐÃ XẢY RA RỒI, KHÔNG PHẢI LO XA:
// `src/linkkey.cjs` có ở cả hai app và đã lệch — bản PC 162 dòng có `isOriginalSound()` với
// nhãn "original sound" của nhiều thứ tiếng, bản phone chỉ còn 24 dòng. Hậu quả cụ thể: phần
// Python lọc Original Sound bằng `REJECT_KEYWORDS = ["contains:", "bao gồm"]` — CHỈ tiếng Anh
// và tiếng Việt. Máy nào để TikTok tiếng Pháp/Indo thì ô "Chỉ lấy Original Sound" hỏng câm:
// không báo gì, chỉ là lọc sai suốt.
//
// Không ai phát hiện ra cho tới khi đọc chéo hai thư mục. Nên phải có một phép thử đỏ ngay.
//
// KHI PHÉP THỬ NÀY ĐỎ, đừng sửa file bên phone cho khớp rồi thôi — hỏi xem bản PC đổi vì lý do
// gì, rồi chép lại nguyên bản. Bản PC là nguồn sự thật: nó chạy thật trên nhiều máy ảo và có
// 587 phép thử bảo vệ.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// Bản PC nằm cạnh bản phone trong cùng cây thư mục làm việc. Khi phát hành lẻ (người khác
// clone mỗi repo phone) thì không có nó — lúc đó BỎ QUA chứ không báo đỏ, vì đỏ ở đây là đỏ
// oan và sẽ dạy người ta bỏ qua màu đỏ.
const PC = path.join(__dirname, '..', '..', '..', 'Crawl_DataTiktok_build', 'src');
const ME = path.join(__dirname, '..', 'src');

const DUNG_CHUNG = [
  'langfilter.cjs',    // lọc caption theo nhóm ký tự + từ khoá
  'uilabels.cjs',      // nhãn nút Follow / Following / Not interested / AI
  'followpolicy.cjs',  // chuẩn hoá @handle — khoá định danh kênh
  'channelstore.cjs',  // sổ kênh chất lượng (append-only)
  'textset.cjs',       // đọc/ghi file dòng, channelstore cần
  'phaseplan.cjs',     // chia pha theo thời gian
  'linkkey.cjs',       // chuẩn hoá link sound + nhận Original Sound đa ngôn ngữ
];

function bam(p) {
  // So theo NỘI DUNG ĐÃ CHUẨN HOÁ XUỐNG DÒNG. Git trên Windows tự đổi LF thành CRLF khi
  // checkout (đã thấy cảnh báo "LF will be replaced by CRLF" lúc commit), nên so byte thô sẽ
  // đỏ oan trên máy khác mà chẳng ai sửa được. Cái ta cần bắt là lệch NỘI DUNG.
  const s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(s).digest('hex');
}

const coPC = fs.existsSync(PC);
check('0. Tìm thấy thư mục mã nguồn bản PC để đối chiếu', true,
  coPC ? PC : 'KHÔNG có — bỏ qua phần so sánh (bình thường khi clone riêng repo phone)');

if (coPC) {
  const lech = [];
  const thieu = [];
  for (const f of DUNG_CHUNG) {
    const a = path.join(PC, f);
    const b = path.join(ME, f);
    if (!fs.existsSync(a)) { thieu.push(`${f} (thiếu bên PC)`); continue; }
    if (!fs.existsSync(b)) { thieu.push(`${f} (thiếu bên phone)`); continue; }
    const ha = bam(a);
    const hb = bam(b);
    if (ha !== hb) {
      const da = fs.readFileSync(a, 'utf8').split('\n').length;
      const db = fs.readFileSync(b, 'utf8').split('\n').length;
      lech.push(`${f}: PC ${da} dòng / phone ${db} dòng`);
    }
  }
  check('1. Không file dùng chung nào bị thiếu', thieu.length === 0, thieu.join(', '));
  check('2. Mọi file dùng chung KHỚP NỘI DUNG với bản PC', lech.length === 0,
    lech.join(' | ') + (lech.length ? '  ← chép lại từ bản PC, đừng sửa tay bên phone' : ''));
}

// ── 3. Các module này phải THUẦN LOGIC, không kéo theo trình duyệt ──
// Lý do bê được sang app phone chính là vì chúng không phụ thuộc Playwright/Electron. Ai lỡ
// thêm một `require('playwright')` vào là app phone sập ngay lúc khởi động, mà lỗi sẽ hiện ra
// ở tận nơi khác.
{
  const CAM = /require\(['"](playwright|electron|playwright-core)['"]\)/;
  const dinh = [];
  for (const f of DUNG_CHUNG) {
    const p = path.join(ME, f);
    if (!fs.existsSync(p)) continue;
    if (CAM.test(fs.readFileSync(p, 'utf8'))) dinh.push(f);
  }
  check('3. Không module dùng chung nào phụ thuộc trình duyệt/Electron', dinh.length === 0,
    dinh.join(', '));
}

// ── 4. Mỗi module nạp được và xuất đúng những hàm nơi khác đang gọi ──
// Chép thiếu một file phụ thuộc (ví dụ quên textset.cjs) thì `require` ném lỗi lúc CHẠY, giữa
// chừng, chứ không phải lúc build.
{
  const CAN = {
    'langfilter.cjs': ['makeMatcher', 'parseKeywords', 'normalizeScripts', 'SCRIPT_GROUPS', 'DEFAULT_SCRIPTS', 'DEFAULT_KEYWORDS'],
    'uilabels.cjs': ['isAiLabel', 'isMaybeAiLabel', 'isFollowLabel', 'isFollowingLabel', 'NOT_INTERESTED_LABELS', 'normLabel'],
    'followpolicy.cjs': ['normalizeHandle'],
    'channelstore.cjs': ['recordHit', 'recordFollow', 'isFollowed', 'load', 'compactIfNeeded'],
    'textset.cjs': ['appendLines', 'readLines', 'rewriteAll'],
    'phaseplan.cjs': ['buildPhasePlan', 'isPhasedMode'],
    'linkkey.cjs': ['canonicalSoundUrl', 'normalizeKey', 'isOriginalSound'],
  };
  const loi = [];
  for (const [f, ten] of Object.entries(CAN)) {
    let m;
    try { m = require(path.join(ME, f)); } catch (e) { loi.push(`${f}: ${String(e.message).slice(0, 60)}`); continue; }
    const thieu = ten.filter((k) => typeof m[k] === 'undefined');
    if (thieu.length) loi.push(`${f}: thiếu ${thieu.join(', ')}`);
  }
  check('4. Mọi module nạp được và xuất đủ hàm đang dùng', loi.length === 0, loi.join(' | '));
}

// ── 5. linkkey phải là bản ĐẦY ĐỦ, không phải bản rút gọn ──
// Chốt riêng cho đúng file đã từng lệch. `isOriginalSound` là thứ bản rút gọn không có, và là
// thứ thay cho `REJECT_KEYWORDS` chỉ-Anh-Việt trong Python.
{
  const lk = require(path.join(ME, 'linkkey.cjs'));
  check('5. linkkey có isOriginalSound (bản rút gọn KHÔNG có)', typeof lk.isOriginalSound === 'function');
  check('5b. Nhận "Original Sound" tiếng Anh', lk.isOriginalSound('', 'original sound - abc') === true);
  check('5c. Nhận nhãn tiếng Việt', lk.isOriginalSound('', 'nhạc nền - abc') === true);
  check('5d. Danh sách nhãn phủ nhiều thứ tiếng', (lk.ORIGINAL_SOUND_LABELS || []).length >= 8,
    `${(lk.ORIGINAL_SOUND_LABELS || []).length} nhãn`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
process.exit(failed.length ? 1 : 0);
