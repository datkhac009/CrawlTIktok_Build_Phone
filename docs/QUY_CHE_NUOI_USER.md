# Quy chế: một máy thu thập sound tốt và một tài khoản được nuôi tốt

Tài liệu này dành cho người **vận hành farm** — người bật máy, chỉnh ô cài đặt, và đọc log sau mỗi
ca. Nó nói bằng thao tác và con số, không bằng tên hàm.

Mọi con số ở đây đều **đo được trên máy thật** (SM-N975F, TikTok v46.1.1), không phải ước lượng.

> ⚠ **Cập nhật 2026-09-24:** máy **không còn ghé trang cá nhân** ở chế độ nào (chủ dự án chốt: For
> You chỉ quét và tương tác). Các đoạn dưới đây nói về ghé trang, lướt trang, mở video trong lưới
> không còn áp dụng; công tắc "Ghé trang" trong Cài đặt không có tác dụng.

---

## 1. Một ca chạy trông như thế nào

Máy lướt feed "For You". Với **mỗi video**:

1. **Livestream thì lướt qua ngay** — không hỏi, không bấm gì. Màn LIVE không có icon sound, không
   có nút Follow ở chỗ quen thuộc, nên mọi thao tác trên đó đều là bấm mù.
2. **Đọc màn hình**, gửi câu hỏi lên app. App phán xét (lọc ngôn ngữ, nhãn AI, hạn mức) và trả lời.
3. **Bấm icon sound** → sang trang nhạc → đọc tên sound và số post → quay về feed.
4. **Sound KHÔNG hợp lệ** → không tương tác gì cả. Lướt tiếp.
5. **Sound HỢP LỆ** → ghi link vào kết quả, rồi:
   - Tym video trên feed — **theo tỉ lệ**, không phải lúc nào cũng tym.
   - Vuốt phải→trái vào trang cá nhân của tác giả.
   - Lướt trang **5–10 giây**.
   - Mở **một video ngẫu nhiên** trong lưới, xem **3–7 giây**, tym (cũng theo tỉ lệ).
   - Quay về feed, lướt tiếp.

**Sound hợp lệ là gì:** là "Original Sound" (không phải "Contains: …") và số post nằm trong khoảng
đã đặt — mặc định **1.000 đến 100.000**. Dưới 1.000 là sound chưa ai dùng; trên 100.000 là sound đã
bão hoà, đăng vào đó cũng chìm.

### Tỉ lệ tym: vì sao không tym hết

Tỉ lệ mặc định **40–60%**. Đầu mỗi ca, máy **bốc một con số** trong khoảng đó rồi giữ nguyên suốt
ca — nên mỗi máy có một "tính cách" ổn định, nhìn từ phía TikTok giống một người hơn là giống máy.

Con số bốc được in ra ngay dòng đầu log: `tym ngẫu nhiên 47% lượt này`.

Tym 100% số video đạt là hành vi máy móc, dễ nhận ra. Tym 0% thì tài khoản không có tín hiệu sống.

---

## 2. Trần an toàn mỗi máy mỗi ngày

| Việc | Trần | Vì sao |
|---|---|---|
| Follow | **30/ngày** | Đếm từ sổ trên đĩa, nên **tắt app mở lại KHÔNG reset**. Mỗi cú follow tác động lên tài khoản thật và không hoàn tác được bằng cách chạy lại. |
| Giãn cách giữa 2 cú follow | **120–300 giây** | Follow liên tiếp trong vài giây là dấu hiệu máy rõ nhất. |
| Tym | **60/ngày** | ⚠ Dùng **chung** cho cả tym trên feed lẫn tym trong trang cá nhân. Một video đạt có thể ăn **2 suất**. |
| Ghé trang | không giới hạn mặc định | Đặt "Tối đa … kênh mỗi lượt chạy" nếu muốn chặn. |
| Không follow trùng | luôn bật | Sổ nhớ vĩnh viễn kênh đã follow. |
| Số máy chạy cùng lúc | **6** | 19 máy dồn lệnh qua **một** adb server và một đường Wi-Fi. Máy vượt trần sẽ xếp hàng. |

**Đặt trần bằng 0 nghĩa là TẮT hẳn, không phải "không giới hạn".** Gõ 0 vào ô trần follow là muốn
ngừng follow.

---

## 3. Nhịp quét: nhanh tới đâu thì dừng

Mặc định hiện tại, mỗi video:

| Loại video | Thời gian |
|---|---|
| Không có icon sound (quảng cáo, ảnh) | ~5–9 giây |
| Sound bị loại | ~10–20 giây |
| Sound đạt + ghé trang + tym | ~25–40 giây |

Bốn ô chỉnh được tốc độ, trong ⚙ Cài đặt:

- **Delay giữa các video** (mặc định 3–6 giây) — quãng "xem" video. Đây là ô **nhạy cảm nhất** với
  chống bot.
- **Chờ trang nhạc mở tối đa** (8 giây) và **Chờ số post hiện ra tối đa** (1,2 giây) — đây là
  **trần chờ**, không phải thời gian ngủ: thấy rồi là đi tiếp ngay. Hạ xuống thì nhanh hơn nhưng
  máy mạng chậm dễ bỏ sót sound.
- **Lướt trang** (5–10 giây) và **Xem video trong trang** (3–7 giây).

> ⚠ **Không hạ Delay xuống dưới 2 giây.** Đã đo: TikTok phản ứng với nhịp gần 0 bằng cách **nhồi
> lại cùng một video** và chèn quảng cáo liên tục — lúc đó máy chạy cả ngày mà không thu được gì.
> Muốn hạ thì hạ trên **một máy** vài ngày rồi mới áp cả farm.

---

## 4. Sáu dòng log cần soi sau mỗi ca

| Dòng | Nói lên điều gì |
|---|---|
| `tym ngẫu nhiên NN% lượt này` | Phép bốc đã chạy. **Không thấy dòng này** = tương tác chưa bật. |
| `── Tổng kết: … tym N (K trong trang) · ghé M kênh` | `M` cao mà `K` bằng 0 → đường mở video trong lưới đang hỏng. |
| `CHAM BAT THUONG: video #N mat Xs` | Vòng quét vượt 60 giây. Một lần lẻ thì bình thường; lặp lại là mạng hoặc adb đang nghẽn. |
| `phuc hoi lan N` | Máy phải reset service. Tới lần thứ 3–4 trong một ca là máy đang có vấn đề thật. |
| `ghe tham xong KHONG ve duoc feed` | **Phải xem ngay.** Máy lạc khỏi feed, mọi thao tác sau đó sai chỗ. |
| `TikTok đã bật lại cú follow` | **Canh báo nặng nhất.** TikTok đang huỷ follow của mình = tài khoản bị siết. Dừng follow trên máy đó. |

Ngoài ra: `bam o luoi nhung video khong mo` — cú bấm vào lưới rơi vào chỗ trống. Lẻ tẻ thì bỏ qua;
thường xuyên nghĩa là bố cục lưới trên máy đó khác (máy bảng, bản TikTok khác).

---

## 5. Dấu hiệu tài khoản đang bị siết

Theo thứ tự từ nhẹ tới nặng:

1. **Feed nhồi lại cùng một video** hoặc toàn quảng cáo → nhịp quét quá nhanh. Tăng Delay lên.
2. **Tym báo hỏng liên tục** (`tym N (hỏng M)` với M lớn) → thao tác bấm không ăn.
3. **`TikTok đã bật lại cú follow` lặp lại** → tài khoản bị hạn chế hành vi tự động. **Tắt follow
   trên máy đó ít nhất một ngày.**
4. **Số sound đạt tụt hẳn** trong khi số video quét vẫn như cũ → feed bị đẩy sang nội dung rác.

---

## 6. Việc KHÔNG được làm

- **Không** hạ Delay xuống dưới 2 giây, hoặc tắt hẳn quãng nghỉ.
- **Không** bật follow trên cả farm khi chưa thử một máy vài ngày. Follow không hoàn tác được.
- **Không** chạy hai máy trên cùng một tài khoản TikTok — sổ theo từng máy, hai máy sẽ đếm riêng và
  cùng nhau vượt trần.
- **Không** dùng chung thư mục `config/devices/<id>/` giữa các máy. Sổ kênh chất lượng và bộ đếm
  ngày là **khẩu vị của một tài khoản cụ thể**; trộn chung là sai.
- **Không** bấm vào máy trong lúc nó đang chạy. Thao tác tay làm feed trôi và máy sẽ bấm nhầm chỗ.
- **Không** để máy đứng trong phòng livestream. Nếu thấy, dừng máy và xem log.

---

## 7. Trạng thái hôm nay (2026-09-17)

| Tính năng | Tình trạng |
|---|---|
| Quét sound, lọc, ghi link | **Chạy tốt** |
| Bỏ qua livestream | **Chạy tốt** |
| Tym (feed + trong trang), theo tỉ lệ | **Chạy tốt** |
| Ghé trang + mở video ngẫu nhiên | **Đã tắt** ở mọi chế độ (2026-09-24) |
| Lọc ngôn ngữ, nhãn AI, Not interested | **Chạy tốt** |
| **Follow** | ⚠ **CHƯA DÙNG ĐƯỢC.** Bấm được nhưng chưa xác minh chắc chắn được là follow có trụ lại không. Đã từng báo thành công giả. **Để tắt** cho tới khi có thông báo khác. |
