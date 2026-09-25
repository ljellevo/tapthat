// The prompt itself is built in @tapthat/shared so the clipboard path and the
// sidecar path can never drift apart. What's left here is browser plumbing.
export { buildMarkdown } from '@tapthat/shared';

/**
 * Clipboard write. Called from a real click inside our shadow DOM, so the
 * document is focused and the async API is permitted; the execCommand path
 * covers older/edge cases where it is not.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fall through
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
