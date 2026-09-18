// src/runner.cjs — Thay cho browser.cjs + crawler.cjs của bản gốc.
// Mỗi thiết bị chạy = 1 tiến trình con `python scan_feed_sounds.py <serial>`.
'use strict';

const readline = require('readline');
const { spawn, execFile } = require('child_process');
const { getBaseDir, getPythonScriptPath } = require('./paths.cjs');
const { adbPath, adbServerPort } = require('./adbpath.cjs');
const { findPython } = require('./pythonpath.cjs');
const askproto = require('./askproto.cjs');
const { getDeviceDir } = require('./paths.cjs');

const uilabels = require('./uilabels.cjs');

const SCRIPT_PATH = getPythonScriptPath();
const TIKTOK_PKGS = ['com.zhiliaoapp.musically', 'com.ss.android.ugc.trill'];

// ── Dựng biểu thức tìm nút TỪ `uilabels.cjs`, rồi truyền xuống Python ──
//
// VÌ SAO KHÔNG CHÉP DANH SÁCH NHÃN SANG PYTHON:
// Đó chính là cách `linkkey.cjs` đã lệch — bản phone rút gọn còn tiếng Anh + tiếng Việt, và ô
// "Chỉ lấy Original Sound" hỏng câm trên máy để ngôn ngữ khác. Danh sách nhãn chỉ có MỘT nguồn
// là `uilabels.cjs`; Python nhận nó lúc khởi động chứ không giữ bản sao nào.
//
// Khớp TRỌN CHUỖI (`^...$`), không phải chứa — `uilabels.cjs:40-42` ghi rõ lý do: khớp kiểu
// chứa thì "Followers 1.2M" cũng thành nút Follow và bị bấm.
function _reTu(list) {
  const phan = (list || [])
    .filter((x) => typeof x === 'string' && x)
    .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return phan.length ? `(?i)^(${phan.join('|')})$` : '(?!)';   // rỗng = không khớp gì cả
}
// Viết thẳng mã ký tự thay vì dấu escape: khối này đã một lần bị công cụ sinh mã biến dấu
// escape thành ký tự xuống dòng THẬT, làm hỏng cú pháp file. Cách này không thể hỏng như vậy.
const NEWLINE = String.fromCharCode(10);

// Ba tiền tố của giao thức. `askbridge.py` khớp đúng các chuỗi này — đổi một bên mà quên bên
// kia thì kênh hỏi/đáp ngừng hoạt động trong im lặng.
const ASK_PREFIX = '@@ASK@@';
const ANS_PREFIX = '@@ANS@@';
const EVENT_PREFIX = '@@EVENT@@';
const _active = new Map(); // deviceId -> { proc, serial }

// Dong app TikTok tren may + dua ve man hinh chinh (goi qua adb, khong dung uiautomator2
// vi luc nay tien trinh python da bi kill).
function cleanupDevice(serial) {
  if (!serial) return;
  const ADB_PATH = adbPath();
  if (!ADB_PATH) return;   // không có adb thì không dọn được; im lặng ở đây là đúng (đang tắt máy)
  TIKTOK_PKGS.forEach((pkg) => {
    execFile(ADB_PATH, ['-s', serial, 'shell', 'am', 'force-stop', pkg], { timeout: 8000 }, () => {});
  });
  execFile(ADB_PATH, ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_HOME'], { timeout: 8000 }, () => {});
}

function runningIds() {
  return Array.from(_active.keys());
}

function isRunning(deviceId) {
  return _active.has(deviceId);
}

// ── DỊCH KẾT QUẢ TỪNG CÚ BẤM SANG TIẾNG VIỆT ──
//
// ⚠ SỰ CỐ THẬT (2026-09-18): bản cũ in thẳng giá trị nội bộ ra màn hình —
//     [tương tác] follow=skip_changed_video tym=skip_changed_video ghé=skip_changed_video
// Chủ dự án gửi ảnh chụp kèm câu "bạn log cái gì vậy tôi nhìn khó hiểu quá". Một dòng 90 ký tự
// chỉ để nói "không làm gì cả", và lặp ở mọi video.
//
// Bản PC không bao giờ làm thế: mã nội bộ của nó ('nav', 'nofeed', 'same', 'empty') đều được
// dịch thành câu tiếng Việt ngay tại chỗ gọi, không giá trị nào lọt ra log.
// Việc nào do AI kể. `visit` KHÔNG có trong bảng: `do_visit` bên Python đã tự in một dòng đầy
// đủ kèm SỐ GIÂY THẬT và lý do ("👀 Đã ghé một kênh (14.3s)"), kể lại ở đây là nói hai lần cùng
// một chuyện — đúng cái làm log cũ dài gấp đôi.
const VIEC_TUONG_TAC = {
  follow: 'Follow',
  like: 'Tym',
  like_profile: 'Tym video trong trang',
  ni: 'Not interested',
};

const KET_QUA_TUONG_TAC = {
  ok: 'xong',
  ok_unverified: 'xong (chưa kiểm lại được)',
  fail: 'hỏng',
  reverted: 'bị TikTok bật lại',
};

const VI_SAO_HOI_HONG = {
  timeout: 'app trả lời quá chậm',
  eof: 'app đã đóng kênh',
  badjson: 'câu trả lời hỏng định dạng',
  version: 'lệch phiên bản giao thức',
  error: 'lỗi khi đọc câu trả lời',
};

// Dựng một câu cho cả lượt tương tác, hoặc '' nếu không có gì đáng nói.
//
// ⚠ GIÁ TRỊ LẠ THÌ BỎ QUA, KHÔNG IN RA. Bản cũ in thẳng bất cứ thứ gì nhận được, nên một giá trị
// mới thêm ở phía Python là lập tức hiện ra màn hình dưới dạng mã. Ở đây, không dịch được thì
// không kể — thà thiếu một mẩu còn hơn bày mã nội bộ cho người dùng đọc.
//
// `not_needed` (không xin quyền) và `skip_changed_video` (đã bỏ lượt, Python đã giải thích vì
// sao) đều không có trong bảng nên tự rơi ra.
function kePhanTuongTac(payload) {
  const phan = [];
  for (const [khoa, ten] of Object.entries(VIEC_TUONG_TAC)) {
    const ketQua = KET_QUA_TUONG_TAC[payload[khoa]];
    if (!ketQua) continue;
    phan.push(`${ten} ${ketQua}`);
  }
  if (!phan.length) return '';
  const hong = phan.some((t) => /hỏng|bật lại/.test(t));
  return `${hong ? '⚠ ' : ''}${phan.join(' · ')}.`;
}

function startDevice(params, onData, onStatus) {
  const { deviceId, serial, minPosts, maxPosts, dwellMin, dwellMax, originalOnly, limit } = params;
  const cfg = params.cfg || {};
  if (_active.has(deviceId)) {
    throw new Error('Thiết bị này đang chạy rồi.');
  }
  // ── MỘT ĐIỆN THOẠI, MỘT TIẾN TRÌNH (2026-09-18) ──
  // Chặn theo id thôi là KHÔNG đủ. Xoá một máy lúc nó đang nghỉ giữa ca rồi thêm lại đúng điện
  // thoại đó là ra hai id cho cùng một serial — và hai tiến trình Python cùng lái một màn hình:
  // cùng vuốt, cùng bấm, cùng thấy một video nên cùng báo về MỘT sound hai lần. Đó chính là hai
  // dòng "thật huy" trùng nhau chủ dự án chụp màn hình gửi (một dòng ghi tên máy, một dòng ghi
  // mã `d_…` của máy đã xoá).
  for (const [khac, e] of _active) {
    if (e.serial === serial) {
      throw new Error(`Điện thoại ${serial} đang được một lượt chạy khác điều khiển (${khac}). `
        + 'Bấm Dừng lượt đó trước.');
    }
  }

  // Kiểm TRƯỚC khi spawn, và ném ra câu người đọc hiểu được. Bản cũ `spawn('python', ...)` với
  // python 3.14 trong PATH thì tiến trình chết ngay vì thiếu uiautomator2, và tất cả những gì
  // giao diện nhận được là `exit code 1` → một chữ "Lỗi". Mất cả buổi mới ra nguyên nhân.
  const py = findPython();
  if (!py) {
    throw new Error('Không tìm thấy Python. Bấm 🔌 Kiểm tra để xem hướng dẫn cài.');
  }
  if (!py.hasU2) {
    throw new Error(`Python ${py.version.text} chưa có thư viện uiautomator2. Bấm 🔌 Kiểm tra để xem lệnh cài.`);
  }
  const ADB_PATH = adbPath();
  if (!ADB_PATH) {
    throw new Error('Không tìm thấy adb.exe. Bấm 🔌 Kiểm tra để xem cách khắc phục.');
  }

  const env = Object.assign({}, process.env, {
    GUI_MODE: '1',
    MIN_POSTS: String(minPosts ?? 1000),
    MAX_POSTS: String(maxPosts ?? 100000),
    DWELL_MIN: String(dwellMin ?? 3.0),
    DWELL_MAX: String(dwellMax ?? 6.0),
    ORIGINAL_ONLY: originalOnly === false ? '0' : '1',
    LIMIT: String(limit || 0),
    PYTHONIOENCODING: 'utf-8',

    // ── Những thứ Python TỰ quyết được vì chúng thuần số, không phải luật ──
    // Luật (lọc ngôn ngữ, nhãn AI, hạn mức follow) ở lại Node và đi qua kênh hỏi/đáp.
    PROTO_V: String(askproto.PROTO_VERSION),
    ASK_ON: (cfg.niEnabled || cfg.niAi || cfg.followOn || cfg.likeOn || cfg.visitOn) ? '1' : '0',
    CYCLE_ON: cfg.cycleOn ? '1' : '0',

    // Cờ THỬ NGHIỆM, không có ô nào trong giao diện bật được: bỏ tạm điều kiện "sound hợp lệ" ở
    // nhánh follow để đo xem đường follow có bấm được thật không. Chỉ `tools/run-one.cjs --follow-test`
    // bật nó. Mặc định tắt nên app chạy y nguyên.
    FOLLOW_ANY: cfg.followAnySound ? '1' : '0',
    CYCLE_SCAN_MIN: String(cfg.cycleScanMinutes ?? 30),
    VISIT_SEC_MIN: String(cfg.visitSecMin ?? 5),
    VISIT_SEC_MAX: String(cfg.visitSecMax ?? 10),

    // Xem video mở trong trang cá nhân bao lâu trước khi tym.
    PROFILE_VID_SEC_MIN: String(cfg.profileVideoSecMin ?? 3),
    PROFILE_VID_SEC_MAX: String(cfg.profileVideoSecMax ?? 7),

    // Nhịp quét. Hai ô này để chỉnh được TỐC ĐỘ mà không phải sửa code:
    //  - `MUSIC_WAIT_SEC` từng là 15 và `find_first` duyệt cả hai gói TikTok -> một lần lỡ trang
    //    nhạc đốt trọn 30 giây. Giờ Python chỉ chờ một gói nên 8 là đủ rộng.
    //  - `SETTLE_SEC` là TRẦN TRÊN, không phải giấc ngủ: Python dò tới khi thấy số post.
    MUSIC_WAIT_SEC: String(cfg.musicWaitSec ?? 8),
    SETTLE_SEC: String(cfg.settleSec ?? 1.2),

    // Nhãn nút — dựng từ uilabels.cjs, Python KHÔNG giữ bản sao nào.
    RE_FOLLOW: _reTu(uilabels.FOLLOW_LABELS),
    RE_FOLLOWING: _reTu(uilabels.FOLLOWING_LABELS),
    RE_NOT_INTERESTED: _reTu(uilabels.NOT_INTERESTED_LABELS),
    // Phía Python dùng ĐÚNG adb mà phía Node đã chọn. Hai bên tự dò riêng là có ngày mỗi bên
    // một binary khác phiên bản, và chúng sẽ thay nhau giết adb server của nhau.
    ADB_PATH,

    // …VÀ ĐÚNG CÁI ADB SERVER ĐÓ NỮA (2026-09-16).
    //
    // Cùng một bài học như `ADB_PATH` ngay trên, chỉ khác chỗ nó rơi. `scan_feed_sounds.py` từng
    // tự suy một cổng server RIÊNG cho mỗi máy bằng `crc32(serial)`. Hậu quả đo được trong một
    // lần chạy thật: `preflight.cjs`, `devices.cjs` và `cleanupDevice()` bên này đều hỏi server
    // mặc định (5037) và báo XANH, còn tiến trình quét hỏi server 5112 — nơi `adb devices` rỗng,
    // vì máy nối qua MẠNG và `adbd` chỉ nhận đúng một adb server (23 máy đã nằm trên server của
    // 效卫). `adb connect` treo trọn 60 giây, mọi `adb shell` trả `device not found`,
    // `setup_device` hỏng ba lần, tiến trình thoát mã 1. Ép cổng 5037 cho đúng lần chạy đó:
    // 20/20 video, không một lỗi.
    //
    // Nên cổng server cũng chỉ có MỘT nguồn là `adbpath.cjs`, và Python chỉ được ĐỌC, không suy.
    ANDROID_ADB_SERVER_PORT: adbServerPort(),
  });

  const proc = spawn(py.cmd, [...py.args, SCRIPT_PATH, serial], {
    cwd: getBaseDir(),
    env,
    windowsHide: true,
  });

  // stdin sẽ được dùng ở Đợt 2 (kênh hỏi/đáp). Gắn bắt lỗi NGAY từ bây giờ: ghi vào stdin của
  // một tiến trình vừa chết sẽ phát sự kiện 'error' trên stream, mà stream không có người nghe
  // thì Node NÉM lỗi — ở đây là tiến trình main của Electron, tức là **chết cả app và bỏ lại
  // toàn bộ tiến trình Python mồ côi vẫn đang vuốt máy thật**. Lỗi này chỉ hiện trong khe đua
  // giữa "con vừa thoát" và "cha vừa ghi", nên thử tay gần như không bao giờ gặp.
  if (proc.stdin) proc.stdin.on('error', () => {});

  _active.set(deviceId, { proc, serial, stopping: false });
  onStatus(deviceId, { kind: 'status', state: 'running' });

  // ── BỘ NÃO PHÁN XÉT, phía Node ──
  // Mỗi máy một thư mục riêng: sổ kênh chất lượng và bộ đếm ngày là KHẨU VỊ CỦA MỘT TÀI KHOẢN
  // TikTok cụ thể, trộn chung giữa các máy là sai.
  const dir = getDeviceDir(deviceId);
  const say = (line) => onStatus(deviceId, { kind: 'log', line });
  const brain = askproto.makeBrain({ deviceId, dir, cfg, say });

  // Ghi một dòng xuống stdin của tiến trình con.
  //
  // ⚠ PHẢI kiểm stream còn sống trước mỗi lần ghi. Ghi vào stdin của tiến trình vừa chết sẽ
  // phát sự kiện 'error'; ở đây là tiến trình main của Electron nên một lỗi không ai bắt là
  // **chết cả app và bỏ lại toàn bộ tiến trình Python mồ côi vẫn đang vuốt máy thật**. Lỗi này
  // chỉ xảy ra trong khe đua giữa "con vừa thoát" và "cha vừa ghi" nên thử tay không gặp.
  const guiXuong = (obj) => {
    const st = proc.stdin;
    if (!st || st.destroyed || !st.writable) return false;
    try {
      // ⚠ TIỀN TỐ `@@ANS@@` LÀ BẮT BUỘC. `askbridge.py` bỏ qua mọi dòng không mang tiền tố này
      // (để dòng lạ trên stdin không bị hiểu nhầm là phán quyết). Thiếu nó thì Python KHÔNG BAO
      // GIỜ nhận được câu trả lời: hết giờ 3 lần liên tiếp rồi tự tắt lọc & tương tác — im lặng,
      // không lỗi, app vẫn quét bình thường nên nhìn ngoài không thấy gì sai.
      // Phép thử ghép nối `tests/bridge.test.cjs` bắt được đúng lỗi này.
      //
      // Ký tự xuống dòng cũng bắt buộc: Python đọc bằng `readline()`.
      st.write(ANS_PREFIX + JSON.stringify(obj) + NEWLINE);
      return true;
    } catch (_) {
      return false;
    }
  };

  const handleLine = (line, isErr) => {
    if (!line) return;

    // ── CÂU HỎI TỪ PYTHON ──
    if (line.startsWith(ASK_PREFIX)) {
      let ask = null;
      try {
        ask = JSON.parse(line.slice(ASK_PREFIX.length));
      } catch (_) {
        // JSON hỏng: vẫn PHẢI trả lời, nếu không Python đứng chờ hết giờ mới đi tiếp.
        brain.noteAskFail();
      }
      const ans = ask ? brain.answer(ask) : askproto.safeAnswer(0);
      guiXuong(ans);
      return;
    }

    if (line.startsWith(EVENT_PREFIX)) {
      let payload;
      try {
        payload = JSON.parse(line.slice(EVENT_PREFIX.length));
      } catch (_) {
        onStatus(deviceId, { kind: 'log', line });
        return;
      }
      if (payload.type === 'progress') {
        onStatus(deviceId, { kind: 'progress', checked: payload.checked, qualified: payload.qualified });
      } else if (payload.type === 'status') {
        onStatus(deviceId, { kind: 'status', state: payload.state, msg: payload.msg });
      } else if (payload.type === 'acted') {
        // Kết quả THẬT của từng cú bấm. Sổ chỉ được ghi ở đây, sau khi đã xác minh —
        // channelstore.cjs:182-184 cảnh báo: ghi lúc BẤM thì kênh bị đánh dấu đã follow dù
        // follow hỏng, và bị bỏ qua VĨNH VIỄN.
        brain.noteActed(payload);
        const phan = kePhanTuongTac(payload);
        if (phan) onStatus(deviceId, { kind: 'log', line: phan });
      } else if (payload.type === 'askfail') {
        brain.noteAskFail();
        onStatus(deviceId, {
          kind: 'log',
          line: `⚠ Không nhận được phán quyết cho một video (${VI_SAO_HOI_HONG[payload.why]
            || 'lỗi không rõ'}) — bỏ qua, không bấm gì.`,
        });
      } else if (payload.type === 'result') {
        // ⚠ CHỈ đẩy dữ liệu, KHÔNG in log ở đây (2026-09-18). Python đã in câu phán quyết
        // (`Lấy "X" (3.300 video)` / `Bỏ "X" (1.600.000 > 100.000 video)`) ngay khi đọc xong
        // trang nhạc. Bản cũ in thêm một dòng nữa ở đây, nên MỌI kết quả nằm trong log hai lần,
        // hai định dạng khác nhau — chủ dự án đọc log tưởng máy làm hai lượt.
        if (payload.verdict === 'DAT') {
          onData(deviceId, { name: payload.name, url: payload.url, posts: payload.posts });
        }
      }
      return;
    }
    onStatus(deviceId, { kind: 'log', line: isErr ? `[err] ${line}` : line });
  };

  readline.createInterface({ input: proc.stdout }).on('line', (l) => handleLine(l, false));
  readline.createInterface({ input: proc.stderr }).on('line', (l) => handleLine(l, true));

  proc.on('error', (e) => {
    onStatus(deviceId, { kind: 'status', state: 'error', msg: String(e.message || e).slice(0, 200) });
  });

  proc.on('close', (code) => {
    const entry = _active.get(deviceId);
    const wasStopping = !!(entry && entry.stopping);
    _active.delete(deviceId);
    // Dòng tổng kết: bộ đếm về 0 là dấu hiệu THẤY NGAY rằng nhận diện đã trượt (TikTok đổi
    // chữ trên nút, hoặc màn hình đổi cấu trúc). Không có dòng này thì hỏng cũng không ai biết.
    try {
      const tk = brain.summary();
      if (tk) onStatus(deviceId, { kind: 'log', line: `── Tổng kết: ${tk}` });
    } catch (_) {}
    const isError = !!code && !wasStopping;
    onStatus(deviceId, { kind: 'status', state: isError ? 'error' : 'stopped', msg: isError ? `exit code ${code}` : '' });
  });
}

function stopDevice(deviceId) {
  const entry = _active.get(deviceId);
  if (!entry) return { ok: false, msg: 'Thiết bị không chạy.' };
  entry.stopping = true;
  const serial = entry.serial;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(entry.proc.pid), '/t', '/f'], () => cleanupDevice(serial));
  } else {
    entry.proc.kill('SIGKILL');
    setTimeout(() => cleanupDevice(serial), 500);
  }
  return { ok: true };
}

function stopAll() {
  runningIds().forEach(stopDevice);
}

// `kePhanTuongTac` mở ra CHỈ để phép thử gọi được: đây là dòng người dùng nhìn thấy nhiều nhất
// trong ca chạy, nên nó phải kiểm được mà không cần cắm điện thoại.
module.exports = { startDevice, stopDevice, stopAll, runningIds, isRunning, kePhanTuongTac };
