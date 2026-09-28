"""
college_proxy.py — Gắn proxy cho điện thoại bằng app College Proxy đã cài sẵn trên máy farm.

App là một VPN: mọi traffic của TikTok đi qua proxy, không cần root. Nhưng nó CHỈ chạy proxy
HTTP. Đo trên máy 60 (SM-A920F, 2026-09-23) với cùng một tài khoản proxy:
  - cổng HTTP  50100 → app báo Connected, IP công khai của máy = IP proxy;
  - cổng SOCKS5 50101 → app VẪN báo Connected, nhưng máy mất mạng hẳn.
Nên chữ "Connected" không chứng minh được gì — chỉ IP công khai đo trên chính điện thoại mới là
bằng chứng. Mọi lần gắn đều kết thúc bằng phép đo đó.

Dùng từ scan_feed_sounds.py: `dam_bao_proxy(d, serial, chuoi_proxy, log, emit_event)`.
Hỏng thì ném `ProxyHong` — nơi gọi PHẢI dừng, không được mở TikTok bằng IP thật.
"""
import ipaddress
import os
import re
import time

from adb_helper import adb

PKG = "com.cell47.College_Proxy"
_RID = PKG + ":id/"
O_DIA_CHI = _RID + "editText_address"
O_CONG = _RID + "editText_port"
O_TEN = _RID + "editText_username"
O_MAT_KHAU = _RID + "editText_password"
NUT = _RID + "proxy_start_button"

# Hop thoai "Connection request" cua Android lan dau app xin quyen VPN tren moi may.
NUT_DONG_Y_VPN = "android:id/button1"

# Dich vu tra IP bang HTTP THUONG (khong TLS): tren dien thoai chi co `toybox nc`, khong co curl.
IP_HOST = "api.ipify.org"
# Dich vu tra CA NUOC lan IP, cung HTTP thuong. Chu du an phan biet dung hai trang thai "IP Viet Nam"
# (Lalasoft tat) / "IP US" (Lalasoft bat). Do that 2026-09-23 bang `toybox nc` tren dien thoai, ~5 giay:
# may VPN bat -> "US | 203.0.113.10", may VPN tat -> "VN | 198.51.100.20".
NUOC_HOST = "ip-api.com"


class ProxyHong(Exception):
    """Khong gan duoc proxy, hoac gan roi ma may van ra IP that. Noi goi phai DUNG."""


class ProxyChet(ProxyHong):
    """Lalasoft DA BAT voi dung proxy nay ma may khong ra Internet / van ra IP Viet Nam: loi nam o
    CHINH proxy (chet, het han, sai mat khau, cong SOCKS5). Go lai cung chuoi do khong chua duoc —
    khac voi loi giao dien (man Loading, go khong khop), thu lai co the duoc."""


# ── Chuoi proxy ──

def doc_proxy(chuoi):
    """`host:port:user:pass` hoac `host:port` -> dict, sai dang -> None.

    Tach tu PHAI sang cho `host` la IPv6 (co dau `:`) van tach dung khi co du user/pass.
    """
    s = (chuoi or "").strip()
    if not s or any(c.isspace() for c in s):
        return None
    phan = s.split(":")
    if len(phan) >= 4 and phan[-3].isdigit():
        host, cong, ten, mk = ":".join(phan[:-3]), phan[-3], phan[-2], phan[-1]
    elif len(phan) >= 2 and phan[-1].isdigit():
        host, cong, ten, mk = ":".join(phan[:-1]), phan[-1], "", ""
    else:
        return None
    if not host or not (1 <= int(cong) <= 65535):
        return None
    return {"host": host, "port": cong, "user": ten, "pass": mk}


def mo_ta(p):
    """Dong de in ra log: KHONG BAO GIO co mat khau."""
    return f"{p['host']}:{p['port']}" + (f" (tài khoản {p['user']})" if p["user"] else "")


def ip_hop_le(s):
    try:
        ipaddress.ip_address((s or "").strip())
        return True
    except ValueError:
        return False


# ── Do IP ──

_IP_MAY_TINH = {"ip": "", "luc": 0.0}


def ip_may_tinh():
    """IP cong khai cua MAY TINH = IP that cua ca farm (dien thoai va may tinh chung mot duong
    mang: do ngay 2026-09-23, ca hai cung ra mot IP). Giu 10 phut."""
    if _IP_MAY_TINH["ip"] and time.time() - _IP_MAY_TINH["luc"] < 600:
        return _IP_MAY_TINH["ip"]
    import requests
    for url in ("https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"):
        try:
            ip = requests.get(url, timeout=8).text.strip()
            if ip_hop_le(ip):
                _IP_MAY_TINH.update(ip=ip, luc=time.time())
                return ip
        except Exception:
            pass
    return ""


# ── Do IP tren dien thoai ──
#
# ⚠ DO QUA LALASOFT RAT CHAP CHON — PHAI THU NHIEU LAN, CO GIOI HAN CUNG (do 2026-09-28, may
# 52000352c0ee64df, proxy HTTP con song: tu MAY TINH qua cung proxy do 18/18 lan, 0,5 giay):
#   - tren dien thoai, MOI lan hoi (ip-api / ipify / icanhazip, cong 80) chi duoc ~50%: 3/6 moi dich
#     vu; lan duoc mat ~6 giay, lan hong la ket noi TCP khong mo duoc;
#   - khong co gioi han cung thi lan hong TREO ~128 giay (thoi gian Linux cho mo ket noi — `nc -w`
#     khong ap vao buoc nay): do duoc 64 / 128 / 128 giay.
# Ban cu thu 2 lan ip-api + 2 lan ipify, khong gioi han -> ~1/16 so luot ket luan nham "proxy khong
# ra Internet" voi proxy CON SONG, va luc hong thi treo vai phut. Moi lan ket luan nham, `dam_bao_proxy`
# ban cu xoa dau roi go lai proxy vao Lalasoft — dung loi chu du an bao ngay 2026-09-28.
# TikTok van chay vi no di HTTPS (cong 443) — duong khac trong Lalasoft.
# Gio: moi VONG hoi CA BA dich vu CUNG LUC trong mot lenh adb (moi cai `toybox timeout` cung), toi da
# DO_IP_VONG vong. Hoi lan luot thi do that ton 69-95 giay moi lan bam Chay (moi lan hong mat 12 giay);
# song song thi mot vong <= ~13 giay.
# ⚠ Hong KHONG doc lap giua cac dich vu: Lalasoft co nhung quang "dung" vai chuc giay, ca ba cung hong
# (do: mot lan hong ca 3 vong song song, 38 giay; cac lan khac xong o vong 1-2). Nen can CUA SO THOI
# GIAN du dai de qua quang dung, khong phai nhieu dich vu hon: 6 vong, toi da ~90 giay — chi proxy
# chet that moi ton het; proxy song thuong xong sau 12-25 giay.
DO_IP = (("A", NUOC_HOST, "/line/?fields=countryCode,query"), ("B", IP_HOST, "/"), ("C", "icanhazip.com", "/"))
DO_IP_VONG = 6
DO_IP_GIAY = 12


def _lenh_hoi_ip():
    """MOT lenh shell hoi ca ba dich vu song song; moi dong ra mang tien to "A|" / "B|" / "C|"."""
    # `sleep` giu stdin mo: `toybox nc` dong ket noi ngay khi stdin het, truoc khi kip nhan tra loi.
    phan = [f'((printf "GET {duong} HTTP/1.0\\r\\nHost: {host}\\r\\n\\r\\n"; sleep 6) '
            f'| toybox timeout {DO_IP_GIAY} toybox nc -w 10 {host} 80 | tail -2 | toybox sed "s/^/{nhan}|/") &'
            for nhan, host, duong in DO_IP]
    return " ".join(phan) + " wait"


def doc_hoi_ip(tra_loi):
    """Tra loi cua `_lenh_hoi_ip` -> (ip, nuoc). Uu tien ip-api (co nuoc); khong co thi IP cua ipify /
    icanhazip, nuoc rong. Khong co gi -> ("", "")."""
    theo = {}
    for dong in (tra_loi or "").splitlines():
        nhan, _, gt = dong.partition("|")
        if gt.strip():
            theo.setdefault(nhan.strip(), []).append(gt.strip())
    ip, nuoc = doc_ip_nuoc("\n".join(theo.get("A", [])))
    if ip:
        return ip, nuoc
    for nhan in ("B", "C"):
        dong = theo.get(nhan, [])
        if dong and ip_hop_le(dong[-1]):
            return dong[-1], ""
    return "", ""


def ip_dien_thoai(serial, lan=DO_IP_VONG):
    """IP cong khai do TREN DIEN THOAI (khong can nuoc). Rong = khong ra duoc Internet."""
    return do_ip_nuoc(serial, lan)[0]


def doc_ip_nuoc(tra_loi):
    """Hai dong cuoi cua ip-api (`/line/?fields=countryCode,query`): "US\\n203.0.113.10" ->
    ("203.0.113.10", "US"). Tra loi rac / cut -> ("", "")."""
    dong = [x.strip() for x in (tra_loi or "").splitlines() if x.strip()]
    if len(dong) >= 2 and re.fullmatch(r"[A-Z]{2}", dong[-2]) and ip_hop_le(dong[-1]):
        return dong[-1], dong[-2]
    return "", ""


def do_ip_nuoc(serial, lan=DO_IP_VONG):
    """(ip, nuoc) do TREN DIEN THOAI, qua `adb shell` — di qua VPN nhu moi app, nen la IP ma TikTok
    dang dung. Moi vong hoi song song ip-api (co nuoc) / ipify / icanhazip; dung o vong duoc dau tien.
    Khong do duoc gi -> ("", "")."""
    for i in range(lan):
        try:
            tra_loi = adb("shell", _lenh_hoi_ip(), serial=serial, timeout=DO_IP_GIAY + 15) or ""
        except Exception:
            tra_loi = ""
        ip, nuoc = doc_hoi_ip(tra_loi)
        if ip:
            return ip, nuoc
        if i < lan - 1:
            time.sleep(2)
    return "", ""


def ip_viet_nam(ip, nuoc):
    """Day co phai IP that cua farm (Viet Nam) khong. Xet theo NUOC truoc: khong phu thuoc may tinh —
    may tinh cua chu du an co cai Cloudflare WARP, bat len thi IP may tinh khac IP farm va phep so
    `ip == ip_may_tinh()` se cho qua sai. Chi khi ip-api khong tra nuoc moi so voi IP may tinh."""
    if nuoc:
        return nuoc == "VN"
    that = ip_may_tinh()
    return bool(ip and that and ip == that)


def vpn_dang_bat(serial):
    """VPN cua College Proxy dang song khong — giao dien `tun0` chi co khi VPN bat. Mot lenh adb,
    khong mo giao dien, nen goi dinh ky giua ca duoc."""
    try:
        return "tun0" in adb("shell", "ls", "/sys/class/net", serial=serial, timeout=15).split()
    except Exception:
        return False


def co_college_proxy(serial):
    """May co cai College Proxy (ten hien thi "Lalasoft Proxy -congnv fix") khong. Do 2026-09-23:
    ca 18 may USB co; 20 may mang dung proxy GenFarmer va KHONG co — chu du an chot khong dung vao
    may mang. Tra None khi chua hoi duoc (adb loi) de noi goi hoi lai, khong doan la "khong co"."""
    try:
        out = adb("shell", "pm", "list", "packages", PKG, serial=serial, timeout=15)
    except Exception:
        return None
    return ("package:" + PKG) in out.split()


# ── Go chu vao o nhap ──
#
# ⚠ KHONG dung `set_text` cua uiautomator2, va KHONG dung `send_keys`:
#   - `set_text` bam vao o truoc; may nam ngang thi ban phim 效卫 bung TOAN MAN HINH, o nhap bien
#     mat khoi cay giao dien va lenh hong `UiObjectNotFoundException` (do tren may 60).
#   - `send_keys` DOI ban phim mac dinh cua may sang ban phim cua uiautomator2 va khong tra lai —
#     pha tinh nang gui chu cua 效卫.
# Nen: cham vao o, xoa bang phim, go bang `input text`, roi bam Back cho ban phim cup xuong.

def _ban_phim_dang_hien(serial):
    try:
        return "mInputShown=true" in adb("shell", "dumpsys", "input_method", serial=serial, timeout=15)
    except Exception:
        return False


def _an_ban_phim(d, serial):
    for _ in range(3):
        if not _ban_phim_dang_hien(serial):
            return
        d.press("back")
        time.sleep(0.8)


def chuoi_input_text(s):
    """Boc gia tri cho `adb shell input text`: dau cach -> %s (quy uoc cua `input`), roi boc
    nhay don cho shell tren dien thoai khong hieu nham ky tu dac biet trong mat khau."""
    return "'" + s.replace(" ", "%s").replace("'", "'\\''") + "'"


def _dien_o(d, serial, rid, gia_tri):
    _an_ban_phim(d, serial)
    o = d(resourceId=rid)
    if not o.wait(timeout=5):
        raise ProxyHong("không thấy ô nhập của College Proxy (app đổi giao diện?)")
    # Xoa DUNG so ky tu dang co: 64 lan DEL ton ~5 giay moi o (do tren may 60). O mat khau doc lai
    # khong tin duoc (o an) nen van xoa 64.
    cu = None if rid == O_MAT_KHAU else _doc_o(d, rid)
    xoa = 64 if cu is None else len(cu)
    o.click()
    time.sleep(0.8)
    if xoa:
        adb("shell", "input", "keyevent", "KEYCODE_MOVE_END", *(["KEYCODE_DEL"] * (xoa + 2)), serial=serial, timeout=30)
    if gia_tri:
        adb("shell", "input", "text", chuoi_input_text(gia_tri), serial=serial, timeout=30)
    time.sleep(0.4)


# ── Gan proxy ──
#
# ⚠ GIAO DIEN COLLEGE PROXY KHONG ON DINH (do tren may 60, 2026-09-23): app TU chong them man
# `LoadingActivity` ("Loading...") len tren man chinh, ke ca khi khong ai dung vao. Task cua no
# phinh toi 34 man; `app_start` khi app dang song lai chong them mot man nua, va cac o nhap bien mat
# khoi cay giao dien hang chuc giay. Nen:
#   - DUONG NHANH khong mo giao dien (xem `dam_bao_proxy`);
#   - DUONG DAY DU luon khoi dong SACH (force-stop roi mo lai) va CHO toi khi o nhap hien ra that.

CHO_MAN_CHINH = 40      # giay: mo sach do duoc 7-25 giay moi vao man chinh


def _dang_ket_noi(d):
    # MOT lenh RPC. Ban dau la `exists` roi `get_text` — hai lenh, va giua chung giao dien ve lai
    # (hoac ban phim toan man hinh con bung) thi lenh sau no `StaleObjectException` /
    # `NullPointerException` (do that tren may 60).
    try:
        return bool(d(resourceId=NUT, textStartsWith="STOP").exists)
    except Exception:
        return False


def _co(d, **k):
    try:
        return bool(d(**k).exists)
    except Exception:
        return False


def _doc_o(d, rid):
    """Chu trong mot o nhap; khong thay / doc hong -> None, NGAY. (`get_text` mac dinh cho toi 20
    giay khi o vang mat — do duoc 6-21 giay moi lan doc luc app ket o man Loading.)"""
    for _ in range(3):
        try:
            o = d(resourceId=rid)
            if not o.exists:
                return None
            return o.get_text(timeout=2) or ""
        except Exception:
            time.sleep(0.5)
    return None


def _mo_app_sach(d, serial, xoa_du_lieu=False):
    """Tat han College Proxy (VPN tat theo) roi mo lai, cho toi khi man chinh hien that.

    `xoa_du_lieu`: `pm clear` truoc khi mo. Do tren may 60: app tung roi vao vong lap tu de
    `LoadingActivity` (13 -> 8 -> 21 lop trong 10 giay, bam Back khong go kip), ke ca sau khi
    force-stop; `pm clear` chua duoc ngay. Du lieu cua app chi la 4 o proxy va danh sach "Direct
    Apps" — app tu nhap lai o ngay sau day.
    """
    if xoa_du_lieu:
        adb("shell", "pm", "clear", PKG, serial=serial, timeout=30)
    d.app_start(PKG, stop=True)
    han = time.time() + CHO_MAN_CHINH
    while time.time() < han:
        if _co(d, resourceId=O_DIA_CHI) and not _co(d, text="Loading..."):
            _an_ban_phim(d, serial)
            return
        time.sleep(0.5)
    raise ProxyHong(f"College Proxy không vào được màn hình chính sau {CHO_MAN_CHINH} giây "
                    "(kẹt ở màn Loading, hoặc chưa cài app)")


def _khop(d, p):
    """Cac o dang ghi dung proxy nay chua. Mat khau khong doc lai duoc (o an) nen khong so."""
    return (_doc_o(d, O_DIA_CHI) == p["host"]
            and _doc_o(d, O_CONG) == p["port"]
            and _doc_o(d, O_TEN) == p["user"])


def _go_proxy(d, serial, p):
    """Go du 4 o roi DOC LAI (tru o mat khau — o an, khong doc duoc). App phai dang o man chinh."""
    for rid, gt in ((O_DIA_CHI, p["host"]), (O_CONG, p["port"]), (O_TEN, p["user"]), (O_MAT_KHAU, p["pass"])):
        _dien_o(d, serial, rid, gt)
    _an_ban_phim(d, serial)
    if not _khop(d, p):
        raise ProxyHong("gõ proxy vào College Proxy không khớp (bàn phím nuốt ký tự, hoặc app chen màn Loading)")


def gan_proxy(d, serial, p, log, xoa_du_lieu=False):
    """Nhap proxy vao College Proxy va bat VPN. Khong do IP — viec do cua `dam_bao_proxy`.

    Mo SACH nen VPN cu (neu co) da tat: noi goi PHAI tat TikTok truoc, khong thi TikTok chay vai
    giay bang IP that (setup_device da `kill_all_apps` truoc khi goi toi day).
    """
    _mo_app_sach(d, serial, xoa_du_lieu)
    _go_proxy(d, serial, p)
    _bat_vpn(d, serial, log)


def _bat_vpn(d, serial, log):
    """Bam START, dong y quyen VPN lan dau, cho `tun0`. Dung chung cho `gan_proxy` (vua go proxy vao)
    va `dam_bao_proxy_san_co` (proxy nam san trong app tren may, khong go gi)."""
    d(resourceId=NUT).click()
    if d(resourceId=NUT_DONG_Y_VPN).wait(timeout=5):
        log("Android hỏi quyền VPN lần đầu trên máy này — đã bấm đồng ý.")
        d(resourceId=NUT_DONG_Y_VPN).click()
    # `tun0` la bang chung, khong phai chu tren nut: man Loading co the che mat nut bat cu luc nao.
    han = time.time() + 15
    while time.time() < han:
        if vpn_dang_bat(serial):
            return
        time.sleep(1)
    raise ProxyHong("College Proxy không bật được VPN sau 15 giây")


# ── Dau "da gan proxy nao" ──
# Luu tren MAY TINH (thu muc rieng cua may, runner truyen duong dan qua PROXY_MOC), khong doc tu
# giao dien College Proxy. Chi luu MA BAM cua chuoi proxy, khong luu mat khau.

def _dau(chuoi):
    import hashlib
    return hashlib.sha256(chuoi.strip().encode("utf-8")).hexdigest()


def _doc_moc(moc):
    try:
        with open(moc, encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def _ghi_moc(moc, gia_tri):
    if not moc:
        return
    try:
        if gia_tri:
            with open(moc, "w", encoding="utf-8") as f:
                f.write(gia_tri)
        elif os.path.exists(moc):
            os.remove(moc)
    except Exception:
        pass


def dam_bao_proxy(d, serial, chuoi, log, emit=lambda *a, **k: None, moc="", truoc_khi_gan=None):
    """May phai dang ra Internet QUA proxy `chuoi`. Tra IP proxy; hong thi nem `ProxyHong`.

    ⚠ CHI GO PROXY VAO LALASOFT KHI TRONG DO CHUA CO DUNG PROXY NAY (sua 2026-09-28).
    Chu du an: "moi lan click vao Chay la no lai phai dien lai proxy mac du toi da thay proxy dang
    start roi", va "neu no hien status proxy hong thi moi lan dang nhap hay an Chay la no lai dien
    lai proxy trong Lalasoft". Ban cu chi tin TEP DAU; khong co dau (nguoi dung tu bat Lalasoft, hoac
    dau bi xoa) la force-stop + go lai. Va MOI lan hong — ke ca hong thoang qua cua dich vu do IP —
    no XOA dau, nen tu do moi luot deu go lai; proxy chet that thi con `pm clear` + go lai o lan 2,
    moi luot, du go lai cung mot chuoi khong chua duoc gi. Gio:
      1. VPN dang bat va ra mang qua proxy: dau khop, HOAC IP ra dung IP cua proxy -> khong dung gi.
      2. Can bat lai: mo sach Lalasoft, cac o DA DUNG proxy nay -> chi bam START, khong go.
      3. Chi go khi o khac proxy nay (gan proxy moi / Lalasoft bi xoa du lieu).
      4. `ProxyChet` (Lalasoft da chay dung proxy ma khong ra mang) khi chuoi nay chac chan dang nam
         trong Lalasoft (chinh app go, dau khop) -> dung, bao proxy chet; KHONG go lai, KHONG xoa dau.
    Tep dau = "Lalasoft dang giu DUNG chuoi nay (ca mat khau) do chinh app go" — ghi ngay sau khi go
    xong, khong phai "proxy dang chay tot". Chi xoa khi khong con chac Lalasoft dang giu gi.
    Proxy duoc GIU BAT khi dung (chu du an chot 2026-09-23).
    """
    p = doc_proxy(chuoi)
    if not p:
        raise ProxyHong("proxy sai dạng — cần host:port:user:pass")
    dau = _dau(chuoi)
    da_go_dung = bool(moc) and _doc_moc(moc) == dau
    try:
        ip = ""
        if vpn_dang_bat(serial):
            try:
                ip = _kiem_ip(serial, p["host"])
            except ProxyHong as e:
                log(f"⚠ Lalasoft đang bật nhưng {e} — bật lại.")
            if ip and not (da_go_dung or ip == p["host"]):
                log(f"Lalasoft đang chạy (IP {ip}) nhưng app chưa chắc nó giữ proxy {mo_ta(p)} — mở Lalasoft xem ô proxy.")
                ip = ""
            elif ip and not da_go_dung:
                # Ra DUNG IP cua proxy nay: Lalasoft dang giu no (vd nguoi dung tu nhap, tu bat).
                _ghi_moc(moc, dau)
        if not ip:
            # Mo Lalasoft = force-stop = VPN tat vai chuc giay. TikTok dang mo luc do la chay bang IP
            # that — noi goi truyen ham tat TikTok vao day.
            if truoc_khi_gan:
                truoc_khi_gan()
            ip = _bat_lai_hoac_go(d, serial, p, dau, moc, da_go_dung, log)
    except ProxyHong as e:
        emit("proxy", ok=False, msg=str(e))
        raise
    except Exception as e:
        _ghi_moc(moc, "")
        emit("proxy", ok=False, msg=f"lỗi khi gắn proxy: {str(e)[:120]}")
        raise ProxyHong(f"lỗi khi gắn proxy: {str(e)[:120]}")
    log(f"🌐 Proxy {mo_ta(p)} đang chạy — IP của máy: {ip}.")
    emit("proxy", ok=True, ip=ip)
    return ip


def _bat_lai_hoac_go(d, serial, p, dau, moc, da_go_dung, log):
    """Mo sach Lalasoft; o da dung proxy -> chi bat VPN, khong thi go. Do IP. Toi da hai lan:
      - loi giao dien (man Loading, go khong khop, VPN khong len) -> lan 2 `pm clear` roi go;
      - `ProxyChet` khi o khop host/port/user nhung mat khau chua chac (khong phai app go) -> lan 2
        go lai du 4 o, KHONG `pm clear`;
      - `ProxyChet` khi chuoi nay chac chan dang nam trong Lalasoft (app vua go, hoac dau khop) ->
        dung ngay: proxy chet that, go lai khong chua duoc.
    """
    xoa_du_lieu = False
    go_lai = False
    for lan in (1, 2):
        vua_go = False
        try:
            if xoa_du_lieu:
                _ghi_moc(moc, "")          # pm clear = Lalasoft trong tron
            _mo_app_sach(d, serial, xoa_du_lieu)
            if not go_lai and _khop(d, p):
                log(f"Lalasoft đã có sẵn đúng proxy {mo_ta(p)} — chỉ bật lại, KHÔNG gõ lại.")
            else:
                log(f"Đang gõ proxy {mo_ta(p)} vào Lalasoft (College Proxy)…")
                _ghi_moc(moc, "")
                _go_proxy(d, serial, p)
                _ghi_moc(moc, dau)
                vua_go = True
            _bat_vpn(d, serial, log)
            ip = _kiem_ip(serial, p["host"])
            # Ra mang bang cac o dang co -> Lalasoft dang giu proxy nay: lan sau di duong nhanh.
            _ghi_moc(moc, dau)
            return ip
        except ProxyChet as e:
            if vua_go or da_go_dung or lan == 2:
                raise ProxyChet(f"{e} — Lalasoft đang giữ đúng proxy này nên KHÔNG gõ lại; đổi proxy khác cho máy")
            go_lai = True
            log(f"⚠ Bật lại bằng proxy có sẵn trong Lalasoft mà {e} — gõ lại đủ 4 ô (mật khẩu có thể khác).")
        except ProxyHong as e:
            if lan == 2:
                _ghi_moc(moc, "")
                raise
            xoa_du_lieu = True
            log(f"⚠ Gắn proxy lần 1 hỏng ({e}) — xoá dữ liệu College Proxy, thử lần 2.")


def _kiem_ip(serial, host=""):
    """IP do tren dien thoai phai la IP proxy: ra duoc Internet, va KHONG phai IP Viet Nam cua farm.

    Xet theo NUOC (ip-api) truoc, nhu `dam_bao_proxy_san_co`: may tinh cua chu du an co Cloudflare
    WARP, va may tinh doc IP hong la ban cu bao "proxy hong" oan -> go lai proxy. Khong co nuoc thi:
    ra dung IP cua proxy la dat; con lai moi so voi IP may tinh.
    """
    ip, nuoc = do_ip_nuoc(serial)
    if not ip:
        raise ProxyChet("máy KHÔNG ra được Internet qua proxy — proxy chết, sai mật khẩu, "
                        "hoặc đang dùng cổng SOCKS5 (College Proxy chỉ chạy HTTP)")
    if nuoc:
        if nuoc == "VN":
            raise ProxyChet(f"máy vẫn ra IP Việt Nam {ip} — proxy không có tác dụng")
        return ip
    if host and ip == host:
        return ip
    that = ip_may_tinh()
    if not that:
        # ProxyChet chu khong phai ProxyHong: day la "khong kiem duoc", KHONG phai loi giao dien —
        # khong duoc dan toi `pm clear` + go lai (xem `_bat_lai_hoac_go`).
        raise ProxyChet("không đọc được nước của IP lẫn IP thật của máy tính để so — không chắc proxy đã che IP")
    if ip == that:
        raise ProxyChet(f"máy vẫn ra IP thật {that} — proxy không có tác dụng")
    return ip


# ── Proxy CO SAN tren may (2026-09-23) ──
# 18 may USB da nhap proxy san trong Lalasoft (College Proxy) bang tay, chua may nao duoc gan proxy
# trong app. Toi v0.1.18, `kill_all_apps` force-stop ca College Proxy o dau MOI luot -> VPN tat,
# TikTok quet bang IP that. Do luc 17:4x: 6/7 may USB dang quet ra IP Viet Nam 198.51.100.20.
# v0.1.19 thoi tat, nhung khong ai BAT LAI; may khoi dong lai (tay, hoac tu khoi dong lai may do)
# thi VPN cung khong tu bat. Ham nay bat lai bang DUNG proxy dang luu tren may — khong go gi — roi do
# NUOC cua IP. Chu du an: "stop thi o IP Viet Nam, bat thi o IP US".

CHUA_NHAP_PROXY = ("Lalasoft trên máy chưa nhập proxy — nhập tay trên máy, hoặc gán proxy cho máy "
                   "trong app (🌐 Proxy đã chọn)")


def _bao_ok(log, emit, ip, nuoc, viec=""):
    if ip:
        log(f"🌐 {viec + ' — ' if viec else ''}Lalasoft đang chạy, máy ra IP {nuoc or '?'} {ip}.")
    else:
        log(f"⚠ {viec + ' — ' if viec else ''}Lalasoft đang chạy nhưng không đo được IP của máy "
            "(dịch vụ đo IP không trả lời) — vẫn quét.")
    emit("proxy", ok=True, ip=ip, nuoc=nuoc, msg="" if ip else "không đo được IP")
    return ip, nuoc


def _bat_lai_san_co(d, serial, log):
    """Mo sach College Proxy va bat VPN bang proxy DANG LUU trong app. Tra (ip, nuoc)."""
    _mo_app_sach(d, serial)
    dia_chi, cong = _doc_o(d, O_DIA_CHI), _doc_o(d, O_CONG)
    if dia_chi is None or cong is None:
        raise ProxyHong("không đọc được ô proxy của Lalasoft (app chen màn Loading?)")
    if not dia_chi.strip() or not cong.strip():
        raise ProxyHong(CHUA_NHAP_PROXY)
    log(f"Bật Lalasoft bằng proxy đang lưu trên máy ({dia_chi.strip()}:{cong.strip()})…")
    _bat_vpn(d, serial, log)
    ip, nuoc = do_ip_nuoc(serial)
    if ip and ip_viet_nam(ip, nuoc):
        raise ProxyHong(f"đã bật Lalasoft mà máy vẫn ra IP Việt Nam ({ip}) — proxy lưu trên máy hỏng hoặc hết hạn")
    return ip, nuoc


def dam_bao_proxy_san_co(d, serial, log, emit=lambda *a, **k: None):
    """Lalasoft (College Proxy) phai dang bat va may KHONG ra IP Viet Nam. Tra (ip, nuoc).

    Chi CHAN (nem `ProxyHong`) khi co bang chung: o proxy trong, khong bat duoc VPN, hoac do ra IP
    Viet Nam. Dich vu do IP chet ma `tun0` da co thi cho quet kem canh bao — mot dich vu ben ngoai
    chet khong duoc lam dung ca farm.
    ⚠ KHONG BAO GIO `pm clear` (khac `dam_bao_proxy`): xoa du lieu app la xoa mat proxy nguoi dung
    da nhap tay tren may, va app khong co chuoi proxy nao de nhap lai.
    Noi goi PHAI tat TikTok truoc: bat lai = force-stop College Proxy truoc da.
    """
    try:
        if vpn_dang_bat(serial):
            ip, nuoc = do_ip_nuoc(serial)
            if not ip or not ip_viet_nam(ip, nuoc):
                return _bao_ok(log, emit, ip, nuoc)
            log(f"⛔ Lalasoft đang bật mà máy vẫn ra IP Việt Nam ({ip}) — bật lại từ đầu.")
        else:
            log("⛔ Lalasoft (College Proxy) đang TẮT — máy sẽ ra IP Việt Nam. Bật lại trước khi mở TikTok…")
        for lan in (1, 2):
            try:
                ip, nuoc = _bat_lai_san_co(d, serial, log)
                return _bao_ok(log, emit, ip, nuoc, "Đã bật lại Lalasoft")
            except ProxyHong as e:
                # O trong thi thu lai cung vo ich; con lai (man Loading, VPN cham len) thi thu MOT lan.
                if lan == 2 or str(e) == CHUA_NHAP_PROXY:
                    raise
                log(f"⚠ Bật Lalasoft lần 1 hỏng ({e}) — thử lại một lần.")
    except ProxyHong as e:
        emit("proxy", ok=False, msg=str(e))
        raise
    except Exception as e:
        emit("proxy", ok=False, msg=f"lỗi khi bật Lalasoft: {str(e)[:120]}")
        raise ProxyHong(f"lỗi khi bật Lalasoft: {str(e)[:120]}")


# ── Chay rieng, ngoai luot quet (2026-09-23) ──
# Chu du an: "khi toi LUU proxy thi may do da phai nhan proxy toi setup roi" — khong cho toi luc bam
# Chay. main.js goi `python college_proxy.py <serial> gan|tat` cho tung may DANG RANH (may dang
# chay thi tien trinh quet dang giu man hinh, gan o luot sau). Proxy + tep dau di qua bien moi
# truong PROXY / PROXY_MOC y nhu luot quet; ket qua ve bang dong @@EVENT@@ nhu scan_feed_sounds.py.

GOI_TIKTOK = ("com.zhiliaoapp.musically", "com.ss.android.ugc.trill")


def _su_kien(loai, **k):
    import json
    print("@@EVENT@@" + json.dumps({"type": loai, **k}, ensure_ascii=False), flush=True)


def tat_proxy(serial, moc, log):
    """Tat College Proxy tren may (VPN tat theo) va xoa dau. Tra True neu VPN da tat that."""
    adb("shell", "am", "force-stop", PKG, serial=serial, timeout=20)
    _ghi_moc(moc, "")
    for _ in range(10):
        if not vpn_dang_bat(serial):
            log("Đã tắt College Proxy — máy dùng mạng thật.")
            return True
        time.sleep(1)
    return False


def _chinh(argv):
    import os
    import sys
    from adb_helper import connect
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if len(argv) < 3 or argv[2] not in ("gan", "tat"):
        print("Dùng: python college_proxy.py <serial> gan|tat", flush=True)
        return 2
    serial, viec = argv[1], argv[2]
    moc = os.environ.get("PROXY_MOC", "")
    log = lambda m: print(m, flush=True)
    try:
        if viec == "tat":
            ok = tat_proxy(serial, moc, log)
            _su_kien("proxy", ok=ok, tat=True, msg="" if ok else "VPN vẫn bật sau khi tắt College Proxy")
            return 0 if ok else 1

        def tat_tiktok():
            for goi in GOI_TIKTOK:
                try:
                    adb("shell", "am", "force-stop", goi, serial=serial, timeout=15)
                except Exception:
                    pass
        d = connect(serial)
        dam_bao_proxy(d, serial, os.environ.get("PROXY", ""), log, _su_kien, moc=moc, truoc_khi_gan=tat_tiktok)
        try:
            d.press("home")
        except Exception:
            pass
        return 0
    except ProxyHong as e:
        log(f"⛔ Proxy không chạy: {e}")
        return 1
    except Exception as e:
        log(f"⛔ Lỗi khi {'tắt' if viec == 'tat' else 'gắn'} proxy: {str(e)[:160]}")
        _su_kien("proxy", ok=False, msg=str(e)[:160])
        return 1


if __name__ == "__main__":
    import sys
    sys.exit(_chinh(sys.argv))
