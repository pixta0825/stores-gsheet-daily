// gapi-retry.js
// Google API 呼び出しを 429 / クォータ超過 / レート制限のときに指数バックオフで再試行する。
//
// 背景:
//   GOOGLE_CREDENTIALS のサービスアカウントは他ジョブ(stores-gsheet-daily / kot 等)と共有のため、
//   毎朝の同時実行帯に Sheets API の「1分あたり書き込み/読み取り」枠を取り合って 429 になることがある。
//   1分窓はリセットされるので、少し待って再試行すれば回復する（2026-06-12 の sheets 書込失敗の根本対処）。

// 再試行すべきエラーか判定する（クォータ超過・レート制限・一時的なサーバ混雑）
function isRetryable(err) {
  if (!err) return false;
  const status = err.code || (err.response && err.response.status);
  const msg = err.message || '';
  if (status === 429 || status === 500 || status === 503) return true;
  // 403 でも rateLimitExceeded / userRateLimitExceeded の場合は再試行対象
  if (status === 403 && /rate.?limit/i.test(msg)) return true;
  if (/quota exceeded|rate.?limit|try again later|backend error/i.test(msg)) return true;
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Google API 呼び出しを再試行付きで実行する。
 * @param {string} label   - ログ用のラベル（どのAPI呼び出しか）
 * @param {() => Promise<any>} fn - 実行する非同期関数（API呼び出し1回ぶん）
 * @param {object} [opts]
 * @param {number} [opts.maxRetries=5]
 * @param {number[]} [opts.delays] - 各再試行前の待機ミリ秒（1分窓のリセットを跨ぐよう最大60秒まで）
 */
async function withRetry(label, fn, opts = {}) {
  const maxRetries = opts.maxRetries != null ? opts.maxRetries : 5;
  const delays = opts.delays || [15000, 30000, 45000, 60000, 60000];
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxRetries) throw err;
      const base = delays[Math.min(attempt, delays.length - 1)];
      const jitter = Math.floor(Math.random() * 5000); // 0〜5秒のばらつきで他ジョブとの同時再試行を分散
      const wait = base + jitter;
      attempt += 1;
      const ts = new Date().toLocaleTimeString('ja-JP');
      const code = err.code || (err.response && err.response.status) || '';
      console.log(`[${ts}] ⏳ ${label}: APIレート制限/混雑 (${code}) — ${Math.round(wait / 1000)}秒待って再試行 (${attempt}/${maxRetries})`);
      await sleep(wait);
    }
  }
}

module.exports = { withRetry, isRetryable };
