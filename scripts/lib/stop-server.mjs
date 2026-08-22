/**
 * Stop a spawned server child and wait for it to actually exit.
 *
 * Calling `child.kill()` and then `process.exit()` immediately races the
 * child's teardown. On Windows that reliably trips a libuv assertion
 * (`!(handle->flags & UV_HANDLE_CLOSING)`), which aborts the process with exit
 * code 127 — potentially *after* every check has already passed, so a green
 * suite is reported as a failure and CI blames the wrong thing.
 *
 * Windows also has no real SIGTERM, so the polite kill is backed by a forced
 * one on a timer.
 *
 * Prefer setting `process.exitCode` over calling `process.exit()` in scripts
 * that use this, so Node closes its handles normally rather than being torn
 * down mid-teardown.
 */
export async function stopServer(child, forceAfterMs = 3_000) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  const forced = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, forceAfterMs);

  try {
    await exited;
  } finally {
    clearTimeout(forced);
  }
}
