/**
 * Page furniture that is not something a business says to its customers: a copyright line, a legal or cookie notice, a bare name or a quote credit.
 * A fact like "© Copyright 2024 By Digibranders.Com" is true and usable by every other check, and still makes a poster about nothing, so it is not
 * offered to the writer. Shape rules only; they never look at industry words.
 */
const LEGAL = /©|\bcopyright\b|\ball rights reserved\b|\bprivacy policy\b|\bterms (?:of|and) (?:use|service|conditions)\b|\bcookie(?:s)? (?:policy|settings|notice)\b/i;

export function isPageFurniture(text: string): boolean {
  const plain = text.replace(/\s+/g, ' ').trim();
  if (plain === '') return true;
  if (LEGAL.test(plain)) return true;
  // A name or credit between dashes ("- HENRY FORD -", "— Jane Doe").
  if (/^[-–—~•]/.test(plain) || /[-–—~•]$/.test(plain)) return plain.split(/[^\p{L}']+/u).filter(Boolean).length <= 5;
  return false;
}
