import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BuilderDnd } from '@/components/builder/BuilderDnd';
import { FormCanvas } from '@/components/builder/FormCanvas';

/** The canvas as the builder mounts it: drag-and-drop context, the edit route. */
export function renderCanvas() {
  return render(
    <MemoryRouter initialEntries={['/builder/test']}>
      <Routes>
        <Route
          path="/builder/:id/preview?"
          element={
            <BuilderDnd>
              <FormCanvas />
            </BuilderDnd>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}
