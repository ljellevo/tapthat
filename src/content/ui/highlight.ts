import { shortLabel } from '../capture';
import { el, getHost } from './host';

let box: HTMLDivElement | null = null;
let chip: HTMLDivElement | null = null;

function ensure() {
  if (box && chip) return { box, chip };
  const { layer } = getHost();
  box = el('div', 'highlight');
  chip = el('div', 'chip');
  layer.appendChild(box);
  layer.appendChild(chip);
  return { box, chip };
}

export interface ShowOptions {
  locked?: boolean;
  /** How many levels the user has walked up from the hovered element. */
  depth?: number;
  /** Skip the position transition — used while scrolling, where it reads as lag. */
  instant?: boolean;
}

export function show(target: Element, opts: ShowOptions = {}) {
  const { box, chip } = ensure();
  const r = target.getBoundingClientRect();

  box.classList.toggle('instant', !!opts.instant);
  box.style.display = 'block';
  box.style.left = `${r.left}px`;
  box.style.top = `${r.top}px`;
  box.style.width = `${r.width}px`;
  box.style.height = `${r.height}px`;
  box.classList.toggle('locked', !!opts.locked);

  chip.style.display = 'flex';
  chip.textContent = '';
  chip.appendChild(el('span', undefined, shortLabel(target)));
  chip.appendChild(
    el('span', 'dim', `${Math.round(r.width)} × ${Math.round(r.height)}`),
  );
  if (opts.depth) chip.appendChild(el('span', 'dim', `↑${opts.depth}`));

  // Measure after content is set, then flip below when there's no room above.
  const chipRect = chip.getBoundingClientRect();
  const above = r.top - chipRect.height - 4;
  chip.style.top = above >= 0 ? `${above}px` : `${Math.min(r.top + 4, innerHeight - chipRect.height - 4)}px`;
  chip.style.left = `${Math.max(2, Math.min(r.left, innerWidth - chipRect.width - 4))}px`;
}

export function hide() {
  if (box) box.style.display = 'none';
  if (chip) chip.style.display = 'none';
}

export function destroy() {
  box?.remove();
  chip?.remove();
  box = null;
  chip = null;
}
