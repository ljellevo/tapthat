import { spawn } from 'node:child_process';
import type { AgentResult } from './job';
import type { Config } from './config';
import { addSecret, forgetSecret, scrub } from './log';

export interface Credential {
  raw: string;
  kind: 'api_key' | 'oauth_token';
}

/** Detect by prefix: OAuth tokens from `claude setup-token` carry -oat01-. */
export function credentialKind(raw: string): Credential['kind'] | null {
  if (raw.startsWith('sk-ant-oat01-')) return 'oauth_token';
  if (raw.startsWith('sk-ant-')) return 'api_key';
  return null;
}

/**
 * The environment the agent child gets. Built fresh per run and never assigned
 * into process.env, so one user's credential cannot leak into another's job or
 * into the sidecar's own logs.
 */
function childEnv(credential: Credential | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Whichever variable we are not using must be cleared, or a stale ambient
  // value would silently win over the credential we were handed.
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;

  if (credential) {
    if (credential.kind === 'oauth_token') env.CLAUDE_CODE_OAUTH_TOKEN = credential.raw;
    else env.ANTHROPIC_API_KEY = credential.raw;
  }
  return env;
}

function buildArgs(prompt: string, config: Config): string[] {
  if (config.agent.args) return [...config.agent.args, prompt];

  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    // No Bash and no network tools: the prompt contains text captured from a web
    // page, so the agent must not be able to act on anything it finds there
    // beyond editing files.
    '--allowedTools',
    config.agent.allowedTools,
    '--permission-mode',
    'acceptEdits',
  ];
  if (config.agent.model) args.push('--model', config.agent.model);
  return args;
}

export interface RunAgentOptions {
  config: Config;
  credential: Credential | null;
  /** Called with each assistant message as it streams, already scrubbed. */
  onMessage?(text: string): void;
}

/**
 * Runs the agent over the repo. stream-json rather than json: a 10-40s run that
 * emits nothing until it finishes looks hung to the reviewer, which is the exact
 * failure the status panel exists to avoid.
 */
export function makeAgentRunner(opts: RunAgentOptions) {
  return function runAgent(prompt: string, signal: AbortSignal): Promise<AgentResult> {
    return new Promise((resolvePromise) => {
      const { config, credential } = opts;
      if (credential) addSecret(credential.raw);

      const child = spawn(config.agent.command, buildArgs(prompt, config), {
        // The workspace root: the checkout itself, or the directory holding several.
        cwd: config.workspaceRoot,
        env: childEnv(credential),
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
      });

      let stderr = '';
      let buffer = '';
      const messages: string[] = [];

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as {
              type?: string;
              subtype?: string;
              result?: string;
              message?: { content?: Array<{ type?: string; text?: string }> };
            };
            if (event.type === 'assistant') {
              for (const part of event.message?.content ?? []) {
                if (part.type === 'text' && part.text) {
                  const text = scrub(part.text);
                  messages.push(text);
                  opts.onMessage?.(text);
                }
              }
            } else if (event.type === 'result' && typeof event.result === 'string') {
              messages.push(scrub(event.result));
            }
          } catch {
            // A non-JSON line is diagnostic noise, not a failure.
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      const finish = (result: AgentResult) => {
        if (credential) forgetSecret(credential.raw);
        resolvePromise(result);
      };

      child.on('error', (err) => {
        const hint =
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `Could not run "${config.agent.command}". Install the Claude Code CLI, or set agent.command in tapthat.config.json.`
            : scrub(err.message);
        finish({ ok: false, summary: '', error: hint });
      });

      child.on('close', (code) => {
        if (signal.aborted) {
          finish({
            ok: false,
            summary: '',
            error: `The agent exceeded its ${Math.round(config.agent.timeoutMs / 1000)}s time limit and was stopped.`,
          });
          return;
        }
        const summary = messages.at(-1) ?? '';
        if (code === 0) {
          finish({ ok: true, summary });
          return;
        }
        finish({
          ok: false,
          summary,
          error: scrub(stderr.trim() || summary || `The agent exited with code ${code}.`),
        });
      });
    });
  };
}
