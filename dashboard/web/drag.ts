/**
 * Moving a post by dragging it, smoothly: the browser's own drag and drop jerks the page and draws a faded copy, so this follows the
 * mouse itself. The post is picked up after a few pixels of movement (so a click still opens it), a small copy follows the pointer,
 * the cell underneath lights up when the post may land there, and the hourly grid scrolls by itself near its top and bottom edge.
 * Cells say where a post can land with `data-drop-day` (and `data-drop-hour` in the hourly grid). Escape puts the post back.
 */
import type { StatusPost } from '../shared/status.ts';

export interface DragRules {
  /** Whether the post may land on this day (and hour, in the hourly grid; null on a day cell). */
  allowed(post: StatusPost, day: string, hour: number | null): boolean;
  drop(post: StatusPost, day: string, hour: number | null): void;
}

const PICK_UP_DISTANCE = 5;
const EDGE = 44;
const MAX_SCROLL_PER_FRAME = 16;
const LIT = 'drop-lit';

let justDragged = false;

interface Spot {
  cell: HTMLElement;
  day: string;
  hour: number | null;
}

function spotAt(x: number, y: number, post: StatusPost, rules: DragRules): Spot | null {
  const cell = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-day]');
  const day = cell?.dataset['dropDay'];
  if (!cell || day === undefined) return null;
  const hour = cell.dataset['dropHour'] === undefined ? null : Number(cell.dataset['dropHour']);
  return rules.allowed(post, day, hour) ? { cell, day, hour } : null;
}

/** Lets a post box be picked up with the mouse and dropped on a day or an hour. Its click is swallowed once, right after a drag. */
export function makeDraggable(element: HTMLElement, post: StatusPost, rules: DragRules): void {
  element.classList.add('movable');
  element.title = `${element.title ? `${element.title}. ` : ''}Drag to move it`;
  element.addEventListener('click', (event) => {
    if (!justDragged) return;
    event.stopImmediatePropagation();
    event.preventDefault();
  }, true);

  element.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    const start = { x: event.clientX, y: event.clientY };
    let pointer = { ...start };
    let picked = false;
    let spot: Spot | null = null;
    let frame = 0;
    let ghost: HTMLElement | null = null;

    const light = (next: Spot | null): void => {
      if (next?.cell !== spot?.cell) {
        spot?.cell.classList.remove(LIT);
        next?.cell.classList.add(LIT);
      }
      spot = next;
    };
    const refresh = (): void => light(spotAt(pointer.x, pointer.y, post, rules));
    const place = (): void => {
      if (ghost) ghost.style.transform = `translate(${pointer.x + 14}px, ${pointer.y + 14}px)`;
    };

    // Near the top or bottom of the hourly grid it scrolls, faster the closer the pointer is to the edge.
    const scroll = (): void => {
      const grid = document.querySelector<HTMLElement>('.tbody');
      if (grid) {
        const box = grid.getBoundingClientRect();
        const push = pointer.y < box.top + EDGE ? -(box.top + EDGE - pointer.y) : pointer.y > box.bottom - EDGE ? pointer.y - (box.bottom - EDGE) : 0;
        if (push !== 0) {
          grid.scrollTop += Math.max(-MAX_SCROLL_PER_FRAME, Math.min(MAX_SCROLL_PER_FRAME, push / 3));
          refresh();
        }
      }
      frame = requestAnimationFrame(scroll);
    };

    const finish = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', key);
      cancelAnimationFrame(frame);
      ghost?.remove();
      element.classList.remove('dragging');
      light(null);
      if (picked) {
        justDragged = true;
        // The click that follows the release has come and gone by the next turn of the page.
        setTimeout(() => {
          justDragged = false;
        }, 0);
      }
    };
    function move(moved: PointerEvent): void {
      pointer = { x: moved.clientX, y: moved.clientY };
      if (!picked) {
        if (Math.hypot(pointer.x - start.x, pointer.y - start.y) < PICK_UP_DISTANCE) return;
        picked = true;
        element.classList.add('dragging');
        ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.setAttribute('aria-hidden', 'true');
        ghost.textContent = element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 90) ?? '';
        document.body.append(ghost);
        frame = requestAnimationFrame(scroll);
      }
      place();
      refresh();
    }
    function up(): void {
      const landing = picked ? spot : null;
      finish();
      if (landing) rules.drop(post, landing.day, landing.hour);
    }
    function key(pressed: KeyboardEvent): void {
      if (pressed.key === 'Escape') finish();
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', key);
  });
}
