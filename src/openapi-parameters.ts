import { effectiveReferenceLabel, extractFlatBodyProperties, extractInputSchemaFromParts, resolveEffectiveSchemaValue, resolveLocalPointer } from './openapi.js';
import type { JsonBodyInput } from './openapi.js';
import { PROTO_DENY } from './safe-keys.js';
import type { ScannedModule } from './types.js';

type JsonObject = Record<string, unknown>;
export type OpenApiParameterScope = 'path_item' | 'operation';
export type OpenApiParameterProblem =
  | { kind: 'invalid_list'; scope: OpenApiParameterScope }
  | { kind: 'invalid_parameter'; scope: OpenApiParameterScope; index: number }
  | { kind: 'reference'; scope: OpenApiParameterScope; index: number; reference: string; reason: string }
  | { kind: 'duplicate'; scope: OpenApiParameterScope; name: string; location: string }
  | { kind: 'unsupported_input'; scope: 'operation'; name: string; location: 'path' | 'query' | 'body'; reason: string };

export interface OpenApiProxyInputs {
  path: string[];
  query: string[];
  body: string[];
  problems: OpenApiParameterProblem[];
  required_json_body?: boolean;
}

export const OPENAPI_PROXY_INPUTS_KEY = 'proxy_inputs';
const parameterLocations = new Set(['path', 'query', 'header', 'cookie']);
const bodyApplicators = ['allOf', 'anyOf', 'oneOf', 'not', 'if'];

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProblem(value: unknown): value is OpenApiParameterProblem {
  if (!isObject(value) || (value.scope !== 'path_item' && value.scope !== 'operation')) return false;
  if (value.kind === 'invalid_list') return true;
  if (value.kind === 'duplicate') return typeof value.name === 'string' && typeof value.location === 'string';
  if (value.kind === 'unsupported_input') {
    return value.scope === 'operation' && typeof value.name === 'string' && typeof value.reason === 'string'
      && (value.location === 'path' || value.location === 'query' || value.location === 'body');
  }
  const hasIndex = typeof value.index === 'number' && Number.isSafeInteger(value.index) && value.index >= 0;
  if (value.kind === 'invalid_parameter') return hasIndex;
  return value.kind === 'reference' && hasIndex && typeof value.reference === 'string' && typeof value.reason === 'string';
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

/** Read routing metadata produced by OpenAPIScanner.scanWithEffectiveParameters. */
export function readOpenApiProxyInputs(module: ScannedModule): OpenApiProxyInputs | undefined {
  const openapi = module.metadata?.openapi;
  if (!isObject(openapi) || !Object.prototype.hasOwnProperty.call(openapi, OPENAPI_PROXY_INPUTS_KEY)) return undefined;
  const value = openapi[OPENAPI_PROXY_INPUTS_KEY];
  if (!isObject(value) || !isStringList(value.path) || !isStringList(value.query) ||
      !isStringList(value.body) || !Array.isArray(value.problems) || !value.problems.every(isProblem) ||
      (value.required_json_body !== undefined && typeof value.required_json_body !== 'boolean')) {
    throw new TypeError('Invalid OpenAPI effective parameter metadata');
  }
  return {
    path: value.path, query: value.query, body: value.body, problems: value.problems.map(sanitizeStoredProblem),
    ...(value.required_json_body === true ? { required_json_body: true } : {}),
  };
}

function sanitizeStoredProblem(problem: OpenApiParameterProblem): OpenApiParameterProblem {
  if (problem.kind !== 'reference' || problem.reference === '<non-string>' || problem.reference.startsWith('#')) {
    return problem;
  }
  return { ...problem, reference: effectiveReferenceLabel(problem.reference), reason: 'expected a same-document JSON Pointer' };
}

function resolveEntry(
  entry: JsonObject, doc: JsonObject, scope: OpenApiParameterScope, index: number, problems: OpenApiParameterProblem[],
): JsonObject | undefined {
  let value = entry;
  const seen = new Set<JsonObject>();
  while (Object.prototype.hasOwnProperty.call(value, '$ref')) {
    const reference = value.$ref;
    let reason: string;
    if (typeof reference !== 'string') {
      reason = 'expected a string reference';
    } else if (!reference.startsWith('#')) {
      reason = 'expected a same-document JSON Pointer';
    } else if (seen.has(value)) {
      reason = 'cyclic parameter reference';
    } else {
      seen.add(value);
      try {
        const target = resolveLocalPointer(reference, doc);
        if (isObject(target)) { value = target; continue; }
        reason = 'reference must point to a same-document Parameter Object';
      } catch {
        reason = 'invalid URI fragment encoding';
      }
    }
    problems.push({ kind: 'reference', scope, index, reference: effectiveReferenceLabel(reference), reason });
    return undefined;
  }
  return value;
}

function resolveParameters(
  owner: JsonObject, doc: JsonObject, scope: OpenApiParameterScope, problems: OpenApiParameterProblem[],
): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  if (!Object.prototype.hasOwnProperty.call(owner, 'parameters')) return result;
  const entries = owner.parameters;
  if (!Array.isArray(entries)) {
    problems.push({ kind: 'invalid_list', scope });
    return result;
  }
  for (const [index, entry] of entries.entries()) {
    if (!isObject(entry)) {
      problems.push({ kind: 'invalid_parameter', scope, index });
      continue;
    }
    const parameter = resolveEntry(entry, doc, scope, index, problems);
    if (!parameter) continue;
    const { name, in: location } = parameter;
    if (typeof name !== 'string' || !name || PROTO_DENY.has(name) ||
        typeof location !== 'string' || !parameterLocations.has(location)) {
      problems.push({ kind: 'invalid_parameter', scope, index });
      continue;
    }
    const key = JSON.stringify([name, location]);
    if (result.has(key)) {
      problems.push({ kind: 'duplicate', scope, name, location });
      continue;
    }
    result.set(key, parameter);
  }
  return result;
}

function resolveRequestBody(declaration: JsonObject, doc: JsonObject): JsonObject | undefined {
  const seen = new Set<JsonObject>();
  let body = declaration;
  while (Object.hasOwn(body, '$ref')) {
    if (seen.has(body) || typeof body.$ref !== 'string') return undefined;
    seen.add(body);
    try {
      const resolved = resolveLocalPointer(body.$ref, doc);
      if (!isObject(resolved)) return undefined;
      body = resolved;
    } catch {
      return undefined;
    }
  }
  return body;
}

function effectiveJsonBody(operation: JsonObject, doc: JsonObject, problems: OpenApiParameterProblem[]):
  JsonBodyInput & { requiredJsonBody?: true } {
  const empty = { properties: {}, required: [] };
  if (!Object.hasOwn(operation, 'requestBody')) return empty;
  const fail = (reason: string) => {
    problems.push({ kind: 'unsupported_input', scope: 'operation', name: 'requestBody', location: 'body', reason });
    return empty;
  };
  if (!isObject(operation.requestBody)) return fail('request_body_schema');
  const declaration = resolveRequestBody(operation.requestBody, doc);
  if (!declaration) return fail('request_body_reference');
  const media = isObject(declaration.content) ? declaration.content['application/json'] : undefined;
  if (!isObject(media)) return fail('request_body_media_type');
  const schema = resolveEffectiveSchemaValue(media.schema, doc);
  if (!isObject(schema) || (schema.type !== undefined && schema.type !== 'object') || !isObject(schema.properties) ||
      bodyApplicators.some(keyword => Object.hasOwn(schema, keyword))) {
    return fail('request_body_schema');
  }
  const fields = extractFlatBodyProperties(schema);
  if (Object.keys(fields.properties).length === 0 || fields.required.some(name => !Object.hasOwn(fields.properties, name))) {
    return fail('request_body_schema');
  }
  return { ...fields, ...(declaration.required === true ? { requiredJsonBody: true } : {}) };
}

function schemaHasType(schema: JsonObject, type: string): boolean {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

const schemaCombinators = ['allOf', 'anyOf', 'oneOf'];
const scalarSchemaTypes = new Set(['string', 'boolean', 'number', 'integer']);

function someSchemaBranch(schema: unknown, predicate: (branch: JsonObject) => boolean): boolean {
  if (!isObject(schema)) return false;
  return predicate(schema) || schemaCombinators.some(keyword => {
    const branches = schema[keyword];
    return Array.isArray(branches) && branches.some(branch => someSchemaBranch(branch, predicate));
  });
}

function hasComplexType(schema: unknown): boolean {
  return someSchemaBranch(schema, branch => schemaHasType(branch, 'array') || schemaHasType(branch, 'object'));
}

function hasUnsupportedArrayElement(schema: unknown): boolean {
  return someSchemaBranch(schema, branch =>
    schemaHasType(branch, 'array') || schemaHasType(branch, 'object') || schemaHasType(branch, 'null'));
}

function hasExplicitScalarType(schema: unknown): boolean {
  if (!isObject(schema)) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.length > 0 && types.every(type => typeof type === 'string' && scalarSchemaTypes.has(type));
}

function unsupportedParameterSerialization(parameter: JsonObject, schema: unknown, location: 'path' | 'query'): boolean {
  if (Object.hasOwn(parameter, 'content')) return true;
  if (location === 'path') {
    return (parameter.style !== undefined && parameter.style !== 'simple') || hasComplexType(schema);
  }
  if ((parameter.style !== undefined && parameter.style !== 'form') ||
      someSchemaBranch(schema, branch => schemaHasType(branch, 'object')) ||
      (parameter.explode !== undefined && parameter.explode !== true && !hasExplicitScalarType(schema))) return true;
  if (!someSchemaBranch(schema, branch => schemaHasType(branch, 'array'))) return false;
  return (parameter.explode !== undefined && parameter.explode !== true) ||
    someSchemaBranch(schema, branch => hasUnsupportedArrayElement(branch.items) ||
      (Array.isArray(branch.prefixItems) && branch.prefixItems.some(hasUnsupportedArrayElement)));
}

/** Use the same resolved declarations for schema extraction and proxy routing. */
export function extractEffectiveOperationInputs(
  pathItem: JsonObject, operation: JsonObject, doc: JsonObject,
): { inputSchema: JsonObject; proxyInputs: OpenApiProxyInputs } {
  const problems: OpenApiParameterProblem[] = [];
  const parameters = resolveParameters(pathItem, doc, 'path_item', problems);
  for (const [key, value] of resolveParameters(operation, doc, 'operation', problems)) parameters.set(key, value);
  const body = effectiveJsonBody(operation, doc, problems);
  const inputSchema = extractInputSchemaFromParts(parameters.values(), body, doc, true);
  const proxyInputs: OpenApiProxyInputs = {
    path: [], query: [], body: Object.keys(body.properties), problems,
    ...(body.requiredJsonBody ? { required_json_body: true } : {}),
  };
  const properties = inputSchema.properties as JsonObject;
  for (const parameter of parameters.values()) {
    const name = parameter.name as string;
    const location = parameter.in;
    if (location !== 'path' && location !== 'query') continue;
    proxyInputs[location].push(name);
    if (unsupportedParameterSerialization(parameter, properties[name], location)) {
      problems.push({ kind: 'unsupported_input', scope: 'operation', location, name, reason: `${location}_serialization` });
    }
  }
  return { inputSchema, proxyInputs };
}
