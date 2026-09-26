/**
 * A frozen PageContext shared by the test runners.
 *
 * `capturedAt` is fixed rather than `new Date()` so the rendered prompt is
 * byte-stable and can be diffed against a golden file.
 */
export const TEST_PAGE = {
  url: 'http://localhost:3000/pricing',
  title: 'TapThat selector fixture',
  viewport: { w: 1024, h: 768 },
  capturedAt: '2025-01-01T00:00:00.000Z',
};
