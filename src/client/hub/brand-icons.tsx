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
  | 'step-code' | 'cline-pass' | 'qoder' | 'opendesign'

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

/**
 * OpenDesign 这张卡自带的标记：官方 logo-mark（圆角方框 + 圆 + 指针），逐字转录。
 *
 * 来源 https://open-design.ai/cloud/assets/logo-mark-nav-Cmeb7g0L.svg ——
 * 2026-10-21 抓取，HTTP 200，image/svg+xml，1,022 字节，sha256 439141e0…0c67。
 * 这是 Cloud 控制台导航与文档站挂的官方标记（站点 favicon 的 PNG 同源同形）。
 * 原图 viewBox="9 9 82 82"、两条 fill="#202020" 的 path；这里 fill 改为
 * currentColor，与上面 GLM / Step Code 两张标记同一形状：viewBox + 单色
 * currentColor 内联体 + 同一个 size 盒子。底砖色由 PROVIDER_BRANDS 那格提供。
 */
const OPENDESIGN_MARK: BrandMarkSvg = {
  viewBox: '9 9 82 82',
  body: '<path fill-rule="evenodd" clip-rule="evenodd" d="M49.8906 29.7598C61.0699 29.7598 70.1328 38.8226 70.1328 50.002C70.1327 61.1812 61.0699 70.2441 49.8906 70.2441C38.7113 70.2441 29.6485 61.1813 29.6484 50.002C29.6484 38.8226 38.7113 29.7598 49.8906 29.7598ZM41.6445 40.5283C40.9921 40.2762 40.3503 40.9204 40.5996 41.5771L48.3145 61.8779C48.6345 62.7203 49.877 62.4897 49.877 61.5879V49.957H61.665C62.5605 49.957 62.7908 48.7102 61.9551 48.3867L41.6445 40.5283Z" fill="currentColor"/>'
    + '<path fill-rule="evenodd" clip-rule="evenodd" d="M50 9C85.5753 9 91 14.4247 91 50C91 85.5753 85.5753 91 50 91C14.4247 91 9 85.5753 9 50C9 14.4247 14.4247 9 50 9ZM49.8906 24.6992C35.9164 24.6992 24.5879 36.0277 24.5879 50.002C24.5879 55.0491 24.5879 66.2953 24.5879 71.9385C24.588 73.8015 26.091 75.3046 27.9541 75.3047H49.8906C63.8647 75.3046 75.1932 63.976 75.1934 50.002C75.1934 36.0278 63.8647 24.6993 49.8906 24.6992Z" fill="currentColor"/>',
}

/** 一张标记的键：BRAND_MARKS 的全部键，加上本文件自带的键。 */
export type ProviderMarkKey = BrandMarkKey | 'glm' | 'step-code' | 'cline-pass' | 'opendesign'

/** 本文件自带的标记（BRAND_MARKS 之外的补充，按键索引）。 */
const LOCAL_MARKS: Record<string, BrandMarkSvg> = { glm: GLM_MARK, 'step-code': STEP_CODE_MARK, 'cline-pass': CLINE_MARK, opendesign: OPENDESIGN_MARK }

function artworkOf(mark: ProviderMarkKey): BrandMarkSvg {
  return mark in BRAND_MARKS ? BRAND_MARKS[mark as BrandMarkKey] : LOCAL_MARKS[mark]
}

/**
 * A brand image carried as a data URI rather than as inline SVG geometry.
 *
 * Used where the official artwork is a raster asset whose vector form is a
 * 36 KB path — inlining the geometry would cost five times the pixels and buy
 * nothing at a 23 px box. The bytes are the vendor's own file, so the mark is
 * still the official one rather than a redraw of it.
 */
interface BrandImage {
  /** Data URI of the official asset. */
  src: string
  /** How the image fills the tile; 'cover' hides the artwork's own rounded base. */
  fit: 'cover' | 'contain'
}

interface ProviderBrand {
  /** Key into BRAND_MARKS (or LOCAL_MARKS); absent for monogram-only providers. */
  mark?: ProviderMarkKey
  /** Official raster artwork; takes precedence over `mark` when both are set. */
  image?: BrandImage
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
  // Qoder：官方应用图标，逐字节取自 qoder.com 首页 `<link rel="icon" type="image/png">`
  // 指向的那张 412×412 PNG（https://img.alicdn.com/imgextra/i4/O1CN01QkSxiCocd3D0prc8_!!6000000008124-2-tps-412-412.png，
  // 2026-10-21 抓取，HTTP 200，4,990 字节，sha256 2276f0f8…26f3d）。
  //
  // 这里换掉了原来那个 monogram 'Q'。换的理由不是「字母不好看」，而是**上一版
  // 的注释是错的**：它说官方 favicon 是一枚 73 KB 的复合字形、不适合内联。那份
  // 73 KB 确实是 https://qoder.com/favIcon.svg 今天的应答——但那个 URL 现在返回的
  // 是整站 HTML，不是图标；页面真正挂的图标是这个 alicdn 地址（SVG 版同源，
  // 内含一条 36 KB 的 path，内联进去要 73 KB，不如用这张 5 KB 的 PNG）。
  //
  // image.fit='cover'：PNG 自带 #F3F3F3 圆角底，铺满 40px 底砖正好与官方图标
  // 同一个比例，四角由 tile 的 border-radius 裁圆。底砖色仍是同一个 #F3F3F3。
  qoder: { image: { src: 'data:image/png;base64,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', fit: 'cover' }, tile: '#F3F3F3' },
  // OpenDesign：追加在 PROVIDER_BRANDS 末尾，既有条目一个都不动。官方 logo-mark
  // 见上面 OPENDESIGN_MARK 常量（来源、抓取日期、sha256 都在那里）。标记官方填充
  // 色 #202020；底砖用 open-design.ai 自己样式表里的高亮底色 #EFF8E9（model-credits
  // 页的强调块背景），两者都是官方取值，不是本地选的颜色。
  opendesign: { mark: 'opendesign', color: '#202020', tile: '#EFF8E9' },
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
    {brand.image !== undefined
      // An official raster asset fills the tile at its own scale: the artwork
      // already carries the rounded base the SVG marks get from `.tile`, so
      // shrinking it to the 0.58 mark box would read as a shrunken app icon.
      ? <img
          className="dsh-hub-brand-image"
          src={brand.image.src}
          alt=""
          width={size}
          height={size}
          style={{ objectFit: brand.image.fit }}
        />
      : brand.mark !== undefined
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
