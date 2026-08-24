// シーン進行エンジン（設計書.md 4.1 / 4.3 / 5.2）
//
// scenes.json を読み、条件付き行のフィルタと分岐の解決を行う。
// エンディング判定は scene_08 の next（条件配列）に含まれているため、
// ここに if/elif を書かない＝5.4節の「閾値をひとつの定数に統一する」が構造的に守られる。

export class Engine {
  constructor(scenesData, config) {
    this.scenes = {};
    for (const s of scenesData.scenes) this.scenes[s.id] = s;
    this.constants = config;
    this.reset();
  }

  // 周回時に呼ぶ（設計書.md 4.3）。録音と名前はここでは触らない。
  reset() {
    this.vars = { ...this.constants.INITIAL_VARS };
    this.choices = {};
    this.stage = { bg: null, bgm: null };
    this.sprites = { friend: null, girlfriend: null };
    this.scene = null;
    this.queue = [];
  }

  begin(startId = 'scene_01') {
    this.reset();
    this._enter(startId);
    return this;
  }

  get isEnding() {
    return !!(this.scene && this.scene.isEnding);
  }

  get sceneId() {
    return this.scene ? this.scene.id : null;
  }

  get sceneTitle() {
    return this.scene ? this.scene.title : '';
  }

  /* ---------- 進行 ---------- */

  // 次に表示するものを返す：
  //   { type: 'line',   speaker, body, voiceId }
  //   { type: 'choice', id, options, se }
  //   { type: 'end' }   … エンディングの最終行まで進み終えた
  next() {
    for (;;) {
      if (!this.queue.length) return { type: 'end' };
      const item = this.queue.shift();

      if (item.type === 'transition') {
        const to = this._resolveNext();
        if (!to) return { type: 'end' };
        this._enter(to);
        continue;
      }

      if (item.type === 'line') {
        this._applyPresentation(item);
        return item;
      }

      return item; // choice
    }
  }

  choose(key) {
    const choice = this.scene && this.scene.choice;
    if (!choice) throw new Error('選択肢のないシーンで choose が呼ばれた: ' + this.sceneId);
    const option = choice.options.find((o) => o.key === key);
    if (!option) throw new Error('未定義の選択肢: ' + key);

    this.choices[choice.id] = key;
    // クランプはしない（設計書.md 4.3）。0で止めると Scene1-B の warning -1 が無効化される
    for (const [k, v] of Object.entries(option.effect || {})) {
      this.vars[k] = (this.vars[k] || 0) + v;
    }

    // after は選択の結果に依存するため、選び終えたこの時点で条件を評価する
    this._queueAfter();
  }

  /* ---------- 内部 ---------- */

  _enter(id) {
    const scene = this.scenes[id];
    if (!scene) throw new Error('未定義のシーン: ' + id);
    this.scene = scene;
    this.queue = [];

    if (scene.stage) {
      if ('bg' in scene.stage) this.stage.bg = scene.stage.bg;
      if ('bgm' in scene.stage) this.stage.bgm = scene.stage.bgm;
    }

    for (const line of scene.text || []) {
      if (this._test(line.condition)) this.queue.push({ type: 'line', ...line });
    }

    if (scene.choice) {
      this.queue.push({ type: 'choice', ...scene.choice });
    } else {
      this._queueAfter();
    }
  }

  _queueAfter() {
    for (const line of this.scene.after || []) {
      if (this._test(line.condition)) this.queue.push({ type: 'line', ...line });
    }
    this.queue.push({ type: 'transition' });
  }

  // 行レベルの bg / bgm / sprite を反映する（設計書.md 4.1）
  _applyPresentation(line) {
    if ('bg' in line) this.stage.bg = line.bg;
    if ('bgm' in line) this.stage.bgm = line.bgm;
    if (line.sprite) {
      for (const [role, value] of Object.entries(line.sprite)) {
        this.sprites[role] = value; // null なら画面から外す
      }
    }
  }

  _resolveNext() {
    const next = this.scene.next;
    if (next == null) return null; // エンディング
    if (typeof next === 'string') return next;
    for (const branch of next) {
      if (!branch.condition || this._test(branch.condition)) return branch.to;
    }
    return null;
  }

  // 条件はボイス専用ではない。ボイスのない地の文にも付く（設計書.md 4.1）
  _test(condition) {
    if (!condition) return true;

    if ('choice' in condition) {
      return this.choices[condition.choice] === condition.equals;
    }

    const actual = this.vars[condition.var];
    const expected = typeof condition.value === 'string'
      ? this.constants[condition.value]   // 定数名で参照する
      : condition.value;
    if (expected === undefined) throw new Error('未定義の定数: ' + condition.value);

    switch (condition.op) {
      case '>=': return actual >= expected;
      case '>':  return actual >  expected;
      case '<=': return actual <= expected;
      case '<':  return actual <  expected;
      case '==': return actual === expected;
      default: throw new Error('未知の演算子: ' + condition.op);
    }
  }
}
