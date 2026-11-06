/**
 * 轻量同步语法高亮分词器（TypeScript / JavaScript 与 Python），直接输出宿主主题的
 * `--shiki-*` CSS 变量颜色。
 *
 * 选择内建词法扫描而非打包整套 Shiki 引擎：
 * 1. 宿主样式表（`ui-theme`）已在全局 `:root` 提供 `--shiki-*` 令牌，明暗主题自动切换零色差；
 * 2. 同步零延迟、零额外 bundle 体积，流式 `preparing` 阶段亦可逐帧平滑着色；
 * 3. 覆盖 `code_run` 常见语法：单双引号字符串、嵌套 `${...}` 模板字符串、正则表达式字面量、
 *    单/多行注释、Python 三引号字符串、关键字、内置常量、数字、函数调用与标点符号。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/codemode/highlight
 */

export type CodeLanguage = 'typescript' | 'python'

export type HighlightTokenKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'string-expression'
  | 'comment'
  | 'constant'
  | 'function'
  | 'parameter'
  | 'punctuation'

export interface HighlightToken {
  readonly text: string
  readonly kind: HighlightTokenKind
}

/** 宿主 `ui-theme/src/styles/shiki.css` 定义的标准变量表（带合理回退色以兼容测试环境）。 */
export const SHIKI_TOKEN_COLORS: Readonly<Record<HighlightTokenKind, string | undefined>> = {
  plain: undefined,
  keyword: 'var(--shiki-token-keyword, #d6336c)',
  string: 'var(--shiki-token-string, #2f9e44)',
  'string-expression': 'var(--shiki-token-string-expression, #2b8a3e)',
  comment: 'var(--shiki-token-comment, #868e96)',
  constant: 'var(--shiki-token-constant, #1c7ed6)',
  function: 'var(--shiki-token-function, #6741d9)',
  parameter: 'var(--shiki-token-parameter, #e8590c)',
  punctuation: 'var(--shiki-token-punctuation, #495057)',
}

/** 单字符数超长保护上限（与宿主 `TOKENIZE_MAX_LINE_LENGTH` 对齐，防止超长单行卡顿）。 */
const MAX_HIGHLIGHT_CHARS = 100_000

const TS_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally', 'for',
  'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'infer', 'instanceof',
  'interface', 'is', 'keyof', 'let', 'module', 'namespace', 'new', 'of', 'override', 'package',
  'private', 'protected', 'public', 'readonly', 'return', 'satisfies', 'set', 'static', 'super',
  'switch', 'throw', 'try', 'type', 'typeof', 'using', 'var', 'void', 'while', 'with', 'yield',
])

const TS_CONSTANTS = new Set([
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'this', 'globalThis', 'console',
  'Promise', 'Math', 'JSON', 'Object', 'Array', 'Map', 'Set', 'RegExp', 'Error', 'String',
  'Number', 'Boolean', 'Buffer', 'process',
])

const PY_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'match', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
])

const PY_CONSTANTS = new Set([
  'True', 'False', 'None', 'self', 'cls', 'Ellipsis', 'NotImplemented',
])

/** 允许紧跟正则表达式字面量的前置关键字。 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'throw', 'case', 'in', 'of', 'typeof', 'instanceof', 'void', 'delete', 'new', 'yield', 'await',
])

/** 允许紧跟正则表达式字面量的末尾标点字符。 */
const REGEX_PRECEDING_PUNCT = new Set([
  '(', '[', '{', ',', ';', ':', '=', '!', '?', '&', '|', '^', '~', '+', '-', '*', '%', '<', '>',
])

/**
 * 将完整源码切分为带颜色类别的跨行数组（每个子数组代表源码的一行）。
 */
export function tokenizeCodeLines(code: string, language: CodeLanguage = 'typescript'): HighlightToken[][] {
  const normalized = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  if (trimmed.length === 0) return [[{ text: '', kind: 'plain' }]]
  if (trimmed.length > MAX_HIGHLIGHT_CHARS) {
    return trimmed.split('\n').map((line) => [{ text: line, kind: 'plain' }])
  }
  const flat = language === 'python' ? scanPython(trimmed) : scanTypeScript(trimmed)
  return splitTokensIntoLines(flat)
}

function pushToken(out: HighlightToken[], text: string, kind: HighlightTokenKind): void {
  if (text.length === 0) return
  const prev = out[out.length - 1]
  if (prev !== undefined && prev.kind === kind) {
    out[out.length - 1] = { text: prev.text + text, kind }
    return
  }
  out.push({ text, kind })
}

function splitTokensIntoLines(tokens: readonly HighlightToken[]): HighlightToken[][] {
  const lines: HighlightToken[][] = [[]]
  for (const token of tokens) {
    const parts = token.text.split('\n')
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) lines.push([])
      const part = parts[index]!
      if (part.length > 0) {
        lines[lines.length - 1]!.push({ text: part, kind: token.kind })
      }
    }
  }
  return lines
}

function isIdentStart(ch: number): boolean {
  return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95 || ch === 36 || ch > 127
}

function isIdentPart(ch: number): boolean {
  return isIdentStart(ch) || (ch >= 48 && ch <= 57)
}

function isDigit(ch: number): boolean {
  return ch >= 48 && ch <= 57
}

function skipWhitespaceLookahead(src: string, from: number): number {
  let pos = from
  while (pos < src.length) {
    const ch = src.charCodeAt(pos)
    if (ch === 32 || ch === 9) pos += 1
    else break
  }
  return pos
}

function scanNumber(src: string, start: number): number {
  let i = start
  if (src[i] === '0' && i + 1 < src.length && /[xXbBoO]/.test(src[i + 1]!)) {
    i += 2
    while (i < src.length && /[0-9a-fA-F_]/.test(src[i]!)) i += 1
    if (src[i] === 'n') i += 1
    return i
  }
  while (i < src.length && (isDigit(src.charCodeAt(i)) || src[i] === '_')) i += 1
  if (src[i] === '.' && i + 1 < src.length && isDigit(src.charCodeAt(i + 1))) {
    i += 1
    while (i < src.length && (isDigit(src.charCodeAt(i)) || src[i] === '_')) i += 1
  }
  if (i < src.length && (src[i] === 'e' || src[i] === 'E')) {
    let next = i + 1
    if (src[next] === '+' || src[next] === '-') next += 1
    if (next < src.length && isDigit(src.charCodeAt(next))) {
      i = next + 1
      while (i < src.length && (isDigit(src.charCodeAt(i)) || src[i] === '_')) i += 1
    }
  }
  if (src[i] === 'n') i += 1
  return i
}

/**
 * 尝试从 `start`（`src[start] === '/'`）扫描单行正则表达式字面量；不合法时返回 -1。
 */
function tryScanRegexLiteral(src: string, start: number): number {
  let i = start + 1
  let inCharClass = false
  if (i >= src.length || src[i] === '\n') return -1
  while (i < src.length) {
    const ch = src[i]!
    if (ch === '\n') return -1
    if (ch === '\\') {
      if (i + 1 >= src.length || src[i + 1] === '\n') return -1
      i += 2
      continue
    }
    if (ch === '[') {
      inCharClass = true
      i += 1
      continue
    }
    if (ch === ']') {
      inCharClass = false
      i += 1
      continue
    }
    if (ch === '/' && !inCharClass) {
      i += 1
      while (i < src.length && /[dgimsuvy]/.test(src[i]!)) i += 1
      return i
    }
    i += 1
  }
  return -1
}

function scanTypeScript(src: string): HighlightToken[] {
  const tokens: HighlightToken[] = []
  /** 模板字符串 `${ ... }` 嵌套栈：记录每一层尚未闭合的左花括号深度。 */
  const templateBraceStack: number[] = []
  let canStartRegex = true
  let i = 0

  const scanTemplateBody = (from: number): number => {
    let pos = from
    let segStart = pos
    while (pos < src.length) {
      const ch = src[pos]!
      if (ch === '\\') {
        pos = Math.min(src.length, pos + 2)
        continue
      }
      if (ch === '`') {
        pushToken(tokens, src.slice(segStart, pos + 1), 'string')
        canStartRegex = false
        return pos + 1
      }
      if (ch === '$' && src[pos + 1] === '{') {
        if (pos > segStart) pushToken(tokens, src.slice(segStart, pos), 'string')
        pushToken(tokens, '${', 'punctuation')
        templateBraceStack.push(0)
        canStartRegex = true
        return pos + 2
      }
      pos += 1
    }
    pushToken(tokens, src.slice(segStart), 'string')
    canStartRegex = false
    return pos
  }

  while (i < src.length) {
    const ch = src[i]!
    const code = src.charCodeAt(i)

    // 空白与换行
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      let end = i + 1
      while (end < src.length && (src[end] === ' ' || src[end] === '\t' || src[end] === '\n')) end += 1
      pushToken(tokens, src.slice(i, end), 'plain')
      i = end
      continue
    }

    // 单行注释
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i + 2)
      const end = nl === -1 ? src.length : nl
      pushToken(tokens, src.slice(i, end), 'comment')
      i = end
      continue
    }

    // 多行注释
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      const end = close === -1 ? src.length : close + 2
      pushToken(tokens, src.slice(i, end), 'comment')
      i = end
      continue
    }

    // 正则表达式字面量
    if (ch === '/' && canStartRegex) {
      const regexEnd = tryScanRegexLiteral(src, i)
      if (regexEnd > i) {
        pushToken(tokens, src.slice(i, regexEnd), 'string-expression')
        canStartRegex = false
        i = regexEnd
        continue
      }
    }

    // 单双引号字符串
    if (ch === '"' || ch === "'") {
      let end = i + 1
      while (end < src.length) {
        const c = src[end]!
        if (c === '\\') {
          end = Math.min(src.length, end + 2)
          continue
        }
        end += 1
        if (c === ch || c === '\n') break
      }
      pushToken(tokens, src.slice(i, end), 'string')
      canStartRegex = false
      i = end
      continue
    }

    // 模板字符串起始
    if (ch === '`') {
      pushToken(tokens, '`', 'string')
      i = scanTemplateBody(i + 1)
      continue
    }

    // 模板插值 `${ ... }` 的花括号配对恢复
    if (ch === '{' && templateBraceStack.length > 0) {
      templateBraceStack[templateBraceStack.length - 1]! += 1
      pushToken(tokens, '{', 'punctuation')
      canStartRegex = true
      i += 1
      continue
    }
    if (ch === '}' && templateBraceStack.length > 0) {
      const top = templateBraceStack[templateBraceStack.length - 1]!
      if (top === 0) {
        templateBraceStack.pop()
        pushToken(tokens, '}', 'punctuation')
        i = scanTemplateBody(i + 1)
        continue
      }
      templateBraceStack[templateBraceStack.length - 1] = top - 1
      pushToken(tokens, '}', 'punctuation')
      canStartRegex = false
      i += 1
      continue
    }

    // 数字
    if (isDigit(code) || (ch === '.' && i + 1 < src.length && isDigit(src.charCodeAt(i + 1)))) {
      const end = scanNumber(src, i)
      pushToken(tokens, src.slice(i, end), 'constant')
      canStartRegex = false
      i = end
      continue
    }

    // 标识符 / 关键字 / 常量 / 函数调用
    if (isIdentStart(code)) {
      let end = i + 1
      while (end < src.length && isIdentPart(src.charCodeAt(end))) end += 1
      const word = src.slice(i, end)
      let prevNonSpace = i - 1
      while (prevNonSpace >= 0 && (src[prevNonSpace] === ' ' || src[prevNonSpace] === '\t')) prevNonSpace -= 1
      const afterDot = prevNonSpace >= 0 && (src[prevNonSpace] === '.' || src[prevNonSpace] === '?')
      const nextPos = skipWhitespaceLookahead(src, end)
      const beforeCall = src[nextPos] === '('

      if (!afterDot && TS_KEYWORDS.has(word)) {
        pushToken(tokens, word, 'keyword')
        canStartRegex = REGEX_PRECEDING_KEYWORDS.has(word)
      } else if (!afterDot && TS_CONSTANTS.has(word)) {
        pushToken(tokens, word, 'constant')
        canStartRegex = false
      } else if (beforeCall) {
        pushToken(tokens, word, 'function')
        canStartRegex = false
      } else if (/^[A-Z][A-Z0-9_]{2,}$/.test(word)) {
        pushToken(tokens, word, 'constant')
        canStartRegex = false
      } else {
        pushToken(tokens, word, 'plain')
        canStartRegex = false
      }
      i = end
      continue
    }

    // 装饰器 @name
    if (ch === '@' && i + 1 < src.length && isIdentStart(src.charCodeAt(i + 1))) {
      let end = i + 2
      while (end < src.length && isIdentPart(src.charCodeAt(end))) end += 1
      pushToken(tokens, src.slice(i, end), 'function')
      canStartRegex = false
      i = end
      continue
    }

    // 其余标点与运算符
    pushToken(tokens, ch, 'punctuation')
    canStartRegex = REGEX_PRECEDING_PUNCT.has(ch)
    i += 1
  }

  return tokens
}

function scanPython(src: string): HighlightToken[] {
  const tokens: HighlightToken[] = []
  let i = 0

  while (i < src.length) {
    const ch = src[i]!
    const code = src.charCodeAt(i)

    if (ch === ' ' || ch === '\t' || ch === '\n') {
      let end = i + 1
      while (end < src.length && (src[end] === ' ' || src[end] === '\t' || src[end] === '\n')) end += 1
      pushToken(tokens, src.slice(i, end), 'plain')
      i = end
      continue
    }

    if (ch === '#') {
      const nl = src.indexOf('\n', i + 1)
      const end = nl === -1 ? src.length : nl
      pushToken(tokens, src.slice(i, end), 'comment')
      i = end
      continue
    }

    // 字符串前缀 r/f/b/u + 单双引号 / 三引号
    let strStart = i
    if (/[rRfFbBuU]/.test(ch)) {
      let p = i + 1
      if (p < src.length && /[rRfFbBuU]/.test(src[p]!)) p += 1
      if (src[p] === '"' || src[p] === "'") strStart = p
    }
    if (src[strStart] === '"' || src[strStart] === "'") {
      const quote = src[strStart]!
      const triple = src[strStart + 1] === quote && src[strStart + 2] === quote
      const delim = triple ? quote.repeat(3) : quote
      let end = strStart + delim.length
      while (end < src.length) {
        if (src[end] === '\\') {
          end = Math.min(src.length, end + 2)
          continue
        }
        if (triple && src.startsWith(delim, end)) {
          end += 3
          break
        }
        if (!triple && (src[end] === quote || src[end] === '\n')) {
          if (src[end] === quote) end += 1
          break
        }
        end += 1
      }
      pushToken(tokens, src.slice(i, end), 'string')
      i = end
      continue
    }

    if (isDigit(code) || (ch === '.' && i + 1 < src.length && isDigit(src.charCodeAt(i + 1)))) {
      const end = scanNumber(src, i)
      pushToken(tokens, src.slice(i, end), 'constant')
      i = end
      continue
    }

    if (isIdentStart(code)) {
      let end = i + 1
      while (end < src.length && isIdentPart(src.charCodeAt(end))) end += 1
      const word = src.slice(i, end)
      let prevNonSpace = i - 1
      while (prevNonSpace >= 0 && (src[prevNonSpace] === ' ' || src[prevNonSpace] === '\t')) prevNonSpace -= 1
      const afterDot = prevNonSpace >= 0 && src[prevNonSpace] === '.'
      const nextPos = skipWhitespaceLookahead(src, end)
      const beforeCall = src[nextPos] === '('

      if (!afterDot && PY_KEYWORDS.has(word)) {
        pushToken(tokens, word, 'keyword')
      } else if (!afterDot && PY_CONSTANTS.has(word)) {
        pushToken(tokens, word, 'constant')
      } else if (beforeCall) {
        pushToken(tokens, word, 'function')
      } else {
        pushToken(tokens, word, 'plain')
      }
      i = end
      continue
    }

    if (ch === '@' && i + 1 < src.length && isIdentStart(src.charCodeAt(i + 1))) {
      let end = i + 2
      while (end < src.length && isIdentPart(src.charCodeAt(end))) end += 1
      pushToken(tokens, src.slice(i, end), 'function')
      i = end
      continue
    }

    pushToken(tokens, ch, 'punctuation')
    i += 1
  }

  return tokens
}
