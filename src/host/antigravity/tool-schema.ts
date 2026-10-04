import { LlmError } from '@deepseek-ai/dsh-llm'

// FunctionDeclaration.parameters uses Google's Schema, not arbitrary JSON Schema.
// https://googleapis.github.io/js-genai/release_docs/interfaces/types.Schema.html
const schemaFields = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'default', 'example',
  'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength',
  'minProperties', 'maxProperties', 'pattern', 'required', 'propertyOrdering',
])

/** One outbound tool-schema conversion's per-target options. */
export interface AntigravityToolSchemaOptions {
  /**
   * Collapse `anyOf`/`oneOf`/`allOf` and type unions into one declared form.
   *
   * Gemini ignores `anyOf` and takes the composed form as sent. Antigravity routes
   * a Claude-family request to Vertex Anthropic, whose `input_schema` check rejects
   * a tool schema the request still composes with (#39). That is a gateway limit,
   * not a JSON Schema rule: the caller's schema is valid draft 2020-12.
   */
  foldUnions?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeSchemas(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...left, ...right }
  if (isRecord(left.properties) && isRecord(right.properties)) {
    merged.properties = { ...left.properties, ...right.properties }
  }
  if (Array.isArray(left.required) && Array.isArray(right.required)) {
    merged.required = [...new Set([...left.required, ...right.required])]
  }
  return merged
}

/** Value constraints a branch summary reports, in a stable order. */
const constraintFields = [
  'format', 'pattern', 'minimum', 'maximum', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'minProperties', 'maxProperties',
] as const

/** Keys the same-type union merge below represents rather than drops. */
const mergedTypeKeys: ReadonlySet<string> = new Set([
  'type', 'enum', 'nullable', 'description', ...constraintFields,
])

/**
 * One alternative in the words a model can act on.
 *
 * Folding removes the branch from the schema itself, so this text carries the
 * branch description and its constraints too: the type alone would leave the
 * model with strictly less than the schema it started from.
 */
function describeBranch(branch: Record<string, unknown>): string {
  const type = typeof branch.type === 'string'
    ? branch.type
    : isRecord(branch.properties) ? 'object' : isRecord(branch.items) ? 'array' : 'value'
  const details: string[] = []
  if (isRecord(branch.properties)) {
    const names = Object.keys(branch.properties)
    if (names.length > 0) details.push(`{${names.join(',')}}`)
  }
  if (Array.isArray(branch.required) && branch.required.length > 0) {
    details.push(`requires ${branch.required.map(String).join(',')}`)
  }
  if (Array.isArray(branch.enum)) {
    details.push(`enum[${branch.enum.map((value) => JSON.stringify(value)).join(',')}]`)
  }
  for (const field of constraintFields) {
    if (branch[field] !== undefined) details.push(`${field}=${JSON.stringify(branch[field])}`)
  }
  if (branch.nullable === true) details.push('or null')
  const summary = details.length > 0 ? `${type} ${details.join(' ')}` : type
  const description = typeof branch.description === 'string' ? branch.description.trim() : ''
  return description === '' ? summary : `${summary} — "${description}"`
}

/** How well one branch can stand in for a whole union; a named object shape wins. */
function branchRank(branch: Record<string, unknown>): number {
  if (isRecord(branch.properties)) return 3
  if (branch.type === 'object') return 2
  if (branch.type === 'array') return 1
  return 0
}

/**
 * The one JSON Schema type a literal set declares, when it declares exactly one.
 *
 * Read from the caller's literals, never from the wire's stringified `enum`: a
 * `{ const: 5 }` branch is a number, and `String(5)` alone cannot say so.
 */
function literalType(values: readonly unknown[]): string | undefined {
  const kinds = new Set(values.map((value) => typeof value))
  if (kinds.size !== 1) return undefined
  const [kind] = kinds
  return kind === 'string' || kind === 'number' || kind === 'boolean' ? kind : undefined
}

/**
 * The single form the wire can declare for a set of union branches.
 *
 * `folded` is false only when the declared form carries every constraint the
 * branches between them declared; once a constraint is only in the description,
 * the fold says so instead of passing a partial restatement off as the union.
 */
function unionShape(
  branches: Array<Record<string, unknown>>,
): { shape: Record<string, unknown>; folded: boolean } {
  if (branches.length === 1) return { shape: branches[0], folded: false }
  const types = new Set(branches.map((branch) => branch.type))
  if (types.size === 1 && branches.every((branch) => !isRecord(branch.properties) && !isRecord(branch.items))) {
    // A union of one type is that type with the union of its value sets. A branch
    // without an enum accepts anything, so keeping the merged enum there would
    // forbid values the caller still allows.
    const shape: Record<string, unknown> = { type: branches[0].type }
    if (branches.every((branch) => Array.isArray(branch.enum))) {
      const values = [...new Set(branches.flatMap((branch) => branch.enum as unknown[]))]
      if (values.length > 0) shape.enum = values
    }
    if (branches.some((branch) => branch.nullable === true)) shape.nullable = true
    const folded = branches.some((branch) => Object.entries(branch).some(([key, value]) =>
      !mergedTypeKeys.has(key) && !Object.is(shape[key], value)))
    return { shape, folded }
  }
  const declared = branches.reduce((best, branch) => (branchRank(branch) > branchRank(best) ? branch : best))
  return { shape: declared, folded: true }
}

/** Append the folded union to whatever description the node already carried. */
function withUnionHint(description: unknown, hint: string): string {
  const base = typeof description === 'string' ? description.trim() : ''
  return base === '' ? hint : `${base}\n\n${hint}`
}

function unionHint(alternatives: Array<Record<string, unknown>>, declared?: Record<string, unknown>): string {
  const list = alternatives.map(describeBranch).join(' | ')
  const text = `Union of accepted forms: ${list}.`
  // The gateway validates the declared schema only: an alternative is a real part
  // of the caller's tool contract, but this wire cannot express it, so the text
  // says which form to send instead of implying the others still fit.
  return declared === undefined
    ? text
    : `${text} Send "${describeBranch(declared)}": this gateway validates the declared form only, and the alternatives describe the original tool contract.`
}

/**
 * One node's own fields, children folded, composition keys set aside.
 *
 * `anyOf`, `oneOf` and `allOf` are keywords only in these positions: a parameter
 * NAMED `anyOf` is data, so recursion goes through `properties` by name and never
 * reads a property key as a keyword.
 */
function foldOwnFields(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') continue
    if (key === 'properties' && isRecord(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, foldSchemaUnions(child)]),
      )
      continue
    }
    if (key === 'items') {
      out.items = foldSchemaUnions(value)
      continue
    }
    out[key] = value
  }
  return out
}

/**
 * Replace every composition keyword in one already-converted schema with a
 * single declared form, moving what folding drops into `description`.
 *
 * This runs after {@link toAntigravityToolSchema} resolved references and merged
 * `allOf`, so it is one pass over the wire shape and no second sanitizer can
 * strip the hint it just wrote.
 *
 * Folding NARROWS the wire contract: preferring the object branch leaves the
 * schema declaring an object, so a caller that would have sent the string form
 * now sends against a schema that does not mention it. That is the only way
 * past a gateway that refuses a composed schema outright, and the description
 * keeps the dropped forms visible as the original tool contract rather than
 * silently erasing them. DSH's own tool validator is the real gate: an
 * argument the model sends anyway fails there, naming the actual problem.
 */
function foldSchemaUnions(node: unknown): unknown {
  if (!isRecord(node)) return node

  // allOf is an intersection, which the converter normally resolves before this
  // point; merging here keeps the fold correct if one still reaches it.
  let own = foldOwnFields(node)
  if (Array.isArray(node.allOf)) {
    for (const branch of node.allOf) {
      const folded = foldSchemaUnions(branch)
      if (isRecord(folded)) own = mergeSchemas(own, folded)
    }
  }

  const alternatives = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : []
  if (alternatives.length === 0) return own
  const branches = alternatives.map((branch) => foldSchemaUnions(branch)).filter(isRecord)
  if (branches.length === 0) return own

  // A bare `null` alternative is `nullable`, not a competing shape: it must never
  // win the branch contest and hide every real form.
  const shapes = branches.filter((branch) => branch.type !== 'null')
  const acceptsNull = branches.some((branch) => branch.type === 'null')
  if (shapes.length === 0) {
    const onlyNull = mergeSchemas({ nullable: true }, own)
    onlyNull.description = withUnionHint(own.description, unionHint(branches, { nullable: true }))
    return onlyNull
  }

  const { shape, folded } = unionShape(shapes)
  // Sibling constraints hold for the union as a whole, so they win over the
  // chosen branch exactly as they do over an allOf branch.
  const merged = mergeSchemas(shape, own)
  if (acceptsNull) merged.nullable = true
  if (branches.length > 1) {
    merged.description = withUnionHint(merged.description, unionHint(branches, folded ? shape : undefined))
  }
  return merged
}

export function toAntigravityToolSchema(
  schema: unknown,
  options: AntigravityToolSchemaOptions = {},
): unknown {
  if (!isRecord(schema)) return schema
  const root = schema

  function resolveReference(reference: string): Record<string, unknown> {
    let target: unknown = root
    if (reference !== '#' && !reference.startsWith('#/')) {
      throw new LlmError(`Antigravity tool schema requires a local reference: ${reference}`, 'PROVIDER_ERROR')
    }
    const path = reference === '#' ? [] : reference.slice(2).split('/')
    for (const segment of path) {
      const key = segment.replace(/~1/g, '/').replace(/~0/g, '~')
      target = isRecord(target) && Object.hasOwn(target, key) ? target[key] : undefined
    }
    if (!isRecord(target)) {
      throw new LlmError(`Antigravity tool schema reference was not found: ${reference}`, 'PROVIDER_ERROR')
    }
    return target
  }

  function convert(node: unknown, references: ReadonlySet<string>): Record<string, unknown> {
    if (!isRecord(node)) return {}
    let inherited: Record<string, unknown> = {}
    if (typeof node.$ref === 'string') {
      if (references.has(node.$ref)) {
        throw new LlmError(`Antigravity tool schema contains a recursive reference: ${node.$ref}`, 'PROVIDER_ERROR')
      }
      inherited = convert(resolveReference(node.$ref), new Set([...references, node.$ref]))
    }
    if (Array.isArray(node.allOf)) {
      for (const branch of node.allOf) inherited = mergeSchemas(inherited, convert(branch, references))
    }

    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      if (schemaFields.has(key)) out[key] = value
    }
    // Recurse only through schema-bearing fields. Property names and literal
    // default/example values may themselves contain words such as propertyNames.
    if (isRecord(node.properties)) {
      out.properties = Object.fromEntries(Object.entries(node.properties)
        .map(([name, child]) => [name, convert(child, references)]))
    }
    if (isRecord(node.items)) out.items = convert(node.items, references)
    const alternatives = Array.isArray(node.anyOf) ? node.anyOf : node.oneOf
    if (Array.isArray(alternatives)) out.anyOf = alternatives.map((child) => convert(child, references))

    // JSON Schema permits type arrays and const; Google's typed Schema does not.
    if (Array.isArray(node.type)) {
      const types = node.type.filter((type): type is string => typeof type === 'string' && type !== 'null')
      delete out.type
      if (types.length === 1) out.type = types[0]
      else if (types.length > 1) out.anyOf = types.map((type) => ({ type }))
      if (node.type.includes('null')) out.nullable = true
    }
    if (Object.hasOwn(node, 'const') && !Object.hasOwn(node, 'enum')) {
      if (node.const === null) out.nullable = true
      else if (['string', 'number', 'boolean'].includes(typeof node.const)) out.enum = [String(node.const)]
    } else if (Array.isArray(node.enum)) {
      out.enum = node.enum.map((value) => String(value))
    }
    // A Claude target folds a union by type, and `{ const: '' }` states none. The
    // type comes from the caller's literal; the wire enum is already stringified.
    if (options.foldUnions && node.type === undefined && !Array.isArray(node.type)) {
      const values = Object.hasOwn(node, 'const') ? [node.const] : node.enum
      if (Array.isArray(values) && values.length > 0) {
        const literal = literalType(values)
        if (literal !== undefined) out.type = literal
      }
    }
    return mergeSchemas(inherited, out)
  }

  const converted = convert(root, new Set())
  // One pass: the fold runs on the finished wire shape, so the hint it adds to a
  // description is never handed back to a sanitizer that would drop it.
  return options.foldUnions === true ? foldSchemaUnions(converted) : converted
}
