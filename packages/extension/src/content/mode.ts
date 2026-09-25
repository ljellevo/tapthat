import type { Settings } from '../settings';

export type Mode = 'light' | 'full';

/**
 * Derived, never stored. With default settings every page is Light, which is
 * behaviour-identical to TapThat before Full existed: no Apply button and no
 * network request of any kind.
 */
export function modeFor(settings: Settings, origin: string): Mode {
  if (!settings.sidecarUrl) return 'light';
  if (!settings.allowedOrigins.includes(origin)) return 'light';
  return 'full';
}
