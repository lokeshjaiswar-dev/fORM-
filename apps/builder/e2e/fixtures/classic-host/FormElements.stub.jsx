// Stands in for classic's legacy RenderElement, the fallback target: shows the record it was handed (EMPTY after a bridge failure).
import { forwardRef, useImperativeHandle } from 'react';

const RenderElement = forwardRef((props, ref) => {
  useImperativeHandle(ref, () => ({ validate: () => true, getData: () => props.recordData ?? {}, clearErrors: () => {}, clearForm: () => {} }), [props.recordData]);
  return <pre data-testid="legacy-renderer">{JSON.stringify(props.recordData ?? {})}</pre>;
});
export default RenderElement;
