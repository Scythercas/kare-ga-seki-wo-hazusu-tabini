// 画面遷移と全体の組み立て（設計書.md 3章 / 6章）
//
// 名前入力 → マイク権限 → 録音（10本・持ち替え1回） → プレイ開始 → 本編 → エンディング → 周回

import { CONFIG, ROLE_LABEL, SPEAKER_LABEL } from './config.js';
import { store, requestPersistence } from './db.js';
import { Recorder, playVoice, stopVoice, unlockAudio, isRecordingSupported, audioContextState,
         playBgm, stopBgm, playSe, preloadSe } from './audio.js';
import { Engine } from './engine.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------- 状態 ---------- */

const app = {
  scenesData: null,
  recMeta: [],        // recordings.json の静的メタ（recordingOrder順）
  state: { friendName: '', recs: {} },
  engine: null,
  recorder: new Recorder(),
  recIndex: 0,        // recMeta 上の現在位置
  lastPlayedRole: null,
  inChoice: false,
  debugOn: false,
  recTimer: null,
};

const blobKeyOf = (voiceId) => 'rec_' + voiceId;
const subst = (text) => String(text || '').replace(/\{\{friendName\}\}/g, app.state.friendName);

function showScreen(id) {
  $$('.screen').forEach((el) => el.classList.toggle('hidden', el.id !== id));
}

async function saveState() {
  await store.putState(app.state);
}

/* ---------- 起動 ---------- */

async function boot() {
  const [scenesData, recData] = await Promise.all([
    fetch(CONFIG.SCENES_URL).then((r) => r.json()),
    fetch(CONFIG.RECORDINGS_URL).then((r) => r.json()),
  ]);

  app.scenesData = scenesData;
  app.recMeta = recData.recordings.slice().sort((a, b) => a.recordingOrder - b.recordingOrder);
  app.engine = new Engine(scenesData, CONFIG);

  const saved = await store.getState();
  if (saved) app.state = { friendName: saved.friendName || '', recs: saved.recs || {} };
  for (const meta of app.recMeta) {
    if (!app.state.recs[meta.voiceId]) app.state.recs[meta.voiceId] = { status: 'unrecorded' };
  }

  // 録音データが失われていないか検証する（設計書.md 8.3）。
  // ストレージ退去などで Blob だけ消えることがあるため、無言で壊れた状態にしない。
  const keys = new Set(await store.blobKeys());
  let lost = 0;
  for (const meta of app.recMeta) {
    const rec = app.state.recs[meta.voiceId];
    if (rec.status !== 'unrecorded' && !keys.has(blobKeyOf(meta.voiceId))) {
      app.state.recs[meta.voiceId] = { status: 'unrecorded' };
      lost++;
    }
  }
  if (lost) await saveState();

  registerServiceWorker();
  route(lost);
}

function allConfirmed() {
  return app.recMeta.every((m) => app.state.recs[m.voiceId].status === 'confirmed');
}

function firstUnconfirmedIndex() {
  const i = app.recMeta.findIndex((m) => app.state.recs[m.voiceId].status !== 'confirmed');
  return i < 0 ? 0 : i;
}

function route(lostCount) {
  if (!app.state.friendName) return showScreen('screen-title');
  if (allConfirmed()) return showScreen('screen-ready');
  app.recIndex = firstUnconfirmedIndex();
  // 中断から再開した場合も、話者が切り替わる位置なら持ち替え画面を挟む
  app.lastPlayedRole = app.recIndex > 0 ? app.recMeta[app.recIndex - 1].speakerRole : null;
  if (lostCount) {
    alert('保存されていた録音の一部が見つかりませんでした。該当分をもう一度録音してください。');
  }
  maybeHandoffThenRecord();
}

/* ---------- タイトル／名前入力 ---------- */

$('#btn-to-mic').addEventListener('click', async () => {
  const input = $('#input-name');
  const name = input.value.trim();
  const err = $('#name-error');

  if (!name) {
    err.textContent = '名前を入力してください。';
    err.classList.remove('hidden');
    return;
  }
  if (name.length > CONFIG.FRIEND_NAME_MAX) {
    err.textContent = `${CONFIG.FRIEND_NAME_MAX}文字以内で入力してください。`;
    err.classList.remove('hidden');
    return;
  }
  err.classList.add('hidden');

  app.state.friendName = name;
  await saveState();
  showScreen('screen-mic');
});

/* ---------- マイク権限 ---------- */

async function requestMic() {
  $('#mic-denied').classList.add('hidden');

  if (!isRecordingSupported()) {
    $('#mic-denied').classList.remove('hidden');
    $('#mic-denied .error').textContent = 'このブラウザは録音に対応していません。';
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...CONFIG.AUDIO_CONSTRAINTS } });
    stream.getTracks().forEach((t) => t.stop()); // 許可の確認だけ。掴んだままにしない
    await requestPersistence();
    preloadSe(['se_rec_start', 'se_rec_stop', 'se_confirm']);
    app.recIndex = firstUnconfirmedIndex();
    app.lastPlayedRole = null;
    maybeHandoffThenRecord();
  } catch (_) {
    $('#mic-denied').classList.remove('hidden');
  }
}

$('#btn-request-mic').addEventListener('click', requestMic);
$('#btn-retry-mic').addEventListener('click', requestMic);

/* ---------- 録音 ---------- */

function currentMeta() {
  return app.recMeta[app.recIndex];
}

function currentRec() {
  return app.state.recs[currentMeta().voiceId];
}

// 話者が切り替わる境目（recordingOrder 6→7）で持ち替え画面を挟む
function maybeHandoffThenRecord() {
  const meta = currentMeta();
  if (app.lastPlayedRole && app.lastPlayedRole !== meta.speakerRole) {
    $('#handoff-role').textContent = ROLE_LABEL[meta.speakerRole];
    showScreen('screen-handoff');
    return;
  }
  showRecord();
}

$('#btn-handoff-next').addEventListener('click', showRecord);

function showRecord() {
  const meta = currentMeta();
  const rec = currentRec();

  $('#rec-role').textContent = ROLE_LABEL[meta.speakerRole];
  $('#rec-progress').textContent = `${meta.recordingOrder} / ${app.recMeta.length}`;
  $('#rec-emotion').textContent = '［' + meta.emotionNote + '］';
  $('#rec-script').textContent = subst(meta.scriptText);
  $('#rec-error').classList.add('hidden');

  setRecordButtons(rec.status === 'confirmed' ? 'recorded' : rec.status);
  $('#rec-status').textContent = rec.status === 'recorded'
    ? '録音しました。聞いてみて、よければ確定してください。'
    : 'ボタンを押して読み上げてください。';
  $('#rec-status').classList.remove('live');

  showScreen('screen-record');
}

// 設計書.md 6.3 のボタン状態表
function setRecordButtons(status) {
  const map = {
    unrecorded: { start: true, stop: false, preview: false, retake: false, confirm: false },
    cue:        { start: false, stop: false, preview: false, retake: false, confirm: false },
    recording:  { start: false, stop: true, preview: false, retake: false, confirm: false },
    recorded:   { start: false, stop: false, preview: true, retake: true, confirm: true },
  };
  const s = map[status] || map.unrecorded;
  $('#btn-rec-start').classList.toggle('hidden', !s.start);
  $('#btn-rec-stop').classList.toggle('hidden', !s.stop);
  $('#btn-rec-preview').classList.toggle('hidden', !s.preview);
  $('#btn-rec-retake').classList.toggle('hidden', !s.retake);
  $('#btn-rec-confirm').classList.toggle('hidden', !s.confirm);
}

async function startRecording() {
  stopVoice();
  stopBgm();
  $('#rec-error').classList.add('hidden');

  // 開始の合図。鳴り終わるまで待ってからマイクを開かないと、
  // ビープ音そのものが録音の頭に入ってしまう
  setRecordButtons('cue');
  $('#rec-status').classList.add('live');
  $('#rec-status').textContent = '合図のあとに読み上げてください…';
  const cue = await playSe('se_rec_start');
  if (cue) await new Promise((r) => setTimeout(r, cue * 1000 + CONFIG.SE_REC_CUE_MARGIN_MS));

  app.recorder.onAutoStop = (result) => finishRecording(result, true);
  try {
    await app.recorder.start();
  } catch (e) {
    $('#rec-error').textContent = '録音を開始できませんでした。マイクの許可を確認してください。';
    $('#rec-error').classList.remove('hidden');
    setRecordButtons('unrecorded');
    $('#rec-status').classList.remove('live');
    return;
  }

  setRecordButtons('recording');
  const tick = () => {
    if (!app.recorder.isRecording) return;
    const sec = Math.floor(app.recorder.elapsedMs / 1000);
    $('#rec-status').textContent = `● 録音中… ${sec}秒 / 最大30秒`;
    app.recTimer = setTimeout(tick, 200);
  };
  tick();
}

async function stopRecording() {
  const result = await app.recorder.stop();
  if (result) finishRecording(result, false);
}

async function finishRecording(result, wasAuto) {
  clearTimeout(app.recTimer);
  playSe('se_rec_stop');
  const meta = currentMeta();

  await store.putBlob(blobKeyOf(meta.voiceId), result.blob);
  app.state.recs[meta.voiceId] = {
    status: 'recorded', // 未確定。確定前は何度でも上書きできる（設計書.md 4.2）
    blobKey: blobKeyOf(meta.voiceId),
    mimeType: result.mimeType,
    durationMs: result.durationMs,
    recordedAt: new Date().toISOString(),
  };
  await saveState();

  setRecordButtons('recorded');
  $('#rec-status').classList.remove('live');
  $('#rec-status').textContent =
    (wasAuto ? '30秒で自動停止しました' : '録音しました') +
    `（${(result.durationMs / 1000).toFixed(1)}秒・${Math.round(result.blob.size / 1024)}KB）。`
    + '聞いてみて、よければ確定してください。';
}

$('#btn-rec-start').addEventListener('click', async () => {
  await unlockAudio();   // 必ずユーザー操作の中で resume まで済ませる
  startRecording();
});
$('#btn-rec-stop').addEventListener('click', stopRecording);

// 録り直す＝「録音する」前の状態に戻すだけ。ここで録音を始めてしまうと、
// 押した瞬間に喋り出す羽目になる（前回の不具合）
$('#btn-rec-retake').addEventListener('click', () => {
  stopVoice();
  clearTimeout(app.recTimer);
  setRecordButtons('unrecorded');
  $('#rec-status').classList.remove('live');
  $('#rec-status').textContent = '準備ができたら「録音する」を押してください。';
  $('#rec-error').classList.add('hidden');
});

$('#btn-rec-preview').addEventListener('click', async () => {
  await unlockAudio(); // このクリックがユーザー操作。ここで resume しておく
  const rec = currentRec();
  const blob = await store.getBlob(blobKeyOf(currentMeta().voiceId));

  $('#rec-status').textContent = '再生中…';
  const r = await playVoice(blob);

  if (r.ok) {
    $('#rec-status').textContent = '聞こえましたか？よければ確定してください。';
    $('#rec-error').classList.add('hidden');
    return;
  }

  $('#rec-status').textContent = '再生できませんでした。端末の音量と消音を確認してください。';
  if (CONFIG.SHOW_AUDIO_DIAGNOSTICS) {
    $('#rec-error').textContent =
      `［診断］${r.reason}\n` +
      `形式: ${rec.mimeType || '不明'} / サイズ: ${blob ? Math.round(blob.size / 1024) + 'KB' : 'なし'}\n` +
      `再生方式: ${CONFIG.PLAYBACK_MODE} / AudioContext: ${audioContextState()}`;
    $('#rec-error').classList.remove('hidden');
  }
});

$('#btn-rec-confirm').addEventListener('click', async () => {
  stopVoice();
  playSe('se_confirm');
  const meta = currentMeta();
  app.state.recs[meta.voiceId].status = 'confirmed';
  await saveState();

  app.lastPlayedRole = meta.speakerRole;

  if (allConfirmed()) {
    showScreen('screen-ready');
    return;
  }
  // 通常は次の1本へ。飛ばした分が残っていれば最初の未確定に戻る
  app.recIndex = app.recIndex + 1 < app.recMeta.length ? app.recIndex + 1 : firstUnconfirmedIndex();
  maybeHandoffThenRecord();
});

/* ---------- プレイ開始 ---------- */

$('#btn-start-play').addEventListener('click', async () => {
  await unlockAudio(); // 音声再生はここを起点にする（設計書.md 8.4）
  await preloadSe(['se_select']);
  startPlaythrough();
});

$('#btn-rerecord').addEventListener('click', async () => {
  if (!confirm('録音した10本をすべて消してやり直します。よろしいですか？')) return;
  stopBgm();
  await store.clearBlobs();
  await store.clearState();
  app.state = { friendName: '', recs: {} };
  for (const meta of app.recMeta) app.state.recs[meta.voiceId] = { status: 'unrecorded' };
  app.recIndex = 0;
  app.lastPlayedRole = null;
  $('#input-name').value = '';
  showScreen('screen-title');
});

/* ---------- 本編 ---------- */

function startPlaythrough() {
  cancelTyping();
  app.engine.begin();
  app.inChoice = false;
  $('#choices').classList.add('hidden');
  $('#ending-actions').classList.add('hidden');
  $('#tap-hint').classList.remove('hidden');
  showScreen('screen-play');
  advance();
}

function renderStage() {
  const st = app.engine.stage;
  $('#stage').dataset.bg = st.bg || '';
  $('#stage').dataset.bgm = st.bgm == null ? '(停止)' : st.bgm;
  // 同じ曲名の間は鳴らしっぱなしになる（playBgm 側で判定）
  playBgm(st.bgm);

  for (const role of ['friend', 'girlfriend']) setSprite(role);
  renderDebug();
}

// 立ち絵の描画。画像が未用意（＝友人役はこれから生成）の場合は、
// 差分名を出すプレースホルダに自動で切り替える。
function setSprite(role) {
  const box = $(`.sprite[data-role="${role}"]`);
  const expr = app.engine.sprites[role];

  if (!expr) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.querySelector('.fallback').textContent = `${SPEAKER_LABEL[role]}\n${expr}`;

  const src = `${CONFIG.CHARA_DIR}/${role}/${expr}${CONFIG.CHARA_EXT}`;
  const img = box.querySelector('img');
  if (img.dataset.src === src) return;

  img.dataset.src = src;
  img.onerror = () => box.classList.add('missing');
  img.onload = () => box.classList.remove('missing');
  img.src = src;
}

function renderDebug() {
  if (!app.debugOn) return;
  const e = app.engine;
  $('#debug').textContent =
    `好感度 ${e.vars.affection} / 警戒度 ${e.vars.warning}\n` +
    `${e.sceneId}` +
    (e.stage.bgm == null ? '\nBGM: 停止' : `\nBGM: ${e.stage.bgm}`);
}

/* ---------- テキストのタイプライタ表示（設計書.md 6.2） ---------- */

const typing = { timer: null, full: '', el: null, done: true };

function typeText(el, text) {
  cancelTyping();
  typing.el = el;
  typing.full = text;
  typing.done = false;
  el.textContent = '';
  $('#next-mark').classList.remove('ready');

  if (!CONFIG.TYPING_MS) { finishTyping(); return; }

  let i = 0;
  const step = () => {
    i += 1;
    el.textContent = text.slice(0, i);
    if (i >= text.length) { finishTyping(); return; }
    // 句読点のあとだけ少し溜めると、読みのリズムが自然になる
    const wait = CONFIG.TYPING_MS + (CONFIG.TYPING_PAUSE[text[i - 1]] || 0);
    typing.timer = setTimeout(step, wait);
  };
  typing.timer = setTimeout(step, CONFIG.TYPING_MS);
}

// 表示途中でタップされたとき：残りを一気に出す
function finishTyping() {
  if (typing.timer) { clearTimeout(typing.timer); typing.timer = null; }
  if (typing.el) typing.el.textContent = typing.full;
  typing.done = true;
  $('#next-mark').classList.add('ready');
}

function cancelTyping() {
  if (typing.timer) { clearTimeout(typing.timer); typing.timer = null; }
  typing.done = true;
  $('#next-mark').classList.remove('ready');
}

async function advance() {
  if (app.inChoice) return;

  // 1回目のタップ＝全文表示、2回目のタップ＝次へ進む
  if (!typing.done) { finishTyping(); return; }

  stopVoice();

  const item = app.engine.next();

  if (item.type === 'end') {
    cancelTyping();
    renderStage();
    $('#tap-hint').classList.add('hidden');
    $('#ending-title').textContent = app.engine.sceneTitle || '';
    $('#ending-actions').classList.remove('hidden');
    return;
  }

  if (item.type === 'choice') {
    app.inChoice = true;
    cancelTyping();
    renderStage();
    const box = $('#choices');
    box.innerHTML = '';
    for (const opt of item.options) {
      const b = document.createElement('button');
      b.textContent = `${opt.key}．${subst(opt.label)}`;
      b.addEventListener('click', () => {
        playSe(item.se || 'se_select');
        box.classList.add('hidden');
        app.inChoice = false;
        app.engine.choose(opt.key);
        advance();
      });
      box.appendChild(b);
    }
    box.classList.remove('hidden');
    return;
  }

  // 通常行：左から1文字ずつ表示。再生中でもタップで先に進める（設計書.md 6.2）
  renderStage();
  const isNarration = item.speaker === 'narration';
  $('#speaker').textContent = isNarration ? '' : SPEAKER_LABEL[item.speaker] || '';
  $('#body').classList.toggle('narration', isNarration);
  typeText($('#body'), subst(item.body));

  if (item.voiceId) {
    const blob = await store.getBlob(blobKeyOf(item.voiceId));
    playVoice(blob); // 待たない。テキストは既に出ている
  }
}

$('#textbox').addEventListener('click', advance);
$('#btn-replay').addEventListener('click', () => {
  $('#ending-actions').classList.add('hidden');
  $('#tap-hint').classList.remove('hidden');
  startPlaythrough();
});

$('#btn-debug').addEventListener('click', (e) => {
  e.stopPropagation();
  app.debugOn = !app.debugOn;
  $('#debug').classList.toggle('hidden', !app.debugOn);
  renderDebug();
});

/* ---------- Service Worker ---------- */

function registerServiceWorker() {
  const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if ('serviceWorker' in navigator && secure) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 開発中は無視 */ });
  }
}

/* ---------- 開始 ---------- */

boot().catch((e) => {
  console.error(e);
  $('#screen-boot').querySelector('.loading').textContent =
    '読み込みに失敗しました。ローカルファイルを直接開いた場合は、HTTPサーバー経由で開いてください。';
});
