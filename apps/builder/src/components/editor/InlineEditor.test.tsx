import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InlineEditor } from '@/components/editor/InlineEditor';
import { RichEditor } from '@/components/editor/RichEditor';

function editable(container: HTMLElement) {
  const el = container.querySelector<HTMLElement>('.ProseMirror');
  if (!el) throw new Error('no editor');
  return el;
}

function paste(el: HTMLElement, data: Record<string, string>) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => data[type] ?? '' } });
  el.dispatchEvent(event);
}

describe('InlineEditor', () => {
  it('shows stored label HTML through the allowlist', () => {
    const { container } = render(<InlineEditor value={'<b>Hi</b><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>'} onChange={() => {}} placeholder="Label" />);
    expect(screen.getByText('Hi').tagName).toBe('STRONG');
    expect(container.querySelector('img, a')).toBeNull();
    expect(editable(container)).toHaveAttribute('aria-label', 'Label');
  });

  it('writes edits back as v1 HTML and calls onEnter on Enter', () => {
    const onChange = vi.fn();
    const onEnter = vi.fn();
    const { container } = render(<InlineEditor value="" onChange={onChange} onEnter={onEnter} placeholder="Type a question" />);
    expect(screen.getByText('Type a question')).toBeInTheDocument();
    paste(editable(container), { 'text/html': '<p><b onclick="alert(1)">Full</b> name<script>alert(1)</script></p>' });
    expect(onChange).toHaveBeenLastCalledWith('<b>Full</b> name');
    fireEvent.keyDown(editable(container), { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledOnce();
  });

  it('follows external changes such as undo', () => {
    const onChange = vi.fn();
    const { rerender } = render(<InlineEditor value="First" onChange={onChange} />);
    rerender(<InlineEditor value="<i>Second</i>" onChange={onChange} />);
    expect(screen.getByText('Second').tagName).toBe('EM');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('RichEditor', () => {
  it('keeps lists from a paste and stores them as v1 HTML', () => {
    const onChange = vi.fn();
    const { container } = render(<RichEditor value="Intro" onChange={onChange} />);
    paste(editable(container), { 'text/html': '<ul><li>a</li><li style="color:red">b</li></ul>' });
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining('<ul><li>a</li><li>b</li></ul>'));
  });
});
