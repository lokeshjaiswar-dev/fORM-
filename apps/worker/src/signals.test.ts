import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { onShutdownSignal } from './signals.ts';

function setup(shutdown: () => Promise<void>) {
  const source = new EventEmitter();
  const exit = vi.fn<(code: number) => void>();
  const onError = vi.fn();
  const fn = vi.fn(shutdown);
  onShutdownSignal(fn, { source: source as never, exit, onError });
  return { source, exit, onError, shutdown: fn };
}

describe('onShutdownSignal', () => {
  it('shuts down once on SIGTERM, then exits 0', async () => {
    let finish!: () => void;
    const s = setup(() => new Promise<void>((r) => (finish = r)));
    s.source.emit('SIGTERM');
    expect(s.shutdown).toHaveBeenCalledWith('SIGTERM');
    expect(s.exit).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(s.exit).toHaveBeenCalledWith(0));
    expect(s.shutdown).toHaveBeenCalledTimes(1);
  });

  it('exits 1 at once on a second signal during shutdown', () => {
    const s = setup(() => new Promise<void>(() => {}));
    s.source.emit('SIGINT');
    s.source.emit('SIGTERM');
    expect(s.shutdown).toHaveBeenCalledTimes(1);
    expect(s.exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 and reports when shutdown fails', async () => {
    const s = setup(() => Promise.reject(new Error('pool busy')));
    s.source.emit('SIGTERM');
    await vi.waitFor(() => expect(s.exit).toHaveBeenCalledWith(1));
    expect(s.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'pool busy' }));
  });
});
