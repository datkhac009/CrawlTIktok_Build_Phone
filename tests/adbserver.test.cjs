// tests/adbserver.test.cjs — khoá chuyện "ai quyết cổng ADB server".
//
// VÌ SAO PHẢI CÓ (2026-09-16):
// `scan_feed_sounds.py` tự suy một cổng ADB server RIÊNG cho mỗi máy (`5100 + crc32(serial)%800`)
// để chữa triệu chứng "1 máy chạy 1 máy dừng". Nó làm chết cả farm, và chết theo kiểu tệ nhất —
// **xanh giả**: `preflight.cjs` hỏi server mặc định 5037 thấy đủ 23 máy nên báo XANH hết, trong
// khi tiến trình quét hỏi server 5112 thì `adb devices` RỖNG. `adb connect` treo trọn 60 giây,
// rồi mọi `adb shell` trả `device not found`, `setup_device` hỏng ba lần, thoát mã 1.
//
// Lý do gốc: farm nối qua MẠNG, mà `adbd` trên điện thoại chỉ nhận ĐÚNG MỘT adb server — 23 máy
// đã nằm trên server của 效卫. Và mẹo đó chưa từng chữa được gì: `adbutils` dựng client cấp module
// đọc biến môi trường NGAY LÚC IMPORT, mà `uiautomator2` được import trước khi cổng riêng kịp
// đặt, nên toàn bộ lệnh RPC vẫn đi 5037.
//
// Phép thử này khoá ba thứ: (1) một nơi duy nhất quyết cổng, (2) Python chỉ ĐỌC chứ không suy,
// (3) không ai lặng lẽ trả lại cú `adb connect` 60 giây. Thuần văn bản, không cần máy Android.
'use strict';
const fs = require('fs');
const path = require('path');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const R = path.join(__dirname, '..');
const doc = (p) => fs.readFileSync(path.join(R, p), 'utf8');

const ap = require(path.join(R, 'src', 'adbpath.cjs'));
const py = doc('scan_feed_sounds.py');
const runner = doc('src/runner.cjs');

// ── 1. `adbServerPort()` — một nơi duy nhất, và không nuốt rác ──
{
  const cu = process.env.ANDROID_ADB_SERVER_PORT;

  delete process.env.ANDROID_ADB_SERVER_PORT;
  check('1. Không có biến môi trường thì trả 5037', ap.adbServerPort() === '5037',
    ap.adbServerPort());
  check('1b. 5037 là mặc định được export ra ngoài', ap.DEFAULT_ADB_SERVER_PORT === '5037');

  process.env.ANDROID_ADB_SERVER_PORT = '5099';
  check('1c. Tôn trọng giá trị số hợp lệ', ap.adbServerPort() === '5099', ap.adbServerPort());

  // Rác thì PHẢI rơi về mặc định. Một cổng rác lọt xuống tiến trình con thì adb bên đó dựng
  // server ở nơi không ai biết, và triệu chứng lại đúng là "không thấy máy nào" — thứ vừa mất
  // một buổi để tìm ra.
  const rac = ['abc', '', '  ', '50 37', '5037;rm', '-1'];
  const lot = rac.filter((v) => {
    process.env.ANDROID_ADB_SERVER_PORT = v;
    return ap.adbServerPort() !== '5037';
  });
  check('1d. Giá trị rác rơi về 5037', lot.length === 0,
    lot.length ? `lọt: ${JSON.stringify(lot)}` : `đã thử ${rac.length} giá trị rác`);

  if (cu === undefined) delete process.env.ANDROID_ADB_SERVER_PORT;
  else process.env.ANDROID_ADB_SERVER_PORT = cu;
}

// ── 2. Node thật sự truyền cổng đó xuống tiến trình con ──
// Hàm đúng mà không ai gọi thì vô nghĩa — đúng loại "ô chết" mà QĐ-38 cấm.
{
  check('2. runner.cjs đưa ANDROID_ADB_SERVER_PORT vào env của tiến trình con',
    /ANDROID_ADB_SERVER_PORT:\s*adbServerPort\(\)/.test(runner));
  check('2b. runner.cjs lấy hàm đó TỪ adbpath.cjs, không tự viết lại',
    /require\(['"]\.\/adbpath\.cjs['"]\)/.test(runner) && /adbServerPort/.test(runner));
}

// ── 3. CHỐT CHẶN TÁI PHÁT: Python không được tự suy cổng nữa ──
{
  const tuDat = /os\.environ\[["']ANDROID_ADB_SERVER_PORT["']\]\s*=/.test(py);
  check('3. Python KHÔNG tự đặt ANDROID_ADB_SERVER_PORT', !tuDat,
    tuDat ? 'Python lại tự suy cổng adb server — đúng dòng đã làm chết cả farm ngày 2026-09-16' : '');

  const crc = /zlib\.crc32/.test(py) || /import zlib/.test(py);
  check('3b. Không còn dấu vết cổng suy từ crc32(serial)', !crc,
    crc ? 'còn zlib/crc32 trong scan_feed_sounds.py' : '');

  check('3c. Python chỉ ĐỌC cổng, có mặc định 5037',
    /os\.environ\.get\(["']ANDROID_ADB_SERVER_PORT["'],\s*["']5037["']\)/.test(py));
}

// ── 4. `adb connect` phải CÓ ĐIỀU KIỆN và CÓ TRẦN THỜI GIAN ──
// Bản cũ gọi mù mỗi lần khởi động và ăn trọn 60 giây kể cả khi máy đã sẵn sàng — nhân 19 máy là
// 19 phút mỗi ca, đốt không đổi lấy gì.
{
  check('4. Hỏi `adb devices` trước khi connect', /list_devices\(\)/.test(py));
  check('4b. Chỉ connect với serial dạng ip:port', /":"\s+in\s+serial/.test(py));

  const m = py.match(/adb\(\s*["']connect["']\s*,\s*serial\s*,\s*timeout\s*=\s*(\d+)\s*\)/);
  const giay = m ? parseInt(m[1], 10) : null;
  check('4c. connect có timeout ngắn (<= 15s), không phải 60s mặc định',
    giay !== null && giay <= 15,
    m ? `timeout=${giay}` : 'không tìm thấy lời gọi adb("connect", serial, timeout=...)');

  check('4d. list_devices() cũng có trần thời gian riêng',
    /def list_devices\(timeout=\d+\)/.test(doc('adb_helper.py')));
}

// ── 5. Người dùng phải THẤY được cổng nào đang dùng ──
// Mục preflight xanh mà máy vẫn chết chính là chuyện đã xảy ra. Cái phân biệt hai tình huống đó
// phải nằm trên mặt, không phải nằm trong đầu người đọc log.
{
  check('5. preflight nói rõ cổng server ở mục adb',
    /server cổng \$\{adbServerPort\(\)\}/.test(doc('src/preflight.cjs')));
}

// ── 6. CHỐT CHẶN TÀI LIỆU: năm chỗ từng nói sai không được nói lại ──
// Sáu chỗ đó tồn tại được lâu như vậy chính vì không có phép thử nào soi chữ. Giờ có.
{
  const FILES = ['README.md', 'renderer/index.html', 'src/devslot.cjs', 'main.js',
    'tests/devslot.test.cjs'];
  // Cố ý KHÔNG soi `src/adbpath.cjs`: ở đó câu "效卫 giữ sẵn một adb server" vẫn đúng và phải ở lại.
  // Cũng cố ý cho phép các đoạn KỂ LẠI chuyện cũ (có chữ "bản trước"/"cách cũ"/"từng") tồn tại —
  // xoá lịch sử đi thì lần sau lại có người phát minh lại đúng cái bẫy này.
  const XAU = [/mỗi tiến trình một ADB server riêng/i, /19 ADB server/i, /\+ 1 ADB server/i];
  const hong = [];
  FILES.forEach((f) => {
    const t = doc(f);
    t.split('\n').forEach((dong, i) => {
      if (/bản trước|cách cũ|từng |2026-09-16/i.test(dong)) return;   // đoạn kể lại, tha
      if (XAU.some((re) => re.test(dong))) hong.push(`${f}:${i + 1}`);
    });
  });
  check('6. Không file nào còn khẳng định "mỗi máy một ADB server riêng"', hong.length === 0,
    hong.length ? hong.join(', ') : `đã soi ${FILES.length} file`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
process.exit(failed.length ? 1 : 0);
