/**
 * The sidecar accepts instructions that modify a repository. In production that
 * is a remote-code-execution primitive, so booting is opt-in and the opt-in is
 * env-only — it cannot be turned on by a committed config file.
 */

/** sysexits.h EX_CONFIG: the process is correctly installed but misconfigured. */
const EX_CONFIG = 78;

export class GuardError extends Error {}

export function checkNotProduction(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV === 'production') {
    return [
      'Refusing to start: NODE_ENV=production.',
      '',
      'The TapThat sidecar runs a coding agent against your working tree. It is a',
      'development tool and must never run in a production environment. There is no',
      'flag that overrides this check.',
    ].join('\n');
  }

  if (env.TAPTHAT_ENABLE !== '1') {
    return [
      'Refusing to start: TAPTHAT_ENABLE is not set to 1.',
      '',
      'This is a deliberate safety latch — the sidecar modifies your repository, so',
      'starting it has to be an explicit act rather than something a stray config file',
      'can do.',
      '',
      'To start it:  TAPTHAT_ENABLE=1 npx tapthat-sidecar',
    ].join('\n');
  }

  return null;
}

/** Exits the process when the guard fails. Used by the CLI, not by tests. */
export function assertNotProduction(env: NodeJS.ProcessEnv = process.env): void {
  const problem = checkNotProduction(env);
  if (problem) {
    console.error(problem);
    process.exit(EX_CONFIG);
  }
}
