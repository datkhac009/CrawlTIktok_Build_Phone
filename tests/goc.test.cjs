// tests/goc.test.cjs — luật "Chỉ lấy Original Sound": phía Python và bản PC phải KHỚP NHAU.
//
// VÌ SAO (2026-09-18): Python quyết sound nào đi tiếp (và vì thế quyết cả việc có tương tác với
// video đó không) bằng biểu thức nhãn do Node dựng từ `linkkey.cjs`. Node chốt lại lần cuối bằng
// chính `linkkey.isOriginalSound` của bản PC. Hai nơi chạy hai ngôn ngữ khác nhau — nếu lệch,
// Python cho qua thứ Node chặn (hoặc ngược lại) mà không ai hay. Ở đây chạy ĐÚNG hàm Python thật
// và ĐÚNG hàm JS thật trên cùng một bộ mẫu, gồm cả 8 sound đo trên farm hôm 2026-09-18.
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function done() {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) console.log('FAIL: ' + failed.map((f) => f.name).join(' | '));
  process.exit(failed.length ? 1 : 0);
}

const R = path.join(__dirname, '..');
const linkkey = require(path.join(R, 'src', 'linkkey.cjs'));
const runner = require(path.join(R, 'src', 'runner.cjs'));
const { findPython } = require(path.join(R, 'src', 'pythonpath.cjs'));

const M = 'https://www.tiktok.com/music/';
const ID = '-7633696888679598855';
// [mô tả, link thật (có thể rỗng), tên nguyên văn trên trang nhạc, KỲ VỌNG]
const MAU = [
  // ── 8 sound đo thật trên farm (probe_screen.py --origin, TikTok 46.9.3) ──
  ['farm: âm-thanh-gốc-Lajico', M + '%C3%A2m-thanh-g%E1%BB%91c-Lajico' + ID, 'Original Sound T Lajico', true],
  ['farm: nhạc-nền + "Contains:"', M + 'nh%E1%BA%A1c-n%E1%BB%81n-Kimdung' + ID, 'Contains: Nỗ Lực Mỗi Ngày DJ Frostline', true],
  ['farm: nhạc-nền-J1N + "Contains:"', M + 'nh%E1%BA%A1c-n%E1%BB%81n-J1N' + ID, 'Contains: Để Anh Lương Thiện (', true],
  ['farm: Passport Sky (nhạc bản quyền)', M + 'Passport-Sky' + ID, 'Passport Sky T Tommy Alvarez', false],
  ['farm: original-sound-<tên có ký tự lạ>', M + 'original-sound-%E1%B4%8D%E1%B4%8F%E1%B4%A0%C9%AA%E1%B4%87' + ID, 'Original Sound T', true],
  ['farm: âm-thanh-gốc + "Contains:"', M + '%C3%A2m-thanh-g%E1%BB%91c-vbb512' + ID, 'Contains: Thương Phận Hồng Nha', true],
  ['farm: new-trick (tên tuỳ ý)', M + 'new-trick' + ID, 'new trickT T', false],
  ['farm: pour-it-up (sound gốc bị đổi tên)', M + 'pour-it-up' + ID, 'pour it up T ..', false],
  // ── Ca biên ──
  ['không có link thật, tên là sound gốc', '', 'Original Sound thật huy', true],
  ['không có link thật, tên "Contains:"', '', 'Contains: Nỗ Lực Mỗi Ngày', false],
  ['tên tiếng Việt, không có link', '', 'âm thanh gốc - Lajico', true],
  ['tên tiếng Việt dạng NFD', '', 'âm thanh gốc - Lajico'.normalize('NFD'), true],
  ['nhạc phim "original-soundtrack" KHÔNG phải sound gốc', M + 'original-soundtrack-of-my-life' + ID, 'Original Soundtrack Of My Life', false],
  ['"âm-thanh-gốcxyz" — nhãn không đứng trọn từ', M + 'âm-thanh-gốcxyz' + ID, 'x', false],
  ['tiếng Pháp', M + 'son-original-Omar-Hassan' + ID, 'son original - Omar Hassan', true],
  ['tiếng Ả Rập', M + 'الصوت-الأصلي-Amal' + ID, 'الصوت الأصلي - Amal', true],
  ['tiếng Hàn', M + '오리지널-사운드-Justin' + ID, '오리지널 사운드 - Justin', true],
  ['tiếng Đức, chỉ có tên', '', 'Originalton - Vanessa', true],
  ['link có ?query và CHỮ HOA', M + 'Original-Sound-ABC' + ID + '?lang=vi&x=1', 'x', true],
  ['link không phải trang nhạc', 'https://www.tiktok.com/@abc/video/7633696888679598855', 'Some Song', false],
];

// ── 1. Kỳ vọng của bản PC (nguồn sự thật) ──
{
  const sai = MAU.filter(([, url, ten, mong]) => linkkey.isOriginalSound(url, ten) !== mong).map(([m]) => m);
  check('1. Bản PC (linkkey) xếp đúng mọi mẫu', sai.length === 0, sai.join(' | '));
}

// ── 2. Phía Python phải cho ĐÚNG cùng kết quả ──
const py = findPython({ fresh: true });
if (!py || !py.hasU2) {
  check('2. Có Python + uiautomator2 để so', true, 'KHÔNG có — bỏ qua phần so với Python');
  done();
}
const KICH_BAN = [
  'import sys, os, json',
  'sys.path.insert(0, os.environ["APP_DIR"])',
  'import scan_feed_sounds as S',
  'mau = json.loads(os.environ["MAU"])',
  'print("@@KQ@@" + json.dumps([S.la_sound_goc(u, t) for (u, t) in mau]), flush=True)',
  'print("@@CO_LUAT@@" + json.dumps(S.CO_LUAT_GOC), flush=True)',
].join('\n');
const r = spawnSync(py.cmd, [...py.args, '-c', KICH_BAN], {
  encoding: 'utf8', timeout: 60000,
  env: Object.assign({}, process.env, {
    APP_DIR: R, PYTHONIOENCODING: 'utf-8',
    RE_GOC_SLUG: runner.RE_GOC_SLUG, RE_GOC_TEN: runner.RE_GOC_TEN,
    MAU: JSON.stringify(MAU.map(([, url, ten]) => [url, ten])),
  }),
});
const dong = String(r.stdout || '').split(/\r?\n/);
const kq = JSON.parse((dong.find((l) => l.startsWith('@@KQ@@')) || '@@KQ@@null').slice(6));
check('2. Chạy được hàm Python thật', Array.isArray(kq), String(r.stderr || '').slice(-300));
if (Array.isArray(kq)) {
  const lech = MAU.map(([m, url, ten], i) => ({ m, js: linkkey.isOriginalSound(url, ten), py: kq[i] }))
    .filter((x) => x.js !== x.py);
  check(`2b. Python và bản PC KHỚP trên cả ${MAU.length} mẫu`, lech.length === 0,
    lech.map((x) => `${x.m}: PC=${x.js} Python=${x.py}`).join(' | '));
}
check('2c. Python biết mình đang có luật từ app',
  (dong.find((l) => l.startsWith('@@CO_LUAT@@')) || '').endsWith('true'));

// ── 3. Không có nhãn từ app (chạy ngoài app) → KHÔNG được âm thầm loại sạch ──
{
  const r2 = spawnSync(py.cmd, [...py.args, '-c', KICH_BAN], {
    encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, {
      APP_DIR: R, PYTHONIOENCODING: 'utf-8', RE_GOC_SLUG: '', RE_GOC_TEN: '',
      MAU: JSON.stringify([['', 'Original Sound x']]),
    }),
  });
  const co = (String(r2.stdout || '').split(/\r?\n/).find((l) => l.startsWith('@@CO_LUAT@@')) || '');
  check('3. Thiếu nhãn từ app → Python TỰ BIẾT là không có luật (để tắt lọc và nói ra)', co.endsWith('false'), co);
}

// ── 4. Nhánh PENDING (2026-09-18): KHÔNG đọc được số video ──
// Chạy ĐÚNG `check_current_video` thật, chỉ thay phần chạm màn hình: icon sound bấm được, trang
// nhạc mở ra với tên cho sẵn, ô số video KHÔNG BAO GIỜ hiện, link thật cho sẵn.
{
  const KB_PENDING = [
    'import sys, os, json',
    'sys.path.insert(0, os.environ["APP_DIR"])',
    'import scan_feed_sounds as S',
    'S.REST_AFTER_BACK = 0',
    'S.SETTLE = 0.05',
    'su_kien = []',
    'S.emit_event = lambda t, **f: su_kien.append(dict(f, type=t))',
    'S.log = lambda m: None',
    'S.log_han_che = lambda k, m: None',
    'class El:',
    '    def __init__(s, desc): s.info = {"contentDescription": desc}',
    '    def get_text(s): return s.info["contentDescription"]',
    '    def click(s): pass',
    'class D:',
    '    def press(s, k): pass',
    '    def app_current(s): return {"activity": ""}',
    'kq = []',
    'for (ten, url, mid) in json.loads(os.environ["CA"]):',
    '    su_kien.clear()',
    '    def ff(d, ids, timeout=0, _ten=ten):',
    '        if ids is S.SOUND_ICON_IDS: return El("")',
    '        if ids is S.TITLE_IDS: return El(_ten)',
    '        return None',
    '    S.find_first = ff',
    '    S.lay_link_that = lambda d, _u=url: _u',
    '    S.get_music_id = lambda d, _m=mid: _m',
    '    r = S.check_current_video(D())',
    '    kq.append({"ket_qua": r[0], "su_kien": [e for e in su_kien if e["type"] == "result"]})',
    'print("@@PENDING@@" + json.dumps(kq, ensure_ascii=False), flush=True)',
  ].join('\n');
  // [tên nguyên văn trên trang nhạc, link thật (rỗng = Share → Copy link hỏng), music id]
  const CA = [
    ['Original Sound T Lajico', M + '%C3%A2m-thanh-g%E1%BB%91c-Lajico' + ID, '7633696888679598855'],
    ['Passport Sky T Tommy Alvarez', M + 'Passport-Sky' + ID, '7633696888679598855'],
    ['Original Sound thật huy', '', '7633696888679598855'],
    ['Original Sound thật huy', '', null],
  ];
  const chayPending = (bat) => {
    const r4 = spawnSync(py.cmd, [...py.args, '-c', KB_PENDING], {
      encoding: 'utf8', timeout: 60000,
      env: Object.assign({}, process.env, {
        APP_DIR: R, PYTHONIOENCODING: 'utf-8', GUI_MODE: '1',
        RE_GOC_SLUG: runner.RE_GOC_SLUG, RE_GOC_TEN: runner.RE_GOC_TEN,
        PENDING_ON: bat ? '1' : '0', CA: JSON.stringify(CA),
      }),
    });
    const l = String(r4.stdout || '').split(/\r?\n/).find((x) => x.startsWith('@@PENDING@@'));
    if (!l) return { loi: String(r4.stderr || '').slice(-400) };
    return { kq: JSON.parse(l.slice('@@PENDING@@'.length)) };
  };

  const bat = chayPending(true);
  check('4. Chạy được check_current_video thật với Pending bật', !!bat.kq, bat.loi);
  if (bat.kq) {
    const [a, b, c, e] = bat.kq;
    const ea = a.su_kien[0] || {};
    check('4a. Sound gốc, không đọc được số video → PENDING kèm LINK THẬT, không phải kết quả thường',
      a.ket_qua === null && a.su_kien.length === 1 && ea.verdict === 'PENDING' && ea.url === CA[0][1]
      && ea.title === 'Original Sound T Lajico', JSON.stringify(a));
    const eb = b.su_kien[0] || {};
    check('4b. Nhạc bản quyền, không đọc được số video → LOẠI, không lọt vào Pending',
      b.ket_qua === null && eb.verdict === 'LOAI' && eb.original === false, JSON.stringify(b));
    const ec = c.su_kien[0] || {};
    check('4c. Không lấy được link thật nhưng tên là sound gốc → cất bằng link dựng từ music id (như sound thường)',
      c.ket_qua === null && ec.verdict === 'PENDING' && ec.url === M + 'original-sound' + ID, JSON.stringify(c));
    const ee = e.su_kien[0] || {};
    check('4e. Không có link thật, cũng không có music id → LOẠI (không có gì để cất)',
      e.ket_qua === null && ee.verdict === 'LOAI', JSON.stringify(e));
  }
  const tat = chayPending(false);
  check('4d. Pending TẮT → sound không đọc được số video bị LOẠI như trước, không cất',
    !!tat.kq && tat.kq.every((x) => x.su_kien.length === 1 && x.su_kien[0].verdict === 'LOAI'),
    tat.loi || JSON.stringify(tat.kq && tat.kq.map((x) => x.su_kien[0])));
}

done();
