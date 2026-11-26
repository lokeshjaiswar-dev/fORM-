// Stands in for classic's legacy RenderElement, the fallback target: shows the record it was handed (EMPTY after a create-mode bridge failure, DMS's stored masked record after an edit-mode one) and returns it as an untouched form's data.
import { forwardRef, useImperativeHandle } from 'react';

const RenderElement = forwardRef((props, ref) => {
  useImperativeHandle(ref, () => ({ validate: () => true, getData: () => props.recordData ?? {}, clearErrors: () => {}, clearForm: () => {} }), [props.recordData]);
  return <pre data-testid="legacy-renderer">{JSON.stringify(props.recordData ?? {})}</pre>;
});
export default RenderElement;
