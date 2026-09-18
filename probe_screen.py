"""probe_screen.py — Chup man hinh THAT roi doc, thay vi doan tiep.

VI SAO PHAI CO (2026-09-16)
===========================
Luot chay thu `--full` tren may SM-N975F (TikTok v46.1.1): 20 video, **0 sound dat, 0 cu bam**.
19/20 video bao `khong co icon sound`. Hai nut that, va CA HAI deu la nhan dien man hinh chua
tung duoc do tren may that:

  1. `scan_feed_sounds.py:46` tim icon sound bang DUNG MOT id: `rid("videomusiccoverblock")`.
     Id do sai hoac TikTok da doi ten thi ham tra None, va ca vong quet im lang khong lam gi.
  2. `phone_actions.read_video_info()` doan @handle theo HINH DANG (`^@abc$`) chu khong theo
     resource-id. Docstring cua chinh no thu nhan: "chua do duoc resource-id cua caption va ten
     tac gia tren may that". Ma `askproto.cjs:128,145,151` doi `handle` khac rong cho CA follow,
     tym LAN ghe trang -> khong doc duoc handle thi Node tra 0 het, cho MOI video, khong mot
     dong log nao.

Nen buoc tiep theo khong phai sua mo, ma la DO. File nay chup `dump_hierarchy()` cua may that,
liet ke moi resource-id dang co tren man hinh, va in nguyen van thu ma `read_video_info` doc ra.

⚠ FILE NAY KHONG CHUA LUAT NAO, va cung khong viet lai logic doc. No goi DUNG
`phone_actions.read_video_info` — vi thu can do chinh la ham do. Viet mot ban doc rieng o day thi
do xong lai khong biet ban that co doc duoc khong.

Chay tay, khong noi vao app, khong nam trong ban build (`package.json` da loai `probe_*.xml`).

    python probe_screen.py 192.168.x.y:5555 [--n 5]
"""
import os
import re
import sys
import time
import json
import random
import collections
import xml.etree.ElementTree as ET

from adb_helper import connect, list_devices, adb
import phone_actions as PA

# Nhung id ma code dang tin la co that. Do lai tung cai mot.
ID_DANG_DUNG = {
    "videomusiccoverblock": "icon sound tren feed (scan_feed_sounds.py:46 SOUND_ICON_IDS)",
    "title": "ten sound tren trang nhac (TITLE_IDS)",
    "used_count": "so post tren trang nhac (COUNT_IDS)",
}
PKGS = ["com.zhiliaoapp.musically", "com.ss.android.ugc.trill"]


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _nodes(xml_str):
    """Moi node, kem resource-id / text / content-desc / class. Khong loc gi ca."""
    out = []
    try:
        root = ET.fromstring(xml_str)
    except Exception as e:
        log(f"khong doc duoc XML: {str(e)[:80]}")
        return out
    for n in root.iter():
        out.append({
            "id": (n.get("resource-id") or "").strip(),
            "text": (n.get("text") or "").strip(),
            "desc": (n.get("content-desc") or "").strip(),
            "cls": (n.get("class") or "").split(".")[-1],
            "la": len(n) == 0,
        })
    return out


def _rut_id(rid):
    """`com.zhiliaoapp.musically:id/abc` -> `abc`. Chuoi la thi giu nguyen."""
    return rid.split(":id/")[-1] if ":id/" in rid else rid


def do_mot_mau(d, serial, i):
    xml_str = d.dump_hierarchy()

    ten = f"probe_{serial.replace(':', '_').replace('.', '-')}_{time.strftime('%H%M%S')}_{i}.xml"
    duong = os.path.join(os.path.dirname(os.path.abspath(__file__)), ten)
    with open(duong, "w", encoding="utf-8") as f:
        f.write(xml_str)

    nodes = _nodes(xml_str)
    co_id = [n for n in nodes if n["id"]]
    dem = collections.Counter(_rut_id(n["id"]) for n in co_id)

    print()
    log(f"── MAU #{i} ──  {len(nodes)} node, {len(co_id)} node co resource-id  -> {ten}")

    # 1. Kiem DICH DANH nhung id ma code dang tin.
    print("  · Id ma code dang tin:")
    for key, mo_ta in ID_DANG_DUNG.items():
        co = dem.get(key, 0)
        print(f"      {'CO   ' if co else 'KHONG'} {key:26s} x{co}   ({mo_ta})")

    # 2. Bang id dang co that tren man hinh. Day la cho tim id THAY THE cho icon sound.
    print(f"  · {len(dem)} resource-id dang co tren man hinh (kem chu, neu co):")
    for key, so in dem.most_common():
        vi_du = next((n for n in co_id if _rut_id(n["id"]) == key and (n["text"] or n["desc"])), None)
        chu = ""
        if vi_du:
            chu = (vi_du["text"] or vi_du["desc"])[:60]
            chu = f'  "{chu}"'
        print(f"      {key:34s} x{so}{chu}")

    # 2b. DAU HIEU LIVE. Yeu cau moi (2026-09-16): bo qua han user/video dang livestream.
    #     Chua biet neo nao dang tin -> in RA HET moi node co chu "live" kem resource-id, roi
    #     nhin so lieu ma chon, thay vi doan mot id roi cau dau.
    live = [n for n in nodes if re.search(r"live", (n["text"] + " " + n["desc"]), re.I)]
    if live:
        print(f"  · {len(live)} node co chu LIVE (ung vien de nhan dien livestream):")
        for n in live[:8]:
            print(f'      {_rut_id(n["id"]) or "(khong co id)":30s} {n["cls"]:16s} '
                  f'text="{n["text"][:30]}" desc="{n["desc"][:40]}"')
    else:
        print("  · khong thay node nao co chu LIVE (video nay khong phai livestream)")

    # 3. Thu ma phia Node THUC SU nhan duoc. Day la cau tra loi cho "vi sao khong follow duoc".
    info = PA.read_video_info(d)
    print("  · read_video_info() tra ve (DUNG cai ma askproto.cjs nhan):")
    print("      " + json.dumps(info, ensure_ascii=False)[:600])

    handle = info.get("handle", "")
    co_icon = dem.get("videomusiccoverblock", 0) > 0
    # Ba cai khoa cua askproto.cjs:128,145,151 — thieu handle la ca ba cung dong.
    print(f"  · KET LUAN mau #{i}: icon_sound={'CO' if co_icon else 'KHONG'}  "
          f"handle={handle or 'RONG -> follow/tym/ghe deu se bi tra 0'}  "
          f"desc_len={len(info.get('desc', ''))}  badges={len(info.get('badges', []))}")

    return {"icon": co_icon, "handle": handle, "ids": set(dem.keys())}


def do_trang_ca_nhan(d, serial, i):
    """Mo trang ca nhan cua tac gia roi doc @handle that + nut Follow that.

    ⚠ CHI BAM AVATAR, KHONG BAM FOLLOW. Cu follow khong hoan tac duoc, ma day la buoc DO.
    Truoc khi bam con kiem toa do: neu o avatar chong len nut Follow thi THOI, khong bam mu.
    """
    xml_str = d.dump_hierarchy()
    try:
        root = ET.fromstring(xml_str)
    except Exception:
        log("khong doc duoc XML feed"); return None

    def _bounds(node):
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds") or "")
        return tuple(int(x) for x in m.groups()) if m else None

    avatar = nut_follow = None
    for n in root.iter():
        rid = _rut_id(n.get("resource-id") or "")
        if rid == "user_avatar" and avatar is None:
            avatar = _bounds(n)
        if rid == "ife" and nut_follow is None:
            nut_follow = _bounds(n)

    print(f"  · o avatar (user_avatar) : {avatar}")
    print(f"  · o nut Follow (ife)     : {nut_follow}")
    if not avatar:
        log("khong thay user_avatar -> bo qua mau nay"); return None

    ax, ay = (avatar[0] + avatar[2]) // 2, (avatar[1] + avatar[3]) // 2
    if nut_follow and nut_follow[0] <= ax <= nut_follow[2] and nut_follow[1] <= ay <= nut_follow[3]:
        log("TAM AVATAR NAM TRONG NUT FOLLOW -> KHONG bam, tranh follow nham"); return None

    log(f"bam vao avatar tai ({ax},{ay}) de mo trang ca nhan...")
    d.click(ax, ay)
    time.sleep(3.5)

    xml2 = d.dump_hierarchy()
    ten = f"probe_profile_{serial.replace(':', '_').replace('.', '-')}_{time.strftime('%H%M%S')}_{i}.xml"
    duong = os.path.join(os.path.dirname(os.path.abspath(__file__)), ten)
    with open(duong, "w", encoding="utf-8") as f:
        f.write(xml2)

    nodes2 = _nodes(xml2)
    log(f"── TRANG CA NHAN ──  {len(nodes2)} node  -> {ten}")

    # @handle that: chuoi dang @abc o BAT KY node nao.
    handles = [n for n in nodes2 if re.match(r"^@[A-Za-z0-9._]{1,30}$", n["text"] or n["desc"] or "")]
    print(f"  · node co @handle: {len(handles)}")
    for n in handles[:5]:
        print(f'      {_rut_id(n["id"]) or "(khong co id)":30s} text="{n["text"]}" desc="{n["desc"]}"')

    # Nut Follow that: o day no co text that khong, hay lai chi co content-desc?
    nut = [n for n in nodes2 if re.search(r"follow", (n["text"] + " " + n["desc"]), re.I)]
    print(f"  · node lien quan Follow: {len(nut)}")
    for n in nut[:8]:
        print(f'      {_rut_id(n["id"]) or "(khong co id)":30s} {n["cls"]:16s} '
              f'text="{n["text"][:28]}" desc="{n["desc"][:38]}"')

    d.press("back")
    time.sleep(2.5)
    return {"handles": [h["text"] or h["desc"] for h in handles],
            "follow_text": [n["text"] for n in nut if n["text"]]}


def _luu(d, serial, nhan):
    """Chup cay giao dien hien tai ra file, tra (xml, nodes, ten file)."""
    xml_str = d.dump_hierarchy()
    ten = f"probe_view_{serial.replace(':', '_').replace('.', '-')}_{time.strftime('%H%M%S')}_{nhan}.xml"
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), ten), "w", encoding="utf-8") as f:
        f.write(xml_str)
    return xml_str, _nodes(xml_str), ten


def _in_bang_id(nodes, toi_da=40):
    co_id = [n for n in nodes if n["id"]]
    dem = collections.Counter(_rut_id(n["id"]) for n in co_id)
    for key, so in dem.most_common(toi_da):
        vi_du = next((n for n in co_id if _rut_id(n["id"]) == key and (n["text"] or n["desc"])), None)
        chu = f'  "{(vi_du["text"] or vi_du["desc"])[:60]}"' if vi_du else ""
        print(f"      {key:34s} x{so}{chu}")
    return dem


def _bounds_all(xml_str):
    """[(rid, cls, clickable, (x1,y1,x2,y2), text, desc)] cho moi node co bounds."""
    out = []
    try:
        root = ET.fromstring(xml_str)
    except Exception:
        return out
    for n in root.iter():
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", n.get("bounds") or "")
        if not m:
            continue
        out.append((_rut_id(n.get("resource-id") or ""), (n.get("class") or "").split(".")[-1],
                    n.get("clickable") == "true", tuple(int(x) for x in m.groups()),
                    (n.get("text") or "").strip(), (n.get("content-desc") or "").strip()))
    return out


def _link_that_qua_share(d):
    """Share sound -> Copy link -> clipboard -> theo redirect ra link web THAT (co slug that).

    Muc dich (viec 3c): biet slug tren web cua sound goc vs nhac ban quyen trong nhu the nao,
    de xem `linkkey.isOriginalSound(url, name)` cua ban PC co dung duoc tren dien thoai khong.
    """
    share = d(description="Share sound")
    if not share.wait(timeout=5):
        log("  khong thay nut 'Share sound' (desc) -> bo qua do slug"); return None
    share.click(); time.sleep(1.5)
    copy = d(description="Copy link")
    if not copy.wait(timeout=5):
        log("  khong thay 'Copy link' -> bo qua"); d.press("back"); return None
    copy.click(); time.sleep(1.2)
    raw = (d.clipboard or "").strip()
    log(f"  clipboard: {raw[:120]}")
    if not raw.startswith("http"):
        return raw
    try:
        import urllib.request
        req = urllib.request.Request(raw, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.geturl()
    except Exception as e:
        log(f"  theo redirect loi: {str(e)[:80]}")
        return raw


def do_pha_xem(d, serial, link):
    """Do TUNG BUOC cua pha Xem (che do Quet <-> Xem, clone `view` ban PC).

    Ban PC: mo trang sound -> bam 1 video NGAU NHIEN trong luoi -> xem 40-70% do dai -> vuot
    them 20-30 video -> sang link ke. Tren dien thoai chua do buoc nao ca, nen o day chi QUAN
    SAT va in ra. KHONG tym, KHONG follow — chi bam mot o video, vuot, va lui ra.
    """
    print()
    log(f"══ DO PHA XEM ══  {link}")

    # 1. Deep link. Chi dinh package o cuoi de Android khong hien bang chon trinh duyet.
    pkg = PKGS[0]
    out = d.shell(f'am start -a android.intent.action.VIEW -d "{link}" {pkg}').output
    log(f"  am start: {out.strip()[:160]}")
    time.sleep(6)
    cur = d.app_current()
    log(f"  sau deep link: package={cur.get('package')} activity={cur.get('activity')}")
    xml1, n1, f1 = _luu(d, serial, "1_trang")
    log(f"  ── BUOC 1: trang mo tu link ──  {len(n1)} node -> {f1}")
    dem1 = _in_bang_id(n1)
    tieu_de = [n for n in n1 if _rut_id(n["id"]) == "title"]
    so_post = [n for n in n1 if _rut_id(n["id"]) == "used_count"]
    print(f"  · title: {[t['text'] for t in tieu_de][:3]}   used_count: {[t['text'] for t in so_post][:3]}")
    # Dau hieu sound goc / ban quyen: in moi chu ngan tren trang de nhin bang mat.
    chu_ngan = [n["text"] or n["desc"] for n in n1 if (n["text"] or n["desc"]) and len(n["text"] or n["desc"]) <= 40]
    print(f"  · chu ngan tren trang ({len(chu_ngan)}): {chu_ngan[:40]}")

    # 1b. Slug that qua Share -> Copy link (viec 3c).
    that = _link_that_qua_share(d)
    log(f"  LINK WEB THAT: {that}")
    time.sleep(1.5)
    # Dong bang chia se neu con mo.
    if d(description="Copy link").exists:
        d.press("back"); time.sleep(1)

    # 2. Luoi video: tim cac o bam duoc nam o nua duoi man hinh.
    xml2, n2, f2 = _luu(d, serial, "2_luoi")
    w, h = d.window_size()
    o = [b for b in _bounds_all(xml2)
         if b[2] and b[3][1] > h * 0.35 and (b[3][2] - b[3][0]) < w * 0.6
         and (b[3][3] - b[3][1]) > h * 0.12]
    ids_o = collections.Counter(b[0] or f"({b[1]})" for b in o)
    log(f"  ── BUOC 2: luoi video ──  {len(o)} o bam duoc, cao > 12% man hinh -> {f2}")
    print(f"  · id cua cac o: {ids_o.most_common(8)}")
    if not o:
        log("  KHONG thay o video nao -> dung o day"); return {"link": link, "that": that, "ok": False}

    chon = random.choice(o[: min(6, len(o))])
    cx, cy = (chon[3][0] + chon[3][2]) // 2, (chon[3][1] + chon[3][3]) // 2
    log(f"  bam o {chon[0] or chon[1]} tai ({cx},{cy})")
    d.click(cx, cy)
    time.sleep(4)

    # 3. Trinh phat: tim cho doc duoc DO DAI video.
    cur = d.app_current()
    xml3, n3, f3 = _luu(d, serial, "3_trinh_phat")
    log(f"  ── BUOC 3: trinh phat ──  activity={cur.get('activity')}  {len(n3)} node -> {f3}")
    _in_bang_id(n3, 30)
    thanh = [b for b in _bounds_all(xml3) if "SeekBar" in b[1] or "Progress" in b[1]]
    print(f"  · SeekBar/Progress: {[(b[0], b[1], b[4][:20], b[5][:30]) for b in thanh][:6]}")
    gio = [n["text"] or n["desc"] for n in n3 if re.search(r"\d{1,2}:\d{2}", n["text"] + " " + n["desc"])]
    print(f"  · chu dang mm:ss: {gio[:8]}")
    ms = d.shell("dumpsys media_session").output
    dong = [l.strip() for l in ms.splitlines() if re.search(r"musically|trill|duration|position|state=", l, re.I)]
    print(f"  · dumpsys media_session ({len(dong)} dong lien quan): {dong[:10]}")
    info = PA.read_video_info(d)
    print(f"  · read_video_info: {json.dumps(info, ensure_ascii=False)[:300]}")

    # 4. Vuot len: co sang video ke CUA CUNG SOUND khong.
    d.swipe(0.5, 0.85, 0.5, 0.15, random.uniform(0.15, 0.3))
    time.sleep(3.5)
    cur2 = d.app_current()
    info2 = PA.read_video_info(d)
    xml4, n4, f4 = _luu(d, serial, "4_sau_vuot")
    doi = info2.get("handle") != info.get("handle") or info2.get("desc") != info.get("desc")
    log(f"  ── BUOC 4: sau mot lan vuot ──  activity={cur2.get('activity')}  "
        f"video {'DA DOI' if doi else 'KHONG DOI'} -> {f4}")
    print(f"  · read_video_info: {json.dumps(info2, ensure_ascii=False)[:300]}")

    for _ in range(3):
        d.press("back"); time.sleep(1.5)
    return {"link": link, "that": that, "ok": True, "doi_video": doi,
            "activity_trinh_phat": cur.get("activity"), "co_seekbar": bool(thanh), "gio": gio[:4]}


def do_nguon_goc(d, serial, n):
    """Viec 3c: tren For You, mo trang nhac cua n video, ghi lai DAU HIEU sound goc vs ban quyen.

    Can so sanh: ten sound, nguoi tao (tv_nickname), nhan tren o video dau tien cua luoi (vd
    "Original"), va SLUG THAT tren web qua Share -> Copy link. Chi quan sat, khong bam gi khac.
    """
    bang = []
    for i in range(1, n + 1):
        icon = d(resourceIdMatches=r".*:id/videomusiccoverblock$")
        if not icon.exists:
            log(f"#{i}: khong co icon sound (quang cao/anh) -> vuot")
        else:
            icon.click(); time.sleep(4)
            xml_str, nodes, f = _luu(d, serial, f"goc{i}")
            def lay(k):
                return next((x["text"] for x in nodes if _rut_id(x["id"]) == k and x["text"]), "")
            nhan_o = [x["text"] for x in nodes if _rut_id(x["id"]) == "mj8" and x["text"]]
            that = _link_that_qua_share(d) or ""
            if d(description="Copy link").exists:
                d.press("back"); time.sleep(1)
            m = re.search(r"/music/([^?]*)-(\d{8,})", that)
            dong = {"i": i, "ten": lay("title"), "nguoi_tao": lay("tv_nickname"),
                    "post": lay("used_count").replace("‎", ""), "nhan_o": nhan_o,
                    "slug": m.group(1) if m else that[:60]}
            bang.append(dong)
            log(f"#{i}: {json.dumps(dong, ensure_ascii=False)}")
            d.press("back"); time.sleep(2)
        d.swipe(0.5, 0.85, 0.5, 0.15, random.uniform(0.15, 0.3))
        time.sleep(random.uniform(2.5, 3.5))
    print()
    log("══ TONG KET NGUON GOC ══")
    for r in bang:
        goc = "Original" in r["nhan_o"]
        print(f"  {'[co nhan Original]' if goc else '[KHONG co nhan]   '} slug={r['slug'][:40]:40s} "
              f"ten={r['ten'][:30]!r} nguoi_tao={r['nguoi_tao'][:20]!r} nhan_o={r['nhan_o'][:4]}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    serial = sys.argv[1]
    if "--origin" in sys.argv:
        # python probe_screen.py <serial> --origin <so_video>
        # May phai dang o For You.
        n = int(sys.argv[sys.argv.index("--origin") + 1])
        d = connect(serial)
        do_nguon_goc(d, serial, n)
        return
    if "--view" in sys.argv:
        # python probe_screen.py <serial> --view <link1> [<link2> ...]
        links = sys.argv[sys.argv.index("--view") + 1:]
        d = connect(serial)
        log(f"Ket noi: {d.serial}  | app dang mo: {d.app_current().get('package', '?')}")
        ket = []
        for lk in links:
            try:
                ket.append(do_pha_xem(d, serial, lk))
            except Exception as e:
                log(f"do pha xem loi: {str(e)[:160]}")
        print()
        log("══ TONG KET PHA XEM ══")
        for k in ket:
            print("  " + json.dumps(k, ensure_ascii=False))
        return
    n = 5
    if "--n" in sys.argv:
        n = int(sys.argv[sys.argv.index("--n") + 1])

    # Cung mot adb server voi ca app — tu 2026-09-16 khong ai tu suy cong nua, xem
    # scan_feed_sounds.py. Khong dat bien o day de no thua huong dung thu app dung.
    adb_port = os.environ.get("ANDROID_ADB_SERVER_PORT", "5037")
    log(f"ADB server cong {adb_port}")
    if ":" in serial and serial not in list_devices():
        log(f"{serial} chua co tren server {adb_port} -> dang connect...")
        try:
            adb("connect", serial, timeout=10)
        except Exception as e:
            log(f"adb connect loi: {str(e)[:80]} (van thu tiep)")

    d = connect(serial)
    log(f"Ket noi: {d.serial}")
    log(f"App dang mo: {d.app_current().get('package', '?')}")
    log(f"Se do {n} mau, vuot sang video ke giua cac mau.")

    ket = []
    for i in range(1, n + 1):
        try:
            ket.append(do_mot_mau(d, serial, i))
        except Exception as e:
            log(f"mau #{i} loi: {str(e)[:120]}")
        if "--profile" in sys.argv:
            try:
                do_trang_ca_nhan(d, serial, i)
            except Exception as e:
                log(f"do trang ca nhan #{i} loi: {str(e)[:120]}")
        if i < n:
            d.swipe(0.5, 0.85, 0.5, 0.15, random.uniform(0.15, 0.3))
            time.sleep(random.uniform(2.5, 4))

    # ── TONG KET: cai ma nguoi doc that su can ──
    print()
    log("══ TONG KET ══")
    co_icon = sum(1 for k in ket if k["icon"])
    co_handle = sum(1 for k in ket if k["handle"])
    log(f"icon sound `videomusiccoverblock`: thay o {co_icon}/{len(ket)} mau")
    log(f"doc duoc @handle:                  {co_handle}/{len(ket)} mau")
    if ket:
        # Id co mat o MOI mau = khung co dinh cua feed. Icon sound that (neu ten da doi) nam
        # trong day chu khong nam trong dam id chi hien mot lan.
        chung = set.intersection(*[k["ids"] for k in ket])
        log(f"{len(chung)} resource-id co mat o CA {len(ket)} mau (khung co dinh cua feed):")
        for key in sorted(chung):
            print(f"      {key}")
    if co_handle == 0:
        log("=> Khong doc duoc @handle o mau nao: askproto.cjs se tra follow=0 like=0 visit=0 cho")
        log("   MOI video. Do la ly do khong co cu bam nao, va no im lang hoan toan.")
    if co_icon == 0:
        log("=> Khong thay icon sound o mau nao: check_current_video() se bo qua moi video.")
        log("   Tim trong bang id o tren xem TikTok da doi ten thanh gi.")


if __name__ == "__main__":
    main()
