import { describe, expect, test } from 'vitest';
import { DEFAULT_LAYOUT, frameSizes } from '../src/lib/autoLayout';
import { canvasToDefinition, definitionToCanvas } from '../src/lib/irCanvas';

const at = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id,
  isContainer: false,
  position: { x, y },
  ...extra,
});

describe('frameSizes', () => {
  test('a canvas with no containers needs no frames', () => {
    expect(frameSizes([at('a', 0, 0)]).size).toBe(0);
  });

  test('a frame grows to hold the node furthest from its origin', () => {
    const narrow = frameSizes([
      { id: 'loop', isContainer: true, position: { x: 0, y: 0 } },
      at('one', 32, 56, { parentNode: 'loop' }),
    ]);
    const wide = frameSizes([
      { id: 'loop', isContainer: true, position: { x: 0, y: 0 } },
      at('one', 32, 56, { parentNode: 'loop' }),
      at('two', 700, 56, { parentNode: 'loop' }),
    ]);
    expect(wide.get('loop')!.width).toBeGreaterThan(narrow.get('loop')!.width);
    expect(wide.get('loop')!.width).toBeGreaterThan(700 + DEFAULT_LAYOUT.nodeWidth);
  });

  test('an empty frame still gets a size worth drawing', () => {
    const sizes = frameSizes([{ id: 'loop', isContainer: true, position: { x: 0, y: 0 } }]);
    expect(sizes.get('loop')!.width).toBeGreaterThan(0);
    expect(sizes.get('loop')!.height).toBeGreaterThan(0);
  });

  test('a nested frame contributes its own size to its parent', () => {
    const sizes = frameSizes([
      { id: 'outer', isContainer: true, position: { x: 0, y: 0 } },
      { id: 'inner', isContainer: true, position: { x: 32, y: 56 }, parentNode: 'outer' },
      at('leaf', 600, 56, { parentNode: 'inner' }),
    ]);
    expect(sizes.get('outer')!.width).toBeGreaterThanOrEqual(sizes.get('inner')!.width);
  });

  test('a parentNode cycle does not hang', () => {
    const sizes = frameSizes([
      { id: 'x', isContainer: true, position: { x: 0, y: 0 }, parentNode: 'y' },
      { id: 'y', isContainer: true, position: { x: 0, y: 0 }, parentNode: 'x' },
    ]);
    expect(sizes.size).toBe(2);
  });
});

describe('a loop survives a save and reload', () => {
  const loopDefinition = {
    schemaVersion: '0.1',
    workflow: { id: 'wf1', name: 'Loop' },
    entrypoints: ['hook'],
    nodes: [
      { id: 'hook', kind: 'trigger', type: 'webhook.trigger', operationVersion: '0.1.0', parameters: {} },
      { id: 'loop', kind: 'logic', type: 'core.loop', operationVersion: '0.1.0', parameters: {} },
      {
        id: 'body',
        kind: 'logic',
        type: 'core.transform',
        operationVersion: '0.1.0',
        parameters: {},
        scope: { loopId: 'loop' },
      },
    ],
    edges: [],
    metadata: { layout: { hook: { x: 0, y: 0 }, loop: { x: 400, y: 0 }, body: { x: 640, y: 56 } } },
  };

  test('the frame is rebuilt wide enough for the body it holds', () => {
    // The body sits 640px into the frame, well past the 320px CSS floor. Without a
    // rebuilt size it would render outside its own container after a reload.
    const canvas = definitionToCanvas(loopDefinition);
    const loop = canvas.nodes.find((n) => n.id === 'loop')!;
    expect(loop.style).toBeDefined();
    expect(loop.style!.width).toBeGreaterThan(640);
  });

  test('the rebuilt size never reaches the saved definition', () => {
    const canvas = definitionToCanvas(loopDefinition);
    const saved = canvasToDefinition({
      workflowId: 'wf1',
      name: 'Loop',
      nodes: canvas.nodes,
      edges: canvas.edges,
      previous: loopDefinition,
    });
    expect(JSON.stringify(saved)).not.toContain('style');
    // Round-tripping must not disturb the layout it read.
    expect((saved['metadata'] as { layout: Record<string, unknown> }).layout['body']).toEqual({ x: 640, y: 56 });
  });
});
