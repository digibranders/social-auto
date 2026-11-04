import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooserPage } from './google-choose.ts';
import { parseChoices } from './google-publisher.ts';

test('the chooser lists each location as a button and escapes names that came from Google', () => {
  const html = chooserPage([{ id: '100', title: 'Cafe One' }, { id: '101', title: '<script>alert("x")</script> & Sons' }]);
  assert.match(html, /<form method="post" action="\/api\/google\/choose">/);
  assert.match(html, /name="location" value="100">Cafe One</);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; Sons/);
  assert.ok(!/<script|style=|onclick/i.test(html));
});

test('only a well-formed list of locations is accepted from the publisher', () => {
  assert.deepEqual(parseChoices({ locations: [{ id: '100', title: 'A' }] }), [{ id: '100', title: 'A' }]);
  assert.equal(parseChoices(null), null);
  assert.equal(parseChoices({}), null);
  assert.equal(parseChoices({ locations: [{ id: 'abc', title: 'A' }] }), null);
  assert.equal(parseChoices({ locations: [{ id: '1' }] }), null);
});
