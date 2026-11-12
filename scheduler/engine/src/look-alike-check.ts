/**
 * After the pictures of a topic are drawn for several networks, they are compared side by side: two that are clearly the same scene (the same people around the
 * same laptop) are not what the customer asked for when she wanted each network to have a picture of its own. The later network of such a pair is drawn once more,
 * told to choose a clearly different scene; it is never drawn a third time, and when the second try is not accepted the first picture stays. The comparison is
 * best effort: if it cannot be made, nothing is redrawn.
 */
import { NETWORKS, type Network } from './networks.ts';
import type { LookAlikes } from './creative-director.ts';

export interface DrawnPicture {
  postId: string;
  network: Network;
  file: string;
}

export interface Flagged {
  postId: string;
  /** The network whose picture is drawn again (the later of the pair). */
  network: Network;
  /** The network whose picture it looked like. */
  alikeWith: Network;
  why: string;
}

const idOf = (p: { postId: string; network: Network }): string => `${p.postId}|${p.network}`;
const rank = (n: Network): number => NETWORKS.indexOf(n);

/** The pictures to draw again: for each topic with two or more pictures, the later network of every pair the comparison found clearly alike (each picture at most once). */
export async function flagAlike(pictures: readonly DrawnPicture[], lookAlikes: (posters: ReadonlyArray<{ id: string; file: string }>) => Promise<LookAlikes>, log: (message: string) => void = () => undefined): Promise<Flagged[]> {
  const flagged: Flagged[] = [];
  const topics = [...new Set(pictures.map((p) => p.postId))];
  for (const postId of topics) {
    const own = pictures.filter((p) => p.postId === postId);
    if (own.length < 2) continue;
    try {
      const found = await lookAlikes(own.map((p) => ({ id: idOf(p), file: p.file })));
      for (const pair of found.scenes) {
        const a = own.find((p) => idOf(p) === pair.a);
        const b = own.find((p) => idOf(p) === pair.b);
        if (!a || !b) continue;
        const [first, second] = rank(a.network) <= rank(b.network) ? [a, b] : [b, a];
        if (flagged.some((f) => f.postId === postId && f.network === second.network)) continue;
        flagged.push({ postId, network: second.network, alikeWith: first.network, why: pair.why });
      }
    } catch (error) {
      log(`${postId}: the pictures could not be compared (${error instanceof Error ? error.message : String(error)}), so none is drawn again`);
    }
  }
  return flagged;
}

/** The instruction for the second try: the same topic, a clearly different scene from the picture it looked like. */
export const differentScene = (f: Flagged): string =>
  `The first picture for this network looked too much like the picture made for ${f.alikeWith}${f.why ? ` (${f.why})` : ''}. Choose a clearly different scene, subject and camera angle, about the same topic and the brand's own business.`;

/**
 * Draws the flagged pictures once more. `redraw` makes the new picture and answers its file when it was accepted, or null; an error (a limit reached, a failed call)
 * leaves that picture as it was. Answers what was replaced.
 */
export async function redrawAlike(input: {
  pictures: readonly DrawnPicture[];
  lookAlikes: (posters: ReadonlyArray<{ id: string; file: string }>) => Promise<LookAlikes>;
  redraw: (flagged: Flagged, note: string) => Promise<{ file: string } | null>;
  log?: (message: string) => void;
}): Promise<Array<{ flagged: Flagged; file: string }>> {
  const log = input.log ?? ((): undefined => undefined);
  const replaced: Array<{ flagged: Flagged; file: string }> = [];
  for (const flagged of await flagAlike(input.pictures, input.lookAlikes, log)) {
    log(`${flagged.postId}: the ${flagged.network} picture looks like the ${flagged.alikeWith} one, so it is drawn once more`);
    try {
      const again = await input.redraw(flagged, differentScene(flagged));
      if (again) replaced.push({ flagged, file: again.file });
      else log(`${flagged.postId}: the second ${flagged.network} picture was not accepted, so the first stays`);
    } catch (error) {
      log(`${flagged.postId}: the second ${flagged.network} picture could not be made (${error instanceof Error ? error.message : String(error)}), so the first stays`);
    }
  }
  return replaced;
}
