/** Forwarding diagnostics for modules selected by the effective OpenAPI scanner. */
import { parseEffectiveOpenApiPath, type EffectiveOpenApiPath } from "./openapi-path.js";
import {
  readOpenApiProxyInputs,
  type OpenApiParameterProblem,
  type OpenApiProxyInputs,
} from "./openapi-parameters.js";
import { proxyUsesJsonBody, readProxyRoute } from "./output/http-proxy-writer.js";
import type { ScannedModule } from "./types.js";

export type OpenApiInputLocation = "path" | "query" | "body";
export type EffectiveProxyHazardKind =
  | { code: "missing_effective_inputs" }
  | { code: "invalid_effective_inputs"; detail: string }
  | { code: "missing_route_metadata"; key: "http_method" | "url_path" }
  | { code: "unsupported_http_method"; method: string }
  | { code: "parameter_resolution"; problem: OpenApiParameterProblem }
  | { code: "query_on_body_method"; parameters: string[] }
  | { code: "body_on_query_method"; properties: string[] }
  | { code: "name_collision"; name: string; locations: OpenApiInputLocation[] }
  | { code: "path_template_mismatch"; undeclared: string[]; unused: string[] }
  | { code: "input_schema_mismatch"; unlocated: string[]; unpublished: string[] };

export interface EffectiveProxyHazard {
  moduleId: string;
  httpMethod: string;
  urlPath: string;
  kind: EffectiveProxyHazardKind;
}

export interface EffectiveProxyHazardWire {
  module_id: string;
  http_method: string;
  url_path: string;
  kind: EffectiveProxyHazardKind;
}

const INPUT_LOCATIONS: readonly OpenApiInputLocation[] = ["path", "query", "body"];
// The portable proxy contract excludes TRACE, which native Fetch rejects.
const PROXY_METHODS: ReadonlySet<string> = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
]);

// Match Python and Rust's lexicographic order for Unicode property names.
function compareCodePoints(left: string, right: string): number {
  let offset = 0;
  while (offset < left.length && offset < right.length) {
    const leftPoint = left.codePointAt(offset) ?? 0;
    const rightPoint = right.codePointAt(offset) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
    offset += leftPoint > 0xffff ? 2 : 1;
  }
  return left.length - right.length;
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter(key => !right.has(key)).sort(compareCodePoints);
}

function inspectInputNames(
  inputs: OpenApiProxyInputs, schema: Record<string, unknown>,
): EffectiveProxyHazardKind[] {
  const locations = new Map<string, OpenApiInputLocation[]>();
  for (const location of INPUT_LOCATIONS) {
    for (const name of new Set(inputs[location])) {
      const entries = locations.get(name) ?? [];
      entries.push(location);
      locations.set(name, entries);
    }
  }
  const hazards: EffectiveProxyHazardKind[] = [];
  for (const name of [...locations.keys()].sort(compareCodePoints)) {
    const names = locations.get(name) ?? [];
    if (names.length > 1) hazards.push({ code: "name_collision", name, locations: names });
  }
  const properties = schema.properties;
  const published = new Set(
    properties !== null && typeof properties === "object" && !Array.isArray(properties)
      ? Object.keys(properties) : [],
  );
  const located = new Set(locations.keys());
  const unlocated = difference(published, located);
  const unpublished = difference(located, published);
  if (unlocated.length || unpublished.length) hazards.push({ code: "input_schema_mismatch", unlocated, unpublished });
  return hazards;
}

function assessEffectiveInputs(
  module: ScannedModule, method: string | undefined, path: EffectiveOpenApiPath | undefined,
): EffectiveProxyHazardKind[] {
  let inputs: OpenApiProxyInputs | undefined;
  try {
    inputs = readOpenApiProxyInputs(module);
  } catch (error) {
    return [{ code: "invalid_effective_inputs", detail: error instanceof Error ? error.message : String(error) }];
  }
  if (!inputs) return [{ code: "missing_effective_inputs" }];
  const hazards: EffectiveProxyHazardKind[] = inputs.problems.map(problem => ({ code: "parameter_resolution", problem }));
  if (!method) {
    hazards.push({ code: "missing_route_metadata", key: "http_method" });
  } else if (!PROXY_METHODS.has(method)) {
    hazards.push({ code: "unsupported_http_method", method });
  } else if (proxyUsesJsonBody(method)) {
    if (inputs.query.length) hazards.push({ code: "query_on_body_method", parameters: [...inputs.query] });
  } else if (inputs.body.length) {
    hazards.push({ code: "body_on_query_method", properties: [...inputs.body].sort(compareCodePoints) });
  }
  if (!path) {
    hazards.push({ code: "missing_route_metadata", key: "url_path" });
  } else {
    const template = path.parameterNames;
    const declared = new Set(inputs.path);
    const undeclared = difference(template, declared);
    const unused = difference(declared, template);
    if (undeclared.length || unused.length) hazards.push({ code: "path_template_mismatch", undeclared, unused });
  }
  return [...hazards, ...inspectInputNames(inputs, module.inputSchema)];
}

/**
 * Check selected modules from OpenAPIScanner.scanWithEffectiveParameters
 * before registering them with the HTTP proxy writer. The scanner's routing
 * metadata comes from the parameters that generated the tool schema.
 */
export function detectEffectiveProxyHazards(modules: readonly ScannedModule[]): EffectiveProxyHazard[] {
  const hazards = modules.flatMap(module => {
    const route = readProxyRoute(module);
    const httpMethod = route.httpMethod?.trim() ? route.httpMethod : undefined;
    const path = parseEffectiveOpenApiPath(route.urlPath);
    return assessEffectiveInputs(module, httpMethod, path).map(kind => ({
      moduleId: module.moduleId, httpMethod: httpMethod ?? "?", urlPath: path?.template ?? "?", kind,
    }));
  });
  return hazards.sort((left, right) => {
    for (const key of ["moduleId", "httpMethod", "urlPath"] as const) {
      const order = compareCodePoints(left[key], right[key]);
      if (order !== 0) return order;
    }
    return 0;
  });
}

/** Convert a typed effective hazard to the shared diagnostic JSON shape. */
export function effectiveHazardToWire(hazard: EffectiveProxyHazard): EffectiveProxyHazardWire {
  const { kind } = hazard;
  return {
    module_id: hazard.moduleId,
    http_method: hazard.httpMethod,
    url_path: hazard.urlPath,
    kind: kind.code === "parameter_resolution"
      ? { code: kind.code, problem: parameterProblemToWire(kind.problem) }
      : kind,
  };
}

function parameterProblemToWire(problem: OpenApiParameterProblem): OpenApiParameterProblem {
  const { kind, scope } = problem;
  switch (kind) {
    case "invalid_list": return { kind, scope };
    case "invalid_parameter": return { kind, scope, index: problem.index };
    case "reference": return { kind, scope, index: problem.index, reference: problem.reference, reason: problem.reason };
    case "duplicate": return { kind, scope, name: problem.name, location: problem.location };
    case "unsupported_input": return { kind, scope, name: problem.name, location: problem.location, reason: problem.reason };
  }
}

/** Format one finding for startup errors and human-readable CLI output. */
export function describeEffectiveProxyHazard(hazard: EffectiveProxyHazard): string {
  const route = `${hazard.moduleId} (${hazard.httpMethod} ${hazard.urlPath})`;
  const { kind } = hazard;
  switch (kind.code) {
    case "missing_effective_inputs":
      return `${route}: effective OpenAPI parameter metadata is unavailable`;
    case "invalid_effective_inputs":
      return `${route}: ${kind.detail}`;
    case "missing_route_metadata":
      return `${route}: missing route field ${kind.key}`;
    case "unsupported_http_method":
      return `${route}: unsupported HTTP method ${kind.method}`;
    case "parameter_resolution":
      return `${route}: parameter resolution failed (${JSON.stringify(parameterProblemToWire(kind.problem))})`;
    case "query_on_body_method":
      return `${route}: query parameters on a JSON body method: ${kind.parameters.join(", ")}`;
    case "body_on_query_method":
      return `${route}: JSON body properties on this HTTP method: ${kind.properties.join(", ")}`;
    case "name_collision":
      return `${route}: input ${kind.name} occurs in ${kind.locations.join(", ")}`;
    case "path_template_mismatch":
      return `${route}: path template mismatch (undeclared: ${kind.undeclared.join(", ")}; unused: ${kind.unused.join(", ")})`;
    case "input_schema_mismatch":
      return `${route}: input schema mismatch (unlocated: ${kind.unlocated.join(", ")}; unpublished: ${kind.unpublished.join(", ")})`;
  }
}

/** Refuse a batch before registration if any selected operation cannot be forwarded. */
export function validateEffectiveProxyModules(modules: readonly ScannedModule[]): void {
  const hazards = detectEffectiveProxyHazards(modules);
  if (hazards.length > 0) {
    const details = hazards.map(describeEffectiveProxyHazard).join("; ");
    throw new Error(`OpenAPI proxy cannot forward selected operations: ${details}`);
  }
}
