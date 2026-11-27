# Sekai Viewer — MMW / unipjsk (WebSekai) 動的譜面ビューア再現

test10-main を置き換える新ビューア。描画エンジンは WebSekai の中核である
sekai-mmw-preview-web（MikuMikuWorld プレビューの C++→WASM 移植）の公開ソースを
JavaScript / WebGL2 へ忠実に移植したもので、素材は MMW / 実機由来のアトラスを使用する。

## 使い方

`index.html` を HTTP サーバ経由で開く（`file://` では素材 fetch が制限される場合がある）。

```sh
python3 -m http.server 8000
# http://localhost:8000/ を開く
```

- 曲 ID と難易度を選んで「読み込み」: SUS（unipjsk CDN）・音源・ジャケット・
  フィラー秒数（sekai-master-db-diff）を自動取得する。初期表示は #796 MASTER。
- ローカルの SUS / 音源 / ジャケットファイルも読み込める。
- `#cfg=<base64url JSON>` 形式（{sus, bgm, jacket, title, offset}）にも対応。
- スペースキーで再生/一時停止。シークバーで移動（HUD はリプレイで再計算）。

## 設計（何をどう再現したか）

### エンジン（js/render.js, js/drawdata.js）
- **DrawData 事前計算**: 全ノーツの visualTime（scaled time）を事前に計算し、
  毎フレームは範囲チェックのみ。MMW の calculateDrawData / addHoldNote を移植。
- **scaled time**: BPM と HiSpeed（#TIL00）を折り込んだ時間軸
  （accumulateScaledDuration 移植）。ノーツ表示時間は
  `lerp(0.35, 4.0, pow(unlerp(12, 1, noteSpeed), 1.31)) / speedRatio`、既定速度 10.5。
- **軌道**: `approach = pow(1.06, 45 * lerp(-1, 0, unlerp(start, end, now)))`。
- **投影**: perspectiveQuadvPos（x に y を乗算する台形投影）＋頂点 w = 仮想 y に
  よる perspective-correct UV 補間（MMW の reciprocalW と等価）。
  ワールド変換は prsk-chart-viewer の mmwWebgl.ts と同じ定数
  （STAGE_ZOOM=927/800、1420×850 レーン、目標 1920×1080）。
- **ノーツ描画**: スプライト変換行列 18 種とスプライト矩形 37+4+4 は
  sekai-mmw-preview-web の生成リソースから自動変換して同梱（js/mmw-data.js）。
  ノーツ本体は 3 スライス（NOTE_SIDE_WIDTH=91 / PAD=10、左 0.25 / 右 0.3 レーン）、
  トレースダイヤ、フリック矢印（幅 1–6 テーブル、0.5 秒アニメーション
  alpha=1−t³）、同時押しライン、ホールドティックを個別に移植。
- **スライド/ガイド帯**: 二次イージング（Linear / EaseIn t² / EaseOut 1−(1−t)²）
  で補間し 10/15+log ステップに分割。ホールドは HOLD_XCUTOFF=36、
  ガイドは GUIDE_XCUTOFF=3 と Y カットオフ（-41/-12）で touchLine テクスチャを
  サンプリング。アクティブ時は通常/アクティブ行を cos でクロスフェード（1Hz）。
  アクティブ中はヘッドノーツを判定ライン上に再描画する。
- **z オーダー**: MMW のレイヤー優先（FLICK_ARROW > DIAMOND > BASE_NOTE >
  TICK_NOTE > HOLD_PATH > GUIDE_PATH > UNDER_FX）を int32 キーで再現。
- **ステージ配置**: 同梱 stage.png（2048×1176）を実測（レーン台形
  halfW(y)=0.8341y+43.97、中心 x=1023.5、判定枠中心 y=805、消失点 y=−52.7）し、
  ノーツ投影と一致するよう配置した。

### SUS パーサ（js/sus.js）
Sekai-SUS-Parser（SusToJson.cpp）の意味論を移植:
- タップ種別 1–8（通常/クリティカル/スキップ/スキルイベント/フリクション/
  クリティカルフリクション/フリクションヒドゥン×2）、方向チャンネル
  （フリック上下左右・EaseIn/EaseOut）、スライド（開始/終了/可視中継/不可視中継）、
  ガイド帯、レーン 'f' のフィーバーイベント、レーン 'e' のスキル。
- 同一 tick+lane のタップ/方向情報はスライド・ガイドへ継承（クリティカル、
  フリクション、隠しヘッド、フリック、イージング）— 実譜面 796 MASTER で検証済み
  （スライド開始 189 件中 154 件がタップ情報と一致する実データ特性を再現）。
- #TIL00 ハイスピード、#VOL00 SE 音量、拍子（#02）、BPM 変化、WAVEOFFSET 対応。

### 背景（js/bg.js）
実機 2D 背景（live/2dmode/background/default.png、2048×2048）の中央ウィンドウへ
ジャケットを合成（暗めに減衰）。その上に stage.png を被せ、明るさ・ステージ
カバー・ステージ不透明度を設定で調整できる（WebSekai の設定項目に対応）。

### 音声（js/audio.js）
- BGM は `<audio>` の preservesPitch 再生（0.25–2.0x）。
- 譜面クロック = 音源時刻 − フィラー秒 + **出力レイテンシ** + 手動オフセット。
  出力レイテンシは Web Audio の outputLatency / getOutputTimestamp から自動取得
  （WebSekai 計画 E の自動測定に相当）。
- SE は MMW の sound/01・02 セット（切替可）を Web Audio で先読みスケジューリング。
  種別は MMW の getNoteSE 準拠（フリック/フリクション/ティック/コネクト等）。
  ホールド自動ティックは 1/2 拍グリッド（ゲームのモデル）。

### エフェクト（js/fx.js）
MMW の Unity パーティクル JSON の完全解釈は行わず、effect.png の
NOTE_CIRCULAR / LINEAR スプライトを使ったプール型パーティクルで近似:
レーン発光ピラー、判定ライングロー（touch_line スプライト）、拡散リング、
スパーク。種別ごとに色・個数を変える。

### HUD（js/hud.js, index.html）
添付の実機動画のレイアウトを再現: 左上ランクバッジ＋スコアバー（C/B/A/S
マーカー）＋8 桁スコアと加算ポップ、右上 LIFE 1000＋ポーズボタン、
右下 AUTO LIVE バッジ、中央の判定表示（AUTO）とコンボ、スキルバナー、
FEVER CHANCE! / SUPER FEVER!! バナー。
スコア計算は近似（全 PERFECT、基本 1,000,000 点をイベント重みで配分、
自動ティック 0.1 倍、スキル中 ×1.3、フィーバー ×1.1。動画の +661/+66 の
増分パターンと D→C→B→S の遷移に合わせて調整）。実機の確定仕様は非公開。

## 検証

- Node で 796 MASTER をパース: ノーツ 1,422（タップ 584 / ホールド 287 /
  中継 264 / 終端 287）、ヒットイベント 1,232、NaN なし。
- ヘッドレス Chromium（SwiftShader）で実描画を確認: ノーツ軌道・帯・フリック・
  HUD・背景合成が実機動画と同等の幾何で描画される（docs/preview-*.png）。

## 既知の近似・未再現

- パーティクルは MMW fx JSON の完全再現ではない（上記）。
- スコア/ランクは近似モデル。判定窓・スコアの確定仕様は公開情報に存在しない。
- 背景は bggen v3 方式（ジャケットの射影変換合成）ではなく MMW 方式の合成。
- HUD は WebSekai live-ui の画像そのものではなく、DOM/CSS による再現。
- フリクションヒドゥン（7/8）のヘッドはダイヤのみ表示（帯は通常描画）。

## 素材・ライセンス

- コード: 本リポジトリの移植部分は sekai-mmw-preview-web / MikuMikuWorld 由来の
  アルゴリズムを含み AGPL-3.0 の影響を受ける。利用時は各ライセンスに従うこと。
- 画像・音声素材はゲーム由来アセットを含む。個人の開発・検証用途とし、
  再配布・公開利用には権利確認が必要。
