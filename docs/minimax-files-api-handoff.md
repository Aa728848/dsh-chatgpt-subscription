# 交接：MiniMax Code Files API（N4）

状态：**未实现**。本文是给后续实现者的完整上下文与已验证事实。
最后更新：2026-10-05，基于订阅端点 `https://agent.minimax.cn/mavis/api/v1/llm/v1/messages` 实测。

---

## 0. 一句话

上传大文件到 MiniMax 文件服务换取 file id，让超出内联上限的附件（主要是视频）可发送。
**这是唯一能让 MiniMax Code 线路发大视频的路径**，但它需要新增网络写入与四个生命周期职责。

---

## 1. 官方给的事实

来自官方开源客户端 `MiniMax-AI/minimax-code` @ `56221c1`，
`packages/config/src/minimax-model-catalog.ts:4-11`：

```ts
const MINIMAX_M3_FILE_API_CAPABILITIES = {
  support_files_api: true,
  files_api_upload_endpoint: '/v1/files/upload',
  max_image_bytes_inline: 10_485_760,   // 10 MB
  max_video_bytes_inline: 52_428_800,   // 50 MB
  max_request_body_bytes: 67_108_864,   // 64 MB
  max_attachments_count: 4,
};
```

M3 与 M3.1 **共用**这一块；M2.7 / M2.7-highspeed 没有。

平台文档称 M3 与 M3.1 上下文均为 1,000,000（与本线路订阅 `config.yaml` 的 512K 口径不同，见 §7）。

---

## 2. 本线路现状

| 字段 | 位置 | 含义 |
| --- | --- | --- |
| `filesApiDocumented: true` | `src/host/minimax-code/model-catalog.ts` | 文档有、本线路未实现 |
| `maxAttachments: 4 / 9` | 同上 | **Files API 的数字，不约束内联**（已实测，见 §3.1） |
| `maxVideoBytes: 50 MB` | 同上 | 文档值；内联路径达不到 |

`filesApiDocumented` 的文档已写明本线路不上传，这是**诚实的现状标注**。

---

## 3. 已实测的事实（重要，别再猜）

用已登录账号（`MinimaxCodeAccountPool` 取凭证，池内 2 个账号，region `cn`）直接打订阅端点：

### 3.1 内联路径没有数量限制

| 请求 | 结果 |
| --- | --- |
| M3 带 4 / 5 / 8 / 9 / 10 / 12 / 20 / 48 张内联图 | **全部 HTTP 200** |
| M3 带 32 张 | 网络失败（传输抖动；48 张随后成功，**非服务端拒绝**） |

**结论**：`maxAttachments` 描述上传路径。**不要**把它当内联上限执行——
之前正是这么做的，会白白丢掉服务免费接受的图片。已回退。

### 3.2 内联视频的形状（已确认可用）

| 形状 | 服务端反应 |
| --- | --- |
| `{type:'video', source:{type:'base64', media_type, data}}` | ✅ 接受，**解码后跑 ffprobe 校验内容** |
| `{type:'video_url', ...}` | ❌ `unsupported content type 'video_url'` |
| `{type:'image', source:{media_type:'video/mp4'}}` | ❌ `image media type not supported` |
| `{type:'document', source:{...}}` | ❌ 按 PDF 解析 |

**base64 取向**（关键差异）：

| 形式 | 服务端反应 |
| --- | --- |
| **裸 base64** | ✅ 解码成功，进到 ffprobe |
| data URL | ❌ `illegal base64 data at input byte 4` |

> MiniMax 用**裸 base64**；Kimi 线用 `data:` URL。**两者形状相反，不可共用编码**。
共享的只是遍历与预算，所以本线路的 `videoBlockToInline` 保留在 mapper 自己的代码里。

### 3.3 当前内联视频预算

`MAX_REQUEST_VIDEO_BYTES = 16 MB`（`src/host/minimax-code/types.ts`），
远低于文档的 50 MB：base64 涨 4/3，50 MB 编码后约 67 MB，超出 64 MB 请求体上限。
**所以现在只能内联 ≤16 MB 的视频，更长的必须走 Files API。**

---

## 4. 实现清单

### 4.1 上传客户端

- **端点**：`{apiBase}/v1/files/upload`（`apiBase` 见 `types.ts` 的 `agentBaseUrl()`）
- **认证**：与其它调用同一 Bearer token（`modelRequestHeaders`）
- multipart 还是 raw body：**未验证**。先打一次探测再写实现
- 返回结构里取 file id 的字段名：**未验证**

### 4.2 四个必须自己做的生命周期职责

这是本工作的**主要成本**，不是上传本身：

| 职责 | 为什么不能省 |
| --- | --- |
| **TTL** | 上传的文件在服务端会过期。必须记录过期时间并在引用前检查 |
| **账号隔离** | 账号池会让同一会话由不同账号服务。**A 账号上传的 file id 很可能不能被 B 账号引用** —— 最容易踩的坑，实现前必须先验证 |
| **删除** | 否则文件在服务端无限累积 |
| **失败降级** | 上传失败必须退回到内联或占位文本，不能让整轮失败 |

### 4.3 与现有代码的接点

- `src/host/minimax-code/adapter.ts` — 在 `buildMinimaxRequest` 前按需上传
- `src/host/minimax-code/types.ts` — 预算与端点常量
- `src/host/minimax-code/mapper.ts` — `anthropicUserContent` 的 video 分支：file id 形态与内联不同
- `src/host/common/video-request.ts` — 共享的遍历与预算（**不要在这里加 provider 逻辑**）

---

## 5. 建议的推进顺序

1. **先探测，不写实现**：端点是否存在、接受什么 content type、返回什么字段、**跨账号是否可用**。这四点决定整个设计。
2. 探测通过再写客户端，**先只支持视频**（唯一真正需要它的场景）
3. 生命周期四个职责**一起做完**，不做半套
4. 最后把 `filesApiDocumented` 改为「已实现」，并让 `maxAttachments` 生效

---

## 6. 不该做的事

- ❌ 把 `maxAttachments` 当内联上限 —— **已实测错误**
- ❌ 复用 Kimi 的 `data:` URL 编码 —— MiniMax 只认裸 base64
- ❌ 在 `src/host/common/video-*.ts` 里写 MiniMax 专属逻辑 —— 会污染 kimi 线
- ❌ 只做上传不做删除 —— 服务端会无限累积

---

## 7. 相关但独立的未决项

| 项 | 状态 |
| --- | --- |
| M3 上下文 512K（本线路）vs 1M（平台文档） | 口径不同，需约 4 MB 提示实测，**未获授权未烧额度** |
| 官方规定省略 `effort` 即 `max`，而 `max` 档实测在 4000 输出上限就触顶 | 即**未指定档位默认跑最贵档**。属于产品决策 |
