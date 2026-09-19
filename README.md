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

Cả Node lẫn Python dùng **chung một ADB server** (mặc định cổng 5037 — đúng cái mà phần mềm soi
màn hình 效卫 đang giữ). Cổng do phía Node quyết trong `src/adbpath.cjs` rồi truyền xuống bằng biến
môi trường `ANDROID_ADB_SERVER_PORT`, y hệt cách nó truyền `ADB_PATH`, và vì đúng một lý do: hai
bên tự quyết riêng thì có ngày mỗi bên một server.

> ⚠ Bản trước cho **mỗi tiến trình một ADB server riêng** (cổng suy từ serial bằng crc32) để chữa
> triệu chứng "một máy chạy một máy đứng". Cách đó sai với farm nối qua **mạng**: `adbd` trên điện
> thoại chỉ nhận ĐÚNG MỘT adb server, mà 23 máy đã nằm trên server mặc định của 效卫 rồi — server
> riêng vĩnh viễn không thấy máy nào. Ngày 2026-09-16 cả farm chết vì đúng chỗ này: `adb connect`
> treo 60 giây, rồi mọi lệnh `adb shell` trả `device not found`, còn bảng kiểm tra thì vẫn XANH vì
> nó hỏi server mặc định. Nó cũng chưa từng chữa được gì: `adbutils` đọc cổng NGAY LÚC IMPORT, mà
> `uiautomator2` được import trước khi cổng riêng kịp đặt — toàn bộ lệnh RPC vẫn đi cổng 5037.

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
npm test            # ~610 phép thử, ~10 giây (gồm tests/mainflow — nạp NGUYÊN main.js với Electron giả)
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

**Có**: quét For You · **chế độ Quét ⇄ Xem** (clone `cycle` bản PC) · lọc theo số post · lọc
Original Sound · đẩy Google Sheet · lọc trùng mọi máy qua `known_links.txt` + đọc Sheet tăng dần
(chép nguyên `sheets.cjs` bản PC) · trần số máy chạy đồng thời + hàng đợi · chu kỳ quét/nghỉ ·
lọc theo ngôn ngữ, **không thu** sound khớp bộ lọc · nhận nhãn AI-generated · bấm "Not
interested" · **follow / thả tim / ghé thăm trang cá nhân** kèm hạn mức · **tự thoát khi lọt vào
TikTok Tako** (trợ lý chat AI): chỉ bấm Back, log ghi lọt vào ngay sau bước nào.

**Chưa có**: Quét Mix (= Quét ⇄ Xem + ghé thăm kênh, như bản PC) · tự cập nhật.

### Treo máy không bị đứng (2026-09-19)

Mọi kiểu hỏng đều có đường quay lại, mỗi lần phục hồi in **một** dòng log:

| Hỏng kiểu gì | App làm gì |
|---|---|
| Lỗi giữa chừng một video (máy kẹt ở trang nhạc / bảng Share) | `ve_feed`: Back từng nhịp tới khi về feed; không được thì mở lại / khởi động lại TikTok |
| 8 video liền không thấy icon sound | Canh gác gọi `ve_feed`; vẫn ở feed mà 24 video không có icon thì khởi động lại TikTok (tối đa 1 lần/30 phút) |
| Feed không sang video mới | Vòng sau kéo từng điểm; 4 vòng liền cùng một video thì khởi động lại TikTok |
| Dịch vụ điều khiển trên máy đứt (`Remote end closed connection`) | Khởi động lại dịch vụ ngay, rồi `ve_feed` |
| Mất kết nối ADB (`device offline` / `not found`) | Dừng quét, tự `adb connect` (15 → 60 giây), nối lại thì mở lại TikTok và quét tiếp; bảng Thiết bị hiện "Mất kết nối" |
| Điện thoại khởi động lại và nhận **IP mới** (DHCP) | Dò theo **số máy phần cứng** (`ro.serialno`, lưu ở trường `hw` trong `devices.json`): lúc mở app, và ngay trước mỗi lần chạy một máy. Máy cũ chưa có số máy thì nhận theo đời máy một lần rồi ghi luôn. Python so số máy lúc khởi động và sau khi nối lại — IP đã về tay điện thoại khác thì thoát, không lái nhầm |
| Mất kết nối quá 2 phút | Python thoát để app dò lại IP rồi chạy lại sau 1 phút |
| Phục hồi tại chỗ hỏng 3 lần liền, hoặc tiến trình chết | Python thoát mã 1 → app tự chạy lại máy đó sau **đúng 1 phút**, lần nào cũng vậy (không bỏ cuộc; Dừng là huỷ) |

Nhận biết feed (`phone_actions.o_feed`): loại theo activity (trang nhạc, trình phát) rồi mới xét
tab "For You" và `_o_tren_feed`. Đo trên 41 bản chụp thật: tab "For You" có ở 14/14 bản chụp
feed, 0/27 bản ngoài feed.

### Google Sheet (2026-09-18, v0.1.9)

Modal ☁ giống bản PC: Spreadsheet ID (dán cả link cũng được), tên tab chính (cột A:E), **kho link
cục bộ** (`known_links.txt`: số link đang giữ + ba nút *Nạp từ Google Sheet vào kho* / *Mở file*
/ *Đọc lại file*), **tên tab Pending**, Service Account JSON, chu kỳ đồng bộ.

- Service Account lưu dạng CHUỖI (đúng thứ dán vào ô), còn `sheets.cjs` bản PC chỉ nhận ĐỐI
  TƯỢNG — `main.js` đổi ở một chỗ duy nhất (`cauHinhSheet`). v0.1.8 thiếu bước này nên mọi thao
  tác Sheet báo "thiếu client_email/private_key".
- **Tab Pending** (clone QĐ-20 bản PC): để trống = TẮT. Đặt tên thì sound **không đọc được số
  video** được lấy link thật, xét Original Sound như sound thường, rồi cất vào tab đó (cột
  `[tên, link, "", thiết bị]`) thay vì bỏ — không lên bảng kết quả. Tab Pending cũng được đọc vào
  kho lọc trùng lúc nạp đầu phiên, mỗi vòng đồng bộ và ở nút *Nạp từ Google Sheet vào kho*.

### Quét ⇄ Xem (2026-09-18)

Quét For You N giờ → nghỉ → xem danh sách link M phút → nghỉ → lặp tới khi bấm Dừng. Chia pha
bằng ĐÚNG `src/phaseplan.cjs` của bản PC. Mỗi pha là một lượt chạy Python (`MODE=scan|view`);
hết pha máy nhả khe và xếp lại cuối hàng. Pha Xem không thu sound, không bấm gì — mở link bằng
deep link, bấm một video ngẫu nhiên trong lưới, xem, vuốt thêm vài chục video của cùng sound.
Mốc "xem tới link nào" nằm ở `config/devices/<id>/view_cursor.json`, nên pha sau (kể cả sau khi
tắt app) xem tiếp đúng chỗ. Khác bản PC ở một điểm: bản PC xem 40–70% **độ dài** video, còn điện
thoại đã đo là không đọc được độ dài video, nên xem theo **giây**. Ghé thăm kênh tắt ở chế độ
này, đúng như bản PC (ghé thăm là phần Quét Mix cộng thêm).

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

**Luật "Chỉ lấy Original Sound" = luật bản PC** (2026-09-18). Sound đạt số post được lấy **link
thật** qua Share → Copy link (thêm ~2–3 giây, chỉ cho sound đã đạt). Slug của link thật, hoặc tên
sound, phải bắt đầu bằng một nhãn "original sound" (34 thứ tiếng trong `linkkey.cjs`, gồm "âm
thanh gốc"). Nhãn do Node truyền xuống — Python không giữ bản sao; Node chốt lại bằng chính
`linkkey.isOriginalSound` và rút gọn link. `tests/goc.test.cjs` chạy CẢ HAI phía trên 20 mẫu (có 8
sound đo thật trên farm) để hai bên không lệch. Hệ quả, giống hệt bản PC: nhạc bản quyền bị bỏ;
sound gốc bị người tạo đổi tên cũng bị bỏ (không phân biệt được với bài hát); sound "Contains: …"
được GIỮ. Không lấy được link thật (UI khác tiếng Anh) thì xét theo tên và in cảnh báo.
