/**
 * Reading and judging a render report. The report is what the measuring page wrote about itself (measure-script.ts); this
 * module validates its shape strictly, because a missing or malformed report means nothing was measured, and turns it into
 * hard failures and warnings with codes. A page the browser merely exited successfully on is never assumed to have passed.
 */
import { REPORT_ELEMENT_ID } from './measure-script.ts';
import type { ContrastCheck } from './compose.ts';

export class MeasurementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeasurementError';
  }
}

export interface ElementReport {
  slot: string;
  role: string;
  layer: string;
  fontSize: number;
  min: number;
  max: number;
  lines: number;
  maxLines: number;
  height: number;
  slotH: number;
  slotW: number;
  fits: boolean;
  rect: { x: number; y: number; w: number; h: number };
}

export interface RenderReport {
  done: boolean;
  errors: string[];
  fontSource: string;
  fonts: { status: string; faces: Array<{ family: string; status: string }> };
  images: Array<{ slot: string; ok: boolean }>;
  elements: ElementReport[];
  collisions: Array<[string, string]>;
  outside: string[];
  missingGlyphs: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function validElement(value: unknown): value is ElementReport {
  if (!isRecord(value) || !isRecord(value['rect'])) return false;
  const rect = value['rect'];
  return (
    typeof value['slot'] === 'string' && typeof value['role'] === 'string' && typeof value['layer'] === 'string' && typeof value['fits'] === 'boolean' &&
    ['fontSize', 'min', 'max', 'lines', 'maxLines', 'height', 'slotH', 'slotW'].every((k) => isNumber(value[k])) &&
    ['x', 'y', 'w', 'h'].every((k) => isNumber(rect[k]))
  );
}

/** Finds and validates the report in a dumped page. Throws MeasurementError when it is absent or malformed. */
export function extractReport(dom: string): RenderReport {
  const match = new RegExp(`<script id="${REPORT_ELEMENT_ID}" type="application/json">([\\s\\S]*?)</script>`).exec(dom);
  if (!match) throw new MeasurementError('the page wrote no measurement report');
  let raw: unknown;
  try {
    raw = JSON.parse((match[1] ?? '').replace(/&lt;/g, '<').replace(/&amp;/g, '&'));
  } catch {
    throw new MeasurementError('the measurement report is not valid JSON');
  }
  if (!isRecord(raw) || typeof raw['done'] !== 'boolean' || !Array.isArray(raw['errors']) || !Array.isArray(raw['elements']) || !Array.isArray(raw['collisions']) || !Array.isArray(raw['outside']) || !Array.isArray(raw['missingGlyphs']) || !Array.isArray(raw['images']) || !isRecord(raw['fonts']) || typeof raw['fontSource'] !== 'string') {
    throw new MeasurementError('the measurement report has the wrong shape');
  }
  if (!raw['elements'].every(validElement)) throw new MeasurementError('the measurement report has a malformed element');
  const fonts = raw['fonts'];
  if (typeof fonts['status'] !== 'string' || !Array.isArray(fonts['faces'])) throw new MeasurementError('the measurement report has malformed font data');
  return raw as unknown as RenderReport;
}

export type IssueCode =
  | 'measurement_incomplete'
  | 'font_not_loaded'
  | 'system_font'
  | 'text_overflow'
  | 'missing_slot'
  | 'collision'
  | 'outside_margin'
  | 'missing_glyphs'
  | 'image_failed'
  | 'contrast'
  | 'identity_omitted'
  | 'possible_unbalanced_composition';

export interface Issue {
  code: IssueCode;
  severity: 'hard' | 'warning';
  message: string;
  slot?: string;
}

export interface Judgement {
  ok: boolean;
  hard: Issue[];
  warnings: Issue[];
  /** The solved font size of every fitted text slot, to freeze into the final page. */
  solved: Record<string, number>;
}

export interface Expectations {
  /** Slots the page must have measured (at least the headline). */
  slots: readonly string[];
  /** Pictures the page must have loaded. */
  images: number;
  contrast: readonly ContrastCheck[];
  /** Where pictures sit; what a picture fills is not empty. */
  pictureRects?: ReadonlyArray<{ y: number; h: number }>;
  /** Content should reach this share of the canvas height (text, brand strip or picture) before the poster is called unbalanced. Advisory only. */
  minContentReach?: number;
}

/** The share of the canvas height the lowest piece of content (text, brand element or picture) reaches. */
export function contentReach(report: RenderReport, pictureRects: ReadonlyArray<{ y: number; h: number }> = [], canvas = 1080): number {
  const bottoms = [...report.elements.map((e) => e.rect.y + e.rect.h), ...pictureRects.map((r) => r.y + r.h)];
  return bottoms.length === 0 ? 1 : Math.max(...bottoms) / canvas;
}

export function judgeReport(report: RenderReport, expect: Expectations): Judgement {
  const hard: Issue[] = [];
  const warnings: Issue[] = [];
  const add = (issue: Issue): void => void (issue.severity === 'hard' ? hard : warnings).push(issue);
  const solved: Record<string, number> = {};

  if (!report.done || report.errors.length > 0) {
    add({ code: 'measurement_incomplete', severity: 'hard', message: `the page did not finish measuring${report.errors.length ? `: ${report.errors.join('; ')}` : ''}` });
  }

  if (report.fontSource === 'system') {
    add({ code: 'system_font', severity: 'warning', message: 'the brand font is not in the local font set; system fonts were used' });
  } else if (report.fontSource === 'local') {
    const failed = report.fonts.faces.filter((f) => f.status !== 'loaded');
    if (report.fonts.faces.length === 0 || failed.length > 0 || report.fonts.status !== 'loaded') {
      add({ code: 'font_not_loaded', severity: 'hard', message: `a local font did not load${failed.length ? `: ${failed.map((f) => f.family).join(', ')}` : ''}` });
    }
  } else {
    add({ code: 'font_not_loaded', severity: 'hard', message: `unknown font source "${report.fontSource}"` });
  }

  for (const slot of expect.slots) {
    if (!report.elements.some((e) => e.slot === slot)) add({ code: 'missing_slot', severity: 'hard', message: `the page did not measure "${slot}"`, slot });
  }
  for (const element of report.elements) {
    if (element.role !== 'logo') solved[element.slot] = element.fontSize;
    if (!element.fits) {
      add({ code: 'text_overflow', severity: 'hard', message: `"${element.slot}" does not fit its slot even at ${element.min}px (${element.lines} line${element.lines === 1 ? '' : 's'}, ${Math.round(element.height)}px tall in ${element.slotH}px)`, slot: element.slot });
    }
  }
  for (const [a, b] of report.collisions) add({ code: 'collision', severity: 'hard', message: `"${a}" and "${b}" collide`, slot: a });
  for (const slot of report.outside) add({ code: 'outside_margin', severity: 'hard', message: `"${slot}" reaches outside the safe margins`, slot });
  if (report.missingGlyphs.length > 0) add({ code: 'missing_glyphs', severity: 'hard', message: `no font draws these characters: ${report.missingGlyphs.join(' ')}` });
  if (report.images.length < expect.images || report.images.some((i) => !i.ok)) add({ code: 'image_failed', severity: 'hard', message: 'a picture did not load' });
  for (const c of expect.contrast) if (!c.ok) add({ code: 'contrast', severity: 'hard', message: `"${c.slot}" has contrast ${c.ratio}:1, below ${c.target}:1`, slot: c.slot });

  // Advisory: a poster whose content stops well above the bottom edge, with no picture or brand element filling it, may look unfinished. Negative space can be
  // intended, so this only warns and records the number; it never changes the outcome.
  const reach = contentReach(report, expect.pictureRects ?? []);
  const minReach = expect.minContentReach ?? 0.85;
  if (report.done && report.elements.length > 0 && reach < minReach) {
    add({ code: 'possible_unbalanced_composition', severity: 'warning', message: `content ends at ${Math.round(reach * 100)}% of the poster height with nothing below it; this may look unfinished (checked only for empty space, not for a cropped picture subject)` });
  }

  return { ok: hard.length === 0, hard, warnings, solved };
}
