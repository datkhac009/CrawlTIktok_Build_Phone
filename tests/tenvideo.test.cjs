// tests/tenvideo.test.cjs — phép so "video còn đúng người đó không", chạy THẬT bằng Python.
//
// VÌ SAO PHẢI CÓ (2026-09-18): đây là hàm đã làm TOÀN BỘ phần tương tác ngừng chạy suốt nhiều
// ca mà không ai biết. Nó trả `False` ngay ở `if not author` — trước khi nhìn màn hình một lần
// nào — rồi nơi gọi in ra "video đã đổi sau khi quay lại feed". Câu đó sai: video không đổi gì
// cả, chỉ là tên tác giả chưa bao giờ đọc được. Chủ dự án nhìn log thấy `skip_changed_video` ở
// mọi video, và không một phép thử nào bắt được vì tất cả đều là phép thử văn bản.
//
// Nên phép thử này chạy hàm THẬT, với một `d` giả trả về XML do mình dựng.
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

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

// Máy nào không có Python thì BỎ QUA, đừng báo đỏ oan — đỏ oan dạy người ta bỏ qua màu đỏ.
const { findPython } = require(path.join(R, 'src', 'pythonpath.cjs'));
const py = findPython({ fresh: true });
if (!py) {
  check('0. Có Python để chạy phép thử', true, 'KHÔNG có Python — bỏ qua toàn bộ file này');
  done();
}
check('0. Có Python để chạy phép thử', true, `${py.version.text} (${py.from})`);

// `d` giả: chỉ cần `dump_hierarchy()`. Không đụng tới máy thật, không cần uiautomator2.
const KICH_BAN = [
  'import sys, os, json',
  'sys.path.insert(0, os.environ["APP_DIR"])',
  'import phone_actions as PA',
  '',
  'def xml_feed(ten):',
  '    return ("<hierarchy><node resource-id=\\"com.zhiliaoapp.musically:id/long_press_layout\\" '
    + 'content-desc=\\"Video\\" />"',
  '            "<node resource-id=\\"com.zhiliaoapp.musically:id/user_avatar\\" content-desc=\\"%s profile\\" />"',
  '            "</hierarchy>") % ten',
  '',
  'def xml_live():',
  '    return ("<hierarchy><node resource-id=\\"com.zhiliaoapp.musically:id/long_press_layout\\" '
    + 'content-desc=\\"LIVE\\" /></hierarchy>")',
  '',
  'def xml_trang_nhac():',
  '    return "<hierarchy><node resource-id=\\"com.zhiliaoapp.musically:id/title\\" text=\\"abc\\" /></hierarchy>"',
  '',
  'class D:',
  '    def __init__(self, xml): self._x = xml',
  '    def dump_hierarchy(self): ',
  '        if self._x is None: raise RuntimeError("rpc chet")',
  '        return self._x',
  '',
  'ra = {}',
  'ra["y_het"]        = PA.same_video(D(xml_feed("Skibidi Dog")), "Skibidi Dog")',
  'ra["hoa_thuong"]   = PA.same_video(D(xml_feed("SKIBIDI DOG")), "Skibidi Dog")',
  'ra["thua_trang"]   = PA.same_video(D(xml_feed("Skibidi   Dog")), " Skibidi Dog ")',
  'ra["kem_handle"]   = PA.same_video(D(xml_feed("Skibidi Dog")), "Skibidi Dog @skibidi")',
  'ra["duoi_profile"] = PA.same_video(D(xml_feed("Skibidi Dog")), "Skibidi Dog profile")',
  'ra["nguoi_khac"]   = PA.same_video(D(xml_feed("Ai Do Khac")), "Skibidi Dog")',
  'ra["chua_doc"]     = PA.same_video(D(xml_feed("Skibidi Dog")), "")',
  'ra["dump_hong"]    = PA.same_video(D(None), "Skibidi Dog")',
  'ra["lac_man"]      = PA.same_video(D(xml_trang_nhac()), "Skibidi Dog")',
  'ra["tren_live"]    = PA.same_video(D(xml_live()), "Skibidi Dog")',
  'print(json.dumps({k: list(v) for k, v in ra.items()}))',
].join('\n');

const r = spawnSync(py.cmd, [...py.args, '-c', KICH_BAN], {
  cwd: R,
  env: { ...process.env, APP_DIR: R, PYTHONIOENCODING: 'utf-8' },
  encoding: 'utf8',
  timeout: 60000,
});

if (r.status !== 0) {
  check('1. Chạy được hàm thật', false, (r.stderr || r.stdout || '(không có gì)').slice(0, 400));
  done();
}
check('1. Chạy được hàm thật', true);

let ra;
try {
  ra = JSON.parse(String(r.stdout).trim().split('\n').pop());
} catch (e) {
  check('2. Đọc được kết quả', false, String(r.stdout).slice(0, 300));
  done();
}
check('2. Đọc được kết quả', true, JSON.stringify(ra));

const dung = (k) => ra[k] && ra[k][0] === true;
const sai = (k, lyDo) => ra[k] && ra[k][0] === false && ra[k][1] === lyDo;

// ── Nhận đúng là CÙNG một người ──
check('3. Cùng tên -> đúng video', dung('y_het'));
check('3b. Khác hoa thường vẫn là một người', dung('hoa_thuong'), JSON.stringify(ra.hoa_thuong));
check('3c. Thừa khoảng trắng vẫn là một người', dung('thua_trang'), JSON.stringify(ra.thua_trang));
// `read_video_info` ghép "Tên @handle"; so nguyên chuỗi đó với tên trên màn là trượt.
check('3d. Tên ghép kèm @handle vẫn khớp', dung('kem_handle'), JSON.stringify(ra.kem_handle));
// `_ten_tac_gia` có nhánh trả về nguyên chuỗi thô "Tên profile" khi regex trượt — hai lần đọc
// có thể ra hai dạng khác nhau của CÙNG một người.
check('3e. "Tên profile" so với "Tên" vẫn khớp', dung('duoi_profile'), JSON.stringify(ra.duoi_profile));

// ── Và phân biệt được BỐN lý do khác nhau ──
// Bản cũ gộp cả bốn thành một `False` và một câu "video đã đổi" — sai ở ba trong bốn.
check('4. Người khác thật -> "khac_nguoi"', sai('nguoi_khac', 'khac_nguoi'), JSON.stringify(ra.nguoi_khac));
check('4b. Lúc quét chưa đọc được tên -> "chua_doc_duoc"',
  sai('chua_doc', 'chua_doc_duoc'), JSON.stringify(ra.chua_doc));
check('4c. Đọc màn hình hỏng -> "khong_doc_duoc"',
  sai('dump_hong', 'khong_doc_duoc'), JSON.stringify(ra.dump_hong));
check('4d. Lạc khỏi feed -> "khong_o_feed"', sai('lac_man', 'khong_o_feed'), JSON.stringify(ra.lac_man));

// Feed LIVE VẪN là feed nhưng không có `user_avatar` — không được báo là "lạc khỏi feed".
check('4e. Feed LIVE không bị nhầm thành lạc màn hình',
  sai('tren_live', 'khong_doc_duoc'), JSON.stringify(ra.tren_live));

done();
