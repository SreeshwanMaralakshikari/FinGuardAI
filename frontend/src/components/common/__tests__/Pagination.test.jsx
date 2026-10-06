// N-19: Pagination range clamp and "page beyond the last page" recovery
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Pagination from '../Pagination.jsx';

describe('Pagination', () => {
  it('renders nothing without rows', () => {
    const { container } = render(<Pagination page={1} limit={10} total={0} onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the range and moves between pages', () => {
    const onChange = vi.fn();
    render(<Pagination page={2} limit={10} total={25} onChange={onChange} />);
    expect(screen.getByText('11–20')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onChange.mock.calls).toEqual([[3], [1]]);
  });

  it('the last partial page ends at the total', () => {
    render(<Pagination page={3} limit={10} total={25} onChange={() => {}} />);
    expect(screen.getByText('21–25')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('disables Previous on page 1', () => {
    render(<Pagination page={1} limit={10} total={25} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  it('page beyond the last page: clamped display and the owner is sent to the last page', () => {
    const onChange = vi.fn();
    render(<Pagination page={3} limit={10} total={15} onChange={onChange} />);
    expect(screen.queryByText(/21–15/)).toBeNull(); // used to print "Showing 21–15 of 15"
    expect(screen.getByText('11–15')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it('does not call onChange when the page is in range', () => {
    const onChange = vi.fn();
    render(<Pagination page={2} limit={10} total={15} onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });
});
