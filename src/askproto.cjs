// src/askproto.cjs — Bộ não phía Node. Python đưa chữ đọc được trên màn hình, đây ra phán quyết.
//
// VÌ SAO ĐẶT PHÁN XÉT Ở NODE CHỨ KHÔNG Ở PYTHON (2026-09-15):
// Viết lại bộ lọc bằng Python là sinh ra **bản thứ hai âm thầm lệch đi**. Chuyện đó ĐÃ xảy ra:
// `linkkey.cjs` có ở cả hai app và đã lệch, khiến Python lọc Original Sound bằng
// `["contains:", "bao gồm"]` — chỉ tiếng Anh và tiếng Việt. Máy để TikTok tiếng Pháp là ô "Chỉ
// lấy Original Sound" hỏng câm.
//
// Nên Python chỉ **đọc chữ và thi hành**; mọi phán xét dùng lại `langfilter` + `uilabels` của
// bản PC, vốn có 587 phép thử bảo vệ.
//
// ⚠ VÌ SAO GIAO THỨC NÀY GẦN NHƯ MIỄN PHÍ:
// Python gửi câu hỏi TRƯỚC khi bấm icon sound, rồi mới lấy câu trả lời SAU khi back về feed.
// Quãng 5–9 giây mở trang nhạc che trọn thời gian đi về, nên đường bình thường không tốn thêm
// mili-giây nào. Thời gian chờ chỉ chạy khi có sự cố thật.
//
// ⚠ MẶC ĐỊNH AN TOÀN LÀ HÀNH VI HÔM NAY:
// Hết giờ / EOF / JSON hỏng / lệch id / lệch phiên bản → `ni=0, follow=0, like=0, visit=0`, việc
// quét chạy tiếp y nguyên. Rút hẳn phía Node ra thì app vẫn làm đúng việc nó đang làm. Hướng
// sai ở đây là **mất tính năng**, không bao giờ là **bấm nhầm lên tài khoản thật**.
'use strict';

const langfilter = require('./langfilter.cjs');
const uilabels = require('./uilabels.cjs');
const channelstore = require('./channelstore.cjs');
const followquota = require('./followquota.cjs');
const daycount = require('./daycount.cjs');
const { normalizeHandle } = require('./followpolicy.cjs');

const PROTO_VERSION = 1;

// Câu trả lời an toàn: không bấm gì cả. Dùng cho MỌI đường hỏng.
function safeAnswer(id) {
  return { v: PROTO_VERSION, id: id | 0, ni: 0, why: '', follow: 0, like: 0, visit: 0 };
}

function makeBrain({ deviceId, dir, cfg = {}, say = () => {} }) {
  // Dựng bộ khớp ngôn ngữ MỘT LẦN cho cả lượt chạy: `makeMatcher` biên dịch regex và chuẩn hoá
  // danh sách từ khoá, gọi lại mỗi video là phí.
  const matcher = (cfg.niEnabled || cfg.followOn || cfg.likeOn)
    ? langfilter.makeMatcher({ scripts: cfg.niScripts, keywords: cfg.niKeywords })
    : null;

  const dem = {
    asked: 0, lang: 0, ai: 0, ni: 0,
    follow: 0, followFail: 0, like: 0, likeFail: 0, visit: 0,
    askFail: 0,
  };
  const viDu = [];          // vài ví dụ kênh bị loại, để soi xem có khớp nhầm không
  let daBaoNhanLa = false;  // đường tự vá: chỉ in MỘT dòng mỗi lượt chạy

  // Quyền follow đã cấp cho video đang hỏi. Python chỉ dùng khi sound hoá ra hợp lệ.
  let dangCho = null;       // { id, handle }

  function answer(ask) {
    try {
      if (!ask || typeof ask !== 'object') { dem.askFail++; return safeAnswer(0); }
      const id = ask.id | 0;
      if (ask.v !== PROTO_VERSION) {
        // Lệch phiên bản giao thức: phần JS và phần Python không cùng một bản build. Không có
        // triệu chứng nào khác ngoài dòng này, nên phải nói to.
        dem.askFail++;
        if (!answer._daBaoLechV) {
          answer._daBaoLechV = true;
          say(`⚠ Lệch phiên bản giao thức: Python gửi v=${ask.v}, Node hiểu v=${PROTO_VERSION}. `
            + 'Phần .py không cùng bản build với app — mọi tính năng lọc/tương tác sẽ KHÔNG chạy.');
        }
        return safeAnswer(id);
      }
      // ── KIỂM HÌNH DẠNG CÂU HỎI TRƯỚC KHI CẤP BẤT KỲ QUYỀN NÀO ──
      //
      // Bài học từ chính phép thử của file này (2026-09-15): câu hỏi thiếu `id`, hoặc có
      // `badges` không phải mảng, vẫn lọt qua cửa phiên bản. Vì nó cũng không có caption nên
      // không dính bộ lọc nào, và kết quả là **được cấp quyền tym** — tức bấm lên một video mà
      // phía Node không biết gì về nó. Thiếu dữ liệu KHÔNG phải là "video sạch".
      //
      // Đếm riêng vào `askFail` để nó hiện ra ở dòng tổng kết, chứ không bỏ qua im lặng.
      const hopLe = Number.isInteger(id) && id >= 1
        && (ask.author === undefined || typeof ask.author === 'string')
        && (ask.desc === undefined || typeof ask.desc === 'string')
        && (ask.badges === undefined || Array.isArray(ask.badges))
        && (ask.handle === undefined || typeof ask.handle === 'string');
      if (!hopLe) { dem.askFail++; return safeAnswer(id); }

      dem.asked++;

      const author = String(ask.author || '').slice(0, 300);
      const desc = String(ask.desc || '').slice(0, 500);
      const badges = Array.isArray(ask.badges) ? ask.badges.slice(0, 12) : [];
      const handle = normalizeHandle(ask.handle);

      // ── Nhãn AI ──
      const nhanAi = badges.find((b) => uilabels.isAiLabel(b));
      const laAi = !!nhanAi;
      if (laAi) dem.ai++;

      // ── Đường TỰ VÁ: chữ lạ trông như nhãn AI nhưng chưa có trong danh sách ──
      // Farm 19 máy chạy nhiều ngôn ngữ chính là cái probe mà tôi không làm được từ máy mình.
      if (!laAi && !daBaoNhanLa) {
        const la = badges.find((b) => uilabels.isMaybeAiLabel(b));
        if (la) {
          daBaoNhanLa = true;
          say(`ℹ Thấy nhãn lạ có thể là nhãn AI: "${String(la).slice(0, 80)}" — gửi lại chuỗi này để bổ sung.`);
        }
      }

      // ── Lọc ngôn ngữ ──
      const khop = matcher ? matcher({ author, desc }) : null;
      if (khop) dem.lang++;

      // ── Bấm "Not interested" — mặc định TẮT, vì cú bấm dạy vĩnh viễn, không hoàn tác ──
      let ni = 0;
      let why = '';
      if (cfg.niEnabled && khop) { ni = 1; why = 'lang'; }
      else if (cfg.niAi && laAi) { ni = 1; why = 'ai'; }
      if (ni) {
        dem.ni++;
        if (viDu.length < 5) viDu.push(`${handle || '?'} (${why === 'ai' ? 'nhãn AI' : (khop && khop.reason) || 'ngôn ngữ'})`);
      }

      // Video đã bị loại thì KHÔNG tương tác với chủ nó. Nuôi feed bằng chính thứ mình vừa loại
      // là tự phá mục tiêu.
      const biLoai = !!khop || laAi;

      // ── Quyền FOLLOW: cấp trước, Python chỉ dùng nếu sound hoá ra hợp lệ ──
      let follow = 0;
      dangCho = null;
      if (cfg.followOn && !biLoai && handle) {
        const q = followquota.canFollow({
          deviceId, dir, handle,
          opts: {
            perDay: cfg.followPerDay,
            gapMinSec: cfg.followGapMin,
            gapMaxSec: cfg.followGapMax,
          },
        });
        if (q.ok) { follow = 1; dangCho = { id, handle }; }
      }

      // ── Quyền TYM ──
      // Cũng đòi có `handle`: tym là một cú bấm lên video của MỘT người cụ thể. Không đọc được
      // chủ video nghĩa là màn hình chưa đọc xong hoặc đang ở đâu đó khác — bấm lúc đó là bấm mù.
      let like = 0;
      if (cfg.likeOn && !biLoai && handle) {
        if (daycount.remaining(dir, 'like', cfg.likePerDay) > 0) like = 1;
      }

      // ── Quyền GHÉ THĂM kênh ──
      let visit = 0;
      if (cfg.visitOn && !biLoai && handle) {
        const tran = Math.max(0, parseInt(cfg.visitMaxUsers, 10) || 0);
        if (tran === 0 || dem.visit < tran) visit = 1;   // 0 = không giới hạn (khác với follow/tym)
      }

      return { v: PROTO_VERSION, id, ni, why, follow, like, visit };
    } catch (e) {
      // Không bao giờ để lỗi ở đây làm chết tiến trình chính — 8 máy đang phụ thuộc vào nó.
      dem.askFail++;
      return safeAnswer(ask && ask.id);
    }
  }

  // Python báo lại KẾT QUẢ THẬT của từng cú bấm.
  //
  // ⚠ CHỈ GHI SỔ KHI ĐÃ XÁC MINH. `channelstore.cjs:182-184` cảnh báo đúng chỗ này: ghi
  // `recordFollow` lúc BẤM thay vì lúc nút đã đổi sang "Following" thì kênh bị đánh dấu đã
  // follow dù follow hỏng, và **bị bỏ qua vĩnh viễn**.
  function noteActed(evt) {
    try {
      if (!evt) return;
      if (evt.follow === 'ok') {
        const h = (dangCho && dangCho.id === (evt.id | 0)) ? dangCho.handle : normalizeHandle(evt.handle);
        if (h) {
          channelstore.recordFollow(dir, h);
          followquota.noteFollowed(deviceId, dir, {
            perDay: cfg.followPerDay, gapMinSec: cfg.followGapMin, gapMaxSec: cfg.followGapMax,
          });
          dem.follow++;
        }
      } else if (evt.follow === 'fail') {
        dem.followFail++;
      }

      if (evt.like === 'ok') { daycount.record(dir, 'like'); dem.like++; }
      else if (evt.like === 'fail') { dem.likeFail++; }

      if (evt.visit === 'ok') dem.visit++;
    } catch (_) { /* ghi sổ hỏng không được làm chết vòng quét */ }
  }

  function noteAskFail() { dem.askFail++; }

  // Dòng tổng kết cuối lượt. Bộ đếm về 0 là dấu hiệu thấy ngay rằng nhận diện đã trượt.
  function summary() {
    const p = [];
    if (dem.asked) p.push(`hỏi ${dem.asked} video`);
    if (dem.lang) p.push(`loại ${dem.lang} vì ngôn ngữ`);
    if (dem.ai) p.push(`loại ${dem.ai} gắn nhãn AI`);
    if (dem.ni) p.push(`bấm Not interested ${dem.ni}`);
    if (dem.follow || dem.followFail) p.push(`follow ${dem.follow}${dem.followFail ? ` (hỏng ${dem.followFail})` : ''}`);
    if (dem.like || dem.likeFail) p.push(`tym ${dem.like}${dem.likeFail ? ` (hỏng ${dem.likeFail})` : ''}`);
    if (dem.visit) p.push(`ghé ${dem.visit} kênh`);
    if (dem.askFail) p.push(`⚠ ${dem.askFail} lượt hỏi hỏng`);
    if (!p.length) return '';
    let s = p.join(' · ');
    if (viDu.length) s += `\n   Ví dụ kênh bị loại: ${viDu.join(', ')}`;
    return s;
  }

  return { answer, noteActed, noteAskFail, summary, _dem: dem };
}

module.exports = { PROTO_VERSION, makeBrain, safeAnswer };
