# MiniMax 视频「生成 + 侧边栏播放」可行性调查

> 调查方式：只读。DSH 检出（C:\Users\A\Documents\deepseek-harness）与本仓库均未修改，除本文件外无任何写入。
> 标注约定：**【事实】** = 我读到的代码/文档原文；**【推断】** = 基于事实的推理，未运行验证。

---

## 1. 结论先行

**「生成一个视频并在侧边栏里播放」——当前不能做，但不是被一个不可逾越的墙挡住。**

缺口分布如下：

| 环节 | 现状 | 归属 |
|---|---|---|
| (A) 视频字节**进来**（输入多模态） | **已有且完整** | 我们插件 |
| (B) 视频**产出**（文生视频 / 视频生成接口） | **完全没有**，全仓 0 条生成相关代码 | MiniMax 服务端 + 我们插件 |
| (C) 视频**播放**（UI 渲染 <video> 元素） | **宿主没有**：整个 client 源码树里 <video 标签命中 0 条 | DSH 上游 |

三个关键判断：

1. **卡点在 C 和 B，不在「文件通道」。** 宿主已经有 /api/file?path=<绝对路径> 这条鉴权路由，它会用 mime.lookup() 给 mp4 打上 video/mp4 发出去（packages/api/session-controller/src/media-references.ts:30-33）。所以"视频字节怎么到浏览器"这件事**宿主已经解决了**，缺的只是"浏览器拿到之后谁来播一下"。

2. **侧边栏播放最可能的落点是「注册一个 video 渲染器」，而不是改宿主。** 侧边栏文档预览是一套**按文件后缀注册**的可扩展机制（ctx.documentPreviews，registry.ts:94），而且 priority: 'extension' 的外部注册**排在内置实现之前**（registry.ts:43）。宿主内置的 image / pdf / excel / office / markdown / code / html 全是走这条路注册的。也就是说：**video 没有被实现，但它是被设计成可以被实现的。**

3. **但我们插件现在够不着那个注册点。** 该服务由 ui-sidebar-documentpreview 的 **client 半** ctx.reflect.provide（client/index.ts:91），类型声明也在它的 ./client 出口里，而我们的 package.json 既没依赖它、它的 dsh.client.inject 也没声明它。所以要么加依赖直接 ctx.inject(['documentPreviews'])，要么走宿主 PR。**这一点是本报告里唯一没能 100% 证实的地方，见 §6。**

**一句话给决策者：** 如果只是想让用户**看到**生成的视频，最小可行路径是"落盘到 workspace + 返回可点击的文件链接"，不需要动宿主；如果要的是**侧边栏里真的播放器**，那需要先解决 C 侧——优先试"我们插件注册 documentPreviews 渲染器"（成本低但需先验证服务可达性），失败则必须提宿主 PR。

---

## 2. 三段链路现状

### (A) 视频字节怎么进来 —— **有**

**【事实】** 这条链路是完整且已经在线上工作的。

| 环节 | 证据 |
|---|---|
| 工具入口 | src/host/kimi-code/video-tool.ts:28 KIMI_VIDEO_TOOL_NAME = 'kimi_attach_video' |
| 接受两种来源：本地绝对路径 / http(s) URL | video-tool.ts:89-115（本地读盘，校验绝对路径、存在、是普通文件、大小、扩展名）与 video-tool.ts:124-168（URL 下载，先过 assertPublicFetchTarget 防 SSRF） |
| 落盘 | src/host/kimi-code/video-store.ts:115-166 saveVideo() |
| 存储位置 | video-store.ts:39-41：dshHomeDir()/storages/kimi-code-videos |
| 内容寻址 | video-store.ts:143-144：attachmentId = "sha256:" + sha256(bytes)，同名对象去重且不可篡改 |
| 单文件上限 30MB | video-store.ts:33 MAX_VIDEO_FILE_BYTES = 30 * 1024 * 1024 |
| 容量治理 | video-store.ts:176 512MB 预算，:185-215 按 LRU 淘汰（写时修剪，失败吞掉） |
| 注入对话 | video-tool.ts:253-263：exec.deferContext(createUserMessage({ content: [{ type: 'video', attachment: ref }, ...] })) |
| 能力门禁 | video-tool.ts:54-82：路由 provider 必须是 kimi-code，且模型 inputModalities 必须含 video |
| 读回用于请求 | video-store.ts:231-247 readVideoBytes()，**重新校验 sha256**，不匹配即拒绝 |
| 请求侧装配 | src/host/common/video-request.ts:94-124 resolveRequestVideos()；字节预算见 video-request.ts:158-189 offloadOldestRequestVideos() |
| 线上编码 | Kimi: video_url + data URL（src/host/kimi-code/mapper.ts:776-777）；MiniMax: { type:'video', source:{ type:'base64' } }（src/host/minimax-code/mapper.ts:409-419） |

**【事实】共享层职责划分**（src/host/common/）：

- **video.ts —— 词汇与类型。** 通过 declare module '@deepseek-ai/dsh-llm' 给宿主的 ContentBlockMap / ModelModalityMap **合并扩展**出一个 video 键（video.ts:69-79）。这是插件对宿主内容块契约的唯一扩展点。另有 VIDEO_MEDIA_TYPES（:26-36）、VideoAttachmentRef（:51-61）、VideoBlock（:64-67）、videoDataUrl()（:87-89）。
- **video-request.ts —— 请求侧机制。** 遍历 content、收集 video 引用、按 attachment id 解析字节、base64 编码、超预算时用文本替换最老的视频。:84-86 定义了一个注入 seam AttachmentVideoReader，注释明说 DSH 附件服务只存图片。
- **各线路自己的 modalities.ts —— 仅文案。** MiniMax 的 videoOmissionText()（src/host/minimax-code/modalities.ts:22-33）给出四种缺省理由的人话：模型不支持 / 容器不支持 / 读不出来 / 协议不支持。

**【事实】MiniMax 侧的字节通道确实是"上传"而非"下载"：** src/host/minimax-code/files-api.ts 只有 uploadMediaFile()（:260-351），走 POST {base}/files/upload，产物是一个 mm_file://<file_id> 的**服务端引用**（:41 FILE_REF_SCHEME、:199-201 fileRef()）。**没有任何下载/读取路由**——文件头注释 :28-29 明确写：There is no list or delete route on this surface (GET /files answers 503 direct_route_not_configured)。所以它**不可能**被用来把服务端产物拿回本地。

### (B) 视频怎么产出 —— **完全没有**

**【事实】** 在本仓库 src/ 全量 grep：

- generate.*video|video.*generat|text2video|video_gen|videoGen → **0 条命中**。
- video 相关 296 条命中全部属于：内容块类型定义、请求装配、码流映射、缺失文案、媒体类型表、Files API 上传的 purpose: 'video_understanding'。
- 唯一一处提到"视频资源"的是配额：src/host/minimax-code/client.ts:587 注释说 general 桶覆盖 chat 和 coding，**其它桶（video…）是独立资源**。这说明 MiniMax 订阅里确实有独立的视频资源，但那只是**配额桶的名字**，我们并没有任何调用它的代码。

**【事实】** MiniMax 模型目录里两个模型声明了视频**输入**：src/host/minimax-code/model-catalog.ts:204（inputModalities: ['text','image','video']）与 :244，描述见 :236。**输入，不是输出。**

**【推断】** 即使 MiniMax 有视频生成接口，我们还需要：提交任务 → 轮询 → 拿到产物 URL 或字节 → 落盘。files-api.ts 帮不上忙（无下载路由），所以必须有第二个客户端模块。

### (C) DSH 的 UI 怎么渲染/播放 —— **宿主不支持**

#### C.1 全仓没有 video 元素

**【事实】** grep -rn '<video' --include=*.ts --include=*.tsx packages/client apps/web/src → **0 条命中**。整个 DSH 客户端源码树里不存在视频元素。

**【事实】** 全仓 video 这个词在客户端源码里只以三种形态出现：

1. **文件类型图标**：packages/client/ui-primitives/src/FileTypeIcon.tsx:22 的 FileType 联合类型含 'video'，:80-87 把 mp4/mov/m4v/webm/mkv/avi/mpg/mpeg 映射到它——**只是一个 28px 的图标字形**。
2. **不可预览名单**：packages/client/ui-sidebar-documentpreview/src/client/document/unviewable.ts:10-12 把 'mp4','mov','avi','mkv','webm','flv','wmv','m4v' 显式列进 UNVIEWABLE_BINARY_EXTENSIONS。这是**最关键的一条反证**：侧边栏遇到 mp4 会走"不支持"的空状态，而不是播放。
3. **测试夹具**：ui-open-in-app/tests/*.spec.ts:54-70、document-unviewable.client.spec.ts:8 里拿 /w/clip.mp4 当示例路径；ui-primitives/tests/* 里拿 clip.webm 测图标分类。**都不是渲染能力。**

> 注意：unviewable.ts 的注释（:1-8）说得很清楚——"**任何为某个后缀注册了渲染器，该渲染器优先**，owner 只在没有匹配实现时才查这个名单"。也就是说 mp4 在名单里不等于永久拒绝，它只是"**目前没人认领**"。

#### C.2 侧边栏是什么、谁渲染

**【事实】** 侧边栏分两层，我们插件已经在用其中一层：

| 层 | 包 / 机制 | 我们是否已用 |
|---|---|---|
| 页签类型 + 页签本体 | ui-sidebar-right；ctx.sidebarRightTabs.register + 槽位 sidebar.right.pane.tab | **是**（进展更新面板：src/client/progress-updates/index.ts:243-279 注册页签定义，:312-326 注册页签正文，:329-339 注册标题） |
| **文档预览渲染器** | ui-sidebar-documentpreview；ctx.documentPreviews.register + 槽位 sidebar.right.tab.document | 否 |

**【事实】** 文档预览渲染器的契约（document/registry.ts:9-28 DocumentPreviewDefinition）：

- id：唯一实现名，同时是 document 槽位的 key
- extensions：认领的文件后缀（支持 tar.gz 这类复合后缀）
- binaryExtensions：其中哪些是二进制（决定要不要给纯文本兜底）
- priority：'builtin' | 'extension' —— **外部实现优先**
- title：本地化显示名
- loading：'text-pages' | 'bytes-complete' | 'renderer'
- wrap：是否吃文档的换行偏好

排序规则在 registry.ts:36-49 matchingDocumentPreviews()：**先按 priority（extension 在前 = 1，builtin = 0，按 right.rank - left.rank 降序），再按后缀长度，再按注册顺序**。

**【事实】内置实现全部走同一条路**（这就是"照抄"的模板）：

- image/index.ts:42-53：ctx.documentPreviews.register(imageBodyDefinition(...)) + ctx.slots.inject('sidebar.right.tab.document', ...) 注册 keyed 组件。
- image 的 loading 是 'bytes-complete'（:33），即 owner 把**整份字节**交给组件。
- ImageBody.tsx:74 拿到字节后 URL.createObjectURL(new Blob([data], { type: mediaType }))，最后 :121-130 渲染 img 元素。

**这就是 video 渲染器该照抄的完整范式**——把 img 换成 video（controls + src=blob URL）即可，字节来源、生命周期、revoke 逻辑完全一致。

**【事实】** 字节怎么到组件：rpc.ts:93 ReadDocumentBytes，实际绑定在 client/index.ts:97-101：
(file, signal) => ctx.remote.workspaceFiles.readBytes(file.sessionId, file.path, {}, signal)。
注意这是 **workspace 作用域**的读取，地址形如 dsh-resource://file/session/<id>/<path>（rpc.ts:67-72 hostFileOf()，:56-72 注释说明 absolute 地址在这里读不了）。

#### C.3 宿主已有的"本地路径 → 可显示 URL"

**【事实】** packages/util/workspace-path/src/index.ts:120-124 fileMediaUrl(base, path)：
把绝对路径拼成 api/file?path=<encodeURIComponent(path)>。仅接受 http(s) base 或 dsh-app://app/，且 path 必须是绝对路径、非 UNC、无控制字符。

**【事实】** 对话里的 markdown 图片就是靠它：packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx:23-28 localPathMediaUrl() → fileMediaUrl()；ChatView.tsx:87 也用它。

**【事实】** 但 markdown 图片最终渲染成 img 元素，不是 video：packages/client/ui-primitives/src/markdown/render.tsx:630-641 MarkdownImage → LoadedMarkdownImage。

**【推断】** 所以"在回答里写一个指向 mp4 的 markdown 图片链接"**不会**播放——会得到一个加载失败的 img。（未实机验证；依据是渲染路径只有 img。）

#### C.4 宿主附件服务是不是"只存图片"

**【事实】是，而且现在仍然是。**

- packages/attachment/README.md:12：The attachment/ group provides durable image attachments... only raster image formats are supported.
- packages/attachment/attachment/src/types.ts:8：export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' —— **四选一的字面量联合，装不下 video**。
- 存储根：packages/attachment/attachment-local/src/store.ts:47 注释写明是 DSH_HOME/attachments/v1（即我们看到的 ~/.dsh/attachments）。
- 我们仓库里三处注释独立复述了这个事实：src/host/common/video-request.ts:78、src/host/kimi-code/video-store.ts:4-5、src/host/kimi-code/video-tool.ts:4-5。

**【事实】** 所以 README 里那句"DSH 的附件服务只存图片"**依然成立**，对应宿主代码就是上面那两处 + ImageMediaType 的类型封闭性。

**【事实】** 但**附件服务 ≠ 文件服务**。宿主另有一条与附件无关的通用文件路由：

packages/api/session-controller/src/media-references.ts:22-60 serveFile()：

- :25-27：只要求 path 是**绝对路径**、不含 NUL；
- :30：mime.lookup(target.displayPath) || 'application/octet-stream' —— **按扩展名给 MIME**，mp4 → video/mp4；
- :45-47：fs.readBytes(target, signal, maxBytes) 后整份返回；
- 模块 doc :2-4 明说：Paths and MIME types do not restrict access；
- 挂载点 :70-75：GET|HEAD /api/file。

**【事实】** 测试里已经明确覆盖了 mp4：packages/api/session-controller/tests/media-references.host.spec.ts:98 的参数化用例 ['mp4', 'video/mp4']，断言"以正确 MIME 和响应保护返回"。

**三个硬限制（video 会直接撞上）：**

| 限制 | 证据 | 影响 |
|---|---|---|
| **字节上限复用的是图片的** maxImageBytes，默认 **20MB** | media-references.ts:69 const maxBytes = ctx.attachments.imageLimits.maxImageBytes；attachment-local/src/index.ts:34 DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024 | 超过 20MB 的视频 GET 直接 **413**。Kimi 视频工具自己的上限是 30MB，比这条路还大 |
| **不支持 Range** | serveFile() 里 grep Range / 206 / Accept-Ranges → **0 条**；且它 readBytes 后**整份**返回（:45-47）。测试 :59 的用例名是 "refuses larger images for GET, HEAD and Range"，:66 断言带 range: bytes=0-0 也返回 413 | 浏览器拖动进度条需要 206 Partial Content；这条路给不了。**小文件可以整份播放，大文件无法 seek** |
| **响应头阻断了一些玩法** | :15-20 BASE_HEADERS：Cache-Control: private, no-store、X-Content-Type-Options: nosniff、Content-Security-Policy: sandbox; default-src 'none' | 直接在 iframe/独立标签打开会被 CSP sandbox 限制 |

#### C.5 内容块（content block）契约支持什么

**【事实】** 宿主本体（@deepseek-ai/dsh-llm）的 ContentBlockMap **没有 video 键**——这一点不是猜的，我们自己的 src/host/common/video.ts:4-6 和 :69-79 就是在做这件事的补丁：

    // video.ts:4-6
    // DSH ships ModelModalityMap = { text, image } and a ContentBlockMap with no
    // video entry, but both are merge-extensible interfaces.
    declare module '@deepseek-ai/dsh-llm' {
      interface ModelModalityMap { video: 'video' }
      interface ContentBlockMap { video: VideoBlock }
    }

**【事实】** 宿主侧对该扩展是容忍的，甚至有测试固化"插件可以加一个 video 块类型"这个前提：packages/llm/llm/tests/assembler.spec.ts:67-69 注释 plugin-added 'video' block without its required 'block-end'。

**【事实】** 附件侧的内容形式仍然是封闭的：packages/attachment/attachment/src/types.ts:103-104 { readonly type: 'image'; readonly mediaType: ImageMediaType }，:117 { readonly type:'image'; readonly attachment: ImageAttachmentRef }。

**【事实】** 从 DSH 到模型这条路，video 块是我们**自己**解释的：resolveRequestVideos() 只认 block.type === 'video'（video-request.ts:38），而**谁能造出这个块**——目前全仓库只有 kimi_attach_video 一个（video-tool.ts:255）。

---

## 3. kimi-code/video-tool.ts 到底做到了哪一步

### 做成了什么

**【事实】** 它是**输入侧**的完整实现，而且质量不低：

1. **两种来源**：本地绝对路径（video-tool.ts:89-115）/ http(s)（:124-168）。
2. **防 SSRF**：URL 分支先 lookupHostAddresses 再 assertPublicFetchTarget（:143-146），用的是部署统一的地址策略而不是自己造一套。
3. **双重大小检查**：先看 stat.size / Content-Length 再读字节（:101、:153-160），避免把一个超大文件读进内存。
4. **产物形态 = 本地文件**：saveVideo() 内容寻址落盘到 ~/.dsh/storages/kimi-code-videos/<sha256>.<ext>（video-store.ts:143-154）。
5. **交回 DSH 的方式**：exec.deferContext(createUserMessage({ content: [{type:'video', attachment: ref}] }))（video-tool.ts:253-263）——作为**插件来源的用户消息**注入下一轮请求。
6. **完整性**：读回时重新算 sha256 比对（video-store.ts:242-245）。

### 没做成什么（关键）

**【事实】** 它**没有解决「产物落地 → UI 呈现」这件事**，而且它压根没往这个方向走：

**证据 1 —— 工具输出把路径丢了。** video-tool.ts:190-200 的输出 schema 只有四个字段：source / mediaType / bytes / attachmentId。**没有本地路径，没有 URL。** storedPathFor() 这个函数在 video-store.ts:218-222 是存在的，但**只在 store 内部给 readVideoBytes() 用**，没有暴露到工具输出。

**证据 2 —— 渲染只有一行字。** video-tool.ts:201-207：

    render: (_args, value): ContentBlock[] => {
      const output = value as unknown as { source: string; mediaType: string; bytes: number }
      return [{ type: 'text', text: 'Attached video ... (mediaType, bytes).' }]
    }

**证据 3 —— 结果卡片是 generic。** video-tool.ts:217-221 presentResult 返回 { card: 'generic', title: 'Video attached', content: result.content }，即宿主默认的通用卡片，不是自定义 toolview。

**证据 4 —— 没有注册任何槽位。** 全仓库的 ctx.slots 注册点只有 src/client/index.tsx（settings.section / conversation.input.right / tool.call.toolview）和 src/client/progress-updates/index.ts（tool.call.toolview / **sidebar.right.pane.tab** / sidebar.right.pane.tab.title / settings.section）。**没有一条与 video 有关。**

**证据 5 —— 注释自认。** 模块 doc video-tool.ts:4-8 说得很直白：

> DSH's attachment service stores images only and no DSH surface can produce a video block, so this route supplies its own ingress.

它解决的是"**怎么把视频送进模型**"，从来不是"**怎么把视频给人看**"。这两件事它只做了前一件。

### 卡在哪

**【推断】** 它没有卡在技术上，而是**卡在目标上**——它的需求是"读视频"，不是"放视频"。所以：

- 落盘那一半（video-store.ts）其实**可以直接复用**来做生成的产物存储：内容寻址、LRU、完整性校验都是现成的。
- 但它缺两样东西才能变成播放方案：(1) 把落盘路径暴露到工具输出；(2) 一个能播 video 的 UI 落点（宿主没有）。

**结论：抄它的一半，不能抄它的全部。**

---

## 4. 最小可行方案

分三档，成本递增、能力递增。**建议按档位推进，每档都可独立交付。**

### 档位 0（1 天量级，纯我们插件，零宿主改动）：让"生成了视频"这件事**可见**

不追求播放器，只追求"用户知道文件在哪、能点开"。

1. **产出侧**：新增 src/host/minimax-code/video-generate.ts——提交生成任务、轮询、拿产物字节。（**前提**：MiniMax 视频生成接口的存在性未确认，见 §6。）
2. **落盘**：复用 video-store.ts 的 saveVideo()，但改写到 **session workspace** 下（如 <cwd>/generated/<sha256>.mp4）而不是 ~/.dsh/storages/。理由：/api/file 和 workspaceFiles.readBytes 都走 ctx.fs 的 workspace 视图，放 workspace 里两边都能读。
3. **呈现**：工具 output.render 返回 { type:'text', text: '[clip.mp4](<绝对路径>)' }。
4. **效果**：对话里出现一个可点击的文件链接（宿主对绝对路径的链接会走 openFile → 侧边栏，见 ui-chat/src/client/apply.ts:258-264）。侧边栏会显示"不支持预览"的空状态（unviewable.ts），但**用户可以点工具栏用系统播放器打开**（ui-open-in-app 存在，测试见 ui-open-in-app/tests/open-path.client.spec.ts:54-70）。

> 档位 0 的定位是"**诚实的最小可用**"：不假装有播放器，但产物真的落地了、真的能打开。

### 档位 1（2~3 天量级，仍需验证一个前提）：在我们插件里注册侧边栏 video 渲染器

这条是**整个调查里最值得先试的一步**，因为宿主的设计明显是允许这么做的。

1. 在 package.json 的 peerDependencies 与 dsh.client.inject 中加入 @deepseek-ai/dsh-client-ui-sidebar-documentpreview。
2. 新建 src/client/video/index.ts，照抄 packages/client/ui-sidebar-documentpreview/src/client/image/index.ts:42-53：

       ctx.documentPreviews.register({
         id: 'dsh-chatgpt-subscription/video',
         extensions: ['mp4', 'webm', 'mov', 'm4v'],
         binaryExtensions: ['mp4', 'webm', 'mov', 'm4v'],
         priority: 'extension',      // 外部实现优先
         title: () => '视频',
         loading: 'bytes-complete',  // 和 image 一样整份字节
         wrap: false,
       })
       ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
         { name: 'sidebar.right.tab.document', key: 'dsh-chatgpt-subscription/video', locale: NS }, VideoBody))

3. VideoBody.tsx 照抄 ImageBody.tsx:70-82 的 Blob 生命周期，只把 img 换成 video：

       const url = URL.createObjectURL(new Blob([content.data], { type: 'video/mp4' }))
       // cleanup: URL.revokeObjectURL(url)
       <video src={url} controls playsInline />

4. **收益**：不需要改宿主一行代码，mp4 从此在侧边栏里**真的能播**。因为它读的是 workspaceFiles.readBytes 拿到的整份字节再转 Blob URL，**连 Range 都不需要**——/api/file 那条路的 20MB 上限和缺 Range 的问题都被绕开了（上限变成 workspace 读的 cap）。
5. **未验证的前提**：我们的 client 半能不能真的拿到 ctx.documentPreviews。见 §6。

### 档位 2（需宿主 PR）：在**对话流里**播放

档位 1 只解决侧边栏。如果要在回答正文里直接播放，需要动宿主。

---

## 5. 宿主侧需要改什么（如果需要改）

以下每一条都是**上游仓库 deepseek-ai/deepseek-harness 的改动**，我们这个插件单独做不到。

| # | 改什么 | 具体文件 | 为什么必须是上游 |
|---|---|---|---|
| 1 | **给附件服务加 video** | packages/attachment/attachment/src/types.ts:8（ImageMediaType 这个四值联合是硬墙）；attachment-local/src/store.ts（存储/规范化）；attachment/src/request-projection.ts | 附件是宿主的服务契约，ctx.attachments 的类型不由插件定义 |
| 2 | **视频路由的字节上限** | packages/api/session-controller/src/media-references.ts:69：maxBytes 现在借的是 ctx.attachments.imageLimits.maxImageBytes（默认 20MB）。需要独立的 mediaLimits.maxFileBytes | 路由属于宿主 |
| 3 | **给 /api/file 加 Range/206** | 同上 serveFile()（:22-60）：目前只有整份 readBytes，无 Accept-Ranges、无 Content-Range、无 206 | 没有它，大视频在浏览器里无法 seek |
| 4 | **对话里支持 video 块渲染** | packages/client/ui-primitives/src/markdown/render.tsx:630-641（MarkdownImage 只产 img）；更大范围要在 ui-chat 的 assistant block 渲染里新增一种块 | 对话渲染器属于宿主 |
| 5 | **（可选，最省事）内置一个 video 文档预览器** | 新目录 packages/client/ui-sidebar-documentpreview/src/client/video/，照 image/ 的 5 个文件结构；并在 unviewable.ts:10-12 里把 mp4 等从 UNVIEWABLE_BINARY_EXTENSIONS **删掉** | 若上游愿意接受，这是对所有插件都有利的通用能力 |

**如果上游只愿意接受一条改动**，我建议是 **#5**：它把"视频能不能在侧边栏播放"从"每个插件各写一遍"变成"宿主自带"，而且改动面最小（一个内置渲染器 + 删除几行名单）。

---

## 6. 查不到的 / 未能证实的

明确列出来，不做猜测：

1. **我们插件的 client 半能否 ctx.inject(['documentPreviews']) —— 未证实。**
   - **确定的部分**：该服务由 packages/client/ui-sidebar-documentpreview/src/client/index.ts:91 ctx.reflect.provide('documentPreviews', previews) 注册；类型声明在 :57；Context 的模块增强在 :58-62。
   - **确定的部分**：它的 dsh.client.inject（package.json）声明了 8 个包，**不含**自己的服务出口；exports 里确实有 ./src/*。
   - **未证实**：DSH 的 client 服务是否像 host 侧那样支持"任意插件 inject 一个已被别的包 provide 的服务"。我没有读到 client 侧服务可见性的判定代码。**验证方法：写一个 5 行的临时 client 插件，ctx.inject(['documentPreviews'], s => …) 看是否被调用**（我没写，因为任务要求只读）。
   - 若不可行，档位 1 降级为"必须走宿主 PR #5"。

2. **MiniMax 是否有可用的视频生成接口 —— 完全未查明。**
   - 我们的 src/host/minimax-code/ 里没有任何生成相关代码。
   - client.ts:587 的注释提到配额里有 video 资源桶，但**那不是接口证据**。
   - 我需要的是：endpoint、请求体、轮询方式、产物形态（URL？字节？mm_file://？）、计费方式。**这些一条都没查到。** 这是 (B) 环节最大的空白，也是整个需求能否成立的前提。

3. **/api/file 在真实浏览器里对 20MB 以下 mp4 的播放表现 —— 未实测。**
   - 代码层面它给 video/mp4 + 整份字节，理论上 video 元素的 src 能播。
   - 但 Content-Security-Policy: sandbox; default-src 'none'（media-references.ts:19）会不会影响媒体加载，我没验证。（video 元素直接 src 引用通常不受 CSP sandbox 影响，因为不是文档上下文——这是推断，不是事实。）

4. **在回答里写 mp4 的 markdown 图片链接会怎样 —— 未实测。**
   - 事实：渲染路径是 img（render.tsx:630-641）。
   - 推断：会显示加载失败/alt 文本。
   - 但这个具体路径我没跑。

5. **workspaceFiles.readBytes 的字节上限 —— 没查。**
   - 这决定档位 1 能播多大的视频。rpc.ts:93 只声明了类型，实际 cap 在 @deepseek-ai/dsh-api-workspace-files 里，我没有展开读。

6. **我们这条线（minimax-code）能不能挂 kimi_attach_video —— 不能，这是事实不是空白。**
   - video-tool.ts:65-70 硬门禁：provider !== 'kimi-code' 直接抛 KIMI_VIDEO_WRONG_PROVIDER。
   - 所以如果 MiniMax 线要"把生成的视频再喂回模型看"，得另写一个门禁不同的工具。

---

## 7. 附：本次调查用到的证据索引

DSH 检出（C:\Users\A\Documents\deepseek-harness，只读）：

| 文件 | 行 | 内容 |
|---|---|---|
| packages/api/session-controller/src/media-references.ts | 2-4, 15-20, 22-60, 69, 70-75 | /api/file 全貌、MIME、20MB 限制、无 Range |
| packages/api/session-controller/tests/media-references.host.spec.ts | 59-71, 98, 114-126 | 上限与 Range 行为、mp4 MIME 用例 |
| packages/attachment/attachment/src/types.ts | 8, 103-104, 117 | ImageMediaType 四值封闭 |
| packages/attachment/README.md | 12 | "durable image attachments… only raster image formats" |
| packages/attachment/attachment-local/src/index.ts | 34 | DEFAULT_MAX_IMAGE_BYTES = 20MB |
| packages/util/workspace-path/src/index.ts | 120-124 | fileMediaUrl() |
| packages/client/ui-primitives/src/markdown/render.tsx | 630-641 | markdown 图片 → img |
| packages/client/ui-sidebar-documentpreview/src/client/document/registry.ts | 9-28, 36-49, 94-113 | 渲染器注册契约与优先级排序 |
| .../src/client/document/unviewable.ts | 10-12 | mp4 等列在不可预览 |
| .../src/client/image/index.ts | 26-36, 42-53 | **可照抄的注册范式** |
| .../src/client/image/ImageBody.tsx | 14-23, 70-82, 121-130 | **可照抄的 Blob 生命周期** |
| .../src/client/index.ts | 57, 91, 97-101, 104-121 | documentPreviews 的 provide 与槽位 |
| .../src/client/rpc.ts | 56-72, 84-93 | 文件地址 → session + path |
| packages/llm/llm/tests/assembler.spec.ts | 67-69 | 插件可加 video 块类型 |
| packages/client/ui-chat/src/client/apply.ts | 258-264 | openFile → 侧边栏 |
| packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx | 23-28 | localPathMediaUrl |

本仓库（C:\Users\A\Documents\ChatGPT\dsh-chatgpt-subscription）：

| 文件 | 行 | 内容 |
|---|---|---|
| src/host/kimi-code/video-tool.ts | 4-8, 54-82, 89-168, 190-221, 253-263 | 工具全貌；**输出无路径、render 只有文字** |
| src/host/kimi-code/video-store.ts | 33, 39-41, 115-166, 176-215, 218-247 | 内容寻址落盘 + LRU + 完整性校验 |
| src/host/common/video.ts | 4-6, 26-36, 51-67, 69-79, 87-89 | 词汇与 ContentBlockMap 合并扩展 |
| src/host/common/video-request.ts | 78-86, 94-124, 158-189, 204-233 | 请求侧装配、字节预算、seam |
| src/host/minimax-code/files-api.ts | 28-29, 41, 199-201, 260-351 | **只有上传、无下载路由** |
| src/host/minimax-code/modalities.ts | 22-33 | 缺失文案 |
| src/host/minimax-code/mapper.ts | 409-419 | 线上 video 块编码 |
| src/client/progress-updates/index.ts | 243-279, 312-339 | **我们已有的侧边栏注册先例** |
| src/client/mermaid/sanitize.ts | 1-16 | video 只在**剥离**名单里 |
| package.json | peerDependencies / dsh.client.inject | 未依赖 ui-sidebar-documentpreview |
