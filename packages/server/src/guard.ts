/**
 * The sidecar accepts instructions that modify a repository. In production that
 * is a remote-code-execution primitive, so booting is opt-in and the opt-in is
 * env-only — it cannot be turned on by a committed config file.
 */

/** sysexits.h EX_CONFIG: the process is correctly installed but misconfigured. */
const EX_CONFIG = 78;

export class GuardError extends Error {}

/** Best-effort host detection, used only to make error messages actionable. */
export function detectPlatform(env: NodeJS.ProcessEnv): string | null {
  if (env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID) return 'Railway';
  if (env.FLY_APP_NAME) return 'Fly.io';
  if (env.RENDER) return 'Render';
  if (env.VERCEL) return 'Vercel';
  if (env.HEROKU_APP_ID || env.DYNO) return 'Heroku';
  return null;
}

export function checkNotProduction(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV === 'production') {
    const lines = [
      'Refusing to start: NODE_ENV=production.',
      '',
      'The TapThat sidecar runs a coding agent against your working tree. It is a',
      'development tool and must never run in a production environment. There is no',
      'flag that overrides this check.',
    ];

    // Several PaaS builders set NODE_ENV=production for Node services by default,
    // so on those hosts this fires on the very first deploy and looks like a bug
    // rather than the guard doing its job. Name the fix rather than making them
    // guess that the platform, not their config, set it.
    if (detectPlatform(env)) {
      lines.push(
        '',
        `${detectPlatform(env)} sets NODE_ENV=production by default for Node services.`,
        'If this really is a dev environment, set NODE_ENV=development on the service.',
      );
    }
    return lines.join('\n');
  }

  if (env.TAPTHAT_ENABLE !== '1') {
    return [
      'Refusing to start: TAPTHAT_ENABLE is not set to 1.',
      '',
      'This is a deliberate safety latch — the sidecar modifies your repository, so',
      'starting it has to be an explicit act rather than something a stray config file',
      'can do.',
      '',
      'To start it:  TAPTHAT_ENABLE=1 npx tapthat-server',
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
