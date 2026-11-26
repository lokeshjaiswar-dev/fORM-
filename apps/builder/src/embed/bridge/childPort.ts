import { PROTOCOL_V2, parseParentMessage, parseV2, stampChild, type ChildBody, type ParentMessage } from './protocolV2.ts';

/*
 * The child end of fp-bridge/2 (SEC-DESIGN 3.4). The page runs in an opaque origin (sandbox without allow-same-origin), so
 * it cannot know its parent's origin from its own URL and talks in two steps:
 *
 *   1. `hello` to window.parent with target '*'. It is empty: no value, no token, no field.
 *   2. The parent answers `{type:'port', dialogId}` with one MessagePort. It is taken only when `event.source` is
 *      window.parent AND `event.origin` is one of the allowlisted parents (`VITE_FP_EMBED_PARENTS`; an EMPTY allowlist denies
 *      everybody) AND exactly one port came along, and only the FIRST such message is ever taken. Everything after that
 *      travels on the port, which only the holder of the other end can write to; the window listener is gone.
 *
 * Anything else is dropped without an answer, so a page that is not the parent learns nothing from this one.
 */

export interface ChildPortOptions {
  /** This page's window (where `message` events arrive). */
  self: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** The window that framed this page. */
  parent: Pick<Window, 'postMessage'>;
  /** Origins that may hand over the port. Empty = deny. */
  allowedParents: readonly string[];
  /** The port was accepted; `dialogId` is the parent's channel id for this mount. */
  onPort: (dialogId: string) => void;
  /** A schema-valid parent -> child message from the port. */
  onMessage: (message: ParentMessage) => void;
  /** Called for anything dropped after the origin check (bad shape, wrong direction); for logs only. */
  onDropped?: (why: string) => void;
}

export class ChildPort {
  private port: MessagePort | null = null;
  private dialog: string | null = null;
  private listening = false;
  private readonly options: ChildPortOptions;

  constructor(options: ChildPortOptions) {
    this.options = options;
  }

  get dialogId(): string | null {
    return this.dialog;
  }

  get connected(): boolean {
    return this.port !== null;
  }

  /**
   * Listens for the port and says `hello`. With an empty allowlist nothing is listened to and nothing is sent (returns false):
   * there is no parent this page would accept.
   */
  start(): boolean {
    if (this.listening || this.port) return true;
    if (this.options.allowedParents.length === 0) {
      this.options.onDropped?.('no parent origin is allowed (VITE_FP_EMBED_PARENTS is empty)');
      return false;
    }
    this.listening = true;
    this.options.self.addEventListener('message', this.handleWindow);
    this.options.parent.postMessage({ protocol: PROTOCOL_V2, type: 'hello' }, '*');
    return true;
  }

  stop(): void {
    this.unlisten();
    if (this.port) {
      this.port.onmessage = null;
      this.port.close();
      this.port = null;
    }
    this.dialog = null;
  }

  /** Sends one child message on the port (schema-checked, `protocol` stamped). False when there is no port yet. */
  send(body: ChildBody): boolean {
    if (!this.port) return false;
    this.port.postMessage(stampChild(body));
    return true;
  }

  private unlisten(): void {
    if (!this.listening) return;
    this.listening = false;
    this.options.self.removeEventListener('message', this.handleWindow);
  }

  private readonly handleWindow = (event: MessageEvent): void => {
    if (this.port) return;
    if (event.source !== this.options.parent || !this.options.allowedParents.includes(event.origin)) return;
    const parsed = parseV2(event.data);
    if (!parsed.ok || parsed.message.type !== 'port') {
      if (parsed.ok || parsed.reason !== 'foreign') this.options.onDropped?.(`window message is not a port handover: ${parsed.ok ? parsed.message.type : `${parsed.reason} ${parsed.detail ?? ''}`}`);
      return;
    }
    const ports = event.ports as readonly MessagePort[] | undefined;
    const port = ports?.length === 1 ? ports[0] : undefined;
    if (!port) {
      this.options.onDropped?.('port handover without exactly one port');
      return;
    }
    this.port = port;
    this.dialog = parsed.message.dialogId;
    this.unlisten();
    port.onmessage = this.handlePort;
    port.start();
    this.options.onPort(parsed.message.dialogId);
  };

  private readonly handlePort = (event: MessageEvent): void => {
    const parsed = parseParentMessage(event.data);
    if (parsed.ok) return this.options.onMessage(parsed.message);
    if (parsed.reason !== 'foreign') this.options.onDropped?.(`port message dropped: ${parsed.reason}`);
  };
}
