import { createInterface } from 'node:readline';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = paint(1);
export const dim = paint(2);
export const green = paint(32);
export const yellow = paint(33);
export const red = paint(31);
export const cyan = paint(36);

export const say = (s = '') => console.log(s);
export const heading = (s: string) => say(`\n${bold(s)}`);
export const ok = (s: string) => say(`  ${green('✓')} ${s}`);
export const todo = (s: string) => say(`  ${yellow('•')} ${s}`);
export const warn = (s: string) => say(`  ${yellow('!')} ${s}`);
export const fail = (s: string) => say(`  ${red('✗')} ${s}`);

/**
 * Terminal prompts. Without a terminal (CI, a pipe) every question takes its
 * default when `assumeYes` is set, and is an error otherwise: an installer that
 * guesses silently is worse than one that stops.
 */
export class Prompter {
  constructor(private readonly assumeYes: boolean) {}

  private get interactive(): boolean {
    return !!process.stdin.isTTY && !this.assumeYes;
  }

  private ask(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((done) => rl.question(question, (a) => (rl.close(), done(a.trim()))));
  }

  private noTerminal(what: string, fallback: string | undefined): string {
    if (this.assumeYes && fallback !== undefined) return fallback;
    throw new Error(`${what}: needs an answer. Run in a terminal, or pass the flag for it (see --help) and --yes.`);
  }

  async input(question: string, fallback?: string): Promise<string> {
    if (!this.interactive) return this.noTerminal(question, fallback);
    for (;;) {
      const a = await this.ask(`${cyan('?')} ${question}${fallback ? dim(` (${fallback})`) : ''} `);
      if (a || fallback) return a || fallback!;
    }
  }

  async confirm(question: string, fallback = true): Promise<boolean> {
    if (!this.interactive) return this.assumeYes ? fallback : !!this.noTerminal(question, undefined);
    const a = (await this.ask(`${cyan('?')} ${question} ${dim(fallback ? '(Y/n)' : '(y/N)')} `)).toLowerCase();
    return a ? a.startsWith('y') : fallback;
  }

  async select(question: string, options: Array<{ value: string; label: string }>, fallback?: string): Promise<string> {
    if (!options.length) throw new Error(`${question}: nothing to choose from`);
    const def = options.find((o) => o.value === fallback) ?? options[0]!;
    if (!this.interactive) return this.noTerminal(question, def.value);
    say(`${cyan('?')} ${question}`);
    options.forEach((o, i) => say(`  ${dim(`${i + 1})`)} ${o.label}${o === def ? dim('  ← default') : ''}`));
    for (;;) {
      const a = await this.ask(`  ${dim(`1-${options.length}, Enter for default:`)} `);
      if (!a) return def.value;
      const hit = options[Number(a) - 1] ?? options.find((o) => o.value === a);
      if (hit) return hit.value;
    }
  }

  /** Reads a secret without echoing it. */
  async secret(question: string): Promise<string> {
    if (!process.stdin.isTTY) throw new Error(`${question}: needs a terminal (or pass it on stdin with --git-token-stdin)`);
    process.stdout.write(`${cyan('?')} ${question} ${dim('(hidden)')} `);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    return new Promise((done, reject) => {
      let value = '';
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') {
            finish();
            process.stdout.write('\n');
            return done(value.trim());
          }
          if (ch === '\u0003') {
            finish();
            process.stdout.write('\n');
            return reject(new Error('Cancelled.'));
          }
          if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
          else value += ch;
        }
      };
      const finish = () => {
        stdin.off('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
      };
      stdin.on('data', onData);
    });
  }
}

export async function readAllStdin(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}

/** Scales every wait; the installer's own tests run it at a thousandth. */
export const PACE = Number(process.env.TAPTHAT_INSTALL_PACE ?? 1);

/** Waits with a one-line spinner, for steps that take minutes. */
export async function waitFor<T>(label: string, poll: () => Promise<T | null>, timeoutMs: number, everyMs = 5000): Promise<T | null> {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const started = Date.now();
  let i = 0;
  for (;;) {
    const value = await poll().catch(() => null);
    if (value !== null) {
      if (tty) process.stdout.write('\r\x1b[2K');
      return value;
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (Date.now() - started > timeoutMs * PACE) {
      if (tty) process.stdout.write('\r\x1b[2K');
      return null;
    }
    if (tty) process.stdout.write(`\r\x1b[2K  ${cyan(frames[i++ % frames.length]!)} ${label} ${dim(`${elapsed}s`)}`);
    await new Promise((r) => setTimeout(r, everyMs * PACE));
  }
}
