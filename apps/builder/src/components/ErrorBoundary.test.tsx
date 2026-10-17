import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from '@/components/ErrorBoundary';

function Boom(): never {
  throw new Error('bad regex');
}

describe('ErrorBoundary', () => {
  it('B12: shows a fallback instead of unmounting the app', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <>
        <p>Header still here</p>
        <ErrorBoundary label="preview">
          <Boom />
        </ErrorBoundary>
      </>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The preview hit an error');
    expect(screen.getByText('bad regex')).toBeInTheDocument();
    expect(screen.getByText('Header still here')).toBeInTheDocument();
  });
});
