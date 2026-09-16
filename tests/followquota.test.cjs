// tests/followquota.test.cjs — khoá hạn mức follow.
//
// VÌ SAO PHẢI CÓ (2026-09-15): mỗi cú follow tác động lên một TÀI KHOẢN TIKTOK THẬT và không
// hoàn tác được bằng cách chạy lại chương trình. Vượt trần là rủi ro mất tài khoản thật.
//
// Điều quan trọng nhất phải khoá: **trần ngày đọc từ SỔ TRÊN ĐĨA, không phải bộ đếm trong RAM**.
// Giữ trong RAM thì tắt app mở lại là về 0 và follow quá tay — mà mở lại app vài lần một ngày
// là chuyện thường ngày.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const cs = require(path.join(__dirname, '..', 'src', 'channelstore.cjs'));
const fq = require(path.join(__dirname, '..', 'src', 'followquota.cjs'));

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fq-')); }
const dọn = [];
function newDir() { const d = tmp(); dọn.push(d); return d; }

// ── 1. Đường bình thường ──
{
  fq._resetForTest();
  const d = newDir();
  const r = fq.canFollow({ deviceId: 'm1', dir: d, handle: '@abc', opts: { perDay: 30 } });
  check('1. Kênh mới, chưa follow gì hôm nay -> cho phép', r.ok === true, r.reason);
  check('1b. Trả về handle đã chuẩn hoá', r.handle === '@abc', r.handle);
}

// ── 2. TRẦN NGÀY ĐỌC TỪ SỔ — hàng rào quan trọng nhất ──
{
  fq._resetForTest();
  const d = newDir();
  for (let i = 1; i <= 3; i++) cs.recordFollow(d, `@kenh${i}`);
  fq.invalidate(d);
  check('2. Đếm đúng số follow hôm nay từ sổ', fq.followedToday(d) === 3, `${fq.followedToday(d)}`);

  const r = fq.canFollow({ deviceId: 'm1', dir: d, handle: '@moi', opts: { perDay: 3 } });
  check('2b. Đạt trần thì từ chối', r.ok === false && /trần ngày/.test(r.reason), r.reason);

  const r2 = fq.canFollow({ deviceId: 'm1', dir: d, handle: '@moi', opts: { perDay: 5 } });
  check('2c. Nới trần thì lại cho phép', r2.ok === true, r2.reason);
}

// ── 3. TẮT APP MỞ LẠI KHÔNG RESET TRẦN ──
// Mô phỏng khởi động lại bằng cách xoá sạch trạng thái RAM rồi hỏi lại trên cùng thư mục.
{
  fq._resetForTest();
  const d = newDir();
  for (let i = 1; i <= 30; i++) cs.recordFollow(d, `@k${i}`);

  fq._resetForTest();          // ← "tắt app, mở lại": mọi thứ trong RAM mất sạch
  const r = fq.canFollow({ deviceId: 'm1', dir: d, handle: '@sau_khi_mo_lai', opts: { perDay: 30 } });
  check('3. Mở lại app KHÔNG reset trần ngày (đọc từ sổ trên đĩa)',
    r.ok === false && /trần ngày \(30\/30\)/.test(r.reason), r.reason);
}

// ── 4. KHÔNG FOLLOW TRÙNG, và khoá không phân biệt hoa thường ──
{
  fq._resetForTest();
  const d = newDir();
  cs.recordFollow(d, '@Hira_Faisal');
  fq.invalidate(d);
  const r = fq.canFollow({ deviceId: 'm1', dir: d, handle: '@hira_faisal', opts: { perDay: 30 } });
  check('4. @Hira và @hira là MỘT — không follow lại', r.ok === false && /đã follow/.test(r.reason), r.reason);

  const r2 = fq.canFollow({ deviceId: 'm1', dir: d, handle: 'https://www.tiktok.com/@HIRA_FAISAL/video/123', opts: { perDay: 30 } });
  check('4b. Nhận cả dạng URL đầy đủ', r2.ok === false && /đã follow/.test(r2.reason), r2.reason);
}

// ── 5. GIÃN CÁCH giữa hai cú follow ──
{
  fq._resetForTest();
  const d = newDir();
  const t0 = 1_000_000_000;
  const opts = { perDay: 30, gapMinSec: 120, gapMaxSec: 120 };
  check('5. Cú đầu được phép ngay', fq.canFollow({ deviceId: 'm1', dir: d, handle: '@a', opts, now: t0 }).ok === true);

  fq.noteFollowed('m1', d, opts, t0);
  const r1 = fq.canFollow({ deviceId: 'm1', dir: d, handle: '@b', opts, now: t0 + 60_000 });
  check('5b. 60s sau vẫn còn trong giãn cách', r1.ok === false && /giãn cách/.test(r1.reason), r1.reason);

  const r2 = fq.canFollow({ deviceId: 'm1', dir: d, handle: '@b', opts, now: t0 + 121_000 });
  check('5c. Quá giãn cách thì cho phép', r2.ok === true, r2.reason);

  // Giãn cách theo TỪNG MÁY, không dùng chung
  const r3 = fq.canFollow({ deviceId: 'm2', dir: d, handle: '@b', opts, now: t0 + 60_000 });
  check('5d. Giãn cách riêng từng máy, máy khác không bị vạ lây', r3.ok === true, r3.reason);
}

// ── 6. Trần 0 nghĩa là TẮT, KHÔNG phải "không giới hạn" ──
// Hướng hiểu sai ở đây cực đắt: gõ 0 mà thành follow vô hạn là bay tài khoản.
{
  fq._resetForTest();
  const d = newDir();
  const r = fq.canFollow({ deviceId: 'm1', dir: d, handle: '@a', opts: { perDay: 0 } });
  check('6. perDay = 0 -> KHÔNG follow (không phải vô hạn)', r.ok === false && /0/.test(r.reason), r.reason);
  const r2 = fq.canFollow({ deviceId: 'm1', dir: d, handle: '@a', opts: { perDay: -3 } });
  check('6b. perDay âm cũng là không follow', r2.ok === false, r2.reason);
}

// ── 7. Unfollow KHÔNG trả lại lượt ──
// Cú follow đã xảy ra thì TikTok đã thấy. Cho lượt lại là tự mở đường vượt trần bằng cách
// unfollow rồi follow tiếp.
{
  fq._resetForTest();
  const d = newDir();
  cs.recordFollow(d, '@a');
  cs.recordFollow(d, '@b');
  cs.recordUnfollow(d, '@a');
  fq.invalidate(d);
  check('7. Unfollow rồi vẫn tính vào hạn mức hôm nay', fq.followedToday(d) === 2, `${fq.followedToday(d)}`);
}

// ── 8. Đầu vào hỏng không được làm sập vòng quét ──
{
  fq._resetForTest();
  let nem = false;
  let rs = [];
  try {
    rs = [
      fq.canFollow({ deviceId: 'm1', dir: newDir(), handle: '', opts: {} }),
      fq.canFollow({ deviceId: 'm1', dir: newDir(), handle: null, opts: {} }),
      fq.canFollow({ deviceId: 'm1', dir: newDir(), handle: 'không hợp lệ!!', opts: {} }),
      fq.canFollow({ deviceId: 'm1', dir: path.join(os.tmpdir(), 'khong-he-ton-tai-' + Date.now()), handle: '@a', opts: {} }),
    ];
  } catch (_) { nem = true; }
  check('8. Handle rỗng/null/rác và thư mục không tồn tại đều không ném', nem === false);
  check('8b. Ba handle hỏng đầu đều bị từ chối', rs.slice(0, 3).every((r) => r.ok === false));
  check('8c. Thư mục chưa có sổ vẫn cho phép (sổ rỗng = chưa follow ai)', rs[3] && rs[3].ok === true, rs[3] && rs[3].reason);
}

// ── 9. Ngày dùng GIỜ ĐỊA PHƯƠNG, khớp channelstore ──
// Lệch sang UTC là trần ngày đổi lúc 7 giờ sáng thay vì nửa đêm.
{
  const d = new Date(2026, 8, 15, 23, 30);     // 15/09/2026 23:30 giờ máy
  check('9. today() theo giờ địa phương', fq.today(d) === '2026-09-15', fq.today(d));
}

dọn.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} });

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
process.exit(failed.length ? 1 : 0);
