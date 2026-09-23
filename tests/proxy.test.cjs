// tests/proxy.test.cjs — Proxy của từng máy: đọc chuỗi, gán hàng loạt, gắn lên điện thoại qua
// College Proxy, và KHÔNG BAO GIỜ mở TikTok bằng IP thật.
//
// ĐO THẬT trước khi viết (2026-09-23, máy 60 = SM-A920F 520006e9ee546475, College Proxy 3.0.0):
//   • proxy HTTP  50100 → app báo Connected, IP công khai của máy đổi sang IP proxy;
//   • proxy SOCKS5 50101 → app VẪN báo Connected, nhưng máy mất mạng hẳn.
// Chữ "Connected" không chứng minh gì — phép thử ở mục 3 khoá đúng điều đó: chỉ IP đo trên điện
// thoại mới quyết định được mở TikTok hay không.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const R = path.join(__dirname, '..');
// devices.json thật KHÔNG BAO GIỜ bị đụng (QĐ-21).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-'));
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

const { docProxy, moTa, ganHangLoat } = require(path.join(R, 'src', 'proxy.cjs'));

// Cùng một bộ chuỗi chạy qua cả bản JS lẫn bản Python (mục 2): hai bên lệch nhau là giao diện
// báo "hợp lệ" cho một proxy mà Python từ chối lúc chạy.
const MAU = [
  ['102.129.141.141:50100:hung10aGtj:BkyiiPsaEU', { host: '102.129.141.141', port: '50100', user: 'hung10aGtj', pass: 'BkyiiPsaEU' }],
  ['  1.2.3.4:8080  ', { host: '1.2.3.4', port: '8080', user: '', pass: '' }],
  ['proxy.vn:3128:u:p', { host: 'proxy.vn', port: '3128', user: 'u', pass: 'p' }],
  ['2001:db8::1:8080:u:p', { host: '2001:db8::1', port: '8080', user: 'u', pass: 'p' }],
  ['1.2.3.4:8080:123:456', { host: '1.2.3.4', port: '8080', user: '123', pass: '456' }],
  ['1.2.3.4', null],
  ['1.2.3.4:0:u:p', null],
  ['1.2.3.4:70000', null],
  ['1.2.3.4:8080:u', null],
  ['1.2.3.4:80 80:u:p', null],
  ['', null],
  [':8080:u:p', null],
];

// ── 1. Đọc chuỗi, che mật khẩu, gán hàng loạt (JS) ──
{
  const sai = MAU.filter(([s, mong]) => JSON.stringify(docProxy(s)) !== JSON.stringify(mong));
  check('1a. docProxy đọc đúng mọi mẫu (kể cả IPv6, user/pass toàn số)', !sai.length,
    sai.map(([s]) => `${s} → ${JSON.stringify(docProxy(s))}`).join(' | '));
  check('1b. moTa chỉ còn host:port — không bao giờ có mật khẩu',
    moTa('102.129.141.141:50100:hung10aGtj:BkyiiPsaEU') === '102.129.141.141:50100' && moTa('rác') === '');

  const r = ganHangLoat(['a', 'b', 'c'], '1.1.1.1:80:u:p\r\n\n  2.2.2.2:81:u:p  \n');
  check('1c. Dòng 1 → máy 1, dòng 2 → máy 2; dòng trống bỏ qua; máy thiếu dòng được đếm',
    r.gan.map((x) => `${x.id}=${x.proxy}`).join(',') === 'a=1.1.1.1:80:u:p,b=2.2.2.2:81:u:p' && r.thieu === 1 && r.thua === 0,
    JSON.stringify(r));
  const r2 = ganHangLoat(['a'], '1.1.1.1:80:u:p\n2.2.2.2:81:u:p');
  check('1d. Dòng thừa (nhiều hơn số máy) bị bỏ qua và được đếm', r2.gan.length === 1 && r2.thua === 1);
  const r3 = ganHangLoat(['a', 'b'], '1.1.1.1:80:u:p\n1.1.1.1:socks');
  check('1e. Có một dòng sai → KHÔNG gán máy nào, báo đúng số dòng',
    r3.gan.length === 0 && r3.loi.length === 1 && r3.loi[0].dong === 2, JSON.stringify(r3));
}

// ── 1f. devices.cjs thật: lưu và bỏ proxy ──
{
  const devices = require(path.join(R, 'src', 'devices.cjs'));
  const d = devices.addDevice({ name: 'SM-A920F', serial: '520006e9ee546475' });
  devices.updateDevice({ id: d.id, proxy: ' 1.2.3.4:80:u:p ' });
  const sau = devices.loadDevices().find((x) => x.id === d.id);
  devices.updateDevice({ id: d.id, name: 'đổi tên' });
  const giu = devices.loadDevices().find((x) => x.id === d.id);
  devices.updateDevice({ id: d.id, proxyKq: { ok: true, ip: '9.9.9.9', luc: 1 } });
  devices.updateDevice({ id: d.id, proxy: '1.2.3.4:80:u:p' });
  const cungProxy = devices.loadDevices().find((x) => x.id === d.id);
  devices.updateDevice({ id: d.id, proxy: '5.6.7.8:80:u:p' });
  const doiProxy = devices.loadDevices().find((x) => x.id === d.id);
  check('1g. Kết quả gắn đã lưu: giữ khi lưu lại CÙNG proxy, xoá khi đổi sang proxy khác',
    !!cungProxy.proxyKq && cungProxy.proxyKq.ip === '9.9.9.9' && !('proxyKq' in doiProxy));
  devices.updateDevice({ id: d.id, proxy: '' });
  const bo = devices.loadDevices().find((x) => x.id === d.id);
  check('1f. devices.json: lưu proxy (đã cắt khoảng trắng), đổi tên không mất proxy, chuỗi rỗng = bỏ hẳn',
    sau.proxy === '1.2.3.4:80:u:p' && giu.proxy === '1.2.3.4:80:u:p' && !('proxy' in bo), JSON.stringify([sau, bo]));
}

// ── 2–3. Phía Python: chạy ĐÚNG college_proxy.py, thay điện thoại + adb + mạng bằng bản giả ──
const { findPython } = require(path.join(R, 'src', 'pythonpath.cjs'));
const py = findPython({ fresh: true });
if (!py || !py.hasU2) {
  check('2. Có Python + uiautomator2 để chạy phần Python', true, 'KHÔNG có — bỏ qua');
} else {
  const NEN = `
import sys, os, json, time
sys.path.insert(0, os.environ["APP_DIR"])
time.sleep = lambda s: None
import college_proxy as CP

# Dien thoai gia: College Proxy voi 4 o nhap + nut START/STOP. Go chu = lenh "input text".
class O:
    def __init__(s, may, rid, dau=None): s.may, s.rid, s.dau = may, rid, dau
    @property
    def exists(s):
        if not s.may.app_mo: return False
        return s.dau is None or s.get_text().startswith(s.dau)
    def wait(s, timeout=0):
        if s.rid == CP.NUT_DONG_Y_VPN: return s.may.hoi_vpn
        return s.may.app_mo
    def get_text(s, timeout=None):
        if s.rid == CP.NUT: return "STOP SERVICE-BY CONGNV" if s.may.bat else "START SERVICE-BY CONGNV"
        return s.may.o.get(s.rid, "")
    def click(s):
        s.may.viec.append(("click", s.rid))
        if s.rid == CP.NUT: s.may.bam_nut()
        elif s.rid == CP.NUT_DONG_Y_VPN: s.may.hoi_vpn = False; s.may.bat = True
        else: s.may.dang_go = s.rid
class Loading:
    # Man "Loading..." College Proxy tu chen len: con may.loading lan hoi nua thi con thay no.
    def __init__(s, may): s.may = may
    @property
    def exists(s):
        if s.may.loading > 0:
            s.may.loading -= 1; return True
        return False
class May:
    def __init__(s, bat=False, o=None, hoi_vpn=False, go_hong=0):
        s.app_mo = False; s.bat = bat; s.o = dict(o or {}); s.hoi_vpn = hoi_vpn
        s.viec = []; s.dang_go = None; s.go_hong = go_hong; s.loading = 0
    def app_start(s, pkg, stop=False):
        s.viec.append(("app_start", pkg, stop)); s.app_mo = pkg == CP.PKG
        if stop and pkg == CP.PKG: s.bat = False      # force-stop app VPN = VPN tat
    def press(s, k): s.viec.append(("press", k))
    def __call__(s, resourceId=None, textStartsWith=None, text=None):
        if text == "Loading...": return Loading(s)
        return O(s, resourceId, textStartsWith)
    def bam_nut(s):
        if s.bat: s.bat = False
        elif s.hoi_vpn: pass            # cho nguoi bam dong y
        else: s.bat = True

MAY = May()
IP = {"dt": "102.129.141.141", "pc": "118.68.96.56"}
LENH = []
def adb_gia(*a, serial=None, timeout=60):
    LENH.append(list(a))
    if a[:2] == ("shell", "ls"): return "lo wlan0 tun0" if MAY.bat else "lo wlan0"
    if a[:2] == ("shell", "dumpsys"): return "mInputShown=false"
    if a[:3] == ("shell", "pm", "clear"):
        MAY.o = {}; MAY.bat = False; MAY.loading = 0; return "Success"
    if a[:3] == ("shell", "input", "text"):
        gt = a[3][1:-1].replace("'\\\\''", "'").replace("%s", " ")
        if MAY.go_hong > 0 and MAY.dang_go == CP.O_MAT_KHAU: MAY.go_hong -= 1
        elif MAY.go_hong > 0: gt = gt[:-1]
        MAY.o[MAY.dang_go] = gt
        return ""
    if a[:3] == ("shell", "input", "keyevent"):
        MAY.o[MAY.dang_go] = ""; return ""
    if a[0] == "shell" and "nc" in a[1]:
        if IP.get("hong", 0) > 0:
            IP["hong"] -= 1; return ""
        return IP["dt"] if MAY.bat else ""
    return ""
CP.adb = adb_gia
CP.ip_may_tinh = lambda: IP["pc"]
LOG, SK = [], []
log = LOG.append
emit = lambda t, **k: SK.append(dict(type=t, **k))
def ket(**k):
    k.update(log=LOG, su_kien=SK, lenh=LENH)
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
  const MK = 'BkyiiPsaEU';
  const PX = `102.129.141.141:50100:hung10aGtj:${MK}`;

  // ── 2. Luật đọc chuỗi của Python khớp bản JS ──
  {
    const r = chay('doc', `ket(kq=[CP.doc_proxy(s) for s in ${JSON.stringify(MAU.map(([s]) => s))}])`);
    const lech = r.kq ? MAU.filter(([, mong], i) => JSON.stringify(r.kq.kq[i]) !== JSON.stringify(mong)) : MAU;
    check('2a. doc_proxy (Python) khớp docProxy (JS) trên cùng bộ mẫu', !lech.length, lech.map(([s]) => s).join(' | ') || r.loi);
    const q = chay('quote', `ket(kq=[CP.chuoi_input_text("a b"), CP.chuoi_input_text("x'y")])`);
    check("2b. Gõ chữ: dấu cách → %s, dấu ' được bọc cho shell trên điện thoại",
      !!q.kq && q.kq.kq[0] === "'a%sb'" && q.kq.kq[1] === "'x'\\''y'", q.kq ? JSON.stringify(q.kq.kq) : q.loi);
  }

  // ── 3. dam_bao_proxy: hành vi ──
  {
    const r = chay('ok', `
ip = CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit)
ket(ip=ip, o=MAY.o, bat=MAY.bat)`);
    const k = r.kq || {};
    check('3a. Máy tắt proxy → nhập đủ 4 ô, bật VPN, đo IP, trả IP proxy',
      k.ip === '102.129.141.141' && k.bat === true && k.o && k.o[`${'com.cell47.College_Proxy'}:id/editText_password`] === MK,
      JSON.stringify(k.o) || r.loi);
    check('3b. Báo sự kiện proxy ok kèm IP cho giao diện',
      !!k.su_kien && k.su_kien.some((e) => e.type === 'proxy' && e.ok === true && e.ip === '102.129.141.141'));
    check('3c. Mật khẩu KHÔNG xuất hiện trong log hay sự kiện',
      !!k.log && !JSON.stringify([k.log, k.su_kien]).includes(MK), JSON.stringify(k.log));

    // Đường nhanh: dấu trên máy tính khớp + VPN đang bật → KHÔNG mở College Proxy (giao diện nó
    // chập chờn, đo thật: màn Loading chồng tới 34 lớp).
    const MOC = path.join(TMP, 'moc.txt').split(path.sep).join('/');
    const nhanh = chay('nhanh', `
MAY.bat = True
open("${MOC}", "w").write(CP._dau(${JSON.stringify(PX)}))
ip = CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}")
ket(ip=ip, go=[l for l in LENH if l[:3] == ["shell", "input", "text"]], viec=MAY.viec)`);
    check('3d. Đường nhanh: dấu khớp + VPN bật → không mở app, không gõ, không bấm; chỉ đo IP',
      !!nhanh.kq && nhanh.kq.ip === '102.129.141.141' && !nhanh.kq.go.length && !nhanh.kq.viec.length,
      nhanh.kq ? JSON.stringify(nhanh.kq.viec) : nhanh.loi);

    const doi = chay('doi', `
MAY.bat = True
MAY.o = {CP.O_DIA_CHI: "9.9.9.9", CP.O_CONG: "1", CP.O_TEN: "cu"}
open("${MOC}", "w").write(CP._dau("9.9.9.9:1:cu:x"))
CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}")
ket(o=MAY.o, bat=MAY.bat, sach=[v for v in MAY.viec if v[0] == "app_start"], moc=open("${MOC}").read())`);
    check('3e. Dấu là proxy KHÁC → mở College Proxy SẠCH (force-stop), nhập proxy mới, bật, ghi dấu mới',
      !!doi.kq && doi.kq.o['com.cell47.College_Proxy:id/editText_address'] === '102.129.141.141'
      && doi.kq.bat === true && doi.kq.sach.length === 1 && doi.kq.sach[0][2] === true
      && doi.kq.moc.length === 64 && !doi.kq.moc.includes(MK),
      doi.kq ? JSON.stringify(doi.kq.sach) : doi.loi);

    const tatVpn = chay('tat_vpn', `
open("${MOC}", "w").write(CP._dau(${JSON.stringify(PX)}))
CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}")
ket(bat=MAY.bat, sach=[v for v in MAY.viec if v[0] == "app_start"])`);
    check('3e2. Dấu khớp nhưng VPN đã tắt (điện thoại vừa khởi động lại) → gắn lại đầy đủ',
      !!tatVpn.kq && tatVpn.kq.bat === true && tatVpn.kq.sach.length === 1, tatVpn.loi);

    // Đường nhanh đo IP hỏng (proxy chập chờn một lúc) → KHÔNG dừng ở đó, gắn lại đầy đủ. Dừng thì
    // lượt sau lại đi đường nhanh, lại hỏng — kẹt mãi mà không bao giờ thử gắn lại.
    const nhanhHong = chay('nhanh_hong', `
MAY.bat = True
IP["hong"] = 3
open("${MOC}", "w").write(CP._dau(${JSON.stringify(PX)}))
ip = CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}")
ket(ip=ip, sach=[v for v in MAY.viec if v[0] == "app_start"])`);
    check('3e5. Đường nhanh đo IP hỏng → gắn lại từ đầu trong CÙNG lượt, được',
      !!nhanhHong.kq && nhanhHong.kq.ip === '102.129.141.141' && nhanhHong.kq.sach.length === 1
      && nhanhHong.kq.log.some((l) => /gắn lại từ đầu/.test(l)), nhanhHong.loi);

    // Gắn từ nút Lưu: máy có thể đang mở TikTok (thao tác tay trên 效卫). Gắn đầy đủ tắt VPN vài chục
    // giây → phải tắt TikTok TRƯỚC khi đụng College Proxy; đường nhanh không đụng gì thì không tắt.
    const hook = chay('truoc_khi_gan', `
THU_TU = []
_goc = MAY.app_start
def _mo(pkg, stop=False):
    THU_TU.append("mo_college_proxy"); _goc(pkg, stop)
MAY.app_start = _mo
CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, truoc_khi_gan=lambda: THU_TU.append("tat_tiktok"))
day_du = list(THU_TU)
THU_TU.clear()
MAY.bat = True
open("${MOC}", "w").write(CP._dau(${JSON.stringify(PX)}))
CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}", truoc_khi_gan=lambda: THU_TU.append("tat_tiktok"))
ket(day_du=day_du, nhanh=list(THU_TU))`);
    check('3e8. Gắn đầy đủ: tắt TikTok TRƯỚC khi mở College Proxy; đường nhanh: không tắt TikTok',
      !!hook.kq && hook.kq.day_du[0] === 'tat_tiktok' && hook.kq.day_du.includes('mo_college_proxy') && !hook.kq.nhanh.length,
      hook.kq ? JSON.stringify(hook.kq) : hook.loi);

    const tat = chay('tat', `
MAY.bat = True
open("${MOC}", "w").write("x")
_goc_adb = CP.adb
def adb_tat(*a, **k):
    if a[:4] == ("shell", "am", "force-stop", CP.PKG): MAY.bat = False
    return _goc_adb(*a, **k)
CP.adb = adb_tat
import os
ok = CP.tat_proxy("S", "${MOC}", log)
ket(ok=ok, bat=MAY.bat, con_moc=os.path.exists("${MOC}"))`);
    check('3e9. Bỏ proxy: tắt College Proxy (VPN tắt thật) và xoá dấu',
      !!tat.kq && tat.kq.ok === true && tat.kq.bat === false && tat.kq.con_moc === false, tat.loi);

    const cho = chay('cho_loading', `
MAY.loading = 6
CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit)
ket(bat=MAY.bat, con=MAY.loading, go=[l for l in LENH if l[:3] == ["shell", "input", "text"]])`);
    check('3e3. Màn Loading chen vào → CHỜ nó đi hết rồi mới gõ',
      !!cho.kq && cho.kq.bat === true && cho.kq.con === 0 && cho.kq.go.length === 4, cho.loi);

    const lan2 = chay('lan2', `
MAY.go_hong = 1
ip = CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit)
ket(ip=ip, sach=[v for v in MAY.viec if v[0] == "app_start"], clear=[l for l in LENH if l[:3] == ["shell", "pm", "clear"]])`);
    check('3e4. Lần gắn đầu hỏng → lần 2 XOÁ DỮ LIỆU College Proxy rồi mới mở, được',
      !!lan2.kq && lan2.kq.ip === '102.129.141.141' && lan2.kq.sach.length === 2 && lan2.kq.clear.length === 1
      && lan2.kq.log.some((l) => /thử lần 2/.test(l)), lan2.loi);
    // Đo thật: app kẹt vòng lặp Loading, force-stop KHÔNG gỡ được, chỉ \`pm clear\` gỡ được.
    const ket = chay('ket_loading', `
MAY.loading = 10**6
ip = CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit)
ket(ip=ip)`);
    check('3e6. Kẹt vòng lặp Loading (force-stop không gỡ được) → lần 2 pm clear gỡ được, gắn xong',
      !!ket.kq && ket.kq.ip === '102.129.141.141', ket.loi);
    const lan1 = chay('lan1_khong_clear', `
CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit)
ket(clear=[l for l in LENH if l[:3] == ["shell", "pm", "clear"]])`);
    check('3e7. Lần 1 KHÔNG xoá dữ liệu (chỉ xoá khi đã hỏng một lần)', !!lan1.kq && lan1.kq.clear.length === 0, lan1.loi);

    const hoi = chay('hoi', `
MAY.hoi_vpn = True
CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit)
ket(bat=MAY.bat)`);
    check('3f. Lần đầu Android hỏi quyền VPN → tự bấm đồng ý', !!hoi.kq && hoi.kq.bat === true
      && hoi.kq.log.some((l) => /quyền VPN/.test(l)), hoi.loi);

    // Máy báo "Connected" nhưng không ra Internet — ĐÚNG ca SOCKS5 đo được trên máy 60.
    const socks = chay('socks', `
IP["dt"] = ""
try:
    CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit); ket(hong=False)
except CP.ProxyHong as e:
    ket(hong=True, ly_do=str(e))`);
    check('3g. Connected nhưng mất mạng (cổng SOCKS5) → ProxyHong, nói rõ có thể là SOCKS5',
      !!socks.kq && socks.kq.hong && /SOCKS5/.test(socks.kq.ly_do)
      && socks.kq.su_kien.some((e) => e.type === 'proxy' && e.ok === false), socks.loi);

    const lo = chay('lo', `
IP["dt"] = IP["pc"]
try:
    CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit); ket(hong=False)
except CP.ProxyHong as e:
    ket(hong=True, ly_do=str(e))`);
    check('3h. Máy vẫn ra IP thật của farm → ProxyHong', !!lo.kq && lo.kq.hong && /IP thật/.test(lo.kq.ly_do), lo.loi);

    const khongPc = chay('khong_pc', `
CP.ip_may_tinh = lambda: ""
try:
    CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit); ket(hong=False)
except CP.ProxyHong as e:
    ket(hong=True)`);
    check('3i. Không đọc được IP thật để so → KHÔNG cho chạy (không đoán)', !!khongPc.kq && khongPc.kq.hong, khongPc.loi);

    const goHong = chay('go_hong', `
MAY.go_hong = 2
open("${MOC}", "w").write(CP._dau(${JSON.stringify(PX)}))
try:
    CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}"); ket(hong=False, bat=MAY.bat)
except CP.ProxyHong as e:
    import os
    ket(hong=True, bat=MAY.bat, con_moc=os.path.exists("${MOC}"))`);
    check('3j. Gõ hỏng cả 2 lần (ô đọc lại không khớp) → ProxyHong, KHÔNG bấm START, xoá dấu cũ',
      !!goHong.kq && goHong.kq.hong && goHong.kq.bat === false && goHong.kq.con_moc === false, goHong.loi);

    const saiDang = chay('sai_dang', `
try:
    CP.dam_bao_proxy(MAY, "S", "1.2.3.4", log, emit); ket(hong=False)
except CP.ProxyHong:
    ket(hong=True, mo=[v for v in MAY.viec if v[0] == "app_start"])`);
    check('3k. Chuỗi proxy sai dạng → ProxyHong trước khi đụng tới điện thoại',
      !!saiDang.kq && saiDang.kq.hong && !saiDang.kq.mo.length, saiDang.loi);
  }
}

// ── 4. Nối dây: không đường nào mở TikTok mà bỏ qua proxy ──
{
  const scan = doc('scan_feed_sounds.py');
  const setup = (scan.match(/def setup_device\(d\):[\s\S]*?\n(?=\n\n)/) || [''])[0];
  const iKill = setup.indexOf('kill_all_apps(d)');
  const iProxy = setup.indexOf('CP.dam_bao_proxy(');
  const iTik = setup.indexOf('ensure_tiktok_open(d)');
  check('4a. setup_device: tắt app → gắn proxy → rồi mới mở TikTok',
    iKill >= 0 && iProxy > iKill && iTik > iProxy, `${iKill} ${iProxy} ${iTik}`);
  check('4b. setup_device không thử lại / không nuốt ProxyHong', /except CP\.ProxyHong:\s*\n\s*raise/.test(setup));
  check('4c. College Proxy KHÔNG bị kill_all_apps tắt (tắt nó = VPN tắt ngay trước khi TikTok mở)',
    /EXCLUDE_KILL_KEYWORDS = \([^)]*"college_proxy"/.test(scan));
  // Mọi chỗ gọi setup_device đều phải bắt ProxyHong riêng: nhánh `except Exception` chung sẽ
  // "vòng sau thử tiếp" — tức là quét tiếp khi TikTok có thể đang ở IP thật.
  const goi = scan.split('\n').map((l, i) => [l, i]).filter(([l]) => /^\s+(pkg = )?setup_device\(d\)\s*$/.test(l));
  const thieu = goi.filter(([, i]) => !scan.split('\n').slice(i, i + 6).join('\n').includes('except CP.ProxyHong'));
  check('4d. MỌI chỗ gọi setup_device đều bắt ProxyHong riêng', goi.length >= 4 && !thieu.length,
    `${goi.length} chỗ gọi, thiếu ở dòng ${thieu.map(([, i]) => i + 1).join(', ')}`);
  const main = (scan.match(/def main\(\):[\s\S]*$/) || [''])[0];
  const iBat = main.indexOf('except CP.ProxyHong as e:');
  check('4e. Proxy hỏng lúc khởi động KHÔNG bị báo là máy đơ (không tự khởi động lại điện thoại)',
    iBat >= 0 && !main.slice(iBat, main.indexOf('except Exception as e:', iBat)).includes('bao_may_do'));
  check('4f. Kiểm VPN định kỳ giữa ca, rớt thì tắt TikTok trước khi gắn lại',
    /if PROXY and time\.time\(\) >= kiem_vpn_luc:[\s\S]{0,400}CP\.vpn_dang_bat\(d\.serial\)[\s\S]{0,300}am", "force-stop", goi[\s\S]{0,300}setup_device\(d\)/.test(scan));

  const cp = doc('college_proxy.py');
  check('4g. college_proxy.py không in mật khẩu ra log', !/log\([^)]*\[["']pass["']\]/.test(cp) && !/emit\([^)]*pass/.test(cp));
  check('4h. Không dùng send_keys (đổi bàn phím 效卫) hay set_text (vỡ khi bàn phím toàn màn hình)',
    !/\.send_keys\(|\.set_text\(/.test(cp));

  const rn = doc('src/runner.cjs');
  check('4i. runner: PROXY đi qua biến môi trường của tiến trình con', /PROXY: String\(params\.proxy \|\| ''\)/.test(rn)
    && !/SCRIPT_PATH, serial, [^\]]*proxy/.test(rn));
  check('4i2. runner truyền PROXY_MOC (tệp dấu riêng từng máy) và Python chuyển nó cho dam_bao_proxy',
    /PROXY_MOC: params\.proxy \? path\.join\(getDeviceDir\(deviceId\), 'proxy_da_gan\.txt'\)/.test(rn)
    && /PROXY_MOC = os\.environ\.get\("PROXY_MOC", ""\)/.test(scan) && /moc=PROXY_MOC\)/.test(scan));
  const prun = doc('src/proxyrun.cjs');
  check('4i3. Gắn lúc Lưu dùng CÙNG tệp dấu với lượt quét (lượt sau đi đường nhanh), mật khẩu qua biến môi trường',
    /PROXY_MOC: path\.join\(getDeviceDir\(deviceId\), 'proxy_da_gan\.txt'\)/.test(prun)
    && /PROXY: String\(proxy \|\| ''\)/.test(prun)
    && /\[\.\.\.py\.args, resolveResource\('college_proxy\.py'\), serial, tat \? 'tat' : 'gan'\]/.test(prun)
    && /ADB_PATH,\s*\n\s*ANDROID_ADB_SERVER_PORT: adbServerPort\(\)/.test(prun));
  check('4i4. college_proxy.py chạy riêng: gắn thì truyền hàm tắt TikTok vào dam_bao_proxy',
    /truoc_khi_gan=tat_tiktok/.test(cp) && /"force-stop", goi/.test(cp));
  check('4j. runner chuyển sự kiện proxy lên', /payload\.type === 'proxy'[\s\S]{0,200}kind: 'proxy'/.test(rn));

  const pkg = JSON.parse(doc('package.json'));
  check('4k. Bản build .exe mang theo college_proxy.py (extraResources)',
    (pkg.build.extraResources || []).includes('college_proxy.py'));

  const html = doc('renderer/index.html');
  const rend = doc('renderer/renderer.js');
  const idHtml = ['proxySelectedBtn', 'proxyModal', 'proxyText', 'proxyPreview', 'proxySave', 'proxyClear', 'proxyCancel', 'proxyModalClose', 'proxyTarget'];
  const thieuId = idHtml.filter((id) => !html.includes(`id="${id}"`) || !rend.includes(`'${id}'`));
  check('4l. Giao diện: mọi phần tử của modal proxy có trong HTML VÀ được renderer dùng', !thieuId.length, thieuId.join(', '));
  const cot = (html.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0].match(/<th\b/g).length;
  const o = (rend.match(/function deviceRowHtml[\s\S]*?\n}/) || [''])[0].match(/<td\b/g).length;
  check('4m. Bảng thiết bị: số cột tiêu đề = số ô mỗi dòng', cot === o, `${cot} tiêu đề, ${o} ô`);
  check('4n. preload lộ devicesSetProxies', /devicesSetProxies: \(data\) => ipcRenderer\.invoke\('devices-set-proxies'/.test(doc('preload.cjs')));
}

done();
