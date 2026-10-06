// Sidebar mobile drawer: dialog semantics, Escape, focus management (N-15)
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Sidebar from '../Sidebar.jsx';
import { CUSTOMER_NAV } from '../../../utils/navigation.js';

function Host({ onNavigate = vi.fn() }) {
  const [open, setOpen] = useState(false);
  return (
    <MemoryRouter>
      <button type="button" onClick={() => setOpen(true)}>Open menu</button>
      <Sidebar navItems={CUSTOMER_NAV} open={open} onClose={() => { onNavigate(); setOpen(false); }} />
    </MemoryRouter>
  );
}

describe('Sidebar mobile drawer', () => {
  it('is not rendered while closed (only the desktop nav exists)', () => {
    render(<Host />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens as a modal dialog, moves focus in and locks scroll', () => {
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Open menu' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Navigation menu' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.activeElement).toBe(dialog);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('Escape closes it, unlocks scroll and returns focus to the opener', () => {
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Open menu' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).not.toBe('hidden');
    expect(document.activeElement).toBe(opener);
  });

  it('the close button and a navigation click close it; Tab stays inside', () => {
    const onNavigate = vi.fn();
    render(<Host onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Close menu' });
    close.focus();
    expect(fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })).toBe(false); // wraps to the last link
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getAllByRole('link', { name: 'Transactions' }).at(-1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onNavigate).toHaveBeenCalled();
  });
});
