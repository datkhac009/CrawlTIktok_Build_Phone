"""askbridge.py — Cây cầu hỏi/đáp giữa tiến trình Python và app Electron.

VÌ SAO CÓ FILE NÀY (2026-09-15)
================================
Mọi PHÁN XÉT (lọc ngôn ngữ, nhãn AI, hạn mức follow) nằm ở phía Node, dùng lại đúng các module
đã chạy thật trên bản PC và có 587 phép thử bảo vệ. Python chỉ đọc chữ trên màn hình rồi thi
hành. Viết lại bộ lọc bằng Python là sinh ra bản thứ hai âm thầm lệch đi — chuyện đó ĐÃ xảy ra
với linkkey.cjs.

BỐN CÁI BẪY CỦA WINDOWS, VÀ CÁCH BỊT
=====================================
1. `select.select()` KHÔNG chạy với pipe trên Windows (chỉ nhận socket), và Windows không có
   `signal.alarm`. Nên cách duy nhất đặt được hạn giờ là **luồng đọc nền + queue.Queue.get(timeout)**.

2. Luồng đọc PHẢI là `daemon=True`. Luồng thường đang chờ `sys.stdin.readline()` sẽ **giữ cho
   trình thông dịch không thoát được**: chạy hết LIMIT, script in "XONG", rồi TREO VĨNH VIỄN.
   Phía Node không bao giờ nhận `close`, giao diện mãi hiện "đang chạy".

3. LỆCH ID là hỏng nguy hiểm nhất. Một ngoại lệ xảy ra giữa "đã gửi câu hỏi N" và "đọc câu trả
   lời N" là mọi video sau đó nhận phán quyết của video TRƯỚC — vĩnh viễn, không báo lỗi, trong
   khi vẫn bấm "Not interested" (không hoàn tác được) lên những kênh vô can. Cách bịt: mỗi câu
   trả lời phải mang đúng `id`; lệch thì bỏ; hết giờ thì ĐỐT luôn id đó để câu trả lời tới muộn
   không thể khớp về sau.

4. `for line in sys.stdin:` dùng bộ đệm đọc trước, không trả về cho tới khi đầy đệm hoặc EOF.
   CHỈ được dùng `sys.stdin.readline()`.

MẶC ĐỊNH AN TOÀN
================
Hết giờ / EOF / JSON hỏng / lệch id / lệch phiên bản → **không bấm gì cả**, việc quét chạy tiếp
y nguyên. Rút hẳn phía Node ra thì script vẫn làm đúng việc nó vốn làm. Hướng sai ở đây là mất
tính năng, KHÔNG BAO GIỜ là bấm nhầm lên tài khoản thật.
"""
import json
import os
import queue
import sys
import threading

# ⚠ SỐ NÀY PHẢI KHỚP `askproto.cjs:PROTO_VERSION`. Lúc chạy trong app thì `runner.cjs` truyền
# xuống qua biến môi trường, nên giá trị mặc định ở đây chỉ dùng khi chạy tay ngoài app
# (`start_scan_feed_sound.bat`) — nhưng nó vẫn phải đúng, vì lệch phiên bản làm MỌI phán quyết
# rơi về "không bấm gì", im lặng, không lỗi. `tests/wiring.test.cjs:158` khoá hai bên bằng nhau.
# v2 (2026-09-16): thêm `live` và nhịp hỏi `follow_confirm`.
# v3 (2026-09-17): thêm `like_profile` — cú tym lên video mở trong trang cá nhân.
PROTO_V = int(os.environ.get("PROTO_V", "3"))
TIMEOUT = float(os.environ.get("ASK_TIMEOUT", "3.0"))
FAIL_STREAK_OFF = 3          # bấy nhiêu lượt hỏng liên tiếp thì tắt hẳn, khỏi phí thời gian

# Câu trả lời khi mọi thứ hỏng: không bấm gì.
# ⚠ PHAI DU KHOA nhu cau tra loi that. Thieu mot khoa la duong HONG tra ve mot hinh
# dang KHAC duong thuong, va noi goi doc phai `None` thay vi 0 — im lang va kho tim.
SAFE = {"ni": 0, "why": "", "follow": 0, "like": 0, "visit": 0, "like_profile": 0}


class AskBridge:
    def __init__(self, enabled=True, timeout=TIMEOUT, log=None):
        self.enabled = bool(enabled)
        self.timeout = timeout
        self._log = log or (lambda s: None)
        self._q = queue.Queue()
        self._next_id = 1
        self._pending = None      # id đang chờ trả lời, hoặc None
        self._fail_streak = 0
        self._eof = False
        self._t = None
        if self.enabled:
            self._start_reader()

    # ---- luồng đọc nền ----
    def _start_reader(self):
        def doc():
            while True:
                try:
                    line = sys.stdin.readline()
                except Exception:
                    break
                if line == "":        # EOF: tiến trình cha đã chết
                    self._q.put(None)
                    break
                line = line.strip()
                if line:
                    self._q.put(line)

        # daemon=True là BẮT BUỘC — xem bẫy số 2 ở đầu file.
        self._t = threading.Thread(target=doc, name="askbridge-reader", daemon=True)
        self._t.start()

    @property
    def parent_gone(self):
        """Tiến trình cha đã chết. Trước khi có kênh này, Electron chết là các tiến trình Python
        MỒ CÔI cứ vuốt máy thật mãi mãi, không ai dọn. Giờ phát hiện được."""
        return self._eof

    # ---- gửi câu hỏi ----
    def ask(self, *, author="", handle="", desc="", badges=None, live=False, kind=""):
        """Gửi câu hỏi rồi trả về id. KHÔNG chờ ở đây — chờ ở `take()` sau khi đã đi một vòng
        trang nhạc, nhờ vậy thời gian đi về được che trọn và đường bình thường không tốn thêm
        mili-giây nào.

        `kind="follow_confirm"` là NHỊP HỎI THỨ HAI (giao thức v2, 2026-09-16): gửi sau khi đã
        ghé trang cá nhân và đọc được @handle thật. Nhịp này thì KHÔNG che được thời gian chờ —
        nó nằm giữa lúc mở trang và lúc bấm Follow — nhưng chỉ chạy đúng lúc sắp follow, tức vài
        lần mỗi ca, nên không đáng kể.
        """
        if not self.enabled or self._eof:
            return None
        aid = self._next_id
        self._next_id += 1
        payload = {
            "v": PROTO_V,
            "id": aid,
            "author": (author or "")[:300],
            "handle": (handle or "")[:120],
            "desc": (desc or "")[:500],
            "badges": [str(b)[:120] for b in (badges or [])][:10],
            "live": bool(live),
        }
        if kind:
            payload["kind"] = str(kind)[:40]
        try:
            # ensure_ascii=True (mặc định) là CỐ Ý: dòng ra thuần ASCII nên miễn nhiễm với mọi
            # tai nạn bảng mã trên đường ra quyết định. Log cho người đọc vẫn để nguyên tiếng Việt.
            sys.stdout.write("@@ASK@@" + json.dumps(payload) + "\n")
            sys.stdout.flush()
        except Exception:
            return None
        self._pending = aid
        return aid

    # ---- nhận câu trả lời ----
    def take(self, aid):
        """Lấy câu trả lời cho `aid`. Trả dict (luôn có đủ khoá). Không bao giờ ném."""
        if aid is None or not self.enabled:
            return dict(SAFE)
        import time
        han = time.time() + self.timeout
        try:
            while True:
                con = han - time.time()
                if con <= 0:
                    return self._fail(aid, "timeout")
                try:
                    line = self._q.get(timeout=con)
                except queue.Empty:
                    return self._fail(aid, "timeout")
                if line is None:
                    self._eof = True
                    return self._fail(aid, "eof")
                if not line.startswith("@@ANS@@"):
                    continue          # dòng lạ trên stdin: bỏ qua, không phải lỗi
                try:
                    ans = json.loads(line[len("@@ANS@@"):])
                except Exception:
                    return self._fail(aid, "badjson")
                if ans.get("v") != PROTO_V:
                    return self._fail(aid, "version")
                if int(ans.get("id", -1)) != aid:
                    # Câu trả lời của lượt khác (thường là lượt đã hết giờ trước đó). BỎ QUA và
                    # chờ tiếp — tuyệt đối không dùng nó cho video hiện tại.
                    continue
                self._pending = None
                self._fail_streak = 0
                return {
                    "ni": 1 if ans.get("ni") else 0,
                    "why": str(ans.get("why", ""))[:16],
                    "follow": 1 if ans.get("follow") else 0,
                    "like": 1 if ans.get("like") else 0,
                    "visit": 1 if ans.get("visit") else 0,
                    "like_profile": 1 if ans.get("like_profile") else 0,
                }
        except Exception:
            return self._fail(aid, "error")

    def _fail(self, aid, why):
        # ĐỐT id: tăng bộ đếm để câu trả lời tới muộn của lượt này không bao giờ khớp được nữa.
        self._next_id = max(self._next_id, aid + 1)
        self._pending = None
        self._fail_streak += 1
        try:
            sys.stdout.write("@@EVENT@@" + json.dumps({"type": "askfail", "id": aid, "why": why}) + "\n")
            sys.stdout.flush()
        except Exception:
            pass
        if self._fail_streak >= FAIL_STREAK_OFF and self.enabled:
            self.enabled = False
            self._log("hoi/dap hong %d lan lien tiep -> TAT phan loc & tuong tac, van quet binh thuong"
                      % self._fail_streak)
        return dict(SAFE)

    # ---- báo lại kết quả THẬT của từng cú bấm (một chiều, không chờ) ----
    def acted(self, aid, **kq):
        """`kq` nhận follow/like/visit/ni với giá trị 'ok' | 'fail' | 'not_needed' | 'skip_changed_video'.

        ⚠ Phía Node CHỈ ghi sổ khi nhận 'ok'. channelstore.cjs:182-184 cảnh báo đúng chỗ này:
        ghi lúc BẤM thay vì lúc đã xác minh thì kênh bị đánh dấu đã follow dù follow hỏng, và
        bị bỏ qua VĨNH VIỄN."""
        try:
            payload = {"type": "acted", "id": aid}
            payload.update(kq)
            sys.stdout.write("@@EVENT@@" + json.dumps(payload) + "\n")
            sys.stdout.flush()
        except Exception:
            pass
