// tests/wiring.test.cjs — mọi ô cài đặt phải THẬT SỰ đi tới nơi thi hành.
//
// VÌ SAO PHẢI CÓ (2026-09-15):
// Bản PC ghi lại bài học này ở QĐ-38: **một ô cài đặt hiện ra mà không đổi hành vi còn tệ hơn
// một ô bị gỡ đi.** Người dùng bật nó, tin là đã bật, rồi không hiểu vì sao không có gì đổi.
//
// Ở app này đường đi của một ô dài bất thường và có bốn chặng để rơi mất:
//
//     index.html  →  renderer.js  →  main.js  →  runner.cjs  →  scan_feed_sounds.py
//        (ô)        (đọc + lưu)      (IPC)      (env / bộ não)      (thi hành)
//
// Rơi ở chặng nào cũng cho ra đúng một triệu chứng: ô bật mà không có gì xảy ra, không báo lỗi.
//
// ⚠ Phép thử này ĐÃ bắt được một ô chết thật ngay lần chạy đầu: `cycleBreakMin/Max` có ô, có
// mặc định, được lưu — nhưng không nơi nào đọc. Khoảng nghỉ giữa hai chu kỳ chưa hề tồn tại.
'use strict';
const fs = require('fs');
const path = require('path');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const R = path.join(__dirname, '..');
const doc = (p) => fs.readFileSync(path.join(R, p), 'utf8');

const rend = doc('renderer/renderer.js');
const html = doc('renderer/index.html');
const runner = doc('src/runner.cjs');
const brain = doc('src/askproto.cjs');
const mainjs = doc('main.js');
const py = doc('scan_feed_sounds.py');
const pyAct = doc('phone_actions.py');
const pyBridge = doc('askbridge.py');

// Lấy các khoá của một object literal khai báo bằng `const TÊN = { ... };`
function khoaCua(src, ten) {
  const i = src.indexOf(`const ${ten} = {`);
  if (i < 0) return [];
  let d = 0;
  const bd = src.indexOf('{', i);
  let j = bd;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) break; }
  }
  const than = src.slice(bd + 1, j);
  return [...than.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]);
}

// id của KHỐI BỌC (kết thúc bằng `Section`) và `cfgNiScripts` là thẻ chứa, không phải ô nhập —
// chúng không có giá trị mặc định tương ứng.
const laONhap = (x) => !/Section$/.test(x) && x !== 'cfgNiScripts';
const idCfg = [...html.matchAll(/\sid="(cfg[A-Za-z0-9_]+)"/g)].map((m) => m[1]);

// ── 1. Mọi cài đặt theo máy phải được AI ĐÓ ĐỌC ──
{
  const keys = khoaCua(rend, 'DEFAULT_SETTINGS');
  check('1. Đọc được DEFAULT_SETTINGS', keys.length >= 20, `${keys.length} khoá`);

  // Hai khoá ĐỔI TÊN trên đường đi: renderer gửi `delayMin` xuống dưới tên `dwellMin` (tên cũ
  // của biến môi trường Python). Ghi rõ ở đây thay vì nới lỏng phép kiểm — nới lỏng là phép thử
  // hết bắt được ô chết thật.
  const DOI_TEN = { delayMin: 'dwellMin', delayMax: 'dwellMax' };
  // main.js cũng là nơi thi hành: khoảng nghỉ giữa hai chu kỳ do main hẹn giờ, không phải Python.
  const noiThiHanh = brain + runner + mainjs;
  const chet = keys.filter((k) => !new RegExp(`\\b${DOI_TEN[k] || k}\\b`).test(noiThiHanh));
  check('1b. Không ô nào là ô CHẾT (bật mà không ai đọc)', chet.length === 0,
    chet.length ? `${chet.join(', ')}  ← ô hiện ra nhưng không đổi hành vi (QĐ-38)` : '');
}

// ── 2. Mọi ô trong HTML phải có mặc định, và ngược lại ──
// Ô có trong HTML mà thiếu mặc định thì `openSettingsModal` ghi `undefined` vào ô nhập.
// Mặc định có mà không có ô thì người dùng không bao giờ sửa được.
{
  const oNhap = idCfg.filter(laONhap);
  const keys = new Set([...khoaCua(rend, 'DEFAULT_SETTINGS'), ...khoaCua(rend, 'DEFAULT_GLOBAL')]);
  const veKhoa = (id) => id.slice(3, 4).toLowerCase() + id.slice(4);   // cfgMinPosts -> minPosts

  const thieuMacDinh = oNhap.filter((id) => !keys.has(veKhoa(id)));
  check('2. Mọi ô cfg trong HTML đều có giá trị mặc định', thieuMacDinh.length === 0,
    thieuMacDinh.join(', '));

  // `niScripts` không có ô input riêng: nó là dãy ô tích dựng lúc chạy trong `cfgNiScripts`.
  // Vẫn phải kiểm là CÓ AI DỰNG nó thật, nếu không thì đúng là một ô chết.
  const RIENG = { niScripts: /renderNiScripts\(/ };
  const idSet = new Set(oNhap.map(veKhoa));
  const khongCoO = [...keys].filter((k) => (RIENG[k] ? !RIENG[k].test(rend) : !idSet.has(k)));
  check('2b. Mọi mặc định đều có ô để người dùng sửa', khongCoO.length === 0, khongCoO.join(', '));
}

// ── 3. saveSettings phải ĐỌC hết các ô, openSettingsModal phải GHI hết ──
// Thêm ô vào HTML mà quên một trong hai hàm là ô đó không lưu được, hoặc mở ra luôn trống.
{
  const keys = khoaCua(rend, 'DEFAULT_SETTINGS');
  const i = rend.indexOf('async function saveSettings');
  const than = rend.slice(i, i + 4000);
  const thieu = keys.filter((k) => !new RegExp(`\\b${k}\\s*:`).test(than));
  check('3. saveSettings ghi đủ mọi khoá', thieu.length === 0, thieu.join(', '));

  const j = rend.indexOf('function openSettingsModal');
  const than2 = rend.slice(j, j + 3000);
  const chuaNap = idCfg.filter(laONhap).filter((id) => !than2.includes(`'${id}'`));
  check('3b. openSettingsModal nạp đủ mọi ô', chuaNap.length === 0, chuaNap.join(', '));
}

// ── 4. Hai ô toàn app phải được ÁP vào devslot, không chỉ lưu vào store ──
{
  check('4. main.js áp trần song song vào devslot', /devslot\.setMax\(/.test(mainjs));
  check('4b. main.js áp giãn cách khởi động', /devslot\.setStaggerMs\(/.test(mainjs));
  check('4c. main.js thật sự xin khe trước khi chạy máy', /devslot\.acquire\(/.test(mainjs));
  check('4d. main.js nhả khe khi máy dừng/lỗi', /devslot\.release\(/.test(mainjs));
  check('4e. Bấm Dừng lúc đang xếp hàng thì rút khỏi hàng', /devslot\.cancel\(/.test(mainjs));
  check('4f. renderer đẩy cài đặt toàn app xuống tiến trình chính',
    /setGlobalSettings\(/.test(rend) && /set-global-settings/.test(mainjs));
}

// ── 4g. Khoảng nghỉ giữa hai chu kỳ phải được dùng thật ──
// Đây là thứ làm 19 máy xoay vòng qua 6 khe. Thiếu nó thì 6 máy giữ khe vĩnh viễn và 13 máy
// còn lại chờ mãi — phép thử 1b đã bắt được đúng lỗ hổng này.
{
  check('4g. Python báo hết ca trước khi thoát', /cycle_done/.test(py));
  check('4h. main.js bắt "hết ca" và hẹn giờ chạy lại',
    /_cycleDone/.test(mainjs) && /cycleBreakMin/.test(mainjs) && /cycleBreakMax/.test(mainjs));
  check('4i. Bấm Dừng huỷ luôn hẹn giờ nghỉ (không tự chạy lại sau khi đã bảo dừng)',
    /huyNghi\(/.test(mainjs));
}

// ── 4j. Mọi `window.api.X` renderer gọi phải có trong preload, và có handler trong main ──
// Gọi một hàm preload không tồn tại là `TypeError` **giữa chừng `init()`** — nửa còn lại của
// hàm im lặng không chạy, và giao diện mở ra trống trơn không báo gì. Đúng hình dạng QĐ-24.
{
  const preload = doc('preload.cjs');
  const dung = [...new Set([...rend.matchAll(/window\.api\.([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]))];
  const co = new Set([...preload.matchAll(/^\s*([A-Za-z0-9_]+)\s*:\s*\(/gm)].map((m) => m[1]));
  const thieu = dung.filter((x) => !co.has(x));
  check('4j. Mọi window.api renderer gọi đều có trong preload', thieu.length === 0, thieu.join(', '));
  check('4k. Phép thử không rỗng', dung.length >= 10, `${dung.length} hàm`);

  // Và mỗi kênh `invoke` trong preload phải có `ipcMain.handle` bên main.
  const kenh = [...new Set([...preload.matchAll(/invoke\('([a-z0-9-]+)'/g)].map((m) => m[1]))];
  const xuLy = new Set([...mainjs.matchAll(/ipcMain\.handle\('([a-z0-9-]+)'/g)].map((m) => m[1]));
  const khongAiXuLy = kenh.filter((k) => !xuLy.has(k));
  check('4l. Mọi kênh IPC đều có người xử lý bên main', khongAiXuLy.length === 0,
    khongAiXuLy.join(', '));
}

// ── 5. Phiên bản giao thức hai phía phải KHỚP ──
// Lệch là mọi tính năng lọc/tương tác lặng lẽ không chạy, không có triệu chứng nào khác.
{
  const mJs = brain.match(/const PROTO_VERSION\s*=\s*(\d+)/);
  const mPy = pyBridge.match(/PROTO_V\s*=\s*int\(os\.environ\.get\("PROTO_V",\s*"(\d+)"\)\)/);
  check('5. Đọc được số phiên bản giao thức ở cả hai phía', !!mJs && !!mPy,
    `js=${mJs && mJs[1]} py=${mPy && mPy[1]}`);
  if (mJs && mPy) {
    check('5b. Hai phía cùng một số phiên bản', mJs[1] === mPy[1], `js=${mJs[1]} py=${mPy[1]}`);
  }
  check('5c. runner truyền số phiên bản xuống Python',
    /PROTO_V:\s*String\(askproto\.PROTO_VERSION\)/.test(runner));
}

// ── 6. Python KHÔNG được giữ bản sao danh sách nhãn ──
// Đây chính là cách `linkkey.cjs` đã lệch. Nhãn chỉ có một nguồn là `uilabels.cjs`.
{
  const nghiNgo = /FOLLOW_LABELS\s*=\s*\[|NOT_INTERESTED_LABELS\s*=\s*\[|AI_LABELS\s*=\s*\[/;
  check('6. phone_actions.py không tự khai danh sách nhãn', !nghiNgo.test(pyAct));
  check('6b. Nhãn đến từ biến môi trường do Node dựng',
    /os\.environ\.get\("RE_FOLLOW"/.test(pyAct)
    && /RE_FOLLOW:\s*_reTu\(uilabels\.FOLLOW_LABELS\)/.test(runner));
  check('6c. Khớp TRỌN CHUỖI, không phải "có chứa"', /\(\?i\)\^\(/.test(runner));
}

// ── 7. Nhóm ký tự trong giao diện phải khớp langfilter ──
// Thêm nhóm bên langfilter mà quên ở đây thì người dùng không bật được nó; ngược lại thì bật
// một nhóm không tồn tại và nó im lặng không lọc gì.
{
  const lf = require(path.join(R, 'src', 'langfilter.cjs'));
  const coThat = new Set(Object.keys(lf.SCRIPT_GROUPS));
  const i = rend.indexOf('const NI_SCRIPTS');
  const than = rend.slice(i, rend.indexOf('];', i));
  const trongUI = [...than.matchAll(/key:\s*'([a-z]+)'/g)].map((m) => m[1]);
  const la = trongUI.filter((k) => !coThat.has(k));
  const sot = [...coThat].filter((k) => !trongUI.includes(k));
  check('7. Không nhóm ký tự nào trong giao diện là nhóm không tồn tại', la.length === 0, la.join(', '));
  check('7b. Không sót nhóm nào của langfilter', sot.length === 0, sot.join(', '));
}

// ── 8. Python phải thi hành đủ bốn hành động, theo đúng thứ tự an toàn ──
{
  check('8. Python có gọi đủ 4 hành động',
    /PA\.do_follow\(/.test(py) && /PA\.do_like\(/.test(py)
    && /PA\.do_visit\(/.test(py) && /PA\.tap_not_interested\(/.test(py));
  check('8b. Kiểm "vẫn đúng video đó" TRƯỚC khi bấm', /PA\.same_video\(/.test(py));
  // Not interested làm feed nhảy sang video khác nên phải bấm SAU CÙNG.
  check('8c. Not interested nằm sau follow/tym/ghé thăm trong mã',
    py.indexOf('PA.tap_not_interested(') > py.indexOf('PA.do_follow('));
  check('8d. Follow chỉ chạy khi sound HỢP LỆ', /if res:[\s\S]{0,80}kq\["follow"\]/.test(py));
}

// ── 9. Luồng đọc stdin phải là daemon ──
// Không phải daemon thì chạy hết LIMIT là Python treo vĩnh viễn: Node không nhận `close`,
// giao diện mãi hiện "đang chạy", người dùng phải bấm Dừng.
{
  // Bỏ docstring và chú thích trước khi soi: chính khối docstring đầu file có viết câu cảnh báo
  // "for line in sys.stdin:" — soi cả chú thích thì phép thử báo đỏ oan mãi mãi, rồi người ta
  // học cách bỏ qua màu đỏ.
  const pyMa = pyBridge.replace(/"""[\s\S]*?"""/g, '').replace(/^\s*#.*$/gm, '');
  check('9. Luồng đọc stdin là daemon', /daemon=True/.test(pyMa));
  check('9b. Dùng readline() chứ không phải `for line in sys.stdin`',
    /sys\.stdin\.readline\(\)/.test(pyMa) && !/for line in sys\.stdin/.test(pyMa));
  check('9c. Có đốt id khi hết giờ để câu trả lời muộn không khớp nhầm',
    /self\._next_id = max\(self\._next_id, aid \+ 1\)/.test(pyMa));
}

// ── 10. Ghi vào stdin của tiến trình con phải có hàng rào ──
// Ghi vào stdin của tiến trình vừa chết phát sự kiện 'error'; không ai bắt thì Electron main
// CHẾT và bỏ lại toàn bộ tiến trình Python mồ côi vẫn đang vuốt máy thật.
{
  check('10. runner bắt lỗi trên stdin', /proc\.stdin\.on\('error'/.test(runner));
  check('10b. runner kiểm stream còn sống trước mỗi lần ghi',
    /st\.destroyed \|\| !st\.writable/.test(runner));

  // ⚠ Câu trả lời PHẢI mang tiền tố `@@ANS@@`. `askbridge.py` bỏ qua mọi dòng không có tiền tố
  // này. Quên nó thì Python không bao giờ nhận được phán quyết: hết giờ 3 lần rồi TỰ TẮT lọc &
  // tương tác — im lặng, không lỗi, app vẫn quét nên nhìn ngoài không thấy gì sai.
  // Lỗi này đã xảy ra thật và do `tests/bridge.test.cjs` bắt được.
  check('10c. Câu trả lời gửi xuống có tiền tố @@ANS@@',
    /st\.write\(ANS_PREFIX \+ JSON\.stringify/.test(runner));
  check('10d. Hai phía dùng cùng ba tiền tố',
    /ANS_PREFIX = '@@ANS@@'/.test(runner)
    && /startswith\("@@ANS@@"\)/.test(pyBridge)
    && /"@@ASK@@"/.test(pyBridge));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
process.exit(failed.length ? 1 : 0);
