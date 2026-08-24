// 設計書.md 5.2 の定数はここ1箇所にまとめる。
// バランス調整はこのファイルだけを触り、validate_scenes.py の C も合わせて再実行すること。

export const CONFIG = {
  // エンディング分岐（設計書.md 5.2）
  WARNING_THRESHOLD: 3,
  AFFECTION_LOW: 2,
  AFFECTION_HIGH: 4,

  // 初期値（設計書.md 4.3）。クランプは行わない（負値を許容）
  INITIAL_VARS: { affection: 0, warning: 0 },

  // 録音（設計書.md 8.2）
  MAX_RECORDING_MS: 30000,

  // テキスト送り（設計書.md 6.1）
  // 1文字あたりのミリ秒。0にすると即時全文表示に戻る。
  // 表示中にタップすると即座に全文表示し、もう一度タップで次へ進む。
  TYPING_MS: 32,
  // 句読点で少し溜める（ミリ秒）。読点「、」と句点「。」で間を作る
  TYPING_PAUSE: { '、': 120, '。': 220, '…': 90, '─': 90 },

  // 録音時のノイズ抑制（設計書.md 8.2）
  // ブラウザ内蔵の音声処理。環境ノイズ・エアコン音・ハウリングに効く
  AUDIO_CONSTRAINTS: {
    noiseSuppression: true,   // ノイズ抑制
    echoCancellation: true,   // スピーカー回り込みの除去
    autoGainControl: true,    // 音量の自動調整（録音者ごとの声量差を吸収）
    channelCount: 1,          // モノラル（容量が半分になる）
  },

  // 再生方式（設計書.md 8.4）
  //   'auto'     … <audio> を優先し、失敗したら Web Audio にフォールバック（既定）
  //   'element'  … <audio> のみ
  //   'webaudio' … Web Audio のみ。iOSの消音スイッチで鳴らない場合はここを試す
  // MediaRecorder が出した容器をそのまま再生できる <audio> のほうが確実なため既定は auto。
  PLAYBACK_MODE: 'auto',

  // 再生に失敗した理由を画面に出す（実機デバッグ用。配布時は false）
  SHOW_AUDIO_DIAGNOSTICS: true,

  // 名前入力（設計書.md 4.4）
  FRIEND_NAME_MAX: 8,

  // データ
  SCENES_URL: './scenes.json',
  RECORDINGS_URL: './recordings.json',

  // 素材（設計書.md 7章）。PNGは原本、配信は optimize_assets.py が生成する .webp を使う
  CHARA_DIR: './public/assets/chara',
  CHARA_EXT: '.webp',
  BG_DIR: './public/assets/bg',
  BG_EXT: '.webp',

  // BGM（設計書.md 7章）。AAC(.m4a) は iOS Safari を含め全ブラウザで再生できる
  BGM_DIR: './public/assets/bgm',
  BGM_EXT: '.m4a',
  BGM_VOLUME: 0.32,   // セリフの下に敷く音量。上げすぎるとテキストの邪魔になる
  BGM_FADE_MS: 700,   // 曲を切り替えるときのフェード

  // 効果音（設計書.md 7章）。WAVなのは、短いUI音にコーデックの前詰めが乗るのを避けるため
  SE_DIR: './public/assets/se',
  SE_EXT: '.wav',
  SE_VOLUME: 0.5,
  // 録音開始の合図を鳴らし終えてからマイクを開くまでの余白。
  // 0にすると開始音が録音の頭に入り込む
  SE_REC_CUE_MARGIN_MS: 140,
};

export const ROLE_LABEL = {
  girlfriend: '彼女役（女性）',
  friend: '友人役（男性）',
};

export const SPEAKER_LABEL = {
  girlfriend: '彼女',
  friend: '友人',
  narration: '',
};
