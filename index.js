// index.js
// STORES POS データ取得 → Google Spreadsheet アップロード → Slack通知 を一括実行
// ────────────────────────────────────────────────────────────

const { execSync } = require('child_process');
const path = require('path');

function log(msg) {
  const ts = new Date().toLocaleTimeString('ja-JP');
  console.log(`[${ts}] ${msg}`);
}

function run(script, description) {
  log(`▶ ${description}...`);
  try {
    execSync(`node ${path.join(__dirname, script)}`, {
      stdio: 'inherit',
      env: process.env,
      cwd: __dirname,
    });
    log(`✅ ${description} 完了\n`);
  } catch (err) {
    log(`❌ ${description} 失敗`);
    throw err;
  }
}

async function main() {
  log('═══════════════════════════════════════════');
  log(' STORES POS → Google Spreadsheet + Slack');
  log(' 一括実行開始');
  log('═══════════════════════════════════════════\n');

  const startTime = Date.now();

  try {
    // Step 1: STORES からデータ取得 → JSON 保存
    run('fetch-stores-data.js', 'STORES データ取得');

    // Step 2: Google Spreadsheet にアップロード
    run('upload-gsheet.js', 'Google Spreadsheet アップロード');

    // Step 3: Slack 通知メッセージ生成
    run('notify-slack.js', 'Slack メッセージ生成');

    // Step 4: yasumi ワークスペースに投稿
    run('post-to-slack.js', 'Slack 投稿');

  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`\n❌ エラーで中断 (${elapsed}秒経過)`);
    process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('═══════════════════════════════════════════');
  log(` ✅ 全処理完了 (${elapsed}秒)`);
  log('═══════════════════════════════════════════');
}

main();
