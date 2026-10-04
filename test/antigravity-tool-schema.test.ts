import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'
import { buildRequest, stripMetaSchema } from '../src/host/antigravity/mapper.ts'
import { MODELS } from '../src/host/antigravity/types.ts'

const model = MODELS.find((entry) => entry.id === 'gemini-3.8-flash')!
const claudeModel = MODELS.find((entry) => entry.id === 'claude-opus-5-5')!

function requestParameters(
  parameters: unknown,
  target: { model?: typeof model; runtimeModel?: string } = {},
): any {
  const selected = target.model ?? model
  const request = buildRequest({
    provider: 'antigravity', model: selected.id, messages: [],
    tools: [{ name: 'test_tool', parameters }],
  } as unknown as GenerateOptions, selected, 'project', target.runtimeModel ?? 'gemini-3.8-flash-tiered')
  // Inspect the actual serialized payload, including the function declaration field.
  return JSON.parse(JSON.stringify(request)).request.tools[0].functionDeclarations[0].parameters
}

/** The parameters one Claude request declares, from the serialized wire body. */
function claudeParameters(parameters: unknown, runtimeModel = 'claude-opus-5-5-medium'): any {
  return requestParameters(parameters, { model: claudeModel, runtimeModel })
}

/**
 * Every composition keyword still present in a payload.
 *
 * A parameter NAMED `anyOf` is a property, not a keyword, so `properties` is
 * walked by entry name instead of being treated as a key set.
 */
function compositionKeywords(schema: unknown, path = '$'): string[] {
  if (Array.isArray(schema)) return schema.flatMap((entry, index) => compositionKeywords(entry, `${path}[${index}]`))
  if (typeof schema !== 'object' || schema === null) return []
  const found: string[] = []
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      found.push(`${path}.${key}`)
      found.push(...compositionKeywords(value, `${path}.${key}`))
      continue
    }
    if (key === 'type' && Array.isArray(value)) found.push(`${path}.type[]`)
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      for (const [name, child] of Object.entries(value)) {
        found.push(...compositionKeywords(child, `${path}.properties.${name}`))
      }
      continue
    }
    if (key === 'items') found.push(...compositionKeywords(value, `${path}.items`))
  }
  return found
}

describe('Antigravity tool schema compatibility', () => {
  it('removes unsupported schema keywords from object, array and union members before sending a request', () => {
    const parameters = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      properties: {
        headers: {
          type: 'object', description: 'Request headers',
          propertyNames: { type: 'string' }, additionalProperties: { type: 'string' },
          patternProperties: { '^x-': { type: 'string' } },
        },
        records: {
          type: 'array', minItems: 1,
          items: {
            type: 'object', propertyNames: { pattern: '^[a-z]+$' },
            properties: { value: { type: 'string', minLength: 1 } }, required: ['value'],
            additionalProperties: false,
          },
        },
        payload: {
          anyOf: [
            { type: 'string', $comment: 'String input' },
            { type: 'object', propertyNames: { minLength: 1 }, additionalProperties: true },
          ],
        },
      },
      required: ['headers', 'records'],
    }
    const original = structuredClone(parameters)
    expect(requestParameters(parameters)).toEqual({
      type: 'object', required: ['headers', 'records'],
      properties: {
        headers: { type: 'object', description: 'Request headers' },
        records: {
          type: 'array', minItems: 1,
          items: { type: 'object', properties: { value: { type: 'string', minLength: 1 } }, required: ['value'] },
        },
        payload: { anyOf: [{ type: 'string' }, { type: 'object' }] },
      },
    })
    expect(parameters).toEqual(original)
  })

  it('preserves real parameter names and literal values that happen to match schema keywords', () => {
    const literal = { propertyNames: 'literal value', $schema: 'literal metadata', nested: { additionalProperties: false } }
    const parameters = {
      type: 'object',
      properties: {
        propertyNames: { type: 'string', description: 'A real tool argument' },
        additionalProperties: { type: 'boolean' },
        definitions: { type: 'object', default: literal, example: literal },
      },
      required: ['propertyNames', 'additionalProperties'],
      propertyOrdering: ['propertyNames', 'additionalProperties', 'definitions'],
    }
    expect(requestParameters(parameters)).toEqual(parameters)
  })

  it('expands local definitions without dropping referenced parameter shapes or sibling descriptions', () => {
    const parameters = {
      type: 'object',
      $defs: {
        'Record/~value': {
          type: 'object', propertyNames: { type: 'string' },
          properties: { mode: { type: 'string', const: 'read' } }, required: ['mode'],
        },
      },
      definitions: { label: { type: ['string', 'null'] } },
      properties: {
        first: { $ref: '#/$defs/Record~1~0value', description: 'First record' },
        second: { $ref: '#/$defs/Record~1~0value' },
        label: { $ref: '#/definitions/label' },
      },
    }
    const record = { type: 'object', properties: { mode: { type: 'string', enum: ['read'] } }, required: ['mode'] }
    expect(requestParameters(parameters)).toEqual({
      type: 'object', properties: {
        first: { ...record, description: 'First record' }, second: record, label: { type: 'string', nullable: true },
      },
    })
  })

  it('normalizes composition branches and type unions while retaining required object fields', () => {
    expect(requestParameters({
      type: 'object',
      allOf: [
        { properties: { name: { type: 'string' } }, required: ['name'] },
        { properties: { value: { type: ['number', 'string'] } }, required: ['value'] },
      ],
      properties: {
        options: { oneOf: [
          { type: 'object', propertyNames: { type: 'string' } },
          { type: 'array', items: { type: 'object', propertyNames: { minLength: 1 } } },
        ] },
      },
    })).toEqual({
      type: 'object', required: ['name', 'value'], properties: {
        name: { type: 'string' }, value: { anyOf: [{ type: 'number' }, { type: 'string' }] },
        options: { anyOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }] },
      },
    })
  })

  it.each([
    [{ type: 'object', properties: { child: { $ref: '#' } } }, 'recursive reference'],
    [{ type: 'object', properties: { child: { $ref: '#/$defs/missing' } } }, 'reference was not found'],
    [{ type: 'object', properties: { child: { $ref: 'https://example.test/schema.json' } } }, 'local reference'],
  ])('reports unresolved references locally instead of sending dangling references: %j', (schema, diagnostic) => {
    expect(() => stripMetaSchema(schema)).toThrow(String(diagnostic))
  })
})

describe('Antigravity tool schema for a Claude target', () => {
  // The two real shapes from #39: @deepseek-ai/dsh-experimental-schedule-bundle's
  // `schedule_create.at` and the agent-team profile's `task_board_update.permission`.
  const scheduleAt = {
    type: 'object',
    properties: {
      at: {
        description: 'When the schedule should run',
        oneOf: [
          { type: 'string', description: 'A raw date/time string' },
          { type: 'object', properties: { at: { type: 'string' }, delay: { type: 'string' }, cron: { type: 'string' } } },
        ],
      },
    },
    required: ['at'],
  }
  const permission = {
    type: 'object',
    properties: {
      permission: {
        description: 'Where the permission may change',
        oneOf: [
          { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
          { const: '' },
        ],
      },
    },
  }

  it('declares one form per parameter and keeps the folded alternatives in its description', () => {
    const original = structuredClone(scheduleAt)
    expect(claudeParameters(scheduleAt)).toEqual({
      type: 'object',
      required: ['at'],
      properties: {
        at: {
          type: 'object',
          properties: { at: { type: 'string' }, delay: { type: 'string' }, cron: { type: 'string' } },
          description: 'When the schedule should run\n\n' +
            'Union of accepted forms: string — "A raw date/time string" | object {at,delay,cron}. ' +
            'Send "object {at,delay,cron}": this gateway validates the declared form only, ' +
            'and the alternatives describe the original tool contract.',
        },
      },
    })
    // The gateway rejected this request 400; nothing composed may reach a Claude target.
    expect(compositionKeywords(claudeParameters(scheduleAt))).toEqual([])
    expect(scheduleAt).toEqual(original)
  })

  it('merges an enum union with an untyped const branch instead of dropping the empty string', () => {
    const payload = claudeParameters(permission)
    expect(payload.properties.permission).toEqual({
      type: 'string',
      // A fold that kept only the enum branch would drop the empty string the
      // untyped const branch exists to allow. The type is read from the caller's
      // literal, so a numeric const is not mistaken for a string one.
      enum: ['read-only', 'workspace-write', 'danger-full-access', ''],
      description: 'Where the permission may change\n\n' +
        'Union of accepted forms: string enum["read-only","workspace-write","danger-full-access"] | string enum[""].',
    })
  })

  it('folds unions nested in arrays, references and composition branches', () => {
    const parameters = {
      type: 'object',
      $defs: {
        selector: {
          oneOf: [
            { type: 'object', properties: { kind: { const: 'now' } }, required: ['kind'] },
            { type: 'object', properties: { kind: { const: 'at' }, at: { type: 'string' } }, required: ['kind', 'at'] },
          ],
        },
      },
      allOf: [{ properties: { name: { type: 'string' } }, required: ['name'] }],
      properties: {
        name: { type: 'string' },
        selector: { $ref: '#/$defs/selector', description: 'How to fire' },
        rows: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
        flag: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
    }
    expect(claudeParameters(parameters)).toEqual({
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        // The reference is expanded and then folded, so the union does not return
        // through the one path that would restore it.
        selector: {
          type: 'object',
          properties: { kind: { type: 'string', enum: ['now'] } },
          required: ['kind'],
          description: 'How to fire\n\n' +
            'Union of accepted forms: object {kind} requires kind | object {kind,at} requires kind,at. ' +
            'Send "object {kind} requires kind": this gateway validates the declared form only, ' +
              'and the alternatives describe the original tool contract.',
        },
        rows: {
          type: 'array',
          items: {
            type: 'string',
            description: 'Union of accepted forms: string | number. ' +
'Send "string": this gateway validates the declared form only, ' +
              'and the alternatives describe the original tool contract.',
          },
        },
        // A null alternative is `nullable`, not a branch that can win.
        flag: { type: 'string', nullable: true, description: 'Union of accepted forms: string | null.' },
      },
    })
    expect(compositionKeywords(claudeParameters(parameters))).toEqual([])
  })

  it('folds a union at the tool root and keeps a parameter named after a keyword', () => {
    expect(claudeParameters({
      anyOf: [{ type: 'object', properties: { name: { type: 'string' } } }, { type: 'null' }],
    })).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      nullable: true,
      description: 'Union of accepted forms: object {name} | null.',
    })
    // `anyOf` and `oneOf` are keywords in key position only; as parameter names
    // they are data and must survive both the fold and the sanitizer.
    expect(claudeParameters({
      type: 'object',
      properties: {
        anyOf: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        nested: { type: 'object', properties: { oneOf: { type: 'string', description: 'a real argument' } } },
      },
      required: ['anyOf'],
    })).toEqual({
      type: 'object',
      required: ['anyOf'],
      properties: {
        anyOf: {
          type: 'string',
          description: 'Union of accepted forms: string | number. ' +
'Send "string": this gateway validates the declared form only, ' +
            'and the alternatives describe the original tool contract.',
        },
        nested: { type: 'object', properties: { oneOf: { type: 'string', description: 'a real argument' } } },
      },
    })
  })

  it('preserves a single constrained branch and literal types', () => {
    const result = claudeParameters({ type: 'object', properties: {
      single: { oneOf: [{ type: 'string', pattern: '^ok$', minLength: 2 }] },
      numeric: { const: 5 },
      typed: { type: ['object', 'string', 'null'], properties: { name: { type: 'string' } } },
    } })
    expect(result.properties.single).toEqual({ type: 'string', pattern: '^ok$', minLength: 2 })
    expect(result.properties.numeric.type).toBe('number')
    expect(result.properties.typed).toMatchObject({ type: 'object', nullable: true })
    expect(compositionKeywords(result)).toEqual([])
  })

  it('leaves a Gemini target on the composed form it has always sent', () => {
    expect(requestParameters(scheduleAt)).toEqual({
      type: 'object',
      required: ['at'],
      properties: {
        at: {
          anyOf: [
            { type: 'string', description: 'A raw date/time string' },
            { type: 'object', properties: { at: { type: 'string' }, delay: { type: 'string' }, cron: { type: 'string' } } },
          ],
          description: 'When the schedule should run',
        },
      },
    })
    expect(requestParameters(permission)).toEqual({
      type: 'object',
      properties: {
        permission: {
          anyOf: [
            { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
            { enum: [''] },
          ],
          description: 'Where the permission may change',
        },
      },
    })
  })
})
