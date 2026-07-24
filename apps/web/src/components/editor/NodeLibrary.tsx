'use client';

import { useState } from 'react';
import type { ConnectorItem } from '../../lib/api';
import { NODE_GLYPHS } from './XperimentNode';

const GROUPS: { kind: ConnectorItem['kind']; title: string }[] = [
  { kind: 'trigger', title: 'Triggers' },
  { kind: 'logic', title: 'Logic' },
  { kind: 'action', title: 'Actions' },
];

export function NodeLibrary({
  items,
  onAdd,
}: {
  items: ConnectorItem[];
  onAdd: (item: ConnectorItem) => void;
}) {
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const visible = q ? items.filter((i) => i.type.toLowerCase().includes(q)) : items;

  return (
    <aside className="q-library" data-testid="node-library">
      <input
        className="q-input"
        placeholder="Search nodes…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        data-testid="lib-search"
      />
      {GROUPS.map((group) => {
        const groupItems = visible.filter((i) => i.kind === group.kind);
        if (groupItems.length === 0) return null;
        return (
          <div className="q-library__group" key={group.kind}>
            <div className="q-library__group-title">{group.title}</div>
            {groupItems.map((item) => (
              <button
                key={item.type}
                type="button"
                className="q-library__item"
                onClick={() => onAdd(item)}
                data-testid={`lib-item-${item.type}`}
              >
                <span className="q-library__glyph" aria-hidden>
                  {NODE_GLYPHS[item.type] ?? '▣'}
                </span>
                <span className="q-library__type">{item.type}</span>
              </button>
            ))}
          </div>
        );
      })}
    </aside>
  );
}
