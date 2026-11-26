# プロセカ譜面ビューア v2

元の譜面ビューア（`index.orig.html`）のゲームプレイヤー部分だけを、WASM + WebGL2 の新エンジンに置き換えたものです。
曲一覧・SUS 取得・SVG 譜面表示・キャッシュ・設定画面は元のまま動きます。

## GitHub Pages で運用する

`.nojekyll` をリポジトリのルートに入れてあります（Jekyll を無効化し、全ファイルをそのまま配信するため）。
これがないと Pages のビルドで一部のファイルが配信対象から外れることがあります。

```sh
# 推奨: git で push する（Web のドラッグ＆ドロップは一度に 100 ファイルまでで、
# このプロジェクトは 90 ファイルあるため、漏れが起きやすい）
git init
git add .
git commit -m "proseka viewer v2"
git remote add origin https://github.com/<ユーザー名>/<リポジトリ名>.git
git push -u origin main
```

その後、GitHub の Settings → Pages → Build and deployment → Source を
「Deploy from a branch」、Branch を `main`、フォルダを **/(root)** にします。
`/docs` にすると `docs/` だけが配信されて動きません。

公開後、以下が 200 で返ることを確認してください（これが欠けていると、
画面は開くのにステージ・ノーツ・エフェクトが表示されません）。

- `https://<ユーザー名>.github.io/<リポジトリ名>/assets/stage.png`
- `https://<ユーザー名>.github.io/<リポジトリ名>/assets/notes_01.json`
- `https://<ユーザー名>.github.io/<リポジトリ名>/wasm/proseka_core.wasm`

リポジトリ側のファイル数がこのフォルダと一致していることも確認してください。
`assets/` フォルダ（PNG・`notes_*.json`・`effects/` の 50 個の fx 定義）が
丸ごと欠けていると、プレイヤーは開けてもゲーム画面が真っ暗になります。

### iPhone/iPad からアップロードする場合（`.` で始まるファイルが見えない）

iOS の「ファイル」アプリでは `.nojekyll` や `.gitignore` のような
`.` で始まるファイルが表示されず、zip に入れ直すときにも漏れてしまいます。
そのため、このプロジェクトには見える名前の仮ファイルを入れてあります。

- `nojekyll` → GitHub に上げたあと、Web 画面で `.nojekyll` にリネームする
- `gitignore` → 同じく `.gitignore` にリネームする（Pages の動作には不要なので、なくても動きます）

リネームの手順（github.com の Web 画面）:
1. リポジトリで `nojekyll` を開く
2. 右上の鉛筆アイコン（Edit）をタップ
3. ファイル名を `.nojekyll` に変更して「Commit changes」をタップ

なお、本物の `.nojekyll` / `.gitignore` も zip に入っています。
パソコンから git で push する場合はそちらがそのまま使えるので、仮ファイルは無視して構いません。

`.nojekyll` がなくてもサイト自体は開けますが、Pages が Jekyll として処理するため、
一部のファイルが配信対象から外れることがあります。必ず入れてください。

## 起動方法

WASM を読むため、**HTTP サーバー経由で開く必要があります**。`file://` で開くと WASM が読めず、JS コアにフォールバックします
（描画はできますが遅くなります）。

```sh
cd proseka-viewer-v2
python3 -m http.server 8000
# ブラウザで http://localhost:8000/index.html を開く
```

## 依頼 A〜E への対応

| 依頼 | 対応 |
|---|---|
| A. WASM + WebGL2 に置き換え、GPU 主役化 | Rust コア（`wasm/proseka-core/`）＋ WebGL2 レンダラー。同一画像をバッチ描画（1 フレーム約 5〜7 ドローコール） |
| A. 透視補正を GPU で実施 | クアッドに reciprocalW を持たせ、頂点シェーダで透視補正補間を利用 |
| A. 1920×1080 / ステージ 2048×1176 | 目標解像度 1920×1080、ステージ画像 2048×1176（`assets/stage.png`） |
| A. ゲーム画面はキャンバス内、DOM は操作パネルだけ | `#gview` キャンバス 1 枚に集約。DOM はヘッダー・設定パネル・フッターのみ |
| B. DrawData の完全な事前計算 | 表示時間範囲・同時押し線・ロング帯の分割済みポリゴン・ホールド刻みまで読み込み時に計算 |
| B. visualTime の事前変換 | テンポマップ＋ハイスピードを読み込み時に畳み込み（TempoMap / ScrollLayer） |
| B. エンジン/UI 境界 | Engine が時刻・曲長・終端・開始遅延を一元管理し、UI は `getState()` で問い合わせるだけ。プレイヤーは独立ページ `player.html` |
| C. テクスチャアトラス | ノーツ 36 スプライト/スキン、エフェクト、ステージを PNG＋切り取り座標表で管理 |
| C. スキン 2 種の切替 | `notes_01` / `notes_02` を設定（設定画面・再生画面）で切替 |
| C. 背景の明るさ・ステージカバー | 背景の明るさ（10〜150%）、ステージカバー不透明度（0〜100%）を設定可能 |
| D. パーティクルシステム | MikuMikuWorld 由来、プール付き。発生・寿命・透明度を物理更新 |
| D. エフェクト定義のデータ化 | `fx_*.json` 約 25 種×2 パターン。通常/クリティカル/フリック/ロング/トレース別 |
| D. エフェクト画像アトラス | `effect.png` から粒の絵を切り出して使用 |
| E. 出力遅延の自動補正 | 自動計測（`outputLatency` / `getOutputTimestamp`）＋手動 ms 調整（−300〜+300）＋タップ調整 |
| E. 書き出し用音声の分離 | 再生バッファとは別の stretch コピーから WAV 書き出し（0.5×/等速/2×） |

## 操作

- Space: 再生/停止、←→: ±1 秒（Shift で ±5 秒）、↑↓: 小節移動、Home/End: 頭/最後、V: ゲーム画面 ⇄ 譜面再生
- 再生画面の「表示設定」パネル: 速度・音量・タイミング補正・ハイスピード・出現開始・ソフラン・ミラー・
  ボーカル・スライド/ガイド透明度・ノーツスキン・エフェクト・背景の明るさ・ステージカバー・出力遅延・WAV 書き出し
- 設定画面（#settings）にもノーツスキン・エフェクト・背景の明るさ・ステージカバー・手動遅延調整を追加済み

## テスト

```sh
node tests/run_all.js   # WASM/JS カーネル一致、DrawData、FX 定義、アトラスの 4 本
```

ブラウザでの動作確認は `tests/harness.html`（デモ SUS を `player.html?demo` で再生）で行えます。
詳しくは `docs/DESIGN.md` を参照してください。

## 未検証の範囲

- 実機ブラウザでの描画・音声（検証はヘッドレス Chromium + SwiftShader のみ）
- 実曲（sekai.best / master-db）での再生 — ネットワーク取得が必要です
- Bluetooth 環境での遅延自動計測の実測値
