export interface DragOptions {
  /** The element that moves. */
  node: HTMLElement;
  /** The grab area (defaults to `node`). */
  handle?: HTMLElement;
  /** Called with viewport coordinates once the drag settles. */
  onEnd?(pos: { left: number; top: number }): void;
  /** Distance in px before a press counts as a drag rather than a click. */
  threshold?: number;
  /** Called when the press ended without exceeding the threshold. */
  onClick?(): void;
  className?: string;
}

const MARGIN = 8;

export function clampToViewport(node: HTMLElement, left: number, top: number) {
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  return {
    left: Math.max(MARGIN, Math.min(left, innerWidth - w - MARGIN)),
    top: Math.max(MARGIN, Math.min(top, innerHeight - h - MARGIN)),
  };
}

/**
 * Pointer-based dragging that also distinguishes a drag from a click, so a
 * draggable element can still be a button. Uses pointer capture, so the drag
 * keeps tracking even when the cursor leaves the element or the window.
 */
export function makeDraggable(opts: DragOptions): () => void {
  const { node, onEnd, onClick } = opts;
  const handle = opts.handle ?? node;
  const threshold = opts.threshold ?? 4;
  const dragClass = opts.className ?? 'dragging';

  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;
  let moved = false;
  let active = false;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    active = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;

    const r = node.getBoundingClientRect();
    originLeft = r.left;
    originTop = r.top;

    // Switch from any right/bottom anchoring to explicit left/top before moving.
    node.style.left = `${r.left}px`;
    node.style.top = `${r.top}px`;
    node.style.right = 'auto';
    node.style.bottom = 'auto';

    handle.setPointerCapture(e.pointerId);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);
  }

  function onPointerMove(e: PointerEvent) {
    if (!active) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!moved && Math.hypot(dx, dy) < threshold) return;
    if (!moved) {
      moved = true;
      handle.classList.add(dragClass);
    }

    const { left, top } = clampToViewport(node, originLeft + dx, originTop + dy);
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }

  function onPointerUp(e: PointerEvent) {
    if (!active) return;
    active = false;
    handle.classList.remove(dragClass);
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', onPointerUp);
    handle.removeEventListener('pointercancel', onPointerUp);

    if (moved) {
      const r = node.getBoundingClientRect();
      onEnd?.({ left: r.left, top: r.top });
    } else {
      onClick?.();
    }
  }

  handle.addEventListener('pointerdown', onPointerDown);

  // Keep it on screen when the window shrinks.
  const onResize = () => {
    if (node.style.left === '' || node.style.display === 'none') return;
    const r = node.getBoundingClientRect();
    const { left, top } = clampToViewport(node, r.left, r.top);
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  };
  window.addEventListener('resize', onResize, { passive: true });

  return () => {
    handle.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('resize', onResize);
  };
}
