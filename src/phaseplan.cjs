// src/phaseplan.cjs — Danh sách PHA của các chế độ chạy theo chu kỳ. THUẦN: không đụng
// Playwright, không đụng đĩa → test được offline.
//
// VÌ SAO TÁCH RA (2026-08-22): chế độ `cycle` có 2 pha (Quét ⇄ Xem) với vòng điều phối viết
// cứng trong crawler.cjs. Thêm một chế độ nhiều pha nữa bằng cách chép vòng đó ra là con
// đường ngắn nhất dẫn tới bản sao thứ hai — dự án đã có 4 bản sao vòng cuộn và từng mất một
// dòng log vì đúng kiểu chép này (QĐ-10). Nên vòng điều phối chỉ còn MỘT, và nó duyệt danh
// sách pha do file này sinh ra.
//
// ⚠ `cycle` là chế độ ĐANG CHẠY THẬT ngoài thực địa. Phép thử "buildPhasePlan('cycle') ra
// đúng 2 pha 5h/30p" trong tests/phaseplan.test.cjs là lưới an toàn tự động DUY NHẤT cho nó —
// đừng sửa phép thử đó cho khớp mã, phải sửa mã cho khớp phép thử.
'use strict';

const HOUR = 3600000;
const MIN = 60000;

// Nhãn phải NGẮN: nó hiện trong chip đếm ngược một dòng ở bảng profile
// ("⏳ Kênh · còn 12:34 → Quét"), dài là vỡ dòng.
// `channel` GỠ cùng Automation Loop (2026-09-14, QĐ-48): pha Kênh đã thành worker nền chạy
// suốt cả chu kỳ, không còn là một pha chiếm trọn thời lượng nữa. Giữ lại nhãn chết ở đây là
// để người đọc sau tưởng vẫn còn pha đó.
const LABEL = { scan: 'Quét', view: 'Xem' };

// ⚠ SỐ 0 LÀ GIÁ TRỊ HỢP LỆ, không phải giá trị rác: 0 nghĩa là "bỏ hẳn pha này" (cách chạy
// riêng một pha để kiểm chứng). Gộp 0 vào nhóm rác rồi trả về mặc định thì đặt 0 lại thành 60
// phút — người dùng tưởng đã tắt pha mà nó vẫn chạy nguyên giờ. Chỉ giá trị THẬT SỰ vô nghĩa
// (không phải số, âm, NaN) mới rơi về mặc định.
function _num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Trả về [{ key, label, ms }] — đã BỎ những pha có thời lượng <= 0.
//
// Bỏ pha 0 phút không phải để "cho gọn": nó là cách chạy riêng MỘT pha để kiểm chứng. Đặt
// thời lượng Xem = 0 thì `mix` thành ra chỉ quét, không cần thêm một chế độ nữa trong danh sách.
function buildPhasePlan(mode, opts = {}) {
  let raw;
  if (mode === 'cycle') {
    // GIỮ NGUYÊN đơn vị cũ: Quét tính bằng GIỜ, Xem tính bằng PHÚT. Đổi đơn vị ở đây là âm
    // thầm đổi hành vi của mọi profile đang chạy.
    raw = [
      { key: 'scan', ms: _num(opts.cycleScanHours, 5) * HOUR },
      { key: 'view', ms: _num(opts.cycleViewMinutes, 30) * MIN },
    ];
  } else if (mode === 'mix') {
    // ── QUÉT MIX (2026-09-14, QĐ-48) — thay cho Automation Loop ──
    // Chủ dự án: *"đơn giản chỉ là ghép Mix vào với nhau thôi"* — For You và Quét ⇄ Xem.
    // Đọc mã thì hoá ra gọn hơn tưởng: pha Quét của `cycle` CHÍNH LÀ cuộn For You. Khác biệt
    // duy nhất còn lại giữa hai chế độ là GHÉ THĂM KÊNH. Nên `mix` dùng đúng hai pha của
    // `cycle`, chỉ khác ở chỗ `visitOn` trong crawler.cjs bật thêm cho nó.
    //
    // KHÓA CÀI ĐẶT RIÊNG, tính bằng PHÚT. Không dùng chung `cycle*`: chỉnh chu kỳ của chế độ
    // này không được âm thầm đổi chế độ kia — quy tắc đã đặt từ hồi thêm `auto`.
    raw = [
      { key: 'scan', ms: _num(opts.mixScanMinutes, 60) * MIN },
      { key: 'view', ms: _num(opts.mixViewMinutes, 30) * MIN },
    ];
  // ⚠ Hai chế độ ĐÃ GỠ, và cả hai đều được `startProfile` đưa về chế độ khác KÈM MỘT DÒNG BÁO
  // — chết câm là thứ tài liệu dự án cấm:
  //   • `followed` ("Xem kênh đã follow"), gỡ 2026-09-10 (QĐ-38): cuộn feed Following, mà app
  //     không còn follow ai nên feed đó rỗng.
  //   • `auto` (Automation Loop: Quét → Xem → Kênh), gỡ 2026-09-14 (QĐ-48): pha Kênh đã thành
  //     worker nền chạy suốt chu kỳ, nên chia pha cứng cho nó không còn nghĩa. Profile đang
  //     lưu `auto` được đưa về `mix`.
  } else {
    return [];   // chế độ không chạy theo pha (foryou/search/current/view)
  }

  return raw
    .filter(p => p.ms > 0)
    .map(p => ({ key: p.key, label: LABEL[p.key], ms: Math.round(p.ms) }));
}

// Các chế độ do bộ chạy pha đảm nhiệm — dùng để phân nhánh trong crawler mà không phải liệt
// kê tay ở nhiều chỗ rồi sót một chỗ.
function isPhasedMode(mode) {
  return mode === 'cycle' || mode === 'mix';
}

module.exports = { buildPhasePlan, isPhasedMode, LABEL, HOUR, MIN };
