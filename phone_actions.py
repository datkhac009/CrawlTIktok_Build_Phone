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


def _attrs_by_id(xml_str):
    """Gom `text` / `content-desc` theo resource-id (đã cắt tiền tố gói).

    Khác `_leaf_texts`: hàm kia chỉ lấy node LÁ, mà hai neo quan trọng nhất của feed —
    `user_avatar` và `long_press_layout` — đều là node BỌC, nên node lá không bao giờ thấy chúng.
    """
    out = {}
    try:
        root = ET.fromstring(xml_str)
    except Exception:
        return out
    for node in root.iter():
        rid = node.get("resource-id") or ""
        if not rid:
            continue
        key = rid.split(":id/")[-1]
        if key in out:
            continue                      # lấy node ĐẦU TIÊN: video đang hiển thị nằm trên cùng
        out[key] = {
            "text": (node.get("text") or "").strip(),
            "desc": (node.get("content-desc") or "").strip(),
        }
    return out


# Tên tác giả nằm trong `content-desc` dạng "<Tên> profile" (avatar) hoặc "Follow <Tên>" (nút
# follow trên feed). Đo trên máy thật 2026-09-16, TikTok v46.1.1 — xem `probe_screen.py`.
_RE_AVATAR = re.compile(r"^(.*?)\s+profile$", re.I)
_RE_NUT_FOLLOW = re.compile(r"^follow\s+(.+)$", re.I)


def _ten_tac_gia(attrs):
    """Tên HIỂN THỊ của chủ video. Chuỗi rỗng nếu không đọc được.

    ⚠ ĐÂY KHÔNG PHẢI @handle. Feed TikTok v46.1.1 **không bày @handle ở đâu cả** — grep thẳng
    bản chụp XML không có một chuỗi `text="@..."` nào. @handle chỉ có trên TRANG CÁ NHÂN, và
    `scan_feed_sounds.py` phải ghé vào đó mới lấy được (xem `open_profile_read_handle`).

    Hai neo, thử theo thứ tự. Neo thứ hai không thừa: khi tác giả ĐÃ được follow thì nút đổi chữ
    thành "Following ..." nên `_RE_NUT_FOLLOW` trượt, nhưng avatar thì luôn còn.
    """
    av = attrs.get("user_avatar", {}).get("desc", "")
    m = _RE_AVATAR.match(av)
    if m and m.group(1).strip():
        return m.group(1).strip()
    if av:
        return av        # máy để ngôn ngữ khác: đuôi không phải "profile", vẫn hơn là rỗng
    m = _RE_NUT_FOLLOW.match(attrs.get("ife", {}).get("desc", ""))
    return m.group(1).strip() if m else ""


def _dang_live(attrs):
    """Video đang hiển thị có phải LIVESTREAM không.

    Neo là `long_press_layout`: video thường mang `content-desc="Video"`, còn livestream mang
    `"LIVE"`. Chọn đúng neo này vì nó là id ĐỌC ĐƯỢC — hai ứng viên khác (`zxp` "Tap to watch
    LIVE", `i1i` "LIVE now") là id đã bị làm rối, đổi tên theo từng bản TikTok.
    """
    return attrs.get("long_press_layout", {}).get("desc", "").strip().upper() == "LIVE"


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
        return {"author": "", "handle": "", "desc": "", "badges": [], "live": False}

    attrs = _attrs_by_id(xml_str)
    live = _dang_live(attrs)
    tac_gia = _ten_tac_gia(attrs)

    texts = _leaf_texts(xml_str)
    handle = next((t for t in texts if _RE_HANDLE.match(t)), "")

    # Caption = chuỗi DÀI NHẤT không phải handle. Ngưỡng 15 ký tự để khỏi nhận nhầm nhãn nút.
    ung_vien = [t for t in texts if t != handle and len(t) >= 15]
    desc = max(ung_vien, key=len) if ung_vien else ""

    # Ứng viên nhãn: chuỗi NGẮN, không phải caption. Phía Node quyết cái nào là nhãn AI.
    badges = [t for t in texts if t != desc and len(t) <= MAX_BADGE_LEN][:MAX_BADGES]

    return {
        # `langfilter` cần TÊN HIỂN THỊ + @handle nối nhau (langfilter.cjs:98-99). Từ 2026-09-16
        # đã đọc được tên hiển thị THẬT từ `user_avatar`, nên bộ lọc ngôn ngữ mạnh hơn hẳn bản cũ
        # (bản cũ nhét @handle vào ô author, mà @handle thì feed không hề có -> luôn rỗng).
        "author": (tac_gia + (" " + handle if handle else "")).strip(),
        # Gần như LUÔN rỗng trên feed — giữ lại cho đủ hình dạng câu hỏi và cho máy nào có bố cục
        # khác. @handle thật lấy ở `open_profile_read_handle`.
        "handle": handle,
        "desc": desc[:MAX_DESC],
        "badges": badges,
        "live": live,
    }


def _bounds(node):
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds") or "")
    return tuple(int(x) for x in m.groups()) if m else None


def _chu_cua(node):
    return ((node.get("text") or "").strip(), (node.get("content-desc") or "").strip())


def tim_nut_follow(d, pattern):
    """Tìm NÚT follow/following thật trên trang cá nhân. Trả (x, y) để bấm, hoặc None.

    ⚠ VÌ SAO KHÔNG DÙNG `_find_by_regex(..., clickable=True)` NỮA (2026-09-16):
    Trang cá nhân TikTok có HAI kiểu dựng nút, đo được cả hai trên cùng một máy:
        probe_profile_..._1.xml:  <Button  text="Follow"  clickable="true">
        probe_profile_..._2.xml:  <TextView text="Follow"  clickable="false">   ← chữ nằm TRONG
                                                                                  khung bấm được
    Đòi `clickable=True` thì kiểu thứ hai trượt, và log báo "khong thay nut Follow bam duoc" —
    đúng thứ vừa gặp khi chạy thật. Bỏ đòi hỏi đó ra thì lại dính **nhãn thống kê**
    "Following / Followers" (đếm số người), vì chữ của nó cũng đúng bằng "Following".

    Nên phân biệt bằng NGỮ CẢNH, không bằng một thuộc tính đơn lẻ: nút thật nằm trong một khung
    bấm được mà trong khung đó KHÔNG có chữ "Followers". Cụm thống kê thì luôn có, vì
    "Following" và "Followers" là hai ô cạnh nhau của cùng một hàng.
    """
    try:
        root = ET.fromstring(d.dump_hierarchy())
    except Exception:
        return None
    re_khop = re.compile(pattern)
    re_followers = re.compile(r"^followers$", re.I)
    # Ô thống kê LUÔN kèm một con số ("1234" / "12.3K" / "1.2M") trong cùng khung bấm được —
    # đó là số người. Nút Follow thì không bao giờ có số bên trong.
    #
    # ⚠ Vì sao phải thêm luật này: đo trên bản chụp thật, mỗi ô thống kê là MỘT khung bấm riêng,
    # nên luật "cùng khung có chữ Followers" không bắt được ô "Following". Hậu quả nếu lọt: hàm
    # tưởng đã theo dõi rồi -> `do_follow` trả 'not_needed' -> KHÔNG BAO GIỜ follow được ai,
    # trong im lặng. Đúng con bọ đã mất cả buổi để tìm ra.
    re_so = re.compile(r"^[\d.,]+\s*[KMBkmb]?$")

    # Bản đồ con -> cha, để leo ngược tìm khung bấm được.
    cha = {con: me for me in root.iter() for con in me}

    for node in root.iter():
        if not any(re_khop.match(c) for c in _chu_cua(node) if c):
            continue
        # Leo lên tối đa 4 tầng tìm khung bấm được (gồm chính nó).
        khung = node
        for _ in range(4):
            if (khung.get("clickable") or "") == "true":
                break
            khung = cha.get(khung)
            if khung is None:
                break
        if khung is None or (khung.get("clickable") or "") != "true":
            continue
        # Ô thống kê: cùng khung có chữ "Followers", HOẶC có một con số. Bỏ qua cả hai.
        chu_trong_khung = [c for hau in khung.iter() for c in _chu_cua(hau) if c]
        if any(re_followers.match(c) for c in chu_trong_khung):
            continue
        if any(re_so.match(c) for c in chu_trong_khung):
            continue
        b = _bounds(node) or _bounds(khung)
        if b:
            return ((b[0] + b[2]) // 2, (b[1] + b[3]) // 2)
    return None


def _find_by_regex(d, pattern, timeout=0, clickable=None):
    """Tìm phần tử theo chữ hiện trên nó, thử cả `text` lẫn `content-desc`.

    `clickable=True` để chỉ nhận phần tử BẤM ĐƯỢC.

    ⚠ VÌ SAO CẦN THAM SỐ ĐÓ (2026-09-16):
    Trên TRANG CÁ NHÂN, chữ "Following" xuất hiện HAI nơi: nút theo dõi, và **nhãn thống kê**
    "Following / Followers" đếm số người. Khớp trọn chuỗi vẫn dính nhãn thống kê, vì nó đúng
    bằng chữ "Following". Hậu quả đo được trên máy thật: `do_follow` thấy "Following" tưởng đã
    theo dõi rồi nên trả 'not_needed' NGAY, và **không bao giờ follow được ai** — im lặng, không
    lỗi. Đây đúng là cái bẫy `uilabels.cjs:40-42` cảnh báo ("Followers 1.2M" hoá thành nút
    Follow), chỉ ở một góc mà khớp-trọn-chuỗi không cứu được.
    Thứ phân biệt là `clickable`: nút thật bấm được, nhãn thống kê thì không.
    """
    for kw in ({"textMatches": pattern}, {"descriptionMatches": pattern}):
        if clickable is not None:
            kw = dict(kw, clickable=clickable)
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
    # `tim_nut_follow` phân biệt nút thật với nhãn thống kê bằng NGỮ CẢNH — xem lý do dài ở đó.
    if tim_nut_follow(d, RE_FOLLOWING):
        return "not_needed"
    diem = tim_nut_follow(d, RE_FOLLOW)
    if diem is None:
        time.sleep(1.5)                     # trang có thể chưa dựng xong; thử lại một nhịp
        diem = tim_nut_follow(d, RE_FOLLOW)
    if diem is None:
        log("khong thay nut Follow tren man hinh nay")
        return "fail"
    try:
        d.click(*diem)
    except Exception as e:
        log("bam Follow loi: %s" % str(e)[:80])
        return "fail"

    # XÁC MINH: nút phải đổi sang trạng thái "đã theo dõi". Không đổi = không follow được
    # (TikTok chặn, mạng rớt, bấm trượt). Báo 'fail' để phía Node KHÔNG ghi sổ.
    #
    # ⚠ `clickable=True` ở đây CÒN QUAN TRỌNG HƠN chỗ trên: nhãn thống kê "Following" lúc nào
    # cũng có mặt trên trang cá nhân, nên thiếu nó thì phép xác minh LUÔN nói "ok" — kể cả khi
    # cú bấm trượt hoàn toàn. Sổ sẽ ghi một cú follow chưa từng xảy ra, và kênh đó bị đánh dấu
    # đã follow VĨNH VIỄN (channelstore.cjs:182-184).
    time.sleep(1.2)
    for _ in range(3):
        if tim_nut_follow(d, RE_FOLLOWING):
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


def _o_luoi_video(d):
    """Toa do giua cua cac o video HIEN DAY DU tren luoi trang ca nhan. Rong = khong thay luoi.

    Neo la `cover` — resource-id KHONG bi lam roi. Do tren ban chup that
    (`probe_profile_..._141113_2.xml`): 6 node `cover`, moi cai nam trong mot khung bam duoc,
    trong mot `GridView`. Cac id anh em (`erf`, `hui`) deu la id da bi lam roi nen se doi ten o
    ban TikTok sau — khong duoc bam vao chung.

    Loc bang HINH HOC chu khong bang chu, nen khong phu thuoc ngon ngu may:
      - O luoi that rong dung 1/3 be ngang man hinh (do duoc: 358 tren man 1080).
      - Hang duoi cung thuong bi CAT CUT (cao 103 thay vi 477). Bam vao o cut la cuon chu khong
        phai mo video, nen bo.
    """
    try:
        root = ET.fromstring(d.dump_hierarchy())
    except Exception:
        return []
    cha = {con: me for me in root.iter() for con in me}
    try:
        w, h = d.window_size()
    except Exception:
        return []

    thay = []
    for node in root.iter():
        if (node.get("resource-id") or "").split(":id/")[-1] != "cover":
            continue
        khung = node
        for _ in range(3):                      # leo toi da 3 tang tim khung bam duoc
            if (khung.get("clickable") or "") == "true":
                break
            khung = cha.get(khung)
            if khung is None:
                break
        if khung is None or (khung.get("clickable") or "") != "true":
            continue
        b = _bounds(khung)
        if not b:
            continue
        bw, bh = b[2] - b[0], b[3] - b[1]
        if not (0.28 * w <= bw <= 0.36 * w):    # khong phai o cua luoi 3 cot
            continue
        thay.append((bh, (b[0] + b[2]) // 2, (b[1] + b[3]) // 2))

    if not thay:
        return []
    cao_nhat = max(x[0] for x in thay)
    return [(cx, cy) for bh, cx, cy in thay
            if bh >= 0.6 * cao_nhat and 0.15 * h < cy < 0.90 * h]


def _o_tren_feed(d):
    """Dang o FEED hay khong.

    ⚠ KHONG dung `long_press_layout` lam neo: TRINH XEM STORY cung co no (do duoc tren
    `probe_profile_..._141059_1.xml`). Lay no lam neo la co luc tuong da ve feed trong khi dang
    dung trong story cua nguoi ta, roi moi thao tac sau deu sai cho.
    Neo dung: `user_avatar` VA `videomusiccoverblock` — 2/2 ban chup feed co ca hai, 0/3 ban chup
    ngoai feed co `user_avatar`.

    ⚠ VIDEO LIVE TREN FEED VAN LA FEED, nhung no KHONG co `user_avatar`. Do duoc tren ban chup:
        feed thuong   long_press_layout.desc='Video'  user_avatar=co
        feed LIVE     long_press_layout.desc='LIVE'   user_avatar=KHONG
        story viewer  long_press_layout.desc=''       user_avatar=KHONG
    Thieu nhanh nay thi `_ve_feed` se back du 3 nhip roi bao "khong ve duoc feed" trong khi may
    dang dung dung o feed — bao dong gia, va bao dong gia day nguoi ta bo qua bao dong that.
    Chinh `desc` la thu tach feed-LIVE khoi story viewer.
    """
    try:
        attrs = _attrs_by_id(d.dump_hierarchy())
    except Exception:
        return False
    if "user_avatar" in attrs and "videomusiccoverblock" in attrs:
        return True
    return attrs.get("long_press_layout", {}).get("desc", "").strip().upper() == "LIVE"


def _ve_feed(d, log=lambda s: None):
    """Back cho toi khi THAT SU ve duoc feed, toi da 3 nhip.

    ⚠ VI SAO PHAI LAP (2026-09-17): ngan xep gio sau hon truoc — feed -> trang ca nhan -> video.
    Mot `back` chi ve toi luoi. Va 1/3 lan ghe roi vao tam "Viewer history turned on"
    (`probe_profile_..._141129_3.xml`) nuot them mot `back` nua.
    MOI nhip di qua `close_profile` de giu nguyen lop thoat phong LIVE.
    """
    for _ in range(3):
        close_profile(d, log)
        if _o_tren_feed(d):
            return True
    log("ghe tham xong KHONG ve duoc feed - vong quet ke tiep se sai cho")
    return False


def do_visit(d, author, sec_min=5, sec_max=10, log=lambda s: None,
             like_video=False, vid_min=3.0, vid_max=7.0):
    """Ghe trang ca nhan -> luot vai giay -> mo MOT video NGAU NHIEN trong luoi -> xem vai giay
    -> (co the) tym -> ve feed.

    Tra ve CAP: ("ok" | "ok_no_grid" | "fail",  "ok" | "fail" | "not_needed").

    ⚠ ĐỔI CÁCH MỞ TRANG HAI LẦN TRONG NGÀY 2026-09-16, cả hai đều do đo trên máy thật:
      1. Bản gốc bấm `d(text=@handle)` trên feed. Feed TikTok v46.1.1 **không bày @handle ở đâu
         cả**, nên phép tìm luôn trượt và ghé thăm luôn trả 'fail'.
      2. Bản kế bấm AVATAR. Nhưng tác giả đang có story thì avatar mở STORY, không mở trang cá
         nhân — và ghé xong không đọc được @handle.
    Giờ dùng `_mo_trang_ca_nhan` (vuốt sang trái, kéo từng điểm), chung một đường với
    `open_profile_read_handle` nên hai nơi không thể lệch nhau.

    ⚠ BẢN CŨ CHỈ CUỘN SUÔNG (2026-09-17): nó vuốt dọc lưới 4-8 giây rồi `back`, không mở video
    nào, không xác nhận vào đúng trang ai, và KHÔNG đi qua `close_profile` nên không có lớp thoát
    phòng LIVE — đúng lỗ hổng đã làm máy đứng trong một buổi phát trực tiếp.
    """
    if not author:
        return ("fail", "not_needed")
    if not _mo_trang_ca_nhan(d):
        log("vuot sang trai de ghe tham loi")
        return ("fail", "not_needed")

    try:
        # Luoi thu hai cho phong LIVE, ngay khi vua vao.
        if dang_trong_phong_live(d):
            log("ghe tham roi vao phong LIVE -> thoat ra ngay")
            _ve_feed(d, log)
            return ("fail", "not_needed")

        # Cho luoi hien ra theo DIEU KIEN, khong ngu mu. Khong thay thi back MOT nhip roi do lai:
        # 1/3 lan ghe roi vao tam thong bao che trang, va no nuot dung mot `back`.
        o = []
        het = time.time() + 6.0
        da_back = False
        while time.time() < het:
            o = _o_luoi_video(d)
            if o:
                break
            if not da_back:
                da_back = True
                # ⚠ Chi `back` de bo tam che. TUYET DOI khong bam nut la tren tam do (vd "Save")
                # — bam mu mot nut khong biet la gi tren tai khoan that la dung QD-31.
                d.press("back")
                time.sleep(1.2)
            else:
                time.sleep(0.5)

        # Luot xem trang.
        han = time.time() + random.uniform(sec_min, sec_max)
        while time.time() < han:
            d.swipe(0.5, 0.75, 0.5, 0.35, random.uniform(0.2, 0.35))
            time.sleep(random.uniform(0.8, 1.4))

        # Doc lai luoi SAU khi cuon: o hien tren man da khac, nen lua chon cung ngau nhien theo
        # vi tri trong luoi chu khong chi trong hang dau.
        o = _o_luoi_video(d)
        if not o:
            log("ghe trang: khong thay o luoi video nao (trang trong / bi chan / bo cuc khac)")
            _ve_feed(d, log)
            return ("ok_no_grid", "not_needed")

        cx, cy = random.choice(o)
        d.click(cx, cy)

        # ── XAC NHAN VIDEO DA MO TRUOC KHI BAM BAT KY THU GI ──
        # Double-tap khi van dang o luoi la mo nham mot video khac, hoac chi cuon. Dung bai hoc
        # QD-31 (ban PC tung 5/10 cu bam trung cho khong lien quan).
        het = time.time() + 4.0
        mo_duoc = False
        while time.time() < het:
            attrs = _attrs_by_id(d.dump_hierarchy())
            if "video_visible_area_container" in attrs and "cover" not in attrs:
                mo_duoc = True
                break
            time.sleep(0.5)
        if not mo_duoc:
            log("bam o luoi nhung video khong mo -> KHONG tym (tranh bam mu)")
            _ve_feed(d, log)
            return ("ok_no_grid", "not_needed")

        time.sleep(random.uniform(vid_min, vid_max))
        # Dung lai `do_like`, khong viet cu double-tap thu hai — dung loi cua `linkkey.cjs`.
        kq_tym = do_like(d, log) if like_video else "not_needed"

        _ve_feed(d, log)
        return ("ok", kq_tym)
    except Exception as e:
        log("ghe tham loi: %s" % str(e)[:80])
        _ve_feed(d, log)
        return ("fail", "not_needed")


def same_video(d, author):
    """Video đang hiển thị có còn là video đã hỏi không. `author` là TÊN HIỂN THỊ.

    ⚠ VÌ SAO CẦN: sau khi vào trang nhạc rồi `back`, feed CÓ THỂ đã nhảy sang video khác. Bấm
    lúc đó là bấm nhầm người. Đây không phải rủi ro của kênh hỏi/đáp mà là rủi ro thật của
    chính tính năng. Không chắc thì trả False — mặc định an toàn là KHÔNG bấm.

    ⚠ ĐỔI NEO (2026-09-16): bản cũ so `d(text=handle)` với @handle. Mà @handle KHÔNG hề xuất hiện
    trên feed, nên phép so này **luôn trả False** — tức `_thi_hanh` thoát sớm ở mọi video và
    không cú bấm nào từng được phát ra. Giờ so bằng tên hiển thị, đọc từ cùng một nguồn với
    `read_video_info` nên hai bên không thể lệch nhau.
    """
    if not author:
        return False
    try:
        attrs = _attrs_by_id(d.dump_hierarchy())
    except Exception:
        return False
    hien_tai = _ten_tac_gia(attrs)
    if not hien_tai:
        return False
    # `author` có thể là "Tên @handle" do `read_video_info` ghép; so phần TÊN ở đầu.
    return author.startswith(hien_tai) or hien_tai == author


def _mo_trang_ca_nhan(d):
    """Mở trang cá nhân của chủ video: VUỐT PHẢI→TRÁI, kéo từng điểm một.

    MỘT nơi định nghĩa, dùng chung cho `open_profile_read_handle` (lấy @handle để follow) và
    `do_visit` (ghé thăm). Hai nơi tự làm lấy là có ngày một nơi sửa còn nơi kia quên — đúng bài
    học của `adbpath.cjs`.

    ⚠ VÌ SAO KHÔNG BẤM AVATAR (2026-09-16):
    Bản trước bấm vào avatar. Nhưng tác giả nào **đang có story** thì avatar mang vòng story, và
    bấm vào đó mở STORY chứ không mở trang cá nhân. Đo được trên máy thật: ghé xong không đọc
    được @handle, vì màn hình lúc đó là trình xem story. Chính bản chụp XML cũng có sẵn dấu vết
    `storyringhas_unconsumed_story_false` — avatar có hai vai trò tuỳ trạng thái.
    Vuốt sang trái thì luôn ra trang cá nhân, không phụ thuộc người đó có story hay không.

    ⚠ PHẢI CHẮC ĐANG Ở FEED TRƯỚC KHI VUỐT (2026-09-16, đo trên máy thật):
    Vuốt lúc màn hình còn tấm "Repost to followers" — thứ hiện ra ngay sau khi từ trang nhạc quay
    về — thì cú vuốt bị nuốt thành thao tác REPOST, và ta đứng trước một bảng Repost chứ không
    phải trang cá nhân. Log lúc đó: "reposted / Introduce this post to other / Repost".
    Dấu hiệu đang ở feed là `long_press_layout` có mặt; rời feed rồi thì nó biến mất.

    ⚠⚠ TUYỆT ĐỐI KHÔNG VUỐT KHI VIDEO ĐANG LÀ LIVESTREAM (2026-09-16):
    Vuốt sang trái trên một video LIVE **không** mở trang cá nhân — nó ĐI THẲNG VÀO PHÒNG LIVE.
    Chủ dự án bắt được tận mắt: máy đang đứng trong một buổi phát trực tiếp, giữa khung chat và
    nút tặng quà. Đó vừa là tương tác thật không ai muốn, vừa trái hẳn yêu cầu đã chốt — gặp
    livestream thì LƯỚT QUA, không đụng vào.
    Vòng quét đã bỏ qua LIVE ở đầu mỗi video rồi, nhưng chừng đó chưa đủ: từ lúc đọc màn hình tới
    lúc vuốt còn cả một vòng đi trang nhạc rồi quay lại, và feed CÓ THỂ đã trôi sang video khác —
    một video LIVE. Nên phải kiểm LẠI ngay trước khi mở, tại đây, nơi thao tác thật sự xảy ra.

    ⚠⚠ PHẢI KÉO TỪNG ĐIỂM, KHÔNG DÙNG `d.swipe()` (2026-09-16, đo trên máy thật):
    `d.swipe()` của uiautomator2 bơm sự kiện quá thưa nên TikTok **không nhận ra đó là cử chỉ** —
    màn hình đứng nguyên ở feed. Đã thử ba biến thể (chậm 0.6s, `swipe_points` 5 điểm, nhanh
    0.22s), cả ba đều không điều hướng. Tôi đã suýt kết luận nhầm rằng "vuốt không chạy" và quay
    về bấm avatar — chủ dự án bác lại, và đo tiếp thì đúng là do cách bơm sự kiện:

        d.swipe(...) 3 biến thể      -> vẫn ở feed
        d.touch.down/move/up 9 điểm  -> TRANG CA NHAN (@tranghieu0211)   ✔
        adb shell input swipe 400ms  -> TRANG CA NHAN (@tranghieu0211)   ✔

    Chọn `touch.down/move/up` vì nó đi qua đúng kênh uiautomator2 đang dùng, không phải gọi thêm
    một tiến trình adb cho mỗi cú vuốt.

    ⚠ VÌ SAO KHÔNG BẤM AVATAR: tác giả nào đang có story thì avatar mang vòng story, bấm vào đó
    mở STORY chứ không mở trang cá nhân. Vuốt thì không phụ thuộc chuyện người đó có story.
    """
    try:
        attrs = _attrs_by_id(d.dump_hierarchy())
        if "long_press_layout" not in attrs:
            return False
        if _dang_live(attrs):
            return False
        w, h = d.window_size()
        x1, x2, y = int(w * 0.8), int(w * 0.12), int(h * 0.55)
        d.touch.down(x1, y)
        time.sleep(0.08)
        for i in range(1, 9):
            d.touch.move(int(x1 + (x2 - x1) * i / 8), y)
            time.sleep(0.045)
        d.touch.up(x2, y)
        return True
    except Exception:
        return False


def open_profile_read_handle(d, log=lambda s: None, timeout=12):
    """Bấm avatar để mở trang cá nhân, đọc @handle THẬT. Trả chuỗi `@abc` hoặc ''.

    ⚠ VÌ SAO PHẢI GHÉ MỚI FOLLOW ĐƯỢC (2026-09-16):
    Feed không bày @handle (đo: 0/3 mẫu, grep XML không có `text="@..."`). Mà sổ chống trùng và
    trần 30 lượt/ngày đều khoá theo @handle — khoá theo tên hiển thị thì hai kênh trùng tên bị
    coi là một, và cú follow thì không hoàn tác được. Nên: ghé, đọc tên thật, rồi mới follow.

    Tiện thêm một việc: nút Follow trên TRANG CÁ NHÂN có `text` đúng bằng "Follow" nên khớp được
    `RE_FOLLOW`. Nút trên FEED thì `text` rỗng, chỉ có `content-desc="Follow <Tên>"` — không khớp
    kiểu trọn chuỗi, nên `do_follow` gọi ở feed luôn báo "khong thay nut Follow".

    ⚠ NƠI GỌI PHẢI `close_profile` DÙ THÀNH CÔNG HAY KHÔNG. Bỏ lại máy ở trang cá nhân thì vòng
    quét kế tiếp vuốt trên trang đó, và mọi phép nhận diện sau đều sai chỗ.
    """
    # ── THỬ HAI LẦN ──
    # Đo được trên máy thật: cú vuốt NGAY SAU khi từ trang nhạc quay về bị nuốt — feed còn đang
    # dựng lại nên thao tác rơi vào khoảng trống. Bằng chứng nằm trong cùng một video:
    # `follow=fail` nhưng `ghé=ok`, mà ghé thăm dùng ĐÚNG cú vuốt đó, chỉ khác là nó đi sau một
    # nhịp `back`. Nên: chờ cho feed đứng yên rồi vuốt, hỏng thì lùi lại và thử thêm một lần.
    for lan in (1, 2):
        if lan == 2:
            close_profile(d)          # về feed cho chắc, kể cả khi đang ở đâu đó lạ
            time.sleep(1.5)
        time.sleep(1.2)               # để feed dựng xong; vuốt vào lúc đang chuyển cảnh là mất
        if not _mo_trang_ca_nhan(d):
            log("lan %d: chua o feed hoac vuot loi" % lan)
            continue

        # Chờ trang tải. Đo được: 3.5 giây CHƯA đủ — 2/3 lần chụp sớm chưa thấy @handle. Nên chờ
        # theo ĐIỀU KIỆN chứ không chờ theo đồng hồ.
        het = time.time() + timeout
        while time.time() < het:
            try:
                attrs_xml = d.dump_hierarchy()
            except Exception:
                time.sleep(0.5)
                continue
            for t in _leaf_texts(attrs_xml):
                if _RE_HANDLE.match(t):
                    return t
            time.sleep(0.6)
        log("lan %d: mo duoc man khac nhung khong thay @handle" % lan)
    # ── HỎNG THÌ PHẢI NÓI ĐANG Ở ĐÂU, ĐỪNG ĐỂ ĐOÁN ──
    # "Không đọc được @handle" có ít nhất ba nguyên nhân khác hẳn nhau: (a) bấm avatar không mở
    # được gì, (b) mở đúng trang nhưng tải chậm, (c) mở nhầm một màn khác (TikTok hay chèn thông
    # báo "Others will see you viewed"). Ba cách sửa khác hẳn nhau, nên chẩn đoán rỗng là vô
    # dụng — đúng điều `preflight.cjs` mở đầu đã kể.
    try:
        chu = [t for t in _leaf_texts(d.dump_hierarchy()) if t][:6]
        co_nut = "co" if tim_nut_follow(d, RE_FOLLOW) else "khong"
        # App nào đang ở tiền cảnh là câu hỏi tách bạch hẳn: TikTok vẫn mở mà không đọc được
        # (tải chậm / sai màn) là một chuyện; TikTok bị đẩy ra nền là chuyện hoàn toàn khác —
        # nghĩa là cú vuốt bị hiểu thành thao tác thoát app.
        act = d.app_current()
        log("ghe trang nhung khong doc duoc @handle sau %ds. app=%s/%s | Man hinh: %s | nut Follow: %s"
            % (timeout, act.get("package", "?"), str(act.get("activity", "?")).split(".")[-1],
               " / ".join(c[:24] for c in chu), co_nut))
    except Exception:
        log("ghe trang nhung khong doc duoc @handle sau %ds (va khong doc duoc man hinh)" % timeout)
    return ""


def verify_follow_after_reload(d, log=lambda s: None, cho=3.0):
    """ĐANG Ở TRANG CÁ NHÂN sau khi bấm Follow: nạp lại trang rồi đọc lại nút.

    Trả 'ok' | 'reverted' | 'unknown'.

    ⚠ VÌ SAO KIỂM TẠI CHỖ THÔI LÀ CHƯA ĐỦ (yêu cầu chủ dự án 2026-09-16):
    `do_follow` bấm xong thấy nút đổi thành "Following" là báo thành công. Nhưng TikTok có thể
    **bật lại** cú follow vài giây sau (chặn hành vi tự động) — nút đã đổi rồi vẫn quay về
    "Follow". Lúc đó phía Node đã ghi sổ mất rồi, mà sổ đánh dấu kênh này **đã follow VĨNH VIỄN**
    (`channelstore.cjs:182-184`) nên nó không bao giờ được thử lại: một cú follow không hề tồn
    tại chiếm một suất trong trần 30/ngày, mãi mãi.

    Nạp lại NGAY TẠI TRANG ĐANG MỞ, không quay về feed rồi vào lại. Hai lý do:
      1. Ngắn hơn: một cú vuốt, không phải một vòng back–tìm avatar–bấm–chờ tải.
      2. KHÔNG CÓ chuyện nhầm người. Quay về feed thì feed có thể đã trôi sang video khác, bấm
         avatar lúc đó là mở trang người lạ, và chữ "Follow" trên trang đó sẽ bị đọc nhầm thành
         "đã bị bật lại". Ở nguyên một trang thì không cần đối chiếu @handle nữa.
    """
    try:
        # Vuốt xuống ở vùng trên = nạp lại trang cá nhân (pull-to-refresh).
        d.swipe(0.5, 0.35, 0.5, 0.85, 0.35)
    except Exception as e:
        log("nap lai trang loi: %s" % str(e)[:80])
        return "unknown"

    time.sleep(cho)
    # Đọc lại nút. `clickable=True` bắt buộc: nhãn thống kê "Following / Followers" lúc nào cũng
    # có mặt trên trang này, nên thiếu nó là phép kiểm LUÔN nói "ok" — kể cả khi đã bị bật lại.
    if tim_nut_follow(d, RE_FOLLOWING):
        return "ok"
    if tim_nut_follow(d, RE_FOLLOW):
        return "reverted"
    log("nap lai xong khong thay nut Follow lan Following -> khong ket luan duoc")
    return "unknown"


def dang_trong_phong_live(d):
    """Màn hình hiện tại có phải PHÒNG LIVE không (đã vào trong, không phải ô LIVE trên feed).

    Nhận bằng các thứ chỉ phòng live mới có: ô nhập chat, nút tặng quà, chữ "LIVE" kèm số người
    xem. Không dùng `long_press_layout` vì trong phòng live không có nó.
    """
    try:
        texts = _leaf_texts(d.dump_hierarchy())
    except Exception:
        return False
    dau_hieu = 0
    for t in texts:
        tl = t.lower()
        if tl in ("type...", "say something...", "send a message"):
            dau_hieu += 1
        elif "gift" in tl or "qua tang" in tl:
            dau_hieu += 1
        elif tl in ("live", "live now") or "watch live" in tl:
            dau_hieu += 1
    return dau_hieu >= 2


def close_profile(d, log=lambda s: None):
    """Quay về feed sau khi ghé trang cá nhân. Luôn gọi, kể cả khi ghé hỏng.

    ⚠ CÓ LỚP THOÁT PHÒNG LIVE (2026-09-16):
    Chủ dự án bắt được máy đang đứng TRONG một buổi phát trực tiếp — vuốt sang trái trên video
    LIVE đi thẳng vào phòng live chứ không mở trang cá nhân. `_mo_trang_ca_nhan` giờ đã chặn từ
    đầu, nhưng ở đây vẫn phải có lưới thứ hai: lọt vào rồi mà không thoát thì máy ngồi xem
    livestream của người ta, và mọi vòng quét sau đều sai chỗ.
    """
    try:
        d.press("back")
        time.sleep(1.2)
        for _ in range(2):
            if not dang_trong_phong_live(d):
                return True
            log("dang o TRONG phong LIVE -> thoat ra")
            d.press("back")
            time.sleep(1.5)
        return True
    except Exception as e:
        log("quay lai feed loi: %s" % str(e)[:80])
        return False
