# Kimi Code 缓存预热与结果引用

## 目标与边界

`src/host/cache-warmup/` 是本项目内的独立子包，目标是让 Kimi Code 在保持缓存前缀稳定的前提下，尽快形成高命中缓存，并只压缩能够证明语义完整的新工具结果。

它不是新的缓存协议，也不修改 DSH。以下现有机制保持不变：

- `promptCacheKey`、会话路由、请求构造与 replay；
- 动态工具的 `in-history` 更新；
- Kimi 的漂移检测、统计、重试与账号轮换；
- 已进入历史的任何消息、preview 或 `refId`。

## 组成部分

| 模块 | 职责 |
| --- | --- |
| `store.ts` | 内容寻址的原文存储、幂等写入、UTF-8 安全分页、会话归属校验 |
| `projection.ts` | 保守识别可完整提取的信息，生成带引用的 preview |
| `usage.ts` | 有界记录真实 input/cacheRead，命中率与生命周期状态 |
| `budget.ts` | 预热预算、稳态预算和只读快照 |
| `install.ts` | `tools/post-execute`、静态提示、设置与安装释放 |
| `result-tool.ts` | `cache_warmup_result` 精确补读与释放 |
| `logging.ts` | 不含原文、凭据、路径或异常 message 的结构化指标 |

## 缓存安全不变量

1. 只处理当前新产生的工具结果，不回改旧历史。
2. 原始 `value` 不变，只替换模型可见的 `content` 投影。
3. preview 和 refId 一旦写入历史就不再变化；原文过期、淘汰或释放不会改写 preview。
4. 非文本块原样保留；非 Kimi 线路、非 `run_code`、无法确认会话的结果不变。
5. 不自动重热、不重写前缀、不因为命中率下降而重建会话。
6. `stable` 与 `first-request` 是正常生命周期状态，不是漂移；`tools`、`system-prompt` 等真实漂移会重置连续命中。

## 投影策略

小结果原样通过。大结果只有在能可靠提取时才生成 preview：

- 测试日志：完整失败集合与汇总；装不下完整失败集合时回退原文。
- Shell 日志：退出码与完整错误集合。
- grep/glob：计数、分布和有限样本，完整原文通过 ref 补读。
- JSON Lines / TSV：字段、行数与分页信息。

以下内容不改写：

- 源码、接口和类型定义；
- 完整 JSON 文档及被宿主截断的 JSON 对象；
- 子代理报告、混合证据和无法可靠解析的大文本；
- 含 `value` 的后续决策、非 `accept` 决策和非文本块。

这套策略优先保证信息准确，不追求对所有大结果都压缩。对最初分析的 110 条真实工具结果，最终只有一条真实测试失败日志被投影，其余源码和混合证据均保持原文。

## 预热预算

命中率按以下公式计算：

```text
cacheReadTokens / (inputTokens + cacheReadTokens)
```

- 预热期：`maxChars = 1200`，约 512–1024 tokens 的保守新增预算。
- 连续两次请求命中率达到 97%，且没有真实漂移后，进入 `maxChars = 8000` 的稳态预算。
- 真实漂移立即清零连续命中，下一条结果回到保守预算。
- 控制器只读用量，不发请求、不改消息；登记和读侧均为非抛出路径，避免影响 adapter 的 `finally`。

97% 是内部退出阈值。必须连续两次达标，单次达到 97% 不会立即退出；真实 drift 仍会清零。

## 原文引用与补读

引用形式：`ref://<session>/<sha256>`。

`cache_warmup_result` 支持：

- `action: "page"`：按 `offset`、`limit`、`maxBytes`、`fields`、`equals` 精确读取；
- `action: "release"`：删除一条原文副本，历史 preview 不变。

文本模式的 offset 是 UTF-8 字节偏移；结构化模式是过滤后的行下标。每页都报告 `complete`、`nextOffset` 和 `omitted`，模型不得把不完整页面当成完整结果。

默认存储位置为 `<DSH_HOME>/storages/cache-warmup`：

- 单结果上限 8 MiB；每 session 总量上限 64 MiB；
- 原子写入，尽量使用 0600 权限；
- 超限按 mtime 逐个删除具体文件，不使用递归删除；
- 会话不匹配时，在接触文件系统前拒绝读取。

## 设置与日志

现有设置页新增 `cacheWarmup`，默认开启。开关只影响之后的新结果，既有历史不变。

结构化日志记录投影策略、输入/输出字符数、ref 补读和预热退出。异常只记录稳定的 name/code，不记录异常 message、原文、凭据或文件路径。

## 验证

- 六份相关测试：104 passed / 1 skipped（Windows 不保留 Unix mode 位）。
- 完整类型检查：通过。
- 全套 Vitest：309 files passed / 2 skipped，5093 passed / 9 skipped。
- `npm run build`、`npm pack --dry-run`、`npm ci --dry-run`：通过。
- 真实会话 110 条工具结果重放：只有一条测试失败日志被投影，混合证据不再误分类。
- 最多三次真实 k3.1-pro 请求：
  - 第一次：1794 uncached input tokens；
  - 第二次：43 uncached + 1792 cached，命中率 97.66%，达到 97% 目标，但只形成一次连续达标，未满足连续两次；
  - 第三次：84 uncached + 1792 cached，命中率 95.52%，控制器继续保持保守预算。

真实测试未在三次额度内证明进入稳态；稳态退出逻辑由单元测试覆盖。不得把这组结果描述为“已实测进入稳态”。
