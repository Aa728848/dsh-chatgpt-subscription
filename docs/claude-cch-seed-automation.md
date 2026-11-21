# Claude Code cch 种子自动提取

## 目的与边界

`.github/workflows/claude-cch-seed.yml` 每 6 小时检查 npm 的
`@anthropic-ai/claude-code` 最新稳定版，也可以通过 **Run workflow** 指定历史版本。
当最新版本等于 `CLAUDE_CODE_DEFAULT_CLI_VERSION` 时直接跳过；否则下载同版本的官方
`@anthropic-ai/claude-code-win32-x64` 包并执行提取。

工作流只生成经过验证的 JSON 证据和 Step Summary，不直接修改运行时版本表。审核结果后，
仍需把 `{ version, seed }` 加入 `CLAUDE_CODE_VERSION_PROFILES`，并在需要升级默认版本时
同步更新 `CLAUDE_CODE_DEFAULT_CLI_VERSION` 与 `CLAUDE_CODE_CCH_SEED`。

当前自动路径限定 Windows x64。它不是跨架构反编译器；macOS/Linux 或 ARM64 需要另行验证。

## 提取与验证流程

1. 启动仅监听 `127.0.0.1` 的 HTTP 服务，使用 dummy key 和全新的临时配置目录启动 Claude Code。
2. 分别运行三次，保存带不同会话字段的 `/v1/messages` 请求；返回 HTTP 500，不等待模型回复。
3. 扫描 Windows x64 二进制中的 `REX.W + B8..BF`（`movabs r64, imm64`）立即数，
   不依赖某个版本的固定文件偏移。
4. 对每个候选计算 `xxHash64(hashView(body), seed) & 0xFFFFF`，先用全部样本消歧，
   再执行 `cch=00000` 签名往返，要求与原始请求逐字节相同。
5. 只有唯一候选通过全部样本时才输出 `status: verified`。零命中、多命中、样本不足或
   重复请求都会使工作流失败，不会猜测种子。

如果新版编译器不再使用 `movabs`，可在人工诊断时用 `--range 0xSTART:0xEND` 对缩小后的
区间逐字节扫描。不要把整个二进制作为常规回退范围。

抓包不会使用真实凭据；JSON 产物只含版本、种子、二进制 SHA-256、候选数量和样本元数据，
原始请求体不会上传为 Actions artifact。

## 本地命令

在仓库根目录使用 Node 22.19+：

```powershell
node scripts/claude-code-cch-seed.ts capture --binary <claude.exe> --out <captures-dir> --runs 3
node scripts/claude-code-cch-seed.ts find --binary <claude.exe> --captures <captures-dir> --version <x.y.z> --output <result.json>
node scripts/claude-code-cch-seed.ts verify --seed <0x...> --captures <captures-dir> --version <x.y.z>
```

隔离配置目录交由操作系统临时目录机制回收；脚本不执行递归删除。

## 历史版本实测

以下均使用官方 Windows x64 npm 包，每版三次独立回环抓包，全部唯一命中并通过逐字节往返：

| Claude Code | 去重候选数 | 提取种子 | 样本 | 立即数偏移 |
| --- | ---: | --- | ---: | ---: |
| 2.1.288 | 32,189 | `0x4d659218e32a3268` | 3/3 | 22,345,434 |
| 2.1.289 | 32,280 | `0x4d659218e32a3268` | 3/3 | 22,345,434 |
| 2.1.300 | 35,863 | `0x4d659218e32a3268` | 3/3 | 27,162,362 |
| 2.1.329 | 52,733 | `0x4d659218e32a3268` | 3/3 | 38,567,226 |
| 2.1.330 | 52,696 | `0x4d659218e32a3268` | 3/3 | 38,567,226 |

这些结果证明当前扫描规则覆盖上述版本，不证明未来种子一定不变。报告提及的旧种子
`0x6e52736ac806831e` 没有被这些新版本接受；合成单测另行覆盖了不同种子的选择与错误种子拒绝。
