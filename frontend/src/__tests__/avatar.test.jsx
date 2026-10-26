// Avatar: initials instead of a broken image when the picture cannot load (offline demo: pictures are on Cloudinary).
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Avatar from '../components/common/Avatar.jsx';

describe('Avatar', () => {
  it('shows the picture, falls back to initials when it fails, and tries a new picture again', () => {
    const { container, rerender } = render(<Avatar src="https://res.cloudinary.com/x/a.jpg" name="Meera Nair" alt="Profile" className="h-9 w-9" textClassName="text-sm" />);
    const img = screen.getByRole('img', { name: 'Profile' });
    expect(img).toHaveAttribute('src', 'https://res.cloudinary.com/x/a.jpg');

    fireEvent.error(img);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container).toHaveTextContent('MN');

    rerender(<Avatar src="blob:new-pick" name="Meera Nair" alt="Profile" className="h-9 w-9" textClassName="text-sm" />);
    expect(screen.getByRole('img', { name: 'Profile' })).toHaveAttribute('src', 'blob:new-pick');
  });

  it('shows initials when there is no picture', () => {
    const { container } = render(<Avatar src={null} name="Karan Singh" className="h-9 w-9" textClassName="text-sm" />);
    expect(container).toHaveTextContent('KS');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
