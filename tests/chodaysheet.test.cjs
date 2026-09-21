// tests/chodaysheet.test.cjs — HÀNG CHỜ ĐẨY SHEET trên đĩa (2026-09-21).
//
// Chủ dự án: "Google Sheet đang lỗi … để nó quét rồi đẩy lên sau được không, mỗi lần đẩy phải tránh
// trùng link". Trước đây sound chưa lên Sheet chỉ nằm trong bộ nhớ: tắt app là mất. Ở đây chạy
// ĐÚNG module thật, ghi vào thư mục tạm — không đụng dữ liệu thật.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? '  — ' + detail : ''}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chodaysheet-'));
process.env.PORTABLE_EXECUTABLE_DIR = TMP;
const cd = require(path.join(__dirname, '..', 'src', 'chodaysheet.cjs'));
const F = cd.getFilePath();
const url = (n) => `https://www.tiktok.com/music/original-sound-${n}`;
const dong = (n, ten = 'Sound ' + n) => [ten, url(n), 5000, 'GM1911', 1];

check('1. File nằm cạnh .exe (cùng chỗ với known_links.txt), tên cho_day_sheet.jsonl',
  path.dirname(F) === TMP && path.basename(F) === 'cho_day_sheet.jsonl', F);

// 2. Thêm + chống trùng theo khoá chuẩn hoá (link dài, ?lang, chữ hoa… vẫn là một sound).
const a = cd.them(dong('7100000000000000001'));
const trung = cd.them(['khác tên', url('7100000000000000001') + '?lang=vi', 9, 'V2031', 1]);
const trungHoa = cd.them(['x', url('7100000000000000001').toUpperCase(), 9, 'V2031', 1]);
const b = cd.them(dong('7100000000000000002'));
check('2. Thêm sound mới; cùng sound (link khác kiểu viết) KHÔNG vào hàng chờ lần hai',
  a && b && !trung && !trungHoa && cd.dem() === 2, JSON.stringify({ a, b, trung, trungHoa, n: cd.dem() }));
check('2b. Link rỗng không vào hàng chờ', cd.them(['x', '', 1, 'y', 1]) === false && cd.dem() === 2);

// 3. Sống qua lần tắt app: đọc lại từ đĩa ra đúng 5 cột, đúng thứ tự.
cd.load(true);
const sau = cd.tatCa();
check('3. Tắt app mở lại → đọc lại từ đĩa đủ dòng, đủ 5 cột, giữ thứ tự',
  sau.length === 2 && JSON.stringify(sau[0].dong) === JSON.stringify(dong('7100000000000000001')) && sau[0].t > 0
  && sau[1].dong[1] === url('7100000000000000002'), JSON.stringify(sau));

// 4. Lên Sheet thành công → gỡ; gỡ cũng sống qua lần tắt app.
const go = cd.bo([url('7100000000000000001') + '?lang=vi', url('7999999999999999999')]);
cd.load(true);
check('4. Lên Sheet → gỡ đúng sound đó (khớp theo khoá chuẩn hoá), ghi lại đĩa',
  go === 1 && cd.dem() === 1 && cd.tatCa()[0].dong[1] === url('7100000000000000002'), `gỡ ${go}, còn ${cd.dem()}`);

// 5. Mất điện giữa lúc ghi: dòng cuối dở dang. Không được làm hỏng dòng ghi SAU nó.
fs.appendFileSync(F, '{"t":1,"dong":["dở', 'utf8');
cd.load(true);
cd.them(dong('7100000000000000003'));
cd.load(true);
const cuoi = cd.tatCa().map((x) => x.dong[1]);
check('5. Dòng ghi dở (mất điện) bị bỏ, dòng thêm sau vẫn nguyên vẹn',
  cuoi.length === 2 && cuoi.includes(url('7100000000000000002')) && cuoi.includes(url('7100000000000000003')),
  JSON.stringify(cuoi));

// 6. Gỡ hết → file còn nhưng rỗng, đếm 0; không để lại file tạm.
cd.bo(cd.tatCa().map((x) => x.dong[1]));
cd.load(true);
check('6. Gỡ hết → hàng chờ 0, không sót file tạm', cd.dem() === 0 && !fs.existsSync(F + '.tmp'));

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
const failed = results.filter((x) => !x.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
process.exit(failed.length ? 1 : 0);
