import type { RepoFacts } from './model';
import { must, parseJson, run } from './sh';

/**
 * GitHub through the `gh` CLI, as the person running the installer. Their own
 * login creates branches and commits the config; the workspace's token is only
 * checked, never used here.
 */
export class GitHub {
  constructor(private readonly bin = process.env.TAPTHAT_GH_BIN ?? 'gh') {}

  async available(): Promise<boolean> {
    return (await run(this.bin, ['--version'])).code === 0;
  }

  async loggedIn(): Promise<boolean> {
    return (await run(this.bin, ['auth', 'status'])).code === 0;
  }

  async login(): Promise<boolean> {
    return (await run(this.bin, ['auth', 'login'], { interactive: true })).code === 0;
  }

  private async api<T>(path: string, args: string[] = []): Promise<T | null> {
    const r = await run(this.bin, ['api', path, ...args]);
    if (r.code !== 0) {
      if (/HTTP 404|Not Found/.test(r.stderr + r.stdout)) return null;
      throw new Error(`gh api ${path} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
    }
    return parseJson<T>(r.stdout, `gh api ${path}`);
  }

  async defaultBranch(repo: string): Promise<string> {
    const r = await this.api<{ default_branch: string }>(`repos/${repo}`);
    if (!r) throw new Error(`GitHub repository ${repo} not found, or your gh login cannot see it`);
    return r.default_branch;
  }

  async branchSha(repo: string, branch: string): Promise<string | null> {
    const r = await this.api<{ commit: { sha: string } }>(`repos/${repo}/branches/${encodeURIComponent(branch)}`);
    return r?.commit.sha ?? null;
  }

  async createBranch(repo: string, branch: string, from: string): Promise<void> {
    const sha = await this.branchSha(repo, from);
    if (!sha) throw new Error(`${repo} has no branch "${from}" to create "${branch}" from`);
    await must(this.bin, ['api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${sha}`]);
  }

  async file(repo: string, path: string, ref: string): Promise<string | null> {
    const r = await this.api<{ content?: string; encoding?: string }>(`repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (!r?.content) return null;
    return Buffer.from(r.content, 'base64').toString('utf8');
  }

  async putFile(repo: string, path: string, branch: string, content: string, message: string): Promise<void> {
    await must(this.bin, [
      'api', '-X', 'PUT', `repos/${repo}/contents/${path}`,
      '-f', `message=${message}`,
      '-f', `branch=${branch}`,
      '-f', `content=${Buffer.from(content).toString('base64')}`,
    ]);
  }

  async repoFacts(repo: string, ref: string): Promise<RepoFacts> {
    const pkg = await this.file(repo, 'package.json', ref);
    let scripts: Record<string, string> = {};
    try {
      scripts = (pkg ? JSON.parse(pkg).scripts : null) ?? {};
    } catch {
      // An unparseable package.json shows up as missing scripts, which is warned about.
    }
    const has = async (p: string) => !!(await this.api(`repos/${repo}/contents/${p}?ref=${encodeURIComponent(ref)}`));
    const lockfile = (await has('package-lock.json'))
      ? 'npm'
      : (await has('pnpm-lock.yaml'))
        ? 'pnpm'
        : (await has('yarn.lock'))
          ? 'yarn'
          : null;
    return { scripts, lockfile };
  }
}

/**
 * Whether a token can push to a repository: GitHub only advertises the
 * receive-pack service to credentials with write access. Reads nothing and
 * pushes nothing.
 */
export async function canPush(token: string, repo: string): Promise<boolean> {
  const base = process.env.TAPTHAT_GITHUB_URL ?? 'https://github.com';
  const res = await fetch(`${base}/${repo}.git/info/refs?service=git-receive-pack`, {
    headers: { authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`, 'user-agent': 'tapthat-installer' },
    redirect: 'manual',
  });
  await res.body?.cancel();
  return res.status === 200;
}
