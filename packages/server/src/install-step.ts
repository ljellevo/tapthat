import type { Progress } from './session';

/**
 * Keeps each repo's dependencies in step with its code across sessions.
 * Starting a session fast-forwards the checkouts to dev, and discarding one
 * puts them back; either can bring a different lockfile. The dev server of a
 * repo whose dependencies changed would otherwise run the new code against the
 * old `node_modules` and fail on the first import it added.
 */
export interface InstallStepDeps {
  /** Repos that have an install command, in workspace order. */
  repos: string[];
  /** Whether the repo's lockfile differs from the one last installed. */
  needsInstall(name: string): Promise<boolean>;
  /** Installs; throws when the install fails. */
  install(name: string): Promise<void>;
  isRunning(name: string): boolean;
  stopServer(name: string): Promise<void>;
  /** Starts the dev server and resolves once it answers. */
  startServer(name: string): Promise<void>;
}

/**
 * Reinstalls each repo whose dependencies changed, with its dev server stopped
 * for the install — `npm ci` removes `node_modules` first — and started again
 * afterwards, whether or not the install succeeded. Repos that did not change
 * are left alone and their servers keep running.
 */
export function makeInstallStep(deps: InstallStepDeps): (progress: Progress) => Promise<void> {
  return async (progress) => {
    const changed: string[] = [];
    for (const name of deps.repos) {
      if (await deps.needsInstall(name)) changed.push(name);
    }
    for (const [i, name] of changed.entries()) {
      progress(`Installing changed dependencies… ${name}`, i + 1, changed.length);
      const running = deps.isRunning(name);
      if (running) await deps.stopServer(name);
      try {
        await deps.install(name);
      } finally {
        if (running) await deps.startServer(name);
      }
    }
  };
}
