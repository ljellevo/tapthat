import { el, getHost } from './host';

export interface ConnectOptions {
  /** Saves the pasted credential; resolves to an error message to show, or null on success. */
  onSubmit(credential: string): Promise<string | null>;
  onOpenSettings(): void;
  onOpenHelp(): void;
}

let node: HTMLDivElement | null = null;

/**
 * First-run credential capture, in the page, so a reviewer's first Apply does
 * not bounce them to a settings tab. The key is POSTed once to the sidecar and
 * never stored by the extension — only the handle the sidecar returns.
 *
 * Resolves true once a credential is saved, false if the reviewer backs out.
 */
export function open(opts: ConnectOptions): Promise<boolean> {
  close();
  const { layer } = getHost();
  node = el('div', 'sheet');
  layer.appendChild(node);

  node.appendChild(el('h2', undefined, 'Connect your Claude account'));
  node.appendChild(
    el(
      'p',
      undefined,
      'The agent runs on your credential, so the cost lands on your own account. Paste an API key (sk-ant-…) or a token from `claude setup-token`. It is sent once to your sidecar and never stored in the browser.',
    ),
  );

  const input = el('input');
  input.type = 'password';
  input.placeholder = 'sk-ant-…';
  input.autocomplete = 'off';
  input.spellcheck = false;
  node.appendChild(input);

  const how = el('a', undefined, "Don't have a key? How to get one →");
  how.addEventListener('click', () => opts.onOpenHelp());
  node.appendChild(how);

  const error = el('div', 'error');
  error.hidden = true;
  node.appendChild(error);

  const row = el('div', 'row');
  const settings = el('a', undefined, 'Open settings');
  settings.addEventListener('click', () => opts.onOpenSettings());
  row.appendChild(settings);
  row.appendChild(el('span', 'spacer'));
  const cancel = el('button', 'ghost', 'Cancel');
  const save = el('button', 'primary', 'Connect & apply');
  save.disabled = true;
  row.appendChild(cancel);
  row.appendChild(save);
  node.appendChild(row);

  return new Promise<boolean>((resolvePromise) => {
    const finish = (ok: boolean) => {
      close();
      resolvePromise(ok);
    };

    const submit = async () => {
      const value = input.value.trim();
      if (!value) return;
      save.disabled = true;
      save.textContent = 'Connecting…';
      const problem = await opts.onSubmit(value);
      if (!problem) {
        input.value = '';
        finish(true);
        return;
      }
      error.textContent = problem;
      error.hidden = false;
      save.disabled = false;
      save.textContent = 'Connect & apply';
    };

    input.addEventListener('input', () => {
      save.disabled = input.value.trim().length === 0;
      error.hidden = true;
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        void submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    cancel.addEventListener('click', () => finish(false));
    save.addEventListener('click', () => void submit());
    input.focus();
  });
}

export function close() {
  node?.remove();
  node = null;
}
