/** The parts of a WHATWG `URL` the guard needs; a `URL` instance satisfies it. */
export interface EgressTarget {
  readonly href: string;
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
}

/**
 * SSRF and air-gap guard for every outbound call (webhooks, integrations, SMTP, KMS). Resolves DNS once
 * and returns the address the caller must connect to, so a rebinding answer cannot redirect the request.
 * A denied target → PortError('egress_denied').
 */
export interface EgressGuard {
  assertAllowed(url: EgressTarget): Promise<{ pinnedIp: string }>;
}
