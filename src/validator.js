/**
 * 请求抢占后的 KV 缓存与输出恢复验证器（纯状态模拟）。
 *
 * 核心不变量：
 *  - 已交付客户端的内容（outputOffset 之前的 token）不能重发；
 *  - 未完成请求只能从最后一个一致 token（缓存连续覆盖的最长前缀）继续；
 *  - 共享缓存块（refs > 1）只能解除引用，不能释放。
 */

export const PREEMPTION_REASONS = Object.freeze([
  'higher-priority',
  'memory-pressure',
  'cancelled',
  'stream-disconnected',
  'cache-corrupted',
]);

export const RECOVERY_EVENTS = Object.freeze(['resume', 'reconnect', 'cancel']);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function normalizeBlock(block, index) {
  if (!block || typeof block.id !== 'string' || block.id.length === 0) {
    throw new ValidationError(`cacheBlocks[${index}] 缺少字符串 id`);
  }
  const { id, start, length } = block;
  const refs = block.refs ?? 1;
  if (!Number.isInteger(start) || start < 0) {
    throw new ValidationError(`缓存块 ${id} 的 start 必须是非负整数`);
  }
  if (!Number.isInteger(length) || length <= 0) {
    throw new ValidationError(`缓存块 ${id} 的 length 必须是正整数`);
  }
  if (!Number.isInteger(refs) || refs <= 0) {
    throw new ValidationError(`缓存块 ${id} 的 refs 必须是正整数`);
  }
  return { id, start, length, refs, end: start + length };
}

/**
 * 创建请求快照。
 * @param {object} spec
 * @param {string} spec.id 请求 id
 * @param {number} spec.priority 优先级（数值越大优先级越高）
 * @param {number} spec.generatedTokens 已生成 token 数
 * @param {Array}  [spec.cacheBlocks] KV 缓存块 [{id, start, length, refs}]
 * @param {number} [spec.outputOffset] 已交付客户端的 token 数
 */
export function createRequest(spec) {
  if (!spec || typeof spec.id !== 'string' || spec.id.length === 0) {
    throw new ValidationError('请求缺少字符串 id');
  }
  const { id, priority, generatedTokens } = spec;
  const outputOffset = spec.outputOffset ?? 0;
  if (!Number.isFinite(priority)) {
    throw new ValidationError(`请求 ${id} 的 priority 必须是数值`);
  }
  if (!Number.isInteger(generatedTokens) || generatedTokens < 0) {
    throw new ValidationError(`请求 ${id} 的 generatedTokens 必须是非负整数`);
  }
  if (!Number.isInteger(outputOffset) || outputOffset < 0) {
    throw new ValidationError(`请求 ${id} 的 outputOffset 必须是非负整数`);
  }
  if (outputOffset > generatedTokens) {
    throw new ValidationError(
      `请求 ${id} 的 outputOffset(${outputOffset}) 不能超过 generatedTokens(${generatedTokens})`,
    );
  }
  const blocks = (spec.cacheBlocks ?? []).map(normalizeBlock);
  const seen = new Set();
  for (const b of blocks) {
    if (seen.has(b.id)) throw new ValidationError(`缓存块 id 重复: ${b.id}`);
    seen.add(b.id);
  }
  blocks.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  return {
    id,
    priority,
    generatedTokens,
    outputOffset,
    cacheBlocks: blocks,
    state: 'running',
    preemption: null,
    plan: null,
  };
}

/** 缓存块从 token 0 开始连续覆盖的最长前缀长度。 */
export function consistentPrefix(cacheBlocks) {
  let covered = 0;
  for (const b of cacheBlocks) {
    if (b.start > covered) break;
    covered = Math.max(covered, b.end);
  }
  return covered;
}

/** 回收全部缓存块；共享块仅解除引用。 */
function rollbackAll(blocks) {
  return blocks.map((b) =>
    b.refs > 1
      ? { blockId: b.id, action: 'detach', refs: b.refs - 1 }
      : { blockId: b.id, action: 'release' },
  );
}

/** 回滚 keepPoint 之后的缓存：截断跨界块，释放/解除其后的块。 */
function rollbackBeyond(blocks, keepPoint) {
  const out = [];
  for (const b of blocks) {
    if (b.end <= keepPoint) {
      out.push({ blockId: b.id, action: 'retain' });
    } else if (b.start < keepPoint) {
      out.push({ blockId: b.id, action: 'truncate', newLength: keepPoint - b.start });
    } else if (b.refs > 1) {
      out.push({ blockId: b.id, action: 'detach', refs: b.refs - 1 });
    } else {
      out.push({ blockId: b.id, action: 'release' });
    }
  }
  return out;
}

export class PreemptionValidator {
  constructor() {
    this.requests = new Map();
  }

  addRequest(spec) {
    const req = createRequest(spec);
    if (this.requests.has(req.id)) {
      throw new ValidationError(`请求 id 重复: ${req.id}`);
    }
    this.requests.set(req.id, req);
    return req;
  }

  #get(id) {
    const req = this.requests.get(id);
    if (!req) throw new ValidationError(`未知请求: ${id}`);
    return req;
  }

  /**
   * 记录一次抢占。
   * @param {string} requestId 被抢占的低优先级请求
   * @param {object} opts
   * @param {string} opts.reason 抢占原因（见 PREEMPTION_REASONS）
   * @param {string} [opts.preemptedBy] 发起抢占的高优先级请求 id
   */
  preempt(requestId, { reason, preemptedBy } = {}) {
    const req = this.#get(requestId);
    if (req.state !== 'running') {
      throw new ValidationError(`请求 ${requestId} 当前状态为 ${req.state}，无法抢占`);
    }
    if (!PREEMPTION_REASONS.includes(reason)) {
      throw new ValidationError(`未知抢占原因: ${reason}`);
    }
    if (preemptedBy !== undefined) {
      const other = this.#get(preemptedBy);
      if (other.priority <= req.priority) {
        throw new ValidationError(
          `抢占者 ${preemptedBy}(priority=${other.priority}) 优先级必须高于 ${requestId}(priority=${req.priority})`,
        );
      }
    }
    req.state = 'preempted';
    req.preemption = { reason, preemptedBy: preemptedBy ?? null };
    return req.preemption;
  }

  /**
   * 计算恢复计划（幂等：重复恢复返回缓存的计划并标记 duplicate）。
   * @param {string} requestId
   * @param {string} event 'resume' | 'reconnect' | 'cancel'
   */
  recover(requestId, event) {
    const req = this.#get(requestId);
    if (!RECOVERY_EVENTS.includes(event)) {
      throw new ValidationError(`未知恢复事件: ${event}`);
    }
    if (req.state === 'running') {
      throw new ValidationError(`请求 ${requestId} 未被抢占，无需恢复`);
    }
    if (req.plan) {
      return { ...req.plan, duplicate: true };
    }
    const plan = this.#computePlan(req, event);
    req.plan = plan;
    req.state = plan.status === 'resumed' ? 'resumed' : plan.status;
    return plan;
  }

  #computePlan(req, event) {
    const reason = req.preemption.reason;
    const delivered = req.outputOffset;
    const cached = Math.min(consistentPrefix(req.cacheBlocks), req.generatedTokens);

    const base = {
      requestId: req.id,
      event,
      preemptionReason: reason,
      deliveredTokens: delivered,
      duplicate: false,
    };

    // 取消：抢占即取消，或恢复事件为 cancel —— 无需恢复，回收缓存。
    if (reason === 'cancelled' || event === 'cancel') {
      return {
        ...base,
        status: 'cancelled',
        resumeFrom: null,
        streamFrom: null,
        cacheRollback: rollbackAll(req.cacheBlocks),
      };
    }

    // 缓存损坏：无法信任任何前缀，不可恢复。
    if (reason === 'cache-corrupted') {
      return {
        ...base,
        status: 'unrecoverable',
        unrecoverableReason: 'cache-corrupted',
        resumeFrom: null,
        streamFrom: null,
        cacheRollback: rollbackAll(req.cacheBlocks),
      };
    }

    // 客户端已交付内容超过缓存一致前缀：继续生成会重发或错乱前缀。
    if (delivered > cached) {
      return {
        ...base,
        status: 'unrecoverable',
        unrecoverableReason: 'delivered-beyond-consistent-prefix',
        resumeFrom: null,
        streamFrom: null,
        cacheRollback: rollbackAll(req.cacheBlocks),
      };
    }

    return {
      ...base,
      status: 'resumed',
      resumeFrom: cached, // 生成从最后一致 token 继续
      streamFrom: delivered, // 已交付部分不重发，只补发 [delivered, cached)
      cacheRollback: rollbackBeyond(req.cacheBlocks, cached),
    };
  }
}
