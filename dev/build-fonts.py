#!/usr/bin/env python3
"""fonts/*.woff2 を作る（サブセット化）。再現手順:

  python3 dev/build-fonts.py                  # npm から取得（要ネット・npm・fonttools・brotli）
  python3 dev/build-fonts.py --src DIR        # 取得済みの @expo-google-fonts 展開ディレクトリを使う

元フォント: @expo-google-fonts/{dela-gothic-one,zen-kaku-gothic-new,archivo,dm-mono}（いずれも SIL OFL 1.1）。
日本語2書体（Dela Gothic One / Zen Kaku Gothic New 700）には
  ASCII・全角ASCII・ひらがな・カタカナ・約物・JIS X 0208 第1水準漢字、
  それに js/ と index.html に現れる全文字 を入れる。
  --no-dela-kanji を付けると Dela から第1水準漢字を外す（容量が大きすぎるとき。かな・UI文字だけ残す）。
Archivo 900 / DM Mono 500 は ASCII + Latin-1 + 句読点のみ。
"""
import argparse, glob, os, re, shutil, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'fonts')

PKGS = {  # out name: (npm package, version, ttf relative path inside package/, license heading)
    'dela-gothic-one': ('dela-gothic-one', '0.4.1', '400Regular/DelaGothicOne_400Regular.ttf'),
    'zen-kaku-gothic-new': ('zen-kaku-gothic-new', '0.4.1', '700Bold/ZenKakuGothicNew_700Bold.ttf'),
    'archivo': ('archivo', '0.4.2', '900Black/Archivo_900Black.ttf'),
    'dm-mono': ('dm-mono', '0.4.2', '500Medium/DMMono_500Medium.ttf'),
}
JOBS = [  # (pkg key, output file, charset kind)
    ('dela-gothic-one', 'dela-gothic-one.woff2', 'jp-display'),
    ('zen-kaku-gothic-new', 'zen-kaku-gothic-new-700.woff2', 'jp-body'),
    ('archivo', 'archivo-900.woff2', 'latin'),
    ('dm-mono', 'dm-mono-500.woff2', 'latin'),
]


def jis_level1_kanji():
    """JIS X 0208 第1水準（区16〜47）"""
    out = []
    for row in range(16, 48):
        for cell in range(1, 95):
            b = bytes([0xA0 + row, 0xA0 + cell])
            try:
                out.append(b.decode('euc_jp'))
            except UnicodeDecodeError:
                pass
    return out


def rng(a, b):
    return [chr(c) for c in range(a, b + 1)]


def ui_chars():
    """js/*.js と index.html に現れる非ASCII文字（動的テキストの取りこぼし防止）"""
    s = set()
    for pat in ('js/*.js', 'index.html', 'css/*.css'):
        for f in glob.glob(os.path.join(ROOT, pat)):
            s |= set(open(f, encoding='utf-8').read())
    return {c for c in s if c >= ' ' and c not in '​﻿'}


def charset(kind):
    cs = set(rng(0x20, 0x7E))
    if kind == 'latin':
        cs |= set(rng(0xA0, 0xFF)) | set('–—‘’“”•…·×←→↗↻✓°′″‐‑−')
        return cs
    cs |= set(rng(0xFF01, 0xFF5E))            # 全角ASCII
    cs |= set(rng(0x3000, 0x303F))            # 約物（、。〈〉「」・など）
    cs |= set(rng(0x3041, 0x3096)) | set(rng(0x3099, 0x309F))  # ひらがな
    cs |= set(rng(0x30A0, 0x30FF))            # カタカナ・ー・
    cs |= set('～〜…‥・・※→←↑↓↗↻✓×○●◎△▲▽▼□■◇◆★☆♪♥♡￥￠￡')
    cs |= set(rng(0xFF61, 0xFF9F))            # 半角カナ
    cs |= set('–—‘’“”•·°′″‐')
    cs |= ui_chars()
    if kind == 'jp-body' or not ARGS.no_dela_kanji:
        cs |= set(jis_level1_kanji())
    return cs


def fetch(srcdir):
    """npm pack で取得して展開。戻り値: {key: package ディレクトリ}"""
    res = {}
    tmp = tempfile.mkdtemp(prefix='gacha-fonts-')
    for key, (pkg, ver, _) in PKGS.items():
        if srcdir:
            cands = glob.glob(os.path.join(srcdir, f'expo-google-fonts-{pkg}-*', 'package')) + \
                    glob.glob(os.path.join(srcdir, key, 'package')) + glob.glob(os.path.join(srcdir, pkg))
            if not cands:
                sys.exit(f'--src に {pkg} が見つかりません: {srcdir}')
            res[key] = cands[0]
            continue
        subprocess.check_call(['npm', 'pack', f'@expo-google-fonts/{pkg}@{ver}', '--silent'], cwd=tmp)
        tgz = glob.glob(os.path.join(tmp, f'expo-google-fonts-{pkg}-*.tgz'))[0]
        d = os.path.join(tmp, key)
        os.makedirs(d, exist_ok=True)
        subprocess.check_call(['tar', 'xzf', tgz, '-C', d])
        res[key] = os.path.join(d, 'package')
    return res


def main():
    os.makedirs(OUT, exist_ok=True)
    pk = fetch(ARGS.src)
    total = 0
    for key, out, kind in JOBS:
        ttf = os.path.join(pk[key], PKGS[key][2])
        cs = ''.join(sorted(charset(kind)))
        tf = tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False, encoding='utf-8')
        tf.write(cs); tf.close()
        dst = os.path.join(OUT, out)
        subprocess.check_call(['pyftsubset', ttf, f'--text-file={tf.name}', '--flavor=woff2', '--layout-features=*',
                               '--no-hinting', '--desubroutinize', f'--output-file={dst}'])
        os.unlink(tf.name)
        size = os.path.getsize(dst)
        total += size
        print(f'{out:36s} {len(cs):5d} chars {size:8d} bytes')
        lic = os.path.join(pk[key], 'LICENSE_FONT')
        if os.path.exists(lic):
            shutil.copy(lic, os.path.join(OUT, f'OFL-{key}.txt'))
    print('total', total, 'bytes')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', help='@expo-google-fonts 展開済みディレクトリ（省略時は npm pack で取得）')
    ap.add_argument('--no-dela-kanji', action='store_true', help='Dela Gothic One から第1水準漢字を外す')
    ARGS = ap.parse_args()
    main()
