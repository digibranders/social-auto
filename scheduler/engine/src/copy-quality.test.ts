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
