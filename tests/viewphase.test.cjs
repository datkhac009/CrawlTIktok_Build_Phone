// tests/viewphase.test.cjs — khoá VÒNG LẶP pha Xem bên Python (chế độ Quét ⇄ Xem).
//
// VÌ SAO (2026-09-18): `mainflow.test.cjs` kiểm phía Node (pha nối pha, mốc ghi xuống đĩa). Còn
// quyết định "mốc tiến tới đâu" nằm bên PYTHON, trong `chay_pha_xem` — và chính chỗ đó là chỗ bản
// PC từng sai (trước v0.1.56 mỗi pha Xem đều bắt đầu lại từ link 1, cuối danh sách dài không bao
// giờ được xem tới). Ở đây chạy ĐÚNG hàm thật trong `scan_feed_sounds.py`, chỉ thay cú bấm trên
// điện thoại (`phone_actions.xem_mot_link`) bằng một kịch bản kết quả dựng sẵn.
'use strict';
const fs = require('fs');
const os = require('os');
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
// Máy nào không có Python thì BỎ QUA, đừng báo đỏ oan — đỏ oan dạy người ta bỏ qua màu đỏ.
const { findPython } = require(path.join(R, 'src', 'pythonpath.cjs'));
const py = findPython({ fresh: true });
if (!py || !py.hasU2) {
  check('0. Có Python + uiautomator2 để chạy', true, 'KHÔNG có — bỏ qua toàn bộ file này');
  done();
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viewphase-'));
const HARNESS = path.join(TMP, 'harness.py');
fs.writeFileSync(HARNESS, [
  'import sys, os, json',
  'sys.path.insert(0, os.environ["APP_DIR"])',
  'import scan_feed_sounds as S',
  'kich_ban = iter(json.loads(os.environ["KICH_BAN"]))',
  'da_goi = []',
  'def gia(d, goi, link, con_han, dung, *a, **k):',
  '    da_goi.append(link)',
  '    return next(kich_ban, "het_gio")',
  'S.PA.xem_mot_link = gia',
  'class CanhGia:',
  '    def __init__(self, *a, **k): pass',
  '    parent_gone = False',
  'S.AskBridge = CanhGia',
  'S.chay_pha_xem(None, "com.zhiliaoapp.musically")',
  'print("@@GOI@@" + json.dumps(da_goi), flush=True)',
].join('\n'), 'utf8');

function chay({ links, start = 0, kichBan }) {
  const f = path.join(TMP, `links_${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(links), 'utf8');
  const r = spawnSync(py.cmd, [...py.args, HARNESS], {
    encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, {
      APP_DIR: R, GUI_MODE: '1', PYTHONIOENCODING: 'utf-8',
      VIEW_LINKS_FILE: f, VIEW_START: String(start), VIEW_PHASE_MIN: '0',
      KICH_BAN: JSON.stringify(kichBan),
    }),
  });
  const dong = String(r.stdout || '').split(/\r?\n/);
  const ev = dong.filter((l) => l.startsWith('@@EVENT@@')).map((l) => JSON.parse(l.slice(9)));
  const goi = JSON.parse((dong.find((l) => l.startsWith('@@GOI@@')) || '@@GOI@@[]').slice(7));
  return {
    loi: r.status !== 0 ? String(r.stderr || '').slice(-400) : '',
    dangXem: ev.filter((e) => e.type === 'view_progress').map((e) => e.idx),
    moc: ev.filter((e) => e.type === 'view_moc').map((e) => e.idx),
    xong: ev.some((e) => e.type === 'status' && e.state === 'cycle_done'),
    log: dong.filter((l) => l && !l.startsWith('@@')).join('\n'),
    goi,
  };
}

const L3 = ['https://x/a-1111111111', 'https://x/b-2222222222', 'https://x/c-3333333333'];

// ── 1. Mốc tiến đúng, và HẾT GIỜ giữa chừng thì KHÔNG tiến mốc ──
{
  const k = chay({ links: L3, start: 1, kichBan: ['ok', 'không mở được link', 'het_gio'] });
  check('1. Chạy được hàm thật', !k.loi, k.loi);
  check('1b. Bắt đầu từ mốc đã lưu (link 2), không từ link 1', k.dangXem[0] === 1, JSON.stringify(k.dangXem));
  check('1c. Xem xong link 2 → mốc sang link 3; hỏng link 3 → bỏ qua, mốc vòng về link 1',
    JSON.stringify(k.moc) === '[2,0]', JSON.stringify(k.moc));
  check('1d. Hết giờ giữa link 1 → KHÔNG tiến mốc: pha sau xem lại chính link 1',
    !k.moc.includes(1) && /Lần sau bắt đầu từ link 1\/3/.test(k.log));
  check('1e. Link hỏng được NÓI RA kèm lý do', /Bỏ link 3\/3 — không mở được link/.test(k.log));
  check('1f. Hết pha thì báo cycle_done để Node cho nghỉ rồi sang pha kế', k.xong);
}

// ── 2. Mốc vượt độ dài danh sách (người dùng vừa xoá bớt link) → quay vòng, không vỡ ──
{
  const k = chay({ links: L3, start: 7, kichBan: ['het_gio'] });
  check('2. Mốc 7 với danh sách 3 link → bắt đầu ở link 2 (7 mod 3)', k.dangXem[0] === 1, JSON.stringify(k.dangXem));
}

// ── 3. Cả danh sách hỏng liên tiếp → kết thúc pha SỚM ──
// Không có hàng rào này thì mất mạng / TikTok chặn là pha Xem đốt trọn 30 phút mở link hỏng,
// mỗi lần 12–25 giây.
{
  const k = chay({ links: L3.slice(0, 2), kichBan: ['lỗi A', 'lỗi B', 'ok', 'ok'] });
  check('3. Hỏng liền cả 2/2 link → dừng pha sớm, không thử lại vòng hai',
    k.goi.length === 2 && /kết thúc pha Xem sớm/.test(k.log), `gọi ${k.goi.length} lần`);
  check('3b. Và vẫn báo cycle_done để chu kỳ chạy tiếp', k.xong);
}

// ── 4. Danh sách trống → bỏ pha, nói ra, vẫn báo hết pha ──
{
  const k = chay({ links: [], kichBan: [] });
  check('4. Danh sách trống → không mở link nào', k.goi.length === 0);
  check('4b. Nói rõ là bỏ pha Xem', /Danh sách link trống — bỏ pha Xem/.test(k.log));
  check('4c. Vẫn báo cycle_done — không để máy kẹt ở pha này', k.xong);
}

// ── 5. App đóng giữa chừng → thoát NGAY, không báo hết pha ──
{
  const k = chay({ links: L3, kichBan: ['ok', 'dung', 'ok'] });
  check('5. App đóng → dừng, không mở thêm link nào', k.goi.length === 2, `gọi ${k.goi.length} lần`);
  check('5b. Không báo cycle_done (không có ai để nghỉ rồi chạy lại)', !k.xong);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
done();
