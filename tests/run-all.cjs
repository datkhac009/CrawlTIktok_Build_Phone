// tests/run-all.cjs — chạy TẤT CẢ file *.test.cjs trong thư mục này, lần lượt.
//
// VÌ SAO CÓ FILE NÀY (2026-08-22): trước đây `npm test` là một chuỗi 12 lệnh nối bằng `&&`
// dài 421 ký tự nằm gọn trong package.json. Hai vấn đề đã xảy ra thật:
//
//   1. Chuỗi đủ dài thì `cmd.exe` (shell mà npm/pnpm dùng trên Windows) **treo và không in ra
//      một dòng nào** — không phải lỗi của test, vì từng file chạy riêng đều xanh trong dưới
//      1 giây, và cắt chuỗi ngắn lại thì chạy bình thường. Đo được: 9 file chạy ổn, 11 file
//      là treo.
//   2. Mỗi lần thêm một file test lại phải sửa tay đúng chuỗi đó — dễ gõ sót, và sót thì
//      test mới **không bao giờ chạy** mà chẳng ai biết (đúng loại hỏng câm mà DECISIONS.md
//      cảnh báo).
//
// Bộ chạy này tự quét thư mục nên thêm file test mới là nó tự chạy, không phải sửa gì.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const files = fs.readdirSync(DIR)
  .filter(f => f.endsWith('.test.cjs'))
  .sort();

if (!files.length) {
  console.error('Không tìm thấy file .test.cjs nào — bộ chạy đang trỏ sai thư mục?');
  process.exit(1);
}

const t0 = Date.now();
const failed = [];
let totalPass = 0, totalAll = 0;

for (const f of files) {
  // Chạy từng file trong TIẾN TRÌNH RIÊNG: các file test đặt biến môi trường
  // (PORTABLE_EXECUTABLE_DIR) và require module có trạng thái ở cấp module, chạy chung một
  // tiến trình là chúng giẫm chân nhau (QĐ-21).
  const r = spawnSync(process.execPath, [path.join(DIR, f)], {
    encoding: 'utf8',
    // stdin nối vào 'ignore': không file test nào được phép chờ người gõ phím.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/===\s*(\d+)\/(\d+)\s*PASS\s*===/);
  if (m) { totalPass += Number(m[1]); totalAll += Number(m[2]); }

  const ok = r.status === 0;
  if (!ok) {
    failed.push(f);
    // Chỉ in ĐẦY ĐỦ output của file HỎNG — file xanh chỉ cần một dòng tóm tắt, để dòng đỏ
    // không bị chìm giữa hàng trăm dòng PASS.
    console.log(`\n──────── ${f} — HỎNG ────────`);
    console.log(out.trimEnd());
    console.log('─'.repeat(40));
  } else {
    console.log(`PASS  ${f.padEnd(30)} ${m ? m[1] + '/' + m[2] : '(không đọc được số)'}`);
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n=== ${totalPass}/${totalAll} PASS · ${files.length - failed.length}/${files.length} file · ${secs}s ===`);
if (failed.length) console.log('FILE HỎNG: ' + failed.join(', '));
process.exit(failed.length ? 1 : 0);
