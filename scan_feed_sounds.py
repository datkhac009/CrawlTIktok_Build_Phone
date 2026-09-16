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
from adb_helper import connect, adb
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

WAIT_MUSIC_PAGE = 15     # giây, chờ trang nhạc mở sau khi bấm icon
SETTLE = 2.5             # giây, chờ số liệu (used_count) tải xong sau khi trang mở (tránh đọc "0 posts")
WAIT_SHARE_SHEET = 2
REST_AFTER_BACK = 1.5

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

# Chu ky: quet bao nhieu phut roi tu dung, NHA KHE cho may dang xep hang.
# Khong co chu ky thi voi "Gioi han video = 0" may chay mai va 13 may con lai cho vinh vien.
CYCLE_ON = os.environ.get("CYCLE_ON") == "1"
CYCLE_SCAN_MIN = float(os.environ.get("CYCLE_SCAN_MIN", "30") or 30)
VISIT_SEC_MIN = float(os.environ.get("VISIT_SEC_MIN", "4") or 4)
VISIT_SEC_MAX = float(os.environ.get("VISIT_SEC_MAX", "8") or 8)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


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


def find_first(d, ids, timeout=0):
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
        log(f"khong lay duoc danh sach app de kill: {str(e)[:80]}")
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
    log(f"da dong {len(pkgs)} app truoc khi bat dau")
    emit_event("status", state="apps_killed", count=len(pkgs))
    time.sleep(1.5)


def ensure_tiktok_open(d):
    """Đảm bảo TikTok đang mở và ở tiền cảnh. Trả về package đang dùng."""
    cur = d.app_current().get("package", "")
    if cur in PKGS:
        log(f"TikTok da mo san ({cur})")
        return cur
    installed = adb("shell", "pm", "list", "packages", serial=d.serial)
    pkg = next((p for p in PKGS if p in installed), None)
    if not pkg:
        raise RuntimeError("Khong tim thay TikTok (musically/trill) da cai tren may.")
    log(f"Man hinh ngoai ({cur or 'home'}) -> dang mo TikTok ({pkg})...")
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


def check_current_video(d):
    """App đang ở feed, đứng tại 1 video. Trả về (link, posts) nếu ĐẠT, None nếu không.
    Luôn back về feed trước khi return (trừ khi không tìm thấy icon sound -> vẫn ở feed)."""
    icon = find_first(d, SOUND_ICON_IDS, timeout=3)
    if icon is None:
        log("khong co icon sound tren video nay (bo qua)")
        return None
    icon.click()

    title_el = find_first(d, TITLE_IDS, timeout=WAIT_MUSIC_PAGE)
    if title_el is None:
        log("khong vao duoc trang nhac (bo qua video nay)")
        if MUSIC_ACTIVITY in d.app_current().get("activity", ""):
            d.press("back")
            time.sleep(REST_AFTER_BACK)
        return None

    time.sleep(SETTLE)
    desc = (title_el.info.get("contentDescription") or title_el.get_text() or "").strip()
    count_el = find_first(d, COUNT_IDS)
    posts = parse_count(count_el.get_text()) if count_el else None
    is_original = not any(kw in desc.lower() for kw in REJECT_KEYWORDS)
    name = extract_sound_name(desc)

    result = None
    if (is_original or not ORIGINAL_ONLY) and posts is not None and MIN_POSTS < posts < MAX_POSTS:
        link = get_link(d)
        if link:
            result = (link, posts, name)
            log(f"DAT  posts={posts:<8} {name} {link}")
            emit_event("result", verdict="DAT", name=name, url=link, posts=posts)
        else:
            log(f"DAT nhung khong lay duoc link (posts={posts})")
            emit_event("result", verdict="ERROR", name=name, posts=posts, msg="khong lay duoc link")
    else:
        log(f"LOAI original={is_original} posts={posts} desc={desc[:60]!r}")
        emit_event("result", verdict="LOAI", name=name, posts=posts, original=is_original)

    d.press("back")
    time.sleep(REST_AFTER_BACK)
    return result


def reset_service(d):
    """Khoi dong lai uiautomator2 SACH: don instrumentation cu con ton dong (moi lan kill
    tien trinh Python, ban tren may van song -> lan sau tranh chap service -> treo)."""
    try:
        d.reset_uiautomator()
        log("da reset uiautomator (service sach)")
        return True
    except Exception as e:
        log(f"reset uiautomator loi: {str(e)[:80]}")
        return False


def setup_device(d):
    """Chuan bi may: dong app + mo TikTok. Co retry vi buoc nay cung co the treo/loi."""
    for attempt in range(1, 4):
        try:
            kill_all_apps(d)
            pkg = ensure_tiktok_open(d)
            return pkg
        except Exception as e:
            log(f"setup lan {attempt} loi: {str(e)[:100]}")
            reset_service(d)
            time.sleep(2)
    raise RuntimeError("Khong the mo TikTok sau 3 lan thu.")


def _thi_hanh(d, bridge, aid, ans, info, res):
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
    handle = (info or {}).get("handle", "")
    kq = {}

    # Video da doi thi DUNG HET. Mac dinh an toan la khong bam.
    if (ans.get("ni") or ans.get("follow") or ans.get("like") or ans.get("visit")):
        if not PA.same_video(d, handle):
            log("video da doi sau khi quay lai feed -> KHONG bam gi (tranh bam nham nguoi)")
            bridge.acted(aid, ni="skip_changed_video", follow="skip_changed_video",
                         like="skip_changed_video", visit="skip_changed_video")
            return

    # FOLLOW chi khi sound HOP LE. Node cap quyen truoc, nhung dieu kien "sound hop le" thi
    # chi o day moi biet — `res` khac None nghia la sound da dat nguong.
    if ans.get("follow"):
        if res:
            kq["follow"] = PA.do_follow(d, log)
        else:
            kq["follow"] = "not_needed"

    if ans.get("like"):
        kq["like"] = PA.do_like(d, log)

    if ans.get("visit") and res:
        kq["visit"] = PA.do_visit(d, handle, VISIT_SEC_MIN, VISIT_SEC_MAX, log)

    # Not interested SAU CUNG: no doi feed.
    if ans.get("ni"):
        kq["ni"] = PA.tap_not_interested(d, log)
        if kq["ni"] == "ok":
            log("da bam 'Not interested' (ly do: %s)" % ans.get("why", "?"))

    if kq:
        bridge.acted(aid, **kq)


def main():
    serial = sys.argv[1] if len(sys.argv) > 1 else None

    # NGUYEN NHAN "1 may chay 1 may dung": nhieu tien trinh cung don lenh vao MOT adb server
    # (port mac dinh 5037) -> server nghen -> 1 tien trinh treo cung (khong phai cu jsonrpc
    # nen HTTP timeout khong cuu duoc). FIX: moi tien trinh dung 1 ADB SERVER RIENG (port
    # khac nhau, suy ra tu serial bang crc32 -> on dinh & rieng biet tung may).
    if serial and not os.environ.get("ANDROID_ADB_SERVER_PORT"):
        import zlib
        os.environ["ANDROID_ADB_SERVER_PORT"] = str(5100 + zlib.crc32(serial.encode()) % 800)
    adb_port = os.environ.get("ANDROID_ADB_SERVER_PORT", "5037")
    try:
        import uiautomator2.base as _b
        log(f"ADB server rieng port {adb_port}, HTTP_TIMEOUT={_b.HTTP_TIMEOUT}")
    except Exception:
        log(f"ADB server rieng port {adb_port}")
    if serial:
        try:
            adb("connect", serial)   # ket noi device tren adb server rieng nay
        except Exception as e:
            log(f"adb connect loi: {str(e)[:80]}")

    d = connect(serial)
    log(f"Ket noi: {d.serial}")
    emit_event("status", state="connected", serial=d.serial)
    reset_service(d)
    pkg = setup_device(d)
    emit_event("status", state="app_open", pkg=pkg)

    limit = int(os.environ.get("LIMIT", "0"))
    count = 0
    qualified = 0
    consecutive_fail = 0

    # Cay cau hoi/dap voi phia Node. Tat thi moi thu chay y het truoc khi co tinh nang nay.
    bridge = AskBridge(enabled=ASK_ON, log=log)
    if ASK_ON:
        log("loc & tuong tac: BAT (phan xet o phia app, may chi doc man hinh va thi hanh)")

    # Han chu ky. Het gio thi THOAT SACH de nha khe cho may dang xep hang.
    han_chu_ky = (time.time() + CYCLE_SCAN_MIN * 60) if CYCLE_ON else None
    if han_chu_ky:
        log("chu ky: quet %.0f phut roi tu dung, nhuong may khac" % CYCLE_SCAN_MIN)

    with open(OUTPUT_FILE, "a", encoding="utf-8") as f:
        while True:
            if limit and count >= limit:
                break
            if han_chu_ky and time.time() >= han_chu_ky:
                log("het ca chu ky -> dung, nha khe cho may dang cho")
                emit_event("status", state="cycle_done")
                break
            # Tien trinh cha da chet: truoc khi co kenh stdin, Electron chet la cac tien trinh
            # Python MO COI cu vuot may that mai mai, khong ai don. Gio phat hien duoc.
            if bridge.parent_gone:
                log("tien trinh cha da dong -> thoat")
                break
            count += 1
            try:
                if dismiss_popups(d):
                    log("da bo qua 1 popup")
                    time.sleep(1)

                # ── HOI TRUOC KHI BAM ICON SOUND ──
                # Gui cau hoi RUOC, lay cau tra loi SAU khi tu trang nhac quay ve. Quang 5-9
                # giay mo trang nhac che tron thoi gian di ve, nen duong binh thuong khong ton
                # them mili-giay nao.
                info = PA.read_video_info(d) if bridge.enabled else None
                aid = bridge.ask(**info) if info else None

                res = check_current_video(d)
                consecutive_fail = 0

                # ── LAY PHAN QUYET VA THI HANH ──
                if aid is not None:
                    ans = bridge.take(aid)
                    _thi_hanh(d, bridge, aid, ans, info, res)
            except Exception as e:
                consecutive_fail += 1
                log(f"loi video #{count}: {str(e)[:100]} (loi lien tiep {consecutive_fail})")
                res = None
                # Loi lien tiep -> service co the wedged: reset + mo lai TikTok (main thread,
                # hieu qua vi khong con cu RPC nao dang treo o day).
                if consecutive_fail >= 3:
                    log("phuc hoi: reset service + mo lai TikTok...")
                    emit_event("status", state="recover")
                    reset_service(d)
                    try:
                        setup_device(d)
                    except Exception as e2:
                        log(f"phuc hoi loi: {str(e2)[:80]}")
                    consecutive_fail = 0
                    continue

            if res:
                link, posts, name = res
                f.write(f"{link}\t{posts}\n")
                f.flush()
                qualified += 1

            emit_event("progress", checked=count, qualified=qualified)

            # dwell ngau nhien truoc khi sang video ke (tranh bi TikTok coi la bot)
            try:
                time.sleep(random.uniform(DWELL_MIN, DWELL_MAX))
                d.swipe(0.5, 0.85, 0.5, 0.15, random.uniform(0.15, 0.3))
                time.sleep(random.uniform(1.5, 2.5))
            except Exception as e:
                log(f"loi swipe #{count}: {str(e)[:100]} (bo qua, thu tiep)")

    log(f"XONG. Da check {count} video, DAT {qualified}. Ket qua: {OUTPUT_FILE}")
    emit_event("status", state="done", checked=count, qualified=qualified)


if __name__ == "__main__":
    main()
