# STORES POS 売上データ → Google Spreadsheet 自動取得 + Slack通知 手順書

## 概要

STORES POS の期間別売上データ（今月・日別・全店舗+個別店舗）を毎日自動取得し、Google Spreadsheet に保存、売上サマリーを Slack に通知するシステム。GAS（WorkflowDispatcher）から GitHub Actions を `workflow_dispatch` で毎日起動。

### 処理フロー

```
1. fetch-stores-data.js    → STORES POS からスクレイピング → data/YYYYMM.json
2. upload-gsheet.js        → Google Spreadsheet 作成・更新（店舗別シート + サマリー3シート + グラフ）
3. notify-slack.js         → 前日の売上レポートメッセージ生成 → slack_message.txt
4. post-to-slack.js        → yasumi Slack ワークスペースに投稿
5. notify-slack-weekly.js  → [月曜のみ] 前週（月〜日）の週次売上レポート生成 → slack_message.txt
6. post-to-slack.js        → [月曜のみ] 週次レポートを投稿
```

### 対象店舗（7店舗）

| # | 店舗名 | slug | サマリー短縮名 |
|---|---|---|---|
| 1 | 全店舗 | all | — |
| 2 | YY HANDS名古屋 | yyhands_nagoya | YY名古屋 |
| 3 | YYHANDS東京 | yyhands_tokyo | YY東京 |
| 4 | YYHANDS大阪 | yyhands_osaka | YY大阪 |
| 5 | YASUMI LAB名古屋 | yasumilab_nagoya | LAB |
| 6 | 2525ジュエリー名古屋 | 2525jewelry_nagoya | 2525 |
| 7 | HELLO BONSAI CLUB | hello_bonsai | BONSAI |

---

## ディレクトリ構成

```
stores-gsheet-daily/
├── .github/workflows/
│   └── daily-fetch.yml          ← GitHub Actions（GAS workflow_dispatch で起動）
├── index.js                     ← メイン（一括実行）
├── fetch-stores-data.js         ← STORES POS スクレイピング
├── upload-gsheet.js             ← Google Spreadsheet 作成・更新
├── notify-slack.js              ← Slack 日次通知メッセージ生成
├── notify-slack-weekly.js       ← Slack 週次通知メッセージ生成（月曜のみ）
├── post-to-slack.js             ← yasumi Slack に投稿
├── config.js                    ← 店舗定義・カラム定義
├── package.json
├── .env                         ← 環境変数（Git管理外）
├── .env.example                 ← 環境変数テンプレート
├── .gitignore
├── data/                        ← スクレイピング結果JSON（Git管理外）
└── screenshots/                 ← デバッグ用スクリーンショット（Git管理外）
```

---

## セットアップ手順

### 1. リポジトリのクローンと依存インストール

```bash
git clone https://github.com/pixta0825/stores-gsheet-daily.git
cd stores-gsheet-daily
npm install
npx playwright install --with-deps chromium
```

### 2. Google Cloud サービスアカウント作成

#### 2-1. プロジェクト作成

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. 上部の「プロジェクトを選択」→「新しいプロジェクト」
3. プロジェクト名: `stores-gsheet-daily`（任意）
4. 「作成」をクリック

#### 2-2. API 有効化

1. 左メニュー「APIとサービス」→「ライブラリ」
2. 以下の2つの API を検索して「有効にする」:
   - **Google Sheets API**
   - **Google Drive API**

#### 2-3. サービスアカウント作成

1. 左メニュー「APIとサービス」→「認証情報」
2. 「認証情報を作成」→「サービスアカウント」
3. サービスアカウント名: `stores-gsheet`（任意）
4. 「作成して続行」→ ロールは不要 →「完了」
5. 作成されたサービスアカウントをクリック
6. 「鍵」タブ →「鍵を追加」→「新しい鍵を作成」→ JSON →「作成」
7. JSON ファイルがダウンロードされる

#### 2-4. Google Drive フォルダの共有設定

1. Google Drive でスプレッドシートの保存先フォルダを開く
2. フォルダを右クリック →「共有」→「ユーザーやグループを追加」
3. ダウンロードした JSON 内の `client_email` の値を入力
   - 例: `stores-gsheet@stores-gsheet-daily.iam.gserviceaccount.com`
4. 権限を「**編集者**」に設定して「送信」

### 3. 環境変数の設定

```bash
cp .env.example .env
```

`.env` を編集:

```env
# STORES POS ログイン情報
STORES_EMAIL=your-email@example.com
STORES_PASSWORD=your-password

# Google サービスアカウント認証（JSON鍵の内容を1行で）
GOOGLE_CREDENTIALS={"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}

# Google Drive フォルダID（URLの末尾部分）
GOOGLE_DRIVE_FOLDER_ID=1ZiZE3bkB25aeeawQIPyiLazm_iabQJmj

# Slack Bot Token（yasumiワークスペース）
DEST_BOT_TOKEN=xoxb-your-bot-token

# Slack チャンネルID
DEST_CHANNEL_ID=C0A6RB6JGMV
```

**JSON文字列の作り方:**

```bash
cat path/to/downloaded-key.json | jq -c .
```

出力をそのまま `GOOGLE_CREDENTIALS=` の後に貼り付ける。

**Google Drive フォルダID の確認方法:** フォルダを開いた状態のURLが `https://drive.google.com/drive/folders/XXXXX` の場合、`XXXXX` がフォルダID。

### 4. GitHub Secrets の設定

リポジトリの Settings → Secrets and variables → Actions → New repository secret

| Secret名 | 値 |
|---|---|
| `STORES_EMAIL` | STORES POS ログインメールアドレス |
| `STORES_PASSWORD` | STORES POS ログインパスワード |
| `GOOGLE_CREDENTIALS` | サービスアカウント JSON 文字列（1行） |
| `GOOGLE_DRIVE_FOLDER_ID` | Google Drive フォルダID |
| `DEST_BOT_TOKEN` | Slack Bot Token（yasumi） |
| `DEST_CHANNEL_ID` | Slack チャンネルID |

---

## 実行方法

### ローカル実行

```bash
# 一括実行（データ取得 → Spreadsheet → Slack通知）
npm run all          # または node index.js

# 個別実行
npm run fetch        # STORES データ取得のみ
npm run upload       # Spreadsheet アップロードのみ
npm run notify       # Slack メッセージ生成のみ
npm run post         # Slack 投稿のみ
```

### オプション

```bash
node fetch-stores-data.js --month=202603     # 指定月のデータ取得
node upload-gsheet.js --month=202603         # 指定月をアップロード
node upload-gsheet.js --dry-run              # プレビューのみ
node notify-slack.js --date=3月7日           # 指定日のレポート生成
node post-to-slack.js --dry-run              # 送信せずプレビュー
```

### GitHub Actions

- **自動実行**: GAS（WorkflowDispatcher）から `workflow_dispatch` で毎日起動
- **手動実行**: Actions タブ →「STORES POS → Google Spreadsheet Daily」→「Run workflow」

### 週次レポート（月曜のみ）

```bash
# 週次レポートの単独テスト
node notify-slack-weekly.js --dry-run    # プレビューのみ
node notify-slack-weekly.js              # メッセージ生成（slack_message.txt に保存）
```

月曜日に `index.js` を実行すると、日次レポート投稿後に自動で週次レポートも投稿される。
週次レポートは Google Spreadsheet のサマリーシート（純売上・客数）から前週月〜日の7日分を読み取り集計。

---

## Google Spreadsheet の構成

### 出力先

Google Drive フォルダ内に月ごとに1ファイル作成。日次実行で最新データに上書き更新。

| 月 | スプレッドシート名 |
|---|---|
| 2026年3月 | `STORES_売上_202603` |
| 2026年4月 | `STORES_売上_202604` |

### シート構成（タブ順）

| # | シート名 | 内容 |
|---|---|---|
| 1 | **純売上** | 店舗別日次純売上サマリー + 棒グラフ（積み上げ） |
| 2 | **客数** | 店舗別日次客数サマリー + 棒グラフ（積み上げ） |
| 3 | **単価** | 店舗別日次売上単価サマリー + 棒グラフ |
| 4 | 全店舗 | 全店舗合計の期間別売上データ |
| 5 | YY HANDS名古屋 | 店舗別売上データ |
| 6 | YYHANDS東京 | 〃 |
| 7 | YYHANDS大阪 | 〃 |
| 8 | YASUMI LAB名古屋 | 〃 |
| 9 | 2525ジュエリー名古屋 | 〃 |
| 10 | HELLO BONSAI CLUB | 〃 |

### サマリーシート（純売上・客数・単価）

| 項目 | 内容 |
|---|---|
| 行 | 1日〜月末（月の全日分） |
| 列 | 日付 / YY名古屋 / YY東京 / YY大阪 / LAB / 2525 / BONSAI / 合計or平均 |
| ゼロ値 | 「-」で表示（数値フォーマット `#,##0;-#,##0;"-"` による） |
| 書式 | ヘッダー: 紺背景・白太字、データ: 右揃え、合計/平均列: 太字 |
| 列幅 | 店舗別シートと同じ幅で統一 |

### サマリーグラフ仕様

| 項目 | 純売上・客数 | 単価 |
|---|---|---|
| グラフタイプ | COLUMN（棒グラフ） | COLUMN（棒グラフ） |
| 積み上げ | STACKED | NOT_STACKED |
| サイズ | 1080 x 667 px | 1405 x 667 px |
| フォント | Roboto | Roboto |
| 横軸タイトル | 日付 | 日付 |
| 凡例 | 下部（BOTTOM_LEGEND） | 下部（BOTTOM_LEGEND） |
| データ範囲 | 個別6店舗（合計列を除く） | 個別6店舗（平均列を除く） |

### 店舗別シート

| 行 | 内容 |
|---|---|
| 1行目 | ヘッダー（紺背景・白太字） |
| 2行目 | 期間合計（薄緑背景・太字） |
| 3行目〜 | 日別データ |

カラム: 日付 / 純売上 / 純売上（税抜）/ 消費税 / 総売上 / 値引き / 返金額 / 販売点数 / 返品点数 / 件数 / 単価

- 数値フォーマット: `#,##0`（円マークなし）
- 列幅: A列の自動調整幅 × 1.5 で全列統一
- フィルタ: 全列に設定

---

## Slack 通知

### 投稿先

- ワークスペース: yasumi
- チャンネル: `C0A6RB6JGMV`
- Bot: image_forwarder_desti（`DEST_BOT_TOKEN`）

### 日次通知内容

- 前日の全店舗合計（純売上・件数・単価）
- 店舗別実績（棒グラフ付き、売上降順）
- Google Spreadsheet のリンク

### 週次通知内容（毎週月曜日のみ、日次通知の後に投稿）

- 前週（月曜〜日曜）の全店舗合計（純売上・件数・単価）
- 店舗別実績（棒グラフ付き、売上降順）
- データソース: Google Spreadsheet のサマリーシート（純売上・客数）
- 単価は「純売上合計 ÷ 件数合計」で算出
- 月またぎ対応: 前週が月をまたぐ場合は2つのSpreadsheetを読む

---

## 店舗の追加・変更

### 1. config.js に店舗を追加

```javascript
const STORES = [
  // ...既存店舗...
  {
    name: '新店舗名',
    slug: 'new_store',
    url: `${BASE_URL}?${COMMON_PARAMS}&salesChannelId=XXXXX`,
  },
];
```

`salesChannelId` は STORES 管理画面で対象店舗を選択した際の URL パラメータから取得。

### 2. upload-gsheet.js にサマリー短縮名を追加

```javascript
const SHORT_NAMES = {
  // ...既存...
  new_store: '新店舗',
};
```

---

## トラブルシューティング

| 症状 | 確認ポイント |
|---|---|
| STORES ログイン失敗 | `STORES_EMAIL` / `STORES_PASSWORD` の確認。パスワード変更があった場合は更新。`screenshots/` を確認 |
| データ取得0件 | STORES 画面の仕様変更の可能性。`screenshots/` のスクリーンショットを確認 |
| Google API 403 エラー | フォルダがサービスアカウントと共有されているか確認（編集者権限）。Sheets API / Drive API が有効か確認 |
| Google API 404 エラー | `GOOGLE_DRIVE_FOLDER_ID` が正しいか確認。共有ドライブの場合はアクセス権を確認 |
| Slack 投稿エラー | `DEST_BOT_TOKEN` の有効性確認。Bot がチャンネルに招待されているか確認 |
| GitHub Actions 失敗 | Secrets が全て正しく設定されているか確認。Actions タブでログを確認。`screenshots` アーティファクトをダウンロードして状態確認 |

---

最終更新: 2026年3月13日
