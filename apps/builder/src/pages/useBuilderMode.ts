import { useCallback } from 'react';
import { useMatch, useNavigate, useParams } from 'react-router-dom';
import type { BuilderMode } from '@/types/form';

export const builderPath = (id: string, mode: BuilderMode = 'edit') =>
  `/builder/${encodeURIComponent(id)}${mode === 'preview' ? '/preview' : ''}`;

/**
 * Edit or preview, read from the URL and changed by navigating, so the mode and the address bar never disagree and
 * Back and Forward switch modes (B23).
 */
export function useBuilderMode(): [BuilderMode, (mode: BuilderMode) => void] {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const mode: BuilderMode = useMatch('/builder/:id/preview') ? 'preview' : 'edit';
  const setMode = useCallback(
    (next: BuilderMode) => {
      if (next !== mode) navigate(builderPath(id, next));
    },
    [id, mode, navigate],
  );
  return [mode, setMode];
}
