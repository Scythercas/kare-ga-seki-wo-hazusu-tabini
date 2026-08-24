# -*- coding: utf-8 -*-
"""scenes.yaml（原本）→ scenes.json（アプリが読む実データ）へ変換する。

セリフは scenes.yaml のほうを編集すること。scenes.json は生成物なので直接触らない。

    python build_scenes.py && python validate_scenes.py

YAMLの書きかたは docs/シーンYAMLの書きかた.md を参照。
"""
import io, json, re, sys
import yaml

sys.stdout.reconfigure(encoding='utf-8')

SRC, DST = 'scenes.yaml', 'scenes.json'

# 日本語キー → 内部名
SPEAKERS = {'地の文': 'narration', '彼女': 'girlfriend', '友人': 'friend',
            'narration': 'narration', 'girlfriend': 'girlfriend', 'friend': 'friend'}
VARS = {'好感度': 'affection', '警戒度': 'warning',
        'affection': 'affection', 'warning': 'warning'}
ALIAS = {'声': 'voice', '表情': 'face', '背景': 'bg', 'BGM': 'bgm', '条件': 'if',
         '見出し': 'title', '本文': 'text', '選択後': 'after', '次': 'next',
         '行き先': 'to', '選択肢': 'choice', 'エンディング': 'ending', '効果音': 'se'}


def norm(d):
    """日本語キーを内部キーに寄せる"""
    return {ALIAS.get(k, k): v for k, v in d.items()}


def parse_condition(expr):
    """'choice_03 == A' / 'warning >= WARNING_THRESHOLD' を条件オブジェクトに変換"""
    if expr is None:
        return None
    if isinstance(expr, dict):
        return expr  # 生のまま書かれていればそのまま通す

    m = re.match(r'^\s*(\S+)\s*(==|!=|>=|<=|>|<)\s*(\S+)\s*$', str(expr))
    if not m:
        raise ValueError(f'条件を解釈できません: {expr!r}')
    lhs, op, rhs = m.groups()

    if lhs.startswith('choice_'):
        if op != '==':
            raise ValueError(f'選択肢の条件は == のみ使えます: {expr!r}')
        return {'choice': lhs, 'equals': rhs}

    var = VARS.get(lhs)
    if not var:
        raise ValueError(f'未知の変数です: {lhs!r}（好感度／警戒度）')
    value = int(rhs) if re.fullmatch(r'-?\d+', rhs) else rhs  # 数値でなければ定数名
    return {'var': var, 'op': op, 'value': value}


def parse_face(face, speaker):
    """表情指定。文字列なら話者に適用、マッピングならそのまま（日本語キーは変換）"""
    if face is None:
        return None
    if isinstance(face, dict):
        return {SPEAKERS.get(k, k): v for k, v in face.items()}
    if speaker in ('girlfriend', 'friend'):
        return {speaker: face}
    raise ValueError(f'地の文の表情はキャラ名を明示してください: {face!r}')


def parse_line(item):
    """1行分を JSON スキーマの形に展開する"""
    # 素の文字列は地の文
    if isinstance(item, str):
        return {'speaker': 'narration', 'body': item}

    d = norm(item)
    speaker = body = None
    for key, val in list(d.items()):
        if key in SPEAKERS:
            speaker, body = SPEAKERS[key], val
            d.pop(key)
            break
    if speaker is None:
        raise ValueError(f'話者が見つかりません: {item!r}')

    out = {'speaker': speaker, 'body': body}
    if 'voice' in d:
        out['voiceId'] = d.pop('voice')
    if 'bg' in d:
        out['bg'] = d.pop('bg')
    if 'bgm' in d:
        out['bgm'] = d.pop('bgm')       # None は「停止」
    face = parse_face(d.pop('face', None) or d.pop('sprite', None), speaker)
    if face is not None:
        out['sprite'] = face
    if 'if' in d:
        out['condition'] = parse_condition(d.pop('if'))
    if d:
        raise ValueError(f'未知のキーがあります: {list(d)}（行: {body!r}）')
    return out


def parse_choice(c):
    d = norm(c)
    options = []
    for raw in d.get('options') or d.get('choice') or []:
        o = norm(raw)
        key = label = None
        for k in list(o):
            if re.fullmatch(r'[A-Z]', str(k)):
                key, label = k, o.pop(k)
                break
        if key is None:
            raise ValueError(f'選択肢キー（A/B/C）がありません: {raw!r}')

        effect = {}
        for k in list(o):
            if k in VARS:
                effect[VARS[k]] = o.pop(k)
        if o:
            raise ValueError(f'選択肢に未知のキー: {list(o)}')
        options.append({'key': key, 'label': label, 'effect': effect})

    out = {'id': d['id'], 'options': options}
    if d.get('se'):
        out['se'] = d['se']
    return out


def parse_next(n):
    if n is None or isinstance(n, str):
        return n
    branches = []
    for raw in n:
        b = norm(raw)
        out = {}
        if b.get('if') is not None:
            out['condition'] = parse_condition(b['if'])
        out['to'] = b['to']
        branches.append(out)
    return branches


def parse_scene(s):
    d = norm(s)
    out = {'id': d['id'], 'title': d.get('title', '')}
    if d.get('ending'):
        out['isEnding'] = True

    stage = {}
    if 'bg' in d:
        stage['bg'] = d['bg']
    if 'bgm' in d:
        stage['bgm'] = d['bgm']
    if stage:
        out['stage'] = stage

    out['text'] = [parse_line(x) for x in (d.get('text') or [])]
    if d.get('choice'):
        out['choice'] = parse_choice(d['choice'])
    if d.get('after'):
        out['after'] = [parse_line(x) for x in d['after']]
    if d.get('next') is not None:
        out['next'] = parse_next(d['next'])
    return out


def main():
    src = yaml.safe_load(io.open(SRC, encoding='utf-8'))
    data = {'meta': src.get('meta', {}), 'scenes': []}
    data['meta']['generated'] = f'{SRC} から build_scenes.py が生成。直接編集しないこと。'

    for s in src['scenes']:
        try:
            data['scenes'].append(parse_scene(s))
        except Exception as e:
            print(f'FAIL  シーン {s.get("id", "?")}: {e}')
            return 1

    io.open(DST, 'w', encoding='utf-8').write(
        json.dumps(data, ensure_ascii=False, indent=2) + '\n')

    lines = sum(len(s.get('text', [])) + len(s.get('after', [])) for s in data['scenes'])
    voices = sum(1 for s in data['scenes'] for l in s.get('text', []) + s.get('after', []) if 'voiceId' in l)
    print(f'{SRC} → {DST}')
    print(f'  シーン {len(data["scenes"])} / 行 {lines} / ボイス {voices}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
