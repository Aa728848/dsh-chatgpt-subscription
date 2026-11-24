# Claude Code `cch` 算法与用法

`x-anthropic-billing-hdr` 是 Claude Code 在每个 `/v1/messages` 请求的 `system[0]` 里携带的计费头，其中 `cch` 是 5 位十六进制的请求签名。本文给出该签名的算法与调用方式（对应 Claude Code 2.1.330）。

---

## 1. 算法

```text
cch = (xxHash64(hashView(body), SEED) & 0xFFFFF).toString(16).padStart(5, '0')

SEED = 0x4D659218E32A3268
```

| 项 | 值 |
| --- | --- |
| 哈希函数 | xxHash64（64 位，非加密哈希） |
| 种子 | `0x4D659218E32A3268` |
| 取位 | 低 20 位（`& 0xFFFFF`） |
| 输出格式 | 5 位小写十六进制，左补 `0` |
| 被签名的数据 | `hashView(body)`，**不是**线上字节 |

### 1.1 `hashView`

哈希前先对「仍带 `cch=00000` 占位符的完整序列化 body」做两步纯文本替换，顺序固定：

```js
body
  .replace(/"model":"[^"]*"/g, '"model":""')            // 1. 所有 model 字符串值置空
  .replace(/"max_tokens":\d+,|,?"max_tokens":\d+/g, '')   // 2. 删除所有数字型 max_tokens
```

| 规则 | 说明 |
| --- | --- |
| 纯文本匹配 | 不解析 JSON，工具 schema 里嵌套的同名字段同样命中 |
| `model` 边界 | 匹配停在第一个 `"`，值中含转义引号时只清到该引号 |
| `max_tokens` | 只删数字值；`"max_tokens":"auto"` 这类非数字不动 |
| 顺序 | 先 `model` 后 `max_tokens`，不可交换 |

### 1.2 替换

把 body 里 `cch=00000` 中的 `00000` 换成算出的 5 位值，其余字节不变。占位符与结果等长，`Content-Length` 不变。

---

## 2. 计费头形态

`system[0]` 的文本形如：

```text
x-anthropic-billing-hdr: cc_version=2.1.330.9e1; cc_entrypoint=sdk-cli; cch=6f6e6; cc_prompt_id=<uuid>; cc_turn_origin=sdk; cc_prompt_index=0; cc_turn_index=1;
```

| 字段 | 说明 |
| --- | --- |
| `cc_version` | `版本号.三位十六进制`。三位后缀 = `sha256("59cf53e54c78" + 首条 user 文本第 4/7/20 个字符 + 版本号)` 的前 3 位 hex；缺字符用 `0` 顶替 |
| `cc_entrypoint` | 入口标识，print 模式为 `sdk-cli`，交互模式为 `cli` |
| `cch` | 本文的签名，仅 first-party / vertex 场景出现 |
| `cc_prompt_id` 等 | 会话上下文，可选，不影响 `cch` 计算 |

注意：`cch` 的输入是**整个 body**，所以任何参与序列化的字段（model、tools、messages、thinking、metadata …）都会影响结果；改动 body 必须重算。

---

## 3. 使用方法

### 3.1 引入

`cch.mjs` 是零依赖 ESM 模块（Node ≥ 22）。两个来源任选：

- 下面的 §5 全文（直接复制成 `cch.mjs`）；
- skill `capture-claude-cch` 的 `lib/cch.mjs`（`~/.dsh/skills/capture-claude-cch/lib/cch.mjs`）。

### 3.2 计算与签名

```js
import { cchToken, signBody } from './cch.mjs';

// body：最终序列化结果，计费块里仍是 ` cch=00000;`
const token = cchToken(body);   // '6f6e6'
const wire  = signBody(body);   // 已替换好的字节串，可直接发送
```

### 3.3 接入位置

`cch` 依赖**最终字节串**（含字段顺序、空格），因此签名必须在序列化之后：

```js
const body = JSON.stringify(payload);        // 计费块里写 ` cch=00000;`
const wire = signBody(body);                 // 在这里签名
await fetch(url, { method: 'POST', headers, body: wire });
```

不要在对象阶段签，也不要在 `JSON.stringify` 之前签。

### 3.4 API

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `CCH_SEED` | `bigint` | 种子常量 |
| `CCH_MASK` | `bigint` | `0xFFFFF` |
| `CCH_PATTERN` | `RegExp` | `/\bcch=([0-9a-f]{5});/` |
| `xxHash64` | `(bytes: string \| Uint8Array, seed?: bigint) => bigint` | 标准 xxHash64 |
| `cchHashView` | `(body: string) => string` | 上述两步改写 |
| `cchToken` | `(body: string, seed?: bigint) => string` | 返回 5 位 hex；`seed` 默认取 `CCH_SEED` |
| `signBody` | `(body: string, seed?: bigint) => string` | 替换占位符并返回最终 body；无占位符时原样返回 |

### 3.5 自测

```bash
node cch.test.mjs                        # 标准向量
node cch.test.mjs sample1.json           # 再对已保存的请求体验算
# xxh64 KAT: pass; samples: 1/1
```

标准向量可随时跑；对真实请求体的验算需要先用 skill `capture-claude-cch` 保存一份样本（见该 skill 的 §4）。
该 skill 里已带一份同样内容的 `cch.test.mjs`（`~/.dsh/skills/capture-claude-cch/cch.test.mjs`），可直接运行。

---

## 4. 注意事项

1. **种子随客户端版本轮换。** 本文的种子对应 2.1.330；升级客户端后需要重新取值，否则 `cch` 会算错。
2. **不要用 `crypto` 的哈希替代。** Node 内置没有 xxHash64，必须用本模块（或等价的 xxHash64 实现）。
3. **必须先 `hashView` 再哈希。** 直接哈希线上字节一定会得到错误结果。
4. **占位符长度固定 5 位。** 生成计费头时写 ` cch=00000;`，不要写别的长度，否则替换后长度变化会导致 `Content-Length` 不匹配。
5. **非 first-party / vertex 场景不带 `cch`。** 走自定义网关时可以不带该字段。

---

## 5. 参考实现 `cch.mjs`

```js
/**
 * cch — Claude Code request attestation.
 *
 *   cch = (xxHash64(hashView(body with cch=00000), SEED) & 0xFFFFF) as 5 lowercase hex digits
 *
 * hashView empties every "model":"..." string value and drops every numeric "max_tokens"
 * member, at any depth. The client hashes that view, not the wire bytes.
 *
 * Zero dependencies; runs on Node >= 22.
 */
export const CCH_SEED = 0x4d659218e32a3268n;
export const CCH_MASK = 0xfffffn;
export const CCH_PATTERN = /\bcch=([0-9a-f]{5});/;

const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;
const M64 = 0xffffffffffffffffn;

const rotl = (x, r) => ((x << r) | (x >> (64n - r))) & M64;

function round(acc, input) {
  acc = (acc + input * P2) & M64;
  acc = rotl(acc, 31n);
  return (acc * P1) & M64;
}

function mergeRound(acc, val) {
  val = round(0n, val);
  acc = (acc ^ val) & M64;
  return (acc * P1 + P4) & M64;
}

/** Canonical xxHash64 over raw bytes. */
export function xxHash64(bytes, seed = 0n) {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  const len = buf.length;
  let i = 0;
  let h;

  if (len >= 32) {
    let v1 = (seed + P1 + P2) & M64;
    let v2 = (seed + P2) & M64;
    let v3 = seed & M64;
    let v4 = (seed - P1) & M64;
    while (i <= len - 32) {
      v1 = round(v1, buf.readBigUInt64LE(i));
      v2 = round(v2, buf.readBigUInt64LE(i + 8));
      v3 = round(v3, buf.readBigUInt64LE(i + 16));
      v4 = round(v4, buf.readBigUInt64LE(i + 24));
      i += 32;
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & M64;
    h = mergeRound(h, v1);
    h = mergeRound(h, v2);
    h = mergeRound(h, v3);
    h = mergeRound(h, v4);
  } else {
    h = (seed + P5) & M64;
  }

  h = (h + BigInt(len)) & M64;

  while (i + 8 <= len) {
    h = (h ^ round(0n, buf.readBigUInt64LE(i))) & M64;
    h = (rotl(h, 27n) * P1 + P4) & M64;
    i += 8;
  }
  if (i + 4 <= len) {
    h = (h ^ ((BigInt(buf.readUInt32LE(i)) * P1) & M64)) & M64;
    h = (rotl(h, 23n) * P2 + P3) & M64;
    i += 4;
  }
  while (i < len) {
    h = (h ^ ((BigInt(buf[i]) * P5) & M64)) & M64;
    h = (rotl(h, 11n) * P1) & M64;
    i += 1;
  }

  h ^= h >> 33n;
  h = (h * P2) & M64;
  h ^= h >> 29n;
  h = (h * P3) & M64;
  h ^= h >> 32n;
  return h;
}

/** Exactly the client's two plain-text rewrites, in this order. */
export function cchHashView(body) {
  return body
    .replace(/"model":"[^"]*"/g, '"model":""')
    .replace(/"max_tokens":\d+,|,?"max_tokens":\d+/g, '');
}

/** cch token for a body that still carries the cch=00000 placeholder. */
export function cchToken(body, seed = CCH_SEED) {
  const h = xxHash64(cchHashView(body), seed);
  return (h & CCH_MASK).toString(16).padStart(5, '0');
}

/** Replace the placeholder in a serialized body and return the final bytes. */
export function signBody(body, seed = CCH_SEED) {
  const m = /\bcch=00000;/.exec(body);
  if (m === null) return body;
  const token = cchToken(body, seed);
  return body.slice(0, m.index + 4) + token + body.slice(m.index + 9);
}

export default { CCH_SEED, CCH_MASK, CCH_PATTERN, xxHash64, cchHashView, cchToken, signBody };
```

---

## 6. 自测脚本 `cch.test.mjs`

```js
/**
 * cch self-test: four xxHash64 known-answer vectors, plus optional verification of saved
 * request bodies.
 *
 *   node cch.test.mjs                              # vectors only
 *   node cch.test.mjs sample1.json sample2.json    # also verify saved bodies
 *
 * A sample file is one of:
 *   "<body JSON string>" | { "raw": "<body>" } | { "r1": "<body>", "r2": "<body>" } |
 *   an array of any of those
 */
import fs from 'node:fs';
import { cchToken, signBody, xxHash64 } from './cch.mjs';

const KAT = [
  ['', 'ef46db3751d8e999'],
  ['a', 'd24ec4f1a98c6e5b'],
  ['abc', '44bc2cf5ad770999'],
  ['xxhash', '32dd38952c4bc720'],
];

let ok = true;
for (const [input, want] of KAT) {
  const got = xxHash64(input, 0n).toString(16).padStart(16, '0');
  const pass = got === want;
  ok = ok && pass;
  console.log((pass ? 'OK   ' : 'FAIL ') + 'xxh64(' + JSON.stringify(input) + ') = ' + got);
}

const asList = (loaded) => {
  if (typeof loaded === 'string') return [loaded];
  if (Array.isArray(loaded)) return loaded.flatMap(asList);
  if (loaded && typeof loaded === 'object') {
    if (typeof loaded.raw === 'string') return [loaded.raw];
    const strings = Object.values(loaded).filter((v) => typeof v === 'string');
    if (strings.length > 0) return strings;
  }
  return [];
};

let pass = 0, total = 0;
for (const file of process.argv.slice(2)) {
  for (const raw of asList(JSON.parse(fs.readFileSync(file, 'utf8')))) {
    const body = JSON.parse(raw);
    const header = (body.system && body.system[0] && body.system[0].text) || '';
    const m = header.match(/cch=([0-9a-f]{5})/);
    if (!m) { console.log('SKIP ' + file + ' (no cch in system[0])'); continue; }
    total++;
    const placeholder = raw.replace('cch=' + m[1], 'cch=00000');
    const token = cchToken(placeholder);
    const roundTrip = signBody(placeholder) === raw;
    const good = token === m[1] && roundTrip;
    if (good) pass++;
    ok = ok && good;
    console.log((good ? 'OK   ' : 'FAIL ') + file + ' expect=' + m[1] + ' computed=' + token + ' roundTrip=' + roundTrip);
  }
}

console.log('');
console.log('xxh64 KAT: ' + (ok ? 'pass' : 'FAIL') + (total ? '; samples: ' + pass + '/' + total : ''));
if (!ok) process.exitCode = 1;
```
