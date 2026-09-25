// tests/tuongtacxem.test.cjs — Tương tác ở pha Xem (2026-09-25): tim / lưu / follow VIDEO ĐẦU của
// mỗi link người dùng điền, theo tỉ lệ, dùng chung trần ngày với For You.
//
// ĐO THẬT trên SM-A920F 52000352c0ee64df (TikTok 45.7.3, tiếng Việt) trước khi viết — bản chụp ở
// tests/fixtures/xem_*_45.7.3.xml (tên tác giả / sound đã thay bằng tên giả):
//   • tim: nhãn "Thích video. …" → "Đã thích video", icon con `selected=true`;
//   • lưu: nhãn KHÔNG đổi, chỉ icon con `selected=true` (kèm tấm "Đã lưu");
//   • follow: vuốt sang trang tác giả đọc được @handle, rồi quay về đúng trình phát.
// Điều phép thử khoá chặt:
//   • tỉ lệ 0 / thiếu = không làm gì; trần ngày hết = không làm;
//   • chỉ ghi sổ khi Python báo 'ok' (đã đọc lại nút);
//   • chỉ VIDEO ĐẦU được tương tác, các video vuốt thêm thì không;
//   • nút đã bật sẵn thì KHÔNG bấm (bấm nữa là gỡ).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const R = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ttxem-'));
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

const ap = require(path.join(R, 'src', 'askproto.cjs'));
const fq = require(path.join(R, 'src', 'followquota.cjs'));
const dc = require(path.join(R, 'src', 'daycount.cjs'));
let soDir = 0;
const newDir = () => { const d = path.join(TMP, 'm' + (++soDir)); fs.mkdirSync(d); return d; };
const hoi = (b, id = 1) => b.answer({ v: ap.PROTO_VERSION, id, kind: 'view_act', author: 'Ten Tac Gia' });

// ── 1. Bộ não: quyết định cho pha Xem ──
{
  fq._resetForTest();
  const b0 = ap.makeBrain({ deviceId: 'x0', dir: newDir(), cfg: { likePerDay: 60, followPerDay: 30 } });
  const a0 = hoi(b0);
  check('1a. Không đặt tỉ lệ → không tim, không lưu, không follow (0 là tắt)', !a0.like && !a0.fav && !a0.follow, JSON.stringify(a0));

  const cfg = { viewLikePct: 100, viewFavPct: 100, viewFollowPct: 100, likePerDay: 60, favPerDay: 30, followPerDay: 30 };
  const b1 = ap.makeBrain({ deviceId: 'x1', dir: newDir(), cfg });
  const a1 = hoi(b1);
  check('1b. Tỉ lệ 100% → được tim + lưu + (đi ghé để) follow', a1.like === 1 && a1.fav === 1 && a1.follow === 1, JSON.stringify(a1));
  check('1c. Câu trả lời có đủ mọi khoá như safeAnswer (Python không đọc trúng khoá thiếu)',
    Object.keys(ap.safeAnswer(1)).every((k) => k in a1));

  // Tỉ lệ thật sự được bốc: 30% → khoảng 30% số lần (rng tất định).
  let n = 0;
  const seq = Array.from({ length: 1000 }, (_, i) => ((i * 7919) % 1000) / 1000);
  let k = 0;
  const b2 = ap.makeBrain({ deviceId: 'x2', dir: newDir(), cfg: { ...cfg, viewLikePct: 30, viewFavPct: 0, viewFollowPct: 0 }, rng: () => seq[(k++) % seq.length] });
  for (let i = 1; i <= 200; i++) if (hoi(b2, i).like) n++;
  check('1d. Tỉ lệ tim 30% → khoảng 30% số link được tim', n >= 45 && n <= 75, `${n}/200`);

  // Trần ngày: tim CHUNG với For You, lưu trần riêng.
  const d3 = newDir();
  for (let i = 0; i < 2; i++) { dc.record(d3, 'like'); dc.record(d3, 'fav'); }
  const b3 = ap.makeBrain({ deviceId: 'x3', dir: d3, cfg: { ...cfg, likePerDay: 2, favPerDay: 2 } });
  const a3 = hoi(b3);
  check('1e. Hết trần tim ngày (chung với For You) → không tim; hết trần lưu → không lưu',
    !a3.like && !a3.fav && a3.follow === 1, JSON.stringify(a3));
  const b3b = ap.makeBrain({ deviceId: 'x3b', dir: newDir(), cfg: { ...cfg, favPerDay: 0 } });
  check('1f. Trần lưu = 0 → tắt lưu hẳn (không phải "không giới hạn")', !hoi(b3b).fav);

  const d4 = newDir();
  const b4 = ap.makeBrain({ deviceId: 'x4', dir: d4, cfg });
  b4.noteActed({ type: 'acted', id: 1, like: 'ok', fav: 'ok' });
  b4.noteActed({ type: 'acted', id: 2, like: 'fail', fav: 'fail' });
  b4.noteActed({ type: 'acted', id: 3, like: 'not_needed', fav: 'not_needed' });
  check('1g. Chỉ ghi sổ khi Python báo "ok" (hỏng / đã bật sẵn thì không)',
    dc.count(d4, 'like') === 1 && dc.count(d4, 'fav') === 1, `like ${dc.count(d4, 'like')} fav ${dc.count(d4, 'fav')}`);
  check('1h. Dòng tổng kết có số lượt lưu và số hỏng', /lưu 1 \(hỏng 1\)/.test(b4.summary()), b4.summary());

  // Follow: ngân sách CHUNG với For You — trần 0 = tắt; vừa follow xong thì phải chờ giãn cách.
  fq._resetForTest();
  const b6 = ap.makeBrain({ deviceId: 'x6', dir: newDir(), cfg: { ...cfg, followPerDay: 0 } });
  const d7 = newDir();
  const b7 = ap.makeBrain({ deviceId: 'x7', dir: d7, cfg: { ...cfg, followGapMin: 120, followGapMax: 300 } });
  b7.answer({ v: ap.PROTO_VERSION, id: 20, kind: 'follow_confirm', handle: '@kenh.mot' });
  b7.noteActed({ type: 'acted', id: 20, follow: 'ok', handle: '@kenh.mot' });
  check('1l. Follow ở pha Xem ăn chung ngân sách For You: trần 0 → không; vừa follow → chờ giãn cách',
    !hoi(b6).follow && !hoi(b7, 21).follow, JSON.stringify([hoi(b6).follow, hoi(b7, 22).follow]));

  // Follow: vẫn qua nhịp follow_confirm — chống trùng kênh như For You.
  fq._resetForTest();
  const d5 = newDir();
  const b5 = ap.makeBrain({ deviceId: 'x5', dir: d5, cfg });
  const x1 = b5.answer({ v: ap.PROTO_VERSION, id: 9, kind: 'follow_confirm', handle: '@ten.tac.gia' });
  b5.noteActed({ type: 'acted', id: 9, follow: 'ok', handle: '@ten.tac.gia' });
  fq._resetForTest();
  const x2 = b5.answer({ v: ap.PROTO_VERSION, id: 10, kind: 'follow_confirm', handle: '@ten.tac.gia' });
  check('1k. Follow ở pha Xem vẫn qua sổ chống trùng: kênh đã follow thì không follow lại',
    x1.follow === 1 && x2.follow === 0, JSON.stringify([x1.follow, x2.follow, x2.why]));
}

// ── 2–3. Phía Python ──
const { findPython } = require(path.join(R, 'src', 'pythonpath.cjs'));
const py = findPython({ fresh: true });
if (!py || !py.hasU2) {
  check('2. Có Python + uiautomator2 để chạy phần Python', true, 'KHÔNG có — bỏ qua');
} else {
  const chay = (ten, than, env = {}) => {
    const f = path.join(TMP, ten + '.py');
    fs.writeFileSync(f, `
import sys, os, json, time
sys.path.insert(0, os.environ["APP_DIR"])
time.sleep = lambda s: None
def ket(**k): print("@@KQ@@" + json.dumps(k, ensure_ascii=False))
FX = os.path.join(os.environ["APP_DIR"], "tests", "fixtures")
doc = lambda f: open(os.path.join(FX, f), encoding="utf-8").read()
` + than, 'utf8');
    const r = spawnSync(py.cmd, [...py.args, f], {
      encoding: 'utf8', timeout: 60000, input: '',
      env: Object.assign({}, process.env, { APP_DIR: R, PYTHONIOENCODING: 'utf-8' }, env),
    });
    const dong = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('@@KQ@@'));
    return { kq: dong ? JSON.parse(dong.slice(6)) : null, loi: String(r.stderr || '').slice(-800) };
  };

  // ── 2. Đọc nút tim / lưu trên bản chụp thật ──
  {
    const r = chay('nut', `import phone_actions as PA
ket(kq=[[PA.nut_tuong_tac(doc(f), l)[1] for l in ("tim", "luu")] for f in
        ("xem_truoc_tim_45.7.3.xml", "xem_sau_tim_45.7.3.xml", "xem_sau_luu_45.7.3.xml")],
    rong=PA.nut_tuong_tac("<hierarchy/>", "tim"), feed=PA.nut_tuong_tac(doc("login_so_thich_47.0.2.xml"), "luu"))`);
    check('2a. Trạng thái tim / lưu đọc đúng trên bản chụp thật (trước tim, sau tim, sau lưu)',
      !!r.kq && JSON.stringify(r.kq.kq) === JSON.stringify([[false, false], [true, false], [true, true]]),
      r.kq ? JSON.stringify(r.kq.kq) : r.loi);
    check('2b. Màn không có nút → None (không bấm mù)', !!r.kq && r.kq.rong === null && r.kq.feed === null, r.kq ? JSON.stringify(r.kq) : r.loi);
    const en = chay('nut_en', `import phone_actions as PA
x = ('<hierarchy><node content-desc="Like video. 5.5M likes" bounds="[615,625][720,728]" selected="false">'
     '<node content-desc="Like" bounds="[628,625][707,704]" selected="true"/></node>'
     '<node bounds="[615,842][720,952]" selected="false"><node content-desc="Add or remove this video from Favorites." '
     'bounds="[615,842][720,952]" selected="false"/></node></hierarchy>')
ket(tim=PA.nut_tuong_tac(x, "tim"), luu=PA.nut_tuong_tac(x, "luu"))`);
    check('2c. Giao diện tiếng Anh (nhãn máy 60): nhận ra cả hai nút',
      !!en.kq && en.kq.tim[1] === true && en.kq.luu[1] === false && en.kq.luu[0][1] === 897, en.kq ? JSON.stringify(en.kq) : en.loi);
  }

  // ── 3. Bấm + xác minh, và chỉ video đầu ──
  const MAY = `
import phone_actions as PA
class May:
    def __init__(s, tim=False, luu=False, an=True, act="com.ss.android.ugc.aweme.detail.ui.DetailActivity"):
        s.tim, s.luu, s.an, s.act, s.bam = tim, luu, an, act, []
    def dump_hierarchy(s):
        return ('<hierarchy><node content-desc="Thích video. 1K" bounds="[600,600][720,700]" selected="false">'
                '<node bounds="[620,600][700,680]" selected="%s"/></node>'
                '<node bounds="[600,800][720,900]"><node content-desc="Thêm hoặc xóa video này khỏi mục Yêu thích." '
                'bounds="[600,800][720,900]"/><node bounds="[620,800][700,880]" selected="%s"/></node></hierarchy>'
                % ("true" if s.tim else "false", "true" if s.luu else "false"))
    def click(s, x, y):
        s.bam.append((x, y))
        if not s.an: return
        if y < 750: s.tim = not s.tim
        else: s.luu = not s.luu
    def app_current(s): return {"activity": s.act}
    def press(s, k): s.bam.append(k)
`;
  {
    const r = chay('bam', MAY + `
m = May(); a = PA.bat_nut_tuong_tac(m, "tim"); b = PA.bat_nut_tuong_tac(m, "luu")
m2 = May(tim=True, luu=True); c = PA.bat_nut_tuong_tac(m2, "tim"); e = PA.bat_nut_tuong_tac(m2, "luu")
m3 = May(an=False); f = PA.bat_nut_tuong_tac(m3, "luu")
# Đo thật: bấm lưu xong icon KHÔNG đổi, chỉ có tấm "Đã lưu" — vẫn phải là "ok".
class MayThongBao(May):
    def click(s, x, y): s.bam.append((x, y)); s.da_bam = True
    def dump_hierarchy(s):
        x = May.dump_hierarchy(s)
        return x.replace("</hierarchy>", '<node text="Đã lưu" bounds="[91,1053][573,1128]"/></hierarchy>') if getattr(s, "da_bam", False) else x
m4 = MayThongBao(); g = PA.bat_nut_tuong_tac(m4, "luu")
m5 = MayThongBao(); h = PA.bat_nut_tuong_tac(m5, "tim")
ket(a=a, b=b, bam=m.bam, c=c, e=e, bam2=m2.bam, f=f, g=g, h=h,
    tb=[PA.thay_thong_bao_da_luu(doc("xem_sau_luu_45.7.3.xml")), PA.thay_thong_bao_da_luu(doc("xem_sau_tim_45.7.3.xml"))])`);
    check('3a. Bấm tim / lưu rồi đọc lại thấy bật → "ok", mỗi nút bấm đúng MỘT lần',
      !!r.kq && r.kq.a === 'ok' && r.kq.b === 'ok' && r.kq.bam.length === 2, r.kq ? JSON.stringify(r.kq) : r.loi);
    check('3b. Nút đã bật sẵn → KHÔNG bấm (bấm nữa là gỡ), trả "not_needed"',
      !!r.kq && r.kq.c === 'not_needed' && r.kq.e === 'not_needed' && !r.kq.bam2.length);
    check('3c. Bấm mà nút không đổi → "fail" (không ghi sổ)', !!r.kq && r.kq.f === 'fail');
    check('3c2. Lưu: icon chưa đổi nhưng thấy tấm "Đã lưu" → "ok" (đo thật: icon không cập nhật ngay)',
      !!r.kq && r.kq.g === 'ok', r.kq ? JSON.stringify(r.kq) : r.loi);
    check('3c3. Tấm "Đã lưu" KHÔNG được dùng để xác minh tim', !!r.kq && r.kq.h === 'fail');
    check('3c4. Nhận ra tấm "Đã lưu" trên bản chụp thật, và không nhầm ở màn chưa lưu',
      !!r.kq && JSON.stringify(r.kq.tb) === '[true,false]', r.kq ? JSON.stringify(r.kq.tb) : '');

    const x = chay('xem', MAY + `
PA._mo_link = lambda d, g, l, cho=12.0: "video"
PA.vuot_video_ke = lambda d, manh=False: None
PA.thoat_tako = lambda d, g: ""
PA._ve_ngoai = lambda d: None
goi = []
m = May()
kq = PA.xem_mot_link(m, "pkg", "https://x", None, lambda: False, (1, 1), (5, 5), (1, 1), tuong_tac=lambda d: goi.append(1))
m2 = May(act="com.ss.android.ugc.aweme.music.ui.MusicDetailActivity")
goi2 = []
PA.xem_mot_link(m2, "pkg", "https://x", None, lambda: False, (1, 1), (0, 0), (1, 1), tuong_tac=lambda d: goi2.append(1))
ket(kq=kq, goi=len(goi), goi2=len(goi2))`);
    check('3d. Vuốt thêm 5 video mà chỉ tương tác MỘT lần — với video đầu',
      !!x.kq && x.kq.kq === 'ok' && x.kq.goi === 1, x.kq ? JSON.stringify(x.kq) : x.loi);
    check('3e. Đang ở trang nhạc (MusicDetailActivity) chứ không phải trình phát → không tương tác',
      !!x.kq && x.kq.goi2 === 0, x.kq ? JSON.stringify(x.kq) : x.loi);

    // tuong_tac_xem: hỏi bộ não, làm đúng thứ được phép, báo lại kết quả thật.
    const t = chay('ttx', MAY + `
import scan_feed_sounds as S
S.log = lambda *a, **k: None
PA.read_video_info = lambda d: {"author": "Ten Tac Gia", "desc": ""}
PA.open_profile_read_handle = lambda d, log=None: "@ten.tac.gia"
PA.do_follow = lambda d, log=None: "ok"
PA.verify_follow_after_reload = lambda d, log=None: "ok"
dong = []
PA.close_profile = lambda d, log=None: dong.append("close")
class Canh:
    enabled = True
    def __init__(s, tl): s.tl, s.hoi, s.bao = tl, [], []
    def ask(s, **k): s.hoi.append(k.get("kind")); return len(s.hoi)
    def take(s, aid): return s.tl[aid - 1]
    def acted(s, aid, **k): s.bao.append(k)
S.VIEW_ACT_ON = True
m = May(); c = Canh([{"like": 1, "fav": 1, "follow": 1}, {"follow": 1}])
S.tuong_tac_xem(m, c)
m2 = May(); c2 = Canh([{"like": 0, "fav": 0, "follow": 0}])
S.tuong_tac_xem(m2, c2)
m3 = May(); c3 = Canh([{"like": 0, "fav": 0, "follow": 1}, {"follow": 0}])
S.tuong_tac_xem(m3, c3)
S.VIEW_ACT_ON = False
m4 = May(); c4 = Canh([{"like": 1}])
S.tuong_tac_xem(m4, c4)
ket(hoi=c.hoi, bao=c.bao, tim=m.tim, luu=m.luu, dong=dong, bam2=m2.bam, bao2=c2.bao, bao3=c3.bao, hoi4=c4.hoi)`);
    const k = t.kq || {};
    check('3f. Được phép cả ba → tim + lưu thật, hỏi follow_confirm, báo lại kết quả kèm @handle',
      !!t.kq && k.hoi.join(',') === 'view_act,follow_confirm' && k.tim && k.luu
      && JSON.stringify(k.bao) === JSON.stringify([{ like: 'ok', fav: 'ok', follow: 'ok', handle: '@ten.tac.gia' }]),
      t.kq ? JSON.stringify(k) : t.loi);
    check('3g. Mở trang tác giả để follow thì LUÔN quay về trình phát (close_profile)', !!t.kq && k.dong.length === 2);
    check('3h. Không được phép gì → không bấm gì, không báo gì', !!t.kq && !k.bam2.length && !k.bao2.length);
    check('3i. follow_confirm từ chối (vd đã follow kênh này) → không bấm Follow, báo not_needed',
      !!t.kq && JSON.stringify(k.bao3) === JSON.stringify([{ follow: 'not_needed' }]), t.kq ? JSON.stringify(k.bao3) : '');
    check('3k. Tắt tương tác pha Xem (VIEW_ACT_ON=0) → không hỏi bộ não', !!t.kq && !k.hoi4.length);
  }
}

// ── 4. Nối dây ──
{
  const runner = doc('src/runner.cjs');
  const bridge = doc('askbridge.py');
  const html = doc('renderer/index.html');
  const rjs = doc('renderer/renderer.js');
  check('4a. VIEW_ACT_ON chỉ bật ở pha Xem, và chỉ khi có tỉ lệ > 0',
    /VIEW_ACT_ON: \(phaXem && \[cfg\.viewLikePct, cfg\.viewFavPct, cfg\.viewFollowPct\]\.some\(\(v\) => Number\(v\) > 0\)\)/.test(runner));
  check('4b. Kênh hỏi/đáp Python mang khoá "fav" ở cả câu trả lời thường lẫn câu an toàn',
    /SAFE = \{[^}]*"fav": 0\}/.test(bridge) && /"fav": 1 if ans\.get\("fav"\) else 0/.test(bridge));
  check('4c. Giao diện có 4 ô và lưu / nạp đủ cả 4',
    ['cfgViewLikePct', 'cfgViewFavPct', 'cfgViewFollowPct', 'cfgFavPerDay'].every((id) => html.includes(`id="${id}"`)
      && rjs.includes(`$('${id}').value`) && rjs.includes(`numOf('${id}'`)));
  check('4d. Dòng log kết quả tương tác có chữ cho "Lưu video"', /fav: 'Lưu video'/.test(runner));
}

done();
