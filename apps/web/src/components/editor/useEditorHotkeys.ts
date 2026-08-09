'use client';

import { useEffect, useRef } from 'react';
import { isTextEntry, resolveHotkey, type HotkeyAction } from '../../lib/hotkeys';

/**
 * Binds one window-level keydown listener for the editor.
 *
 * Deliberately holds no logic — what a keystroke means lives in lib/hotkeys.ts, which
 * unit tests can reach. This file only reads the DOM and calls back.
 */
export function useEditorHotkeys(onAction: (action: HotkeyAction) => void): void {
  const latest = useRef(onAction);
  useEffect(() => {
    latest.current = onAction;
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const action = resolveHotkey(e, isTextEntry(el));
      if (!action) return;
      // Ctrl+S would open the browser's save dialog and '/' opens quick-find in Firefox.
      e.preventDefault();
      latest.current(action);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
