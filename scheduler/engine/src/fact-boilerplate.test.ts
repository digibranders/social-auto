import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPageFurniture } from './fact-boilerplate.ts';

test('footer lines, legal notices and quote credits are page furniture', () => {
  for (const text of ['© Copyright 2024 By Digibranders.Com', 'All rights reserved.', 'Read our Privacy Policy', 'Terms of Service apply', '- HENRY FORD -', '— Jane Doe']) assert.equal(isPageFurniture(text), true, text);
});

test('what a business says about its work is not furniture', () => {
  for (const text of ['Installation takes under 10 minutes and uses one script tag.', 'We build websites for B2B companies.', 'Book a 15-minute call', 'Our copywriters write in your voice']) assert.equal(isPageFurniture(text), false, text);
});
