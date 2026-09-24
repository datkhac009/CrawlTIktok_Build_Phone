"""
tim_tu_khoa.py — Pha TÌM THEO TỪ KHÓA của bản phone (2026-09-24).

Bản PC (`src/feeds/feedSearch.cjs`): MỘT từ khóa → tab Videos → bấm video đầu → cuộn trình phát
y như For You tới khi bấm Dừng. Bản phone đi đúng đường đó trên app TikTok thật, và thêm những thứ
bản PC không có:
  - DANH SÁCH từ khóa, quét lần lượt; mỗi từ tối đa N video rồi sang từ kế;
  - vuốt mà video không đổi (hết kết quả) thì sang từ kế sớm;
  - mỗi máy bắt đầu ở một từ khác nhau và nhớ mốc theo máy (main.js) — 38 máy cùng quét MỘT từ
    thì chỉ ra cùng một bộ video, đúng thứ làm 84% sound đạt lọc bị trùng (đo 2026-09-23).

ĐO THẬT trên Pixel 4 XL (TikTok 46.9.3, 2026-09-24) trước khi viết:
  - `snssdk1233://search?keyword=<từ>` mở thẳng `SearchResultActivity`. Link
    `https://www.tiktok.com/search?q=…` thì KHÔNG — máy đứng nguyên ở màn hình chính.
  - Tab "Videos" (content-desc) → lưới ô `vjp`; tab Top dùng ô `vh0`. Tên id bị làm rối, đổi theo
    bản TikTok — nên còn một đường dự phòng không cần id (`_o_dau`).
  - Bấm ô → `DetailActivity` có `videomusiccoverblock` + `user_avatar` y như feed. Bấm sound →
    trang nhạc (tên + số post) → Back về ĐÚNG trình phát; `d.swipe` sang video kế được. Tức là
    toàn bộ đường đọc sound của For You (`check_current_video`) dùng lại nguyên được.
  - Back từ trình phát → về lại lưới kết quả.

File này chỉ lo ĐIỀU HƯỚNG (mở từ, vào trình phát, đọc chữ video). Việc quét, xoay từ, phục hồi
nằm ở `scan_feed_sounds.py` — đi chung vòng quét For You để khỏi viết lại đường xử lý lỗi.
"""
import time
from urllib.parse import quote

ACT_KET_QUA = "SearchResultActivity"
ACT_TRINH_PHAT = "DetailActivity"
ACT_TRANG_NHAC = "MusicDetailActivity"

# Scheme deep link của từng gói TikTok (bản quốc tế / bản châu Á).
SCHEME = {"com.zhiliaoapp.musically": "snssdk1233", "com.ss.android.ugc.trill": "snssdk1180"}

# Tab video của trang kết quả — giao diện tiếng Anh / tiếng Việt (HD1911 `.112` để tiếng Việt).
TAB_VIDEO = ("Videos", "Video")
# Ô video trong lưới kết quả (46.9.3): tab Videos rồi tới tab Top.
O_KET_QUA = ("vjp", "vh0")


def doc_tu_khoa(raw):
    """Mỗi dòng một từ khóa. Bỏ dòng trống, gộp trùng không phân biệt hoa thường, GIỮ dấu '#'
    (hashtag là từ khóa hợp lệ). Nhận cả chuỗi lẫn danh sách."""
    dong = raw if isinstance(raw, list) else str(raw or "").splitlines()
    ra, da_co = [], set()
    for x in dong:
        tu = " ".join(str(x).split())
        if tu and tu.lower() not in da_co:
            da_co.add(tu.lower())
            ra.append(tu)
    return ra


def link_tim(pkg, tu):
    """Deep link mở trang kết quả tìm kiếm. Mã hoá TOÀN BỘ từ khóa: dấu cách, '#', '&' đều phải
    thành %xx, không thì app cắt từ khóa ở đó."""
    return f"{SCHEME.get(pkg, 'snssdk1233')}://search?keyword={quote(tu, safe='')}"


def activity(d):
    """TÊN activity đang ở trước mặt — phần sau dấu chấm cuối, vd "DetailActivity".

    ⚠ So TÊN, không dùng `endswith`: "MusicDetailActivity" (trang nhạc) cũng kết thúc bằng
    "DetailActivity" (trình phát) — so đuôi là đứng ở trang nhạc mà tưởng đang ở trình phát.
    Phép thử 2f bắt được đúng lỗi này ở bản viết đầu."""
    try:
        a = (d.app_current() or {}).get("activity") or ""
    except Exception:
        return ""
    return a.rsplit(".", 1)[-1]


def o_trinh_phat(d):
    """Đang đứng ở trình phát video của kết quả tìm kiếm không. Xét theo ACTIVITY, không đòi nút
    sound: bài ảnh trong kết quả không có nút sound mà vẫn là đang ở đúng chỗ."""
    return activity(d) == ACT_TRINH_PHAT


def chu_video(d, pkg):
    """Caption của video đang phát — để nhận ra "vuốt mà không sang video mới" (hết kết quả)."""
    try:
        o = d(resourceId=f"{pkg}:id/desc")
        return (o.get_text(timeout=1) or "").strip() if o.exists else ""
    except Exception:
        return ""


def _ra_khoi_tim_cu(d):
    """Lùi ra khỏi màn tìm kiếm cũ trước khi mở từ mới: mở chồng deep link lên nhau suốt 2 giờ thì
    TikTok giữ cả chồng activity trong RAM."""
    for _ in range(4):
        if activity(d) not in (ACT_KET_QUA, ACT_TRINH_PHAT, ACT_TRANG_NHAC):
            return
        d.press("back")
        time.sleep(0.8)


def _bam_tab_video(d):
    for t in TAB_VIDEO:
        for sel in (dict(description=t), dict(text=t)):
            try:
                o = d(**sel)
                if o.exists:
                    o.click()
                    time.sleep(2.5)
                    return True
            except Exception:
                pass
    return False


def _o_dau(d, pkg, cho=6.0):
    """Ô video đầu tiên của lưới kết quả. Thử theo id trước; bản TikTok đổi id thì lấy ô bấm được
    lớn nhất ở nửa trên màn hình (ô video chiếm nửa bề ngang, cao hơn hẳn mọi nút khác)."""
    han = time.time() + cho
    while time.time() < han:
        for r in O_KET_QUA:
            try:
                o = d(resourceId=f"{pkg}:id/{r}")
                if o.exists:
                    return o
            except Exception:
                pass
        time.sleep(0.6)
    try:
        rong, cao = d.window_size()
        tot, dien_tich = None, 0
        for o in d(clickable=True):
            b = o.info.get("bounds") or {}
            w, h = b.get("right", 0) - b.get("left", 0), b.get("bottom", 0) - b.get("top", 0)
            if b.get("top", 0) > cao * 0.12 and w >= rong * 0.4 and h >= cao * 0.25 and w * h > dien_tich:
                tot, dien_tich = o, w * h
        return tot
    except Exception:
        return None


def mo_tu(d, pkg, tu, cho=12.0):
    """Mở kết quả tìm kiếm của `tu` rồi vào trình phát ở video đầu. True = đã đứng ở trình phát."""
    _ra_khoi_tim_cu(d)
    try:
        # Truyền dạng DANH SÁCH (như `_mo_link`): link có `?`, ghép chuỗi là shell cắt ngang.
        d.shell(["am", "start", "-a", "android.intent.action.VIEW", "-d", link_tim(pkg, tu), pkg])
    except Exception:
        return False
    han = time.time() + cho
    while time.time() < han and activity(d) != ACT_KET_QUA:
        time.sleep(0.8)
    if activity(d) != ACT_KET_QUA:
        return False
    time.sleep(2.0)
    # Không thấy tab Videos (giao diện ngôn ngữ khác) thì ở lại tab Top — bản PC cũng vậy.
    _bam_tab_video(d)
    o = _o_dau(d, pkg)
    if o is None:
        return False
    try:
        o.click()
    except Exception:
        return False
    han = time.time() + 10
    while time.time() < han:
        if o_trinh_phat(d):
            return True
        time.sleep(0.8)
    return False
