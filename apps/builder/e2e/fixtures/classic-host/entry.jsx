// The classic step 2 as the browser sees it: the real FormPlusHost mounted with the contract's
// document-form-builders response, logging every message the fORM- child sends.
import { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import fixtures from '../../../src/embed/bridge/__fixtures__/fp-bridge-v1.fixtures.json';
import FormPlusHost from '@classic-formplus/FormPlusHost';
import { buildInitPayload, formatDmsDate, splitForBridge } from '@classic-formplus/legacyRecord';

const elements = fixtures.documentFormBuildersResponse.data;
// classic holds the master's current record keyed by field NAME; the contract gives it keyed by id.
const nameOf = Object.fromEntries(elements.map((e) => [e.id, e.value]));
const recordData = Object.fromEntries(Object.entries(fixtures.handshake[1].payload.values).map(([id, v]) => [nameOf[id], v]));

window.fpLog = [];
window.fpWarnings = [];
const warn = console.warn.bind(console);
console.warn = (...args) => {
  window.fpWarnings.push(args.map(String).join(' '));
  warn(...args);
};
window.addEventListener('message', (event) => {
  if (event.source !== window && event.data && event.data.protocol === 'fp-bridge/1') window.fpLog.push(event.data);
});

const split = splitForBridge(elements);
window.fpExpectedInit = split && buildInitPayload({ ...split, recordData, isEdit: false, today: formatDmsDate(new Date()) });

const handle = createRef();
window.fpHost = {
  validate: () => handle.current.validate(),
  getData: () => handle.current.getData(),
};
createRoot(document.getElementById('root')).render(
  <FormPlusHost ref={handle} element={elements} recordData={recordData} isEdit={false} masterId="m-1" title="upload" />,
);
