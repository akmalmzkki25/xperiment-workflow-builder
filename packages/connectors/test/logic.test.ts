import { describe, expect, test } from 'vitest';
import { createDefaultRegistry, NodeRunError, type NodeRunContext } from '../src/index.js';

const registry = createDefaultRegistry();

function ctx(parameters: unknown, triggerBody: unknown = null): NodeRunContext {
  return {
    executionId: 'exec-1',
    nodeId: 'n1',
    attempt: 1,
    parameters,
    triggerBody,
    signal: new AbortController().signal,
    log: () => {},
  };
}

describe('registry', () => {
  test('exposes the three phase-0 logic/trigger types with RegistryLike fields', () => {
    for (const type of ['manual.trigger', 'core.transform', 'core.if']) {
      const def = registry.get(type);
      expect(def).toBeDefined();
      expect(def!.outputPorts.length).toBeGreaterThan(0);
      expect(def!.paramsSchema).toBeDefined();
      expect(['pure', 'read', 'write']).toContain(def!.defaultEffectClass);
    }
    expect(registry.get('alien.op')).toBeUndefined();
  });

  test('core.if declares true/false ports; others declare main', () => {
    expect(registry.get('core.if')!.outputPorts).toEqual(['true', 'false']);
    expect(registry.get('core.transform')!.outputPorts).toEqual(['main']);
    expect(registry.get('manual.trigger')!.outputPorts).toEqual(['main']);
  });
});

describe('manual.trigger', () => {
  test('emits the trigger body as output', async () => {
    const def = registry.get('manual.trigger')!;
    const r = await def.run(ctx({}, { name: 'Budi' }));
    expect(r).toEqual({ output: { name: 'Budi' } });
  });

  test('null trigger body yields null output', async () => {
    const def = registry.get('manual.trigger')!;
    const r = await def.run(ctx({}, null));
    expect(r).toEqual({ output: null });
  });
});

describe('core.transform', () => {
  test('returns a NEW object built from fields', async () => {
    const def = registry.get('core.transform')!;
    const fields = { greeting: 'Halo Budi', total: 150 };
    const r = await def.run(ctx({ fields }));
    expect(r.output).toEqual({ greeting: 'Halo Budi', total: 150 });
    expect(r.output).not.toBe(fields); // immutability: fresh object
  });

  test('rejects missing fields parameter', async () => {
    const def = registry.get('core.transform')!;
    await expect(def.run(ctx({}))).rejects.toBeInstanceOf(NodeRunError);
  });
});

describe('core.if', () => {
  test('routes true and false to named ports', async () => {
    const def = registry.get('core.if')!;
    expect(await def.run(ctx({ condition: true }))).toEqual({
      output: { result: true },
      outputPort: 'true',
    });
    expect(await def.run(ctx({ condition: false }))).toEqual({
      output: { result: false },
      outputPort: 'false',
    });
  });

  test('non-boolean condition is a non-retryable NodeRunError', async () => {
    const def = registry.get('core.if')!;
    const err = await def.run(ctx({ condition: 'yes' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRunError);
    expect((err as NodeRunError).code).toBe('condition_not_boolean');
    expect((err as NodeRunError).retryable).toBe(false);
  });
});
