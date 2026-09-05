import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { buildRequest, stripMetaSchema } from '../src/host/antigravity/mapper.ts'
import { MODELS } from '../src/host/antigravity/types.ts'

const model = MODELS.find((entry) => entry.id === 'gemini-3.8-flash')!

function requestParameters(parameters: unknown): any {
  const request = buildRequest({
    provider: 'antigravity', model: model.id, messages: [],
    tools: [{ name: 'test_tool', parameters }],
  } as unknown as GenerateOptions, model, 'project', 'gemini-3.8-flash-tiered')
  // Inspect the actual serialized payload, including the function declaration field.
  return JSON.parse(JSON.stringify(request)).request.tools[0].functionDeclarations[0].parameters
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
