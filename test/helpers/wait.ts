/**
 * Waiting in tests. Server responses arrive after scheduling ticks and worker messages whose timing
 * varies with machine load, so tests never assert after a fixed sleep: they poll for the response.
 */

/** Wait until `done()` holds (5 ms polls); fail naming `what` after `ms`. */
export async function until(what: string, done: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(5);
  }
}

/**
 * A short pause before asserting that something has *not* happened (a request still waiting):
 * load can only make such a check pass for longer, never flake it.
 */
export function pause(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
