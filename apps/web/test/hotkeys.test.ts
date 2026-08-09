import { describe, expect, test } from 'vitest';
import { isTextEntry, resolveHotkey, type KeyEvent } from '../src/lib/hotkeys';

const press = (key: string, mods: Partial<KeyEvent> = {}): KeyEvent => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

const onCanvas = (e: KeyEvent) => resolveHotkey(e, false);
const inField = (e: KeyEvent) => resolveHotkey(e, true);

describe('resolveHotkey', () => {
  test('Ctrl+S and Cmd+S both save', () => {
    expect(onCanvas(press('s', { ctrlKey: true }))).toBe('save');
    expect(onCanvas(press('s', { metaKey: true }))).toBe('save');
  });

  test('Ctrl+S resolves to save even while a text field has focus', () => {
    // Saving mid-edit is the whole point of the shortcut — a parameter field is
    // exactly where a user reaches for it.
    expect(inField(press('s', { ctrlKey: true }))).toBe('save');
  });

  test('Ctrl+Z undoes and Ctrl+Shift+Z redoes', () => {
    expect(onCanvas(press('z', { ctrlKey: true }))).toBe('undo');
    expect(onCanvas(press('z', { ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(onCanvas(press('Z', { metaKey: true, shiftKey: true }))).toBe('redo');
  });

  test('Ctrl+Y also redoes, for Windows habits', () => {
    expect(onCanvas(press('y', { ctrlKey: true }))).toBe('redo');
  });

  test('undo and redo yield to the browser inside a text field', () => {
    // A field has its own undo stack; hijacking it would make typing feel broken.
    expect(inField(press('z', { ctrlKey: true }))).toBeNull();
    expect(inField(press('z', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(inField(press('y', { ctrlKey: true }))).toBeNull();
  });

  test('slash focuses the palette search only outside a text field', () => {
    expect(onCanvas(press('/'))).toBe('search');
    expect(inField(press('/'))).toBeNull();
  });

  test('a bare letter is not a shortcut', () => {
    expect(onCanvas(press('z'))).toBeNull();
    expect(onCanvas(press('s'))).toBeNull();
    expect(onCanvas(press('y'))).toBeNull();
  });

  test('Alt disarms every combination', () => {
    expect(onCanvas(press('s', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(onCanvas(press('z', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(onCanvas(press('/', { altKey: true }))).toBeNull();
  });

  test('Delete is left to React Flow, which already owns it', () => {
    // Canvas passes deleteKeyCode={['Delete','Backspace']}; claiming it here would
    // delete the selection twice or fight the library over which won.
    expect(onCanvas(press('Delete'))).toBeNull();
    expect(onCanvas(press('Backspace'))).toBeNull();
  });

  test('an unknown key is null, not a crash', () => {
    expect(onCanvas(press('F7', { ctrlKey: true }))).toBeNull();
    expect(onCanvas(press('Escape'))).toBeNull();
  });
});

describe('isTextEntry', () => {
  test('recognises the elements that own their own keystrokes', () => {
    expect(isTextEntry({ tagName: 'INPUT', isContentEditable: false })).toBe(true);
    expect(isTextEntry({ tagName: 'TEXTAREA', isContentEditable: false })).toBe(true);
    expect(isTextEntry({ tagName: 'SELECT', isContentEditable: false })).toBe(true);
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  test('the canvas and its buttons are not text entry', () => {
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: false })).toBe(false);
    expect(isTextEntry({ tagName: 'BUTTON', isContentEditable: false })).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });

  test('is case-insensitive about the tag name', () => {
    expect(isTextEntry({ tagName: 'input', isContentEditable: false })).toBe(true);
  });
});
