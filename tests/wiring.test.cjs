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
// Đưa xuống dòng về `\n` trước khi soi (2026-09-23): máy chủ dự án để `core.autocrlf=true` nên
// git checkout ra CRLF, mà nhiều biểu thức dưới đây tìm `\n\n`. Kéo commit về xong là 16e đỏ oan
// trên máy này trong khi máy vừa đẩy lên (LF) vẫn xanh — cùng một mã nguồn.
const doc = (p) => fs.readFileSync(path.join(R, p), 'utf8').replace(/\r\n/g, '\n');

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
  // Follow chỉ được chạy khi sound HỢP LỆ (`res` khác None). Từ 2026-09-16 điều kiện này viết
  // theo chiều ngược — `if not res: ... else: <ghé trang rồi follow>` — vì nhánh follow giờ dài
  // hơn (ghé trang cá nhân lấy @handle thật rồi mới bấm). Vẫn là đúng một bảo đảm đó.
  {
    const i = py.indexOf('if ans.get("follow"):');
    // Cửa sổ 1400: nhánh follow dài hẳn ra từ 2026-09-16 vì phải ghé trang cá nhân trước khi
    // bấm. Đo được lúc viết: 975 ký tự từ `if ans.get("follow")` tới `PA.do_follow(`.
    const khoi = i >= 0 ? py.slice(i, i + 2200) : '';
    // `FOLLOW_ANY` là cờ THỬ NGHIỆM, mặc định tắt — nên điều kiện thật vẫn là "sound hợp lệ".
    const iRes = khoi.indexOf('if not res and not FOLLOW_ANY:');
    const iBam = khoi.indexOf('PA.do_follow(');
    check('8d. Follow chỉ chạy khi sound HỢP LỆ',
      i >= 0 && iRes >= 0 && iBam > iRes,
      i < 0 ? 'không thấy khối follow' : `if-not-res@${iRes} do_follow@${iBam}`);
    // Cờ thử nghiệm PHẢI mặc định tắt, nếu không app thật sẽ follow cả khi sound không đạt.
    check('8d2. Cờ FOLLOW_ANY mặc định TẮT',
      /FOLLOW_ANY = os\.environ\.get\("FOLLOW_ANY"\) == "1"/.test(py)
      && /FOLLOW_ANY:\s*cfg\.followAnySound \? '1' : '0'/.test(runner));
  }
  // Follow PHẢI đi qua trang cá nhân: @handle không tồn tại trên feed (đo 2026-09-16), mà sổ
  // chống trùng + trần 30/ngày đều khoá theo @handle. Bấm follow thẳng ở feed là bỏ qua cả hai.
  check('8e. Follow đi qua trang cá nhân để lấy @handle thật',
    /PA\.open_profile_read_handle\(/.test(py) && /follow_confirm/.test(py));
  check('8f. Ghé trang xong LUÔN quay về feed', /PA\.close_profile\(/.test(py));
  // Follow xong phải NẠP LẠI trang rồi đọc lại nút: TikTok bật lại cú follow vài giây sau là
  // chuyện có thật, mà sổ thì ghi vĩnh viễn — tin phép xác minh tại chỗ là ghi một cú follow
  // không hề tồn tại, và kênh đó không bao giờ được thử lại.
  check('8i. Follow xong có nạp lại trang để kiểm còn không',
    /PA\.verify_follow_after_reload\(/.test(py) && /"reverted"/.test(py));
  // Kiểm PHẢI xảy ra TRƯỚC khi rời trang: rời đi rồi quay lại là có thể mở nhầm trang người khác.
  {
    const i = py.indexOf('PA.verify_follow_after_reload(');
    const j = py.indexOf('PA.close_profile(', py.indexOf('if ans.get("follow"):'));
    check('8j. Nạp lại NGAY trên trang đang mở, trước khi quay về feed',
      i > 0 && j > 0 && i < j, `reload@${i} close@${j}`);
  }
  // ⚠ BẪY ĐÃ SẬP MỘT LẦN (2026-09-16), đo trên máy thật:
  // Trang cá nhân có nhãn thống kê "Following / Followers" — `text` đúng bằng "Following", nên
  // khớp trọn chuỗi vẫn dính. `do_follow` tưởng đã theo dõi rồi, trả 'not_needed' NGAY, và
  // không follow được ai. Tệ hơn: bước XÁC MINH sau khi bấm cũng thấy nhãn đó nên luôn báo
  // 'ok', tức ghi sổ một cú follow chưa từng xảy ra. Thứ phân biệt là `clickable`.
  {
    const pa = doc('phone_actions.py');
    // Mọi lần hỏi "có nút Follow/Following không" PHẢI đi qua `tim_nut_follow` — nơi duy nhất
    // biết phân biệt nút thật với ô thống kê. Gọi thẳng `_find_by_regex` là mở lại cửa cho bọ.
    const thangThuong = (pa.match(/_find_by_regex\([^)]*RE_FOLLOW(?:ING)?\b[^)]*\)/g) || [])
      .filter((s) => !/RE_NOT_INTERESTED/.test(s));
    check('8h. Không nơi nào tìm nút Follow bằng _find_by_regex trần',
      thangThuong.length === 0,
      thangThuong.length ? `còn: ${thangThuong.join(' | ')}` : '');
    // Hai luật loại ô thống kê, cả hai đều do đo trên máy thật mà có.
    check('8h2. tim_nut_follow loại ô thống kê bằng "Followers" VÀ bằng con số',
      /def tim_nut_follow\(/.test(pa) && /\^followers\$/i.test(pa)
      && /re_so\s*=\s*re\.compile/.test(pa));
  }
  // Livestream: bỏ qua hẳn, không hỏi không bấm (yêu cầu chủ dự án 2026-09-16).
  check('8g. Bỏ qua video đang LIVE', /info\.get\("live"\)/.test(py));
  // ⚠ BỎ QUA Ở ĐẦU VÒNG LÀ CHƯA ĐỦ, và đây là lỗi đã XẢY RA THẬT:
  // chủ dự án bắt được máy đang đứng TRONG một phòng phát trực tiếp. Vuốt sang trái trên video
  // LIVE không mở trang cá nhân mà đi thẳng vào phòng live. Giữa lúc đọc màn hình và lúc vuốt
  // còn cả vòng đi trang nhạc, feed kịp trôi sang một video LIVE khác.
  {
    const pa = doc('phone_actions.py');
    const i = pa.indexOf('def _mo_trang_ca_nhan');
    // Cửa sổ rộng vì hàm này mang một docstring dài — nó chép lại ba cách mở trang cá nhân đã
    // thử và vì sao từng cách hỏng. Đo lúc viết: thân hàm bắt đầu quanh ký tự thứ 2800.
    const than = i >= 0 ? pa.slice(i, i + 4200) : '';
    // Chốt chặn LIVE phải nằm TRƯỚC thao tác mở trang, dù thao tác đó là vuốt hay bấm — đã đổi
    // từ vuốt sang bấm avatar ngày 2026-09-16 vì vuốt không điều hướng trên bản TikTok này.
    const iLive = than.indexOf('_dang_live(attrs)');
    // ⚠ Chỉ tính THÂN HÀM. Docstring của hàm này có nhắc chuỗi `d.swipe(` khi kể lại ba cách mở
    // trang đã thử — lấy cả docstring thì phép so vị trí đo nhầm vào một dòng chú thích.
    const iThan = than.indexOf('    try:');
    const thanThat = iThan >= 0 ? than.slice(iThan) : than;
    const iMo = Math.min(...['d.touch.down(', 'el.click()', 'd.swipe(']
      .map((x) => thanThat.indexOf(x)).filter((x) => x >= 0)
      .map((x) => x + iThan).concat([1e9]));
    check('8g2. Không mở trang cá nhân khi video đang LIVE',
      i >= 0 && iLive >= 0 && iMo < 1e9 && iLive < iMo,
      i < 0 ? 'không thấy hàm' : `live@${iLive} mở@${iMo}`);
    // Lưới thứ hai: lỡ lọt vào phòng live thì phải tự thoát.
    check('8g3. Có đường thoát nếu lỡ lọt vào phòng LIVE',
      /def dang_trong_phong_live\(/.test(pa) && /dang_trong_phong_live\(d\)/.test(pa));
  }
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

// ── 11. Thêm máy từ danh sách quét: tên phải đi theo serial ──
// SỰ CỐ THẬT (2026-09-17): chủ dự án bấm "+ Thêm" máy thứ hai, ô serial nhảy sang máy mới nhưng
// ô tên vẫn giữ tên máy TRƯỚC — ảnh chụp cho thấy tên "GM1911" đứng cạnh serial 192.168.5.110,
// vốn là GM1901. Thêm vào thì máy mang tên của máy khác. Tên là thứ DUY NHẤT để biết IP nào ứng
// với ô nào trên màn hình soi, nên gán nhầm tên là hỏng đúng cái nó sinh ra để giải quyết —
// càng nguy khi trong farm có hai SM-A920F và hai Redmi K20 Pro trùng đời.
{
  // Neo là lời gọi `closest('[data-act="quick-add"]')` — chuỗi trong template dựng HTML không có
  // dấu `');` theo sau nên không khớp nhầm. Cửa sổ rộng 1600 vì khối này mang một đoạn chú thích
  // dài giải thích chính sự cố nói trên; bóp hẹp lại là phép thử báo đỏ oan khi ai đó viết thêm.
  const khoiQuickAdd = /quick-add"\]'\);[\s\S]{0,1600}?oTen\.select\(\);/.exec(rend);
  check('11. Có xử lý bấm "+ Thêm" trong danh sách quét', !!khoiQuickAdd);

  const kQA = khoiQuickAdd ? khoiQuickAdd[0] : '';
  // Ô tên phải gán VÔ ĐIỀU KIỆN. Bản hỏng viết `if (... && !oTen.value.trim()) oTen.value = ...`
  check('11b. Ô tên gán thẳng theo máy vừa chọn, không nấp sau điều kiện "ô tên còn trống"',
    /oTen\.value = btn\.dataset\.name \|\| ''/.test(kQA) && !/!oTen\.value\.trim\(\)/.test(kQA));

  // Ô serial và ô tên phải cùng lấy từ MỘT nút, nếu không lại lệch theo kiểu khác.
  check('11c. Serial và tên cùng đọc từ nút vừa bấm',
    /newDeviceSerial'\)\.value = btn\.dataset\.serial/.test(kQA));
}

// ── 12. Thêm máy xong phải dọn dấu vết, nếu không người dùng bấm lại ──
// Cùng sự cố ngày 2026-09-17. Thêm xong, dòng trong danh sách quét vẫn hiện nút "+ Thêm" vì danh
// sách chỉ dựng lại khi bấm "Quét ADB" — nhìn vào tưởng bấm hụt nên bấm nữa, và chính cú bấm
// thừa đó đẻ ra lỗi lệch tên ở mục 11. Hai lỗi phải sửa cùng nhau mới hết.
{
  const khoiAdd = /async function addDevice\(\)[\s\S]*?\n}/.exec(rend);
  check('12. Có hàm addDevice', !!khoiAdd);

  const kA = khoiAdd ? khoiAdd[0] : '';
  check('12b. Thêm xong thì xoá cả hai ô nhập',
    /newDeviceName'\)\.value = ''/.test(kA) && /newDeviceSerial'\)\.value = ''/.test(kA));
  check('12c. Thêm xong thì đánh dấu dòng đó là "đã thêm"', /danhDauDaThem\(serial\)/.test(kA));
  check('12d. Có hàm đánh dấu, và nó đổi đúng nút của serial đó',
    /function danhDauDaThem\(serial\)/.test(rend)
    && /quick-add"\]\[data-serial="\$\{CSS\.escape\(serial\)\}"/.test(rend));

  // Chỉ đánh dấu khi devicesAdd trả về ngon lành. Nằm sau `await` trong khối `try` là đủ: ném
  // lỗi thì nhảy thẳng xuống `catch`, dòng vẫn còn nút "+ Thêm" để bấm lại.
  const viTriAwait = kA.indexOf('await window.api.devicesAdd');
  const viTriDanh = kA.indexOf('danhDauDaThem(serial)');
  check('12e. Đánh dấu SAU khi thêm thành công, không phải trước',
    viTriAwait >= 0 && viTriDanh > viTriAwait);
}

// ── 13. Cú trượt vì hết trần chờ phải ĐẾM ĐƯỢC ──
// Chủ dự án nhìn app quét và hỏi thẳng: "nhanh thế liệu đã ổn chưa". Trước 2026-09-17 câu đó
// KHÔNG trả lời được bằng log: hạ `WAIT_MUSIC_PAGE` 15→8s và đổi `SETTLE` sang trần 1,2s đều có
// thể đánh rơi sound thật, mà cú trượt vì hết giờ đọc số post trông y hệt một sound bị lọc loại.
// Hướng sai là an toàn (bỏ sót chứ không lấy nhầm) nhưng vô hình thì không ai chỉnh được nhịp.
{
  const py = doc('scan_feed_sounds.py');
  check('13. Có bộ đếm cú trượt vì hết trần chờ', /TRUOT = \{/.test(py));
  check('13b. Đếm đủ ba chỗ trượt',
    /TRUOT\["khong_icon"\] \+= 1/.test(py)
    && /TRUOT\["khong_vao_trang_nhac"\] \+= 1/.test(py)
    && /TRUOT\["het_gio_doc_so_post"\] \+= 1/.test(py));

  // Đây là cái vô hình nhất trong ba: hết trần đọc số post thì video bị loại y như bị lọc.
  check('13c. Hết giờ đọc số post có nói ra, không im lặng',
    /số video chưa hiện sau \{SETTLE:\.1f\}s/.test(py));
  check('13d. Tổng kết in hai số trượt kèm tổng số video',
    /Trượt vì hết giờ chờ/.test(py) && /trên tổng \{count\} video/.test(py));
}

// ── 14. Ghé thăm phải THẬT SỰ vào trang, không phải vuốt một cái rồi về ──
// SỰ CỐ THẬT (2026-09-17): chủ dự án nhìn màn hình và báo "ghé thăm chưa được 2 giây, vừa kéo
// sang một cái là nó đã quay lại feed". Hai lỗi nối nhau:
//   1. `_mo_trang_ca_nhan` trả True NGAY khi vừa nhả tay, không kiểm gì. Trang cá nhân mất gần
//      một giây mới dựng xong.
//   2. `do_visit` dò lưới hụt lần đầu là bấm `back` luôn — mà lần dò đó rơi đúng lúc trang còn
//      đang mở, nên cú `back` không bỏ tấm che nào cả, nó đưa máy VỀ FEED.
// Từ đó mọi thao tác sau đều sai chỗ: vòng "lướt xem trang" cuộn chính cái feed, và kết quả
// luôn là `ok_no_grid`. Hai lỗi phải sửa cùng nhau.
{
  const pa = doc('phone_actions.py');

  const khoiMo = /def _mo_trang_ca_nhan\(d\)[\s\S]*?\n(?=def )/.exec(pa);
  check('14. Có _mo_trang_ca_nhan', !!khoiMo);
  const kM = khoiMo ? khoiMo[0] : '';
  check('14b. Mở trang xong phải xác nhận đã rời feed, không trả True suông',
    /if not _o_tren_feed\(d\):\s*\n\s*return True/.test(kM)
    && !/d\.touch\.up\(x2, y\)\s*\n\s*return True/.test(kM));

  const khoiVisit = /def do_visit\([\s\S]*?\n(?=def )/.exec(pa);
  check('14c. Có do_visit', !!khoiVisit);
  const kV = khoiVisit ? khoiVisit[0] : '';

  // Cú `back` phải nấp sau MỐC THỜI GIAN, không bắn ở lần dò hụt đầu tiên.
  check('14d. Chỉ back khi đã chờ gần hết giờ, không back ngay lần dò hụt đầu',
    /if not da_back and time\.time\(\) > het - 3\.0:/.test(kV)
    && !/if not da_back:\s*\n\s*da_back = True\s*\n\s*#[\s\S]{0,200}?d\.press\("back"\)/.test(kV));

  // Thấy mình đang ở feed thì bỏ lượt, KHÔNG back thêm — back nữa là đi xa hơn khỏi chỗ cần đến.
  // Từ 2026-09-17 mọi đường thoát đi qua `_xong` để in ra số giây THẬT của lượt ghé, nên phép
  // thử khớp theo `_xong(...)` chứ không theo bộ đôi trần trụi nữa.
  check('14e. Rơi về feed giữa chừng thì bỏ lượt, không back tiếp',
    /if _o_tren_feed\(d\):[\s\S]{0,220}?return _xong\("fail", "not_needed"/.test(kV));

  // Vòng lướt trang phải kéo từng điểm. `d.swipe` đã đo được là TikTok không nhận ra là cử chỉ,
  // nên để nguyên thì 5-10 giây "lướt xem" là 5-10 giây trang đứng yên.
  check('14f. Lướt trang kéo từng điểm, không dùng d.swipe', /_keo_doc\(d\)/.test(kV)
    && !/d\.swipe\(0\.5, 0\.75/.test(kV));
  check('14g. _keo_doc bơm sự kiện từng điểm như _mo_trang_ca_nhan',
    /def _keo_doc\(/.test(pa)
    && /def _keo_doc\([\s\S]*?d\.touch\.down\([\s\S]*?d\.touch\.move\([\s\S]*?d\.touch\.up\(/.test(pa));
}

// ── 15. Ghé thăm: đo giờ thật, đọc @handle một chỗ, hỏi sổ trước khi lướt ──
// SỰ CỐ THẬT (2026-09-17): log báo `ghé=ok` và trần `visitMaxUsers` trừ một suất, trong khi chủ
// dự án nhìn màn hình thấy lượt ghé chưa được 2 giây. Cả hai thứ cùng nói dối một lúc, và không
// có số nào trong log đủ để phát hiện — vì không chỗ nào đo thời gian thật.
{
  const pa = doc('phone_actions.py');
  const py = doc('scan_feed_sounds.py');

  const kV = (/def do_visit\([\s\S]*?\n(?=def )/.exec(pa) || [''])[0];

  check('15. Lượt ghé bấm giờ từ trước khi vuốt', /t_ghe = time\.time\(\)/.test(kV));
  check('15b. Mọi đường thoát in ra số giây thật',
    /def _xong\(/.test(kV) && /time\.time\(\) - t_ghe/.test(kV));
  // Nếu còn một `return ("...", "...")` trần trụi nào sau khi đã bấm giờ thì đường đó im lặng.
  {
    const sauKhiBamGio = kV.slice(kV.indexOf('t_ghe = time.time()'));
    const tran = sauKhiBamGio.match(/\n\s+return \("[a-z_]+", "[a-z_]+"\)/g) || [];
    check('15c. Không còn đường thoát nào bỏ qua phép đo', tran.length === 0,
      tran.length ? tran.join(' | ') : 'sạch');
  }

  check('15d. Hỏi sổ TRƯỚC khi lướt trang',
    kV.indexOf('hoi_o_lai(h)') > 0 && kV.indexOf('hoi_o_lai(h)') < kV.indexOf('_keo_doc(d)'));
  check('15e. Bỏ qua vì trùng trả về mã riêng, không lẫn với ghé thật',
    /return _xong\("skip_trung"/.test(kV));

  // MỘT nơi đọc @handle. Hai nơi tự đọc lấy là có ngày một nơi sửa còn nơi kia quên — đúng bài
  // học `linkkey.cjs`, thứ đã làm bộ lọc Original Sound hỏng câm ở bản phone.
  //
  // ⚠ 15g là hàng rào CHẶN TRƯỚC, không phải phép kiểm bản sửa: bản cũ cũng chỉ có một vòng dò.
  // Nó đỏ vào đúng ngày ai đó (kể cả tôi) chép thêm một vòng thứ hai vào `do_visit` cho tiện.
  check('15f. Có hàm đọc @handle dùng chung', /def doc_handle_tren_trang\(/.test(pa));
  {
    const soVongDoc = (pa.match(/if _RE_HANDLE\.match\(t\):/g) || []).length;
    check('15g. Chỉ MỘT vòng dò @handle trong cả file', soVongDoc === 1, `thấy ${soVongDoc}`);
  }
  check('15h. open_profile_read_handle dùng lại đúng hàm đó',
    /def open_profile_read_handle\([\s\S]*?doc_handle_tren_trang\(d, timeout\)/.test(pa));

  // Phán xét nằm ở Node. Python chỉ gửi câu hỏi và thi hành — luật mở đầu `askproto.cjs`.
  check('15i. Nhịp hỏi visit_check gửi từ Python, không tự quyết',
    /bridge\.ask\(kind="visit_check", handle=handle\)/.test(py));
  check('15j. Python KHÔNG giữ bản sao sổ ghé thăm',
    !/visited_channels|visitbook|visitSkipDays/i.test(py + pa));
}

// ── 16. Log phải đọc được: tiếng Việt đủ dấu, không lộ giá trị nội bộ, không lặp ──
// SỰ CỐ THẬT (2026-09-18): chủ dự án gửi ảnh chụp log kèm câu "bạn log cái gì vậy tôi nhìn khó
// hiểu quá — mọi thứ phải follow theo giống app của PC". Ba bệnh cùng lúc: 58/58 dòng Python
// không dấu; dòng `[tương tác] follow=skip_changed_video tym=skip_changed_video ...` in thẳng
// giá trị nội bộ; và một dòng lặp 20 lần liền mạch đủ đẩy mọi thứ đáng đọc ra khỏi bộ đệm.
{
  const py = doc('scan_feed_sounds.py');
  const pa = doc('phone_actions.py');
  const ab = doc('askbridge.py');
  const rn = doc('src/runner.cjs');

  // ── 16a. Mọi chuỗi log Python phải có dấu ──
  // Quét chính các lời gọi log, không quét cả file (chú thích thì không sao).
  {
    const xau = [];
    for (const [ten, ma] of [['scan_feed_sounds.py', py], ['phone_actions.py', pa], ['askbridge.py', ab]]) {
      const re = /(?:^|[^\w.])(?:log|log_han_che|self\._log)\(([\s\S]{0,260}?)\)\n/g;
      let m;
      while ((m = re.exec(ma))) {
        const t = m[1];
        // Bỏ qua lời gọi chỉ truyền biến/khoá, không có chuỗi chữ nào.
        if (!/["']/.test(t)) continue;
        // Lời gọi hạn chế có dạng `log_han_che(<khoá>, <thông điệp>)`. Khoá là MÃ, cố ý không
        // dấu; chỉ xét phần thông điệp. Khoá có thể là chuỗi, hoặc ghép chuỗi với biến.
        const phanChu = t.replace(/^\s*"[a-z_]+"(\s*\+\s*\w+)?\s*,/, '');
        // Thông điệp là một biến (đã dựng sẵn bằng tiếng Việt ở trên) thì không có gì để xét.
        if (/^\s*\w+\s*$/.test(phanChu)) continue;
        if (!/[^\x00-\x7F]/.test(phanChu)) {
          xau.push(`${ten}: ${phanChu.replace(/\s+/g, ' ').slice(0, 70)}`);
        }
      }
    }
    check('16a. Mọi dòng log Python đều có dấu tiếng Việt', xau.length === 0,
      xau.length ? xau.slice(0, 4).join(' || ') : 'sạch');
  }

  // ── 16b. Không lộ giá trị nội bộ ra màn hình ──
  // Bản PC có cả tá mã nội bộ ('nav', 'nofeed', 'same', 'empty') mà KHÔNG mã nào lọt ra log —
  // đều dịch tại chỗ gọi. Đây là hàng rào giữ cho bản phone cũng vậy.
  {
    const MA = ['skip_changed_video', 'ok_no_grid', 'ok_unverified', 'skip_trung', 'not_needed'];
    // Chỉ soi các dòng THẬT SỰ in ra: `log(...)`, `say(...)`, `line:`.
    const dongIn = [];
    for (const ma of [py, pa, rn]) {
      const re = /(?:log|log_han_che|self\._log|say)\(([\s\S]{0,260}?)\)\n|line:\s*(`[^`]*`)/g;
      let m;
      while ((m = re.exec(ma))) dongIn.push(m[1] || m[2] || '');
    }
    const lo = [];
    for (const d of dongIn) {
      for (const ma of MA) {
        // `${ten}` hay `${v}` thì không sao — chỉ báo khi CHÍNH chuỗi mã nằm trong dòng in.
        if (d.includes(`'${ma}'`) || d.includes(`"${ma}"`) || new RegExp(`[=\s]${ma}\b`).test(d)) {
          lo.push(`${ma}: ${d.replace(/\s+/g, ' ').slice(0, 60)}`);
        }
      }
    }
    // ⚠ 16b là hàng rào CHẶN TRƯỚC: bản cũ cũng xanh ở đây, vì nó rò bằng cách NỘI SUY BIẾN
    // (`follow=${payload.follow}`) chứ không viết thẳng chuỗi. 16b1 ngay dưới mới là phép thử
    // bắt đúng hình dạng đã hỏng thật.
    check('16b. Không dòng log nào viết thẳng giá trị nội bộ', lo.length === 0,
      lo.length ? lo.slice(0, 3).join(' || ') : 'sạch');

    // Hình dạng ĐÃ HỎNG THẬT: nhét thẳng trường kết quả vào dòng log, không qua bảng dịch.
    // Chính nó đẻ ra `[tương tác] follow=skip_changed_video tym=skip_changed_video ...`.
    {
      const noiSuy = (rn.match(/line:[^\n]*\$\{payload\.(follow|like|like_profile|visit|ni|why)\b/g) || [])
        .concat(rn.match(/phan\.push\(`[^`]*\$\{payload\.\w+\}/g) || []);
      check('16b1. runner KHÔNG nội suy thẳng trường kết quả vào dòng log',
        noiSuy.length === 0, noiSuy.length ? noiSuy.slice(0, 3).join(' || ') : 'sạch');
    }

    // Bảng dịch phải tồn tại, nếu không thì 16b xanh vì chẳng in gì cả.
    check('16b2. Có bảng dịch kết quả tương tác sang tiếng Việt',
      /const KET_QUA_TUONG_TAC = \{/.test(rn) && /const VIEC_TUONG_TAC = \{/.test(rn));
    check('16b3. Có bảng dịch lý do bấm Not interested', /_VI_SAO_NI = \{/.test(py));
    check('16b4. Có bảng dịch kết quả ghé thăm', /_KQ_GHE = \{/.test(pa));
  }

  // ── 16c. Chặn dòng lặp ở NGUỒN ──
  check('16c. Có bộ chặn dòng lặp', /def log_han_che\(khoa, msg\)/.test(py) && /LAP_TOI_DA = 3/.test(py));
  check('16c2. Bộ đếm vẫn chạy sau khi ngừng in — tổng không mất',
    /_DEM_LAP\[khoa\] = n/.test(py) && /if n <= LAP_TOI_DA/.test(py));
  // Dòng "không có icon sound" từng lặp 20 lần liền mạch. Chủ dự án chốt bỏ hẳn.
  // Soi ĐÚNG nhánh "video này không có icon sound": nó chỉ được tăng bộ đếm, không được in gì.
  // Bắt theo chữ thì đỏ oan — chú thích trong mã vẫn nhắc tới cụm đó để giải thích, và còn một
  // dòng log HỢP LỆ khác cũng chứa chữ "icon sound" ("bấm icon sound nhưng trang nhạc không mở").
  {
    const nhanh = /if icon is None:([\s\S]{0,700}?)return \(None, False\)/.exec(py);
    check('16c3. Nhánh "không có icon sound" chỉ đếm, không in dòng nào',
      !!nhanh && !/(?:^|[^\w.])log(?:_han_che)?\(/.test(nhanh[1]),
      nhanh ? 'tìm thấy nhánh' : 'KHÔNG tìm thấy nhánh');
  }

  // ── 16d. Nhịp tim: im lặng không được phép mơ hồ ──
  // Bản PC có dòng này vì người dùng từng thấy "0 sound" suốt 3 tiếng mà không biết feed còn
  // chạy hay đã kẹt.
  check('16d. Có nhịp tim theo số video', /NHIP_TIM = \d+/.test(py) && /Lướt \{_n\} video/.test(py));
  check('16d2. Nhịp tim in ĐỘ CHÊNH và đặt lại mốc',
    /count - moc\["count"\] >= NHIP_TIM/.test(py) && /moc = \{"count": count/.test(py));

  // ── 16e. "Đã quét N sound..." chỉ in khi con số THẬT SỰ tăng ──
  // Quy tắc bản PC: chặn lặp ở nguồn chứ không lọc ở đích, nhờ vậy không bao giờ có hai dòng
  // giống hệt nhau liền nhau.
  {
    const khoiDat = /qualified \+= 1[\s\S]{0,400}?\n\n/.exec(py);
    check('16e. Dòng "Đã quét N sound" nằm ngay sau chỗ tăng bộ đếm',
      !!khoiDat && /Đã quét \{qualified\} sound\.\.\./.test(khoiDat[0]));
    check('16e2. Và KHÔNG in ở chỗ nào khác',
      (py.match(/Đã quét \{qualified\} sound/g) || []).length === 1);
  }

  // ── 16f. Mỗi kết quả chỉ vào log MỘT lần ──
  // Bản cũ: Python `log()` rồi `emit_event`, và runner biến sự kiện thành một dòng nữa.
  check('16f. runner KHÔNG in lại kết quả sound (Python đã in)',
    !/kind: 'log', line: `DAT/.test(rn) && !/line: `LOAI/.test(rn));

  // ── 16g. Đóng dấu giờ ở ĐÚNG MỘT chỗ ──
  check('16g. Python không tự đóng dấu giờ', !/strftime\('%H:%M:%S'\)/.test(py));
  check('16g2. Renderer đóng dấu giờ cho mọi dòng',
    /toLocaleTimeString\('vi-VN', \{ hour12: false \}\)/.test(rend) && /line = `\[\$\{gio\}\] \$\{line\}`/.test(rend));

  // ── 16h. Phép kiểm "video có đổi không" chỉ chạy khi ĐÃ rời feed ──
  // Video không có icon sound thì máy chưa đi đâu cả — kiểm ở đó vừa vô nghĩa vừa in ra một câu
  // sai, và tệ hơn: nó chặn luôn mọi tương tác.
  check('16h. Chỉ kiểm khi đã rời feed', /if da_roi_feed and \(ans\.get\("ni"\)/.test(py));
  check('16h2. check_current_video nói cho nơi gọi biết có rời feed hay không',
    /return \(None, False\)/.test(py) && /return \(None, True\)/.test(py) && /return \(result, True\)/.test(py));
  check('16h3. Nơi gọi nhận đủ cặp', /res, da_roi_feed = check_current_video\(d\)/.test(py));
}

// ── 17. Dòng "tương tác" phải đọc được, và im khi không có gì để nói ──
// Đây là dòng chủ dự án nhìn thấy nhiều nhất trong một ca. Bản cũ in
//     [tương tác] follow=skip_changed_video tym=skip_changed_video ghé=skip_changed_video ...
// — 90 ký tự chỉ để nói "không làm gì cả", lặp ở mọi video. Phép thử này gọi hàm THẬT.
{
  const { kePhanTuongTac: ke } = require(path.join(R, 'src', 'runner.cjs'));

  check('17. Không xin quyền gì -> im hẳn',
    ke({ follow: 'not_needed', like: 'not_needed', visit: 'not_needed',
         like_profile: 'not_needed', ni: 'skip' }) === '');

  // Lượt bỏ vì không xác minh được video: Python đã in một câu đầy đủ giải thích vì sao.
  check('17b. Bỏ lượt thì KHÔNG nói lại lần nữa',
    ke({ follow: 'skip_changed_video', like: 'skip_changed_video', visit: 'skip_changed_video',
         like_profile: 'skip_changed_video', ni: 'skip_changed_video' }) === '');

  check('17c. Tym hai chỗ -> một câu tiếng Việt',
    ke({ like: 'ok', like_profile: 'ok' }) === 'Tym xong · Tym video trong trang xong.');

  // `do_visit` bên Python đã in kèm SỐ GIÂY THẬT. Kể lại ở đây là nói hai lần.
  check('17d. Ghé trang KHÔNG kể lại (Python đã in kèm số giây)',
    ke({ visit: 'ok', like: 'not_needed' }) === '' && ke({ visit: 'ok_no_grid' }) === '');

  check('17e. Việc hỏng có dấu cảnh báo', ke({ like: 'fail' }) === '⚠ Tym hỏng.');
  check('17f. Follow bị bật lại là cảnh báo', ke({ follow: 'reverted' }) === '⚠ Follow bị TikTok bật lại.');

  // ⚠ Hàng rào quan trọng nhất: giá trị lạ thì BỎ QUA, không in ra dưới dạng mã. Bản cũ in thẳng
  // bất cứ thứ gì nhận được, nên chỉ cần phía Python thêm một giá trị mới là nó hiện ngay ra màn
  // hình — đúng cách `skip_changed_video` lọt ra.
  check('17g. Giá trị lạ thì bỏ qua, không bày mã ra màn hình',
    ke({ like: 'mot_gia_tri_chua_tung_co' }) === '');
}

// ── 18. Lọc trùng link phải chạy CHO MỌI MÁY, và chạy cả khi tắt Google Sheet ──
// SỰ CỐ THẬT (2026-09-18): chủ dự án chụp màn hình bảng kết quả có hai dòng "thật huy" trùng
// nhau — cùng link `original-sound-7633696888679598855`, cùng 13.900 post, chỉ khác máy.
// Bản cũ chỉ lọc trùng ở đường ĐẨY LÊN SHEET, nên ba lỗ hổng cùng lúc: tắt Sheet là mất hẳn bộ
// lọc; bảng trên màn hình không lọc gì cả; và tắt app mở lại là quên sạch link đã thu.
{
  const mj = doc('main.js');

  check('18. Có kho link cục bộ (chép từ bản PC)', /require\('\.\/src\/linkstore\.cjs'\)/.test(mj));
  check('18b. Nạp kho ngay khi mở app, trước khi máy nào kịp quét',
    /linkstore\.ensureFile\(\)[\s\S]{0,200}?linkstore\.load\(true\)/.test(mj));

  // Lọc PHẢI nằm trước `sendToRenderer('crawl-data'...)`, nếu không bảng vẫn bày link trùng.
  {
    const kA = mj.indexOf('linkstore.load().has(khoa)');
    const kB = mj.indexOf("sendToRenderer('crawl-data'");
    check('18c. Lọc trùng TRƯỚC khi gửi lên màn hình', kA > 0 && kB > 0 && kA < kB,
      `lọc ở ${kA}, gửi ở ${kB}`);
  }

  // Không được nấp sau `sheets.isEnabled()` — tắt Sheet thì vẫn phải lọc.
  // (2026-09-18: khối lọc dời ra hàm riêng `quaCongLocTrung` để kết quả về lúc đang nạp Sheet
  // được giữ lại rồi mới cho qua — xem mục 19.)
  {
    const khoiData = /function quaCongLocTrung\(deviceId, data\) \{[\s\S]*?\n\}/.exec(mj);
    const kD = khoiData ? khoiData[0] : '';
    const viTriLoc = kD.indexOf('linkstore.load().has(khoa)');
    const viTriSheet = kD.indexOf('sheets.isEnabled()');
    check('18d. Lọc trùng KHÔNG phụ thuộc Google Sheet',
      viTriLoc > 0 && (viTriSheet < 0 || viTriLoc < viTriSheet));
    check('18e. Link mới được ghi vào kho để lần sau còn nhớ', /linkstore\.addUrls\(\[data\.url\]\)/.test(kD));
  }

  // Khoá so trùng phải là ĐÚNG hàm mà kho link và đường đẩy Sheet dùng — ba nơi tự chuẩn hoá
  // theo cách riêng là có ngày lệch nhau (QĐ-10).
  check('18f. Dùng chung normalizeKey với kho link và Sheet',
    /const \{ normalizeKey \} = require\('\.\/src\/linkkey\.cjs'\)/.test(mj)
    && /normalizeKey\(data\.url/.test(mj));

  // Link đọc từ Sheet cũng phải vào kho, nếu không lần mở app sau lại phải chờ đọc Sheet.
  check('18g. Link đọc từ Sheet cũng ghi vào kho cục bộ', /linkstore\.addUrls\(links\)/.test(mj));

  // `linkstore.cjs` là module DÙNG CHUNG với bản PC — `srcsync` khoá nó từng byte.
  check('18h. linkstore nằm trong danh sách module dùng chung',
    /'linkstore\.cjs'/.test(doc('tests/srcsync.test.cjs')));
}

// ── 19. Máy ma + đọc Sheet (2026-09-18) ──
// Phần HÀNH VI (xoá lúc nghỉ, giữ kết quả lúc nạp Sheet, bấm Chạy hai lần, Dừng tất cả, dừng lúc
// chờ giãn cách) được `tests/mainflow.test.cjs` chạy thật. Ở đây chỉ canh những chỗ phép thử đó
// không với tới: runner THẬT, vòng đồng bộ 5 phút, và giao diện.
{
  const mj = doc('main.js');
  const rn = doc('src/runner.cjs');
  const rj = doc('renderer/renderer.js');

  // Chặn theo id không đủ: xoá rồi thêm lại một máy là hai id cho cùng một serial.
  check('19a. Runner từ chối tiến trình thứ hai trên cùng một điện thoại',
    /for \(const \[khac, e\] of _active\)[\s\S]{0,80}e\.serial === serial[\s\S]{0,40}throw/.test(rn));

  const khoiDong = /_reseedTimer = setInterval\(async \(\) => \{[\s\S]*?\n  \}, phut \* 60 \* 1000\);/.exec(mj);
  const dongBo = khoiDong ? khoiDong[0] : '';
  // Gốc của "call data từ Google Sheet lên chưa tốt": vòng đồng bộ cũ chỉ ghi cổng đẩy, còn cổng
  // hiển thị hỏi kho cục bộ — link máy khác vừa đẩy lên không bao giờ tới được cổng hiển thị.
  check('19b. Vòng đồng bộ Sheet ghi vào KHO LINK (cổng hiển thị hỏi kho này)',
    /napVaoBoLoc\(links\)/.test(dongBo)
    && /function napVaoBoLoc[\s\S]{0,200}linkstore\.addUrls\(links\)/.test(mj));
  check('19c. Vòng đồng bộ đọc TĂNG DẦN (Sheet lớn không bị tải trọn mỗi 5 phút)',
    /readLinks\([^)]*\{ fromRow: from \}\)/.test(dongBo) && /_sheetNextRow = links\.nextRow/.test(dongBo));
  check('19d. Lỗi đồng bộ Sheet được BÁO RA, không nuốt im lặng',
    /catch \(e\) \{[\s\S]{0,400}sendToRenderer\('crawl-status'[\s\S]{0,80}sheet-error/.test(dongBo)
    && !/catch \(_\) \{ \/\* thử lại vòng sau \*\/ \}/.test(mj));
  check('19e. Link đẩy lên Sheet xong được ghi ngược vào kho (setOnPushed)',
    /sheets\.setOnPushed\(\(urls\) => \{[^}]*linkstore\.addUrls\(urls\)/.test(mj));
  check('19f. Nạp Sheet KHÔNG chặn máy khởi động (bài học QĐ-09)',
    /if \(sheets\.isEnabled\(\)\) napSheetDauPhien\(cfg\);/.test(mj)
    && !/await (seedKnownLinks|napSheetDauPhien)/.test(mj));
  check('19g. Nút Xoá đi qua cùng đường dọn dẹp với nút Dừng',
    /'devices-delete'[\s\S]{0,700}dungHan\(data\.id\)/.test(mj)
    && /function dungHan[\s\S]{0,200}huyNghi\(deviceId\)[\s\S]{0,60}_lastParams\.delete\(deviceId\)[\s\S]{0,260}devslot\.cancel\(deviceId\)/.test(mj));

  // Giao diện: hai trạng thái bản cũ vẽ thành "Đã dừng".
  check('19h. Giao diện nhận trạng thái XẾP HÀNG và NGHỈ',
    /state === 'queued'\) \{ st\.status = 'queue'/.test(rj) && /state === 'resting'\) \{\s*st\.status = 'rest'/.test(rj));
  check('19i. Máy xếp hàng / đang nghỉ / đang chờ nối lại / đang khởi động lại hiện nút Dừng, không hiện nút Chạy',
    /TRANG_THAI_BAN = new Set\(\['run', 'queue', 'rest', 'offline', 'reboot'\]\)/.test(rj)
    && /dangBan\(id\) \? stopDeviceById\(id\) : startDeviceById\(id\)/.test(rj));
  check('19j. "Chạy đã chọn" bỏ qua máy đang bận',
    /ids\.filter\(\(id\) => !dangBan\(id\)\)\.forEach\(startDeviceById\)/.test(rj));
  check('19k. Kết quả của máy đã xoá ghi rõ "máy đã xoá", không để mã trần',
    /máy đã xoá \(\$\{deviceId\}\)/.test(rj) && /máy đã xoá \(\$\{deviceId\}\)/.test(mj));
}

// ── 20. Những chỗ bản phone lệch bản PC (2026-09-18) ──
{
  const rn = doc('src/runner.cjs');
  const rj = doc('renderer/renderer.js');
  const html = doc('renderer/index.html');
  const mj = doc('main.js');
  const py = doc('scan_feed_sounds.py');

  // 3a — không thu sound khớp bộ lọc.
  check('20a. Kết quả ĐẠT phải qua cổng ngôn ngữ trước khi lên bảng',
    /\} else if \(brain\.choThu\(tieuDe\)\) \{[\s\S]{0,300}?onData\(deviceId/.test(rn));
  check('20b. Có ô "Không thu sound" trong Cài đặt, đọc và ghi đủ',
    /id="cfgNiBlockCollect"/.test(html)
    && /\$\('cfgNiBlockCollect'\)\.checked = base\.niBlockCollect !== false/.test(rj)
    && /niBlockCollect: document\.getElementById\('cfgNiBlockCollect'\)\.checked/.test(rj));
  check('20c. Dòng hướng dẫn KHÔNG còn nói điều mã không làm',
    !/Tắt cả hai thì app vẫn nhận diện và vẫn BỎ QUA sound/.test(html));
  check('20d. Nâng cấp cấu hình đã lưu MỘT lần, có báo ra',
    /const daNang = nangCapLocNgonNgu\(\);[\s\S]{0,200}storeSet[\s\S]{0,120}toast\(/.test(rj)
    && /niScriptsV2: true,/.test(rj));

  // 3b — biên số post, số thập phân, cài đặt mới tới máy đang chạy.
  check('20e. Biên số post gồm cả hai đầu, max = 0 là không giới hạn (như bản PC)',
    /posts >= MIN_POSTS and \(MAX_POSTS <= 0 or posts <= MAX_POSTS\)/.test(py)
    && !/MIN_POSTS < posts < MAX_POSTS/.test(py));
  check('20f. Số lẻ không làm Python chết lúc khởi động',
    /MIN_POSTS = int\(float\(/.test(py) && /MAX_POSTS = int\(float\(/.test(py)
    && /limit = int\(float\(/.test(py) && /MIN_POSTS: soNguyen\(minPosts/.test(rn));
  check('20g. Lưu cài đặt đẩy xuống máy đang bận',
    /await window\.api\.deviceUpdateParams\(paramsFor\(d\)\)/.test(rj)
    && /'device-update-params'[\s\S]{0,300}_lastParams\.has\(id\)[\s\S]{0,120}_lastParams\.set\(id/.test(mj));
  check('20h. Nút Chạy và nút Lưu dựng tham số ở MỘT chỗ',
    /window\.api\.deviceStart\(paramsFor\(d\)\)/.test(rj));
}

// ── 21. Quét ⇄ Xem (2026-09-18) ──
// Hành vi được `mainflow.test.cjs` (phía Node) và `viewphase.test.cjs` (vòng lặp Python) chạy
// thật. Ở đây canh phần nối dây giữa chúng: runner → biến môi trường → Python → điện thoại.
{
  const rn = doc('src/runner.cjs');
  const mj = doc('main.js');
  const rj = doc('renderer/renderer.js');
  const html = doc('renderer/index.html');
  const py = doc('scan_feed_sounds.py');
  const pa = doc('phone_actions.py');

  check('21a. Chia pha bằng ĐÚNG phaseplan.cjs của bản PC, không tự chia',
    /phaseplan\.buildPhasePlan\('cycle', \{/.test(mj) && /require\('\.\/src\/phaseplan\.cjs'\)/.test(mj));
  // 2026-09-24: pha Tìm (chế độ Tìm từ khóa ⇄ For You) cũng đi đường chu kỳ — mọi pha trừ Xem.
  check('21b. Pha Xem chạy Python ở chế độ xem, pha Quét và pha Tìm đi đường "chạy theo chu kỳ" có sẵn',
    /MODE: phaXem \? 'view' : 'scan'/.test(rn)
    && /CYCLE_ON: \(pha \? pha\.key !== 'view' : cfg\.cycleOn\)/.test(rn)
    && /CYCLE_SCAN_MIN: String\(pha && pha\.key !== 'view' \? pha\.ms \/ 60000/.test(rn));
  check('21c. Danh sách link đi qua TỆP (khối biến môi trường Windows có trần ~32K ký tự)',
    /VIEW_LINKS_FILE: phaXem \? ghiDanhSachLink\(deviceId, pha\.links\)/.test(rn));
  check('21d. Ghé thăm TẮT trong Quét ⇄ Xem (clone QĐ-47/48 — ghé thăm là phần của Quét Mix)',
    /const cfg = pha \? Object\.assign\(\{\}, params\.cfg \|\| \{\}, \{ visitOn: false \}\)/.test(rn));
  check('21e. Pha Xem không bật kênh hỏi/đáp (không thu, không bấm gì)',
    /ASK_ON: \(!phaXem && /.test(rn));
  check('21f. Mốc xem tiếp: runner chuyển tiếp, main ghi xuống đĩa',
    /payload\.type === 'view_moc'/.test(rn) && /status\.kind === 'view' && status\.moc\) ghiMoc\(/.test(mj));
  check('21g. Chỉ hẹn chạy lại khi tiến trình ĐÃ ĐÓNG (không hẹn ở "done")',
    /status\.state === 'stopped' && _cycleDone\.delete\(deviceId\)/.test(mj)
    && !/_cycleDone\.delete\(deviceId\) && status\.state !== 'error'/.test(mj));
  check('21h. Python rẽ sang pha Xem theo MODE', /if MODE == "view":\s*\n\s*chay_pha_xem\(d, pkg\)/.test(py));
  check('21i. Pha Xem vẫn canh được app đã đóng dù tắt kênh hỏi/đáp',
    /def chay_pha_xem[\s\S]{0,1600}canh = AskBridge\(enabled=True/.test(py));
  check('21j. Lưới trang nhạc dùng lại `_o_luoi_video` (neo `cover`, lọc bằng hình học)',
    /def _cho_luoi[\s\S]{0,200}_o_luoi_video\(d\)/.test(pa));
  check('21k. Deep link truyền dạng DANH SÁCH (link có & và ? không bị shell cắt)',
    /d\.shell\(\["am", "start", "-a", "android\.intent\.action\.VIEW", "-d", link, goi\]\)/.test(pa));
  check('21l. Có ô Chế độ, đổi chế độ thì ẩn/hiện đúng khối',
    /id="cfgMode"/.test(html) && /getElementById\('cfgMode'\)\.addEventListener\('change', apCheDo\)/.test(rj));
  check('21m. Bảng thiết bị nói rõ đang ở pha nào',
    /`Xem link \$\{st\.viewIdx \+ 1\}\/\$\{st\.viewTotal\}`/.test(rj) && /`Quét \$\{gioPhut\(/.test(rj));
}

// ── 22. Luật "Chỉ lấy Original Sound" = luật bản PC (2026-09-18) ──
// Phần KHỚP NHAU giữa Python và bản PC được `tests/goc.test.cjs` chạy thật trên 20 mẫu. Ở đây
// canh các mắt xích nối dây.
{
  const rn = doc('src/runner.cjs');
  const py = doc('scan_feed_sounds.py');

  check('22a. Nhãn original sound dựng TỪ linkkey.cjs rồi truyền xuống Python',
    /RE_GOC_SLUG = _reNhanDau\(linkkey\.ORIGINAL_SOUND_LABELS/.test(rn) && /\n\s*RE_GOC_SLUG,\s*\n\s*RE_GOC_TEN,/.test(rn));
  // Soi MÃ chứ không soi chú thích: chú thích giải thích lý do sửa có nhắc tên cũ, và nên nhắc.
  check('22b. Python KHÔNG còn danh sách chữ cứng "Contains:" / "Bao gồm"',
    !/^REJECT_KEYWORDS\s*=|\bin REJECT_KEYWORDS\b/m.test(py));
  check('22c. Python KHÔNG còn tự dựng link original-sound cho mọi sound (lỗi gắn nhầm nhạc bản quyền)',
    !/def canonical_from_url/.test(py) && !/def get_link\(/.test(py));
  check('22d. Sound đạt số post được lấy LINK THẬT rồi mới xét Original Sound',
    /url_that = lay_link_that\(d\)[\s\S]{0,900}goc = la_sound_goc\(url_that, tieu_de\)/.test(py));
  check('22e. Node chốt lần cuối bằng ĐÚNG hàm của bản PC, rồi mới rút gọn link',
    /!linkkey\.isOriginalSound\(url, tieuDe\)/.test(rn) && /url: linkkey\.canonicalSoundUrl\(url\)/.test(rn));
  check('22f. Không có link thật thì KHÔNG gắn nhãn original-sound cho sound chưa xác nhận',
    /\{'original-sound' if goc else 'sound'\}-\{mid\}/.test(py));
  check('22g. Sound bị bỏ vì không phải Original Sound được ĐẾM và in ở tổng kết',
    /DEM\["khong_goc"\] \+= 1/.test(py) && /không phải Original Sound"\)/.test(py));
}

// ── 23. Google Sheet: Service Account, kho link cục bộ, tab Pending (2026-09-18) ──
// Hành vi do `mainflow.test.cjs` mục M và `sheetsa.test.cjs` chạy thật. Ở đây canh nối dây.
{
  const mj = doc('main.js');
  const rn = doc('src/runner.cjs');
  const rj = doc('renderer/renderer.js');
  const html = doc('renderer/index.html');
  const pl = doc('preload.cjs');
  const py = doc('scan_feed_sounds.py');

  // Lỗi v0.1.8: gọi sheets.cjs với Service Account dạng CHUỖI. Không chỗ nào được đọc thẳng
  // `store.get('sheets_config')` rồi đưa cho sheets.cjs — phải đi qua `docCauHinhSheet()`.
  check('23a. Mọi chỗ đọc cấu hình Sheet đều đi qua bước đổi Service Account',
    (mj.match(/store\.get\('sheets_config'\)/g) || []).length === 2   // docCauHinhSheet + 'sheets-get-config'
    && /function docCauHinhSheet\(\) \{ return cauHinhSheet\(store\.get\('sheets_config'\)/.test(mj)
    && /'sheets-get-config', \(\) => store\.get\('sheets_config'\)/.test(mj));
  check('23b. "Test kết nối" đổi Service Account trước khi gọi sheets.cjs',
    /'sheets-test', async \(_e, raw\) => \{\s*\n[^\n]*\n\s*const \{ cfg, loiSa \} = cauHinhSheet\(raw\);/.test(mj));
  check('23c. Tab Pending được đọc lúc nạp đầu phiên, mỗi vòng đồng bộ, và ở nút "Nạp từ Sheet"',
    (mj.match(/await napTabPending\(cfg\)/g) || []).length === 3);
  check('23d. Có đủ bốn nút xử lý kho link cục bộ',
    ['links-info', 'links-reload', 'links-open-file', 'links-import-from-sheet']
      .every((k) => mj.includes(`ipcMain.handle('${k}'`) && pl.includes(`'${k}'`)));
  {
    // Ba nút chỉ hoạt động khi `initLinkStore` được GỌI lúc mở app — định nghĩa hàm thôi thì nút
    // hiện ra mà bấm không có gì xảy ra.
    const than = (rj.match(/function initLinkStore\(\) \{[\s\S]*?\n\}/) || [''])[0];
    check('23d2. Ba nút kho link được gắn lúc mở app, mỗi nút gọi đúng việc của nó',
      (rj.match(/^\s*initLinkStore\(\);/gm) || []).length === 1
      && /btnImport\.addEventListener[\s\S]*?window\.api\.linksImportFromSheet\(\)/.test(than)
      && /btnOpen\.addEventListener[\s\S]*?window\.api\.linksOpenFile\(\)/.test(than)
      && /btnReload\.addEventListener[\s\S]*?window\.api\.linksReload\(\)/.test(than));
  }
  check('23e. Modal ☁ có đủ phần của bản PC: kho link + 3 nút + tab Pending',
    ['linksInfo', 'linksImportBtn', 'linksOpenBtn', 'linksReloadBtn', 'sheetsPendingTab']
      .every((id) => html.includes(`id="${id}"`)));
  check('23f. Tên tab Pending được nạp VÀ lưu',
    /getElementById\('sheetsPendingTab'\)\.value = cfg\.pendingTab/.test(rj)
    && /pendingTab: document\.getElementById\('sheetsPendingTab'\)\.value\.trim\(\)/.test(rj));
  check('23g. Chip "N lỗi → Pending" có mặt và được đếm',
    html.includes('id="crawlPendingCount"') && /kind === 'pending'\) \{ if \(payload\.ok\) \{ soPending\+\+/.test(rj));
  check('23h. Runner báo xuống Python tab Pending có bật không',
    /PENDING_ON: params\.pendingOn \? '1' : '0'/.test(rn) && /pendingOn: !!\(sheets\.isEnabled\(\) && String\(cfg\.pendingTab/.test(mj));
  check('23i. Kết quả PENDING đi qua ĐÚNG các cổng của sound thường (Original Sound, ngôn ngữ)',
    /payload\.verdict === 'DAT' \|\| laPending/.test(rn) && /pending: true \}/.test(rn));
  check('23j. Python cất Pending CHỈ khi bật, và vẫn xét Original Sound',
    /elif posts is None and PENDING_ON:[\s\S]{0,600}goc = la_sound_goc\(url_that, tieu_de\)\s*\n\s*if ORIGINAL_ONLY and CO_LUAT_GOC and not goc:[\s\S]{0,1200}verdict="PENDING"/.test(py));
}

// ── 24. Treo máy không bị đứng (2026-09-19) ──
// Hành vi do `phuchoi.test.cjs` (Python, cả vòng quét thật) và `mainflow.test.cjs` mục N (Node)
// chạy thật. Ở đây canh hai chỗ gọi `ve_feed` mà phép thử hành vi không đi qua, và phần giao diện.
{
  const py = doc('scan_feed_sounds.py');
  const rj = doc('renderer/renderer.js');
  const mj = doc('main.js');
  check('24a. Quay lại mà không phải feed → ĐƯA VỀ feed (bản cũ chỉ "bỏ lượt tương tác")',
    /if ly_do == "khong_o_feed":\s*\n\s*ve_feed\(d, /.test(py));
  check('24b. Trang nhạc mở quá chậm (máy yếu) → kiểm và đưa về feed',
    /TRUOT\["khong_vao_trang_nhac"\] \+= 1[\s\S]{0,900}ve_feed\(d, "bấm icon sound nhưng trang nhạc mở quá chậm"\)\s*\n\s*return \(None, True\)/.test(py));
  check('24c. Giao diện hiện "Mất kết nối" khi Python đang chờ nối lại',
    /state === 'offline'\) st\.status = 'offline'/.test(rj) && /st\.status === 'offline'\) return 'Mất kết nối/.test(rj));
  check('24d. Giao diện phân biệt "nghỉ vì lỗi, sẽ tự chạy lại" với nghỉ giữa ca',
    /st\.restLoi = !!payload\.loi/.test(rj) && /if \(st\.restLoi\) return `Lỗi → tự chạy lại/.test(rj));
  check('24e. Tiến trình chết → hẹn tự chạy lại (chỉ ở nhánh LỖI)',
    /if \(status\.state === 'error'\) \{\s*\n\s*_cycleDone\.delete\(deviceId\);[\s\S]{0,160}if \(!xetKhoiDongLai\(deviceId, chay\.serial\)\) henChayLaiSauLoi\(deviceId, status\.msg\);/.test(mj));
  check('24f. Giao diện có trạng thái "đang khởi động lại máy — chờ máy lên" (không hiện "Lỗi → tự chạy lại hh:mm")',
    /payload\.state === 'rebooting'\) st\.status = 'reboot'/.test(rj) && /st\.status === 'reboot'\) return 'Đang khởi động lại máy — chờ máy lên'/.test(rj));
}

// ── 25. Máy đổi IP (2026-09-19) ──
// Hành vi do `doiip.test.cjs` (ghép máy với farm thật hôm đó) và `mainflow.test.cjs` mục O chạy thật.
{
  const mj = doc('main.js');
  const rj = doc('renderer/renderer.js');
  check('25a. Mở app: lần đầu giao diện hỏi danh sách máy thì dò lại IP cả farm trước khi trả',
    /ipcMain\.handle\('devices-list', async \(\) => \{\s*\n\s*if \(!_daDongBoIp\) \{[\s\S]{0,300}devices\.dongBoIp\(/.test(mj));
  check('25b. Thêm / sửa máy → ghi luôn số máy phần cứng ở IP đó',
    /'devices-add', \(_e, data\) => ghiDanhTinh\(devices\.addDevice\(data\)\)/.test(mj)
    && /'devices-update', \(_e, data\) => ghiDanhTinh\(devices\.updateDevice\(data\)\)/.test(mj));
  check('25c. Giao diện nạp lại danh sách khi app vừa dò ra IP mới',
    /kind === 'devices-changed'\) \{ napLaiDanhSachMay\(/.test(rj) && /async function napLaiDanhSachMay\(doi\)/.test(rj));
}

// ── 26. Nút "☁ Đẩy lên Sheet" (2026-09-21) — hành vi phía main do mainflow mục Q chạy thật ──
{
  const rj = doc('renderer/renderer.js');
  const m = rj.match(/async function pushToSheet\(\) \{[\s\S]*?\n\}/);
  const f = m ? m[0] : '';
  check('26a. Khoá nút trong lúc đẩy (bấm hai lần liền thì hai lượt cùng thấy "chưa có" → ghi trùng)',
    /if \(btn\.disabled\) return;\s*\n\s*btn\.disabled = true;/.test(f) && /finally \{\s*\n\s*btn\.disabled = false;/.test(f)
    && f.indexOf('btn.disabled = true') < f.indexOf('sheetsPushManual('));
  check('26b. Đẩy hỏng giữa chừng → báo lỗi ra màn hình, không im lặng',
    /catch \(e\) \{\s*\n\s*toast\(`Đẩy lỗi:/.test(f));
  check('26c. Gửi NGUYÊN bảng, đủ 5 cột như đường tự đẩy (A–E: tên, link, số post, thiết bị, 1)',
    /crawlResults\.map\(\(r\) => \[r\.name, r\.url, r\.posts, r\.deviceName, 1\]\)/.test(f)
    && /const dong = \[data\.name \|\| '', data\.url \|\| '', data\.posts \?\? '', tenThietBi\(deviceId\), 1\];/.test(doc('main.js'))
    && /chodaysheet\.them\(dong\)/.test(doc('main.js')) && /sheets\.enqueue\(dong\)/.test(doc('main.js')));
  check('26d. Chip "N chờ lên Sheet": giao diện hỏi số lúc mở app và nghe sự kiện cập nhật',
    /kind === 'cho-day'\) \{ renderChoDay\(payload\.n\)/.test(rj) && /window\.api\.choDayCount\(\)\.then\(renderChoDay/.test(rj)
    && /choDayCount: \(\) => ipcRenderer\.invoke\('cho-day-count'\)/.test(doc('preload.cjs'))
    && /id="choDayCount"/.test(doc('renderer/index.html')));
  check('26e. Bảng trống mà hàng chờ còn → nút ☁ vẫn đẩy được (vừa mở lại app)',
    /if \(!crawlResults\.length && !soChoDay\)/.test(f));
}

// ── 27. Máy bị đơ → tự khởi động lại điện thoại (2026-09-22) — hành vi do phuchoi mục 8 và mainflow mục S chạy thật ──
{
  const rn = doc('src/runner.cjs');
  const rj = doc('renderer/renderer.js');
  const mj = doc('main.js');
  check('27a. Runner chuyển tiếp sự kiện "máy đơ" của Python lên main.js',
    /payload\.type === 'may_do'\) \{[\s\S]{0,200}onStatus\(deviceId, \{ kind: 'may_do', chac: payload\.chac === true, lyDo:/.test(rn));
  check('27b. Ô "Tự khởi động lại điện thoại khi bị đơ": mặc định BẬT, đọc lúc mở Cài đặt, lưu lúc bấm Lưu',
    /autoReboot: true,/.test(rj) && /\$\('cfgAutoReboot'\)\.checked = globalSettings\.autoReboot !== false;/.test(rj)
    && /autoReboot: document\.getElementById\('cfgAutoReboot'\)\.checked,/.test(rj) && /id="cfgAutoReboot"/.test(doc('renderer/index.html')));
  check('27c. Main áp công tắc qua set-global-settings (thiếu khoá = BẬT)',
    /_tuKhoiDongLai = c\.autoReboot !== false;/.test(mj));
}

// Hàm làm tròn: chạy thật, không soi chữ.
{
  const { soNguyen } = require('../src/runner.cjs');
  const ca = [[1000.4, 1000, '1000'], [1000.6, 1000, '1001'], [0, 1000, '0'], ['', 1000, '1000'],
    [null, 7, '7'], [-5, 1000, '1000'], ['abc', 3, '3'], ['250', 0, '250']];
  const sai = ca.filter(([v, mac, mong]) => soNguyen(v, mac) !== mong)
    .map(([v, mac, mong]) => `${JSON.stringify(v)}→${soNguyen(v, mac)} (mong ${mong})`);
  check('20i. soNguyen: làm tròn, giữ 0 là 0, rác thì về mặc định', sai.length === 0, sai.join('; '));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
process.exit(failed.length ? 1 : 0);
