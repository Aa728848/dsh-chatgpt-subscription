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

/**
 * GLM（ZCode 账号）这张卡自带的标记。
 *
 * 与 BRAND_MARKS 里的同族一样是一个 viewBox + 单色 currentColor 的内联体、同一个
 * size 盒子；差别在来源：那一张张是从 vendored lockup 提取的（brand-svg.ts 注明
 * 「do not hand-edit」），而 Z.ai/GLM 没有可提取的 lockup 可用，且 brand-svg.ts
 * 不在本工作包的改动白名单内，所以这张以同样的形状就地声明在这里。
 *
 * 画的是三个字母本身而不是仿造官方商标的路径：一个认得出品牌的字标，
 * 配一块品牌色底砖，与 command-code / ollama 的单字母底砖同属一个层次。
 */
const GLM_MARK: BrandMarkSvg = {
  viewBox: '0 0 24 24',
  body: '<text x="12" y="16.4" text-anchor="middle" font-family="ui-sans-serif,system-ui,-apple-system,\'Segoe UI\',sans-serif" font-size="10.6" font-weight="700" letter-spacing="0.2" fill="currentColor">GLM</text>',
}

/** 一张标记的键：BRAND_MARKS 的全部键，加上本文件自带的键。 */
export type ProviderMarkKey = BrandMarkKey | 'glm'

/** 本文件自带的标记（BRAND_MARKS 之外的补充，按键索引）。 */
const LOCAL_MARKS: Record<string, BrandMarkSvg> = { glm: GLM_MARK }

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
  'glm-coding-plan': { mark: 'glm', tile: '#3859FF' },
  claude: { mark: 'claude', color: '#D97757', tile: '#D97757' },
  ollama: { monogram: 'O', color: '#3B3B3B', tile: '#3B3B3B' },
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
