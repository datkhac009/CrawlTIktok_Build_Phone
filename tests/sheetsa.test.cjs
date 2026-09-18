// tests/sheetsa.test.cjs — HỢP ĐỒNG giữa main.js và `sheets.cjs` về Service Account.
//
// SỰ CỐ THẬT (2026-09-18, v0.1.8): chủ dự án dán ĐÚNG file JSON service account, bấm "Test kết
// nối" và nhận "Service Account không hợp lệ (thiếu client_email/private_key)". Mọi thao tác Sheet
// đều hỏng: kiểm kết nối, đọc link lọc trùng, đẩy link.
//
// Gốc: `sheets.cjs` được chép nguyên từ bản PC, và bản PC chỉ nhận Service Account dạng ĐỐI TƯỢNG
// — việc đổi chuỗi → đối tượng nằm ở main.js bên PC. `sheets.cjs` cũ của bản phone thì tự đổi bên
// trong. Chép tệp mà không chuyển việc đổi sang main.js là hỏng, và không phép thử nào thấy vì
// `mainflow.test.cjs` dùng Sheet giả.
//
// File này khoá HAI ĐẦU của hợp đồng đó, chạy thật, không cần mạng:
//   1. `sheets.cjs` THẬT từ chối chuỗi → nên main.js BẮT BUỘC phải đổi trước khi gọi.
//   2. Đổi xong thành đối tượng thì qua được cửa kiểm "client_email/private_key".
// Đầu còn lại (main.js thật sự đổi) do `mainflow.test.cjs` mục M chạy thật.
'use strict';
const path = require('path');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sheets = require(path.join(__dirname, '..', 'src', 'sheets.cjs'));

// Service Account GIẢ đúng hình dạng file Google tải về. Khoá bí mật không hợp lệ nên việc ký JWT
// hỏng ngay tại máy — không bao giờ đi ra mạng.
const SA = {
  type: 'service_account',
  project_id: 'du-an-gia',
  private_key_id: 'abc',
  private_key: '-----BEGIN PRIVATE KEY-----\\nKHONGPHAIKHOATHAT\\n-----END PRIVATE KEY-----\\n',
  client_email: 'crawler@du-an-gia.iam.gserviceaccount.com',
  client_id: '1',
};
const SAI_HINH_DANG = /thiếu client_email\/private_key/;

(async () => {
  // ── 1. Đúng triệu chứng v0.1.8: đưa CHUỖI thẳng vào sheets.cjs ──
  const r1 = await sheets.testConnection('1BKKxKh15LCkFN9jrqPmsYxpxNy9DSBAoDrXPc52JQmA', JSON.stringify(SA));
  check('1. sheets.cjs (bản PC) TỪ CHỐI Service Account dạng chuỗi — nên main.js phải đổi trước',
    r1 && r1.ok === false && SAI_HINH_DANG.test(r1.msg || ''), r1 && r1.msg);

  // ── 2. Đổi sang đối tượng thì qua được cửa kiểm hình dạng ──
  const r2 = await sheets.testConnection('1BKKxKh15LCkFN9jrqPmsYxpxNy9DSBAoDrXPc52JQmA', SA);
  check('2. Đối tượng thì QUA cửa kiểm client_email/private_key (hỏng sau đó chỉ vì khoá giả)',
    r2 && r2.ok === false && !SAI_HINH_DANG.test(r2.msg || ''), r2 && r2.msg);

  const failed = results.filter((x) => !x.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log('FAIL  lỗi không bắt được: ' + (e && e.stack || e));
  console.log('\n=== 0/1 PASS ===');
  process.exit(1);
});
