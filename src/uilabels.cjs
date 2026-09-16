// src/uilabels.cjs — Nhãn giao diện TikTok theo NGÔN NGỮ TÀI KHOẢN. THUẦN: không đụng
// Playwright/đĩa/Electron → test offline được.
//
// VÌ SAO CÓ FILE NÀY (2026-08-22): TikTok dịch mọi nhãn theo ngôn ngữ của tài khoản đang đăng
// nhập. Dự án đã trả giá cho điều này HAI lần:
//
//   • QĐ-23 — chữ "original sound" bị dịch (`son original`, `suara asli`, `오리지널 사운드`…)
//     nên link bản địa hóa không được rút gọn, và cùng một sound ra nhiều key → đẩy trùng.
//   • Ngày 2026-08-22 — mục menu "Not interested" trên profile `(FR2)` là tiếng Pháp, không
//     khớp regex chỉ-Anh-Việt, nên tính năng **tự tắt** sau 3 lần thất bại. Không có lỗi nào
//     chỉ ra nguyên nhân là "sai ngôn ngữ".
//
// Nay thêm nút **Follow** — cũng bị dịch y hệt. Gom hết vào một chỗ để lần sau chỉ phải thêm
// một dòng, thay vì đi tìm regex rải rác (trước file này có 3 bản sao regex Follow nằm trong
// 3 hàm dò khác nhau của crawler.cjs).
'use strict';

// ── Chuẩn hóa để so: NFC + gập dấu nháy + chữ thường + gom khoảng trắng ──
// NFC là BẮT BUỘC, không phải cho đẹp: tiếng Hàn và tiếng Việt có 2 cách mã hóa cùng một chữ
// (dựng sẵn / tổ hợp), nhìn y hệt nhau nhưng khác byte → so chuỗi trượt mà không ai hiểu vì sao.
//
// GẬP DẤU NHÁY (2026-09-09): TikTok in nhãn bằng dấu nháy CONG U+2019 ("S’abonner"), còn chuỗi
// gõ trong file này là dấu nháy THẲNG U+0027 ("S'abonner"). Nhìn y hệt nhau, khác byte, không
// khớp. Cùng loại lỗi với NFC ở trên nên xử lý cùng chỗ. Gập cả nháy kép để nhãn tiếng Nhật/
// Trung dùng „…“ hay “…” cũng về một mối.
//
// ⚠ BA BẢN SAO của hàm này chạy TRONG TRÌNH DUYỆT (page.evaluate không require được):
// crawler.cjs ~672 (Not interested), ~744 (tìm nút Follow), ~797 (đọc lại để xác minh).
// Sửa ở đây thì PHẢI sửa cả ba — danh sách nhãn đã gập mà chữ đọc từ trang chưa gập là
// hỏng nặng hơn không sửa. tests/srcsync.test.cjs canh chuyện đó.
const _QUOTES = /[‘’‚‛′´`＇ʼ]/g;   // → '
const _DQUOTES = /[“”„‟″＂]/g;             // → "
function normLabel(s) {
  let x = String(s == null ? '' : s);
  try { x = x.normalize('NFC'); } catch (_) {}
  return x.replace(_QUOTES, '\'').replace(_DQUOTES, '"')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// ⚠ KHỚP TRỌN CHUỖI, không phải chứa-chuỗi-con. Nút "Follow" và chữ "Followers 1.2M" chỉ khác
// nhau ở chỗ đó; khớp chuỗi con là bấm nhầm vào ô đếm người theo dõi. Nhãn nút vốn ngắn và
// đứng một mình nên khớp trọn là đúng.
function _match(text, list, maxLen = 30) {
  const t = normLabel(text);
  if (!t || t.length > maxLen) return false;   // nhãn nút không bao giờ dài như vậy
  return list.includes(t);
}

// ── Nhóm A: ĐÃ THẤY THẬT (có trong mã cũ hoặc đọc được từ log/ảnh của chủ dự án) ──
// ── Nhóm B: thêm theo hiểu biết về bản địa hóa TikTok, CHƯA đối chiếu dữ liệu thật.
//    Nhãn sai thì chỉ đơn giản là KHÔNG KHỚP — không gây hại, không bấm nhầm. Gặp ngôn ngữ
//    lạ thì thêm một dòng vào đây là xong.

const FOLLOW_LABELS = [
  'follow',                    // en  (A)
  'theo dõi',                  // vi  (A)
  's\'abonner', 'suivre',      // fr  (B) — TikTok FR dùng "S'abonner"
  'seguir',                    // es/pt (B)
  'folgen',                    // de  (B)
  'segui',                     // it  (B)
  'volgen',                    // nl  (B)
  'obserwuj',                  // pl  (B)
  'takip et',                  // tr  (B)
  'подписаться',               // ru  (B)
  'ikuti',                     // id/ms (B)
  'sundin',                    // tl  (B)
  'ติดตาม',                     // th  (B)
  '팔로우',                     // ko  (B)
  'フォロー',                    // ja  (B)
  '关注',                       // zh-Hans (B)
  '追蹤',                       // zh-Hant (B)
  'متابعة',                    // ar  (B)
  'फ़ॉलो करें',                   // hi  (B)
].map(normLabel);

// Trạng thái SAU KHI đã follow — dùng để XÁC MINH cú bấm có ăn không.
// Đây là hàng rào an toàn quan trọng nhất của tính năng: không đọc được trạng thái mới thì
// coi như thất bại, thà không follow còn hơn tưởng đã follow mà chưa.
const FOLLOWING_LABELS = [
  'following', 'friends',            // en  (A) — TikTok đổi thành "Friends" khi hai bên follow nhau
  'đang theo dõi', 'bạn bè',         // vi  (A)
  'abonné', 'abonné(e)', 'abonnement', 'amis',   // fr (B)
  'siguiendo', 'seguindo', 'amigos', // es/pt (B)
  'gefolgt', 'folge ich', 'freunde', // de  (B)
  'segui già', 'amici',              // it  (B)
  'volgend',                         // nl  (B)
  'obserwujesz',                     // pl  (B)
  'takiptesin', 'takip ediliyor',    // tr  (B)
  'подписки', 'вы подписаны',        // ru  (B)
  'mengikuti', 'diikuti',            // id/ms (B)
  'กำลังติดตาม',                      // th  (B)
  '팔로잉',                          // ko  (B)
  'フォロー中',                       // ja  (B)
  '已关注',                          // zh-Hans (B)
  '已追蹤',                          // zh-Hant (B)
  'متابَع', 'يتابع',                  // ar  (B)
].map(normLabel);

// Để SẴN cho lần sửa "Not interested" đa ngôn ngữ (chủ dự án đang hoãn). Chưa nơi nào dùng —
// giữ ở đây để khi cần chỉ việc nối dây, và để chỗ này là nơi duy nhất chứa nhãn giao diện.
const NOT_INTERESTED_LABELS = [
  'not interested',                          // en (A)
  'không quan tâm', 'khong quan tam',        // vi (A)
  'pas intéressé', 'pas intéressé(e)', 'ça ne m\'intéresse pas',   // fr (B)
  'no me interesa', 'não tenho interesse',   // es/pt (B)
  'kein interesse', 'nicht interessiert',    // de  (B)
  'non mi interessa',                        // it  (B)
  'niet geïnteresseerd',                     // nl  (B)
  'nie interesuje mnie to',                  // pl  (B)
  'ilgilenmiyorum',                          // tr  (B)
  'не интересует',                           // ru  (B)
  'tidak tertarik',                          // id/ms (B)
  'ไม่สนใจ',                                  // th  (B)
  '관심 없음',                                // ko  (B)
  '興味なし',                                 // ja  (B)
  '不感兴趣',                                 // zh-Hans (B)
  '不感興趣',                                 // zh-Hant (B)
  'غير مهتم',                                // ar  (B)
].map(normLabel);

// ── NHÃN "nội dung do AI tạo" (2026-09-15, QĐ-50) ──
//
// TikTok gắn một badge ngay trong khung video cho nội dung sinh bởi AI. Feed của chủ dự án
// đang bị loại này lấp đầy (ảnh chụp 2026-09-15: chó mèo băng bó cạnh bánh sinh nhật), và
// sound của chúng vô giá trị với mục tiêu thu link.
//
// ⚠ NHÃN NÀY DÀI HƠN NHÃN NÚT nên phải nới trần độ dài (`AI_MAX_LEN`). Tiếng Thổ và tiếng Ả
// Rập vượt xa 30 ký tự — giữ trần cũ là loại sạch hai thứ tiếng đó mà không báo gì.
//
// ⚠ VẪN KHỚP TRỌN CHUỖI, không dùng chứa-chuỗi-con. Ba lý do:
//   1. Caption nằm trong cùng khung video — người đăng viết "#aigenerated" là khớp nhầm.
//   2. TÊN SOUND cũng nằm trong khung đó, và hoàn toàn có thể là "AI generated beat".
//   3. Cú bấm "Not interested" dạy VĨNH VIỄN cho tài khoản, không hoàn tác được (QĐ-31).
const AI_MAX_LEN = 80;
const AI_LABELS = [
  // ── Nhóm A: ĐÃ THẤY TẬN MẮT trên ảnh chụp của chủ dự án (giao diện tiếng Anh) ──
  'contains ai-generated media',
  // ── Nhóm B: suy theo cách TikTok bản địa hóa, CHƯA đối chiếu dữ liệu thật ──
  // Sai thì chỉ đơn giản là KHÔNG KHỚP: mất tính năng chứ không bấm nhầm. Và đường tự vá
  // trong crawler sẽ in ra chuỗi lạ để bổ sung đúng vào đây.
  'ai-generated', 'ai-generated content',              // en (B) — biến thể ngắn
  'chứa nội dung do ai tạo', 'có nội dung do ai tạo',  // vi (B)
  'nội dung do ai tạo',                                // vi (B)
  'contient du contenu généré par ia',                 // fr (B)
  'contenu généré par ia',                             // fr (B)
  'contiene contenido generado por ia',                // es (B)
  'contém conteúdo gerado por ia',                     // pt (B)
  'enthält ki-generierte inhalte',                     // de (B)
  "contiene contenuti generati dall'ia",              // it (B)
  'bevat door ai gegenereerde media',                  // nl (B)
  'zawiera treści wygenerowane przez ai',              // pl (B)
  'yapay zeka ile oluşturulmuş içerik içerir',         // tr (B)
  'содержит контент, созданный ии',                    // ru (B)
  'berisi media yang dihasilkan ai',                   // id/ms (B)
  'มีสื่อที่สร้างโดย ai',                                      // th (B)
  'ai 생성 콘텐츠 포함',                                 // ko (B)
  'ai生成コンテンツを含みます',                            // ja (B)
  '包含ai生成内容',                                      // zh-Hans (B)
  '包含ai生成內容',                                      // zh-Hant (B)
  'يحتوي على وسائط من إنشاء الذكاء الاصطناعي',           // ar (B)
].map(normLabel);

// Dấu hiệu "có thể là nhãn AI của một ngôn ngữ mình CHƯA có". Dùng cho đường TỰ VÁ: gặp chuỗi
// khớp cái này mà không khớp `AI_LABELS` thì ghi một dòng để bổ sung — biến lượt chạy thật
// thành cái probe. KHÔNG bao giờ dùng nó để quyết định bấm: quá lỏng.
// ⚠ `\b` trong JS chỉ hiểu chữ ASCII, nên với tiếng Nga phải tự viết ranh giới:
// `\bии\b` KHÔNG khớp, mà bỏ ranh giới thì 'России' cũng khớp.
const _AI_HINT = /\bai\b|\bia\b|\bki\b|(?:^|[^а-яёА-ЯЁ])ии(?:[^а-яёА-ЯЁ]|$)|ai生成|ai 생성|인공지능|الذكاء الاصطناعي|yapay zeka/i;

function isFollowLabel(text) { return _match(text, FOLLOW_LABELS); }
function isFollowingLabel(text) { return _match(text, FOLLOWING_LABELS); }
function isNotInterestedLabel(text) { return _match(text, NOT_INTERESTED_LABELS); }
function isAiLabel(text) { return _match(text, AI_LABELS, AI_MAX_LEN); }
// Trả true nếu chuỗi TRÔNG GIỐNG nhãn AI nhưng chưa có trong danh sách — chỉ để ghi log.
function isMaybeAiLabel(text) {
  const t = normLabel(text);
  if (!t || t.length > AI_MAX_LEN) return false;
  if (AI_LABELS.includes(t)) return false;   // đã biết rồi thì không phải "lạ"
  return _AI_HINT.test(t);
}

module.exports = {
  normLabel,
  FOLLOW_LABELS, FOLLOWING_LABELS, NOT_INTERESTED_LABELS, AI_LABELS, AI_MAX_LEN,
  isFollowLabel, isFollowingLabel, isNotInterestedLabel, isAiLabel, isMaybeAiLabel,
};
