import { describe, expect, test } from 'vitest';
import { coreSwitch, SWITCH_MAX_CASES } from '../src/core/switch.js';
import { NodeRunError, type NodeRunContext } from '../src/index.js';

function ctx(parameters: unknown): NodeRunContext {
  return {
    executionId: 'exec-1',
    nodeId: 'sw',
    attempt: 1,
    parameters,
    triggerBody: null,
    signal: new AbortController().signal,
    log: () => {},
  };
}

describe('core.switch', () => {
  test('declares ten case ports plus default', () => {
    // Fixed positional ports keep packages/ir untouched: validateGraph reads this static
    // array, and a declared-name param would need a cross-check that lives in the IR layer.
    expect(coreSwitch.outputPorts).toEqual([
      'case1',
      'case2',
      'case3',
      'case4',
      'case5',
      'case6',
      'case7',
      'case8',
      'case9',
      'case10',
      'default',
    ]);
    expect(SWITCH_MAX_CASES).toBe(10);
  });

  test('routes to the first matching case', async () => {
    const cases = [{ equals: 'a' }, { equals: 'b' }, { equals: 'b' }];
    const r = await coreSwitch.run(ctx({ value: 'b', cases }));
    expect(r.outputPort).toBe('case2');
    expect(r.output).toEqual({ matched: true, caseIndex: 1, value: 'b' });
  });

  test('equality is strict: 150 does not match the string 150', async () => {
    const r = await coreSwitch.run(ctx({ value: 150, cases: [{ equals: '150' }] }));
    expect(r.outputPort).toBe('default');
    expect(r.output).toEqual({ matched: false, caseIndex: null, value: 150 });
  });

  test('matches null and false as values, not as absences', async () => {
    const onNull = await coreSwitch.run(ctx({ value: null, cases: [{ equals: 'x' }, { equals: null }] }));
    expect(onNull.outputPort).toBe('case2');
    const onFalse = await coreSwitch.run(ctx({ value: false, cases: [{ equals: false }] }));
    expect(onFalse.outputPort).toBe('case1');
    // false must not match 0 or '' — that is coercion, not routing.
    const noCoercion = await coreSwitch.run(ctx({ value: false, cases: [{ equals: 0 }, { equals: '' }] }));
    expect(noCoercion.outputPort).toBe('default');
  });

  test('compares objects structurally, not by reference', async () => {
    // An author cannot produce the same object reference twice, so reference equality
    // would mean an object case silently never fires and always falls to default.
    const r = await coreSwitch.run(ctx({ value: { b: 2, a: 1 }, cases: [{ equals: { a: 1, b: 2 } }] }));
    expect(r.outputPort).toBe('case1');
    const arrays = await coreSwitch.run(ctx({ value: [1, 2], cases: [{ equals: [1, 2] }] }));
    expect(arrays.outputPort).toBe('case1');
    const different = await coreSwitch.run(ctx({ value: [1, 2], cases: [{ equals: [2, 1] }] }));
    expect(different.outputPort).toBe('default');
  });

  test('a value with no matching case routes to default', async () => {
    const r = await coreSwitch.run(ctx({ value: 'zzz', cases: [{ equals: 'a' }, { equals: 'b' }] }));
    expect(r.outputPort).toBe('default');
    expect(r.output).toEqual({ matched: false, caseIndex: null, value: 'zzz' });
  });

  test('an absent value is a value: it can match a null case', async () => {
    const r = await coreSwitch.run(ctx({ cases: [{ equals: null }] }));
    expect(r.outputPort).toBe('case1');
  });

  test('rejects more than ten cases and an empty case list', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ equals: i }));
    await expect(coreSwitch.run(ctx({ value: 1, cases: many }))).rejects.toBeInstanceOf(NodeRunError);
    await expect(coreSwitch.run(ctx({ value: 1, cases: [] }))).rejects.toBeInstanceOf(NodeRunError);
  });

  test('rejects a missing or malformed case list without retrying', async () => {
    const err = await coreSwitch.run(ctx({ value: 1 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRunError);
    expect((err as NodeRunError).code).toBe('invalid_parameters');
    // Retrying cannot make malformed parameters valid.
    expect((err as NodeRunError).retryable).toBe(false);
    await expect(coreSwitch.run(ctx({ value: 1, cases: 'nope' }))).rejects.toBeInstanceOf(NodeRunError);
    await expect(coreSwitch.run(ctx({ value: 1, cases: [{ equals: 1, port: 'x' }] }))).rejects.toBeInstanceOf(
      NodeRunError,
    );
  });

  test('the tenth case reaches the tenth port', async () => {
    const cases = Array.from({ length: 10 }, (_, i) => ({ equals: i }));
    const r = await coreSwitch.run(ctx({ value: 9, cases }));
    expect(r.outputPort).toBe('case10');
  });
});
