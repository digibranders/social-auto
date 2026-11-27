import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCopyQuality } from './copy-quality.ts';

const CTA = '\n\nExplore our services at digibranders.com (link in bio)\n\n#Digital #Business';

test('the posts the Digibranders run wrote badly are turned back', () => {
  assert.match(checkCopyQuality({ headline: '- |HENRY FORD| -', caption: `- HENRY FORD -${CTA}` }) ?? '', /name or a quote credit/);
  assert.match(checkCopyQuality({ headline: 'Could your |Digital Impact| be amplified?', caption: `Could your Digital Impact be amplified?  Amplify your Digital Impact.${CTA}` }) ?? '', /same thing twice|repeats the headline/);
});

test('good posts pass, including one whose caption opens by echoing its headline once', () => {
  assert.equal(checkCopyQuality({ headline: 'From |staying ahead| to |driving leads|', caption: `Looking for a partner focused on growth? Partner with us to stay ahead of the curve and grow your business.${CTA}` }), undefined);
  assert.equal(checkCopyQuality({ headline: 'It |Starts with a Conversation|', caption: `At Digibranders, it starts with a conversation. Tell us where you want to be in a year.${CTA}` }), undefined);
});

test('a headline needs three words and may not begin or end with a dash', () => {
  assert.match(checkCopyQuality({ headline: 'Grow faster', caption: 'x' }) ?? '', /too short/);
  assert.match(checkCopyQuality({ headline: 'Grow your reach today —', caption: 'x' }) ?? '', /quote credit/);
});

test('the web-address and hashtag lines are not counted as the post\'s own sentences', () => {
  assert.equal(checkCopyQuality({ headline: 'Build a site that sells', caption: `We build fast sites.\n\nExplore our services at digibranders.com (link in bio)\nExplore our services at digibranders.com (link in bio)\n#Web` }), undefined);
});

import { ownWordsLength } from './copy-quality.ts';
import { validateDraft } from './planner.ts';

test('a caption\'s own words leave out the hashtags and the closing address line', () => {
  const caption = 'Reports only help when you can read them. We help you track them.\n\nVisit acme.example (link in bio)\n\n#Reports #Tracking';
  assert.equal(ownWordsLength(caption), 'Reports only help when you can read them. We help you track them.'.length);
});

test('a caption shorter than the minimum is sent back, a long enough one is accepted, and without a minimum nothing changes', () => {
  const base = { visual: 'a desk', visualLink: 'shows the topic', subline: 'Acme', headline: 'Reports you can read', hashtags: ['#a'] };
  const short = { ...base, caption: 'Track your reports.' };
  const long = { ...base, caption: 'Reports only help when you can read them. Acme lets you track and analyze your business reports, so you can see what is happening and decide what to do next. Less digging through numbers, more clarity on where you stand.' };
  assert.throws(() => validateDraft(short as never, 1, 'Acme', [], undefined, { optionalSubline: true, minCaption: 200 }), /caption is too short/);
  assert.doesNotThrow(() => validateDraft(long as never, 1, 'Acme', [], undefined, { optionalSubline: true, minCaption: 200 }));
  assert.doesNotThrow(() => validateDraft(short as never, 1, 'Acme', [], undefined, { optionalSubline: true }));
});
