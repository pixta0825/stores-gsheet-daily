// post-to-slack.js
// yasumiワークスペースのチャンネルに売上レポートを投稿する
// ────────────────────────────────────────────────────────────
// 使い方:
//   node post-to-slack.js            → テキスト通知
//   node post-to-slack.js --dry-run  → 送信せずプレビュー

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { WebClient } = require('@slack/web-api');

// ── CLI引数 ──
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

// ── 設定 ──
const DEST_BOT_TOKEN = process.env.DEST_BOT_TOKEN;
const DEST_CHANNEL_ID = process.env.DEST_CHANNEL_ID || 'C0A6RB6JGMV';

if (!DEST_BOT_TOKEN) {
  console.error('❌ DEST_BOT_TOKEN が .env に設定されていません');
  process.exit(1);
}

const client = new WebClient(DEST_BOT_TOKEN);

// ── テキスト送信 ──
async function sendText() {
  const msgPath = path.join(__dirname, 'slack_message.txt');
  if (!fs.existsSync(msgPath)) {
    console.error('❌ slack_message.txt がありません。先に node notify-slack.js を実行してください');
    return false;
  }

  const message = fs.readFileSync(msgPath, 'utf-8');
  console.log('📝 テキストメッセージ:');
  console.log(message);

  if (DRY_RUN) {
    console.log('🔍 [DRY_RUN] テキスト送信スキップ');
    return true;
  }

  try {
    const result = await client.chat.postMessage({
      channel: DEST_CHANNEL_ID,
      text: message,
    });
    console.log(`✅ テキスト送信完了 → ${DEST_CHANNEL_ID} (ts: ${result.ts})`);
    return true;
  } catch (err) {
    console.error(`❌ テキスト送信失敗: ${err.message}`);
    if (err.data) console.error(`   詳細: ${JSON.stringify(err.data)}`);
    return false;
  }
}

// ── メイン ──
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log(' yasumiワークスペース 売上レポート投稿');
  console.log(`  チャンネル: ${DEST_CHANNEL_ID}`);
  console.log(`  モード: ${DRY_RUN ? 'DRY_RUN' : '本番'}`);
  console.log('═══════════════════════════════════════════\n');

  // Bot認証確認
  try {
    const auth = await client.auth.test();
    console.log(`🤖 Bot認証OK: ${auth.user} (${auth.team})\n`);
  } catch (err) {
    console.error(`❌ Bot認証失敗: ${err.message}`);
    process.exit(1);
  }

  const ok = await sendText();

  console.log('\n═══════════════════════════════════════════');
  if (ok) {
    console.log(' ✅ 完了');
  } else {
    console.log(' ⚠️  失敗あり（上記ログを確認）');
    process.exit(1);
  }
  console.log('═══════════════════════════════════════════');
}

main();
