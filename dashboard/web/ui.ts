/** Small drawing helpers shared by every screen. Text always goes in as text, never as HTML. */
import type { Platform } from '../shared/status.ts';

export const PLATFORM_LABELS: Record<Platform, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn' };

export const platformLabel = (platform: Platform): string => PLATFORM_LABELS[platform];

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Platform marks as simple shapes (white on the platform's colour, set in CSS), drawn here so nothing is fetched. */
const LOGOS: Record<Platform, string[]> = {
  facebook: ['M13.5 21v-7.5h2.6l.4-3h-3V8.6c0-.9.3-1.5 1.5-1.5h1.6V4.4c-.3 0-1.2-.1-2.3-.1-2.3 0-3.9 1.4-3.9 4v2.2H8v3h2.4V21h3.1z'],
  linkedin: [
    'M6.9 9.5h2.6V18H6.9z',
    'M8.2 5.4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
    'M11 9.5h2.5v1.2c.4-.7 1.3-1.4 2.7-1.4 2.7 0 3.2 1.8 3.2 4.1V18h-2.6v-4.1c0-1 0-2.2-1.4-2.2s-1.6 1.1-1.6 2.2V18H11z',
  ],
  instagram: [],
};
const ICONS: Record<string, string[]> = {
  calendar: ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  refresh: ['M21 12a9 9 0 1 1-3-6.7', 'M21 4v5h-5'],
  sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  left: ['M15 18l-6-6 6-6'],
  down: ['M6 9l6 6 6-6'],
  right: ['M9 18l6-6-6-6'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  help: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7', 'M12 17h.01'],
  plus: ['M12 5v14', 'M5 12h14'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  alert: ['M12 7v6', 'M12 17h.01'],
};

export type Child = Node | string | false | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) if (value !== undefined) element.setAttribute(name, value);
  for (const child of children) if (child !== false && child !== null && child !== undefined) element.append(child);
  return element;
}

/** The platform's mark: filled shapes for Facebook and LinkedIn, an outlined camera for Instagram. */
export function logo(platform: Platform): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `logo logo-${platform}`);
  svg.setAttribute('aria-hidden', 'true');
  const add = (tag: string, attributes: Record<string, string>): void => {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    svg.append(element);
  };
  if (platform === 'instagram') {
    add('rect', { x: '5', y: '5', width: '14', height: '14', rx: '4', class: 'logo-line' });
    add('circle', { cx: '12', cy: '12', r: '3.2', class: 'logo-line' });
    add('circle', { cx: '16.2', cy: '7.8', r: '0.9', class: 'logo-dot' });
  } else {
    for (const d of LOGOS[platform]) add('path', { d });
  }
  return svg;
}

export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

export function button(content: Child | Child[], className: string, onClick: () => void, label?: string, disabled = false): HTMLButtonElement {
  const element = h('button', { type: 'button', class: className, 'aria-label': label }, ...(Array.isArray(content) ? content : [content]));
  element.disabled = disabled;
  element.addEventListener('click', onClick);
  return element;
}


/** The channels the guides and the Add channel window talk about; Google has no feed platform yet. */
export type ChannelKind = Platform | 'google';

/** A mark for any channel kind, including Google Business (a coloured G). */
export function channelLogo(kind: ChannelKind): SVGSVGElement {
  if (kind !== 'google') return logo(kind);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'logo logo-google');
  svg.setAttribute('aria-hidden', 'true');
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', '12');
  text.setAttribute('y', '17.5');
  text.setAttribute('text-anchor', 'middle');
  text.textContent = 'G';
  svg.append(text);
  return svg;
}

export const channelName = (kind: ChannelKind): string =>
  kind === 'google' ? 'Google Business' : kind === 'facebook' ? 'Facebook Page' : platformLabel(kind);

let gradientCount = 0;

/** The full-colour mark of a channel, as a self-contained picture (background shape included). */
export function brandMark(kind: ChannelKind): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `brand brand-${kind}`);
  svg.setAttribute('aria-hidden', 'true');
  const add = (tag: string, attributes: Record<string, string>, parent: Element = svg): SVGElement => {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    parent.append(element);
    return element;
  };
  if (kind === 'facebook') {
    add('circle', { cx: '12', cy: '12', r: '12', fill: '#1877f2' });
    add('path', { d: 'M13.5 21v-7.5h2.6l.4-3h-3V8.6c0-.9.3-1.5 1.5-1.5h1.6V4.4c-.3 0-1.2-.1-2.3-.1-2.3 0-3.9 1.4-3.9 4v2.2H8v3h2.4V21h3.1z', fill: '#fff' });
  } else if (kind === 'instagram') {
    const id = `ig-gradient-${(gradientCount += 1)}`;
    const gradient = add('linearGradient', { id, x1: '0', y1: '1', x2: '1', y2: '0' }, add('defs', {}));
    [['0', '#feda75'], ['0.25', '#fa7e1e'], ['0.5', '#d62976'], ['0.75', '#962fbf'], ['1', '#4f5bd5']].forEach(([offset, color]) =>
      add('stop', { offset: offset as string, 'stop-color': color as string }, gradient),
    );
    add('rect', { x: '0', y: '0', width: '24', height: '24', rx: '6', fill: `url(#${id})` });
    add('rect', { x: '5', y: '5', width: '14', height: '14', rx: '4', fill: 'none', stroke: '#fff', 'stroke-width': '1.8' });
    add('circle', { cx: '12', cy: '12', r: '3.3', fill: 'none', stroke: '#fff', 'stroke-width': '1.8' });
    add('circle', { cx: '16.4', cy: '7.6', r: '1', fill: '#fff' });
  } else if (kind === 'linkedin') {
    add('rect', { x: '0', y: '0', width: '24', height: '24', rx: '5', fill: '#0a66c2' });
    for (const d of LOGOS.linkedin) add('path', { d, fill: '#fff' });
  } else {
    // Google Business: a shop front with a four-panel awning and a white G, drawn to match Google's icon.
    svg.setAttribute('viewBox', '0 0 100 87');
    const id = `gb-${(gradientCount += 1)}`;
    const defs = add('defs', {});
    const gradient = add('linearGradient', { id: `${id}-body`, x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
    add('stop', { offset: '0', 'stop-color': '#2d69ea' }, gradient);
    add('stop', { offset: '1', 'stop-color': '#4684f1' }, gradient);
    const bodyPath = 'M6.7 30h86.7v50.6a6.4 6.4 0 0 1-6.4 6.4H13.1a6.4 6.4 0 0 1-6.4-6.4z';
    add('path', { d: bodyPath }, add('clipPath', { id: `${id}-clip` }, defs));
    add('path', { d: bodyPath, fill: `url(#${id}-body)` });
    add('path', { d: 'M6.7 43.5L50 87H6.7z', fill: '#4d8bf3', 'clip-path': `url(#${id}-clip)` });
    // Awning: panels (light, dark, light, dark), each with a rounded scallop at the bottom edge.
    const panels: Array<[string, string, string, string]> = [
      ['M0 32.2L6.5 5.5Q8 0 13.5 0H28.9L25 32.2z', '#7aabf7', 'M0 32.2a12.5 12.5 0 0 0 25 0z', '#74a0e1'],
      ['M28.9 0H50V32.2H25z', '#4355b2', 'M25 32.2a12.5 12.5 0 0 0 25 0z', '#3e4fa7'],
      ['M50 0H71.1L75 32.2H50z', '#7aabf7', 'M50 32.2a12.5 12.5 0 0 0 25 0z', '#74a0e1'],
      ['M71.1 0H86.5Q92 0 93.5 5.5L100 32.2H75z', '#4355b2', 'M75 32.2a12.5 12.5 0 0 0 25 0z', '#3e4fa7'],
    ];
    for (const [panel, color, scallop, shade] of panels) {
      add('path', { d: panel, fill: color });
      add('path', { d: scallop, fill: shade });
    }
    // The white G: an open ring and its bar.
    add('path', { d: 'M81.54 61.11A10.1 10.1 0 1 0 83.9 67.6', fill: 'none', stroke: '#fff', 'stroke-width': '5.1' });
    add('path', { d: 'M74.1 67.6H86.2', fill: 'none', stroke: '#fff', 'stroke-width': '4.9' });
  }
  return svg;
}

/** A round mark for a channel's state: a green tick when it is connected, a red "!" when it needs attention. */
export function statusMark(ok: boolean): HTMLElement {
  const label = ok ? 'Connected' : 'Connection problem';
  return h('span', { class: `status-mark ${ok ? 'status-ok' : 'status-bad'}`, role: 'img', 'aria-label': label, title: label }, icon(ok ? 'check' : 'alert'));
}
