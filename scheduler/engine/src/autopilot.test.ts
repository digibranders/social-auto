import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugFromSite } from './analyze.ts';
import { chooseStartDate, tomorrowAt } from './autopilot.ts';
import { collectColors, htmlToText } from './crawl.ts';
import { scheduleDates } from './planner.ts';
import { captionToHtml } from './scheduler-client.ts';

test('slugFromSite uses the first domain label', () => {
  assert.equal(slugFromSite('brandbasket.in'), 'brandbasket');
  assert.equal(slugFromSite('https://www.Cafe-Moon.co.uk/menu'), 'cafe-moon');
});

test('scheduleDates gives consecutive days at the same local time', () => {
  assert.deepEqual(scheduleDates({ startDate: '2026-10-31', time: '10:00', utcOffset: '+05:30', count: 3 }), [
    '2026-10-31T10:00:00+05:30',
    '2026-11-01T10:00:00+05:30',
    '2026-11-02T10:00:00+05:30',
  ]);
  assert.throws(() => scheduleDates({ startDate: '31-10-2026', time: '10:00', utcOffset: '+05:30', count: 1 }));
});

test('tomorrowAt respects the UTC offset across midnight', () => {
  // 20:00 UTC on 28 Oct is already 01:30 on 29 Oct in India, so "tomorrow" is 30 Oct.
  assert.equal(tomorrowAt('+05:30', new Date('2026-10-28T20:00:00Z')), '2026-10-30');
  assert.equal(tomorrowAt('-05:00', new Date('2026-10-28T02:00:00Z')), '2026-10-28');
});

test('chooseStartDate continues after the last planned post but never before tomorrow', () => {
  assert.equal(chooseStartDate('2026-11-04', '2026-10-29'), '2026-11-05');
  assert.equal(chooseStartDate('2026-10-20', '2026-10-29'), '2026-10-29');
  assert.equal(chooseStartDate(null, '2026-10-29'), '2026-10-29');
  assert.equal(chooseStartDate('2026-12-31', '2026-10-29'), '2027-01-01');
});

test('collectColors normalises and ranks hex colours', () => {
  assert.deepEqual(collectColors(['#c48a47 #fff', 'color:#C48A47; background:#FFFFFF; #123']).slice(0, 3), [
    '#C48A47',
    '#FFFFFF',
    '#112233',
  ]);
});

test('htmlToText drops scripts, nav and tags', () => {
  const html = '<nav>Menu</nav><script>x()</script><h1>Hello &amp; welcome</h1><p>Free&nbsp;build</p>';
  assert.equal(htmlToText(html), 'Hello & welcome Free build');
});

test('captionToHtml keeps blank lines and escapes markup', () => {
  assert.equal(captionToHtml('Hi <b>\n\nBye'), '<p>Hi &lt;b&gt;</p><p></p><p>Bye</p>');
});
