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

const fail = (message: string): Issue => ({ code: 'measurement_incomplete', severity: 'hard', message });

async function measure(candidate: RenderCandidate, input: RenderInput, pictureUrl: string | undefined, expectImages: number, brand: PosterBrand = input.brand): Promise<{ issues: Issue[]; warnings: Issue[]; solved: Record<string, number> }> {
  let composed;
  try {
    composed = composePoster({ brief: candidate.brief, copy: input.copy, brand, font: input.font, mode: { kind: 'measure' }, ...(pictureUrl ? { pictureUrl } : {}) });
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
  const judged = judgeReport(report, { slots: ['headline'], images: expectImages, contrast: composed.contrast });
  return { issues: judged.hard, warnings: judged.warnings, solved: judged.solved };
}

export async function renderPoster(input: RenderInput): Promise<RenderOutcome> {
  const version = await chromeVersion(input.chrome);
  const attempts: Attempt[] = [];
  let chosen: { candidate: RenderCandidate; solved: Record<string, number> } | undefined;
  let omitIdentity = false;
  let extraWarnings: Issue[] = [];

  for (const candidate of input.candidates) {
    let result = await measure(candidate, input, undefined, 0);
    attempts.push({ optionId: candidate.optionId, stage: 'preflight', ok: result.issues.length === 0, issues: result.issues });
    // An identity line too long for its slot is dropped rather than failing the poster: it is an optional brand element, never invented or shortened, and the report says so.
    const onlyIdentity = result.issues.length > 0 && result.issues.every((i) => i.slot === 'identity' || (i.code === 'collision' && i.message.includes('"identity"')));
    if (onlyIdentity && input.brand.identityLine) {
      const trimmed: PosterBrand = { ...input.brand };
      delete trimmed.identityLine;
      const retry = await measure(candidate, input, undefined, 0, trimmed);
      attempts.push({ optionId: candidate.optionId, stage: 'preflight', ok: retry.issues.length === 0, issues: retry.issues });
      if (retry.issues.length === 0) {
        omitIdentity = true;
        result = { ...retry, warnings: [...retry.warnings, { code: 'identity_omitted', severity: 'warning', message: 'the identity line did not fit its slot at the smallest size, so the poster is drawn without it' }] };
      }
    }
    if (result.issues.length === 0) {
      chosen = { candidate, solved: result.solved };
      extraWarnings = result.warnings.filter((w) => w.code === 'identity_omitted');
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

  const brand: PosterBrand = omitIdentity ? { ...input.brand, ...{} } : input.brand;
  if (omitIdentity) delete brand.identityLine;
  const final = await measure(candidate, input, pictureUrl, pictureUrl ? 1 : 0, brand);
  attempts.push({ optionId: candidate.optionId, stage: 'final', ok: final.issues.length === 0, issues: final.issues });
  if (final.issues.length > 0) {
    return { status: 'render_failed', warnings: final.warnings, attempts, chromeVersion: version, failure: `the final measurement failed: ${final.issues.map((i) => i.message).join('; ')}` };
  }

  const frozen = composePoster({ brief: candidate.brief, copy: input.copy, brand, font: input.font, mode: { kind: 'frozen', solved: final.solved }, ...(pictureUrl ? { pictureUrl } : {}) });
  await captureHtml(frozen.html, input.outPng, input.chrome);
  const local = input.font.source === 'local';
  return {
    status: local ? 'render_verified' : 'capture_complete',
    optionId: candidate.optionId,
    record: candidate.record,
    solved: final.solved,
    warnings: [...extraWarnings, ...final.warnings],
    attempts,
    chromeVersion: version,
  };
}
