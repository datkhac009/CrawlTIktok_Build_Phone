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
    /het \{SETTLE:\.1f\}s ma chua doc duoc so post/.test(py));
  check('13d. Tổng kết in ba số đó ra cùng tổng số video',
    /TRUOT vi het gio/.test(py) && /tren tong \{count\} video/.test(py));
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

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
process.exit(failed.length ? 1 : 0);
