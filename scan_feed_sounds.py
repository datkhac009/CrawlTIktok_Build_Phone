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
import sys
import time
from adb_helper import connect, adb, list_devices
from askbridge import AskBridge
import phone_actions as PA

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
MIN_POSTS = int(os.environ.get("MIN_POSTS", "1000"))
MAX_POSTS = int(os.environ.get("MAX_POSTS", "100000"))
ORIGINAL_ONLY = os.environ.get("ORIGINAL_ONLY", "1") != "0"
REJECT_KEYWORDS = ["contains:", "bao gồm"]

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
            el.click()
            acted = True
            time.sleep(1)
            break
    return acted


# KHONG duoc kill agent automation (chinh no dang dieu khien may qua uiautomator2).
# Kill nham -> moi lenh d(...) sau do bi TREO (mat ket noi RPC), gay "1 may chay 1 may dung".
# Cac may farm dung agent ten khac nhau (com.github.uiautomator, com.genfarmer.uiautomator...)
# nen loai tru theo TU KHOA thay vi liet ke cung.
EXCLUDE_KILL_KEYWORDS = ("uiautomator", "wetest", "uia2", "atx", "genfarmer")


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


def canonical_from_url(url):
    """Rút link bất kỳ (kể cả đã resolve) về dạng chuẩn nếu có music id trong path."""
    m = re.search(r"/music/[^/?#]*-(\d{8,})", url or "")
    return f"https://www.tiktok.com/music/original-sound-{m.group(1)}" if m else None


def resolve_shortlink(url):
    """Giải shortlink /t/xxx -> URL cuối -> dạng chuẩn original-sound-<id>. Trả None nếu không được."""
    if not url:
        return None
    try:
        import requests
        r = requests.get(url, allow_redirects=True, timeout=10,
                         headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        return canonical_from_url(r.url)
    except Exception:
        return None


def get_link(d):
    """Ưu tiên dựng link từ music ID (1 lệnh dumpsys, ~0.5s, không đụng UI).
    Fallback: Share sound -> Copy link -> clipboard, rồi GIẢI shortlink về dạng chuẩn
    (để không còn link cũ /t/... lọt qua)."""
    mid = get_music_id(d)
    if mid:
        return f"https://www.tiktok.com/music/original-sound-{mid}"
    share = d(description="Share sound")
    if not share.wait(timeout=5):
        return None
    share.click()
    time.sleep(WAIT_SHARE_SHEET)
    copy = d(description="Copy link")
    if not copy.wait(timeout=5):
        d.press("back")
        return None
    copy.click()
    time.sleep(1)
    raw = (d.clipboard or "").strip()
    # Chuan hoa: neu la link /music/... thi rut gon; neu la shortlink /t/... thi resolve.
    return canonical_from_url(raw) or resolve_shortlink(raw) or raw


# Dem cu TRUOT VI HET TRAN CHO, de tra loi duoc cau "quet nhanh the co dang tin khong".
#
# VI SAO PHAI CO (2026-09-17): dot ha nhip 16/09 cat WAIT_MUSIC_PAGE 15 -> 8s va doi SETTLE tu
# ngu mu 2,5s sang do dieu kien voi tran 1,2s. Ca hai deu CO THE danh roi sound that: trang nhac
# mo cham hon 8s, hoac so post hien cham hon 1,2s. Huong sai la an toan (bo sot chu khong lay
# nham) nhung truoc do KHONG DE LAI DAU VET NAO - cu truot vi het gio doc so post trong y het
# mot sound bi loc loai. Khong dem duoc thi khong biet nhip dang dat hay qua tay, va "nhanh" voi
# "nhanh den muc bo sot" nhin tu log la mot.
TRUOT = {"khong_icon": 0, "khong_vao_trang_nhac": 0, "het_gio_doc_so_post": 0}

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
        return (None, True)

    desc = (title_el.info.get("contentDescription") or title_el.get_text() or "").strip()

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
        posts = parse_count(count_el.get_text()) if count_el else None
        if posts:
            break
        if time.time() >= het_settle:
            # Het tran ma van chua doc duoc so post. Buoc loc ben duoi se loai video nay, va
            # nhin vao log thi no giong het mot sound bi loai vi khong dat nguong - nen phai noi
            # ra o day, khong thi cu truot nay vo hinh.
            TRUOT["het_gio_doc_so_post"] += 1
            log_han_che(
                "het_gio_doc_so_post",
                f"⚠ Trang nhạc mở rồi nhưng số video chưa hiện sau {SETTLE:.1f}s — sound này bị "
                "loại, CÓ THỂ là loại oan. Dòng này lặp nhiều thì nới ô \"Chờ số post hiện ra "
                "tối đa\".")
            break
        time.sleep(0.2)
    is_original = not any(kw in desc.lower() for kw in REJECT_KEYWORDS)
    name = extract_sound_name(desc)

    result = None
    _ten = name or "(không đọc được tên)"
    if (is_original or not ORIGINAL_ONLY) and posts is not None and MIN_POSTS < posts < MAX_POSTS:
        link = get_link(d)
        if link:
            result = (link, posts, name)
            # ⚠ Câu phán quyết theo khuôn bản PC: VIỆC "TÊN" (bằng chứng), KHÔNG dấu chấm cuối.
            # Và KHÔNG in link: link đã nằm trong bảng kết quả, in thêm vào log chỉ làm dòng dài
            # ra mà không nói thêm gì.
            log(f'Lấy "{_ten}" ({_so(posts)} video)')
            emit_event("result", verdict="DAT", name=name, url=link, posts=posts)
        else:
            log(f'⚠ Bỏ "{_ten}" ({_so(posts)} video) — đạt bộ lọc nhưng KHÔNG lấy được link.')
            emit_event("result", verdict="ERROR", name=name, posts=posts, msg="khong lay duoc link")
    else:
        # Mỗi lý do loại một câu riêng. Bản cũ in `original=True posts=None desc='...'` — đọc ra
        # thì phải tự suy, mà suy sai thì không ai biết.
        if posts is None:
            _vi = "không đọc được số video"
        elif not is_original and ORIGINAL_ONLY:
            _vi = "không phải Original Sound"
        elif posts <= MIN_POSTS:
            _vi = f"{_so(posts)} < {_so(MIN_POSTS)} video"
        else:
            _vi = f"{_so(posts)} > {_so(MAX_POSTS)} video"
        log(f'Bỏ "{_ten}" ({_vi})')
        emit_event("result", verdict="LOAI", name=name, posts=posts, original=is_original)

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
    """Chuan bi may: dong app + mo TikTok. Co retry vi buoc nay cung co the treo/loi."""
    for attempt in range(1, 4):
        try:
            kill_all_apps(d)
            pkg = ensure_tiktok_open(d)
            return pkg
        except Exception as e:
            log(f"⚠ Chuẩn bị máy lần {attempt} lỗi ({str(e)[:100]}) — thử lại...")
            reset_service(d)
            time.sleep(2)
    raise RuntimeError("Khong the mo TikTok sau 3 lan thu.")


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

        kq["visit"], kq["like_profile"] = PA.do_visit(
            d, tac_gia, VISIT_SEC_MIN, VISIT_SEC_MAX, log,
            like_video=bool(ans.get("like_profile")),
            vid_min=PROFILE_VID_MIN, vid_max=PROFILE_VID_MAX,
            hoi_o_lai=_o_lai,
        )

    # Not interested SAU CUNG: no doi feed.
    if ans.get("ni"):
        kq["ni"] = PA.tap_not_interested(d, log)
        if kq["ni"] == "ok":
            log("Đã bấm \"Not interested\" (%s)" % _VI_SAO_NI.get(ans.get("why", ""), "không rõ lý do"))

    if kq:
        bridge.acted(aid, **kq)


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

    d = connect(serial)
    log(f"✅ Đã kết nối {d.serial}.")
    emit_event("status", state="connected", serial=d.serial)
    reset_service(d)
    pkg = setup_device(d)
    # Ghi nho goi dang chay -> `find_first` chi cho MOT goi thay vi ca hai (xem chu thich o do).
    set_active_pkg(pkg)
    emit_event("status", state="app_open", pkg=pkg)

    limit = int(os.environ.get("LIMIT", "0"))
    count = 0
    qualified = 0
    consecutive_fail = 0
    # Dem so lan phai phuc hoi. Xem cho in ra o cuoi vong lap: day la van tay cua trieu chung
    # "1 may chay 1 may dung", va tu 2026-09-16 ca farm dung chung mot adb server nen no phai
    # do duoc, khong phai doan.
    recover_count = 0
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
            count += 1
            t_video = time.time()
            try:
                if dismiss_popups(d):
                    log("Đã đóng một hộp thoại chen ngang.")
                    time.sleep(1)

                # ── HOI TRUOC KHI BAM ICON SOUND ──
                # Gui cau hoi RUOC, lay cau tra loi SAU khi tu trang nhac quay ve. Quang 5-9
                # giay mo trang nhac che tron thoi gian di ve, nen duong binh thuong khong ton
                # them mili-giay nao.
                info = PA.read_video_info(d) if bridge.enabled else None

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
                    d.swipe(0.5, 0.85, 0.5, 0.15, random.uniform(0.15, 0.3))
                    time.sleep(random.uniform(0.8, 1.4))
                    continue

                aid = bridge.ask(**info) if info else None

                res, da_roi_feed = check_current_video(d)
                consecutive_fail = 0

                # ── LAY PHAN QUYET VA THI HANH ──
                if aid is not None:
                    ans = bridge.take(aid)
                    _thi_hanh(d, bridge, aid, ans, info, res, da_roi_feed)
            except Exception as e:
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
                    except Exception as e2:
                        log(f"⛔ Phục hồi lỗi ({str(e2)[:80]}) — nếu lặp lại thì máy này đang có vấn đề thật.")
                    consecutive_fail = 0
                    continue

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
                time.sleep(random.uniform(DWELL_MIN, DWELL_MAX))
                d.swipe(0.5, 0.85, 0.5, 0.15, random.uniform(0.15, 0.3))
                time.sleep(random.uniform(0.8, 1.4))
            except Exception as e:
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
    if live_bo_qua:
        _p.append(f"bỏ qua {live_bo_qua} livestream")
    if TRUOT["khong_icon"]:
        _p.append(f"{TRUOT['khong_icon']} video không có sound")
    if recover_count:
        _p.append(f"phục hồi {recover_count} lần")
    log("✅ Xong ca: " + ", ".join(_p) + ".")

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
    emit_event("status", state="done", checked=count, qualified=qualified)


if __name__ == "__main__":
    main()
