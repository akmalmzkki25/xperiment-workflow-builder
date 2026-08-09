/**
 * Keyboard shortcut resolution, kept free of DOM types so it can be unit-tested.
 *
 * The caller reads the real KeyboardEvent and the focused element; everything that
 * decides what a keystroke MEANS lives here.
 */

export type HotkeyAction = 'save' | 'undo' | 'redo' | 'search' | 'copy' | 'paste' | 'duplicate';

export interface KeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Whether the focused element owns its own keystrokes. */
export function isTextEntry(el: { tagName: string; isContentEditable: boolean } | null): boolean {
  if (!el) return false;
  return el.isContentEditable || TEXT_TAGS.has(el.tagName.toUpperCase());
}

/**
 * The action a keystroke means, or null to let it through.
 *
 * `inTextField` suppresses almost everything: a parameter input has its own undo stack
 * and its own use for `/`. Save is the deliberate exception — mid-edit is exactly when
 * a person reaches for Ctrl+S, and refusing it there would be the shortcut failing at
 * the one moment it matters.
 */
export function resolveHotkey(e: KeyEvent, inTextField: boolean): HotkeyAction | null {
  if (e.altKey) return null;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (mod && key === 's') return 'save';
  if (inTextField) return null;

  if (mod && key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (mod && key === 'y') return 'redo';
  if (mod && !e.shiftKey && key === 'c') return 'copy';
  if (mod && !e.shiftKey && key === 'v') return 'paste';
  if (mod && !e.shiftKey && key === 'd') return 'duplicate';
  if (!mod && !e.shiftKey && e.key === '/') return 'search';

  // Delete and Backspace belong to React Flow's deleteKeyCode. Claiming them here
  // would either delete twice or race the library for the selection.
  return null;
}
