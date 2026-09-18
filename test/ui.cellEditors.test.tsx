// @vitest-environment jsdom
import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CellCheck, CellNumber, CellSelect, CellText } from '@/ui/cellEditors';
import { render, click } from './support/render';

/**
 * Cell editors live inside a row that is itself clickable and arrow-key
 * navigable, so the isolation rules matter as much as the editing.
 */
function Row({ children, onRowClick }: { children: React.ReactNode; onRowClick: () => void }) {
  return (
    <div role="row" onClick={onRowClick} onKeyDown={() => onRowClick()}>
      {children}
    </div>
  );
}

function focus(el: Element): void {
  act(() => {
    (el as HTMLElement).focus();
  });
}

function blur(el: Element): void {
  focus(el);
  act(() => {
    (el as HTMLElement).blur();
  });
}

function type(el: Element, text: string): void {
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('cell editors', () => {
  it('commits a number once, on blur, with the finished figure', () => {
    const onCommit = vi.fn();
    const h = render(
      <CellNumber value={2.5} onCommit={onCommit} />,
    );
    const input = h.host.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('2.5');

    // "2." is not a number anyone finished typing; it must not commit as zero.
    type(input, '2.');
    expect(onCommit).not.toHaveBeenCalled();

    type(input, '2.75');
    blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(2.75);
    h.unmount();
  });

  it('treats an emptied field as zero-by-caller, not as a silent no-change', () => {
    const onCommit = vi.fn();
    const h = render(<CellNumber value={10} onCommit={onCommit} />);
    const input = h.host.querySelector('input') as HTMLInputElement;
    type(input, '');
    blur(input);
    expect(onCommit).toHaveBeenCalledWith(null);
    h.unmount();
  });

  it('does not commit when focus leaves without an edit', () => {
    const onCommit = vi.fn();
    const h = render(<CellNumber value={7} onCommit={onCommit} />);
    const input = h.host.querySelector('input') as HTMLInputElement;
    act(() => input.focus());
    blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    h.unmount();
  });

  it('keeps a click on an editor from opening the row behind it', () => {
    const onRowClick = vi.fn();
    const onCommit = vi.fn();
    const h = render(
      <Row onRowClick={onRowClick}>
        <CellNumber value={1} onCommit={onCommit} />
        <CellCheck checked={false} onCommit={onCommit} label="Current" />
        <CellText value="note" onCommit={onCommit} />
      </Row>,
    );

    click(h.host.querySelector('input[type="number"]')!);
    click(h.host.querySelector('[role="checkbox"]')!);
    click(h.host.querySelector('input:not([type="number"])')!);
    expect(onRowClick).not.toHaveBeenCalled();
    // The check editor still did its own job.
    expect(onCommit).toHaveBeenCalledWith(true);
    h.unmount();
  });

  it('lets arrow keys stay inside the field instead of walking the grid', () => {
    const onRowClick = vi.fn();
    const h = render(
      <Row onRowClick={onRowClick}>
        <CellNumber value={1} onCommit={() => {}} />
      </Row>,
    );
    const input = h.host.querySelector('input') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(onRowClick).not.toHaveBeenCalled();
    h.unmount();
  });

  it('commits a select the moment another option is chosen', () => {
    const onCommit = vi.fn();
    const h = render(
      <CellSelect
        value="m2"
        options={[
          { value: 'm2', label: 'm²' },
          { value: 'lm', label: 'lm' },
        ]}
        onCommit={onCommit}
      />,
    );
    const select = h.host.querySelector('select') as HTMLSelectElement;
    act(() => {
      select.value = 'lm';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onCommit).toHaveBeenCalledWith('lm');
    h.unmount();
  });

  it('clears a note through the text editor', () => {
    const onCommit = vi.fn();
    const h = render(<CellText value="keep off blast" onCommit={onCommit} />);
    const input = h.host.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('keep off blast');
    type(input, '');
    blur(input);
    expect(onCommit).toHaveBeenCalledWith('');
    h.unmount();
  });

  it('shows a tick only when a switch is on, and says so to a reader', () => {
    // State lives in a component: a hook at the top of a test is not a render.
    function Switched() {
      const [on, setOn] = useState(true);
      return <CellCheck checked={on} onCommit={setOn} label="Current" />;
    }
    const h = render(<Switched />);
    const box = h.host.querySelector('[role="checkbox"]') as HTMLElement;
    expect(box.getAttribute('aria-checked')).toBe('true');
    expect(box.textContent).toContain('Yes');
    click(box);
    expect(box.getAttribute('aria-checked')).toBe('false');
    h.unmount();
  });
});
