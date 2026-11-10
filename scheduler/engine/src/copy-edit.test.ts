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
