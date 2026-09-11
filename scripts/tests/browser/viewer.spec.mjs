import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const viewer = new URL('../../../viewer/', import.meta.url);
const source = fs.readFileSync(new URL('app.js', viewer), 'utf8');
const styles = fs.readFileSync(new URL('styles.css', viewer), 'utf8');
const fileId = 'f:first:shared.js';
const approvalKey = (stage, node, file = 'shared.js') => `m:${JSON.stringify([stage, node, file])}`;
const firstMembershipRevision = JSON.stringify(['rev', 'a'.repeat(40), 'behavior', [1], null]);
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
async function mount(page, data = fixture(), saved = {}, other = []) {
  const allData = [data, ...other];
  const records = allData.map((item) => ({ id: item.reviewId || item.implementationId, generation: "test", title: item.title, implementationId: item.implementationId, repositoryRoot: `/repos/${item.reviewId || item.implementationId}`, updatedAt: "2026-09-11T10:00:00Z", completedAt: null, available: true }));
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  const stores = new Map();
  const attachments = new Map();
  const deleted = new Set();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://viewer.test/**', async (route) => {
    const url = new URL(route.request().url());
    const currentData = allData.find((item) => (item.reviewId || item.implementationId) === (url.searchParams.get('review') || url.pathname.slice(1))) || data;
    const currentId = currentData.reviewId || currentData.implementationId;
    const json = (body) => route.fulfill({ json: body });
    if (url.pathname === '/api/reviews') return json({ ok: true, reviews: records });
    if (url.pathname === '/api/reviews/storage') {
      const input = route.request().postDataJSON(), review = records.find((record) => record.id === input.reviewId), state = stores.get(input.reviewId) || {};
      const drafts = (state.comments || []).filter((note) => !note.exported && note.mode === 'feedback').length;
      return json({ ok: true, storage: { review, storageDirectory: `/user-data/reviews/${input.reviewId}`, bytes: 2048, categories: [{ label: 'Review state', bytes: 1024, detail: `${drafts} unsent drafts · 1 personal note` }, { label: 'Submitted feedback', bytes: 1024, detail: '1 unresolved' }], drafts, unresolved: 1, unused: [], unusedBytes: 0, fingerprint: JSON.stringify(state), deletionPending: false } });
    }
    if (url.pathname === '/api/reviews/delete') {
      const input = route.request().postDataJSON();
      if (input.fingerprint !== JSON.stringify(stores.get(input.reviewId) || {})) return route.fulfill({ status: 409, json: { ok: false, error: 'Review data changed since the preview. Refresh the details before deleting.' } });
      deleted.add(input.reviewId); stores.delete(input.reviewId);
      for (const key of attachments.keys()) if (key.startsWith(input.reviewId + ":")) attachments.delete(key);
      records.splice(records.findIndex((item) => item.id === input.reviewId), 1);
      return json({ ok: true, deleted: true, cleanupPending: false });
    }
    if (deleted.has(currentId) && ['/api/review-state', '/api/revision', '/api/attachments'].includes(url.pathname)) return route.fulfill({ status: 409, json: { ok: false, reviewUnavailable: true, error: 'Review data was deleted.' } });
    if (url.pathname === '/api/reviews/open') return json({ ok: true, url: `http://viewer.test/${route.request().postDataJSON().reviewId}` });
    if (url.pathname === '/api/reviews/completion') {
      const payload = route.request().postDataJSON();
      records.find((r) => r.id === payload.reviewId).completedAt = payload.completed ? '2026-09-11T11:00:00Z' : null;
      return json({ ok: true });
    }
    if (url.pathname === '/api/review-state') {
      if (!stores.has(currentId)) stores.set(currentId, structuredClone(saved));
      const state = stores.get(currentId);
      if (route.request().method() === 'POST') {
        for (const change of route.request().postDataJSON().changes) {
          let target = state;
          for (const key of change.path.slice(0, -1)) target = target[key] ||= {};
          if (change.after.present) target[change.path.at(-1)] = change.after.value;
          else delete target[change.path.at(-1)];
        }
      }
      return json({ ok: true, reviewId: currentId, generation: 'test', state });
    }
    if (url.pathname === '/api/attachments' && route.request().method() === 'POST') {
      const input = route.request().postDataJSON(), bytes = Buffer.from(input.data, 'base64');
      const id = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const attachment = { id, filename: input.filename, mediaType: input.mediaType, size: bytes.length, sha256: id, path: `attachments/${id}/content.bin` };
      attachments.set(`${currentId}:${id}`, { attachment, bytes }); return json({ ok: true, attachment });
    }
    if (url.pathname.startsWith('/api/attachments/')) {
      const saved = attachments.get(`${currentId}:${url.pathname.split('/').at(-1)}`);
      if (!saved) return route.fulfill({ status: 404 });
      return route.fulfill({ contentType: saved?.attachment.mediaType || 'application/octet-stream', body: saved?.bytes || Buffer.alloc(0) });
    }
    if (url.pathname === '/api/approval-snapshots') return json({ ok: true, snapshotId: 'a'.repeat(32), capturedAt: new Date().toISOString() });
    if (url.pathname === '/api/feedback/export') return json({ ok: true, exported: route.request().postDataJSON().notes.map((note) => ({ ref: note.ref, threadId: `thread-${note.ref}` })), skipped: [] });
    if (url.pathname === '/api/revision') return json({ ok: true, revision: currentData.viewerRevision });
    if (url.pathname === '/api/implementation') return json({ ok: true, implementation: currentData });
    if (url.pathname === '/api/feedback/resolve' || url.pathname === '/api/feedback/reopen') {
      const target = currentData.feedback.find((t) => t.id === route.request().postDataJSON().threadId);
      target.status = url.pathname.endsWith('resolve') ? 'resolved' : 'open';
      return json({ ok: true, status: target.status });
    }
    if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: source });
    if (url.pathname === '/styles.css') return route.fulfill({ contentType: 'text/css', body: styles });
    if (url.pathname === '/api/diff') return json({ ok: true, lines: currentData.stages[0].files[0].lines, additions: 2 });
    return route.fulfill({ contentType: 'text/html', body: `<meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><div id="app"></div><script>window.SEMANTIC_REVIEW_CONTEXT=${JSON.stringify({ reviewId: currentId, generation: "test" })};window.SEMANTIC_IMPLEMENTATION=${JSON.stringify(currentData)}</script><script src="/app.js"></script>` });
  });
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
async function saveAction(page, action, matches) {
  const saved = page.waitForResponse(async (response) => {
    if (new URL(response.url()).pathname !== '/api/review-state' || response.request().method() !== 'POST') return false;
    return response.ok() && matches((await response.json()).state);
  });
  await action();
  await saved;
  await expect(page.locator('#save-status')).toBeHidden();
}
async function showNotes(page) { await page.locator('.tb-btn[data-action="toggle-notes"]').click(); }

test('fresh stages collapse; saved choices restore only for their implementation', async ({ page }) => {
  const data = fixture();
  await mount(page, data);
  await expect(page.locator('.stage.is-open')).toHaveCount(0);
  await saveAction(page, () => page.locator('.stage-title[data-id="second"]').click(), (state) => state.openStages?.second === true);
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
  await page.keyboard.press('Escape');
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
  // Keep prior click/hover state separate from the keyboard dismissal check.
  await page.mouse.move(0, 0);
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
  await saveAction(page, () => first.locator('.notes-toggle').click(),
    (state) => state.openThreads?.['n:first:same-node'] === false && state.openThreads?.['n:second:same-node'] === true);
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
    specificationOpen: true, active: fileId, activeFiles: { [fileId]: true },
    approvals: { [fileId]: true, [approvalKey('second', 'second-one')]: { rev: firstMembershipRevision, at: 1, path: 'shared.js' } },
    comments: [{ id: fileId, kind: 'file', body: 'Keep my note', at: 1 }],
    replyDrafts: [],
  };
  const errors = await mount(page, fixture(), saved);
  await expect(page.locator(".cinema-diff")).toHaveCount(0);
  await openFile(page);
  expect(errors).toEqual([]);
  await expect(page.locator('.stage[data-stage="second"] .frow.is-approved')).toHaveCount(1);
  await expect(page.locator('.stage[data-stage="first"] .frow.is-approved')).toHaveCount(0);
  await showNotes(page);
  await expect(page.getByText('Keep my note', { exact: true }).first()).toBeVisible();
});

test('file approvals require revisions and unsupported renamed-file records are ignored', async ({ page }) => {
  const data = fixture();
  data.stages[1].files[0].kind = 'renamed';
  data.stages[1].files[0].previousPath = 'old.js';
  await mount(page, data, { approvals: {
    [approvalKey('first', 'first-one')]: { rev: null, at: 1 },
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
    [approvalKey('first', 'first-one')]: { rev: 'previous', at: 1 },
    [approvalKey('second', 'second-one', 'old.js')]: { rev: 'previous', at: 1 },
  } });
  await expect(page.locator('.frow.is-stale')).toHaveCount(2);
  await expect(page.locator('.frow.is-approved')).toHaveCount(0);
});


test('unfinished message text survives a reload and failed saves stay visible', async ({ page }) => {
  await mount(page);
  await openFile(page);
  await page.locator('.file-notes .thread-add').click();
  const input = page.locator('textarea[name="nc-body"]');
  await saveAction(page, () => input.fill('Unfinished screenshot explanation'),
    (state) => state.editor?.compose?.body === 'Unfinished screenshot explanation');
  await saveAction(page, () => page.locator('.nc-opt').filter({ hasText: 'Feedback' }).click(),
    (state) => state.editor?.compose?.mode === 'feedback');
  await page.reload();
  await expect(input).toHaveValue('Unfinished screenshot explanation');
  await expect(page.locator('input[name="nc-mode"][value="feedback"]')).toBeChecked();
  await page.route('**/api/review-state*', (route) => route.fulfill({ status: 409, json: { ok: false, error: 'Another tab changed this draft.' } }));
  await input.fill('Keep this conflicting text');
  await expect(page.locator('#save-status')).toContainText('not saved');
  await expect(input).toHaveValue('Keep this conflicting text');
});


test('review switching saves drafts and pins subsequent commands to the selected review', async ({ page }) => {
  const a = { ...fixture(), reviewId: 'worktree-a', title: 'Worktree A' };
  const b = { ...fixture(), reviewId: 'worktree-b', title: 'Worktree B' }; // same implementation ID
  await mount(page, a, {}, [b]);
  await openFile(page);
  await page.locator('.file-notes .thread-add').click();
  await page.locator('textarea[name="nc-body"]').fill('Keep draft in A');
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.locator('[data-review="worktree-b"]').getByRole('button', { name: 'Open review', exact: true }).click();
  await expect(page).toHaveURL('http://viewer.test/worktree-b');
  await expect(page.locator('h1')).toHaveText('Worktree B');
  await openFile(page);
  await page.locator('.file-notes .thread-add').click();
  await page.locator('.nc-opt').filter({ hasText: 'Feedback' }).click();
  await page.locator('textarea[name="nc-body"]').fill('Feedback only for B');
  await page.locator('textarea[name="nc-body"]').press('Control+Enter');
  await showNotes(page);
  const feedbackRequest = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/feedback/export');
  await page.getByRole('button', { name: /Prepare feedback/ }).click();
  const prepared = await feedbackRequest;
  expect(new URL(prepared.url()).searchParams.get('review')).toBe('worktree-b');
  expect(new URL(prepared.url()).searchParams.get('generation')).toBe('test');
  expect(prepared.postDataJSON().notes[0].body).toBe('Feedback only for B');
  await expect(page.getByRole('button', { name: /Sending/ })).toHaveCount(0);
  await page.locator('.side.notes').getByRole('button', { name: 'Close', exact: true }).click();
  const command = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/reviews/completion');
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.locator('[data-review="worktree-b"]').getByRole('button', { name: 'Mark complete' }).click();
  const request = await command;
  expect(new URL(request.url()).searchParams.get('review')).toBe('worktree-b');
  expect(request.postDataJSON().reviewId).toBe('worktree-b');
  await expect(page.locator('[data-review="worktree-b"]')).toContainText('Completed');
  await page.locator('[data-review="worktree-b"]').getByRole('button', { name: 'Reopen review', exact: true }).click();
  await expect(page.locator('[data-review="worktree-b"]')).toContainText('Active');
  await page.locator('[data-review="worktree-a"]').getByRole('button', { name: 'Open review', exact: true }).click();
  await expect(page.locator('textarea[name="nc-body"]')).toHaveValue('Keep draft in A');
});

test('failed saves prevent switching and unavailable reviews stay visible', async ({ page }) => {
  const a = { ...fixture(), reviewId: 'a' }, b = { ...fixture(), reviewId: 'b' };
  await mount(page, a, {}, [b]);
  await openFile(page);
  await page.locator('.file-notes .thread-add').click();
  await page.route('**/api/review-state*', (route) => route.fulfill({ status: 409, json: { ok: false, error: 'Conflicting draft' } }));
  await page.locator('textarea[name="nc-body"]').fill('Do not lose me');
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.locator('[data-review="b"]').getByRole('button', { name: 'Open review', exact: true }).click();
  await expect(page.locator('#review-list [role="alert"]')).toContainText('Conflicting draft');
  await expect(page).toHaveURL('http://viewer.test/');
  await expect(page.locator('textarea[name="nc-body"]')).toHaveValue('Do not lose me');
  await page.route('**/api/reviews?*', (route) => route.fulfill({ json: { ok: true, reviews: [{ id: 'missing', generation: 'test', title: 'Old review', implementationId: 'old', repositoryRoot: '/missing', updatedAt: new Date().toISOString(), available: false, unavailableReason: 'The worktree was removed.' }] } }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('[data-review="missing"]')).toContainText('The worktree was removed.');
  await expect(page.locator('[data-review="missing"]').getByRole('button', { name: 'Open review', exact: true })).toBeDisabled();
});


test('shared files have independent node approvals, counts, and revocation', async ({ page }) => {
  await mount(page);
  await page.locator('.stage-title[data-id="first"]').click();
  const one = page.locator('details[data-node="first-one"]'), two = page.locator('details[data-node="first-two"]');
  await one.locator('summary').click(); await two.locator('summary').click();
  const stageApproval = page.locator('.stage[data-stage="first"] .stage-approve .approve');
  await expect(stageApproval).toBeDisabled();
  await saveAction(page, () => one.locator('.mini-approve').click(), (state) => !!state.approvals?.[approvalKey('first', 'first-one')]);
  await expect(one.locator('.frow')).toHaveClass(/is-approved/);
  await expect(two.locator('.frow')).not.toHaveClass(/is-approved/);
  await expect(page.locator('.tb-btn[data-action="toggle-coverage"]')).toContainText('2/10');
  await expect(stageApproval).toBeDisabled();
  await two.locator('.mini-approve').click();
  await stageApproval.click();
  await expect(page.locator('.tb-btn[data-action="toggle-coverage"]')).toContainText('5/10');
  await saveAction(page, () => one.locator('.mini-approve').click(), (state) => !state.approvals?.[approvalKey('first', 'first-one')] && !state.approvals?.first);
  await expect(two.locator('.frow')).toHaveClass(/is-approved/);
  await expect(stageApproval).toBeDisabled();
  await expect(page.locator('.tb-btn[data-action="toggle-coverage"]')).toContainText('2/10');
  await page.reload();
  await expect(one.locator('.frow')).not.toHaveClass(/is-approved/);
  await expect(two.locator('.frow')).toHaveClass(/is-approved/);
});

test('ownership changes stale only that membership; file content changes stale every approval', async ({ page }) => {
  const data = fixture();
  await mount(page, data);
  await page.locator('.stage-title[data-id="first"]').click();
  const one = page.locator('details[data-node="first-one"]'), two = page.locator('details[data-node="first-two"]');
  await one.locator('summary').click(); await two.locator('summary').click();
  await one.locator('.mini-approve').click();
  await saveAction(page, () => two.locator('.mini-approve').click(), (state) => !!state.approvals?.[approvalKey('first', 'first-two')]);
  data.stages[0].files[0].memberships[0].hunks = [1, 3]; data.viewerRevision = 'ownership-changed';
  await expect(one.locator('.frow')).toHaveClass(/is-stale/);
  await expect(two.locator('.frow')).toHaveClass(/is-approved/);
  data.stages[0].files[0].revision = 'new-file-content'; data.viewerRevision = 'content-changed';
  await expect(two.locator('.frow')).toHaveClass(/is-stale/);
  await one.locator('.mini-approve').click();
  await expect(one.locator('.frow')).toHaveClass(/is-approved/);
  await expect(two.locator('.frow')).toHaveClass(/is-stale/);
});


test('since-approval comparison is explicit and cannot create current line anchors', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread("current-line", "open", { kind: "line", stageId: "first", path: "shared.js", side: "new", line: 1, label: "Current line" })];
  await mount(page, data, { comments: [{ kind: "line", id: "l:first:new:1:shared.js", nodeId: "first-one", exported: true, threadId: "current-line", body: "Feedback current-line" }] });
  await openFile(page);
  await saveAction(page, () => page.locator('details[data-node="first-one"] .mini-approve').click(), (state) => !!state.approvals?.[approvalKey('first', 'first-one')]?.snapshotId);
  data.stages[0].files[0].revision = 'changed'; data.viewerRevision = 'after-approval';
  await expect(page.locator('details[data-node="first-one"] .frow')).toHaveClass(/is-stale/);
  await openFile(page);
  const endpoint = { path: 'shared.js', headRevision: 'b'.repeat(40), mode: '100644', exists: true, size: 20, sha256: 'hash' };
  await page.route('**/api/approval-comparison*', (route) => route.fulfill({ json: { ok: true, approved: endpoint, current: { ...endpoint, headRevision: 'c'.repeat(40) }, baseChanged: true, ownershipChanged: true, lines: [{ t: 'del', o: 1, s: 'already approved' }, { t: 'add', n: 1, s: 'new content' }], offset: 0, nextOffset: null } }));
  await page.getByRole('button', { name: 'Since approval', exact: true }).click();
  const comparison = page.locator('.is-approved-comparison');
  await expect(comparison).toContainText('already approved'); await expect(comparison).toContainText('new content');
  await expect(comparison).toContainText('stage base changed'); await expect(comparison).toContainText('ownership or classification changed');
  await expect(comparison.locator('[data-line-id], .lact')).toHaveCount(0);
  await showNotes(page);
  await page.locator('.side.notes [data-action="jump-to"][data-kind="line"]').click();
  await expect(page.getByRole('button', { name: 'Current stage diff', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.cinema-diff .lact')).not.toHaveCount(0);
  await expect(page.locator('.cinema-diff')).toContainText('const first = 1;');
});

test('failed snapshot capture does not approve a file', async ({ page }) => {
  await mount(page); await openFile(page);
  await page.route('**/api/approval-snapshots*', (route) => route.fulfill({ status: 409, json: { ok: false, error: 'The file changed. Refresh before approving.' } }));
  await page.locator('details[data-node="first-one"] .mini-approve').click();
  await expect(page.locator('[role="alert"]')).toContainText('Approval was not saved');
  await expect(page.locator('.frow.is-approved')).toHaveCount(0);
  await expect(page.locator('.cinema-diff')).toBeVisible();
  await page.route('**/api/approval-snapshots*', (route) => route.fulfill({ json: { ok: true, snapshotId: 'a'.repeat(32) } }));
  await page.locator('details[data-node="first-two"] summary').click();
  await page.locator('details[data-node="first-two"] .mini-approve').click();
  await expect(page.locator('[role="alert"]')).toContainText('Approval was not saved');
  await page.locator('details[data-node="first-one"] .mini-approve').click();
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});


test('switching waits for an in-flight approval capture and its state save', async ({ page }) => {
  const a = { ...fixture(), reviewId: 'a' }, b = { ...fixture(), reviewId: 'b' };
  await mount(page, a, {}, [b]); await openFile(page);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/approval-snapshots*', async (route) => { await pending; await route.fulfill({ json: { ok: true, snapshotId: 'b'.repeat(32) } }); });
  await page.locator('details[data-node="first-one"] .mini-approve').click();
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.locator('[data-review="b"]').getByRole('button', { name: 'Open review', exact: true }).click();
  await expect(page.locator('#review-list [role="status"]')).toContainText('Loading review');
  await expect(page).toHaveURL('http://viewer.test/');
  release();
  await expect(page).toHaveURL('http://viewer.test/b');
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.locator('[data-review="a"]').getByRole('button', { name: 'Open review', exact: true }).click();
  await expect(page.locator('details[data-node="first-one"] .frow')).toHaveClass(/is-approved/);
});


test('approved identity follows observed rename chains across reloads', async ({ page }) => {
  const data = fixture(); await mount(page, data); await openFile(page);
  const one = page.locator('details[data-node="first-one"]');
  await saveAction(page, () => one.locator('.mini-approve').click(), (state) => !!state.approvals?.[approvalKey('first', 'first-one')]);
  const file = data.stages[0].files[0];
  await saveAction(page, async () => { file.previousPath = file.path; file.path = 'middle.js'; file.kind = 'renamed'; data.viewerRevision = 'rename-one'; }, (state) => !!state.approvals?.[approvalKey('first', 'first-one', 'middle.js')]);
  await expect(one.locator('.frow')).toHaveClass(/is-stale/);
  await page.reload();
  file.previousPath = file.path; file.path = 'final.js'; data.viewerRevision = 'rename-two';
  await expect(one.locator('.frow')).toContainText('final.js');
  await expect(one.locator('.frow')).toHaveClass(/is-stale/);
  if (!await one.evaluate((el) => el.open)) await one.locator('summary').click();
  await one.locator('.frow').click();
  await expect(page.getByRole('button', { name: 'Since approval', exact: true })).toBeVisible();
});


test('failed approvals follow renamed files and clear when the retry succeeds', async ({ page }) => {
  const data = fixture(); await mount(page, data); await openFile(page);
  await page.route('**/api/approval-snapshots*', (route) => route.fulfill({ status: 409, json: { ok: false, error: 'Capture failed' } }));
  const one = page.locator('details[data-node="first-one"]');
  await one.locator('.mini-approve').click();
  await expect(page.locator('[role="alert"]')).toContainText('Capture failed');
  const file = data.stages[0].files[0];
  file.previousPath = file.path; file.path = 'renamed.js'; file.kind = 'renamed'; data.viewerRevision = 'renamed-error';
  await expect(one.locator('.frow')).toContainText('renamed.js');
  await page.route('**/api/approval-snapshots*', (route) => route.fulfill({ json: { ok: true, snapshotId: 'a'.repeat(32) } }));
  await one.locator('.mini-approve').click();
  await expect(one.locator('.frow')).toHaveClass(/is-approved/);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});


test('attachment-only notes survive reloads, preview images, and export managed references', async ({ page }) => {
  await mount(page); await openFile(page); await page.locator('.file-notes .thread-add').click();
  await page.locator('.nc-opt').filter({ hasText: 'Feedback' }).click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9X8AAAAASUVORK5CYII=', 'base64');
  await saveAction(page, () => page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'context.png', mimeType: 'image/png', buffer: png }), (state) => state.editor?.compose?.attachments?.length === 1);
  await expect(page.locator('.note-compose .attachment img')).toBeVisible();
  await page.reload();
  await expect(page.locator('.note-compose .attachment a')).toHaveText('context.png');
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'context.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('button', { name: 'Add note', exact: true })).toBeEnabled();
  await expect(page.locator('.note-compose .attachment')).toHaveCount(1);
  await page.locator('textarea[name="nc-body"]').press('Control+Enter');
  await expect(page.locator('.note-compose')).toHaveCount(0);
  await showNotes(page);
  const request = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/feedback/export');
  await page.getByRole('button', { name: /Prepare feedback/ }).click();
  const note = (await request).postDataJSON().notes[0];
  expect(note.body).toBe(''); expect(note.attachments[0].filename).toBe('context.png');
  expect(note.attachments[0].path).toMatch(/^attachments\/[a-f0-9]{64}\/content.bin$/);
});

test('message editors accept dropped files and pasted images, including replies', async ({ page }) => {
  const data = fixture(); data.feedback = [thread('files-reply')];
  await mount(page, data); await showNotes(page);
  await page.locator('.side.notes [data-action="thread-reply"]').click();
  await page.locator('[data-reply-form]').evaluate((form) => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['log content'], 'debug.log', { type: 'text/plain' }));
    form.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.locator('[data-reply-form] .attachment a')).toHaveText('debug.log');
  await expect(page.getByRole('button', { name: 'Save reply', exact: true })).toBeEnabled();
  await page.locator('textarea[name="reply-body"]').evaluate((input) => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['image bytes'], 'pasted.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  await expect(page.locator('[data-reply-form] .attachment')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Save reply', exact: true })).toBeEnabled();
  await saveAction(page, () => page.getByRole('button', { name: 'Save reply', exact: true }).click(), (state) => state.replyDrafts?.[0]?.attachments?.length === 2);
  await page.reload();
  await expect(page.locator('.side.notes .tmsg-draft .attachment')).toHaveCount(2);
  await page.locator('.side.notes [data-action="reply-edit"]').click();
  await page.getByRole('button', { name: 'Remove debug.log', exact: true }).click();
  await expect(page.locator('[data-reply-form] .attachment')).toHaveCount(1);
});

test('rejected attachment uploads keep the message editable with a visible error', async ({ page }) => {
  await mount(page); await openFile(page); await page.locator('.file-notes .thread-add').click();
  await page.route('**/api/attachments?*', (route) => route.fulfill({ status: 400, json: { ok: false, error: 'Attachment rejected' } }));
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'bad.log', mimeType: 'text/plain', buffer: Buffer.from('bad') });
  await expect(page.locator('.note-compose [role="alert"]')).toContainText('Attachment rejected');
  await expect(page.locator('.note-compose .attachment')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add note', exact: true })).toBeEnabled();
});


test('review switching waits for uploads and retains files in the initiating review', async ({ page }) => {
  const a = { ...fixture(), reviewId: 'a' }, b = { ...fixture(), reviewId: 'b' };
  await mount(page, a, {}, [b]); await openFile(page); await page.locator('.file-notes .thread-add').click();
  let release; const pending = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/attachments?*', async (route) => { await pending; await route.fallback(); });
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'only-a.log', mimeType: 'text/plain', buffer: Buffer.from('A') });
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.locator('[data-review="b"]').getByRole('button', { name: 'Open review', exact: true }).click();
  await expect(page).toHaveURL('http://viewer.test/'); release();
  await expect(page).toHaveURL('http://viewer.test/b');
  await expect(page.locator('.attachment')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.locator('[data-review="a"]').getByRole('button', { name: 'Open review', exact: true }).click();
  await expect(page.locator('.note-compose .attachment a')).toHaveText('only-a.log');
  const attachmentUrl = await page.locator('.note-compose .attachment a').getAttribute('href');
  expect(await page.evaluate(async (url) => { const other = new URL(url); other.searchParams.set('review', 'b'); return (await fetch(other)).status; }, attachmentUrl)).toBe(404);
});


test('review deletion previews data, requires confirmation, and leaves other reviews accessible', async ({ page }) => {
  const a = { ...fixture(), reviewId: 'a', title: 'Review A' }, b = { ...fixture(), reviewId: 'b', title: 'Review B' };
  const errors = await mount(page, a, { comments: [{ kind: 'stage', id: 'first', mode: 'feedback', body: 'Unsent feedback' }] }, [b]);
  let deletions = 0; page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/reviews/delete') deletions++; });
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.locator('[data-review="a"]').getByRole('button', { name: 'Delete data…', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('1 unsent draft'); await expect(dialog).toContainText('1 unresolved feedback');
  await expect(dialog).toContainText('/user-data/reviews/a'); expect(deletions).toBe(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(deletions).toBe(0);
  await page.locator('[data-review="a"]').getByRole('button', { name: 'Delete data…', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete review data', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Review data deleted' })).toBeVisible();
  await expect(page.locator('[data-review="a"]')).toHaveCount(0); expect(deletions).toBe(1);
  await page.locator('[data-review="b"]').getByRole('button', { name: 'Open review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review B', exact: true })).toBeVisible();
  await page.goto('http://viewer.test/a');
  await expect(page.getByRole('heading', { name: 'Review data deleted' })).toBeVisible();
  await expect(page.locator('[data-review="b"]')).toBeVisible(); expect(errors).toEqual([]);
  await expect(page.locator('#review-list [data-action="toggle-reviews"]')).toHaveCount(0);
  await page.route('**/api/reviews?*', (route) => route.fulfill({ json: { ok: true, reviews: [{ id: 'a', generation: 'fresh-session', title: 'Reopened A', repositoryRoot: '/repos/a', implementationId: 'browser-review', updatedAt: '2026-09-11T10:00:00Z', available: true, completedAt: null }] } }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('[data-review="a"]').getByRole('button', { name: 'Open review', exact: true })).toBeEnabled();
  await expect(page.locator('[data-review="a"]')).not.toHaveAttribute('aria-current', 'true');

});

test('changed storage previews cannot delete newly saved data without a refreshed confirmation', async ({ page }) => {
  await mount(page); await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.getByRole('button', { name: 'Delete data…', exact: true }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('button', { name: 'Delete review data', exact: true })).toBeEnabled();
  await page.evaluate(async () => fetch('/api/review-state?review=browser-review&generation=test', { method: 'POST', body: JSON.stringify({ changes: [{ path: ['otherTab'], after: { present: true, value: 'New data' } }] }) }));
  await dialog.getByRole('button', { name: 'Delete review data', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('changed since the preview');
  await dialog.getByRole('button', { name: 'Refresh details', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Delete review data', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review data deleted' })).toBeVisible();
});

test('a review deleted in another tab preserves unsent text for copying and rejects further saves', async ({ page }) => {
  await mount(page); await openFile(page); await page.locator('.file-notes .thread-add').click();
  await saveAction(page, () => page.locator('textarea[name="nc-body"]').fill('Keep this unsent explanation'), (state) => state.editor?.compose?.body === 'Keep this unsent explanation');
  await page.evaluate(async () => {
    const input = { reviewId: 'browser-review', generation: 'test' }, query = '?review=browser-review&generation=test';
    const result = await fetch('/api/reviews/storage' + query, { method: 'POST', body: JSON.stringify(input) }).then((r) => r.json());
    await fetch('/api/reviews/delete' + query, { method: 'POST', body: JSON.stringify({ ...input, fingerprint: result.storage.fingerprint }) });
  });
  await expect(page.getByRole('heading', { name: 'Review data deleted' })).toBeVisible();
  await expect(page.locator('.deleted-review textarea')).toHaveValue('Keep this unsent explanation');
  await expect(page.locator('.deleted-review textarea')).toHaveAttribute('readonly', '');
  expect(await page.evaluate(async () => (await fetch('/api/review-state?review=browser-review&generation=test')).status)).toBe(409);
});


test('a pending deletion stays visible and can retry file removal', async ({ page }) => {
  await mount(page); let pending = false, gone = false;
  const record = { id: 'browser-review', generation: 'test', title: 'Review fixes', repositoryRoot: '/repos/review', implementationId: 'browser-review', updatedAt: '2026-09-11T10:00:00Z', completedAt: null };
  await page.route('**/api/reviews?*', (route) => route.fulfill({ json: { ok: true, reviews: gone ? [] : [{ ...record, available: !pending, deletionPending: pending }] } }));
  await page.route('**/api/reviews/storage?*', (route) => route.fulfill({ json: { ok: true, storage: { review: record, storageDirectory: '/user-data/trash/review', bytes: 1024, categories: [], drafts: 0, unresolved: 0, fingerprint: 'preview', unused: [], unusedBytes: 0, deletionPending: pending } } }));
  await page.route('**/api/reviews/delete?*', (route) => {
    if (!pending) { pending = true; return route.fulfill({ json: { ok: true, deleted: true, cleanupPending: true, error: 'File is open. Retry removal.' } }); }
    gone = true; return route.fulfill({ json: { ok: true, deleted: true, cleanupPending: false } });
  });
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.getByRole('button', { name: 'Delete data…', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Delete review data', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('File is open');
  await expect(page.locator('[data-review="browser-review"]')).toContainText('Deletion pending');
  await dialog.getByRole('button', { name: 'Retry file removal', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.locator('[data-review="browser-review"]')).toHaveCount(0);
});

test('unused-file cleanup keeps the review and its saved messages', async ({ page }) => {
  await mount(page); let cleaned = false;
  await page.route('**/api/reviews/storage?*', (route) => route.fulfill({ json: { ok: true, storage: { storageDirectory: '/user-data/reviews/browser-review', bytes: cleaned ? 1024 : 2048, categories: [], drafts: 1, unresolved: 0, fingerprint: 'preview', unused: cleaned ? [] : [{ path: 'attachments/unused', bytes: 1024 }], unusedBytes: cleaned ? 0 : 1024, deletionPending: false } } }));
  await page.route('**/api/reviews/clean-unused?*', (route) => { cleaned = true; return route.fulfill({ json: { ok: true, reclaimedBytes: 1024, failures: [] } }); });
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.getByRole('button', { name: 'Delete data…', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Clean unused files', exact: true }).click();
  await expect(dialog.getByText('Reclaimed 1.0 KiB.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Clean unused files', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('[data-review="browser-review"]')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Review fixes', exact: true })).toBeVisible();
});


test('uploads attempted while busy remain visible and retryable', async ({ page }) => {
  await mount(page); await openFile(page); await page.locator('.file-notes .thread-add').click();
  let release; const pending = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/attachments?*', async (route) => { await pending; await route.fallback(); });
  const file = (name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) });
  await page.getByLabel('Attach files', { exact: true }).setInputFiles(file('first.log'));
  await expect(page.locator('.note-compose').getByRole('status')).toContainText('Uploading');
  await page.getByLabel('Attach files', { exact: true }).setInputFiles(file('second.log'));
  await expect(page.locator('.note-compose [role="alert"]')).toContainText('second.log: wait');
  release(); await expect(page.locator('.note-compose .attachment')).toHaveCount(1);
  await expect(page.locator('.note-compose [role="alert"]')).toContainText('second.log: wait');
  await page.getByLabel('Attach files', { exact: true }).setInputFiles(file('second.log'));
  await expect(page.locator('.note-compose .attachment')).toHaveCount(2);
  await expect(page.locator('.note-compose [role="alert"]')).toHaveCount(0);
});

test('full attachment lists reject new files before upload but allow duplicate retries', async ({ page }) => {
  await mount(page); await openFile(page); await page.locator('.file-notes .thread-add').click();
  let uploads = 0; page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/attachments') uploads++; });
  const file = (name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) });
  await page.getByLabel('Attach files', { exact: true }).setInputFiles(Array.from({ length: 11 }, (_, i) => file(`${i}.log`)));
  await expect(page.locator('.note-compose .attachment')).toHaveCount(10);
  await expect(page.locator('.note-compose [role="alert"]')).toContainText('at most 10'); expect(uploads).toBe(10);
  await page.getByLabel('Attach files', { exact: true }).setInputFiles(file('0.log'));
  await expect(page.getByRole('button', { name: 'Add note', exact: true })).toBeEnabled();
  expect(uploads).toBe(11); await expect(page.locator('.note-compose .attachment')).toHaveCount(10);
});
