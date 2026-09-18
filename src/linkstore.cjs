// src/linkstore.cjs — KHO LINK CỤC BỘ để lọc trùng (2026-08-07).
//
// VÌ SAO CÓ FILE NÀY:
// Trước đây toàn bộ danh sách link đã biết chỉ nằm trên Google Sheet. Sheet phình tới
// ~172.000 dòng → mỗi lần mở app phải tải trọn cột Link mất 4–5 phút và 13 MB, trong suốt
// thời gian đó app quét mà CHƯA CÓ bộ lọc trùng. Tệ hơn: mốc "đã đọc tới dòng N" chỉ nằm
// trong bộ nhớ nên tắt app là mất, lần sau lại tải lại từ đầu.
//
// Cách giải (chủ dự án chốt 2026-08-07): chuyển gánh nặng lưu trữ xuống MÁY.
//   • File text này giữ toàn bộ link đã biết — nạp tức thì lúc khởi động.
//   • Google Sheet chỉ còn là KÊNH TRAO ĐỔI giữa các máy, giữ nhỏ nên đọc rất nhanh.
//   • Link mới đọc từ Sheet, hoặc chính máy này vừa đẩy lên Sheet, đều được ghi thêm vào đây.
//
// ⚠ MẤT FILE NÀY = MẤT BỘ LỌC TRÙNG. Khi Sheet đã được dọn nhỏ, nó không còn là bản lưu đầy
// đủ nữa. Phải để file này trong danh sách sao lưu, quan trọng ngang thư mục profiles/.
//
// Định dạng: MỖI DÒNG MỘT LINK, đã chuẩn hóa qua normalizeKey (linkkey.cjs) — cùng đúng hàm
// mà crawler và sheets dùng, nên không bao giờ lệch chuẩn so trùng (bài học QĐ-10).
// Người dùng dán link thô kiểu gì cũng được: link dài, có ?lang=vi, hoa/thường lẫn lộn —
// lúc nạp app tự chuẩn hóa lại từng dòng. Dòng trống và dòng bắt đầu bằng # bị bỏ qua.
//
// ── 2026-08-22: phần CƠ HỌC chuyển sang src/textset.cjs ──
// File này giờ chỉ là một *instance* của factory ở đó. Lý do: cần thêm kho thứ hai (danh sách
// kênh chất lượng) mà bản cũ giữ `_keys`/`FILE_NAME` ở cấp module nên không tạo được instance
// thứ hai. HÀNH VI VÀ 7 TÊN EXPORT GIỮ NGUYÊN 100% — `tests/linkstore.test.cjs` (17 phép thử)
// là lưới an toàn cho lần bọc này, và 8 chỗ gọi `linkstore.*` trong main.js không phải sửa gì.
'use strict';

const path = require('path');
const { getBaseDir } = require('./paths.cjs');
const { normalizeKey } = require('./linkkey.cjs');
const { createStore } = require('./textset.cjs');

const FILE_NAME = 'known_links.txt';

const HEADER = [
  '# KHO LINK CỤC BỘ — dùng để lọc trùng khi quét và khi đẩy lên Google Sheet.',
  '# Mỗi dòng MỘT link. Dán link thô kiểu gì cũng được (link dài, có ?lang=vi, hoa/thường',
  '# lẫn lộn) — app tự chuẩn hóa khi nạp. Dòng trống và dòng bắt đầu bằng # bị bỏ qua.',
  '#',
  '# ⚠ ĐỪNG XÓA FILE NÀY. Khi Google Sheet đã được dọn nhỏ, đây là nơi giữ lịch sử link.',
  '# Hãy sao lưu nó cùng với thư mục profiles/.',
  '',
].join('\n');

// Đặt NGAY CẠNH file phần mềm, không nhét vào thư mục con — để mở ra dán link cho nhanh.
// `getBaseDir()` tự thích ứng: bản đóng gói → thư mục chứa .exe (cùng chỗ với profiles/,
// config/, logs/); bản dev → gốc dự án. Không có đường dẫn cứng nào ở đây.
// ⚠ Gọi getBaseDir() LÚC CHẠY chứ không lưu sẵn: test đặt PORTABLE_EXECUTABLE_DIR rồi mới
// require, và nếu tính sẵn đường dẫn ở đây thì test sẽ ghi đè kho link THẬT (QĐ-21).
const store = createStore({
  getPath: () => path.join(getBaseDir(), FILE_NAME),
  normalize: normalizeKey,
  header: HEADER,
  label: 'linkstore',
});

module.exports = {
  getFilePath: store.getFilePath,
  load: store.load,
  count: store.count,
  all: store.all,
  addUrls: store.addUrls,
  ensureFile: store.ensureFile,
  FILE_NAME,
};
