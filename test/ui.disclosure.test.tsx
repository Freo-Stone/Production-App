// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Disclosure } from '@/ui/primitives';
import { buttonNamed, byText, click, render } from './support/render';

/**
 * The disclosure is how the sources screen keeps its furniture out of the way:
 * one line, and the room underneath it for the table. Two things are worth
 * pinning down — that a closed panel really is out of the layout, and that the
 * line still says what is behind it.
 */

function closed(): HTMLElement {
  const { host } = render(
    <Disclosure title="Import by hand" detail="read in the browser, nothing is uploaded">
      <input type="file" data-testid="picker" />
    </Disclosure>,
  );
  return host;
}

describe('Disclosure', () => {
  it('starts closed, with its content out of the screen entirely', () => {
    const host = closed();
    const trigger = buttonNamed(host, 'Import by hand');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    // Not hidden behind CSS: a file picker in a closed panel would still be the
    // screen's own input, which would be a lie about what it offers.
    expect(host.querySelector('input')).toBeNull();

    // And the line still tells you what is behind it.
    expect(byText(host, 'read in the browser, nothing is uploaded')).toBeTruthy();
  });

  it('opens on one press, and says so', () => {
    const host = closed();
    const onOpenChange = vi.fn();
    render(<Disclosure title="Locations counted as stock" onOpenChange={onOpenChange}>18 of 23</Disclosure>);

    const trigger = buttonNamed(host, 'Import by hand');
    click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('input')).not.toBeNull();

    click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('does the parent’s bidding when it is told what state to be in', () => {
    // Chosen files open the panel from the screen's side, so the widget must not
    // remember its own state and disagree with the screen.
    const onOpenChange = vi.fn();
    const { host, rerender } = render(
      <Disclosure title="Import by hand" open={false} onOpenChange={onOpenChange}>
        <span>the drop zone</span>
      </Disclosure>,
    );

    click(buttonNamed(host, 'Import by hand'));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    // Still closed: the parent has not said otherwise yet.
    expect(host.textContent ?? '').not.toContain('the drop zone');

    rerender(
      <Disclosure title="Import by hand" open onOpenChange={onOpenChange}>
        <span>the drop zone</span>
      </Disclosure>,
    );
    expect(host.textContent ?? '').toContain('the drop zone');
    expect(buttonNamed(host, 'Import by hand').getAttribute('aria-expanded')).toBe('true');
    act(() => undefined);
  });
});
