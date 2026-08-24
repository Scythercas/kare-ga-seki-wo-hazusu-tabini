# -*- coding: utf-8 -*-
"""立ち絵の白背景を透過にし、彼女の立ち絵と同じ位置・大きさに揃える。

  python chara_cutout.py <入力png...> [-o 出力先] [--hole x,y] [--list-islands] [--no-align] [--scale 1.05]

白背景で生成した立ち絵（768x1152 前提）から、画像の外周とつながっている白を透過にする。
外周から追える白だけを対象にするので、白いインナーやシャツは消えない。

腕と胴の間のような「外周とつながっていない背景」は自動では消えない。白い服と区別が
つかないため。--list-islands で候補を一覧し、背景であるものを --hole x,y で指定する。

そのあと、彼女の立ち絵（girlfriend/normal.png）の実測値に合わせて人物の大きさと位置を
揃える。rembg などの追加インストールは不要。"""
import os, sys, glob
from collections import deque
from PIL import Image
sys.stdout.reconfigure(encoding='utf-8')

# 彼女の立ち絵の実測値。友人はここに揃える（docs/立ち絵生成仕様_友人.md 参照）
CANVAS      = (768, 1152)
HEAD_TOP_Y  = 35    # 頭頂の位置（上端から）
BODY_HEIGHT = 1117  # 頭頂から画像下辺まで
CENTER_X    = 416   # 人物の中心x
WHITE_TOL   = 26    # これ以内に白へ近い画素を背景の候補とみなす
EDGE_SOFT   = 200   # 境界をなだらかにする閾値（明るいほど薄く抜く）
MIN_ISLAND  = 30    # これ未満の白い島は報告しない


def _near_white_mask(im):
    w, h = im.size
    px = im.load()
    near = bytearray(w * h)
    for y in range(h):
        r = y * w
        for x in range(w):
            c = px[x, y]
            if c[0] >= 255 - WHITE_TOL and c[1] >= 255 - WHITE_TOL and c[2] >= 255 - WHITE_TOL:
                near[r + x] = 1
    return near


def _flood(near, w, h, seeds):
    """seeds から4近傍に white を辿り、到達した画素のマスクを返す。"""
    got = bytearray(w * h)
    q = deque()
    for x, y in seeds:
        i = y * w + x
        if near[i] and not got[i]:
            got[i] = 1
            q.append((x, y))
    while q:
        x, y = q.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h:
                j = ny * w + nx
                if near[j] and not got[j]:
                    got[j] = 1
                    q.append((nx, ny))
    return got


def _border_seeds(w, h):
    return ([(x, 0) for x in range(w)] + [(x, h - 1) for x in range(w)] +
            [(0, y) for y in range(h)] + [(w - 1, y) for y in range(h)])


def _islands(near, bg, w, h):
    """背景に含まれなかった白の連結領域を列挙する。"""
    seen = bytearray(bg)
    out = []
    for y0 in range(h):
        for x0 in range(w):
            i = y0 * w + x0
            if near[i] and not seen[i]:
                seen[i] = 1
                q = deque([(x0, y0)])
                pts = []
                while q:
                    x, y = q.popleft()
                    pts.append((x, y))
                    for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                        if 0 <= nx < w and 0 <= ny < h:
                            j = ny * w + nx
                            if near[j] and not seen[j]:
                                seen[j] = 1
                                q.append((nx, ny))
                if len(pts) >= MIN_ISLAND:
                    xs = [p[0] for p in pts]
                    ys = [p[1] for p in pts]
                    out.append({'area': len(pts), 'seed': pts[len(pts) // 2],
                                'bbox': (min(xs), min(ys), max(xs), max(ys))})
    out.sort(key=lambda d: -d['area'])
    return out


def cut(im, holes=()):
    """外周からつながっている白と、holes で指定した白の島を透過にした RGBA を返す。"""
    im = im.convert('RGB')
    w, h = im.size
    px = im.load()
    near = _near_white_mask(im)

    seeds = _border_seeds(w, h)
    for x, y in holes:
        if not (0 <= x < w and 0 <= y < h):
            raise SystemExit('--hole %d,%d が画像の外です' % (x, y))
        if not near[y * w + x]:
            raise SystemExit('--hole %d,%d は白い画素ではありません' % (x, y))
        seeds.append((x, y))
    bg = _flood(near, w, h, seeds)

    # 背景に接している画素は、明るさに応じて半透明にする（線画のギザつき対策）
    alpha = Image.new('L', (w, h), 255)
    ap = alpha.load()
    for y in range(h):
        row = y * w
        for x in range(w):
            if bg[row + x]:
                ap[x, y] = 0
                continue
            if ((x and bg[row + x - 1]) or (x < w - 1 and bg[row + x + 1]) or
                    (y and bg[row - w + x]) or (y < h - 1 and bg[row + w + x])):
                r, g, b = px[x, y]
                lum = (r * 299 + g * 587 + b * 114) // 1000
                if lum > EDGE_SOFT:
                    ap[x, y] = int(255 * (255 - lum) / (255 - EDGE_SOFT))

    out = im.convert('RGBA')
    out.putalpha(alpha)
    return out, _islands(near, bg, w, h)


def align(im, scale=1.0):
    """人物を彼女と同じ位置・大きさ（scale倍）に置き直す。"""
    bbox = im.getchannel('A').getbbox()
    if not bbox:
        return im
    x0, y0, x1, y1 = bbox
    cur_h = im.height - y0                      # 頭頂〜画像下辺
    factor = (BODY_HEIGHT * scale) / cur_h
    print('  倍率 x%.3f' % factor)
    new = im.resize((round(im.width * factor), round(im.height * factor)), Image.LANCZOS)
    ny0 = y0 * factor
    ncx = ((x0 + x1) / 2) * factor
    canvas = Image.new('RGBA', CANVAS, (0, 0, 0, 0))
    canvas.paste(new, (round(CENTER_X - ncx), round(HEAD_TOP_Y - ny0)), new)
    return canvas


def report(im, label):
    x0, y0, x1, y1 = im.getchannel('A').getbbox()
    print('  %s: 頭頂y=%d 人物高=%d 幅=%d 中心x=%d' % (label, y0, im.height - y0, x1 - x0, (x0 + x1) // 2))


if __name__ == '__main__':
    args = sys.argv[1:]
    outdir, do_align, scale, holes, list_only = None, True, 1.05, [], False
    files = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '-o':
            i += 1; outdir = args[i]
        elif a == '--no-align':
            do_align = False
        elif a == '--scale':
            i += 1; scale = float(args[i])
        elif a == '--hole':
            i += 1; holes.append(tuple(int(v) for v in args[i].split(',')))
        elif a == '--list-islands':
            list_only = True
        else:
            # PowerShell はワイルドカードを展開しないので、ここで展開する
            files.extend(sorted(glob.glob(a)) or [a])
        i += 1
    if not files:
        print(__doc__); sys.exit(1)

    for f in files:
        name = os.path.basename(f)
        im, islands = cut(Image.open(f), () if list_only else holes)
        if list_only:
            print('## %s  外周とつながっていない白の島（面積%d以上）' % (name, MIN_ISLAND))
            for d in islands:
                print('   面積%6d  bbox=%s  背景ならこう指定 → --hole %d,%d'
                      % (d['area'], d['bbox'], d['seed'][0], d['seed'][1]))
            continue
        report(im, name + ' 抜き取り後')
        big = [d for d in islands if d['area'] >= 100]
        if big:
            print('  ※ 白い島が%d個残っている（服なら問題なし。背景なら --hole を足す）' % len(big))
            for d in big:
                print('     面積%6d  bbox=%s  → --hole %d,%d' % (d['area'], d['bbox'], d['seed'][0], d['seed'][1]))
        if do_align:
            im = align(im, scale)
            report(im, name + ' 位置合わせ後')
        dst = os.path.join(outdir or os.path.dirname(f) or '.', name)
        os.makedirs(os.path.dirname(dst) or '.', exist_ok=True)
        im.save(dst)
        print('  -> %s' % dst)
