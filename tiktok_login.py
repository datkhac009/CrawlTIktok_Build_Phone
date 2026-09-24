"""tiktok_login.py — Đăng nhập TikTok trên MỘT điện thoại bằng username + mật khẩu (+ khoá 2FA).

VÌ SAO CÓ (2026-09-24)
======================
Chủ dự án: "Tiếp theo tôi muốn làm chức năng tự động đăng nhập vào tiktok". Các quyết định đã chốt:
  - Tài khoản dạng `user|pass|khoá2fa` (khoá 2FA là chuỗi base32 của app Authenticator; app tự sinh
    mã 6 số). Dán hàng loạt như proxy (src/account.cjs).
  - Đăng nhập khi bấm nút "Đăng nhập TikTok", KHÔNG tự chạy lúc lưu.
  - Gặp captcha / màn lạ: DỪNG CHỜ NGƯỜI giải tay trên xiaowei, thấy qua được thì đi tiếp.
    ⚠ Không có phần tự giải captcha — cố ý.
  - Máy đang đăng nhập tài khoản KHÁC: giữ nguyên, chỉ báo lệch. Không đăng xuất ai cả.

Máy có proxy thì GẮN PROXY TRƯỚC (college_proxy.dam_bao_proxy): đăng nhập từ IP thật của farm rồi
mới chuyển sang proxy là đúng loại dấu vết khiến TikTok khoá tài khoản.

ĐƯỜNG ĐI ĐO TRÊN MÁY 60 (SM-A920F, TikTok 47.0.2, chưa đăng nhập, 2026-09-24):
  0. máy MỚI CÀI TikTok (đo ô 62 = 52001c84c055c4bf, 2026-09-24): "Welcome to TikTok"
     → "Agree and continue" (máy 60 đã qua màn này từ trước nên lượt đầu không thấy)
  1. `NewUserJourneyActivity` "Choose what you like"   → bấm Skip
  2. feed có lớp "Swipe up for more"                    → lớp này NUỐT cú bấm; phải vuốt lên trước
  3. feed                                               → bấm tab Profile (content-desc "Profile")
  4. `I18nSignUpActivity`, ô số điện thoại              → "Continue with email / username"
  5. ô "Email or username" + nút "Log in"
  6. ô mật khẩu → Log in
  7. `CommonFlowActivity` "2-step verification" / "Authenticator app" → mã 6 số → Continue
  8. về feed; tấm quảng cáo "Create your TikTok avatar" → Back
  9. trang cá nhân của mình: "Profile menu" / "Profile views" / "Add bio" + @handle
  (Lượt thật đầu tiên: tài khoản có 2FA, đi qua proxy HTTP của máy, không gặp captcha.)
  ⚠ CHƯA ĐO: chữ báo sai mật khẩu / bị chặn.
⚠ resource-id của TikTok bị làm rối (`zn5`, `j1x`…) và đổi theo phiên bản: chỉ khớp theo CHỮ.

Chạy độc lập: `python tiktok_login.py <serial>` với TAI_KHOAN, TK_HANDLE, PROXY, PROXY_MOC trong biến
môi trường (src/loginrun.cjs truyền). Mật khẩu KHÔNG BAO GIỜ đi qua dòng lệnh hay ra log.
Kết quả về bằng dòng `@@EVENT@@{"type":"login",...}`.
"""
import base64
import hashlib
import hmac
import re
import struct
import time

import college_proxy as CP
from adb_helper import adb

PKG = "com.zhiliaoapp.musically"

CHO_NGUOI = 300        # giây: chờ người giải captcha / màn lạ trên xiaowei
HAN_TONG = 480         # giây: cả lượt đăng nhập (không tính lúc gắn proxy)
LAM_LAI_TOI_DA = 3     # cùng một bước làm lại quá chừng này lần là kẹt (vd sai mật khẩu)
CHO_CHUYEN = 12        # giây: vừa điền + bấm xong thì chờ màn đó biến mất rồi mới điền lại
SAU_2FA = 25           # giây: qua 2FA rồi thì màn tên / mật khẩu loé lên cũng không điền lại


class DangNhapHong(Exception):
    pass


# ── Đọc chuỗi tài khoản ──
# PHẢI khớp `docTaiKhoan` bên src/account.cjs (tests/login.test.cjs chạy cả hai trên cùng bộ chuỗi).
_RE_B32 = re.compile(r"^[A-Z2-7]+=*$")


def doc_tai_khoan(chuoi):
    """`user|pass|khoá2fa` hoặc `user|pass` (dấu `:` thay `|` cũng được khi dòng không có `|`).
    Trả {user, pass, khoa} hoặc None. Khoá 2FA bỏ dấu cách, viết hoa, phải là base32."""
    s = str(chuoi or "").strip()
    if not s:
        return None
    phan = [x.strip() for x in s.split("|" if "|" in s else ":")]
    if len(phan) not in (2, 3):
        return None
    user = phan[0].lstrip("@")
    mk = phan[1]
    khoa = re.sub(r"\s+", "", phan[2]).upper() if len(phan) == 3 else ""
    if not user or re.search(r"\s", user) or not mk:
        return None
    if khoa and (len(khoa) < 16 or not _RE_B32.match(khoa)):
        return None
    return {"user": user, "pass": mk, "khoa": khoa}


def mo_ta(tk):
    """Chữ hiện ra log / bảng: KHÔNG BAO GIỜ có mật khẩu hay khoá."""
    if not tk:
        return ""
    return tk["user"] if "@" in tk["user"] else "@" + tk["user"]


def ma_totp(khoa, luc=None):
    """Mã 6 số RFC 6238 (SHA1, bước 30 giây) — đúng thứ app Authenticator hiện."""
    k = base64.b32decode(khoa + "=" * (-len(khoa) % 8))
    c = int((time.time() if luc is None else luc) // 30)
    h = hmac.new(k, struct.pack(">Q", c), hashlib.sha1).digest()
    o = h[-1] & 15
    return "%06d" % ((struct.unpack(">I", h[o:o + 4])[0] & 0x7FFFFFFF) % 1000000)


# ── Nhận diện màn hình (hàm THUẦN trên XML — thử được bằng bản chụp trong tests/fixtures) ──

def _nodes(xml):
    out = []
    for n in re.findall(r"<node [^>]*>", xml or ""):
        g = lambda a: (re.search(r' %s="([^"]*)"' % a, n) or [None, ""])[1]
        out.append({
            "text": g("text"), "desc": g("content-desc"), "rid": g("resource-id").split("/")[-1],
            "cls": g("class"), "pw": g("password") == "true", "pkg": g("package"),
            "bounds": g("bounds"),
        })
    return [x for x in out if x["pkg"] != "com.android.systemui"]


_RE_HANDLE = re.compile(r"^@[A-Za-z0-9._]{1,30}$")
# Màn 2FA ĐÃ ĐO (máy 60, 2026-09-24, `CommonFlowActivity`): "2-step verification" / "Authenticator
# app" / một ô nhập / nút "Continue". ⚠ CHƯA ĐO: chữ báo sai mật khẩu / bị chặn — mẫu dưới là đoán.
_RE_2FA = re.compile(r"(?i)(2-step verification|authenticator app|enter (the )?6-digit code)")
_RE_SAI_MK = re.compile(r"(?i)(incorrect (account or )?password|wrong password|account doesn.t exist)")
_RE_KHOA = re.compile(r"(?i)(too many attempts|maximum number of attempts|account (was |has been )?banned|suspended)")
# Trang cá nhân CỦA MÌNH (đo máy 60 sau khi đăng nhập): KHÔNG có "Edit profile" như nhiều bản khác, mà
# có "Profile menu", "Profile views", "Add bio". Trang người khác không có mấy thứ này (có Follow).
_DAU_HO_SO_MINH = ("Profile menu", "Profile views", "Add bio", "Edit profile")
# Tấm quảng cáo TikTok chèn ngay sau lần đăng nhập đầu — Back là tắt (đo máy 60). Tự đóng, không bắt
# người phải ngồi giải.
_QUANG_CAO = ("Create your TikTok avatar",
              # Tấm "Viewer history turned on" hiện ngay sau khi đăng nhập (đo ô 62, 2026-09-24).
              # Back = đóng mà KHÔNG đổi cài đặt; bấm "Save" mới là chấp nhận.
              "Viewer history turned on")


def menu_nguon_dang_mo(serial):
    """Menu nguồn Samsung ("Phone options": Power off / Restart / Emergency mode) đang đè lên màn?

    ⚠ ĐO Ô 62 (52001c84c055c4bf, 2026-09-24): máy TỰ bật menu này nhiều lần, không ai bấm — lúc mở
    YouTube, rồi hai lần giữa lượt đăng nhập (nghi nút nguồn kẹt). Menu nằm ngoài TikTok nên bản
    dump không có chữ nào, và bản đầu coi đó là "màn lạ — chờ người". Chỉ `dumpsys window` thấy nó.
    """
    try:
        out = adb("shell", "dumpsys", "window", "windows", serial=serial, timeout=15)
    except Exception:
        return False
    return any("mCurrentFocus" in l and "Phone options" in l for l in out.splitlines())


def nhan_dien(xml):
    """Trả (màn, chi_tiết). Màn: dong_y | so_thich | huong_dan_vuot | feed | chon_cach | o_ten | o_mat_khau |
    ma_2fa | ho_so_minh | sai_mk | bi_khoa | khac."""
    ns = _nodes(xml)
    chu = [x["text"] for x in ns if x["text"]] + [x["desc"] for x in ns if x["desc"]]
    tap = set(chu)
    rids = {x["rid"] for x in ns}
    o_nhap = [x for x in ns if x["cls"].endswith("EditText")]
    gop = " \n ".join(chu)

    if _RE_KHOA.search(gop):
        return "bi_khoa", next(c for c in chu if _RE_KHOA.search(c))[:120]
    if _RE_SAI_MK.search(gop):
        return "sai_mk", next(c for c in chu if _RE_SAI_MK.search(c))[:120]
    if "Agree and continue" in tap:
        return "dong_y", ""
    if "Choose what you like" in tap or ("Skip" in tap and any(c.startswith("Next (") for c in chu)):
        return "so_thich", ""
    if "tv_strengthen_swipe_up_guide" in rids or "Swipe up for more" in tap:
        return "huong_dan_vuot", ""
    if _RE_2FA.search(gop) and o_nhap:
        return "ma_2fa", ""
    if any(x["pw"] for x in o_nhap):
        return "o_mat_khau", ""
    # Ô tên: lúc trống hiện gợi ý "Email or username"; gõ rồi thì ô mang chính tên đó, và màn vẫn có
    # nút chuyển ngược "Continue with phone" (đo trên máy 60) — nên nhận theo cả hai dấu hiệu.
    if o_nhap and (any(x["text"] == "Email or username" for x in o_nhap) or "Continue with phone" in tap):
        return "o_ten", ""
    if "Continue with email / username" in tap:
        return "chon_cach", ""
    if any(c in tap for c in _QUANG_CAO):
        return "quang_cao", next(c for c in _QUANG_CAO if c in tap)
    if sum(c in tap for c in _DAU_HO_SO_MINH) >= 2:
        h = next((c for c in chu if _RE_HANDLE.match(c)), "")
        return "ho_so_minh", h
    if "long_press_layout" in rids and "Profile" in tap:
        return "feed", ""
    return "khac", " / ".join(c[:30] for c in chu[:6])


# ── Thao tác ──

def _xml(d):
    for _ in range(3):
        try:
            return d.dump_hierarchy()
        except Exception:
            time.sleep(0.8)
    return ""


def _vuot_len(d):
    # Kéo TỪNG ĐIỂM: `d.swipe()` bơm sự kiện quá thưa, TikTok không nhận (phone_actions._keo_doc).
    w, h = d.window_size()
    x, y1, y2 = w // 2, int(h * 0.7), int(h * 0.27)
    d.touch.down(x, y1)
    time.sleep(0.05)
    for i in range(1, 9):
        d.touch.move(x, int(y1 + (y2 - y1) * i / 8))
        time.sleep(0.03)
    d.touch.up(x, y2)


def _bam_chu(d, chu, timeout=3):
    for k in ({"text": chu}, {"description": chu}):
        o = d(**k)
        if o.exists(timeout=timeout if k.get("text") else 0.5):
            o.click()
            return True
    return False


def _go(d, serial, o, gia_tri, xoa):
    """Chạm ô, xoá, gõ bằng `adb shell input text` rồi cụp bàn phím — cách đã đo được ổn định với
    bàn phím xiaowei (college_proxy.py). ⚠ Không dùng send_keys: nó đổi bộ gõ mặc định của máy.
    `o` là nút đọc từ XML (`_o_nhap`): chạm theo toạ độ giữa ô."""
    d.click(*o["tam"])
    time.sleep(0.8)
    if xoa:
        adb("shell", "input", "keyevent", "KEYCODE_MOVE_END", *(["KEYCODE_DEL"] * (xoa + 2)), serial=serial, timeout=30)
    adb("shell", "input", "text", CP.chuoi_input_text(gia_tri), serial=serial, timeout=30)
    time.sleep(0.5)
    CP._an_ban_phim(d, serial)


def _o_nhap(d, mat_khau=False):
    """Ô nhập đầu tiên trên màn (ô mật khẩu nếu `mat_khau`), đọc thẳng từ XML, kèm toạ độ giữa ô.
    ⚠ Không dùng `d(className=..., password=True)`: uiautomator2 báo "password is not allowed" (đo
    trên máy 60, 2026-09-24 — lượt thử thật đầu tiên ngã đúng chỗ này)."""
    for x in _nodes(_xml(d)):
        if not x["cls"].endswith("EditText") or (mat_khau and not x["pw"]):
            continue
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", x["bounds"])
        if m:
            a, b, c, e = map(int, m.groups())
            x["tam"] = ((a + c) // 2, (b + e) // 2)
            return x
    return None


def _bam_dang_nhap(d):
    return _bam_chu(d, "Log in") or _bam_chu(d, "Next") or _bam_chu(d, "Continue")


def _ve_tiktok(d, serial):
    try:
        if d.app_current().get("package") != PKG:
            d.app_start(PKG)
            time.sleep(6)
    except Exception:
        adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1", serial=serial, timeout=20)
        time.sleep(6)


def _cung_tai_khoan(handle, tk, handle_cu):
    h = handle.lstrip("@").lower()
    if not h:
        return False
    if handle_cu and h == handle_cu.lstrip("@").lower():
        return True
    return "@" not in tk["user"] and h == tk["user"].lower()


def dang_nhap(d, serial, tk, log, emit, handle_cu=""):
    """Đưa TikTok trên máy về trạng thái ĐÃ ĐĂNG NHẬP `tk`. Trả dict kết quả:
      {ok, trangThai: 'xong'|'da_co'|'lech', handle}  — hoặc ném DangNhapHong.
    Đã đăng nhập ĐÚNG tài khoản → 'da_co', không làm gì. Tài khoản KHÁC → 'lech', không đụng vào.

    ⚠ CHỜ MÀN CHUYỂN SAU MỖI LẦN GÕ (đo máy 60, 2026-09-24): bấm Log in xong, màn cũ còn đứng vài
    giây trong lúc TikTok xử lý, và vòng lặp gõ lại tên lần nữa. Tệ hơn, ngay sau bước 2FA màn mật
    khẩu cũ loé lên và bản đầu GÕ LẠI MẬT KHẨU + bấm Log in — một lượt đăng nhập thứ hai chen vào.
    Nên: vừa điền xong màn nào thì chờ tối đa CHO_CHUYEN giây cho màn đó biến mất; qua bước 2FA
    rồi thì không quay lại điền tên / mật khẩu trong SAU_2FA giây."""
    _ve_tiktok(d, serial)
    het = time.time() + HAN_TONG
    da_go = {}                 # màn → số lần đã điền; quá LAM_LAI_TOI_DA là kẹt
    tu_dang_nhap = False       # chính lượt này đã điền mật khẩu → thấy trang cá nhân là của mình
    la_tu = None               # lúc bắt đầu thấy màn lạ
    da_bao_cho = False
    vua_dien = ("", 0.0)       # (màn vừa điền, lúc điền)
    luc_2fa = 0.0
    while time.time() < het:
        man, ct = nhan_dien(_xml(d))
        if man != "khac":
            la_tu = None
            if da_bao_cho:
                da_bao_cho = False
                log("▶ Đã qua màn cần người — đi tiếp.")
                emit("login", trangThai="dang")
        if man in ("o_ten", "o_mat_khau", "ma_2fa") and (
                (man == vua_dien[0] and time.time() - vua_dien[1] < CHO_CHUYEN)
                or (man != "ma_2fa" and luc_2fa and time.time() - luc_2fa < SAU_2FA)):
            time.sleep(1.5)
            continue
        if man in ("dong_y", "so_thich", "huong_dan_vuot", "feed", "chon_cach", "o_ten", "o_mat_khau", "ma_2fa", "quang_cao"):
            da_go[man] = da_go.get(man, 0) + 1
            if da_go[man] > LAM_LAI_TOI_DA + (6 if man in ("feed", "huong_dan_vuot") else 0):
                raise DangNhapHong("kẹt ở màn %s — xem màn hình máy trên xiaowei" % man)

        if man == "bi_khoa":
            raise DangNhapHong("TikTok chặn: " + ct)
        if man == "sai_mk":
            raise DangNhapHong("TikTok báo sai tài khoản/mật khẩu: " + ct)
        if man == "ho_so_minh":
            if not ct:
                time.sleep(1)
                continue
            if tu_dang_nhap or _cung_tai_khoan(ct, tk, handle_cu):
                return {"ok": True, "trangThai": "xong" if tu_dang_nhap else "da_co", "handle": ct}
            return {"ok": False, "trangThai": "lech", "handle": ct}
        if man == "quang_cao":
            log("Đóng quảng cáo của TikTok: %s" % ct)
            d.press("back")
        elif man == "dong_y":
            _bam_chu(d, "Agree and continue")
        elif man == "so_thich":
            _bam_chu(d, "Skip")
        elif man == "huong_dan_vuot":
            _vuot_len(d)
        elif man == "feed":
            _bam_chu(d, "Profile")
            time.sleep(1.5)
        elif man == "chon_cach":
            _bam_chu(d, "Continue with email / username")
        elif man == "o_ten":
            o = _o_nhap(d)
            if o:
                log("Điền tên đăng nhập %s" % mo_ta(tk))
                # Ô còn chữ của lần trước (lượt trước ngã giữa chừng) thì xoá đúng chừng ấy ký tự.
                cu = "" if o["text"] == "Email or username" else o["text"]
                _go(d, serial, o, tk["user"], xoa=len(cu))
                # Cùng màn có sẵn ô mật khẩu thì điền luôn; không thì bấm Log in / Next sang màn sau.
                if _o_nhap(d, mat_khau=True) is None:
                    _bam_dang_nhap(d)
                    vua_dien = (man, time.time())
        elif man == "o_mat_khau":
            o = _o_nhap(d, mat_khau=True)
            if o:
                log("Điền mật khẩu")
                _go(d, serial, o, tk["pass"], xoa=64)
                tu_dang_nhap = True
                _bam_dang_nhap(d)
                vua_dien = (man, time.time())
        elif man == "ma_2fa":
            if not tk["khoa"]:
                raise DangNhapHong("TikTok hỏi mã 2FA mà tài khoản không có khoá 2FA")
            # Còn dưới 5 giây là mã đổi: chờ mã mới, gõ mã sắp hết hạn là hỏng oan.
            con = 30 - time.time() % 30
            if con < 5:
                time.sleep(con + 0.5)
            o = _o_nhap(d)
            if o:
                log("Điền mã 2FA")
                _go(d, serial, o, ma_totp(tk["khoa"]), xoa=8)
                _bam_dang_nhap(d)
                vua_dien = (man, time.time())
                luc_2fa = time.time()
        else:
            # Màn lạ: captcha, xác minh email, cửa sổ hỏi quyền… → chờ người trên xiaowei.
            # Trừ menu nguồn tự bật: đóng bằng Back rồi đọc lại màn, không bắt người phải ngồi chờ.
            if menu_nguon_dang_mo(serial):
                log("Máy tự bật menu nguồn (Power off / Restart) — đóng bằng Back. Nếu lặp lại nhiều: kiểm tra nút nguồn.")
                d.press("back")
                time.sleep(1.5)
                continue
            if la_tu is None:
                la_tu = time.time()
            elif not da_bao_cho and time.time() - la_tu > 8:
                da_bao_cho = True
                log("⏳ Màn hình cần người xử lý (captcha / xác minh?) — giải tay trên xiaowei. Đang thấy: " + ct)
                emit("login", trangThai="cho_nguoi", msg=ct[:120])
                het = max(het, time.time() + CHO_NGUOI)
            elif da_bao_cho and time.time() - la_tu > CHO_NGUOI:
                raise DangNhapHong("chờ người giải quá %d phút — đang thấy: %s" % (CHO_NGUOI // 60, ct))
            time.sleep(2)
            continue
        time.sleep(2.5)
    raise DangNhapHong("quá %d phút chưa đăng nhập xong" % (HAN_TONG // 60))


def _su_kien(loai, **k):
    import json
    print("@@EVENT@@" + json.dumps({"type": loai, **k}, ensure_ascii=False), flush=True)


def _chinh(argv):
    import os
    import sys
    from adb_helper import connect
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if len(argv) < 2:
        print("Dùng: python tiktok_login.py <serial>   (TAI_KHOAN trong biến môi trường)", flush=True)
        return 2
    serial = argv[1]
    log = lambda m: print(m, flush=True)
    tk = doc_tai_khoan(os.environ.get("TAI_KHOAN", ""))
    if not tk:
        _su_kien("login", ok=False, trangThai="loi", msg="chưa có tài khoản hoặc sai dạng user|pass|2fa")
        return 1
    try:
        d = connect(serial)
        if os.environ.get("PROXY"):
            def tat_tiktok():
                adb("shell", "am", "force-stop", PKG, serial=serial, timeout=15)
            CP.dam_bao_proxy(d, serial, os.environ["PROXY"], log, _su_kien,
                             moc=os.environ.get("PROXY_MOC", ""), truoc_khi_gan=tat_tiktok)
        log("Đăng nhập TikTok bằng %s" % mo_ta(tk))
        kq = dang_nhap(d, serial, tk, log, _su_kien, handle_cu=os.environ.get("TK_HANDLE", ""))
        if kq["trangThai"] == "lech":
            log("⚠ Máy đang đăng nhập %s — khác tài khoản đã gán, giữ nguyên không đụng vào." % kq["handle"])
        elif kq["trangThai"] == "da_co":
            log("✓ Máy đã đăng nhập sẵn %s." % kq["handle"])
        else:
            log("✓ Đăng nhập xong: %s" % kq["handle"])
        _su_kien("login", **kq)
        return 0 if kq["ok"] else 1
    except CP.ProxyHong as e:
        log("⛔ Proxy không chạy — không đăng nhập bằng IP thật: %s" % e)
        _su_kien("login", ok=False, trangThai="loi", msg="proxy hỏng: %s" % str(e)[:140])
        return 1
    except DangNhapHong as e:
        log("⛔ Đăng nhập hỏng: %s" % e)
        _su_kien("login", ok=False, trangThai="loi", msg=str(e)[:160])
        return 1
    except Exception as e:
        log("⛔ Lỗi khi đăng nhập: %s" % str(e)[:160])
        _su_kien("login", ok=False, trangThai="loi", msg=str(e)[:160])
        return 1


if __name__ == "__main__":
    import sys
    sys.exit(_chinh(sys.argv))
