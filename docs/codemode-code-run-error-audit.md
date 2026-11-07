# Code Mode `code_run` 报错审计：与内核 PTC `run_code` 的 A/B 对比

- **对象 A**：本插件的 Code Mode 传输工具 `code_run`（`src/entry-codemode.ts` + `src/host/codemode/`）
- **对象 B**：内核 PTC 工具 `run_code`（`packages/core/tool-executor-ptc/src/ptc.ts`）
- **数据**：本机 `~/.dsh/sessions/` 全部 51 份会话归档（`session.v4.jsonl.zstd`，多帧 zstd 容器），其中 `code_run` 25 会话、`run_code` 13 会话
- **口径**：`tool/call` 里 name 命中即计一次调用；以同 `callId` 的 `tool/result` 的 `message.isError` 判失败，找不到结果记「中断」
- **结论时点**：脚本复现见第九节

---

## 一、结论先行

1. **两边总失败率接近，但不是同一个问题**：`run_code` 4.68%（54/1153），`code_run` 5.14%（55/1069）。同一模型（`opendesign/deepseek-v4.1-flash`）下差距放大：**1.76%（4/227）对 4.27%（35/820）**。
2. **`code_run` 比 PTC 多出来的那部分，几乎全是本仓自己造成的**：参数契约自检 16 条 + 信封形状 TypeError 11 条 = **27 条，占它全部报错的 49%**；这两类在 PTC 侧分别是 0 条和 2 条。
3. **27 条里 7 条可确定性修复，20 条可靠提示词防患**：其中 7 条是把 `progress_update` 的参数和 `code_run` 的参数写进同一次工具调用（模型侧「边汇报边执行」的惯用法），100% 可拆分复原。
4. **PTC 侧的大头不是实现问题**：转义/语法 25 条里 23 条来自 `kimi-code/kimi-for-coding`，属模型写码习惯（反斜杠、`let x: T` 之类），换面不会消失。

---

## 二、样本与口径

| 项 | 值 |
| --- | --- |
| 会话归档总数 | 51 份 |
| `code_run` 覆盖 | 25 会话 / 1069 次调用 |
| `run_code` 覆盖 | 13 会话 / 1153 次调用 |
| 时间跨度 | 归档 mtime 均在 2026-11-03 ~ 2026-11-07 |
| 主要线路 | `opendesign/deepseek-v4.1-flash`（820 次 code_run）、`opendesign/deepseek-v4.1-flash-eco`（93）、`antigravity/gemini-4-argon`（130）、`kimi-code/k3.1-pro`（26）、`kimi-code/kimi-for-coding`（926 次 run_code） |

判定口径的两个偏差来源，先说清楚，避免过度解读：

- **任务混杂**：`code_run` 的会话集中在 `dsh-web` / `dsh-agents` / `cwtools-vscode`（大量改码 + 跑测试），`run_code` 的会话集中在 `deepseek-harness` / `dsh-*` 仓库（读码为主的子代理任务）。shell 失败、超时这类与任务强相关的分型因此不可横比。
- **模型分布不均**：`run_code` 有 80% 调用来自 kimi-for-coding，`code_run` 有 77% 来自 opendesign-flash。总账对比只在**同一模型子集**上有意义。
- 归档里同时存在 `depth=0` 的编排会话与 `depth=1` 的子代理会话；信封类错误 11 条中有 10 条发生在子代理，见第四节。

---

## 三、总账

| 面 | 会话 | 调用 | 报错 | 失败率 | 单模型子集 |
| --- | --- | --- | --- | --- | --- |
| `run_code`（内核 PTC） | 13 | 1153 | 54 | **4.68%** | flash：4/227 = **1.76%** |
| `code_run`（本仓） | 25 | 1069 | 55 | **5.14%** | flash：35/820 = **4.27%** |

`code_run` 的报错高度集中：25 个会话里 7 个零报错，而报错最多的 7 个会话合计 39 条（占 55 条的 71%），最高单个会话 8 条。P1/P3 命中的正是这几个高频会话。

---

## 四、分型

| 分型 | code_run | run_code | 归属 |
| --- | --- | --- | --- |
| 参数契约 / 插件自检（`Error: codemode: …`） | **16** | 0 | 本仓 `transport.ts` |
| 信封形状 / JS 笔误（`X.map/slice/join is not a function`） | **11** | 2 | 本仓信封 + 提示词 |
| 程序文本转义 / 语法（`Expected unicode escape`、`Expected ','`、`Unexpected token`） | 5 | 25 | 模型写码习惯（kimi 占 23） |
| 嵌套工具报错（`ToolCallError`） | 8 | 13 | 共享（基础设施 / MCP / 输入越界） |
| shell / 文件系统（`Command failed`、`ENOENT`） | 6 | 5 | 任务相关，不可横比 |
| 动态 import / 路径（`ERR_MODULE_NOT_FOUND`、`ERR_UNSUPPORTED_ESM_URL_SCHEME`） | 4 | 0 | 本仓提示词缺口 |
| 返回值契约（`program completion must be lossless JSON`） | 3 | 0 | 内核 `protocol.ts` 校验 |
| 超时 / 额度 | 0 | 4 | 运行时 |
| 中断（无结果记录） | 1 | 0 | — |
| 其他 | 1 | 5 | — |

### 4.1 参数契约 16 条的细分（全部本仓可修）

| 子类 | 条数 | 原样证据 |
| --- | --- | --- |
| **两段 JSON 拼接** | 7 | 存的 `arguments` 是 `{"title":…,"message":…}{"code":…,"description":…}`，`JSON.parse` 直接失败 → `codemode: expected an arguments object` |
| 只发 `description` / 别名键 | 8 | `{"description": …}`、`{"code_run": …, "description": "noop"}`、`{"codecode": …}` |
| `code` 是空串 | 1 | 触发同一条自检 |

关键事实：这 7 条**全部可拆分**——按平衡括号切两段后，第一段键集恒为 `{title, message}`（即 `progress_update` 的参数），第二段恒含非空 `code` 与 `description`。同一步里没有任何 `progress_update` 调用记录，说明模型是想「一条调用里既汇报又执行」，不是流式被截断。本仓当前把整段丢掉，只回一句「expected an arguments object」，模型下一轮重发（多烧一轮）。

### 4.2 信封形状 11 条的细分

| 绑定的工具 | 条数 | 典型症状 |
| --- | --- | --- |
| `glob` | 4 | `g.join is not a function` / `g1.slice` / `g.filter` —— 拿到 `{ root, paths }` 直接当数组用 |
| `code_tools_list` | 2 | `tools_list.map is not a function` —— 拿到 `{ tools }` 直接当数组用 |
| `read` | 2 | `r.split(...)` —— 拿到 `{ path, offset, lines, totalLines }` 当正文用 |
| `grep` | 1 | `g.slice` —— 拿到 `{ matches }` |
| `edit` | 1 | `restored.slice` —— 拿到 `{ … }` 当字符串 |

`glob` 与 `code_tools_list` 占 6/11，两者都是**顶层就是数组字段**的形状（`{paths}` / `{tools}`），模型最容易误当裸值。这 11 条里 10 条发生在 `depth=1` 的子代理会话。

---

## 五、机制对比：两个面到底差在哪

两条路最终都进同一个内核求值器（栈帧均为 `ptc-runtime-node/lib/process.js`），差异只在**参数契约、结果封装、提示词**三层：

| 维度 | `run_code`（内核 PTC） | `code_run`（本仓） | 后果 |
| --- | --- | --- | --- |
| 参数校验 | `defineTool` 声明 schema（`code`/`description` 必填），由内核 schema 校验器统一报 `invalid arguments: missing required property "code"` | 工具定义同样声明了 `required: ['code','description']`（`transport.ts:354-381`），但参数由 `readArguments` 自检（`transport.ts:866-895`），schema 校验没有先跑 | 本仓自检文本更长、更贴近，但**遇到整段不可解析时只回一句泛化错误**，没有把模型实际发来的内容回显，于是模型只能照原样重发 |
| 不可解析参数 | 内核 `parseArguments` 保留原始字符串（`packages/core/tools/src/batch.ts:98-106`），交给 schema 校验器 → 统一 `invalid arguments: …` | 同样拿到原始字符串，但直接判「不是对象」并丢弃 | 双方都救不回代码；本仓多丢了一份可回显、可拆分的证据 |
| 结果封装 | 原生结果值（`{path, offset, lines, totalLines}` 等） | 与 PTC 相同的原生结果值，**没有额外包一层** | 信封类错误不是包装造成的，是提示词没覆盖到 |
| 发现面 | 无 discovery 工具，模型只能靠 schema | 有 `code_tools_list/search/describe`（`discovery.ts`），且 `describe` 会回 `output` schema（已验证 `read`/`grep`/`glob`/`win_bash`/`code_tools_list` 均有） | 本仓信息更全，但**模型不查也不看长句提示** |
| 形状提示 | 无（PTC 提示词不列结果形状） | `rules.ts:321-322` 一行硬编码，只覆盖 `glob/grep/read/win_bash` 与 3 个 discovery 工具 | 硬编码会漂移；`code_tools_list` 虽在句子里，仍被误用 2 次 |
| 返回值契约 | 内核 `protocol.ts:88` 校验「完成值必须是无损 JSON」 | 同一处校验，本仓无从拦截 | 3 条 `lossless JSON` 错误属内核侧，需上游改 |
| 语法错误文本 | 内核 `new AsyncFunction(...)` 抛原始 V8 `SyntaxError`（`async-function.ts:26`） | 同一处 | `Expected unicode escape` 这类无行号无上下文的报错两边一样 |

---

## 六、四个补丁：三个已落地在本仓，一个属内核

按「确定性收益 / 改动面 / 风险」排序。改动全部在本仓，不动内核。

### P1 参数容错（最高 ROI；**已落地**，`src/host/codemode/transport.ts`）

`readArguments` 前面加了一层 `parseArguments`，按顺序认四种形态：

1. **原生对象**（正常路径）。
2. **字符串里的 JSON**：执行器把解析失败的文本原样传下来时先 `JSON.parse`。
3. **两段 JSON 拼接**：`JSON.parse` 整段失败后做**平衡括号扫描**，取「装了非空 `code` 的最后一个完整对象」；前面那段若键集是 `{title, message}` 就当作进展简报，用 `progress_update` 补发（`<callId>:ptc:0`，与程序自己的 `:ptc:1` 不撞号）。补发失败一律吞掉——简报只影响界面，不许连累程序。
4. **纯程序文本**：模型直接把源码当参数发时，按首行给出描述。

另外两处收口：别名键（`code | program | source | script | code_run | codecode | program_source`）；`description` 缺失时按 `summary → 简报标题 → 源码首行` 兜底（原来是硬失败）；拒绝时错误文本带上收到的键**与原始片段**（前 120 字符），模型下一轮能照错改。

测试：`test/codemode-argument-recovery.test.ts`（两段拼接的救援与补发顺序、简报失败不影响程序、别名键、纯文本、三级描述兜底、四种拒绝回显）。

### P2 结果形状索引（**已落地**，`src/host/codemode/rules.ts`）

- 把原来那一条「一句带过四个工具」换成了**静态形状表**，覆盖实际会被误用的十个信封：
  `read` → `{ path, offset, lines: [{ number, text }], totalLines }`、`glob` → `{ root, paths }`、`grep` → `{ matches: [{ path, lineNumber, line }] }`、`edit` → `{ path, before, after }`、`write` → `{ path, operation, before, after }`、`win_bash` → `{ stdout, stderr, exitCode }`、`web_fetch` → `{ url, statusCode, body, truncated }`、`job_output` → `{ text, job }`、`read_image` → `{ path, image }`、`skill` → `{ name, content }`；并点名 `job_list` / `list_agents` 是两个**裸数组**。
- 表后面紧跟一句兜底：清单外的（MCP、隐藏插件工具）先 `code_tools_describe({ name })` 读 `output` 顶层键再取字段。
- **为什么不从活 catalog 生成**：这段正文是系统提示的第一段，kimi-code / minimax-code 按前缀缓存计费；按 catalog 生成会让「挂一个 MCP 服务端」改写首段，把一个部署的前缀缓存整段作废。表内容全部按各工具声明过的 output schema 校对过（用 `code_tools_describe` 逐个核对：`read`/`grep`/`glob`/`win_bash`/`edit`/`write`/`web_fetch`/`job_output`/`read_image`/`skill` 都在其中），且是部署内常量——既不漂移也不破坏缓存。真要漂移，兜底那句指向的 `describe` 仍然是权威。

测试：`test/codemode-section-shapes.test.ts`（覆盖点名、裸数组、describe 兜底、逐字节恒定、语言分支）。

### P3 两条程序文本规则（**已落地**，同一处恒定段，仅 TypeScript 形态）

1. **路径与正则**：Windows 路径写正斜杠或 `String.raw`；普通字符串里的 `C:\Users` 会被读成 `\U` 转义，程序根本进不了求值（`Expected unicode escape`）。正则的 `\d`、`\.` 同理。
2. **程序不是模块**：`import('./src/x.ts')`、`import('vscode')` 解析不了（程序在新进程里没有模块图）；读文件用 `tools.read`，`await import('node:fs')` 只对 Node 内置模块有效。

Python 形态换成它自己的读法（`page["lines"]`），不出现这两条 TypeScript 专属规则。测试同上文件。

### P4 内核侧两类问题（**不在本仓**，交上游）

- `program completion must be lossless JSON`（3 条）：`packages/ptc-runtime/ptc-runtime-node/src/protocol.ts:88` 与深层快照的拒收；建议上游改成「丢弃 `undefined` 键 / 视为 `null`」。在改之前，本仓只能继续用无损 JSON 那条提示预防。
- 语法错误的可诊断性：`async-function.ts:26` 直接 `new AsyncFunction`，`Expected unicode escape` 没有行列号。上游若在编译失败时回「第 N 行、具体非法转义序列」，模型一次就能改对。

---

## 七、效果与验证

### 7.1 已落地的机械性收益（不需要模型配合）

| 改动 | 直接消掉的报错 | 依据 |
| --- | --- | --- |
| P1 两段拼接救援 | 7 条 `codemode: expected an arguments object` 全部转成功 | 7/7 的 `arguments` 都能切成「简报 + 程序」，第二段恒含非空 `code` |
| P1 别名键 / 纯文本 / 描述兜底 | 3 条别名键不再报错；5 条「只发 description」仍要模型重发，但错误文本现在带原始片段 | 见 `test/codemode-argument-recovery.test.ts` |
| P3 两条文本规则 | 5 条转义/语法 + 4 条 import 里的绝大部分提前消失（预防性） | 属提示词，靠下一批会话验证 |

### 7.2 失败率预期（改动后待观测，不是实测）

| 状态 | code_run 失败率 | 同模型（flash）子集 | 对比 run_code |
| --- | --- | --- | --- |
| 改动前（本次审计实测） | 5.14% | 4.27% | 4.68%（flash 1.76%） |
| P1 生效后 | ≈4.5% | ≈3.6% | — |
| P1 + P2 | ≈3.8% | ≈2.6% | — |
| P1 + P2 + P3 | **≈3.2%** | **≈2.0%** | 追平 PTC 的 flash 子集 |

剩下的底盘是两类不可修的：嵌套工具报错（8 条，基础设施/MCP/输入越界）与结构性 shell 失败（6 条）。

### 7.3 本轮验证

```powershell
npm run typecheck   # host + test + scripts 三份 tsconfig 全部通过
npm test            # 371 个测试文件、6815 项通过（新增 `codemode-argument-recovery` 10 项与 `codemode-section-shapes` 6 项）
npm run build       # lib/index.js、lib/codemode.js 等 9 个产物构建成功
```

**真实参数回放**（把归档里那 7 条「两段拼接」的原始 `arguments` 原样喂给新传输层的 `presentCall`）：

| 会话 | 救回的源码长度 | 与原第二段的 `code` 逐字节一致 | 卡片标题（原第二段的 description） |
| --- | --- | --- | --- |
| `1373d144` | 201 | ✅ | 定位批量删除与行内删除按钮 |
| `2fe5c25c` ×3 | 497 / 1829 / 2077 | ✅ | Read SquadDetail… / Update English owning note… / Update owning note (en)… |
| `3ab7a535` ×3 | 451 / 237 / 299 | ✅ | List dsh-agents files / Read SessionTarget definition / Read apply-inject test |

7/7 全部逐字节复原；改动前这 7 条各自只回一句 `codemode: expected an arguments object` 并丢掉整段程序。

---

## 八、不做的事（明确的取舍）

- **不自动修 `\U` 转义**：静默改写字符串语义，代价大于收益。
- **不在 envelope 上挂「会抛友好错误的数组方法」**：把 `{paths}` 伪装成数组会污染一切 `typeof`/序列化判断，且掩盖真实形状。
- **schema 里 `description` 仍然是必填**：运行期只是容忍漏发并按三级兜底（本仓的 executor 不走内核 schema 校验，模型漏字段时不能靠 schema 拦）。放宽回放字段等于把成本转移到审计面。
- **不把 PTC 的报错文本照抄过来**：`invalid arguments: …` 更短，但本仓现有文本已经把「收到哪些键」说清楚了，P1 的原始片段回显比换措辞更有用。

---

## 九、前缀缓存核对（kimi-code / minimax-code 按缓存计费）

改动动到了系统提示首段，必须证明它**没有破坏前缀缓存**。四项证据：

| 检查 | 方法 | 结果 |
| --- | --- | --- |
| 工具 schema 未变 | `git diff <改动前提交> -- src/host/codemode/transport.ts` 只看 schema/描述构造与注册 | **0 处**改动；hunk 只落在常量、`presentCall`、`execute` 插入与解析器块；`buildTransportParameters` / `buildTransportDescription` / `tools.register` 全未触碰 |
| 改动前前缀本来就稳定 | 14 个 kimi 会话里取 6 个走 Code Mode 的，抽出 `## Code Mode` 段比较 | **1 个变体**（6 个会话逐字节相同，3242 字符） |
| 改动后仍恒定 | 四种形态（ts body / ts repl / py body / py repl）各构建两次比较；扫正文里的会话标识 | 四次比对全部相等；正文不含 session id、`mcp__`、遮蔽计数；`tools:sdk` 段是 `interpolate: false` |
| 增量是一次性的 | 老正文 vs 新正文逐行差分 | 3242 → 4251 字符（**+1009**，约 250 token）；29 行里 28 行原样，1 行换成 6 行，替换内容对每个会话都相同 |

代价与影响面：

- 每个新会话多一次 ~250 token 的未命中输入，之后进入缓存。走 Code Mode 的那 6 个 kimi 会话改动前命中率 **97.9%**（67.2M 缓存读 / 1.45M 新读，长会话 98.8–98.9%），250 token 相当于一条 20 万 token 前缀的 0.12%。
- 另外 8 个 kimi 会话用的是内核 PTC `run_code` 预设，系统提示里根本没有这段正文，**零影响**。
- 关键的反面：如果按最初的设想「从活 catalog 生成形状表」，挂载/卸载一个 MCP 服务端就会改写这段正文——那才是真正的缓存破坏。静态表正是为守住这条不变量。

---

## 十、复现方法

会话归档是**追加式多帧 zstd**（`node:zlib.zstdDecompressSync` 只解第一帧，必须逐帧切）：

```js
import zlib from 'node:zlib'
import fs from 'node:fs'
const MAGIC = 0xFD2FB528
export function decode(file) {
  const buf = fs.readFileSync(file); const frames = []; let o = 0
  while (o < buf.length) {
    const start = o
    if (buf.readUInt32LE(o) !== MAGIC) throw new Error('bad frame at ' + o)
    o += 4
    const d = buf.readUInt8(o); o += 1
    const csf = d >>> 6, single = (d & 0x20) !== 0, ck = (d & 0x04) !== 0, dict = d & 0x03
    o += (single ? 0 : 1) + (dict === 3 ? 4 : dict) + (csf === 0 ? (single ? 1 : 0) : 1 << csf)
    for (;;) {
      const bh = buf.readUIntLE(o, 3); o += 3
      const last = (bh & 1) !== 0, type = (bh >>> 1) & 3, size = bh >>> 3
      o += type === 1 ? 1 : size
      if (last) break
    }
    if (ck) o += 4
    frames.push({ start, end: o })
  }
  return frames.map(f => zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8'))
    .join('').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l))
}
```

统计：遍历 `~/.dsh/sessions/*/*/session.v4.jsonl.zstd` → 建 `tool/result` 的 `toolCallId → message` 映射 → 对每条 `tool/call` 的 `code_run` / `run_code` 取 `message.isError` → 按首行文本分型（正则见第四节表格）。

> 上面的片段为可读性省略了越界防护：真实归档的最后可能有一条被打断的半帧（torn frame），正式脚本应在每个 `readUInt*` 前判剩余字节数，遇到半帧即停并保留已解出的帧。
