// tests/demhople.test.cjs — khoá hai cột đếm "Đã check" / "Hợp lệ" của bảng thiết bị.
//
// VÌ SAO PHẢI CÓ (2026-09-23): cột "Hợp lệ" lấy số sound ĐẠT LỌC của Python, trong khi bảng "Dữ
// liệu thu thập" chỉ nhận sound MỚI — main.js bỏ mọi link đã có trong kho `known_links.txt`. Đo
// thật: các máy báo 10 sound đạt, 8 cái đã thu từ trước, bảng có 2. Chủ dự án cộng cột thấy không
// khớp "2 sound" và tưởng app đếm sai. Phép thử này khoá luật mới: cộng cột "Hợp lệ" = tổng bảng.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const ROOT = path.join(__dirname, '..');
// CRLF → LF: máy có `core.autocrlf=true` checkout ra CRLF (xem wiring.test.cjs).
const doc = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const rend = doc('renderer', 'renderer.js');
const runner = doc('src', 'runner.cjs');

// Cắt nguyên văn một hàm cấp ngoài cùng ra khỏi renderer.js (file chạy trong trình duyệt, không
// require được) — chạy đúng mã thật chứ không chạy bản chép lại.
function catHam(ten) {
  const dau = rend.indexOf(`function ${ten}(`);
  if (dau < 0) throw new Error(`không thấy hàm ${ten} trong renderer.js`);
  let i = rend.indexOf('{', dau);
  let sau = 0;
  for (; i < rend.length; i++) {
    if (rend[i] === '{') sau++;
    else if (rend[i] === '}' && --sau === 0) return rend.slice(dau, i + 1);
  }
  throw new Error(`hàm ${ten} không đóng ngoặc`);
}

const ctx = {};
vm.createContext(ctx);
vm.runInContext(['esc', 'demTrang', 'trangThaiMoi', 'datLaiDem', 'congDonTienDo', 'oHopLe']
  .map(catHam).join('\n'), ctx);
const { trangThaiMoi, datLaiDem, congDonTienDo, oHopLe } = ctx;

// ── 1. Một tiến trình: số Python đi thẳng lên cột ──
{
  const st = trangThaiMoi();
  congDonTienDo(st, 1, 0, 111);
  congDonTienDo(st, 5, 2, 111);
  congDonTienDo(st, 10, 3, 111);
  check('1. một tiến trình: Đã check / đạt lọc lấy đúng số mới nhất', st.checked === 10 && st.qualified === 3,
    `checked=${st.checked} qualified=${st.qualified}`);
}

// ── 2. Tiến trình MỚI (tự chạy lại sau nghỉ / lỗi): cộng dồn, không tụt về 0 ──
{
  const st = trangThaiMoi();
  congDonTienDo(st, 10, 3, 111);
  congDonTienDo(st, 2, 1, 222);
  congDonTienDo(st, 7, 2, 222);
  check('2. sang tiến trình mới thì cộng dồn', st.checked === 17 && st.qualified === 5,
    `checked=${st.checked} qualified=${st.qualified}`);
}

// ── 3. CÙNG tiến trình nhưng số đi tiếp sau khi nối lại ADB — không đếm hai lần ──
//     (Python báo 'running' giữa chừng lúc nối lại; bản đầu tôi định dựa vào 'running' thì sẽ đếm đôi)
{
  const st = trangThaiMoi();
  congDonTienDo(st, 10, 3, 111);
  congDonTienDo(st, 11, 3, 111);
  congDonTienDo(st, 15, 4, 111);
  check('3. cùng tiến trình thì không cộng dồn', st.checked === 15 && st.qualified === 4,
    `checked=${st.checked} qualified=${st.qualified}`);
}

// ── 4. Thiếu `lan` (tin cũ): nhận ra tiến trình mới nhờ số tụt xuống ──
{
  const st = trangThaiMoi();
  congDonTienDo(st, 10, 3);
  congDonTienDo(st, 2, 1);
  check('4. thiếu mã tiến trình: số tụt thì coi là tiến trình mới', st.checked === 12 && st.qualified === 4,
    `checked=${st.checked} qualified=${st.qualified}`);
}

// ── 5. Làm mới bảng thì mọi đếm về 0, và lần đếm sau không mang số cũ theo ──
{
  const st = trangThaiMoi();
  st.status = 'stop';
  st.log.push('dòng log cũ');
  congDonTienDo(st, 10, 3, 111);
  congDonTienDo(st, 4, 2, 222);
  st.valid = 2;
  datLaiDem(st);
  const ve0 = st.checked === 0 && st.qualified === 0 && st.valid === 0;
  congDonTienDo(st, 3, 1, 333);
  check('5. datLaiDem đưa đếm về 0, giữ trạng thái + log',
    ve0 && st.checked === 3 && st.qualified === 1 && st.status === 'stop' && st.log.length === 1,
    `sau đặt lại: checked=${st.checked} qualified=${st.qualified}`);
}

// ── 6. Ô "Hợp lệ": CHỈ số sound MỚI vào bảng — đúng con số đo thật 10 đạt lọc / 2 mới ──
//     Sound bị bỏ vì trùng kho link KHÔNG hiện (chủ dự án dặn 2026-09-23: "cứ ẩn nó đi").
{
  const st = trangThaiMoi();
  congDonTienDo(st, 40, 10, 111);
  st.valid = 2;
  const o = oHopLe(st);
  check('6. ô Hợp lệ hiện đúng "2" — không hiện 10 đạt lọc, không hiện số bị bỏ', o === '2', o);
  check('6b. không còn chữ "(bỏ N)" nào trong renderer/CSS',
    !/\(bỏ \$\{|pvalid-bo/.test(rend) && !/pvalid-bo/.test(doc('renderer', 'styles.css')));
}

// ── 7. Đi dây: mỗi dòng vào bảng cộng "Hợp lệ" của đúng máy đó ──
{
  const onData = catHam('onCrawlData');
  check('7. onCrawlData cộng st.valid sau khi thêm dòng vào bảng',
    /crawlResults\.push\(row\)[\s\S]*st\.valid = \(st\.valid \|\| 0\) \+ 1/.test(onData));
  check('7b. ô Hợp lệ vẽ bằng oHopLe, không còn lấy thẳng st.qualified',
    /<td class="pvalid">\$\{oHopLe\(st\)\}<\/td>/.test(rend) && !/<td class="pvalid">\$\{st\.qualified/.test(rend));
  check('7c. tiến độ đi qua congDonTienDo kèm mã tiến trình',
    /congDonTienDo\(st, payload\.checked, payload\.qualified, payload\.lan\)/.test(rend));
  check('7d. runner.cjs gửi kèm lan: proc.pid trong sự kiện progress',
    /kind: 'progress'[^}]*lan: proc\.pid/.test(runner));
}

// ── 8. Đặt lại đếm CÙNG LÚC với làm mới bảng, không đặt lại riêng từng máy lúc bấm Chạy ──
{
  const xoa = catHam('clearResultsIfIdle');
  check('8. clearResultsIfIdle đặt lại đếm của mọi máy', /datLaiDem\(deviceState\[id\]\)/.test(xoa));
  const chay = catHam('startDeviceById');
  check('8b. startDeviceById không còn tự đưa đếm của máy về 0',
    !/st\.checked = 0|st\.qualified = 0|datLaiDem/.test(chay));
}

const pass = results.filter((r) => r.pass).length;
console.log(`\n=== ${pass}/${results.length} PASS ===`);
process.exit(pass === results.length ? 0 : 1);
