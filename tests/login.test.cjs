// tests/login.test.cjs — Tài khoản TikTok + đăng nhập tự động (2026-09-24).
//
// Đường đi đo trên máy 60 (SM-A920F, TikTok 47.0.2, chưa đăng nhập) — bản chụp XML thật nằm ở
// tests/fixtures/login_*_47.0.2.xml. Các màn SAU ô tên đăng nhập (mật khẩu, 2FA, trang cá nhân của
// mình) chưa đo được vì chưa có tài khoản thử: phép thử ở mục 3 dùng màn giả theo dấu hiệu phổ biến.
// Điều phép thử khoá chặt, bất kể giao diện thật ra sao:
//   • mật khẩu / khoá 2FA không bao giờ ra log hay sự kiện;
//   • máy đang đăng nhập tài khoản KHÁC thì không gõ gì cả;
//   • màn lạ (captcha) → báo "cần người" rồi CHỜ, qua được thì đi tiếp.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const R = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'login-'));
process.env.PORTABLE_EXECUTABLE_DIR = TMP;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? '  — ' + detail : ''}`);
}
function done() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
  process.exit(failed.length ? 1 : 0);
}
const doc = (f) => fs.readFileSync(path.join(R, f), 'utf8');

const { docTaiKhoan, moTa, ganHangLoat } = require(path.join(R, 'src', 'account.cjs'));

const KHOA = 'JBSWY3DPEHPK3PXPJBSWY3DP';
const MAU = [
  [`hung.acc|Mk#123|${KHOA}`, { user: 'hung.acc', pass: 'Mk#123', khoa: KHOA }],
  ['hung.acc|Mk#123', { user: 'hung.acc', pass: 'Mk#123', khoa: '' }],
  ['@hung.acc | Mk 1 2 | jbsw y3dp ehpk 3pxp', { user: 'hung.acc', pass: 'Mk 1 2', khoa: 'JBSWY3DPEHPK3PXP' }],
  ['a@mail.com|p:q|' + KHOA, { user: 'a@mail.com', pass: 'p:q', khoa: KHOA }],
  ['user:pass', { user: 'user', pass: 'pass', khoa: '' }],
  [`user:pass:${KHOA}`, { user: 'user', pass: 'pass', khoa: KHOA }],
  ['chimottruong', null],
  ['user|', null],
  ['|pass', null],
  ['us er|pass', null],
  ['user|pass|KHOA-SAI-1', null],
  ['user|pass|ABC', null],
  ['a|b|c|d', null],
  ['', null],
];

// ── 1. JS: đọc chuỗi, che mật khẩu, gán hàng loạt ──
{
  const sai = MAU.filter(([s, mong]) => JSON.stringify(docTaiKhoan(s)) !== JSON.stringify(mong));
  check('1a. docTaiKhoan đọc đúng mọi mẫu (2FA có dấu cách, email, mật khẩu có `:`)', !sai.length,
    sai.map(([s]) => `${s} → ${JSON.stringify(docTaiKhoan(s))}`).join(' | '));
  check('1b. moTa: chỉ @user (+ "· 2FA"), không bao giờ có mật khẩu / khoá',
    moTa(`hung.acc|Mk#123|${KHOA}`) === '@hung.acc · 2FA' && moTa('a@mail.com|p') === 'a@mail.com' && moTa('rác') === '');
  const g = ganHangLoat(['m1', 'm2', 'm3'], `u1|p1\n\n u2|p2 \nu3|p3\nu4|p4`);
  check('1c. Gán lần lượt theo thứ tự máy, bỏ dòng trống, báo dòng thừa',
    g.gan.map((x) => `${x.id}=${x.taiKhoan}`).join(',') === 'm1=u1|p1,m2=u2|p2,m3=u3|p3' && g.thua === 1 && !g.thieu);
  const s = ganHangLoat(['m1', 'm2'], 'u1|p1\nsai');
  check('1d. Có dòng sai → không gán máy nào, chỉ ra dòng sai', !s.gan.length && s.loi.length === 1 && s.loi[0].dong === 2);
}

// ── 2–3. Phía Python ──
const { findPython } = require(path.join(R, 'src', 'pythonpath.cjs'));
const py = findPython({ fresh: true });
if (!py || !py.hasU2) {
  check('2. Có Python + uiautomator2 để chạy phần Python', true, 'KHÔNG có — bỏ qua');
} else {
  const NEN = `
import sys, os, json, time
sys.path.insert(0, os.environ["APP_DIR"])
DONG_HO = [1_700_000_000.0]
time.time = lambda: DONG_HO[0]
def _ngu(s): DONG_HO[0] += s
time.sleep = _ngu
import tiktok_login as T
import college_proxy as CP

def nut(text="", desc="", cls="android.view.View", rid="", pw=False):
    return ('<node text="%s" resource-id="com.zhiliaoapp.musically:id/%s" class="%s" package="com.zhiliaoapp.musically" '
            'content-desc="%s" password="%s" bounds="[10,20][110,60]" />' % (text, rid, cls, desc, "true" if pw else "false"))
MAN = {
  "dong_y": [nut("Welcome to TikTok"), nut("Agree and continue")],
  "so_thich": [nut("Choose what you like"), nut("Skip"), nut("Next (0)")],
  "vuot": [nut(rid="long_press_layout", desc="Video"), nut("Swipe up for more", rid="tv_strengthen_swipe_up_guide"), nut(desc="Profile")],
  "feed": [nut(rid="long_press_layout", desc="Video"), nut(desc="Profile"), nut("Profile")],
  "chon": [nut("Phone number", cls="android.widget.EditText"), nut(desc="Continue with email / username"), nut("Continue with email / username")],
  "o_ten": [nut("Email or username", cls="android.widget.EditText"), nut("Log in")],
  "o_mk": [nut("", cls="android.widget.EditText", pw=True), nut("Log in")],
  "ma_2fa": [nut("2-step verification"), nut("Authenticator app"), nut("", cls="android.widget.EditText"), nut("Continue")],
  "captcha": [nut("Drag the slider to fit the puzzle")],
  "sai_mk": [nut("Incorrect account or password"), nut("", cls="android.widget.EditText", pw=True), nut("Log in")],
}
def ho_so(h): return [nut(desc="Profile menu"), nut("Add bio", desc="Add bio"), nut(h), nut("Following")]

# Dien thoai gia: TikTok theo trang thai. Bam / vuot / go chu doi trang thai nhu app that.
class O:
    def __init__(s, may, k): s.may, s.k = may, k
    def _thay(s):
        xml = s.may.dump_hierarchy()
        if "text" in s.k: return ('text="%s"' % s.k["text"]) in xml
        if "description" in s.k: return ('content-desc="%s"' % s.k["description"]) in xml
        if s.k.get("password"): return 'password="true"' in xml
        return "EditText" in xml
    def exists(s, timeout=0): return s._thay()
    def click(s):
        s.may.viec.append(("click", s.k)); s.may.bam(s.k)
class Touch:
    def __init__(s, may): s.may = may
    def down(s, x, y): pass
    def move(s, x, y): pass
    def up(s, x, y): s.may.viec.append(("vuot",)); s.may.bam({"vuot": 1})
class May:
    # tre: sau khi bấm, màn CŨ còn đứng thêm chừng ấy lần đọc (TikTok đang xử lý — đo máy 60).
    # loe_mk: qua 2FA rồi, màn mật khẩu cũ loé lên chừng ấy lần đọc trước khi vào app.
    def __init__(s, man, dang_nhap="", co_2fa=False, captcha=0, sai_mk=False, tre=0, loe_mk=0, quang_cao=False):
        s.man = man; s.dang_nhap = dang_nhap; s.co_2fa = co_2fa; s.captcha = captcha; s.sai_mk = sai_mk
        s.tre = tre; s.cho = None; s.loe_mk = loe_mk; s.quang_cao = quang_cao
        s.menu_nguon = False; s.lan_menu = 0
        s.viec = []; s.go = []; s.touch = Touch(s); s.user = "hung.acc"
    def app_current(s): return {"package": T.PKG}
    def app_start(s, *a, **k): s.viec.append(("app_start",))
    def window_size(s): return (720, 1280)
    def press(s, k):
        s.viec.append(("press", k))
        if k == "back" and s.menu_nguon:
            s.menu_nguon = False; return
        if k == "back" and s.man == "quang_cao": s.man = "ho_so"
    def click(s, x, y): s.viec.append(("cham", x, y))
    def __call__(s, **k): return O(s, k)
    def dump_hierarchy(s):
        # Menu nguồn tự bật (ô 62): đè lên mọi thứ, dump không có chữ nào của TikTok.
        if s.lan_menu > 0 and not s.menu_nguon and s.man in ("o_mk", "ma_2fa"):
            s.lan_menu -= 1; s.menu_nguon = True
        if s.menu_nguon: return ""
        if s.cho:
            man_cu, con = s.cho
            if con > 0:
                s.cho = (man_cu, con - 1); return "".join(MAN[man_cu])
            s.cho = None
        if s.man == "loe":
            s.loe_mk -= 1
            if s.loe_mk < 0: s.man = "quang_cao" if s.quang_cao else "ho_so"
            else: return "".join(MAN["o_mk"])
        if s.man == "quang_cao":
            return nut("Viewer history turned on") + nut("Viewer history") + nut("ON") + nut("Save")
        if s.man == "captcha":
            s.captcha -= 1
            if s.captcha <= 0: s.man = "ho_so"
        if s.man == "ho_so": return "".join(ho_so(s.dang_nhap))
        return "".join(MAN[s.man])
    def bam(s, k):
        t = k.get("text") or k.get("description")
        if s.tre and s.man in ("o_ten", "o_mk") and t == "Log in": s.cho = (s.man, s.tre)
        if s.man == "dong_y" and t == "Agree and continue": s.man = "so_thich"
        elif s.man == "so_thich" and t == "Skip": s.man = "vuot"
        elif s.man == "vuot" and "vuot" in k: s.man = "feed"
        elif s.man == "feed" and t == "Profile": s.man = "ho_so" if s.dang_nhap else "chon"
        elif s.man == "chon" and t == "Continue with email / username": s.man = "o_ten"
        elif s.man == "o_ten" and t == "Log in": s.man = "o_mk"
        elif s.man in ("o_mk", "sai_mk") and t == "Log in":
            if s.sai_mk: s.man = "sai_mk"
            else:
                s.man = "ma_2fa" if s.co_2fa else ("captcha" if s.captcha else "ho_so")
                if not s.co_2fa: s.dang_nhap = "@" + s.user
        elif s.man == "ma_2fa" and t == "Continue":
            s.dang_nhap = "@" + s.user
            s.man = "captcha" if s.captcha else ("loe" if s.loe_mk else ("quang_cao" if s.quang_cao else "ho_so"))

MAY = [None]
def adb_gia(*a, serial=None, timeout=60):
    if a[:3] == ("shell", "input", "text"):
        gt = a[3][1:-1].replace("'\\\\''", "'").replace("%s", " ")
        MAY[0].go.append(gt)
        if MAY[0].man == "o_ten": MAY[0].user = gt
    if a[:3] == ("shell", "dumpsys", "window"):
        return "  mCurrentFocus=Window{a63 u0 Phone options}" if MAY[0].menu_nguon else "  mCurrentFocus=Window{1 u0 com.zhiliaoapp.musically}"
    if a[:2] == ("shell", "dumpsys"): return "mInputShown=false"
    return ""
T.adb = adb_gia
CP.adb = adb_gia
LOG, SK = [], []
log = LOG.append
emit = lambda t, **k: SK.append(dict(type=t, **k))
def chay(may, tk, handle_cu=""):
    MAY[0] = may
    try:
        kq = T.dang_nhap(may, "SERIAL", tk, log, emit, handle_cu=handle_cu)
    except T.DangNhapHong as e:
        kq = {"loi": str(e)}
    return kq
def ket(**k):
    k.update(log=LOG, su_kien=SK)
    print("@@KQ@@" + json.dumps(k, ensure_ascii=False))
`;
  const chay = (ten, than) => {
    const f = path.join(TMP, ten + '.py');
    fs.writeFileSync(f, NEN + '\n' + than, 'utf8');
    const r = spawnSync(py.cmd, [...py.args, f], {
      encoding: 'utf8', timeout: 60000,
      env: Object.assign({}, process.env, { APP_DIR: R, PYTHONIOENCODING: 'utf-8' }),
    });
    const dong = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('@@KQ@@'));
    return { kq: dong ? JSON.parse(dong.slice(6)) : null, loi: String(r.stderr || '').slice(-800) };
  };
  const MK = "Mk'bi mat#9";
  const TK = (khoa) => `{"user": "hung.acc", "pass": ${JSON.stringify(MK)}, "khoa": "${khoa || ''}"}`;
  const kin = (kq) => !JSON.stringify(kq.log).includes(MK) && !JSON.stringify(kq.su_kien).includes(MK)
    && !JSON.stringify(kq.log).includes(KHOA) && !JSON.stringify(kq.su_kien).includes(KHOA);

  // ── 2. Luật đọc chuỗi, mã 2FA, nhận diện màn thật ──
  {
    const r = chay('doc', `ket(kq=[T.doc_tai_khoan(s) for s in ${JSON.stringify(MAU.map(([s]) => s))}])`);
    const lech = r.kq ? MAU.filter(([, mong], i) => JSON.stringify(r.kq.kq[i]) !== JSON.stringify(mong)) : MAU;
    check('2a. doc_tai_khoan (Python) khớp docTaiKhoan (JS) trên cùng bộ mẫu', !lech.length, lech.map(([s]) => s).join(' | ') || r.loi);
    // RFC 6238 phụ lục B, SHA1, khoá "12345678901234567890": 94287082 / 07081804 → 6 số cuối.
    const t = chay('totp', `ket(kq=[T.ma_totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59), T.ma_totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1111111109)])`);
    check('2b. Mã 2FA đúng mẫu chuẩn RFC 6238', !!t.kq && t.kq.kq.join(',') === '287082,081804', t.kq ? t.kq.kq : t.loi);
    const FX = [['login_dong_y_47.0.2.xml', 'dong_y'], ['login_so_thich_47.0.2.xml', 'so_thich'], ['login_huong_dan_vuot_47.0.2.xml', 'huong_dan_vuot'],
      ['login_chon_cach_47.0.2.xml', 'chon_cach'], ['login_o_ten_47.0.2.xml', 'o_ten'], ['login_o_ten_da_go_47.0.2.xml', 'o_ten'],
      ['login_2fa_47.0.2.xml', 'ma_2fa'], ['login_popup_avatar_47.0.2.xml', 'quang_cao'], ['login_ho_so_minh_47.0.2.xml', 'ho_so_minh'], ['feed_nut_tako_46.9.3.xml', 'feed']];
    const n = chay('fx', `ket(kq=[T.nhan_dien(open(os.path.join(os.environ["APP_DIR"], "tests", "fixtures", f), encoding="utf-8").read())[0] for f in ${JSON.stringify(FX.map((x) => x[0]))}])`);
    const sai = n.kq ? FX.filter(([, m], i) => n.kq.kq[i] !== m) : FX;
    const hs = chay('hs', `ket(kq=T.nhan_dien(open(os.path.join(os.environ["APP_DIR"], "tests", "fixtures", "login_ho_so_minh_47.0.2.xml"), encoding="utf-8").read()))`);
    check('2d. Trang cá nhân của mình (bản chụp thật) → đọc đúng @handle', !!hs.kq && hs.kq.kq[1] === '@ten.dang.nhap', hs.kq ? JSON.stringify(hs.kq.kq) : hs.loi);
    check('2c. Nhận diện đúng các màn chụp THẬT trên máy 60 (Agree and continue của máy mới cài, sở thích, lớp vuốt, chọn cách, ô tên trống / đã gõ, 2FA, quảng cáo, trang của mình, feed)', !sai.length,
      n.kq ? JSON.stringify(n.kq.kq) : n.loi);
  }

  // ── 3. Luồng đăng nhập trên TikTok giả ──
  {
    const a = chay('moi', `ket(kq=chay(May("dong_y"), ${TK()}), go=MAY[0].go)`);
    check('3a. Máy mới cài → Agree and continue, Skip, vuốt, Profile, email/username, điền tên + mật khẩu → xong',
      !!a.kq && a.kq.kq.trangThai === 'xong' && a.kq.kq.handle === '@hung.acc' && a.kq.go.join('|') === `hung.acc|${MK}`,
      a.kq ? JSON.stringify(a.kq.kq) + JSON.stringify(a.kq.go) : a.loi);
    check('3a2. Mật khẩu không ra log / sự kiện', !!a.kq && kin(a.kq));

    const b = chay('2fa', `kq = chay(May("feed", co_2fa=True), ${TK(KHOA)}); ket(kq=kq, go=MAY[0].go, ma=T.ma_totp("${KHOA}"))`);
    check('3b. TikTok hỏi 2FA → gõ đúng mã sinh từ khoá', !!b.kq && b.kq.kq.trangThai === 'xong' && b.kq.go[2] === b.kq.ma,
      b.kq ? JSON.stringify(b.kq) : b.loi);
    check('3b2. Khoá 2FA không ra log / sự kiện', !!b.kq && kin(b.kq));
    // Mã sắp hết hạn (còn 3 giây) → chờ sang mã mới rồi mới gõ; gõ mã cũ là TikTok báo sai oan.
    const b3 = chay('2fa_het', `N = 56_666_666; DONG_HO[0] = N * 30 + 27
kq = chay(May("ma_2fa", co_2fa=True), ${TK(KHOA)}); ket(go=MAY[0].go, cu=T.ma_totp("${KHOA}", N * 30 + 27), moi=T.ma_totp("${KHOA}", (N + 1) * 30 + 1))`);
    check('3b3. Mã 2FA còn dưới 5 giây → chờ mã mới rồi mới gõ',
      !!b3.kq && b3.kq.go[0] === b3.kq.moi && b3.kq.cu !== b3.kq.moi, b3.kq ? JSON.stringify(b3.kq) : b3.loi);

    const tr = chay('tre', `ket(kq=chay(May("so_thich", tre=3, co_2fa=True, loe_mk=3, quang_cao=True), ${TK(KHOA)}), go=MAY[0].go, viec=MAY[0].viec)`);
    check('3i. Bấm Log in mà màn chưa kịp chuyển → CHỜ, không gõ lại tên / mật khẩu',
      !!tr.kq && tr.kq.kq.trangThai === 'xong' && tr.kq.go.length === 3, tr.kq ? JSON.stringify(tr.kq.go.length) + JSON.stringify(tr.kq.kq) : tr.loi);
    check('3j. Qua 2FA rồi màn mật khẩu cũ loé lên → KHÔNG gõ lại mật khẩu (lượt đăng nhập thứ hai)',
      !!tr.kq && tr.kq.go.filter((g) => g === MK).length === 1);
    check('3l. Tấm "Viewer history turned on" sau đăng nhập → tự bấm Back, không bắt người giải',
      !!tr.kq && tr.kq.viec.some((v) => v[0] === 'press' && v[1] === 'back') && !tr.kq.su_kien.some((x) => x.trangThai === 'cho_nguoi'));
    const mn = chay('menu', `m = May("o_ten", co_2fa=True, quang_cao=True); m.lan_menu = 2
ket(kq=chay(m, ${TK(KHOA)}), viec=m.viec)`);
    check('3m. Menu nguồn tự bật giữa chừng (ô 62) → Back đóng, đi tiếp, KHÔNG báo "cần người"',
      !!mn.kq && mn.kq.kq.trangThai === 'xong' && !mn.kq.su_kien.some((x) => x.trangThai === 'cho_nguoi')
      && mn.kq.viec.filter((v) => v[0] === 'press' && v[1] === 'back').length >= 3, mn.kq ? JSON.stringify(mn.kq.kq) + JSON.stringify(mn.kq.su_kien) : mn.loi);
    const c = chay('daco', `ket(kq=chay(May("feed", dang_nhap="@hung.acc"), ${TK()}), go=MAY[0].go)`);
    check('3c. Đã đăng nhập ĐÚNG tài khoản → "da_co", không gõ gì',
      !!c.kq && c.kq.kq.trangThai === 'da_co' && c.kq.kq.ok && !c.kq.go.length, c.kq ? JSON.stringify(c.kq.kq) : c.loi);

    const d = chay('lech', `ket(kq=chay(May("feed", dang_nhap="@nguoi.khac"), ${TK()}), go=MAY[0].go, viec=MAY[0].viec)`);
    check('3d. Đang đăng nhập tài khoản KHÁC → "lech", không gõ, không bấm gì ngoài Profile',
      !!d.kq && d.kq.kq.trangThai === 'lech' && d.kq.kq.handle === '@nguoi.khac' && !d.kq.go.length
      && d.kq.viec.filter((v) => v[0] === 'click').length === 1, d.kq ? JSON.stringify(d.kq) : d.loi);

    const e = chay('email', `ket(kq=chay(May("feed", dang_nhap="@ten.that"), {"user": "a@mail.com", "pass": "p", "khoa": ""}, handle_cu="@ten.that"))`);
    check('3e. Tài khoản email: nhận ra "đã đăng nhập" nhờ @handle của lần trước',
      !!e.kq && e.kq.kq.trangThai === 'da_co', e.kq ? JSON.stringify(e.kq.kq) : e.loi);

    const f = chay('captcha', `ket(kq=chay(May("o_mk", captcha=20), ${TK()}))`);
    check('3f. Captcha → báo "cần người" MỘT lần, chờ, người giải xong thì đi tiếp tới xong',
      !!f.kq && f.kq.kq.trangThai === 'xong' && f.kq.su_kien.filter((s) => s.trangThai === 'cho_nguoi').length === 1
      && f.kq.su_kien.some((s) => s.trangThai === 'dang'), f.kq ? JSON.stringify(f.kq) : f.loi);

    const g = chay('captcha_mai', `ket(kq=chay(May("o_mk", captcha=10**6), ${TK()}), dh=DONG_HO[0])`);
    check('3g. Captcha không ai giải → dừng sau 5 phút chờ, nói rõ lý do',
      !!g.kq && /chờ người giải quá 5 phút/.test(g.kq.kq.loi || ''), g.kq ? JSON.stringify(g.kq.kq) : g.loi);

    const h = chay('saimk', `ket(kq=chay(May("o_mk", sai_mk=True), ${TK()}), go=MAY[0].go)`);
    check('3h. Sai mật khẩu → dừng ngay, không gõ lại lần nữa',
      !!h.kq && /sai tài khoản\/mật khẩu/.test(h.kq.kq.loi || '') && h.kq.go.length === 1, h.kq ? JSON.stringify(h.kq) : h.loi);

    const k = chay('thieu2fa', `ket(kq=chay(May("o_mk", co_2fa=True), ${TK()}))`);
    check('3k. TikTok hỏi 2FA mà tài khoản không có khoá → dừng, nói rõ',
      !!k.kq && /không có khoá 2FA/.test(k.kq.kq.loi || ''), k.kq ? JSON.stringify(k.kq.kq) : k.loi);
  }
}

// ── 4. Nối dây ──
{
  const main = doc('main.js');
  const lr = doc('src/loginrun.cjs');
  const tl = doc('tiktok_login.py');
  const pkg = JSON.parse(doc('package.json'));
  check('4a. Mật khẩu đi qua biến môi trường, KHÔNG qua dòng lệnh',
    /TAI_KHOAN: String\(taiKhoan/.test(lr) && /\[\.\.\.py\.args, resolveResource\('tiktok_login\.py'\), serial\]/.test(lr));
  check('4b. Danh sách gửi giao diện bỏ `taiKhoan`, chỉ gửi `taiKhoanHien`',
    /const \{ proxy: p, taiKhoan: tk, \.\.\.con \} = d;/.test(main) && /ghiDanhTinh[\s\S]*?return choGiaoDien\(dev\);/.test(main));
  check('4c. Python gắn proxy TRƯỚC khi đăng nhập (không đăng nhập bằng IP thật)',
    tl.indexOf('CP.dam_bao_proxy(') > 0 && tl.indexOf('CP.dam_bao_proxy(') < tl.indexOf('kq = dang_nhap('));
  check('4d. Python không in mật khẩu / khoá ra log', !/log\([^)]*\["(pass|khoa)"\]/.test(tl) && !/emit\([^)]*\["(pass|khoa)"\]/.test(tl));
  check('4e. Bản build .exe mang theo tiktok_login.py', (pkg.build.extraResources || []).includes('tiktok_login.py'));
  check('4f. Máy đang đăng nhập bị coi là bận (gắn proxy không chen vào)',
    /function _dangBan\(id\) \{[\s\S]*?_dangDangNhap\.has\(id\)[\s\S]*?\}/.test(main));
  check('4g. Không có phần tự giải captcha', !/solve|giai_captcha/i.test(tl.replace(/"""[\s\S]*?"""/g, '')) );
}

done();
