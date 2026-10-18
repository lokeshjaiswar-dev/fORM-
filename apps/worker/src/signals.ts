export type ShutdownSignal = 'SIGTERM' | 'SIGINT';

interface SignalSource {
  on(event: ShutdownSignal, listener: () => void): unknown;
}

/**
 * The first SIGTERM or SIGINT runs `shutdown` once (finish or fail back running jobs, close pools); `exit(0)`
 * follows, or `exit(1)` when it throws. A second signal while that is in progress exits at once with 1.
 */
export function onShutdownSignal(
  shutdown: (signal: ShutdownSignal) => Promise<void>,
  o: { source?: SignalSource; exit?: (code: number) => void; onError?: (err: unknown) => void } = {},
): void {
  const source = o.source ?? process;
  const exit = o.exit ?? ((code: number) => process.exit(code));
  let stopping = false;
  const handle = (signal: ShutdownSignal) => {
    if (stopping) {
      exit(1);
      return;
    }
    stopping = true;
    shutdown(signal).then(
      () => exit(0),
      (err: unknown) => {
        o.onError?.(err);
        exit(1);
      },
    );
  };
  source.on('SIGTERM', () => handle('SIGTERM'));
  source.on('SIGINT', () => handle('SIGINT'));
}
