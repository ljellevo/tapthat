import { exec } from 'node:child_process';
import { scrub } from './log';

/**
 * Runs the project's own build check after the agent finishes. This is the
 * sidecar's job, not the agent's: the agent has no Bash by design, so it cannot
 * discover that a plausible-looking edit fails to compile. Without this the
 * reviewer is told "live" while looking at an error overlay.
 */
export function makeVerifier(command: string | null, cwd: string, timeoutMs = 120_000) {
  if (!command) return undefined;

  return function verify(): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolvePromise) => {
      exec(
        command,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          // The verify step never needs a credential.
          env: { ...process.env, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined },
        },
        (err, stdout, stderr) => {
          const output = scrub(`${stdout}${stderr}`.trim());
          resolvePromise(err ? { ok: false, output: output || err.message } : { ok: true, output });
        },
      );
    });
  };
}
