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
import { BRAND_MARKS, type BrandMarkKey } from './brand-svg.ts'

export type HubProviderId =
  | 'chatgpt' | 'antigravity' | 'command-code' | 'kimi-code'
  | 'workbuddy' | 'minimax-code' | 'claude' | 'ollama'

interface ProviderBrand {
  /** Key into BRAND_MARKS; absent for monogram-only providers. */
  mark?: BrandMarkKey
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
  claude: { mark: 'claude', color: '#D97757', tile: '#D97757' },
  ollama: { monogram: 'O', color: '#3B3B3B', tile: '#3B3B3B' },
}

/** One brand mark at a given box size; the artwork is decorative. */
export function BrandMark({ mark, color, size = 22 }: { mark: BrandMarkKey; color?: string; size?: number }): React.JSX.Element {
  const art = BRAND_MARKS[mark]
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
const MODEL_BRAND_RULES: ReadonlyArray<{ re: RegExp; mark: BrandMarkKey }> = [
  { re: /gpt|codex|o[0-9]/, mark: 'openai' },
  { re: /claude|anthropic/, mark: 'claude' },
  { re: /kimi|moonshot|\bk[0-9]/, mark: 'kimi' },
  { re: /minimax|\bm[0-9]/, mark: 'minimax' },
  { re: /gemini/, mark: 'gemini' },
  { re: /qwen/, mark: 'qwen' },
  { re: /deepseek/, mark: 'deepseek' },
  { re: /grok/, mark: 'grok' },
]

export function modelBrandMark(modelId: string): BrandMarkKey | null {
  const id = modelId.toLowerCase()
  for (const rule of MODEL_BRAND_RULES) {
    if (rule.re.test(id)) return rule.mark
  }
  return null
}
