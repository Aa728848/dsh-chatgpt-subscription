/** Learn the reasoning field a concrete OpenAI-compatible endpoint speaks. */

export const KNOWN_REASONING_KEYS = ['reasoning_content', 'reasoning_details', 'reasoning'] as const

export class ReasoningKeyDialect {
  private detected: string | undefined

  constructor(
    private readonly defaultKey: string = KNOWN_REASONING_KEYS[0],
    private readonly keys: readonly string[] = KNOWN_REASONING_KEYS,
  ) {}

  /** Record an observed field and return its text. Empty strings still teach the key. */
  observe(source: unknown): string | undefined {
    if (typeof source !== 'object' || source === null) return undefined
    const record = source as Record<string, unknown>
    for (const key of this.keys) {
      const value = record[key]
      if (typeof value === 'string') {
        this.learn(key)
        return value
      }
    }
    return undefined
  }

  /** Record a previously parsed fragment without re-reading the wire object. */
  observeKey(key: string): void {
    if (this.keys.includes(key)) this.learn(key)
  }

  protected learn(key: string): void {
    this.detected = key
  }

  outboundKey(): string {
    return this.detected ?? this.defaultKey
  }

  reset(): void {
    this.detected = undefined
  }
}

/** Provider+endpoint isolation; one gateway's dialect never contaminates another. */
export class ReasoningDialectRegistry {
  private readonly dialects = new Map<string, ReasoningKeyDialect>()

  constructor(private readonly maxEntries = 64) {}

  for(provider: string, endpoint: string, defaultKey?: string): ReasoningKeyDialect {
    const key = provider + ':' + endpoint
    let dialect = this.dialects.get(key)
    if (dialect === undefined) {
      dialect = new ReasoningKeyDialect(defaultKey)
      this.dialects.set(key, dialect)
    }
    this.dialects.delete(key)
    this.dialects.set(key, dialect)
    if (this.dialects.size > this.maxEntries) {
      const oldest = this.dialects.keys().next()
      if (oldest.done !== true) this.dialects.delete(oldest.value)
    }
    return dialect
  }

  reset(): void { this.dialects.clear() }
}
