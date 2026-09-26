import type { PageContext } from 'tapthat-shared';

/**
 * The browser half of the prompt input. Kept here rather than in shared because
 * shared is compiled without DOM types on purpose — see packages/shared/tsconfig.json.
 */
export function pageContext(): PageContext {
  return {
    url: location.href,
    title: document.title,
    viewport: { w: innerWidth, h: innerHeight },
    capturedAt: new Date().toISOString(),
  };
}
