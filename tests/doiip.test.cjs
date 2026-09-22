// tests/doiip.test.cjs — máy ĐỔI IP: ghép danh sách máy với điện thoại đang online (`ghepMay`).
//
// SỰ CỐ THẬT (2026-09-19): cả farm khởi động lại, DHCP cấp IP mới cho 6 máy. App vẫn gọi IP cũ:
// 5 dòng báo "device … not online" rồi tự chạy lại mãi, còn dòng "V2031" (.115) lại đang lái chiếc
// GM1911 vừa nhận đúng IP đó. Dữ liệu ở mục 1 là ĐÚNG danh sách và ĐÚNG farm đọc được hôm đó
// (`adb devices` + `getprop ro.product.model` / `ro.serialno` trên từng IP).
'use strict';
const path = require('path');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const { ghepMay, khopTen } = require(path.join(__dirname, '..', 'src', 'devices.cjs'));
const ip = (n) => `192.168.5.${n}:5555`;

// Danh sách trong config/devices.json (tên → IP cũ). Chưa máy nào có `hw`.
const DS = [
  ['M2010J19SG', 148], ['CPH2179', 104], ['GM1911', 106], ['GM1901', 110], ['TECNO LC8', 111],
  ['HD1911', 112], ['TECNO CD7', 113], ['CPH2127', 114], ['V2031', 115], ['SM-N975F', 116],
  ['V2036', 117], ['Pixel 2 XL', 118], ['vivo 1904', 119], ['Pixel 4 XL', 120], ['Nokia 2.3', 121],
  ['Nokia 6.1 Plus', 127], ['Redmi K20 Pro', 139], ['Redmi Note 8 Pro', 140], ['Redmi K20 Pro1', 141],
  ['RMX2061', 144],
].map(([name, n], i) => ({ id: 'd' + i, name, serial: ip(n), note: '' }));

// Farm online lúc đó: IP → đời máy, số máy phần cứng.
const FARM = [
  ['192.168.4.167:5555', 'SM-A920F', '5200d3b4ee27940f'], ['192.168.4.90:5555', 'SM-A920F', '52000352c0ee64df'],
  [ip(104), 'CPH2179', 'ce061716b1705c3c037e'], [ip(110), 'GM1901', '988c1d333143414c3830'],
  [ip(111), 'TECNO LC8', 'ce0617165c2290eb0d7e'], [ip(112), 'HD1911', '988a16423633514f3530'],
  [ip(113), 'TECNO CD7', 'ce061716431fd41d0d7e'], [ip(114), 'CPH2127', 'ce071717325faa1b017e'],
  [ip(115), 'GM1911', 'ce071717194ec10f017e'], [ip(116), 'SM-N975F', '988ad037423245433230'],
  [ip(117), 'V2036', 'ce061716db671033017e'], [ip(118), 'Pixel 2 XL', '988a97474241414d3630'],
  [ip(119), 'vivo 1904', 'ce06171655bbc405027e'], [ip(120), 'Pixel 4 XL', 'ce081718bb36b10a017e'],
  [ip(121), 'Nokia 2.3', 'ce051715e0ae4314027e'], [ip(125), 'V2031', '988a9b314d3559365030'],
  [ip(137), 'Nokia 6.1 Plus', '988a1b335a4851435230'], [ip(141), 'Redmi K20 Pro', '988ad04845304b484530'],
  [ip(144), 'RMX2061', 'ce06171654935808027e'], [ip(149), 'Redmi K20 Pro', '988a5c394736324a3930'],
  [ip(150), 'Redmi Note 8 Pro', '988a90344831324e5530'], [ip(158), 'M2010J19SG', '988c1d464f37534d4730'],
  ['192.168.5.185:5555', 'SM-A920F', '5200505af414b4db'],
].map(([serial, model, hwSerial]) => ({ serial, model, hwSerial }));

// ── 1. Đúng hôm đó ──
{
  const r = ghepMay(DS, FARM);
  const doi = Object.fromEntries(r.doi.map((x) => [x.name, `${x.cu.split('.')[3].split(':')[0]}→${x.moi.split('.')[3].split(':')[0]}`]));
  const mong = {
    'M2010J19SG': '148→158', 'GM1911': '106→115', 'V2031': '115→125', 'Nokia 6.1 Plus': '127→137',
    'Redmi K20 Pro': '139→149', 'Redmi Note 8 Pro': '140→150',
  };
  check('1a. Tìm ra ĐÚNG 6 máy đổi IP, đúng IP mới từng máy', JSON.stringify(doi) === JSON.stringify(mong), JSON.stringify(doi));
  check('1b. "V2031" được đưa sang .125 và "GM1911" nhận .115 — không lái nhầm máy nữa',
    r.ds.find((d) => d.name === 'V2031').serial === ip(125) && r.ds.find((d) => d.name === 'GM1911').serial === ip(115));
  check('1c. Hai chiếc Redmi K20 Pro không bị tráo: "Redmi K20 Pro1" giữ .141, "Redmi K20 Pro" sang .149',
    r.ds.find((d) => d.name === 'Redmi K20 Pro1').serial === ip(141)
    && r.ds.find((d) => d.name === 'Redmi K20 Pro').serial === ip(149));
  check('1d. 14 máy còn lại giữ nguyên IP', r.ds.filter((d) => !mong[d.name]).every((d) => d.serial === DS.find((x) => x.id === d.id).serial));
  check('1e. Cả 20 máy được ghi số máy phần cứng — lần sau dò bằng số máy, không đoán theo đời nữa',
    r.ds.every((d) => d.hw) && r.khongThay.length === 0, JSON.stringify(r.khongThay));
  check('1f. Không hai máy nào chung một IP', new Set(r.ds.map((d) => d.serial)).size === r.ds.length);

  // Lần sau (đã có số máy): DHCP xáo tiếp → vẫn tìm đúng, kể cả hai máy cùng đời đổi chỗ cho nhau.
  const farm2 = FARM.map((o) => Object.assign({}, o));
  const k1 = farm2.find((o) => o.hwSerial === '988ad04845304b484530');
  const k2 = farm2.find((o) => o.hwSerial === '988a5c394736324a3930');
  [k1.serial, k2.serial] = [k2.serial, k1.serial];
  const r2 = ghepMay(r.ds, farm2);
  check('1g. Có số máy rồi thì hai chiếc CÙNG ĐỜI đổi IP cho nhau vẫn nhận đúng từng chiếc',
    r2.ds.find((d) => d.name === 'Redmi K20 Pro1').serial === ip(149) && r2.ds.find((d) => d.name === 'Redmi K20 Pro').serial === ip(141),
    JSON.stringify(r2.doi));
}

// ── 2. Ca biên ──
{
  // Hai máy cùng đời CHƯA có số máy, cả hai IP cũ đều mất → không đoán.
  const ds = [{ id: 'a', name: 'Redmi K20 Pro', serial: ip(1) }, { id: 'b', name: 'Redmi K20 Pro 2', serial: ip(2) }];
  const farm = [{ serial: ip(3), model: 'Redmi K20 Pro', hwSerial: 'X' }, { serial: ip(4), model: 'Redmi K20 Pro', hwSerial: 'Y' }];
  const r = ghepMay(ds, farm);
  check('2a. Hai máy cùng đời chưa rõ ai là ai → KHÔNG đoán bừa, nói rõ phải sửa IP một lần',
    r.doi.length === 0 && r.khongThay.length === 2 && /cùng đời/.test(r.khongThay[0].viSao + r.khongThay[1].viSao),
    JSON.stringify(r.khongThay.map((x) => x.viSao)));
}
{
  // Máy đang chạy: giữ nguyên, và IP của nó không được giao cho máy khác.
  const ds = [{ id: 'a', name: 'GM1911', serial: ip(106) }, { id: 'b', name: 'V2031', serial: ip(115) }];
  const farm = [{ serial: ip(115), model: 'GM1911', hwSerial: 'G' }];
  const r = ghepMay(ds, farm, new Map([['b', ip(115)]]));
  check('2b. Máy đang chạy giữ nguyên; IP nó đang giữ không giao cho máy khác (hai tiến trình một điện thoại)',
    r.ds.find((d) => d.id === 'b').serial === ip(115) && r.ds.find((d) => d.id === 'a').serial === ip(106)
    && r.khongThay.some((x) => x.id === 'a'));
}
{
  // Máy đã có số máy, IP cũ giờ là một điện thoại khác, còn máy đó chưa online.
  const ds = [{ id: 'a', name: 'V2031', serial: ip(115), hw: 'V' }];
  const farm = [{ serial: ip(115), model: 'GM1911', hwSerial: 'G' }];
  const r = ghepMay(ds, farm);
  check('2c. IP cũ giờ là điện thoại khác, máy mình chưa online → không nhận bừa, nói rõ',
    r.doi.length === 0 && /giờ là một điện thoại khác \(GM1911\)/.test((r.khongThay[0] || {}).viSao || ''),
    JSON.stringify(r.khongThay));
}
{
  // Người dùng đặt tên tuỳ ý: không nhận theo đời được, nhưng có số máy thì vẫn dò được.
  const ds = [{ id: 'a', name: 'Máy test phòng 2', serial: ip(9), hw: 'H' }];
  const r = ghepMay(ds, [{ serial: ip(19), model: 'CPH2127', hwSerial: 'H' }]);
  check('2d. Tên tuỳ ý nhưng đã có số máy → vẫn tìm ra IP mới', r.ds[0].serial === ip(19) && r.doi.length === 1);
}
check('2e. Khớp tên: đời máy + hậu tố ("Redmi K20 Pro1") khớp; đời khác ("V2036" với V2031) không khớp',
  khopTen('Redmi K20 Pro1', 'Redmi K20 Pro') && khopTen('redmi  k20 pro', 'Redmi K20 Pro')
  && !khopTen('V2036', 'V2031') && !khopTen('GM1911', ''));

// ── 3. `noiLai`: điện thoại vừa khởi động lại, GIỮ IP cũ nhưng rơi khỏi ADB server (GM1901, 2026-09-19) ──
// Chạy ĐÚNG hàm thật trong devices.cjs; chỉ thay `execFile` (không gọi adb thật) và đường dẫn adb.
async function thuNoiLai() {
  const cp = require('child_process');
  const execFileGoc = cp.execFile;
  const goi = [];
  let traLoi = '';
  cp.execFile = (file, args, opt, cb) => {
    goi.push({ file, args, opt });
    setImmediate(() => (traLoi === 'LOI' ? cb(new Error('Command failed'), '', '') : cb(null, traLoi, '')));
    return {};
  };
  const pDev = require.resolve(path.join(__dirname, '..', 'src', 'devices.cjs'));
  const pAdb = require.resolve(path.join(__dirname, '..', 'src', 'adbpath.cjs'));
  const adbThat = require(pAdb);
  delete require.cache[pDev];
  require.cache[pAdb] = { id: pAdb, filename: pAdb, loaded: true,
    exports: Object.assign({}, adbThat, { adbPath: () => 'C:/adb/adb.exe' }) };
  try {
    const { noiLai } = require(pDev);
    const kq = {};
    for (const [ten, tl] of [['da_noi', 'already connected to 192.168.5.110:5555\n'],
      ['vua_noi', 'connected to 192.168.5.110:5555\n'],
      ['hong', "failed to connect to '192.168.5.110:5555': Connection timed out\n"], ['loi', 'LOI']]) {
      traLoi = tl;
      kq[ten] = await noiLai('192.168.5.110:5555');
    }
    const g = goi[0] || {};
    check('3a. Nối lại đúng IP cũ bằng "adb connect", có hạn chờ (máy đang khởi động thì không treo lượt chạy lại)',
      g.file === 'C:/adb/adb.exe' && JSON.stringify(g.args) === '["connect","192.168.5.110:5555"]'
      && g.opt && g.opt.timeout > 0 && g.opt.timeout <= 15000, JSON.stringify(g));
    check('3b. "connected to" / "already connected to" → nối được; "failed to connect" / lỗi → không',
      kq.da_noi === true && kq.vua_noi === true && kq.hong === false && kq.loi === false, JSON.stringify(kq));
    const truoc = goi.length;
    const usb = await noiLai('R58M123ABC');
    const rong = await noiLai('');
    check('3c. Máy cắm USB (serial không phải ip:port) → không gọi "adb connect"',
      usb === false && rong === false && goi.length === truoc);
  } finally {
    cp.execFile = execFileGoc;
    require.cache[pAdb] = { id: pAdb, filename: pAdb, loaded: true, exports: adbThat };
    delete require.cache[pDev];
  }
}

// ── 4. `khoiDongLai`: máy bị đơ → gửi đúng lệnh nút Restart của 效卫 (2026-09-22) ──
// Chạy ĐÚNG hàm thật; chỉ thay `execFile` — KHÔNG gửi `adb reboot` thật tới máy nào.
async function thuKhoiDongLai() {
  const cp = require('child_process');
  const execFileGoc = cp.execFile;
  const goi = [];
  let tl = null;   // { err, stdout, stderr }
  cp.execFile = (file, args, opt, cb) => {
    goi.push({ file, args, opt });
    setImmediate(() => cb(tl.err, tl.stdout || '', tl.stderr || ''));
    return {};
  };
  const pDev = require.resolve(path.join(__dirname, '..', 'src', 'devices.cjs'));
  const pAdb = require.resolve(path.join(__dirname, '..', 'src', 'adbpath.cjs'));
  const adbThat = require(pAdb);
  delete require.cache[pDev];
  require.cache[pAdb] = { id: pAdb, filename: pAdb, loaded: true,
    exports: Object.assign({}, adbThat, { adbPath: () => 'C:/adb/adb.exe' }) };
  const loi = (msg, them) => Object.assign(new Error(msg), them || {});
  try {
    const { khoiDongLai } = require(pDev);
    const S = '192.168.5.110:5555';
    const kq = {};
    for (const [ten, t] of [
      ['xong', { err: null }],
      ['het_gio', { err: loi('Command failed', { killed: true }) }],
      ['dut', { err: loi('Command failed'), stderr: 'error: closed' }],
      ['khong_thay', { err: loi('Command failed'), stderr: "adb.exe: device '192.168.5.110:5555' not found" }],
      ['offline', { err: loi('Command failed'), stderr: 'adb.exe: device offline' }],
    ]) {
      tl = t;
      kq[ten] = await khoiDongLai(S);
    }
    const g = goi[0] || {};
    check('4a. Gửi đúng lệnh nút Restart của 效卫 (`adb -s <máy> shell reboot`), có hạn chờ',
      g.file === 'C:/adb/adb.exe' && JSON.stringify(g.args) === JSON.stringify(['-s', S, 'shell', 'reboot'])
      && g.opt && g.opt.timeout > 0 && g.opt.timeout <= 20000, JSON.stringify(g));
    check('4b. Lệnh xong / hết giờ / mất kết nối (máy đang tắt) → coi là ĐÃ GỬI được',
      kq.xong.ok && kq.het_gio.ok && kq.dut.ok, JSON.stringify(kq));
    check('4c. Không có máy (not found / offline) → KHÔNG gửi được, kèm câu lỗi thật',
      !kq.khong_thay.ok && /not found/.test(kq.khong_thay.msg) && !kq.offline.ok, JSON.stringify(kq));
    const truoc = goi.length;
    const rong = await khoiDongLai('');
    check('4d. Không có serial → không gọi adb', rong.ok === false && goi.length === truoc);
  } finally {
    cp.execFile = execFileGoc;
    require.cache[pAdb] = { id: pAdb, filename: pAdb, loaded: true, exports: adbThat };
    delete require.cache[pDev];
  }
}

thuNoiLai().catch((e) => check('3. noiLai chạy được', false, e && e.stack))
  .then(() => thuKhoiDongLai()).catch((e) => check('4. khoiDongLai chạy được', false, e && e.stack)).then(() => {
  const failed = results.filter((x) => !x.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
  process.exit(failed.length ? 1 : 0);
});
