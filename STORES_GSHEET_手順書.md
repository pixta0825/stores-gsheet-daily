# STORES POS 売上データ → Google Spreadsheet 自動取得 手順書

STORES POS の売上データ（今月・日別・全店舗）を毎日自動取得し、Google Spreadsheet に出力、Slack に売上レポートを通知するシステムの構築手順。

---

## 1. 前提条件

| 項目 | 要件 |
|---|---|
| Node.js | v18 以上 |
| STORES アカウント | POS 管理画面へのログイン権限 |
| Google Cloud アカウント | サービスアカウント作成用 |
| Slack Bot Token（yasumi） | `chat:write` スコープ付き |
| GitHub アカウント | リポジトリ・Actions 用 |


## 2. ファイル構成

```
stores-gsheet-daily/
├── .github/workflows/
│   └── daily-fetch.yml          ← GitHub Actions（毎日09:50 JST自動実行）
├── index.js                     ← メイン（一括実行）
├── fetch-stores-data.js         ← STORESスクレイピング本体
├── upload-gsheet.js             ← Google Spreadsheet書き込み
├── notify-slack.js              ← 売上サマリーメッセージ生成
├── post-to-slack.js             ← yasumiワークスペースへ投稿
├── config.js                    ← 店舗定義
├── package.json
├── .env.example
├── .gitignore
├── data/                        ← 中間JSON
├── screenshots/                 ← デバッグ用スクリーンショット
└── STORES_GSHEET_手順書.md
```


## 3. Google Cloud サービスアカウント作成

### 3-1. Google Cloud Console にアクセス

https://console.cloud.google.com/ にアクセスし、ログイン。

### 3-2. プロジェクト作成

1. 上部の「プロジェクトを選択」→「新しいプロジェクト」
2. プロジェクト名: `stores-gsheet-daily`（任意）
3. 「作成」をクリック

### 3-3. API を有効化

1. 左メニュー「APIとサービス」→「ライブラリ」
2. 以下の2つのAPIを検索して有効化:
   - **Google Sheets API**
   - **Google Drive API**

### 3-4. サービスアカウント作成

1. 左メニュー「APIとサービス」→「認証情報」
2. 「認証情報を作成」→「サービスアカウント」
3. サービスアカウント名: `stores-gsheet`（任意）
4. 「作成して続行」→ ロールは不要 →「完了」
5. 作成されたサービスアカウントをクリック
6. 「鍵」タブ →「鍵を追加」→「新しい鍵を作成」→ JSON → 「作成」
7. JSON ファイルがダウンロードされる（例: `stores-gsheet-daily-xxxxx.json`）

### 3-5. Google Drive フォルダの共有設定

1. Google Drive で対象フォルダを開く:
   https://drive.google.com/drive/u/0/folders/1ZiZE3bkB25aeeawQIPyiLazm_iabQJmj
2. フォルダ名を右クリック →「共有」→「ユーザーやグループを追加」
3. ダウンロードした JSON ファイル内の `client_email` の値を入力
   （例: `stores-gsheet@stores-gsheet-daily.iam.gserviceaccount.com`）
4. 権限を「**編集者**」に設定して「送信」


## 4. ローカルセットアップ

### 4-1. npm パッケージインストール

```bash
cd stores-gsheet-daily
npm install
```

### 4-2. Playwright ブラウザインストール

```bash
npx playwright install chromium
```

### 4-3. .env ファイルの作成

```bash
cp .env.example .env
```

`.env` を編集:

```
# STORES POS ログイン情報
STORES_EMAIL=your-email@example.com
STORES_PASSWORD=your-password

# Google サービスアカウント認証（JSON文字列を1行で）
# ダウンロードしたJSONファイルの中身をコピーして1行に整形
GOOGLE_CREDENTIALS={"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}

# Google Drive フォルダID
GOOGLE_DRIVE_FOLDER_ID=1ZiZE3bkB25aeeawQIPyiLazm_iabQJmj

# Slack Bot Token（yasumiワークスペース）
DEST_BOT_TOKEN=xoxb-your-bot-token

# Slack チャンネルID
DEST_CHANNEL_ID=C0A6RB6JGMV
```

**JSON文字列の作り方:**

```bash
# ダウンロードしたJSONファイルを1行に変換
cat path/to/downloaded-key.json | jq -c .
```

出力をそのまま `GOOGLE_CREDENTIALS=` の後に貼り付ける。


## 5. 実行方法

### 5-1. 一括実行

```bash
npm run all
```

以下が順に実行される:
1. STORESにログイン → 7店舗の売上データ取得 → JSON保存
2. Google Spreadsheetに書き込み（月ごとに1ファイル）
3. 前日売上のSlackメッセージ生成
4. yasumiワークスペースに投稿

### 5-2. 個別実行

```bash
# データ取得のみ
npm run fetch

# Google Spreadsheetアップロードのみ（要: 先にfetch実行）
npm run upload

# Slackメッセージ生成のみ
npm run notify

# Slack投稿のみ
npm run post
```


## 6. GitHub リポジトリ作成 + Actions 設定

### 6-1. リポジトリ作成

```bash
cd stores-gsheet-daily
git init
git add .
git commit -m "Initial commit: STORES POS → Google Spreadsheet + Slack"
```

GitHub で新規リポジトリ `stores-gsheet-daily` を作成（Private推奨）し、push:

```bash
git remote add origin https://github.com/YOUR_USER/stores-gsheet-daily.git
git branch -M main
git push -u origin main
```

### 6-2. GitHub Secrets 設定

リポジトリの Settings → Secrets and variables → Actions → New repository secret

| Secret名 | 値 |
|---|---|
| `STORES_EMAIL` | STORESログインメールアドレス |
| `STORES_PASSWORD` | STORESログインパスワード |
| `GOOGLE_CREDENTIALS` | サービスアカウントJSON文字列（1行） |
| `GOOGLE_DRIVE_FOLDER_ID` | `1ZiZE3bkB25aeeawQIPyiLazm_iabQJmj` |
| `DEST_BOT_TOKEN` | Slack Bot Token（yasumi） |
| `DEST_CHANNEL_ID` | `C0A6RB6JGMV` |

### 6-3. 動作確認

1. リポジトリの Actions タブを開く
2. 「STORES POS → Google Spreadsheet Daily」ワークフローを選択
3. 「Run workflow」で手動実行
4. 正常終了を確認


## 7. 対象店舗

| # | 店舗名 | slug |
|---|---|---|
| 1 | 全店舗 | all |
| 2 | YY HANDS名古屋 | yyhands_nagoya |
| 3 | YYHANDS東京 | yyhands_tokyo |
| 4 | YYHANDS大阪 | yyhands_osaka |
| 5 | YASUMI LAB名古屋 | yasumilab_nagoya |
| 6 | 2525ジュエリー名古屋 | 2525jewelry_nagoya |
| 7 | HELLO BONSAI CLUB | hello_bonsai |

店舗の追加・削除は `config.js` の `STORES` 配列を編集する。


## 8. スプレッドシート仕様

### 出力先

Google Drive フォルダ: https://drive.google.com/drive/u/0/folders/1ZiZE3bkB25aeeawQIPyiLazm_iabQJmj

### 命名規則

月ごとに1ファイル作成。同月内は毎日上書き更新。

| 月 | スプレッドシート名 |
|---|---|
| 2026年3月 | `STORES_売上_202603` |
| 2026年4月 | `STORES_売上_202604` |

### シート構成

店舗ごとに1シート（計7シート）。各シートのレイアウト:

| 行 | A列 | B〜K列 |
|---|---|---|
| 1 | ヘッダー | 純売上〜単価（10列） |
| 2 | 期間合計 | 合計値 |
| 3〜 | 日別（1日〜31日） | 日別値 |

カラム: 日付 / 純売上 / 純売上（税抜）/ 消費税 / 総売上 / 値引き / 返金額 / 販売点数 / 返品点数 / 件数 / 単価


## 9. Slack 通知

投稿先: yasumiワークスペース `C0A6RB6JGMV`

通知内容:
- 前日の全店舗合計（純売上・件数・単価）
- 店舗別実績（棒グラフ付き、売上降順）
- Google Spreadsheet のリンク


## 10. トラブルシューティング

| 症状 | 確認ポイント |
|---|---|
| ログイン失敗 | `STORES_EMAIL` / `STORES_PASSWORD` の確認。`screenshots/debug_login.html` を確認 |
| データ取得0件 | STORES画面の仕様変更。`screenshots/` のスクリーンショットを確認 |
| Google API エラー | `GOOGLE_CREDENTIALS` のJSON形式確認。API有効化確認。フォルダ共有設定確認 |
| Slack送信失敗 | `DEST_BOT_TOKEN` の有効性確認。チャンネルにBotが招待されているか確認 |
| GitHub Actions失敗 | Secrets設定の確認。Actions タブでログを確認 |

---

最終更新: 2026年3月11日
