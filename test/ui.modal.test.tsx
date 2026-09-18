// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Button, Field, Modal, TextInput } from '@/ui/primitives';
import { click, render, type Rendered } from './support/render';

/**
 * The dialog has to stay out of the way of the person typing in it.
 *
 * Both assertions here came from the same bug: the modal's document-level work —
 * the scroll lock, the Escape listener, the call to focus() — re-ran on every
 * render, because the effect depended on an `onClose` prop that is an inline arrow
 * at every call site. Typing in the first-run name box therefore flipped
 * `document.body.style.overflow` and called focus() once per keystroke: layout
 * thrown away for the whole page, which at full-screen sizes is what "a delay
 * between every letter" turned out to be, and the caret taken out of the field.
 */

/**
 * Counts the two document-level touches the modal makes when it opens: an Escape
 * listener on `document`, and a call to focus(). jsdom cannot count the third one —
 * writing `body.style.overflow` — because its CSSStyleDeclaration has no accessor
 * to wrap, but all three live in the same effect, so either of these two proves
 * whether that effect re-ran. In a browser the overflow write is the expensive one,
 * since it throws away layout for the entire page.
 */
function countDocumentWork(): { counters: { listeners: number; focus: number }; stop: () => void } {
  const counters = { listeners: 0, focus: 0 };

  const focusDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'focus');
  if (!focusDescriptor?.value) throw new Error('no HTMLElement.prototype.focus to wrap');
  const focusOriginal = focusDescriptor.value as (options?: FocusOptions) => void;
  Object.defineProperty(HTMLElement.prototype, 'focus', {
    ...focusDescriptor,
    value: function patchedFocus(this: HTMLElement, options?: FocusOptions): void {
      counters.focus += 1;
      focusOriginal.call(this, options);
    },
  });

  // It lives on EventTarget.prototype; the wrapper goes on the document instance so
  // only document-level listeners are counted.
  const addDescriptor = Object.getOwnPropertyDescriptor(EventTarget.prototype, 'addEventListener');
  if (!addDescriptor?.value) throw new Error('no EventTarget.prototype.addEventListener to wrap');
  const addOriginal = addDescriptor.value as (type: string, listener: unknown, options?: unknown) => void;
  const wrapped = function patchedAdd(
    this: Document,
    type: string,
    listener: unknown,
    options?: unknown,
  ): void {
    if (type === 'keydown') counters.listeners += 1;
    addOriginal.call(this, type, listener, options);
  };
  document.addEventListener = wrapped as typeof document.addEventListener;

  return {
    counters,
    stop: () => {
      // Restore, do not delete: removing the patched method takes the real one with
      // it, and the next render then dies on `domElement.focus is not a function`.
      Object.defineProperty(HTMLElement.prototype, 'focus', focusDescriptor);
      delete (document as unknown as Record<string, unknown>).addEventListener;
    },
  };
}

async function paint(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** One render per character, the way typing really happens. */
function type(control: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  for (const ch of text) {
    act(() => {
      setter?.call(control, control.value + ch);
      control.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}

/** The first-run name box, inline arrow and all, because that is how it is used. */
function NameBox(): ReactElement {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState('');
  return (
    <Modal
      open={open}
      title="Who is using this?"
      onClose={() => setOpen(false)}
      footer={<Button onClick={() => setOpen(false)}>Save</Button>}
    >
      <Field label="Your name">
        <TextInput autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />
      </Field>
    </Modal>
  );
}

function dialogInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('[role="dialog"] input');
  if (!el) throw new Error('no input inside the dialog');
  return el;
}

function dialogButton(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no "${label}" button in the dialog`);
  return found;
}

describe('Modal', () => {
  let h: Rendered | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
    document.body.style.overflow = '';
  });

  it('does no document work per keystroke', async () => {
    const { counters, stop } = countDocumentWork();
    h = render(<NameBox />);
    await paint();
    expect(counters.listeners, 'opening installs one Escape listener').toBe(1);
    expect(counters.focus, 'opening takes focus once').toBe(1);
    const afterOpen = { ...counters };

    type(dialogInput(), 'Testing');
    await paint();

    expect(dialogInput().value).toBe('Testing');
    expect(counters.listeners - afterOpen.listeners, 'an inline onClose re-added the listener per render').toBe(0);
    expect(counters.focus - afterOpen.focus, 'and re-focused the panel, which takes the caret out of the field').toBe(0);
    stop();
  });

  it('does not take the caret out of the field being typed in', async () => {
    h = render(<NameBox />);
    await paint();

    const input = dialogInput();
    input.focus();
    type(input, 'Testing');
    await paint();

    expect(document.activeElement, 'focus stayed in the input across the keystrokes').toBe(input);
  });

  it('gives the scroll lock back when it closes', async () => {
    h = render(<NameBox />);
    await paint();
    expect(document.body.style.overflow).toBe('hidden');

    click(dialogButton('Save'));
    await paint();

    expect(document.body.style.overflow, 'the page behind a closed dialog scrolls again').not.toBe('hidden');
  });

  it('is rendered at the document root, not inside whoever opened it', async () => {
    // jsdom does no layout, so this cannot assert where the dialog *paints* — the
    // browser test does that. What it can pin is the invariant the fix relies on:
    // the dialog is not a descendant of the component that opened it. With the old
    // in-place render, the name prompt sat inside a header that carries a
    // backdrop-filter, and a filtered ancestor becomes the containing block for
    // position: fixed — the dialog was centred inside a 47px strip, title above the
    // top of the screen.
    const host = document.createElement('div');
    host.style.backdropFilter = 'blur(8px)';
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<NameBox />));
    await paint();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog, 'the dialog exists').not.toBeNull();
    expect(host.contains(dialog ?? new DocumentFragment()), 'and is not trapped inside the caller').toBe(false);
    expect(document.body.contains(dialog ?? new DocumentFragment()), 'it hangs off the document').toBe(true);

    act(() => root.unmount());
    host.remove();
  });
});
