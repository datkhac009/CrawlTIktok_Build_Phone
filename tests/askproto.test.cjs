// tests/askproto.test.cjs — khoá bộ não phán xét và MẶC ĐỊNH AN TOÀN.
//
// VÌ SAO PHẢI CÓ (2026-09-15): mỗi câu trả lời của module này có thể dẫn tới một cú bấm
// **Not interested** (dạy feed vĩnh viễn, không hoàn tác) hoặc một cú **follow** lên tài khoản
// TikTok thật. Sai một lần là sai vào thứ không lấy lại được.
//
// Hợp đồng quan trọng nhất: **mọi đường hỏng đều phải cho ra "không bấm gì"**. Rút hẳn phía
// Node ra thì app vẫn quét bình thường như trước khi có tính năng này.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const ap = require(path.join(__dirname, '..', 'src', 'askproto.cjs'));
const cs = require(path.join(__dirname, '..', 'src', 'channelstore.cjs'));
const fq = require(path.join(__dirname, '..', 'src', 'followquota.cjs'));
const dc = require(path.join(__dirname, '..', 'src', 'daycount.cjs'));

const dọn = [];
function newDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-')); dọn.push(d); return d; }
const V = ap.PROTO_VERSION;

function hoi(extra = {}) {
  return { v: V, id: 1, author: 'Ai Do @ai_do', handle: '@ai_do', desc: 'hello world', badges: [], ...extra };
}

// ── 1. Mọi thứ TẮT thì không bấm gì — đây là mặc định xuất xưởng ──
{
  fq._resetForTest();
  const b = ap.makeBrain({ deviceId: 'm1', dir: newDir(), cfg: {} });
  const a = b.answer(hoi({ badges: ['Contains AI-generated media'], desc: 'afghan kabul' }));
  check('1. Mặc định (mọi ô tắt) KHÔNG bấm gì, dù video vừa dính AI vừa dính ngôn ngữ',
    a.ni === 0 && a.follow === 0 && a.like === 0 && a.visit === 0, JSON.stringify(a));
}

// ── 2. Lọc ngôn ngữ ──
{
  fq._resetForTest();
  const b = ap.makeBrain({ deviceId: 'm1', dir: newDir(), cfg: { niEnabled: true } });
  const a = b.answer(hoi({ desc: 'GIVE HER THE ICE CREAM #afghanistan' }));
  check('2. Caption dính từ khoá -> bấm Not interested, lý do "lang"', a.ni === 1 && a.why === 'lang', JSON.stringify(a));

  const a2 = b.answer(hoi({ id: 2, desc: 'chỉ là một caption bình thường' }));
  check('2b. Caption sạch -> không bấm', a2.ni === 0, JSON.stringify(a2));

  const a3 = b.answer(hoi({ id: 3, author: 'Afghan Daily @afghan.daily', desc: 'hello' }));
  check('2c. Bắt được cả ở TÊN TÁC GIẢ, không chỉ caption', a3.ni === 1, JSON.stringify(a3));
}

// ── 3. Nhãn AI — và ô riêng, KHÔNG ăn theo ô lọc ngôn ngữ ──
{
  fq._resetForTest();
  const d = newDir();
  const chiNgonNgu = ap.makeBrain({ deviceId: 'm1', dir: d, cfg: { niEnabled: true } });
  const a = chiNgonNgu.answer(hoi({ badges: ['Contains AI-generated media'] }));
  check('3. Bật lọc ngôn ngữ KHÔNG tự bật bấm-AI', a.ni === 0, JSON.stringify(a));

  const coAi = ap.makeBrain({ deviceId: 'm1', dir: d, cfg: { niAi: true } });
  const a2 = coAi.answer(hoi({ badges: ['Contains AI-generated media'] }));
  check('3b. Bật ô AI thì bấm, lý do "ai"', a2.ni === 1 && a2.why === 'ai', JSON.stringify(a2));

  const a3 = coAi.answer(hoi({ id: 9, badges: ['1.2M', 'Follow', 'Add comment'] }));
  check('3c. Nhãn thường KHÔNG bị nhận nhầm là nhãn AI', a3.ni === 0, JSON.stringify(a3));
}

// ── 4. `why` chỉ được là enum ASCII ──
// Câu tiếng Việt của langfilter phải ở lại Node. Đẩy tiếng Việt qua đường ống là mở cửa cho
// tai nạn mã hoá đúng trên đường ra quyết định.
{
  fq._resetForTest();
  const b = ap.makeBrain({ deviceId: 'm1', dir: newDir(), cfg: { niEnabled: true, niAi: true } });
  const a = b.answer(hoi({ desc: 'kabul afghan' }));
  const a2 = b.answer(hoi({ id: 2, badges: ['Contains AI-generated media'] }));
  check('4. why chỉ nhận "lang" | "ai" và thuần ASCII',
    ['lang', 'ai'].includes(a.why) && ['lang', 'ai'].includes(a2.why)
    && /^[\x20-\x7e]*$/.test(a.why) && /^[\x20-\x7e]*$/.test(a2.why), `${a.why} / ${a2.why}`);
}

// ── 5. FOLLOW: chỉ khi bật, và KHÔNG follow chủ video vừa bị loại ──
{
  fq._resetForTest();
  const d = newDir();
  const cfg = { followOn: true, followPerDay: 30, niEnabled: true, niAi: true };
  const b = ap.makeBrain({ deviceId: 'm1', dir: d, cfg });

  const a = b.answer(hoi({ desc: 'caption sach' }));
  check('5. Video sạch, còn hạn mức -> cấp quyền follow', a.follow === 1, JSON.stringify(a));

  const a2 = b.answer(hoi({ id: 2, handle: '@khac', desc: 'afghan kabul' }));
  check('5b. Video dính ngôn ngữ -> KHÔNG follow chủ nó', a2.follow === 0, JSON.stringify(a2));

  const a3 = b.answer(hoi({ id: 3, handle: '@khac2', badges: ['Contains AI-generated media'] }));
  check('5c. Video gắn nhãn AI -> KHÔNG follow chủ nó', a3.follow === 0, JSON.stringify(a3));

  const tat = ap.makeBrain({ deviceId: 'm1', dir: d, cfg: { followPerDay: 30 } });
  check('5d. Không bật ô follow thì không bao giờ cấp quyền', tat.answer(hoi()).follow === 0);
}

// ── 6. CHỈ GHI SỔ KHI ĐÃ XÁC MINH ──
// channelstore.cjs:182-184 cảnh báo: ghi lúc BẤM thay vì lúc nút đã đổi sang "Following" thì
// kênh bị đánh dấu đã follow dù follow hỏng, và bị bỏ qua VĨNH VIỄN.
{
  fq._resetForTest();
  const d = newDir();
  const b = ap.makeBrain({ deviceId: 'm1', dir: d, cfg: { followOn: true, followPerDay: 30 } });

  b.answer(hoi({ id: 7, handle: '@thanh_cong' }));
  b.noteActed({ id: 7, follow: 'ok', handle: '@thanh_cong' });
  check('6. Follow thành công -> ghi sổ', cs.isFollowed(d, '@thanh_cong') === true);

  b.answer(hoi({ id: 8, handle: '@that_bai' }));
  b.noteActed({ id: 8, follow: 'fail', handle: '@that_bai' });
  check('6b. Follow HỎNG -> KHÔNG ghi sổ (nếu ghi là bỏ qua kênh này vĩnh viễn)',
    cs.isFollowed(d, '@that_bai') === false);
  check('6c. Số lần hỏng được đếm riêng, không im lặng', b._dem.followFail === 1, `${b._dem.followFail}`);
}

// ── 7. TYM đếm trên đĩa, và trần 0 = TẮT ──
{
  fq._resetForTest();
  const d = newDir();
  const b = ap.makeBrain({ deviceId: 'm1', dir: d, cfg: { likeOn: true, likePerDay: 2 } });
  const a1 = b.answer(hoi({ id: 1 }));
  check('7. Còn hạn mức -> cấp quyền tym', a1.like === 1);
  b.noteActed({ id: 1, like: 'ok' });
  b.noteActed({ id: 2, like: 'ok' });
  const a3 = b.answer(hoi({ id: 3 }));
  check('7b. Hết hạn mức -> ngừng cấp quyền', a3.like === 0, `dem=${dc.count(d, 'like')}`);

  const tat = ap.makeBrain({ deviceId: 'm1', dir: newDir(), cfg: { likeOn: true, likePerDay: 0 } });
  check('7c. Trần tym 0 = TẮT, không phải vô hạn', tat.answer(hoi()).like === 0);
}

// ── 8. MẶC ĐỊNH AN TOÀN cho mọi đầu vào hỏng ──
// Đây là hợp đồng quan trọng nhất của cả file.
{
  fq._resetForTest();
  const b = ap.makeBrain({
    deviceId: 'm1', dir: newDir(),
    cfg: { niEnabled: true, niAi: true, followOn: true, followPerDay: 30, likeOn: true, likePerDay: 99, visitOn: true },
  });
  const xau = [
    null, undefined, {}, 'chuỗi chứ không phải đối tượng', 42,
    { v: 999, id: 1, desc: 'afghan' },              // lệch phiên bản giao thức
    { v: V, id: 1, badges: 'không phải mảng' },
    { v: V },                                       // thiếu id
  ];
  let nem = false;
  const ra = [];
  try { xau.forEach((x) => ra.push(b.answer(x))); } catch (_) { nem = true; }
  check('8. Không đầu vào hỏng nào làm ném lỗi', nem === false);
  check('8b. MỌI đầu vào hỏng -> không bấm gì cả',
    ra.every((r) => r && r.ni === 0 && r.follow === 0 && r.like === 0 && r.visit === 0),
    JSON.stringify(ra.map((r) => r && `${r.ni}${r.follow}${r.like}${r.visit}`)));
  check('8c. Luôn trả đủ trường để phía Python đọc được', ra.every((r) => r && r.v === V && typeof r.id === 'number'));
}

// ── 9. safeAnswer là "không làm gì" ──
{
  const s = ap.safeAnswer(5);
  check('9. safeAnswer không bấm gì', s.ni === 0 && s.follow === 0 && s.like === 0 && s.visit === 0 && s.id === 5);
}

// ── 10. Lệch phiên bản giao thức phải NÓI TO ──
// Phần .py và phần .js không cùng bản build thì không có triệu chứng nào khác ngoài dòng cảnh
// báo này — mọi tính năng chỉ lặng lẽ không chạy.
{
  fq._resetForTest();
  const noi = [];
  const b = ap.makeBrain({ deviceId: 'm1', dir: newDir(), cfg: { niEnabled: true }, say: (s) => noi.push(s) });
  b.answer({ v: 999, id: 1, desc: 'afghan' });
  b.answer({ v: 999, id: 2, desc: 'afghan' });
  check('10. Lệch phiên bản -> có cảnh báo', noi.some((s) => /Lệch phiên bản/.test(s)), noi[0] || '(không có)');
  check('10b. Chỉ cảnh báo MỘT lần, không spam log',
    noi.filter((s) => /Lệch phiên bản/.test(s)).length === 1);
}

// ── 11. Đường tự vá nhãn AI: in đúng MỘT dòng mỗi lượt chạy ──
{
  fq._resetForTest();
  const noi = [];
  const b = ap.makeBrain({ deviceId: 'm1', dir: newDir(), cfg: { niAi: true }, say: (s) => noi.push(s) });
  b.answer(hoi({ badges: ['Contient du contenu généré par IA'] }));
  b.answer(hoi({ id: 2, badges: ['Contenido generado por IA aquí'] }));
  const la = noi.filter((s) => /nhãn lạ/.test(s));
  check('11. Chuỗi lạ nghi là nhãn AI -> có báo', la.length >= 1, la[0] || '(không có)');
  check('11b. Chỉ báo MỘT dòng mỗi lượt chạy', la.length === 1, `${la.length} dòng`);
}

// ── 12. Dòng tổng kết ──
{
  fq._resetForTest();
  const b = ap.makeBrain({ deviceId: 'm1', dir: newDir(), cfg: { niEnabled: true, niAi: true } });
  check('12. Chưa làm gì thì tổng kết rỗng, không in dòng vô nghĩa', b.summary() === '');
  b.answer(hoi({ desc: 'afghan kabul' }));
  const s = b.summary();
  check('12b. Có hoạt động thì tổng kết nêu số liệu', /loại 1 vì ngôn ngữ/.test(s), s.replace(/\n/g, ' | '));
  check('12c. Kèm ví dụ kênh bị loại để soi xem có khớp nhầm không', /Ví dụ kênh bị loại/.test(s));
}

dọn.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} });

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
process.exit(failed.length ? 1 : 0);
