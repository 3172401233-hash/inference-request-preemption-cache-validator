#!/usr/bin/env node
/**
 * CLI：读取场景 JSON（文件路径或 stdin），输出每个被抢占请求的恢复计划。
 *
 * 场景格式：
 * {
 *   "requests": [{ id, priority, generatedTokens, cacheBlocks, outputOffset }],
 *   "events": [
 *     { "type": "preempt", "requestId": "r1", "reason": "higher-priority", "preemptedBy": "r2" },
 *     { "type": "recover", "requestId": "r1", "event": "resume" }
 *   ]
 * }
 */
import { readFileSync } from 'node:fs';
import { PreemptionValidator, ValidationError } from './validator.js';

function readInput(argv) {
  const path = argv[2];
  if (path && path !== '-') return readFileSync(path, 'utf8');
  return readFileSync(0, 'utf8'); // stdin
}

function main() {
  const scenario = JSON.parse(readInput(process.argv));
  const validator = new PreemptionValidator();
  for (const spec of scenario.requests ?? []) validator.addRequest(spec);

  const results = [];
  for (const ev of scenario.events ?? []) {
    if (ev.type === 'preempt') {
      results.push({
        type: 'preempt',
        requestId: ev.requestId,
        ...validator.preempt(ev.requestId, {
          reason: ev.reason,
          preemptedBy: ev.preemptedBy,
        }),
      });
    } else if (ev.type === 'recover') {
      results.push({ type: 'recover', ...validator.recover(ev.requestId, ev.event) });
    } else {
      throw new ValidationError(`未知事件类型: ${ev.type}`);
    }
  }
  process.stdout.write(JSON.stringify({ plans: results }, null, 2) + '\n');
}

try {
  main();
} catch (err) {
  if (err instanceof ValidationError) {
    process.stderr.write(`校验失败: ${err.message}\n`);
    process.exit(2);
  }
  throw err;
}
