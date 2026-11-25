import raw from './__fixtures__/fp-bridge-v1.fixtures.json' with { type: 'json' };
import type { BridgeMessage, InitPayload } from './protocol.ts';

/* The contract fixtures (a byte-identical copy of contract/fp-bridge-v1.fixtures.json), typed for the tests. */

interface Case {
  name: string;
  init: string;
  userInput: Record<string, string>;
  validate: BridgeMessage;
  expectedChange?: BridgeMessage;
  expectedValidated: Extract<BridgeMessage, { type: 'validated' }>;
  expectedRecord?: Record<string, string>;
  expectedRecordEdit?: Record<string, string>;
}

export const fixtures = raw as unknown as {
  handshake: BridgeMessage[];
  optionsExchange: BridgeMessage[];
  cases: Case[];
  unsupported: { init: Extract<BridgeMessage, { type: 'init' }>; expectedInitialized: BridgeMessage };
  mustBeRejected: Array<{ why: string; message: unknown }>;
  lookup: {
    $comment: string;
    childUrlCaps: string;
    pickerElement: Record<string, unknown> & { id: string; fp_lookup: { v: 1; id: string; master_id: string; label_field_id: string; fill: Array<{ from: string; to: string }>; min_chars: number } };
    sourceMasterElements: Array<Record<string, unknown> & { id: string; name: string; is_secret?: boolean; is_hidden?: boolean }>;
    masterRecordsResponse: { data: { records: Array<{ id: string; json_data: string | Record<string, unknown> }>; total: number } };
    exchange: [Extract<BridgeMessage, { type: 'lookup.request' }>, Extract<BridgeMessage, { type: 'lookup.result' }>];
    mustBeRejected: Array<{ why: string; message: unknown }>;
  };
};

export const handshakeInit = fixtures.handshake[1] as Extract<BridgeMessage, { type: 'init' }>;
export const initPayload = (): InitPayload => structuredClone(handshakeInit.payload);

/** The parent's answer to the master dropdown's `options.request` in the fixtures. */
export const categoryOptions = (fixtures.optionsExchange[1] as Extract<BridgeMessage, { type: 'options.result' }>).payload.options;
