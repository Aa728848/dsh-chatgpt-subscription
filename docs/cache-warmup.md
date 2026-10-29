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
| `retrieval-intent.ts` | 直接检索工具的保守导航意图判定；编辑、审查与未知意图回退 |
| `result-tool.ts` | `cache_warmup_result` 精确补读与释放 |
| `logging.ts` | 不含原文、凭据、路径或异常 message 的结构化指标 |

## 缓存安全不变量

1. 只处理当前新产生的工具结果，不回改旧历史。
2. 原日志路径的 `value` 不变，只替换模型可见的 `content`。独立检索开关开启且明确为导航任务时，`read` / `web_fetch` / `grep` / `glob` 若实际生成 preview，可以把结构化 `value` 转为内容预览；未生成 preview 时原决策逐字返回，原文始终先存入 ref。
3. preview 和 refId 一旦写入历史就不再变化；原文过期、淘汰或释放不会改写 preview。
4. 非文本块原样保留；非 Kimi 线路、非受控执行/日志工具（`run_code`、`win_bash`、`bash`、`pwsh`、`job_output`）、无法确认会话的结果不变。
5. 不自动重热、不重写前缀、不因为命中率下降而重建会话。
6. `stable` 与 `first-request` 是正常生命周期状态，不是漂移；`tools`、`system-prompt` 等真实漂移会重置连续命中。

## 投影策略

小结果原样通过。大结果只有在能可靠提取时才生成 preview：

- 测试日志：完整失败集合与汇总；装不下完整失败集合时回退原文。
- Shell / TypeScript 构建日志：退出码与完整错误集合（含 `error TSxxxx` 紧随其后的缩进类型差异详情行）。
- PTC `run_code` JSON Envelope：若外层是轻量 JSON 对象且仅包含单一超长白名单日志字段（`stdout`/`stderr`/`output`/`logs`/`log`），只将该字段值替换为 preview 并保留外层 JSON 结构；含多份源码或被截断的混合证据保持原样。
- grep/glob：计数、分布和有限样本，完整原文通过 ref 补读。
- 文件导航：只在明确导航意图下，列出可识别声明的完整集合与原始行号；编辑、审查和未知意图保持原文。PTC 的 Read JSON Envelope 必须具有唯一、连续、完整的 lines 数组，混合输出与契约仍保持原文。
- 网页导航：只在明确导航意图下，列出完整 title 与 h1-h3 / Markdown heading 集合，不做任务相关性事实摘要。
- JSON Lines / TSV：字段、行数与分页信息。

以下内容不改写：

- 源码、接口和类型定义；
- 含批量源码/契约的 JSON 文档及被宿主截断的 JSON 对象；
- 子代理报告、混合证据和无法可靠解析的大文本；
- 原日志路径中含 `value` 的后续决策，以及所有非 `accept` 决策和非文本块。
- 直接检索工具的编辑、审查、验证、全量审计和无法判断意图的结果。

这套策略优先保证信息准确，不追求对所有大结果都压缩。对最初分析的 110 条真实工具结果，最终只有一条真实测试失败日志被投影，其余源码和混合证据均保持原文。

## 预热预算

命中率按以下公式计算：

```text
cacheReadTokens / (inputTokens + cacheReadTokens)
```

- 预热期：`maxChars = 1200`，约 512–1024 tokens 的保守新增预算。
- **双轨稳态判据**：连续两次请求满足（1）命中率达到 97%，或（2）已缓存前缀 $\ge 1024$ tokens、相比上一轮一字未掉（`cacheReadTokens >= prev.cacheReadTokens`）且本轮新增 `inputTokens <= 256` tokens，并且期间没有真实漂移后，进入 `maxChars = 8000` 的稳态预算。
- **空闲 TTL 预判与持久化恢复**：若距离最近一次请求已超过 25 分钟（`cacheTtlMs`），无需等待下一轮请求失败，当场退回 `1200` 字符的预热期预算；进程重启且未满 25 分钟时，可从 `session-cache-state` 持久化的 `warmupConsecutiveHits` 恢复稳态，并在 Kimi 设置页展示当前预热状态与预算上限。
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

「进展更新」设置页提供两个独立开关：`cacheWarmup` 默认开启，控制日志/命令结果投影；`cacheWarmupRetrieval` 默认开启，控制直接文件、网页与搜索结果的导航投影。两个开关都只影响之后的新结果，既有历史不变。配置字段仍留在核心入口，避免旧 profile 的整行配置替换造成迁移。

结构化日志记录投影策略、输入/输出字符数、ref 补读和预热退出。异常只记录稳定的 name/code，不记录异常 message、原文、凭据或文件路径。

## 验证

- 完整类型检查：通过。
- 全套 Vitest：310 files passed / 2 skipped，5164 passed / 9 skipped。
- `npm run build`、`npm pack --dry-run`、`git diff --check`：通过。
- 检索投影的真实 Kimi 对照严格使用 4 次请求（A/B/C/D，无重试）：
  - 原始组：冷启动 687 fresh；加入原始文件结果时 512 cached + 1251 fresh；
  - 大纲组：冷启动 687 fresh；加入大纲结果时 512 cached + 317 fresh；
  - 两组续写都读到首轮缓存，受控样本的新增输入由 1251 降至 317（约 74.7%）。
- 运行时 PTC 验收：真实探针文件生成 `strategy=file-outline`，包含 8 个顶层声明与 ref；审查请求之后 `outlinesAfterReview: 0`，读取结果为原始 JSON。

真实对照只证明这组输入上的缓存复用与新增量差异，不证明所有任务都有相同收益；编辑、审查与未知意图仍应以原文和正确性优先。
