import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const viewer = new URL('../../../viewer/', import.meta.url);
const source = fs.readFileSync(new URL('app.js', viewer), 'utf8');
const styles = fs.readFileSync(new URL('styles.css', viewer), 'utf8');
const fileId = 'f:first:shared.js';
function fixture() {
  return {
    implementationId: 'browser-review', title: 'Review fixes', summary: 'Browser fixture',
    targetBranch: 'master', baseRevision: 'a'.repeat(40), viewerRevision: 'initial', requirements: [], feedback: [],
    stages: ['first', 'second'].map((id) => ({
      id, title: `Stage ${id}`, summary: 'Summary', rationale: 'Rationale', baseRevision: 'a'.repeat(40), headRevision: 'b'.repeat(40),
      insights: [], specificationRefs: [],
      nodes: ['one', 'two'].map((n) => ({ id: `${id}-${n}`, title: `Step ${n}`, description: 'Node description' })),
      files: [{ path: 'shared.js', kind: 'modified', revision: 'rev', additions: 2, deletions: 0,
        memberships: [{ nodeId: `${id}-one`, classification: 'behavior', hunks: [1] }, { nodeId: `${id}-two`, classification: 'behavior', hunks: [2] }],
        lines: [{ t: 'add', n: 1, s: 'const first = 1;', h: 1 }, { t: 'ctx', o: 2, n: 2, s: '// context' }, { t: 'add', n: 3, s: 'const second = 2;', h: 2 }],
      }],
    })),
  };
}
function thread(id, status = 'open', target = { kind: 'stage', stageId: 'first', label: 'Stage first' }) {
  return { id, status, target, comments: [{ author: 'user', body: `Feedback ${id}`, createdAt: '2026-09-08T10:00:00Z' }] };
}
async function mount(page, data = fixture(), saved = {}) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://viewer.test/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ json: body });
    if (url.pathname === '/api/revision') return json({ ok: true, revision: data.viewerRevision });
    if (url.pathname === '/api/implementation') return json({ ok: true, implementation: data });
    if (url.pathname === '/api/feedback/resolve' || url.pathname === '/api/feedback/reopen') {
      const target = data.feedback.find((t) => t.id === route.request().postDataJSON().threadId);
      target.status = url.pathname.endsWith('resolve') ? 'resolved' : 'open';
      return json({ ok: true, status: target.status });
    }
    if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: source });
    if (url.pathname === '/styles.css') return route.fulfill({ contentType: 'text/css', body: styles });
    if (url.pathname === '/api/diff') return json({ ok: true, lines: data.stages[0].files[0].lines, additions: 2 });
    return route.fulfill({ contentType: 'text/html', body: `<link rel="stylesheet" href="/styles.css"><div id="app"></div><script>window.SEMANTIC_IMPLEMENTATION=${JSON.stringify(data)}</script><script src="/app.js"></script>` });
  });
  await page.addInitScript(({ id, saved }) => {
    if (!localStorage.getItem(`semantic-view:${id}`)) localStorage.setItem(`semantic-view:${id}`, JSON.stringify(saved));
  }, { id: data.implementationId, saved });
  await page.goto('http://viewer.test/');
  await expect(page.locator('.stage')).toHaveCount(2);
  expect(errors).toEqual([]);
  return errors;
}
async function openFile(page, node = 'first-one') {
  if (!await page.locator('.stage[data-stage="first"]').evaluate((el) => el.classList.contains('is-open')))
    await page.locator('.stage-title[data-id="first"]').click();
  const details = page.locator(`details[data-node="${node}"]`);
  if (!await details.evaluate((el) => el.open)) await details.locator('summary').click();
  await details.locator('.frow-open').click();
  await expect(details.locator('.cinema-diff')).toBeVisible();
}
async function showNotes(page) { await page.locator('.tb-btn[data-action="toggle-notes"]').click(); }

test('fresh stages collapse; saved choices restore only for their implementation', async ({ page }) => {
  const data = fixture();
  await mount(page, data);
  await expect(page.locator('.stage.is-open')).toHaveCount(0);
  await page.locator('.stage-title[data-id="second"]').click();
  await page.reload();
  await expect(page.locator('.stage.is-open')).toHaveAttribute('data-stage', 'second');
  data.implementationId = 'another-review';
  await page.reload();
  await expect(page.locator('.stage.is-open')).toHaveCount(0);
});

for (const count of [0, 1, 40]) {
  test(`notes controls stay compact and sticky with ${count} resolved threads`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1100 });
    const data = fixture();
    data.feedback = Array.from({ length: count }, (_, i) => thread(`resolved-${i}`, 'resolved'));
    await mount(page, data);
    await showNotes(page);
    const active = page.locator('.notes-switch-btn[data-filter="active"]');
    const resolved = page.locator('.notes-switch-btn[data-filter="resolved"]');
    const original = await active.boundingBox();
    expect(original.height).toBeLessThan(45);
    await resolved.click();
    expect((await resolved.boundingBox()).height).toBeCloseTo(original.height, 0);
    const list = page.locator('.notes-list');
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    if (count === 40) expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
    const toggle = await page.locator('.notes-switch').boundingBox();
    expect(toggle.y).toBeCloseTo((await list.boundingBox()).y, 0);
    await active.click();
    await expect(page.locator('.notes-col-active .notes-empty')).toBeVisible();
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
    expect(await list.evaluate((el) => el.scrollHeight)).toBeLessThanOrEqual(await list.evaluate((el) => el.clientHeight));
    expect((await active.boundingBox()).height).toBeCloseTo(original.height, 0);
  });
}

test('Ctrl+Enter submits notes and replies, keeps blank inputs, and scopes shared-file comments', async ({ page }) => {
  const errors = await mount(page);
  await openFile(page);
  await page.locator('.file-notes .thread-add').click();
  const input = page.locator('textarea[name="nc-body"]');
  await input.fill('   ');
  await input.press('Control+Enter');
  await expect(input).toBeVisible();
  await input.fill('Only step one');
  await input.press('Enter');
  await expect(input).toBeVisible();
  await input.press('Control+Enter');
  await expect(page.locator('.file-notes')).toContainText('Only step one');
  await expect(page.locator('details[data-node="first-one"] .mini-threads')).toHaveCount(0);
  await expect(page.locator('details[data-node="first-one"] .mini-notes')).toContainText('1');
  await page.locator('.lact[data-id="l:first:new:1:shared.js"]').click();
  await page.locator('.nc-opt').filter({ hasText: 'Feedback' }).click();
  await expect(page.locator('input[name="nc-mode"][value="feedback"]')).toBeChecked();
  await page.locator('textarea[name="nc-body"]').fill('Line in step one');
  await page.locator('textarea[name="nc-body"]').press('Control+Enter');
  await expect(page.locator('details[data-node="first-one"] .mini-lines')).toContainText('1');
  await page.locator('.ownership-notice button').click();
  await expect(page.locator('details[data-node="first-two"] .cinema-diff')).toBeVisible();
  await expect(page.locator('.cinema-diff')).not.toContainText('Only step one');
  await expect(page.locator('.cinema-diff')).not.toContainText('Line in step one');
  await expect(page.locator('details[data-node="first-two"] .mini-count')).toHaveCount(0);
  await showNotes(page);
  const card = page.locator('.side.notes .tnote').filter({ hasText: 'Only step one' });
  await expect(card.locator('xpath=ancestor::div[contains(@class,"note-node")]/h4')).toHaveText('Step one');
  await card.locator('[data-action="jump-to"]').click();
  await expect(page.locator('details[data-node="first-one"] .cinema-diff')).toContainText('Only step one');
  expect(errors).toEqual([]);
});

test('open threads refresh while code remains selected, and edited replies survive refresh', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('live')];
  const errors = await mount(page, data, { openThreads: { first: true } });
  await openFile(page);
  await page.locator('.drow code').first().evaluate((el) => {
    const range = document.createRange(); range.selectNodeContents(el);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  });
  data.feedback[0].comments.push({ author: 'agent', body: 'Addressed by the agent', createdAt: '2026-09-08T10:01:00Z' });
  data.viewerRevision = 'changed';
  await expect(page.locator('.stage .tthread')).toContainText('Addressed by the agent');
  expect(await page.evaluate(() => String(window.getSelection()))).toContain('const first');
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.locator('.stage [data-action="thread-reply"]').click();
  const input = page.locator('.stage textarea[name="reply-body"]');
  await input.fill('Keep my draft');
  data.feedback[0].comments.push({ author: 'agent', body: 'Second update', createdAt: '2026-09-08T10:02:00Z' });
  data.viewerRevision = 'changed-again';
  await expect(page.locator('.stage .tthread')).toContainText('Second update');
  await expect(input).toHaveValue('Keep my draft');
  await input.press('Control+Enter');
  await expect(page.locator('.stage .tmsg-draft')).toContainText('Keep my draft');
  expect(errors).toEqual([]);
});

test('resolve and reopen update global badge, lists, and inline thread immediately', async ({ page }) => {
  const data = fixture(); data.feedback = [thread('resolve-me')];
  await mount(page, data, { openThreads: { first: true } });
  await page.locator('.stage [data-action="thread-resolve"]').click();
  await expect(page.locator('.tb-btn[data-action="toggle-notes"]')).toHaveText('Notes 0');
  await showNotes(page);
  await expect(page.locator('.notes-col-active .notes-empty')).toBeVisible();
  await page.locator('.notes-switch-btn[data-filter="resolved"]').click();
  await page.locator('.notes-col-resolved [data-action="toggle-thread-collapse"]').click();
  await page.locator('.notes-col-resolved [data-action="thread-reopen"]').click();
  await expect(page.locator('.tb-btn[data-action="toggle-notes"]')).toHaveText('Notes 1');
  await page.locator('.notes-switch-btn[data-filter="active"]').click();
  await expect(page.locator('.notes-col-active .tthread')).toHaveCount(1);
});

test('exported local provenance scopes comments; unknown shared-file origins stay in the global list', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('known', 'open', { kind: 'file', stageId: 'first', path: 'shared.js', label: 'shared.js' }), thread('unknown', 'open', { kind: 'line', stageId: 'first', path: 'shared.js', side: 'new', line: 1, label: 'shared.js:1' })];
  await mount(page, data, { comments: [{ kind: 'file', id: fileId, nodeId: 'first-two', exported: true, threadId: 'known', body: 'Feedback known' }] });
  await openFile(page);
  await expect(page.locator('.cinema-diff .tthread')).toHaveCount(0);
  await openFile(page, 'first-two');
  await expect(page.locator('.file-notes .tthread')).toHaveCount(1);
  await showNotes(page);
  const unknown = page.locator('.side.notes [data-thread-id="unknown"]');
  await expect(unknown).toContainText('Original step unknown');
  await expect(unknown.locator('[data-action="jump-to"]')).toHaveCount(0);
});

test('custom tooltips work on focus without native duplicates and dismiss with Escape', async ({ page }) => {
  await mount(page);
  await openFile(page);
  await expect(page.locator('#app [title]')).toHaveCount(0);
  await expect(page.locator('.frow .kind[tabindex], .frow .cls[tabindex], .frow .fp-from[tabindex]')).toHaveCount(0);
  await page.locator('details[data-node="first-one"] .frow-open').focus();
  await expect(page.locator('[role="tooltip"]')).toContainText('this step owns hunk 1');
  const target = page.locator('.cinema-diff [data-action="toggle-hide-removed"]');
  await target.focus();
  await expect(page.locator('[role="tooltip"]')).toContainText('Hide removed lines');
  await expect(target).toHaveAttribute('aria-describedby', 'review-tooltip');
  await target.press('Escape');
  await expect(page.locator('[role="tooltip"]')).not.toHaveClass(/is-shown/);
});

test('editing a draft from the notes panel focuses its visible form and survives a refresh', async ({ page }) => {
  const data = fixture();
  await mount(page, data, { comments: [{ kind: 'file', id: fileId, nodeId: 'first-two', body: 'Edit this note', mode: 'feedback', createdAt: 1 }] });
  await showNotes(page);
  await page.locator('.side.notes [data-action="edit-note"]').click();
  const input = page.locator('.side.notes textarea');
  await expect(input).toBeFocused();
  await input.fill('Updated note');
  data.viewerRevision = 'updated';
  await expect(page.locator('.review-update')).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Updated note');
  await input.press('Control+Enter');
  await expect(page.locator('.side.notes .tnote')).toContainText('Updated note');
  await expect(page.locator('.side.notes .tnote')).toContainText('Draft');
});

test('renamed file comments render under their original node and line anchors fall back to file level', async ({ page }) => {
  const data = fixture();
  data.stages[0].files[0].path = 'renamed.js';
  data.stages[0].files[0].previousPath = 'shared.js';
  data.stages[0].files[0].kind = 'renamed';
  data.feedback = [
    thread('renamed-file', 'open', { kind: 'file', stageId: 'first', path: 'shared.js', label: 'shared.js' }),
    thread('renamed-line', 'open', { kind: 'line', stageId: 'first', path: 'shared.js', side: 'new', line: 1, label: 'shared.js:1' }),
  ];
  const errors = await mount(page, data, { comments: [
    { kind: 'file', id: fileId, nodeId: 'first-two', exported: true, threadId: 'renamed-file' },
    { kind: 'line', id: 'l:first:new:1:shared.js', nodeId: 'first-two', exported: true, threadId: 'renamed-line' },
    { kind: 'file', id: fileId, nodeId: 'first-two', body: 'Local renamed file', mode: 'feedback' },
    { kind: 'line', id: 'l:first:new:1:shared.js', nodeId: 'first-two', body: 'Local renamed line', mode: 'personal' },
  ] });
  await openFile(page, 'first-two');
  await expect(page.locator('.file-notes .tthread')).toHaveCount(4);
  await expect(page.locator('.file-notes [data-thread-id="renamed-line"]')).toContainText('shared.js:1');
  await expect(page.locator('.file-notes [data-thread-id="renamed-line"]')).toContainText('current position is unverified');
  await expect(page.locator('.line-thread .tthread')).toHaveCount(0);
  await expect(page.locator('details[data-node="first-two"] .mini-threads')).toContainText('2');
  await expect(page.locator('details[data-node="first-two"] .mini-lines')).toContainText('1');
  await expect(page.locator('details[data-node="first-two"] .mini-notes')).toContainText('1');
  await openFile(page, 'first-one');
  await expect(page.locator('.file-notes .tthread')).toHaveCount(0);
  await showNotes(page);
  const localFileLabel = page.locator('.side.notes .tnote').filter({ hasText: 'Local renamed file' }).locator('.tthread-title');
  await expect(localFileLabel).toHaveText('renamed.js');
  await expect(localFileLabel).toHaveAttribute('data-tooltip', 'renamed.js');
  await page.locator('.side.notes [data-thread-id="renamed-line"] [data-action="jump-to"]').click();
  await expect(page.locator('details[data-node="first-two"] .file-notes')).toContainText('Feedback renamed-line');
  expect(errors).toEqual([]);
});

test('shared-file jumps stay in their stage when node IDs repeat across stages', async ({ page }) => {
  const data = fixture();
  for (const stage of data.stages) {
    stage.nodes.forEach((node, index) => { node.id = ['one', 'two'][index]; node.title = `${stage.id} ${node.id}`; });
    stage.files[0].memberships.forEach((membership, index) => { membership.nodeId = ['one', 'two'][index]; });
  }
  await mount(page, data);
  await page.locator('.stage-title[data-id="second"]').click();
  const stage = page.locator('.stage[data-stage="second"]');
  await stage.locator('details[data-node="one"] summary').click();
  await stage.locator('details[data-node="one"] .frow-open').click();
  await expect(stage.locator('.ownership-notice')).toContainText('second two');
  await stage.locator('.ownership-notice button').click();
  await expect(stage.locator('details[data-node="two"] .cinema-diff')).toBeVisible();
  await expect(page.locator('.stage[data-stage="first"] details[open]')).toHaveCount(0);
  await stage.locator('[data-action="comment"][data-kind="node"][data-id="one"]').click();
  await expect(page.locator('textarea[name="nc-body"]')).toHaveCount(1);
  await page.locator('textarea[name="nc-body"]').fill('Only the second stage node');
  await page.locator('textarea[name="nc-body"]').press('Control+Enter');
  await expect(page.locator('.stage[data-stage="first"] .tnote')).toHaveCount(0);
  await expect(stage.locator('details[data-node="one"] .tnote')).toContainText('Only the second stage node');
  await showNotes(page);
  await expect(page.locator('.side.notes .tnote .tthread-title')).toHaveText('second one');
});

test('equal node IDs in two stages keep independent note-panel visibility across toggles and reloads', async ({ page }) => {
  const data = fixture();
  for (const stage of data.stages) {
    stage.nodes[0].id = 'same-node';
    stage.files[0].memberships[0].nodeId = 'same-node';
  }
  data.feedback = data.stages.map((stage) => thread(`${stage.id}-thread`, 'open', {
    kind: 'node', stageId: stage.id, nodeId: 'same-node', label: `${stage.id} node`,
  }));
  const errors = await mount(page, data, { openStages: { first: true, second: true }, comments:
    data.stages.map((stage) => ({ kind: 'node', id: 'same-node', stageId: stage.id, mode: 'personal', body: `${stage.id} personal note` })),
  });
  const first = page.locator('.stage[data-stage="first"] details[data-node="same-node"]');
  const second = page.locator('.stage[data-stage="second"] details[data-node="same-node"]');
  await first.locator('summary').click();
  await second.locator('summary').click();
  await first.locator('.notes-toggle').click();
  await expect(first.locator('.thread .tthread')).toHaveCount(2);
  await expect(second.locator('.thread .tthread')).toHaveCount(0);
  await second.locator('.notes-toggle').click();
  await expect(second.locator('.thread .tthread')).toHaveCount(2);
  await first.locator('.notes-toggle').click();
  await expect(first.locator('.thread .tthread')).toHaveCount(0);
  await expect(second.locator('.thread .tthread')).toHaveCount(2);
  await page.reload();
  await expect(first.locator('.notes-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(second.locator('.notes-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(first.locator('.thread .tthread')).toHaveCount(0);
  await expect(second.locator('.thread .tthread')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('unsupported experimental UI records reset while current approvals and drafts survive', async ({ page }) => {
  const saved = {
    specificationOpen: true, active: fileId, activeFiles: {},
    approvals: { [fileId]: true, 'f:second:shared.js': { rev: 'rev', at: 1 } },
    comments: [{ id: fileId, kind: 'file', body: 'Keep my note', at: 1 }],
    replyDrafts: [],
  };
  const errors = await mount(page, fixture(), saved);
  await openFile(page);
  expect(errors).toEqual([]);
  await expect(page.locator('.stage[data-stage="second"] .frow.is-approved')).toHaveCount(2);
  await expect(page.locator('.stage[data-stage="first"] .frow.is-approved')).toHaveCount(0);
  await showNotes(page);
  await expect(page.getByText('Keep my note', { exact: true }).first()).toBeVisible();
});

test('file approvals require revisions and unsupported renamed-file records are ignored', async ({ page }) => {
  const data = fixture();
  data.stages[1].files[0].kind = 'renamed';
  data.stages[1].files[0].previousPath = 'old.js';
  await mount(page, data, { approvals: {
    [fileId]: { rev: null, at: 1 },
    first: { rev: null, at: 1 },
    'f:second:old.js': true,
  } });
  await expect(page.locator('.frow.is-approved, .frow.is-stale, .stage.is-approved')).toHaveCount(0);
});

test('valid changed and renamed file approvals remain stale', async ({ page }) => {
  const data = fixture();
  data.stages[1].files[0].kind = 'renamed';
  data.stages[1].files[0].previousPath = 'old.js';
  await mount(page, data, { approvals: {
    [fileId]: { rev: 'previous', at: 1 },
    'f:second:old.js': { rev: 'previous', at: 1 },
  } });
  await expect(page.locator('.frow.is-stale')).toHaveCount(4);
  await expect(page.locator('.frow.is-approved')).toHaveCount(0);
});
