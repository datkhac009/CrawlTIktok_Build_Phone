"""phone_actions.py — Đọc chữ trên màn hình và thi hành cú bấm. KHÔNG chứa luật nào.

VÌ SAO TÁCH RA (2026-09-15)
===========================
`scan_feed_sounds.py` lo vòng quét sound. File này lo phần "đọc màn hình + bấm nút", để khi
TikTok đổi giao diện thì chỉ phải sửa một chỗ.

⚠ KHÔNG CÓ LUẬT NÀO TRONG FILE NÀY.
Danh sách nhãn nút đến từ biến môi trường do `runner.cjs` dựng từ `src/uilabels.cjs` — nguồn duy
nhất, dùng chung với bản PC. Quyết định bấm hay không do phía Node đưa xuống qua `askbridge`.
Chép danh sách nhãn vào đây là tái lập đúng lỗi đã xảy ra với `linkkey.cjs`.

⚠ VÌ SAO KHỚP TRỌN CHUỖI CHỨ KHÔNG PHẢI "CÓ CHỨA"
`uilabels.cjs:40-42` ghi rõ: khớp kiểu chứa thì "Followers 1.2M" cũng thành nút Follow. Biểu
thức truyền xuống đây đã ở dạng `(?i)^(...)$`.

⚠ XÁC MINH SAU KHI BẤM
Bấm xong phải đọc lại nhãn nút. `channelstore.cjs:182-184` cảnh báo: ghi sổ lúc BẤM thay vì lúc
đã xác minh thì kênh bị đánh dấu đã follow dù follow hỏng, và **bị bỏ qua vĩnh viễn**.
"""
import os
import random
import re
import time
import xml.etree.ElementTree as ET

RE_FOLLOW = os.environ.get("RE_FOLLOW", "(?!)")
RE_FOLLOWING = os.environ.get("RE_FOLLOWING", "(?!)")
RE_NOT_INTERESTED = os.environ.get("RE_NOT_INTERESTED", "(?!)")

# `(?i)` ở đầu là cú pháp chung của cả Java (uiautomator2 dùng) lẫn Python, nên một chuỗi dùng
# được cho cả hai phía.
_py_follow = re.compile(RE_FOLLOW)
_py_following = re.compile(RE_FOLLOWING)

# Handle TikTok: chữ thường, số, dấu chấm, gạch dưới, tối đa 30 ký tự. Khớp ĐÚNG luật của
# `followpolicy.cjs` — nơi kia mới là nguồn sự thật, đây chỉ để nhặt ứng viên trên màn hình.
_RE_HANDLE = re.compile(r"^@[A-Za-z0-9._]{1,30}$")

MAX_DESC = 500
MAX_BADGES = 10
MAX_BADGE_LEN = 120


def _leaf_texts(xml_str):
    """Lấy chữ của các node LÁ (không có con). Trả danh sách theo thứ tự xuất hiện.

    Dùng node lá vì node cha gộp chữ của mọi con lại — lấy node cha là trộn caption, tên sound,
    số like vào một chuỗi rồi mọi phép khớp đều sai.
    """
    out = []
    try:
        root = ET.fromstring(xml_str)
    except Exception:
        return out
    for node in root.iter():
        if len(node) > 0:
            continue                      # không phải lá
        for key in ("text", "content-desc"):
            v = (node.get(key) or "").strip()
            if v and v not in out:
                out.append(v)
    return out


def read_video_info(d):
    """Đọc thông tin video đang hiển thị trên feed.

    ⚠ HẠN CHẾ ĐÃ BIẾT: chưa dò được resource-id của caption và tên tác giả trên máy thật, nên
    đây là phỏng đoán theo hình dạng: handle là chuỗi dạng `@abc`, caption là chuỗi dài nhất.
    Bản PC đọc chính xác hơn vì có neo `[data-e2e="video-desc"]` đã dò thật.

    Hệ quả: khớp theo TÊN HIỂN THỊ của tác giả (thứ mà `langfilter` cũng xét) yếu hơn bản PC.
    Hướng sai ở đây là BỎ SÓT, không phải bắt nhầm — chấp nhận được.
    """
    try:
        xml_str = d.dump_hierarchy()
    except Exception:
        return {"author": "", "handle": "", "desc": "", "badges": []}

    texts = _leaf_texts(xml_str)
    handle = next((t for t in texts if _RE_HANDLE.match(t)), "")

    # Caption = chuỗi DÀI NHẤT không phải handle. Ngưỡng 15 ký tự để khỏi nhận nhầm nhãn nút.
    ung_vien = [t for t in texts if t != handle and len(t) >= 15]
    desc = max(ung_vien, key=len) if ung_vien else ""

    # Ứng viên nhãn: chuỗi NGẮN, không phải caption. Phía Node quyết cái nào là nhãn AI.
    badges = [t for t in texts if t != desc and len(t) <= MAX_BADGE_LEN][:MAX_BADGES]

    return {
        # `langfilter` cần TÊN HIỂN THỊ + @handle nối nhau (langfilter.cjs:98-99). Chưa tách được
        # tên hiển thị nên tạm chỉ có handle.
        "author": handle,
        "handle": handle,
        "desc": desc[:MAX_DESC],
        "badges": badges,
    }


def _find_by_regex(d, pattern, timeout=0):
    """Tìm phần tử theo chữ hiện trên nó, thử cả `text` lẫn `content-desc`."""
    for kw in ({"textMatches": pattern}, {"descriptionMatches": pattern}):
        try:
            el = d(**kw)
            if timeout:
                if el.wait(timeout=timeout):
                    return el
            elif el.exists:
                return el
        except Exception:
            continue
    return None


def do_follow(d, log=lambda s: None):
    """Bấm Follow rồi XÁC MINH. Trả 'ok' | 'fail' | 'not_needed'.

    'not_needed' khi nút đã ở trạng thái Following — không phải lỗi, và KHÔNG được tính là
    thành công để ghi sổ, vì ta đâu có follow ai.
    """
    if _find_by_regex(d, RE_FOLLOWING):
        return "not_needed"
    btn = _find_by_regex(d, RE_FOLLOW, timeout=3)
    if btn is None:
        log("khong thay nut Follow tren man hinh nay")
        return "fail"
    try:
        btn.click()
    except Exception as e:
        log("bam Follow loi: %s" % str(e)[:80])
        return "fail"

    # XÁC MINH: nút phải đổi sang trạng thái "đã theo dõi". Không đổi = không follow được
    # (TikTok chặn, mạng rớt, bấm trượt). Báo 'fail' để phía Node KHÔNG ghi sổ.
    time.sleep(1.2)
    for _ in range(3):
        if _find_by_regex(d, RE_FOLLOWING):
            return "ok"
        time.sleep(0.8)
    log("da bam Follow nhung nut KHONG doi trang thai -> coi la that bai")
    return "fail"


def do_like(d, log=lambda s: None):
    """Thả tim bằng cách nhấn đúp giữa màn hình. Trả 'ok' | 'fail'.

    ⚠ KHÔNG xác minh được chắc chắn: icon tim của TikTok không lộ trạng thái ổn định qua
    uiautomator. Nên 'ok' ở đây nghĩa là "đã thực hiện thao tác", yếu hơn 'ok' của follow. Vì
    tym là thao tác HOÀN TÁC ĐƯỢC nên mức bảo đảm thấp hơn chấp nhận được; follow thì không.
    """
    try:
        w, h = d.window_size()
        d.double_click(w * 0.5, h * 0.45)
        time.sleep(0.6)
        return "ok"
    except Exception as e:
        log("tha tim loi: %s" % str(e)[:80])
        return "fail"


def tap_not_interested(d, log=lambda s: None):
    """Nhấn giữ video rồi chọn "Not interested". Trả 'ok' | 'fail'.

    ⚠ CÚ BẤM NÀY DẠY FEED VĨNH VIỄN, KHÔNG HOÀN TÁC. Bản PC đã trả giá đúng chỗ này (QĐ-31:
    5/10 cú bấm trúng kênh không liên quan). Nên nếu không thấy đúng mục thì THOÁT RA, tuyệt đối
    không bấm bừa mục nào khác trong menu.
    """
    try:
        w, h = d.window_size()
        d.long_click(w * 0.5, h * 0.45, 0.8)
        time.sleep(1.2)
    except Exception as e:
        log("nhan giu loi: %s" % str(e)[:80])
        return "fail"

    item = _find_by_regex(d, RE_NOT_INTERESTED, timeout=3)
    if item is None:
        log("khong thay muc 'Not interested' trong menu -> thoat, KHONG bam gi")
        try:
            d.press("back")
            time.sleep(0.6)
        except Exception:
            pass
        return "fail"
    try:
        item.click()
        time.sleep(1.0)
        return "ok"
    except Exception as e:
        log("bam 'Not interested' loi: %s" % str(e)[:80])
        return "fail"


def do_visit(d, handle, sec_min=4, sec_max=8, log=lambda s: None):
    """Mở trang cá nhân tác giả, vuốt vài giây rồi quay lại feed. Trả 'ok' | 'fail'.

    Đi qua @handle hiện trên feed. Xong thì `back` về ĐÚNG vị trí feed cũ — đây là lý do dùng
    back chứ không mở lại app: mở lại là mất vị trí cuộn và TikTok nạp feed mới.
    """
    if not handle:
        return "fail"
    el = None
    try:
        el = d(text=handle)
        if not el.exists:
            el = None
    except Exception:
        el = None
    if el is None:
        log("khong thay @handle tren feed de ghe tham")
        return "fail"
    try:
        el.click()
        time.sleep(2.0)
        han = time.time() + random.uniform(sec_min, sec_max)
        while time.time() < han:
            d.swipe(0.5, 0.75, 0.5, 0.35, random.uniform(0.2, 0.35))
            time.sleep(random.uniform(0.8, 1.4))
        d.press("back")
        time.sleep(1.2)
        return "ok"
    except Exception as e:
        log("ghe tham loi: %s" % str(e)[:80])
        try:
            d.press("back")
        except Exception:
            pass
        return "fail"


def same_video(d, handle):
    """Video đang hiển thị có còn là video đã hỏi không.

    ⚠ VÌ SAO CẦN: sau khi vào trang nhạc rồi `back`, feed CÓ THỂ đã nhảy sang video khác. Bấm
    lúc đó là bấm nhầm người. Đây không phải rủi ro của kênh hỏi/đáp mà là rủi ro thật của
    chính tính năng. Không chắc thì trả False — mặc định an toàn là KHÔNG bấm.
    """
    if not handle:
        return False
    try:
        return d(text=handle).exists
    except Exception:
        return False
