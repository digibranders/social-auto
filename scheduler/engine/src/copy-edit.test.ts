import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeCaption } from './content.ts';
import { editCopy } from './copy-edit.ts';
import { CopyStage, CopyStageError } from './copy-stage.ts';
import type { EvidenceFact } from './evidence.ts';

const FACT = { id: 'f1', text: 'Setup takes under 10 minutes with one script tag.', status: 'usable', intent: 'claim', attribution: 'brand' } as unknown as EvidenceFact;

function workspace(): { dir: string; stage: CopyStage; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'copy-edit-'));
  const plan = { brand: 'acme', timezone: '+05:30', posts: [
    { id: 'p1', headline: 'Set up in |ten minutes|', subline: '', caption: 'One script tag and the assistant is live on your site.', hashtags: ['#acme', '#setup'], factIds: ['f1'] },
    { id: 'p2', headline: 'Find answers fast', subline: '', caption: 'Search every guide in one place.', hashtags: ['#acme'], factIds: ['f1'] },
  ] };
  writeFileSync(join(dir, 'week-01.json'), JSON.stringify(plan));
  const stage = new CopyStage(dir, 'acme', () => new Date('2026-11-06T10:00:00Z'));
  stage.open('week-01.json', plan.posts.map((p) => ({ postId: p.id, headline: p.headline, caption: composeCaption(p) })));
  return { dir, stage, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const refusal = (work: () => unknown): string => {
  try { work(); } catch (error) { assert.ok(error instanceof CopyStageError, String(error)); return `${error.code}: ${error.message}`; }
  return assert.fail('not refused');
};
const edit = (dir: string, over: Partial<Parameters<typeof editCopy>[0]> = {}) => editCopy({ brandDir: dir, brand: 'acme', planFile: 'week-01.json', postId: 'p1', by: 'owner', facts: [FACT], ...over });

test('a new headline and caption are written into the plan and the list together, and the post is drawn with exactly those words', () => {
  const { dir, stage, done } = workspace();
  try {
    stage.decide('week-01.json', 'p1', 'kept', 'owner');
    const batch = edit(dir, { headline: 'Live in under ten minutes', caption: 'One script tag and you are live on your site in under 10 minutes.' });
    const post = batch.posts[0];
    assert.equal(post?.headline, 'Live in under ten minutes');
    assert.match(post?.caption ?? '', /^One script tag and you are live[\s\S]*#acme #setup$/, 'the hashtags are kept');
    assert.equal(post?.state, 'kept', 'an edited kept post stays kept');
    assert.equal(post?.edited, true);
    const plan = JSON.parse(readFileSync(join(dir, 'week-01.json'), 'utf8')) as { posts: Array<{ id: string; headline: string; caption: string; hashtags: string[] }> };
    assert.equal(plan.posts[0]?.headline, 'Live in under ten minutes');
    assert.equal(plan.posts[1]?.headline, 'Find answers fast', 'other posts are untouched');
    const current = plan.posts.map((p) => ({ postId: p.id, headline: p.headline, caption: composeCaption(p) }));
    assert.deepEqual(stage.toDraw('week-01.json', current), { postIds: ['p1'], changed: [] }, 'what is drawn is what the owner saw');
  } finally {
    done();
  }
});

test('words the writer would have been sent back for are refused with a reason, and nothing changes', () => {
  const { dir, stage, done } = workspace();
  try {
    const before = readFileSync(join(dir, 'week-01.json'), 'utf8');
    assert.match(refusal(() => edit(dir, { headline: '' })), /REJECTED.*empty/);
    assert.match(refusal(() => edit(dir, { headline: 'x'.repeat(61) })), /REJECTED.*at most 60/);
    assert.match(refusal(() => edit(dir, { headline: '- HENRY FORD -' })), /REJECTED.*credit/);
    assert.match(refusal(() => edit(dir, { caption: 'It goes live in under 3 minutes for every customer.' })), /REJECTED.*does not support/);
    assert.match(refusal(() => edit(dir, {})), /INVALID/);
    assert.equal(readFileSync(join(dir, 'week-01.json'), 'utf8'), before);
    assert.equal(stage.get('week-01.json').posts[0]?.edited, undefined);
  } finally {
    done();
  }
});

test('a post that does not exist, a batch that was drawn and a batch that was put away cannot be edited', () => {
  const { dir, stage, done } = workspace();
  try {
    assert.match(refusal(() => edit(dir, { postId: 'zz', headline: 'A different headline here' })), /NOT_FOUND/);
    stage.close('week-01.json', 'owner');
    assert.match(refusal(() => edit(dir, { headline: 'A different headline here' })), /CLOSED/);
  } finally {
    done();
  }
});

test('a batch put away is no longer drawn and its choices are final', () => {
  const { stage, done } = workspace();
  try {
    stage.decide('week-01.json', 'p1', 'kept', 'owner');
    const closed = stage.close('week-01.json', 'owner');
    assert.ok(closed.closedAt);
    assert.match(refusal(() => stage.decide('week-01.json', 'p2', 'kept', 'owner')), /CLOSED/);
    assert.match(refusal(() => stage.markDrawn('week-01.json')), /CLOSED/);
  } finally {
    done();
  }
});

function networkWorkspace(): { dir: string; stage: CopyStage; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'copy-edit-net-'));
  const posts = [{ id: 'p1', headline: 'Set up in |ten minutes|', subline: '', caption: 'One script tag and the assistant is live on your site.\n\nExplore our services at acme.example (link in bio)', hashtags: ['#acme', '#setup'], factIds: ['f1'],
    variants: { instagram: { caption: 'One script tag and the assistant is live on your site.\n\nExplore our services at acme.example (link in bio)', hashtags: ['#acme', '#setup'] }, linkedin: { caption: 'Teams can add the assistant with one script tag.\n\nExplore our services at acme.example', hashtags: ['#acme'], fallback: true } } }];
  writeFileSync(join(dir, 'week-01.json'), JSON.stringify({ brand: 'acme', timezone: '+05:30', posts }));
  const stage = new CopyStage(dir, 'acme', () => new Date('2026-11-06T10:00:00Z'));
  stage.open('week-01.json', [{ postId: 'p1', headline: posts[0]?.headline ?? '', caption: composeCaption(posts[0] as never), captions: { instagram: { text: composeCaption(posts[0] as never) }, linkedin: { text: 'Teams can add the assistant with one script tag.\n\nExplore our services at acme.example\n\n#acme', fallback: true } } }]);
  return { dir, stage, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('one network\'s caption can be changed on its own: the plan, the list and the draw check all follow, and the other networks are untouched', () => {
  const { dir, stage, done } = networkWorkspace();
  try {
    stage.decide('week-01.json', 'p1', 'kept', 'owner');
    const batch = edit(dir, { network: 'linkedin', caption: 'Teams can put the assistant on their site with one script tag in under 10 minutes.\n\nExplore our services at acme.example' });
    const post = batch.posts[0];
    assert.match(post?.captions?.['linkedin']?.text ?? '', /under 10 minutes\.[\s\S]*#acme$/);
    assert.equal(post?.captions?.['linkedin']?.edited, true);
    assert.equal(post?.captions?.['linkedin']?.fallback, undefined, 'an edited caption is no longer the main caption adapted');
    assert.equal(post?.captions?.['instagram']?.edited, undefined);
    const plan = JSON.parse(readFileSync(join(dir, 'week-01.json'), 'utf8')) as { posts: Array<{ caption: string; hashtags: string[]; variants: Record<string, { caption: string; fallback?: boolean }> }> };
    assert.match(plan.posts[0]?.variants['linkedin']?.caption ?? '', /under 10 minutes/);
    assert.equal(plan.posts[0]?.variants['linkedin']?.fallback, undefined);
    assert.match(plan.posts[0]?.caption ?? '', /live on your site/, 'the main caption is unchanged');
    const raw = plan.posts[0];
    const texts = { instagram: composeCaption(raw as never), linkedin: `${raw?.variants['linkedin']?.caption}\n\n#acme` };
    assert.deepEqual(stage.toDraw('week-01.json', [{ postId: 'p1', headline: post?.headline ?? '', caption: composeCaption(raw as never), captions: texts }]), { postIds: ['p1'], changed: [] });
    assert.deepEqual(stage.toDraw('week-01.json', [{ postId: 'p1', headline: post?.headline ?? '', caption: composeCaption(raw as never), captions: { ...texts, linkedin: 'changed behind the owner\'s back' } }]), { postIds: [], changed: ['p1'] }, 'a network caption changed outside the list is not drawn');
  } finally {
    done();
  }
});

test('a network the post has no caption for, and a name that is not a network, are refused', () => {
  const { dir, done } = networkWorkspace();
  try {
    assert.match(refusal(() => edit(dir, { network: 'google', caption: 'Plain text for the listing.' })), /NOT_FOUND.*google/);
    assert.match(refusal(() => edit(dir, { network: 'tiktok', caption: 'Plain text for the listing.' })), /INVALID/);
  } finally {
    done();
  }
});

test('changing Instagram\'s caption changes the main caption and its network version together', () => {
  const { dir, done } = networkWorkspace();
  try {
    const batch = edit(dir, { network: 'instagram', caption: 'The assistant is live on your site with one script tag.\n\nExplore our services at acme.example (link in bio)' });
    const plan = JSON.parse(readFileSync(join(dir, 'week-01.json'), 'utf8')) as { posts: Array<{ caption: string; variants: Record<string, { caption: string }> }> };
    assert.equal(plan.posts[0]?.caption, plan.posts[0]?.variants['instagram']?.caption);
    assert.match(batch.posts[0]?.captions?.['instagram']?.text ?? '', /one script tag\./);
  } finally {
    done();
  }
});

const DEFAULTS = { brandName: 'Acme', domain: 'acme.com' };

test('the brand name and web address of one poster can be changed or left off; the plan and the list follow, and the default wording typed again goes back to the default', () => {
  const { dir, stage, done } = workspace();
  try {
    const batch = edit(dir, { brandName: ' Acme   Labs ', domain: 'https://www.Acme.com/Pricing/', signoffDefaults: DEFAULTS });
    assert.deepEqual(batch.posts[0]?.signoff, { brandName: 'Acme Labs', domain: 'acme.com/Pricing' });
    assert.equal(batch.posts[0]?.edited, true);
    const plan = () => JSON.parse(readFileSync(join(dir, 'week-01.json'), 'utf8')) as { posts: Array<{ id: string; headline: string; signoff?: unknown }> };
    assert.deepEqual(plan().posts[0]?.signoff, { brandName: 'Acme Labs', domain: 'acme.com/Pricing' });
    assert.equal(plan().posts[0]?.headline, 'Set up in |ten minutes|', 'the words and their emphasis are untouched');
    assert.equal(plan().posts[1]?.signoff, undefined, 'other posts keep the default');
    assert.equal(stage.get('week-01.json').posts[1]?.signoff, undefined);

    // Only the piece given changes; the default typed again clears it.
    assert.deepEqual(edit(dir, { domain: 'shop.acme.com', signoffDefaults: DEFAULTS }).posts[0]?.signoff, { brandName: 'Acme Labs', domain: 'shop.acme.com' });
    assert.deepEqual(edit(dir, { brandName: 'Acme', signoffDefaults: DEFAULTS }).posts[0]?.signoff, { domain: 'shop.acme.com' });
    const cleared = edit(dir, { domain: 'acme.com', signoffDefaults: DEFAULTS });
    assert.equal(cleared.posts[0]?.signoff, undefined);
    assert.equal(plan().posts[0]?.signoff, undefined);
  } finally {
    done();
  }
});

test('an empty brand name or web address leaves that line off the poster, and the default typed again brings it back', () => {
  const { dir, done } = workspace();
  try {
    const plan = () => JSON.parse(readFileSync(join(dir, 'week-01.json'), 'utf8')) as { posts: Array<{ signoff?: unknown }> };
    assert.deepEqual(edit(dir, { brandName: '', domain: '', signoffDefaults: DEFAULTS }).posts[0]?.signoff, { brandName: '', domain: '' });
    assert.deepEqual(plan().posts[0]?.signoff, { brandName: '', domain: '' });
    assert.deepEqual(edit(dir, { brandName: '   ', signoffDefaults: DEFAULTS }).posts[0]?.signoff, { brandName: '', domain: '' }, 'only spaces is empty too');
    assert.deepEqual(edit(dir, { domain: 'acme.com', signoffDefaults: DEFAULTS }).posts[0]?.signoff, { brandName: '' }, 'one line back, the other still off');
    assert.equal(edit(dir, { brandName: 'Acme', signoffDefaults: DEFAULTS }).posts[0]?.signoff, undefined, 'both back: nothing is stored');
  } finally {
    done();
  }
});

test('a brand name or address that is not allowed is refused and nothing changes', () => {
  const { dir, done } = workspace();
  try {
    const before = readFileSync(join(dir, 'week-01.json'), 'utf8');
    assert.match(refusal(() => edit(dir, { brandName: 'x'.repeat(41), signoffDefaults: DEFAULTS })), /REJECTED.*at most 40/);
    assert.match(refusal(() => edit(dir, { brandName: 'Acme "Pro"', signoffDefaults: DEFAULTS })), /REJECTED.*quotation marks/);
    assert.match(refusal(() => edit(dir, { domain: 'not an address', signoffDefaults: DEFAULTS })), /REJECTED.*does not look like a web address/);
    assert.match(refusal(() => edit(dir, { domain: 'rival.com', signoffDefaults: DEFAULTS })), /REJECTED.*client's own website \(acme\.com\)/);
    assert.match(refusal(() => edit(dir, { domain: 'acme.com.evil.io', signoffDefaults: DEFAULTS })), /REJECTED.*own website/);
    assert.match(refusal(() => edit(dir, { domain: `acme.com/${'a'.repeat(60)}`, signoffDefaults: DEFAULTS })), /REJECTED.*at most 60/);
    assert.match(refusal(() => edit(dir, { brandName: 'Acme Labs' })), /REJECTED.*no name or website saved/);
    assert.equal(readFileSync(join(dir, 'week-01.json'), 'utf8'), before);
  } finally {
    done();
  }
});

test('a caption longer than the network takes is refused when the owner makes it, but one that was already there can still be left as it is', () => {
  const { dir, done } = workspace();
  try {
    // 700 characters is more than Instagram's most (600): refused when typed.
    const long = [
      'Setup takes under 10 minutes with one script tag.',
      'The assistant answers from your own pages and guides.',
      'Visitors ask in their own words and get a plain reply.',
      'Your team keeps control of what the assistant may say.',
      'Questions it cannot answer are passed to a person.',
      'Everything it reads comes from content you already publish.',
      'Changes to your pages reach the assistant without extra work.',
      'It fits the look of your site instead of fighting it.',
      'Customers find what they need without searching menus.',
      'Your support inbox stays quiet on the simple questions.',
      'People who want a human can still reach one quickly.',
      'The assistant speaks the way your brand does.',
    ].join(' ');
    assert.ok(long.length > 600);
    assert.match(refusal(() => edit(dir, { caption: long, network: 'instagram' })), /REJECTED.*at most 600|REJECTED.*600/);
    // A caption already in the plan that is over today's most is not refused when only the sign-off is changed (the page sends the caption back as it is).
    const planPath = join(dir, 'week-01.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as { posts: Array<{ id: string; caption: string }> };
    (plan.posts[0] as { caption: string }).caption = long;
    writeFileSync(planPath, JSON.stringify(plan));
    const batch = edit(dir, { caption: long, network: 'instagram', brandName: 'Acme Labs', signoffDefaults: { brandName: 'Acme', domain: 'acme.com' } });
    assert.equal(batch.posts[0]?.signoff?.brandName, 'Acme Labs');
  } finally {
    done();
  }
});
