import { PROTOCOL, isInboundType, parseMessage, type InboundMessage, type OutboundType, type PayloadOf } from './protocol.ts';

/*
 * The child end of the wire. A message is acted on only when `event.source` is the parent window, `event.origin` is the
 * allowlisted parent origin and it passes the schema; everything else is dropped without an answer, so a page that
 * is not the parent learns nothing. Outgoing messages name the parent origin as targetOrigin, never `*`.
 */

export interface TransportOptions {
  /** This page's window (where `message` events arrive). */
  self: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** The window that framed this page. */
  parent: Pick<Window, 'postMessage'>;
  /** An allowlisted origin (origins.ts). */
  parentOrigin: string;
  onMessage: (message: InboundMessage) => void;
  /** Called for anything the transport drops after the origin check (wrong version, bad shape); for logs only. */
  onDropped?: (why: string) => void;
}

/** At most this many `unsupported_version` / `invalid_init` answers per page view: a flooding parent gets no amplification. */
const MAX_PROTOCOL_ERRORS = 3;

export class ChildTransport {
  private counter = 0;
  private errorsSent = 0;
  private listening = false;

  private readonly options: TransportOptions;

  constructor(options: TransportOptions) {
    this.options = options;
  }

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.options.self.addEventListener('message', this.handle);
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    this.options.self.removeEventListener('message', this.handle);
  }

  /** Sends one message to the parent and returns its id. */
  send<T extends OutboundType>(type: T, payload: PayloadOf<T>, replyTo?: string): string {
    this.counter += 1;
    const id = `c-${this.counter.toString(36)}`;
    this.options.parent.postMessage({ protocol: PROTOCOL, type, id, ...(replyTo === undefined ? {} : { replyTo }), payload }, this.options.parentOrigin);
    return id;
  }

  private protocolError(code: 'unsupported_version' | 'invalid_init', message: string): void {
    if (this.errorsSent >= MAX_PROTOCOL_ERRORS) return;
    this.errorsSent += 1;
    this.send('error', { code, message, fatal: true });
  }

  private readonly handle = (event: MessageEvent): void => {
    if (event.source !== this.options.parent || event.origin !== this.options.parentOrigin) return;
    const parsed = parseMessage(event.data);
    if (parsed.ok) {
      if (isInboundType(parsed.message.type)) this.options.onMessage(parsed.message as InboundMessage);
      return;
    }
    if (parsed.reason === 'foreign') return;
    this.options.onDropped?.(`${parsed.reason}${parsed.type ? ` ${parsed.type}` : ''}: ${parsed.detail ?? ''}`);
    if (parsed.reason === 'protocol') this.protocolError('unsupported_version', `This page speaks ${PROTOCOL}, not ${parsed.detail ?? 'another version'}`);
    else if (parsed.type === 'init') this.protocolError('invalid_init', parsed.detail ?? 'invalid init');
  };
}
