// OpenAPI schema extraction utilities

import { PROTO_DENY as PROTO_DENY_LIST } from './safe-keys.js';

type SchemaValue = Record<string, unknown> | boolean;

function isSchemaValue(value: unknown): value is SchemaValue {
  return typeof value === "boolean"
    || (typeof value === "object" && value !== null && !Array.isArray(value));
}

/** Resolve a same-document URI fragment without assuming the target's type. */
export function resolveLocalPointer(reference: string, doc: Record<string, unknown>): unknown {
  if (!reference.startsWith('#')) return undefined;
  const pointer = decodeURIComponent(reference.slice(1));
  if (pointer === '') return doc;
  if (!pointer.startsWith('/')) return undefined;
  let value: unknown = doc;
  for (const segment of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(segment)) return undefined;
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (PROTO_DENY_LIST.has(key)) return undefined;
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key)) return undefined;
      value = value[Number(key)];
    } else if (typeof value === 'object' && value !== null && Object.hasOwn(value, key)) {
      value = (value as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return value;
}

export function schemaObject(schema: SchemaValue): Record<string, unknown> {
  if (schema === true) return {};
  if (schema === false) return { not: {} };
  return schema;
}

/**
 * Resolve a JSON `$ref` pointer like `#/components/schemas/Foo`.
 *
 * Decodes RFC 6901 escape sequences in path segments (`~1` → `/`, `~0` → `~`).
 *
 * @param refString - The `$ref` value (e.g., `#/components/schemas/Foo`).
 * @param openapiDoc - The full OpenAPI document.
 * @returns The resolved schema, or an empty object on failure.
 */
export function resolveRef(
  refString: string,
  openapiDoc: Record<string, unknown>,
): Record<string, unknown> {
  const target = resolveRefValue(refString, openapiDoc);
  return typeof target === "boolean" ? {} : target;
}

function resolveRefValue(
  refString: string,
  openapiDoc: Record<string, unknown>,
): SchemaValue {
  if (!refString.startsWith("#/")) {
    return {};
  }
  const parts = refString.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = openapiDoc;
  for (const part of parts) {
    if (PROTO_DENY_LIST.has(part)) return {};
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return {};
    }
    current = (current as Record<string, unknown>)[part] ?? {};
  }
  return isSchemaValue(current) ? current : {};
}

/**
 * If `schema` contains a `$ref`, resolve it; otherwise return as-is.
 *
 * @param schema - A JSON Schema object (possibly containing `$ref`).
 * @param openapiDoc - The full OpenAPI document (needed for ref resolution),
 *   or `null` when no document is available.
 * @returns The resolved schema, or the original `schema` unchanged.
 */
export function resolveSchema(
  schema: Record<string, unknown>,
  openapiDoc: Record<string, unknown> | null,
): Record<string, unknown> {
  return schemaObject(resolveSchemaValue(schema, openapiDoc));
}

function resolveSchemaValue(
  schema: SchemaValue, openapiDoc: Record<string, unknown> | null,
): SchemaValue {
  if (openapiDoc && typeof schema !== "boolean" && "$ref" in schema) {
    const ref = schema["$ref"];
    if (typeof ref !== 'string') return schema;
    return resolveRef(ref, openapiDoc);
  }
  return schema;
}

/**
 * Recursively resolve all `$ref` pointers in a schema.
 *
 * Handles nested `$ref`, `allOf`, `anyOf`, `oneOf`, and `items`.
 * Depth-limited to 16 levels to prevent infinite recursion.
 */
export function deepResolveRefs(
  schema: Record<string, unknown>,
  openapiDoc: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  return schemaObject(deepResolveSchemaValue(schema, openapiDoc, depth));
}

function deepResolveSchemaValue(
  schema: SchemaValue, openapiDoc: Record<string, unknown>, depth = 0,
  effective = false,
): SchemaValue {
  if (typeof schema === "boolean") return schema;
  if (depth > 16) {
    console.warn('deepResolveRefs: max depth reached; returning schema as-is');
    return schema;
  }
  const resolveChild = (value: SchemaValue): SchemaValue =>
    deepResolveSchemaValue(value, openapiDoc, depth + 1, effective);

  if ("$ref" in schema) {
    const ref = schema["$ref"];
    if (typeof ref !== 'string') return schema;
    // Resolve the target, then merge back any keys that sat BESIDE the `$ref`.
    // Discarding them silently drops `x-sensitive`, which apcore reads off the
    // *resolved* schema to decide what to redact — a field the OpenAPI document
    // marked sensitive then reaches apcore carrying nothing to redact on.
    // apcore closed the same hole in its own resolver as D-98 in 0.31.0;
    // see docs/features/openapi.md.
    const resolved = resolveChild(effective ? resolveEffectiveReference(ref, openapiDoc) : resolveRef(ref, openapiDoc));
    const siblings: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k !== "$ref") siblings[k] = v;
    }
    if (Object.keys(siblings).length === 0) return resolved;
    // Siblings are walked at the SAME depth: following the reference has
    // already consumed a level and they are not a second hop.
    const resolvedSiblings = schemaObject(deepResolveSchemaValue(siblings, openapiDoc, depth, effective));
    if (resolved === false) {
      const siblingsAllOf = Array.isArray(resolvedSiblings.allOf) ? resolvedSiblings.allOf : [];
      return { ...resolvedSiblings, allOf: [false, ...siblingsAllOf] };
    }
    if (effective && resolved !== true && Object.keys(resolvedSiblings).some(key => !isSchemaAnnotation(key))) {
      const annotations = Object.fromEntries(Object.entries(resolved).filter(([key]) => isSchemaAnnotation(key)));
      const type = typeof resolved.type === 'string' ? { type: resolved.type } : {};
      const siblingAllOf = Array.isArray(resolvedSiblings.allOf) ? resolvedSiblings.allOf : [];
      // Keep sibling assertions adjacent to the target, including unevaluatedProperties.
      return { ...annotations, ...type, ...resolvedSiblings, allOf: [resolved, ...siblingAllOf] };
    }
    return { ...schemaObject(resolved), ...resolvedSiblings };
  }

  const result = { ...schema };

  // Resolve inside allOf/anyOf/oneOf
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (key in result && Array.isArray(result[key])) {
      result[key] = (result[key] as unknown[])
        .filter(isSchemaValue)
        .map(resolveChild);
    }
  }

  // Resolve array items (single-schema form)
  if (isSchemaValue(result["items"])) {
    result["items"] = resolveChild(result["items"]);
  }

  // Resolve tuple-form items (when items is an array of schemas)
  if (Array.isArray(result["items"])) {
    result["items"] = (result["items"] as unknown[]).map(item =>
      isSchemaValue(item) ? resolveChild(item) : item,
    );
  }

  // Resolve nested properties
  if (
    "properties" in result &&
    typeof result["properties"] === "object" &&
    result["properties"] !== null
  ) {
    const props = result["properties"] as Record<string, unknown>;
    const resolvedProps: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(props)) {
      if (PROTO_DENY_LIST.has(k)) continue;
      resolvedProps[k] = isSchemaValue(v) ? resolveChild(v) : v;
    }
    result["properties"] = resolvedProps;
  }

  // patternProperties — each value is a schema
  if (result["patternProperties"] && typeof result["patternProperties"] === "object") {
    result["patternProperties"] = Object.fromEntries(
      Object.entries(result["patternProperties"] as Record<string, unknown>).map(([k, v]) => [
        k,
        isSchemaValue(v) ? resolveChild(v) : v,
      ]),
    );
  }

  for (const key of ["additionalProperties", "not", "if", "then", "else"] as const) {
    if (isSchemaValue(result[key])) {
      result[key] = resolveChild(result[key]);
    }
  }

  // prefixItems — array of schemas
  if (Array.isArray(result["prefixItems"])) {
    result["prefixItems"] = (result["prefixItems"] as unknown[]).map(item =>
      isSchemaValue(item) ? resolveChild(item) : item,
    );
  }

  return result;
}

function isSchemaAnnotation(key: string): boolean {
  return key.startsWith('x-') || [
    'title', 'description', 'default', 'deprecated', 'readOnly', 'writeOnly', 'examples', 'example',
  ].includes(key);
}

function resolveEffectiveReference(reference: string, doc: Record<string, unknown>): SchemaValue {
  try {
    const value = resolveLocalPointer(reference, doc);
    return isSchemaValue(value) ? value : {};
  } catch {
    return {};
  }
}

export function resolveEffectiveSchemaValue(schema: unknown, doc: Record<string, unknown>): SchemaValue | undefined {
  return isSchemaValue(schema) ? deepResolveSchemaValue(schema, doc, 0, true) : undefined;
}

/**
 * Extract input schema from an OpenAPI operation.
 *
 * Combines query/path parameters and request body properties into a
 * single `{"type": "object", "properties": ..., "required": [...]}` schema.
 *
 * @param operation - An OpenAPI operation object (e.g., from `paths["/users"]["get"]`).
 * @param openapiDoc - The full OpenAPI document (for `$ref` resolution), or `null`.
 * @returns A merged JSON Schema object for all input parameters.
 */
export function extractInputSchema(
  operation: Record<string, unknown>,
  openapiDoc: Record<string, unknown> | null = null,
): Record<string, unknown> {
  const rawParameters = operation["parameters"] ?? [];
  if (!Array.isArray(rawParameters)) {
    console.warn('extractInputSchema: operation.parameters is not an array — ignoring');
  }
  const parameters = Array.isArray(rawParameters)
    ? (rawParameters as unknown[]).filter(
        (p): p is Record<string, unknown> =>
          typeof p === 'object' && p !== null && !Array.isArray(p),
      )
    : [];
  return extractInputSchemaFromParts(parameters, extractJsonBodyInput(operation, openapiDoc), openapiDoc);
}

export interface JsonBodyInput {
  properties: Record<string, unknown>;
  required: string[];
}

/** Select the JSON media type and fields used by flat input extraction. */
export function extractJsonBodyInput(
  operation: Record<string, unknown>, openapiDoc: Record<string, unknown> | null,
): JsonBodyInput {
  const requestBody = (operation["requestBody"] ?? {}) as Record<string, unknown>;
  const content = (requestBody["content"] ?? {}) as Record<string, unknown>;
  const contentKeys = Object.keys(content);
  const jsonKey = contentKeys.find(k => k === 'application/json')
    ?? contentKeys.find(k => k.startsWith('application/json'))
    ?? contentKeys.find(k => k === 'application/vnd.api+json');
  const jsonContent = (jsonKey ? content[jsonKey] : {}) as Record<string, unknown>;
  const bodySchema = jsonContent["schema"];
  if (!isSchemaValue(bodySchema)) return { properties: {}, required: [] };
  const resolved = resolveSchemaValue(bodySchema, openapiDoc);
  return extractFlatBodyProperties(resolved);
}

export function extractFlatBodyProperties(resolved: SchemaValue): JsonBodyInput {
  if (typeof resolved === "boolean") return { properties: {}, required: [] };
  const bodyProperties = (resolved["properties"] ?? {}) as Record<string, unknown>;
  const bodyRequired = (resolved["required"] ?? []) as string[];
  return {
    properties: Object.fromEntries(Object.entries(bodyProperties).filter(([key]) => !PROTO_DENY_LIST.has(key))),
    required: Array.isArray(bodyRequired)
      ? bodyRequired.filter(name => typeof name === 'string' && !PROTO_DENY_LIST.has(name)) : [],
  };
}

export function extractInputSchemaFromParts(
  parameters: Iterable<Record<string, unknown>>,
  body: JsonBodyInput,
  openapiDoc: Record<string, unknown> | null,
  preserveReferenceSiblings = false,
): Record<string, unknown> {
  const schema: { type: string; properties: Record<string, unknown>; required: string[] } =
    { type: "object", properties: {}, required: [] };
  for (const param of parameters) {
    if (param["in"] === "query" || param["in"] === "path") {
      const name = param["name"];
      if (typeof name !== 'string' || PROTO_DENY_LIST.has(name)) continue;
      const paramSchema = param["schema"];
      const value = isSchemaValue(paramSchema) ? paramSchema : { type: "string" };
      schema.properties[name] = preserveReferenceSiblings ? value : resolveSchemaValue(value, openapiDoc);
      if (param["required"]) {
        schema.required.push(name);
      }
    }
  }

  Object.assign(schema.properties, body.properties);
  schema.required.push(...body.required);

  // Recursively resolve $ref inside individual properties
  if (openapiDoc) {
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      if (isSchemaValue(propSchema)) {
        schema.properties[propName] = deepResolveSchemaValue(propSchema, openapiDoc, 0, preserveReferenceSiblings);
      }
    }
  }

  // Deduplicate required[] — path params and body schema may both declare the same field
  schema.required = [...new Set(schema.required)];

  return schema;
}

/**
 * Extract output schema from OpenAPI operation responses.
 *
 * Accepts any 2xx status code (200–299). Response codes are checked in
 * lexicographic order, so 200 is preferred over 201, 201 over 202, and so on.
 *
 * @param operation - An OpenAPI operation object.
 * @param openapiDoc - The full OpenAPI document (for `$ref` resolution), or `null`.
 * @returns The output JSON Schema, or a default empty object schema.
 */
export function extractOutputSchema(
  operation: Record<string, unknown>,
  openapiDoc: Record<string, unknown> | null = null,
): Record<string, unknown> {
  return extractResponseSchema(operation, openapiDoc, false);
}

export function extractEffectiveOutputSchema(
  operation: Record<string, unknown>, openapiDoc: Record<string, unknown>,
): Record<string, unknown> {
  return extractResponseSchema(operation, openapiDoc, true);
}

function extractResponseSchema(
  operation: Record<string, unknown>, openapiDoc: Record<string, unknown> | null, effective: boolean,
): Record<string, unknown> {
  const responses = (operation["responses"] ?? {}) as Record<string, unknown>;

  const successCodes = Object.keys(responses).filter(
    k => /^2\d\d$/.test(k),
  ).sort();

  for (const statusCode of successCodes) {
    const response = responses[statusCode] as Record<string, unknown>;
    const content = (response["content"] ?? {}) as Record<string, unknown>;
    // Accept application/json (exact or with parameters like charset=utf-8),
    // application/vnd.api+json, or any key starting with "application/json".
    // Mirrors Python's startswith("application/json") behaviour.
    const respContentKeys = Object.keys(content);
    const respJsonKey = respContentKeys.find(k => k === 'application/json')
      ?? respContentKeys.find(k => k.startsWith('application/json'))
      ?? respContentKeys.find(k => k === 'application/vnd.api+json');
    const jsonContent = (respJsonKey ? content[respJsonKey] : {}) as Record<string, unknown>;

    const rawSchema = jsonContent["schema"];
    if (isSchemaValue(rawSchema)) {
      if (effective && openapiDoc) return schemaObject(deepResolveSchemaValue(rawSchema, openapiDoc, 0, true));
      let schema = resolveSchemaValue(rawSchema, openapiDoc);
      // Recursively resolve all nested $ref pointers
      if (openapiDoc) {
        schema = deepResolveSchemaValue(schema, openapiDoc);
      }
      return schemaObject(schema);
    }
  }

  return { type: "object", properties: {} };
}
