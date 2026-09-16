// Kiểm CẤU TRÚC THẺ của renderer/index.html.
//
// VÌ SAO PHẢI CÓ (2026-09-14): thêm hai ô Limit_Number vào modal Cài đặt, tôi đóng một
// `<div class="section-desc">` bằng `</label>`. Trình duyệt không báo lỗi — nó tự sửa theo cách
// của nó, và hậu quả là **mọi mục phía sau bị nuốt vào trong khối "Ghé thăm kênh"**. Khối đó
// ẩn ở chế độ Quét ⇄ Xem, nên chủ dự án mở cài đặt thấy modal cụt mất một nửa: không còn ô dán
// link, không còn Hiệu năng, không còn Lọc theo số video.
//
// Đây là LẦN THỨ HAI một lỗi cấu trúc HTML nuốt cả mảng giao diện — lần trước là cắt nhầm mốc
// khi gỡ modal và mất luôn hai modal khác (QĐ-38). Cả hai lần đều HỎNG CÂM: file vẫn mở được,
// app vẫn chạy, chỉ là người dùng không thấy thứ họ cần. Một phép thử 20ms chặn được cả hai.
'use strict';
const fs = require('fs');
const path = require('path');

// Nhận đường dẫn qua tham số để tự kiểm được chính phép thử này: chạy nó trên một bản sao đã
// cố tình làm hỏng, nếu vẫn xanh thì phép thử vô dụng. Không truyền gì thì soi file thật.
const FILE = process.argv[2] || path.join(__dirname, '..', 'renderer', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// Thẻ tự đóng theo chuẩn HTML — không bao giờ có thẻ đóng tương ứng.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Bỏ chú thích, <script> và <style> trước khi soi: bên trong chúng có thể có chuỗi trông như
// thẻ (ví dụ `'</div>'` trong JavaScript) mà không phải thẻ thật.
const sach = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/<style\b[\s\S]*?<\/style>/gi, '');

// ── 1. Mọi thẻ phải đóng ĐÚNG THỨ TỰ và ĐÚNG TÊN ──
{
  const stack = [];
  const loi = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  let m;
  let dong = 1;
  let viTri = 0;
  while ((m = re.exec(sach)) !== null) {
    // Đếm dòng để báo chỗ hỏng — không có số dòng thì người sửa phải dò tay cả nghìn dòng.
    dong += (sach.slice(viTri, m.index).match(/\n/g) || []).length;
    viTri = m.index;
    const dongThe = m[1] === '/';
    const ten = m[2].toLowerCase();
    const tuDong = /\/\s*$/.test(m[3]);
    if (VOID.has(ten) || tuDong) continue;
    if (!dongThe) {
      stack.push({ ten, dong });
    } else {
      const cuoi = stack[stack.length - 1];
      if (!cuoi) {
        loi.push(`dòng ${dong}: </${ten}> thừa, không có thẻ mở nào đang chờ`);
      } else if (cuoi.ten !== ten) {
        loi.push(`dòng ${dong}: </${ten}> nhưng đang chờ đóng <${cuoi.ten}> mở ở dòng ${cuoi.dong}`);
        stack.pop();
      } else {
        stack.pop();
      }
    }
  }
  check('1. Mọi thẻ đóng đúng tên và đúng thứ tự', loi.length === 0, loi.slice(0, 3).join(' | '));
  check('1b. Không còn thẻ nào chưa đóng', stack.length === 0,
    stack.slice(0, 3).map(x => `<${x.ten}> ở dòng ${x.dong}`).join(', '));
}

// ── 2. Mọi id phải là duy nhất ──
// `$('id')` trong renderer lấy phần tử ĐẦU TIÊN; id trùng nghĩa là đọc/ghi nhầm ô mà không
// có lỗi nào được ném ra.
{
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const trung = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
  check('2. Không có id trùng', trung.length === 0, trung.join(', '));
}

// ── 3. Mọi id renderer ĐỌC phải có thật trong HTML ──
// Đây là phép kiểm từng cứu bản PC một lần (QĐ-24): gỡ một phần tử khỏi HTML mà quên renderer
// thì `getElementById` trả về null, rồi `.value` ném lỗi **giữa chừng một hàm** — nửa còn lại của
// hàm im lặng không chạy. Với `saveSettings` thì hậu quả là **lưu thiếu một nửa cài đặt** mà
// không báo gì.
//
// Bản phone dùng `document.getElementById('x')` chứ không phải `$('x')` như bản PC, nên phải bắt
// cả hai dạng — nếu chỉ bắt `$()` thì phép thử này **luôn xanh và vô dụng** ở đây.
{
  const rend = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const co = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const dung = [...new Set([
    ...[...rend.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map(m => m[1]),
    ...[...rend.matchAll(/getElementById\(\s*'([A-Za-z0-9_]+)'\s*\)/g)].map(m => m[1]),
  ])];
  const thieu = dung.filter(x => !co.has(x));
  check('3. Mọi id renderer đọc đều có trong HTML', thieu.length === 0, thieu.join(', '));
  check('3b. Có bắt được id (phép thử không rỗng)', dung.length >= 20, `${dung.length} id`);
}

// ── 4. Các mục trong MỖI modal PHẢI nằm cùng cấp, không lồng vào nhau ──
// Đây chính là hình dạng của lỗi 2026-09-14 bên bản PC: một `</div>` viết nhầm thành `</label>` làm
// các mục sau bị NUỐT vào trong mục trước — modal cụt mất một nửa mà file vẫn mở được, app vẫn
// chạy. Hỏng câm hoàn toàn. Bản phone không đặt id cho từng `.section` nên đếm theo TỬNG MODAL.
{
  const modals = [...sach.matchAll(/<div class="modal" id="([A-Za-z0-9_]+)"/g)]
    .map(m => ({ id: m[1], at: m.index }));
  check('4. Tìm thấy các modal', modals.length >= 3, `${modals.length} modal`);

  // Độ sâu thẻ tại một vị trí — tính một lần cho cả file thay vì quét lại từng mục.
  const moc = [];
  {
    const r = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
    let mm, d = 0;
    while ((mm = r.exec(sach)) !== null) {
      const ten = mm[2].toLowerCase();
      if (VOID.has(ten) || /\/\s*$/.test(mm[3])) continue;
      if (mm[1] === '/') d--; else { moc.push({ at: mm.index, d }); d++; }
    }
  }
  const sauTai = (pos) => {
    let last = 0;
    for (const x of moc) { if (x.at > pos) break; last = x.d; }
    return last;
  };

  const loi = [];
  modals.forEach((mo, i) => {
    const het = i + 1 < modals.length ? modals[i + 1].at : sach.length;
    const secs = [...sach.matchAll(/<div class="section"[^>]*>/g)]
      .filter(x => x.index > mo.at && x.index < het)
      .map(x => sauTai(x.index));
    if (secs.length < 2) return;                 // 0–1 mục thì không có gì để so
    const chuan = secs[0];
    const lech = secs.filter(d => d !== chuan);
    if (lech.length) loi.push(`${mo.id}: ${lech.length}/${secs.length} mục lệch độ sâu (chuẩn ${chuan}, thấy ${lech.join(',')})`);
  });
  check('4b. Không mục cài đặt nào bị lồng vào mục khác', loi.length === 0, loi.join(' | '));
}

const failed = results.filter(r => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) console.log('FAIL: ' + failed.map(f => f.name).join(' | '));
process.exit(failed.length ? 1 : 0);
