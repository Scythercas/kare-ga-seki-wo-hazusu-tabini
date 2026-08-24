# -*- coding: utf-8 -*-
"""scenes.json / recordings.json の整合性チェック。
設計書.md 5.3（到達分布）/ 5.4（Scene8ボイスとエンドの整合）/ 4.1（条件付き行）を機械的に検証する。
閾値を変えたら再実行して分布を確認すること。"""
import json, io, itertools, sys
sys.stdout.reconfigure(encoding='utf-8')

# 設計書.md 5.2 の暫定値。config.js を変えたらここも合わせる
C = {'WARNING_THRESHOLD': 3, 'AFFECTION_LOW': 2, 'AFFECTION_HIGH': 4}

d = json.load(io.open('scenes.json', encoding='utf-8'))
scenes = {s['id']: s for s in d['scenes']}
ok = True

def lines(s): return s.get('text', []) + s.get('after', [])

def ev(c, v, ch):
    if 'choice' in c: return ch.get(c['choice']) == c['equals']
    val = C[c['value']] if isinstance(c['value'], str) else c['value']
    x, op = v[c['var']], c['op']
    return {'>=': x >= val, '<': x < val, '>': x > val, '<=': x <= val}[op]

def check(label, cond, detail=''):
    global ok
    print(('  OK   ' if cond else '  FAIL ') + label + ('' if cond else '  ' + detail))
    if not cond: ok = False

print('== recordings.json との突き合わせ ==')
r = json.load(io.open('recordings.json', encoding='utf-8'))['recordings']
in_scene = {}
for s in d['scenes']:
    for l in lines(s):
        if 'voiceId' in l:
            in_scene[l['voiceId']] = (l['body'], l['speaker'], s['id'])
diffs = []
for rec in r:
    src = in_scene.get(rec['voiceId'])
    if not src:
        diffs.append(rec['voiceId'] + ': scenes.json に存在しない'); continue
    if src[0] != rec['scriptText']: diffs.append(rec['voiceId'] + ': scriptText が本文と不一致')
    if src[1] != rec['speakerRole']: diffs.append(rec['voiceId'] + ': speakerRole が不一致')
    if src[2] != rec['sceneRef']:   diffs.append(rec['voiceId'] + ': sceneRef が不一致')
check('10本のセリフ・話者・シーンが scenes.json と一致', not diffs, '; '.join(diffs))
order = sorted(x['recordingOrder'] for x in r)
check('recordingOrder が 1〜10 で重複なし', order == list(range(1, 11)), str(order))
roles = [x['speakerRole'] for x in sorted(r, key=lambda x: x['recordingOrder'])]
switches = sum(1 for i in range(1, len(roles)) if roles[i] != roles[i - 1])
check('端末の持ち替えが1回だけ（話者ごとにまとまっている）', switches == 1, '実際: %d回' % switches)

print('== 台本.md との突き合わせ ==')
# 台本.md（読み物としての原本）と scenes.json（実データ）が食い違うと、
# 収録するセリフと画面に出るセリフがズレる。ボイス行だけは機械的に照合する。
script = io.open('台本.md', encoding='utf-8').read()
drift = []
for rec in r:
    body = in_scene[rec['voiceId']][0]
    if body not in script:
        drift.append('%s: 台本.md に同じ本文が見つからない' % rec['voiceId'])
check('ボイス10本の本文が 台本.md と一致', not drift, '; '.join(drift))

print('== 静的チェック ==')
vs = [l['voiceId'] for s in d['scenes'] for l in lines(s) if 'voiceId' in l]
check('voice_01〜10 が各1回だけ登場', sorted(vs) == ['voice_%02d' % i for i in range(1, 11)], str(sorted(vs)))
nconds = sum(1 for s in d['scenes'] for l in lines(s) if 'condition' in l)
check('条件付き行が9つ（設計書 4.1）', nconds == 9, '実際: %d' % nconds)
bad = [b['to'] for s in d['scenes'] for b in (s['next'] if isinstance(s.get('next'), list) else
       [{'to': s['next']}] if isinstance(s.get('next'), str) else []) if b['to'] not in scenes]
check('next の遷移先がすべて実在', not bad, str(bad))
check('末端がエンディングのみ', all(s.get('isEnding') for s in d['scenes'] if 'next' not in s))

print('== 全ルート走査 ==')
keys = [s['choice']['id'] for s in d['scenes'] if 'choice' in s]
opts = [[o['key'] for o in s['choice']['options']] for s in d['scenes'] if 'choice' in s]
tally, nv_range, mismatch = {}, [], 0
for combo in itertools.product(*opts):
    ch = dict(zip(keys, combo)); v = {'affection': 0, 'warning': 0}
    cur, nv, v6 = 'scene_01', 0, False
    while True:
        s = scenes[cur]
        for l in s.get('text', []):
            if 'condition' in l and not ev(l['condition'], v, ch): continue
            if 'voiceId' in l: nv += 1
        if 'choice' in s:
            o = next(o for o in s['choice']['options'] if o['key'] == ch[s['choice']['id']])
            for k, x in o['effect'].items(): v[k] += x
        for l in s.get('after', []):
            if 'condition' in l and not ev(l['condition'], v, ch): continue
            if 'voiceId' in l:
                nv += 1
                if l['voiceId'] == 'voice_06': v6 = True
        n = s.get('next')
        if n is None: break
        cur = n if isinstance(n, str) else next(b['to'] for b in n if 'condition' not in b or ev(b['condition'], v, ch))
    tally[cur] = tally.get(cur, 0) + 1; nv_range.append(nv)
    if v6 != (cur == 'ending_bare'): mismatch += 1

total = sum(tally.values())
check('総ルート数が192', total == 192, '実際: %d' % total)
check('5.4整合：voice_06 の再生とバレエンドが常に一致', mismatch == 0, '不一致 %d 件' % mismatch)
check('1周のボイス再生が4〜6本', (min(nv_range), max(nv_range)) == (4, 6), str((min(nv_range), max(nv_range))))
expect = {'ending_bare': 28, 'ending_none': 75, 'ending_reject': 56, 'ending_success': 33}
for k, n in expect.items():
    check('%-15s %3d ルート (%.1f%%)' % (k, tally.get(k, 0), tally.get(k, 0) / total * 100), tally.get(k) == n, '期待 %d' % n)

print('\n' + ('すべて OK' if ok else '不整合あり'))
sys.exit(0 if ok else 1)
