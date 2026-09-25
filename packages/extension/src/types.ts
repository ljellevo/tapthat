/**
 * Capture and prompt types live in @tapthat/shared so the extension and the
 * sidecar render the same payload. Re-exported here so the ~12 existing
 * `from '../types'` imports keep working.
 */
export type {
  AncestorRef,
  CommentRecord,
  PageContext,
  PageSession,
  Rect,
} from '@tapthat/shared';

/** Chrome runtime messaging — extension-only, never crosses the wire. */
export type BackgroundMessage =
  | { type: 'TOGGLE' }
  | { type: 'PING' };

export type ContentMessage =
  | { type: 'COUNT'; count: number }
  | { type: 'ACTIVE'; active: boolean }
  | { type: 'OPEN_OPTIONS' };
