# -*- coding: utf-8 -*-
"""配信用の素材を生成する（設計書.md 8.6）。
  画像 … PNG/JPEG → WebP
  BGM  … MP3 → AAC(.m4a)。iOS Safari を含め全ブラウザで再生できる形式にする
原本はそのまま残し、アプリは生成物のほうを読む。素材を追加・差し替えたら再実行すること。"""
import os, subprocess, sys
from PIL import Image
sys.stdout.reconfigure(encoding='utf-8')

BGM_DIR = 'public/assets/bgm'
BGM_BITRATE = '96k'   # ピアノ主体のため、これ以上落とすと粗さが出やすい

SE_DIR = 'public/assets/se'
# 効果音は WAV（モノラル22.05kHz）にする。0.2秒程度のUI音にAAC/MP3の
# エンコード前詰め（数十ms の無音）が乗ると、押した瞬間の反応が鈍って感じられるため。
# 長さが短いのでWAVでも1本10KB前後にしかならない。
SE_RATE = '22050'

# (フォルダ, 高さ上限, 品質, 透過を保持するか)
TARGETS = [
    ('public/assets/chara', 1152, 90, True),   # 立ち絵：透過必須
    ('public/assets/bg',    1080, 82, False),  # 背景：不透明。RGBで保存したほうが軽い
]
SRC_EXT = ('.png', '.jpg', '.jpeg')

total_src = total_out = 0
for root, max_h, quality, keep_alpha in TARGETS:
    if not os.path.isdir(root):
        print(f'(スキップ) {root} がありません')
        continue
    for dirpath, _, files in os.walk(root):
        for name in sorted(files):
            if not name.lower().endswith(SRC_EXT):
                continue
            src = os.path.join(dirpath, name)
            dst = os.path.splitext(src)[0] + '.webp'
            if os.path.basename(dst) == os.path.basename(src):
                continue
            im = Image.open(src).convert('RGBA' if keep_alpha else 'RGB')
            if im.height > max_h:
                im = im.resize((round(im.width * max_h / im.height), max_h), Image.LANCZOS)
            im.save(dst, 'WEBP', quality=quality, method=6)
            s, o = os.path.getsize(src), os.path.getsize(dst)
            total_src += s; total_out += o
            print('%-46s %6.0fKB → %6.0fKB (%.0f%%)' % (os.path.relpath(dst), s/1024, o/1024, o/s*100))

# ---- BGM（MP3 → AAC/m4a）----
def ffmpeg_exe():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        from shutil import which
        return which('ffmpeg')

if os.path.isdir(BGM_DIR):
    ff = ffmpeg_exe()
    if not ff:
        print('(スキップ) ffmpeg がありません。pip install imageio-ffmpeg')
    else:
        for name in sorted(os.listdir(BGM_DIR)):
            if not name.lower().endswith('.mp3'):
                continue
            src = os.path.join(BGM_DIR, name)
            dst = os.path.splitext(src)[0] + '.m4a'
            subprocess.run([ff, '-y', '-loglevel', 'error', '-i', src,
                            '-c:a', 'aac', '-b:a', BGM_BITRATE, '-ac', '2',
                            '-movflags', '+faststart', dst], check=True)
            s_, o_ = os.path.getsize(src), os.path.getsize(dst)
            total_src += s_; total_out += o_
            print('%-46s %6.0fKB → %6.0fKB (%.0f%%)' % (os.path.relpath(dst), s_/1024, o_/1024, o_/s_*100))

# ---- 効果音（MP3 → 末尾の無音を落としたモノラルWAV）----
if os.path.isdir(SE_DIR):
    ff = ffmpeg_exe()
    if not ff:
        print('(スキップ) ffmpeg がありません')
    else:
        for name in sorted(os.listdir(SE_DIR)):
            if not name.lower().endswith('.mp3'):
                continue
            src = os.path.join(SE_DIR, name)
            dst = os.path.splitext(src)[0] + '.wav'
            # 素材には1秒前後の無音が付いているので削る（前後とも）
            subprocess.run([ff, '-y', '-loglevel', 'error', '-i', src,
                            '-af', 'silenceremove=start_periods=1:start_threshold=-50dB:'
                                   'detection=peak,areverse,'
                                   'silenceremove=start_periods=1:start_threshold=-50dB:'
                                   'detection=peak,areverse',
                            '-ac', '1', '-ar', SE_RATE, '-c:a', 'pcm_s16le', dst], check=True)
            s_, o_ = os.path.getsize(src), os.path.getsize(dst)
            total_src += s_; total_out += o_
            print('%-46s %6.0fKB → %6.0fKB (%.0f%%)' % (os.path.relpath(dst), s_/1024, o_/1024, o_/s_*100))

if total_src:
    print('-' * 60)
    print('合計 %.2fMB → %.2fMB' % (total_src/1024/1024, total_out/1024/1024))
    print('配信サイズ上限 10MB に対して %.0f%%' % (total_out/1024/1024/10*100))
