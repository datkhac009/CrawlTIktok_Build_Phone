// tests/devslot.test.cjs — khoá cổng chia khe cho 19 máy.
//
// VÌ SAO PHẢI CÓ (2026-09-15): chủ dự án có 19 máy Android, mỗi máy chạy = 1 tiến trình Python,
// và cả 19 dồn lệnh qua CÙNG một ADB server. Bật hết cùng lúc là máy điều khiển gánh không nổi.
//
// Điều PHẢI khoá chặt nhất: **nhánh lỗi cũng nhả khe**. Bản PC học bài này ở `browser.cjs`
// (dùng `.then(ok, err)` chứ không chỉ `.then(ok)`). Quên nhả một lần là hàng đợi kẹt VĨNH
// VIỄN, và triệu chứng người dùng thấy là "tự nhiên không máy nào chạy nữa" — không ai lần ra.
'use strict';
const path = require('path');
const ds = require(path.join(__dirname, '..', 'src', 'devslot.cjs'));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  // ── 1. Dưới trần thì chạy ngay, không xếp hàng ──
  {
    ds._resetForTest(); ds.setMax(3);
    let goiOnWait = 0;
    const a = await ds.acquire('m1', () => goiOnWait++);
    const b = await ds.acquire('m2', () => goiOnWait++);
    check('1. Dưới trần thì được chạy ngay', a === true && b === true);
    check('1b. KHÔNG gọi onWait cho máy chạy ngay', goiOnWait === 0, `gọi ${goiOnWait} lần`);
    check('1c. Đếm đúng số máy đang chạy', ds.activeCount() === 2, `${ds.activeCount()}`);
  }

  // ── 2. Chạm trần thì máy tiếp theo phải CHỜ ──
  {
    ds._resetForTest(); ds.setMax(2);
    await ds.acquire('m1'); await ds.acquire('m2');
    let viTri = 0;
    let xong = false;
    const p = ds.acquire('m3', (pos) => { viTri = pos; }).then((r) => { xong = r; });
    await new Promise((r) => setImmediate(r));
    check('2. Chạm trần thì máy thứ 3 phải chờ', xong === false && ds.activeCount() === 2);
    check('2b. onWait báo vị trí xếp hàng để UI hiện "đang xếp hàng (n)"', viTri === 1, `vị trí ${viTri}`);
    check('2c. queuePosition khớp', ds.queuePosition('m3') === 1);

    ds.release('m1');
    await p;
    check('2d. Nhả khe thì máy đang chờ được vào', xong === true && ds.isActive('m3'));
    check('2e. Hàng chờ rỗng sau khi trao khe', ds.waitingCount() === 0);
  }

  // ── 3. ĐÚNG THỨ TỰ TỚI TRƯỚC (FIFO) ──
  // Không FIFO thì có máy bị bỏ đói mãi mà không ai để ý.
  {
    ds._resetForTest(); ds.setMax(1);
    await ds.acquire('m1');
    const thuTu = [];
    ds.acquire('mA').then(() => thuTu.push('mA'));
    ds.acquire('mB').then(() => thuTu.push('mB'));
    ds.acquire('mC').then(() => thuTu.push('mC'));
    await new Promise((r) => setImmediate(r));
    ds.release('m1'); await new Promise((r) => setImmediate(r));
    ds.release('mA'); await new Promise((r) => setImmediate(r));
    ds.release('mB'); await new Promise((r) => setImmediate(r));
    check('3. Trao khe đúng thứ tự tới trước', thuTu.join(',') === 'mA,mB,mC', thuTu.join(','));
  }

  // ── 4. HỎNG GIỮA CHỪNG VẪN PHẢI NHẢ ĐƯỢC KHE ──
  // Đây là bài học đắt nhất. Mô phỏng: lượt chạy ném lỗi, nơi gọi nhả trong `finally`.
  {
    ds._resetForTest(); ds.setMax(1);
    await ds.acquire('m1');
    let đượcVào = false;
    const p = ds.acquire('m2').then((r) => { đượcVào = r; });
    try {
      throw new Error('máy m1 rớt mạng giữa chừng');
    } catch (_) {
      // đúng khuôn nơi gọi phải viết
    } finally {
      ds.release('m1');
    }
    await p;
    check('4. Lượt chạy hỏng vẫn nhả khe, hàng đợi không kẹt', đượcVào === true);
  }

  // ── 5. Huỷ khi đang xếp hàng (người dùng bấm Dừng lúc máy còn chờ) ──
  // Phải giải lời hứa bằng `false`, không được để treo — treo thì nơi gọi chờ mãi rồi spawn
  // tiến trình cho một máy người dùng đã bảo dừng.
  {
    ds._resetForTest(); ds.setMax(1);
    await ds.acquire('m1');
    let kq = null;
    const p = ds.acquire('m2').then((r) => { kq = r; });
    await new Promise((r) => setImmediate(r));
    const đãHuỷ = ds.cancel('m2');
    await p;
    check('5. Huỷ lúc đang chờ thì trả về false, không treo', đãHuỷ === true && kq === false);
    check('5b. Máy đã huỷ không còn trong hàng', ds.waitingCount() === 0 && !ds.isWaiting('m2'));

    // và khe nhả ra sau đó KHÔNG được trao cho máy đã huỷ
    let m3 = false;
    const p3 = ds.acquire('m3').then((r) => { m3 = r; });
    await new Promise((r) => setImmediate(r));
    ds.release('m1');
    await p3;
    check('5c. Khe nhả sau đó trao cho máy còn chờ, không trao cho máy đã huỷ',
      m3 === true && ds.isActive('m3') && !ds.isActive('m2'));
  }

  // ── 6. Nới trần thì máy đang chờ được vào ngay ──
  // Người dùng đang chạy 6 máy, kéo trần lên 10 — 4 máy chờ phải vào luôn, không phải bấm lại.
  {
    ds._resetForTest(); ds.setMax(1);
    await ds.acquire('m1');
    let a = false, b = false;
    ds.acquire('m2').then((r) => { a = r; });
    ds.acquire('m3').then((r) => { b = r; });
    await new Promise((r) => setImmediate(r));
    check('6. Trước khi nới: 2 máy đang chờ', ds.waitingCount() === 2);
    ds.setMax(3);
    await new Promise((r) => setImmediate(r));
    check('6b. Nới trần thì máy đang chờ vào ngay', a === true && b === true && ds.activeCount() === 3);
  }

  // ── 7. Trần bị kẹp vào khoảng hợp lệ ──
  // 0 hoặc số âm mà lọt qua là KHÔNG máy nào chạy được nữa, và người dùng không hiểu vì sao.
  {
    ds._resetForTest();
    check('7. setMax(0) bị kẹp lên 1', ds.setMax(0) === 1);
    check('7b. setMax(-5) bị kẹp lên 1', ds.setMax(-5) === 1);
    check('7c. setMax("abc") về mặc định', ds.setMax('abc') === ds.DEFAULT_MAX);
    check('7d. setMax(999) bị kẹp xuống 50', ds.setMax(999) === 50);
    check('7e. setMax("8") nhận chuỗi số (giá trị từ ô nhập luôn là chuỗi)', ds.setMax('8') === 8);
  }

  // ── 8. Giãn cách khởi động ──
  // Hai máy cùng được nhả khe một lúc mà spawn cùng lúc thì vẫn dồn cục đúng thứ ta tránh.
  {
    ds._resetForTest(); ds.setStaggerMs(3000);
    const t = 1_000_000;
    check('8. Lượt đầu không phải chờ', ds.staggerDelay(t) === 0);
    check('8b. Lượt kế chờ đúng một nhịp giãn', ds.staggerDelay(t) === 3000);
    check('8c. Lượt thứ ba chờ hai nhịp', ds.staggerDelay(t) === 6000);
    check('8d. Gọi muộn hơn thì không phải chờ nữa', ds.staggerDelay(t + 99000) === 0);
    ds.setStaggerMs(0);
    check('8e. Giãn cách 0 = tắt (0 là giá trị hợp lệ, không phải "chưa đặt")',
      ds.staggerDelay(t + 99000) === 0 && ds.getStaggerMs() === 0);
  }

  // ── 9. Xin khe hai lần cho cùng một máy không chiếm hai chỗ ──
  {
    ds._resetForTest(); ds.setMax(2);
    await ds.acquire('m1');
    await ds.acquire('m1');
    check('9. Xin hai lần vẫn chỉ chiếm một khe', ds.activeCount() === 1, `${ds.activeCount()}`);
    ds.release('m1');
    check('9b. Nhả một lần là hết', ds.activeCount() === 0);
    check('9c. Nhả máy không giữ khe không làm sập', ds.release('khong-co') === false);
  }

  ds._resetForTest();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
  process.exit(failed.length ? 1 : 0);
})();
