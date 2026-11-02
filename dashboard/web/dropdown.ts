import { brandHue } from './calendar.ts';
import { h, icon } from './ui.ts';

export interface DropdownOption {
  value: string;
  label: string;
  /** Gives the option a dot in the client's own colour. */
  dot?: string;
}

/** A drop-in for a <select>: reads `.value`, fires 'change', but looks like the rest of the page. */
export type Dropdown = HTMLDivElement & { value: string };

const dotColor = (slug: string): string => `hsl(${brandHue(slug)} 62% 56%)`;

/** The option for a client: its name with a dot in its colour. */
export const clientOption = (brand: string, label: string): DropdownOption => ({ value: brand, label, dot: brand });

/**
 * A list you open with a click or the keyboard (arrows, Enter, Escape). The page's own look is used instead of
 * the system menu, which cannot be styled.
 */
export function dropdown(options: readonly DropdownOption[], initial: string, label: string): Dropdown {
  let current = options.some((o) => o.value === initial) ? initial : (options[0]?.value ?? '');
  let open = false;
  let active = 0;

  const root = h('div', { class: 'dropdown' }) as Dropdown;
  const dotFor = (option: DropdownOption): HTMLElement => {
    const dot = h('span', { class: option.dot ? 'dd-dot' : 'dd-dot dd-dot-none', 'aria-hidden': 'true' });
    if (option.dot) dot.style.setProperty('--dot', dotColor(option.dot));
    return dot;
  };
  const trigger = h('button', { type: 'button', class: 'btn dd-trigger', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': label });
  const list = h('ul', { class: 'dd-list', role: 'listbox', 'aria-label': label, tabindex: '-1', hidden: '' });
  const items = options.map((option) => {
    const item = h('li', { class: 'dd-item', role: 'option', id: `dd-${Math.random().toString(36).slice(2, 9)}` }, dotFor(option), h('span', { class: 'dd-text' }, option.label), h('span', { class: 'dd-check', 'aria-hidden': 'true' }, icon('check')));
    item.addEventListener('click', () => choose(option.value));
    item.addEventListener('mousemove', () => highlight(options.indexOf(option)));
    return item;
  });
  list.append(...items);

  function paint(): void {
    const option = options.find((o) => o.value === current);
    trigger.replaceChildren(...(option ? [dotFor(option), h('span', { class: 'dd-text' }, option.label)] : []), h('span', { class: 'dd-arrow', 'aria-hidden': 'true' }, icon('down')));
    items.forEach((item, i) => item.setAttribute('aria-selected', String(options[i]?.value === current)));
  }
  function highlight(index: number): void {
    active = Math.max(0, Math.min(options.length - 1, index));
    items.forEach((item, i) => item.classList.toggle('dd-active', i === active));
    const item = items[active];
    if (item) {
      trigger.setAttribute('aria-activedescendant', item.id);
      item.scrollIntoView({ block: 'nearest' });
    }
  }
  function setOpen(next: boolean): void {
    open = next;
    list.hidden = !next;
    trigger.setAttribute('aria-expanded', String(next));
    if (next) {
      highlight(Math.max(0, options.findIndex((o) => o.value === current)));
      document.addEventListener('pointerdown', outside, true);
    } else {
      trigger.removeAttribute('aria-activedescendant');
      document.removeEventListener('pointerdown', outside, true);
    }
  }
  function outside(event: Event): void {
    if (!root.contains(event.target as Node)) setOpen(false);
  }
  function choose(value: string): void {
    const changed = value !== current;
    current = value;
    paint();
    setOpen(false);
    trigger.focus();
    if (changed) root.dispatchEvent(new Event('change', { bubbles: true }));
  }

  trigger.addEventListener('click', () => setOpen(!open));
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return setOpen(true);
      highlight(active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Home' || event.key === 'End') {
      if (!open) return;
      event.preventDefault();
      highlight(event.key === 'Home' ? 0 : options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (!open) return;
      event.preventDefault();
      const option = options[active];
      if (option) choose(option.value);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation(); // do not also close the window the list sits in
      setOpen(false);
    } else if (event.key === 'Tab' && open) {
      setOpen(false);
    }
  });

  Object.defineProperty(root, 'value', { get: () => current, enumerable: true });
  paint();
  root.append(trigger, list);
  return root;
}
