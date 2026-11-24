# inference-request-preemption-cache-validator
验证请求抢占后的 KV 缓存和输出恢复

> **说明：本仓库是纯状态模拟器，不调用任何真实推理引擎。**
> 它不加载模型、不执行 token 生成，只根据输入的请求快照（优先级、已生成
> token 数、缓存块、输出偏移）和抢占/恢复事件，计算恢复位置与缓存引用，
> 用于验证调度器在抢占场景下的缓存回滚与输出恢复逻辑是否正确。

## 背景

高优先级请求抢占低优先级请求后，低优先级请求已生成的 KV 缓存和部分输出
需要恢复。错误复用被抢占请求的缓存会让输出前缀错乱。本工具校验两条不变量：

- 已交付客户端的内容（`outputOffset` 之前的 token）不能重发；
- 未完成请求只能从最后一个一致 token（缓存块连续覆盖的最长前缀）继续。

## 输入

场景 JSON（见 `examples/preemption-scenario.json`）：

- `requests[]`：`id`、`priority`（越大越高）、`generatedTokens`、
  `cacheBlocks`（`{id, start, length, refs}`，`refs > 1` 表示共享块）、
  `outputOffset`（已交付客户端的 token 数）；
- `events[]`：
  - `preempt`：`reason` ∈ `higher-priority | memory-pressure | cancelled |
    stream-disconnected | cache-corrupted`，可选 `preemptedBy`（校验优先级）；
  - `recover`：`event` ∈ `resume | reconnect | cancel`。

## 输出

每个被抢占请求的恢复计划：

- `status`：`resumed` / `cancelled` / `unrecoverable`；
- `resumeFrom`：生成恢复位置（最后一致 token）；`streamFrom`：补发起点
  （已交付部分不重发）；
- `cacheRollback`：逐块的 `retain | truncate | release | detach`
  （共享块只解除引用，不释放）；
- 不可恢复情形：缓存损坏（`cache-corrupted`）、已交付偏移超过一致前缀
  （`delivered-beyond-consistent-prefix`）。

恢复是幂等的：对同一请求重复恢复返回首个计划并标记 `duplicate: true`，
不会产生二次回滚。

## 使用

```bash
node src/cli.js examples/preemption-scenario.json   # 或 cat scenario.json | node src/cli.js
node --test                                          # 运行测试（Node.js 24.16.0）
```

测试覆盖：抢占中取消、缓存共享、输出流断线、重复恢复、前缀空洞回滚、
缓存损坏与非法操作校验。
