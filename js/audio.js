// 録音と再生（設計書.md 8.2 / 8.4）
//
// 録音：形式は決め打ちせず isTypeSupported で判定する（Chrome系は WebM/Opus、Safari は MP4系）。
//       停止時は必ずマイクストリームを止める。掴んだままだと端末によって再生音が極端に小さくなる。
// 再生：ユーザー操作を起点に AudioContext を作り、以降はその文脈で鳴らす。
//       再生・停止は playVoice / stopVoice の2つに集約する（画面遷移時の停止漏れを防ぐため）。

import { CONFIG } from './config.js';

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/aac',
  'audio/ogg;codecs=opus',
];

// 実際に効いた音声処理を返す（端末によっては無視されるため、診断に使う）
export function appliedAudioSettings(stream) {
  try {
    const track = stream && stream.getAudioTracks()[0];
    return track && track.getSettings ? track.getSettings() : null;
  } catch (_) { return null; }
}

export function isRecordingSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

export function pickMimeType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return ''; // ブラウザ既定に任せる
}

export class Recorder {
  constructor() {
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.startedAt = 0;
    this.autoStopTimer = null;
    this.pending = null;
    this.onAutoStop = null; // 30秒で自動停止したときに呼ばれる
  }

  get isRecording() {
    return !!(this.recorder && this.recorder.state === 'recording');
  }

  async start() {
    if (this.isRecording) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { ...CONFIG.AUDIO_CONSTRAINTS } });
    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];

    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.onstop = () => {
      const type = this.recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(this.chunks, { type });
      const durationMs = Math.round(performance.now() - this.startedAt);
      this.releaseStream();
      const resolve = this.pending;
      this.pending = null;
      if (resolve) resolve({ blob, mimeType: type, durationMs });
    };

    this.startedAt = performance.now();
    this.recorder.start();

    // 無限録音を防ぐ自動停止（設計書.md 8.2）。
    // stop() の戻り値を捨てると録音が保存されないまま消えるため、必ず onAutoStop に渡す。
    this.autoStopTimer = setTimeout(() => {
      this.stop().then((result) => {
        if (result && this.onAutoStop) this.onAutoStop(result);
      });
    }, CONFIG.MAX_RECORDING_MS);
  }

  get elapsedMs() {
    return this.isRecording ? performance.now() - this.startedAt : 0;
  }

  stop() {
    if (!this.isRecording) return Promise.resolve(null);
    clearTimeout(this.autoStopTimer);
    this.autoStopTimer = null;
    const p = new Promise((resolve) => { this.pending = resolve; });
    this.recorder.stop();
    return p;
  }

  // マイクを掴みっぱなしにしない。ブラウザの録音インジケータも消える。
  releaseStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  cancel() {
    clearTimeout(this.autoStopTimer);
    this.autoStopTimer = null;
    this.pending = null;
    if (this.isRecording) {
      try { this.recorder.stop(); } catch (_) { /* noop */ }
    }
    this.releaseStream();
  }
}

/* ---------- 再生 ---------- */

let ctx = null;
let currentSource = null;
let currentEl = null;
let currentUrl = null;

// 「はじめる」「録音する」「聞いてみる」など、必ずユーザー操作の中から呼ぶこと（自動再生ポリシー対策）
export async function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!ctx && AC) ctx = new AC();
    // resume は非同期。await しないと suspended のまま start() してしまい、
    // 「エラーは出ないのに音が鳴らない」状態になる。
    if (ctx && ctx.state === 'suspended') await ctx.resume();
  } catch (_) { /* 未対応環境では <audio> にフォールバックする */ }
}

export function audioContextState() {
  return ctx ? ctx.state : 'なし';
}

export function stopVoice() {
  if (currentSource) {
    try { currentSource.onended = null; currentSource.stop(); } catch (_) { /* noop */ }
    currentSource = null;
  }
  if (currentEl) {
    try { currentEl.pause(); } catch (_) { /* noop */ }
    currentEl = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}

// 再生の終了（または stopVoice）で解決する。失敗しても throw しない。
// 戻り値: { ok, via, reason } … via は 'element' / 'webaudio'
export async function playVoice(blob) {
  stopVoice();

  if (!blob) return { ok: false, via: null, reason: '録音データが見つかりません' };
  if (!blob.size) return { ok: false, via: null, reason: '録音データが空です（0バイト）' };

  const mode = CONFIG.PLAYBACK_MODE;
  const reasons = [];

  if (mode === 'element' || mode === 'auto') {
    const r = await playWithElement(blob);
    if (r.ok) return r;
    reasons.push('audio要素: ' + r.reason);
    if (mode === 'element') return { ok: false, via: 'element', reason: reasons.join(' / ') };
  }

  const r = await playWithWebAudio(blob);
  if (r.ok) return r;
  reasons.push('WebAudio: ' + r.reason);
  return { ok: false, via: null, reason: reasons.join(' / ') };
}

// MediaRecorder が出した容器をそのまま再生する。最も確実な経路。
async function playWithElement(blob) {
  let url = null;
  try {
    url = URL.createObjectURL(blob);
    const el = new Audio();
    el.playsInline = true;
    el.preload = 'auto';
    el.src = url;
    currentEl = el;
    currentUrl = url;

    await el.play(); // 自動再生ポリシーに弾かれるとここで reject する
    return await new Promise((resolve) => {
      el.onended = () => { stopVoice(); resolve({ ok: true, via: 'element', reason: '' }); };
      el.onerror = () => {
        stopVoice();
        resolve({ ok: false, via: 'element', reason: 'この形式を再生できません' });
      };
    });
  } catch (e) {
    stopVoice();
    return { ok: false, via: 'element', reason: (e && e.name) || String(e) };
  }
}

// iOS の消音スイッチ対策として用意している経路（設計書.md 8.4）
async function playWithWebAudio(blob) {
  await unlockAudio();
  if (!ctx) return { ok: false, via: 'webaudio', reason: 'AudioContext を作れません' };
  if (ctx.state !== 'running') return { ok: false, via: 'webaudio', reason: 'AudioContext が ' + ctx.state };

  let buf;
  try {
    buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch (e) {
    return { ok: false, via: 'webaudio', reason: 'デコードできません（' + ((e && e.name) || e) + '）' };
  }
  // デコードは通ったのに長さ0、というケースがある。ここで弾かないと
  // 「エラーなし・音は鳴らない」状態のまま成功扱いになってしまう。
  if (!buf || !buf.duration) {
    return { ok: false, via: 'webaudio', reason: 'デコード結果の長さが0です' };
  }

  return await new Promise((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => { currentSource = null; resolve({ ok: true, via: 'webaudio', reason: '' }); };
    currentSource = src;
    src.start();
  });
}


/* ---------- BGM ---------- */
//
// ボイスとは独立して鳴らす。曲名が同じ間は鳴らしっぱなしにするので、
// 同じ曲を使うシーンをまたいでも途切れない（Scene1〜5 は通しで bgm_daily）。
//
// 音量調整は Web Audio の GainNode で行う。HTMLAudioElement の volume は
// iOS で効かないため、ここを <audio> の volume だけに頼ると音量を絞れない。

let bgmEl = null;
let bgmSrc = null;
let bgmGain = null;
let bgmName = undefined;   // undefined = 未設定、null = 明示的に停止

export function currentBgm() {
  return bgmName;
}

function rampGain(gain, to, ms) {
  const t = ctx.currentTime;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(gain.gain.value, t);
  gain.gain.linearRampToValueAtTime(to, t + ms / 1000);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// name が null / 空なら停止（①バレエンドの無音演出）
export async function playBgm(name) {
  const next = name || null;
  if (next === bgmName) return { ok: true, reason: '' };

  await fadeOutBgm();
  bgmName = next;
  if (!next) return { ok: true, reason: '' };

  await unlockAudio();
  const el = new Audio(`${CONFIG.BGM_DIR}/${next}${CONFIG.BGM_EXT}`);
  el.loop = true;
  el.preload = 'auto';
  bgmEl = el;

  try {
    if (ctx && ctx.state === 'running') {
      bgmSrc = ctx.createMediaElementSource(el);
      bgmGain = ctx.createGain();
      bgmGain.gain.value = 0;
      bgmSrc.connect(bgmGain);
      bgmGain.connect(ctx.destination);
      await el.play();
      rampGain(bgmGain, CONFIG.BGM_VOLUME, CONFIG.BGM_FADE_MS);
    } else {
      el.volume = CONFIG.BGM_VOLUME; // iOS では無視されるが、その場合は上の経路が使えている
      await el.play();
    }
    return { ok: true, reason: '' };
  } catch (e) {
    // BGMが鳴らなくても本編は続行する
    bgmEl = null; bgmSrc = null; bgmGain = null;
    return { ok: false, reason: (e && e.name) || String(e) };
  }
}

export async function stopBgm() {
  await fadeOutBgm();
  bgmName = undefined;
}

async function fadeOutBgm() {
  const el = bgmEl, gain = bgmGain, src = bgmSrc;
  bgmEl = null; bgmGain = null; bgmSrc = null;
  if (!el) return;

  if (gain && ctx) {
    rampGain(gain, 0, CONFIG.BGM_FADE_MS);
    await wait(CONFIG.BGM_FADE_MS);
  }
  try { el.pause(); } catch (_) { /* noop */ }
  try { if (src) src.disconnect(); if (gain) gain.disconnect(); } catch (_) { /* noop */ }
  el.removeAttribute('src');
  el.load();
}


/* ---------- 効果音 ---------- */
//
// 短いUI音。デコード済みのバッファを持ち回して、押した瞬間に鳴るようにする。
// ボイス・BGMとは独立して鳴らす（重なってよい）。

const seBuffers = new Map();

async function loadSe(name) {
  if (seBuffers.has(name)) return seBuffers.get(name);
  try {
    const res = await fetch(`${CONFIG.SE_DIR}/${name}${CONFIG.SE_EXT}`);
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    seBuffers.set(name, buf);
    return buf;
  } catch (_) {
    seBuffers.set(name, null); // 取得できなければ以後は諦める（無音で続行）
    return null;
  }
}

// ユーザー操作の中で先に呼んでおくと、最初の1回目から遅延なく鳴る
export async function preloadSe(names) {
  await unlockAudio();
  if (!ctx) return;
  await Promise.all(names.map(loadSe));
}

// 鳴らした音の長さ（秒）を返す。0 は鳴らなかったことを意味する
export async function playSe(name) {
  await unlockAudio();
  if (!ctx || ctx.state !== 'running') return 0;

  const buf = await loadSe(name);
  if (!buf) return 0;

  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = CONFIG.SE_VOLUME;
  src.buffer = buf;
  src.connect(gain);
  gain.connect(ctx.destination);
  src.onended = () => { try { src.disconnect(); gain.disconnect(); } catch (_) { /* noop */ } };
  src.start();
  return buf.duration;
}
