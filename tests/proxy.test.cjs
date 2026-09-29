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
// CRLF → LF trước khi soi: máy có `core.autocrlf=true` checkout ra CRLF và 4a/4b đỏ oan
// (xem chú thích cùng chỗ trong wiring.test.cjs).
const doc = (f) => fs.readFileSync(path.join(R, f), 'utf8').replace(/\r\n/g, '\n');

const { docProxy, moTa, ganHangLoat } = require(path.join(R, 'src', 'proxy.cjs'));

// Cùng một bộ chuỗi chạy qua cả bản JS lẫn bản Python (mục 2): hai bên lệch nhau là giao diện
// báo "hợp lệ" cho một proxy mà Python từ chối lúc chạy.
const MAU = [
  ['203.0.113.10:50100:nguoidung01:MatKhauGia01', { host: '203.0.113.10', port: '50100', user: 'nguoidung01', pass: 'MatKhauGia01' }],
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

// Mạng nền của điện thoại (`settings get global wifi_on; ip route show table all`) → [có mạng, Wi-Fi tắt].
// CÙNG bộ mẫu chạy qua doc_mang_nen (Python, lượt quét) và docMangNen (JS, nút 🔌 Kiểm tra): hai bên
// lệch là nút Kiểm tra nói "có mạng" mà lượt quét lại chặn, hoặc ngược lại. Mẫu 1–2 chép từ máy thật
// ngày 2026-09-29 (5200b3985a969423 có Wi-Fi; 5200c637ea67c41b Wi-Fi tắt, Lalasoft vẫn Connected).
const MAU_MANG = [
  ['1\ndefault via 192.168.5.1 dev wlan0 table wlan0 proto static\nunreachable default dev lo table tun0 proto static metric 1024 error -101', [true, false]],
  ['0\nunreachable default dev lo table tun0 proto static metric 1024 error -101\nunreachable default dev lo proto kernel metric 4294967295 error -101', [false, true]],
  ['0\ndefault dev rmnet_data0 table rmnet_data0 proto static scope link', [true, true]],
  ['1\r\ndefault via 192.168.4.1 dev wlan0 table wlan0 proto static\r\n', [true, false]],
  ['', [null, false]],
  ['1\n192.168.4.0/23 dev wlan0 proto kernel scope link src 192.168.4.149', [null, false]],
  ['null\nunreachable default dev lo table tun0', [false, false]],
];

// ── 1. Đọc chuỗi, che mật khẩu, gán hàng loạt (JS) ──
{
  const sai = MAU.filter(([s, mong]) => JSON.stringify(docProxy(s)) !== JSON.stringify(mong));
  check('1a. docProxy đọc đúng mọi mẫu (kể cả IPv6, user/pass toàn số)', !sai.length,
    sai.map(([s]) => `${s} → ${JSON.stringify(docProxy(s))}`).join(' | '));
  check('1b. moTa chỉ còn host:port — không bao giờ có mật khẩu',
    moTa('203.0.113.10:50100:nguoidung01:MatKhauGia01') === '203.0.113.10:50100' && moTa('rác') === '');

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
IP = {"dt": "203.0.113.10", "pc": "198.51.100.20"}
def ip_ra():
    # VPN bat: ra mang bang proxy DANG NAM TRONG O cua Lalasoft (nhu may that). "co_dinh" ep mot IP;
    # dt rong = proxy chet; dt = pc = lo IP that.
    if IP.get("co_dinh") or IP["dt"] in ("", IP["pc"]): return IP["dt"]
    return MAY.o.get(CP.O_DIA_CHI) or IP["dt"]
LENH = []
# Mang nen (wifi_on + bang dinh tuyen). Rong = "chua hoi duoc" -> khong chan (nhu cu).
MANG = {"out": ""}
def adb_gia(*a, serial=None, timeout=60):
    LENH.append(list(a))
    if a[0] == "shell" and len(a) > 1 and "ip route" in a[1]: return MANG["out"]
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
    if a[:4] == ("shell", "pm", "list", "packages"):
        return ("package:" + CP.PKG) if IP.get("co_cp", True) else ""
    # ip-api (nuoc + IP). "tat_ra_that": VPN tat thi may van ra mang bang IP that Viet Nam — dung
    # canh do duoc tren 6 may USB 2026-09-23. "vn_lan": n lan dau tra VN du VPN bat.
    # Do IP: MOT lenh hoi song song ip-api (A) / ipify (B) / icanhazip (C), moi dong "A|..." —
    # xem _lenh_hoi_ip. "hong": n lan hoi ipify/icanhazip dau tien khong tra gi.
    if a[0] == "shell" and "toybox nc" in a[1]:
        ra = []
        if "ip-api.com" in a[1]:
            ra += ["A|" + x for x in _api().split("\\n") if x]
        for nhan, host in (("B", "api.ipify.org"), ("C", "icanhazip.com")):
            if host in a[1]:
                r = _nc()
                if r: ra.append(nhan + "|" + r)
        return "\\n".join(ra)
    return ""
def _api():
    if IP.get("api_hong"): return ""
    if IP.get("vn_lan", 0) > 0:
        IP["vn_lan"] -= 1; return "VN\\n" + IP["pc"]
    if MAY.bat: return (IP.get("nuoc_dt", "US") + "\\n" + ip_ra()) if ip_ra() else ""
    return ("VN\\n" + IP["pc"]) if IP.get("tat_ra_that") else ""
def _nc():
    if IP.get("hong", 0) > 0:
        IP["hong"] -= 1; return ""
    return ip_ra() if MAY.bat else (IP["pc"] if IP.get("tat_ra_that") else "")
CP.adb = adb_gia
CP.ip_may_tinh = lambda: IP["pc"]
# Thu proxy tu MAY TINH: mac dinh "khong thu duoc" -> hanh vi cu. Phep thu KHONG ra mang that.
_THU_PC_GOC = CP.thu_proxy_tu_may_tinh
PC = {"kq": ("", "")}
CP.thu_proxy_tu_may_tinh = lambda p: PC["kq"]
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
  const MK = 'MatKhauGia01';
  const PX = `203.0.113.10:50100:nguoidung01:${MK}`;

  // ── 2. Luật đọc chuỗi của Python khớp bản JS ──
  {
    const r = chay('doc', `ket(kq=[CP.doc_proxy(s) for s in ${JSON.stringify(MAU.map(([s]) => s))}])`);
    const lech = r.kq ? MAU.filter(([, mong], i) => JSON.stringify(r.kq.kq[i]) !== JSON.stringify(mong)) : MAU;
    check('2a. doc_proxy (Python) khớp docProxy (JS) trên cùng bộ mẫu', !lech.length, lech.map(([s]) => s).join(' | ') || r.loi);
    const q = chay('quote', `ket(kq=[CP.chuoi_input_text("a b"), CP.chuoi_input_text("x'y")])`);
    check("2b. Gõ chữ: dấu cách → %s, dấu ' được bọc cho shell trên điện thoại",
      !!q.kq && q.kq.kq[0] === "'a%sb'" && q.kq.kq[1] === "'x'\\''y'", q.kq ? JSON.stringify(q.kq.kq) : q.loi);
  }

  // ── 2c. Đo IP trên điện thoại (2026-09-28) ──
  // Đo thật qua Lalasoft: mỗi lần hỏi chỉ ~50% được, lần hỏng không giới hạn thì TREO ~128 giây, và
  // Lalasoft có quãng "đứng" vài chục giây làm cả ba dịch vụ cùng hỏng.
  {
    const r = chay('do_ip', `
GOI = []
TL = {"n_hong": 3, "chi_b": False}
def adb_do(*a, serial=None, timeout=60):
    GOI.append(a[1])
    if TL["n_hong"] > 0:
        TL["n_hong"] -= 1; return ""
    if TL["chi_b"]: return "B|203.0.113.10\\nC|<html>"
    return "A|US\\nA|203.0.113.10\\nB|203.0.113.10"
CP.adb = adb_do
ip1 = CP.do_ip_nuoc("S"); goi1 = list(GOI)
GOI.clear(); TL["n_hong"] = 10**6
ip2 = CP.do_ip_nuoc("S"); so2 = len(GOI)
GOI.clear(); TL["n_hong"] = 0; TL["chi_b"] = True
ip3 = CP.do_ip_nuoc("S")
ket(ip1=ip1, goi1=goi1, ip2=ip2, so2=so2, ip3=ip3)`);
    const k = r.kq || {};
    check('2c. Đo IP: 3 vòng đầu hỏng (Lalasoft "đứng") → đo tiếp, được ở vòng 4 và DỪNG ngay',
      !!r.kq && JSON.stringify(k.ip1) === '["203.0.113.10","US"]' && k.goi1.length === 4, r.kq ? JSON.stringify(k.ip1) + ' ' + k.goi1.length : r.loi);
    check('2d. Đo IP: mỗi vòng hỏi SONG SONG ip-api + ipify + icanhazip, mỗi cái có giới hạn cứng (toybox timeout)',
      !!r.kq && k.goi1.every((c) => /ip-api\.com/.test(c) && /api\.ipify\.org/.test(c) && /icanhazip\.com/.test(c)
        && (c.match(/toybox timeout \d+ toybox nc/g) || []).length === 3 && /&\s*wait$/.test(c)),
      r.kq ? k.goi1[0] : r.loi);
    check('2e. Đo IP: hỏng hết → trả rỗng sau ĐÚNG 6 vòng (không treo, không thử vô hạn)',
      !!r.kq && k.ip2[0] === '' && k.so2 === 6, r.kq ? String(k.so2) : r.loi);
    check('2f. Đo IP: ip-api không trả mà ipify trả → vẫn có IP (không có nước)',
      !!r.kq && JSON.stringify(k.ip3) === '["203.0.113.10",""]', r.kq ? JSON.stringify(k.ip3) : r.loi);
  }

  // ── 3. dam_bao_proxy: hành vi ──
  {
    const r = chay('ok', `
ip = CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit)
ket(ip=ip, o=MAY.o, bat=MAY.bat)`);
    const k = r.kq || {};
    check('3a. Máy tắt proxy → nhập đủ 4 ô, bật VPN, đo IP, trả IP proxy',
      k.ip === '203.0.113.10' && k.bat === true && k.o && k.o[`${'com.cell47.College_Proxy'}:id/editText_password`] === MK,
      JSON.stringify(k.o) || r.loi);
    check('3b. Báo sự kiện proxy ok kèm IP cho giao diện',
      !!k.su_kien && k.su_kien.some((e) => e.type === 'proxy' && e.ok === true && e.ip === '203.0.113.10'));
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
      !!nhanh.kq && nhanh.kq.ip === '203.0.113.10' && !nhanh.kq.go.length && !nhanh.kq.viec.length,
      nhanh.kq ? JSON.stringify(nhanh.kq.viec) : nhanh.loi);

    const doi = chay('doi', `
MAY.bat = True
MAY.o = {CP.O_DIA_CHI: "9.9.9.9", CP.O_CONG: "1", CP.O_TEN: "cu"}
open("${MOC}", "w").write(CP._dau("9.9.9.9:1:cu:x"))
CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}")
ket(o=MAY.o, bat=MAY.bat, sach=[v for v in MAY.viec if v[0] == "app_start"], moc=open("${MOC}").read())`);
    check('3e. Dấu là proxy KHÁC → mở College Proxy SẠCH (force-stop), nhập proxy mới, bật, ghi dấu mới',
      !!doi.kq && doi.kq.o['com.cell47.College_Proxy:id/editText_address'] === '203.0.113.10'
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
MAY.o = {CP.O_DIA_CHI: "203.0.113.10", CP.O_CONG: "50100", CP.O_TEN: "nguoidung01", CP.O_MAT_KHAU: "x"}
IP["api_hong"] = True
IP["hong"] = 12     # ca 6 vong do o duong nhanh deu hong (moi vong 2 lan ipify/icanhazip; ip-api hong)
open("${MOC}", "w").write(CP._dau(${JSON.stringify(PX)}))
ip = CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}")
ket(ip=ip, sach=[v for v in MAY.viec if v[0] == "app_start"], go=[l for l in LENH if l[:3] == ["shell", "input", "text"]])`);
    check('3e5. Đường nhanh đo IP hỏng thoáng qua → bật lại trong CÙNG lượt, KHÔNG gõ lại (ô đã đúng proxy)',
      !!nhanhHong.kq && nhanhHong.kq.ip === '203.0.113.10' && nhanhHong.kq.sach.length === 1 && !nhanhHong.kq.go.length
      && nhanhHong.kq.log.some((l) => /KHÔNG gõ lại/.test(l)), nhanhHong.kq ? JSON.stringify(nhanhHong.kq.log) : nhanhHong.loi);

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
      !!lan2.kq && lan2.kq.ip === '203.0.113.10' && lan2.kq.sach.length === 2 && lan2.kq.clear.length === 1
      && lan2.kq.log.some((l) => /thử lần 2/.test(l)), lan2.loi);
    // Đo thật: app kẹt vòng lặp Loading, force-stop KHÔNG gỡ được, chỉ \`pm clear\` gỡ được.
    const ket = chay('ket_loading', `
MAY.loading = 10**6
ip = CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit)
ket(ip=ip)`);
    check('3e6. Kẹt vòng lặp Loading (force-stop không gỡ được) → lần 2 pm clear gỡ được, gắn xong',
      !!ket.kq && ket.kq.ip === '203.0.113.10', ket.loi);
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
    // ⚠ Tên tệp KHÔNG được là `socks`: tệp thử nằm đầu sys.path, và `requests` (3u) import module
    // `socks` — nó sẽ chạy nhầm tệp này.
    const socks = chay('cong_socks5', `
IP["dt"] = ""
try:
    CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit); ket(hong=False)
except CP.ProxyHong as e:
    ket(hong=True, ly_do=str(e))`);
    check('3g. Connected nhưng mất mạng (cổng SOCKS5) → ProxyHong, nói rõ có thể là SOCKS5',
      !!socks.kq && socks.kq.hong && /SOCKS5/.test(socks.kq.ly_do)
      && socks.kq.su_kien.some((e) => e.type === 'proxy' && e.ok === false), socks.loi);

    const lo = chay('lo', `
IP["dt"] = IP["pc"]; IP["nuoc_dt"] = "VN"
try:
    CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit); ket(hong=False)
except CP.ProxyHong as e:
    ket(hong=True, ly_do=str(e))`);
    check('3h. Máy vẫn ra IP Việt Nam (ip-api báo VN) → ProxyHong', !!lo.kq && lo.kq.hong && /IP Việt Nam/.test(lo.kq.ly_do), lo.loi);
    const lo2 = chay('lo2', `
IP["dt"] = IP["pc"]; IP["api_hong"] = True
try:
    CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit); ket(hong=False)
except CP.ProxyHong as e:
    ket(hong=True, ly_do=str(e))`);
    check('3h2. ip-api hỏng, IP máy = IP thật của máy tính → ProxyHong', !!lo2.kq && lo2.kq.hong && /IP thật/.test(lo2.kq.ly_do), lo2.loi);

    const dungHost = chay('dung_host', `
CP.ip_may_tinh = lambda: ""
IP["api_hong"] = True
ip = CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit)
ket(ip=ip)`);
    check('3i0. ip-api không trả lời, máy tính không đọc được IP, nhưng máy ra ĐÚNG IP của proxy → cho chạy',
      !!dungHost.kq && dungHost.kq.ip === '203.0.113.10', dungHost.loi);
    const khongPc = chay('khong_pc', `
CP.ip_may_tinh = lambda: ""
IP["api_hong"] = True; IP["co_dinh"] = True; IP["dt"] = "203.0.113.77"
try:
    CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit); ket(hong=False)
except CP.ProxyHong as e:
    ket(hong=True)`);
    check('3i. Không biết nước của IP, IP khác IP proxy, không đọc được IP máy tính → KHÔNG cho chạy (không đoán)', !!khongPc.kq && khongPc.kq.hong, khongPc.loi);
    const khongKiem = chay('khong_kiem_duoc', `
CP.ip_may_tinh = lambda: ""
IP["api_hong"] = True; IP["co_dinh"] = True; IP["dt"] = "203.0.113.77"
MAY.o = {CP.O_DIA_CHI: "203.0.113.10", CP.O_CONG: "50100", CP.O_TEN: "nguoidung01", CP.O_MAT_KHAU: "?"}
open("${MOC}", "w").write(CP._dau(${JSON.stringify(PX)}))
try:
    CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}"); ket(hong=False)
except CP.ProxyHong:
    ket(hong=True, go=[l for l in LENH if l[:3] == ["shell", "input", "text"]], clear=[l for l in LENH if l[:3] == ["shell", "pm", "clear"]])`);
    check('3i2. "Không kiểm được IP" KHÔNG phải lỗi giao diện → không pm clear, không gõ lại proxy',
      !!khongKiem.kq && khongKiem.kq.hong && !khongKiem.kq.go.length && !khongKiem.kq.clear.length,
      khongKiem.kq ? JSON.stringify(khongKiem.kq.clear) : khongKiem.loi);

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

    // ── 2026-09-28: "mỗi lần bấm Chạy / Đăng nhập nó lại điền lại proxy" ──
    const O_DUNG = `{CP.O_DIA_CHI: "203.0.113.10", CP.O_CONG: "50100", CP.O_TEN: "nguoidung01", CP.O_MAT_KHAU: "?"}`;
    const GO = '[l for l in LENH if l[:3] == ["shell", "input", "text"]]';
    const tuBat = chay('tu_bat', `
import os
MAY.bat = True
MAY.o = ${O_DUNG}
if os.path.exists("${MOC}"): os.remove("${MOC}")
ip = CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}")
ket(ip=ip, go=${GO}, viec=MAY.viec, moc=open("${MOC}").read() == CP._dau(${JSON.stringify(PX)}))`);
    check('3m. Người dùng tự bật Lalasoft (không có dấu), máy ra đúng IP proxy → KHÔNG đụng Lalasoft, ghi dấu',
      !!tuBat.kq && tuBat.kq.ip === '203.0.113.10' && !tuBat.kq.go.length && !tuBat.kq.viec.length && tuBat.kq.moc,
      tuBat.kq ? JSON.stringify(tuBat.kq.viec) : tuBat.loi);

    const khacIp = chay('khac_ip', `
import os
MAY.bat = True
MAY.o = ${O_DUNG}
IP["co_dinh"] = True; IP["dt"] = "203.0.113.55"
if os.path.exists("${MOC}"): os.remove("${MOC}")
ip = CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}")
ip2 = CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}")
ket(ip=ip, ip2=ip2, go=${GO}, sach=[v for v in MAY.viec if v[0] == "app_start"])`);
    check('3n. Không có dấu, IP ra khác host proxy (proxy xoay IP), ô đã đúng → mở kiểm ô, chỉ bật, KHÔNG gõ; lượt sau không đụng',
      !!khacIp.kq && khacIp.kq.ip === '203.0.113.55' && khacIp.kq.ip2 === '203.0.113.55' && !khacIp.kq.go.length
      && khacIp.kq.sach.length === 1, khacIp.kq ? JSON.stringify(khacIp.kq) : khacIp.loi);

    const khoiDong = chay('khoi_dong_lai', `
MAY.o = ${O_DUNG}
open("${MOC}", "w").write(CP._dau(${JSON.stringify(PX)}))
ip = CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}")
ket(ip=ip, bat=MAY.bat, go=${GO})`);
    check('3o. Điện thoại khởi động lại (VPN tắt), ô Lalasoft còn đúng → chỉ bấm START, KHÔNG gõ lại',
      !!khoiDong.kq && khoiDong.kq.ip === '203.0.113.10' && khoiDong.kq.bat === true && !khoiDong.kq.go.length, khoiDong.loi);

    const chet = chay('chet', `
import os
MAY.bat = True
MAY.o = ${O_DUNG}
IP["dt"] = ""
open("${MOC}", "w").write(CP._dau(${JSON.stringify(PX)}))
kq = []
for lan in range(3):   # bấm Chạy / Đăng nhập ba lần liền
    try:
        CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}"); kq.append("ok")
    except CP.ProxyChet as e:
        kq.append("chet")
ket(kq=kq, go=${GO}, clear=[l for l in LENH if l[:3] == ["shell", "pm", "clear"]], sach=[v for v in MAY.viec if v[0] == "app_start"],
    con_moc=os.path.exists("${MOC}"))`);
    check('3p. Proxy CHẾT, bấm Chạy 3 lần → mỗi lần báo proxy chết, KHÔNG gõ lại, KHÔNG xoá dữ liệu Lalasoft, giữ dấu',
      !!chet.kq && chet.kq.kq.join() === 'chet,chet,chet' && !chet.kq.go.length && !chet.kq.clear.length
      && chet.kq.con_moc && chet.kq.sach.length === 3, chet.kq ? JSON.stringify(chet.kq) : chet.loi);
    check('3p2. Báo rõ cho người dùng: đổi proxy khác, không gõ lại',
      !!chet.kq && chet.kq.su_kien.some((e) => e.type === 'proxy' && e.ok === false && /KHÔNG gõ lại/.test(e.msg)));

    const chetMk = chay('chet_mk', `
import os
MAY.bat = True
MAY.o = ${O_DUNG}
IP["dt"] = ""
if os.path.exists("${MOC}"): os.remove("${MOC}")
kq = []
for lan in range(2):
    try:
        CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}"); kq.append("ok")
    except CP.ProxyChet:
        kq.append("chet")
ket(kq=kq, so_go=len(${GO}), clear=[l for l in LENH if l[:3] == ["shell", "pm", "clear"]])`);
    check('3q. Không có dấu, ô khớp nhưng mật khẩu chưa chắc, không ra mạng → gõ lại đủ 4 ô MỘT lần (không pm clear); lần bấm sau không gõ nữa',
      !!chetMk.kq && chetMk.kq.kq.join() === 'chet,chet' && chetMk.kq.so_go === 4 && !chetMk.kq.clear.length,
      chetMk.kq ? JSON.stringify(chetMk.kq) : chetMk.loi);

    const saiDang = chay('sai_dang', `
try:
    CP.dam_bao_proxy(MAY, "S", "1.2.3.4", log, emit); ket(hong=False)
except CP.ProxyHong:
    ket(hong=True, mo=[v for v in MAY.viec if v[0] == "app_start"])`);
    check('3k. Chuỗi proxy sai dạng → ProxyHong trước khi đụng tới điện thoại',
      !!saiDang.kq && saiDang.kq.hong && !saiDang.kq.mo.length, saiDang.loi);

    // ── 2026-09-29: Lalasoft báo "Connected" mà app báo "✕ không chạy" ──
    // Đo thật 4 máy USB: Wi-Fi TẮT → không có đường ra Internet, dù proxy (thử từ máy tính) vẫn sống.
    // Bản cũ bảo "đổi proxy khác" — chẩn đoán sai.
    const CO_MANG = '"1\\ndefault via 192.168.5.1 dev wlan0 table wlan0 proto static"';
    const KHONG_MANG = '"0\\nunreachable default dev lo table tun0 proto static metric 1024 error -101"';
    const khongMang = chay('khong_mang', `
import os
MAY.bat = True
MAY.o = ${O_DUNG}
MANG["out"] = ${KHONG_MANG}
open("${MOC}", "w").write(CP._dau(${JSON.stringify(PX)}))
try:
    CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}"); ket(hong=False)
except CP.MayKhongCoMang as e:
    ket(hong=True, ly_do=str(e), mo=[v for v in MAY.viec if v[0] == "app_start"], go=${GO}, con_moc=os.path.exists("${MOC}"))`);
    check('3r. Máy TẮT Wi-Fi (Lalasoft vẫn Connected) → báo "Wi-Fi đang TẮT", KHÔNG bảo đổi proxy, KHÔNG đụng Lalasoft, giữ dấu',
      !!khongMang.kq && khongMang.kq.hong && /Wi-Fi đang TẮT/.test(khongMang.kq.ly_do) && !/đổi proxy/.test(khongMang.kq.ly_do)
      && !khongMang.kq.mo.length && !khongMang.kq.go.length && khongMang.kq.con_moc
      && khongMang.kq.su_kien.some((e) => e.type === 'proxy' && e.ok === false && /không có mạng/.test(e.msg)),
      khongMang.kq ? JSON.stringify(khongMang.kq) : khongMang.loi);

    const mangDoc = chay('mang_doc', `ket(kq=[list(CP.doc_mang_nen(s)) for s in ${JSON.stringify(MAU_MANG.map(([s]) => s))}])`);
    const lechMang = mangDoc.kq ? MAU_MANG.filter(([, mong], i) => JSON.stringify(mangDoc.kq.kq[i]) !== JSON.stringify(mong)) : MAU_MANG;
    check('3r2. doc_mang_nen: Wi-Fi / di động có đường → có mạng; chỉ "unreachable default" → KHÔNG (kèm Wi-Fi tắt); không đọc được gì → chưa biết, không chặn',
      !lechMang.length, mangDoc.kq ? JSON.stringify(mangDoc.kq.kq) : mangDoc.loi);

    const duPhong = chay('du_phong_pc', `
MAY.bat = True
MAY.o = ${O_DUNG}
MANG["out"] = ${CO_MANG}
IP["dt"] = ""
PC["kq"] = ("ok", "203.0.113.10")
open("${MOC}", "w").write(CP._dau(${JSON.stringify(PX)}))
ip = CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}")
ket(ip=ip, mo=[v for v in MAY.viec if v[0] == "app_start"], go=${GO})`);
    check('3s. Lalasoft đã start ĐÚNG proxy (dấu khớp), đo trên máy không ra, proxy sống khi thử từ máy tính → ✓ nhận IP proxy, không đụng Lalasoft',
      !!duPhong.kq && duPhong.kq.ip === '203.0.113.10' && !duPhong.kq.mo.length && !duPhong.kq.go.length
      && duPhong.kq.su_kien.some((e) => e.type === 'proxy' && e.ok === true && e.ip === '203.0.113.10')
      && duPhong.kq.log.some((l) => /thử từ máy tính/.test(l)), duPhong.kq ? JSON.stringify(duPhong.kq) : duPhong.loi);

    const duPhongKhongDau = chay('du_phong_khong_dau', `
import os
MAY.bat = True
MAY.o = ${O_DUNG}
MANG["out"] = ${CO_MANG}
IP["dt"] = ""
PC["kq"] = ("ok", "203.0.113.10")
if os.path.exists("${MOC}"): os.remove("${MOC}")
ip = CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}")
ket(ip=ip, so_go=len(${GO}), clear=[l for l in LENH if l[:3] == ["shell", "pm", "clear"]])`);
    check('3s2. Không có dấu (mật khẩu trong Lalasoft chưa chắc) → KHÔNG nhận ngay; gõ lại đủ 4 ô MỘT lần rồi mới nhận IP proxy',
      !!duPhongKhongDau.kq && duPhongKhongDau.kq.ip === '203.0.113.10' && duPhongKhongDau.kq.so_go === 4
      && !duPhongKhongDau.kq.clear.length, duPhongKhongDau.kq ? JSON.stringify(duPhongKhongDau.kq) : duPhongKhongDau.loi);

    const saiMk = chay('sai_mk_pc', `
MAY.bat = True
MAY.o = ${O_DUNG}
MANG["out"] = ${CO_MANG}
IP["dt"] = ""
PC["kq"] = ("sai_mk", "")
open("${MOC}", "w").write(CP._dau(${JSON.stringify(PX)}))
try:
    CP.dam_bao_proxy(MAY, "S", ${JSON.stringify(PX)}, log, emit, moc="${MOC}"); ket(hong=False)
except CP.ProxyHong as e:
    ket(hong=True, ly_do=str(e), mo=[v for v in MAY.viec if v[0] == "app_start"], go=${GO})`);
    check('3t. Proxy SAI mật khẩu (407 khi thử từ máy tính) → báo đúng, KHÔNG mở / gõ lại Lalasoft',
      !!saiMk.kq && saiMk.kq.hong && /407/.test(saiMk.kq.ly_do) && !saiMk.kq.mo.length && !saiMk.kq.go.length,
      saiMk.kq ? JSON.stringify(saiMk.kq) : saiMk.loi);

    // Hàm thử proxy từ máy tính THẬT, với `requests` giả (không ra mạng).
    const thuPc = chay('thu_pc', `
import requests
URL = []
class R:
    def __init__(s, code, text): s.status_code, s.text = code, text
TL = {"kieu": "ok"}
def get_gia(url, proxies=None, timeout=None):
    URL.append(proxies["http"])
    if TL["kieu"] == "loi": raise requests.exceptions.ProxyError("Unable to connect to proxy " + proxies["http"])
    if TL["kieu"] == "407": return R(407, "")
    return R(200, "203.0.113.10\\n")
requests.get = get_gia
f = _THU_PC_GOC
kq = {"ok": f(CP.doc_proxy(${JSON.stringify(PX)}))}
TL["kieu"] = "407"; kq["sai_mk"] = f(CP.doc_proxy(${JSON.stringify(PX)}))
TL["kieu"] = "loi"; kq["chet"] = f(CP.doc_proxy(${JSON.stringify(PX)}))
CP.ip_may_tinh = lambda: ""
kq["pc_mat_mang"] = f(CP.doc_proxy(${JSON.stringify(PX)}))
TL["kieu"] = "ok"; f(CP.doc_proxy("2001:db8::1:8080:u:p@x"))
ket(kq=kq, url0=URL[0], url6=URL[-1])`);
    const tp = thuPc.kq || {};
    check('3u. thu_proxy_tu_may_tinh: 200 → ("ok", IP); 407 → sai_mk; không nối được → chet; máy tính mất mạng → chưa biết',
      !!thuPc.kq && JSON.stringify(tp.kq) === JSON.stringify({ ok: ['ok', '203.0.113.10'], sai_mk: ['sai_mk', ''], chet: ['chet', ''], pc_mat_mang: ['', ''] }),
      thuPc.kq ? JSON.stringify(tp.kq) : thuPc.loi);
    check('3u2. URL proxy: tài khoản được mã hoá (@ trong mật khẩu), host IPv6 có ngoặc; lỗi của requests không lọt ra log',
      !!thuPc.kq && tp.url0 === `http://nguoidung01:${MK}@203.0.113.10:50100` && tp.url6 === 'http://u:p%40x@[2001:db8::1]:8080'
      && !JSON.stringify([tp.log, tp.su_kien]).includes(MK), thuPc.kq ? `${tp.url0} ${tp.url6}` : thuPc.loi);
  }

  // ── 5. Lalasoft CÓ SẴN trên máy, không gán proxy trong app (2026-09-23) ──
  // Đo thật: 6/7 máy USB đang quét ra IP Việt Nam vì VPN Lalasoft tắt, mà chưa máy nào gán proxy
  // trong app nên đường cũ không chạy. App phải bật lại bằng ĐÚNG proxy đang lưu trên máy — không
  // gõ gì, không bao giờ `pm clear` (xoá mất proxy người dùng nhập tay).
  {
    const DA_NHAP = `MAY.o = {CP.O_DIA_CHI: "203.0.113.10", CP.O_CONG: "50100", CP.O_TEN: "nguoidung01"}`;
    const GO = `[l for l in LENH if l[:3] in (["shell", "input", "text"], ["shell", "input", "keyevent"])]`;
    const CLEAR = `[l for l in LENH if l[:3] == ["shell", "pm", "clear"]]`;
    const MO = `[v for v in MAY.viec if v[0] == "app_start"]`;

    const tat = chay('sc_tat', `
${DA_NHAP}
IP["tat_ra_that"] = True
ip, nuoc = CP.dam_bao_proxy_san_co(MAY, "S", log, emit)
ket(ip=ip, nuoc=nuoc, bat=MAY.bat, go=${GO}, clear=${CLEAR}, mo=${MO}, o=MAY.o)`);
    const t = tat.kq || {};
    check('5a. Lalasoft TẮT, ô đã có proxy → mở sạch, chỉ bấm START (không gõ, không pm clear) → ra IP US',
      t.ip === '203.0.113.10' && t.nuoc === 'US' && t.bat === true && !t.go.length && !t.clear.length
      && t.mo.length === 1 && t.o['com.cell47.College_Proxy:id/editText_address'] === '203.0.113.10',
      JSON.stringify({ ip: t.ip, nuoc: t.nuoc, go: t.go, clear: t.clear }) || tat.loi);
    check('5b. Báo sự kiện proxy ok kèm mã nước cho cột Proxy, log nói rõ đã bật lại',
      !!t.su_kien && t.su_kien.some((e) => e.type === 'proxy' && e.ok === true && e.nuoc === 'US' && e.ip === '203.0.113.10')
      && t.log.some((l) => /đang TẮT/.test(l)) && t.log.some((l) => /Đã bật lại Lalasoft/.test(l)), JSON.stringify(t.log));

    const trong = chay('sc_trong', `
IP["tat_ra_that"] = True
try:
    CP.dam_bao_proxy_san_co(MAY, "S", log, emit); ket(hong=False)
except CP.ProxyHong as e:
    ket(hong=True, ly_do=str(e), bat=MAY.bat, bam=[v for v in MAY.viec if v[0] == "click"], mo=${MO}, clear=${CLEAR})`);
    const tr = trong.kq || {};
    check('5c. Lalasoft chưa nhập proxy → ProxyHong nói rõ, KHÔNG bấm START, không thử lại, không pm clear',
      tr.hong === true && /chưa nhập proxy/.test(tr.ly_do) && tr.bat === false && !tr.bam.length
      && tr.mo.length === 1 && !tr.clear.length && tr.su_kien.some((e) => e.type === 'proxy' && e.ok === false),
      JSON.stringify(tr) || trong.loi);

    const dangBat = chay('sc_bat', `
MAY.bat = True
ip, nuoc = CP.dam_bao_proxy_san_co(MAY, "S", log, emit)
ket(ip=ip, nuoc=nuoc, viec=MAY.viec)`);
    check('5d. Lalasoft đang bật + ra IP US → không mở app, không bấm gì, chỉ đo',
      !!dangBat.kq && dangBat.kq.ip === '203.0.113.10' && dangBat.kq.nuoc === 'US' && !dangBat.kq.viec.length,
      dangBat.kq ? JSON.stringify(dangBat.kq.viec) : dangBat.loi);

    const roVn = chay('sc_ro_vn', `
${DA_NHAP}
MAY.bat = True
IP["vn_lan"] = 1
ip, nuoc = CP.dam_bao_proxy_san_co(MAY, "S", log, emit)
ket(ip=ip, nuoc=nuoc, mo=${MO}, clear=${CLEAR})`);
    check('5e. Lalasoft báo bật mà máy vẫn ra IP Việt Nam → bật lại từ đầu, ra IP US',
      !!roVn.kq && roVn.kq.nuoc === 'US' && roVn.kq.mo.length === 1 && !roVn.kq.clear.length
      && roVn.kq.log.some((l) => /vẫn ra IP Việt Nam/.test(l)), roVn.kq ? JSON.stringify(roVn.kq.log) : roVn.loi);

    const vnMai = chay('sc_vn_mai', `
${DA_NHAP}
IP["tat_ra_that"] = True
IP["nuoc_dt"] = "VN"
try:
    CP.dam_bao_proxy_san_co(MAY, "S", log, emit); ket(hong=False)
except CP.ProxyHong as e:
    ket(hong=True, ly_do=str(e), mo=${MO}, clear=${CLEAR})`);
    check('5f. Bật rồi mà vẫn IP Việt Nam (proxy trên máy hỏng) → thử lại 1 lần rồi ProxyHong — không mở TikTok, không pm clear',
      !!vnMai.kq && vnMai.kq.hong === true && /IP Việt Nam/.test(vnMai.kq.ly_do) && vnMai.kq.mo.length === 2
      && !vnMai.kq.clear.length, vnMai.kq ? JSON.stringify(vnMai.kq) : vnMai.loi);

    const khongDo = chay('sc_khong_do', `
MAY.bat = True
IP["api_hong"] = True
IP["hong"] = 99
ip, nuoc = CP.dam_bao_proxy_san_co(MAY, "S", log, emit)
ket(ip=ip, nuoc=nuoc, viec=MAY.viec)`);
    check('5g. Dịch vụ đo IP chết mà VPN đã bật → KHÔNG chặn cả farm, cho quét kèm ⚠',
      !!khongDo.kq && khongDo.kq.ip === '' && !khongDo.kq.viec.length
      && khongDo.kq.log.some((l) => /⚠.*không đo được IP/.test(l))
      && khongDo.kq.su_kien.some((e) => e.type === 'proxy' && e.ok === true), khongDo.kq ? JSON.stringify(khongDo.kq.log) : khongDo.loi);

    const doc2 = chay('sc_doc', `
ket(kq=[CP.doc_ip_nuoc(s) for s in ["US\\n203.0.113.10", "HTTP/1.0 200 OK\\r\\n\\r\\nVN\\n198.51.100.20", "US", "", "abc\\nxyz", "us\\n1.2.3.4"]],
    co=CP.co_college_proxy("S"))`);
    const mong = [['203.0.113.10', 'US'], ['198.51.100.20', 'VN'], ['', ''], ['', ''], ['', ''], ['', '']];
    check('5h. doc_ip_nuoc đọc đúng câu trả lời hai dòng của ip-api, câu trả lời rác ra rỗng',
      !!doc2.kq && JSON.stringify(doc2.kq.kq) === JSON.stringify(mong), doc2.kq ? JSON.stringify(doc2.kq.kq) : doc2.loi);
    const khongCo = chay('sc_khong_co', `
IP["co_cp"] = False
a = CP.co_college_proxy("S")
def hong(*x, **k): raise RuntimeError("adb lỗi")
CP.adb = hong
ket(khong=a, loi=CP.co_college_proxy("S"))`);
    check('5i. co_college_proxy: máy có Lalasoft → True, không có → False, adb lỗi → None (chưa hỏi được, không đoán)',
      !!doc2.kq && doc2.kq.co === true && !!khongCo.kq && khongCo.kq.khong === false && khongCo.kq.loi === null,
      JSON.stringify([doc2.kq && doc2.kq.co, khongCo.kq]) || khongCo.loi);

    // 2026-09-29: bản cũ ở đây "không đo được IP — vẫn quét" → TikTok mở trên máy không có mạng.
    const scKhongMang = chay('sc_khong_mang', `
${DA_NHAP}
MAY.bat = True
MANG["out"] = "0\\nunreachable default dev lo table tun0 proto static metric 1024 error -101"
try:
    CP.dam_bao_proxy_san_co(MAY, "S", log, emit); ket(hong=False)
except CP.MayKhongCoMang as e:
    ket(hong=True, ly_do=str(e), mo=${MO}, go=${GO})`);
    check('5j. Lalasoft có sẵn nhưng máy TẮT Wi-Fi → báo "Wi-Fi đang TẮT", không mở Lalasoft, không cho quét',
      !!scKhongMang.kq && scKhongMang.kq.hong && /Wi-Fi đang TẮT/.test(scKhongMang.kq.ly_do) && !scKhongMang.kq.mo.length
      && !scKhongMang.kq.go.length && scKhongMang.kq.su_kien.some((e) => e.type === 'proxy' && e.ok === false),
      scKhongMang.kq ? JSON.stringify(scKhongMang.kq) : scKhongMang.loi);
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
  check('4f. Kiểm VPN định kỳ giữa ca (máy gán proxy LẪN máy có Lalasoft sẵn), rớt thì tắt TikTok trước khi bật lại',
    /if time\.time\(\) >= kiem_vpn_luc:[\s\S]{0,400}if \(PROXY or co_college_proxy\(d\.serial\)\) and not CP\.vpn_dang_bat\(d\.serial\):[\s\S]{0,300}am", "force-stop", goi[\s\S]{0,300}setup_device\(d\)/.test(scan));
  // 2026-09-23: máy không gán proxy trong app nhưng có Lalasoft nhập sẵn (18 máy USB) cũng phải bật
  // Lalasoft TRƯỚC khi mở TikTok; máy mạng (không có Lalasoft) giữ nguyên — chủ dự án chốt.
  const iSanCo = setup.indexOf('elif co_college_proxy(d.serial):');
  const iGoiSanCo = setup.indexOf('CP.dam_bao_proxy_san_co(');
  check('4m. setup_device: không gán proxy mà máy có Lalasoft → bật Lalasoft rồi mới mở TikTok',
    iSanCo > iProxy && iGoiSanCo > iSanCo && iTik > iGoiSanCo, `${iProxy} ${iSanCo} ${iGoiSanCo} ${iTik}`);
  check('4n. Chỉ hỏi "có Lalasoft không" MỘT lần mỗi tiến trình (vòng giữa ca gọi mỗi 2 phút)',
    /def co_college_proxy\(serial\):\s*\n\s*if CO_CP\["co"\] is None:\s*\n\s*CO_CP\["co"\] = CP\.co_college_proxy\(serial\)/.test(scan));

  const cp = doc('college_proxy.py');
  check('4g. college_proxy.py không in mật khẩu ra log', !/log\([^)]*\[["']pass["']\]/.test(cp) && !/emit\([^)]*pass/.test(cp));
  check('4h. Không dùng send_keys (đổi bàn phím 效卫) hay set_text (vỡ khi bàn phím toàn màn hình)',
    !/\.send_keys\(|\.set_text\(/.test(cp));
  const sanCo = (cp.match(/def _bat_lai_san_co[\s\S]*?(?=\n# ── Chay rieng)/) || [''])[0];
  check('4o. Chế độ Lalasoft có sẵn KHÔNG BAO GIỜ pm clear / gõ proxy (xoá mất proxy người dùng nhập tay)',
    !!sanCo && !/pm", "clear|xoa_du_lieu=True|_dien_o\(|input", "text/.test(sanCo), sanCo.slice(0, 60));

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
  check('4j2. Mã nước (US/VN) đi đủ đường: runner → main lưu devices.json → renderer vẽ',
    /kind: 'proxy'[^}]*nuoc: String\(payload\.nuoc \|\| ''\)/.test(rn)
    && /proxyKq: \{[^}]*nuoc: String\(r\.nuoc \|\| ''\)/.test(doc('main.js'))
    && /p\.nuoc \? esc\(p\.nuoc\)/.test(doc('renderer/renderer.js')));

  const pkg = JSON.parse(doc('package.json'));
  check('4k. Bản build .exe mang theo college_proxy.py (extraResources)',
    (pkg.build.extraResources || []).includes('college_proxy.py'));

  const html = doc('renderer/index.html');
  const rend = doc('renderer/renderer.js');
  const idHtml = ['proxySelectedBtn', 'proxyModal', 'proxyText', 'proxyPreview', 'proxySave', 'proxyClear', 'proxyCancel', 'proxyModalClose', 'proxyTarget',
    'proxyCurrent', 'proxyCheck', 'proxyCheckBox', 'proxyCheckResult'];
  const thieuId = idHtml.filter((id) => !html.includes(`id="${id}"`) || !rend.includes(`'${id}'`));
  check('4l. Giao diện: mọi phần tử của modal proxy có trong HTML VÀ được renderer dùng', !thieuId.length, thieuId.join(', '));
  const cot = (html.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0].match(/<th\b/g).length;
  const o = (rend.match(/function deviceRowHtml[\s\S]*?\n}/) || [''])[0].match(/<td\b/g).length;
  check('4m. Bảng thiết bị: số cột tiêu đề = số ô mỗi dòng', cot === o, `${cot} tiêu đề, ${o} ô`);
  check('4n. preload lộ devicesSetProxies', /devicesSetProxies: \(data\) => ipcRenderer\.invoke\('devices-set-proxies'/.test(doc('preload.cjs')));

  // 2026-09-29: nút "Lưu" đổi thành "Lưu & Kết nối"; thêm nút "🔌 Kiểm tra proxy"; modal hiện proxy đang lưu.
  const mainJs = doc('main.js');
  check('4p. Modal proxy: nút "Lưu & Kết nối" + nút 🔌 Kiểm tra proxy nối tới main (proxies-check → proxycheck.kiemNhieu)',
    /id="proxySave">Lưu &amp; Kết nối</.test(html) && /id="proxyCheck">🔌 Kiểm tra proxy</.test(html)
    && /proxiesCheck: \(data\) => ipcRenderer\.invoke\('proxies-check'/.test(doc('preload.cjs'))
    && /ipcMain\.handle\('proxies-check'[\s\S]{0,1500}proxycheck\.kiemNhieu\(/.test(mainJs)
    && /window\.api\.proxiesCheck\(/.test(rend) && /addEventListener\('click', kiemTraProxy\)/.test(rend));
  check('4q. Kiểm tra proxy trả về giao diện KHÔNG kèm mật khẩu (chỉ host:port qua moTa)',
    /kq: kq\.map\(\(x, i\) => \(\{ id: x\.id, hien: proxy\.moTa\(cap\[i\]\.chuoi\), proxy: x\.proxy, mang: x\.mang \}\)\)/.test(mainJs));
  check('4r. Cột Proxy nói đúng bệnh: máy không có mạng (Wi-Fi) / sai mật khẩu proxy, thay vì chỉ "không chạy"',
    /không có mạng/.test(rend) && /sai mật khẩu proxy/.test(rend) && /máy không có mạng/.test(doc('college_proxy.py')));
}

// ── 6. Nút "🔌 Kiểm tra proxy" (src/proxycheck.cjs, 2026-09-29) ──
// Proxy giả chạy trên 127.0.0.1 — phép thử KHÔNG ra mạng thật.
(async () => {
  const http = require('http');
  const net = require('net');
  const pc = require(path.join(R, 'src', 'proxycheck.cjs'));
  const MKJ = 'MatKhauGia01';
  const AUTH = 'Basic ' + Buffer.from(`nguoidung01:${MKJ}`).toString('base64');

  const lech = MAU_MANG.filter(([s, mong]) => {
    const r = pc.docMangNen(s);
    return JSON.stringify([r.co, r.wifiTat]) !== JSON.stringify(mong);
  });
  check('6a. docMangNen (JS, nút Kiểm tra) khớp doc_mang_nen (Python, lượt quét) trên cùng bộ mẫu', !lech.length,
    lech.map(([s]) => JSON.stringify(s)).join(' | '));

  const moProxyGia = (chanConnect) => new Promise((xong) => {
    const s = http.createServer((req, res) => {
      if (req.headers['proxy-authorization'] !== AUTH) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('203.0.113.10');
    });
    s.on('connect', (req, sock) => {
      if (req.headers['proxy-authorization'] !== AUTH) { sock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
      sock.end(chanConnect ? 'HTTP/1.1 403 Forbidden\r\n\r\n' : 'HTTP/1.1 200 Connection Established\r\n\r\n');
    });
    s.listen(0, '127.0.0.1', () => xong(s));
  });
  const moIm = () => new Promise((xong) => {
    const giu = [];
    const s = net.createServer((sock) => giu.push(sock));   // nhận kết nối rồi im lặng mãi
    s.giu = giu;
    s.listen(0, '127.0.0.1', () => xong(s));
  });

  const tot = await moProxyGia(false);
  const chan = await moProxyGia(true);
  const im = await moIm();
  const dong = await moIm();
  const congDong = dong.address().port;
  await new Promise((x) => dong.close(x));

  const px = (s, mk = MKJ) => `127.0.0.1:${s.address ? s.address().port : s}:nguoidung01:${mk}`;
  const kqTot = await pc.thuProxy(px(tot));
  const kqSai = await pc.thuProxy(px(tot, 'SaiMatKhau'));
  const kqChan = await pc.thuProxy(px(chan));
  const kqDong = await pc.thuProxy(px(congDong), { hanMs: 8000 });
  const kqIm = await pc.thuProxy(px(im), { hanMs: 400 });
  const kqDang = await pc.thuProxy('1.2.3.4');
  im.giu.forEach((x) => x.destroy());
  await Promise.all([tot, chan, im].map((s) => new Promise((x) => s.close(x))));

  check('6b. Proxy sống: GET ra IP + CONNECT tới TikTok được → ✓ kèm IP và thời gian',
    kqTot.ok === true && kqTot.ip === '203.0.113.10' && kqTot.ms >= 0 && !kqTot.msg, JSON.stringify(kqTot));
  check('6c. Sai mật khẩu → nói rõ 407, không phải "proxy chết"', kqSai.ok === false && /407/.test(kqSai.msg), JSON.stringify(kqSai));
  check('6d. GET được mà CONNECT bị chặn → ✕ "không mở được đường HTTPS tới TikTok" (TikTok đi HTTPS)',
    kqChan.ok === false && kqChan.ip === '203.0.113.10' && /HTTPS tới TikTok/.test(kqChan.msg), JSON.stringify(kqChan));
  check('6e. Cổng không mở → "từ chối kết nối"', kqDong.ok === false && /từ chối kết nối/.test(kqDong.msg), JSON.stringify(kqDong));
  check('6f. Proxy nhận kết nối rồi im lặng → dừng đúng hạn, "không trả lời"', kqIm.ok === false && /không trả lời/.test(kqIm.msg)
    && kqIm.ms < 3000, JSON.stringify(kqIm));
  check('6g. Chuỗi sai dạng → báo ngay, không kết nối', kqDang.ok === false && /sai dạng/.test(kqDang.msg));
  check('6h. Kết quả kiểm tra KHÔNG chứa mật khẩu',
    !JSON.stringify([kqTot, kqSai, kqChan, kqDong, kqIm]).includes(MKJ) && !JSON.stringify([kqSai]).includes('SaiMatKhau'));

  let dangThu = 0;
  let dinh = 0;
  const thuGia = async (chuoi) => {
    dangThu++; dinh = Math.max(dinh, dangThu);
    await new Promise((x) => setTimeout(x, 20));
    dangThu--;
    return { ok: true, ip: chuoi.split(':')[0], ms: 1, msg: '' };
  };
  const hoiGia = async (serial) => ({ co: serial !== 'S3', wifiTat: serial === 'S3' });
  const dsMay = Array.from({ length: 7 }, (_, i) => ({ id: `d${i}`, chuoi: i === 2 ? '' : `203.0.113.${i}:80:u:p`, serial: `S${i}` }));
  const kqNhieu = await pc.kiemNhieu(dsMay, { dongThoi: 3, thu: thuGia, hoiMang: hoiGia });
  check('6i. kiemNhieu: giữ đúng thứ tự máy, tối đa 3 máy một lúc (chung một adb server), máy chưa có proxy vẫn được hỏi mạng',
    kqNhieu.map((x) => x.id).join() === dsMay.map((x) => x.id).join() && dinh === 3 && kqNhieu[2].proxy === null
    && kqNhieu[2].mang.co === true && kqNhieu[3].mang.co === false && kqNhieu[3].mang.wifiTat === true
    && kqNhieu[4].proxy.ip === '203.0.113.4', JSON.stringify({ dinh, kqNhieu }));

  done();
})().catch((e) => { check('6. Phần kiểm tra proxy chạy không lỗi', false, String(e && e.stack || e)); done(); });
