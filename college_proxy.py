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


class ProxyHong(Exception):
    """Khong gan duoc proxy, hoac gan roi ma may van ra IP that. Noi goi phai DUNG."""


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
    mang: do ngay 2026-09-23, ca hai cung ra 118.68.96.56). Giu 10 phut."""
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


def ip_dien_thoai(serial, lan=3):
    """IP cong khai do TREN DIEN THOAI. Tien trinh `adb shell` cung di qua VPN nhu moi app, nen
    IP nay la IP ma TikTok dang dung. Rong = khong ra duoc Internet."""
    # `sleep` giu stdin mo: `toybox nc` dong ket noi ngay khi stdin het, truoc khi kip nhan tra loi.
    lenh = (f'(printf "GET / HTTP/1.0\\r\\nHost: {IP_HOST}\\r\\n\\r\\n"; sleep 5) '
            f'| toybox nc -w 8 {IP_HOST} 80 | tail -1')
    for i in range(lan):
        try:
            ip = adb("shell", lenh, serial=serial, timeout=25).strip()
            if ip_hop_le(ip):
                return ip
        except Exception:
            pass
        if i < lan - 1:
            time.sleep(2)
    return ""


def vpn_dang_bat(serial):
    """VPN cua College Proxy dang song khong — giao dien `tun0` chi co khi VPN bat. Mot lenh adb,
    khong mo giao dien, nen goi dinh ky giua ca duoc."""
    try:
        return "tun0" in adb("shell", "ls", "/sys/class/net", serial=serial, timeout=15).split()
    except Exception:
        return False


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


def gan_proxy(d, serial, p, log, xoa_du_lieu=False):
    """Nhap proxy vao College Proxy va bat VPN. Khong do IP — viec do cua `dam_bao_proxy`.

    Mo SACH nen VPN cu (neu co) da tat: noi goi PHAI tat TikTok truoc, khong thi TikTok chay vai
    giay bang IP that (setup_device da `kill_all_apps` truoc khi goi toi day).
    """
    _mo_app_sach(d, serial, xoa_du_lieu)
    for rid, gt in ((O_DIA_CHI, p["host"]), (O_CONG, p["port"]), (O_TEN, p["user"]), (O_MAT_KHAU, p["pass"])):
        _dien_o(d, serial, rid, gt)
    _an_ban_phim(d, serial)
    if not _khop(d, p):
        raise ProxyHong("gõ proxy vào College Proxy không khớp (bàn phím nuốt ký tự, hoặc app chen màn Loading)")
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


def dam_bao_proxy(d, serial, chuoi, log, emit=lambda *a, **k: None, moc=""):
    """May phai dang ra Internet QUA proxy `chuoi`. Tra IP proxy; hong thi nem `ProxyHong`.

    DUONG NHANH (moi lan chay, moi lan phuc hoi): VPN dang bat + dau tren may tinh khop proxy nay
    -> chi do IP, KHONG mo College Proxy. DUONG DAY DU: mo sach, nhap, bat, do IP; hong thi thu
    them MOT lan tu dau (giao dien app chap chon, xem tren).
    Proxy duoc GIU BAT khi dung (chu du an chot 2026-09-23): TikTok tren may luon mot IP, ke ca
    khi thao tac tay tren 效卫.
    ⚠ Dau chi biet LAN GAN CUOI app gan gi. Ai sua tay College Proxy sang proxy khac ma VPN van
    bat thi duong nhanh khong nhan ra — nhung phep do IP van chan duoc IP THAT.
    """
    p = doc_proxy(chuoi)
    if not p:
        raise ProxyHong("proxy sai dạng — cần host:port:user:pass")
    dau = _dau(chuoi)
    try:
        ip = ""
        if moc and _doc_moc(moc) == dau and vpn_dang_bat(serial):
            try:
                ip = _kiem_ip(serial)
            except ProxyHong as e:
                # Khong dung o day: dung thi lan chay sau lai di duong nhanh, lai hong — ket mai ma
                # khong bao gio thu gan lai.
                log(f"⚠ VPN đang bật nhưng {e} — gắn lại từ đầu.")
        if not ip:
            _ghi_moc(moc, "")
            log(f"Đang gắn proxy {mo_ta(p)} qua College Proxy…")
            for lan in (1, 2):
                try:
                    gan_proxy(d, serial, p, log, xoa_du_lieu=lan == 2)
                    ip = _kiem_ip(serial)
                    break
                except ProxyHong as e:
                    if lan == 2:
                        raise
                    log(f"⚠ Gắn proxy lần 1 hỏng ({e}) — xoá dữ liệu College Proxy, thử lần 2.")
            _ghi_moc(moc, dau)
    except ProxyHong as e:
        _ghi_moc(moc, "")
        emit("proxy", ok=False, msg=str(e))
        raise
    except Exception as e:
        _ghi_moc(moc, "")
        emit("proxy", ok=False, msg=f"lỗi khi gắn proxy: {str(e)[:120]}")
        raise ProxyHong(f"lỗi khi gắn proxy: {str(e)[:120]}")
    log(f"🌐 Proxy {mo_ta(p)} đang chạy — IP của máy: {ip}.")
    emit("proxy", ok=True, ip=ip)
    return ip


def _kiem_ip(serial):
    """IP do tren dien thoai phai la IP proxy: ra duoc Internet, va KHAC IP that cua farm."""
    ip = ip_dien_thoai(serial)
    that = ip_may_tinh()
    if not ip:
        raise ProxyHong("máy KHÔNG ra được Internet qua proxy — proxy chết, sai mật khẩu, "
                        "hoặc đang dùng cổng SOCKS5 (College Proxy chỉ chạy HTTP)")
    if not that:
        raise ProxyHong("không đọc được IP thật của máy tính để so — không chắc proxy đã che IP")
    if ip == that:
        raise ProxyHong(f"máy vẫn ra IP thật {that} — proxy không có tác dụng")
    return ip
