// The classic step 2 as the browser sees it: the real FormPlusHost mounted with the contract's document-form-builders response,
// logging every message it posts to the fORM- child and every message the child sends back (on the MessagePort).
import { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import fixtures from '../../../src/embed/bridge/__fixtures__/fp-bridge-v1.fixtures.json';
import FormPlusHost from '@classic-formplus/FormPlusHost';
import { buildInitMessage, formatDmsDate, splitForBridge } from '@classic-formplus/legacyRecord';

const params = new URLSearchParams(location.search);
const edit = params.get('edit') === '1';
const secretName = params.get('secret'); // a field NAME to flag as a stored secret (edit mode)

const base = fixtures.documentFormBuildersResponse.data;
const elements = base.map((e) => (e.value === secretName ? { ...e, is_secret: true, required: false } : e));
// classic holds the master's current record keyed by field NAME; the contract gives it keyed by id.
const nameOf = Object.fromEntries(elements.map((e) => [e.id, e.value]));
const recordData = Object.fromEntries(Object.entries(fixtures.handshake[1].payload.values).map(([id, v]) => [nameOf[id], v]));
if (secretName) {
  recordData[secretName] = '••••••';
  recordData[`${secretName}__masked`] = true;
}

window.fpSent = []; // what the parent posts on the port (the init, collect, answers)
window.fpIn = []; // what the child sends on the port
window.fpWarnings = [];
const warn = console.warn.bind(console);
console.warn = (...args) => {
  window.fpWarnings.push(args.map(String).join(' '));
  warn(...args);
};
const post = MessagePort.prototype.postMessage;
MessagePort.prototype.postMessage = function (message, ...rest) {
  // React's scheduler posts `null` on its own channel; only objects of the bridge matter here.
  if (message && typeof message === 'object') window.fpSent.push(message);
  return post.call(this, message, ...rest);
};
const onmessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
Object.defineProperty(MessagePort.prototype, 'onmessage', {
  ...onmessage,
  set(fn) {
    onmessage.set.call(this, fn && ((event) => (window.fpIn.push(event.data), fn.call(this, event))));
  },
});
// One channel per mount: the host creates exactly one MessageChannel (a second hello or port is never served).
window.fpChannels = 0;
const Channel = window.MessageChannel;
window.MessageChannel = function MessageChannelCounter() {
  window.fpChannels += 1;
  return new Channel();
};

const split = splitForBridge(elements);
// The init classic builds from the document-form-builders response (the dialog id is the host's own, random per mount).
window.fpExpectedInit = (dialogId) => split && buildInitMessage({ dialogId, ...split, recordData, isEdit: edit, today: formatDmsDate(new Date()) });

const handle = createRef();
window.fpHost = { collect: () => handle.current.collect() };
createRoot(document.getElementById('root')).render(
  <FormPlusHost ref={handle} element={elements} recordData={recordData} isEdit={edit} masterId="m-1" title="upload" />,
);
