"""
scan_feed_sounds.py — Duyệt feed TikTok (For You), lấy link sound ĐẠT điều kiện.

Luồng (1 vòng lặp):
  1. Đang ở 1 video trên feed -> bấm icon sound (góc phải, videomusiccoverblock).
  2. Sang trang nhạc (MusicDetailActivity) -> đọc title + số post.
  3. ĐẠT nếu: title là "Original Sound" (không phải "Contains: ..." / "Bao gồm ...")
     VÀ 1000 < số post < 100000.
     Nếu ĐẠT -> đọc music ID qua dumpsys, dựng link https://www.tiktok.com/music/original-sound-<id>
     (fallback: bấm Share sound -> Copy link -> đọc clipboard).
  4. Back về feed -> cuộn xuống video tiếp theo -> lặp lại từ bước 1.

Kết quả ĐẠT ghi ra file sound_links.txt (mỗi dòng: link<TAB>so_post), ghi ngay khi có (an toàn nếu dừng giữa chừng).

Cách dùng:
  python scan_feed_sounds.py                  # máy đầu tiên list_devices() thấy
  python scan_feed_sounds.py 192.168.5.104:5555
  set LIMIT=20 & python scan_feed_sounds.py   # chỉ check 20 video rồi dừng (mặc định 0 = chạy tới khi Ctrl+C)

Yêu cầu: TikTok đã đăng nhập trên máy (script tự mở app nếu đang ở màn hình ngoài).
"""
import json
import os
import random
import re
import subprocess
import sys
import time
from adb_helper import connect, adb, list_devices
from askbridge import AskBridge
import phone_actions as PA
import college_proxy as CP

# Ha timeout HTTP cua uiautomator2 (mac dinh 300s = 5 phut) xuong ngan hon: khi 1 lenh RPC
# bi TREO (hay gap khi chay nhieu may song song), no se tu RAISE loi sau HTTP_TIMEOUT giay
# thay vi dung im 5 phut -> main loop bat loi & tu phuc hoi (reset service) nhanh.
try:
    import uiautomator2.base as _u2base
    _u2base.HTTP_TIMEOUT = float(os.environ.get("U2_HTTP_TIMEOUT", "25"))
except Exception:
    pass

PKGS = ["com.zhiliaoapp.musically", "com.ss.android.ugc.trill"]

def rid(name):
    return [f"{pkg}:id/{name}" for pkg in PKGS]

SOUND_ICON_IDS = rid("videomusiccoverblock")
TITLE_IDS = rid("title")
COUNT_IDS = rid("used_count")
MUSIC_ACTIVITY = "MusicDetailActivity"

# Cac nguong nay doc duoc tu bien moi truong (GUI truyen vao), fallback ve mac dinh cu.
# `int(float(...))`: o nhap tren giao dien cho go so le ("1000.5"), ma `int("1000.5")` nem loi
# ngay luc khoi dong -> tien trinh chet ma 1, giao dien chi thay chu "Loi". Node da lam tron
# truoc khi truyen xuong; day la hang rao thu hai.
MIN_POSTS = int(float(os.environ.get("MIN_POSTS", "1000")))
# 0 = KHONG gioi han tren, giong o "Số video đến ≤" cua ban PC (QD-27: 0 la gia tri hop le).
MAX_POSTS = int(float(os.environ.get("MAX_POSTS", "100000")))
ORIGINAL_ONLY = os.environ.get("ORIGINAL_ONLY", "1") != "0"

# ── LUAT "CHI LAY ORIGINAL SOUND" — DUNG LUAT BAN PC (2026-09-18) ──
#
# Ban cu o day: `REJECT_KEYWORDS = ["contains:", "bao gồm"]` — chi LOAI ten co chu "Contains:"
# (tieng Anh/Viet), roi dung link `original-sound-<id>` cho MOI sound con lai. Do tren may that
# (`probe_screen.py --origin`): nhac ban quyen "Passport Sky" — link that `Passport-Sky-<id>` —
# lot qua va bi GAN NHAM thanh `original-sound-<id>` tren Sheet.
#
# Gio xet DUNG nhu ban PC (`linkkey.isOriginalSound`): SLUG cua LINK THAT (lay qua Share -> Copy
# link), hoac TEN sound, phai BAT DAU bang mot nhan "original sound" (34 thu tieng, gom ca "âm
# thanh gốc"). Nhan do Node dung tu `src/linkkey.cjs` roi truyen xuong — Python KHONG giu ban sao
# nao (bai hoc `linkkey.cjs` tung lech giua hai app). Node con chot lai lan cuoi bang chinh ham
# `isOriginalSound` cua ban PC.
_RE_GOC_SLUG_SRC = os.environ.get("RE_GOC_SLUG", "")
_RE_GOC_TEN_SRC = os.environ.get("RE_GOC_TEN", "")
RE_GOC_SLUG = re.compile(_RE_GOC_SLUG_SRC or "(?!)")
RE_GOC_TEN = re.compile(_RE_GOC_TEN_SRC or "(?!)")
# Chay ngoai app (start_scan_feed_sound.bat) thi khong co nhan -> KHONG loc duoc Original Sound.
# Khi do thu moi sound dat so post va NOI RA luc khoi dong, thay vi loai sach moi thu trong im lang.
CO_LUAT_GOC = bool(_RE_GOC_SLUG_SRC and _RE_GOC_TEN_SRC)

# Tab PENDING bat khong (clone QD-20 ban PC). Bat thi sound KHONG DOC DUOC so video duoc lay link
# de cat vao tab Pending cho nguoi kiem tay, thay vi bo luon. Tat thi khong ton 2-3 giay lay link
# cho no — khong co cho nao de cat.
PENDING_ON = os.environ.get("PENDING_ON") == "1"

# ── PROXY CUA MAY NAY (2026-09-23) ──
# `host:port:user:pass` do Node doc tu devices.json. Co proxy thi TikTok CHI duoc mo sau khi
# college_proxy.dam_bao_proxy da do duoc IP cua may la IP proxy — xem `setup_device`. Rong = chay
# mang that nhu truoc.
PROXY = os.environ.get("PROXY", "").strip()
# Tep dau "da gan proxy nao" tren MAY TINH (runner truyen) — cho college_proxy di duong nhanh.
PROXY_MOC = os.environ.get("PROXY_MOC", "")
# Bao lau hoi lai mot lan "VPN con song khong" giua ca (mot lenh adb, khong mo giao dien).
KIEM_VPN_GIAY = 120

HERE = os.path.dirname(__file__)
OUTPUT_FILE = os.path.join(HERE, "sound_links.txt")

# Cho trang nhac mo sau khi bam icon. Chinh duoc trong app (o "Chờ trang nhạc").
# ⚠ Gia tri nay tung la 15 VA `find_first` duyet ca hai goi TikTok -> mot lan lo trang nhac dot
# tron 30 giay. Gio `find_first` chi cho MOT goi (xem ACTIVE_PKG) nen 8 giay la du rong.
WAIT_MUSIC_PAGE = float(os.environ.get("MUSIC_WAIT_SEC", "8") or 8)

# Tran cho so lieu (used_count) tai xong sau khi trang nhac mo.
# ⚠ Ban cu la `time.sleep(2.5)` MU — ngu du 2,5 giay ke ca khi so da hien ra tu lau. Gio do theo
# DIEU KIEN (thay so thi di tiep), con day chi la tran tren. Tiet kiem ~1,3-2,2s MOI trang nhac.
SETTLE = float(os.environ.get("SETTLE_SEC", "1.2") or 1.2)

WAIT_SHARE_SHEET = 2
REST_AFTER_BACK = 0.8

# TikTok coi lướt quá nhanh (dwell time ~0) la hanh vi bot va nhoi lai cung 1
# video/quang cao lien tuc. Dwell ngau nhien de giong hanh vi nguoi that hon.
DWELL_MIN = float(os.environ.get("DWELL_MIN", "3.0"))
DWELL_MAX = float(os.environ.get("DWELL_MAX", "6.0"))

# GUI_MODE=1 (do runner.cjs cua app Electron dat) -> in them dong @@EVENT@@<json>
# de tien trinh cha parse duoc; khong anh huong gi khi chay CLI binh thuong.
GUI_MODE = os.environ.get("GUI_MODE") == "1"

# ASK_ON=1 khi nguoi dung bat bat ky o loc/tuong tac nao. Tat thi KHONG dump hierarchy moi
# video -> giu nguyen toc do cu. Dump la buoc dat nhat (~0.3-2s/video), dat hon nhieu so voi
# ban than kenh hoi/dap.
ASK_ON = os.environ.get("ASK_ON") == "1"

# FOLLOW_ANY=1: co THU NGHIEM. Bo tam dieu kien "sound hop le" o nhanh follow, de do xem duong
# follow co bam duoc that khong. Mac dinh TAT -> app chay y nguyen nhu truoc.
FOLLOW_ANY = os.environ.get("FOLLOW_ANY") == "1"

# Chu ky: quet bao nhieu phut roi tu dung, NHA KHE cho may dang xep hang.
# Khong co chu ky thi voi "Gioi han video = 0" may chay mai va 13 may con lai cho vinh vien.
CYCLE_ON = os.environ.get("CYCLE_ON") == "1"
CYCLE_SCAN_MIN = float(os.environ.get("CYCLE_SCAN_MIN", "30") or 30)
VISIT_SEC_MIN = float(os.environ.get("VISIT_SEC_MIN", "5") or 5)
VISIT_SEC_MAX = float(os.environ.get("VISIT_SEC_MAX", "10") or 10)

# Xem video mo trong trang ca nhan bao lau truoc khi tym.
PROFILE_VID_MIN = float(os.environ.get("PROFILE_VID_SEC_MIN", "3") or 3)
PROFILE_VID_MAX = float(os.environ.get("PROFILE_VID_SEC_MAX", "7") or 7)

# ── CHE DO QUET <-> XEM (2026-09-18, clone che do `cycle` ban PC) ──
# Moi PHA la mot luot chay Python rieng: Node chia pha bang `phaseplan.cjs` cua ban PC, het pha
# thi Python bao `cycle_done` roi thoat, Node cho nghi roi chay pha ke. Python chi biet pha cua
# CHINH luot nay qua bien MODE — khong giu trang thai, khong giu luat.
MODE = (os.environ.get("MODE") or "scan").strip().lower()       # "scan" | "view"
VIEW_LINKS_FILE = os.environ.get("VIEW_LINKS_FILE", "")
VIEW_START = int(float(os.environ.get("VIEW_START", "0") or 0))    # moc: link can xem tiep
VIEW_PHASE_MIN = float(os.environ.get("VIEW_PHASE_MIN", "0") or 0)
# Xem video DAU cua moi link bao lau. Ban PC xem 40-70% DO DAI video, nhung tren dien thoai do
# duoc la KHONG doc duoc do dai (khong SeekBar, khong chu mm:ss, media_session rong) -> tinh bang
# giay.
VIEW_SEC_MIN = float(os.environ.get("VIEW_SEC_MIN", "10") or 0)
VIEW_SEC_MAX = float(os.environ.get("VIEW_SEC_MAX", "20") or 0)
# Vuot them bao nhieu video sau video dau (ban PC: 20-30). 0 = khong vuot.
VIEW_SCROLL_MIN = int(float(os.environ.get("VIEW_SCROLL_MIN", "20") or 0))
VIEW_SCROLL_MAX = int(float(os.environ.get("VIEW_SCROLL_MAX", "30") or 0))


def log(msg):
    """In một dòng log. KHÔNG tự đóng dấu giờ.

    ⚠ VÌ SAO (2026-09-18): trước đây Python tự thêm `[HH:MM:SS]`, còn các dòng do phía Node viết
    thì không — nên nửa log có giờ, nửa không, nhìn như hai bản ghi trộn vào nhau. Bản PC đóng
    dấu ở MỘT chỗ duy nhất là lúc hiển thị (`appendLog` trong renderer), nên mọi dòng đều có giờ
    và giờ đó luôn cùng một đồng hồ.
    """
    print(msg, flush=True)


def emit_event(type_, **fields):
    if not GUI_MODE:
        return
    print("@@EVENT@@" + json.dumps({"type": type_, **fields}, ensure_ascii=False), flush=True)


def extract_sound_name(desc):
    """'Original Sound FIFA World Cup \u200E198 posts' -> 'FIFA World Cup'."""
    s = (desc or "").strip()
    s = re.sub(r"[\u200E\u200F]?[\d.,]+\s*[KkMm]?\s*posts?\s*$", "", s, flags=re.I).strip()
    s = re.sub(r"^(original sound|contains:|bao gồm)\s*", "", s, flags=re.I).strip()
    return s or desc.strip()


def parse_count(text):
    """'872 posts' -> 872 ; '12.3K posts' -> 12300 ; '1.2M posts' -> 1200000."""
    if not text:
        return None
    text = text.strip().lstrip("\u200E\u200F").replace(",", "")
    m = re.search(r"([\d.]+)\s*([KkMm]?)", text)
    if not m:
        return None
    num = float(m.group(1))
    suffix = m.group(2).upper()
    if suffix == "K":
        num *= 1_000
    elif suffix == "M":
        num *= 1_000_000
    return int(num)


# Goi TikTok THAT SU dang chay tren may nay. Dat MOT LAN sau `setup_device`.
ACTIVE_PKG = None


def set_active_pkg(pkg):
    """Ghi nho goi TikTok dang chay, de `find_first` khoi phai doan lai."""
    global ACTIVE_PKG
    ACTIVE_PKG = pkg or None
    if ACTIVE_PKG:
        log(f"Gói TikTok đang dùng: {ACTIVE_PKG}")


def find_first(d, ids, timeout=0):
    # ⚠ CHI CHO MOT GOI (2026-09-17).
    # Ban cu duyet CA HAI muc cua PKGS va cho TRON timeout o moi muc, trong khi may chi cai MOT
    # goi. Do duoc: video khong co icon sound dot 2 x 3 = 6 giay CHAC CHAN, va mot lan lo trang
    # nhac dot 2 x 15 = 30 giay. `ensure_tiktok_open` da biet goi nao dang chay roi — khong co ly
    # do gi de doan lai o day.
    # Loc rong het thi ROI VE danh sach cu: goi la thi cham nhu truoc, con hon khong tim thay gi.
    if ACTIVE_PKG:
        ids = [i for i in ids if i.startswith(ACTIVE_PKG + ":")] or ids
    for rid_ in ids:
        el = d(resourceId=rid_)
        if timeout:
            if el.wait(timeout=timeout):
                return el
        elif el.exists:
            return el
    return None


# ⚠ PHAN TU "CU" — StaleObjectException (do tren may .117, 2026-09-19: 4 lan trong 14 video).
# Trang nhac VE LAI ngay sau khi mo, nen phan tu vua tim thay da cu luc doc chu. Ban cu de loi bay
# ra ngoai: mat sound do, va — truoc khi co thang phuc hoi — may dung luon o trang nhac. Tim lai
# roi doc lai.
def _la_phan_tu_cu(e):
    return "StaleObjectException" in str(e)


def _doc_tieu_de(d, el):
    """Doc ten sound tren trang nhac, chiu duoc trang vua ve lai (tim lai phan tu, toi da 3 lan)."""
    for lan in range(3):
        try:
            if el is None:
                return ""
            return (el.info.get("contentDescription") or el.get_text() or "").strip()
        except Exception as e:
            if not _la_phan_tu_cu(e) or lan == 2:
                raise
            time.sleep(0.3)
            el = find_first(d, TITLE_IDS, timeout=2)
    return ""


POPUP_BUTTON_TEXTS = (
    "Got it", "OK", "Allow", "Continue", "I agree", "Accept", "Accept all",
    "Skip", "Not now", "Bỏ qua", "Để sau", "Đóng", "Đồng ý",
)


def dismiss_popups(d):
    """Bỏ các popup thường gặp (xin quyền hệ thống, thông báo cập nhật, onboarding)."""
    acted = False
    deny = d(resourceId="com.android.permissioncontroller:id/permission_deny_button")
    if deny.exists:
        deny.click()
        acted = True
        time.sleep(1)
    for t in POPUP_BUTTON_TEXTS:
        el = d(text=t)
        if el.exists:
            # ⚠ Hop thoai GIOI THIEU Tako (tro ly AI) cung mang nut "Continue" / "Got it" / "OK" —
            # bam vao la MO Tako, tuc chinh ta dua may vao cho ket. Hop thoai nao nhac toi Tako
            # thi chi bam Back. Chi soi man hinh khi da thay nut, nen duong thuong khong ton gi.
            try:
                co_tako = "tako" in d.dump_hierarchy().lower()
            except Exception:
                co_tako = False
            if co_tako:
                BUOC["v"] = "đóng hộp thoại có nhắc tới Tako (bằng Back)"
                d.press("back")
            else:
                BUOC["v"] = f'bấm "{t}" để đóng hộp thoại'
                el.click()
            acted = True
            time.sleep(1)
            break
    return acted


# KHONG duoc kill agent automation (chinh no dang dieu khien may qua uiautomator2).
# Kill nham -> moi lenh d(...) sau do bi TREO (mat ket noi RPC), gay "1 may chay 1 may dung".
# Cac may farm dung agent ten khac nhau (com.github.uiautomator, com.genfarmer.uiautomator...)
# nen loai tru theo TU KHOA thay vi liet ke cung.
# ⚠ "college_proxy": app proxy la mot VPN. `force-stop` no la VPN tat NGAY TRUOC khi TikTok mo —
# ca ca chay bang IP that ma khong ai biet.
EXCLUDE_KILL_KEYWORDS = ("uiautomator", "wetest", "uia2", "atx", "genfarmer", "college_proxy")


def _is_automation_agent(pkg):
    p = pkg.lower()
    return any(kw in p for kw in EXCLUDE_KILL_KEYWORDS)


def kill_all_apps(d):
    """Dong toan bo app (tru agent automation) truoc khi bat dau, dam bao trang thai sach
    (kill ca TikTok - se duoc ensure_tiktok_open() mo lai ngay sau)."""
    try:
        installed = adb("shell", "pm", "list", "packages", "-3", serial=d.serial)
    except Exception as e:
        log(f"⚠ Không đọc được danh sách app để tắt bớt ({str(e)[:80]}) — bỏ qua bước này, vẫn chạy tiếp.")
        return
    pkgs = [
        line.split(":", 1)[1].strip()
        for line in installed.splitlines()
        if line.startswith("package:")
    ]
    pkgs = [p for p in pkgs if not _is_automation_agent(p)]
    for pkg in pkgs:
        try:
            adb("shell", "am", "force-stop", pkg, serial=d.serial)
        except Exception:
            pass
    log(f"Đã tắt {len(pkgs)} app nền để nhường RAM cho TikTok.")
    emit_event("status", state="apps_killed", count=len(pkgs))
    time.sleep(1.5)


def ensure_tiktok_open(d):
    """Đảm bảo TikTok đang mở và ở tiền cảnh. Trả về package đang dùng."""
    cur = d.app_current().get("package", "")
    if cur in PKGS:
        log(f"TikTok đã mở sẵn ({cur}).")
        return cur
    installed = adb("shell", "pm", "list", "packages", serial=d.serial)
    pkg = next((p for p in PKGS if p in installed), None)
    if not pkg:
        raise RuntimeError("Khong tim thay TikTok (musically/trill) da cai tren may.")
    log(f"Đang ở màn hình khác ({cur or 'màn hình chính'}) — mở TikTok...")
    d.app_start(pkg)
    time.sleep(4)
    for _ in range(3):
        if not dismiss_popups(d):
            break
        time.sleep(1)
    return pkg


# Music ID cua TikTok la snowflake ~19 chu so. Loc theo do dai de tranh bat nham cac
# truong so ngan khac trong dump.
_MID_PATTERNS = [r"detail_id=(\d+)", r"share_music_id=(\d+)", r"music_id[=:\"'\s]+(\d+)"]


def get_music_id(d):
    """Đọc music ID từ Bundle của MusicDetailActivity (dumpsys activity top).
    Retry vài lần vì đôi khi Bundle chưa sẵn sàng ngay sau khi trang mở.
    Link chuẩn TikTok chỉ cần ID: https://www.tiktok.com/music/original-sound-<id>."""
    for _ in range(3):
        try:
            out = adb("shell", "dumpsys", "activity", "top", serial=d.serial)
        except Exception:
            out = ""
        for pat in _MID_PATTERNS:
            ids = [i for i in re.findall(pat, out) if len(i) >= 15]
            if ids:
                return ids[-1]
        time.sleep(0.5)
    return None


def lay_link_that(d):
    """Share sound -> Copy link -> clipboard -> theo redirect -> LINK THAT, co slug that.

    Tra None neu khong lay duoc. KHONG rut gon link o day — rut gon la viec cua Node
    (`linkkey.canonicalSoundUrl`), va no chi rut gon SLUG CUA SOUND GOC. Ban cu rut MOI link
    `/music/...-<id>` thanh `original-sound-<id>`, ke ca nhac ban quyen — dung loi gan nham.
    """
    share = d(description="Share sound")
    if not share.wait(timeout=4):
        return None
    BUOC["v"] = "Share → Copy link trên trang nhạc"
    share.click()
    time.sleep(WAIT_SHARE_SHEET)
    copy = d(description="Copy link")
    if not copy.wait(timeout=4):
        d.press("back")
        return None
    copy.click()
    time.sleep(1)
    # Bang chia se con mo thi dong lai, de nut back sau do roi dung vao trang nhac.
    if d(description="Copy link").exists:
        d.press("back")
        time.sleep(0.5)
    raw = (d.clipboard or "").strip()
    if not raw.startswith("http"):
        return None
    if "/music/" in raw:
        return raw.split("?")[0].split("#")[0]
    # Link ngan (vt.tiktok.com/...): theo redirect ra link web that. `stream=True` + dong ngay:
    # chi can URL cuoi, khong tai trang HTML vai tram KB ve.
    try:
        import requests
        r = requests.get(raw, allow_redirects=True, timeout=10, stream=True,
                         headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        cuoi = r.url
        r.close()
    except Exception:
        return None
    return cuoi.split("?")[0].split("#")[0] if "/music/" in cuoi else None


def la_sound_goc(url, tieu_de):
    """Sound goc hay khong — DUNG luat ban PC (`linkkey.isOriginalSound`): slug cua link that,
    HOAC ten sound, bat dau bang mot nhan "original sound" (nhan tu Node, xem RE_GOC_*).

    Hai buoc chuan hoa bat buoc, giong het phia JS:
      - giai %-encode: TikTok tra slug tieng Viet dang `%C3%A2m-thanh-g%E1%BB%91c-...`
      - NFC + chu thuong: tieng Viet/Han co hai cach ma hoa cung mot chu (dung san / to hop)
    """
    import unicodedata
    from urllib.parse import unquote
    if url:
        sach = url.strip().split("?")[0].split("#")[0].rstrip("/")
        try:
            sach = unquote(sach)
        except Exception:
            pass
        m = re.search(r"/music/([^/]*)-(\d{8,})$", sach)
        if m and RE_GOC_SLUG.match(unicodedata.normalize("NFC", m.group(1)).lower()):
            return True
    t = unicodedata.normalize("NFC", tieu_de or "").strip().lower()
    return bool(RE_GOC_TEN.match(t))


def _slug_ngan(url):
    """'.../music/Passport-Sky-7633...' -> 'Passport-Sky' — bang chung ngan gon cho dong log."""
    from urllib.parse import unquote
    m = re.search(r"/music/([^/?#]*)-\d{8,}", unquote(url or ""))
    return m.group(1)[:40] if m else ""


# Dem cu TRUOT VI HET TRAN CHO, de tra loi duoc cau "quet nhanh the co dang tin khong".
#
# VI SAO PHAI CO (2026-09-17): dot ha nhip 16/09 cat WAIT_MUSIC_PAGE 15 -> 8s va doi SETTLE tu
# ngu mu 2,5s sang do dieu kien voi tran 1,2s. Ca hai deu CO THE danh roi sound that: trang nhac
# mo cham hon 8s, hoac so post hien cham hon 1,2s. Huong sai la an toan (bo sot chu khong lay
# nham) nhung truoc do KHONG DE LAI DAU VET NAO - cu truot vi het gio doc so post trong y het
# mot sound bi loc loai. Khong dem duoc thi khong biet nhip dang dat hay qua tay, va "nhanh" voi
# "nhanh den muc bo sot" nhin tu log la mot.
TRUOT = {"khong_icon": 0, "khong_vao_trang_nhac": 0, "het_gio_doc_so_post": 0, "tako": 0}

# ── BUOC VUA LAM GAN NHAT (2026-09-18) ──
# Loi vao TikTok Tako (tro ly AI) chua do duoc chac chan — xem phone_actions: "VUOT SANG VIDEO KE
# + MAN HINH TAKO". Nen moi lan lot vao, log phai noi duoc "ngay sau buoc nao": dong log do chinh
# la cach do loi vao that tren farm. Moi thao tac cham man hinh ghi ten minh vao day truoc khi lam.
BUOC = {"v": "mở TikTok"}


def xu_ly_tako(d, xml_str=None):
    """Dang o TikTok Tako thi lui ra, dem, va noi ra. Tra ket qua cua `PA.thoat_tako`
    ('' = khong phai Tako; 'ket' = lui khong ra)."""
    kq = PA.thoat_tako(d, ACTIVE_PKG, xml_str)
    if not kq:
        return ""
    TRUOT["tako"] += 1
    # Han che theo TUNG BUOC: moi loi vao duoc in vai lan, loi vao khac van in rieng.
    log_han_che("tako_" + BUOC["v"],
                f'⚠ Lọt vào TikTok Tako (trợ lý AI) ngay sau bước "{BUOC["v"]}" — '
                f'{PA._TAKO_CACH.get(kq, kq)}.')
    return kq

# Dem sound DAT so post nhung bi bo vi KHONG PHAI Original Sound, va so lan khong lay duoc link
# that. In o dong tong ket: loc gio la luat that (theo ban PC), mat sound phai thay duoc.
DEM = {"khong_goc": 0, "khong_link_that": 0, "pending": 0}

# Vì sao bỏ lượt tương tác. Bản cũ gộp cả bốn thành một dòng "video đã đổi" — sai ở ba trong bốn
# trường hợp, và không có số nào để biết cái nào đang xảy ra.
BO_LUOT = {"khac_nguoi": 0, "chua_doc_duoc": 0, "khong_doc_duoc": 0, "khong_o_feed": 0}

# ── CHẶN DÒNG LẶP: in vài lần đầu, đếm tiếp, tổng hiện ở tổng kết ──
#
# Khuôn lấy nguyên từ bản PC: mọi loại lỗi hay lặp đều in tối đa 3 dòng rồi im, nhưng bộ đếm VẪN
# chạy để con số đầy đủ hiện ở dòng tổng kết cuối ca. Chặn dòng, giữ tổng.
#
# ⚠ VÌ SAO CẦN: log chỉ giữ 500 dòng trong bộ nhớ. Một lỗi lặp mỗi video sẽ đẩy mọi dòng đáng đọc
# ra ngoài trong vài phút — chủ dự án mở log lên chỉ thấy một câu lặp lại hàng chục lần.
# ── NHỊP TIM: cứ bấy nhiêu video thì in một dòng tổng hợp ──
#
# ⚠ VÌ SAO PHẢI CÓ (chép từ bản PC): bản PC ghi lại một sự cố thật — người dùng thấy "0 sound"
# suốt 3 tiếng và KHÔNG có cách nào biết feed đang chạy tốt mà toàn gặp sound đã có, hay feed đã
# kẹt cứng ở một video. Hai chuyện khác hẳn nhau mà log không phân biệt được.
#
# Dòng này là câu trả lời: im lặng không bao giờ được phép mơ hồ. Nó cũng là chỗ chứa những con
# số mà từng dòng lẻ đã bị bỏ đi (video không có sound, livestream).
def _so(n):
    """Chấm nghìn kiểu Việt: 1600000 -> "1.600.000".

    Tự viết chứ không dùng `format(n, ",d")` rồi đổi dấu: bản PC cũng tự viết, với lý do ghi ngay
    trong mã — không phụ thuộc vào cấu hình vùng của máy đang chạy.
    """
    try:
        return f"{int(n):,}".replace(",", ".")
    except Exception:
        return str(n)


# Lý do bấm "Not interested", dịch sang tiếng Việt NGAY TẠI CHỖ IN.
#
# ⚠ Bản PC có cả tá giá trị nội bộ ('nav', 'nofeed', 'same', 'empty') nhưng KHÔNG giá trị nào lọt
# ra log — đều dịch tại chỗ gọi. Bản phone trước đây in thẳng `(ly do: lang)` ra màn hình.
_VI_SAO_NI = {
    "lang": "caption hoặc tên kênh dính bộ lọc ngôn ngữ",
    "ai": "video gắn nhãn AI",
    "live": "đang livestream",
}

NHIP_TIM = 25

LAP_TOI_DA = 3
_DEM_LAP = {}


def log_han_che(khoa, msg):
    """In `msg`, nhưng chỉ `LAP_TOI_DA` lần đầu cho mỗi `khoa`. Sau đó im, vẫn đếm."""
    n = _DEM_LAP.get(khoa, 0) + 1
    _DEM_LAP[khoa] = n
    if n <= LAP_TOI_DA:
        log(msg)
    elif n == LAP_TOI_DA + 1:
        log("   ↳ (dòng trên còn lặp lại — thôi không in nữa, tổng sẽ hiện ở dòng tổng kết)")


def check_current_video(d):
    """App đang ở feed, đứng tại 1 video.

    Trả về CẶP `(ket_qua, da_roi_feed)`:
      - `ket_qua`      = `(link, posts, ten)` nếu sound ĐẠT, `None` nếu không
      - `da_roi_feed`  = có thật sự đi sang trang nhạc rồi quay về hay không

    ⚠ VÌ SAO PHẢI TRẢ THÊM `da_roi_feed` (2026-09-18): nơi gọi có một phép kiểm "video có trôi
    sang người khác trong lúc mình đi vắng không". Bản cũ chạy phép kiểm đó KỂ CẢ khi máy chưa hề
    rời feed — video không có icon sound thì hàm này trả về ngay tại feed. Hậu quả là log in ra
    "video đã đổi sau khi quay lại feed" cho một lượt chưa đi đâu cả: câu đó sai theo cấu trúc,
    không phải sai lúc chạy.
    """
    icon = find_first(d, SOUND_ICON_IDS, timeout=3)
    if icon is None:
        # ⚠ KHÔNG in dòng nào ở đây (2026-09-18, chủ dự án chốt). Quảng cáo và bài ảnh đều rơi vào
        # nhánh này và chúng đi thành cụm, nên bản cũ đẻ ra 20 dòng giống hệt nhau liền mạch — đủ
        # để đẩy mọi dòng đáng đọc ra khỏi bộ đệm 500 dòng. Con số nằm ở dòng nhịp tim và tổng kết.
        TRUOT["khong_icon"] += 1
        return (None, False)
    BUOC["v"] = "bấm icon sound để mở trang nhạc"
    icon.click()

    title_el = find_first(d, TITLE_IDS, timeout=WAIT_MUSIC_PAGE)
    if title_el is None:
        TRUOT["khong_vao_trang_nhac"] += 1
        log_han_che("khong_vao_trang_nhac",
                    f"⚠ Bấm icon sound nhưng trang nhạc KHÔNG mở trong {WAIT_MUSIC_PAGE:.0f}s — "
                    "bỏ qua video này. Dòng này lặp nhiều thì nới ô \"Chờ trang nhạc mở tối đa\".")
        if MUSIC_ACTIVITY in d.app_current().get("activity", ""):
            d.press("back")
            time.sleep(REST_AFTER_BACK)
        # May yeu (Nokia 2.3, log 2026-09-19): trang nhac mo CHAM hon tran cho, tuc la no mo ra
        # SAU phep kiem ngay tren — may dung lai tren trang nhac. Da o feed thi `ve_feed` khong
        # lam gi va khong in gi.
        ve_feed(d, "bấm icon sound nhưng trang nhạc mở quá chậm")
        return (None, True)

    desc = _doc_tieu_de(d, title_el)

    # ── CHO SO POST THEO DIEU KIEN, KHONG NGU MU ──
    # Ban cu `time.sleep(SETTLE)` voi SETTLE=2,5: ngu du 2,5 giay KE CA khi so da hien tu lau.
    # Nhan voi moi trang nhac cua moi video, ca ngay, la rat nhieu thoi gian chet.
    # Gio do theo dieu kien: thay so thi di tiep ngay, con SETTLE chi la TRAN TREN.
    #
    # ⚠ `posts` bang 0 hay None deu coi la "chua tai xong" — dung cai ly do ma ban cu ngu mu:
    # doc som thi thay "0 posts" va sound bi loai oan. Het tran ma van 0/None thi de nguyen, buoc
    # loc ben duoi se loai — do la huong sai AN TOAN (bo sot, khong phai lay nham).
    het_settle = time.time() + SETTLE
    posts = None
    while True:
        count_el = find_first(d, COUNT_IDS)
        try:
            posts = parse_count(count_el.get_text()) if count_el else None
        except Exception as e:
            if not _la_phan_tu_cu(e):
                raise
            posts = None        # trang vua ve lai — vong sau tim lai phan tu roi doc lai
        if posts:
            break
        if time.time() >= het_settle:
            # Het tran ma van chua doc duoc so post. Buoc loc ben duoi se loai video nay, va
            # nhin vao log thi no giong het mot sound bi loai vi khong dat nguong - nen phai noi
            # ra o day, khong thi cu truot nay vo hinh.
            TRUOT["het_gio_doc_so_post"] += 1
            log_han_che(
                "het_gio_doc_so_post",
                f"⚠ Trang nhạc mở rồi nhưng số video chưa hiện sau {SETTLE:.1f}s — "
                + ("sound này được cất vào tab Pending để kiểm tay. " if PENDING_ON
                   else "sound này bị loại, CÓ THỂ là loại oan. ")
                + "Dòng này lặp nhiều thì nới ô \"Chờ số post hiện ra tối đa\".")
            break
        time.sleep(0.2)
    name = extract_sound_name(desc)
    # Ten NGUYEN VAN — GIU nhan ("Original Sound ...", "âm thanh gốc ...", "Contains: ..."), chi bo
    # duoi "N posts". Luat Original Sound cua ban PC xet CHINH nhan nay; `name` o tren da cat mat
    # nhan "original sound" nen khong dung duoc cho viec xet.
    tieu_de = re.sub(r"[‎‏]?[\d.,]+\s*[KkMm]?\s*posts?\s*$", "", desc, flags=re.I).strip()

    result = None
    _ten = name or "(không đọc được tên)"
    # Bien GOM CA HAI DAU (>= / <=) nhu ban PC ("Số video từ ≥ / đến ≤"). Ban cu so chat
    # `MIN < posts < MAX`, nen sound dung 1.000 post bi loai du o nhap 1000.
    trong_khoang = posts is not None and posts >= MIN_POSTS and (MAX_POSTS <= 0 or posts <= MAX_POSTS)
    if trong_khoang:
        # Loc so post TRUOC, xet Original Sound SAU: lay link that ton 2-3 giay (Share -> Copy
        # link -> theo redirect), chi dang tieu cho sound da dat so post (~5-10%).
        url_that = lay_link_that(d)
        if not url_that:
            DEM["khong_link_that"] += 1
            log_han_che(
                "khong_link_that",
                "⚠ Không lấy được link thật qua Share → Copy link — đang xét Original Sound theo TÊN, "
                "nên sẽ bỏ sót sound gốc bị đổi tên và sound \"Contains: …\".")
        loc_goc = ORIGINAL_ONLY and CO_LUAT_GOC
        goc = la_sound_goc(url_that, tieu_de)
        if loc_goc and not goc:
            DEM["khong_goc"] += 1
            bang_chung = (f"link thật …/music/{_slug_ngan(url_that)}" if url_that
                          else "không lấy được link thật, tên cũng không phải")
            log(f'Bỏ "{_ten}" (không phải Original Sound — {bang_chung})')
            emit_event("result", verdict="LOAI", name=name, posts=posts, original=False)
        else:
            link = url_that
            if not link:
                # Khong co link that thi dung tu music id. Slug `original-sound` CHI khi ten da xac
                # nhan la sound goc; con lai dung slug trung tinh `sound` — TikTok mo link theo ID
                # nen link van dung, chi khong NHAN BUA day la sound goc.
                mid = get_music_id(d)
                if mid:
                    link = f"https://www.tiktok.com/music/{'original-sound' if goc else 'sound'}-{mid}"
            if link:
                result = (link, posts, name)
                # ⚠ Câu phán quyết theo khuôn bản PC: VIỆC "TÊN" (bằng chứng), KHÔNG dấu chấm cuối.
                # Và KHÔNG in link: link đã nằm trong bảng kết quả, in thêm vào log chỉ làm dòng dài
                # ra mà không nói thêm gì.
                log(f'Lấy "{_ten}" ({_so(posts)} video)')
                emit_event("result", verdict="DAT", name=name, title=tieu_de, url=link, posts=posts)
            else:
                log(f'⚠ Bỏ "{_ten}" ({_so(posts)} video) — đạt bộ lọc nhưng KHÔNG lấy được link.')
                emit_event("result", verdict="ERROR", name=name, posts=posts, msg="khong lay duoc link")
    elif posts is None and PENDING_ON:
        # ── PENDING: khong doc duoc so video — CAT LAI thay vi bo (clone QD-20 ban PC) ──
        # Sound chua chac da chet: trang nhac mo cham hon tran cho la chuyen thuong. Van phai qua
        # luat Original Sound nhu sound thuong — Pending khong phai cua sau de nhac ban quyen lot.
        # Cung duong voi sound DAT o tren: link that truoc; khong co thi dung music id (slug
        # `original-sound` CHI khi ten da xac nhan la sound goc).
        url_that = lay_link_that(d)
        if not url_that:
            DEM["khong_link_that"] += 1
        goc = la_sound_goc(url_that, tieu_de)
        if ORIGINAL_ONLY and CO_LUAT_GOC and not goc:
            DEM["khong_goc"] += 1
            bang_chung = (f"link thật …/music/{_slug_ngan(url_that)}" if url_that
                          else "không lấy được link thật, tên cũng không phải")
            log(f'Bỏ "{_ten}" (không phải Original Sound — {bang_chung})')
            emit_event("result", verdict="LOAI", name=name, posts=None, original=False)
        else:
            link = url_that
            if not link:
                mid = get_music_id(d)
                if mid:
                    link = f"https://www.tiktok.com/music/{'original-sound' if goc else 'sound'}-{mid}"
            if link:
                DEM["pending"] += 1
                emit_event("result", verdict="PENDING", name=name, title=tieu_de, url=link)
            else:
                log(f'Bỏ "{_ten}" (không đọc được số video, cũng không lấy được link để cất vào Pending)')
                emit_event("result", verdict="LOAI", name=name, posts=None)
    else:
        # Mỗi lý do loại một câu riêng. Bản cũ in `original=True posts=None desc='...'` — đọc ra
        # thì phải tự suy, mà suy sai thì không ai biết.
        if posts is None:
            _vi = "không đọc được số video"
        elif posts < MIN_POSTS:
            _vi = f"{_so(posts)} < {_so(MIN_POSTS)} video"
        else:
            _vi = f"{_so(posts)} > {_so(MAX_POSTS)} video"
        log(f'Bỏ "{_ten}" ({_vi})')
        emit_event("result", verdict="LOAI", name=name, posts=posts)

    BUOC["v"] = "bấm Back từ trang nhạc về feed"
    d.press("back")
    time.sleep(REST_AFTER_BACK)
    return (result, True)


def reset_service(d):
    """Khoi dong lai uiautomator2 SACH: don instrumentation cu con ton dong (moi lan kill
    tien trinh Python, ban tren may van song -> lan sau tranh chap service -> treo)."""
    try:
        d.reset_uiautomator()
        log("Đã khởi động lại uiautomator2 (dịch vụ sạch).")
        return True
    except Exception as e:
        log(f"⚠ Khởi động lại uiautomator2 lỗi ({str(e)[:80]}) — vẫn thử chạy tiếp.")
        return False


def setup_device(d):
    """Chuan bi may: dong app + (gan proxy) + mo TikTok. Co retry vi buoc nay cung co the treo/loi.

    Proxy nam O DAY chu khong o main(): moi duong mo lai TikTok (luc dau, phuc hoi, noi lai sau khi
    dien thoai khoi dong lai — luc do VPN da tat) deu di qua ham nay, nen khong duong nao mo duoc
    TikTok ma bo qua proxy. `ProxyHong` KHONG thu lai 3 lan va KHONG tinh la may do: proxy chet thi
    khoi dong lai dien thoai cung khong chua duoc.
    """
    for attempt in range(1, 4):
        try:
            kill_all_apps(d)
            if PROXY:
                CP.dam_bao_proxy(d, d.serial, PROXY, log, emit_event, moc=PROXY_MOC)
            pkg = ensure_tiktok_open(d)
            return pkg
        except CP.ProxyHong:
            raise
        except Exception as e:
            log(f"⚠ Chuẩn bị máy lần {attempt} lỗi ({str(e)[:100]}) — thử lại...")
            reset_service(d)
            time.sleep(2)
    raise RuntimeError("Khong the mo TikTok sau 3 lan thu.")


# ════════════════════ TREO MAY KHONG BI DUNG (2026-09-19) ════════════════════
#
# ⚠ HAI SU CO THAT, chu du an gui log:
#   1. Loi `Remote end closed connection without response` o video #91, roi 3 TIENG lien "0 sound
#      dat, 25 video khong co sound" cho toi khi bam Dung. Nhip tim 06:04:43 phu video #76-#100 va
#      dem dung 9 video khong co sound = dung #92-#100: may dung NGAY tu luc loi. TikTok khong crash
#      (event log moi may tu 05:34 toi 09:07 chi co cac lan tat do chinh app). Loi roi vao GIUA mot
#      video (dang o trang nhac / bang Share) va khong buoc nao dua may ve feed; con "khong thay
#      icon sound" thi khong phai loi, nen nhanh phuc hoi (can 3 loi lien tiep) khong bao gio chay.
#   2. May .121 mat ket noi ADB ("device offline" roi "not found"). Nhanh phuc hoi thu 3x3 lan
#      trong 10 giay, hong het, roi vong quet quay tit moi 4 giay in loi — khong cho may quay lai.
#
# Nen gio co mot THANG PHUC HOI, moi bac mot duong ve, moi lan dung MOT dong log:
#   Bac 1  `ve_feed`       — sau moi loi, khi quay lai ma khong phai feed, va khi CANH GAC thay
#                            8 video lien khong co icon sound.
#   Bac 2  `reset_service` — 3 loi lien tiep (da co tu truoc), hoac NGAY khi dich vu tren may dut.
#   Bac 3  thoat ma 1      — phuc hoi hong 3 lan lien: phia Node chay lai tien trinh moi tu dau.
#   Bac 4  `cho_noi_lai`   — mat ket noi ADB: dung quet, cho, tu `adb connect`, noi lai thi chay tiep.

# Cau loi cua adb / adbutils khi dien thoai KHONG CON tren ADB server. Khop theo CUM TU, khong theo
# chu "not found" tron: loi `UiObjectNotFoundError` cua uiautomator2 cung co chu "not found".
_RE_MAT_KET_NOI = re.compile(
    r"device offline|device '[^']*' not found|device not found|no devices|unauthorized|"
    r"device still (?:connecting|authorizing)", re.I)

# Dich vu uiautomator2 TREN DIEN THOAI dut ket noi giua chung.
# ⚠ uiautomator2 3.7.0 tu khoi dong lai dich vu khi gap `HTTPError`, nhung `_http_request` cua no
# chi bat loi cua thu vien `requests` — trong khi no goi thang `http.client`. Nen `RemoteDisconnected`
# di thang ra ngoai va KHONG AI khoi dong lai dich vu o lenh do (da doc ma nguon, core.py:117-166).
_RE_DUT_DICH_VU = re.compile(
    r"remote end closed|remotedisconnected|connection reset|connection aborted|broken pipe", re.I)

# Canh gac: bao nhieu video LIEN khong thay icon sound thi di xem may dang o dau. Feed binh thuong
# co quang cao / bai anh xen ke, nhung 8 video lien khong co cai nao la dau hieu may da lac.
CANH_GAC_KHONG_ICON = 8

# Dem cho dong tong ket cuoi ca.
PHUC_HOI = {"ve_feed": 0, "mo_lai_tiktok": 0, "mat_ket_noi": 0, "giay_mat_ket_noi": 0.0}


def la_loi_mat_ket_noi(e):
    return bool(_RE_MAT_KET_NOI.search(str(e)))


def la_loi_dut_dich_vu(e):
    return bool(_RE_DUT_DICH_VU.search(f"{type(e).__name__} {e}"))


def _thoi_luong(giay):
    """125 -> "2 phút 5 giây"; 3900 -> "1 giờ 5 phút"."""
    giay = int(max(0, giay))
    if giay < 60:
        return f"{giay} giây"
    phut, giay = divmod(giay, 60)
    if phut < 60:
        return f"{phut} phút {giay} giây" if giay else f"{phut} phút"
    gio, phut = divmod(phut, 60)
    return f"{gio} giờ {phut} phút" if phut else f"{gio} giờ"


def _ten_man_hinh(goi, act):
    """Ten NGAN cua man hinh dang dung — de dong log noi duoc may lac o dau."""
    if not goi:
        return "không đọc được màn hình"
    if goi not in PKGS:
        if "launcher" in goi.lower():
            return "màn hình chính (TikTok không ở trước mặt)"
        return f"app khác ({goi})"
    if act.endswith(PA.ACT_TRANG_NHAC):
        return "trang nhạc"
    if act.endswith(PA.ACT_TRINH_PHAT):
        return "trình phát video"
    return "một màn hình khác trong TikTok"


def ve_feed(d, ly_do):
    """BAC 1: dua may ve feed For You. Tra 'o_feed' | 'mo_app' | 'back' | 'mo_lai' | 'khong_ve_duoc'.

    Da o feed thi KHONG lam gi va KHONG in gi — canh gac goi ham nay ca khi feed binh thuong.
    ⚠ Chi bam Back va mo lai app, KHONG cham vao thu gi tren man hinh la: may dang lac o dau thi
    chua biet, bam mu la dung bai hoc QD-31 cua ban PC.
    """
    pkg = ACTIVE_PKG or PKGS[0]
    try:
        cur = d.app_current() or {}
    except Exception:
        cur = {}
    goi, act = cur.get("package") or "", cur.get("activity") or ""
    if goi in PKGS and PA.o_feed(d):
        return "o_feed"

    truoc = _ten_man_hinh(goi, act)
    viec = []
    kq = "khong_ve_duoc"
    # 1. TikTok khong o truoc mat: mot cu Back dong hop thoai he thong (vd "Storage low" — dang thay
    #    tren may .185), roi goi TikTok len. Khong `stop`: TikTok con song thi ve dung cho cu.
    if goi not in PKGS:
        d.press("back")
        time.sleep(1.0)
        if ((d.app_current() or {}).get("package") or "") in PKGS:
            viec.append("bấm Back đóng hộp thoại")
        else:
            d.app_start(pkg)
            time.sleep(5)
            viec.append("mở lại TikTok")
        if PA.o_feed(d):
            kq = "mo_app"
    # 2. Lui TUNG NHIP, kiem lai sau moi nhip. Tako co cach lui rieng (chi Back — xem PA.thoat_tako).
    if kq == "khong_ve_duoc":
        so_back = 0
        for _ in range(3):
            if PA.thoat_tako(d, pkg):
                viec.append("thoát TikTok Tako")
            else:
                d.press("back")
                so_back += 1
                time.sleep(1.2)
            if PA.o_feed(d):
                kq = "back"
                break
        if so_back:
            viec.append(f"bấm Back {so_back} lần")
    # 3. Van chua ve: khoi dong lai TikTok tu dau.
    if kq == "khong_ve_duoc":
        d.app_start(pkg, stop=True)
        time.sleep(6)
        for _ in range(2):
            if not dismiss_popups(d):
                break
        PHUC_HOI["mo_lai_tiktok"] += 1
        viec.append("khởi động lại TikTok")
        if PA.o_feed(d):
            kq = "mo_lai"

    PHUC_HOI["ve_feed"] += 1
    # Moi LOAI man hinh in vai lan dau roi im (van dem, tong hien o dong tong ket): lac cung mot
    # kieu moi 2 phut suot ca ma dong nao cung in thi day het dong dang doc ra khoi bo dem log.
    if kq == "khong_ve_duoc":
        log_han_che("ve_feed_hong_" + truoc,
                    f"⛔ Lạc khỏi feed ({ly_do}) — đang ở {truoc}; {', '.join(viec)} mà vẫn chưa về "
                    "được feed. Vòng sau thử tiếp.")
    else:
        log_han_che("ve_feed_" + truoc,
                    f"⚠ Lạc khỏi feed ({ly_do}) — đang ở {truoc} → {', '.join(viec)}, đã về feed.")
    return kq


def _con_ket_noi(serial):
    """Dien thoai con tren ADB server khong (`adb get-state` tra `device`)."""
    try:
        return adb("get-state", serial=serial, timeout=10).strip() == "device"
    except Exception:
        return False


# Mat ket noi lau hon chung nay thi THOI CHO o day: thoat ma 1 de phia Node do lai IP cua may
# (dien thoai khoi dong lai thuong nhan IP MOI tu DHCP — su co 2026-09-19) roi chay lai sau 1 phut.
# Cho mai o IP cu la cho mot dia chi co the khong bao gio quay lai.
CHO_MAT_KET_NOI_TOI_DA = 120

# So may phan cung (`ro.serialno`) cua dien thoai luot nay dang lai — doc luc khoi dong.
MAY = {"hw": ""}


def _doc_hw(serial):
    """So may phan cung cua dien thoai dang o `serial`, hoac '' neu khong doc duoc."""
    try:
        return adb("shell", "getprop", "ro.serialno", serial=serial, timeout=10).strip()
    except Exception:
        return ""


# ── DIEN THOAI VAN NOI ADB, NHUNG ANDROID TREN MAY DA TREO (2026-09-19, GM1901 .110) ──
#
# Log: "⛔ Không kết nối được điện thoại 192.168.5.110:5555 (('server not ready', …)) — app sẽ dò
# lại IP…" moi phut mot lan, 19 may kia chay binh thuong. Cau do SAI HUONG: IP dung, ADB van thong
# (app thay may tren ADB server). Do that tren may:
#   - `ps`: system_server (loi Android: Cai dat, cai app, cho app khac dieu khien) la ZOMBIE
#     "Z [system_server]" — 22 may con lai deu "S system_server".
#   - event log 14:24:34 `watchdog: Blocked in handler on main thread / android.fg / android.io`:
#     Android tu giet system_server nhung khong dung lai duoc, vi luong "PackageManager" ket trong
#     nhan (trang thai D). May vua khoi dong lai luc 14:18, 6 phut sau treo lai.
#   - `settings get …`, `pm list packages` treo mai; dich vu uiautomator2 in "Starting Server" roi
#     ket o lenh binder dau tien, 30 giay khong len -> "server not ready".
# App khong chua duoc cai nay — phai khoi dong lai dien thoai. Nen noi DUNG benh, DUNG viec can lam.
_RE_DICH_VU_KHONG_LEN = re.compile(
    r"server not ready|server quit unexpect|already registered|LaunchUiAutomation", re.I)


def android_treo(serial):
    """Android tren may co dang treo khong. Tra:
        'chet'          — system_server da chet (zombie) hoac khong con
        'khong_tra_loi' — con song nhung lenh he thong khong tra loi
        ''              — binh thuong, HOAC khong hoi duoc (khong ket luan bua)
    Hoi `ps` truoc: lenh do khong di qua binder, may treo van tra loi ngay."""
    # May DANG KHOI DONG (vd app vua tu khoi dong lai no): `system_server` chua len nen `ps` khong
    # co no, va `settings` chua tra loi — ca hai deu giong het may treo. Hoi truoc cho chac.
    try:
        if adb("shell", "getprop sys.boot_completed", serial=serial, timeout=10).strip() != "1":
            return ""
    except Exception:
        return ""
    try:
        out = adb("shell", "ps -A -o S,NAME", serial=serial, timeout=10)
    except subprocess.TimeoutExpired:
        return ""           # ca lenh khong qua binder cung treo: ADB hong, khong phai benh nay
    except Exception:
        out = ""
    dong = [l.split() for l in out.splitlines() if l.strip()]
    if len(dong) >= 20:     # may cu co the khong hieu `-o` — khi do chi con cach hoi `settings`
        ss = [p for p in dong if len(p) >= 2 and p[1].strip("[]") == "system_server"]
        if not ss or ss[0][0] == "Z":
            return "chet"
    try:
        adb("shell", "settings get global device_provisioned", serial=serial, timeout=8)
    except subprocess.TimeoutExpired:
        return "khong_tra_loi"
    except Exception:
        pass
    return ""


def cho_khoi_dong_xong(serial, toi_da=180):
    """May VUA KHOI DONG LAI (app tu khoi dong lai, hay nguoi dung bam Restart trong 效卫): `adbd`
    len TRUOC Android ca phut. Ket noi luc do thi dich vu dieu khien khong len, bi tinh nham la
    "may do" va co khi bi khoi dong lai lan nua. Cho `sys.boot_completed` = 1, toi da `toi_da` giay.
    Khong hoi duoc (mat ADB...) thi thoi — de `connect` ben duoi bao dung loi that."""
    t0 = time.time()
    da_bao = False
    while True:
        try:
            xong = adb("shell", "getprop sys.boot_completed", serial=serial, timeout=10).strip() == "1"
        except Exception:
            return False
        if xong:
            if da_bao:
                log(f"✅ Android đã lên hẳn sau {_thoi_luong(time.time() - t0)} — kết nối.")
            return True
        if not da_bao:
            log("⏳ Máy đang khởi động — chờ Android lên hẳn rồi mới kết nối…")
            da_bao = True
        if time.time() - t0 >= toi_da:
            log(f"⚠ Chờ {_thoi_luong(toi_da)} mà Android vẫn chưa báo khởi động xong — vẫn thử kết nối.")
            return False
        time.sleep(5)


def _vi_sao_treo(benh):
    return "lõi Android đã chết" if benh == "chet" else "lệnh hệ thống không trả lời"


def chan_doan_khong_noi(serial, e):
    """Chan doan khi `connect` hong luc khoi dong. Tra (cau log, may_do):
        may_do = None           — may mat / doi IP: khong gui duoc gi qua ADB, phia Node lo do lai IP
        may_do = (chac, ly_do)  — may con noi ADB ma khong dieu khien duoc: bao Node (`bao_may_do`)"""
    loi = str(e)
    if not _RE_DICH_VU_KHONG_LEN.search(f"{type(e).__name__} {loi}"):
        return (f"⛔ Không kết nối được điện thoại {serial} ({loi[:120]}) — app sẽ dò lại IP của "
                "máy này và thử lại sau 1 phút.", None)
    benh = android_treo(serial)
    if benh:
        return (f"⛔ {serial}: điện thoại vẫn nối ADB nhưng ANDROID TRÊN MÁY ĐANG TREO ({_vi_sao_treo(benh)}), "
                "app không điều khiển được. Cần KHỞI ĐỘNG LẠI điện thoại này (app tự làm nếu đang bật "
                "\"Tự khởi động lại điện thoại khi bị đơ\").",
                (True, f"Android trên máy treo — {_vi_sao_treo(benh)}"))
    if "already registered" in loi:
        ly_do = "đang có công cụ khác giữ quyền đọc màn hình"
    else:
        ly_do = next((a for a in getattr(e, "args", ()) if isinstance(a, str)), loi).strip()[:60]
    return (f"⛔ {serial}: điện thoại vẫn nối ADB nhưng dịch vụ điều khiển (uiautomator2) trên máy không "
            f"khởi động được ({ly_do}). App thử lại sau 1 phút; lặp lại mãi thì khởi động lại điện "
            "thoại này.", (False, f"dịch vụ điều khiển không khởi động được ({ly_do})"))


def cau_khong_ket_noi(serial, e):
    """MOT dong noi dung benh khi `connect` hong luc khoi dong."""
    return chan_doan_khong_noi(serial, e)[0]


# ── MAY BI DO → BAO PHIA NODE DE NO TU KHOI DONG LAI DIEN THOAI (2026-09-22) ──
#
# Chu du an van lam tay: bam Dung trong app, vao 效卫 Restart → Confirm, roi bam Chay lai. Gio
# Python chi BAO (ngay truoc khi thoat ma 1), con quyet dinh khoi dong lai nam o main.js — no song
# qua moi lan chay lai nen moi dem duoc "3 luot lien". CHAC = Android treo han (khoi dong lai ngay);
# NGHI = khong dieu khien duoc ma chua ro vi sao (Node doi 3 luot lien).
# KHONG bao khi may mat ADB (khong gui lenh duoc) hay khi Python crash (loi app, khoi dong lai dien
# thoai khong chua duoc).
def bao_may_do(chac, ly_do):
    emit_event("may_do", chac=bool(chac), ly_do=str(ly_do)[:160])


def bao_may_do_sau_khi_hoi(serial, ly_do):
    """Nhu `bao_may_do`, nhung hoi `android_treo` truoc: Android treo han thi la CHAC."""
    benh = android_treo(serial)
    if benh:
        bao_may_do(True, f"Android trên máy treo — {_vi_sao_treo(benh)}")
    else:
        bao_may_do(False, ly_do)


def cho_noi_lai(serial, han=None, dung=lambda: False):
    """BAC 4: mat ket noi ADB — DUNG quet, cho dien thoai quay lai. Tra:
        'noi_lai'  — noi lai duoc, DUNG chiec dien thoai cu: quet tiep
        'het'      — het han ca / app da dong: dau vong quet tu thoat dung cach
        'thoat'    — mat qua `CHO_MAT_KET_NOI_TOI_DA` giay, HOAC noi lai thi IP do da la mot dien
                     thoai KHAC: thoat ma 1 de phia Node do lai IP roi chay lai sau 1 phut
    Khong dem video, khong in loi moi vong: mot dong luc bat dau, mot dong luc ket thuc.
    """
    t0 = time.time()
    PHUC_HOI["mat_ket_noi"] += 1
    log("⛔ Mất kết nối ADB tới máy — tạm dừng quét, tự nối lại (thử mỗi 15–60 giây)…")
    emit_event("status", state="offline")
    cho = 15.0
    try:
        while True:
            if dung() or (han and time.time() >= han):
                return "het"
            if _con_ket_noi(serial):
                break
            # May noi qua MANG (ip:port) thi tu goi `adb connect`, dung cach luc khoi dong (xem
            # main). CUNG binary va CUNG server 5037 voi 效卫, nen day chi la nhac lai viec 效卫
            # van lam, khong gianh may cua nhau. May cam USB thi `connect` vo nghia — chi cho.
            if serial and ":" in serial:
                try:
                    adb("connect", serial, timeout=10)
                except Exception:
                    pass
                if _con_ket_noi(serial):
                    break
            if time.time() - t0 >= CHO_MAT_KET_NOI_TOI_DA:
                log(f"⛔ Mất kết nối quá {_thoi_luong(CHO_MAT_KET_NOI_TOI_DA)} — thoát để app dò lại IP của "
                    "máy (điện thoại vừa khởi động lại thường nhận IP mới) rồi chạy lại sau 1 phút.")
                return "thoat"
            het = min(time.time() + cho, t0 + CHO_MAT_KET_NOI_TOI_DA)
            while time.time() < het:
                if dung() or (han and time.time() >= han):
                    return "het"
                time.sleep(1.0)
            cho = min(60.0, cho * 2)
    finally:
        PHUC_HOI["giay_mat_ket_noi"] += time.time() - t0
    # Noi lai duoc — nhung co dung chiec dien thoai cu khong? DHCP co the vua cap IP nay cho mot
    # may KHAC trong farm (dung chuyen dong "V2031" lai nham chiec GM1911 ngay 2026-09-19).
    hw = _doc_hw(serial)
    if MAY["hw"] and hw and hw != MAY["hw"]:
        log(f"⛔ Nối lại được, nhưng {serial} giờ là MỘT ĐIỆN THOẠI KHÁC (số máy {hw}) — không lái máy đó. "
            "Thoát để app dò lại IP của máy này rồi chạy lại sau 1 phút.")
        return "thoat"
    log(f"✅ Nối lại được sau {_thoi_luong(time.time() - t0)} — khởi động lại dịch vụ, mở lại TikTok, "
        "quét tiếp.")
    emit_event("status", state="running")
    return "noi_lai"


# Trang thai cua canh gac — cap module de phep thu goi thang `canh_gac` duoc.
CANH_GAC = {"chuoi": 0, "vong_o_feed": 0, "lan_mo_lai": None}


def canh_gac(d, khong_icon):
    """CANH GAC: `CANH_GAC_KHONG_ICON` video LIEN khong thay icon sound thi di xem may dang o dau.

    Feed binh thuong co quang cao / bai anh xen ke, nhung khong bao gio lien 8 cai. Lien nhu the la
    may da lac (trang nhac, trang ca nhan, app khac...) — dung canh 3 tieng trong log 2026-09-19 —
    hoac TikTok vua doi giao dien. Tra ket qua `ve_feed` neu vua kiem, '' neu chua toi luot kiem.
    """
    CANH_GAC["chuoi"] = CANH_GAC["chuoi"] + 1 if khong_icon else 0
    if not khong_icon:
        CANH_GAC["vong_o_feed"] = 0
    if CANH_GAC["chuoi"] < CANH_GAC_KHONG_ICON:
        return ""
    CANH_GAC["chuoi"] = 0
    try:
        kq = ve_feed(d, f"{CANH_GAC_KHONG_ICON} video liền không thấy icon sound")
    except Exception:
        return ""               # loi that (vd mat ket noi) — vong quet sau xu ly dung nhanh cua no
    if kq != "o_feed":
        CANH_GAC["vong_o_feed"] = 0
        return kq
    # 3 vong lien ma may VAN o feed: khong phai lac, ma la khong doc duoc icon sound.
    CANH_GAC["vong_o_feed"] += 1
    if CANH_GAC["vong_o_feed"] < 3:
        return kq
    CANH_GAC["vong_o_feed"] = 0
    n = 3 * CANH_GAC_KHONG_ICON
    if CANH_GAC["lan_mo_lai"] is None or time.time() - CANH_GAC["lan_mo_lai"] >= 1800:
        CANH_GAC["lan_mo_lai"] = time.time()
        log(f"⚠ {n} video liền không thấy icon sound dù đang ở feed — khởi động lại TikTok.")
        try:
            d.app_start(ACTIVE_PKG or PKGS[0], stop=True)
            time.sleep(6)
            dismiss_popups(d)
            PHUC_HOI["mo_lai_tiktok"] += 1
        except Exception:
            pass
        return "mo_lai"
    # Da khoi dong lai trong 30 phut qua ma van the: nhieu kha nang TikTok doi ten nut icon sound
    # (resource-id bi lam roi, doi theo ban) — khoi dong lai them cung vo ich, chi can NOI RA.
    log_han_che(
        "doi_giao_dien",
        f"⛔ {n} video liền không thấy icon sound dù đang ở feed, khởi động lại TikTok cũng không "
        "đỡ — có thể TikTok vừa đổi giao diện. Cần dò lại bằng probe_screen.py.")
    return kq


def _thi_hanh(d, bridge, aid, ans, info, res, da_roi_feed=True):
    """Thi hanh phan quyet cua phia Node. KHONG quyet dinh gi o day.

    THU TU CO CHU Y:
      1. Not interested TRUOC — no lam feed nhay sang video khac, nen moi thu khac phai xong truoc.
         Thuc te lam nguoc lai: tuong tac truoc, Not interested sau cung.
      2. Kiem "van dung video do" TRUOC MOI CU BAM. Sau khi tu trang nhac `back` ve, feed CO THE
         da nhay sang video khac; bam luc do la bam nham nguoi, va cu Not interested thi khong
         hoan tac duoc (QD-31: ban PC tung 5/10 cu bam trung kenh khong lien quan).
    """
    if not ans:
        return
    tac_gia = (info or {}).get("author", "")
    kq = {}

    # ── VIDEO CÒN ĐÚNG NGƯỜI ĐÓ KHÔNG ──
    #
    # ⚠ CHỈ KIỂM KHI ĐÃ THẬT SỰ RỜI FEED (2026-09-18). Phép kiểm này sinh ra để chặn một rủi ro
    # duy nhất: đi sang trang nhạc rồi quay về thì feed có thể đã trôi sang video khác, bấm lúc đó
    # là bấm nhầm người. Video không có icon sound thì máy chưa đi đâu cả — chạy phép kiểm ở đó
    # vừa vô nghĩa vừa in ra một câu sai ("sau khi quay lại feed"), và tệ hơn: nó chặn luôn mọi
    # tương tác. Chủ dự án nhìn log thấy đúng cảnh đó ở MỌI video.
    if da_roi_feed and (ans.get("ni") or ans.get("follow") or ans.get("like") or ans.get("visit")):
        con_dung, ly_do = PA.same_video(d, tac_gia)
        if not con_dung:
            BO_LUOT[ly_do] = BO_LUOT.get(ly_do, 0) + 1
            # Bốn lý do, bốn câu. Gộp lại thành một câu là chẩn đoán sai ba phần tư số lần —
            # đúng bài học QĐ-31 của bản PC: chẩn đoán sai tệ hơn không chẩn đoán.
            cau = {
                "khac_nguoi":
                    "Feed đã trôi sang video khác trong lúc đi xem trang nhạc — bỏ lượt tương tác "
                    "này để khỏi bấm nhầm người.",
                "chua_doc_duoc":
                    "⚠ Lúc quét không đọc được tên chủ video, nên không có gì để đối chiếu — bỏ "
                    "lượt tương tác này. Việc quét sound KHÔNG bị ảnh hưởng.",
                "khong_doc_duoc":
                    "⚠ Quay lại feed nhưng không đọc được tên chủ video — bỏ lượt tương tác này. "
                    "Việc quét sound KHÔNG bị ảnh hưởng.",
                "khong_o_feed":
                    "⚠ Quay lại mà màn hình KHÔNG phải feed — bỏ lượt tương tác này.",
            }.get(ly_do, "⚠ Không xác minh được video còn đúng người — bỏ lượt tương tác này.")
            log_han_che("bo_luot_" + ly_do, cau)
            bridge.acted(aid, ni="skip_changed_video", follow="skip_changed_video",
                         like="skip_changed_video", visit="skip_changed_video",
                         like_profile="skip_changed_video")
            # Biet ro la khong con o feed ma chi "bo luot" thi vong sau van dung sai cho — log cua
            # may .121 (2026-09-19) cho thay dung canh do tren may yeu. Dua ve feed ngay tai day.
            if ly_do == "khong_o_feed":
                ve_feed(d, "quay lại từ trang nhạc mà không phải feed")
            return

    # ── FOLLOW: GHE TRANG CA NHAN LAY @handle THAT ROI MOI BAM ──
    #
    # `ans["follow"]` o day CHUA phai giay phep. No chi noi "con ngan sach trong ngay, dang de
    # ghe". Giay phep that do nhip hoi thu hai cap, sau khi doc duoc @handle tren trang ca nhan —
    # vi so chong trung va tran 30 luot/ngay deu khoa theo @handle, ma feed thi KHONG bay @handle
    # (do duoc 2026-09-16: 0/3 mau).
    #
    # Van giu dieu kien "sound HOP LE" (`res`): khong ghe bua, chi ghe nguoi co sound dang lay.
    if ans.get("follow"):
        # FOLLOW_ANY=1: CO THU NGHIEM, bo tam dieu kien "sound hop le" de CHUNG MINH duong follow
        # bam duoc that. Mac dinh TAT, nen hanh vi cua app khong doi.
        #
        # Vi sao can: dieu kien "sound hop le" doi mot vong di trang nhac roi quay ve, ma chinh
        # trong quang do feed hay TROI sang video khac -> `same_video` chan lai -> nhanh follow
        # gan nhu khong bao gio chay. Do duoc 2026-09-16: `ghe trang: 0` suot mot luot 9 video.
        # Tat co nay di thi moi biet do_follow co bam duoc hay khong, thay vi doan.
        if not res and not FOLLOW_ANY:
            kq["follow"] = "not_needed"
        else:
            BUOC["v"] = "mở trang cá nhân để follow"
            handle_that = PA.open_profile_read_handle(d, log)
            try:
                if not handle_that:
                    kq["follow"] = "fail"
                else:
                    log(f"Đã vào trang {handle_that} — hỏi app xem có được follow không...")
                    xn = bridge.ask(kind="follow_confirm", handle=handle_that,
                                    author=tac_gia, desc="", badges=[])
                    quyet = bridge.take(xn) if xn is not None else None
                    if quyet and quyet.get("follow"):
                        # Bam NGAY TREN TRANG CA NHAN: o day nut co `text` dung bang "Follow" nen
                        # khop duoc RE_FOLLOW. Nut tren feed co `text` rong (chi co content-desc
                        # "Follow <Ten>") nen bam o feed luon bao "khong thay nut Follow".
                        kq["follow"] = PA.do_follow(d, log)
                        kq["handle"] = handle_that      # de phia Node ghi so DUNG kenh

                        # ── NAP LAI TRANG ROI DOC LAI NUT ──
                        # Yeu cau chu du an: "follow xong reload lai la biet no con follow hay
                        # khong". TikTok co the BAT LAI cu follow vai giay sau; tin phep xac minh
                        # tai cho thi so ghi mot cu follow khong he ton tai, va ghi VINH VIEN.
                        # Lam ngay tai trang dang mo, chua quay ve feed - khong the nham nguoi.
                        if kq["follow"] == "ok":
                            con = PA.verify_follow_after_reload(d, log)
                            if con == "reverted":
                                log(f"⛔ TikTok đã BẬT LẠI cú follow {handle_that} — không ghi sổ. Lặp lại nhiều lần nghĩa là tài "
            "khoản đang bị chặn hành vi tự động; nên tắt follow trên máy này một ngày.")
                                kq["follow"] = "reverted"
                            elif con == "unknown":
                                # Bam duoc va nut da doi, chi la nap lai khong ket luan duoc.
                                # Van ghi so: dem THUA an toan hon dem thieu, vi dem thieu la
                                # follow qua tay tren tai khoan that.
                                kq["follow"] = "ok_unverified"
                    else:
                        kq["follow"] = "not_needed"
            finally:
                # LUON quay ve feed. Bo lai may o trang ca nhan thi vong quet ke tiep vuot tren
                # trang do, va moi phep nhan dien sau deu sai cho.
                PA.close_profile(d, log)

    # ── TYM TREN FEED: CHI khi sound HOP LE ──
    # ⚠ Truoc 2026-09-17 dong nay la `if ans.get("like"):` — KHONG co `res`, trong khi follow
    # (:389) va ghe tham (:433) deu co. Hau qua: MOI video deu bi tym, ke ca video vua bi bo loc
    # loai. Chu du an nhin man hinh bat duoc. Mot dieu kien thieu, khong mot dong log nao bao.
    if ans.get("like") and res:
        BUOC["v"] = "thả tim (chạm đúp giữa video)"
        kq["like"] = PA.do_like(d, log)

    # ── GHE TRANG: luot vai giay -> mo MOT video ngau nhien -> xem -> (co the) tym -> ve feed ──
    # `like_profile` do phia Node cap trong CUNG mot cau tra loi (xem askproto.cjs): nhip hoi thu
    # hai se nam trong trang ca nhan, khong co gi che thoi gian cho nen ton wall-clock that.
    if ans.get("visit") and res:
        # ── NHIP HOI THU HAI, NGAY TRONG TRANG CA NHAN ──
        # Chong ghe trung qua ngay khoa theo `@handle`, ma feed KHONG bay `@handle` (do: 0/3
        # mau). Nen phai mo trang, doc ten that, roi moi hoi so duoc. Phan xet van o phia Node —
        # o day chi gui cau hoi va thi hanh cau tra loi, dung luat mo dau `askproto.cjs`.
        #
        # Hoi hong (het gio, lech phien ban) thi `take()` tra ve SAFE, tuc `visit=0`, tuc di ra
        # ngay. Huong sai an toan: khong bam gi len tai khoan that.
        def _o_lai(handle):
            aid2 = bridge.ask(kind="visit_check", handle=handle)
            if aid2 is None:
                return True          # cau hoi/dap dang tat -> giu nguyen hanh vi cu
            return bool(bridge.take(aid2).get("visit"))

        BUOC["v"] = "ghé trang cá nhân"
        kq["visit"], kq["like_profile"] = PA.do_visit(
            d, tac_gia, VISIT_SEC_MIN, VISIT_SEC_MAX, log,
            like_video=bool(ans.get("like_profile")),
            vid_min=PROFILE_VID_MIN, vid_max=PROFILE_VID_MAX,
            hoi_o_lai=_o_lai,
        )

    # Not interested SAU CUNG: no doi feed.
    if ans.get("ni"):
        BUOC["v"] = "nhấn giữ → Not interested"
        kq["ni"] = PA.tap_not_interested(d, log)
        if kq["ni"] == "ok":
            log("Đã bấm \"Not interested\" (%s)" % _VI_SAO_NI.get(ans.get("why", ""), "không rõ lý do"))

    if kq:
        bridge.acted(aid, **kq)


def chay_pha_xem(d, pkg):
    """Pha XEM cua che do Quet <-> Xem. KHONG thu sound, KHONG bam gi — viec cua no la nuoi tai
    khoan: mo trang sound, xem mot video, vuot them vai chuc video cua cung sound, sang link ke.
    """
    try:
        with open(VIEW_LINKS_FILE, encoding="utf-8") as fh:
            links = [x for x in json.load(fh) if isinstance(x, str) and x.startswith("http")]
    except Exception as e:
        links = []
        log(f"⚠ Không đọc được danh sách link ({str(e)[:80]}).")
    if not links:
        # Node da bo pha Xem khi danh sach trong; toi duoc day nghia la tep hong giua chung.
        log("⚠ Danh sách link trống — bỏ pha Xem.")
        emit_event("status", state="cycle_done")
        return

    # Canh app con song. Pha nay khong hoi gi nen kenh hoi/dap TAT — ma tat thi khong co luong doc
    # stdin, khong biet Electron da chet, va tien trinh nay thanh MO COI vuot may mai. Bat cau noi
    # CHI de nghe EOF, khong gui cau hoi nao.
    canh = AskBridge(enabled=True, log=log)
    dung = lambda: canh.parent_gone

    n = len(links)
    i = VIEW_START % n
    han = (time.time() + VIEW_PHASE_MIN * 60) if VIEW_PHASE_MIN > 0 else None
    log(f"Pha Xem{f' ({VIEW_PHASE_MIN:g} phút)' if han else ''}: {n} link, bắt đầu từ link {i + 1}...")
    da_xem = bo = hong_lien = 0
    while True:
        if han and time.time() >= han:
            break
        if dung():
            log("App đã đóng — thoát.")
            return
        emit_event("view_progress", idx=i, total=n)
        log(f"Đang xem link {i + 1}/{n}...")
        kq = PA.xem_mot_link(
            d, pkg, links[i], han, dung,
            (VIEW_SEC_MIN, max(VIEW_SEC_MIN, VIEW_SEC_MAX)),
            (VIEW_SCROLL_MIN, max(VIEW_SCROLL_MIN, VIEW_SCROLL_MAX)),
            (DWELL_MIN, max(DWELL_MIN, DWELL_MAX)), log=log)
        if kq == "dung":
            log("App đã đóng — thoát.")
            return
        if kq == "het_gio":
            # KHONG tien moc: pha sau xem lai CHINH link nay. Ban PC v0.1.56 sua dung loi nay —
            # truoc do moi pha Xem deu bat dau lai tu link 1, cuoi danh sach dai khong bao gio
            # duoc xem toi.
            break
        if kq == "ok":
            da_xem += 1
            hong_lien = 0
        else:
            bo += 1
            hong_lien += 1
            log(f"⚠ Bỏ link {i + 1}/{n} — {kq}.")
        i = (i + 1) % n
        # Moc = link KE TIEP can xem. Node ghi xuong dia, nen tat app mo lai van xem tiep dung cho.
        emit_event("view_moc", idx=i, total=n)
        # Ca danh sach hong lien tiep (mat mang, TikTok chan, danh sach toan link chet): dung pha
        # SOM thay vi dot tron thoi luong vao viec mo link hong — moi lan hong ton 12-25 giay.
        if hong_lien >= n:
            log(f"⚠ Không xem được link nào trong cả {n} link — kết thúc pha Xem sớm.")
            break

    _p = [f"xem {da_xem} link"]
    if bo:
        _p.append(f"bỏ {bo} link không xem được")
    log("Hết pha Xem: " + ", ".join(_p) + f". Lần sau bắt đầu từ link {i + 1}/{n}.")
    emit_event("status", state="cycle_done")


def main():
    serial = sys.argv[1] if len(sys.argv) > 1 else None

    # ── MOT ADB SERVER DUNG CHUNG, KHONG PHAI MOI MAY MOT CAI ──
    #
    # Ban cu o day tu dat ANDROID_ADB_SERVER_PORT = 5100 + crc32(serial) % 800, voi ly do
    # "1 may chay 1 may dung la vi nhieu tien trinh don lenh vao MOT adb server". Doan do sai o
    # HAI cho, va ngay 2026-09-16 no lam chet ca farm:
    #
    #   1. Nua RPC cua uiautomator2 KHONG BAO GIO di theo cong rieng do. `adbutils` giu mot
    #      client cap module (`adbutils.adb = AdbClient()`) doc bien moi truong NGAY LUC IMPORT,
    #      ma `import uiautomator2.base` o file nay nam tren dau file (dong 35-39) nen chay
    #      TRUOC main(). Nghia la moi lenh d(...) van di cong 5037; chi cac lenh adb goi bang
    #      subprocess trong adb_helper.py moi nhay sang cong rieng. Mot tien trinh, hai server —
    #      va cai cong rieng do chua bao gio ganh cai tai ma no duoc sinh ra de chia.
    #   2. Farm nay noi qua MANG (192.168.x.y:5555). `adbd` tren dien thoai chi nhan DUNG MOT
    #      ket noi tu mot adb server, ma phan mem soi man hinh 效卫 da giu ca 23 may tren server
    #      mac dinh roi. Do duoc: `adb devices` tren 5037 ra 23 may, tren 5112 ra RONG, va
    #      `adb connect` toi 5112 treo mai khong ve.
    #
    # Hau qua: `adb shell pm list packages` -> `device not found` -> setup_device hong 3 lan ->
    # RuntimeError("Khong the mo TikTok sau 3 lan thu") -> thoat ma 1, trong khi bang kiem tra
    # ben Node van bao XANH vi no hoi server mac dinh. Cung lan chay do, ep
    # ANDROID_ADB_SERVER_PORT=5037 thi quet 20/20 video khong mot loi.
    #
    # Nen: o day KHONG con tu chon cong nua. Phia Node (runner.cjs) chon va truyen xuong, y het
    # cach no truyen ADB_PATH, va bang cung mot ly do: hai ben tu quyet rieng thi co ngay moi
    # ben mot server, phia Node bao XANH con may thi khong ai dieu khien duoc.
    # Chay tay ngoai app (start_scan_feed_sound.bat) thi khong co bien -> roi ve 5037, dung cai
    # server ma `adb devices` go trong cmd nhin thay.
    adb_port = os.environ.get("ANDROID_ADB_SERVER_PORT", "5037")
    try:
        import uiautomator2.base as _b
        log(f"Dùng chung ADB server cổng {adb_port} với app (chờ RPC tối đa {_b.HTTP_TIMEOUT}s).")
    except Exception:
        log(f"Dùng chung ADB server cổng {adb_port} với app.")

    # ── CHI `connect` KHI THAT SU CHUA CO MAY ──
    #
    # Ban cu goi `adb connect` MU, moi lan khoi dong. Do duoc: lenh do ton tron 60 giay
    # (adb_helper.adb() mac dinh timeout=60) NGAY CA tren server da co san may — nhan voi 19 may
    # la 19 phut moi ca, dot khong doi lay gi. Va voi may cam USB thi `connect` con vo nghia:
    # no doi dia chi ip:port, serial USB truyen vao chi to them mot dong loi.
    #
    # Hoi `adb devices` truoc: mot lenh, xong trong nua giay, va tra loi dung cau hoi can hoi.
    if serial and ":" in serial:
        try:
            if serial in list_devices():
                log(f"Máy {serial} đã có sẵn trên ADB server — bỏ qua bước kết nối.")
            else:
                log(f"Máy {serial} chưa có trên ADB server — đang kết nối...")
                # Timeout NGAN co chu y: da biet may khong nam trong danh sach thi `connect`
                # hoac an ngay, hoac treo vi mot host khac dang giu `adbd` cua may — cho them
                # 50 giay nua khong doi duoc ket qua, chi lam nguoi dung tuong app da treo.
                out = adb("connect", serial, timeout=10)
                log(f"adb connect: {out or '(không nói gì)'}")
        except Exception as e:
            # KHONG dung o day: connect hong chua chac la khong dieu khien duoc may. De
            # connect(serial) ben duoi bao loi that, va bao dung cai loi that.
            log(f"⚠ adb connect lỗi ({str(e)[:80]}) — vẫn thử kết nối tiếp.")

    if serial:
        cho_khoi_dong_xong(serial)
    try:
        d = connect(serial)
    except Exception as e:
        # Mot dong noi ro thay cho ca trang traceback (log 2026-09-19: "device … not online"), va
        # noi DUNG benh: may mat / doi IP, hay may con do nhung Android tren may da treo.
        cau, do_ = chan_doan_khong_noi(serial, e)
        log(cau)
        if do_:
            bao_may_do(*do_)
        sys.exit(1)
    # DUNG MAY chua? IP co the da ve tay mot dien thoai khac (DHCP cap lai sau khi khoi dong lai).
    hw_that = _doc_hw(d.serial)
    hw_mong = os.environ.get("DEVICE_HW", "").strip()
    if hw_mong and hw_that and hw_that != hw_mong:
        log(f"⛔ {d.serial} giờ là MỘT ĐIỆN THOẠI KHÁC (số máy {hw_that}, không phải {hw_mong}) — không "
            "chạy trên máy đó. App sẽ dò lại IP của máy này và thử lại sau 1 phút.")
        sys.exit(1)
    MAY["hw"] = hw_that or hw_mong
    log(f"✅ Đã kết nối {d.serial}.")
    emit_event("status", state="connected", serial=d.serial)
    reset_service(d)
    try:
        pkg = setup_device(d)
    except CP.ProxyHong as e:
        # KHONG bao may do: dien thoai khoe, proxy moi la cai hong.
        log(f"⛔ Proxy không chạy: {e}. KHÔNG mở TikTok bằng IP thật — app sẽ thử lại sau 1 phút.")
        sys.exit(1)
    except Exception as e:
        log(f"⛔ Không mở được TikTok ({str(e)[:120]}) — app sẽ thử lại sau 1 phút.")
        bao_may_do_sau_khi_hoi(d.serial, "không mở được TikTok sau 3 lần thử")
        sys.exit(1)
    # Ghi nho goi dang chay -> `find_first` chi cho MOT goi thay vi ca hai (xem chu thich o do).
    set_active_pkg(pkg)
    emit_event("status", state="app_open", pkg=pkg)

    if MODE == "view":
        chay_pha_xem(d, pkg)
        emit_event("status", state="done", checked=0, qualified=0)
        return

    if ORIGINAL_ONLY and not CO_LUAT_GOC:
        log("⚠ Chạy ngoài app: không có luật Original Sound từ app — thu MỌI sound đạt số post.")

    limit = int(float(os.environ.get("LIMIT", "0")))
    count = 0
    qualified = 0
    consecutive_fail = 0
    # Dem so lan phai phuc hoi. Xem cho in ra o cuoi vong lap: day la van tay cua trieu chung
    # "1 may chay 1 may dung", va tu 2026-09-16 ca farm dung chung mot adb server nen no phai
    # do duoc, khong phai doan.
    recover_count = 0
    # Thang phuc hoi (2026-09-19) — xem khoi "TREO MAY KHONG BI DUNG".
    hong_phuc_hoi = 0           # so lan phuc hoi (bac 2) hong LIEN TIEP
    thoat_loi = False           # bac 3: thoat ma 1 de phia Node chay lai tien trinh moi tu dau
    # Feed KHONG SANG VIDEO MOI (do that tren may .117, 2026-09-19: mot bai anh giu feed dung yen 8
    # vong lien, vong nao cung mo lai trang nhac cua CUNG mot sound). Nhan ra bang (ten tac gia,
    # caption) doc duoc o dau moi vong — giong het vong truoc la feed chua sang video moi.
    video_truoc = None
    lan_trung = 0
    mo_lai_ket = 0      # so lan LIEN khoi dong lai TikTok vi feed dung yen (chua thay video moi nao)
    live_bo_qua = 0     # so video livestream da bo qua (yeu cau 2026-09-16)
    # Mốc của lần in nhịp tim gần nhất, để in ĐỘ CHÊNH chứ không in tổng luỹ kế. Tổng luỹ kế đọc
    # không ra nhịp: "đã quét 300 video" lần nào cũng đúng, kể cả khi feed vừa kẹt 20 phút.
    moc = {"count": 0, "qualified": 0, "khong_icon": 0, "live": 0}

    # Cay cau hoi/dap voi phia Node. Tat thi moi thu chay y het truoc khi co tinh nang nay.
    bridge = AskBridge(enabled=ASK_ON, log=log)
    if ASK_ON:
        log("Lọc và tương tác: BẬT — app phán xét, máy chỉ đọc màn hình và thi hành.")

    # Han chu ky. Het gio thi THOAT SACH de nha khe cho may dang xep hang.
    han_chu_ky = (time.time() + CYCLE_SCAN_MIN * 60) if CYCLE_ON else None
    kiem_vpn_luc = time.time() + KIEM_VPN_GIAY  # vua gan proxy xong trong setup_device
    if han_chu_ky:
        log("Chu kỳ: quét %.0f phút rồi tự dừng, nhường khe cho máy khác..." % CYCLE_SCAN_MIN)

    with open(OUTPUT_FILE, "a", encoding="utf-8") as f:
        while True:
            if limit and count >= limit:
                break
            if han_chu_ky and time.time() >= han_chu_ky:
                log("Hết ca — dừng và nhả khe cho máy đang xếp hàng.")
                emit_event("status", state="cycle_done")
                break
            # Tien trinh cha da chet: truoc khi co kenh stdin, Electron chet la cac tien trinh
            # Python MO COI cu vuot may that mai mai, khong ai don. Gio phat hien duoc.
            if bridge.parent_gone:
                log("App đã đóng — thoát.")
                break
            # ── VPN RO GIUA CA ──
            # College Proxy co the bi Android tat giua chung; luc do TikTok lang le chay tiep bang IP
            # that. Tat TikTok NGAY roi gan lai qua `setup_device` (no do lai IP truoc khi mo TikTok).
            if PROXY and time.time() >= kiem_vpn_luc:
                kiem_vpn_luc = time.time() + KIEM_VPN_GIAY
                if not CP.vpn_dang_bat(d.serial):
                    log("⛔ VPN của College Proxy đã tắt giữa ca — tắt TikTok, gắn lại proxy.")
                    for goi in PKGS:
                        try:
                            adb("shell", "am", "force-stop", goi, serial=d.serial, timeout=15)
                        except Exception:
                            pass
                    try:
                        setup_device(d)
                    except CP.ProxyHong as e2:
                        log(f"⛔ Gắn lại proxy không được: {e2}. Dừng — app sẽ thử lại sau 1 phút.")
                        thoat_loi = True
                        break
                    except Exception as e2:
                        log(f"⚠ Mở lại TikTok sau khi gắn lại proxy lỗi ({str(e2)[:80]}) — vòng sau thử tiếp.")
                    continue
            count += 1
            t_video = time.time()
            khong_icon = False
            try:
                if dismiss_popups(d):
                    log("Đã đóng một hộp thoại chen ngang.")
                    time.sleep(1)

                # ── HOI TRUOC KHI BAM ICON SOUND ──
                # Gui cau hoi RUOC, lay cau tra loi SAU khi tu trang nhac quay ve. Quang 5-9
                # giay mo trang nhac che tron thoi gian di ve, nen duong binh thuong khong ton
                # them mili-giay nao.
                info = PA.read_video_info(d) if bridge.enabled else None
                # Dang dung trong TikTok Tako (tro ly AI) — soi ke tren CUNG ban chup vua doc. Lui
                # ra roi lam lai vong nay tu dau; luot nay khong tinh la mot video.
                # ⚠ `pop` la bat buoc: `bridge.ask(**info)` ben duoi khong nhan khoa `tako`.
                if info is not None and info.pop("tako", False):
                    count -= 1
                    if xu_ly_tako(d) == "ket":
                        # Back lan mo lai TikTok deu khong ra: dua vao nhanh loi ben duoi, du 3 lan
                        # lien tiep thi no khoi dong lai dich vu va dung may lai tu dau.
                        raise RuntimeError("kẹt ở màn hình TikTok Tako")
                    continue
                if info is not None:
                    ky = (info.get("author") or "", info.get("desc") or "")
                    lan_trung = lan_trung + 1 if (ky != ("", "") and ky == video_truoc) else 0
                    if video_truoc is not None and ky != ("", "") and ky != video_truoc:
                        mo_lai_ket = 0      # feed da sang video moi that su
                    video_truoc = ky

                # ── BO QUA LIVESTREAM ──
                # Yeu cau cua chu du an (2026-09-16), va ky thuat cung dong y: man LIVE khong co
                # icon sound, khong co nut Follow o cho quen thuoc, `long_press_layout` mang chu
                # "LIVE" thay vi "Video" -> moi phep nhan dien sau do deu truot. Vuot qua luon,
                # khong hoi, khong bam gi.
                #
                # Khi TAT tuong tac (`bridge.enabled` false) thi `info` la None nen khong biet
                # LIVE hay khong — van quet nhu cu, va `check_current_video` tu bo qua vi khong
                # co icon sound. Khong con duong nao khac ma cung khong hai gi.
                if info and info.get("live"):
                    # Không in dòng nào: livestream đi thành cụm y như quảng cáo, và con số đã
                    # nằm ở dòng nhịp tim lẫn dòng tổng kết.
                    live_bo_qua += 1
                    emit_event("progress", checked=count, qualified=qualified)
                    time.sleep(random.uniform(1.0, 2.0))
                    BUOC["v"] = "vuốt qua livestream"
                    PA.vuot_video_ke(d)
                    time.sleep(random.uniform(0.8, 1.4))
                    continue

                aid = bridge.ask(**info) if info else None

                res, da_roi_feed = check_current_video(d)
                consecutive_fail = 0
                khong_icon = res is None and not da_roi_feed

                # ── LAY PHAN QUYET VA THI HANH ──
                if aid is not None:
                    ans = bridge.take(aid)
                    _thi_hanh(d, bridge, aid, ans, info, res, da_roi_feed)
            except Exception as e:
                # ── BAC 4: MAT KET NOI ADB — cho may quay lai, khong dem, khong in loi moi vong ──
                # Hoi thang ADB server chu khong chi doc cau loi: adbutils / uiautomator2 bao cung
                # mot chuyen bang nhieu cau khac nhau.
                if la_loi_mat_ket_noi(e) or not _con_ket_noi(d.serial):
                    count -= 1
                    kq_noi = cho_noi_lai(d.serial, han_chu_ky, lambda: bridge.parent_gone)
                    if kq_noi == "thoat":
                        thoat_loi = True    # Node do lai IP roi chay lai sau 1 phut
                        break
                    if kq_noi != "noi_lai":
                        continue            # het ca / app da dong: dau vong se thoat dung cach
                    reset_service(d)
                    try:
                        setup_device(d)
                    except CP.ProxyHong as e2:
                        log(f"⛔ Proxy không chạy sau khi nối lại: {e2}. Dừng — app sẽ thử lại sau 1 phút.")
                        thoat_loi = True
                        break
                    except Exception as e2:
                        log(f"⚠ Mở lại TikTok sau khi nối lại lỗi ({str(e2)[:80]}) — vòng sau thử tiếp.")
                    consecutive_fail = 0
                    CANH_GAC["chuoi"] = 0
                    continue
                consecutive_fail += 1
                log(f"⚠ Lỗi ở video #{count} ({str(e)[:100]}) — lỗi liên tiếp {consecutive_fail}.")
                res = None
                # Loi lien tiep -> service co the wedged: reset + mo lai TikTok (main thread,
                # hieu qua vi khong con cu RPC nao dang treo o day).
                if consecutive_fail >= 3:
                    recover_count += 1
                    log(f"⚠ Phục hồi lần {recover_count} — khởi động lại dịch vụ và mở lại TikTok...")
                    emit_event("status", state="recover", n=recover_count)
                    reset_service(d)
                    try:
                        setup_device(d)
                        hong_phuc_hoi = 0
                    except CP.ProxyHong as e2:
                        log(f"⛔ Proxy không chạy: {e2}. Dừng — app sẽ thử lại sau 1 phút.")
                        thoat_loi = True
                        break
                    except Exception as e2:
                        hong_phuc_hoi += 1
                        log(f"⛔ Phục hồi lỗi ({str(e2)[:80]}) — hỏng {hong_phuc_hoi}/3 lần liền.")
                        # ── BAC 3: phuc hoi trong tien trinh nay khong con tac dung ──
                        # Thoat ma 1 de phia Node chay lai MOT TIEN TRINH MOI (ket noi moi, dich vu
                        # moi, TikTok moi) sau vai phut. Quay tit o day thi chi in loi mai mai.
                        if hong_phuc_hoi >= 3:
                            log("⛔ Phục hồi hỏng 3 lần liền — thoát để app tự chạy lại máy này từ đầu "
                                "sau vài phút.")
                            bao_may_do_sau_khi_hoi(d.serial, "phục hồi hỏng 3 lần liền")
                            thoat_loi = True
                            break
                    consecutive_fail = 0
                    CANH_GAC["chuoi"] = 0
                    continue
                # ── BAC 1 (+ BAC 2): loi le — DUA MAY VE FEED truoc khi di tiep ──
                # Loi roi vao giua mot video la may dang dung o trang nhac / bang Share / trang ca
                # nhan. Khong ve feed thi moi vong sau deu "khong thay icon sound" — dung 3 tieng
                # trong log cua chu du an.
                try:
                    if la_loi_dut_dich_vu(e):
                        log("⚠ Dịch vụ điều khiển trên máy vừa đứt kết nối — khởi động lại nó ngay.")
                        reset_service(d)
                    ve_feed(d, f"sau lỗi ở video #{count}")
                except Exception:
                    pass        # vong sau gap lai loi that va di dung nhanh cua no

            # ── CANH GAC: N video LIEN khong thay icon sound (xem `canh_gac`) ──
            canh_gac(d, khong_icon)

            if res:
                link, posts, name = res
                f.write(f"{link}\t{posts}\n")
                f.flush()
                qualified += 1
                # ⚠ Chỉ in khi con số THẬT SỰ tăng — chặn lặp ở NGUỒN, không lọc ở đích. Đây là
                # quy tắc của bản PC: nhờ nó không bao giờ có hai dòng giống hệt nhau liền nhau.
                log(f"Đã quét {qualified} sound...")

            emit_event("progress", checked=count, qualified=qualified)

            # ── NHỊP TIM ──
            if count - moc["count"] >= NHIP_TIM:
                _n = count - moc["count"]
                _phan = [f"{qualified - moc['qualified']} sound đạt"]
                _khong = TRUOT["khong_icon"] - moc["khong_icon"]
                _live = live_bo_qua - moc["live"]
                if _khong:
                    _phan.append(f"{_khong} video không có sound (quảng cáo/ảnh)")
                if _live:
                    _phan.append(f"{_live} livestream")
                log(f"Lướt {_n} video: " + ", ".join(_phan) + ".")
                moc = {"count": count, "qualified": qualified,
                       "khong_icon": TRUOT["khong_icon"], "live": live_bo_qua}

            # dwell ngau nhien truoc khi sang video ke (tranh bi TikTok coi la bot)
            try:
                # SOI TAKO TRUOC KHI VUOT, trong luc dang xem video: bat duoc moi lan lot vao do
                # trang nhac, Share, tym, ghe tham, Not interested cua CHINH vong nay — va cu vuot
                # khong bao gio roi xuong man hinh Tako (vuot o do la cham vao the "Plan your next
                # vacation", tuc la gui cau hoi cho AI). Thoi gian chup man hinh tru vao thoi gian
                # xem, nen nhip quet khong cham di.
                t_xem = time.time()
                xu_ly_tako(d)
                time.sleep(max(0.0, random.uniform(DWELL_MIN, DWELL_MAX) - (time.time() - t_xem)))
                BUOC["v"] = "vuốt sang video kế"
                if lan_trung >= 3:
                    # Khoi dong lai TikTok 3 lan roi ma feed van dung yen: may bi DO (man hinh / cam
                    # ung dung), khong phai TikTok — ban cu cu khoi dong lai TikTok mai, khong leo thang.
                    mo_lai_ket += 1
                    if mo_lai_ket > 3:
                        log("⛔ Đã khởi động lại TikTok 3 lần mà feed vẫn đứng yên — máy có vẻ bị đơ, "
                            "thoát để app xử lý.")
                        bao_may_do_sau_khi_hoi(d.serial, "feed đứng yên sau 3 lần khởi động lại TikTok")
                        thoat_loi = True
                        break
                    # Doi cach vuot roi van dung yen: khoi dong lai TikTok de feed nap lai.
                    log(f"⚠ Feed không sang được video mới ({lan_trung + 1} vòng liền cùng một video) — "
                        "khởi động lại TikTok.")
                    d.app_start(ACTIVE_PKG or PKGS[0], stop=True)
                    time.sleep(6)
                    dismiss_popups(d)
                    PHUC_HOI["mo_lai_tiktok"] += 1
                    lan_trung, video_truoc = 0, None
                else:
                    # Vong truoc da vuot ma van cung video: doi sang cach keo tung diem.
                    PA.vuot_video_ke(d, manh=lan_trung >= 1)
                time.sleep(random.uniform(0.8, 1.4))
            except Exception as e:
                # Mat ket noi thi vong sau vao thang che do cho noi lai va noi mot lan o do — in them
                # o day chi la mot dong loi nua cho cung mot chuyen (log may .121: 2 dong moi 4 giay).
                if not la_loi_mat_ket_noi(e):
                    log(f"⚠ Vuốt sang video kế lỗi ở #{count} ({str(e)[:100]}) — bỏ qua, thử tiếp.")

            # ── DAU HIEU NGHEN, PHAI THAY DUOC NGAY ──
            # Mot vong binh thuong ~10-20 giay (dwell 3-6s + mo trang nhac + back). Vuot 90 giay
            # nghia la co lenh nao do dang CHO adb/RPC chu khong phai dang lam viec. Day chinh la
            # "1 may chay 1 may dung" luc no moi chom, truoc khi may dung han.
            #
            # Vi sao can dong nay tu 2026-09-16: bo "moi may mot adb server" nghia la ca farm dung
            # chung mot server. Neu trieu chung cu quay lai that thi dong nay bao truoc — con hon
            # doi den luc may dung han roi ngoi doan, nhu lan truoc.
            _mat = time.time() - t_video
            if _mat > 60:
                log_han_che(
                    "cham_bat_thuong",
                    f"⚠ Video #{count} mất {_mat:.0f}s (bình thường 5-20s) — ADB server cổng "
                    f"{adb_port} có thể đang nghẽn vì nhiều máy chạy cùng lúc.")

    # ── TỔNG KẾT ──
    # Khuôn bản PC: một câu nền, rồi CÁC MẢNH GHÉP THÊM chỉ khi khác 0. Nhờ vậy bật thêm một tính
    # năng không viết lại dòng cũ, và số 0 không chiếm chỗ của số đáng đọc.
    _p = [f"quét {count} video", f"lấy {qualified} sound"]
    if DEM["khong_goc"]:
        _p.append(f"bỏ {DEM['khong_goc']} sound không phải Original Sound")
    if DEM["pending"]:
        _p.append(f"cất {DEM['pending']} sound vào tab Pending (không đọc được số video)")
    if DEM["khong_link_that"]:
        _p.append(f"{DEM['khong_link_that']} lần không lấy được link thật")
    if live_bo_qua:
        _p.append(f"bỏ qua {live_bo_qua} livestream")
    if TRUOT["khong_icon"]:
        _p.append(f"{TRUOT['khong_icon']} video không có sound")
    if recover_count:
        _p.append(f"phục hồi {recover_count} lần")
    if TRUOT["tako"]:
        _p.append(f"{TRUOT['tako']} lần lọt vào TikTok Tako (đã lùi ra)")
    if PHUC_HOI["ve_feed"]:
        _p.append(f"đưa máy về feed {PHUC_HOI['ve_feed']} lần")
    if PHUC_HOI["mo_lai_tiktok"]:
        _p.append(f"khởi động lại TikTok {PHUC_HOI['mo_lai_tiktok']} lần")
    if PHUC_HOI["mat_ket_noi"]:
        _p.append(f"mất kết nối {PHUC_HOI['mat_ket_noi']} lần (tổng {_thoi_luong(PHUC_HOI['giay_mat_ket_noi'])})")
    log(("⛔ Dừng ca vì lỗi: " if thoat_loi else "✅ Xong ca: ") + ", ".join(_p) + ".")

    # Hai số dưới đây là thước đo của câu hỏi "nhịp quét đã quá tay chưa": đó là sound CÓ THẬT mà
    # máy không kịp đọc. Đeo bám theo tổng số video — vài phần trăm thì bình thường, hai chữ số
    # trở lên là nhịp đang ăn vào kết quả.
    _t = []
    if TRUOT["khong_vao_trang_nhac"]:
        _t.append(f"{TRUOT['khong_vao_trang_nhac']} lần không vào được trang nhạc")
    if TRUOT["het_gio_doc_so_post"]:
        _t.append(f"{TRUOT['het_gio_doc_so_post']} lần không kịp đọc số video")
    if _t:
        log(f"⚠ Trượt vì hết giờ chờ: " + ", ".join(_t)
            + f" (trên tổng {count} video) — nới hai ô \"Chờ trang nhạc mở tối đa\" và \"Chờ số "
              "post hiện ra tối đa\" nếu số này lớn.")

    # Vì sao bỏ lượt tương tác. Bằng 0 hết là tốt; `chua_doc_duoc` cao nghĩa là máy đọc tên tác
    # giả không kịp — đúng lỗi đã làm mọi tương tác ngừng chạy suốt nhiều ca.
    _bo = [f"{v} lần {k}" for k, v in (
        ("feed đã trôi sang video khác", BO_LUOT["khac_nguoi"]),
        ("không đọc được tên lúc quét", BO_LUOT["chua_doc_duoc"]),
        ("không đọc lại được tên", BO_LUOT["khong_doc_duoc"]),
        ("lạc khỏi feed", BO_LUOT["khong_o_feed"]),
    ) if v]
    if _bo:
        log("⚠ Bỏ lượt tương tác: " + ", ".join(_bo) + ".")

    log(f"Kết quả ghi vào {OUTPUT_FILE}")
    if thoat_loi:
        # BAC 3: ma thoat khac 0 la tin hieu cho phia Node "chay lai may nay sau vai phut".
        # KHONG bao 'done' — 'done' la het ca binh thuong.
        sys.exit(1)
    emit_event("status", state="done", checked=count, qualified=qualified)


if __name__ == "__main__":
    main()
