'use client';

import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import type { ConnectorItem } from '../../lib/api';
import { filterCatalog } from '../../lib/catalogSearch';
import { FALLBACK_GLYPH } from './XperimentNode';

const GROUPS: { kind: ConnectorItem['kind']; title: string }[] = [
  { kind: 'trigger', title: 'Triggers' },
  { kind: 'logic', title: 'Logic' },
  { kind: 'action', title: 'Actions' },
];

export function NodeLibrary({
  items,
  onAdd,
  focusSignal,
}: {
  items: ConnectorItem[];
  onAdd: (item: ConnectorItem) => void;
  /** Increments when '/' is pressed; the value itself carries no meaning. */
  focusSignal: number;
}) {
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const visible = filterCatalog(items, search);

  // Also fires on mount, which is the case that matters: '/' opens the drawer and
  // focuses in one press, and this component did not exist when the key was pressed.
  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus();
  }, [focusSignal]);

  return (
    <aside className="q-library" data-testid="node-library">
      <Input
        ref={inputRef}
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
                  {item.glyph ?? FALLBACK_GLYPH}
                </span>
                <span className="q-library__label">
                  <span className="q-library__type">{item.displayName ?? item.type}</span>
                  {item.description ? <span className="q-library__desc">{item.description}</span> : null}
                </span>
              </button>
            ))}
          </div>
        );
      })}
    </aside>
  );
}
