import type { EditionConfig, KmsConfig, StorageConfig } from '@form/config';
import type { EgressGuard } from '@form/ports';
import { createEgressGuard, DEFAULT_PORTS, type EgressResolver } from './guard.ts';

/** `host:port` of a configured URL (its explicit port or the scheme's), so the trust covers that port only. */
const hostOf = (url: string | undefined): string[] => {
  if (!url) return [];
  try {
    const u = new URL(url);
    const port = u.port === '' ? DEFAULT_PORTS[u.protocol] : Number(u.port);
    return port === undefined ? [] : [`${u.hostname.toLowerCase()}:${port}`];
  } catch {
    return [];
  }
};

/**
 * The endpoints (`host:port`) the operator configured for the KMS, the object store and other infrastructure URLs
 * (SMTP, SIEM). A trusted entry holds only for that port.
 */
export function infrastructureHosts(o: { kms?: KmsConfig | undefined; storage?: StorageConfig | undefined; urls?: readonly (string | undefined)[] }): string[] {
  const hosts: string[] = [];
  const k = o.kms;
  if (k?.driver === 'aws') hosts.push(...(k.endpoint ? hostOf(k.endpoint) : [`kms.${k.region}.amazonaws.com:443`]));
  if (k?.driver === 'gcp') hosts.push(...(k.endpoint ? hostOf(k.endpoint) : ['cloudkms.googleapis.com:443']), 'oauth2.googleapis.com:443');
  if (k?.driver === 'azure') hosts.push(...hostOf(k.keyUrl), ...hostOf(k.authorityUrl ?? 'https://login.microsoftonline.com'));
  if (k?.driver === 'vault') hosts.push(...hostOf(k.address));
  const s = o.storage;
  if (s?.driver === 's3') {
    if (s.endpoint) hosts.push(...hostOf(s.endpoint));
    else hosts.push(`s3.${s.region}.amazonaws.com:443`, ...Object.values(s.buckets).map((b) => `${b}.s3.${s.region}.amazonaws.com:443`));
  }
  for (const u of o.urls ?? []) hosts.push(...hostOf(u));
  return [...new Set(hosts)];
}

/**
 * The guard for operator-configured infrastructure (KMS, object store, SMTP relay, SIEM): EGRESS_POLICY and its
 * allowlist apply, and the configured hosts are trusted endpoints, so a VPC endpoint or an in-cluster store works under
 * `open` while `none` still refuses any of them that resolves to a public address. Tenant-supplied destinations
 * (webhooks, per-org SMTP, integrations) use a guard without trusted hosts.
 */
export function createInfrastructureEgressGuard(edition: Pick<EditionConfig, 'egressPolicy' | 'egressAllowlist'>, hosts: readonly string[], resolve?: EgressResolver): EgressGuard {
  return createEgressGuard({ policy: edition.egressPolicy, allowlist: edition.egressAllowlist, trusted: hosts, ...(resolve ? { resolve } : {}) });
}

/** The guard for tenant-supplied destinations: EGRESS_POLICY and EGRESS_ALLOWLIST only. */
export function createTenantEgressGuard(edition: Pick<EditionConfig, 'egressPolicy' | 'egressAllowlist'>, resolve?: EgressResolver): EgressGuard {
  return createEgressGuard({ policy: edition.egressPolicy, allowlist: edition.egressAllowlist, ...(resolve ? { resolve } : {}) });
}
