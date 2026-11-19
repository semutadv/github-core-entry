// Entry lifecycle: bind the forge, tell the harness where it listens, then
// wait until the harness declares the trial finished.
//
// The harness (make.fun env) owns the conversation. This process only does
// three things, in order:
//   1. Start the forge on a kernel-chosen port and report that port.
//   2. Keep asking until the harness accepts the registration.
//   3. Keep polling until the harness says the trial is done, then stop.
//
// Nothing here scores anything and nothing here exits early: while the env
// is still running, this process stays alive and keeps retrying.

import { createApp } from './app.ts';

// Where the harness lives, e.g. http://store:8080 inside a trial container.
// Trailing slashes are stripped so URL building below stays predictable.
const harnessOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (harnessOrigin === '') {
  process.stderr.write('no MAKEFUN_ENV_URL set — cannot reach the harness, giving up\n');
  process.exit(1);
}

// One request to the harness may take at most this long before we give up
// on that attempt and try again.
const REQUEST_LIMIT_MS = 30_000;

// Pause between attempts: start short, double each time, never exceed the cap.
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

/**
 * Run `work` over and over until it reports success. Each attempt gets a
 * number starting at 0; the pause after a failed attempt grows
 * exponentially (250, 500, 1000, 2000, 2000, ...) so a harness that is
 * still booting is not hammered, while a harness that is up is reached
 * quickly. `work` returns true when finished, false to try again, and may
 * throw to abort the whole process (used for answers that mean "you are
 * talking to the wrong endpoint").
 */
async function keepTrying(work: (attempt: number) => Promise<boolean>): Promise<void> {
  let attempt = 0;
  for (;;) {
    if (await work(attempt)) return;
    const waitFor = Math.min(LONGEST_PAUSE_MS, FIRST_PAUSE_MS * 2 ** attempt);
    attempt += 1;
    await pause(waitFor);
  }
}

/** Tell the harness which port the forge bound. Returns true once accepted. */
async function announcePort(port: number): Promise<boolean> {
  let reply: Response;
  try {
    reply = await fetch(`${harnessOrigin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
    });
  } catch {
    // Harness unreachable or too slow: it may still be starting, retry.
    return false;
  }
  if (reply.status === 200 || reply.status === 409) return true;
  if (reply.status === 400 || reply.status === 405) {
    // The harness understood us and refused the shape of the request:
    // retrying the same request cannot fix that, so stop loudly.
    throw new Error(`harness rejected registration with HTTP ${reply.status}: ${await reply.text()}`);
  }
  return false;
}

/** Ask the harness whether the trial is over. Returns true only on {"done": true}. */
async function trialFinished(): Promise<boolean> {
  let reply: Response;
  try {
    reply = await fetch(`${harnessOrigin}/done`, {
      signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
    });
  } catch {
    return false;
  }
  if (!reply.ok) return false;
  const payload = (await reply.json()) as { done?: unknown };
  return payload.done === true;
}

/** Bind, register, wait for the harness to finish, then shut down. */
async function run(): Promise<void> {
  const forge = createApp();
  await new Promise<void>((resolve, reject) => {
    forge.once('error', reject);
    // Port 0 lets the kernel pick a free port. 8080 belongs to the harness
    // and must never be bound here.
    forge.listen(0, () => resolve());
  });

  const bound = forge.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('forge did not bind a TCP port');
  }
  process.stdout.write(`forge listening on ${bound.port}\n`);

  await keepTrying(() => announcePort(bound.port));
  process.stdout.write('registered with harness, waiting for trial to finish\n');

  await keepTrying(() => trialFinished());

  forge.close();
  process.stdout.write('trial done, shutting down\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`entry failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
