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
};

export const handshakeInit = fixtures.handshake[1] as Extract<BridgeMessage, { type: 'init' }>;
export const initPayload = (): InitPayload => structuredClone(handshakeInit.payload);

/** The parent's answer to the master dropdown's `options.request` in the fixtures. */
export const categoryOptions = (fixtures.optionsExchange[1] as Extract<BridgeMessage, { type: 'options.result' }>).payload.options;
