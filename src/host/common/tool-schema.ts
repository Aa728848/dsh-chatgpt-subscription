/**
 * JSON-Schema normalization for tool parameter schemas.
 *
 * Provider gateways reject or ignore parts of a JSON Schema that a TypeBox/Zod-style
 * schema carries, and a few keywords arrive unresolved. This module is shared
 * because several provider lines send the same normalized shape and the
 * normalization is behaviour, not preference: two lines that normalize
 * differently send different request bytes for the same tool.
 *
 * The work is:
 *
 * - drop the meta keywords ($schema) a gateway ignores;
 * - INLINE $defs / definitions / $ref, so no reference survives to the wire;
 * - give enum and const nodes an explicit type, which some gateways require;
 * - walk the whole tree, with cycle detection so a self-referential schema
 *   terminates instead of recursing forever.
 *
 * @module dsh-chatgpt-subscription/tool-schema
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue)
  if (isRecord(value)) {
    const res: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      res[k] = cloneJsonValue(v)
    }
    return res
  }
  return value
}

function resolveLocalJsonPointer(root: Record<string, unknown>, ref: string): { found: true; value: unknown } | { found: false } {
  if (ref === '#') return { found: true, value: root }
  let current: unknown = root
  for (const rawPart of ref.slice(2).split('/')) {
    const part = rawPart.replaceAll('~1', '/').replaceAll('~0', '~')
    if (isRecord(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, part)) return { found: false }
      current = current[part]
    } else if (Array.isArray(current)) {
      const idx = Number(part)
      if (!/^(0|[1-9]\d*)$/.test(part) || idx >= current.length) return { found: false }
      current = current[idx]
    } else {
      return { found: false }
    }
  }
  return { found: true, value: current }
}

function derefNode(node: unknown, root: Record<string, unknown>, visited: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((item) => derefNode(item, root, visited))
  if (isRecord(node)) {
    if (typeof node['$ref'] === 'string' && (node['$ref'] === '#' || node['$ref'].startsWith('#/'))) {
      const ref = node['$ref']
      if (visited.has(ref)) return node
      const resolved = resolveLocalJsonPointer(root, ref)
      if (resolved.found) {
        visited.add(ref)
        const inlined = derefNode(resolved.value, root, visited)
        visited.delete(ref)
        if (isRecord(inlined)) {
          const merged: Record<string, unknown> = { ...inlined }
          for (const [k, v] of Object.entries(node)) {
            if (k === '$ref') continue
            merged[k] = derefNode(v, root, visited)
          }
          return merged
        }
        return inlined
      }
      return node
    }
    const res: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) {
      res[k] = derefNode(v, root, visited)
    }
    return res
  }
  return node
}

function hasUnresolvedDefinitionRef(node: unknown, bucketKey: string): boolean {
  if (Array.isArray(node)) return node.some((child) => hasUnresolvedDefinitionRef(child, bucketKey))
  if (isRecord(node)) {
    const ref = node['$ref']
    if (typeof ref === 'string' && ref.startsWith(`#/${bucketKey}/`)) return true
    for (const [k, v] of Object.entries(node)) {
      if (k === bucketKey) continue
      if (hasUnresolvedDefinitionRef(v, bucketKey)) return true
    }
  }
  return false
}

function inferValueType(val: unknown): string | undefined {
  if (val === null) return 'null'
  if (Array.isArray(val)) return 'array'
  switch (typeof val) {
    case 'string': return 'string'
    case 'number': return Number.isInteger(val) ? 'integer' : 'number'
    case 'boolean': return 'boolean'
    case 'object': return 'object'
    default: return undefined
  }
}

function inferTypeFromValues(values: unknown[]): string | undefined {
  const types = new Set<string>()
  for (const v of values) {
    const t = inferValueType(v)
    if (t) types.add(t)
  }
  if (types.has('number') && types.has('integer')) types.delete('integer')
  if (types.size === 1) return types.values().next().value
  return undefined
}

function normalizeSchemaProperties(node: unknown): void {
  if (!isRecord(node)) return

  if (isRecord(node.properties)) {
    for (const propSchema of Object.values(node.properties)) {
      if (isRecord(propSchema)) {
        if (!propSchema.type && !propSchema.$ref) {
          if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) {
            propSchema.type = inferTypeFromValues(propSchema.enum) ?? 'string'
          } else if (propSchema.const !== undefined) {
            propSchema.type = inferValueType(propSchema.const) ?? 'string'
          } else if (isRecord(propSchema.properties)) {
            propSchema.type = 'object'
          } else if (propSchema.items) {
            propSchema.type = 'array'
          }
        }
        normalizeSchemaProperties(propSchema)
      }
    }
  }
  if (isRecord(node.items)) {
    normalizeSchemaProperties(node.items)
  } else if (Array.isArray(node.items)) {
    for (const item of node.items) normalizeSchemaProperties(item)
  }
}

/**
 * Normalizes tool parameter schemas for Kimi by stripping meta keywords ($schema),
 * inlining definitions ($defs/definitions/$ref), and ensuring property types for enums/consts.
 */
export function normalizeKimiToolSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return { type: 'object', properties: {} }
  const cloned = cloneJsonValue(schema) as Record<string, unknown>
  delete cloned.$schema

  const visited = new Set<string>()
  const dereffed = derefNode(cloned, cloned, visited) as Record<string, unknown>
  if (!hasUnresolvedDefinitionRef(dereffed, '$defs')) delete dereffed.$defs
  if (!hasUnresolvedDefinitionRef(dereffed, 'definitions')) delete dereffed.definitions

  normalizeSchemaProperties(dereffed)
  return dereffed
}

/** Drop the JSON-Schema keywords provider gateways reject or ignore, and normalize properties. */
export function stripMetaSchema(schema: unknown): Record<string, unknown> {
  return normalizeKimiToolSchema(schema)
}
