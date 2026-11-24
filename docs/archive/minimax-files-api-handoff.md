# MiniMax Code Files API（N4）

状态：**已实现并端到端验证**（2026-10-05，订阅端点实测通过）。
实现：`src/host/minimax-code/files-api.ts`；测试：`test/minimax-files-api.test.ts`（17 例）。

> 本文同时是那批实测事实的记录。**实现前每一项都探测过**，
> 因为官方客户端的 `files_api_upload_endpoint` 只是一个相对路径，照抄会 404。

---

## 1. 端到端结果

```
上传   -> file_id: 449057657319831
引用   -> mm_file://449057657319831
请求   -> { type: 'image', source: { type: 'url', url: 'mm_file://...' } }
结果   -> messages 200，正常回答
```

---

## 2. 实测事实（照抄代码会踩坑的地方）

### 2.1 端点：是 `/messages` 的**兄弟**，不是子路径

| 路径 | 结果 |
| --- | --- |
| `/mavis/api/v1/llm/v1/files/upload` | ✅ **唯一可用** |
| `/mavis/api/v1/llm/v1/messages/files/upload` | ❌ 503 `direct_route_not_configured` |
| `/mavis/api/v1/files/upload` | ❌ 404 |
| `/v1/files/upload` / `/files/upload` | ❌ 404 HTML 页面 |

官方配置里的 `files_api_upload_endpoint: '/v1/files/upload'` 是**相对模型 base** 的，
其 resolver 会先剥掉 base 末尾的 `/anthropic` 兼容后缀再拼接。

**两个错误路径都不像「差一段」**：一个 503（像功能没开），一个 404 HTML（像网关坏了）。
这就是 `filesUploadUrl` 单独存在并有专门测试的原因。

### 2.2 只发 `Authorization`，**不要发 `X-Msh-*` 身份头**

最关键、也最难查的一条。本线路其它所有请求都带 7 个 `X-Msh-*` 头。带上去时 Files API 回答：

```json
{"file":null,"base_resp":{"status_code":2013,"status_msg":"invalid params"}}
```

这个响应**与「表单字段名写错」逐字节相同**。为此扫了 8 个字段名
（file / files / upload / data / content / attachment / media / video）加空表单，
全部得到同一句 `invalid params`——「字段名不对」这个假设会把人带进死胡同。

去掉身份头、只留 `Authorization: Bearer`，**同样的表单立刻成功**。

> 错误信息指向错误方向时，先怀疑「我多发了什么」，而不是「我少发了什么」。

### 2.3 表单：`purpose` 在前，`file` 在后

```
form.append('purpose', 'image_understanding' | 'video_understanding')
form.append('file', blob, filenameForMediaType(mediaType))
```

目的值由媒体类型决定：`image/*` → `image_understanding`，`video/*` → `video_understanding`。

### 2.4 响应：`file.file_id`，且必须检查 `status_code`

```json
{"file":{"file_id":449057657319831,"bytes":70,"created_at":...},
 "base_resp":{"status_code":0,"status_msg":"success"}}
```

**失败时 HTTP 是 200，不是 4xx。** 只读 `file.file_id` 会把字面量 `"null"` 当 id 发上线，
所以必须 `base_resp.status_code === 0` 才采信。

### 2.5 引用形态：`mm_file://<id>`，scheme 不可省

| 引用 | 结果 |
| --- | --- |
| `mm_file://449057657319831` | ✅ 200 |
| `449057657319831`（裸 id） | ❌ `image url must be http(s):// or data:...;base64` |

scheme 来自官方默认 `DEFAULT_FILE_API_REF_SCHEME = 'mm_file://'`。

### 2.6 没有 list / delete 路由

| 路径 | 结果 |
| --- | --- |
| `GET /files/upload` | 405 `method_not_allowed` |
| `GET /files` | 503 `direct_route_not_configured` |
| `GET /files/list` | 503 `direct_route_not_configured` |

**后果：过期只能在本地推断，无法向服务端确认。** TTL 保守取 12 小时
（官方 resolver 的默认值 43,200 秒）。

---

## 3. 实现要点

### 3.1 四个生命周期职责的落地

| 职责 | 落地方式 |
| --- | --- |
| **TTL** | `DEFAULT_FILE_ID_TTL_SEC = 43_200`；缓存条目带 `expiresAtMs`，过期即重新上传 |
| **账号隔离** | 缓存 key = `accountKey + ':' + sha256(bytes)`。**id 绝不跨账号复用** |
| **删除** | ⚠️ **无 delete 路由，做不到**。改为控制上传量：按内容哈希去重 + 12h TTL |
| **失败降级** | 上传失败**不抛给调用方**，媒体保持内联、请求继续；随后的体积检查仍给出本地明确错误 |

账号隔离是**保守假设**：实测没有验证 id 是否跨账号可读，
所以宁可多传一次，也不把 A 账号的 id 发给 B 账号。若服务实际是全局的，代价只是冗余上传。

### 3.2 触发条件

在两个 offload pass **之后**执行（已被体积限制丢掉的媒体不会白传一次），
且只有**超过内联上限**的媒体才上传——小于上限的传字节比传 id 更便宜。

### 3.3 503 的分类

`503 direct_route_not_configured` 单独归为 `route-not-configured`，
与 `rejected`（表单被拒）区分：前者是**账号没开这个路由**，重试无用；后者是请求本身的问题。
混为一谈会让用户去查自己的请求，而实际该查的是套餐。

---

## 4. 仍然未解决

| 项 | 状态 |
| --- | --- |
| **服务端删除文件** | 无路由。文件会留到其自身过期，长期运行的部署会累积 |
| **id 是否跨账号可读** | 未验证，当前按「不可读」处理 |
| M3 上下文 512K（本线路）vs 1M（平台文档） | 口径不同，需约 4 MB 提示实测，**未获授权未烧额度** |
| 官方规定省略 `effort` 即 `max`，而 `max` 档实测在 4000 输出上限就触顶 | 即未指定档位默认跑最贵档，属产品决策 |
