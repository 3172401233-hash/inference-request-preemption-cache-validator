import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PreemptionValidator,
  ValidationError,
  consistentPrefix,
} from '../src/validator.js';

function setup() {
  const v = new PreemptionValidator();
  v.addRequest({
    id: 'low',
    priority: 1,
    generatedTokens: 48,
    outputOffset: 16,
    cacheBlocks: [
      { id: 'a', start: 0, length: 16 },
      { id: 'b', start: 16, length: 16 },
      { id: 'c', start: 32, length: 16 },
    ],
  });
  v.addRequest({ id: 'high', priority: 10, generatedTokens: 4, cacheBlocks: [] });
  return v;
}

test('高优先级抢占后从最后一致 token 恢复，已交付内容不重发', () => {
  const v = setup();
  v.preempt('low', { reason: 'higher-priority', preemptedBy: 'high' });
  const plan = v.recover('low', 'resume');

  assert.equal(plan.status, 'resumed');
  assert.equal(plan.resumeFrom, 48); // 缓存完整覆盖 48 个 token
  assert.equal(plan.streamFrom, 16); // 只补发 [16, 48)
  assert.deepEqual(
    plan.cacheRollback.map((r) => r.action),
    ['retain', 'retain', 'retain'],
  );
});

test('缓存前缀有空洞时回滚到一致前缀并截断跨界块', () => {
  const v = new PreemptionValidator();
  v.addRequest({
    id: 'low',
    priority: 1,
    generatedTokens: 48,
    outputOffset: 8,
    cacheBlocks: [
      { id: 'a', start: 0, length: 20 }, // 覆盖 [0,20)
      { id: 'c', start: 32, length: 16 }, // [20,32) 缺失
    ],
  });
  assert.equal(consistentPrefix(v.requests.get('low').cacheBlocks), 20);

  v.preempt('low', { reason: 'memory-pressure' });
  const plan = v.recover('low', 'resume');

  assert.equal(plan.status, 'resumed');
  assert.equal(plan.resumeFrom, 20);
  assert.deepEqual(plan.cacheRollback, [
    { blockId: 'a', action: 'retain' },
    { blockId: 'c', action: 'release' },
  ]);
});

test('抢占中取消：回收全部缓存，共享块仅解除引用', () => {
  const v = new PreemptionValidator();
  v.addRequest({
    id: 'low',
    priority: 1,
    generatedTokens: 32,
    outputOffset: 0,
    cacheBlocks: [
      { id: 'shared', start: 0, length: 16, refs: 2 },
      { id: 'own', start: 16, length: 16 },
    ],
  });
  v.preempt('low', { reason: 'higher-priority' });
  const plan = v.recover('low', 'cancel');

  assert.equal(plan.status, 'cancelled');
  assert.equal(plan.resumeFrom, null);
  assert.deepEqual(plan.cacheRollback, [
    { blockId: 'shared', action: 'detach', refs: 1 },
    { blockId: 'own', action: 'release' },
  ]);
  assert.equal(v.requests.get('low').state, 'cancelled');
});

test('抢占原因即取消时，任何恢复事件都按取消处理', () => {
  const v = setup();
  v.preempt('low', { reason: 'cancelled' });
  const plan = v.recover('low', 'resume');
  assert.equal(plan.status, 'cancelled');
  assert.ok(plan.cacheRollback.every((r) => r.action === 'release'));
});

test('缓存共享：回滚共享块时 detach 而非 release', () => {
  const v = new PreemptionValidator();
  v.addRequest({
    id: 'low',
    priority: 1,
    generatedTokens: 24,
    outputOffset: 0,
    cacheBlocks: [
      { id: 'shared-prefix', start: 0, length: 16, refs: 3 },
      { id: 'tail', start: 16, length: 8 },
    ],
  });
  // 一致前缀只有 16（缓存只覆盖到 24 中的 16？不，覆盖到 24）
  // 改为：generatedTokens=24，缓存覆盖 24，无回滚。构造前缀缺失场景：
  const req = v.requests.get('low');
  req.cacheBlocks.splice(1, 1); // 移除 tail，一致前缀 = 16

  v.preempt('low', { reason: 'memory-pressure' });
  const plan = v.recover('low', 'resume');

  assert.equal(plan.resumeFrom, 16);
  assert.deepEqual(plan.cacheRollback, [{ blockId: 'shared-prefix', action: 'retain' }]);

  // 取消场景下共享块 detach
  const v2 = new PreemptionValidator();
  v2.addRequest({
    id: 'low',
    priority: 1,
    generatedTokens: 16,
    cacheBlocks: [{ id: 'shared-prefix', start: 0, length: 16, refs: 3 }],
  });
  v2.preempt('low', { reason: 'cancelled' });
  const cancelPlan = v2.recover('low', 'cancel');
  assert.deepEqual(cancelPlan.cacheRollback, [
    { blockId: 'shared-prefix', action: 'detach', refs: 2 },
  ]);
});

test('输出流断线：已交付偏移不超过一致前缀时可重连恢复', () => {
  const v = setup();
  v.preempt('low', { reason: 'stream-disconnected' });
  const plan = v.recover('low', 'reconnect');

  assert.equal(plan.status, 'resumed');
  assert.equal(plan.streamFrom, 16); // 客户端已收到的 16 个 token 不重发
  assert.equal(plan.resumeFrom, 48);
});

test('输出流断线：已交付内容超过一致前缀时不可恢复', () => {
  const v = new PreemptionValidator();
  v.addRequest({
    id: 'low',
    priority: 1,
    generatedTokens: 48,
    outputOffset: 40, // 客户端已收到 40 个 token
    cacheBlocks: [{ id: 'a', start: 0, length: 32 }], // 缓存只一致到 32
  });
  v.preempt('low', { reason: 'stream-disconnected' });
  const plan = v.recover('low', 'reconnect');

  assert.equal(plan.status, 'unrecoverable');
  assert.equal(plan.unrecoverableReason, 'delivered-beyond-consistent-prefix');
  assert.deepEqual(plan.cacheRollback, [{ blockId: 'a', action: 'release' }]);
});

test('缓存损坏不可恢复', () => {
  const v = setup();
  v.preempt('low', { reason: 'cache-corrupted' });
  const plan = v.recover('low', 'resume');

  assert.equal(plan.status, 'unrecoverable');
  assert.equal(plan.unrecoverableReason, 'cache-corrupted');
});

test('重复恢复幂等：返回相同计划并标记 duplicate，不产生二次回滚', () => {
  const v = setup();
  v.preempt('low', { reason: 'higher-priority', preemptedBy: 'high' });
  const first = v.recover('low', 'resume');
  const second = v.recover('low', 'resume');
  const third = v.recover('low', 'cancel'); // 即使事件不同也不改变已生效计划

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(third.duplicate, true);
  assert.deepEqual(
    { ...second, duplicate: false },
    { ...first, duplicate: false },
  );
  assert.equal(v.requests.get('low').state, 'resumed');
});

test('非法操作校验', () => {
  const v = setup();
  // 未被抢占就恢复
  assert.throws(() => v.recover('low', 'resume'), ValidationError);
  // 低优先级不能抢占高优先级
  assert.throws(
    () => v.preempt('high', { reason: 'higher-priority', preemptedBy: 'low' }),
    ValidationError,
  );
  // 未知原因 / 未知请求 / 重复 id
  assert.throws(() => v.preempt('low', { reason: 'unknown' }), ValidationError);
  assert.throws(() => v.preempt('ghost', { reason: 'cancelled' }), ValidationError);
  assert.throws(
    () => v.addRequest({ id: 'low', priority: 2, generatedTokens: 1 }),
    ValidationError,
  );
  // outputOffset 不能超过已生成 token
  assert.throws(
    () =>
      v.addRequest({ id: 'bad', priority: 1, generatedTokens: 4, outputOffset: 5 }),
    ValidationError,
  );
});
