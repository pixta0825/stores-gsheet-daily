// REQ-1017: 販売チャネル 69ae3f73… は 2026年11月分以降「YY新宿」。10月以前は従来表記のまま。
const assert = require('assert');
const { storesForMonth, officialNameOf } = require('../store-names');
const { CLOSED_SALES_CHANNELS } = require('../sync-stores-master');
const ID = '69ae3f7326307605f0833d2f';
const base = [{ name: 'ぬいぬいぬい', slug: 'yyhands_shinjuku', salesChannelId: ID, prevName: 'Coppice吉祥寺' }];
assert.strictEqual(officialNameOf(base[0]), 'YY新宿');
assert.ok(!CLOSED_SALES_CHANNELS[ID], '閉店扱いが外れている');
const nov = storesForMonth(base, '202611')[0];
assert.strictEqual(nov.name, 'YY新宿');
assert.strictEqual(nov.prevName, '吉祥寺', '11月シートの吉祥寺タブはYY新宿へ改名される');
for (const m of ['202608', '202609', '202610']) assert.strictEqual(storesForMonth(base, m)[0].name, 'ぬいぬいぬい', `${m}は11月切替前＝書き換えない`);
console.log('test-yy-shinjuku: OK');
