/**
 * OpenAIConverter - Converts apcore Registry modules to OpenAI-compatible tool definitions.
 *
 * Uses SchemaConverter, AnnotationMapper, and ModuleIDNormalizer internally
 * to produce function-calling tool definitions that conform to the OpenAI
 * chat completions API.
 */

import { toStrictSchema } from "apcore-js";
import { prepareLlmSchema, SchemaConverter } from "../adapters/schema.js";
import { AnnotationMapper } from "../adapters/annotations.js";
import { ModuleIDNormalizer } from "../adapters/id-normalizer.js";
import type { Registry, ModuleDescriptor, OpenAIToolDef, OpenAIResponsesToolDef, JsonSchema } from "../types.js";
import { isMarkdownAvailable, renderModuleMarkdownSync } from "../markdown.js";

/** Options shared by convertRegistry and convertDescriptor. */
export interface ConvertOptions {
  /** If true, append annotation hints to the tool description. */
  embedAnnotations?: boolean;
  /** If true, apply OpenAI strict-mode transformations to the schema. */
  strict?: boolean;
  /**
   * If true, replace the plain `description` with apcore-toolkit
   * Markdown rendering (`formatModule({ style: "markdown" })`). LLMs
   * select tools primarily from this field — Markdown packs more
   * decision-relevant signal per token. Requires apcore-toolkit;
   * the caller must `await primeMarkdownToolkit()` (or
   * `MCPServerFactory.prepare()`) before this synchronous path can
   * find the toolkit. Falls back to plain description when toolkit
   * is unavailable.
   */
  richDescription?: boolean;
}

/** Extended options accepted by convertRegistry (adds filtering). */
export interface ConvertRegistryOptions extends ConvertOptions {
  /** Optional tag filter forwarded to registry.list(). */
  tags?: string[];
  /** Optional prefix filter forwarded to registry.list(). */
  prefix?: string;
}

/**
 * Converts apcore Registry modules to OpenAI-compatible tool definitions.
 *
 * Each tool definition has the shape:
 * ```
 * {
 *   type: "function",
 *   function: {
 *     name: string,
 *     description: string,
 *     parameters: JsonSchema,
 *     strict?: boolean
 *   }
 * }
 * ```
 */
export class OpenAIConverter {
  private readonly _schemaConverter: SchemaConverter;
  private readonly _annotationMapper: AnnotationMapper;
  private readonly _idNormalizer: ModuleIDNormalizer;
  // One-shot flag: warn about missing apcore-toolkit at most once per
  // converter instance (mirrors MCPServerFactory._warnedToolkitMissing).
  private _warnedToolkitMissing = false;

  constructor() {
    this._schemaConverter = new SchemaConverter();
    this._annotationMapper = new AnnotationMapper();
    this._idNormalizer = new ModuleIDNormalizer();
  }

  /**
   * Convert all modules in a Registry to OpenAI tool definitions.
   *
   * Iterates registry.list() with optional tag/prefix filtering,
   * calls registry.getDefinition() for each module ID, skips null
   * definitions (race-condition guard), and converts each descriptor.
   *
   * @param registry - apcore Registry with list() and getDefinition() methods.
   * @param options  - Optional filtering and conversion options.
   * @returns Array of OpenAI-compatible tool definition objects.
   */
  convertRegistry(
    registry: Registry,
    options?: ConvertRegistryOptions,
  ): OpenAIToolDef[] {
    const tags = options?.tags;
    const prefix = options?.prefix;
    const embedAnnotations = options?.embedAnnotations;
    // [D10-005 / OC-1] TS default for `strict` is `true` (changed in 0.14.0 spec).
    const strict = options?.strict ?? true;
    const richDescription = options?.richDescription;

    const moduleIds = registry.list({
      tags: tags ?? null,
      prefix: prefix ?? null,
    });

    const tools: OpenAIToolDef[] = [];
    // [OC-3] Track normalized names so we can detect collisions.
    // OpenAI function names must be unique post-normalization
    // (dot→hyphen). E.g. `a.b` and `a-b` both normalize to `a-b`;
    // without this guard two tools with identical function.name would
    // be emitted silently, producing undefined OpenAI behavior.
    const seenNames = new Map<string, string>();

    for (const moduleId of moduleIds) {
      const descriptor = registry.getDefinition(moduleId);
      if (descriptor === null) {
        continue;
      }
      const tool = this.convertDescriptor(descriptor, {
        embedAnnotations,
        strict,
        richDescription,
      });
      const toolName = tool.function.name;
      const existing = seenNames.get(toolName);
      if (existing !== undefined && existing !== moduleId) {
        throw new Error(
          `OpenAI function-name collision: module ids "${existing}" and "${moduleId}" both ` +
            `normalize to "${toolName}". OpenAI requires unique function names; rename ` +
            `one of the modules to avoid the collision.`,
        );
      }
      seenNames.set(toolName, moduleId);
      tools.push(tool);
    }

    return tools;
  }

  /**
   * Convert a single ModuleDescriptor to an OpenAI tool definition.
   *
   * - Normalizes the moduleId via ModuleIDNormalizer (dots -> dashes).
   * - Converts the inputSchema via SchemaConverter.
   * - Optionally appends an annotation suffix to the description.
   * - Optionally applies strict-mode transformations to the schema.
   *
   * @param descriptor - Module descriptor with moduleId, description,
   *                     inputSchema, and optional annotations.
   * @param options    - Optional conversion flags.
   * @returns OpenAI-compatible tool definition object.
   */
  convertDescriptor(
    descriptor: ModuleDescriptor,
    options?: ConvertOptions,
  ): OpenAIToolDef {
    const embedAnnotations = options?.embedAnnotations ?? false;
    // [D10-005 / OC-1] TS default for `strict` is `true` (changed in 0.14.0 spec).
    const strict = options?.strict ?? true;
    const richDescription = options?.richDescription ?? false;

    const name = this._idNormalizer.normalize(descriptor.moduleId);
    let parameters = this._schemaConverter.convertInputSchema(descriptor, { strict: false, inlineRefs: false });

    // Resolve the LLM-facing description. Markdown rendering takes
    // precedence over the plain `descriptor.description`; the
    // annotation suffix is appended last as a strict superset.
    let description = descriptor.description;
    if (richDescription) {
      if (isMarkdownAvailable()) {
        const md = renderModuleMarkdownSync(descriptor);
        if (md !== null) {
          description = md;
        }
      } else if (!this._warnedToolkitMissing) {
        this._warnedToolkitMissing = true;
        console.warn(
          "OpenAIConverter: richDescription=true but apcore-toolkit is not " +
            "available. Call `await primeMarkdownToolkit()` during startup, " +
            "or install `apcore-toolkit`. Falling back to plain descriptions.",
        );
      }
    }
    if (embedAnnotations) {
      const suffix = this._annotationMapper.toDescriptionSuffix(
        descriptor.annotations,
      );
      description += suffix;
    }

    // Apply strict mode transformations if requested
    if (strict) {
      parameters = this._applyStrictMode(parameters);
    }

    // Build the function definition
    const func: OpenAIToolDef["function"] = {
      name,
      description,
      parameters,
    };

    if (strict) {
      func.strict = true;
    }

    return {
      type: "function",
      function: func,
    };
  }

  /** Convert one module to a Responses API function tool. */
  convertResponsesDescriptor(descriptor: ModuleDescriptor, options?: ConvertOptions): OpenAIResponsesToolDef {
    const tool = this.convertDescriptor(descriptor, options);
    return { type: "function", ...tool.function, strict: options?.strict ?? true };
  }

  /** Convert a registry to Responses API function tools. */
  convertResponsesRegistry(registry: Registry, options?: ConvertRegistryOptions): OpenAIResponsesToolDef[] {
    return this.convertRegistry(registry, options).map(tool => ({
      type: "function",
      ...tool.function,
      strict: options?.strict ?? true,
    }));
  }

  /**
   * Convert a schema to OpenAI strict mode.
   *
   * Creates a deep copy and then recursively applies:
   * 1. `additionalProperties: false` on all objects with properties
   * 2. All properties become required
   * 3. Optional properties (not in original required) become nullable
   *    (type becomes [original, "null"])
   * 4. `default` values are removed
   * 5. Recurses into nested objects and array items
   *
   * @param schema - JSON Schema to transform.
   * @returns New schema with strict mode applied.
   */
  _applyStrictMode(schema: JsonSchema): JsonSchema {
    const copy = structuredClone(schema);
    prepareLlmSchema(copy);
    return toStrictSchema(copy);
  }
}
