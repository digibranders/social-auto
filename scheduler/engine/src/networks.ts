/**
 * The networks a post can be written for, and what each one takes: how long a caption may be, how many hashtags, and the shape of the picture. The names are the
 * publisher's (instagram, facebook, linkedin, google) so a caption written here is the one the publisher sends to that platform (its `variants`).
 */
export const NETWORKS = ['instagram', 'facebook', 'linkedin', 'google'] as const;
export type Network = (typeof NETWORKS)[number];

export const isNetwork = (value: unknown): value is Network => typeof value === 'string' && (NETWORKS as readonly string[]).includes(value);

export interface NetworkRules {
  /** The longest caption the owner or the writer may use for the network (the words, not the hashtags). Shorter than what the platform itself allows. */
  maxCaption: number;
  /** The length worth aiming for, in characters: readers of a business post read the start and stop. Advice, never a limit. */
  recommended: { min: number; max: number };
  /** About how many characters a reader sees before the platform folds the caption behind "more". An estimate, and the platforms change it. */
  visibleChars: number;
  maxHashtags: number;
  /** The picture the network gets, in pixels. LinkedIn takes a wide picture; the picture model's nearest wide size is used. */
  picture: { shape: 'square' | 'wide'; width: number; height: number };
  /** What the caption should sound like, in one line for the writer. */
  voice: string;
  /** Whether the closing line says "link in bio": only Instagram cannot carry a clickable link in its caption. */
  linkInBio: boolean;
}

export const NETWORK_RULES: Record<Network, NetworkRules> = {
  instagram: { maxCaption: 800, recommended: { min: 300, max: 600 }, visibleChars: 125, maxHashtags: 5, picture: { shape: 'square', width: 1024, height: 1024 }, voice: 'short, warm and visual; two or three short lines; hashtags allowed', linkInBio: true },
  facebook: { maxCaption: 800, recommended: { min: 300, max: 600 }, visibleChars: 125, maxHashtags: 3, picture: { shape: 'square', width: 1024, height: 1024 }, voice: 'friendly and conversational, a little longer than Instagram; the web address can be written out', linkInBio: false },
  linkedin: { maxCaption: 1500, recommended: { min: 900, max: 1200 }, visibleChars: 125, maxHashtags: 3, picture: { shape: 'wide', width: 1536, height: 1024 }, voice: 'professional and plain; lead with what the business does for its customers; no slang; few hashtags', linkInBio: false },
  google: { maxCaption: 1000, recommended: { min: 150, max: 300 }, visibleChars: 100, maxHashtags: 0, picture: { shape: 'square', width: 1024, height: 1024 }, voice: 'plain text, factual, no hashtags and no emoji, as a local business would post on its listing', linkInBio: false },
};

/** One network's own version of a post's caption. `caption` includes the closing call to action line; hashtags are separate. */
export interface PostVariant {
  caption: string;
  hashtags: string[];
  /** True when the writer could not make a version that passed the checks and the main caption was adapted instead. */
  fallback?: boolean;
}
export type PostVariants = Partial<Record<Network, PostVariant>>;

import { tidyPunctuation } from './caption-text.ts';

/** What is sent for a network: its caption, then its hashtags. */
export const composeVariant = (variant: PostVariant): string => {
  const words = tidyPunctuation(variant.caption.trim());
  return variant.hashtags.length > 0 ? `${words}\n\n${variant.hashtags.join(' ')}` : words;
};

/** The composed caption of each network a post has its own version for, or undefined when it has none. */
export const variantTexts = (post: { variants?: PostVariants }): Record<string, string> | undefined =>
  post.variants && Object.keys(post.variants).length > 0 ? Object.fromEntries(Object.entries(post.variants).map(([network, v]) => [network, composeVariant(v as PostVariant)])) : undefined;

export type PictureShape = NetworkRules['picture'];
export const SQUARE_SHAPE: PictureShape = { shape: 'square', width: 1024, height: 1024 };

/**
 * The pictures a batch of posts needs: every network a post is written for gets a picture of its own (a different composition of the same topic), so a post
 * written for Instagram, Facebook, Google and LinkedIn needs four. The square pictures come first, in network order, and the wide one for LinkedIn last.
 * A post without network captions needs one square picture, drawn for no network in particular.
 */
export function pictureGroups(posts: ReadonlyArray<{ id: string; variants?: PostVariants }>): Array<{ shape: PictureShape; networks: Network[]; postIds: string[] }> {
  const plain = new Set<string>();
  const byNetwork = new Map<Network, Set<string>>();
  for (const post of posts) {
    const own = NETWORKS.filter((n) => post.variants?.[n] !== undefined);
    if (own.length === 0) plain.add(post.id);
    for (const network of own) byNetwork.set(network, (byNetwork.get(network) ?? new Set<string>()).add(post.id));
  }
  const groups: Array<{ shape: PictureShape; networks: Network[]; postIds: string[] }> = [];
  if (plain.size > 0) groups.push({ shape: SQUARE_SHAPE, networks: [], postIds: [...plain] });
  const asked = NETWORKS.filter((n) => byNetwork.has(n));
  for (const network of [...asked.filter((n) => NETWORK_RULES[n].picture.shape === 'square'), ...asked.filter((n) => NETWORK_RULES[n].picture.shape !== 'square')]) {
    groups.push({ shape: NETWORK_RULES[network].picture, networks: [network], postIds: [...(byNetwork.get(network) as Set<string>)] });
  }
  return groups;
}

/** What each network's picture is asked to look like, so the pictures of one topic differ from each other (the facts, the headline and the look stay the same). */
export const COMPOSITION_BY_NETWORK: Record<Network, string> = {
  instagram: 'The strongest, most direct picture of the idea: one clear subject, close and bold, the kind of image that stops a scroll.',
  facebook: 'A warmer, wider view: the idea shown in its everyday setting, with people or a place around it, and a different camera angle from the Instagram picture.',
  linkedin: 'A calm, professional view for a business reader: the idea at work in a real setting, composed for a wide frame, with room to breathe.',
  google: 'A plain, factual view for someone searching nearby: the product or service shown simply and honestly, a different scene from the social pictures.',
};

/** The length worth aiming for, in words for the writer, e.g. "about 100 to 300 characters". */
export const recommendedLengthText = (network: Network): string => `about ${NETWORK_RULES[network].recommended.min} to ${NETWORK_RULES[network].recommended.max} characters`;

/** What the owner's page needs to know about every network's captions. */
export const captionRulesView = (): Record<Network, { maxCaption: number; recommendedMin: number; recommendedMax: number; visibleChars: number; maxHashtags: number }> =>
  Object.fromEntries(NETWORKS.map((n) => [n, { maxCaption: NETWORK_RULES[n].maxCaption, recommendedMin: NETWORK_RULES[n].recommended.min, recommendedMax: NETWORK_RULES[n].recommended.max, visibleChars: NETWORK_RULES[n].visibleChars, maxHashtags: NETWORK_RULES[n].maxHashtags }])) as Record<Network, { maxCaption: number; recommendedMin: number; recommendedMax: number; visibleChars: number; maxHashtags: number }>;
