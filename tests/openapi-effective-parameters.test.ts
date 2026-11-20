import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Context, Registry } from 'apcore-js';
import { Value } from '@sinclair/typebox/value';
import { HTTPProxyRegistryWriter, OpenAPIScanner, readOpenApiProxyInputs } from '../src/index.js';

const response = { 200: { description: 'OK' } };
const parameter = (name: string, location: string, type: string, required = false) => ({
  name, in: location, schema: { type }, required,
});

async function captureProxyRequests(exercise: (writer: HTTPProxyRegistryWriter) => Promise<void>) {
  const requests: { url: string; body: string; contentType: string | undefined }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url ?? '', body, contentType: request.headers['content-type'] });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await exercise(new HTTPProxyRegistryWriter({ baseUrl }));
    return requests;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('effective OpenAPI parameters', () => {
  it('preserves boolean inputs reached directly and through schema and Parameter Object references', () => {
    const spec = {
      openapi: '3.1.0',
      components: {
        schemas: { Never: false },
        parameters: {
          Direct: { name: 'direct', in: 'query', schema: true },
          Referenced: { name: 'referenced', in: 'query', schema: { $ref: '#/components/schemas/Never' } },
        },
      },
      paths: {
        '/boolean': { get: {
          parameters: [
            { $ref: '#/components/parameters/Direct' },
            { $ref: '#/components/parameters/Referenced' },
            { name: 'disabled', in: 'query', schema: false },
            { name: 'annotated', in: 'query', schema: {
              $ref: '#/components/schemas/Never', description: 'Disallowed', allOf: [{ type: 'number' }],
            } },
            { name: 'nested', in: 'query', schema: {
              properties: { allowed: true, forbidden: { $ref: '#/components/schemas/Never' } },
              allOf: [true, false],
              anyOf: [false, true],
              oneOf: [true, false],
              items: { $ref: '#/components/schemas/Never' },
              prefixItems: [false, true],
              patternProperties: { '^x-': { $ref: '#/components/schemas/Never' } },
              additionalProperties: false,
              if: true,
              then: false,
              else: true,
              not: { $ref: '#/components/schemas/Never' },
            } },
          ],
          responses: response,
        } },
        '/healthy': { get: { responses: response } },
      },
    };
    const scanner = new OpenAPIScanner();
    const [module, healthy] = scanner.scanWithEffectiveParameters(spec);
    expect(module.inputSchema.properties).toEqual({
      direct: true,
      referenced: false,
      disabled: false,
      annotated: { description: 'Disallowed', allOf: [false, { type: 'number' }] },
      nested: {
        properties: { allowed: true, forbidden: false },
        allOf: [true, false],
        anyOf: [false, true],
        oneOf: [true, false],
        items: false,
        prefixItems: [false, true],
        patternProperties: { '^x-': false },
        additionalProperties: false,
        if: true,
        then: false,
        else: true,
        not: false,
      },
    });
    expect(readOpenApiProxyInputs(module)?.problems).toEqual([]);
    expect(healthy.metadata.url_path).toBe('/healthy');
    expect(scanner.scanWithEffectiveParameters(spec, { include: 'healthy' })).toEqual([healthy]);
    const [legacy] = scanner.scan(spec);
    expect(legacy.inputSchema.properties).toMatchObject({
      disabled: false,
      annotated: {},
      nested: { properties: { allowed: true, forbidden: {} } },
    });

    const registry = new Registry();
    const writer = new HTTPProxyRegistryWriter({ baseUrl: 'https://example.invalid' });
    expect(writer.write([module], registry)[0].verified).toBe(true);
    const inputSchema = registry.get(module.moduleId)?.inputSchema;
    expect(inputSchema).toBeDefined();
    if (inputSchema === undefined) throw new Error('Expected the HTTP proxy input schema');
    expect(Value.Check(inputSchema, { direct: { any: 'value' } })).toBe(true);
    expect(Value.Check(inputSchema, { disabled: 'value' })).toBe(false);
    expect(Value.Check(inputSchema, { referenced: 'value' })).toBe(false);
    expect(Value.Check(inputSchema, { annotated: 42 })).toBe(false);
    expect((module.inputSchema.properties as Record<string, unknown>).disabled).toBe(false);
  });

  it('shares inherited, referenced, and overridden parameters between schema and routing metadata', () => {
    const spec = {
      openapi: '3.1.0',
      components: { parameters: {
        Alias: { $ref: '#/components/parameters/some%20id' },
        'some id': parameter('id', 'path', 'string', true),
        'term/name': parameter('term', 'query', 'string'),
      } },
      paths: { '/items/{id}': {
        parameters: [
          { $ref: '#/components/parameters/Alias' },
          parameter('limit', 'query', 'number', true),
        ],
        get: { parameters: [{ $ref: '#/components/parameters/term~1name' }], responses: response },
      } },
    };
    const scanner = new OpenAPIScanner();
    const [module] = scanner.scanWithEffectiveParameters(spec, {
      transformOperation: (_path, _method, operation) => ({
        ...operation, parameters: [...(operation.parameters as unknown[]), parameter('limit', 'query', 'integer')],
      }),
    });
    expect(module.inputSchema).toEqual({
      type: 'object', properties: { id: { type: 'string' }, limit: { type: 'integer' }, term: { type: 'string' } },
      required: ['id'],
    });
    expect(readOpenApiProxyInputs(module)).toEqual({ path: ['id'], query: ['limit', 'term'], body: [], problems: [] });
    const [legacy] = scanner.scan(spec);
    expect(legacy.inputSchema.properties).toEqual({});
    expect(readOpenApiProxyInputs(legacy)).toBeUndefined();
  });

  it('records malformed and duplicate declarations for the selected operation without unsafe keys', () => {
    const spec = {
      openapi: '3.1.0',
      components: { parameters: { Cycle: { $ref: '#/components/parameters/Cycle' } } },
      paths: { '/items': {
        parameters: { malformed: true },
        post: {
          parameters: [
            parameter('dup', 'query', 'string'), parameter('dup', 'query', 'integer'),
            { $ref: '#/components/parameters/Cycle' },
            { $ref: './remote.json#/parameters/Term' },
            { $ref: '#/components/parameters/Missing' },
            parameter('__proto__', 'query', 'string'),
          ],
          requestBody: { content: { 'application/json': { schema: {
            properties: JSON.parse('{"constructor":{"type":"string"},"safe":{"type":"boolean"}}'),
          } } } },
          responses: response,
        },
      } },
    };
    const [module] = new OpenAPIScanner().scanWithEffectiveParameters(spec);
    expect(Object.keys(module.inputSchema.properties as object)).toEqual(['dup', 'safe']);
    const effective = readOpenApiProxyInputs(module);
    expect(effective?.query).toEqual(['dup']);
    expect(effective?.body).toEqual(['safe']);
    expect(effective?.problems.map(problem => problem.kind)).toEqual([
      'invalid_list', 'duplicate', 'reference', 'reference', 'reference', 'invalid_parameter',
    ]);
  });

  it('preserves conjunctive reference assertions and resolves fragment and array pointers', () => {
    const spec = {
      openapi: '3.1.0',
      components: { schemas: {
        'Color Set': { type: 'string', enum: ['red', 'blue'] },
        Alternatives: { anyOf: [false, true] },
      } },
      paths: { '/colors': { get: {
        parameters: [
          { name: 'color', in: 'query', schema: {
            $ref: '#/components/schemas/Color%20Set', enum: ['red', 'green'], 'x-sensitive': true,
          } },
          { name: 'denied', in: 'query', schema: { $ref: '#/components/schemas/Alternatives/anyOf/0' } },
        ],
        responses: { 200: { description: 'OK', content: { 'application/json': {
          schema: { $ref: '#/components/schemas/Alternatives/anyOf/1' },
        } } } },
      } } },
    };
    const [module] = new OpenAPIScanner().scanWithEffectiveParameters(spec);
    expect(module.inputSchema.properties).toEqual({
      color: {
        type: 'string', enum: ['red', 'green'], 'x-sensitive': true,
        allOf: [{ type: 'string', enum: ['red', 'blue'] }],
      },
      denied: false,
    });
    expect(module.outputSchema).toEqual({});
    const registry = new Registry();
    const writer = new HTTPProxyRegistryWriter({ baseUrl: 'https://example.invalid' });
    expect(writer.write([module], registry)[0].verified).toBe(true);
    const schema = registry.get(module.moduleId)?.inputSchema;
    if (schema === undefined) throw new Error('Expected the HTTP proxy input schema');
    expect(Value.Check(schema, { color: 'red' })).toBe(true);
    expect(Value.Check(schema, { color: 'blue' })).toBe(false);
    expect(Value.Check(schema, { color: 'green' })).toBe(false);
  });

  it('matches the writer media type and identifies unrepresentable request bodies', () => {
    const spec = {
      openapi: '3.1.0',
      components: { requestBodies: {
        Item: { content: {
          'application/vnd.api+json': { schema: { properties: { vendor: { type: 'string' } } } },
          'application/json': { schema: { properties: { plain: { type: 'string' } }, required: ['plain'] } },
        } },
      } },
      paths: {
        '/good': { post: { requestBody: { $ref: '#/components/requestBodies/Item' }, responses: response } },
        '/bool': { post: { requestBody: { required: true, content: { 'application/json': { schema: false } } }, responses: response } },
        '/vendor': { post: { requestBody: { content: { 'application/vnd.api+json': { schema: {
          properties: { vendor: { type: 'string' } },
        } } } }, responses: response } },
        '/missing': { post: { requestBody: { $ref: '#/components/requestBodies/Missing' }, responses: response } },
      },
    };
    const modules = Object.fromEntries(new OpenAPIScanner().scanWithEffectiveParameters(spec)
      .map(module => [module.metadata.url_path, module]));
    expect(modules['/good'].inputSchema).toEqual({
      type: 'object', properties: { plain: { type: 'string' } }, required: ['plain'],
    });
    expect(readOpenApiProxyInputs(modules['/good'])?.problems).toEqual([]);
    for (const [path, reason] of [
      ['/bool', 'request_body_schema'],
      ['/vendor', 'request_body_media_type'],
      ['/missing', 'request_body_reference'],
    ]) {
      expect(readOpenApiProxyInputs(modules[path])?.problems).toEqual([
        { kind: 'unsupported_input', scope: 'operation', location: 'body', name: 'requestBody', reason },
      ]);
    }
  });

  it('sends repeated keys for effective form arrays and preserves the legacy wire format', async () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/list': { get: { parameters: [{
          name: 'tag', in: 'query', schema: { type: 'array', items: { type: 'string' } },
        }], responses: response } },
        '/unsupported': { get: { parameters: [{
          name: 'tag', in: 'query', style: 'form', explode: false, schema: {
            type: 'array', items: { type: 'string' },
          },
        }], responses: response } },
      },
    };
    const scanner = new OpenAPIScanner();
    const [selected, unsupported] = scanner.scanWithEffectiveParameters(spec);
    const [legacy] = scanner.scan(spec);
    expect(readOpenApiProxyInputs(unsupported)?.problems).toEqual([
      { kind: 'unsupported_input', scope: 'operation', location: 'query', name: 'tag', reason: 'query_serialization' },
    ]);

    const requests = await captureProxyRequests(async writer => {
      for (const module of [selected, legacy]) {
        const registry = new Registry();
        expect(writer.write([module], registry)[0].verified).toBe(true);
        const runtime = registry.get(module.moduleId);
        if (runtime === undefined) throw new Error('Expected the HTTP proxy module');
        await runtime.execute({ tag: ['red', 'blue'] }, Context.create());
        if (module === selected) {
          for (const value of [[null], [['red']], [{ color: 'red' }]]) {
            await expect(runtime.execute({ tag: value }, Context.create()))
              .rejects.toThrow('Query array "tag" must contain only strings, booleans, or numbers');
          }
        }
      }
    });
    expect(requests.map(({ url }) => new URL(url, 'http://127.0.0.1').searchParams.getAll('tag')))
      .toEqual([['red', 'blue'], ['["red","blue"]']]);
  });

  it('sends required JSON bodies even when all fields are optional', async () => {
    const spec = {
      openapi: '3.1.0',
      paths: { '/items': { post: { responses: response, requestBody: { required: true, content: {
        'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } },
      } } } } },
    };
    const scanner = new OpenAPIScanner();
    const [effective] = scanner.scanWithEffectiveParameters(spec);
    const [legacy] = scanner.scan(spec);
    const requests = await captureProxyRequests(async writer => {
      for (const module of [effective, legacy]) {
        const registry = new Registry();
        expect(writer.write([module], registry)[0].verified).toBe(true);
        const runtime = registry.get(module.moduleId);
        if (runtime === undefined) throw new Error('Expected the HTTP proxy module');
        await runtime.execute({}, Context.create());
      }
    });
    expect(requests).toEqual([
      { url: '/items', body: '{}', contentType: 'application/json' },
      { url: '/items', body: '', contentType: 'application/json' },
    ]);
  });
});
