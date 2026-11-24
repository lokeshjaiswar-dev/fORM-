// Stands in for classic's legacy RenderElement, the fallback target: shows the record it was handed.
import { forwardRef, useImperativeHandle } from 'react';

const RenderElement = forwardRef((props, ref) => {
  useImperativeHandle(ref, () => ({ validate: () => true, getData: () => props.recordData ?? {}, clearErrors: () => {} }), [props.recordData]);
  return <pre data-testid="legacy-renderer">{JSON.stringify(props.recordData ?? {})}</pre>;
});
export default RenderElement;
