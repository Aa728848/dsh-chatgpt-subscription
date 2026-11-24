# RelayOne 线路设计与证据

## 范围与决策

- Provider：`relayone`；站点：RelayOne（New API 部署），固定 Base URL `https://z1rry.cyou/v1`。
- 多个 API Key 存储，系统加密存储；**手动切换**当前 Key，不自动轮询。401/403 只标记该 Key 失效、429 只记 60 秒冷却，均不自动换号。升级前的单 Key 文件被投影为主账号并保持镜像回写。
- 对话 + 工具调用 + 生图/编辑 + 异步视频；媒体模型不进入对话模型选择器。
- 用户确认的协议策略：OpenAI 优先 Responses，Claude 优先 Anthropic Messages，其余模型优先 Chat Completions。
- RelayOne 生图与视频工具和 Codex/Kimi/MiniMax 一样受全局 `mediaTools` 开关控制；执行时再检查线路启用与凭据。

## 上游证据

| 事实 | 来源 | 核验日期 |
| --- | --- | --- |
| Bearer `sk-` 鉴权、Base URL、SSE | https://z1rry.cyou/docs#/overview | 2026-11-18 |
| `POST /v1/chat/completions`、tools、stream_options | https://z1rry.cyou/docs#/chat | 2026-11-18 |
| `POST /v1/responses` | https://z1rry.cyou/docs#/responses | 2026-11-18 |
| `POST /v1/messages`、`anthropic-version: 2023-06-01` | https://z1rry.cyou/docs#/messages | 2026-11-18 |
| 当前 Key 可见模型与 `supported_endpoint_types` | https://z1rry.cyou/docs#/models-api | 2026-11-18 |
| Key 分组决定可用模型 | https://z1rry.cyou/docs#/models | 2026-11-18 |
| 公开分组、vendor、媒体 tags 与 billing schema | `GET https://z1rry.cyou/api/pricing` | 2026-11-18 |
| 生图、编辑与异步任务 | https://z1rry.cyou/docs#/images 、#/image-edit 、#/midjourney | 2026-11-18 |
| 视频提交与轮询 | https://z1rry.cyou/docs#/video | 2026-11-18 |
| 官方 SVG 标记 | https://z1rry.cyou/docs/assets/logo.svg | 2026-11-18，HTTP 200，716 bytes，SHA-256 `5835660da03da1473399f224b36f8e9e9067bfe21727c9be2e7e73475042d05e` |
| 当前 Key 的授予/已用/剩余/无限标记 | https://doc.newapi.pro/api/token-usage/ ，`GET /api/usage/token` | 2026-11-18；本站无鉴权实测 401，端点存在且需 Key |
| 美元换算 `quota_per_unit=500000` | `GET https://z1rry.cyou/api/status` | 2026-11-18，HTTP 200 |
| 无限令牌与账户余额取较小值 | https://github.com/QuantumNous/new-api/blob/main/controller/channel-billing.go `updateChannelNewAPIBalance` | 2026-11-18 |

公开 `/api/pricing` 在核验时返回 47 个模型与 14 个 `usable_group` 条目。公开端点组合为 37 个 `openai`、4 个 `anthropic+openai`、6 个 `image-generation+openai`；没有模型公开声明 `openai-response`，但站点文档明确提供 Responses 入口。因此实现不把公开价格表当作当前 Key 的可用性证明，而是把它与带鉴权的 `/v1/models` 合并。

无凭据访问 `/v1/models` 实测为 HTTP 401；测试不索取或保存真实用户 Key。

## 数据流

1. `RelayOneCredentialStore` 复用 Windows DPAPI、macOS Keychain、Linux Secret Service。
2. `RelayOneCatalogManager.warm()` 只读取按 Key SHA-256 指纹隔离的本地快照，不触网。
3. 后台刷新并行读取 `/v1/models` 与公开 `/api/pricing`；前者失败则没有新目录，后者失败只失去补充元数据。
4. 只有 live listing 中的 id 能进入目录。分组、端点、vendor、描述、tags、媒体参数 schema 来自 pricing。
5. 快照 writer/parser 是 `persistedRelayOneModelRecord` / `parsePersistedRelayOneModelEntries` 这一对；换 Key 立即清空旧目录。
6. 内容指纹变化才发送 `llm/adapters-updated`；TTL 与 in-flight 单飞防止状态轮询放大请求。

模型选择三态：`null` 表示当前全部对话模型，`[]` 表示明确全关，显式数组只保留当前 live id。新模型在 null 模式自动出现，在显式选择模式不擅自开启。

## 协议策略

| 条件 | 请求 |
| --- | --- |
| 明确含 `openai-response` / `openai-responses` | 标准 Responses |
| 支持 `anthropic` | Anthropic Messages |
| OpenAI vendor 或 GPT/Codex 家族 | 优先 Responses |
| 其他对话模型 | OpenAI Chat Completions |
| image/video 媒体条目 | 不注册为对话模型 |

Responses 请求不携带 ChatGPT 的 originator、Responses Lite、turn-state 或加密思考私有字段。流解析复用本包已验证的 Responses parser，保留 function_call/output 回放、多工具、usage、incomplete 与无效 JSON 防护。

RelayOne GPT 有工具时提示模型在一批相关工具得出新证据或完成阶段时输出一条可见正文再继续，不要求每个工具都播报，也不重复已通过进度工具发送的小卡。Responses 续轮若只有调用回放项，则补回已经显示的正文；完整回放中的原生正文不重复发送。是否产生小结仍取决于上游模型与网关返回内容。

只有 HTTP 400/404/405/422 且正文明确表示端点/协议不支持时才回退；`model_not_found`、工具参数、上下文、鉴权和额度错误不回退。回退发生在任何模型流输出之前，按 Key + model + 主协议缓存；流开始后不重放。

### Claude Messages 思考参数

- RelayOne 的公开价格目录列出的 Opus 5.5、Fable 5 / 5.1 / 5.2 均使用自适应思考。新版 Claude 使用 `{ type: 'adaptive', display: 'summarized' }`，显式选档时才发送 `output_config.effort`；支持的档位按模型发布。没有指定档位时保留上游默认（例如 Opus 5.5、Haiku 5.5 是 `medium`），不会强制 `high`。旧版 Claude 保留 `budget_tokens`。
- 与自有 Claude 订阅线路一致，主动请求可见的思考摘要，并原样回放工具调用所需的已签名思考块；禁止自定义温度的模型即使未选档也不发送 `temperature`。不把订阅线路的 Claude Code 鉴权、版本门槛或 beta 字段复制到中转请求。
- [思考块前缀绑定](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking/prefix-checks)的自动丢弃需要上游透传指定 beta header 和 `block_binding`；RelayOne 未公开保证该支持，本线路不主动发送。模型参数依据 Anthropic 的[思考模式](https://platform.claude.com/docs/en/build-with-claude/thinking)、[档位](https://platform.claude.com/docs/en/build-with-claude/effort)与 [Opus 5.5 迁移指南](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide)，RelayOne 上下文与输出上限继续使用本地保守值。

## 会话粘性与前缀缓存

- [New API 的渠道亲和规则模板](https://github.com/QuantumNous/new-api/blob/main/web/src/features/system-settings/general/channel-affinity/constants.ts) 从 GPT Responses 请求的 `prompt_cache_key`、Claude Messages 的 `metadata.user_id` 取键。按 DSH 会话、模型、凭据作用域派生匿名稳定值；重试、工具回合、压缩或重启不改变它，换会话或 Key 则隔离。缺少会话 ID 或已标记辅助用途时不发送主会话键。
- GPT 回退到 OpenAI Chat 时沿用同一标准字段；普通第三方 Chat 不注入未声明参数。可通过 `promptCacheOverrides.relayone.mode: none` 关闭插件侧提示。不假定网关启用了模板，不设置未经证实的 TTL，不发预热流量。
- GPT 6.2 及之后的 Responses 模型把顶层 `instructions` 放在可缓存输入之后。RelayOne 将基础系统指令、开头的 system/developer 消息和共用工具指引放入第一条 `developer` 输入；历史开始后出现的额外指令仍放在顶层。旧 GPT 和 Chat 回退的请求形状不变。
- 渠道亲和不是模型 KV 命中；[OpenAI 前缀缓存文档](https://developers.openai.com/api/docs/guides/prompt-caching) 也区分路由与计量。仅当上游报告缓存读取时才记入 DSH；即使键相同，前缀变化、缓存淘汰或网关换渠道都可能未命中。

## 媒体

- `relayone_generate_image`：`/v1/images/generations`；base64 或公网 URL；最多 5 张显式参考图走 `/v1/images/edits` multipart。
- 图像响应若返回 task id，则轮询 `/v1/tasks/{id}`，完成后读取 `image_urls` / `grid_image_url`。
- `relayone_generate_video`：提交 `/v1/video/generations`，轮询同路径 `/{taskId}`，完成后下载到工作区 `relayone-videos/`。
- 下载检查公网地址、重定向、大小与媒体类型；轮询失败不重复提交计费任务。
- 图像结果复用 Codex 附件卡；视频 `presentationMeta` 复用 MiniMax 播放器与工作区读取通道。

## 离线验证

- `test/relayone-core.test.ts`：目录合并、三态选择、生产快照 codec、Responses/Chat/Anthropic 请求与多工具流。
- `test/relayone-adapter.test.ts`：真实 adapter 的 mock HTTP/SSE、三协议选择、回退缓存、普通 400 禁止回退、Key 隔离。
- `test/relayone-media.test.ts`：base64 生图、multipart 编辑、图像任务、视频任务、工作区保存与失败不重提。
- `test/relayone-routes.test.ts`：同源 mutation、密钥不泄漏、模型校验、状态不被慢刷新阻塞。
- `test/relayone-section.test.tsx`：共享 UI 骨架、空态、全关、真实额度徽章、旧 host 无额度字段、500K 独立标签、官方品牌。
- `test/relayone-quota.test.ts`：有限/无限额度、账户上限、过期值、错误脱敏与换 Key 竞态。
- 既有注册、枢纽、偏好迁移、俄语与媒体总开关断言均追加 RelayOne。

## 最终验收记录

- 强制 Host/Client/Test/Scripts 类型检查通过。
- 全量 Vitest、构建与 `npm pack --dry-run` 的发版结果见 [CHANGELOG](../CHANGELOG.md)；离线测试覆盖完整适配器发送的亲和字段和上游缓存用量。
- 当前 `http://127.0.0.1:3080` 的真实插件已重载，状态路由返回 `ok:true`；总览与详情页在 1280×800 深色主题下完成 After 捕获。Key 行经过用户指出的 Before 宽度问题后改为全宽网格并复查，浏览器控制台无错误。
- 新线路没有“接入前”的可靠 Before；媒体卡片复用既有组件，未单独虚构 Before。窄屏规则由 `@media(max-width:640px)` 与样式断言覆盖，未声称完成独立移动设备实机测试。

## 风险与未验证项

- GPT 本地能力更新为默认上下文 272K（可覆盖 500K）、完整推理档位原值透传；快照读取会重算这些本地策略，避免旧 high-only/256K 配置残留。
- 设置页和 composer 使用真实 `/api/usage/token` 额度：有限额度显示百分比/美元，无限显示 ∞；令牌与账户余额并存时取较小值，零授予量不伪造 0%。
- 没有使用真实 RelayOne Key 做计费对话、生图或视频调用；本轮用已有 Key 验证了可用模型目录与无限令牌额度。未实测站点渠道配置或计费对话的缓存命中率。
- OpenAI 模型的 Responses 优先策略来自用户决策和站点文档；具体分组若拒绝该端点，只有明确错误才触发 Chat 回退。
- 上游未统一公布精确上下文窗口/输出上限，host 使用保守本地预算，设置页允许覆盖；这些本地预算不是上游能力承诺。
- 媒体任务解析覆盖本站文档与常见 New API 包装；未公开的新产物形状会明确报“完成但没有 URL”，不会伪造成功。
- 图像 URL 的短时签名与视频任务在线时效未实测。
