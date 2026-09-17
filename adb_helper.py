"""
adb_helper.py — Tiện ích dùng chung cho automation Android.

- Tự trỏ tới adb.exe trong platform-tools (không cần thêm vào PATH).
- connect(): kết nối uiautomator2 tới 1 thiết bị (theo serial hoặc máy đầu tiên).
- list_devices(): liệt kê serial các thiết bị đang online.
- adb(): gọi lệnh adb thuần khi cần (cho thao tác mà u2 không bọc sẵn).
"""
import os
import sys
import subprocess

# Cho phép in tiếng Việt ra console Windows (tránh lỗi cp1252)
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# Đường dẫn adb.exe.
#
# ƯU TIÊN biến môi trường ADB_PATH do runner.cjs truyền xuống: phía Node đã dò và chọn rồi, hai
# bên PHẢI dùng chung một binary. Nếu mỗi bên tự dò thì có ngày chúng chọn hai bản khác phiên
# bản, mà adb có luật "thấy server khác phiên bản thì giết rồi dựng lại bản của mình" — hai bên
# sẽ thay nhau giết server của nhau, và 效卫 đang soi 19 máy cũng mất kết nối theo.
#
# Chỉ khi chạy tay ngoài app (không có biến đó) mới tự dò, theo đúng thứ tự phía Node dùng.
_ENV_ADB = os.environ.get("ADB_PATH")
if _ENV_ADB and os.path.exists(_ENV_ADB):
    ADB_PATH = os.path.abspath(_ENV_ADB)
else:
    _HERE = os.path.dirname(os.path.abspath(__file__))
    _CANDIDATES = [
        os.path.join(_HERE, "platform-tools", "adb.exe"),        # trong thư mục app
        os.path.join(_HERE, "..", "platform-tools", "adb.exe"),  # cạnh thư mục app (kiểu cũ)
        r"D:\xiaowei_android\tools\adb.exe",                     # bản đi kèm 效卫
    ]
    ADB_PATH = next(
        (os.path.abspath(p) for p in _CANDIDATES if os.path.exists(p)),
        os.path.abspath(_CANDIDATES[0]),   # không thấy: giữ đường dẫn đầu để báo lỗi rõ ràng
    )

# Để adbutils/uiautomator2 dùng đúng adb.exe này
os.environ.setdefault("ADBUTILS_ADB_PATH", ADB_PATH)


def adb(*args, serial=None, timeout=60):
    """Gọi lệnh adb thuần. Trả về stdout (string).

    Ví dụ: adb("shell", "input", "tap", "500", "1000", serial="d7877884")
    """
    cmd = [ADB_PATH]
    if serial:
        cmd += ["-s", serial]
    cmd += list(args)
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if out.returncode != 0:
        raise RuntimeError(f"adb lỗi: {' '.join(args)}\n{out.stderr.strip()}")
    return out.stdout.strip()


def list_devices(timeout=20):
    """Danh sách serial các thiết bị đang ở trạng thái 'device'.

    `timeout` ngắn hơn mặc định của adb(): lệnh này chỉ hỏi adb server tại chỗ nên bình thường
    xong dưới một giây. Nếu nó mất tới 20 giây thì server đang có vấn đề, và biết sớm vẫn tốt
    hơn đứng im 60 giây — đúng cái bẫy mà `adb connect` mù đã mắc suốt (xem scan_feed_sounds.py).
    """
    out = adb("devices", timeout=timeout)
    serials = []
    for line in out.splitlines()[1:]:
        if "\tdevice" in line:
            serials.append(line.split("\t")[0])
    return serials


def connect(serial=None):
    """Kết nối uiautomator2. Không truyền serial -> lấy máy đầu tiên."""
    import uiautomator2 as u2
    if serial is None:
        devs = list_devices()
        if not devs:
            raise RuntimeError("Không có thiết bị nào kết nối. Hãy bật USB debugging.")
        serial = devs[0]
    return u2.connect(serial)


if __name__ == "__main__":
    print("adb:", ADB_PATH)
    print("Thiết bị:", list_devices())
