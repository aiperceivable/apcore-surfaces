const OPENAPI_PLACEHOLDER = /\{([^{}]+)\}/g;

export interface EffectiveOpenApiPath {
  readonly template: string;
  readonly parameterNames: ReadonlySet<string>;
  substitute(values: Record<string, unknown>): string;
  firstUnfilled(path: string): string | undefined;
}

/** Read an origin-relative OpenAPI path. Only braces denote parameters. */
export function parseEffectiveOpenApiPath(template: string | undefined): EffectiveOpenApiPath | undefined {
  if (!template?.startsWith('/') || template.startsWith('//') || /[?#\\]/.test(template)) return undefined;
  if (/[{}]/.test(template.replace(OPENAPI_PLACEHOLDER, ''))) return undefined;

  return {
    template,
    parameterNames: new Set(Array.from(template.matchAll(OPENAPI_PLACEHOLDER), match => match[1])),
    substitute(values) {
      return template.replace(OPENAPI_PLACEHOLDER, (literal, name: string) =>
        Object.hasOwn(values, name) ? String(values[name]) : literal);
    },
    firstUnfilled(path) {
      return path.match(OPENAPI_PLACEHOLDER)?.[0];
    },
  };
}
