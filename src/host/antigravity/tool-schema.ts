import { LlmError } from '@deepseek-ai/dsh-llm'

// FunctionDeclaration.parameters uses Google's Schema, not arbitrary JSON Schema.
// https://googleapis.github.io/js-genai/release_docs/interfaces/types.Schema.html
const schemaFields = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'default', 'example',
  'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength',
  'minProperties', 'maxProperties', 'pattern', 'required', 'propertyOrdering',
])

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

export function toAntigravityToolSchema(schema: unknown): unknown {
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
    return mergeSchemas(inherited, out)
  }

  return convert(root, new Set())
}
