/**
 * The networks a post can be written for, and what each one takes: how long a caption may be, how many hashtags, and the shape of the picture. The names are the
 * publisher's (instagram, facebook, linkedin, google) so a caption written here is the one the publisher sends to that platform (its `variants`).
 */
export const NETWORKS = ['instagram', 'facebook', 'linkedin', 'google'] as const;
export type Network = (typeof NETWORKS)[number];

export const isNetwork = (value: unknown): value is Network => typeof value === 'string' && (NETWORKS as readonly string[]).includes(value);

export interface NetworkRules {
  maxCaption: number;
  maxHashtags: number;
  /** The picture the network gets, in pixels. LinkedIn takes a wide picture; the picture model's nearest wide size is used. */
  picture: { shape: 'square' | 'wide'; width: number; height: number };
  /** What the caption should sound like, in one line for the writer. */
  voice: string;
  /** Whether the closing line says "link in bio": only Instagram cannot carry a clickable link in its caption. */
  linkInBio: boolean;
}

export const NETWORK_RULES: Record<Network, NetworkRules> = {
  instagram: { maxCaption: 1000, maxHashtags: 5, picture: { shape: 'square', width: 1024, height: 1024 }, voice: 'short, warm and visual; two or three short lines; hashtags allowed', linkInBio: true },
  facebook: { maxCaption: 1000, maxHashtags: 3, picture: { shape: 'square', width: 1024, height: 1024 }, voice: 'friendly and conversational, a little longer than Instagram; the web address can be written out', linkInBio: false },
  linkedin: { maxCaption: 1300, maxHashtags: 3, picture: { shape: 'wide', width: 1536, height: 1024 }, voice: 'professional and plain; lead with what the business does for its customers; no slang; few hashtags', linkInBio: false },
  google: { maxCaption: 1000, maxHashtags: 0, picture: { shape: 'square', width: 1024, height: 1024 }, voice: 'plain text, factual, no hashtags and no emoji, as a local business would post on its listing', linkInBio: false },
};

/** One network's own version of a post's caption. `caption` includes the closing call to action line; hashtags are separate. */
export interface PostVariant {
  caption: string;
  hashtags: string[];
  /** True when the writer could not make a version that passed the checks and the main caption was adapted instead. */
  fallback?: boolean;
}
export type PostVariants = Partial<Record<Network, PostVariant>>;

/** What is sent for a network: its caption, then its hashtags. */
export const composeVariant = (variant: PostVariant): string => (variant.hashtags.length > 0 ? `${variant.caption.trim()}\n\n${variant.hashtags.join(' ')}` : variant.caption.trim());

/** The composed caption of each network a post has its own version for, or undefined when it has none. */
export const variantTexts = (post: { variants?: PostVariants }): Record<string, string> | undefined =>
  post.variants && Object.keys(post.variants).length > 0 ? Object.fromEntries(Object.entries(post.variants).map(([network, v]) => [network, composeVariant(v as PostVariant)])) : undefined;
