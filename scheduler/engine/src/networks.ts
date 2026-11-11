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
  instagram: { maxCaption: 600, recommended: { min: 100, max: 300 }, visibleChars: 125, maxHashtags: 5, picture: { shape: 'square', width: 1024, height: 1024 }, voice: 'short, warm and visual; two or three short lines; hashtags allowed', linkInBio: true },
  facebook: { maxCaption: 600, recommended: { min: 100, max: 250 }, visibleChars: 125, maxHashtags: 3, picture: { shape: 'square', width: 1024, height: 1024 }, voice: 'friendly and conversational, a little longer than Instagram; the web address can be written out', linkInBio: false },
  linkedin: { maxCaption: 1300, recommended: { min: 400, max: 800 }, visibleChars: 140, maxHashtags: 3, picture: { shape: 'wide', width: 1536, height: 1024 }, voice: 'professional and plain; lead with what the business does for its customers; no slang; few hashtags', linkInBio: false },
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
 * The pictures a batch of posts needs: networks of the same shape share one picture, so a post written for Instagram, Facebook and Google needs one square
 * picture and LinkedIn adds one wide one. A post without network captions needs the square one only. Square comes first.
 */
export function pictureGroups(posts: ReadonlyArray<{ id: string; variants?: PostVariants }>): Array<{ shape: PictureShape; networks: Network[]; postIds: string[] }> {
  const groups = new Map<string, { shape: PictureShape; networks: Set<Network>; postIds: Set<string> }>();
  const group = (shape: PictureShape) => groups.get(shape.shape) ?? (groups.set(shape.shape, { shape, networks: new Set(), postIds: new Set() }), groups.get(shape.shape) as { shape: PictureShape; networks: Set<Network>; postIds: Set<string> });
  for (const post of posts) {
    const own = NETWORKS.filter((n) => post.variants?.[n] !== undefined);
    if (own.length === 0) group(SQUARE_SHAPE).postIds.add(post.id);
    for (const network of own) {
      const g = group(NETWORK_RULES[network].picture);
      g.networks.add(network);
      g.postIds.add(post.id);
    }
  }
  return [...groups.values()].sort((a, b) => (a.shape.shape === 'square' ? 0 : 1) - (b.shape.shape === 'square' ? 0 : 1)).map((g) => ({ shape: g.shape, networks: [...g.networks], postIds: [...g.postIds] }));
}

/** The length worth aiming for, in words for the writer, e.g. "about 100 to 300 characters". */
export const recommendedLengthText = (network: Network): string => `about ${NETWORK_RULES[network].recommended.min} to ${NETWORK_RULES[network].recommended.max} characters`;

/** What the owner's page needs to know about every network's captions. */
export const captionRulesView = (): Record<Network, { maxCaption: number; recommendedMin: number; recommendedMax: number; visibleChars: number; maxHashtags: number }> =>
  Object.fromEntries(NETWORKS.map((n) => [n, { maxCaption: NETWORK_RULES[n].maxCaption, recommendedMin: NETWORK_RULES[n].recommended.min, recommendedMax: NETWORK_RULES[n].recommended.max, visibleChars: NETWORK_RULES[n].visibleChars, maxHashtags: NETWORK_RULES[n].maxHashtags }])) as Record<Network, { maxCaption: number; recommendedMin: number; recommendedMax: number; visibleChars: number; maxHashtags: number }>;
