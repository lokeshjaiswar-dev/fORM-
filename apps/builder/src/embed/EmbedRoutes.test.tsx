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

describe('EmbedRoutes dms-record', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('/embed/dms-record is the record page: with no launch it asks to start from DMS and never goes to the forms list', () => {
    window.history.replaceState(null, '', '/embed/dms-record');
    renderAt('/embed/dms-record');
    expect(screen.getByText(/Open this page from DMS/)).toBeTruthy();
    expect(screen.queryByText('forms list')).toBeNull();
    expect(screen.queryByText(/not available here yet/)).toBeNull();
  });
});
