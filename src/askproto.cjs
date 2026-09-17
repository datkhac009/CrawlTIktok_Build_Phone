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
const visitbook = require('./visitbook.cjs');
const daycount = require('./daycount.cjs');
const { normalizeHandle } = require('./followpolicy.cjs');

// v2 (2026-09-16): thêm `live` (bỏ qua livestream) và nhịp hỏi thứ hai `kind:'follow_confirm'`.
//
// VÌ SAO PHẢI SANG v2 — đo được trên máy thật, TikTok v46.1.1:
// `@handle` **KHÔNG hề xuất hiện trên feed** (0/3 mẫu, grep thẳng XML không có chuỗi `text="@..."`
// nào). Nó chỉ nằm trên TRANG CÁ NHÂN. Mà bản v1 đòi `handle` khác rỗng cho cả follow, tym lẫn
// ghé trang — nên phán quyết luôn là `0 0 0` cho MỌI video, im lặng, không một dòng lỗi. Đó là
// lý do thật của "bật follow mà không thấy bấm gì".
//
// v2 tách danh tính làm hai mức:
//   - TÊN HIỂN THỊ (đọc được ngay trên feed, từ `user_avatar`) — đủ để lọc ngôn ngữ, tym, và để
//     biết "có đáng ghé không".
//   - @handle THẬT (chỉ có trên trang cá nhân) — bắt buộc cho follow, vì sổ chống trùng và trần
//     30 lượt/ngày khoá theo nó. Tên hiển thị không duy nhất và người ta đổi được; khoá sổ theo
//     tên hiển thị là có ngày hai kênh khác nhau bị coi là một.
// v3 (2026-09-17): thêm `like_profile` — cú tym thứ hai, lên video mở trong trang cá nhân.
// v4 (2026-09-17): thêm nhịp hỏi `kind:'visit_check'` — chống ghé trùng qua ngày.
//
// VÌ SAO NHỊP NÀY PHẢI NẰM TRONG TRANG, không gộp vào nhịp 1:
// Sổ chống ghé trùng khoá theo `@handle`, mà feed KHÔNG bày `@handle` (đo: 0/3 mẫu). Khoá theo
// tên hiển thị là coi hai kênh trùng tên thành một rồi bỏ qua oan — mà bỏ qua oan thì không để
// lại dấu vết gì để ai đó nhìn ra. Nên phải mở trang trước, đọc tên thật, rồi mới hỏi sổ.
// Đổi lại là một nhịp hỏi không có gì che; chấp nhận được vì nó là MỘT lần cho cả lượt ghé
// 10-20 giây, không phải mỗi video một lần như nhịp 1.
//
// VÌ SAO MỘT CÂU TRẢ LỜI MANG CẢ HAI CÚ TYM, thay vì thêm nhịp hỏi thứ ba:
// Nhịp hỏi hiện tại gần như miễn phí vì nó nấp sau quãng 5-9 giây đi trang nhạc (xem ghi chú ở
// đầu file). Một nhịp hỏi nằm TRONG trang cá nhân thì không có gì che — nó tốn wall-clock thật,
// đúng thứ mà đợt này đang phải cắt.
const PROTO_VERSION = 4;

// Câu trả lời an toàn: không bấm gì cả. Dùng cho MỌI đường hỏng.
function safeAnswer(id) {
  return { v: PROTO_VERSION, id: id | 0, ni: 0, why: '', follow: 0, like: 0, visit: 0, like_profile: 0 };
}

function makeBrain({ deviceId, dir, cfg = {}, say = () => {}, rng = Math.random, now = Date.now }) {
  // ── TỈ LỆ TYM: bốc MỘT lần cho cả lượt chạy ──
  //
  // VÌ SAO KHÔNG BỐC LẠI MỖI VIDEO: mỗi máy có một "tính cách" ổn định trong suốt ca — nhìn từ
  // phía TikTok thì giống một người hơn là giống bộ sinh số. Và bốc một lần thì in ra được một
  // dòng, nên đọc log là biết ngay máy đó đang chạy ở tỉ lệ nào.
  //
  // ⚠ `0` nghĩa là KHÔNG TYM, không phải "dùng mặc định" — cùng quy ước với trần follow
  // (`followquota.cjs`: trần 0 = tắt hẳn). Người gõ 0 là muốn ngừng, không phải muốn vô hạn.
  //
  // `rng` chỉ để phép thử chạy tất định; `runner.cjs` không bao giờ truyền nó.
  const _pt = (v, mac) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : mac;
  };
  const _lo = _pt(cfg.likeRateMin, 40);
  const _hi = _pt(cfg.likeRateMax, 60);
  const tiLeTym = Math.min(_lo, _hi) + rng() * Math.abs(_hi - _lo);
  let daBaoTiLe = false;
  // Dựng bộ khớp ngôn ngữ MỘT LẦN cho cả lượt chạy: `makeMatcher` biên dịch regex và chuẩn hoá
  // danh sách từ khoá, gọi lại mỗi video là phí.
  const matcher = (cfg.niEnabled || cfg.followOn || cfg.likeOn)
    ? langfilter.makeMatcher({ scripts: cfg.niScripts, keywords: cfg.niKeywords })
    : null;

  const dem = {
    asked: 0, lang: 0, ai: 0, ni: 0,
    follow: 0, followFail: 0, like: 0, likeFail: 0, visit: 0,
    askFail: 0,
    live: 0,          // số video livestream đã bỏ qua
    ghe: 0,           // số lần ghé trang cá nhân để lấy @handle
    trungKenh: 0,     // số lần ghé xong mới biết đã follow người này rồi
    tymTrang: 0,      // số cú tym lên video mở trong trang cá nhân
    gheTrung: 0,      // số lần vào trang rồi quay ra vì đã ghé gần đây
  };
  // ── GHÉ HỎNG LIÊN TIẾP THÌ LÙI LẠI, KHÔNG ĐẬP MÃI ──
  //
  // Chép từ bản PC, nơi đã chạy thật: `VISIT_BLOCK_STREAK = 3` (crawler.cjs:2511-2513) và quy
  // tắc lùi tăng dần của `makeFeedTrainer` (crawler.cjs:997-1007).
  //
  // ⚠ ĐIỂM TINH TẾ PHẢI CHÉP ĐÚNG: nó KHÔNG ngủ, chỉ đẩy mốc "lượt ghé kế tiếp" ra xa. Ghé thăm
  // nằm trong vòng quét, nên ngủ ở đây là đứng luôn cả việc quét sound — tức phạt nhầm việc đang
  // chạy tốt vì một việc khác đang hỏng.
  //
  // ⚠ LÙI DẦN, KHÔNG TẮT HẲN. Bản PC từng làm "3 lần hỏng thì tắt cả lượt chạy", và hậu quả ghi
  // ngay trong mã: người dùng bật một ô, chạy vài tiếng, rồi mất tính năng vì ba lần tải chậm —
  // mà giao diện vẫn báo "đang bật". Thành công một lượt là về lại bậc đầu.
  const GHE_HONG_NGUONG = 3;
  const GHE_NGHI_DAU_MS = 10 * 60 * 1000;
  const GHE_NGHI_TRAN_MS = 60 * 60 * 1000;
  let gheHongLienTiep = 0;
  let gheBacNghi = 0;
  let gheLaiSau = 0;        // mốc thời gian, trước mốc này thì không cấp quyền ghé

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
      // ── NHỊP 2: XÁC NHẬN FOLLOW, khi Python đã ghé trang và đọc được @handle THẬT ──
      //
      // Đây là nơi DUY NHẤT cấp phép follow. Nhịp 1 trên feed chỉ nói "còn ngân sách, đáng ghé";
      // hàng rào chống trùng nằm ở đây, vì trước khi ghé thì chưa ai biết kênh này là ai.
      if (ask.kind === 'follow_confirm') {
        const h = normalizeHandle(ask.handle);
        dem.ghe++;
        if (!h) {
          say('⚠ Ghé trang xong vẫn không đọc được @handle — không follow (mặc định an toàn).');
          return { v: PROTO_VERSION, id, ni: 0, why: 'no_handle', follow: 0, like: 0, visit: 0, like_profile: 0 };
        }
        const q = followquota.canFollow({
          deviceId, dir, handle: h,
          opts: { perDay: cfg.followPerDay, gapMinSec: cfg.followGapMin, gapMaxSec: cfg.followGapMax },
        });
        if (!q.ok) {
          if (/đã follow/.test(q.reason || '')) dem.trungKenh++;
          say(`bỏ follow ${h}: ${q.reason}`);
          return { v: PROTO_VERSION, id, ni: 0, why: q.reason || '', follow: 0, like: 0, visit: 0, like_profile: 0 };
        }
        // Nhớ handle để `noteActed` ghi sổ đúng kênh, kể cả khi Python quên gửi lại.
        dangCho = { id, handle: h };
        return { v: PROTO_VERSION, id, ni: 0, why: q.reason || '', follow: 1, like: 0, visit: 0, like_profile: 0 };
      }

      // ── NHỊP 2b: CÓ NÊN Ở LẠI TRANG NÀY KHÔNG — chống ghé trùng qua ngày ──
      //
      // Python đã vuốt vào trang cá nhân và đọc được `@handle` thật. Nhịp 1 trên feed không trả
      // lời được câu này: ở đó chưa ai biết kênh này là ai.
      //
      // ⚠ CÂU TRẢ LỜI DÙNG LẠI TRƯỜNG `visit`: 1 = ở lại lướt, 0 = về feed ngay. Không thêm
      // trường mới, nên MỌI đường hỏng (`safeAnswer`) đã sẵn mang `visit: 0` — hỏng thì đi ra,
      // đúng hướng an toàn là không bấm gì lên tài khoản thật.
      //
      // ⚠ Dựng câu trả lời bằng `...safeAnswer(id)` chứ không gõ lại từng khoá: đầu file này đã
      // ghi rõ, thiếu một khoá là đường hỏng trả về một HÌNH DẠNG KHÁC đường thường, và Python
      // đọc trúng khoá thiếu thì hiểu thành 0 mà không ai báo gì.
      if (ask.kind === 'visit_check') {
        const h = normalizeHandle(ask.handle);
        if (!h) {
          // Không đọc được @handle thì KHÔNG ghi sổ — ghi mù là chặn oan một kênh khác về sau.
          // Nhưng vẫn cho ở lại: lướt một trang chưa biết của ai thì cũng không hại gì.
          return { ...safeAnswer(id), visit: 1, why: 'no_handle' };
        }
        if (visitbook.visitedWithin(dir, h, cfg.visitSkipDays ?? 7)) {
          dem.gheTrung++;
          say(`bỏ qua ${h}: đã ghé trong ${cfg.visitSkipDays ?? 7} ngày gần đây`);
          return { ...safeAnswer(id), visit: 0, why: 'visited_recently' };
        }
        // Ghi sổ NGAY khi cấp phép ở lại, không đợi lượt ghé chạy xong. Bản PC làm đúng thế
        // (`visits.markVisited` gọi TRƯỚC khi ghé, crawler.cjs:2778), và ở đây lý do còn mạnh
        // hơn: lượt ghé có thể chết giữa chừng (máy treo, app văng, lạc khỏi feed). Ghi sau thì
        // một kênh hay làm ghé hỏng sẽ được thử đi thử lại mãi mãi.
        visitbook.record(dir, h);
        return { ...safeAnswer(id), visit: 1, why: '' };
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

      // ── BỎ QUA LIVESTREAM ──
      // Yêu cầu của chủ dự án (2026-09-16). Lý do kỹ thuật cũng trùng: màn LIVE không có icon
      // sound, không có nút Follow ở chỗ quen thuộc, và `long_press_layout` mang chữ "LIVE" thay
      // vì "Video" — mọi phép nhận diện sau đó đều trượt. Bấm mù lên một màn khác cấu trúc đúng
      // là cách bản PC từng bấm nhầm 5/10 lần (QĐ-31).
      //
      // Trả về SỚM, trước cả Not interested: LIVE không phải nội dung xấu, chỉ là không dùng
      // được. Dạy feed ghét nó là sai mục tiêu.
      if (ask.live) {
        dem.live++;
        return { v: PROTO_VERSION, id, ni: 0, why: 'live', follow: 0, like: 0, visit: 0, like_profile: 0 };
      }

      // ── DANH TÍNH ĐỌC ĐƯỢC TRÊN FEED ──
      // `author` giờ là TÊN HIỂN THỊ (từ `user_avatar`), không phải @handle — vì feed không bày
      // @handle (đo được: 0/3 mẫu). Đủ dùng cho lọc ngôn ngữ, tym, và để biết có đáng ghé không.
      // Follow thì KHÔNG đủ: nó cần @handle thật, lấy ở nhịp 2 (`kind:'follow_confirm'`).
      const danhTinh = handle || author;

      // ── Quyền GHÉ TRANG ĐỂ FOLLOW: mới là "đáng đi xem", CHƯA phải cấp phép ──
      // Chỉ kiểm ngân sách (giãn cách + trần ngày). Chống trùng kênh nằm ở nhịp 2, vì lúc này
      // chưa ai biết kênh này là ai. Hết ngân sách thì khỏi ghé — tiết kiệm đúng chỗ tốn nhất.
      let follow = 0;
      dangCho = null;
      if (cfg.followOn && !biLoai && danhTinh) {
        const q = followquota.canFollowBudget({
          deviceId, dir,
          opts: {
            perDay: cfg.followPerDay,
            gapMinSec: cfg.followGapMin,
            gapMaxSec: cfg.followGapMax,
          },
        });
        if (q.ok) follow = 1;
      }

      // ── Quyền TYM trên FEED ──
      // Đòi đọc được chủ video: tym là một cú bấm lên video của MỘT người cụ thể. Không đọc được
      // chủ video nghĩa là màn hình chưa đọc xong hoặc đang ở đâu đó khác — bấm lúc đó là bấm mù.
      //
      // ⚠ Từ 2026-09-17 tym còn phải QUA PHÉP BỐC: chủ dự án nhìn màn hình thấy video nào cũng
      // bị tym. Thủ phạm là `scan_feed_sounds.py` thiếu điều kiện "sound hợp lệ" — đã sửa ở đó —
      // nhưng tym 100% số video đạt vẫn là hành vi máy móc. Tỉ lệ 40-60% làm nó giống người.
      if (!daBaoTiLe) {
        daBaoTiLe = true;
        say(`tym ngẫu nhiên ${tiLeTym.toFixed(0)}% lượt này`);
      }
      const conTym = daycount.remaining(dir, 'like', cfg.likePerDay);
      let like = 0;
      if (cfg.likeOn && !biLoai && danhTinh && conTym > 0 && rng() * 100 < tiLeTym) like = 1;

      // ── Quyền GHÉ THĂM kênh ──
      let visit = 0;
      if (cfg.visitOn && !biLoai && danhTinh && now() >= gheLaiSau) {
        const tran = Math.max(0, parseInt(cfg.visitMaxUsers, 10) || 0);
        if (tran === 0 || dem.visit < tran) visit = 1;   // 0 = không giới hạn (khác với follow/tym)
      }

      // ── Quyền TYM VIDEO MỞ TRONG TRANG CÁ NHÂN ──
      // Đòi `visit`: không ghé thì không có video nào để tym, mà cấp quyền cho một cú bấm không
      // có đối tượng là để Python bấm lên bất cứ thứ gì đang ở trên màn hình.
      // Đòi `conTym > 1` khi feed đã được cấp: HAI cú tym ăn CHUNG trần ngày, không được vượt.
      let like_profile = 0;
      if (cfg.likeOn && visit && conTym > (like ? 1 : 0) && rng() * 100 < tiLeTym) like_profile = 1;

      return { v: PROTO_VERSION, id, ni, why, follow, like, visit, like_profile };
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
      // ── TIKTOK BẬT LẠI CÚ FOLLOW ──
      // Máy đã mở lại trang cá nhân sau khi về feed và thấy nút quay về "Follow". Cú follow
      // KHÔNG tồn tại, nên tuyệt đối không ghi sổ: ghi vào là kênh đó bị đánh dấu đã follow
      // vĩnh viễn và không bao giờ được thử lại, trong khi thực tế chưa follow ai.
      // Nói to, vì nhiều lần liên tiếp nghĩa là tài khoản đang bị TikTok chặn hành vi.
      if (evt.follow === 'reverted') {
        dem.followFail++;
        dem.batLai = (dem.batLai || 0) + 1;
        say(`⚠ TikTok đã bật lại cú follow ${evt.handle || ''} — không ghi sổ. `
          + 'Nhiều lần liên tiếp nghĩa là tài khoản đang bị chặn hành vi tự động.');
        return;
      }

      // 'ok_unverified': đã bấm và nút đã đổi, nhưng không kiểm lại được sau khi về feed (feed
      // đã trôi sang video khác). VẪN GHI SỔ — đếm thừa an toàn hơn đếm thiếu: đếm thiếu là
      // follow quá tay trên tài khoản thật, còn đếm thừa chỉ mất một suất trong ngày.
      if (evt.follow === 'ok' || evt.follow === 'ok_unverified') {
        // Ưu tiên @handle Python gửi kèm (nó vừa đọc trên trang cá nhân), rồi mới tới cái đã
        // ghi nhớ lúc cấp phép. Hai đường cùng chỉ một kênh; giữ cả hai để mất một đường vẫn ghi
        // được sổ.
        const h = normalizeHandle(evt.handle)
          || ((dangCho && dangCho.id === (evt.id | 0)) ? dangCho.handle : '');
        if (h) {
          channelstore.recordFollow(dir, h);
          followquota.noteFollowed(deviceId, dir, {
            perDay: cfg.followPerDay, gapMinSec: cfg.followGapMin, gapMaxSec: cfg.followGapMax,
          });
          dem.follow++;
        } else {
          // ⚠ ĐÃ FOLLOW MỘT NGƯỜI MÀ KHÔNG BIẾT LÀ AI.
          // Bản cũ bỏ qua trong im lặng, và đó là chỗ hỏng nguy hiểm nhất có thể có ở đây: cú
          // follow ĐÃ xảy ra trên tài khoản thật, nhưng sổ không ghi — nên trần 30/ngày đếm hụt
          // và lần sau có thể follow lại đúng người đó. Hướng sai duy nhất chấp nhận được là
          // đếm THỪA, không bao giờ là đếm thiếu.
          dem.followFail++;
          say('⚠ Máy báo follow thành công nhưng KHÔNG kèm @handle — không ghi sổ được. '
            + 'Trần ngày sẽ đếm thiếu. Kiểm lại bước ghé trang cá nhân.');
        }
      } else if (evt.follow === 'fail') {
        dem.followFail++;
      }

      if (evt.like === 'ok') { daycount.record(dir, 'like'); dem.like++; }
      else if (evt.like === 'fail') { dem.likeFail++; }

      // Tym trong trang cá nhân ăn CHUNG trần ngày với tym trên feed — nó cũng là một cú bấm lên
      // một video thật. Đếm riêng `tymTrang` để đọc log biết nhánh nào đang chạy: `ghé N kênh`
      // cao mà `tym trong trang` bằng 0 nghĩa là đường mở video trong lưới đang hỏng.
      if (evt.like_profile === 'ok') { daycount.record(dir, 'like'); dem.like++; dem.tymTrang++; }
      else if (evt.like_profile === 'fail') { dem.likeFail++; }

      // ── KẾT QUẢ GHÉ: đếm, và điều chỉnh quãng lùi ──
      // `skip_trung` KHÔNG phải hỏng: máy đã vào được trang và đọc được @handle, chỉ là sổ bảo
      // thôi. Tính nó thành hỏng là sổ chống trùng càng chạy tốt thì ghé thăm càng bị phạt nặng.
      // `ok_no_grid` VẪN ăn một suất `visitMaxUsers`: máy đã vào trang người ta và lướt 5-10
      // giây thật, chỉ là không mở được video trong lưới. Không đếm nó là trần "tối đa N kênh
      // mỗi lượt chạy" nói dối — một máy có lưới hỏng sẽ ghé vô hạn mà trần vẫn báo còn nguyên.
      // `skip_trung` thì KHÔNG đếm: vào rồi ra ngay, chưa tương tác gì với kênh đó.
      if (evt.visit === 'ok' || evt.visit === 'ok_no_grid' || evt.visit === 'skip_trung') {
        if (evt.visit !== 'skip_trung') dem.visit++;
        gheHongLienTiep = 0;
        gheBacNghi = 0;
      } else if (evt.visit === 'fail') {
        if (++gheHongLienTiep >= GHE_HONG_NGUONG) {
          gheHongLienTiep = 0;
          const nghi = Math.min(GHE_NGHI_TRAN_MS, GHE_NGHI_DAU_MS * Math.pow(2, gheBacNghi));
          gheBacNghi++;
          gheLaiSau = now() + nghi;
          say(`⚠ Ghé thăm hỏng ${GHE_HONG_NGUONG} lượt liên tiếp — nghỉ ghé ${Math.round(nghi / 60000)} phút. `
            + 'Quét sound vẫn chạy bình thường.');
        }
      }
    } catch (_) { /* ghi sổ hỏng không được làm chết vòng quét */ }
  }

  function noteAskFail() { dem.askFail++; }

  // Dòng tổng kết cuối lượt. Bộ đếm về 0 là dấu hiệu thấy ngay rằng nhận diện đã trượt.
  function summary() {
    const p = [];
    if (dem.asked) p.push(`hỏi ${dem.asked} video`);
    if (dem.lang) p.push(`loại ${dem.lang} vì ngôn ngữ`);
    if (dem.ai) p.push(`loại ${dem.ai} gắn nhãn AI`);
    if (dem.live) p.push(`bỏ qua ${dem.live} livestream`);
    if (dem.ni) p.push(`bấm Not interested ${dem.ni}`);
    // Ghé mà không follow được cái nào là dấu hiệu THẤY NGAY rằng đọc @handle trên trang cá nhân
    // đang trượt — nếu không có số này thì hỏng cũng chỉ hiện ra dưới dạng "follow 0", lẫn với
    // trường hợp hết trần ngày.
    if (dem.ghe) p.push(`ghé trang lấy @handle ${dem.ghe} lần${dem.trungKenh ? `, ${dem.trungKenh} kênh đã follow từ trước` : ''}`);
    if (dem.follow || dem.followFail) {
      const phu = [];
      if (dem.followFail) phu.push(`hỏng ${dem.followFail}`);
      if (dem.batLai) phu.push(`${dem.batLai} bị TikTok bật lại`);
      p.push(`follow ${dem.follow}${phu.length ? ` (${phu.join(', ')})` : ''}`);
    }
    if (dem.like || dem.likeFail) {
      const phu = [];
      if (dem.likeFail) phu.push(`hỏng ${dem.likeFail}`);
      if (dem.tymTrang) phu.push(`${dem.tymTrang} trong trang`);
      p.push(`tym ${dem.like}${phu.length ? ` (${phu.join(', ')})` : ''}`);
    }
    // `bỏ qua N đã ghé` là thước đo xem sổ chống trùng có đang chạy không. Số này bằng 0 suốt
    // nhiều ca trong khi `ghé` vẫn tăng nghĩa là sổ không ghi được (thư mục máy sai quyền, hoặc
    // @handle đọc trượt) — và hỏng kiểu đó không tự lộ ra ở đâu khác.
    if (dem.visit || dem.gheTrung) {
      p.push(`ghé ${dem.visit} kênh${dem.gheTrung ? `, bỏ qua ${dem.gheTrung} đã ghé gần đây` : ''}`);
    }
    if (dem.askFail) p.push(`⚠ ${dem.askFail} lượt hỏi hỏng`);
    if (!p.length) return '';
    let s = p.join(' · ');
    if (viDu.length) s += `\n   Ví dụ kênh bị loại: ${viDu.join(', ')}`;
    return s;
  }

  return { answer, noteActed, noteAskFail, summary, _dem: dem };
}

module.exports = { PROTO_VERSION, makeBrain, safeAnswer };
