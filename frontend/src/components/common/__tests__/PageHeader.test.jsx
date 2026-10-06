import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PageHeader from '../PageHeader.jsx';

describe('PageHeader', () => {
  it('renders the heading and keeps document.title in step, restoring it on unmount', () => {
    document.title = 'FinGuardAI';
    const { unmount, rerender } = render(<PageHeader title="Transactions" subtitle="All of them" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Transactions' })).toBeInTheDocument();
    expect(document.title).toBe('Transactions · FinGuardAI');
    rerender(<PageHeader title="Alerts" />);
    expect(document.title).toBe('Alerts · FinGuardAI');
    unmount();
    expect(document.title).toBe('FinGuardAI');
  });
});
