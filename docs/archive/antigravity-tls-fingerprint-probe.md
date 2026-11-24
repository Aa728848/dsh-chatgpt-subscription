# Antigravity TLS 指纹：能不能在 Node 里对齐官方的 Go 客户端

**结论：不能。** 官方 `/v1internal:*` 请求由 Electron 壳里启动的 Go `language_server` 发出，TLS ClientHello 是 Go `crypto/tls` 的形状。Node 侧唯一能改 ClientHello 的手段是原生模块 `tls-impersonate`，实测它可以复现**大部分**形状，但有三处由 OpenSSL 锁定、改不了，因此 JA3/JA4 与官方始终不同。本仓库因此**不引入该依赖**，也不提供 TLS 指纹伪装开关。

本文记录实测环境、方法、数据与不做的理由，供以后有人再提这件事时直接复用。

---

## 1. 为什么这条线值得量一次

社区里唯一真正"天然对齐"的是 Go 写的 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)：它把传输钉成 HTTP/1.1，清空 `TLSNextProto`，并把 `TLSClientConfig.NextProtos` 设为 `nil`（官方不发 ALPN 扩展），再加上"每凭据一个连接池"。它不需要模仿 ClientHello——因为它就是 Go。

JS/TS 实现（包括本仓库）在这一层要么放弃，要么上原生模块。本文量的是后者到底能走多远。

## 2. 方法

1. 从 Go 源码抄出官方默认值（版本：`golang/go` master，2026-11 快照）：
   - `src/crypto/tls/cipher_suites.go`：`cipherSuitesPreferenceOrder`（TLS1.2 偏好序）与 `disabledCipherSuites`；
   - `src/crypto/tls/defaults.go`：`defaultCipherSuitesTLS13`（`0x1301,0x1302,0x1303`）、`curvePreferenceOrder`、`defaultSupportedSignatureAlgorithms`；
   - `src/crypto/tls/handshake_client.go`：`makeClientHello` —— TLS1.2 列表在前、TLS1.3 三套 `append` 在后。
2. 得出 Go 默认（有 AES-GCM 硬件）的 cipher 列表：
   `0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc009, 0xc013, 0xc00a, 0xc014, 0x1301, 0x1302, 0x1303`（13 套；RSA 密钥交换、3DES、RC4、CBC_SHA256 都被 `disabledCipherSuites` 关掉）。
   曲线：`0x11ec(X25519MLKEM768), 0x11eb, 0x11ed, 0x0202(MLKEM1024), 0x001d(X25519), 0x0017, 0x0018, 0x0019`。
   签名算法：`0x0904,0x0905,0x0906,0x0804,0x0403,0x0807,0x0805,0x0806,0x0401,0x0501,0x0601,0x0503,0x0603,0x0201,0x0203`。
3. 用官方便携版 Node（`v24.20.0`，OpenSSL 3.5.7，解压在临时目录，不安装到系统）调用 `tls-impersonate@0.2.2` 的 `impersonate(spec)`，再把返回的 `tlsOptions` 交给 `tls.connect`，用一个只读首包的本地 TCP 服务抓 ClientHello 比对。

## 3. 实测数据

| 环境 | `impersonate()` 表现 |
| --- | --- |
| **Node 24.14.1**（本机默认，也是仓库当前的运行环境） | 进程**直接退出**（exit 127，无 stderr、无 JS 异常）：原生层崩，不是"优雅失败" |
| **Node 24.20.0 / OpenSSL 3.5.7** | 可用。`isSupported()` = `true`；返回 `secureContext`（+`requestOCSP`），Cipher/签名算法/扩展都通过 `SecureContext` 下发 |

Node 24.20 上 `impersonate()` 报出的 `unsupported`（模块自己如实报告，非本仓库推断）：

| 扩展 | 原因 |
| --- | --- |
| `11` `ec_point_formats` | 内容由 OpenSSL 控制，只能发 `[0,1,2]`；Go 只发 `[0]` |
| `50` `signature_algorithms_cert` | 模块不支持"无数据 + 无内置默认值"的自定义扩展 |

实际发出的 ClientHello：

```
cipherCount = 13
ciphers     = 0x1301,0x1302,0x1303,0xc02b,0xc02f,0xc02c,0xc030,0xcca9,0xcca8,0xc009,0xc013,0xc00a,0xc014
extensions  = [18, 65281, 0, 11, 10, 5, 23, 13, 43, 45, 51]
```

与 Go 的差异（都是 OpenSSL 侧不可控的）：

1. **TLS1.3 套件被排到最前**。Go 是 TLS1.2 列表在前、`0x1301/0x1302/0x1303` 追加在后；OpenSSL 恒定把 TLS1.3 提到最前 → cipher 序不同，JA3 的 cipher 段不同。
2. **`ec_point_formats` 内容不同**（`[0,1,2]` vs Go 的 `[0]`）→ 扩展内容不同。
3. **扩展顺序由 OpenSSL 决定**，模块只能选择"发哪些"，不能选择"按什么顺序发" → 扩展序不同。
4. 扩展 `50` 发不出去（Go 会发 `signature_algorithms_cert`）。

结论：即便上原生模块，也只能做到"cipher 集合、曲线、签名算法接近"，**JA3/JA4 不会与官方相同**。

### 3.1 另外两项：头形状与 ALPN（可做的那一半）

这两项不依赖原生模块，实测都能改：

| 项 | 现状（Node fetch 默认） | 改成 | 验证 |
| --- | --- | --- | --- |
| 请求头 | 每条请求多 `sec-fetch-mode: cors`、`accept-language: *`、`accept-encoding: gzip, deflate` | dispatcher 层剥掉前两个（`fetch` 无接口关闭），`Accept-Encoding` 显式发 `gzip` | 本地 HTTP 服务抓 `rawHeaders`：两个头消失、`authorization` 仍在；`Accept-Encoding` 变为 `gzip` |
| ALPN | TLS hello 里 offer `http/1.1` | 直连用自定义 connector，不设 `ALPNProtocols` | hello 里没有扩展 16；对 GFE 真跑 `loadCodeAssist` 得 401，与带 ALPN 的对照组逐字一致 |

两处坑：

1. **不能剥 `connection`**：undici 的 HTTP/1.1 writer 会重新加 `connection: keep-alive`，剥了也会回来（Go 不发这个头，属已知差异）。
2. **connector 必须显式写 SNI**：undici 交给 connector 的 `servername` 是空的，直接用来握手会被 Cloud Code 拒（`SSL_ALERT_HANDSHAKE_FAILURE`）；`servername` 要回落到 host。
3. **代理路径的 ALPN 改不了**：`ProxyAgent` 的 endpoint connector 在内部构造，`requestTls` 的 TLS 选项会被它覆盖 `ALPNProtocols`。

## 4. 为什么不做

| 理由 | 说明 |
| --- | --- |
| 收益不可证 | 没有任何实测显示 Cloud Code / GFE 按 JA3/JA4 拒绝请求；Node、Python、Rust 的社区实现都在正常跑。唯一把 TLS 列为风险的是 [AntigravityManager#408](https://github.com/Draculabo/AntigravityManager/issues/408) 的**提案**，属"Detection Risk"设想，不是观测 |
| 成本真实 | 原生依赖（五平台预编译产物）+ **Node ≥24.15 硬门槛**（低于此版本直接崩进程，无法降级）+ 一份要跟 Go 版本演进的规格 |
| 到不了终点 | 如上，OpenSSL 锁死排序与 `ec_point_formats`，除非自己打 OpenSSL 补丁或换成 Go 侧车 |

真要对齐，正确的形态是**用 Go 写**（像 CLIProxyAPI 那样，让 ClientHello 天然同源），而不是在 Node 里模仿。这条不作为本插件的方向。

## 5. 本仓库实际做了什么（与没做什么）

做了（见 CHANGELOG 中 `[antigravity]` 的四条）：

- 内容请求只发 UA；`onboardUser` 用控制面身份；UA 版本从 Hub 更新清单跟随；`requestId` 用 `agent-<uuid>`；`loadCodeAssist` 只发 `{ideType}`；
- 传输：HTTP/1.1（含代理路径），每凭据独立连接池；
- **头形状**：dispatcher 层剥掉 `sec-fetch-mode` / `accept-language`（`fetch` 自己加的，`fetch` 没有接口关闭），实测线上 `rawHeaders` 已无这两项；`Accept-Encoding` 显式发 `gzip`；
- **直连 ALPN**：自定义 connector 不设 `ALPNProtocols` → hello 里没有 ALPN 扩展（原生同样不发）；SNI 显式写入（缺 SNI 会 `SSL_ALERT_HANDSHAKE_FAILURE`，实测过）。

没做：

- TLS ClientHello 伪装（本文的结论）；
- **代理路径的 ALPN 抑制**：`ProxyAgent` 把 endpoint connector 写死在内部，`requestTls` 传进去的 TLS 选项会被它覆盖 `ALPNProtocols`，除非自己重写 CONNECT；
- `connection: keep-alive` 的剥离：undici 的 HTTP/1.1 writer 会重新加，剥不掉（Go 不发这个头，属已知差异）。

## 6. 复现要点

`impersonate(spec)` 的 spec 形状见 `tls-impersonate` README（`cipherSuites` 数字数组、`extensions` 按 `{type}` 顺序、`supportedGroups`、`signatureAlgorithms`、`alpnProtocols`）。抓 ClientHello 只需要：本地 `net.createServer` 收首包 → 跳过 TLS record(5)/handshake(4)/version(2)/random(32)/sessionId，读 cipher 长度与扩展长度，即可拿到 cipher 列表与扩展类型序列（本仓库实测脚本即按此实现，约 40 行）。
