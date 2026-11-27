import { ModuleIDNormalizer } from "../adapters/id-normalizer.js";
import { prepareLlmSchema } from "../adapters/schema.js";
import type { AnthropicToolDef, ModuleDescriptor } from "../types.js";

/** Convert one module descriptor into an Anthropic Messages tool. */
export class AnthropicConverter {
  private readonly names = new ModuleIDNormalizer();

  convertDescriptor(descriptor: ModuleDescriptor): AnthropicToolDef {
    const schema = structuredClone(descriptor.inputSchema);
    prepareLlmSchema(schema, true);
    const tool: AnthropicToolDef = {
      name: this.names.normalize(descriptor.moduleId),
      description: descriptor.description,
      input_schema: schema,
    };
    const examples: Record<string, unknown>[] = [];
    for (const example of descriptor.examples ?? []) {
      if (typeof example !== "object" || example === null || !("inputs" in example)) continue;
      const { inputs } = example;
      if (typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)) {
        examples.push(structuredClone(inputs) as Record<string, unknown>);
      }
    }
    if (examples.length > 0) tool.input_examples = examples;
    return tool;
  }
}
