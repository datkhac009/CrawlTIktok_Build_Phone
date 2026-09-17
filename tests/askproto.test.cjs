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

// ── 7. TYM đếm trên đĩa, trần 0 = TẮT, và TỈ LỆ BỐC ──
//
// ⚠ Từ 2026-09-17 tym KHÔNG còn tất định: nó phải qua một phép bốc 40-60% (xem askproto.cjs).
// Nên mọi phép thử ở đây tiêm `rng` để chạy tất định — thiếu nó thì test đỏ ngẫu nhiên, và một
// test đỏ ngẫu nhiên dạy người ta bỏ qua màu đỏ.
{
  fq._resetForTest();
  const d = newDir();
  // rng cố định 0 + tỉ lệ 100% = luôn trúng, nên phần còn lại của phép thử vẫn đo đúng hạn mức.
  const luon = { likeOn: true, likePerDay: 2, likeRateMin: 100, likeRateMax: 100 };
  const b = ap.makeBrain({ deviceId: 'm1', dir: d, cfg: luon, rng: () => 0 });
  const a1 = b.answer(hoi({ id: 1 }));
  check('7. Còn hạn mức -> cấp quyền tym', a1.like === 1);
  b.noteActed({ id: 1, like: 'ok' });
  b.noteActed({ id: 2, like: 'ok' });
  const a3 = b.answer(hoi({ id: 3 }));
  check('7b. Hết hạn mức -> ngừng cấp quyền', a3.like === 0, `dem=${dc.count(d, 'like')}`);

  const tat = ap.makeBrain({ deviceId: 'm1', dir: newDir(), cfg: { likeOn: true, likePerDay: 0 } });
  check('7c. Trần tym 0 = TẮT, không phải vô hạn', tat.answer(hoi()).like === 0);

  // ── Phép bốc ──
  // Chủ dự án nhìn màn hình thấy video nào cũng bị tym. Một phần là thiếu điều kiện "sound hợp
  // lệ" bên Python, phần còn lại là tym 100% số video đạt — vẫn là hành vi máy móc.
  const rate0 = ap.makeBrain({
    deviceId: 'm1', dir: newDir(),
    cfg: { likeOn: true, likePerDay: 60, likeRateMin: 0, likeRateMax: 0 }, rng: () => 0,
  });
  const a0 = rate0.answer(hoi());
  check('7d. Tỉ lệ 0% = KHÔNG tym (0 không phải "dùng mặc định")',
    a0.like === 0 && a0.like_profile === 0, JSON.stringify(a0));

  // Tỉ lệ 50%: rng trả 0.9 -> 90 > 50 -> trượt. Cùng cấu hình, rng 0.1 -> trúng.
  const nua = { likeOn: true, likePerDay: 60, likeRateMin: 50, likeRateMax: 50 };
  check('7e. Bốc trượt thì KHÔNG tym',
    ap.makeBrain({ deviceId: 'm1', dir: newDir(), cfg: nua, rng: () => 0.9 }).answer(hoi()).like === 0);
  check('7f. Bốc trúng thì tym',
    ap.makeBrain({ deviceId: 'm1', dir: newDir(), cfg: nua, rng: () => 0.1 }).answer(hoi()).like === 1);

  // Tỉ lệ bốc MỘT lần cho cả lượt: rng chạy dần từ 0 lên, nhưng tỉ lệ đã chốt từ lần gọi đầu.
  // Nếu bốc lại mỗi video thì mười câu trả lời sẽ không thể giống nhau.
  let n = 0;
  const motLan = ap.makeBrain({
    deviceId: 'm1', dir: newDir(),
    cfg: { likeOn: true, likePerDay: 60, likeRateMin: 100, likeRateMax: 100 },
    rng: () => { n += 1; return 0; },
  });
  const muoi = Array.from({ length: 10 }, (_, i) => motLan.answer(hoi({ id: i + 1 })).like);
  check('7g. Tỉ lệ bốc MỘT lần cho cả lượt chạy', muoi.every((x) => x === 1), muoi.join(''));

  // ── Tym trong trang cá nhân ──
  const cfgGhe = {
    likeOn: true, likePerDay: 60, visitOn: true,
    likeRateMin: 100, likeRateMax: 100,
  };
  const ghe = ap.makeBrain({ deviceId: 'm1', dir: newDir(), cfg: cfgGhe, rng: () => 0 });
  const ag = ghe.answer(hoi());
  check('7h. Có ghé trang -> cấp thêm quyền tym trong trang',
    ag.visit === 1 && ag.like_profile === 1, JSON.stringify(ag));

  // Không ghé thì không có video nào để tym — cấp quyền cho một cú bấm không có đối tượng là
  // để Python bấm lên bất cứ thứ gì đang ở trên màn hình.
  const khongGhe = ap.makeBrain({
    deviceId: 'm1', dir: newDir(),
    cfg: { ...cfgGhe, visitOn: false }, rng: () => 0,
  });
  check('7i. KHÔNG ghé trang -> KHÔNG cấp tym trong trang',
    khongGhe.answer(hoi()).like_profile === 0);

  // Hai cú tym ăn chung trần ngày: còn đúng 1 lượt thì chỉ được cấp MỘT.
  const con1 = ap.makeBrain({
    deviceId: 'm1', dir: newDir(),
    cfg: { ...cfgGhe, likePerDay: 1 }, rng: () => 0,
  });
  const a1c = con1.answer(hoi());
  check('7j. Còn 1 lượt trong ngày -> chỉ cấp MỘT cú tym',
    (a1c.like + a1c.like_profile) === 1, JSON.stringify(a1c));

  // Công tắc tổng phải át tỉ lệ.
  const tatHan = ap.makeBrain({
    deviceId: 'm1', dir: newDir(),
    cfg: { ...cfgGhe, likeOn: false }, rng: () => 0,
  });
  const at = tatHan.answer(hoi());
  check('7k. likeOn=false át cả tỉ lệ lẫn ghé trang',
    at.like === 0 && at.like_profile === 0);

  // Tym trong trang ăn vào trần ngày — nếu không thì nó là cú bấm MIỄN PHÍ, không giới hạn.
  const soSach = newDir();
  const ghiSo = ap.makeBrain({ deviceId: 'm1', dir: soSach, cfg: cfgGhe, rng: () => 0 });
  ghiSo.noteActed({ id: 1, like_profile: 'ok' });
  check('7l. Tym trong trang ĐƯỢC ghi vào trần ngày', dc.count(soSach, 'like') === 1,
    `đếm=${dc.count(soSach, 'like')}`);
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
