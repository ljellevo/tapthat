/**
 * Exercises buildSelector/buildRecord against every element in the fixture page
 * and reports any selector that fails to resolve back to its origin element.
 * Run via `npm run test:selectors` (see README).
 */
import { buildRecord, buildSelector, shortLabel } from '../src/content/capture';

interface Failure {
  label: string;
  selector: string;
  matches: number;
  reason: string;
}

function run() {
  const all = Array.from(document.querySelectorAll('#root *'));
  const failures: Failure[] = [];
  let checked = 0;

  for (const el of all) {
    const selector = buildSelector(el);
    checked++;

    let matches = 0;
    let resolved: Element | null = null;
    try {
      const found = document.querySelectorAll(selector);
      matches = found.length;
      resolved = found[0] ?? null;
    } catch (e) {
      failures.push({
        label: shortLabel(el),
        selector,
        matches: -1,
        reason: `invalid selector: ${(e as Error).message}`,
      });
      continue;
    }

    if (matches !== 1) {
      failures.push({ label: shortLabel(el), selector, matches, reason: 'not unique' });
    } else if (resolved !== el) {
      failures.push({ label: shortLabel(el), selector, matches, reason: 'resolved to a different element' });
    }
  }

  // Spot-check a full record on the hard case: one of three identical buttons.
  const thirdChoose = document.querySelectorAll('.pricing .card .btn-primary')[2];
  const record = buildRecord(thirdChoose, 'make this one green', 1);

  // The node runner (run-selectors.mjs) reads this and does the reporting.
  (window as unknown as { __avResult: unknown }).__avResult = {
    checked,
    failures,
    sample: record,
  };
}

run();
