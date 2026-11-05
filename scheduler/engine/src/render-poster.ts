/**
 * Rendering one poster with measurement and a fallback ladder. Each candidate brief (from art-resolve's renderCandidates) is
 * composed with a placeholder picture and measured in headless Chrome BEFORE any picture is paid for; the first candidate
 * whose measurement passes is the one that gets its picture. With the real picture the page is measured again, then frozen
 * with the solved sizes and captured, and the capture's dimensions are verified. Copy is never truncated; if every candidate
 * fails measurement the post is `render_failed`, no picture is requested and no artifact is written.
 *
 * Statuses: `render_verified` (local fonts, assets, geometry, contrast and dimensions all passed), `capture_complete` (the
 * poster was captured and measured but its fonts were system fonts, so typography is not fully verified), `render_failed`.
 */
import type { ArtRecord } from './art-options.ts';
import type { RenderCandidate } from './art-resolve.ts';
import { chromeVersion, captureHtml, measureHtml, type ChromeDeps } from './chrome-render.ts';
import { composePoster, ComposeError, type PosterBrand, type PosterCopy } from './compose.ts';
import { extractReport, judgeReport, MeasurementError, type Issue } from './fit-report.ts';
import { familyById, layoutRegistry } from './layout-registry.ts';
import { findSubject, focusFor, subjectOnCanvas, type CanvasRect, type Focus, type SubjectBox } from './subject-focus.ts';
import { fileURLToPath } from 'node:url';
import type { ResolvedFont } from './typography.ts';

export type RenderStatus = 'render_verified' | 'capture_complete' | 'render_failed';

export interface Attempt {
  optionId: string;
  stage: 'preflight' | 'final';
  ok: boolean;
  issues: Issue[];
}

export interface RenderOutcome {
  status: RenderStatus;
  /** The candidate that rendered (absent on failure). */
  optionId?: string;
  /** The art record of the candidate that actually rendered, to commit once the poster is accepted. */
  record?: ArtRecord;
  solved?: Record<string, number>;
  warnings: Issue[];
  attempts: Attempt[];
  chromeVersion: string;
  /** Why the post failed, when it did. */
  failure?: string;
}

export interface RenderInput {
  copy: PosterCopy;
  brand: PosterBrand;
  font: ResolvedFont;
  candidates: readonly RenderCandidate[];
  /** Makes the picture for the chosen candidate and returns its file: URL. Called only after that candidate passed preflight. */
  makePicture?: (candidate: RenderCandidate) => Promise<string | undefined>;
  outPng: string;
  chrome?: ChromeDeps;
}

const subjects = new Map<string, SubjectBox | undefined>();

/** The crop position that keeps the picture's subject in view in this candidate's panel, and where the subject then lies on the poster; neither when there is no clear subject. */
async function placeSubject(pictureUrl: string, candidate: RenderCandidate, input: RenderInput): Promise<{ focus: Focus; subject: CanvasRect } | undefined> {
  if (!pictureUrl.startsWith('file:')) return undefined;
  const panel = familyById(layoutRegistry, candidate.brief.layout)?.zones[candidate.brief.textZone]?.imageSlots.find((slot) => slot.id === candidate.brief.picture.role)?.rect;
  if (!panel) return undefined;
  const path = fileURLToPath(pictureUrl);
  if (!subjects.has(path)) subjects.set(path, await findSubject(path, input.chrome));
  const box = subjects.get(path);
  if (!box) return undefined;
  const focus = focusFor(box, panel.w / panel.h);
  return { focus, subject: subjectOnCanvas(box, panel, focus) };
}

const fail = (message: string): Issue => ({ code: 'measurement_incomplete', severity: 'hard', message });

async function measure(candidate: RenderCandidate, input: RenderInput, pictureUrl: string | undefined, expectImages: number, brand: PosterBrand = input.brand, pictureFocus?: Focus, subjectRect?: CanvasRect): Promise<{ issues: Issue[]; warnings: Issue[]; solved: Record<string, number> }> {
  let composed;
  try {
    composed = composePoster({ brief: candidate.brief, copy: input.copy, brand, font: input.font, mode: { kind: 'measure' }, ...(pictureUrl ? { pictureUrl } : {}), ...(pictureFocus ? { pictureFocus } : {}) });
  } catch (error) {
    if (error instanceof ComposeError) return { issues: [fail(error.message)], warnings: [], solved: {} };
    throw error;
  }
  let report;
  try {
    report = extractReport(await measureHtml(composed.html, input.chrome));
  } catch (error) {
    if (error instanceof MeasurementError) return { issues: [fail(error.message)], warnings: [], solved: {} };
    throw error;
  }
  const judged = judgeReport(report, { slots: ['headline'], images: expectImages, contrast: composed.contrast, pictureRects: composed.pictureRects, ...(subjectRect ? { subjectRect } : {}) });
  return { issues: judged.hard, warnings: judged.warnings, solved: judged.solved };
}

export async function renderPoster(input: RenderInput): Promise<RenderOutcome> {
  const version = await chromeVersion(input.chrome);
  const attempts: Attempt[] = [];
  let chosen: { candidate: RenderCandidate; solved: Record<string, number> } | undefined;
  let chosenBrand: PosterBrand = input.brand;
  let extraWarnings: Issue[] = [];
  const onlyAbout = (issues: Issue[], slot: string): boolean => issues.length > 0 && issues.every((i) => i.slot === slot || (i.code === 'collision' && i.message.includes(`"${slot}"`)));

  for (const candidate of input.candidates) {
    let working = input.brand;
    let result = await measure(candidate, input, undefined, 0, working);
    attempts.push({ optionId: candidate.optionId, stage: 'preflight', ok: result.issues.length === 0, issues: result.issues });
    const kept: Issue[] = [];
    // An identity line too long for its slot is dropped rather than failing the poster: it is an optional brand element, never invented or shortened, and the report says so.
    if (onlyAbout(result.issues, 'identity') && working.identityLine) {
      const trimmed: PosterBrand = { ...working };
      delete trimmed.identityLine;
      const retry = await measure(candidate, input, undefined, 0, trimmed);
      attempts.push({ optionId: candidate.optionId, stage: 'preflight', ok: retry.issues.length === 0, issues: retry.issues });
      if (retry.issues.length === 0 || onlyAbout(retry.issues, 'cta')) {
        working = trimmed;
        result = retry;
        kept.push({ code: 'identity_omitted', severity: 'warning', message: 'the identity line did not fit its slot at the smallest size, so the poster is drawn without it' });
      }
    }
    // A call to action that does not fit one line is stacked (label, then link) before anything is given up; only if that still does not fit does it keep
    // just its link, which is the part that matters. The label is never reworded or shortened.
    if (onlyAbout(result.issues, 'cta') && working.cta?.label.trim()) {
      const stacked: PosterBrand = { ...working, cta: { ...working.cta, stacked: true } };
      const retry = await measure(candidate, input, undefined, 0, stacked);
      attempts.push({ optionId: candidate.optionId, stage: 'preflight', ok: retry.issues.length === 0, issues: retry.issues });
      if (retry.issues.length === 0) {
        working = stacked;
        result = retry;
        kept.push({ code: 'cta_stacked', severity: 'warning', message: 'the call to action did not fit one line, so its label and link are on two lines' });
      } else if (onlyAbout(retry.issues, 'cta')) {
        const compact: PosterBrand = { ...working, cta: { label: '', host: working.cta.host } };
        const last = await measure(candidate, input, undefined, 0, compact);
        attempts.push({ optionId: candidate.optionId, stage: 'preflight', ok: last.issues.length === 0, issues: last.issues });
        if (last.issues.length === 0) {
          working = compact;
          result = last;
          kept.push({ code: 'cta_label_omitted', severity: 'warning', message: 'the call to action did not fit its slot even on two lines, so only its link is shown' });
        }
      }
    }
    if (result.issues.length === 0) {
      chosen = { candidate, solved: result.solved };
      chosenBrand = working;
      extraWarnings = kept;
      break;
    }
  }
  if (!chosen) return { status: 'render_failed', warnings: [], attempts, chromeVersion: version, failure: 'no candidate passed measurement; no picture was requested' };

  const { candidate } = chosen;
  let pictureUrl: string | undefined;
  if (candidate.brief.picture.role !== 'none') {
    pictureUrl = await input.makePicture?.(candidate);
    if (!pictureUrl) {
      attempts.push({ optionId: candidate.optionId, stage: 'final', ok: false, issues: [{ code: 'image_failed', severity: 'hard', message: 'the picture was not produced' }] });
      return { status: 'render_failed', warnings: [], attempts, chromeVersion: version, failure: 'the picture was not produced' };
    }
  }

  const brand = chosenBrand;
  // The picture is paid for once. If, laid out, text would sit over its subject, the later candidates are tried with that same picture (or with none) before the poster is given up.
  const later = input.candidates.slice(input.candidates.indexOf(candidate) + 1);
  let final: { issues: Issue[]; warnings: Issue[]; solved: Record<string, number> } | undefined;
  let used: RenderCandidate = candidate;
  let usedPicture: string | undefined = pictureUrl;
  let pictureFocus: Focus | undefined;
  let lastFailure = '';
  for (const option of [candidate, ...later]) {
    const withPicture = option.brief.picture.role !== 'none' && pictureUrl !== undefined;
    if (option.brief.picture.role !== 'none' && !withPicture) continue;
    const url = withPicture ? pictureUrl : undefined;
    const placed = url ? await placeSubject(url, option, input) : undefined;
    const result = await measure(option, input, url, url ? 1 : 0, brand, placed?.focus, placed?.subject);
    attempts.push({ optionId: option.optionId, stage: 'final', ok: result.issues.length === 0, issues: result.issues });
    if (result.issues.length === 0) {
      final = result;
      used = option;
      usedPicture = url;
      pictureFocus = placed?.focus;
      if (option !== candidate) extraWarnings = [...extraWarnings, { code: 'layout_changed_after_picture', severity: 'warning', message: `the first layout put text over the picture's subject, so ${option.optionId} was used${url ? ' with the same picture' : ' without the picture'}` }];
      break;
    }
    lastFailure = result.issues.map((i) => i.message).join('; ');
    // Only a text-over-subject problem is worth another layout; any other hard failure ends the poster as before.
    if (!result.issues.every((i) => i.code === 'text_over_subject')) break;
  }
  if (!final) return { status: 'render_failed', warnings: [], attempts, chromeVersion: version, failure: `the final measurement failed: ${lastFailure}` };

  const frozen = composePoster({ brief: used.brief, copy: input.copy, brand, font: input.font, mode: { kind: 'frozen', solved: final.solved }, ...(usedPicture ? { pictureUrl: usedPicture } : {}), ...(pictureFocus ? { pictureFocus } : {}) });
  await captureHtml(frozen.html, input.outPng, input.chrome);
  const local = input.font.source === 'local';
  return {
    status: local ? 'render_verified' : 'capture_complete',
    optionId: used.optionId,
    record: used.record,
    solved: final.solved,
    warnings: [...extraWarnings, ...final.warnings],
    attempts,
    chromeVersion: version,
  };
}
