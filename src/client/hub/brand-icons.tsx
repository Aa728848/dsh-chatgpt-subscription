/**
 * Provider and vendor brand marks for the hub overview cards and the shared
 * model checklist.
 *
 * The artwork lives in brand-svg.ts as inline strings (extracted from the
 * vendored combine lockups); this module adds the presentation: a rounded,
 * brand-tinted tile for provider cards, a bare mark for model rows, and the
 * ordered model-id → vendor rules. A model no rule claims draws no mark at
 * all — a wrong vendor's mark reads as a wrong answer, not a missing one
 * (the same principle claude-style's brand.js documents).
 */
import { BRAND_MARKS, type BrandMarkKey, type BrandMarkSvg } from './brand-svg.ts'

export type HubProviderId =
  | 'chatgpt' | 'antigravity' | 'command-code' | 'kimi-code'
  | 'workbuddy' | 'minimax-code' | 'glm-coding-plan' | 'claude' | 'ollama'
  | 'step-code' | 'cline-pass' | 'qoder'

/**
 * GLM（ZCode 账号）这张卡自带的标记：智谱官方 logo.svg 里那个方形标记，逐字转录。
 *
 * 来源 https://www.zhipuai.cn/logo.svg —— 2026-10-12 抓取，HTTP 200，2632 字节，
 * sha256 3f8e33a4…b0121。那张图 viewBox="0 0 95 27"、12 条 path：前 9 条是
 * 「智谱」两个汉字，后 3 条是这个方形标记。这里**只取后 3 条**，fill 由原图的
 * black 改为 currentColor，于是它与 BRAND_MARKS 里的同族是同一个形状：viewBox +
 * 单色 currentColor 的内联体、同一个 size 盒子。汉字部分在方块尺寸下读不出来
 * （那是字标，不是标记），所以不取。
 *
 * viewBox 是按三条 path 的极值推出来的，不是抄来的近似值（对每条 path 的三次
 * 贝塞尔取导数零点，得出真实极值）：
 *   path 1  x[0.787598, 16.5376]   y[0.015152, 3.911629]
 *   path 2  x[0, 31.5]             y[0.032166, 26.5273]
 *   path 3  x[14.9624, 30.7124]    y[22.6308, 26.5272]
 *   三条并集 x[0, 31.5]，y[0.015152, 26.5273]
 * 最左是 path 2 的 H0，最右是 path 2 的 M31.5/H31.5，所以宽 31.5；最低是 path 1
 * 的 V0.015152，最高是 path 2 的 L12.6 26.5273。那 0.015152 在 22px 的盒子里不到
 * 0.02px，按原点归零并取高度 = 最高点，得到 viewBox="0 0 31.5 26.5273"。
 *
 * brand-svg.ts 不在本工作包的改动白名单内（文件头写着「do not hand-edit the
 * artwork」），所以这张以同样的形状就地声明在这里。
 */
const GLM_MARK: BrandMarkSvg = {
  viewBox: '0 0 31.5 26.5273',
  body: '<path d="M16.5376 0.0307374L14.3326 3.13223C14.1617 3.37577 13.9331 3.57415 13.6667 3.71001C13.4004 3.84586 13.1045 3.91504 12.8048 3.9115H0.787598V0.015152H16.5376V0.0307374Z" fill="currentColor"/>'
    + '<path d="M31.5 0.0321655L12.6 26.5273H0L18.9 0.0321655H31.5Z" fill="currentColor"/>'
    + '<path d="M14.9624 26.5272L17.1832 23.4101C17.3564 23.1689 17.5856 22.9723 17.8513 22.8368C18.1171 22.7012 18.4119 22.6306 18.7109 22.6308H30.7124V26.5272H14.9624Z" fill="currentColor"/>',
}

/**
 * Step Code（Step Plan 订阅）这张卡自带的标记：StepFun 官方 favicon 的字形，逐字转录。
 *
 * 来源 https://platform.stepfun.com/favicon.svg —— 2026-10-12 抓取，HTTP 200，
 * 380 字节，sha256 cdcb79a0…3ea9。官方那张是 viewBox="0 0 64 64"：一个
 * <rect width="64" height="64" rx="12" fill="#1d1d1d"> 的圆角底 + 一条
 * <path fill="#fff">。这里**只取那条 path 的 d**，fill 改为 currentColor，深色
 * rect 底丢弃——底砖由 PROVIDER_BRANDS[].tile 提供（那一格现在用官方那个
 * #1d1d1d），这是本文件既有的分层：标记只管形状，底砖管颜色。
 *
 * viewBox 沿用官方的 0 0 64 64，不裁到字形的紧包围盒：实测这条 path 的字形是
 * x[12.19, 51.87]、y[12.19, 51.87] 的一个 39.68×39.68 方块，在官方 64×64 的框里
 * 四边各留约 12.2 的内缩。保留官方的框就保留了这个内缩带来的视觉重量，而
 * BrandTile 在下面画的那块圆角底砖正好补上被丢掉的 rect，合起来与官方 favicon
 * 是同一个比例。
 *
 * 与上面 GLM 那张**同一条理由**：brand-svg.ts 不在本工作包的改动白名单内，所以
 * 这张同样以「viewBox + 单色 currentColor 的内联体 + 同一个 size 盒子」的形状
 * 就地声明在这里，而不是画四个字母。
 */
const STEP_CODE_MARK: BrandMarkSvg = {
  viewBox: '0 0 64 64',
  body: '<path d="M33.76 43.03v-8.84h18.05v1.58H41.56v16.1h-7.8zm-21.57-4.39h9.3l-.02-10.4-.01-10.38h25.15l.02 7.62H29.37v20.8H12.2Zm4.28-23.24h1.58v17.67h-1.58zm32.28-.07h-3.23v-1.57h3.23v-1.57h1.54v1.57h1.58l-.01.79v.79h-1.57v3.19h-1.54v-3.2" fill="currentColor"/>',
}

/**
 * Cline Pass's card mark: the official Cline glyph, transcribed from
 * `assets/branding/logos/cline-icon-white.svg` in the Cline open-source
 * repository (commit ca7402c5abced42da9c7c50500b7a9bae82cb6fa, 2026-10-20).
 *
 * The official app icon is this same glyph, white, on a #343B42 rounded square;
 * `BrandTile` draws that square from `PROVIDER_BRANDS['cline-pass'].tile`, so this
 * constant carries only the glyph (the white variant's single fill is replaced by
 * currentColor, exactly like the GLM and Step Code marks above).
 *
 * Do not hand-draw a replacement: the mark is Cline's own and this copy names
 * where it came from, which is the only way a later reviewer can verify it.
 */
const CLINE_MARK: BrandMarkSvg = {
  viewBox: '0 0 113 113',
  body: '<path d="M56.4998 8.99805L56.4999 5.29805H56.4998V8.99805ZM68.4998 20.708L72.1998 20.7081V20.708H68.4998ZM67.9929 25L64.3662 24.2671L63.4704 28.7H67.9929V25ZM84.4998 25L84.4998 21.3H84.4998V25ZM95.7 49.7998H92V51.2066L92.9346 52.258L95.7 49.7998ZM108.027 63.667L110.793 61.2088L110.792 61.2088L108.027 63.667ZM108.027 64.7305L110.792 67.1887L110.793 67.1883L108.027 64.7305ZM95.7 78.5977L92.9346 76.1394L92 77.1909V78.5977H95.7ZM95.7 92.2002L99.3999 92.2002V92.2002H95.7ZM84.4998 103.4V107.1H84.4998L84.4998 103.4ZM17.2996 92.2002H13.5996V92.2002L17.2996 92.2002ZM17.2996 78.5986H20.9996V77.1918L20.0649 76.1404L17.2996 78.5986ZM4.97144 64.7305L2.20602 67.1886L2.20611 67.1887L4.97144 64.7305ZM4.97144 63.667L7.73685 66.1251L7.73685 66.1251L4.97144 63.667ZM17.2996 49.7979L20.065 52.256L20.9996 51.2046V49.7979H17.2996ZM45.0066 25V28.7H49.5292L48.6333 24.267L45.0066 25ZM44.4998 20.708H40.7998V20.7081L44.4998 20.708ZM56.4998 8.99805L56.4996 12.698C61.1812 12.6982 64.7998 16.3247 64.7998 20.708H68.4998H72.1998C72.1998 12.0452 65.0728 5.29829 56.4999 5.29805L56.4998 8.99805ZM68.4998 20.708L64.7998 20.7079C64.7997 21.6154 64.6614 22.8066 64.3662 24.2671L67.9929 25L71.6196 25.7329C71.969 24.004 72.1997 22.2864 72.1998 20.7081L68.4998 20.708ZM67.9929 25V28.7H84.4998V25V21.3H67.9929V25ZM84.4998 25L84.4997 28.7C88.6419 28.7001 92 32.0582 92 36.2002H95.7H99.3999C99.3999 27.9712 92.7287 21.3001 84.4998 21.3L84.4998 25ZM95.7 36.2002H92V49.7998H95.7H99.3999V36.2002H95.7ZM95.7 49.7998L92.9346 52.258L105.262 66.1252L108.027 63.667L110.792 61.2088L98.4653 47.3416L95.7 49.7998ZM108.027 63.667L105.262 66.1251C104.285 65.026 104.285 63.371 105.261 62.2727L108.027 64.7305L110.793 67.1883C112.308 65.4837 112.308 62.9141 110.793 61.2088L108.027 63.667ZM108.027 64.7305L105.262 62.2722L92.9346 76.1394L95.7 78.5977L98.4653 81.0559L110.792 67.1887L108.027 64.7305ZM95.7 78.5977H92V92.2002H95.7H99.3999V78.5977H95.7ZM95.7 92.2002L92 92.2002C91.9999 96.3422 88.6418 99.7003 84.4997 99.7004L84.4998 103.4L84.4998 107.1C92.7287 107.1 99.3999 100.429 99.3999 92.2002L95.7 92.2002ZM84.4998 103.4V99.7004H28.4998V103.4V107.1H84.4998V103.4ZM28.4998 103.4V99.7004C24.3577 99.7004 20.9996 96.3423 20.9996 92.2002L17.2996 92.2002L13.5996 92.2002C13.5996 100.429 20.2707 107.1 28.4998 107.1V103.4ZM17.2996 92.2002H20.9996V78.5986H17.2996H13.5996V92.2002H17.2996ZM17.2996 78.5986L20.0649 76.1404L7.73676 62.2722L4.97144 64.7305L2.20611 67.1887L14.5342 81.0569L17.2996 78.5986ZM4.97144 64.7305L7.73685 62.2723C8.71353 63.3711 8.71353 65.0264 7.73685 66.1251L4.97144 63.667L2.20602 61.2088C0.690476 62.9138 0.690476 65.4836 2.20602 67.1886L4.97144 64.7305ZM4.97144 63.667L7.73685 66.1251L20.065 52.256L17.2996 49.7979L14.5341 47.3397L2.20602 61.2088L4.97144 63.667ZM17.2996 49.7979H20.9996V36.2002H17.2996H13.5996V49.7979H17.2996ZM17.2996 36.2002H20.9996C20.9996 32.0581 24.3576 28.7 28.4998 28.7V25V21.3C20.2707 21.3 13.5996 27.9712 13.5996 36.2002H17.2996ZM28.4998 25V28.7H45.0066V25V21.3H28.4998V25ZM45.0066 25L48.6333 24.267C48.3381 22.8066 48.1998 21.6154 48.1998 20.7079L44.4998 20.708L40.7998 20.7081C40.7998 22.2864 41.0305 24.0039 41.3799 25.733L45.0066 25ZM44.4998 20.708H48.1998C48.1998 16.3244 51.8182 12.698 56.4998 12.698V8.99805V5.29805C47.9264 5.29805 40.7998 12.0451 40.7998 20.708H44.4998Z" fill="currentColor"/>'
    + '<rect x="66.1001" y="49.8008" width="9.6" height="28.8" rx="4.8" fill="currentColor"/>'
    + '<rect x="37.3" y="49.8008" width="9.6" height="28.8" rx="4.8" fill="currentColor"/>',
}

/** 一张标记的键：BRAND_MARKS 的全部键，加上本文件自带的键。 */
export type ProviderMarkKey = BrandMarkKey | 'glm' | 'step-code' | 'cline-pass'

/** 本文件自带的标记（BRAND_MARKS 之外的补充，按键索引）。 */
const LOCAL_MARKS: Record<string, BrandMarkSvg> = { glm: GLM_MARK, 'step-code': STEP_CODE_MARK, 'cline-pass': CLINE_MARK }

function artworkOf(mark: ProviderMarkKey): BrandMarkSvg {
  return mark in BRAND_MARKS ? BRAND_MARKS[mark as BrandMarkKey] : LOCAL_MARKS[mark]
}

interface ProviderBrand {
  /** Key into BRAND_MARKS (or LOCAL_MARKS); absent for monogram-only providers. */
  mark?: ProviderMarkKey
  /**
   * Text color for artwork that draws in currentColor (OpenAI's knot, Kimi's
   * K, Claude's mark). Self-colored artwork (gradients, multi-fill marks)
   * leaves this undefined.
   */
  color?: string
  /** Brand color the tile's tinted background is mixed from. */
  tile: string
  /** Monogram for providers without vendored artwork. */
  monogram?: string
}

export const PROVIDER_BRANDS: Record<HubProviderId, ProviderBrand> = {
  chatgpt: { mark: 'openai', color: '#10A37F', tile: '#10A37F' },
  antigravity: { mark: 'gemini', tile: '#3186FF' },
  'command-code': { monogram: '>_', color: '#7C6AEF', tile: '#7C6AEF' },
  'kimi-code': { mark: 'kimi', color: '#1F1F1F', tile: '#1783FF' },
  workbuddy: { mark: 'tencent', tile: '#0055E9' },
  'minimax-code': { mark: 'minimax', tile: '#E2167E' },
  // 底砖色仍是既有那块品牌色；标记换成官方那三条 path 之后它是 currentColor，
  // 所以补一个白字压砖，否则深蓝底上那枚标记读不出来。
  'glm-coding-plan': { mark: 'glm', color: '#ffffff', tile: '#3859FF' },
  claude: { mark: 'claude', color: '#D97757', tile: '#D97757' },
  ollama: { monogram: 'O', color: '#3B3B3B', tile: '#3B3B3B' },
  // 底砖色取自官方 favicon 那个圆角底的 fill（#1d1d1d），不再是本地选定的靛蓝：
  // 它现在有出处了，上面那句「Step 没有可核验的品牌色取值来源」随之作废。标记画成
  // currentColor，所以这里配 #ffffff，白字压深砖才读得出来。
  'step-code': { mark: 'step-code', color: '#ffffff', tile: '#1d1d1d' },
  // 底砖取自 Cline 官方 app icon 的圆角底（#343B42），标记用官方 white 变体，
  // 两者合起来就是 Cline 自己的应用图标；标记画成 currentColor，所以配白字。
  'cline-pass': { mark: 'cline-pass', color: '#ffffff', tile: '#343B42' },
  // Qoder：官方 favicon（https://qoder.com/favIcon.svg，2026-06-26 抓取，HTTP 200，
  // 73,379 字节，sha256 5e1843cb…1dd0）是一枚 73KB 的复合字形，体量不适合内联
  // 转录（GLM/Step 的标记都只取了几条 path）；所以这张卡用 monogram 'Q'，
  // 两个颜色值都有出处：底砖 #F3F3F3 取自该 favicon 的圆角底 rect，
  // 字形色 #141414 取自 qoder.com 站内全部内联图标的 fill。
  qoder: { monogram: 'Q', color: '#141414', tile: '#F3F3F3' },
}

/** One brand mark at a given box size; the artwork is decorative. */
export function BrandMark({ mark, color, size = 22 }: { mark: ProviderMarkKey; color?: string; size?: number }): React.JSX.Element {
  const art = artworkOf(mark)
  return <svg
    aria-hidden="true"
    viewBox={art.viewBox}
    width={size}
    height={size}
    style={color === undefined ? undefined : { color }}
    dangerouslySetInnerHTML={{ __html: art.body }}
  />
}

/**
 * The overview card's logo tile: the mark centered on a rounded square tinted
 * with the brand color, in the QQ-mail idiom. The tile element doubles as the
 * fallback surface for monogram providers.
 */
export function BrandTile({ id, size = 40 }: { id: HubProviderId; size?: number }): React.JSX.Element {
  const brand = PROVIDER_BRANDS[id]
  return <span
    className="dsh-hub-brand-tile"
    aria-hidden="true"
    style={{ width: size, height: size, ['--dsh-hub-brand' as string]: brand.tile }}
  >
    {brand.mark !== undefined
      ? <BrandMark mark={brand.mark} color={brand.color} size={Math.round(size * 0.58)} />
      : <span className="dsh-hub-brand-mono" style={brand.color === undefined ? undefined : { color: brand.color }}>{brand.monogram}</span>}
  </span>
}

/**
 * The vendor that made one model, resolved from its id. Ordered: the first
 * matching rule wins, so a specific rule ('kimi') precedes a looser one.
 */
const MODEL_BRAND_RULES: ReadonlyArray<{ re: RegExp; mark: ProviderMarkKey }> = [
  // GLM 放在最前：它的 id 一律以 GLM- 开头（GLM-5.3 / GLM-5.3-Flash / GLM-5.2 /
  // GLM-5-Turbo），是全表里最不容易误伤的一条，且必须排在 `o[0-9]` 这种宽松规则之前。
  { re: /glm|zhipu|\bz\.ai\b/, mark: 'glm' },
  { re: /gpt|codex|o[0-9]/, mark: 'openai' },
  { re: /claude|anthropic/, mark: 'claude' },
  { re: /kimi|moonshot|\bk[0-9]/, mark: 'kimi' },
  { re: /minimax|\bm[0-9]/, mark: 'minimax' },
  { re: /gemini/, mark: 'gemini' },
  { re: /qwen/, mark: 'qwen' },
  { re: /deepseek/, mark: 'deepseek' },
  { re: /grok/, mark: 'grok' },
]

export function modelBrandMark(modelId: string): ProviderMarkKey | null {
  const id = modelId.toLowerCase()
  for (const rule of MODEL_BRAND_RULES) {
    if (rule.re.test(id)) return rule.mark
  }
  return null
}
