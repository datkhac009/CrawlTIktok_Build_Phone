# TikTok Phone Crawler

Thu thập link sound TikTok bằng **điện thoại Android thật**, điều khiển qua ADB + uiautomator2.

Khác với bản PC (Electron + Playwright, chạy TikTok Web), bản này chạy **app TikTok thật trên
máy thật, tài khoản đã đăng nhập, IP dân dụng**. Đổi lại được hai thứ mà bản web không có:

- **Số post của sound đọc thẳng trên màn hình** (`used_count` ở trang nhạc) — không cần request
  có chữ ký, không dính captcha.
- **Tương tác được**: follow, thả tim. Bản web đã phải gỡ hai tính năng này vì TikTok chặn.

## Kiến trúc

Electron chỉ là vỏ. Mỗi thiết bị = **một tiến trình Python riêng** điều khiển một máy.

```
renderer/ ──IPC──> main.js
                     ├── src/devices.cjs    quản lý danh sách máy (1 máy = 1 serial ADB)
                     ├── src/runner.cjs     spawn/kill  python scan_feed_sounds.py <serial>
                     ├── src/preflight.cjs  kiểm tra trước khi chạy
                     └── src/sheets.cjs     đẩy Google Sheet + lọc trùng
                                 │
                                 └── scan_feed_sounds.py ──adb/uiautomator2──> Android
```

Tiến trình Python nói chuyện với Node qua **stdout** bằng dòng `@@EVENT@@<json>`.

Mỗi tiến trình dùng **một ADB server riêng** (cổng suy ra từ serial bằng crc32). Đây là bản vá
cho triệu chứng "một máy chạy một máy đứng": nhiều tiến trình cùng dồn lệnh vào một adb server
thì server nghẽn và một tiến trình treo cứng.

## Cần gì để chạy

| Thứ | Ghi chú |
|---|---|
| Node.js | chỉ cần khi chạy từ mã nguồn |
| Python 3 | **bản nào import được `uiautomator2` cũng được** — app tự dò, không chọn theo số phiên bản |
| `uiautomator2` | `python -m pip install -r requirements.txt` |
| `adb.exe` | app tự tìm, xem bên dưới |
| Máy Android | đã cài TikTok và **đăng nhập sẵn** — app không tự đăng nhập |

### App tìm `adb.exe` ở đâu

Theo thứ tự, dừng ở cái đầu tiên thấy được:

1. biến môi trường `ADB_PATH`
2. `platform-tools/` đóng gói kèm bản build
3. `platform-tools/` trong thư mục app
4. `platform-tools/` cạnh thư mục app (cách bày cũ)
5. `D:\xiaowei_android\tools\adb.exe` — bản đi kèm phần mềm soi màn hình xiaowei
6. `adb` trong PATH

> ⚠ Nếu máy đang chạy phần mềm soi màn hình có adb riêng, **hãy dùng đúng binary đó**. adb có
> luật: thấy server đang chạy khác phiên bản thì nó **giết server đó rồi dựng lại bản của
> mình**. Hai binary khác phiên bản trên cùng một máy sẽ thay nhau giết server của nhau, và
> phần mềm kia mất kết nối giữa chừng.

## Chạy

```bash
npm install
npm start           # hoặc start.bat
npm test            # 180 phép thử, ~2 giây
```

Trong app, bấm **🔌 Kiểm tra** ở dòng một máy. Nó kiểm từng mục và **mục nào đỏ thì in ra đúng
câu lệnh cần gõ** — kể cả nguyên nhân nằm ở máy tính chứ không ở điện thoại:

```
[v] adb.exe: 1.0.41 (34.0.1-9680074) — adb đi kèm xiaowei
[x] Python: 3.14.6 (python trong PATH) — thiếu thư viện uiautomator2
    -> Chạy đúng lệnh này rồi bấm "Kiểm tra lại":
           python -m pip install -r requirements.txt
[v] Kết nối thiết bị: đã kết nối
[v] TikTok trên máy: com.zhiliaoapp.musically v46.1.1
```

Câu lệnh cài **nêu đích danh bản Python app sẽ chạy**. Máy làm việc hay có 2–3 bản Python cùng
lúc, và `pip install` trần rất dễ rơi vào bản khác — app vẫn báo thiếu thư viện dù vừa cài xong.

## Build

```bat
set RELEASE_REPO=owner/repo
build.bat
```

Năm bước: chạy phép thử → tăng số phiên bản → `electron-builder` → copy `platform-tools` →
phát hành lên GitHub.

Phép thử chạy **trước** khi build: build xong mới biết hỏng là mất cả lượt.

`RELEASE_REPO` **không có giá trị mặc định**. Không đặt thì chỉ build ra `.exe` tại chỗ. Lý do:
đây và bản PC là **hai app khác nhau**; nếu bản phone lỡ phát hành lên hàng phát hành của bản
PC thì các máy PC sẽ tự tải bản phone về và tự cập nhật sang nhầm app. Script chặn cứng trường
hợp đó.

Các file `.py` đi **theo bản build** (`extraResources`), không còn
phải copy tay ra cạnh `.exe`. Cách cũ để chúng nằm rời: cập nhật app mà quên chép lại `.py` là
nửa JavaScript mới nói chuyện với nửa Python cũ — **không báo lỗi, không cảnh báo**, chỉ là
tính năng mới lặng lẽ không chạy.

## Không đẩy lên repo

`config/` chứa IP farm và **sổ kênh chất lượng của từng tài khoản TikTok**; `sound_links.txt`
là kết quả thu thập. Cả hai là trạng thái riêng của từng máy chạy, không phải mã nguồn.

## Hiện trạng

**Có**: quét For You · lọc theo số post · lọc Original Sound (đa ngôn ngữ) · đẩy Google Sheet ·
trần số máy chạy đồng thời + hàng đợi · chu kỳ quét/nghỉ · lọc theo ngôn ngữ · nhận nhãn
AI-generated · bấm "Not interested" · **follow / thả tim / ghé thăm trang cá nhân** kèm hạn mức
theo ngày.

**Chưa có**: tự cập nhật.

## Phán xét ở đâu

Python **không chứa luật nào**. Nó đọc chữ trên màn hình, gửi lên app, rồi thi hành phán quyết:

```
Python ──@@ASK@@{author, handle, desc, badges}──> app  (gửi TRƯỚC khi bấm icon sound)
Python <──@@ANS@@{ni, why, follow, like, visit}── app  (lấy SAU khi từ trang nhạc quay về)
Python ──@@EVENT@@{type:"acted", ...}──────────> app  (kết quả THẬT của từng cú bấm)
```

Gửi trước / lấy sau là để quãng 5–9 giây mở trang nhạc che trọn thời gian đi về — đường bình
thường không tốn thêm mili-giây nào.

Mọi phán quyết dùng lại `langfilter.cjs`, `uilabels.cjs`, `channelstore.cjs` của bản PC, được
`tests/srcsync.test.cjs` khoá từng byte để hai app không lệch nhau.

**Mặc định an toàn**: hết giờ, EOF, JSON hỏng, lệch id, lệch phiên bản → *không bấm gì cả*,
việc quét chạy tiếp y nguyên. Rút hẳn phía app ra thì script vẫn làm đúng việc nó vốn làm.

## Về follow và thả tim

Bản PC **không làm được hai việc này** — TikTok Web chặn follow với các nick đó và IP trung tâm
dữ liệu chặn luôn cả tym ([crawler.cjs:1537-1539](https://github.com/datkhac009/Crawl_DataTiktok-releases)).
Máy Android thật thì làm được.

⚠ **Follow tác động lên tài khoản thật và không hoàn tác được bằng cách chạy lại chương trình.**
Bốn hàng rào:

| Hàng rào | Ở đâu |
|---|---|
| Trần ngày (mặc định 30) đếm từ **sổ trên đĩa** — tắt app mở lại KHÔNG reset | `followquota.cjs` |
| Giãn cách 2–5 phút giữa hai lần follow | `followquota.cjs` |
| Không follow trùng (`@Hira` và `@hira` là một) | `channelstore.isFollowed` |
| Chỉ follow chủ kênh có **sound hợp lệ**, và không bao giờ follow chủ video vừa bị lọc | `askproto.cjs` |

Ghi sổ **chỉ sau khi xác minh** nút đã đổi sang "Following". Ghi lúc bấm thì kênh bị đánh dấu
đã follow dù follow hỏng, và bị bỏ qua vĩnh viễn.

Mặc định **TẮT hết**. Nên thử một máy vài ngày trước khi mở cả farm.

## Hạn chế đã biết

Chưa dò được `resource-id` của caption và tên tác giả trên máy thật, nên `phone_actions.py` nhận
chúng theo hình dạng (handle là chuỗi `@abc`, caption là chuỗi dài nhất). Khớp theo **tên hiển
thị** của tác giả vì thế yếu hơn bản PC. Hướng sai ở đây là *bỏ sót*, không phải *bắt nhầm*.
