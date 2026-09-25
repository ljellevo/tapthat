export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AncestorRef {
  tag: string;
  id?: string;
  classes?: string[];
}

export interface CommentRecord {
  id: string;
  n: number;
  comment: string;
  createdAt: string;

  /** Unique CSS selector, verified to resolve to exactly one node at capture time. */
  selector: string;
  /** Readable ancestor chain, e.g. "body > div#root > main > section.hero > button.btn". */
  domPath: string;
  tagName: string;
  attributes: Record<string, string>;
  text: string;
  html: string;
  ancestors: AncestorRef[];
  landmark: string | null;
  nearestHeading: string | null;
  siblingIndex: number;
  siblingCount: number;
  rect: Rect;
  styles: Record<string, string>;

  /** Set during rehydration when the selector no longer resolves on the page. */
  stale?: boolean;

  /** Resolved comments are hidden from the page and left out of exports. */
  resolved?: boolean;
  resolvedAt?: string;

  /**
   * Full mode only: the sidecar's HEAD when this comment was captured. When the
   * branch has moved since, the element may no longer look the way the reviewer
   * saw it, and the panel says so before they apply. Never rendered into prompts.
   */
  baseSha?: string;
}

export interface PageSession {
  key: string;
  url: string;
  title: string;
  comments: CommentRecord[];
}

/**
 * Everything the prompt needs to know about the page the comments came from.
 *
 * Supplied by the caller rather than read from globals: the extension builds it
 * from `location`/`document`, the sidecar receives it over the wire, and neither
 * path can reach the other's environment.
 */
export interface PageContext {
  url: string;
  title: string;
  viewport: { w: number; h: number };
  /** ISO 8601. Passed in — never `new Date()` inside the renderer, so output is testable. */
  capturedAt: string;
}
