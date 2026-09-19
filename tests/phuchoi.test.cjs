// tests/phuchoi.test.cjs — treo máy cào sound mà KHÔNG bị đứng: thang phục hồi phía Python.
//
// HAI SỰ CỐ THẬT (2026-09-19), chủ dự án gửi log:
//   1. Lỗi "Remote end closed connection without response" ở video #91, rồi 3 TIẾNG liền
//      "0 sound đạt, 25 video không có sound" tới khi bấm Dừng. Lỗi rơi vào giữa một video (máy
//      đang ở trang nhạc) và không bước nào đưa máy về feed.
//   2. Máy .121 mất kết nối ADB ("device offline" rồi "not found"): phục hồi thử 3×3 lần trong 10
//      giây, hỏng hết, rồi vòng quét quay tít in lỗi mỗi 4 giây — không chờ máy quay lại.
//
// Chạy ĐÚNG hàm Python thật (`scan_feed_sounds.py`, kể cả `main()`), chỉ thay điện thoại, adb và
// đồng hồ bằng bản giả. Đồng hồ giả nên "chờ 3 phút" chạy xong trong vài mili-giây.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const results = [];
// Chi tiết chỉ in khi HỎNG: nhiều phép kiểm đưa cả đoạn log làm chi tiết, in cả lúc xanh là ngập màn hình.
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
const FX = path.join(__dirname, 'fixtures');
const { findPython } = require(path.join(R, 'src', 'pythonpath.cjs'));
const py = findPython({ fresh: true });
if (!py || !py.hasU2) {
  check('0. Có Python + uiautomator2 để chạy', true, 'KHÔNG có — bỏ qua toàn bộ file này');
  done();
}

// ── Máy giả: màn hình là một TRẠNG THÁI; Back / mở app chuyển trạng thái theo bảng `di` ──
const NEN = `
import sys, os, json, time, http.client
sys.path.insert(0, os.environ["APP_DIR"])
DONG_HO = [1_000_000.0]
time.time = lambda: DONG_HO[0]
time.sleep = lambda s: DONG_HO.__setitem__(0, DONG_HO[0] + max(0.0, s))
import scan_feed_sounds as S
import phone_actions as PA
FX = os.environ["FX"]
TT = "com.zhiliaoapp.musically"
SPLASH = "com.ss.android.ugc.aweme.splash.SplashActivity"
MAN = {
    "feed": (TT, SPLASH, open(os.path.join(FX, "feed_nut_tako_46.9.3.xml"), encoding="utf-8").read()),
    "tako": (TT, SPLASH, open(os.path.join(FX, "tako_man_hinh_46.9.3.xml"), encoding="utf-8").read()),
    "nhac": (TT, "com.ss.android.ugc.aweme.music.ui.MusicDetailActivity",
             '<hierarchy><node resource-id="com.zhiliaoapp.musically:id/title" text="Original Sound - abc"/></hierarchy>'),
    "video": (TT, "com.ss.android.ugc.aweme.detail.ui.DetailActivity",
              '<hierarchy><node resource-id="com.zhiliaoapp.musically:id/user_avatar" content-desc="A profile"/>'
              '<node resource-id="com.zhiliaoapp.musically:id/videomusiccoverblock"/></hierarchy>'),
    "ho_so": (TT, SPLASH, '<hierarchy><node text="@abc"/><node resource-id="com.zhiliaoapp.musically:id/cover"/></hierarchy>'),
    "launcher": ("com.android.launcher3", "com.android.launcher3.uioverrides.QuickstepLauncher", "<hierarchy/>"),
    "hop_thoai": ("com.samsung.android.lool", "com.samsung.android.sm.dialog.StorageLowDialogActivity", "<hierarchy/>"),
}
class Nut:
    exists = False
    def click(self): pass
    def wait(self, timeout=0): return False
class May:
    def __init__(self, man="feed", di=None, serial="192.168.5.9:5555"):
        self.man = man; self.di = di or {}; self.viec = []; self.serial = serial
    def app_current(self):
        pkg, act, _ = MAN[self.man]
        return {"package": pkg, "activity": act}
    def dump_hierarchy(self):
        return MAN[self.man][2]
    def press(self, k):
        self.viec.append("back"); self.man = self.di.get(("back", self.man), self.man)
    def app_start(self, pkg, stop=False):
        k = "mo_lai" if stop else "mo_app"
        self.viec.append(k); self.man = self.di.get((k, self.man), "feed")
    def swipe(self, *a):
        self.viec.append("vuot")
    def window_size(self):
        return (1080, 1920)
    def __call__(self, **k):
        return Nut()
`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phuchoi-'));
function chay(ten, than, env = {}) {
  const f = path.join(TMP, ten + '.py');
  fs.writeFileSync(f, NEN + '\n' + than, 'utf8');
  const r = spawnSync(py.cmd, [...py.args, f], {
    encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, {
      APP_DIR: R, FX, PYTHONIOENCODING: 'utf-8', GUI_MODE: '1', ASK_ON: '0', CYCLE_ON: '0',
      DWELL_MIN: '0', DWELL_MAX: '0', MODE: 'scan',
    }, env),
  });
  const dong = String(r.stdout || '').split(/\r?\n/);
  const kq = dong.find((l) => l.startsWith('@@KQ@@'));
  return {
    kq: kq ? JSON.parse(kq.slice(6)) : null,
    ma: r.status,
    loi: String(r.stderr || '').slice(-600),
    log: dong.filter((l) => l && !l.startsWith('@@')),
    su_kien: dong.filter((l) => l.startsWith('@@EVENT@@')).map((l) => JSON.parse(l.slice(9))),
  };
}

// ── 1. Phân loại lỗi ──
{
  const r = chay('phan_loai', `
mat = ["device offline", "device '192.168.5.121:5555' not found", "adb lỗi: shell pm list packages -3\\nadb.exe: device offline",
       "error: no devices/emulators found", "device unauthorized"]
khong = ["Remote end closed connection without response", "UiObjectNotFoundError: element not found", "boom"]
out = {
  "mat": [S.la_loi_mat_ket_noi(Exception(x)) for x in mat],
  "khong_mat": [S.la_loi_mat_ket_noi(Exception(x)) for x in khong],
  "dut": S.la_loi_dut_dich_vu(http.client.RemoteDisconnected("Remote end closed connection without response")),
  "dut_reset": S.la_loi_dut_dich_vu(ConnectionResetError("Connection reset by peer")),
  "khong_dut": S.la_loi_dut_dich_vu(Exception("device offline")),
}
print("@@KQ@@" + json.dumps(out), flush=True)
`);
  check('1. Chạy được', !!r.kq, r.loi);
  if (r.kq) {
    check('1a. Mọi câu "mất kết nối" của adb/adbutils đều nhận ra (kể cả câu trong log máy .121)', r.kq.mat.every(Boolean), JSON.stringify(r.kq.mat));
    check('1b. "element not found" của uiautomator2 KHÔNG bị nhận nhầm là mất kết nối', r.kq.khong_mat.every((x) => !x), JSON.stringify(r.kq.khong_mat));
    check('1c. "Remote end closed connection" (log 06:04) = dịch vụ trên máy đứt kết nối', r.kq.dut && r.kq.dut_reset && !r.kq.khong_dut);
  }
}

// ── 2. ve_feed: đưa máy về feed từ mọi chỗ lạc, chỉ bằng Back / mở app ──
{
  const r = chay('ve_feed', `
S.ACTIVE_PKG = TT
ca = {
  "o_feed":    ("feed", {}),
  "nhac":      ("nhac", {("back", "nhac"): "feed"}),
  "sau_2":     ("video", {("back", "video"): "ho_so", ("back", "ho_so"): "feed"}),
  "launcher":  ("launcher", {("mo_app", "launcher"): "feed"}),
  "hop_thoai": ("hop_thoai", {("back", "hop_thoai"): "feed"}),
  "tako":      ("tako", {("back", "tako"): "feed"}),
  "mo_lai":    ("nhac", {("mo_lai", "nhac"): "feed"}),
  "ket":       ("nhac", {("mo_lai", "nhac"): "nhac", ("mo_app", "nhac"): "nhac"}),
}
out = {}
for ten, (dau, di) in ca.items():
    m = May(dau, di)
    out[ten] = [S.ve_feed(m, "thử"), m.viec, m.man]
print("@@KQ@@" + json.dumps(out, ensure_ascii=False), flush=True)
`);
  check('2. Chạy được', !!r.kq, r.loi);
  if (r.kq) {
    const k = r.kq;
    const log = r.log.join('\n');
    check('2a. Đang ở feed → KHÔNG làm gì, KHÔNG in gì (canh gác gọi cả khi feed bình thường)',
      k.o_feed[0] === 'o_feed' && k.o_feed[1].length === 0);
    check('2b. Lạc ở trang nhạc (log 06:04) → Back 1 lần, về feed',
      k.nhac[0] === 'back' && JSON.stringify(k.nhac[1]) === '["back"]' && k.nhac[2] === 'feed');
    check('2c. Lạc sâu hai tầng (video trong trang cá nhân) → Back tới khi về feed',
      k.sau_2[0] === 'back' && k.sau_2[1].length === 2 && k.sau_2[2] === 'feed');
    check('2d. TikTok không còn mở (màn hình chính) → mở lại TikTok',
      k.launcher[0] === 'mo_app' && k.launcher[1].includes('mo_app') && k.launcher[2] === 'feed', JSON.stringify(k.launcher));
    check('2e. Hộp thoại hệ thống che TikTok ("Storage low") → một cú Back đóng nó, không mở lại app',
      k.hop_thoai[0] === 'mo_app' && JSON.stringify(k.hop_thoai[1]) === '["back"]');
    check('2f. Lạc vào Tako → lùi bằng đường riêng của Tako', k.tako[0] === 'back' && k.tako[2] === 'feed');
    check('2g. Back 3 lần không ra → khởi động lại TikTok', k.mo_lai[0] === 'mo_lai'
      && JSON.stringify(k.mo_lai[1]) === '["back","back","back","mo_lai"]', JSON.stringify(k.mo_lai));
    check('2h. Khởi động lại vẫn không ra → báo "khong_ve_duoc" và NÓI RA', k.ket[0] === 'khong_ve_duoc'
      && /⛔ Lạc khỏi feed \(thử\) — đang ở trang nhạc; .* mà vẫn chưa về được feed/.test(log));
    check('2i. Chỉ Back và mở app — không một cú chạm hay vuốt nào lên màn hình lạ',
      Object.values(k).every(([, viec]) => viec.every((v) => ['back', 'mo_app', 'mo_lai'].includes(v))));
    check('2j. Mỗi lần đưa về in MỘT dòng nói rõ đang ở đâu và đã làm gì',
      log.includes('⚠ Lạc khỏi feed (thử) — đang ở trang nhạc → bấm Back 1 lần, đã về feed.')
      && log.includes('đang ở màn hình chính (TikTok không ở trước mặt) → mở lại TikTok, đã về feed.'), log);
  }
}

// ── 3. Canh gác: 8 video LIỀN không thấy icon sound → đi xem máy đang ở đâu ──
{
  const r = chay('canh_gac', `
goi = []
kich_ban = []
def ve_gia(d, ly_do):
    goi.append(ly_do)
    return kich_ban.pop(0) if kich_ban else "back"
S.ve_feed = ve_gia
m = May("feed")
for _ in range(7): S.canh_gac(m, True)
a = len(goi)
S.canh_gac(m, True)
b = len(goi)
for _ in range(5): S.canh_gac(m, True)
S.canh_gac(m, False)                       # một video CÓ icon: chuỗi đếm lại từ đầu
for _ in range(7): S.canh_gac(m, True)
c = len(goi)
# 3 vòng liền máy VẪN ở feed mà không có icon → khởi động lại TikTok (một lần mỗi 30 phút)
kich_ban[:] = ["o_feed"] * 6
for _ in range(24): S.canh_gac(m, True)
lan_1 = list(m.viec)
for _ in range(24): S.canh_gac(m, True)
lan_2 = list(m.viec)
print("@@KQ@@" + json.dumps({"a": a, "b": b, "c": c, "ly_do": goi[0] if goi else "", "lan_1": lan_1, "lan_2": lan_2}, ensure_ascii=False), flush=True)
`);
  check('3. Chạy được', !!r.kq, r.loi);
  if (r.kq) {
    const log = r.log.join('\n');
    check('3a. 7 video liền không có icon → chưa làm gì (quảng cáo / bài ảnh xen kẽ là bình thường)', r.kq.a === 0);
    check('3b. Video thứ 8 → đi xem máy đang ở đâu', r.kq.b === 1 && r.kq.ly_do === '8 video liền không thấy icon sound', r.kq.ly_do);
    check('3c. Có một video có icon xen giữa → đếm lại từ đầu', r.kq.c === 1);
    check('3d. 24 video không có icon dù máy VẪN ở feed → khởi động lại TikTok',
      JSON.stringify(r.kq.lan_1) === '["mo_lai"]' && /24 video liền không thấy icon sound dù đang ở feed — khởi động lại TikTok/.test(log));
    check('3e. Lặp lại trong 30 phút → KHÔNG khởi động lại nữa, mà nói rõ có thể TikTok đổi giao diện',
      JSON.stringify(r.kq.lan_2) === '["mo_lai"]' && /có thể TikTok vừa đổi giao diện/.test(log));
  }
}

// ── 4. Chờ nối lại khi mất kết nối ADB ──
{
  const r = chay('cho_noi_lai', `
def lam_adb(tra_loi, hw=""):
    goi = []
    def adb_gia(*args, serial=None, timeout=60):
        goi.append(args[0])
        if args[0] == "get-state":
            ok = tra_loi.pop(0) if tra_loi else False
            if not ok:
                raise RuntimeError("adb lỗi: get-state\\nerror: device offline")
            return "device"
        if args[:3] == ("shell", "getprop", "ro.serialno"):
            return hw
        return "connected"
    return adb_gia, goi
out = {}
S.adb, g = lam_adb([False, False, False, False, True])
out["noi_lai"] = [S.cho_noi_lai("192.168.5.121:5555"), g.count("connect")]
S.adb, g = lam_adb([])
bat_dau = time.time()
out["het_ca"] = [S.cho_noi_lai("192.168.5.121:5555", han=bat_dau + 100), time.time() - bat_dau]
S.adb, g = lam_adb([False] * 60 + [True])
bat_dau = time.time()
out["lau"] = [S.cho_noi_lai("192.168.5.121:5555"), time.time() - bat_dau]
S.adb, g = lam_adb([False, False, True])
out["usb"] = [S.cho_noi_lai("R58M12345"), g.count("connect")]
S.adb, g = lam_adb([])
out["app_dong"] = [S.cho_noi_lai("192.168.5.121:5555", dung=lambda: True)]
# Noi lai duoc, nhung IP do gio la mot dien thoai KHAC (DHCP cap lai sau khi khoi dong lai).
S.MAY["hw"] = "HW-CUA-MINH"
S.adb, g = lam_adb([False, True], hw="HW-MAY-KHAC")
out["khac_may"] = [S.cho_noi_lai("192.168.5.115:5555")]
S.adb, g = lam_adb([False, True], hw="HW-CUA-MINH")
out["dung_may"] = [S.cho_noi_lai("192.168.5.115:5555")]
out["dem"] = S.PHUC_HOI["mat_ket_noi"]
print("@@KQ@@" + json.dumps(out), flush=True)
`);
  check('4. Chạy được', !!r.kq, r.loi);
  if (r.kq) {
    const log = r.log.join('\n');
    check('4a. Máy quay lại → "noi_lai", có tự "adb connect" (máy nối qua mạng)',
      r.kq.noi_lai[0] === 'noi_lai' && r.kq.noi_lai[1] >= 1, JSON.stringify(r.kq.noi_lai));
    check('4b. Mất kết nối nói ĐÚNG MỘT dòng lúc đầu và MỘT dòng lúc kết thúc — không in lỗi mỗi vòng',
      (log.match(/⛔ Mất kết nối ADB tới máy/g) || []).length === 7
      && (log.match(/✅ Nối lại được sau/g) || []).length === 3, log);
    // Thoát NGAY lúc hết hạn (trong 1 giây), không đợi hết lượt chờ 15–60 giây: hết ca là phải nhả
    // khe cho máy đang xếp hàng.
    check('4c. Hết hạn ca khi đang chờ → "het" NGAY lúc hết hạn (không treo, không đợi hết lượt chờ)',
      r.kq.het_ca[0] === 'het' && r.kq.het_ca[1] >= 100 && r.kq.het_ca[1] <= 101, JSON.stringify(r.kq.het_ca));
    // Điện thoại khởi động lại thường nhận IP MỚI: chờ mãi ở IP cũ là chờ một địa chỉ có thể không
    // bao giờ quay lại. Quá 2 phút thì thoát để Node dò lại IP rồi chạy lại sau 1 phút.
    check('4d. Mất kết nối quá 2 phút → "thoat" (để app dò lại IP), đúng mốc 2 phút, nói rõ lý do',
      r.kq.lau[0] === 'thoat' && r.kq.lau[1] >= 120 && r.kq.lau[1] <= 121
      && /Mất kết nối quá 2 phút — thoát để app dò lại IP/.test(log), JSON.stringify(r.kq.lau));
    check('4e. Máy cắm USB → chỉ chờ, không gọi "adb connect"', r.kq.usb[0] === 'noi_lai' && r.kq.usb[1] === 0);
    check('4f. App đóng trong lúc chờ → "het" ngay', r.kq.app_dong[0] === 'het');
    check('4h. Nối lại được nhưng IP đó giờ là MỘT ĐIỆN THOẠI KHÁC → "thoat", không lái nhầm máy',
      r.kq.khac_may[0] === 'thoat' && /giờ là MỘT ĐIỆN THOẠI KHÁC \(số máy HW-MAY-KHAC\)/.test(log));
    check('4i. Nối lại đúng chiếc điện thoại cũ → quét tiếp', r.kq.dung_may[0] === 'noi_lai');
    const ev = r.su_kien.filter((e) => e.type === 'status').map((e) => e.state);
    check('4g. Báo giao diện "offline" lúc mất, "running" lúc nối lại', ev.includes('offline') && ev.includes('running'), ev.join(','));
  }
}

// ── 6. Trang nhạc vẽ lại giữa chừng (StaleObjectException) → tìm lại phần tử, KHÔNG mất sound ──
// Đo thật trên máy .117 lúc thử nối lại (2026-09-19): 4 lần trong 14 video.
{
  const r = chay('phan_tu_cu', `
CU = Exception("('Unknown RPC error: -32001 androidx.test.uiautomator.StaleObjectException', ({'mask': 2097152},))")
class El:
    def __init__(self, chu, hong=0):
        self.chu = chu; self.hong = hong
    @property
    def info(self):
        if self.hong:
            self.hong -= 1
            raise CU
        return {"contentDescription": self.chu}
    def get_text(self):
        if self.hong:
            self.hong -= 1
            raise CU
        return self.chu
    def click(self): pass
tim_lai = []
doc_so = []
def ff(d, ids, timeout=0):
    if ids is S.SOUND_ICON_IDS: return El("")
    if ids is S.TITLE_IDS:
        tim_lai.append(1)
        return El("Original Sound T Lajico 3,200 posts", hong=1 if len(tim_lai) == 1 else 0)
    if ids is S.COUNT_IDS:
        doc_so.append(1)
        return El("3,200 posts", hong=1 if len(doc_so) == 1 else 0)     # lần đọc số ĐẦU TIÊN hỏng
    return None
S.find_first = ff
S.lay_link_that = lambda d: "https://www.tiktok.com/music/%C3%A2m-thanh-g%E1%BB%91c-Lajico-7633696888679598855"
S.REST_AFTER_BACK = 0
m = May("feed")
kq = S.check_current_video(m)
print("@@KQ@@" + json.dumps({"kq": kq, "tim_lai": len(tim_lai), "doc_so": len(doc_so)}, ensure_ascii=False), flush=True)
`, { MIN_POSTS: '1000', MAX_POSTS: '100000', SETTLE_SEC: '5' });
  check('6. Chạy được', !!r.kq, r.loi);
  if (r.kq) {
    const kq = r.kq.kq;
    check('6a. Tên sound đọc hỏng một lần vì trang vẽ lại → tìm lại phần tử và đọc được',
      r.kq.tim_lai >= 2 && Array.isArray(kq) && Array.isArray(kq[0]) && kq[0][2] === 'T Lajico', JSON.stringify(r.kq));
    check('6b. Số video đọc hỏng vì trang vẽ lại → đọc lại, sound vẫn được lấy (không mất, không lỗi)',
      Array.isArray(kq) && Array.isArray(kq[0]) && kq[0][1] === 3200 && r.kq.doc_so >= 2, JSON.stringify(r.kq));
  }
}

// ── 5. CẢ VÒNG QUÉT THẬT (`main`) — tái hiện đúng hai log của chủ dự án ──
// Điện thoại, adb và đồng hồ là giả; mọi thứ còn lại là mã thật.
const VONG = `
kq_video = []                  # kịch bản từng video: "icon" | "khong_icon" | ("loi", câu) | ("lac", man)
dem = {"reset": 0, "setup": 0, "check": 0}
m = May("feed", {("back", "nhac"): "feed"})
S.connect = lambda serial: m
S.list_devices = lambda *a, **k: [m.serial]
def reset_gia(d):
    dem["reset"] += 1
S.reset_service = reset_gia
def setup_gia(d):
    dem["setup"] += 1
    if SETUP_HONG and dem["setup"] > 1:
        raise RuntimeError("Khong the mo TikTok sau 3 lan thu.")
    m.man = "feed"
    return TT
S.setup_device = setup_gia
get_state = []
HW_THAT = ""                   # so may phan cung cua dien thoai dang o IP nay
def adb_gia(*args, serial=None, timeout=60):
    if args[0] == "get-state":
        ok = get_state.pop(0) if get_state else MAC_DINH_KET_NOI
        if not ok:
            raise RuntimeError("adb lỗi: get-state\\nerror: device offline")
        return "device"
    if args[:3] == ("shell", "getprop", "ro.serialno"):
        return HW_THAT
    return ""
S.adb = adb_gia
S.OUTPUT_FILE = os.path.join(os.environ["TMPDIR_TEST"], "sound_links.txt")
def check_gia(d):
    dem["check"] += 1
    buoc = kq_video.pop(0) if kq_video else "tuy_man"
    if isinstance(buoc, tuple) and buoc[0] == "loi":
        if len(buoc) > 2:
            m.man = buoc[2]
        raise buoc[1]
    if isinstance(buoc, tuple) and buoc[0] == "lac":
        m.man = buoc[1]
        return (None, True)
    if buoc == "tuy_man":
        buoc = "icon" if m.man == "feed" else "khong_icon"
    if buoc == "icon":
        return (None, True)
    S.TRUOT["khong_icon"] += 1
    return (None, False)
S.check_current_video = check_gia
`;
function chayVong(ten, kichBan, env = {}) {
  return chay(ten, VONG + kichBan + `
sys.argv = ["scan_feed_sounds.py", m.serial]
try:
    S.main()
    ma = 0
except SystemExit as e:
    ma = e.code
print("@@KQ@@" + json.dumps({"ma": ma, "dem": dem, "khong_icon": S.TRUOT["khong_icon"], "viec": m.viec}), flush=True)
`, Object.assign({ TMPDIR_TEST: TMP }, env));
}

// 5a. Log 1: lỗi "Remote end closed" lúc đang ở trang nhạc
{
  const r = chayVong('log1', `
SETUP_HONG = False
MAC_DINH_KET_NOI = True
kq_video[:] = ["icon", "icon", ("loi", http.client.RemoteDisconnected("Remote end closed connection without response"), "nhac")]
`, { LIMIT: '15' });
  check('5a. Chạy được vòng quét thật với lỗi của log 1', !!r.kq, r.loi || r.log.slice(-5).join(' | '));
  if (r.kq) {
    const log = r.log.join('\n');
    check('5a1. Dịch vụ trên máy đứt → khởi động lại NGAY, không đợi đủ 3 lỗi',
      /Dịch vụ điều khiển trên máy vừa đứt kết nối — khởi động lại nó ngay/.test(log) && r.kq.dem.reset >= 2);
    check('5a2. Máy đang kẹt ở trang nhạc → đưa về feed ngay sau lỗi',
      log.includes('⚠ Lạc khỏi feed (sau lỗi ở video #3) — đang ở trang nhạc → bấm Back 1 lần, đã về feed.'), log);
    check('5a3. Sau đó KHÔNG còn video nào "không có sound" (bản cũ: 3 tiếng liền)', r.kq.khong_icon === 0, `${r.kq.khong_icon} video`);
    check('5a4. Chạy đủ ca, tổng kết có "đưa máy về feed"', /✅ Xong ca: quét 15 video.*đưa máy về feed 1 lần/.test(log));
  }
}

// 5b. Lạc KHÔNG kèm lỗi nào (trang nhạc mở chậm) → canh gác bắt được
{
  const r = chayVong('lac_im', `
SETUP_HONG = False
MAC_DINH_KET_NOI = True
kq_video[:] = ["icon", ("lac", "nhac")]
`, { LIMIT: '20' });
  check('5b. Chạy được', !!r.kq, r.loi || r.log.slice(-5).join(' | '));
  if (r.kq) {
    const log = r.log.join('\n');
    check('5b1. Lạc im lặng → canh gác đưa về feed sau đúng 8 video không có icon',
      log.includes('⚠ Lạc khỏi feed (8 video liền không thấy icon sound) — đang ở trang nhạc → bấm Back 1 lần, đã về feed.')
      && r.kq.khong_icon === 8, `${r.kq.khong_icon} video không icon`);
  }
}

// 5c. Log 2: mất kết nối ADB giữa ca
{
  const r = chayVong('log2', `
SETUP_HONG = False
MAC_DINH_KET_NOI = True
kq_video[:] = ["icon", ("loi", Exception("device offline"))]
get_state[:] = [False, False, False, False, True]
`, { LIMIT: '10' });
  check('5c. Chạy được vòng quét thật với lỗi của log 2', !!r.kq, r.loi || r.log.slice(-5).join(' | '));
  if (r.kq) {
    const log = r.log.join('\n');
    check('5c1. Mất kết nối → chờ, nối lại, rồi khởi động lại dịch vụ + mở lại TikTok',
      /⛔ Mất kết nối ADB tới máy/.test(log) && /✅ Nối lại được sau/.test(log)
      && r.kq.dem.reset >= 2 && r.kq.dem.setup >= 2, JSON.stringify(r.kq.dem));
    check('5c2. KHÔNG còn chuỗi "Lỗi ở video … (device offline)" / "Phục hồi lỗi" như log máy .121',
      !/Lỗi ở video|Phục hồi lỗi|Vuốt sang video kế lỗi/.test(log), log);
    check('5c3. Lượt mất kết nối không bị đếm là một video: vẫn quét đủ 10 video THẬT (11 lượt gọi, 1 lượt hỏng)',
      /✅ Xong ca: quét 10 video/.test(log) && r.kq.dem.check === 11, JSON.stringify(r.kq.dem));
  }
}

// 5d. Bậc 3: phục hồi tại chỗ hỏng 3 lần liền → thoát mã 1 để app chạy lại tiến trình mới
{
  const r = chayVong('bac3', `
SETUP_HONG = True
MAC_DINH_KET_NOI = True
kq_video[:] = [("loi", Exception("lỗi lạ"))] * 40
`, { LIMIT: '100' });
  check('5d. Chạy được', !!r.kq, r.loi || r.log.slice(-5).join(' | '));
  if (r.kq) {
    const log = r.log.join('\n');
    check('5d1. Phục hồi hỏng 3 lần liền → thoát MÃ 1 (Node sẽ chạy lại máy này)', r.kq.ma === 1, `mã ${r.kq.ma}`);
    check('5d2. Nói rõ lý do và KHÔNG báo "done" (done = hết ca bình thường)',
      /Phục hồi hỏng 3 lần liền — thoát để app tự chạy lại/.test(log) && /⛔ Dừng ca vì lỗi/.test(log)
      && !r.su_kien.some((e) => e.type === 'status' && e.state === 'done'));
  }
}

// 5e. Mất kết nối mãi mà hết ca → thoát đúng cách, không treo
{
  const r = chayVong('het_ca', `
SETUP_HONG = False
MAC_DINH_KET_NOI = False
kq_video[:] = [("loi", Exception("device offline"))]
`, { CYCLE_ON: '1', CYCLE_SCAN_MIN: '2', LIMIT: '0' });
  check('5e. Chạy được', !!r.kq, r.loi || r.log.slice(-5).join(' | '));
  if (r.kq) {
    check('5e1. Hết ca trong lúc chờ nối lại → báo hết ca và thoát, không treo mãi',
      r.kq.ma === 0 && r.su_kien.some((e) => e.type === 'status' && e.state === 'cycle_done')
      && !r.log.some((l) => /✅ Nối lại/.test(l)), r.log.slice(-4).join(' | '));
  }
}

// 5f. Feed KHÔNG SANG VIDEO MỚI (đo thật trên máy .117: một bài ảnh giữ feed đứng yên 8 vòng liền)
// → vòng sau đổi sang cách kéo từng điểm; vẫn đứng yên thì khởi động lại TikTok.
{
  const r = chayVong('ket_video', `
SETUP_HONG = False
MAC_DINH_KET_NOI = True
kq_video[:] = ["icon"] * 20
class KeoGia:
    def down(self, x, y): pass
    def move(self, x, y): pass
    def up(self, x, y): m.viec.append("keo")
m.touch = KeoGia()
class CauGia:
    enabled = True
    parent_gone = False
    def __init__(self, *a, **k): pass
    def ask(self, **k): return 1
    def take(self, aid): return {}
    def acted(self, *a, **k): pass
S.AskBridge = CauGia
dem_doc = [0]
def doc_gia(d):
    # Truoc khi TikTok duoc khoi dong lai: luon CUNG mot video. Sau do: moi vong mot video moi.
    if "mo_lai" not in m.viec:
        return {"author": "Trend Master", "handle": "", "desc": "How to go viral on TikTok", "badges": [], "live": False, "tako": False}
    dem_doc[0] += 1
    return {"author": f"Người {dem_doc[0]}", "handle": "", "desc": f"video {dem_doc[0]}", "badges": [], "live": False, "tako": False}
PA.read_video_info = doc_gia
`, { LIMIT: '8', ASK_ON: '1' });
  check('5f. Chạy được', !!r.kq, r.loi || r.log.slice(-5).join(' | '));
  if (r.kq) {
    const v = r.kq.viec.filter((x) => ['vuot', 'keo', 'mo_lai'].includes(x));
    check('5f1. Lần đầu vuốt thường; thấy CÙNG video ở vòng sau → đổi sang kéo từng điểm',
      v[0] === 'vuot' && v[1] === 'keo' && v[2] === 'keo', v.join(','));
    check('5f2. Vẫn cùng video ở vòng thứ 4 → khởi động lại TikTok, nói rõ lý do',
      v[3] === 'mo_lai' && r.log.some((l) => /Feed không sang được video mới \(4 vòng liền cùng một video\) — khởi động lại TikTok/.test(l)),
      v.join(','));
    check('5f3. Feed chạy lại bình thường → quay về cú vuốt thường', v.slice(4).every((x) => x === 'vuot') && v.length >= 6, v.join(','));
  }
}

// 5g–5i. MÁY ĐỔI IP (2026-09-19): khởi động lượt chạy trên đúng / sai điện thoại.
{
  const r = chayVong('sai_may', `
SETUP_HONG = False
MAC_DINH_KET_NOI = True
HW_THAT = "HW-GM1911"
`, { LIMIT: '5', DEVICE_HW: 'HW-V2031' });
  check('5g. IP giờ là MỘT ĐIỆN THOẠI KHÁC ngay lúc khởi động → thoát mã 1, KHÔNG quét trên máy đó',
    !!r.kq && r.kq.ma === 1 && r.kq.dem.setup === 0 && r.kq.viec.length === 0
    && r.log.some((l) => /giờ là MỘT ĐIỆN THOẠI KHÁC \(số máy HW-GM1911, không phải HW-V2031\)/.test(l)),
    r.loi || r.log.slice(-3).join(' | '));
}
{
  const r = chayVong('khong_online', `
SETUP_HONG = False
MAC_DINH_KET_NOI = True
def connect_hong(serial):
    raise Exception("device 192.168.5.148:5555 not online")
S.connect = connect_hong
`, { LIMIT: '5' });
  check('5h. Điện thoại không online lúc khởi động (log 11:40) → MỘT dòng nói rõ, thoát mã 1, không có traceback',
    !!r.kq && r.kq.ma === 1 && r.log.some((l) => /⛔ Không kết nối được điện thoại .*not online.*thử lại sau 1 phút/.test(l))
    && !/Traceback/.test(r.loi), r.loi.slice(-300) || r.log.slice(-3).join(' | '));
}
{
  const r = chayVong('mat_lau', `
SETUP_HONG = False
MAC_DINH_KET_NOI = False
kq_video[:] = ["icon", ("loi", Exception("device offline"))]
`, { LIMIT: '0' });
  check('5i. Mất kết nối giữa ca quá 2 phút → thoát mã 1 để app dò lại IP (máy có thể vừa đổi IP)',
    !!r.kq && r.kq.ma === 1 && r.log.some((l) => /Mất kết nối quá 2 phút — thoát để app dò lại IP/.test(l)),
    r.loi || r.log.slice(-3).join(' | '));
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
done();
