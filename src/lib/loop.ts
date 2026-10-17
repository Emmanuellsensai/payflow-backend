export interface Loop {
  /** Stop scheduling passes. Resolves once the pass in flight, if any, has finished. */
  stop(): Promise<void>;
}

/**
 * Run `pass` now and then `intervalMs` after each pass finishes.
 *
 * Unlike `setInterval`, a slow pass delays the next one instead of running
 * alongside it. `pass` should handle its own errors; a rejection is swallowed
 * so the loop keeps going.
 */
export function every(intervalMs: number, pass: () => Promise<void>): Loop {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let current: Promise<void> = Promise.resolve();

  const run = async (): Promise<void> => {
    try {
      await pass();
    } catch {
      // The pass logs its own failures.
    }
    if (!stopped) timer = setTimeout(() => void (current = run()), intervalMs);
  };

  current = run();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      return current;
    },
  };
}

/**
 * Stop every loop and wait for the passes in flight, giving up after
 * `timeoutMs` so a stuck RPC call cannot block shutdown forever.
 */
export async function drain(loops: Loop[], timeoutMs: number): Promise<"drained" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const drained = Promise.all(loops.map((loop) => loop.stop())).then(() => "drained" as const);
  try {
    return await Promise.race([drained, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
