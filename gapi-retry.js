// gapi-retry.js
// Google API 呼び出しを 429 / クォータ超過 / レート制限 / 一時的なネットワーク障害のときに
// 指数バックオフで再試行する。
//
// 背景:
//   GOOGLE_CREDENTIALS のサービスアカウントは他ジョブ(stores-gsheet-daily / kot 等)と共有のため、
//   毎朝の同時実行帯に Sheets API の「1分あたり書き込み/読み取り」枠を取り合って 429 になることがある。
//   1分窓はリセットされるので、少し待って再試行すれば回復する（2026-06-12 の sheets 書込失敗の根本対処）。
//   加えて、認証トークン取得(oauth2/token)時の "Premature close" など一時的な回線切れでも失敗するため、
//   ネットワーク系の一時障害も再試行対象に含める（2026-06-25 yasumi-reservation-daily の失敗を受けた横展開）。

// 一時的なネットワーク障害を表すエラーコード（HTTPステータスを持たず err.code に文字列が入る）。
const TRANSIENT_NET_CODES = [
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
  'ECONNREFUSED', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
];

// 再試行すべきエラーか判定する（クォータ超過・レート制限・一時的なサーバ混雑・一時的なネットワーク障害）
function isRetryable(err) {
  if (!err) return false;
  // googleapis は HTTPステータスを err.code に数値で入れる。ネットワーク系は err.code に文字列が入る。
  const httpStatus = typeof err.code === 'number' ? err.code : (err.response && err.response.status);
  const netCode = typeof err.code === 'string' ? err.code : '';
  const msg = err.message || '';

  // --- HTTPステータス由来: レート制限・サーバ一時障害 ---
  if (httpStatus === 429 || httpStatus === 500 || httpStatus === 503) return true;
  // 403 でも rateLimitExceeded / userRateLimitExceeded の場合は再試行対象
  if (httpStatus === 403 && /rate.?limit/i.test(msg)) return true;
  if (/quota exceeded|rate.?limit|try again later|backend error/i.test(msg)) return true;

  // --- ネットワーク一時障害: 接続切断・タイムアウト・DNS一時失敗・トークン取得時のPremature close等 ---
  if (TRANSIENT_NET_CODES.includes(netCode)) return true;
  if (/premature close|socket hang ?up|network ?error|invalid response body|connection (reset|closed|refused)|fetch failed|request to .* failed|timeout/i.test(msg)) return true;

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
      console.log(`[${ts}] ⏳ ${label}: 一時エラー(レート制限/ネットワーク等) (${code}) — ${Math.round(wait / 1000)}秒待って再試行 (${attempt}/${maxRetries})`);
      await sleep(wait);
    }
  }
}

module.exports = { withRetry, isRetryable };
