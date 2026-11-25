import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbedRoutes } from '@/embed/EmbedRoutes';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/embed/*" element={<EmbedRoutes />} />
        <Route path="/forms" element={<p>forms list</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('EmbedRoutes unknown paths', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('top level: an unknown /embed path goes to the forms list as before', () => {
    renderAt('/embed/dms-upload/x');
    expect(screen.getByText('forms list')).toBeTruthy();
  });

  it('framed: an unknown /embed path shows a notice and never the builder', () => {
    vi.stubGlobal('parent', {});
    renderAt('/embed/dms-upload/x');
    expect(screen.getByRole('alert').textContent).toMatch(/not available here/);
    expect(screen.queryByText('forms list')).toBeNull();
  });
});
