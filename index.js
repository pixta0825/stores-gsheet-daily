// index.js
// STORES POS データ取得 → Google Spreadsheet アップロード → Slack通知 を一括実行
// ────────────────────────────────────────────────────────────

const { execSync } = require('child_process');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');

function log(msg) {
  const ts = new Date().toLocaleTimeString('ja-JP');
  console.log(`[${ts}] ${msg}`);
}

function run(script, description, extraArgs = '') {
  log(`▶ ${description}...`);
  const cmd = `node ${path.join(__dirname, script)}${extraArgs ? ' ' + extraArgs : ''}`;
  try {
    execSync(cmd, {
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

// 前月のYYYYMMを返す（JST基準の現在月から1つ前）
function computePrevMonth() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const mon = now.getMonth() === 0 ? 12 : now.getMonth(); // getMonth()は0始まり=前月の値
  return `${year}${String(mon).padStart(2, '0')}`;
}

async function main() {
  log('═══════════════════════════════════════════');
  log(' STORES POS → Google Spreadsheet + Slack');
  log(` 一括実行開始${DRY_RUN ? ' [DRY-RUN]' : ''}`);
  log('═══════════════════════════════════════════\n');

  const startTime = Date.now();

  try {
    // Step 0: 月初なら前月を締める
    // 月末日は完全データが翌月1日にしか取れず、その時には当月シートへ書かれてしまうため、
    // 毎月1日の実行時のみ、前月を last_month レンジで再取得して前月シートを上書きする。
    // Slack投稿はしない（当月の前日分のみ後段で投稿）。失敗しても当月処理は継続する。
    if (!DRY_RUN) {
      const jstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      if (jstNow.getDate() === 1) {
        const prevMonth = computePrevMonth();
        log(`📅 月初検知 → 前月(${prevMonth})の締め処理を先に実行`);
        try {
          run('fetch-stores-data.js', `前月締め: データ取得 (${prevMonth})`, `--month=${prevMonth} --date=last_month`);
          run('upload-gsheet.js', `前月締め: シート上書き (${prevMonth})`, `--month=${prevMonth}`);
        } catch (err) {
          log(`⚠️ 前月締め処理に失敗（当月処理は継続）: ${err.message}`);
        }
      }
    }

    // Step 1: STORES からデータ取得 → JSON 保存
    run('fetch-stores-data.js', 'STORES データ取得');

    if (DRY_RUN) {
      log('[DRY_RUN] Google Spreadsheet アップロード・Slack投稿をスキップ');
      // メッセージ生成のみ実行（プレビュー用）
      run('notify-slack.js', 'Slack メッセージ生成（プレビュー）');
    } else {
      // Step 2: Google Spreadsheet にアップロード
      run('upload-gsheet.js', 'Google Spreadsheet アップロード');

      // Step 3: Slack 通知メッセージ生成
      run('notify-slack.js', 'Slack メッセージ生成');

      // Step 4: yasumi ワークスペースに投稿
      run('post-to-slack.js', 'Slack 投稿');

      // Step 5-6: 月曜なら週次サマリーも投稿
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      if (now.getDay() === 1) {
        log('📅 月曜日 → 週次サマリーを追加投稿');
        run('notify-slack-weekly.js', '週次サマリー生成');
        run('post-to-slack.js', '週次サマリー投稿');
      }
    }

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
