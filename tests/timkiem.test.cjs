// tests/timkiem.test.cjs — pha TÌM THEO TỪ KHÓA (chế độ Tìm từ khóa ⇄ For You, 2026-09-24).
//
// Đo thật trước khi viết (Pixel 4 XL, TikTok 46.9.3): `snssdk1233://search?keyword=…` mở thẳng trang
// kết quả; tab Videos → bấm video đầu → trình phát có nút sound y như feed; Back từ trang nhạc về
// đúng trình phát. Chạy thật 3 từ × 3 video: xoay từ đúng, đọc đúng số post từng sound.
//
// Phép thử này chạy ĐÚNG hàm Python thật, chỉ thay điện thoại + đồng hồ bằng bản giả, và khoá:
//   - đọc danh sách từ khóa, dựng deep link (mã hoá dấu cách / '#' / '&');
//   - xoay từ: mở từ hiện tại, sang từ kế, từ hỏng thì thử từ kế, hỏng cả thì về For You;
//   - lạc khỏi trình phát thì về lại TRÌNH PHÁT TÌM KIẾM chứ không về feed For You;
//   - hết kết quả (vuốt mà video không đổi) và cảnh gác "không có icon sound" đều sang từ kế;
//   - setup_device mở xong TikTok thì vào từ khóa.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? '  — ' + detail : ''}`);
}
function done() {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
  process.exit(failed.length ? 1 : 0);
}

const R = path.join(__dirname, '..');
const doc = (...p) => fs.readFileSync(path.join(R, ...p), 'utf8').replace(/\r\n/g, '\n');

// ── 1. Nối dây (đọc mã) ──
{
  const rn = doc('src', 'runner.cjs');
  const mj = doc('main.js');
  const rj = doc('renderer', 'renderer.js');
  const html = doc('renderer', 'index.html');
  const scan = doc('scan_feed_sounds.py');
  const pkg = JSON.parse(doc('package.json'));
  check('1a. runner: pha Tìm → TIM_ON, từ khóa qua TỆP, mốc bắt đầu, số video mỗi từ',
    /TIM_ON: phaTim \? '1' : '0'/.test(rn) && /TIM_KW_FILE: phaTim \? ghiDanhSachTu\(deviceId, pha\.tuKhoa\)/.test(rn)
    && /TIM_START: soNguyen\(phaTim \? pha\.mocTim : 0, 0\)/.test(rn) && /TIM_MOI_TU: soNguyen\(cfg\.searchPerKw, 30\)/.test(rn));
  check('1b. Pha Tìm KHÔNG hỏi / không tương tác (ASK_ON tắt, giống pha Xem)', /ASK_ON: \(!phaXem && !phaTim && /.test(rn));
  check('1c. runner chuyển sự kiện "tim" lên, main ghi mốc từ khóa',
    /payload\.type === 'tim'[\s\S]{0,300}kind: 'tim'/.test(rn)
    && /status\.kind === 'tim' && Number\.isInteger\(status\.tiep\)\) ghiMocTim\(deviceId, status\.tiep\)/.test(mj));
  check('1d. Kế hoạch pha Tìm dựng ở main.js, KHÔNG sửa phaseplan.cjs (srcsync khoá giống bản PC)',
    /if \(cfg && cfg\.mode === 'tukhoa'\) return keHoachTim\(cfg\)/.test(mj) && !/tukhoa|'tim'/.test(doc('src', 'phaseplan.cjs')));
  check('1e. Giao diện: có chế độ, khối cài đặt, bộ từ khóa mẫu, nhãn "Tìm … · từ khóa"',
    /<option value="tukhoa">/.test(html) && /id="cfgTimSection"/.test(html) && /id="timMauNhom"/.test(html)
    && /const CHE_DO = \['foryou', 'cycle', 'tukhoa'\]/.test(rj) && /st\.phase\.key === 'tim'/.test(rj)
    && /themNhomTuKhoa\(b\.dataset\.nhom\)/.test(rj));
  check('1f. Bản .exe mang theo tim_tu_khoa.py (extraResources)', (pkg.build.extraResources || []).includes('tim_tu_khoa.py'));
  check('1g. Vòng quét: đủ N video của một từ thì sang từ kế; vuốt trong kết quả đi qua vuot_tim',
    /if TIM\["on"\] and TIM\["dem"\] >= TIM_MOI_TU:\s*\n\s*try:\s*\n\s*vao_tu_khoa\(d, ACTIVE_PKG or PKGS\[0\], sang_tu_moi=True\)/.test(scan)
    && /elif TIM\["on"\]:\s*\n(\s*#.*\n)*\s*vuot_tim\(d\)/.test(scan));
}

// ── 2. Phía Python ──
const { findPython } = require(path.join(R, 'src', 'pythonpath.cjs'));
const py = findPython({ fresh: true });
if (!py || !py.hasU2) {
  check('2. Có Python + uiautomator2 để chạy phần Python', true, 'KHÔNG có — bỏ qua');
  done();
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'timkiem-'));
const NEN = `
import sys, os, json, time
sys.path.insert(0, os.environ["APP_DIR"])
DONG_HO = [1_000_000.0]
time.time = lambda: DONG_HO[0]
time.sleep = lambda s: DONG_HO.__setitem__(0, DONG_HO[0] + max(0.0, s))
import scan_feed_sounds as S
import tim_tu_khoa as TK
PKG = "com.zhiliaoapp.musically"
LOG, SK = [], []
S.log = LOG.append
S.log_han_che = lambda k, m: LOG.append(m)
S.emit_event = lambda t, **k: SK.append(dict(type=t, **k))
class May:
    def __init__(s, act="DetailActivity"): s.act, s.bam = act, []
    def app_current(s): return {"package": PKG, "activity": "com.x." + s.act}
    def press(s, k):
        s.bam.append(k)
        if k == "back" and s.act == "MusicDetailActivity": s.act = "DetailActivity"
MO = []          # tu nao da duoc mo
HONG = set()     # tu nao mo se hong
def mo_gia(d, pkg, tu, cho=12.0):
    MO.append(tu)
    if tu in HONG: return False
    d.act = "DetailActivity"; return True
TK.mo_tu = mo_gia
VE_FEED = []
def bat_tim(tu, i=0):
    S.TIM.update(on=True, tu=list(tu), i=i, dem=0, lap=0, so_tu=0)
def ket(**k):
    k.update(log=LOG, su_kien=SK, mo=MO)
    print("@@KQ@@" + json.dumps(k, ensure_ascii=False))
`;
function chay(ten, than) {
  const f = path.join(TMP, ten + '.py');
  fs.writeFileSync(f, NEN + '\n' + than, 'utf8');
  const r = spawnSync(py.cmd, [...py.args, f], {
    encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, { APP_DIR: R, PYTHONIOENCODING: 'utf-8' }),
  });
  const dong = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('@@KQ@@'));
  return { kq: dong ? JSON.parse(dong.slice(6)) : null, loi: String(r.stderr || '').slice(-800) };
}

// ── 2a. Đọc từ khóa + deep link ──
{
  const r = chay('doc', `
ket(tu=TK.doc_tu_khoa(["storytime", "  AI   voice ", "ai voice", "", "#povtiktok"]),
    tu2=TK.doc_tu_khoa("a\\n\\nb\\nA"),
    l1=TK.link_tim(PKG, "ai voice"), l2=TK.link_tim(PKG, "#povtiktok"), l3=TK.link_tim(PKG, "a&b c"),
    l4=TK.link_tim("com.ss.android.ugc.trill", "pov"))`);
  const k = r.kq || {};
  check('2a. Từ khóa: gộp khoảng trắng, bỏ trùng không phân biệt hoa thường, giữ "#"',
    JSON.stringify(k.tu) === JSON.stringify(['storytime', 'AI voice', '#povtiktok']) && JSON.stringify(k.tu2) === '["a","b"]',
    JSON.stringify(k) || r.loi);
  check('2b. Deep link mã hoá toàn bộ từ khóa (dấu cách, #, &) và đúng scheme từng gói TikTok',
    k.l1 === 'snssdk1233://search?keyword=ai%20voice' && k.l2 === 'snssdk1233://search?keyword=%23povtiktok'
    && k.l3 === 'snssdk1233://search?keyword=a%26b%20c' && k.l4 === 'snssdk1180://search?keyword=pov', JSON.stringify(k));
}

// ── 2c. Xoay từ ──
{
  const r = chay('xoay', `
d = May("SplashActivity")
bat_tim(["a", "b", "c"])
ok1 = S.vao_tu_khoa(d, PKG)                       # mo tu hien tai
S.TIM["dem"] = 7
ok2 = S.vao_tu_khoa(d, PKG, sang_tu_moi=True)     # sang tu ke
HONG.add("c")
ok3 = S.vao_tu_khoa(d, PKG, sang_tu_moi=True)     # c hong -> thu a
ket(ok=[ok1, ok2, ok3], i=S.TIM["i"], dem=S.TIM["dem"], so_tu=S.TIM["so_tu"],
    tiep=[e["tiep"] for e in SK if e["type"] == "tim"])`);
  const k = r.kq || {};
  check('2c. Xoay từ: mở từ hiện tại → sang từ kế → từ hỏng thì thử từ kế (xoay vòng về đầu)',
    !!k.mo && JSON.stringify(k.mo) === '["a","b","c","a"]' && JSON.stringify(k.ok) === '[true,true,true]' && k.i === 0,
    JSON.stringify(k) || r.loi);
  check('2d. Mỗi lần mở từ: đếm video về 0, báo sự kiện "tim" với mốc lượt sau = từ KẾ',
    k.dem === 0 && k.so_tu === 3 && JSON.stringify(k.tiep) === '[1,2,1]' && k.log.some((l) => /Không mở được kết quả tìm kiếm «c»/.test(l)),
    JSON.stringify(k));
}

// ── 2e. Hỏng cả → tắt pha Tìm, về For You ──
{
  const r = chay('hong_ca', `
d = May("SplashActivity")
S.ve_feed = lambda d, ly_do: VE_FEED.append(ly_do) or "o_feed"
bat_tim(["a", "b"])
HONG.update(["a", "b"])
ok = S.vao_tu_khoa(d, PKG)
ket(ok=ok, on=S.TIM["on"], ve=VE_FEED)`);
  const k = r.kq || {};
  check('2e. Không mở được từ nào → TẮT pha Tìm, về For You quét tiếp (không đứng máy, không báo máy đơ)',
    k.ok === false && k.on === false && k.ve && k.ve.length === 1 && k.log.some((l) => /quét For You cho hết pha/.test(l)),
    JSON.stringify(k) || r.loi);
}

// ── 2f. Lạc thì về TRÌNH PHÁT TÌM KIẾM, không về For You ──
{
  const r = chay('ve_tim', `
bat_tim(["a", "b"])
d1 = May("DetailActivity"); k1 = S.ve_feed(d1, "thu")
d2 = May("MusicDetailActivity"); k2 = S.ve_feed(d2, "thu")
d3 = May("SplashActivity"); k3 = S.ve_feed(d3, "thu")
ket(k=[k1, k2, k3], bam=[d1.bam, d2.bam, d3.bam], i=S.TIM["i"])`);
  const k = r.kq || {};
  check('2f. Đang ở trình phát tìm kiếm → không bấm gì; ở trang nhạc → một cú Back; lạc chỗ khác → mở TỪ KẾ',
    !!k.k && JSON.stringify(k.k) === '["o_feed","back","mo_lai"]' && JSON.stringify(k.bam[0]) === '[]'
    && JSON.stringify(k.bam[1]) === '["back"]' && JSON.stringify(k.mo) === '["b"]' && k.i === 1,
    JSON.stringify(k) || r.loi);
}

// ── 2g. Hết kết quả → sang từ kế ──
{
  const r = chay('het_kq', `
bat_tim(["a", "b"])
d = May("DetailActivity")
S.PA.vuot_video_ke = lambda d, manh=False: None
TK.chu_video = lambda d, pkg: "cung mot caption"
S.vuot_tim(d); lan1 = list(MO)
S.vuot_tim(d)
ket(lan1=lan1, i=S.TIM["i"])`);
  const k = r.kq || {};
  check('2g. Vuốt 2 lần liền mà video không đổi = hết kết quả → sang từ kế (lần 1 chưa đổi)',
    !!k.mo && JSON.stringify(k.lan1) === '[]' && JSON.stringify(k.mo) === '["b"]' && k.i === 1
    && k.log.some((l) => /Hết kết quả của «a»/.test(l)), JSON.stringify(k) || r.loi);
}

// ── 2h. Cảnh gác: N video liền không có icon sound → sang từ kế, KHÔNG khởi động lại TikTok ──
{
  const r = chay('canh_gac', `
bat_tim(["a", "b"])
d = May("DetailActivity")
d.app_start = lambda *a, **k: (_ for _ in ()).throw(AssertionError("khong duoc mo lai TikTok"))
kq = [S.canh_gac(d, True) for _ in range(S.CANH_GAC_KHONG_ICON)]
ket(kq=kq)`);
  const k = r.kq || {};
  check('2h. Cảnh gác trong pha Tìm: đủ N video không có sound thì sang từ kế, không khởi động lại TikTok (về For You)',
    !!k.kq && k.kq[k.kq.length - 1] === 'mo_lai' && k.kq.slice(0, -1).every((x) => x === '') && JSON.stringify(k.mo) === '["b"]',
    JSON.stringify(k) || r.loi);
}

// ── 2i. setup_device: mở xong TikTok thì vào từ khóa ──
{
  const r = chay('setup', `
bat_tim(["a", "b"], i=1)
thu_tu = []
S.kill_all_apps = lambda d: thu_tu.append("kill")
S.co_college_proxy = lambda serial: False
def mo_tiktok(d):
    thu_tu.append("tiktok"); d.act = "SplashActivity"; return PKG
S.ensure_tiktok_open = mo_tiktok
d = May("SplashActivity"); d.serial = "S"
pkg = S.setup_device(d)
ket(pkg=pkg, thu_tu=thu_tu, act=d.act)`);
  const k = r.kq || {};
  check('2i. setup_device: tắt app → mở TikTok → VÀO TỪ KHÓA đang tới lượt (mọi đường mở lại TikTok đều qua đây)',
    !!k.thu_tu && JSON.stringify(k.thu_tu) === '["kill","tiktok"]' && JSON.stringify(k.mo) === '["b"]' && k.act === 'DetailActivity',
    JSON.stringify(k) || r.loi);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
done();
