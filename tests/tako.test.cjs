// tests/tako.test.cjs — máy không được kẹt trong TikTok Tako (trợ lý chat AI của TikTok).
//
// SỰ CỐ THẬT (2026-09-18): chủ dự án chụp màn hình máy .140 (Redmi Note 8 Pro) đứng ở trang
// "Hey, I'm Tako". Chụp lại 20 phút sau vẫn nguyên đó: vòng quét không có bước nào hỏi "còn ở
// feed không", nên cứ vuốt, cứ đếm "video không có sound" trên một màn hình chat.
//
// Hai bản chụp THẬT làm mốc, lưu ở `tests/fixtures/`:
//   • `tako_man_hinh_46.9.3.xml`  — chính màn hình Tako trên máy .140 lúc đang kẹt
//   • `feed_nut_tako_46.9.3.xml`  — một video trên feed CÓ nút Tako ở cột nút bên phải (máy .120).
//     Đây vẫn là feed, nhận nhầm nó là Tako thì máy bấm Back ngay giữa feed.
//
// Chạy ĐÚNG hàm Python thật, chỉ thay điện thoại bằng một máy giả trả về các bản chụp đó.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
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

// Máy giả: `man` là danh sách bản chụp theo thứ tự — mỗi lần Back thì sang bản kế.
const MAY_GIA = `
import sys, os, json, time
sys.path.insert(0, os.environ["APP_DIR"])
time.sleep = lambda s: None
import phone_actions as PA
FX = os.environ["FX"]
def doc(ten):
    return open(os.path.join(FX, ten), encoding="utf-8").read() if ten.endswith(".xml") else ten
TAKO = doc("tako_man_hinh_46.9.3.xml")
FEED = doc("feed_nut_tako_46.9.3.xml")
class May:
    def __init__(self, man, activity="com.ss.android.ugc.aweme.splash.SplashActivity"):
        self.man = list(man); self.i = 0; self.viec = []; self.act = activity
    def dump_hierarchy(self):
        return self.man[min(self.i, len(self.man) - 1)]
    def press(self, k):
        self.viec.append("back:" + k); self.i += 1
    def app_start(self, goi, stop=False):
        self.viec.append("mo_lai:" + goi); self.i += 1
    def app_current(self):
        return {"package": "com.zhiliaoapp.musically", "activity": self.act}
    def swipe(self, *a):
        self.viec.append("vuot:%.2f>%.2f" % (a[1], a[3])); self.i += 1
    def window_size(self):
        return (1080, 1920)
    def shell(self, *a, **k):
        pass
`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tako-'));
function chay(tenKichBan, thanKichBan) {
  const f = path.join(TMP, tenKichBan + '.py');
  fs.writeFileSync(f, MAY_GIA + '\n' + thanKichBan, 'utf8');
  const r = spawnSync(py.cmd, [...py.args, f], {
    encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, { APP_DIR: R, FX, PYTHONIOENCODING: 'utf-8', GUI_MODE: '1' }),
  });
  const dong = String(r.stdout || '').split(/\r?\n/);
  const kq = dong.find((l) => l.startsWith('@@KQ@@'));
  return {
    kq: kq ? JSON.parse(kq.slice(6)) : null,
    loi: String(r.stderr || '').slice(-500),
    log: dong.filter((l) => l && !l.startsWith('@@')).join('\n'),
  };
}

// ── 1. Nhận diện: đúng màn hình Tako, KHÔNG nhầm feed có nút Tako ──
{
  const r = chay('nhan_dien', `
out = {
  "tako": PA.la_man_tako(TAKO),
  "feed_co_nut_tako": PA.la_man_tako(FEED),
  "caption_ghi_tako": PA.la_man_tako('<hierarchy><node text="TikTok Tako" resource-id="com.zhiliaoapp.musically:id/desc"/></hierarchy>'),
  "rong": PA.la_man_tako(""),
  "hong": PA.la_man_tako("<hierarchy><node text='TikTok Tako'"),
}
print("@@KQ@@" + json.dumps(out), flush=True)
`);
  check('1. Chạy được hàm thật', !!r.kq, r.loi);
  if (r.kq) {
    check('1a. Bản chụp máy .140 đang kẹt → nhận ra là màn hình Tako', r.kq.tako === true);
    check('1b. Feed có NÚT Tako bên phải → vẫn là feed, không phải màn hình Tako', r.kq.feed_co_nut_tako === false);
    check('1c. Caption tình cờ ghi "TikTok Tako" (chỉ 1 dấu hiệu) → không nhận nhầm', r.kq.caption_ghi_tako === false);
    check('1d. Bản chụp rỗng / hỏng → không nhận nhầm, không ném lỗi', r.kq.rong === false && r.kq.hong === false);
  }
}

// ── 1e. Mọi bản chụp feed / trang cá nhân / trang nhạc có sẵn trên máy này → không phải Tako ──
{
  const mau = fs.readdirSync(R).filter((f) => /^probe_.*\.xml$/.test(f));
  if (mau.length) {
    const r = chay('probe', `
import glob
sai = [os.path.basename(p) for p in glob.glob(os.path.join(os.environ["APP_DIR"], "probe_*.xml"))
       if PA.la_man_tako(open(p, encoding="utf-8").read())]
print("@@KQ@@" + json.dumps(sai), flush=True)
`);
    check(`1e. ${mau.length} bản chụp màn hình khác (feed, trang cá nhân, trang nhạc) → không cái nào bị nhận là Tako`,
      Array.isArray(r.kq) && r.kq.length === 0, r.loi || JSON.stringify(r.kq));
  }
}

// ── 2. Lùi ra: chỉ bấm Back, dừng ngay khi ra khỏi Tako ──
{
  const r = chay('thoat', `
out = {}
m = May([FEED]); out["feed"] = [PA.thoat_tako(m, "com.zhiliaoapp.musically"), m.viec]
m = May([TAKO, FEED]); out["mot_back"] = [PA.thoat_tako(m, "com.zhiliaoapp.musically"), m.viec]
m = May([TAKO, TAKO, FEED]); out["hai_back"] = [PA.thoat_tako(m, "com.zhiliaoapp.musically"), m.viec]
m = May([TAKO, TAKO, TAKO, TAKO, FEED]); out["mo_lai"] = [PA.thoat_tako(m, "com.zhiliaoapp.musically"), m.viec]
m = May([TAKO]); out["ket"] = [PA.thoat_tako(m, "com.zhiliaoapp.musically"), m.viec]
print("@@KQ@@" + json.dumps(out), flush=True)
`);
  check('2. Chạy được', !!r.kq, r.loi);
  if (r.kq) {
    const k = r.kq;
    check('2a. Đang ở feed → không làm gì cả (không bấm Back giữa feed)',
      k.feed[0] === '' && k.feed[1].length === 0, JSON.stringify(k.feed));
    check('2b. Ở Tako → bấm Back, ra rồi thì DỪNG (không Back thêm cú nào)',
      k.mot_back[0] === 'back' && JSON.stringify(k.mot_back[1]) === '["back:back"]', JSON.stringify(k.mot_back));
    check('2c. Back đầu chỉ đóng bàn phím → bấm thêm một Back', k.hai_back[0] === 'back' && k.hai_back[1].length === 2);
    check('2d. Back 3 lần vẫn còn → mở lại TikTok',
      k.mo_lai[0] === 'mo_lai' && k.mo_lai[1].length === 4 && k.mo_lai[1][3] === 'mo_lai:com.zhiliaoapp.musically',
      JSON.stringify(k.mo_lai));
    check('2e. Mở lại vẫn kẹt → báo "ket" để vòng quét đưa vào nhánh phục hồi', k.ket[0] === 'ket');
    check('2f. Chỉ Back và mở lại app — KHÔNG có cú chạm hay vuốt nào trên màn hình Tako',
      Object.values(k).every(([, viec]) => viec.every((v) => /^(back|mo_lai):/.test(v))));
  }
}

// ── 3. read_video_info soi ké Tako trên cùng bản chụp ──
{
  const r = chay('doc_video', `
out = {"tako": PA.read_video_info(May([TAKO])), "feed": PA.read_video_info(May([FEED]))}
print("@@KQ@@" + json.dumps(out, ensure_ascii=False), flush=True)
`);
  check('3. Chạy được', !!r.kq, r.loi);
  if (r.kq) {
    check('3a. Đọc video lúc đang ở Tako → cờ tako = true', r.kq.tako.tako === true);
    check('3b. Đọc video trên feed → cờ tako = false', r.kq.feed.tako === false);
  }
}

// ── 4. Hộp thoại nhắc tới Tako: chỉ bấm Back, không bấm "Continue" ──
{
  const r = chay('hop_thoai', `
import scan_feed_sounds as S
class Nut:
    def __init__(self, may, co): self.may = may; self.exists = co
    def click(self): self.may.viec.append("bam")
class MayHopThoai(May):
    def __init__(self, man, nut): May.__init__(self, man); self.nut = nut
    def __call__(self, text=None, resourceId=None, **k):
        return Nut(self, text == self.nut)
GIOI_THIEU = '<hierarchy><node text="Meet TikTok Tako, your AI assistant"/><node text="Continue"/></hierarchy>'
THUONG = '<hierarchy><node text="Contacts access"/><node text="Not now"/></hierarchy>'
m1 = MayHopThoai([GIOI_THIEU], "Continue"); S.dismiss_popups(m1)
m2 = MayHopThoai([THUONG], "Not now"); S.dismiss_popups(m2)
print("@@KQ@@" + json.dumps({"tako": m1.viec, "thuong": m2.viec, "buoc": S.BUOC["v"]}, ensure_ascii=False), flush=True)
`);
  check('4. Chạy được', !!r.kq, r.loi);
  if (r.kq) {
    check('4a. Hộp thoại giới thiệu Tako có nút "Continue" → chỉ bấm Back, KHÔNG bấm Continue',
      JSON.stringify(r.kq.tako) === '["back:back"]', JSON.stringify(r.kq.tako));
    check('4b. Hộp thoại thường → vẫn bấm nút như cũ', JSON.stringify(r.kq.thuong) === '["bam"]', JSON.stringify(r.kq.thuong));
  }
}

// ── 5. Vòng quét: lọt vào Tako thì đếm, nói rõ sau bước nào, và báo "ket" khi không ra được ──
{
  const r = chay('xu_ly', `
import scan_feed_sounds as S
S.BUOC["v"] = "ghé trang cá nhân"
m = May([TAKO, FEED]); a = S.xu_ly_tako(m)
m2 = May([FEED]); b = S.xu_ly_tako(m2)
m3 = May([TAKO]); c = S.xu_ly_tako(m3)
print("@@KQ@@" + json.dumps({"a": a, "b": b, "c": c, "dem": S.TRUOT["tako"]}), flush=True)
`);
  check('5. Chạy được', !!r.kq, r.loi);
  if (r.kq) {
    check('5a. Lọt vào rồi lùi ra → "back", và đếm vào tổng kết', r.kq.a === 'back' && r.kq.dem === 2, JSON.stringify(r.kq));
    check('5b. Không ở Tako → "" (không làm gì)', r.kq.b === '');
    check('5c. Lùi không ra → "ket" (vòng quét ném lỗi để vào nhánh phục hồi)', r.kq.c === 'ket');
    check('5d. Log nói rõ lọt vào NGAY SAU BƯỚC NÀO — đó là cách đo lối vào thật trên farm',
      /Lọt vào TikTok Tako \(trợ lý AI\) ngay sau bước "ghé trang cá nhân" — đã bấm Back thoát ra\./.test(r.log), r.log);
  }
}

// ── 6. Pha Xem: Tako mở đè lên trình phát (activity không đổi) → vẫn thấy và thôi link đó ──
{
  const r = chay('pha_xem', `
m = May([FEED, TAKO, FEED], activity="com.ss.android.ugc.aweme.detail.ui.DetailActivity")
dong = []
kq = PA.xem_mot_link(m, "com.zhiliaoapp.musically", "https://www.tiktok.com/@a/video/1", None,
                     lambda: False, (0, 0), (3, 3), (0, 0), log=dong.append)
print("@@KQ@@" + json.dumps({"kq": kq, "viec": m.viec, "log": dong}, ensure_ascii=False), flush=True)
`);
  check('6. Chạy được', !!r.kq, r.loi);
  if (r.kq) {
    const vuot = r.kq.viec.filter((v) => v.startsWith('vuot'));
    check('6a. Thấy Tako sau cú vuốt đầu → dừng vuốt (không vuốt tiếp 2 cú còn lại trên màn hình Tako)',
      vuot.length === 1, JSON.stringify(r.kq.viec));
    check('6b. Nói ra trong log', r.kq.log.some((l) => /Lọt vào TikTok Tako .* lúc đang vuốt xem/.test(l)), JSON.stringify(r.kq.log));
    check('6c. Vuốt bằng cú vuốt mới (bắt đầu giữa video)', vuot[0] === 'vuot:0.60>0.15', vuot[0]);
  }
}

// ── 7. Nối dây trong vòng quét (phần không chạy được nếu thiếu máy thật) ──
{
  const scan = fs.readFileSync(path.join(R, 'scan_feed_sounds.py'), 'utf8');
  const pa = fs.readFileSync(path.join(R, 'phone_actions.py'), 'utf8');
  const probe = fs.readFileSync(path.join(R, 'probe_screen.py'), 'utf8');
  check('7a. Không còn cú vuốt nào đặt ngón ở 85% (hàng nút dưới đáy video)',
    ![scan, pa, probe].some((s) => /d\.swipe\(0\.5,\s*0\.85/.test(s)));
  const iPop = scan.indexOf('info.pop("tako", False)');
  const iAsk = scan.indexOf('aid = bridge.ask(**info)');
  check('7b. Vòng quét gỡ cờ tako TRƯỚC khi gọi bridge.ask(**info) (thừa khoá là TypeError)',
    iPop > 0 && iAsk > iPop && scan.indexOf('aid = bridge.ask(**info)', iAsk + 1) === -1);
  check('7c. Soi Tako ngay trước mỗi cú vuốt sang video kế',
    /xu_ly_tako\(d\)\s*\n[^\n]*time\.sleep[^\n]*\n\s*BUOC\["v"\] = "vuốt sang video kế"\s*\n[\s\S]{0,900}?PA\.vuot_video_ke\(d, manh=/.test(scan));
  check('7d. Lùi không ra → ném lỗi để vào nhánh phục hồi sẵn có',
    /if xu_ly_tako\(d\) == "ket":[\s\S]{0,300}raise RuntimeError/.test(scan));
  check('7e. Tổng kết cuối ca có số lần lọt vào Tako', /TRUOT\["tako"\][\s\S]{0,120}lọt vào TikTok Tako/.test(scan));
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
done();
