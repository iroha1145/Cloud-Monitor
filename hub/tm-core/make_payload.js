'use strict';

// 用 vendored 官方源码生成/规范化测试载荷：stdin 传入原始 spec JSON，
// stdout 输出经过官方 mergeDeviceRecord() 处理的设备记录（periods 形态，
// 官方 ingest 的 sanitizeUsagePeriods 同时接受 periods 与顶层两种形态）。
// 差分测试的输入由此由官方代码实际产生，而非手写近似。

const { mergeDeviceRecord } = require('./vendor/src/shared/usage.js');

const spec = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const record = mergeDeviceRecord(undefined, {
  receivedAt: new Date().toISOString(),
  ...spec,
});
process.stdout.write(JSON.stringify(record));
