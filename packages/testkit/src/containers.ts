import { randomBytes } from 'node:crypto';
import type { StartedTestContainer } from 'testcontainers';

const tc = () => import('testcontainers');

/**
 * The adapter contract containers of `pnpm test:int` (architecture §1.4), pinned by version and digest like the dev
 * stack (`deploy/docker/compose.dev.yaml`); Mailpit is `startMailpit` in smtp-sink.ts. Each gets random host ports.
 */
export const SEAWEEDFS_IMAGE = 'chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d';
export const CLAMAV_IMAGE = 'clamav/clamav:1.5.3@sha256:d06c1d6a451d616e1dd79b42f44c8c8c291bba9cf4e75ebc4d0e43c1c6dd87bb';
/** Vault in dev mode (in-memory, unsealed, a fixed root token): transit only, CI and tests only. */
export const VAULT_IMAGE = 'hashicorp/vault:1.21.4@sha256:4e33b126a59c0c333b76fb4e894722462659a6bec7c48c9ee8cea56fccfd2569';

export interface Started {
  stop(): Promise<void>;
}

const stopper = (c: StartedTestContainer) => async () => {
  await c.stop();
};

export interface SeaweedFs extends Started {
  /** S3 API endpoint, path-style. */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * SeaweedFS (Apache-2.0, ADR-0002 §5) with S3 authentication on, so presigned URLs and policies are really checked.
 * Override with FORM_TEST_S3_ENDPOINT, FORM_TEST_S3_ACCESS_KEY_ID and FORM_TEST_S3_SECRET_ACCESS_KEY to use a running store.
 */
export async function startSeaweedFs(): Promise<SeaweedFs> {
  const external = process.env.FORM_TEST_S3_ENDPOINT;
  if (external) {
    return {
      endpoint: external,
      accessKeyId: process.env.FORM_TEST_S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.FORM_TEST_S3_SECRET_ACCESS_KEY ?? '',
      stop: async () => {},
    };
  }
  const accessKeyId = `fr${randomBytes(8).toString('hex')}`;
  const secretAccessKey = randomBytes(24).toString('base64url');
  const config = { identities: [{ name: 'form', credentials: [{ accessKey: accessKeyId, secretKey: secretAccessKey }], actions: ['Admin', 'Read', 'List', 'Tagging', 'Write'] }] };
  const { GenericContainer, Wait } = await tc();
  const c = await new GenericContainer(SEAWEEDFS_IMAGE)
    .withCopyContentToContainer([{ content: JSON.stringify(config), target: '/etc/seaweedfs/s3.json' }])
    .withCommand(['server', '-s3', '-s3.config=/etc/seaweedfs/s3.json', '-dir=/data', '-master.volumeSizeLimitMB=32', '-volume.max=0'])
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forHttp('/healthz', 8333).forStatusCodeMatching((s) => s < 500))
    .withStartupTimeout(120_000)
    .start();
  return { endpoint: `http://${c.getHost()}:${c.getMappedPort(8333)}`, accessKeyId, secretAccessKey, stop: stopper(c) };
}

export interface Vault extends Started {
  address: string;
  token: string;
  /** Mounts transit (once) and creates a key of `type`. */
  transitKey(name: string, type?: 'aes256-gcm96' | 'ecdsa-p256'): Promise<void>;
}

export async function startVault(): Promise<Vault> {
  const token = randomBytes(16).toString('hex');
  const { GenericContainer, Wait } = await tc();
  const c = await new GenericContainer(VAULT_IMAGE)
    .withEnvironment({ VAULT_DEV_ROOT_TOKEN_ID: token, VAULT_DEV_LISTEN_ADDRESS: '0.0.0.0:8200', SKIP_SETCAP: '1' })
    .withCommand(['server', '-dev'])
    .withExposedPorts(8200)
    .withWaitStrategy(Wait.forHttp('/v1/sys/health', 8200))
    .start();
  const address = `http://${c.getHost()}:${c.getMappedPort(8200)}`;
  const call = async (path: string, body: unknown) => {
    const res = await fetch(`${address}/v1/${path}`, { method: 'POST', headers: { 'x-vault-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok && res.status !== 204) throw new Error(`vault ${path}: ${res.status} ${await res.text()}`);
  };
  let mounted: Promise<void> | undefined;
  return {
    address,
    token,
    async transitKey(name, type = 'aes256-gcm96') {
      await (mounted ??= call('sys/mounts/transit', { type: 'transit' }));
      await call(`transit/keys/${name}`, { type });
    },
    stop: stopper(c),
  };
}

export interface ClamAv extends Started {
  host: string;
  port: number;
}

/**
 * ClamAV's official image downloads and loads the full signature set on start (a few minutes, several hundred MB),
 * so the real-engine contract is opt-in: FORM_TEST_CLAMAV=1 (.github/workflows/av-contract.yml, job `clamav`, weekly).
 * Every run uses the fake clamd.
 */
export const clamAvEnabled = (): boolean => process.env.FORM_TEST_CLAMAV === '1' || process.env.FORM_TEST_CLAMAV_HOST !== undefined;

export async function startClamAv(): Promise<ClamAv> {
  const external = process.env.FORM_TEST_CLAMAV_HOST;
  if (external) {
    const [host = 'localhost', port = '3310'] = external.split(':');
    return { host, port: Number(port), stop: async () => {} };
  }
  const { GenericContainer, Wait } = await tc();
  const c = await new GenericContainer(CLAMAV_IMAGE)
    .withExposedPorts(3310)
    .withWaitStrategy(Wait.forLogMessage(/socket found, clamd started|clamd started/i))
    .withStartupTimeout(600_000)
    .start();
  return { host: c.getHost(), port: c.getMappedPort(3310), stop: stopper(c) };
}
