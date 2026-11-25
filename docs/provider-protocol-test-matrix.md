# Provider protocol test matrix

本表记录新线路接入时的协议与验收证据；既有线路保持原有记录，新增行只追加。

| Provider | 认证 | 目录 | 流式文本 | 推理 | 工具闭环 | 图片 | 额度/会话 | 离线验证 | 实测 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `opencode-go` | Console API Key，Host 加密 | 官方 live catalog + 账号隔离快照 | OpenAI SSE，文本与 `[DONE]` | `reasoning_content` / `reasoning`、按目录档位 | 流式工具调用与 tool result 续轮 | 按目录声明内联，12 MiB 预算 | rolling / weekly / monthly；稳定 `x-opencode-session` | 21 项专项测试 | `glm-5.3` 与 `deepseek-v4.1-flash-1017` 文本、工具、续轮、三窗额度、cost=0 |

边界：未断言缓存命中、Go Teams 套餐名或 `dispatch` 行为基准；Global 地区权限由用户在工作区设置。
