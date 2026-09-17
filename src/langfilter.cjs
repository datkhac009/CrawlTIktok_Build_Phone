'use strict';
// ── Nhận diện video thuộc nhóm ngôn ngữ/quốc gia cần dạy feed bỏ qua (2026-08-11) ──
//
// Dùng cho tính năng "⋯ → Not interested": đọc TÊN KÊNH + CAPTION của video đang xem, nếu
// khớp thì bấm Not interested để TikTok thôi đề xuất nội dung tương tự cho profile đó.
//
// Module này CỐ Ý thuần (không đụng Playwright, không đụng đĩa) để test được offline —
// đây cũng là phần dễ sai nhất và hậu quả không hoàn tác được (mỗi cú bấm dạy vĩnh viễn cho
// tài khoản), nên phải khóa bằng phép thử.
//
// ⚠ HAI TẦNG, PHẢI CÓ CẢ HAI:
//
//   1. KÝ TỰ — bắt caption viết bằng chữ bản địa.
//   2. TỪ KHÓA — bắt caption viết bằng TIẾNG ANH.
//
// Vì sao bắt buộc tầng 2: rất nhiều kênh Afghanistan/Pakistan/Bangladesh nhắm người xem quốc
// tế nên viết caption hoàn toàn bằng tiếng Anh. Ví dụ thật do chủ dự án cung cấp:
//     tên kênh "Afghan Daily"
//     caption  "GIVE HER THE ICE CREAM ... #afghanistan #afghantiktok"
// KHÔNG có một ký tự Ả Rập nào — chỉ dò ký tự là bỏ lọt sạch.

// ── Nhóm ký tự ──
//
// ⚠ Urdu (Pakistan), Pashto/Dari (Afghanistan), tiếng Ả Rập (Trung Đông) và tiếng Ba Tư (Iran)
// DÙNG CHUNG bảng chữ Ả Rập. Không có cách nào tách chúng bằng dải Unicode.
// Cách duy nhất để nhắm đúng Pakistan/Afghanistan mà không quét luôn Trung Đông là dò các chữ
// cái MỞ RỘNG — thứ mà tiếng Ả Rập chuẩn KHÔNG dùng. Đó là các nhóm 'urdu'/'pashto'/'perso'
// bên dưới. Nhóm 'arabic' (cả dải) để sẵn nhưng MẶC ĐỊNH TẮT.
const SCRIPT_GROUPS = {
  bengali: {
    label: 'Bengali — Bangladesh',
    note: 'Chữ riêng, không lẫn với ngôn ngữ nào khác.',
    re: /[ঀ-৿]/,
  },
  urdu: {
    label: 'Urdu — Pakistan',
    note: 'Chữ cái riêng của Urdu: ٹ ڈ ڑ ں ھ ہ ے',
    re: /[ٹڈڑںھہۂۃے]/,
  },
  pashto: {
    label: 'Pashto — Afghanistan',
    note: 'Chữ cái riêng của Pashto: ټ ځ څ ډ ړ ږ ښ ګ ڼ ې ۍ',
    re: /[ځڅټډړږښګڼۍې]/,
  },
  perso: {
    label: 'Chữ Ba Tư dùng chung — Urdu / Pashto / Dari / Farsi',
    note: 'پ چ ژ ک گ ی — tiếng Ả Rập chuẩn KHÔNG dùng, nhưng Iran thì có. '
      + 'Dari (Afghanistan) và Farsi (Iran) gần như cùng một ngôn ngữ nên KHÔNG tách được.',
    re: /[پچژکگی]/,
  },
  arabic: {
    label: 'Toàn bộ chữ Ả Rập — RỘNG',
    note: '⚠ Chặn luôn Ả Rập Xê Út, Ai Cập, UAE, Iran... Chỉ bật nếu thực sự muốn cả nhóm đó.',
    // ⚠ VIẾT BẰNG \uXXXX, KHÔNG dán ký tự thật (sửa 2026-09-16).
    // Bản cũ dán ký tự thật và biên trên là U+FEFF — mà U+FEFF KHÔNG phải chữ Ả Rập, nó là
    // BOM / zero-width no-break space, một ký tự VÔ HÌNH lẫn vào text ở khắp nơi. Nó cũng vô
    // hình luôn trong chính mã nguồn này nên không ai soi ra. Khối Arabic Presentation
    // Forms-B dừng thật ở U+FEFC; U+FEFD/U+FEFE chưa gán.
    // Khớp nhầm ở đây không chỉ mất một link: nếu bật ô bấm Not interested thì là DẠY VĨNH
    // VIỄN cho tài khoản.
    re: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]/,
  },
  indic: {
    label: 'Toàn bộ chữ Ấn Độ — RỘNG',
    note: '⚠ Devanagari → Sinhala: Hindi, Marathi, Nepal, Punjab, Gujarat, Odia, Tamil, '
      + 'Telugu, Kannada, Malayalam, Sri Lanka. Không tách được theo nước — cùng lý do như '
      + 'chữ Ả Rập không tách được Iran khỏi Ai Cập. PHỦ CHỒNG nhóm Bengali (U+0980–09FF): '
      + 'bật nhóm này là Bangladesh cũng bị chặn dù không tích ô Bengali.',
    re: /[\u0900-\u0DFF]/,
  },
};

const DEFAULT_SCRIPTS = ['bengali', 'urdu', 'pashto', 'perso'];

// ── Từ khóa mặc định ──
//
// Khớp theo CHUỖI CON (không theo ranh giới từ) — bắt buộc phải vậy để bắt được hashtag dính
// liền như "#afghantiktok", "#banglatiktok".
//
// ⚠ Hệ quả: từ càng ngắn càng dễ bắt nhầm. Hai từ đã bị LOẠI khỏi danh sách mặc định sau khi
// soát lại, ghi ra đây để đừng ai thêm lại:
//   - "dari"  : nằm trong "man-dari-n", và là một từ CỰC KỲ phổ biến trong tiếng Indonesia
//               (nghĩa là "từ") → sẽ chặn nhầm gần như toàn bộ nội dung Indonesia.
//   - "desi"  : phủ cả Ấn Độ, rộng hơn 3 nước chủ dự án yêu cầu.
const DEFAULT_KEYWORDS = [
  'afghan', 'afghanistan', 'kabul', 'pashto', 'pashtun', 'kandahar',
  'pakistan', 'pakistani', 'urdu', 'karachi', 'lahore', 'islamabad',
  'bangladesh', 'bangladeshi', 'bangla', 'dhaka',
];

// Người dùng dán mỗi dòng một từ (hoặc ngăn bằng dấu phẩy). Bỏ dòng trống và dòng ghi chú '#'.
function parseKeywords(raw) {
  if (Array.isArray(raw)) raw = raw.join('\n');
  return String(raw || '')
    .split(/[\r\n,]+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => s && !s.startsWith('#'));
}

function normalizeScripts(list) {
  const out = [];
  for (const k of (list || [])) {
    if (SCRIPT_GROUPS[k] && !out.includes(k)) out.push(k);
  }
  return out;
}

// Tạo bộ so khớp. cfg = { scripts: [...], keywords: '...' | [...] }
// Trả về hàm nhận { author, desc } và trả về:
//   - null nếu KHÔNG khớp
//   - { where, kind, detail, reason } nếu khớp — `reason` là câu tiếng Việt để ghi log.
//
// `author` nên gồm cả tên hiển thị lẫn @handle (nối chuỗi là đủ) — kênh "Afghan Daily" bị bắt
// bằng tên hiển thị, còn "@afghan.daily" bị bắt bằng handle.
// Bỏ mọi DẤU PHỤ TỔ HỢP (Unicode Mn) — chỉ dùng cho tầng dò KÝ TỰ, không dùng cho tầng từ
// khóa. Xem lý do đầy đủ ở chỗ gọi trong `makeMatcher`.
//
// An toàn với tiếng Việt: chuỗi tiếng Việt lấy từ DOM ở dạng NFC dùng ký tự DỰNG SẴN (ề, ạ…)
// nên không có Mn nào để bỏ. Kể cả gặp dạng NFD thì cũng chỉ ảnh hưởng tầng ký tự, mà không
// nhóm nào trong SCRIPT_GROUPS nhắm tới chữ Latin.
function stripMarks(s) {
  try { return String(s).replace(/\p{Mn}/gu, ''); } catch (_) { return String(s); }
}

function makeMatcher(cfg) {
  const scripts = normalizeScripts((cfg && cfg.scripts) || DEFAULT_SCRIPTS);
  const keywords = parseKeywords(cfg && cfg.keywords != null ? cfg.keywords : DEFAULT_KEYWORDS);

  const fields = [
    { key: 'author', label: 'tên kênh' },
    { key: 'desc', label: 'caption' },
  ];

  return function match(meta) {
    if (!meta) return null;
    // Ký tự trước: rẻ hơn (một regex/trường) và là tín hiệu chắc chắn hơn từ khóa.
    for (const f of fields) {
      const raw = String(meta[f.key] || '');
      if (!raw) continue;
      // ⚠ BỎ DẤU PHỤ TỔ HỢP TRƯỚC KHI DÒ (sửa 2026-09-09 — đo được từ log thật).
      // Các dấu phụ Ả Rập (ً ٌ ْ ࣭ …) bị dùng RẤT NHIỀU để TRANG TRÍ tên trên TikTok, không hề
      // mang nghĩa ngôn ngữ. Nhóm "Toàn bộ chữ Ả Rập" khớp cả chúng, nên đã bấm nhầm
      // "Not interested" vào @8k.vibe, @secret.acc111, @.rancito, @offlixneee — 5/10 cú bấm
      // trong một lượt chạy là bắn nhầm, mà mỗi cú DẠY VĨNH VIỄN cho tài khoản đó.
      // Chữ Ả Rập thật luôn có CHỮ CÁI, không chỉ dấu phụ, nên lọc bỏ dấu là đủ tách hai ca.
      const text = stripMarks(raw);
      if (!text) continue;
      for (const key of scripts) {
        const g = SCRIPT_GROUPS[key];
        if (g && g.re.test(text)) {
          return {
            where: f.key, kind: 'script', detail: key,
            reason: `${f.label} có ký tự ${g.label}`,
          };
        }
      }
    }
    for (const f of fields) {
      const text = String(meta[f.key] || '').toLowerCase();
      if (!text) continue;
      for (const kw of keywords) {
        if (text.includes(kw)) {
          return {
            where: f.key, kind: 'keyword', detail: kw,
            reason: `${f.label} chứa từ khóa "${kw}"`,
          };
        }
      }
    }
    return null;
  };
}

module.exports = {
  SCRIPT_GROUPS,
  DEFAULT_SCRIPTS,
  DEFAULT_KEYWORDS,
  parseKeywords,
  normalizeScripts,
  makeMatcher,
};
