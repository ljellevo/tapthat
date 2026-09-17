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
}

export interface PageSession {
  key: string;
  url: string;
  title: string;
  comments: CommentRecord[];
}

export type BackgroundMessage =
  | { type: 'TOGGLE' }
  | { type: 'PING' };

export type ContentMessage =
  | { type: 'COUNT'; count: number }
  | { type: 'ACTIVE'; active: boolean };
