import { describe, it, expect, vi } from 'vitest';
import {
  AlwaysDenyHandler,
  AutoApproveHandler,
  createAnnotations,
  Executor,
  FunctionModule,
  jsonSchemaToTypeBox,
  Registry,
} from 'apcore-js';
import { resolveTarget } from '../src/resolve-target.js';
import { createScannedModule } from '../src/types.js';

vi.mock('../src/resolve-target.js', () => ({
  resolveTarget: vi.fn().mockResolvedValue((_inputs: Record<string, unknown>) => ({ result: 'ok' })),
}));

import { RegistryWriter } from '../src/output/registry-writer.js';
import { assertAnnotationsPreserved } from '../src/conformance.js';

const BASE = {
  moduleId: 'orders.delete_order',
  description: 'Delete an order',
  inputSchema: { type: 'object', properties: { orderId: { type: 'integer' } } },
  outputSchema: { type: 'object' },
  tags: [],
  target: 'some-module:handler',
} as const;

describe('assertAnnotationsPreserved', () => {
  it('passes for the base RegistryWriter (annotations survive round-trip)', async () => {
    const mod = createScannedModule({
      ...BASE,
      annotations: createAnnotations({ destructive: true, requiresApproval: true }),
    });
    await expect(assertAnnotationsPreserved(new RegistryWriter(), mod, new Registry())).resolves.toBeUndefined();
  });

  it('throws for a writer that drops annotations (historical adapter bug)', async () => {
    const droppingWriter = {
      async write(mods: ReturnType<typeof createScannedModule>[], registry: Registry) {
        for (const m of mods) {
          await registry.register(
            m.moduleId,
            new FunctionModule({
              moduleId: m.moduleId,
              description: m.description,
              inputSchema: jsonSchemaToTypeBox(m.inputSchema),
              outputSchema: jsonSchemaToTypeBox(m.outputSchema),
              execute: async () => ({}),
            }),
          );
        }
        return [];
      },
    };
    const mod = createScannedModule({ ...BASE, annotations: createAnnotations({ requiresApproval: true }) });
    await expect(assertAnnotationsPreserved(droppingWriter, mod, new Registry())).rejects.toThrow(
      /requiresApproval|lost its annotations/,
    );
  });

  it('requires annotations to be set on the input module', async () => {
    const mod = createScannedModule({ ...BASE });
    await expect(assertAnnotationsPreserved(new RegistryWriter(), mod, new Registry())).rejects.toThrow(
      /annotations to be set/,
    );
  });
});


it('enforces a Toolkit-registered approval annotation through the real Executor', async () => {
  const registry = new Registry();
  const handler = vi.fn(() => ({ result: 'ok' }));
  vi.mocked(resolveTarget).mockResolvedValueOnce(handler);
  const module = createScannedModule({
    ...BASE,
    annotations: createAnnotations({ destructive: true, requiresApproval: true }),
  });
  await assertAnnotationsPreserved(new RegistryWriter(), module, registry);

  const denied = new Executor({ registry, approvalHandler: new AlwaysDenyHandler() });
  await expect(denied.call(module.moduleId, {})).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
  expect(handler).not.toHaveBeenCalled();

  const approved = new Executor({ registry, approvalHandler: new AutoApproveHandler() });
  await expect(approved.call(module.moduleId, {})).resolves.toEqual({ result: 'ok' });
  expect(handler).toHaveBeenCalledTimes(1);
});
