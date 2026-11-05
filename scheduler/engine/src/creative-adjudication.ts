/**
 * Deciding a poster from its independent readings without letting reader noise reject good work or let a bad poster through. Two readers transcribe the
 * poster without being told the expected text; code compares what each found with the exact text allowed (judgeCreative) and groups every defect into a gate:
 *
 *   text      missing, repeated, extra or unreadable text. Hard.
 *   mark:*    a drawn logo, badge, invented number, screen with writing, a person as an endorser, a flag or religious symbol. Hard.
 *   soft:*    not relevant, poor composition, too small to read at a small size, text over the main artwork. Soft: only when BOTH readers flag it
 *             does it reject; one reader's doubt becomes a warning for the owner.
 *
 * Both readers agree there is a hard defect -> reject. Both find nothing -> pass. They DISAGREE about a hard gate -> exactly one targeted third reading, of the
 * disputed region (cropped and enlarged, plus the whole poster) or of the whole poster when no reader could place it. That reading decides ONLY the disputed gates:
 * text passes only if the third reading finds the text exact and clean, a mark is rejected only if the third reading finds it too. If the third reading cannot
 * establish the text, the poster is rejected: uncertainty is never averaged away and there is no majority vote.
 */
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiConfig } from './ai.ts';
import { judgeCreative, reviewCreative, type Box, type CreativeDefect, type CreativeReview, type TextManifest } from './ai-creative.ts';
import { captureHtml } from './chrome-render.ts';

export type Gate = 'text' | `mark:${string}` | `soft:${string}`;

export const gateOf = (defect: CreativeDefect): Gate => {
  switch (defect.kind) {
    case 'missing_text': case 'repeated_text': case 'extra_text': case 'unreadable_text': return 'text';
    case 'forbidden_mark': return `mark:${defect.mark}`;
    default: return `soft:${defect.kind}`;
  }
};

export interface Dispute {
  gates: Gate[];
  /** Where the disputed things are, as the readers placed them. Empty when nobody could. */
  boxes: Box[];
}

export interface Adjudication {
  accepted: boolean;
  defects: CreativeDefect[];
  /** What was doubted by one reader only (soft), or cleared by the third reading; shown to the owner, never a rejection. */
  warnings: string[];
  /** Set when a third reading was made, with what it decided. */
  third?: { gates: Gate[]; boxes: Box[]; cropped: boolean; reading: CreativeReview; confirmed: Gate[]; cleared: Gate[] };
}

const byGate = (defects: readonly CreativeDefect[]): Map<Gate, CreativeDefect[]> => {
  const out = new Map<Gate, CreativeDefect[]>();
  for (const d of defects) out.set(gateOf(d), [...(out.get(gateOf(d)) ?? []), d]);
  return out;
};
const sameDefects = (a: readonly CreativeDefect[], b: readonly CreativeDefect[]): boolean => JSON.stringify([...a].map((d) => JSON.stringify(d)).sort()) === JSON.stringify([...b].map((d) => JSON.stringify(d)).sort());
const describe = (d: CreativeDefect): string => `${d.kind}${'text' in d ? `: ${d.text}` : 'reason' in d ? `: ${d.reason}` : ''}`;

/** Where a reader placed what is in dispute: the boxes of text regions that are not part of the allowed text, and of the marks it flagged. */
export function disputedBoxes(manifest: TextManifest, readings: readonly CreativeReview[], gates: readonly Gate[]): Box[] {
  const boxes: Box[] = [];
  const allowed = new Set([manifest.headline, manifest.brandName, manifest.domain, ...(manifest.subline ? [manifest.subline] : [])].map((t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()));
  for (const r of readings) {
    if (gates.includes('text')) for (const region of r.regions) {
      const norm = region.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (region.box && (!region.readable || ![...allowed].some((a) => a.includes(norm) || norm.includes(a)))) boxes.push(region.box);
    }
    for (const gate of gates) if (gate.startsWith('mark:')) {
      const box = r.markBoxes?.[gate.slice(5) as keyof CreativeReview['marks']];
      if (box) boxes.push(box);
    }
  }
  return boxes;
}

/**
 * The decision. `third` is called at most once, only for a disagreement about a hard gate, with the places the readers gave.
 * With fewer than two readings there is nothing to compare: a single reading decides alone and every one of its defects stands.
 */
export async function decideReadings(manifest: TextManifest, readings: readonly CreativeReview[], third: (dispute: Dispute) => Promise<{ reading: CreativeReview; cropped: boolean }>, plan: { people?: boolean } = {}): Promise<Adjudication> {
  const verdicts = readings.map((r) => judgeCreative(manifest, r, plan).defects);
  if (verdicts.length < 2) return { accepted: (verdicts[0]?.length ?? 1) === 0, defects: verdicts[0] ?? [], warnings: [] };
  const [a, b] = [byGate(verdicts[0] as CreativeDefect[]), byGate(verdicts[1] as CreativeDefect[])];
  const defects: CreativeDefect[] = [];
  const warnings: string[] = [];
  const disputed: Gate[] = [];
  for (const gate of new Set<Gate>([...a.keys(), ...b.keys()])) {
    const [inA, inB] = [a.get(gate), b.get(gate)];
    if (inA && inB) {
      if (gate.startsWith('soft:') || sameDefects(inA, inB)) defects.push(...inA);
      else disputed.push(gate); // both found something in the text, but not the same thing
    } else if (gate.startsWith('soft:')) {
      warnings.push(`one reader doubted it (${describe((inA ?? inB)?.[0] as CreativeDefect)}); not a rejection`);
    } else disputed.push(gate);
  }
  if (disputed.length === 0) return { accepted: defects.length === 0, defects, warnings };

  const dispute: Dispute = { gates: disputed, boxes: disputedBoxes(manifest, readings, disputed) };
  const { reading, cropped } = await third(dispute);
  const decided = byGate(judgeCreative(manifest, reading, plan).defects);
  const confirmed: Gate[] = [];
  const cleared: Gate[] = [];
  for (const gate of disputed) {
    const found = decided.get(gate);
    if (found) {
      confirmed.push(gate);
      defects.push(...found);
    } else {
      cleared.push(gate);
      warnings.push(`${gate} was disputed between the first readers and cleared by a targeted third reading`);
    }
  }
  return { accepted: defects.length === 0, defects, warnings, third: { gates: disputed, boxes: dispute.boxes, cropped, reading, confirmed, cleared } };
}

/** 15 percent of context around the box, never leaving the poster. */
export function paddedBox(box: Box, context = 0.15): Box {
  const [l, t, r, b] = box;
  const px = (r - l) * context;
  const py = (b - t) * context;
  return [Math.max(0, l - px), Math.max(0, t - py), Math.min(1000, r + px), Math.min(1000, b + py)];
}

/** The smallest box that holds every box given (with context), or null for none. */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const hull: Box = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
  return paddedBox(hull);
}

const CANVAS = 1080;

/** The HTML that shows `box` of the picture enlarged to fill a square, for Chrome to capture. Enlarging adds no detail: it only lets a reader see what is there. */
export function cropHtml(imageDataUrl: string, box: Box): string {
  const [l, t, r, b] = box;
  const wFrac = (r - l) / 1000;
  const hFrac = (b - t) / 1000;
  // Fit the longer side, with a floor on the zoom so a tiny box does not become a blur of one letter.
  const frac = Math.max(wFrac, hFrac, 0.2);
  const size = CANVAS / frac;
  const left = -(l / 1000) * size;
  const top = -(t / 1000) * size;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';"><style>*{margin:0;padding:0}html,body{width:${CANVAS}px;height:${CANVAS}px;overflow:hidden;background:#fff}img{position:absolute;left:${left}px;top:${top}px;width:${size}px;height:${size}px;image-rendering:auto}</style></head><body><img src="${imageDataUrl}" alt=""></body></html>`;
}

/** Crops and enlarges a region of the poster with Chrome, or returns null when it cannot (the reader then gets the whole poster only). */
export async function cropRegion(imagePath: string, box: Box): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), 'crop-'));
  try {
    const bytes = await readFile(imagePath);
    const png = join(dir, 'crop.png');
    await captureHtml(cropHtml(`data:image/jpeg;base64,${bytes.toString('base64')}`, box), png);
    return `data:image/png;base64,${(await readFile(png)).toString('base64')}`;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The third reading: the whole poster and, when the readers placed the dispute, an enlarged crop of it, read independently. */
export async function thirdReading(ai: AiConfig, imagePath: string, message: string, allowed: readonly string[], dispute: Dispute, fetchFn?: typeof fetch): Promise<{ reading: CreativeReview; cropped: boolean }> {
  const box = unionBox(dispute.boxes);
  const crop = box ? await cropRegion(imagePath, box) : null;
  const reading = await reviewCreative(ai, imagePath, message, fetchFn, 3, allowed, crop ? [crop] : []);
  return { reading, cropped: crop !== null };
}
