/**
 * Which brands belong to a product (an outside application that lets its own customers review posters), kept in one small file beside the brand folders.
 *
 * A product-owned brand is decided by its customer only: the review service refuses staff changes to it, and refuses any other product's requests for it.
 * The brand's name is chosen by the product, never taken from the website, so two customers with the same website are two brands that never meet.
 * An entry is written once and never changed or removed here.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock } from './file-lock.ts';

export const BRAND_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const PRODUCT_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;

export interface ProductBrand {
  productId: string;
  createdAt: string;
}

export type ClaimResult = 'created' | 'owned' | 'taken';

export class ProductBrands {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly now: () => Date;
  constructor(brandsRoot: string, now: () => Date = () => new Date()) {
    this.file = join(brandsRoot, '.product-brands.json');
    this.lockFile = join(brandsRoot, '.product-brands.lock');
    this.now = now;
  }

  private read(): Record<string, ProductBrand> {
    if (!existsSync(this.file)) return {};
    const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { brands?: Record<string, ProductBrand> };
    return parsed.brands ?? {};
  }

  /** The product that owns this brand, or null when it is one of ours (staff-managed). */
  get(brand: string): ProductBrand | null {
    return this.read()[brand] ?? null;
  }

  has(brand: string): boolean {
    return this.get(brand) !== null;
  }

  /** Every product-owned brand. */
  all(): string[] {
    return Object.keys(this.read());
  }

  /** The brands one product owns. */
  ownedBy(productId: string): string[] {
    return Object.entries(this.read()).filter(([, entry]) => entry.productId === productId).map(([brand]) => brand);
  }

  /**
   * Registers a brand for a product. "taken" when the name belongs to someone else, or is already in use by a brand that is not product-owned
   * (a folder or a request already exists under that name): a product can never take over one of our own clients.
   */
  claim(brand: string, productId: string, inUse: () => boolean): ClaimResult {
    if (!BRAND_NAME.test(brand) || !PRODUCT_ID.test(productId)) throw new Error('a brand and a product must be lowercase letters, digits and dashes');
    mkdirSync(join(this.file, '..'), { recursive: true });
    return withFileLock(this.lockFile, () => {
      const all = this.read();
      const existing = all[brand];
      if (existing) return existing.productId === productId ? 'owned' : 'taken';
      if (inUse()) return 'taken';
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ brands: { ...all, [brand]: { productId, createdAt: this.now().toISOString() } } }, null, 2)}\n`);
      renameSync(temp, this.file);
      return 'created';
    }, { timeoutMs: 5000 });
  }
}
