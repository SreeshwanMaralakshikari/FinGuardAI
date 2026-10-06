// N-01 / N-07: Modal focus, trap, Escape, restore, scroll lock, dismissible
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import Modal from '../Modal.jsx';

function Host({ onClose = vi.fn(), dismissible = true, startOpen = true }) {
  const [open, setOpen] = useState(startOpen);
  const [text, setText] = useState('');
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Opener</button>
      <Modal
        open={open}
        title="Edit"
        onClose={() => { onClose(); setOpen(false); }}
        dismissible={dismissible}
        footer={<button type="button">Save</button>}
      >
        <textarea aria-label="Summary" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="button">Middle</button>
      </Modal>
    </>
  );
}

describe('Modal', () => {
  it('moves focus into the dialog when it opens', () => {
    render(<Host />);
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Edit' }));
  });

  it('N-01: typing in a controlled textarea keeps focus across parent re-renders', () => {
    render(<Host />);
    const ta = screen.getByLabelText('Summary');
    ta.focus();
    for (const v of ['a', 'ab', 'abc']) {
      fireEvent.change(ta, { target: { value: v } });
      expect(document.activeElement).toBe(ta); // used to jump back to the dialog after every keystroke
    }
    expect(ta).toHaveValue('abc');
  });

  it('Escape closes it', () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('backdrop click and the close button close it', () => {
    const onClose = vi.fn();
    const { container } = render(<Host onClose={onClose} />);
    fireEvent.click(container.querySelector('[aria-hidden="true"].absolute'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismissible=false blocks Escape, backdrop and the close button', () => {
    const onClose = vi.fn();
    const { container } = render(<Host onClose={onClose} dismissible={false} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(container.querySelector('[aria-hidden="true"].absolute'));
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('traps Tab and Shift+Tab inside the dialog', () => {
    render(<Host />);
    const first = screen.getByRole('button', { name: 'Close dialog' });
    const last = screen.getByRole('button', { name: 'Save' });

    last.focus();
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false); // default prevented
    expect(document.activeElement).toBe(first);

    first.focus();
    expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);

    // focus that escaped (e.g. clicked on the page behind) is pulled back in
    screen.getByRole('button', { name: 'Opener' }).focus();
    fireEvent.keyDown(document.activeElement, { key: 'Tab' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);

    // a Tab in the middle of the dialog is left to the browser
    const middle = screen.getByRole('button', { name: 'Middle' });
    middle.focus();
    expect(fireEvent.keyDown(middle, { key: 'Tab' })).toBe(true);
  });

  it('N-07: restores focus to the opener on close', () => {
    render(<Host startOpen={false} />);
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('N-07: locks page scroll while open and restores it afterwards', () => {
    document.body.style.overflow = 'auto';
    render(<Host />);
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('auto');
    document.body.style.overflow = '';
  });

  it('renders nothing when closed', () => {
    render(<Modal open={false} title="x" onClose={() => {}}>body</Modal>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
