import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const viewer = new URL('../../../viewer/', import.meta.url);
const source = fs.readFileSync(new URL('../../../skills/semantic-flow/viewer/app.js', import.meta.url), 'utf8');
const bootSource = fs.readFileSync(new URL('../../../skills/semantic-flow/viewer/boot.js', import.meta.url), 'utf8');
const markdownSource = fs.readFileSync(new URL('../../../skills/semantic-flow/viewer/markdown.js', import.meta.url), 'utf8');
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
async function mount(page, data = fixture(), saved = {}, other = [], { csp } = {}) {
  const allData = [data, ...other];
  const records = allData.map((item) => ({ id: item.reviewId || item.implementationId, generation: "test", remote: item.remote, title: item.title, implementationId: item.implementationId, repositoryRoot: `/repos/${item.reviewId || item.implementationId}`, updatedAt: "2026-09-11T10:00:00Z", completedAt: null, available: true }));
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  const stores = new Map();
  const revisions = new Map();
  const lastSaveIds = new Map();
  const attachments = new Map();
  const deleted = new Set();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    // The page path names the review; its start request carries no review scope.
    const pagePath = url.pathname === '/api/bootstrap' ? new URL(route.request().frame().url()).pathname : url.pathname;
    const currentData = allData.find((item) => (item.reviewId || item.implementationId) === (url.searchParams.get('review') || pagePath.slice(1))) || data;
    const currentId = currentData.reviewId || currentData.implementationId;
    const json = (body) => route.fulfill({ json: body });
    if (url.pathname === '/api/reviews') return json({ ok: true, reviews: records });
    if (url.pathname === '/api/reviews/storage') {
      const input = route.request().postDataJSON(), review = records.find((record) => record.id === input.reviewId), state = stores.get(input.reviewId) || {};
      const drafts = (state.comments || []).filter((note) => !note.exported && note.mode === 'feedback').length;
      return json({ ok: true, storage: { review, storageDirectory: `/user-data/reviews/${input.reviewId}`, bytes: 2048, categories: [{ label: 'Review state', bytes: 1024, detail: `${drafts} unsent drafts · 1 personal note` }, { label: 'Submitted feedback', bytes: 1024, detail: '1 unresolved' }], drafts, unresolved: 1, unused: [], unusedBytes: 0, fingerprint: JSON.stringify(state) } });
    }
    if (url.pathname === '/api/reviews/delete') {
      const input = route.request().postDataJSON();
      if (input.fingerprint !== JSON.stringify(stores.get(input.reviewId) || {})) return route.fulfill({ status: 409, json: { ok: false, error: 'Review data changed since the preview. Refresh the details before deleting.' } });
      deleted.add(input.reviewId); stores.delete(input.reviewId);
      for (const key of attachments.keys()) if (key.startsWith(input.reviewId + ":")) attachments.delete(key);
      records.splice(records.findIndex((item) => item.id === input.reviewId), 1);
      return json({ ok: true, deleted: true });
    }
    if (deleted.has(currentId) && ['/api/review-state', '/api/revision', '/api/attachments'].includes(url.pathname)) return route.fulfill({ status: 409, json: { ok: false, reviewUnavailable: true, error: 'Review data was deleted.' } });
    if (url.pathname === '/api/reviews/open') return json({ ok: true, url: `http://localhost/${route.request().postDataJSON().reviewId}#launch=code` });
    if (url.pathname === '/api/session') return json({ ok: true, key: 'test-key', read: 'test-read' });
    if (url.pathname === '/api/bootstrap') return json({ ok: true, implementation: currentData, context: { reviewId: currentId, generation: 'test' } });
    if (url.pathname === '/api/reviews/completion') {
      const payload = route.request().postDataJSON();
      records.find((r) => r.id === payload.reviewId).completedAt = payload.completed ? '2026-09-11T11:00:00Z' : null;
      return json({ ok: true });
    }
    if (url.pathname === '/api/review-state') {
      if (!stores.has(currentId)) stores.set(currentId, structuredClone(saved));
      if (route.request().method() === 'POST') {
        // Like the review store, every key is an own property, including "__proto__",
        // a change applies only over its `before` or as an exact retry, and a save applies all its changes or none.
        const own = (target, key, value) => Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
        const state = structuredClone(stores.get(currentId));
        const conflict = () => route.fulfill({ status: 409, json: { ok: false, error: 'Review state changed in another tab. Keep your draft text and reload before retrying.' } });
        let changed = false;
        const { changes, saveId } = route.request().postDataJSON();
        for (const change of changes) {
          let target = state;
          for (const key of change.path.slice(0, -1)) {
            if (!Object.hasOwn(target, key)) own(target, key, {});
            target = target[key];
            if (!target || typeof target !== 'object' || Array.isArray(target)) return conflict();
          }
          const key = change.path.at(-1);
          const current = Object.hasOwn(target, key) ? { present: true, value: target[key] } : { present: false };
          if (isDeepStrictEqual(current, change.after)) continue;
          // Tests that stand in for another tab may send a change without `before`.
          if (change.before && !isDeepStrictEqual(current, change.before)) return conflict();
          if (change.after.present) own(target, key, change.after.value);
          else delete target[key];
          changed = true;
        }
        stores.set(currentId, state);
        if (changed) { revisions.set(currentId, (revisions.get(currentId) || 0) + 1); lastSaveIds.set(currentId, saveId ?? null); }
      }
      return json({ ok: true, reviewId: currentId, generation: 'test', state: stores.get(currentId), stateRevision: revisions.get(currentId) || 0, lastSaveId: lastSaveIds.get(currentId) ?? null });
    }
    if (url.pathname === '/api/attachments' && route.request().method() === 'POST') {
      const input = route.request().postDataJSON(), bytes = Buffer.from(input.data, 'base64');
      const id = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const attachment = { id, filename: input.filename, mediaType: input.mediaType, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), path: `attachments/${id}/content.bin` };
      attachments.set(`${currentId}:${id}`, { attachment, bytes }); return json({ ok: true, attachment });
    }
    if (url.pathname.startsWith('/api/attachments/')) {
      const saved = attachments.get(`${currentId}:${url.pathname.split('/').at(-1)}`);
      if (!saved) return route.fulfill({ status: 404 });
      return route.fulfill({ contentType: saved?.attachment.mediaType || 'application/octet-stream', body: saved?.bytes || Buffer.alloc(0) });
    }
    if (url.pathname === '/api/approval-snapshots') return json({ ok: true, snapshotId: 'a'.repeat(32), capturedAt: new Date().toISOString() });
    if (url.pathname === '/api/feedback/export') return json({ ok: true, exported: route.request().postDataJSON().notes.map((note) => ({ ref: note.ref, threadId: `thread-${note.ref}` })), skipped: [] });
    if (url.pathname === '/api/revision') return json({ ok: true, revision: currentData.viewerRevision, ...(currentData.agent ? { agent: currentData.agent } : {}) });
    if (url.pathname === '/api/agent/respond') {
      const input = route.request().postDataJSON();
      (currentData.answers ||= []).push(input);
      currentData.agent.requests = currentData.agent.requests.filter((request) => request.id !== input.requestId);
      return json({ ok: true, agent: currentData.agent });
    }
    if (url.pathname === '/api/agent/stop') { currentData.agent.stopRequested = true; return json({ ok: true, agent: currentData.agent }); }
    if (url.pathname === '/api/implementation') return json({ ok: true, implementation: currentData });
    if (url.pathname === '/api/feedback/resolve' || url.pathname === '/api/feedback/reopen') {
      const target = currentData.feedback.find((t) => t.id === route.request().postDataJSON().threadId);
      target.status = url.pathname.endsWith('resolve') ? 'resolved' : 'open';
      return json({ ok: true, status: target.status });
    }
    if (url.pathname === '/markdown.js') return route.fulfill({ contentType: 'text/javascript', body: markdownSource });
    if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: source });
    if (url.pathname === '/boot.js') return route.fulfill({ contentType: 'text/javascript', body: bootSource });
    if (url.pathname === '/styles.css') return route.fulfill({ contentType: 'text/css', body: styles });
    if (url.pathname === '/api/diff') return json({ ok: true, lines: currentData.stages[0].files[0].lines, additions: 2 });
    return route.fulfill({ contentType: 'text/html', headers: csp ? { 'Content-Security-Policy': csp } : {}, body: '<meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><div id="app"></div><script src="/boot.js"></script>' });
  });
  await page.goto('http://localhost/#launch=code');
  await expect(page.locator('.stage')).toHaveCount(data.stages.length);
  expect(errors).toEqual([]);
  return errors;
}
async function openFile(page, node = 'first-one') {
  if (!await page.locator('.stage[data-stage="first"]').evaluate((el) => el.classList.contains('is-open')))
    await page.locator('.stage-title[data-id="first"]').click();
  const details = page.locator(`details[data-node="${node}"]`);
  if (!await details.evaluate((el) => el.open)) await details.locator('summary').click();
  if (!await details.locator('.cinema-diff').count()) await details.locator('.frow-open').click();
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
// The notes panel's open state is saved with the review, so it can already be open after a reload.
async function showNotes(page) {
  const toggle = page.locator('.tb-btn[data-action="toggle-notes"]');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
// The viewer saves review state shortly after each change. A reload before that save lands restores
// whichever state won the race, so wait until the viewer's own unsaved-changes check is clear.
async function reload(page) {
  await expect.poll(() => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }), { message: 'the viewer has unsaved review state' }).toBe(false);
  await page.reload();
}

for (const skillVersion of ['0.2.0', undefined]) {
  test(`viewer shows running release with artifact skill version ${skillVersion ?? 'absent'}`, async ({ page }) => {
    await mount(page, { ...fixture(), skillVersion, viewerReleaseVersion: "0.8.1" });
    await expect(page.locator('.hero-skill-version')).toHaveText("Viewer version: 0.8.1");
  });
}

test('the page asks for a fresh link only after the server stays unreachable', async ({ page }) => {
  await page.clock.install();
  await mount(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now()));
  let failures = 0;
  await page.route('http://localhost/api/revision**', (route) => { failures += 1; return route.abort('connectionrefused'); });
  const poll = async (count) => { await page.clock.runFor(1000); await expect.poll(() => failures).toBe(count); };
  await poll(1);
  // A background tab stops polling: a failure long after the last one starts a new outage.
  await page.evaluate(() => {
    window.testHidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.testHidden });
  });
  await page.clock.runFor(10_000);
  expect(failures).toBe(1);
  await page.evaluate(() => { window.testHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => failures).toBe(2);
  await expect(page.locator('#fresh-link-notice')).toHaveCount(0);
  for (let count = 3; count <= 6; count++) await poll(count);
  await expect(page.locator('#fresh-link-notice')).toHaveCount(0);
  // Five seconds of failures in a row.
  await poll(7);
  await expect(page.locator('#fresh-link-notice')).toContainText('This review page needs a fresh link.');
  await expect(page.locator('.stage')).not.toHaveCount(0);
});

test('a poll that never answers counts as the server being unreachable', async ({ page }) => {
  await mount(page);
  // The page polls every second; each poll gives up after three seconds.
  await page.route('http://localhost/api/revision**', () => {});
  await expect(page.locator('#fresh-link-notice')).toContainText('This review page needs a fresh link.', { timeout: 20_000 });
});

test('file names with quotes, angle brackets and carriage returns stay text and keep their controls working', async ({ page }) => {
  const name = '"><img src=x onerror="window.injected=1">\r.js';
  const path = `src/${name}`;
  const data = fixture();
  for (const stage of data.stages) stage.files[0].path = path;
  await mount(page, data);
  await openFile(page);
  const node = page.locator('details[data-node="first-one"]');
  await expect(node.locator('.frow')).toHaveAttribute('data-file', `f:first:${path}`);
  await expect(node.locator('.fp-name')).toHaveText(name);
  await expect(node.locator('.frow-open')).toHaveAttribute('data-id', `f:first:${path}`);
  await node.locator('.cinema-diff .lact').first().click();
  await expect(node.locator('.lact').first()).toHaveAttribute('data-id', `l:first:new:1:${path}`);
  await page.locator('.nc-opt').filter({ hasText: 'Personal' }).click();
  await page.locator('textarea[name="nc-body"]').fill('Line note');
  await saveAction(page, () => page.locator('textarea[name="nc-body"]').press('Control+Enter'), (state) => state.comments?.[0]?.id === `l:first:new:1:${path}`);
  await node.locator('.file-notes .thread-add').click();
  await page.locator('textarea[name="nc-body"]').fill('File note');
  await saveAction(page, () => page.locator('textarea[name="nc-body"]').press('Control+Enter'), (state) => state.comments?.some((note) => note.kind === 'file' && note.id === `f:first:${path}`));
  await saveAction(page, () => node.locator('.mini-approve').click(), (state) => !!state.approvals?.[approvalKey('first', 'first-one', path)]);
  await expect(node.locator('.frow')).toHaveClass(/is-approved/);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

test('long acceptance identifiers stay separate from descriptions at supported widths', async ({ page }) => {
  const data = fixture();
  data.requirements = [{ id: 'story', title: 'Requirements', summary: 'Summary', acceptance: [
    { id: 'deployment-errors', text: 'Deployment errors are reported clearly.' },
    { id: 'disable-warmup', text: 'Warmup can be disabled.' },
    { id: 'a'.repeat(100), text: 'A long unbroken identifier remains readable.' },
  ] }];
  await mount(page, data);
  await page.locator('.specification summary').click();
  for (const width of [1440, 1024, 720, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const row of await page.locator('.ac-item').all()) {
      const id = await row.locator('.ac-id').boundingBox();
      const text = await row.locator('.ac-text').boundingBox();
      expect(id.x + id.width <= text.x || id.y + id.height <= text.y).toBe(true);
      expect(await row.locator('.ac-id').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await row.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
  }
});

test('fresh stages collapse; saved choices restore only for their implementation', async ({ page }) => {
  const data = fixture();
  await mount(page, data);
  await expect(page.locator('.stage.is-open')).toHaveCount(0);
  await saveAction(page, () => page.locator('.stage-title[data-id="second"]').click(), (state) => state.openStages?.second === true);
  await reload(page);
  await expect(page.locator('.stage.is-open')).toHaveAttribute('data-stage', 'second');
  data.implementationId = 'another-review';
  await reload(page);
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
  await expect(page.locator('details[data-node="first-one"] .mini-threads')).toHaveAttribute('aria-label', '0 file comments, 1 personal note');
  await expect(page.locator('details[data-node="first-one"] .mini-notes')).toHaveCount(0);
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

async function selectCode(page) {
  await page.locator('.drow code').first().evaluate((el) => {
    const range = document.createRange(); range.selectNodeContents(el);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  });
}

test('a local resolve during a selection does not mark a reopened server revision as shown', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('reopened')];
  await mount(page, data, { openThreads: { first: true } });
  await openFile(page);
  await selectCode(page);
  const badge = page.locator('.tb-btn[data-action="toggle-notes"]');
  data.feedback[0].comments.push({ author: 'agent', body: 'Agent reply', createdAt: '2026-09-08T10:01:00Z' });
  data.viewerRevision = 'with-reply';
  await expect(page.locator('.stage .tthread')).toContainText('Agent reply');
  // Another session reopens the thread before the next poll, returning the server to the revision shown.
  await page.route((url) => url.pathname === '/api/feedback/resolve', (route) => route.fulfill({ json: { ok: true, status: 'resolved' } }));
  await page.locator('.stage [data-action="thread-resolve"]').dispatchEvent('click');
  await expect(badge).toHaveText('Notes 0');
  await expect(badge).toHaveText('Notes 1');
  expect(await page.evaluate(() => String(window.getSelection()))).toContain('const first');
});

test('a local resolve undone elsewhere shows the server\'s thread again', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('undone')];
  await mount(page, data, { openThreads: { first: true } });
  const badge = page.locator('.tb-btn[data-action="toggle-notes"]');
  await expect(badge).toHaveText('Notes 1');
  // The resolve is accepted, but another session reopens the thread before the
  // next poll, so the server is back at the revision the page loaded.
  await page.route((url) => url.pathname === '/api/feedback/resolve', (route) => route.fulfill({ json: { ok: true, status: 'resolved' } }));
  await page.locator('.stage [data-action="thread-resolve"]').click();
  await expect(badge).toHaveText('Notes 0');
  await expect(badge).toHaveText('Notes 1');
});

test('a local resolve after feedback adopted during a selection still converges on the server', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('elsewhere'), thread('local')];
  await mount(page, data, { openThreads: { first: true } });
  await openFile(page);
  await selectCode(page);
  const badge = page.locator('.tb-btn[data-action="toggle-notes"]');
  await expect(badge).toHaveText('Notes 2');
  // Another session resolves one thread, which the selection picks up.
  data.feedback[0].status = 'resolved';
  const initial = data.viewerRevision;
  data.viewerRevision = 'one-resolved';
  await expect(badge).toHaveText('Notes 1');
  // The reviewer resolves the other; the other session then reopens both, returning the server to the first revision.
  await page.route((url) => url.pathname === '/api/feedback/resolve', (route) => route.fulfill({ json: { ok: true, status: 'resolved' } }));
  await page.locator('.stage [data-thread-id="local"] [data-action="thread-resolve"]').dispatchEvent('click');
  await expect(badge).toHaveText('Notes 0');
  data.feedback[0].status = 'open';
  data.viewerRevision = initial;
  await expect(badge).toHaveText('Notes 2');
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await expect(badge).toHaveText('Notes 2');
});

test('a selection records the revision of the adopted data, not the one the probe reported', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('raced')];
  await mount(page, data, { openThreads: { first: true } });
  await openFile(page);
  await selectCode(page);
  const badge = page.locator('.tb-btn[data-action="toggle-notes"]');
  // The probe reports B; the implementation has moved on to C by the time it is fetched.
  await page.route((url) => url.pathname === '/api/implementation', (route) => {
    data.feedback[0].status = 'resolved';
    data.viewerRevision = 'C';
    return route.fallback();
  }, { times: 1 });
  data.viewerRevision = 'B';
  await expect(badge).toHaveText('Notes 0');
  // The server returns to B, whose thread is open.
  data.feedback[0].status = 'open';
  data.viewerRevision = 'B';
  await expect(badge).toHaveText('Notes 1');
  expect(await page.evaluate(() => String(window.getSelection()))).toContain('const first');
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

test('stage rationale shows only its label and reveals the text in a tooltip', async ({ page }) => {
  const data = fixture();
  data.stages[0].rationale = 'Split out so the shared helper is reviewed before its callers.';
  await mount(page, data);
  const label = page.locator('.stage[data-stage="first"] .rationale-label');
  await expect(label).toHaveText('Why this stage');
  await expect(page.locator('.stage[data-stage="first"] .stage-head')).not.toContainText('shared helper');
  const tooltip = page.locator('[role="tooltip"]');
  await label.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(data.stages[0].rationale);
  await page.mouse.move(0, 0);
  await expect(tooltip).not.toHaveClass(/is-shown/);
  await label.focus();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(data.stages[0].rationale);
  await expect(label).toHaveAttribute('aria-describedby', 'review-tooltip');
});

test('a long stage rationale tooltip stays within the viewport and scrolls', async ({ page }) => {
  const data = fixture();
  data.stages[0].rationale = 'This stage exists because of a long chain of reasons. '.repeat(50).trim();
  await page.setViewportSize({ width: 390, height: 600 });
  await mount(page, data);
  await page.locator('.stage[data-stage="first"] .rationale-label').hover();
  const tooltip = page.locator('[role="tooltip"]');
  await expect(tooltip).toBeVisible();
  await expect.poll(() => tooltip.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight && el.scrollHeight > el.clientHeight;
  })).toBe(true);
  await tooltip.hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => tooltip.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(tooltip).toBeVisible();
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
  await expect(page.locator('details[data-node="first-two"] .mini-threads')).toHaveAttribute('aria-label', '2 file comments, 1 personal note');
  await openFile(page, 'first-one');
  await expect(page.locator('.file-notes .tthread')).toHaveCount(0);
  await showNotes(page);
  const localFileLabel = page.locator('.side.notes .tnote').filter({ hasText: 'Local renamed file' }).locator('.tthread-title');
  await expect(localFileLabel).toHaveText('renamed.js');
  await expect(localFileLabel).not.toHaveAttribute('data-tooltip');
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
  await reload(page);
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

test('loading the viewer moves approvals to renamed files and revokes unfinished stage approvals', async ({ page }) => {
  const data = fixture();
  Object.assign(data.stages[0].files[0], { kind: 'renamed', previousPath: 'old.js' });
  const previous = approvalKey('first', 'first-one', 'old.js');
  // No snapshot is adopted after loading, as the revision stays the same.
  await saveAction(page, () => mount(page, data, { approvals: { [previous]: { rev: 'previous', at: 1 }, first: { rev: null, at: 1 } } }),
    (state) => !state.approvals[previous] && !state.approvals.first && state.approvals[approvalKey('first', 'first-one')]?.rev === 'previous');
  await expect(page.locator('details[data-node="first-one"] .frow')).toHaveClass(/is-stale/);
  await expect(page.locator('.stage[data-stage="first"]')).not.toHaveClass(/is-approved/);
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
  await reload(page);
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
  await expect(page).toHaveURL('http://localhost/worktree-b');
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
  await expect(page).toHaveURL('http://localhost/');
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
  await reload(page);
  await expect(one.locator('.frow')).not.toHaveClass(/is-approved/);
  await expect(two.locator('.frow')).toHaveClass(/is-approved/);
});

test('each stage contains its steps and ends with an approval naming the stage', async ({ page }) => {
  await mount(page);
  const first = page.locator('.stage[data-stage="first"]');
  await expect(page.getByRole('region', { name: 'Stage first' })).toHaveAttribute('data-stage', 'first');
  await expect(first.locator('.stage-kicker')).toHaveText('Stage 01');
  await expect(first.locator('.stage-body')).toHaveAttribute('inert', '');
  await page.locator('.stage-title[data-id="first"]').click();
  await expect(first.locator('.stage-body')).not.toHaveAttribute('inert');
  await expect(first.locator('.stage-children-head')).toContainText('Steps in stage 01');
  await expect(first.locator('.stage-children-head')).toContainText('0/2 approved');
  await expect(first.locator('.stage-card .nodes details.node')).toHaveCount(2);
  // The footer approval comes after the stage's last step and before the next stage.
  const footApproval = first.locator('.stage-foot .approve');
  await expect(first.locator('.stage-foot')).toContainText('End of stage 01');
  await expect(footApproval).toHaveText('Approve stage 01');
  await expect(footApproval).toHaveAccessibleName('Approve stage 01: Stage first');
  await expect(first.locator('.stage-approve .approve')).toHaveAccessibleName('Approve stage 01: Stage first');
  await expect(footApproval).toBeDisabled();
  const positions = await page.evaluate(() => {
    const top = (sel) => document.querySelector(sel).getBoundingClientRect().top;
    return { lastStep: top('details[data-node="first-two"]'), foot: top('.stage[data-stage="first"] .stage-foot'), next: top('.stage[data-stage="second"]') };
  });
  expect(positions.lastStep).toBeLessThan(positions.foot);
  expect(positions.foot).toBeLessThan(positions.next);
  for (const node of ['first-one', 'first-two']) {
    const details = page.locator(`details[data-node="${node}"]`);
    await details.locator('summary').click();
    await saveAction(page, () => details.locator('.mini-approve').click(), (state) => !!state.approvals?.[approvalKey('first', node)]);
  }
  await expect(first.locator('.stage-children-head')).toContainText('2/2 approved');
  await saveAction(page, () => footApproval.click(), (state) => !!state.approvals?.first);
  await expect(footApproval).toHaveText('✓Approved stage 01');
  await expect(footApproval).toHaveAccessibleName('Approved stage 01: Stage first');
  await expect(first.locator('.stage-approve .approve')).toHaveAttribute('aria-pressed', 'true');
  await expect(first).toHaveClass(/is-approved/);
});

test('on narrow screens the stage title reports and follows its expansion state', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await mount(page);
  const title = page.locator('.stage-title[data-id="first"]');
  await expect(page.locator('.stage[data-stage="first"] .stop')).toBeHidden();
  await expect(title).toHaveAttribute('aria-expanded', 'false');
  await title.click();
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  await title.click();
  await expect(title).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Find file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Find a file' });
  await dialog.getByRole('combobox').press('Enter');
  await expect(page.locator('.stage[data-stage="first"] .stage-body')).not.toHaveAttribute('inert');
  await expect(title).toHaveAttribute('aria-expanded', 'true');
});

function folderFixture() {
  const data = fixture(), file = (path, project) => ({ path, project, kind: 'modified', revision: `rev-${path}`, additions: 1, deletions: 0,
    memberships: [{ nodeId: 'first-one', classification: 'behavior' }], lines: [{ t: 'add', n: 1, s: 'x', h: 1 }] });
  data.stages[0].files.push(file('web/a.js', 'web'), file('web/b.js', 'web'), file('web/c.js', 'web'), file('web/d.js', 'web'), file('api/e.js', 'api'));
  return data;
}
async function openFolders(page) {
  await page.locator('.stage-title[data-id="first"]').click();
  const node = page.locator('details[data-node="first-one"]');
  await node.locator('summary').click();
  const group = (name) => node.locator('.fgroup').filter({ has: page.locator('.fg-name', { hasText: new RegExp(`^${name}$`) }) });
  return { node, web: group('web'), api: group('api') };
}

test('folder approval approves its pending and stale files only', async ({ page }) => {
  const staleKey = approvalKey('first', 'first-one', 'web/c.js'), doneKey = approvalKey('first', 'first-one', 'web/d.js');
  const done = { rev: JSON.stringify(['rev-web/d.js', 'behavior', null, null]), at: 1, path: 'web/d.js', snapshotId: 'd'.repeat(32) };
  await mount(page, folderFixture(), { approvals: { [staleKey]: { rev: JSON.stringify(['old', 'behavior', null, null]), at: 1, path: 'web/c.js' }, [doneKey]: done } });
  const captured = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/approval-snapshots') captured.push(request.postDataJSON().path); });
  const { node, web, api } = await openFolders(page);
  await expect(web.locator('.fg-done')).toHaveText('1/4');
  await expect(web.locator('.frow.is-stale')).toHaveCount(1);
  await saveAction(page, () => web.locator('.fg-approve').click(), (state) =>
    ['web/a.js', 'web/b.js', 'web/c.js'].every((path) => state.approvals?.[approvalKey('first', 'first-one', path)]?.rev?.includes(`rev-${path}`)));
  expect(captured.sort()).toEqual(['web/a.js', 'web/b.js', 'web/c.js']);
  await expect(web.locator('.frow.is-approved')).toHaveCount(4);
  await expect(web.locator('.fg-done')).toHaveText('✓ 4/4');
  await expect(web.locator('.fg-approve')).toBeDisabled();
  await expect(api.locator('.fg-done')).toHaveText('0/1');
  await expect(api.locator('.fg-approve')).toBeEnabled();
  await expect(node.locator('.frow.is-approved')).toHaveCount(4);
  await reload(page);
  await expect(web.locator('.fg-done')).toHaveText('✓ 4/4');
  expect(await page.evaluate(async (key) => (await (await fetch('/api/review-state')).json()).state.approvals[key], doneKey)).toEqual(done);
});

test('a failed snapshot in folder approval leaves the other files approved', async ({ page }) => {
  await mount(page, folderFixture());
  await page.route('**/api/approval-snapshots*', (route) => route.request().postDataJSON().path === 'web/b.js'
    ? route.fulfill({ status: 409, json: { ok: false, error: 'The file changed. Refresh before approving.' } })
    : route.fulfill({ json: { ok: true, snapshotId: 'a'.repeat(32) } }));
  const { web } = await openFolders(page);
  await web.locator('.fg-approve').click();
  await expect(page.locator('[role="alert"]')).toContainText('web/b.js');
  await expect(web.locator('.fg-done')).toHaveText('3/4');
  await expect(web.locator('.frow-wrap', { hasText: 'b.js' }).locator('.frow')).not.toHaveClass(/is-approved/);
  await page.unroute('**/api/approval-snapshots*');
  await web.locator('.fg-approve').click();
  await expect(web.locator('.fg-done')).toHaveText('✓ 4/4');
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});

for (const legacy of [false, true]) test(`file approvals survive unchanged restacks (${legacy ? 'existing' : 'new'} record)`, async ({ page }) => {
  const data = fixture(), key = approvalKey('first', 'first-one');
  await mount(page, data, legacy ? { approvals: { [key]: { rev: firstMembershipRevision, at: 1, path: 'shared.js' } } } : {});
  await openFile(page);
  const row = page.locator('details[data-node="first-one"] .frow');
  if (!legacy) await saveAction(page, () => row.locator('.mini-approve').click(), state => !!state.approvals?.[key]);
  data.stages[0].baseRevision = 'c'.repeat(40);
  data.stages[0].headRevision = 'd'.repeat(40);
  data.viewerRevision = 'restacked';
  await reload(page);
  await expect(row).toHaveClass(/is-approved/);
  await expect(row).not.toHaveClass(/is-stale/);
  await expect(page.getByRole('button', { name: 'Since approval', exact: true })).toHaveCount(0);
  data.stages[0].files[0].memberships[0].classification = 'refactor';
  data.viewerRevision = 'classification-changed';
  await reload(page);
  await expect(row).toHaveClass(/is-stale/);
});

test('an approval saved under an unknown classification still matches', async ({ page }) => {
  // The server sends a classification this viewer does not know only as recorded.
  const data = fixture(), key = approvalKey('first', 'first-one');
  const membership = data.stages[0].files[0].memberships[0];
  delete membership.classification;
  membership.recordedClassification = 'mystery';
  await mount(page, data, { approvals: { [key]: { rev: JSON.stringify(['rev', 'mystery', [1], null]), at: 1, path: 'shared.js' } } });
  await openFile(page);
  const row = page.locator('details[data-node="first-one"] .frow');
  await expect(row).toHaveClass(/is-approved/);
  await expect(row).not.toHaveClass(/is-stale/);
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


test('since-approval comparison is explicit and shows current line anchors', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread("current-line", "open", { kind: "line", stageId: "first", path: "shared.js", side: "new", line: 1, label: "Current line" })];
  await mount(page, data, { comments: [{ kind: "line", id: "l:first:new:1:shared.js", nodeId: "first-one", exported: true, threadId: "current-line", body: "Feedback current-line" }] });
  await openFile(page);
  await saveAction(page, () => page.locator('details[data-node="first-one"] .mini-approve').click(), (state) => !!state.approvals?.[approvalKey('first', 'first-one')]?.snapshotId);
  const endpoint = { path: 'shared.js', headRevision: 'b'.repeat(40), mode: '100644', exists: true, size: 20, sha256: 'hash' };
  await page.route('**/api/approval-comparison*', (route) => route.fulfill({ json: { ok: true, approved: endpoint, current: { ...endpoint, headRevision: 'c'.repeat(40) }, baseChanged: true, ownershipChanged: true, lines: [{ t: 'del', o: 1, s: 'already approved' }, { t: 'add', n: 1, s: 'new content' }], offset: 0, nextOffset: null } }));
  data.stages[0].files[0].revision = 'changed'; data.viewerRevision = 'after-approval';
  await expect(page.locator('details[data-node="first-one"] .frow')).toHaveClass(/is-stale/);
  await openFile(page);
  await expect(page.getByRole('button', { name: 'Since approval', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const comparison = page.locator('.is-approved-comparison');
  await expect(comparison).toContainText('already approved'); await expect(comparison).toContainText('new content');
  await expect(comparison.locator('.comparison-info')).not.toContainText('Approved:');
  await expect(comparison).toContainText('stage base changed'); await expect(comparison).toContainText('ownership or classification changed');
  await expect(comparison.locator('.d-add .lact[data-id="l:first:new:1:shared.js"]')).toHaveClass(/has-note/);
  await expect(comparison.locator('.d-del')).toHaveCount(1);
  await expect(comparison.locator('.d-del [data-line-id], .d-del .lact')).toHaveCount(0);
  await page.getByRole('button', { name: 'Hide removed', exact: true }).click();
  await expect(comparison.locator('.d-del')).toBeHidden();
  const full = page.waitForRequest(r => r.url().includes('/api/approval-comparison') && r.postDataJSON()?.mode === 'full');
  await page.getByRole('button', { name: 'Full file', exact: true }).click();
  await full;
  await expect(comparison.getByRole('button', { name: 'Full file', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await showNotes(page);
  await page.locator('.side.notes [data-action="jump-to"][data-kind="line"]').click();
  await expect(page.getByRole('button', { name: 'Since approval', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.cinema-diff .lact')).not.toHaveCount(0);
  await expect(page.locator('.cinema-diff')).toContainText('const first = 1;');
  await page.locator('details[data-node="first-one"] .mini-approve').click();
  // Approving closes the file once it has saved. Opening it sooner would race that close.
  await expect(page.locator('details[data-node="first-one"] .cinema-diff')).toHaveCount(0);
  await openFile(page);
  await expect(page.getByRole('button', { name: 'Since approval', exact: true })).toHaveCount(0);
});

test('since-approval comparison leaves out base changes until the reviewer includes them', async ({ page }) => {
  const data = fixture();
  await mount(page, data);
  await openFile(page);
  await saveAction(page, () => page.locator('details[data-node="first-one"] .mini-approve').click(), (state) => !!state.approvals?.[approvalKey('first', 'first-one')]?.snapshotId);
  const endpoint = { path: 'shared.js', headRevision: 'b'.repeat(40), mode: '100644', exists: true, size: 20, sha256: 'hash' };
  const scopes = [];
  await page.route('**/api/approval-comparison*', (route) => {
    const scope = route.request().postDataJSON().scope; scopes.push(scope);
    route.fulfill({ json: { ok: true, approved: endpoint, current: endpoint, baseChanged: true, baseChanges: scope === 'all' ? 'included' : 'excluded', ownershipChanged: false, lines: scope === 'all' ? [{ t: 'add', n: 1, s: 'from target branch' }] : [], offset: 0, nextOffset: null } });
  });
  data.stages[0].files[0].revision = 'changed'; data.viewerRevision = 'after-approval';
  await expect(page.locator('details[data-node="first-one"] .frow')).toHaveClass(/is-stale/);
  await openFile(page);
  const comparison = page.locator('.is-approved-comparison');
  await expect(comparison).toContainText('shows only what changed in this stage');
  await expect(comparison).toContainText('Only its base changed');
  await comparison.getByRole('button', { name: 'Include base changes', exact: true }).click();
  await expect(comparison).toContainText('from target branch');
  await expect(comparison).toContainText('not made in this stage');
  await comparison.getByRole('button', { name: 'Leave out base changes', exact: true }).click();
  await expect(comparison).not.toContainText('from target branch');
  expect(scopes.slice(0, 2)).toEqual(['stage', 'all']);
});

test('a target refresh shows a notice until the reviewer dismisses it', async ({ page }) => {
  const now = new Date().toISOString();
  const refresh = { at: now, targetBranch: 'main', previousBaseRevision: 'a'.repeat(40), baseRevision: 'b'.repeat(40) };
  await mount(page, { ...fixture(), agent: { session: false, listening: false, stopRequested: false, working: null, requests: [], lastRound: null, targetRefresh: refresh, serverTime: now } });
  const notice = page.locator('.agent-bar.is-refreshed');
  await expect(notice).toContainText('Moved onto the latest main');
  await expect(notice).toContainText('those edits are not review corrections');
  await saveAction(page, () => notice.getByRole('button', { name: 'Dismiss', exact: true }).click(), (state) => state.dismissedTargetRefresh === now);
  await expect(notice).toHaveCount(0);
  await reload(page);
  await expect(page.locator('.topbar, header').first()).toBeVisible();
  await expect(notice).toHaveCount(0);
});

test('line comments added in a since-approval comparison attach to the current file line', async ({ page }) => {
  const data = fixture();
  await mount(page, data);
  await openFile(page);
  await saveAction(page, () => page.locator('details[data-node="first-one"] .mini-approve').click(), (state) => !!state.approvals?.[approvalKey('first', 'first-one')]?.snapshotId);
  const endpoint = { path: 'shared.js', headRevision: 'b'.repeat(40), mode: '100644', exists: true, size: 20, sha256: 'hash' };
  // The approved line numbers differ from the current ones, so a mix-up would attach to the wrong line.
  await page.route('**/api/approval-comparison*', (route) => route.fulfill({ json: { ok: true, approved: endpoint, current: endpoint, baseChanged: false, ownershipChanged: false, lines: [{ t: 'del', o: 5, s: 'already approved' }, { t: 'ctx', o: 6, n: 1, s: 'unchanged' }, { t: 'add', n: 2, s: 'new content' }], offset: 0, nextOffset: null } }));
  data.stages[0].files[0].revision = 'changed'; data.viewerRevision = 'after-approval';
  await expect(page.locator('details[data-node="first-one"] .frow')).toHaveClass(/is-stale/);
  await openFile(page);
  const comparison = page.locator('.is-approved-comparison');
  await expect(comparison).toContainText('new content');
  await expect(comparison.locator('.d-del .lact')).toHaveCount(0);
  await expect(comparison.locator('.d-ctx [data-action="line-note"]')).toHaveAttribute('data-id', 'l:first:new:1:shared.js');
  await comparison.locator('.d-add .lact').click();
  await page.locator('textarea[name="nc-body"]').fill('Comment since approval');
  await saveAction(page, () => page.locator('textarea[name="nc-body"]').press('Control+Enter'), (state) =>
    state.comments?.some((note) => note.kind === 'line' && note.id === 'l:first:new:2:shared.js' && note.nodeId === 'first-one' && note.body === 'Comment since approval'));
  await expect(comparison.locator('.line-thread[data-thread="l:first:new:2:shared.js"]')).toContainText('Comment since approval');
  await page.getByRole('button', { name: 'Since approval', exact: true }).click();
  await expect(page.locator('.cinema-diff [data-line-id="l:first:new:2:shared.js"] .lact')).toHaveClass(/has-note/);
});

test('approving a file closes only that file and persists the collapse', async ({ page }) => {
    await mount(page, fixture(), { openStages: { first: true, second: true }, activeFiles: { 'f:second:shared.js': 'second-one' } });
    await openFile(page);
    await page.locator('details[data-node="second-one"] summary').click();
    const node = page.locator('details[data-node="first-one"]');
    await saveAction(page, () => node.locator('.mini-approve').click(), state =>
      !!state.approvals?.[approvalKey('first', 'first-one')] && !state.activeFiles?.[fileId]);
    await expect(node.locator('.cinema-diff')).toHaveCount(0);
    await expect(page.locator('details[data-node="second-one"] .cinema-diff')).toBeVisible();
    await openFile(page);
    await saveAction(page, () => node.locator('.mini-approve').click(), state => !state.approvals?.[approvalKey('first', 'first-one')]);
    await expect(node.locator('.cinema-diff')).toBeVisible();
    await saveAction(page, () => node.locator('.mini-approve').click(), state => !!state.approvals?.[approvalKey('first', 'first-one')] && !state.activeFiles?.[fileId]);
    await reload(page);
    await node.locator('summary').click();
    await expect(node.locator('.cinema-diff')).toHaveCount(0);
});

for (const mode of ['personal', 'feedback', 'edit', 'reply']) {
  test(`${mode} comment autosave waits for 300 ms of idle typing without a save notice`, async ({ page }) => {
    const data = fixture();
    if (mode === 'personal') data.remote = { branch: 'feature', targetBranch: 'main' };
    if (mode === 'reply') data.feedback = [thread('autosave')];
    const saved = mode === 'edit' ? { comments: [{ kind: 'file', id: fileId, nodeId: 'first-one', body: 'Original', mode: 'personal', createdAt: 1 }] } : {};
    await mount(page, data, saved);
    if (mode === 'reply' || mode === 'edit') {
      await saveAction(page, () => showNotes(page), state => state.notesOpen);
      if (mode === 'reply') await page.locator('.side.notes [data-action="thread-reply"]').click();
      else await saveAction(page, () => page.locator('.side.notes [data-action="edit-note"]').click(), state => !!state.editor?.compose);
    } else {
      await openFile(page);
      await saveAction(page, () => page.locator('.file-notes .thread-add').click(), state => !!state.editor?.compose);
      if (mode === 'feedback') await saveAction(page, () => page.locator('.nc-opt').filter({ hasText: 'Feedback' }).click(), state => state.editor?.compose?.mode === 'feedback');
    }
    await page.clock.install();
    await page.clock.pauseAt(await page.evaluate(() => Date.now()));
    const requests = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/review-state' && request.method() === 'POST') requests.push(request.postDataJSON());
    });
    const input = page.locator(mode === 'reply' ? 'textarea[name="reply-body"]' : 'textarea[name="nc-body"]');
    await input.fill('First');
    await page.clock.runFor(200);
    expect(requests).toHaveLength(0);
    await input.fill('Latest');
    await page.clock.runFor(299);
    expect(requests).toHaveLength(0);
    await expect(page.locator('#save-status')).toBeHidden();
    await saveAction(page, () => page.clock.runFor(1), state => (mode === 'reply' ? state.editor?.replyDraft : state.editor?.compose?.body) === 'Latest');
    expect(requests).toHaveLength(1);
    await page.clock.runFor(500);
    expect(requests).toHaveLength(1);
  });
}

test('an in-flight autosave respects the debounce for newer comment text', async ({ page }) => {
  await mount(page);
  await openFile(page);
  await saveAction(page, () => page.locator('.file-notes .thread-add').click(), state => !!state.editor?.compose);
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()));
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let writes = 0;
  await page.route('**/api/review-state*', async route => {
    if (route.request().method() === 'POST' && ++writes === 1) await pending;
    return route.fallback();
  });
  const input = page.locator('textarea[name="nc-body"]');
  await input.fill('First save');
  const firstRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/review-state' && request.method() === 'POST');
  await page.clock.runFor(300);
  await firstRequest;
  await expect(page.locator('#save-status')).toBeHidden();
  await input.fill('Newer text');
  await page.clock.runFor(100);
  await saveAction(page, () => release(), state => state.editor?.compose?.body === 'First save');
  await page.clock.runFor(199);
  expect(writes).toBe(1);
  await saveAction(page, () => page.clock.runFor(1), state => state.editor?.compose?.body === 'Newer text');
  expect(writes).toBe(2);
});

test('approval waits for durable state and keeps the diff open when saving fails', async ({ page }) => {
  await mount(page);
  await openFile(page);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/review-state*', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().changes.some(change => change.path[0] === 'approvals')) {
      await pending;
      return route.fulfill({ status: 500, json: { ok: false, error: 'Storage unavailable' } });
    }
    return route.fallback();
  });
  const node = page.locator('details[data-node="first-one"]');
  await node.locator('.mini-approve').click();
  await expect(page.locator('#save-status')).toBeHidden();
  await expect(node.locator('.cinema-diff')).toBeVisible();
  release();
  await expect(page.locator('#save-status')).toContainText('Storage unavailable');
  await expect(node.locator('.cinema-diff')).toBeVisible();
  await page.reload();
  await openFile(page);
  await expect(node.locator('.mini-approve')).toHaveAttribute('aria-pressed', 'false');
  await expect(node.locator('.cinema-diff')).toBeVisible();
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
  await expect(page).toHaveURL('http://localhost/');
  release();
  await expect(page).toHaveURL('http://localhost/b');
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
  await reload(page);
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
  await reload(page);
  await expect(page.locator('.note-compose .attachment-name')).toHaveText('context.png');
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
  await page.locator('[data-reply-form] textarea').evaluate((form) => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['log content'], 'debug.log', { type: 'text/plain' }));
    form.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.locator('[data-reply-form] .attachment-name')).toHaveText('debug.log');
  await expect(page.getByRole('button', { name: 'Save reply', exact: true })).toBeEnabled();
  await page.locator('textarea[name="reply-body"]').evaluate((input) => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['image bytes'], 'pasted.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  await expect(page.locator('[data-reply-form] .attachment')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Save reply', exact: true })).toBeEnabled();
  await saveAction(page, () => page.getByRole('button', { name: 'Save reply', exact: true }).click(), (state) => state.replyDrafts?.[0]?.attachments?.length === 2);
  await reload(page);
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
  await expect(page).toHaveURL('http://localhost/'); release();
  await expect(page).toHaveURL('http://localhost/b');
  await expect(page.locator('.attachment')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.locator('[data-review="a"]').getByRole('button', { name: 'Open review', exact: true }).click();
  await expect(page.locator('.note-compose .attachment-name')).toHaveText('only-a.log');
  await expect(page.locator('.attachment a, .attachment [download]')).toHaveCount(0);
  const id = await page.evaluate(async () => (await (await fetch('/api/review-state?review=a')).json()).state.editor.compose.attachments[0].id);
  const attachmentUrl = `http://localhost/api/attachments/${id}?review=a&generation=test`;
  expect(await page.evaluate(async (url) => { const other = new URL(url); other.searchParams.set('review', 'b'); return (await fetch(other)).status; }, attachmentUrl)).toBe(404);
});


test('review deletion previews data, requires confirmation, and leaves other reviews accessible', async ({ page }) => {
  const a = { ...fixture(), reviewId: 'a', title: 'Review A' }, b = { ...fixture(), reviewId: 'b', title: 'Review B' };
  const errors = await mount(page, a, { comments: [{ kind: 'stage', id: 'first', mode: 'feedback', body: 'Unsent feedback' }] }, [b]);
  let deletions = 0; page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/reviews/delete') deletions++; });
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.locator('[data-review="a"]').getByRole('button', { name: 'Delete data…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review data', exact: true });
  await expect(dialog).toContainText('1 unsent draft'); await expect(dialog).toContainText('1 unresolved feedback');
  await expect(dialog).toContainText('/user-data/reviews/a'); expect(deletions).toBe(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(deletions).toBe(0);
  await page.locator('[data-review="a"]').getByRole('button', { name: 'Delete data…', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete review data', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Review data deleted' })).toBeVisible();
  await expect(page.locator('[data-review="a"]')).toHaveCount(0); expect(deletions).toBe(1);
  await page.locator('[data-review="b"]').getByRole('button', { name: 'Open review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review B', exact: true })).toBeVisible();
  await page.goto('http://localhost/a');
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
  const dialog = page.getByRole('dialog', { name: 'Review data', exact: true }); await expect(dialog.getByRole('button', { name: 'Delete review data', exact: true })).toBeEnabled();
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


test('a failed deletion reports where the files are held and can be retried', async ({ page }) => {
  await mount(page); let failed = false, gone = false;
  const failure = 'Could not clean /user-data/reviews/review/locked.bin (EBUSY). Editor (PID 123) is using the file. Close it, then Use Refresh details, then retry deletion. Do not delete review files manually.';
  const record = { id: 'browser-review', generation: 'test', title: 'Review fixes', repositoryRoot: '/repos/review', implementationId: 'browser-review', updatedAt: '2026-09-11T10:00:00Z', completedAt: null };
  await page.route('**/api/reviews?*', (route) => route.fulfill({ json: { ok: true, reviews: gone ? [] : [{ ...record, available: true }] } }));
  await page.route('**/api/reviews/storage?*', (route) => route.fulfill({ json: { ok: true, storage: { review: record, storageDirectory: '/user-data/reviews/review', bytes: 1024, categories: [], drafts: 0, unresolved: 0, fingerprint: 'preview', unused: [], unusedBytes: 0 } } }));
  await page.route('**/api/reviews/delete?*', (route) => {
    if (!failed) { failed = true; return route.fulfill({ status: 500, json: { ok: false, error: failure } }); }
    gone = true; return route.fulfill({ json: { ok: true, deleted: true } });
  });
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.getByRole('button', { name: 'Delete data…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review data', exact: true }); await dialog.getByRole('button', { name: 'Delete review data', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('/user-data/reviews/review/locked.bin');
  await expect(dialog.getByRole('alert')).toContainText('Editor (PID 123)');
  await expect(page.locator('[data-review="browser-review"]')).toHaveCount(1);
  await expect(page.locator('[data-review="browser-review"]')).not.toContainText('Deletion pending');
  await dialog.getByRole('button', { name: 'Delete review data', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.locator('[data-review="browser-review"]')).toHaveCount(0);
});

test('unused-file cleanup keeps the review and its saved messages', async ({ page }) => {
  await mount(page); let cleaned = false;
  await page.route('**/api/reviews/storage?*', (route) => route.fulfill({ json: { ok: true, storage: { storageDirectory: '/user-data/reviews/browser-review', bytes: cleaned ? 1024 : 2048, categories: [], drafts: 1, unresolved: 0, fingerprint: 'preview', unused: cleaned ? [] : [{ path: 'attachments/unused', bytes: 1024 }], unusedBytes: cleaned ? 0 : 1024 } } }));
  await page.route('**/api/reviews/clean-unused?*', (route) => { cleaned = true; return route.fulfill({ json: { ok: true, reclaimedBytes: 1024, failures: [] } }); });
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.getByRole('button', { name: 'Delete data…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review data', exact: true }); await dialog.getByRole('button', { name: 'Clean unused files', exact: true }).click();
  await expect(dialog.getByText('Reclaimed 1.0 KiB.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Clean unused files', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('[data-review="browser-review"]')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Review fixes', exact: true })).toBeVisible();
});


test('uploads selected while busy are queued even when filenames match', async ({ page }) => {
  await mount(page); await openFile(page); await page.locator('.file-notes .thread-add').click();
  let release; const pending = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/attachments?*', async (route) => { await pending; await route.fallback(); });
  const file = (body) => ({ name: 'same.log', mimeType: 'text/plain', buffer: Buffer.from(body) });
  await page.getByLabel('Attach files', { exact: true }).setInputFiles(file('first'));
  await expect(page.locator('.note-compose').getByRole('status')).toContainText('Uploading');
  await page.getByLabel('Attach files', { exact: true }).setInputFiles(file('other'));
  release(); await expect(page.locator('.note-compose .attachment')).toHaveCount(2);
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
  expect(uploads).toBe(10); await expect(page.locator('.note-compose .attachment')).toHaveCount(10);
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ ...file('0.log'), buffer: Buffer.from('other') });
  await expect(page.getByRole('button', { name: 'Add note', exact: true })).toBeEnabled();
  expect(uploads).toBe(10); await expect(page.locator('.note-compose .attachment')).toHaveCount(10);
});

test('review picker overlays the page and Escape dismisses it without discarding the composer', async ({ page }) => {
  await mount(page); await openFile(page); await page.locator('.file-notes .thread-add').click();
  await page.locator('textarea[name="nc-body"]').fill('Keep this unfinished draft');
  const stageTop = () => page.locator('.stage').first().evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  const before = await stageTop();
  await page.evaluate(() => { window.keptStage = document.querySelector('.stage'); });
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await expect(page.locator('#review-list')).toBeVisible();
  expect(await stageTop()).toBeCloseTo(before, 0);
  expect(await page.locator('#review-list').evaluate(el => el.matches(':modal'))).toBe(true);
  expect(await page.evaluate(() => window.keptStage === document.querySelector('.stage'))).toBe(true);
  await page.locator('textarea[name="nc-body"]').evaluate(el => el.focus());
  expect(await page.evaluate(() => document.querySelector('#review-list').contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#review-list')).toHaveCount(0);
  expect(await page.evaluate(() => window.keptStage === document.querySelector('.stage'))).toBe(true);
  await expect(page.locator('textarea[name="nc-body"]')).toHaveValue('Keep this unfinished draft');
  await expect(page.getByRole('button', { name: 'Reviews', exact: true })).toBeFocused();
});

test('attachments use compact aligned rows without download links, including saved messages', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page); await openFile(page); await page.locator('.file-notes .thread-add').click();
  const name = 'A very long attachment filename that needs to fit in a narrow message.txt';
  await saveAction(page, () => page.getByLabel('Attach files', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('Context') }), (state) => state.editor?.compose?.attachments?.length === 1);
  const row = page.locator('.note-compose .attachment');
  await expect(row.locator('.attachment-name')).toHaveText(name);
  const alignment = await row.evaluate(el => {
    const name = el.querySelector('.attachment-name').getBoundingClientRect(), size = el.querySelector('small').getBoundingClientRect();
    return Math.abs((name.y + name.height / 2) - (size.y + size.height / 2));
  });
  expect(alignment).toBeLessThan(2);
  expect((await row.boundingBox()).height).toBeLessThanOrEqual(48);
  await expect(row.getByRole('button', { name: `Remove ${name}`, exact: true })).toBeVisible();
  await expect(page.locator('.attachments a, .attachments [download]')).toHaveCount(0);
  await saveAction(page, () => page.locator('.note-compose').getByRole('button', { name: 'Add note', exact: true }).click(), (state) => state.comments?.[0]?.attachments?.length === 1);
  await expect(page.locator('.tnote .attachment-name').first()).toHaveText(name);
  await expect(page.locator('.attachments a, .attachments [download]')).toHaveCount(0);
});

test('only message text fields accept file drops and highlight while files hover', async ({ page }) => {
  await mount(page); await openFile(page); await page.locator('.file-notes .thread-add').click();
  const input = page.locator('textarea[name="nc-body"]');
  await input.fill('Preserve this text');
  const drag = async (locator, type) => locator.evaluate((el, type) => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['demo'], 'context.log', {type: 'text/plain'}));
    el.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: transfer}));
  }, type);
  await drag(page.locator('.note-compose .nc-mode'), 'dragover');
  await expect(input).not.toHaveClass(/is-file-drop-target/);
  await drag(page.locator('.note-compose .nc-mode'), 'drop');
  await expect(page.locator('.attachment')).toHaveCount(0);
  await drag(input, 'dragover'); await expect(input).toHaveClass(/is-file-drop-target/);
  await drag(input, 'dragleave'); await expect(input).not.toHaveClass(/is-file-drop-target/);
  await drag(input, 'dragover'); await drag(input, 'drop');
  await expect(page.locator('.attachment-name')).toHaveText('context.log');
  await expect(input).not.toHaveClass(/is-file-drop-target/); await expect(input).toHaveValue('Preserve this text');
});

test('duplicate label tooltips are omitted and other-node hunk links use concise labels', async ({ page }) => {
  await mount(page); await openFile(page);
  await expect(page.locator('.frow-open').first()).not.toHaveAttribute('data-tooltip', /shared\.js/);
  const notice = page.locator('.ownership-notice').first();
  await expect(notice).toHaveText(/Edited in Step two/);
  await expect(notice.getByRole('button')).toHaveAttribute('data-tooltip', 'Show change node');
  await notice.getByRole('button').click();
  await expect(page.locator('details[data-node="first-two"] .cinema-diff')).toBeVisible();
});

test('unrelated approvals and attachment edits preserve open diffs, editor focus, selection and previews', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const errors = await mount(page, fixture(), { openStages: { first: true, second: true }, activeFiles: { [fileId]: 'first-one', 'f:second:shared.js': 'second-one' } });
  await openFile(page);
  await page.locator('details[data-node="second-one"] summary').click();
  await page.locator('details[data-node="first-one"] .file-notes .thread-add').click();
  const editor = page.locator('.note-compose textarea');
  await editor.fill('Keep this draft and its caret');
  await page.evaluate(() => {
    window.retainedDiffs = [...document.querySelectorAll('.cinema-diff, .diff-scroll, .diff-grid, .drow')];
    window.retainedEditor = document.querySelector('.note-compose textarea');
    window.detachedDiffs = [];
    new MutationObserver(records => {
      for (const record of records) for (const removed of record.removedNodes) {
        if (window.retainedDiffs.some(el => removed === el || removed.contains(el))) window.detachedDiffs.push(removed.nodeName);
      }
    }).observe(document.querySelector('#app'), { childList: true, subtree: true });
  });
  const expectRetained = async () => {
    expect(await page.evaluate(() => window.retainedDiffs.every(el => el.isConnected) && window.retainedEditor === document.querySelector('.note-compose textarea'))).toBe(true);
    expect(await page.evaluate(() => window.detachedDiffs)).toEqual([]);
  };
  await page.locator('details[data-node="first-two"] summary').click();
  const approval = page.locator('details[data-node="first-two"] .mini-approve');
  await page.route('**/api/approval-snapshots*', route => route.fulfill({ status: 409, json: { ok: false, error: 'Capture failed' } }));
  await approval.click();
  await expect(page.locator('[role="alert"]')).toContainText('Capture failed');
  await expectRetained();
  await page.unroute('**/api/approval-snapshots*');
  await saveAction(page, () => approval.click(), state => !!state.approvals?.[approvalKey('first', 'first-two')]);
  await expectRetained();
  await expect(page.locator('.cinema-diff')).toHaveCount(2);
  await saveAction(page, () => approval.click(), state => !state.approvals?.[approvalKey('first', 'first-two')]);
  await expectRetained();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'context.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.note-compose .attachment img')).toBeVisible();
  expect(await page.getByLabel('Attach files', { exact: true }).evaluate(el => el.files.length)).toBe(0);
  await expectRetained();
  await editor.focus();
  await editor.evaluate(el => { el.setSelectionRange(5, 9); window.retainedPreview = document.querySelector('.note-compose .attachment img'); });
  await editor.evaluate(el => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['Details'], 'details.txt', { type: 'text/plain' }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  });
  await expect(page.locator('.note-compose .attachment')).toHaveCount(2);
  await expect(editor).toBeFocused();
  expect(await editor.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([5, 9]);
  await expectRetained();
  await page.getByRole('button', { name: 'Remove details.txt', exact: true }).click();
  await expect(page.locator('.note-compose .attachment')).toHaveCount(1);
  await expectRetained();
  expect(await page.evaluate(() => window.retainedPreview === document.querySelector('.note-compose .attachment img'))).toBe(true);
  await page.locator('.note-compose').getByRole('button', { name: 'Add note', exact: true }).click();
  expect(await page.evaluate(() => window.retainedDiffs.every(el => el.isConnected))).toBe(true);
  await expect(page.locator('.file-notes .comment-body')).toContainText('Keep this draft and its caret');
  expect(await page.evaluate(() => window.detachedDiffs)).toEqual([]);
  expect(errors).toEqual([]);
});

test('combined file counts toggle notes independently of the diff and retain that choice', async ({ page }) => {
  await mount(page, fixture(), { comments: [
    { kind: 'file', id: fileId, nodeId: 'first-one', mode: 'personal', body: 'Personal observation', createdAt: 1 },
    { kind: 'file', id: fileId, nodeId: 'first-one', mode: 'feedback', body: 'File feedback', createdAt: 2 },
  ] });
  await openFile(page);
  const node = page.locator('details[data-node="first-one"]');
  const toggle = node.locator('.mini-threads');
  await expect(toggle).toHaveAccessibleName('1 file comment, 1 personal note');
  await page.evaluate(() => { window.retainedGrid = document.querySelector('.cinema-diff .diff-grid'); });
  await saveAction(page, () => toggle.click(), state => state.openThreads?.[fileId] === false);
  await expect(node.locator('.file-notes .tthread')).toHaveCount(0);
  await expect(node.locator('.file-notes .thread-add')).toBeVisible();
  await expect(node.locator('.file-notes')).toHaveCSS('border-bottom-width', '1px');
  await expect(node.locator('.cinema-diff')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await reload(page); await openFile(page);
  await expect(node.locator('.file-notes .tthread')).toHaveCount(0);
  await expect(node.locator('.file-notes .thread-add')).toBeVisible();
  await expect(node.locator('.file-notes')).toHaveCSS('border-bottom-width', '1px');
  await page.evaluate(() => { window.retainedGrid = document.querySelector('.cinema-diff .diff-grid'); });
  await toggle.click();
  await expect(node.locator('.file-notes')).toContainText('Personal observation');
  await expect(node.locator('.file-notes')).toContainText('File feedback');
  expect(await page.evaluate(() => window.retainedGrid === document.querySelector('.cinema-diff .diff-grid'))).toBe(true);
  await node.locator('.frow-open').click();
  await expect(node.locator('.cinema-diff')).toHaveCount(0);
  await toggle.click();
  await expect(node.locator('.cinema-diff')).toBeVisible();
  await expect(node.locator('.file-notes')).toBeVisible();
  await toggle.click();
  await node.locator('.file-notes .thread-add').click();
  await expect(node.locator('.file-notes textarea')).toBeVisible();
});

test('stored disclosures restore resolved feedback without implying approval', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('resolved-stage', 'resolved'), thread('resolved-node', 'resolved', { kind: 'node', stageId: 'first', nodeId: 'first-one', label: 'Step one' })];
  await mount(page, data, { openStages: { first: true }, openThreads: { first: true, 'n:first:first-one': true } });
  await page.locator('details[data-node="first-one"] summary').click();
  await expect(page.locator('.stage [data-thread-id="resolved-stage"]')).toBeVisible();
  await expect(page.locator('details[data-node="first-one"] [data-thread-id="resolved-node"]')).toBeVisible();
  await expect(page.locator('.stage .is-approved, .stage.is-approved, .frow.is-stale')).toHaveCount(0);
  await expect(page.locator('.stage-approve .notes-toggle[data-id="first"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.stage-approve .notes-toggle[data-id="first"]')).toHaveClass(/all-resolved/);
});

test('file highlights and hover styles survive repeated and interrupted close animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await mount(page); await openFile(page);
  const row = page.locator('details[data-node="first-one"] .frow');
  const toggle = row.locator('.frow-open');
  const holder = page.locator('details[data-node="first-one"] .cinema-diff');
  const finishRowMotion = () => row.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  await finishRowMotion();
  const activeBackground = await row.evaluate(el => getComputedStyle(el).backgroundColor);
  const activeShadow = await row.evaluate(el => getComputedStyle(el).boxShadow);
  for (let i = 0; i < 2; i++) {
    await toggle.click(); await expect(holder).toHaveCount(0);
    await page.mouse.move(0, 0); await finishRowMotion();
    const idleBackground = await row.evaluate(el => getComputedStyle(el).backgroundColor);
    await row.hover(); await finishRowMotion();
    expect(await row.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(idleBackground);
    await toggle.click(); await expect(holder).toBeVisible(); await finishRowMotion();
    await expect(row).toHaveCSS('background-color', activeBackground);
    await expect(row).toHaveCSS('box-shadow', activeShadow);
  }
  // Reopen while closing still owns a filled animation on this same row.
  await toggle.evaluate(el => { el.click(); el.click(); });
  await expect(holder).toBeVisible(); await finishRowMotion();
  await expect(row).toHaveCSS('background-color', activeBackground);
  await expect(row).toHaveCSS('box-shadow', activeShadow);
  expect(await row.evaluate(el => el.getAnimations().filter(animation => animation.effect.getTiming().fill === 'forwards').length)).toBe(0);
});

for (const change of ['add', 'del', 'replacement']) {
  test(`diff separates omitted lines after ${change} changes`, async ({ page }) => {
    const data = fixture(), file = data.stages[0].files[0];
    const changed = change === 'replacement'
      ? [{ t: 'del', o: 4, s: 'old', h: 1 }, { t: 'add', n: 4, s: 'new', h: 1 }]
      : [{ t: change, ...(change === 'add' ? { n: 4 } : { o: 4 }), s: 'changed', h: 1 }];
    const oldOffset = change === 'add' ? -1 : 0;
    const newOffset = change === 'del' ? -1 : 0;
    file.lines = [
      ...[1, 2, 3].map(n => ({ t: 'ctx', o: n, n, s: 'before' })),
      ...changed,
      ...[5, 6, 7, 21, 22, 23].map(n => ({ t: 'ctx', o: n + oldOffset, n: n + newOffset, s: 'context' })),
      { t: 'add', n: 24 + newOffset, s: 'later', h: 2 },
    ];
    await mount(page, data);
    await openFile(page);
    const diff = page.locator('.cinema-diff');
    await expect(diff.locator('.d-gap')).toHaveText('⋯ 13 unchanged lines omitted ⋯');
    await expect(diff.locator('.d-gap [data-line-id], .d-gap button')).toHaveCount(0);
    await expect(diff.locator('.d-gap + .drow .ln').last()).toHaveText(String(21 + newOffset));
  });
}

test('adjacent diff sections and replacements do not invent omitted lines', async ({ page }) => {
  const data = fixture();
  data.stages[0].files[0].lines = [
    { t: 'del', o: 1, s: 'old', h: 1 },
    { t: 'del', o: 2, s: 'old two', h: 1 },
    { t: 'add', n: 1, s: 'new', h: 1 },
    { t: 'ctx', o: 3, n: 2, s: 'context' },
    { t: 'add', n: 3, s: 'adjacent', h: 2 },
    { t: 'ctx', o: 4, n: 4, s: 'context' },
  ];
  await mount(page, data);
  await openFile(page);
  await expect(page.locator('.cinema-diff .d-gap')).toHaveCount(0);
});

test('diff combines collapsed context with omitted source lines', async ({ page }) => {
  const data = fixture();
  data.stages[0].files[0].lines = [
    { t: 'add', n: 1, s: 'first', h: 1 },
    ...[2, 3, 4, 5, 7, 8, 9, 10].map(n => ({ t: 'ctx', o: n - 1, n, s: 'context' })),
    { t: 'add', n: 11, s: 'last', h: 2 },
  ];
  await mount(page, data);
  await openFile(page);
  await expect(page.locator('.cinema-diff .d-gap')).toHaveText('⋯ 3 unchanged lines omitted ⋯');
  await page.locator('.cinema-diff button[data-mode="full"]').click();
  await expect(page.locator('.cinema-diff .d-gap')).toHaveText('⋯ 1 unchanged line omitted ⋯');
});

test('omitted lines between replacements are counted once across both sides', async ({ page }) => {
  const data = fixture();
  data.stages[0].files[0].lines = [
    { t: 'del', o: 1, s: 'old', h: 1 },
    { t: 'add', n: 1, s: 'new', h: 1 },
    { t: 'del', o: 5, s: 'old later', h: 2 },
    { t: 'add', n: 5, s: 'new later', h: 2 },
  ];
  await mount(page, data);
  await openFile(page);
  await expect(page.locator('.cinema-diff .d-gap')).toHaveText('⋯ 3 unchanged lines omitted ⋯');
});


test('node counts include only linked reasoning and open matching entries', async ({ page }) => {
  const data = fixture();
  data.stages[0].insights = [
    { id: 'shared', collection: 'insights', type: 'decision', title: 'Shared decision', nodeRefs: ['first-one', 'first-two'] },
    { id: 'risk', collection: 'insights', type: 'risk', title: 'Only second risk', nodeRefs: ['first-two'] },
    { id: 'failed', collection: 'validation', type: 'validation', title: 'Failed check', meta: 'failed', nodeRefs: ['first-one'] },
    { id: 'passed', collection: 'validation', type: 'validation', title: 'Passed check', meta: 'passed', nodeRefs: ['first-one'] },
  ];
  await mount(page, data);
  await page.locator('.stage-title[data-id="first"]').click();
  const one = page.locator('details[data-node="first-one"]');
  const two = page.locator('details[data-node="first-two"]');
  await expect(page.locator('.stage-body > .reasoning-summary')).toHaveCount(0);
  await expect(one.locator('summary .rk')).toHaveCount(3);
  await expect(two.locator('summary .rk')).toHaveCount(2);
  await expect(page.locator('details[data-node="second-one"] .rk')).toHaveCount(0);
  await expect(one.getByRole('button', { name: 'Check: 2', exact: true })).toBeVisible();
  await one.getByRole('button', { name: 'Decision: 1', exact: true }).click();
  await expect(one.locator('.tag-face[data-type="decision"]')).toBeFocused();
  await one.getByRole('button', { name: 'Checks not passed: 1', exact: true }).click();
  await expect(one.locator('.tag-face[data-vstat="failed"]')).toBeFocused();
  await two.getByRole('button', { name: 'Risk: 1', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(two.locator('.tag-face[data-type="risk"]')).toBeFocused();
});


test('insight reviewed marks toggle, persist, flag rewrites and stay independent of approvals', async ({ page }) => {
  const data = fixture();
  data.stages[0].insights = [
    { id: 'shared', collection: 'decisions', type: 'decision', title: 'Shared decision', body: 'Why', nodeRefs: ['first-one', 'first-two'] },
    { id: 'risk', collection: 'risks', type: 'risk', title: 'A risk', body: 'What', nodeRefs: ['first-one'] },
  ];
  const errors = await mount(page, data);
  await page.locator('.stage-title[data-id="first"]').click();
  await page.locator('details[data-node="first-one"] > summary').click();
  const node = page.locator('details[data-node="first-one"]');
  const pill = node.locator('.tag.type-decision');
  const toggle = pill.locator('.insight-review');
  await expect(toggle).toHaveAccessibleName('Reviewed: Shared decision');
  const meta = page.locator('.stage[data-stage="first"] .stage-meta');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(meta).toContainText('0/2 insights reviewed');
  await toggle.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Not reviewed – click to mark as reviewed');

  // Keyboard activation keeps focus and the open tooltip follows the new state.
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toBeHidden();
  await toggle.focus();
  await expect(page.getByRole('tooltip')).toHaveText('Not reviewed – click to mark as reviewed');
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveText('✓');
  await expect(page.getByRole('tooltip')).toHaveText('Reviewed – click to mark as not reviewed');
  await expect(meta).toContainText('1/2 insights reviewed');
  await expect(pill).not.toHaveCSS('background-color', await node.locator('.tag.type-risk').evaluate((el) => getComputedStyle(el).backgroundColor));
  // One insight linked to two nodes has one state.
  await expect(page.locator('details[data-node="first-two"] .insight-review')).toHaveAttribute('aria-pressed', 'true');

  // The pill body keeps pinning its tooltip and reports the state.
  await pill.locator('.tag-face').click();
  await expect(page.getByRole('tooltip').locator('.tag-pop-kind')).toContainText('Reviewed');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');

  // Approval is untouched by the mark and does not change it.
  await saveAction(page, () => node.locator('.mini-approve').click(), (state) => !!state.approvals?.[approvalKey('first', 'first-one')]);
  await expect(node.locator('.frow')).toHaveClass(/is-approved/);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await saveAction(page, () => node.locator('.mini-approve').click(), (state) => !state.approvals?.[approvalKey('first', 'first-one')]);
  await expect(node.locator('.frow')).not.toHaveClass(/is-approved/);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  // The mark survives a reload, and a rewritten insight says so instead of staying reviewed.
  const state = await page.evaluate(async () => (await (await fetch('/api/review-state')).json()).state);
  expect(Object.keys(state.insightReviews)).toEqual(['i:first:decisions:shared']);
  await reload(page);
  await openFile(page);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  data.stages[0].insights[0].body = 'A different reason';
  await reload(page);
  await openFile(page);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveText('!');
  await expect(toggle).toHaveAccessibleName('Reviewed before it changed: Shared decision');
  await expect(meta).toContainText('0/2 insights reviewed');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveText('');
  expect(errors).toEqual([]);
});

function evidenceInsight(overrides = {}) {
  return { id: 'shot', collection: 'evidence', type: 'evidence', title: 'New settings button appears', body: 'Reproduce: Open /settings', meta: 'screenshot', nodeRefs: ['first-one'],
    evidence: { kind: 'screenshot', attachments: [
      { mediaType: 'image/png', sha256: 'a'.repeat(64), role: 'before', caption: 'Without the button' },
      { mediaType: 'image/png', sha256: 'b'.repeat(64), role: 'after' },
      { mediaType: 'text/plain', sha256: 'c'.repeat(64), caption: 'Console' },
    ], inline: '$ tool <run>\nok', reproduction: 'Open /settings', specificationRefs: ['story#works'], capturedAt: '2026-10-30T10:00:00Z', ...overrides } };
}
const onePixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
async function routeEvidence(page) {
  const requests = [];
  await page.route('**/api/evidence**', (route) => {
    const url = new URL(route.request().url()); requests.push(url);
    if (url.searchParams.get('index') === '2') return route.fulfill({ contentType: 'text/plain', body: 'server <b>log</b>' });
    return route.fulfill({ contentType: 'image/png', body: onePixel });
  });
  return requests;
}

test('evidence opens from its pill with previews, compare view, text and links', async ({ page }) => {
  const data = fixture();
  data.requirements = [{ id: 'story', title: 'Story', acceptance: [{ id: 'works', text: 'The button works' }] }];
  data.stages[0].insights.push(evidenceInsight());
  const errors = await mount(page, data);
  const requests = await routeEvidence(page);
  await openFile(page);
  const node = page.locator('details[data-node="first-one"]');
  const pill = node.locator('.tag.type-evidence');
  await expect(pill.locator('.tag-kind')).toHaveText('Evidence');
  await expect(node.getByRole('button', { name: 'Evidence: 1', exact: true })).toBeVisible();
  const open = pill.getByRole('button', { name: 'View evidence' });
  await expect(open).toHaveText('View evidence');
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Evidence' });
  await expect(dialog.locator('.insight-target-status')).toHaveText(`Captured ${new Date('2026-10-30T10:00:00Z').toLocaleString()}`);
  await expect(dialog).toContainText('New settings button appears');
  await expect(dialog.getByRole('region', { name: 'Before' })).toContainText('Without the button');
  await expect(dialog.getByRole('region', { name: 'Before' }).locator('img')).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'After' }).locator('img')).toBeVisible();
  await expect(dialog.locator('.evidence-text').first()).toHaveText('server <b>log</b>');
  await expect(dialog.locator('.evidence-text').last()).toHaveText('$ tool <run>\nok');
  await expect(dialog.locator('.evidence-text b')).toHaveCount(0);
  await expect(dialog.locator('.evidence-links').first()).toContainText('The button works');
  await expect(dialog.locator('.evidence-links').last()).toContainText('Step one');
  expect(requests.map((url) => [url.searchParams.get('stage'), url.searchParams.get('item'), url.searchParams.get('index')])).toContainEqual(['first', 'shot', '0']);
  expect(requests.every((url) => url.searchParams.get('review') === 'browser-review')).toBe(true);
  const zoom = dialog.getByRole('button', { name: 'Zoom Without the button' });
  await zoom.click();
  await expect(zoom).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  await open.click();
  await expect(dialog.getByRole('button', { name: 'Add note' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Close evidence' })).toHaveText('×');
  await dialog.getByRole('button', { name: 'Close evidence' }).click();
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  expect(errors).toEqual([]);
});

test('evidence linked to two nodes has one thread and reports a capture that fails to load', async ({ page }) => {
  const data = fixture();
  data.stages[0].insights.push({ ...evidenceInsight(), nodeRefs: ['first-one', 'first-two'] });
  data.feedback = [thread('on-evidence', 'open', { kind: 'insight', stageId: 'first', collection: 'evidence', itemId: 'shot', label: 'Evidence' })];
  const errors = await mount(page, data);
  await page.route('**/api/evidence**', (route) => route.fulfill({ status: 404, json: { ok: false } }));
  await page.locator('.stage-title[data-id="first"]').click();
  const first = page.locator('details[data-node="first-one"]'), second = page.locator('details[data-node="first-two"]');
  await first.locator('> summary').click();
  await second.locator('> summary').click();
  await expect(first.locator('.tag.type-evidence .notes-toggle')).toBeVisible();
  await expect(second.locator('.tag.type-evidence .notes-toggle')).toHaveCount(0);
  await second.getByRole('button', { name: 'View evidence' }).click();
  const dialog = page.getByRole('dialog', { name: 'Evidence' });
  await expect(dialog.getByRole('region', { name: 'Before' })).toContainText('could not be loaded');
  await expect(dialog.locator('img')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('evidence of a kind the viewer does not know shows its output and takes a thread', async ({ page }) => {
  const data = fixture();
  data.stages[0].insights.push({ ...evidenceInsight({ kind: 'other', attachments: [], inline: 'call transcript <ok>' }), meta: 'video-call' });
  data.feedback = [thread('on-evidence', 'open', { kind: 'insight', stageId: 'first', collection: 'evidence', itemId: 'shot', label: 'Evidence' })];
  const errors = await mount(page, data);
  await openFile(page);
  const node = page.locator('details[data-node="first-one"]'), pill = node.locator('.tag.type-evidence');
  await pill.locator('.notes-toggle').click();
  await expect(node.locator('.node-reasoning .thread')).toContainText('Feedback on-evidence');
  await pill.getByRole('button', { name: 'View evidence' }).click();
  const dialog = page.getByRole('dialog', { name: 'Evidence' });
  await expect(dialog.locator('.eyebrow')).toHaveText('video-call');
  await expect(dialog.locator('.evidence-text')).toHaveText('call transcript <ok>');
  expect(errors).toEqual([]);
});

test('sent feedback on evidence is grouped under its stage in the notes panel', async ({ page }) => {
  const data = fixture();
  data.stages[0].insights.push(evidenceInsight({ attachments: [] }));
  data.feedback = [thread('on-evidence', 'open', { kind: 'insight', stageId: 'first', collection: 'evidence', itemId: 'shot', label: 'Evidence' })];
  await mount(page, data);
  await showNotes(page);
  await expect(page.locator('.side.notes')).toContainText('Stage first');
  await expect(page.locator('.side.notes')).not.toContainText('Other targets');
});

test('a recapture of reviewed evidence counts as a change', async ({ page }) => {
  const data = fixture();
  data.stages[0].insights.push(evidenceInsight({ attachments: [] }));
  await mount(page, data);
  await openFile(page);
  const pill = page.locator('details[data-node="first-one"] .tag.type-evidence');
  await saveAction(page, () => pill.locator('.insight-review').click(), (state) => !!state.insightReviews?.['i:first:evidence:shot']);
  await expect(pill.locator('.insight-review')).toHaveAttribute('aria-pressed', 'true');
  data.stages[0].insights[0] = evidenceInsight({ inline: 'recaptured', attachments: [] });
  await reload(page);
  await openFile(page);
  await expect(pill.locator('.insight-review')).toHaveText('!');
});

test('a thread on evidence takes further notes beside its pill, sent as an insight target', async ({ page }) => {
  const data = fixture();
  data.stages[0].insights.push(evidenceInsight({ attachments: [] }));
  data.feedback = [thread('on-evidence', 'open', { kind: 'insight', stageId: 'first', collection: 'evidence', itemId: 'shot', label: 'Evidence' })];
  await mount(page, data);
  await openFile(page);
  const node = page.locator('details[data-node="first-one"]');
  await node.locator('.tag.type-evidence .notes-toggle').click();
  await node.locator('.node-reasoning .thread-add').click();
  const editor = node.locator('.node-reasoning textarea[name="nc-body"]');
  await expect(editor).toBeFocused();
  await editor.fill('This shows the wrong page');
  await saveAction(page, () => editor.press('Control+Enter'), (state) => state.comments?.[0]?.kind === 'insight' && state.comments[0].id === 'i:first:evidence:shot');
  await expect(node.locator('.node-reasoning .thread')).toContainText('This shows the wrong page');
  await reload(page);
  await openFile(page);
  await expect(node.locator('.tag.type-evidence .notes-toggle')).toBeVisible();
  await showNotes(page);
  await expect(page.locator('.side.notes')).toContainText('New settings button appears');
});

test('remote reviews offer only personal notes and refresh approved files in place', async ({ page }) => {
  const data = { ...fixture(), remote: { branch: 'feature', targetBranch: 'main' } };
  await mount(page, data);
  await expect(page.locator('.lockup')).toContainText('Remote review');
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await expect(page.locator('[data-review="browser-review"]')).toContainText('Remote');
  await page.keyboard.press('Escape');
  await openFile(page);
  await page.locator('.file-notes .thread-add').click();
  await expect(page.locator('input[name="nc-mode"][value="feedback"]')).toHaveCount(0);
  await page.locator('textarea[name="nc-body"]').fill('My personal note');
  await saveAction(page, () => page.getByRole('button', { name: 'Add note', exact: true }).click(), state => state.comments?.[0]?.mode === 'personal');
  await showNotes(page);
  await expect(page.getByRole('button', { name: /Prepare feedback/ })).toHaveCount(0);
  await page.locator('.side.notes').getByRole('button', { name: 'Close', exact: true }).click();
  await saveAction(page, () => page.locator('details[data-node="first-one"] .mini-approve').click(), state => !!state.approvals?.[approvalKey('first', 'first-one')]?.snapshotId);
  const endpoint = { path: 'shared.js', headRevision: 'b'.repeat(40), exists: true };
  await page.route('**/api/approval-comparison*', route => route.fulfill({ json: { ok: true, approved: endpoint, current: endpoint, lines: [{ t: 'del', o: 1, s: 'approved content' }, { t: 'add', n: 1, s: 'remote update' }], nextOffset: null } }));
  await page.route('**/api/remote/refresh*', route => {
    expect(route.request().headers()['content-type']).toBe('application/json');
    data.stages[0].files[0].revision = 'remote-updated'; data.viewerRevision = 'refreshed';
    return route.fulfill({ json: { ok: true } });
  });
  await page.getByRole('button', { name: 'Refresh branch', exact: true }).click();
  await expect(page.locator('details[data-node="first-one"] .frow')).toHaveClass(/is-stale/);
  await openFile(page);
  await expect(page.getByRole('button', { name: 'Since approval', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.is-approved-comparison')).toContainText('remote update');
  await expect(page.locator('.file-notes')).toContainText('My personal note');
  await page.route('**/api/remote/refresh*', route => route.fulfill({ status: 409, json: { ok: false, error: 'Remote unavailable' } }));
  await page.getByRole('button', { name: 'Refresh branch', exact: true }).click();
  await expect(page.locator('.review-update')).toContainText('Refresh failed: Remote unavailable');
  await expect(page.getByRole('button', { name: 'Refresh branch', exact: true })).toBeEnabled();
});

test('remote stages have no cumulative view and use file-specific diff and approval bases', async ({ page }) => {
  const data = { ...fixture(), remote: { branch: 'feature' } };
  data.stages[0].files[0].baseRevision = 'c'.repeat(40);
  delete data.stages[0].files[0].lines;
  await mount(page, data);
  await expect(page.getByRole('button', { name: 'All changes', exact: true })).toHaveCount(0);
  await expect(page.locator('.hero-line')).toContainText('2 stages');
  await expect(page.locator('.tb-actions')).toContainText('0/10');
  const diffRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/diff');
  await openFile(page);
  expect(new URL((await diffRequest).url()).searchParams.get('base')).toBe('c'.repeat(40));
  const approval = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/approval-snapshots');
  await page.locator('details[data-node="first-one"] .mini-approve').click();
  expect((await approval).postDataJSON().baseRevision).toBe('c'.repeat(40));
});

test('the newest remote commit retains an earlier approval after rewritten history and chained renames', async ({ page }) => {
  const data = { ...fixture(), remote: { branch: 'feature' } };
  data.stages.forEach((stage, index) => {
    stage.id = `commit-${String(index + 1).repeat(40)}`;
    stage.nodes = [{ id: 'changes', title: 'Commit changes' }];
    stage.files[0].memberships = [{ nodeId: 'changes', classification: 'behavior' }];
  });
  const latest = data.stages[1];
  latest.files[0].kind = 'renamed'; latest.files[0].previousPath = 'middle.js';
  latest.files[0].previousPaths = ['middle.js', 'old.js'];
  const oldStage = `commit-${'9'.repeat(40)}`, oldKey = approvalKey(oldStage, 'changes', 'old.js');
  const oldApproval = { stageId: oldStage, nodeId: 'changes', path: 'old.js', rev: 'older', at: 1, snapshotId: 'a'.repeat(32) };
  await mount(page, data, { approvals: { [oldKey]: oldApproval } });
  await expect(page.locator(`.stage[data-stage="${data.stages[0].id}"] .frow`)).not.toHaveClass(/is-stale/);
  const latestStage = page.locator(`.stage[data-stage="${latest.id}"]`);
  await expect(latestStage.locator('.frow')).toHaveClass(/is-stale/);
  await page.route('**/api/approval-comparison*', route => {
    expect(route.request().postDataJSON().snapshotId).toBe(oldApproval.snapshotId);
    return route.fulfill({ json: { ok: true, approved: oldApproval, current: { path: 'shared.js' }, lines: [{ t: 'del', o: 1, s: 'previously approved' }, { t: 'add', n: 1, s: 'updated file' }], nextOffset: null } });
  });
  await latestStage.locator('.stage-title').click();
  await latestStage.locator('details.node summary').click();
  await latestStage.locator('.frow-open').click();
  await expect(latestStage.locator('.is-approved-comparison')).toContainText('previously approved');
  await saveAction(page, () => latestStage.locator('.mini-approve').click(), state => {
    return !!state.approvals?.[approvalKey(latest.id, 'changes')]?.snapshotId && !!state.approvals?.[oldKey];
  });
});

for (const mode of ['changes', 'full', 'approval']) {
  test(`file paging follows navigation direction in ${mode} mode`, async ({ page }) => {
    const data = fixture(), file = data.stages[0].files[0];
    const lines = Array.from({ length: 1900 }, (_, i) => ({ t: 'add', n: i + 1, s: `const row${i + 1} = ${i + 1};`, h: 1 }));
    file.lines = lines.slice(0, 900); file.nextOffset = 900;
    const errors = await mount(page, data, { fileView: { [fileId]: mode === 'full' ? 'full' : 'changes' } });
    const payload = offset => ({ ok: true, lines: lines.slice(offset, offset + 900), offset,
      nextOffset: offset + 900 < lines.length ? offset + 900 : null, additions: lines.length, deletions: 0 });
    await page.route('**/api/diff*', route => route.fulfill({ json: payload(Number(new URL(route.request().url()).searchParams.get('offset'))) }));
    await page.route('**/api/approval-comparison*', route => route.fulfill({ json: payload(route.request().postDataJSON().offset) }));
    await openFile(page);
    if (mode === 'approval') {
      await saveAction(page, () => page.locator('details[data-node="first-one"] .mini-approve').click(), state => !!state.approvals?.[approvalKey('first', 'first-one')]?.snapshotId);
      file.revision = 'changed'; data.viewerRevision = 'changed';
      await expect(page.locator('details[data-node="first-one"] .frow')).toHaveClass(/is-stale/);
      await openFile(page);
      await expect(page.getByRole('button', { name: 'Since approval', exact: true })).toHaveAttribute('aria-pressed', 'true');
    }
    const panel = page.locator('details[data-node="first-one"] .cinema-diff');
    const scroller = panel.locator('.diff-scroll');
    await expect(panel.locator('.diff-pages span')).toHaveText('Rows 1–900');
    // Trigger the button without automation scrolling the pager into view first.
    for (const [button, start, rows, backward] of [
      ['Next page', 400, 'Rows 901–1800', false],
      ['Previous page', 150, 'Rows 1–900', true],
      ['Next page', 0, 'Rows 901–1800', false],
      ['Next page', 600, 'Rows 1801–1900', false],
      ['Previous page', 0, 'Rows 901–1800', true],
    ]) {
      await scroller.evaluate((el, top) => { el.scrollTop = top; }, start);
      await panel.getByRole('button', { name: button, exact: true }).evaluate(el => el.click());
      await expect(panel.locator('.diff-pages span')).toHaveText(rows);
      await expect.poll(() => scroller.evaluate((el, end) => end
        ? Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) : el.scrollTop, backward)).toBeLessThanOrEqual(1);
      if (backward) expect(await scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(1000);
    }
    // Ordinary rerenders continue to retain the current page's position.
    await scroller.evaluate(el => { el.scrollTop = 250; });
    await panel.getByRole('button', { name: 'Wrap lines', exact: true }).click();
    await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(250);
    expect(errors).toEqual([]);
  });
}

for (const scenario of ['diff', 'queued diff', 'approval']) {
  test(`pending page scroll stays with its requesting node (${scenario})`, async ({ page }) => {
    const data = fixture(), file = data.stages[0].files[0];
    const lines = Array.from({ length: 1800 }, (_, i) => ({ t: 'add', n: i + 1, s: `const row${i + 1} = ${i + 1};`, h: 1 }));
    file.lines = lines.slice(0, 900); file.nextOffset = 900;
    await mount(page, data, { fileView: { [fileId]: 'full' } });
    const payload = offset => ({ ok: true, lines: lines.slice(offset, offset + 900), offset, nextOffset: offset ? null : 900, additions: 1800 });
    let releasePage;
    const pendingPage = new Promise(resolve => { releasePage = resolve; });
    await page.route('**/api/diff*', async route => {
      const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
      if (offset) await pendingPage;
      await route.fulfill({ json: payload(offset) });
    });
    await page.route('**/api/approval-comparison*', async route => {
      const offset = route.request().postDataJSON().offset;
      if (offset) await pendingPage;
      await route.fulfill({ json: payload(offset) });
    });
    await openFile(page);
    if (scenario === 'approval') {
      await saveAction(page, () => page.locator('details[data-node="first-one"] .mini-approve').click(), state => !!state.approvals?.[approvalKey('first', 'first-one')]?.snapshotId);
      file.revision = 'changed'; data.viewerRevision = 'changed';
      await expect(page.locator('details[data-node="first-one"] .frow')).toHaveClass(/is-stale/);
      await openFile(page);
    }
    const first = page.locator('details[data-node="first-one"] .cinema-diff');
    await expect(first.locator('.diff-pages span')).toHaveText('Rows 1–900');
    const next = first.getByRole('button', { name: 'Next page', exact: true });
    const routeName = scenario === 'approval' ? '/api/approval-comparison' : '/api/diff';
    const request = page.waitForRequest(r => new URL(r.url()).pathname === routeName);
    await next.evaluate(el => el.click()); await request;
    if (scenario === 'queued diff') await next.evaluate(el => el.click());
    await openFile(page, 'first-two');
    const second = page.locator('details[data-node="first-two"] .cinema-diff');
    const scroller = second.locator('.diff-scroll');
    await scroller.evaluate(el => { el.scrollTop = 250; });
    const responses = [];
    page.on('response', r => { if (new URL(r.url()).pathname === routeName) responses.push(r); });
    releasePage();
    await expect.poll(() => responses.length).toBe(scenario === 'queued diff' ? 2 : 1);
    if (scenario !== 'approval') await expect(second.locator('.diff-pages span')).toHaveText('Rows 901–1800');
    // Let all response handlers and their renders complete before checking scroll.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await scroller.evaluate(el => el.scrollTop)).toBe(250);
  });
}

for (const kind of ['modified', 'added', 'deleted']) {
  test(`line wrapping preserves source rows and anchors for ${kind} files`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    const data = fixture();
    const file = data.stages[0].files[0];
    file.kind = kind;
    const text = `    const long = "${'abcdef'.repeat(100)}";`;
    file.lines = [{ t: kind === 'deleted' ? 'del' : 'add', o: kind === 'deleted' ? 7 : undefined, n: kind === 'deleted' ? undefined : 7, s: text, h: 1 }];
    await mount(page, data);
    await openFile(page);
    const panel = page.locator('.cinema-diff');
    const toggle = panel.getByRole('button', { name: 'Wrap lines', exact: true });
    const row = panel.locator('[data-line-id]');
    const anchor = `l:first:${kind === 'deleted' ? 'old' : 'new'}:7:shared.js`;
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(await panel.locator('.diff-scroll').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    await toggle.focus();
    await toggle.press('Space');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(await panel.locator('.diff-scroll').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await row.evaluate(el => el.offsetHeight > 40)).toBe(true);
    await expect(row).toHaveAttribute('data-line-id', anchor);
    await expect(row.locator('code')).toHaveText(text);
    await expect(row.locator('.tok-key').first()).toHaveText('const');
    await expect(row.locator('.ln').last()).toHaveText('7');
    await row.locator('.lact').click();
    await expect(panel.locator('.line-thread')).toHaveAttribute('data-thread', anchor);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(await panel.locator('.diff-scroll').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  });
}

test('wrapping persists across file navigation and full file mode', async ({ page }) => {
  await mount(page);
  await openFile(page);
  await saveAction(page, () => page.getByRole('button', { name: 'Wrap lines', exact: true }).click(), state => state.wrapLines === true);
  await page.getByRole('button', { name: 'Full file', exact: true }).click();
  await expect(page.locator('.cinema-diff .diff-panel')).toHaveClass(/wrap-lines/);
  await openFile(page, 'first-two');
  for (const button of await page.getByRole('button', { name: 'Wrap lines', exact: true }).all()) {
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }
  await reload(page);
  await openFile(page);
  await expect(page.getByRole('button', { name: 'Wrap lines', exact: true }).first()).toHaveAttribute('aria-pressed', 'true');
});

for (const kind of ['modified', 'added', 'deleted', 'renamed']) {
  test(`Markdown preview renders the complete ${kind} file safely and restores source`, async ({ page }) => {
    const data = fixture(), file = data.stages[0].files[0];
    file.path = 'docs/Guide.MD'; file.kind = kind;
    if (kind === 'renamed') file.previousPath = 'old/Guide.MD';
    const errors = await mount(page, data);
    const content = '# Heading\n\nUnchanged paragraph with **bold** and *emphasis*.\n\n[Relative](../README.md) [Web](https://example.com) [Unsafe](javascript:alert(1))\n\n![Image](./image.png)\n\n- first\n- second\n\n1. ordered\n\n> quotation\n\n```js\nconst example = 1;\n```\n\n| Key | Value |\n| --- | --- |\n| A | B |\n\n- [x] done\n- [ ] pending\n\n<script>window.markdownAttack = true</script><img src="x" onerror="window.markdownAttack=true"><button data-action="toggle-notes">Injected</button><a href="javascript:alert(1)">bad link</a><p data-action="toggle-wrap" class="diff-panel" id="app">text</p>';
    const requests = [];
    await page.route('**/api/file-content*', route => {
      requests.push(new URL(route.request().url()));
      return route.fulfill({ json: { ok: true, content, revision: (kind === 'deleted' ? 'a' : 'b').repeat(40), side: kind === 'deleted' ? 'base' : 'head' } });
    });
    await openFile(page);
    const source = page.locator('.cinema-diff .source-view');
    const before = await source.locator('[data-line-id]').evaluateAll(rows => rows.map(row => row.dataset.lineId));
    const markdownToggle = page.getByRole('group', { name: 'Markdown view', exact: true });
    // Keep focus from scrolling a partly visible toggle into view.
    await markdownToggle.scrollIntoViewIfNeeded();
    const sourcePosition = await markdownToggle.boundingBox();
    const wrapPosition = await page.getByRole('button', { name: 'Wrap lines', exact: true }).boundingBox();
    expect(sourcePosition.x).toBeGreaterThan(wrapPosition.x + wrapPosition.width);
    await page.getByRole('button', { name: 'Preview', exact: true }).focus();
    await page.getByRole('button', { name: 'Preview', exact: true }).press('Enter');
    const preview = page.locator('.markdown-preview');
    await expect(preview.getByRole('heading', { name: 'Heading' })).toBeVisible();
    expect(await markdownToggle.boundingBox()).toEqual(sourcePosition);
    await expect(page.locator('.markdown-revision')).toContainText(kind === 'deleted' ? 'Base revision (deleted file) aaaaaaaaaaaa' : 'Head revision bbbbbbbbbbbb');
    for (const selector of ['strong', 'em', 'ul', 'ol', 'blockquote', 'pre code', 'table']) await expect(preview.locator(selector).first()).toBeVisible();
    await expect(preview.locator('input[type=checkbox]')).toHaveCount(2);
    await expect(preview.locator('input').first()).toBeChecked();
    await expect(preview.locator('input').first()).toBeDisabled();
    await expect(preview.locator('script, button, [data-action], [onerror], [id], [class]')).toHaveCount(0);
    await expect(preview.getByText('bad link', { exact: true })).not.toHaveAttribute('href');
    expect(await page.evaluate(() => window.markdownAttack)).toBeUndefined();
    const relative = new URL(await preview.getByRole('link', { name: 'Relative', exact: true }).getAttribute('href'));
    expect(relative.searchParams.get('target')).toBe('README.md');
    expect(relative.searchParams.get('head')).toBe('b'.repeat(40));
    const image = new URL(await preview.getByRole('img', { name: 'Image', exact: true }).getAttribute('src'));
    expect(image.searchParams.get('target')).toBe('docs/image.png');
    expect(requests[0].searchParams.get('path')).toBe('docs/Guide.MD');
    await expect(source).toBeHidden();
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(source).toBeVisible();
    expect(await markdownToggle.boundingBox()).toEqual(sourcePosition);
    expect(await source.locator('[data-line-id]').evaluateAll(rows => rows.map(row => row.dataset.lineId))).toEqual(before);
    await source.locator('.lact').first().click();
    await expect(source.locator('.line-thread')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('an open Markdown preview keeps its scroll when its group is renamed and its element and focus when stages reorder', async ({ page }) => {
  const data = fixture();
  for (const stage of data.stages) Object.assign(stage.files[0], { path: 'README.md', project: 'web' });
  const content = Array.from({ length: 80 }, (_, i) => i === 60 ? '[Read more](https://example.com/more)' : `Paragraph ${i}`).join('\n\n');
  await mount(page, data);
  await page.route('**/api/file-content*', route => route.fulfill({ json: { ok: true, content, revision: 'b'.repeat(40), side: 'head' } }));
  await openFile(page);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.locator('.cinema-diff .markdown-preview');
  const link = preview.getByRole('link', { name: 'Read more' });
  await link.scrollIntoViewIfNeeded();
  const scrolled = await preview.evaluate((el) => el.scrollTop);
  expect(scrolled).toBeGreaterThan(0);

  // A file that changes group is rendered anew; its preview keeps its scroll.
  data.stages[0].files[0].project = 'docs'; data.viewerRevision = 'regrouped';
  await expect(page.locator('.stage[data-stage="first"] details[data-node="first-one"] .fg-name')).toHaveText('docs');
  await expect(link).toBeVisible();
  expect(await preview.evaluate((el) => el.scrollTop)).toBe(scrolled);

  // Reordering stages moves the same elements; the focused link keeps its focus.
  await link.focus();
  await preview.evaluate((el) => { el.dataset.marker = 'kept'; });
  data.stages.reverse(); data.viewerRevision = 'reordered';
  await expect(page.locator('.stage').first()).toHaveAttribute('data-stage', 'second');
  await expect(preview).toHaveAttribute('data-marker', 'kept');
  await expect(link).toBeFocused();
  expect(await preview.evaluate((el) => el.scrollTop)).toBe(scrolled);
});

test('renaming the group of a focused approval does not move focus to another group', async ({ page }) => {
  const data = fixture();
  data.stages[0].files[0].project = 'web';
  await mount(page, data);
  await openFile(page);
  const node = page.locator('details[data-node="first-one"]');
  data.stages[0].files.unshift({ path: 'docs/guide.md', project: 'docs', kind: 'added', revision: 'docs-rev', additions: 1, deletions: 0,
    memberships: [{ nodeId: 'first-one', classification: 'behavior' }], lines: [{ t: 'add', n: 1, s: '# Guide' }] });
  data.viewerRevision = 'docs-group';
  await expect(node.locator('.fg-name')).toHaveText(['docs', 'web']);
  await node.locator('.fgroup').filter({ hasText: 'web' }).locator('.fg-approve').focus();
  data.stages[0].files[1].project = 'ui'; data.viewerRevision = 'renamed-group';
  await expect(node.locator('.fg-name')).toHaveText(['docs', 'ui']);
  await expect(node.locator('.fgroup').filter({ hasText: 'docs' }).locator('.fg-approve')).not.toBeFocused();
});

test('a focused group approval keeps acting on its own group when a group is inserted before it', async ({ page }) => {
  const data = fixture();
  data.stages[0].files[0].project = 'web';
  await mount(page, data);
  await openFile(page);
  const node = page.locator('details[data-node="first-one"]');
  const web = node.locator('.fgroup').filter({ hasText: 'web' }).locator('.fg-approve');
  await web.focus();
  data.stages[0].files.unshift({ path: 'docs/guide.md', project: 'docs', kind: 'added', revision: 'docs-rev', additions: 1, deletions: 0,
    memberships: [{ nodeId: 'first-one', classification: 'behavior' }], lines: [{ t: 'add', n: 1, s: '# Guide' }] });
  data.viewerRevision = 'docs-group';
  await expect(node.locator('.fg-name')).toHaveText(['docs', 'web']);
  await expect(web).toBeFocused();
  await saveAction(page, () => page.keyboard.press('Enter'), (state) => !!state.approvals?.[approvalKey('first', 'first-one')]);
  expect(Object.keys(await page.evaluate(async () => (await (await fetch('/api/review-state')).json()).state.approvals || {})))
    .not.toContain(approvalKey('first', 'first-one', 'docs/guide.md'));
});

test('Markdown preview failures retain source controls and non-Markdown files have no toggle', async ({ page }) => {
  await mount(page);
  await openFile(page);
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(0);
  const data = fixture(); data.stages[0].files[0].path = 'README.markdown';
  await mount(page, data);
  await page.route('**/api/file-content*', route => route.fulfill({ status: 422, json: { ok: false, error: 'Target unavailable at this revision.' } }));
  await openFile(page);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.cinema-diff')).toContainText('Preview unavailable: Target unavailable');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.locator('.cinema-diff .source-view')).toBeVisible();
});

test('switching Markdown preview preserves a line draft and its source anchor', async ({ page }) => {
  const data = fixture(); data.stages[0].files[0].path = 'README.md';
  await mount(page, data);
  await page.route('**/api/file-content*', route => route.fulfill({ json: { ok: true, content: '# Document', revision: 'b'.repeat(40), side: 'head' } }));
  await openFile(page);
  const source = page.locator('.cinema-diff .source-view');
  await source.locator('.lact').first().click();
  const editor = source.locator('textarea');
  await editor.fill('Keep this review draft');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.markdown-preview h1')).toHaveText('Document');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(editor).toHaveValue('Keep this review draft');
  await expect(source.locator('.line-thread')).toHaveAttribute('data-thread', 'l:first:new:1:README.md');
});

test('more than twelve open Markdown previews do not evict each other', async ({ page }) => {
  const data = fixture(), template = data.stages[0].files[0];
  data.stages[0].files = Array.from({ length: 13 }, (_, i) => ({ ...structuredClone(template), path: `doc${i}.md` }));
  await mount(page, data);
  let requests = 0;
  await page.route('**/api/file-content*', route => {
    requests++;
    return route.fulfill({ json: { ok: true, content: '# Document', revision: 'b'.repeat(40), side: 'head' } });
  });
  await page.locator('.stage-title[data-id="first"]').click();
  const details = page.locator('details[data-node="first-one"]');
  await details.locator('summary').click();
  for (let i = 0; i < 13; i++) {
    const row = details.locator('.frow-wrap').nth(i);
    await row.locator('.frow-open').click();
    await row.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(row.locator('.markdown-preview h1')).toHaveText('Document');
  }
  await page.getByRole('button', { name: /^Notes/ }).click();
  await expect(details.locator('.markdown-preview h1')).toHaveCount(13);
  expect(requests).toBe(13);
});

test('Markdown preview retries a transient failure only after explicit selection', async ({ page }) => {
  const data = fixture(); data.stages[0].files[0].path = 'README.md';
  await mount(page, data);
  let requests = 0;
  await page.route('**/api/file-content*', route => {
    requests++;
    return requests === 1
      ? route.fulfill({ status: 503, json: { ok: false, error: 'Viewer is busy; retry after the current requests finish.' } })
      : route.fulfill({ json: { ok: true, content: '# Recovered', revision: 'b'.repeat(40), side: 'head' } });
  });
  await openFile(page);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.cinema-diff')).toContainText('Preview unavailable: Viewer is busy');
  await page.getByRole('button', { name: /^Notes/ }).click();
  expect(requests).toBe(1);
  await page.locator('.side.notes [data-action="toggle-notes"]').click();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.markdown-preview h1')).toHaveText('Recovered');
  expect(requests).toBe(2);
});

test('jumping to an already-loaded Markdown line exits Preview', async ({ page }) => {
  const data = fixture(); data.stages[0].files[0].path = 'README.md';
  data.feedback = [thread('markdown-line', 'open', { kind: 'line', stageId: 'first', path: 'README.md', side: 'new', line: 1, label: 'README.md:1' })];
  await mount(page, data, { comments: [{ kind: 'line', id: 'l:first:new:1:README.md', nodeId: 'first-one', exported: true, threadId: 'markdown-line', body: 'Feedback markdown-line' }] });
  await page.route('**/api/file-content*', route => route.fulfill({ json: { ok: true, content: '# Document', revision: 'b'.repeat(40), side: 'head' } }));
  await openFile(page);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.markdown-preview h1')).toBeVisible();
  await showNotes(page);
  await page.locator('.side.notes [data-action="jump-to"][data-kind="line"]').click();
  await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.cinema-diff [data-line-id="l:first:new:1:README.md"]')).toBeVisible();
});

test('file search groups every occurrence and opens the chosen stage and node', async ({ page }) => {
  const errors = await mount(page);
  await page.getByRole('button', { name: 'Find file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Find a file' });
  const input = dialog.getByRole('combobox');
  await expect(input).toBeFocused();
  await expect(dialog.getByRole('option')).toHaveCount(4);
  await expect(dialog.getByRole('heading', { name: '01 · Stage first' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '02 · Stage second' })).toBeVisible();
  await expect(dialog.getByRole('option').first()).toContainText('+2');
  await input.fill('SHAR');
  await expect(dialog.getByRole('option')).toHaveCount(4);
  await expect(dialog.locator('.file-search-suffix')).toHaveText('ed.js');
  await input.press('Tab');
  await expect(input).toHaveValue('SHAR');
  await expect(input).not.toBeFocused();
  await input.focus();
  await input.press('End');
  await expect(dialog.getByRole('option').last()).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');
  await expect(dialog).toHaveCount(0);
  const node = page.locator('.stage[data-stage="second"] details[data-node="second-two"]');
  await expect(node).toHaveAttribute('open', '');
  await expect(node.locator('.cinema-diff')).toBeVisible();
  await expect(node.locator('.frow-open')).toBeFocused();
  expect(errors).toEqual([]);
});

test('file occurrences stay scoped to their path; search uses current filenames', async ({ page }) => {
  const data = fixture();
  for (const stage of data.stages) stage.files[0].path = 'lib/shared.js';
  data.stages[0].files.push({ path: 'other/shared.js', kind: 'modified', additions: 1, deletions: 0, memberships: [{ nodeId: 'first-one', classification: 'behavior' }] });
  data.stages[0].files.push({ path: 'src/renamed.js', previousPath: 'old/name.js', kind: 'renamed', additions: 5, deletions: 3, memberships: [{ nodeId: 'first-one', classification: 'behavior' }] });
  data.stages[0].files.push({ path: 'shared.json', kind: 'added', additions: 1, deletions: 0, memberships: [{ nodeId: 'first-one', classification: 'behavior' }] });
  await mount(page, data);
  await page.locator('.stage-title[data-id="first"]').click();
  await page.locator('details[data-node="first-one"] > summary').click();
  const occurrences = page.getByRole('button', { name: 'Find occurrences of lib/shared.js', exact: true }).first();
  await occurrences.click();
  const dialog = page.getByRole('dialog', { name: 'Find a file' });
  const input = dialog.getByRole('combobox');
  await expect(input).toHaveValue('shared.js');
  await expect(dialog.getByRole('option')).toHaveCount(4);
  await input.fill('renamed');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await expect(dialog.getByRole('option').locator('strong')).toHaveText('renamed.js');
  await expect(dialog.getByRole('option').locator('small')).toHaveText('src/');
  await expect(dialog.getByRole('option').getByRole('img', { name: 'Renamed' })).toHaveText('R');
  await expect(dialog.getByRole('option')).toContainText('−3');
  await input.fill('missing-file');
  await expect(dialog.getByRole('status')).toHaveText('No matching files');
  await expect(input).not.toHaveAttribute('aria-activedescendant');
  await input.press('Enter');
  await expect(dialog).toBeVisible();
  await input.press('Escape');
  await expect(occurrences).toBeFocused();
  await page.getByRole('button', { name: 'Find file', exact: true }).click();
  await input.fill('renamed');
  await dialog.getByRole('option').click();
  await expect(page.locator('.frow[data-file="f:first:src/renamed.js"] + .cinema-diff')).toBeVisible();
});

test('file occurrences open the picker on the occurrence they were clicked from', async ({ page }) => {
  await mount(page);
  await page.setViewportSize({ width: 1280, height: 300 });
  const dialog = page.getByRole('dialog', { name: 'Find a file' });
  const selected = dialog.locator('[role="option"][aria-selected="true"]');
  async function openFrom(stageId, nodeId) {
    await page.locator(`.stage-title[data-id="${stageId}"]`).click();
    const node = page.locator(`details[data-node="${nodeId}"]`);
    if (await node.getAttribute('open') === null) await node.locator('> summary').click();
    await node.getByRole('button', { name: 'Find occurrences of shared.js', exact: true }).click();
    await expect(dialog.getByRole('option')).toHaveCount(4);
  }

  await openFrom('second', 'second-two');
  await expect(selected).toHaveAttribute('data-index', '3');
  await expect(selected).toBeInViewport();
  await dialog.getByRole('combobox').press('Escape');

  await openFrom('first', 'first-two');
  await expect(selected).toHaveAttribute('data-index', '1');
  await expect(selected).toBeInViewport();
  await dialog.getByRole('combobox').press('Enter');
  await expect(page.locator('details[data-node="first-two"] .frow-open')).toBeFocused();

  await page.getByRole('button', { name: 'Find file', exact: true }).click();
  await expect(selected).toHaveAttribute('data-index', '0');
});

test('file search updates from live snapshots without losing query or background drafts', async ({ page }) => {
  const data = fixture();
  await mount(page, data);
  await openFile(page);
  await page.locator('.file-notes .thread-add').click();
  await page.locator('textarea[name="nc-body"]').fill('Keep my draft');
  await page.getByRole('button', { name: 'Find file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Find a file' });
  const input = dialog.getByRole('combobox');
  await input.fill('shared');
  data.stages[1].files = [];
  data.viewerRevision = 'updated-files';
  await expect(dialog.getByRole('option')).toHaveCount(2, { timeout: 15000 });
  await expect(input).toHaveValue('shared');
  await expect(input).toBeFocused();
  await input.press('Escape');
  await expect(page.locator('textarea[name="nc-body"]')).toHaveValue('Keep my draft');
});

test('file search reopened before the old one finishes closing keeps following live snapshots', async ({ page }) => {
  const data = fixture();
  const errors = await mount(page, data);
  await page.getByRole('button', { name: 'Find file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Find a file' });
  await expect(dialog.getByRole('option')).toHaveCount(4);
  // Close and reopen in one task, so the old dialog's close event arrives
  // after the new picker opened.
  await page.evaluate(() => {
    document.querySelector('dialog.file-search').close();
    document.querySelector('[data-action="file-search"]').click();
  });
  await expect(page.locator('dialog.file-search')).toHaveCount(1);
  const input = dialog.getByRole('combobox');
  await expect(input).toBeFocused();
  data.stages[1].files = [];
  data.viewerRevision = 'reopened-files';
  await expect(dialog.getByRole('option')).toHaveCount(2, { timeout: 15000 });
  await expect(input).toBeFocused();
  expect(errors).toEqual([]);
});

test('file search keeps all matches scrollable and fits narrow screens', async ({ page }) => {
  const data = fixture();
  data.stages[0].files.push(...Array.from({ length: 120 }, (_, i) => ({ path: `src/${'long-directory/'.repeat(5)}file-${i}.js`, kind: 'added', additions: 1, deletions: 0, memberships: [{ nodeId: 'first-one', classification: 'behavior' }] })));
  await page.setViewportSize({ width: 390, height: 700 });
  await mount(page, data);
  await page.getByRole('button', { name: 'Find file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Find a file' });
  await expect(dialog.getByRole('option')).toHaveCount(124);
  await dialog.getByRole('combobox').press('End');
  await expect(dialog.getByRole('option').last()).toBeInViewport();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const bounds = await dialog.boundingBox();
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(700);
});

test('file search dismisses on the backdrop but keeps interior clicks and result navigation working', async ({ page }) => {
  const errors = await mount(page);
  const trigger = page.getByRole('button', { name: 'Find file', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Find a file' });
  await trigger.click();
  const bounds = await dialog.boundingBox();
  // Empty dialog padding targets the dialog itself, just like the backdrop.
  await page.mouse.click(bounds.x + 5, bounds.y + 5);
  await dialog.getByRole('heading', { name: 'Find a file' }).click();
  await dialog.getByRole('combobox').click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.press('t');
  await dialog.getByRole('option').last().click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('details[data-node="second-two"] .frow-open')).toBeFocused();
  expect(errors).toEqual([]);
});

test('file search reopens an empty query at the top after scrolling and every dismissal method', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const data = fixture();
  data.stages[0].files.push(...Array.from({ length: 120 }, (_, i) => ({ path: `src/file-${i}.js`, kind: 'added', additions: 1, deletions: 0, memberships: [{ nodeId: 'first-one', classification: 'behavior' }] })));
  const errors = await mount(page, data);
  const trigger = page.getByRole('button', { name: 'Find file', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Find a file' });
  const input = dialog.getByRole('combobox');
  const results = dialog.getByRole('listbox');
  await trigger.click();
  for (const dismiss of ['Escape', 'button', 'backdrop']) {
    await expect(input).toHaveValue('');
    if (dismiss === 'Escape') {
      await input.press('End');
      await expect(dialog.getByRole('option').last()).toBeInViewport();
    } else {
      await results.hover();
      await page.mouse.wheel(0, 10000);
    }
    await expect.poll(() => results.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    if (dismiss === 'Escape') await input.press('Escape');
    else if (dismiss === 'button') await dialog.getByRole('button', { name: 'Close file search' }).click();
    else await page.mouse.click(5, 5);
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.press('t');
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await expect.poll(() => results.evaluate(el => el.scrollTop)).toBe(0);
    await expect(dialog.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('option').first()).toBeInViewport();
  }
  expect(errors).toEqual([]);
});

test('T opens file search without stealing typing, modified keys, or another dialog', async ({ page }) => {
  await mount(page);
  const dialog = page.getByRole('dialog', { name: 'Find a file' });
  const trigger = page.getByRole('button', { name: 'Find file', exact: true });
  await expect(trigger).toHaveAttribute('aria-keyshortcuts', 't');
  await trigger.focus();
  await page.keyboard.press('t');
  await expect(dialog.getByRole('combobox')).toBeFocused();
  await page.keyboard.press('t');
  await expect(dialog.getByRole('combobox')).toHaveValue('t');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await openFile(page);
  await page.locator('.file-notes .thread-add').click();
  const draft = page.locator('textarea[name="nc-body"]');
  await draft.press('t');
  await expect(draft).toHaveValue('t');
  await expect(dialog).toHaveCount(0);
  const ignored = await page.evaluate(() => {
    const dispatch = (target, options = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true, ...options }));
    const results = ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing', 'repeat'].map(key => dispatch(document.body, { [key]: true }));
    for (const html of ['<input>', '<select><option>test</option></select>', '<div contenteditable="true"><span>Text</span></div>', '<div role="textbox"><span>Text</span></div>']) {
      const holder = document.createElement('div');
      holder.innerHTML = html; document.body.append(holder);
      results.push(dispatch(holder.querySelector('span') || holder.firstElementChild));
      holder.remove();
    }
    return results;
  });
  expect(ignored.every(Boolean)).toBe(true);
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.keyboard.press('t');
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Saved reviews' })).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press('t');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(draft).toHaveValue('t');
});

test('file search renders its results only when the matches or the active option change', async ({ page }) => {
  const data = fixture();
  for (const stage of data.stages) stage.files = Array.from({ length: 750 }, (_, i) => ({ path: `dir/file${i}.js`, kind: 'modified', revision: 'rev', additions: 1, deletions: 0,
    memberships: [{ nodeId: `${stage.id}-one`, classification: 'behavior' }, { nodeId: `${stage.id}-two`, classification: 'behavior' }] }));
  const errors = await mount(page, data);
  await page.keyboard.press('t');
  const dialog = page.getByRole('dialog', { name: 'Find a file' });
  await expect(dialog.getByRole('option')).toHaveCount(3000);
  // Caret, focus, selection and scroll events only refresh the completion;
  // moving the active option renders the list. Rendering an option converts its
  // selected state with the global String, so the calls during one event count
  // how many options it rendered, and the list's mutations show what changed.
  const effects = await page.evaluate(() => {
    const input = document.querySelector('#file-search-input'), list = document.querySelector('#file-search-results');
    const original = window.String;
    let calls = 0;
    const counting = function (...args) { calls++; return original(...args); };
    Object.setPrototypeOf(counting, original); counting.prototype = original.prototype;
    const observer = new MutationObserver(() => {});
    observer.observe(list, { subtree: true, childList: true, attributes: true, characterData: true });
    const effect = (event) => {
      calls = 0; window.String = counting;
      try { input.dispatchEvent(event); } finally { window.String = original; }
      return { renders: calls, mutations: observer.takeRecords().map((record) => `${record.type}:${record.attributeName}:${record.target.dataset?.index}`) };
    };
    const caret = ['keyup', 'focus', 'select', 'scroll', 'click', 'blur'].map((type) => effect(new Event(type)));
    const move = effect(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    const back = effect(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    observer.disconnect();
    return { caret, move, back };
  });
  for (const caret of effects.caret) {
    expect(caret.renders).toBeLessThan(100);
    expect(caret.mutations).toEqual([]);
  }
  for (const [move, from, to] of [[effects.move, 0, 1], [effects.back, 1, 0]]) {
    expect(move.renders).toBeGreaterThanOrEqual(3000);
    expect(move.mutations.sort()).toEqual([`attributes:aria-selected:${from}`, `attributes:aria-selected:${to}`].sort());
  }
  await expect(dialog.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('option').first()).toHaveAttribute('aria-selected', 'false');
  expect(errors).toEqual([]);
});

test('file search shows line counts a diff response updates while it is open', async ({ page }) => {
  const data = fixture(), { lines } = data.stages[0].files[0];
  // Without lines, opening the file requests its diff.
  delete data.stages[0].files[0].lines;
  const errors = await mount(page, data);
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  await page.route('http://localhost/api/diff**', async (route) => {
    await released;
    await route.fulfill({ json: { ok: true, lines, additions: 9, deletions: 4 } });
  });
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/diff');
  await openFile(page);
  await page.getByRole('button', { name: 'Find file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Find a file' });
  const options = dialog.getByRole('option');
  await expect(options).toHaveCount(4);
  await expect(options.first()).toContainText('+2');
  release();
  await response;
  await expect(options.first()).toContainText('+9');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  for (const index of [0, 1]) {
    await expect(options.nth(index)).toContainText('+9');
    await expect(options.nth(index)).toContainText('−4');
  }
  await expect(options.nth(2)).toContainText('+2');
  expect(errors).toEqual([]);
});

// Holds every diff request until the test answers it.
async function holdDiffRequests(page) {
  const pending = [];
  await page.route('http://localhost/api/diff**', (route) => { pending.push(route); });
  return pending;
}
// Counts the times the open file search draws its results from now on: each
// draw looks up the completion under the input.
const countSearchDraws = (page) => page.evaluate(() => {
  const original = window.originalQuerySelector ||= Element.prototype.querySelector;
  window.searchDraws = 0;
  Element.prototype.querySelector = function (selector) {
    if (selector === '.file-search-completion-text') window.searchDraws++;
    return original.call(this, selector);
  };
});
const searchDraws = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
  Element.prototype.querySelector = window.originalQuerySelector; resolve(window.searchDraws);
}))));

test('file search redraws its results only when a diff response changes what a listed file shows', async ({ page }) => {
  const data = fixture();
  for (const stage of data.stages) stage.files = Array.from({ length: 20 }, (_, i) => ({ path: `dir/file${i}.js`, kind: 'modified', revision: 'rev', additions: 1, deletions: 0,
    memberships: [{ nodeId: `${stage.id}-one`, classification: 'behavior' }, { nodeId: `${stage.id}-two`, classification: 'behavior' }] }));
  const lines = [{ t: 'add', n: 1, s: 'const first = 1;' }, { t: 'add', n: 2, s: 'const second = 2;' }];
  const errors = await mount(page, data, { openStages: { first: true } });
  const pending = await holdDiffRequests(page);
  await page.locator('details[data-node="first-one"] summary').click();
  await page.locator('details[data-node="first-one"] .frow-open[data-id="f:first:dir/file0.js"]').click();
  await expect.poll(() => pending.length).toBe(1);
  const panel = page.locator('details[data-node="first-one"] .cinema-diff');
  const dialog = page.getByRole('dialog', { name: 'Find a file' });
  const options = dialog.getByRole('option');
  // A page whose line counts and binary flag are unchanged renders no option.
  await page.getByRole('button', { name: 'Find file', exact: true }).click();
  await expect(options).toHaveCount(80);
  await countSearchDraws(page);
  await pending[0].fulfill({ json: { ok: true, lines: lines.slice(0, 1), offset: 0, nextOffset: 1, additions: 1, deletions: 0 } });
  await expect(panel.locator('[data-line-id="l:first:new:1:dir/file0.js"]')).toHaveCount(1);
  expect(await searchDraws(page)).toBe(0);
  await dialog.getByRole('combobox').press('Escape');
  // Neither does a page that changes the counts of a file the results do not list.
  await panel.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect.poll(() => pending.length).toBe(2);
  await page.getByRole('button', { name: 'Find file', exact: true }).click();
  await dialog.getByRole('combobox').fill('file1');
  await expect(options).toHaveCount(44);
  await countSearchDraws(page);
  await pending[1].fulfill({ json: { ok: true, lines: lines.slice(1), offset: 1, nextOffset: null, additions: 9, deletions: 0 } });
  await expect(panel.locator('[data-line-id="l:first:new:2:dir/file0.js"]')).toHaveCount(1);
  expect(await searchDraws(page)).toBe(0);
  // The changed counts show once the file is listed.
  await dialog.getByRole('combobox').fill('file0.js');
  await expect(options.first()).toContainText('+9');
  expect(errors).toEqual([]);
});

test('a diff response after a live snapshot updates the open file search, or is dropped when stale', async ({ page }) => {
  const data = fixture(), { lines } = data.stages[0].files[0];
  // Without lines, opening the file requests its diff.
  delete data.stages[0].files[0].lines;
  const errors = await mount(page, data);
  const pending = await holdDiffRequests(page);
  await openFile(page);
  await expect.poll(() => pending.length).toBe(1);
  await page.getByRole('button', { name: 'Find file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Find a file' });
  const options = dialog.getByRole('option');
  await expect(options).toHaveCount(4);
  await expect(options.first()).toContainText('+2');
  // A snapshot replaces the file objects while the page loads.
  data.stages[1].files[0].additions = 5;
  data.viewerRevision = 'during-diff';
  await expect(options.nth(2)).toContainText('+5', { timeout: 15000 });
  await pending[0].fulfill({ json: { ok: true, lines, additions: 9, deletions: 4 } });
  await expect(options.first()).toContainText('+9');
  await expect(options.first()).toContainText('−4');
  // A response for a file revision a snapshot has replaced is dropped, and the
  // new revision is requested.
  await dialog.getByRole('combobox').press('Escape');
  await page.locator('details[data-node="first-one"] [data-action="set-view"][data-mode="full"]').click();
  await expect.poll(() => pending.length).toBe(2);
  data.stages[0].files[0].revision = 'rev2';
  data.stages[0].files[0].additions = 3;
  data.viewerRevision = 'new-file-revision';
  await page.getByRole('button', { name: 'Find file', exact: true }).click();
  await expect(options.first()).toContainText('+3', { timeout: 15000 });
  await pending[1].fulfill({ json: { ok: true, lines, additions: 9, deletions: 4 } });
  await expect.poll(() => pending.length).toBe(3);
  await expect(options.first()).toContainText('+3');
  await expect(options.first()).toContainText('−0');
  expect(errors).toEqual([]);
});

test('a diff request that fails after the view mode changes does not stop the new mode loading', async ({ page }) => {
  const data = fixture(), { lines } = data.stages[0].files[0];
  delete data.stages[0].files[0].lines;
  const errors = await mount(page, data);
  const pending = await holdDiffRequests(page);
  await openFile(page);
  await expect.poll(() => pending.length).toBe(1);
  const panel = page.locator('details[data-node="first-one"] .cinema-diff');
  await panel.locator('[data-action="set-view"][data-mode="full"]').click();
  // The Changes request fails once the reviewer has switched to Full file.
  await pending[0].fulfill({ status: 500, json: { ok: false, error: 'Changes failed' } });
  await expect.poll(() => pending.length).toBe(2);
  expect(new URL(pending[1].request().url()).searchParams.get('mode')).toBe('full');
  await expect(panel).not.toContainText('Could not load diff');
  await pending[1].fulfill({ json: { ok: true, lines, additions: 2 } });
  await expect(panel.locator('[data-line-id="l:first:new:1:shared.js"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

for (const change of ['mode', 'restack']) {
  test(`a queued diff page is dropped when the ${change === 'mode' ? 'view mode' : 'stage head'} changes`, async ({ page }) => {
    const data = fixture(), file = data.stages[0].files[0];
    const long = Array.from({ length: 1900 }, (_, i) => ({ t: 'add', n: i + 1, s: `const row${i + 1} = ${i + 1};`, h: 1 }));
    const short = file.lines;
    file.lines = long.slice(0, 900); file.nextOffset = 900;
    const errors = await mount(page, data, { fileView: { [fileId]: 'full' } });
    // The full file is long; its changes, and the restacked file, are short.
    const respond = (route) => {
      const params = new URL(route.request().url()).searchParams, offset = Number(params.get('offset'));
      const rows = params.get('mode') === 'full' && params.get('head') === 'b'.repeat(40) ? long : short;
      return route.fulfill({ json: { ok: true, lines: rows.slice(offset, offset + 900), offset,
        nextOffset: offset + 900 < rows.length ? offset + 900 : null, additions: rows.length } });
    };
    const pending = await holdDiffRequests(page);
    await openFile(page);
    const panel = page.locator('details[data-node="first-one"] .cinema-diff');
    const next = panel.getByRole('button', { name: 'Next page', exact: true });
    await next.evaluate((el) => el.click());
    await expect.poll(() => pending.length).toBe(1);
    // A second click waits for the first page.
    await next.evaluate((el) => el.click());
    if (change === 'mode') await panel.getByRole('button', { name: 'Changes', exact: true }).click();
    else {
      // The server sends a file's lines only in diff responses.
      delete file.lines; delete file.nextOffset;
      data.stages[0].headRevision = 'c'.repeat(40); data.viewerRevision = 'restacked';
      await expect(page.locator('.review-update')).toHaveText('Review updated', { timeout: 15000 });
    }
    await respond(pending[0]);
    await expect.poll(() => pending.length).toBe(2);
    await respond(pending[1]);
    await expect(panel.locator('[data-line-id="l:first:new:1:shared.js"]')).toHaveCount(1);
    await expect(panel).not.toContainText('No line changes recorded');
    expect(errors).toEqual([]);
  });
}

test('a request for a line that a restack makes stale asks again for that line', async ({ page }) => {
  const data = fixture(), file = data.stages[0].files[0];
  const rows = Array.from({ length: 1900 }, (_, i) => ({ t: 'ctx', o: i + 1, n: i + 1, s: `const row${i + 1} = ${i + 1};` }));
  file.lines = rows.slice(0, 900); file.nextOffset = 900;
  data.feedback = [thread('far', 'open', { kind: 'line', stageId: 'first', nodeId: 'first-one', path: 'shared.js', side: 'new', line: 1200, label: 'shared.js:1200' })];
  const errors = await mount(page, data, { openStages: { first: true } });
  const respond = (route) => {
    const params = new URL(route.request().url()).searchParams, line = Number(params.get('line'));
    const offset = line ? Math.floor((line - 1) / 900) * 900 : Number(params.get('offset'));
    return route.fulfill({ json: { ok: true, lines: rows.slice(offset, offset + 900), offset,
      nextOffset: offset + 900 < rows.length ? offset + 900 : null, additions: 0 } });
  };
  const pending = await holdDiffRequests(page);
  await showNotes(page);
  await page.locator('.side.notes [data-action="jump-to"][data-kind="line"]').click();
  await expect.poll(() => pending.length).toBe(1);
  // The stage head changes while the line's page loads; the file is unchanged.
  // The server sends a file's lines only in diff responses.
  delete file.lines; delete file.nextOffset;
  data.stages[0].headRevision = 'c'.repeat(40); data.viewerRevision = 'restacked';
  await expect(page.locator('.review-update')).toHaveText('Review updated', { timeout: 15000 });
  await respond(pending[0]);
  await expect.poll(() => pending.length).toBe(2);
  await respond(pending[1]);
  await expect(page.locator('.cinema-diff [data-line-id="l:first:new:1200:shared.js"]')).toBeInViewport();
  expect(errors).toEqual([]);
});

test('file search requires a contiguous current filename substring and completes inline', async ({ page }) => {
  const data = fixture();
  const file = (path, kind = 'added', previousPath) => ({ path, kind, previousPath, additions: 3, deletions: 1, memberships: [{ nodeId: 'first-one', classification: 'behavior' }] });
  data.stages[0].files.push(file('src/catalog.ts'), file('lib/catalog.test.ts'), file('catalog/other.ts'), file('src/fresh.ts', 'renamed', 'old/catalog.ts'));
  await mount(page, data);
  await page.keyboard.press('t');
  const dialog = page.getByRole('dialog', { name: 'Find a file' });
  const input = dialog.getByRole('combobox', { name: 'Filename' });
  const suffix = dialog.locator('.file-search-suffix');
  await expect(suffix).toHaveText('');
  for (const query of ['src', 'lib', 'ctlg', 'src/catalog.ts', 'old/catalog', ' catalog']) {
    await input.fill(query);
    await expect(dialog.getByRole('option')).toHaveCount(0);
    await expect(suffix).toHaveText('');
  }
  await input.fill('CAT');
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await expect(suffix).toHaveText('alog.ts');
  await expect(input).toHaveValue('CAT');
  await expect(dialog.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('option').first().locator('strong')).toHaveText('catalog.ts');
  await expect(dialog.getByRole('option').first().locator('small')).toHaveText('src/');
  await expect(dialog.getByRole('option').first().getByRole('img', { name: 'Added' })).toHaveText('A');
  await expect(dialog.locator('footer')).not.toContainText('Tab');
  await input.press('ArrowDown');
  await expect(suffix).toHaveText('alog.test.ts');
  await input.press('ArrowUp');
  await expect(suffix).toHaveText('alog.ts');
  await input.press('ArrowLeft');
  await expect(suffix).toHaveText('');
  await input.press('ArrowRight');
  await expect(suffix).toHaveText('alog.ts');
  await input.dispatchEvent('compositionstart');
  await expect(suffix).toHaveText('');
  await input.dispatchEvent('compositionend');
  await expect(suffix).toHaveText('alog.ts');
  await input.fill('alog');
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await expect(suffix).toHaveText('.ts');
  const typedBounds = await dialog.locator('.file-search-typed').boundingBox();
  const suffixBounds = await suffix.boundingBox();
  expect(suffixBounds.x).toBeCloseTo(typedBounds.x + typedBounds.width, 0);
  expect(suffixBounds.y).toBeCloseTo(typedBounds.y, 0);
  await input.press('Enter');
  await expect(dialog).toHaveCount(0);
  const row = page.locator('.frow[data-file="f:first:src/catalog.ts"]');
  await expect(row.locator('.frow-open')).toBeFocused();
  await expect(page.locator('.frow[data-file="f:first:src/catalog.ts"] + .cinema-diff')).toBeVisible();
  await expect(row.getByRole('img', { name: 'Added' })).toHaveText('A');
});

test('inline filename completion stays clipped and aligned when the query scrolls', async ({ page }) => {
  const data = fixture();
  const query = 'long-filename-'.repeat(8);
  data.stages[0].files[0].path = `src/${query}suffix.ts`;
  await page.setViewportSize({ width: 390, height: 700 });
  await mount(page, data);
  await page.keyboard.press('t');
  const dialog = page.getByRole('dialog', { name: 'Find a file' });
  const input = dialog.getByRole('combobox');
  await input.fill(query);
  await expect(dialog.locator('.file-search-suffix')).toHaveText('suffix.ts');
  await expect.poll(() => input.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  await expect.poll(() => dialog.evaluate(el => {
    const input = el.querySelector('input');
    const transform = getComputedStyle(el.querySelector('.file-search-completion-text')).transform;
    return new DOMMatrixReadOnly(transform).m41 + input.scrollLeft;
  })).toBe(0);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const result = dialog.getByRole('option').first();
  const nameBounds = await result.locator('strong').boundingBox();
  const pathBounds = await result.locator('small').boundingBox();
  expect(pathBounds.y).toBeGreaterThanOrEqual(nameBounds.y + nameBounds.height);
  const sizes = await result.evaluate(el => [el.querySelector('strong'), el.querySelector('small')].map(node => parseFloat(getComputedStyle(node).fontSize)));
  expect(sizes[1]).toBeLessThan(sizes[0]);
});

function codeInsight(status = 'current') {
  const original = { path: 'shared.js', revision: 'b'.repeat(40), blobId: 'c'.repeat(40), startLine: 1, endLine: 1, contextStartLine: 1, context: ['const first = 1;', '// context', 'const second = 2;'] };
  return { type: 'risk', collection: 'risks', id: 'linked', title: 'Check the boundary', body: 'A long explanation.\n'.repeat(120) + 'Final paragraph <img src=x onerror=unsafe()>', nodeRefs: ['first-one'],
    codeTarget: { ...original, original, status, ...(status === 'needs-review' ? { reason: 'Targeted code was edited.' } : {}) } };
}

test('code insights open from reasoning, file and line with full text and keyboard dismissal', async ({ page }) => {
  const data = fixture(); data.stages[0].insights.push(codeInsight());
  const errors = await mount(page, data); await openFile(page);
  const node = page.locator('details[data-node="first-one"]');
  const button = node.locator('.node-reasoning .code-insight-link');
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Insight and code' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.insight-full-body')).toContainText('Final paragraph <img src=x onerror=unsafe()>');
  await expect(dialog.locator('img')).toHaveCount(0);
  await expect(dialog.locator('.insight-code-line.is-target')).toHaveText('1const first = 1;');
  await expect(dialog.locator('.insight-code-block')).toContainText('// context');
  expect(await dialog.locator('article').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(button).toBeFocused();
  await node.getByRole('button', { name: 'Insights · 1' }).click(); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close insight' }).click();
  await node.locator('.line-code-insights button').click(); await expect(dialog).toBeVisible();
  expect(errors).toEqual([]);
});

test('stale code insights show original context and repair guidance without attaching to current lines', async ({ page }) => {
  const data = fixture(); data.stages[0].insights.push(codeInsight('needs-review'));
  const errors = await mount(page, data); await openFile(page);
  const node = page.locator('details[data-node="first-one"]');
  await expect(node.locator('.line-code-insights')).toHaveCount(0);
  await node.locator('.node-reasoning .code-insight-link').click();
  const dialog = page.getByRole('dialog', { name: 'Insight and code' });
  await expect(dialog).toContainText('Needs review: Targeted code was edited.');
  await expect(dialog.getByRole('heading', { name: 'Original code', exact: true })).toBeVisible();
  await expect(dialog).toContainText('stage target');
  await expect(dialog.locator('.insight-code-block')).toContainText('const first = 1;');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('inline insights wrap in a stable sans-serif hit area and stay pinned while code scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  const data = fixture(), insight = codeInsight();
  insight.type = 'question'; insight.collection = 'openQuestions';
  insight.title = 'Should a 429 response honor Retry-After? ' + 'Keep the retry delay within the delivery budget. '.repeat(8);
  data.stages[0].insights.push(insight);
  data.stages[0].files[0].lines[0].s += ' // ' + 'long source line '.repeat(60);
  data.stages[0].files[0].lines.push(...Array.from({ length: 50 }, (_, i) => ({ t: 'add', n: i + 4, s: `const value${i} = ${i};`, h: 1 })));
  const errors = await mount(page, data); await openFile(page);
  const panel = page.locator('details[data-node="first-one"] .cinema-diff');
  const scroller = panel.locator('.diff-scroll');
  const button = panel.locator('.line-code-insights button');
  await expect(button.getByRole('img', { name: 'Open question', exact: true })).toHaveText('?');
  await button.scrollIntoViewIfNeeded();
  const inspect = () => button.evaluate(el => {
    const scroll = el.closest('.diff-scroll'), text = el.querySelector('.inline-insight-text');
    const range = document.createRange(); range.selectNodeContents(text);
    return {
      x: el.getBoundingClientRect().x, width: el.getBoundingClientRect().width,
      scrollLeft: scroll.getBoundingClientRect().left, scrollWidth: scroll.clientWidth,
      overflow: el.scrollWidth > el.clientWidth, font: getComputedStyle(el).fontFamily,
      bodyFont: getComputedStyle(document.body).fontFamily,
      lines: Array.from(range.getClientRects()).map(r => ({ x: r.x, y: r.y })),
    };
  });
  const before = await inspect();
  expect(await scroller.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await button.evaluate(el => el.parentElement.getBoundingClientRect().width <= el.closest('.diff-scroll').clientWidth)).toBe(true);
  expect(before.lines.length).toBeGreaterThan(1);
  expect(before.overflow).toBe(false);
  expect(before.font).toBe(before.bodyFont);
  expect(before.lines.every(r => Math.abs(r.x - before.lines[0].x) < 1)).toBe(true);
  await scroller.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  expect(await scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(200);
  const after = await inspect();
  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  expect(after.x + after.width).toBeLessThanOrEqual(after.scrollLeft + after.scrollWidth);
  // Sample padding, icon, text, and multiple wrapped rows without hit-area changes.
  const box = await button.boundingBox();
  for (const [dx, dy] of [[2, 2], [12, 12], [55, 12], [55, box.height - 8], [box.width - 3, box.height / 2]]) {
    await page.mouse.move(box.x + dx, box.y + dy);
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return { cursor: getComputedStyle(el).cursor, button: el.matches('.line-code-insights button') };
    }, { x: box.x + dx, y: box.y + dy });
    expect(hit).toEqual({ cursor: 'pointer', button: true });
    const bounds = await button.boundingBox();
    expect(bounds).toEqual(box);
  }
  await page.setViewportSize({ width: 760, height: 900 });
  const resized = await inspect();
  expect(resized.width).toBeLessThan(before.width);
  expect(resized.overflow).toBe(false);
  await panel.getByRole('button', { name: 'Wrap lines', exact: true }).click();
  const wrapped = await inspect();
  expect(wrapped.lines.length).toBeGreaterThan(1);
  expect(wrapped.overflow).toBe(false);
  expect(await scroller.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('inline insight hover and focus highlight only the linked new lines in that diff', async ({ page }) => {
  const data = fixture(), insight = codeInsight();
  insight.codeTarget.endLine = 2;
  data.stages[0].insights.push(insight);
  data.stages[0].files[0].lines.unshift({ t: 'del', o: 1, s: 'old code', h: 1 });
  const errors = await mount(page, data);
  await openFile(page, 'first-two');
  await openFile(page);
  const node = page.locator('details[data-node="first-one"]');
  const button = node.locator('.line-code-insights button');
  const highlighted = page.locator('.is-code-insight-target');
  await button.hover();
  await expect(highlighted).toHaveCount(2);
  expect(await highlighted.evaluateAll(rows => rows.map(row => row.dataset.lineId))).toEqual(['l:first:new:1:shared.js', 'l:first:new:2:shared.js']);
  await expect(node.locator('[data-line-id="l:first:old:1:shared.js"]')).not.toHaveClass(/is-code-insight-target/);
  await expect(page.locator('details[data-node="first-two"] .is-code-insight-target')).toHaveCount(0);
  const icon = await button.locator('.inline-insight-icon').boundingBox();
  await page.mouse.move(icon.x + icon.width / 2, icon.y + icon.height / 2);
  await expect(highlighted).toHaveCount(2);
  const text = await button.locator('.inline-insight-text').boundingBox();
  await page.mouse.move(text.x + 10, text.y + text.height / 2);
  await expect(highlighted).toHaveCount(2);
  await page.mouse.move(0, 0);
  await expect(highlighted).toHaveCount(0);
  await button.focus();
  await expect(highlighted).toHaveCount(2);
  await button.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Insight and code' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  await expect(highlighted).toHaveCount(0);
  await page.getByRole('button', { name: 'Find file' }).focus();
  await button.focus();
  await expect(highlighted).toHaveCount(2);
  await button.click();
  await page.getByRole('button', { name: 'Close insight' }).click();
  await expect(button).toBeFocused();
  await expect(highlighted).toHaveCount(0);
  await page.mouse.move(0, 0);
  await button.hover();
  await expect(highlighted).toHaveCount(2);
  await page.mouse.move(0, 0);
  await expect(highlighted).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('linked reasoning is one divided pill with stable hover and multiline tooltips', async ({ page }) => {
  const data = fixture(), insight = codeInsight();
  insight.body = 'First paragraph.\n\nSecond paragraph.\nThird line.';
  data.stages[0].insights.push(insight);
  const errors = await mount(page, data); await openFile(page);
  const pill = page.locator('details[data-node="first-one"] .node-reasoning .tag.has-code');
  const face = pill.locator('.tag-face'), code = pill.locator('.code-insight-link');
  await face.scrollIntoViewIfNeeded();
  const left = await face.boundingBox(), right = await code.boundingBox();
  expect(Math.abs(left.x + left.width - right.x)).toBeLessThan(1);
  expect(left.y).toBe(right.y);
  expect(left.height).toBe(right.height);
  await expect(code).toHaveCSS('border-left-width', '1px');
  await face.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  expect(await tooltip.locator('p').textContent()).toBe(insight.body);
  await expect(tooltip.locator('p')).toHaveCSS('white-space', 'pre-wrap');
  // Moving through label descendants must not repaint or hide the tooltip.
  await tooltip.evaluate(el => {
    window.tooltipMutations = [];
    window.tooltipObserver = new MutationObserver(records => window.tooltipMutations.push(...records.map(r => r.type)));
    window.tooltipObserver.observe(el, { childList: true, attributes: true, subtree: true });
  });
  for (const dx of [3, 18, 60, left.width - 3]) {
    await page.mouse.move(left.x + dx, left.y + left.height / 2);
    await expect(face).toHaveCSS('cursor', 'pointer');
    expect(await face.boundingBox()).toEqual(left);
    await expect(tooltip).toBeVisible();
  }
  expect(await page.evaluate(() => { window.tooltipObserver.disconnect(); return window.tooltipMutations; })).toEqual([]);
  await face.click();
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeVisible();
  await code.click();
  await expect(page.getByRole('dialog', { name: 'Insight and code' })).toBeVisible();
  await expect(tooltip).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(code).toBeFocused();
  expect(errors).toEqual([]);
});

// Every full render first records which steps are open, so counting those
// lookups counts renders.
async function countRenders(page) {
  await page.evaluate(() => {
    window.renders = 0;
    const query = Element.prototype.querySelectorAll;
    Element.prototype.querySelectorAll = function (selector) {
      // Every render prepares the disclosures it rendered for animation.
      if (selector === 'details > summary') window.renders++;
      return query.call(this, selector);
    };
  });
  return () => page.evaluate(() => new Promise((resolve) => setTimeout(() => resolve(window.renders), 50)));
}

test('inline insight hover updates only its rows, without rendering, and later renders agree', async ({ page }) => {
  const data = fixture(), insight = codeInsight();
  insight.codeTarget.endLine = 2;
  data.stages[0].insights.push(insight);
  const errors = await mount(page, data); await openFile(page);
  const button = page.locator('details[data-node="first-one"] .line-code-insights button');
  const highlighted = page.locator('.is-code-insight-target');
  const lineIds = () => highlighted.evaluateAll((rows) => rows.map((row) => row.dataset.lineId));
  const toggleNotes = async (open) => {
    await page.evaluate(() => document.querySelector('.tb-btn[data-action="toggle-notes"]').click());
    await expect(page.locator('.tb-btn[data-action="toggle-notes"]')).toHaveAttribute('aria-expanded', String(open));
  };
  const renders = await countRenders(page);
  await button.hover();
  await expect(highlighted).toHaveCount(2);
  await page.mouse.move(0, 0);
  await expect(highlighted).toHaveCount(0);
  await button.focus();
  await expect(highlighted).toHaveCount(2);
  await button.blur();
  await expect(highlighted).toHaveCount(0);
  expect(await renders()).toBe(0);
  // A render while the insight is focused keeps exactly the highlighted rows;
  // one after it is left keeps none. (The open notes panel covers the diff, so
  // these use focus rather than the pointer.)
  for (let round = 0; round < 2; round++) {
    await button.focus();
    const before = await renders();
    await toggleNotes(true);
    expect(await renders()).toBeGreaterThan(before);
    expect(await lineIds()).toEqual(['l:first:new:1:shared.js', 'l:first:new:2:shared.js']);
    await button.blur();
    await expect(highlighted).toHaveCount(0);
    await toggleNotes(false);
    await expect(highlighted).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('an inline insight highlight ends when its diff closes under the pointer', async ({ page }) => {
  const data = fixture(); data.stages[0].insights.push(codeInsight());
  const errors = await mount(page, data); await openFile(page);
  const node = page.locator('details[data-node="first-one"]');
  await node.locator('.line-code-insights button').hover();
  await expect(page.locator('.is-code-insight-target')).toHaveCount(1);
  while (await node.locator('.cinema-diff').count()) await page.keyboard.press('Escape');
  await page.mouse.move(0, 0);
  await node.locator('.frow-open').click();
  await expect(node.locator('.cinema-diff .drow').first()).toBeVisible();
  await expect(page.locator('.is-code-insight-target')).toHaveCount(0);
  await node.locator('.line-code-insights button').hover();
  await expect(page.locator('.is-code-insight-target')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('an inline insight highlight follows its insight through live updates', async ({ page }) => {
  const data = fixture(); data.stages[0].insights.push(codeInsight());
  const errors = await mount(page, data); await openFile(page);
  const button = page.locator('details[data-node="first-one"] .line-code-insights button');
  const highlighted = page.locator('.is-code-insight-target');
  const lineIds = () => highlighted.evaluateAll((rows) => rows.map((row) => row.dataset.lineId));
  const ids = (...lines) => lines.map((line) => `l:first:new:${line}:shared.js`);
  const update = (revision, change) => { change(data.stages[0]); data.viewerRevision = revision; };
  await button.focus();
  await expect.poll(lineIds).toEqual(ids(1));
  // The insight keeps its first line, so its button stays focused while the
  // range it highlights grows, shrinks, and finally disappears with it.
  update('wider', (stage) => { stage.insights[0].codeTarget.endLine = 3; });
  await expect.poll(lineIds).toEqual(ids(1, 2, 3));
  await expect(button).toBeFocused();
  update('narrower', (stage) => { stage.insights[0].codeTarget.endLine = 2; });
  await expect.poll(lineIds).toEqual(ids(1, 2));
  await expect(button).toBeFocused();
  update('removed', (stage) => { stage.insights = []; });
  await expect(button).toHaveCount(0);
  await expect(highlighted).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('removing a focused inline insight removes its button, not the next one on its line', async ({ page }) => {
  const data = fixture(), kept = codeInsight();
  kept.id = 'kept'; kept.title = 'Kept insight'; kept.codeTarget.endLine = 3;
  data.stages[0].insights.push(codeInsight(), kept);
  const errors = await mount(page, data); await openFile(page);
  const buttons = page.locator('details[data-node="first-one"] .line-code-insights button');
  const highlighted = page.locator('.is-code-insight-target');
  await expect(buttons).toHaveCount(2);
  await buttons.first().focus();
  await expect(highlighted).toHaveCount(1);
  data.stages[0].insights = [kept]; data.viewerRevision = 'removed-first';
  await expect(buttons).toHaveCount(1, { timeout: 15000 });
  await expect(buttons.first()).toHaveAttribute('data-item', 'kept');
  // The removed insight's button went with it, so nothing on the line stays
  // focused and the kept insight's range is not highlighted.
  await expect(buttons.first()).not.toBeFocused();
  await expect(highlighted).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('removing a hovered inline insight returns the highlight to the focused one', async ({ page }) => {
  const data = fixture(), hovered = codeInsight();
  hovered.id = 'hovered'; hovered.title = 'Hovered insight'; hovered.codeTarget.startLine = hovered.codeTarget.endLine = 3;
  data.stages[0].insights.push(codeInsight(), hovered);
  const errors = await mount(page, data); await openFile(page);
  const focused = page.locator('details[data-node="first-one"] .line-code-insights button[data-item="linked"]');
  const highlighted = page.locator('.is-code-insight-target');
  const lineIds = () => highlighted.evaluateAll((rows) => rows.map((row) => row.dataset.lineId));
  await focused.focus();
  await expect.poll(lineIds).toEqual(['l:first:new:1:shared.js']);
  await page.locator('details[data-node="first-one"] .line-code-insights button[data-item="hovered"]').hover();
  await expect.poll(lineIds).toEqual(['l:first:new:3:shared.js']);
  data.stages[0].insights = data.stages[0].insights.filter((ins) => ins.id !== 'hovered'); data.viewerRevision = 'removed-hovered';
  await expect(page.locator('.line-code-insights button[data-item="hovered"]')).toHaveCount(0, { timeout: 15000 });
  await expect(focused).toBeFocused();
  await expect.poll(lineIds).toEqual(['l:first:new:1:shared.js']);
  expect(errors).toEqual([]);
});

test('code insight dialogs animate entry and every dismissal, including an interrupted entry', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const data = fixture(); data.stages[0].insights.push(codeInsight());
  const errors = await mount(page, data); await openFile(page);
  const button = page.locator('details[data-node="first-one"] .line-code-insights button');
  const dialog = page.getByRole('dialog', { name: 'Insight and code' });
  for (const action of ['close', 'escape', 'backdrop']) {
    // Inspect each motion as it starts, in the task that starts it: on a busy
    // machine the entry, or the whole dismissal, can end before a later check.
    await page.evaluate(() => {
      window.motion = { entry: null, closing: null };
      // Opacity and the transform matrix as numbers, comparable across notations.
      const pose = (opacity, transform) => [Number(opacity), ...new DOMMatrix(!transform || transform === 'none' ? undefined : transform).toFloat64Array()];
      const opened = new MutationObserver(() => {
        const el = document.querySelector('dialog.code-insight-dialog');
        if (!el) return;
        opened.disconnect();
        // Interrupt the entry partway; dismissal must start from there.
        const entry = el.getAnimations().find(a => a.effect.getTiming().duration === 180 && a.effect.getKeyframes().some(f => f.transform));
        if (entry) {
          entry.pause(); entry.currentTime = 70;
          const style = getComputedStyle(el);
          window.motion.entry = pose(style.opacity, style.transform);
        }
        const closing = new MutationObserver(() => {
          if (!el.classList.contains('is-closing')) return;
          closing.disconnect();
          const animations = el.getAnimations();
          const frames = animations[0]?.effect.getKeyframes() || [];
          window.motion.closing = {
            durations: animations.map(a => a.effect.getTiming().duration),
            from: frames.length ? pose(frames[0].opacity, frames[0].transform) : null,
            to: frames.length ? pose(frames.at(-1).opacity, frames.at(-1).transform) : null,
            playState: animations[0]?.playState, end: null,
          };
          // Sample the motion as the dialog closes, before it is removed: the
          // capturing listener runs before the dialog's own.
          const animation = animations[0];
          document.addEventListener('close', (event) => {
            if (event.target !== el || !animation) return;
            const style = getComputedStyle(el);
            window.motion.closing.end = { playState: animation.playState, currentTime: animation.currentTime, startTime: animation.startTime,
              timeline: document.timeline.currentTime, pose: pose(style.opacity, style.transform) };
          }, { capture: true, once: true });
        });
        closing.observe(el, { attributes: true, attributeFilter: ['class'] });
      });
      opened.observe(document.body, { childList: true });
    });
    await button.click();
    await expect(dialog).toBeVisible();
    // The paused entry is partway: neither hidden nor fully shown.
    const entry = await page.evaluate(() => window.motion.entry);
    expect(entry[0]).toBeGreaterThan(0);
    expect(entry[0]).toBeLessThan(1);
    if (action === 'close') await dialog.getByRole('button', { name: 'Close insight' }).click();
    else if (action === 'escape') await page.keyboard.press('Escape');
    else await page.mouse.click(1, 1);
    // The dialog took its closing class and ran only the closing motion, which
    // starts where the entry stopped and visibly moves or fades from there.
    await expect.poll(() => page.evaluate(() => window.motion.closing?.durations)).toEqual([140]);
    const { from, to } = await page.evaluate(() => window.motion.closing);
    from.forEach((value, index) => expect(value).toBeCloseTo(entry[index], 3));
    expect(Math.max(...from.map((value, index) => Math.abs(value - to[index])))).toBeGreaterThan(0.05);
    await expect(dialog).toHaveCount(0);
    // The closing motion played rather than holding its first frame: it was
    // running, and by the time the dialog closed it had advanced and changed its
    // pose whenever document time had moved since it started (a starved machine
    // may close on the fallback timer before a frame passes).
    const { playState, end } = await page.evaluate(() => window.motion.closing);
    expect(playState).toBe('running');
    expect(['running', 'finished']).toContain(end.playState);
    if (end.startTime !== null && end.timeline > end.startTime) {
      expect(end.currentTime).toBeGreaterThan(0);
      expect(Math.max(...end.pose.map((value, index) => Math.abs(value - from[index])))).toBeGreaterThan(0);
    } else expect(end.currentTime).toBe(0);
    await expect(button).toBeFocused();
    await expect(page.locator('.is-code-insight-target')).toHaveCount(0);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await button.click();
  expect(await dialog.evaluate(el => el.getAnimations().length)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('mapped insights show both contexts and files let reviewers choose between insights', async ({ page }) => {
  const data = fixture(), first = codeInsight('mapped'), second = codeInsight();
  first.codeTarget.startLine = 2; first.codeTarget.endLine = 2;
  first.codeTarget.context = ['// moved', 'const first = 1;', '// context'];
  first.codeTarget.revision = 'd'.repeat(40);
  second.id = 'second-link'; second.title = 'Another insight';
  data.stages[0].insights.push(first, second);
  await mount(page, data); await openFile(page);
  await page.locator('details[data-node="first-one"]').getByRole('button', { name: 'Insights · 2' }).click();
  const dialog = page.getByRole('dialog', { name: 'Insight and code' });
  await expect(dialog).toContainText('has not been re-reviewed');
  await dialog.locator('.insight-original summary').click();
  await expect(dialog.locator('.insight-original .insight-code-block')).toContainText('const first = 1;');
  await dialog.getByRole('combobox').selectOption('1');
  await expect(dialog.getByRole('heading', { name: 'Another insight', exact: true })).toBeVisible();
});


test('new line drafts retain their file snapshot across live restacks and reloads', async ({ page }) => {
  const data = fixture(); await mount(page, data); await openFile(page);
  await page.locator('.cinema-diff .lact').first().click();
  await page.locator('.nc-opt').filter({ hasText: 'Feedback' }).click();
  const editor = page.locator('textarea[name="nc-body"]'); await editor.fill('Check this line');
  await saveAction(page, () => editor.press('Control+Enter'), state => state.comments?.[0]?.snapshot?.fileRevision === 'rev');
  data.stages[0].baseRevision = 'c'.repeat(40); data.stages[0].headRevision = 'd'.repeat(40); data.viewerRevision = 'restacked';
  await expect(page.locator('.review-update')).toHaveText('Review updated');
  await showNotes(page);
  await expect(page.locator('.side.notes .tthread-stale')).toHaveCount(0);
  await reload(page); await showNotes(page);
  await expect(page.locator('.side.notes .tthread-stale')).toHaveCount(0);
  await expect(page.locator('.side.notes [data-action="jump-to"][data-kind="line"]')).toHaveCount(1);
  const request = page.waitForRequest(r => new URL(r.url()).pathname === '/api/feedback/export');
  await page.getByRole('button', { name: /Prepare feedback/ }).click();
  expect((await request).postDataJSON().notes[0].snapshot.fileRevision).toBe('rev');
});

for (const changed of [false, true]) test(`existing line drafts resolve their original file snapshot (${changed ? 'changed' : 'unchanged'})`, async ({ page }) => {
  const data = fixture();
  const note = { kind: 'line', id: 'l:first:new:1:shared.js', nodeId: 'first-one', body: 'Existing draft', mode: 'feedback', createdAt: 1,
    snapshot: { base: 'c'.repeat(40), head: 'd'.repeat(40) } };
  await mount(page, data, { comments: [note] });
  await page.route('**/api/draft-snapshots*', route => route.fulfill({ json: { ok: true, snapshots: [{ ...note.snapshot, fileRevision: changed ? 'old-content' : 'rev' }] } }));
  await reload(page); await showNotes(page);
  await expect(page.locator('.side.notes .tthread-stale')).toHaveCount(changed ? 1 : 0);
  await expect(page.locator(`.side.notes [data-action="jump-to"][data-kind="${changed ? 'file' : 'line'}"]`)).toHaveCount(1);
  if (changed) {
    await page.route('**/api/feedback/export*', route => route.fulfill({ status: 422, json: { ok: false, error: 'No notes could be exported.', skipped: [{ ref: 0, reason: 'The file changed since this line draft was written.' }] } }));
    await page.getByRole('button', { name: /Prepare feedback/ }).click();
    await expect(page.locator('.side.notes')).toContainText('No notes could be exported.');
    await expect(page.locator('.side.notes')).toContainText('The file changed since this line draft was written.');
    await expect(page.locator('.side.notes .tnote')).toContainText('Existing draft');
  }
});

const noEditor = { replyTo: null, replyDraft: '', replyEditId: null, replyAttachments: [] };

test('line drafts saved with a null file revision resolve their snapshot and keep their text', async ({ page }) => {
  const snapshot = { base: 'c'.repeat(40), head: 'd'.repeat(40), fileRevision: null };
  const note = { kind: 'line', id: 'l:first:new:1:shared.js', nodeId: 'first-one', body: 'Existing draft', mode: 'feedback', createdAt: 1, snapshot };
  const compose = { kind: 'line', id: 'l:first:new:3:shared.js', nodeId: 'first-two', editIndex: null, mode: 'feedback', body: 'Unsaved draft', dirty: true, snapshot };
  await mount(page, fixture(), { comments: [note], editor: { ...noEditor, compose } });
  const resolved = [];
  await page.route('**/api/draft-snapshots*', (route) => {
    const { notes } = route.request().postDataJSON();
    resolved.push(notes.map((item) => item.body));
    return route.fulfill({ json: { ok: true, snapshots: notes.map((item) => ({ ...item.snapshot, fileRevision: 'rev' })) } });
  });
  await reload(page);
  await expect.poll(() => resolved).toEqual([['Existing draft', 'Unsaved draft']]);
  let stored;
  await saveAction(page, () => showNotes(page), (state) => { stored = state; return state.notesOpen === true; });
  expect(stored.comments).toEqual([{ ...note, snapshot: { ...snapshot, fileRevision: 'rev' } }]);
  expect(stored.editor.compose).toMatchObject({ body: 'Unsaved draft', snapshot: { ...snapshot, fileRevision: 'rev' } });
  await expect(page.locator('.side.notes .tthread-stale')).toHaveCount(0);
  await expect(page.locator('.side.notes [data-action="jump-to"][data-kind="line"]')).toHaveCount(1);
});

test('a recovered note edit saves into its own note when an earlier saved note cannot be shown', async ({ page }) => {
  // The first viewer saved notes on "steps", which the page no longer shows.
  const step = { kind: 'step', id: 'first-one', body: 'Step note', mode: 'personal', resolved: false };
  const second = { kind: 'stage', id: 'first', body: 'Second note', mode: 'personal', createdAt: 2 };
  const third = { kind: 'stage', id: 'second', body: 'Third note', mode: 'personal', createdAt: 3 };
  const compose = { kind: 'stage', id: 'first', editIndex: 1, mode: 'personal', body: 'Second note, revised', dirty: true };
  const errors = await mount(page, fixture(), { comments: [step, second, third], notesOpen: true, editor: { ...noEditor, compose } });
  const panel = page.locator('.side.notes');
  await expect(panel.locator('.tnote')).toHaveText([/Third note/]);
  await expect(panel).not.toContainText('Step note');
  const editor = panel.locator('textarea[name="nc-body"]');
  await expect(editor).toHaveValue('Second note, revised');
  let stored;
  await saveAction(page, () => editor.press('Control+Enter'), (state) => { stored = state; return state.editor?.compose === null; });
  expect(stored.comments).toEqual([step, { ...second, body: 'Second note, revised', attachments: [] }, third]);
  await expect(panel.locator('.tnote')).toHaveText([/Second note, revised/, /Third note/]);
  expect(errors).toEqual([]);
});

test('reply drafts saved before attachments existed stay listed', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('t')];
  const errors = await mount(page, data, { replyDrafts: [{ id: 'rd-1', threadId: 't', body: 'Reply from an older viewer', createdAt: 2 }] });
  await showNotes(page);
  await expect(page.locator('.side.notes [data-thread-id="t"] .tmsg-draft')).toContainText('Reply from an older viewer');
  expect(errors).toEqual([]);
});

test('interactive review shows agent presence, round progress, unread replies, and agent questions', async ({ page }) => {
  const now = new Date().toISOString();
  const comment = (id, author, body, extra = {}) => ({ id, author, body, attachments: [], createdAt: '2026-10-08T10:00:00Z', ...extra });
  const stageTarget = { kind: 'stage', stageId: 'first', label: 'Stage first' };
  const data = { ...fixture(), feedback: [
    { id: 'answered', status: 'open', target: stageTarget, comments: [comment('u1', 'user', 'Why?'), comment('a1', 'agent', 'Because.')] },
  ], agent: { session: true, listening: true, stopRequested: false, working: null, requests: [], lastRound: { id: 'r0', completedAt: now, threadIds: ['answered'] }, serverTime: now } };
  await mount(page, data);
  await expect(page.locator('.agent-pill.is-listening')).toHaveText('Agent listening');
  await expect(page.locator('[data-action="stop-agent"]')).toBeVisible();
  await showNotes(page);
  await expect(page.locator('.side.notes .tthread[data-thread-id="answered"] .tthread-agent')).toHaveText('Answered');
  await expect(page.locator('.tmsg.is-unread')).toHaveCount(0);

  data.feedback.push({ id: 'pending', status: 'open', target: stageTarget, comments: [comment('u2', 'user', 'Rename this.')] });
  data.agent = { ...data.agent, working: { startedAt: now, threads: [{ id: 'pending', answered: false }] } };
  data.viewerRevision = 'working';
  await expect(page.locator('.agent-bar.is-working')).toContainText('Agent working on 1 thread');
  await expect(page.locator('.side.notes .tthread[data-thread-id="pending"] .tthread-agent')).toHaveText('Agent working');

  data.feedback[1].comments.push(comment('u3', 'user', 'Also add a test.'));
  data.feedback[1].comments.push(comment('a2', 'agent', 'Renamed it.', { respondsTo: 'u2', createdAt: '2026-10-08T10:05:00Z' }));
  data.agent = { ...data.agent, working: null, lastRound: { id: 'r1', completedAt: now, threadIds: ['pending'] } };
  data.viewerRevision = 'answered';
  await expect(page.locator('.agent-round')).toContainText('Agent replied to 1 thread');
  await expect(page.locator('.side.notes .tthread[data-thread-id="pending"] .tthread-agent')).toHaveText('Queued');
  expect(await page.title()).toMatch(/^\(1\)/);
  await page.locator('[data-action="show-unread"]').click();
  await expect(page.locator('.agent-round')).toHaveCount(0);
  await expect(page.locator('.tmsg.is-unread')).toHaveCount(0, { timeout: 8000 });
  expect(await page.title()).not.toMatch(/^\(/);

  data.agent = { ...data.agent, requests: [{ id: 'refund-email', body: 'Should refunds skip the email?', choices: ['Yes', 'No'], createdAt: now }] };
  data.viewerRevision = 'question';
  await expect(page.locator('.agent-question')).toContainText('Should refunds skip the email?');
  const overlay = await page.locator('.agent-questions').boundingBox(), layoutWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(overlay.width).toBeGreaterThan(600);
  expect(Math.abs(overlay.x + overlay.width / 2 - layoutWidth / 2)).toBeLessThan(2);
  await page.locator('[data-action="minimize-agent-questions"]').click();
  await expect(page.locator('.agent-question')).toHaveCount(0);
  await expect(page.locator('[data-action="show-agent-questions"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-action="minimize-agent-questions"]')).toBeFocused();
  await page.locator('[data-action="minimize-agent-questions"]').click();
  data.agent = { ...data.agent, requests: [...data.agent.requests, { id: 'refund-note', body: 'Note the refund on the order?', choices: [], createdAt: now }] };
  data.viewerRevision = 'second-question';
  await expect(page.locator('.agent-question')).toHaveCount(2);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.locator('[data-action="minimize-agent-questions"]').click();
  const shown = await page.locator('[data-action="show-agent-questions"]').boundingBox();
  expect(shown.x).toBeGreaterThanOrEqual(0);
  expect(shown.x + shown.width).toBeLessThanOrEqual(320);
  await page.locator('[data-action="show-agent-questions"]').click();
  await page.setViewportSize({ width: 1280, height: 720 });
  data.agent = { ...data.agent, requests: data.agent.requests.filter((request) => request.id === 'refund-email') };
  data.viewerRevision = 'question';
  await expect(page.locator('.agent-question')).toHaveCount(1);
  await page.locator('.agent-question [data-action="agent-choice"]', { hasText: 'Yes' }).click();
  await expect(page.locator('.agent-question')).toHaveCount(0);
  expect(data.answers).toEqual([{ requestId: 'refund-email', body: 'Yes' }]);

  await page.locator('.side.notes [data-action="toggle-notes"]').click();
  await page.locator('[data-action="stop-agent"]').click();
  await expect(page.locator('.agent-pill.is-stopping')).toBeVisible();
  data.agent = { ...data.agent, session: false, listening: false, stopRequested: false };
  data.viewerRevision = 'offline';
  await expect(page.locator('.agent-bar.is-offline')).toContainText('1 thread waiting for an agent');
  await expect(page.locator('.agent-bar.is-offline code')).toHaveText('/semantic-flow review -i');
  await expect(page.locator('.agent-pill.is-offline')).toHaveText('No agent listening');
});

test('interactive reviews can send feedback notes and replies automatically when saved', async ({ page }) => {
  const now = new Date().toISOString();
  const data = { ...fixture(), feedback: [thread('existing')],
    agent: { session: false, listening: false, stopRequested: false, working: null, requests: [], lastRound: null, serverTime: now } };
  const olderDraft = { kind: 'stage', id: 'first', stageId: 'first', body: 'Older draft', mode: 'feedback', createdAt: 1 };
  await mount(page, data, { comments: [olderDraft] });
  const exports = [];
  let hold = null;
  await page.route('**/api/feedback/export*', async (route) => {
    const input = route.request().postDataJSON(); exports.push(input);
    if (hold) await hold;
    return route.fulfill({ json: { ok: true, skipped: [],
      exported: input.notes.map((note) => ({ ref: note.ref, threadId: `thread-${note.ref}` })),
      replied: input.replies.map((reply) => ({ ref: reply.ref, threadId: reply.threadId, comment: { id: `c-${reply.ref}`, author: 'user', body: reply.body, createdAt: now } })) } });
  });
  await showNotes(page);
  const autoSend = page.getByRole('checkbox', { name: 'Send automatically' });
  await expect(autoSend).toHaveCount(0);

  data.agent = { ...data.agent, session: true, listening: true }; data.viewerRevision = 'listening';
  await expect(autoSend).toBeVisible();
  await expect(autoSend).not.toBeChecked();
  await autoSend.check();
  await expect(page.locator('.notes-export-hint')).toContainText('go to the listening agent when you save them');

  let release; hold = new Promise((resolve) => { release = resolve; });
  await page.locator('.side.notes [data-action="thread-reply"]').click();
  await page.locator('textarea[name="reply-body"]').fill('Please also cover the edge case.');
  await page.getByRole('button', { name: 'Save reply', exact: true }).click();
  await expect.poll(() => exports.length).toBe(1);
  const sending = page.locator('.side.notes .tmsg-draft[data-reply-id]');
  await expect(sending.locator('.tmsg-draft-tag')).toHaveText('Sending…');
  await expect(sending.locator('[data-action="reply-edit"]')).toHaveCount(0);
  release(); hold = null;
  await expect(sending).toHaveCount(0);
  expect(exports[0].replies.map((reply) => reply.body)).toEqual(['Please also cover the edge case.']);
  expect(exports[0].notes).toEqual([]);
  await expect(page.getByRole('button', { name: /Prepare feedback/ })).toHaveText('Prepare feedback (1)');

  await page.locator('.side.notes [data-action="toggle-notes"]').click();
  await openFile(page); await page.locator('.file-notes .thread-add').click();
  await page.locator('.nc-opt').filter({ hasText: 'Personal' }).click();
  await page.locator('textarea[name="nc-body"]').fill('Just for me');
  await page.locator('textarea[name="nc-body"]').press('Control+Enter');
  await page.locator('.file-notes .thread-add').click();
  await page.locator('.nc-opt').filter({ hasText: 'Feedback' }).click();
  await page.locator('textarea[name="nc-body"]').fill('Rename this file');
  await page.locator('textarea[name="nc-body"]').press('Control+Enter');
  await expect.poll(() => exports.length).toBe(2);
  expect(exports[1].notes.map((note) => note.body)).toEqual(['Rename this file']);
  await expect(page.locator('.notes-export-msg')).toContainText('Sent 1 feedback thread.');

  await reload(page); await showNotes(page);
  await expect(page.getByRole('checkbox', { name: 'Send automatically' })).toBeChecked();
  await expect(page.getByRole('button', { name: /Prepare feedback/ })).toHaveText('Prepare feedback (1)');
  const other = await page.context().newPage();
  await mount(other, data); await showNotes(other);
  await other.getByRole('checkbox', { name: 'Send automatically' }).uncheck();
  await expect(page.getByRole('checkbox', { name: 'Send automatically' })).not.toBeChecked();
  await other.close();
  data.agent = { ...data.agent, session: false, listening: false }; data.viewerRevision = 'offline';
  await expect(page.getByRole('checkbox', { name: 'Send automatically' })).toHaveCount(0);
  expect(exports).toHaveLength(2);
});

test('showing an answered round opens the active thread, not a resolved one with an unread reply', async ({ page }) => {
  const now = new Date().toISOString();
  const comment = (id, author, body, createdAt = '2026-10-08T10:00:00Z') => ({ id, author, body, attachments: [], createdAt });
  const target = { kind: 'stage', stageId: 'first', label: 'Stage first' };
  const listening = { session: true, listening: true, stopRequested: false, working: null, requests: [], lastRound: null, serverTime: now };
  const data = { ...fixture(), feedback: [
    { id: 'done', status: 'open', target, comments: [comment('u1', 'user', 'Drop this?')] },
    { id: 'pending', status: 'open', target, comments: [comment('u1', 'user', 'Rename this.')] },
  ], agent: listening };
  const baseline = page.waitForResponse(async (response) => new URL(response.url()).pathname === '/api/review-state' &&
    response.request().method() === 'POST' && (await response.json()).state?.repliesSeenThrough === '');
  await mount(page, data);
  await baseline;
  await expect(page.locator('.agent-pill.is-listening')).toBeVisible();
  await page.evaluate(() => {
    window.notices = [];
    window.Notification = class { static permission = 'granted'; constructor(title) { this.title = title; window.notices.push(this); } close() {} };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  });

  data.feedback[0].status = 'resolved';
  data.feedback[0].comments.push(comment('a1', 'agent', 'Dropped it.', '2026-10-08T10:05:00Z'));
  data.feedback[1].comments.push(comment('a1', 'agent', 'Renamed it.', '2026-10-08T10:05:00Z'));
  data.agent = { ...listening, lastRound: { id: 'r1', completedAt: now, threadIds: ['done', 'pending'] } };
  data.viewerRevision = 'answered';
  await expect.poll(() => page.evaluate(() => window.notices.length), { timeout: 8000 }).toBe(1);
  await page.evaluate(() => { delete document.hidden; window.notices[0].onclick(); });
  const active = page.locator('.side.notes [data-action="notes-filter"][data-filter="active"]');
  await expect(active).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.side.notes .tthread[data-thread-id="pending"]')).toBeVisible();

  await page.locator('.side.notes [data-action="notes-filter"][data-filter="resolved"]').click();
  data.feedback[1].comments.push(comment('u2', 'user', 'And the test?', '2026-10-08T10:06:00Z'), comment('a2', 'agent', 'Added.', '2026-10-08T10:07:00Z'));
  data.agent = { ...listening, lastRound: { id: 'r2', completedAt: now, threadIds: ['done', 'pending'] } };
  data.viewerRevision = 'answered-again';
  await page.locator('[data-action="show-unread"]').click();
  await expect(active).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.side.notes .tthread[data-thread-id="pending"]')).toBeVisible();
});

test('a hidden tab keeps checking slowly while an agent listens', async ({ page }) => {
  const now = new Date().toISOString();
  const listening = { session: true, listening: true, stopRequested: false, working: null, requests: [], lastRound: null, serverTime: now };
  await mount(page, { ...fixture(), agent: listening });
  await expect(page.locator('.agent-pill.is-listening')).toBeVisible();
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  let polls = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/revision') polls++; });
  await page.waitForTimeout(6500);
  expect(polls).toBeGreaterThanOrEqual(1);
  expect(polls).toBeLessThanOrEqual(2);
});

test('unread replies persist from an empty start, are tracked per thread, and long replies can be read', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 600 });
  const comment = (id, author, body, createdAt = '2026-10-08T10:00:00Z') => ({ id, author, body, attachments: [], createdAt });
  const target = { kind: 'stage', stageId: 'first', label: 'Stage first' };
  const data = { ...fixture(), feedback: [
    { id: 'one', status: 'open', target, comments: [comment('u1', 'user', 'First?')] },
    { id: 'two', status: 'open', target, comments: [comment('u1', 'user', 'Second?')] },
  ] };
  const baseline = page.waitForResponse(async (response) => new URL(response.url()).pathname === '/api/review-state' &&
    response.request().method() === 'POST' && (await response.json()).state?.repliesSeenThrough === '');
  await mount(page, data);
  await baseline;

  data.feedback[0].comments.push(comment('answer', 'agent', Array.from({ length: 80 }, (_, i) => `Line ${i + 1}`).join('\n'), '2026-10-08T10:05:00Z'));
  data.feedback[1].comments.push(comment('answer', 'agent', 'Short answer.', '2026-10-08T10:05:00Z'));
  data.viewerRevision = 'replied';
  await expect.poll(() => page.title()).toMatch(/^\(2\)/);
  await showNotes(page);
  await page.locator('.side.notes [data-reply-key=\'["one","answer"]\']').evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await expect.poll(() => page.title(), { timeout: 8000 }).toMatch(/^\(1\)/);
  await expect(page.locator('.side.notes [data-reply-key=\'["two","answer"]\']')).toHaveClass(/is-unread/);
});

test('coverage, progress and the scrim follow approvals under a policy that blocks style attributes', async ({ page }) => {
  await page.addInitScript(() => {
    window.styleViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => window.styleViolations.push(event.effectiveDirective));
  });
  await mount(page, fixture(), {}, [], { csp: "style-src-attr 'none'" });
  const share = (bar) => bar.evaluate((el) => Math.round(el.getBoundingClientRect().width / el.parentElement.getBoundingClientRect().width * 100));
  const toggle = page.locator('.tb-btn[data-action="toggle-coverage"]'), panel = page.locator('.side.coverage'), scrim = page.locator('.scrim');
  await expect(panel).toHaveAttribute('aria-hidden', 'true');
  await expect(panel).toHaveAttribute('inert', '');
  await expect(scrim).not.toHaveClass(/is-on/);
  expect(await share(page.locator('.progressbar span'))).toBe(0);

  await page.locator('.stage-title[data-id="first"]').click();
  const one = page.locator('details[data-node="first-one"]');
  await one.locator('summary').click();
  await saveAction(page, () => one.locator('.mini-approve').click(), (state) => !!state.approvals?.[approvalKey('first', 'first-one')]);
  await expect(toggle).toContainText('2/10');
  await expect.poll(() => share(page.locator('.progressbar span'))).toBe(20);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveClass(/is-on/);
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
  await expect(panel).not.toHaveAttribute('inert');
  await expect(scrim).toHaveClass(/is-on/);
  await expect(panel.locator('.cov-score')).toContainText('20%2 of 10 approved');
  await expect.poll(() => share(panel.locator('.mini-bar i'))).toBe(20);
  const [first, second] = [panel.locator('.cov-stage').nth(0), panel.locator('.cov-stage').nth(1)];
  await expect(first).toContainText('Stage approval pending · 1/2 steps · 1/2 file reviews');
  await expect(first.locator('.cov-h span')).toHaveText('01');
  await expect(first.locator('.cov-bar').first()).toHaveAttribute('data-tooltip', '1/2 steps');
  await expect.poll(() => share(first.locator('.cov-bar i').first())).toBe(50);
  await expect.poll(() => share(first.locator('.cov-bar.files i'))).toBe(50);
  await expect.poll(() => share(second.locator('.cov-bar.files i'))).toBe(0);

  await scrim.click({ position: { x: 10, y: 300 } });
  await expect(panel).toHaveAttribute('aria-hidden', 'true');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(scrim).not.toHaveClass(/is-on/);
  expect(await page.evaluate(() => window.styleViolations)).toEqual([]);
});

test('stored agent questions with malformed bodies or choices do not stop page updates', async ({ page }) => {
  const now = new Date().toISOString();
  const data = { ...fixture(), agent: { session: true, listening: true, stopRequested: false, working: null, lastRound: null, serverTime: now,
    requests: [{ id: 'q1', choices: [], createdAt: now }, { id: 'q2', body: { toString: null }, choices: [{ nodeType: 1 }, 'Keep'], createdAt: now },
      { id: 'q2', body: 'Duplicate', choices: ['Other'], createdAt: now }, null],
    working: { startedAt: now, note: { toString: null }, threads: null },
    lastRound: { id: 'round-1', completedAt: now },
    targetRefresh: { at: now, targetBranch: { nodeType: 1 }, previousBaseRevision: 1, baseRevision: 2 } } };
  await mount(page, data);
  await expect(page.locator('.agent-question')).toHaveCount(2);
  await expect(page.locator('[data-action="agent-choice"]')).toHaveText(['Keep']);
  await expect(page.locator('.agent-bar.is-refreshed')).toHaveCount(0);
  await page.locator('.tb-btn[data-action="toggle-coverage"]').click();
  await expect(page.locator('.side.coverage')).toHaveClass(/is-open/);
});

test('agent questions keep the draft, focus and caret across live updates and show their text literally', async ({ page }) => {
  const now = new Date().toISOString();
  const data = { ...fixture(), agent: { session: true, listening: true, stopRequested: false, working: null, lastRound: null, serverTime: now,
    requests: [{ id: 'q1', body: 'Use `<b>bold</b>` or <i>this</i>?\r\nSecond line', choices: ['<b>Yes</b>'], createdAt: now }] } };
  await mount(page, data);
  const first = page.locator('.agent-question').first();
  await expect(first.locator('.comment-body code')).toHaveText('<b>bold</b>');
  // toHaveText normalises whitespace; the line break must survive exactly.
  await expect(first.locator('.comment-body')).toHaveJSProperty('textContent', 'Use <b>bold</b> or <i>this</i>?\nSecond line');
  await expect(first.locator('.comment-body b, .comment-body i')).toHaveCount(0);
  await expect(first.locator('[data-action="agent-choice"]')).toHaveText('<b>Yes</b>');

  const answer = page.locator('textarea[name="agent-answer-q1"]');
  await answer.fill('Draft answer');
  await answer.evaluate((el) => { el.setSelectionRange(2, 5); el.dataset.marker = 'kept'; });
  data.agent = { ...data.agent, working: { startedAt: now, threads: [] },
    requests: [...data.agent.requests, { id: 'q2', body: 'Another question?', choices: [], createdAt: now }] };
  data.viewerRevision = 'second-question';
  await expect(page.locator('.agent-question')).toHaveCount(2);
  await expect(page.locator('.agent-questions-h')).toContainText('The agent needs your answer (2)');
  await expect(page.locator('.agent-bar.is-working')).toBeVisible();
  await expect(answer).toHaveValue('Draft answer');
  await expect(answer).toBeFocused();
  await expect(answer).toHaveAttribute('data-marker', 'kept');
  expect(await answer.evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([2, 5]);

  // Swapping the questions moves the focused answer; it keeps its focus and a backward selection.
  await answer.evaluate((el) => el.setSelectionRange(1, 4, 'backward'));
  data.agent = { ...data.agent, requests: [...data.agent.requests].reverse() };
  data.viewerRevision = 'swapped-questions';
  await expect(page.locator('.agent-question').first().locator('textarea')).toHaveAttribute('name', 'agent-answer-q2');
  await expect(answer).toHaveAttribute('data-marker', 'kept');
  await expect(answer).toBeFocused();
  expect(await answer.evaluate((el) => [el.selectionStart, el.selectionEnd, el.selectionDirection])).toEqual([1, 4, 'backward']);

  await page.locator('[data-action="minimize-agent-questions"]').click();
  await expect(page.locator('.agent-question')).toHaveCount(0);
  await page.locator('[data-action="show-agent-questions"]').click();
  await expect(answer).toHaveValue('Draft answer');
});

test('steps keep their disclosure, focus and open diff across live updates that add and reorder steps', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const data = fixture();
  const errors = await mount(page, data, { openStages: { first: true } });
  await openFile(page, 'first-one');
  const stage = page.locator('.stage[data-stage="first"]');
  const one = page.locator('details[data-node="first-one"]');
  const two = page.locator('details[data-node="first-two"]');
  const settled = (details) => expect.poll(() => details.evaluate((el) => el.dataset.animating ?? null)).toBeNull();
  await settled(one);
  await expect(two).toHaveJSProperty('open', false);
  await page.evaluate(() => { window.retained = [...document.querySelectorAll('.stage, details.node, .cinema-diff, .diff-grid')]; });
  await two.locator('summary').focus();
  // A new step arrives before the existing ones while another is renamed.
  data.stages[0].nodes.unshift({ id: 'first-zero', title: 'Step zero', description: 'A new step' });
  data.stages[0].nodes[1].title = 'Step one, renamed';
  data.viewerRevision = 'reordered';
  await expect(one.locator('h3')).toHaveText('Step one, renamed');
  await expect(stage.locator('details.node')).toHaveCount(3);
  await expect(stage.locator('details.node').first()).toHaveAttribute('data-node', 'first-zero');
  await expect(page.locator('details[data-node="first-zero"]')).toHaveJSProperty('open', false);
  await expect(one).toHaveJSProperty('open', true);
  await expect(two).toHaveJSProperty('open', false);
  await expect(one.locator('.node-ix')).toHaveText('1.2');
  await expect(two.locator('summary')).toBeFocused();
  await expect(one.locator('.cinema-diff')).toBeVisible();
  await expect(one.locator('.frow')).toHaveClass(/is-open/);
  expect(await page.evaluate(() => window.retained.every((el) => el.isConnected))).toBe(true);

  // Opening and closing animate, and the result survives the next update.
  expect(await two.locator('summary').evaluate((summary) => { summary.click(); return summary.parentElement.getAnimations().filter((animation) => animation.constructor === Animation).length; })).toBe(1);
  await expect(two).toHaveJSProperty('open', true);
  await settled(two);
  expect(await one.locator('summary').evaluate((summary) => { summary.click(); return summary.parentElement.getAnimations().filter((animation) => animation.constructor === Animation).length; })).toBe(1);
  await settled(one);
  await expect(one).toHaveJSProperty('open', false);
  data.stages[0].nodes[2].title = 'Step two, renamed';
  data.viewerRevision = 'toggled';
  await expect(two.locator('h3')).toHaveText('Step two, renamed');
  await expect(one).toHaveJSProperty('open', false);
  await expect(two).toHaveJSProperty('open', true);
  await expect(one.locator('.cinema-diff')).toHaveCount(1);

  // Closing the stage keeps its steps' disclosures for when it opens again.
  await page.locator('.stage-title[data-id="first"]').click();
  await expect(stage).not.toHaveClass(/is-open/);
  await expect(stage.locator('.stage-body')).toHaveAttribute('inert', '');
  for (const toggle of await stage.locator('[data-action="toggle-stage"]').all()) await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  data.title = 'Review fixes, updated';
  data.viewerRevision = 'collapsed';
  await expect(page.locator('.hero h1')).toHaveText('Review fixes, updated');
  await saveAction(page, () => page.locator('.stop[data-id="first"]').click(), (state) => state.openStages?.first === true);
  await expect(stage).toHaveClass(/is-open/);
  await expect(stage.locator('.stage-body')).not.toHaveAttribute('inert');
  for (const toggle of await stage.locator('[data-action="toggle-stage"]').all()) await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(two).toHaveJSProperty('open', true);
  await expect(one).toHaveJSProperty('open', false);
  expect(errors).toEqual([]);
});

test('the page keeps its scroll position across live updates that grow, reorder and open content', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 600 });
  const data = fixture(); data.feedback = [thread('t1')];
  const errors = await mount(page, data, { openStages: { first: true, second: true } });
  for (const node of ['first-one', 'first-two', 'second-one', 'second-two']) await page.locator(`details[data-node="${node}"] summary`).click();
  await page.locator('details[data-node="second-one"] .frow-open').click();
  await expect(page.locator('details[data-node="second-one"] .cinema-diff')).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 900); });
  const scrollY = () => page.evaluate(() => window.scrollY);
  await expect.poll(scrollY).toBe(900);
  // A new step and a longer summary above the view, then stages and steps in a new order.
  data.stages[0].nodes.unshift({ id: 'first-zero', title: 'Step zero', description: 'A new step. '.repeat(30) });
  data.stages[0].summary = 'A much longer summary. '.repeat(40);
  data.viewerRevision = 'grown';
  await expect(page.locator('details[data-node="first-zero"]')).toHaveCount(1);
  expect(await scrollY()).toBe(900);
  data.stages.reverse(); data.stages[0].nodes.reverse(); data.viewerRevision = 'reordered';
  await expect(page.locator('.stage').first()).toHaveAttribute('data-stage', 'second');
  await expect(page.locator('.stage[data-stage="second"] details.node').first()).toHaveAttribute('data-node', 'second-two');
  expect(await scrollY()).toBe(900);
  // Local renders: the notes panel and coverage open and close.
  for (const action of ['toggle-notes', 'toggle-notes', 'toggle-coverage', 'toggle-coverage']) {
    const toggle = page.locator(`.tb-btn[data-action="${action}"]`), expanded = await toggle.getAttribute('aria-expanded');
    await toggle.evaluate((el) => el.click());
    await expect(toggle).not.toHaveAttribute('aria-expanded', expanded);
    expect(await scrollY()).toBe(900);
  }
  expect(errors).toEqual([]);
});

test('an open file shows its diff and notes after its own row and keeps them across updates', async ({ page }) => {
  const data = fixture();
  const errors = await mount(page, data, { openStages: { first: true } });
  await openFile(page, 'first-one');
  const one = page.locator('details[data-node="first-one"]');
  const two = page.locator('details[data-node="first-two"]');
  expect(await one.locator('.frow-wrap').evaluate((wrap) => [...wrap.children].map((el) => el.classList[0]))).toEqual(['frow', 'cinema-diff']);
  await expect(one.locator('.frow-wrap')).toHaveClass(/is-open-wrap/);
  await expect(one.locator('.cinema-diff > .file-notes')).toHaveCount(1);
  await expect(two.locator('.cinema-diff')).toHaveCount(0);
  // A shared file opens in the step it was clicked from, and only there.
  await two.locator('summary').click();
  await expect(two.locator('.frow-open')).toHaveAttribute('data-node-id', 'first-two');
  await two.locator('.frow-open').click();
  await expect(two.locator('.cinema-diff')).toBeVisible();
  await expect(one.locator('.cinema-diff')).toHaveCount(0);
  await expect(one.locator('.frow')).not.toHaveClass(/is-open|is-active/);
  await expect(two.locator('.frow')).toHaveClass(/is-open/);
  await expect(two.locator('.frow')).toHaveClass(/is-active/);
  await two.locator('.file-notes .thread-add').click();
  const editor = two.locator('.file-notes textarea[name="nc-body"]');
  await editor.fill('A draft beside the diff');
  await page.evaluate(() => { window.grid = document.querySelector('.cinema-diff .diff-grid'); });
  data.stages[0].nodes[1].title = 'Step two, renamed';
  data.viewerRevision = 'renamed';
  await expect(two.locator('h3')).toHaveText('Step two, renamed');
  expect(await page.evaluate(() => window.grid.isConnected && window.grid === document.querySelector('.cinema-diff .diff-grid'))).toBe(true);
  await expect(editor).toHaveValue('A draft beside the diff');
  await expect(editor).toBeFocused();
  await page.locator('.note-compose [data-action="compose-cancel"]').click();
  await two.locator('.frow-open').click();
  await expect(two.locator('.cinema-diff')).toHaveCount(0);
  await expect(two.locator('.frow')).not.toHaveClass(/is-open|is-active/);
  await expect(two.locator('.frow-wrap')).not.toHaveClass(/is-open-wrap/);
  expect(errors).toEqual([]);
});

test('artifact text stays text in the header, specifications, stages, steps, insights and file groups', async ({ page }) => {
  const evil = '"><img src=x onerror="window.injected=1"><b>bold</b>\r';
  const data = fixture();
  data.title = `Title ${evil}`;
  data.summary = `Summary ${evil}`;
  data.requirements = [{ id: 'story', title: `Spec ${evil}`, summary: `Spec summary ${evil}`,
    source: { kind: 'url', reference: `Ref ${evil}`, url: 'javascript:window.injected=1' }, acceptance: [{ id: 'ac-1', text: `Criterion ${evil}` }] }];
  const [first, second] = data.stages;
  Object.assign(first, { title: `Stage ${evil}`, summary: `Stage summary ${evil}`, rationale: `Why ${evil}`, specificationRefs: ['story#ac-1'] });
  second.dependsOn = ['first', `missing ${evil}`];
  Object.assign(first.nodes[0], { title: `Step ${evil}`, description: `Description ${evil}` });
  first.files[0].project = `Project ${evil}`;
  first.insights = [{ id: 'decision-1', collection: 'insights', type: 'decision', title: `Insight ${evil}`, body: `Body ${evil}`, meta: `Meta ${evil}`, nodeRefs: ['first-one'] }];
  const errors = await mount(page, data, { openStages: { first: true, second: true } });
  await page.locator('.specification summary').click();
  const one = page.locator('details[data-node="first-one"]');
  await one.locator('summary').click();
  const normalized = (text) => text.replace(/\s+/g, ' ').trim();
  await expect(page.locator('.hero h1')).toHaveText(normalized(`Title ${evil}`));
  await expect(page.locator('.hero-sum')).toHaveText(normalized(`Summary ${evil}`));
  await expect(page.locator('.specification h2')).toHaveText(normalized(`Spec ${evil}`));
  await expect(page.locator('.req-src-ref')).toHaveText(normalized(`Ref ${evil}`));
  await expect(page.locator('a.req-src-ref, a[href^="javascript"]')).toHaveCount(0);
  await expect(page.locator('.ac-text')).toHaveText(normalized(`Criterion ${evil}`));
  await expect(page.locator('.stage[data-stage="first"] .stage-title h2')).toHaveText(normalized(`Stage ${evil}`));
  await expect(page.locator('.stage[data-stage="first"] .stage-sum')).toHaveText(normalized(`Stage summary ${evil}`));
  await expect(page.locator('.stage[data-stage="first"] .rationale-label')).toHaveAttribute('data-tooltip', `Why ${evil}`);
  await expect(page.locator('.stage[data-stage="first"] .ac-chip')).toHaveAttribute('data-title', `Criterion ${evil}`);
  await expect(page.locator('.stage[data-stage="second"] .dep-chip')).toHaveText(['01', normalized(`missing ${evil}`)]);
  await expect(one.locator('h3')).toHaveText(normalized(`Step ${evil}`));
  await expect(one.locator('.node-head p')).toHaveText(normalized(`Description ${evil}`));
  await expect(one.locator('.tag-gist')).toHaveText(normalized(`Insight ${evil}`));
  await expect(one.locator('.tag-face')).toHaveAttribute('data-body', `Body ${evil}`);
  await expect(one.locator('.tag-face')).toHaveAttribute('data-meta', `Meta ${evil}`);
  await expect(one.locator('.insight-review')).toHaveAccessibleName(normalized(`Reviewed: Insight ${evil}`));
  await expect(one.locator('.fg-name')).toHaveText(normalized(`Project ${evil}`));
  await expect(one.locator('.fg-approve')).toHaveAttribute('data-group', `Project ${evil}`);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.locator('#app b', { hasText: 'bold' })).toHaveCount(0);
  await saveAction(page, () => one.locator('.fg-approve').click(), (state) => !!state.approvals?.[approvalKey('first', 'first-one')]);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  expect(errors).toEqual([]);
});

test('note controls keep their order and tooltips follow approval changes', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('stage-thread'), thread('node-thread', 'open', { kind: 'node', stageId: 'first', nodeId: 'first-one', label: 'Step one' })];
  const errors = await mount(page, data, { openStages: { first: true } });
  const stage = page.locator('.stage[data-stage="first"]');
  const one = page.locator('details[data-node="first-one"]');
  const two = page.locator('details[data-node="first-two"]');
  // The stage's notes toggle comes before adding a note, and both before its approval.
  expect(await stage.locator('.stage-approve').evaluate((el) => [...el.querySelectorAll('.notes-toggle, .comment, .approve')].map((child) => child.classList[0]))).toEqual(['notes-toggle', 'comment', 'approve']);
  // A step offers adding a note before its notes toggle.
  expect(await one.locator('.node-foot .note-cluster').evaluate((el) => [...el.children].map((child) => child.classList[0]))).toEqual(['comment', 'notes-toggle']);
  const stageApproval = stage.locator('.stage-approve .approve');
  await expect(stageApproval).toHaveAttribute('data-tooltip', 'Approve every step before approving the stage');
  await one.locator('summary').click();
  await two.locator('summary').click();
  for (const details of [one, two]) await saveAction(page, () => details.locator('.mini-approve').click(), (state) => !!state.approvals?.[approvalKey('first', details === one ? 'first-one' : 'first-two')]);
  await expect(stageApproval).toBeEnabled();
  await expect(stageApproval).not.toHaveAttribute('data-tooltip');
  await expect(one.locator('summary')).not.toHaveAttribute('data-tooltip');
  // The file changes, so the step's approval turns stale and says so.
  data.stages[0].files[0].revision = 'changed-revision';
  data.viewerRevision = 'changed-file';
  await expect(one).toHaveClass(/is-stale/);
  await expect(one.locator('summary')).toHaveAttribute('data-tooltip', 'One or more file approvals are stale');
  await expect(one.locator('.node-check')).toHaveAttribute('data-tooltip', 'One or more file approvals are stale');
  await expect(stageApproval).toHaveAttribute('data-tooltip', 'Approve every step before approving the stage');
  await one.locator('summary').hover();
  await expect(page.locator('[role="tooltip"]')).toContainText('One or more file approvals are stale');
  await saveAction(page, () => one.locator('.mini-approve').click(), (state) => state.approvals?.[approvalKey('first', 'first-one')]?.rev?.includes('changed-revision'));
  await expect(one).not.toHaveClass(/is-stale/);
  await expect(one.locator('summary')).not.toHaveAttribute('data-tooltip');
  await expect(one.locator('.node-check')).not.toHaveAttribute('data-tooltip');
  await expect(page.locator('#app [title]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a specification toggled without animation keeps its state across reloads', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const data = fixture();
  data.requirements = [{ id: 'story', title: 'Spec', summary: 'Spec summary', acceptance: [{ id: 'ac-1', text: 'Criterion' }] }];
  const errors = await mount(page, data);
  const spec = page.locator('details.specification');
  await expect(spec).toHaveJSProperty('open', false);
  await saveAction(page, () => spec.locator('summary h2').click(), (state) => state.specificationOpen?.story === true);
  await expect(spec).toHaveJSProperty('open', true);
  await reload(page);
  await expect(spec).toHaveJSProperty('open', true);
  await saveAction(page, () => spec.locator('summary h2').click(), (state) => state.specificationOpen?.story === false);
  await expect(spec).toHaveJSProperty('open', false);
  await reload(page);
  await expect(spec).toHaveJSProperty('open', false);
  expect(errors).toEqual([]);
});

for (const name of ['constructor', 'toString']) {
  test(`a specification named ${name} starts closed, opens from a link and never breaks saving`, async ({ page }) => {
    const data = fixture();
    data.requirements = [{ id: name, title: 'Spec', summary: 'Spec summary', acceptance: [{ id: 'ac-1', text: 'Criterion' }] }];
    data.feedback = [thread('about-spec', 'open', { kind: 'specification', specificationId: name, label: 'Spec' })];
    const changes = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/review-state' && request.method() === 'POST') changes.push(...request.postDataJSON().changes);
    });
    const errors = await mount(page, data, { openStages: { first: true } });
    const spec = page.locator('details.specification');
    await expect(spec).toHaveJSProperty('open', false);
    await spec.locator('summary h2').click();
    await expect(spec).toHaveJSProperty('open', true);
    await spec.locator('summary h2').click();
    await expect(spec).toHaveJSProperty('open', false);
    // Jumping from a thread to its specification opens it.
    await showNotes(page);
    await page.locator('.side.notes [data-thread-id="about-spec"] .tthread-jump').click();
    await expect(spec).toHaveJSProperty('open', true);
    const one = page.locator('details[data-node="first-one"]');
    await one.locator('summary').click();
    await saveAction(page, () => one.locator('.frow .mini-approve').click(), (state) => !!state.approvals?.[approvalKey('first', 'first-one', 'shared.js')] &&
      Object.hasOwn(state.specificationOpen, name) && state.specificationOpen[name] === true);
    // The open state is saved under the specification's own key, which is never claimed to exist before it was saved.
    const specChanges = changes.filter((change) => change.path[0] === 'specificationOpen' && change.path[1] === name);
    expect(specChanges.length).toBeGreaterThan(0);
    expect(specChanges[0].before).toEqual({ present: false });
    await reload(page);
    await expect(spec).toHaveJSProperty('open', true);
    expect(errors).toEqual([]);
  });
}

test('approvals and open states of stages and specifications named __proto__, constructor and prototype survive a reload', async ({ page }) => {
  const names = ['__proto__', 'constructor', 'prototype'];
  const data = fixture();
  const [template] = data.stages;
  data.stages = names.map((id) => ({ ...structuredClone(template), id, title: `Stage ${id}`,
    nodes: ['one', 'two'].map((n) => ({ id: `${id}-${n}`, title: `Step ${n}`, description: 'Node description' })),
    files: [{ ...structuredClone(template.files[0]), memberships: [{ nodeId: `${id}-one`, classification: 'behavior', hunks: [1] }, { nodeId: `${id}-two`, classification: 'behavior', hunks: [2] }] }] }));
  data.requirements = names.map((id) => ({ id, title: `Spec ${id}`, summary: 'Spec summary', acceptance: [{ id: 'ac-1', text: 'Criterion' }] }));
  const errors = await mount(page, data);
  const saved = (map, key) => Boolean(map) && Object.hasOwn(map, key) ? map[key] : undefined;
  for (const name of names) {
    const stage = page.locator(`.stage[data-stage="${name}"]`);
    await saveAction(page, () => page.locator(`.stage-title[data-id="${name}"]`).click(), (state) => saved(state.openStages, name) === true);
    for (const node of [`${name}-one`, `${name}-two`]) {
      const details = page.locator(`details[data-node="${node}"]`);
      await details.locator('summary').click();
      await saveAction(page, () => details.locator('.mini-approve').click(), (state) => !!saved(state.approvals, approvalKey(name, node)));
    }
    await saveAction(page, () => stage.locator('.stage-approve .approve').click(), (state) => !!saved(state.approvals, name));
    const spec = page.locator(`details.specification[data-req-id="${name}"]`);
    await saveAction(page, () => spec.locator('summary h2').click(), (state) => saved(state.specificationOpen, name) === true);
  }
  await reload(page);
  for (const name of names) {
    const stage = page.locator(`.stage[data-stage="${name}"]`);
    await expect(stage).toHaveClass(/is-open/);
    await expect(stage.locator('.stage-approve .approve')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`details.specification[data-req-id="${name}"]`)).toHaveJSProperty('open', true);
  }
  expect(await page.evaluate(() => [{}.rev, {}.at, Object.prototype.polluted])).toEqual([undefined, undefined, undefined]);
  expect(errors).toEqual([]);
});

test('a kept file row drops the tooltip of a hint that is no longer rendered', async ({ page }) => {
  const data = fixture();
  const errors = await mount(page, data, { openStages: { first: true } });
  const one = page.locator('details[data-node="first-one"]');
  await one.locator('summary').click();
  const row = one.locator('.frow-open');
  await expect(one.locator('.cls-shared')).toHaveCount(1);
  await expect(row).toHaveAttribute('data-tooltip', /Split across steps/);
  await row.evaluate((el) => { window.keptRow = el; });
  // The file leaves the other step, so it is no longer shared.
  data.stages[0].files[0].memberships.pop();
  data.viewerRevision = 'unshared';
  await expect(one.locator('.cls-shared')).toHaveCount(0);
  expect(await row.evaluate((el) => el === window.keptRow)).toBe(true);
  await expect(row).toHaveAttribute('data-tooltip', 'Modified');
  expect(errors).toEqual([]);
});

test('a focused file button whose file moves to another group never moves focus to another file', async ({ page }) => {
  const data = fixture();
  data.stages[0].files[0].project = 'web';
  data.stages[0].files.push({ path: 'other.js', project: 'web', kind: 'added', revision: 'other-rev', additions: 1, deletions: 0,
    memberships: [{ nodeId: 'first-one', classification: 'behavior' }, { nodeId: 'first-two', classification: 'behavior' }],
    lines: [{ t: 'add', n: 1, s: 'const other = 1;' }] });
  const errors = await mount(page, data, { openStages: { first: true } });
  const one = page.locator('details[data-node="first-one"]');
  await one.locator('summary').click();
  const search = (path) => one.locator(`.file-occurrences[data-path="${path}"]`);
  await expect(search('shared.js')).toHaveCount(1);
  await search('other.js').focus();
  data.stages[0].files[1].project = 'zeta';
  data.viewerRevision = 'moved-group';
  await expect(one.locator('.fg-name')).toHaveText(['web', 'zeta']);
  await expect(search('shared.js')).not.toBeFocused();
  await expect(search('other.js')).toBeFocused();
  expect(errors).toEqual([]);
});

async function markDraft(input, start, end, direction) {
  await input.focus();
  await input.evaluate((el, [start, end, direction]) => { el.setSelectionRange(start, end, direction); el.dataset.marker = 'kept'; }, [start, end, direction]);
}
async function expectDraftKept(input, value, start, end, direction) {
  await expect(input).toHaveValue(value);
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('data-marker', 'kept');
  expect(await input.evaluate((el) => [el.selectionStart, el.selectionEnd, el.selectionDirection])).toEqual([start, end, direction]);
}

test('reply and note drafts keep their text, caret, selection and focus across agent replies and new threads', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('first-thread'), thread('second-thread')];
  const errors = await mount(page, data, { openThreads: { first: true } });
  const stage = page.locator('.stage[data-stage="first"]');
  await stage.locator('[data-thread-id="second-thread"] [data-action="thread-reply"]').click();
  const reply = stage.locator('textarea[name="reply-body"]');
  await expect(reply).toBeFocused();
  await reply.fill('A reply in progress');
  await markDraft(reply, 2, 7, 'backward');
  // An agent reply, and a new thread before the one being answered.
  data.feedback[1].comments.push({ author: 'agent', body: 'Agent answer', createdAt: '2026-09-08T10:01:00Z' });
  data.feedback.unshift(thread('new-thread'));
  data.viewerRevision = 'agent-replied';
  await expect(stage.locator('[data-thread-id="second-thread"]')).toContainText('Agent answer');
  await expect(stage.locator('.thread > .tthread')).toHaveCount(3);
  await expectDraftKept(reply, 'A reply in progress', 2, 7, 'backward');
  await expect(stage.locator('[data-thread-id="second-thread"] [data-action="thread-reply"]')).toHaveCount(0);
  await reply.press('Control+Enter');
  const draft = stage.locator('[data-thread-id="second-thread"] .tmsg-draft');
  await expect(draft).toContainText('A reply in progress');
  await expect(draft.locator('.tmsg-draft-tag')).toHaveText('Draft');
  await draft.locator('[data-action="reply-edit"]').click();
  await expect(reply).toHaveValue('A reply in progress');
  await expect(reply).toBeFocused();
  await expect(stage.locator('form.tthread-reply .nc-save')).toHaveText('Update reply');
  await stage.locator('[data-action="reply-cancel"]').click();

  // A new note keeps its draft when a thread appears on the same stage.
  await stage.locator('.thread .thread-add').click();
  const note = stage.locator('textarea[name="nc-body"]');
  await expect(note).toBeFocused();
  await stage.locator('.nc-opt').filter({ hasText: 'Feedback' }).click();
  await expect(stage.locator('.note-compose')).toHaveClass(/mode-feedback/);
  await note.fill('A note in progress');
  await markDraft(note, 4, 9, 'forward');
  data.feedback.push(thread('later-thread'));
  data.viewerRevision = 'thread-added';
  await expect(stage.locator('.thread > .tthread')).toHaveCount(4);
  await expectDraftKept(note, 'A note in progress', 4, 9, 'forward');
  await expect(page.locator('input[name="nc-mode"][value="feedback"]')).toBeChecked();
  await note.press('Control+Enter');
  await expect(stage.locator('.tnote')).toContainText('A note in progress');
  await expect(stage.locator('.tnote .tnote-state')).toHaveText('Draft');
  expect(errors).toEqual([]);
});

// The ranges the viewer highlights as other occurrences of the selected code.
const selectionHits = (page) => page.evaluate(() => [...(CSS.highlights.get('sel-hit') || [])].map((range) => ({
  text: (() => { const live = document.createRange(); live.setStart(range.startContainer, range.startOffset); live.setEnd(range.endContainer, range.endOffset); return String(live); })(),
  line: range.startContainer.parentElement.closest('[data-line-id]')?.dataset.lineId ?? null,
  code: Boolean(range.startContainer.parentElement.closest('.drow > code')),
  connected: range.startContainer.isConnected,
})));

test('line threads in a diff keep drafts across live updates and refresh beside a code selection', async ({ page }) => {
  const data = fixture();
  data.stages[0].files[0].lines[1].s = '// first context';
  const lineId = 'l:first:new:1:shared.js';
  // A second occurrence of the selected word in code, beside the one in the thread.
  data.stages[0].files[0].lines[1].s = '// first context';
  data.feedback = [thread('line', 'open', { kind: 'line', stageId: 'first', nodeId: 'first-one', path: 'shared.js', side: 'new', line: 1, label: 'shared.js:1' })];
  const errors = await mount(page, data, { openStages: { first: true }, activeFiles: { [fileId]: 'first-one' }, openLineThreads: { [lineId]: true } });
  await openFile(page);
  const lineThread = page.locator(`.line-thread[data-thread="${lineId}"]`);
  await expect(lineThread.locator('.tthread')).toContainText('Feedback line');
  await lineThread.evaluate((el) => { el.dataset.marker = 'kept'; });
  await lineThread.locator('.thread-add').click();
  const input = lineThread.locator('textarea[name="nc-body"]');
  await expect(input).toBeFocused();
  await input.fill('A line note in progress');
  await markDraft(input, 3, 8, 'backward');
  data.feedback[0].comments.push({ author: 'agent', body: 'Fixed the first constant', createdAt: '2026-09-08T10:01:00Z' });
  data.viewerRevision = 'line-reply';
  await expect(lineThread.locator('.tthread')).toContainText('Fixed the first constant');
  await expectDraftKept(input, 'A line note in progress', 3, 8, 'backward');
  await expect(lineThread).toHaveAttribute('data-marker', 'kept');

  // Selecting code marks its other occurrences in the code only; a live update
  // then refreshes the line thread without disturbing the selection.
  await input.evaluate((el) => el.blur());
  await page.locator(`[data-line-id="${lineId}"] code`).evaluate((code) => {
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (!text.textContent.includes('first')) text = walker.nextNode();
    const start = text.textContent.indexOf('first');
    const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + 'first'.length);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    code.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  // The other occurrence in code is highlighted; the line thread's text is not.
  const expected = [{ text: 'first', line: 'l:first:new:2:shared.js', code: true, connected: true }];
  await expect.poll(() => selectionHits(page)).toEqual(expected);
  await expect(lineThread).toContainText('Fixed the first constant');
  data.feedback[0].comments.push({ author: 'agent', body: 'Second agent reply', createdAt: '2026-09-08T10:02:00Z' });
  data.viewerRevision = 'second-line-reply';
  await expect(lineThread.locator('.tthread')).toContainText('Second agent reply');
  expect(await page.evaluate(() => String(window.getSelection()))).toBe('first');
  expect(await selectionHits(page)).toEqual(expected);
  await expect(page.locator('mark')).toHaveCount(0);
  await expect(input).toHaveValue('A line note in progress');
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await input.press('Control+Enter');
  await expect(lineThread.locator('.tnote')).toContainText('A line note in progress');
  await expect(page.locator(`.lact[data-id="${lineId}"]`)).toHaveClass(/has-note/);
  expect(errors).toEqual([]);
});

test('thread headers describe their state in tooltips that follow it, and comment bodies stay literal', async ({ page }) => {
  const data = fixture();
  data.feedback = [{ id: 'literal', status: 'open', target: { kind: 'file', stageId: 'first', nodeId: 'first-one', path: 'shared.js', label: 'shared.js' },
    comments: [{ author: 'user', body: 'Use `<b>x</b>` here\r\nand <i>there</i>', createdAt: '2026-09-08T10:00:00Z' }] }];
  const errors = await mount(page, data);
  await showNotes(page);
  const header = page.locator('.notes-col-active [data-thread-id="literal"] .tthread-h');
  await expect(header).toHaveAttribute('data-tooltip', 'Collapse thread · File · open · Show what this thread is about');
  const body = page.locator('.notes-col-active [data-thread-id="literal"] .comment-body');
  await expect(body.locator('code')).toHaveText('<b>x</b>');
  await expect(body).toHaveJSProperty('textContent', 'Use <b>x</b> here\nand <i>there</i>');
  await expect(body.locator('b, i')).toHaveCount(0);
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(header).toHaveAttribute('data-tooltip', 'Expand thread · File · open · Show what this thread is about');
  await header.press('Enter');
  await expect(header).toHaveAttribute('data-tooltip', /^Collapse thread/);
  await page.locator('.notes-col-active [data-action="thread-resolve"]').click();
  await page.locator('.notes-switch-btn[data-filter="resolved"]').click();
  const resolved = page.locator('.notes-col-resolved [data-thread-id="literal"] .tthread-h');
  await expect(resolved).toHaveAttribute('data-tooltip', 'Expand thread · File · resolved · Show what this thread is about');
  await expect(resolved.locator('.tthread-status-ic')).toHaveAttribute('aria-label', 'resolved');
  await expect(page.locator('#app [title]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('jumping from the notes panel finds a step thread in its own stage when step IDs repeat', async ({ page }) => {
  const data = fixture();
  for (const stage of data.stages) stage.nodes[0].id = 'same-node';
  data.feedback = [thread('second-step', 'open', { kind: 'node', stageId: 'second', nodeId: 'same-node', label: 'Second step' })];
  const errors = await mount(page, data);
  await showNotes(page);
  const jump = page.locator('.side.notes [data-thread-id="second-step"] [data-action="jump-to"]');
  await expect(jump).toHaveAttribute('data-stage', 'second');
  await jump.click();
  await expect(page.locator('.stage[data-stage="second"] details[data-node="same-node"]')).toHaveJSProperty('open', true);
  await expect(page.locator('.stage[data-stage="second"] details[data-node="same-node"] .thread [data-thread-id="second-step"]')).toBeVisible();
  await expect(page.locator('.stage[data-stage="first"] details[data-node="same-node"]')).toHaveJSProperty('open', false);
  expect(errors).toEqual([]);
});

test('preparing feedback reports failures, skipped replies and the sent result in the notes panel', async ({ page }) => {
  const errors = await mount(page, fixture(), {
    comments: [{ kind: 'stage', id: 'first', body: 'Send this', mode: 'feedback', createdAt: 1 }],
    replyDrafts: [{ id: 'rd-gone', threadId: 'gone', body: 'Reply to a removed thread', attachments: [], createdAt: 2 }],
  });
  await showNotes(page);
  const prepare = page.locator('.notes-export');
  await expect(prepare).toHaveText('Prepare feedback (2)');
  await expect(page.locator('.notes-export-hint')).toContainText('sent to the semantic-flow artifact');
  await page.route('**/api/feedback/export*', (route) => route.fulfill({ status: 500, json: { ok: false, error: 'The artifact is <locked>' } }));
  await prepare.click();
  await expect(page.locator('.notes-export-msg')).toHaveClass(/is-error/);
  await expect(page.locator('.notes-export-msg')).toHaveText('The artifact is <locked>');
  await expect(page.locator('.notes-export-skips li')).toHaveText(['reply — thread no longer exists']);
  await expect(prepare).toHaveText('Prepare feedback (2)');
  await page.unroute('**/api/feedback/export*');
  await prepare.click();
  await expect(page.locator('.notes-export-msg')).toHaveClass(/is-done/);
  await expect(page.locator('.notes-export-msg')).toContainText('Sent 1 feedback thread, 1 skipped.');
  await expect(prepare).toHaveText('Prepare feedback (1)');
  await expect(page.locator('.side.notes .tnote .tnote-state')).toHaveText('Sent');
  expect(errors).toEqual([]);
});

test('a reply to the second evidence on a step keeps its editor when the first evidence gains a discussion', async ({ page }) => {
  const data = fixture();
  data.stages[0].insights.push(evidenceInsight({ attachments: [] }), { ...evidenceInsight({ attachments: [] }), id: 'shot-2', title: 'Second capture' });
  const target = (itemId) => ({ kind: 'insight', stageId: 'first', collection: 'evidence', itemId, label: 'Evidence' });
  data.feedback = [thread('on-second', 'open', target('shot-2'))];
  const errors = await mount(page, data, { openThreads: { 'i:first:evidence:shot': true, 'i:first:evidence:shot-2': true } });
  await openFile(page);
  const threads = page.locator('details[data-node="first-one"] .node-reasoning .thread');
  await expect(threads).toHaveCount(1);
  const second = threads.and(page.locator('[data-thread="i:first:evidence:shot-2"]'));
  await second.locator('[data-action="thread-reply"]').click();
  const reply = second.locator('textarea[name="reply-body"]');
  await expect(reply).toBeFocused();
  await reply.fill('About the second capture');
  await markDraft(reply, 3, 9, 'backward');
  data.feedback.unshift(thread('on-first', 'open', target('shot')));
  data.viewerRevision = 'first-evidence-discussed';
  await expect(threads).toHaveCount(2);
  await expect(threads.first()).toHaveAttribute('data-thread', 'i:first:evidence:shot');
  await expectDraftKept(reply, 'About the second capture', 3, 9, 'backward');
  expect(errors).toEqual([]);
});

test('a note edited in the notes panel keeps its editor when its stage moves', async ({ page }) => {
  const data = fixture();
  const errors = await mount(page, data, { comments: [
    { kind: 'stage', id: 'first', body: 'Other note', mode: 'personal', createdAt: 2 },
    { kind: 'stage', id: 'second', body: 'Saved note', mode: 'personal', createdAt: 1 },
  ] });
  await showNotes(page);
  const panel = page.locator('.side.notes');
  await expect(panel.locator('.note-stage-h')).toHaveText(['Stage first', 'Stage second']);
  await panel.locator('.tnote', { hasText: 'Saved note' }).locator('[data-action="edit-note"]').click();
  const editor = panel.locator('textarea[name="nc-body"]');
  await expect(editor).toBeFocused();
  await editor.fill('Saved note, revised');
  await markDraft(editor, 2, 8, 'backward');
  data.stages.reverse();
  data.viewerRevision = 'stages-reordered';
  await expect(page.locator('.stage').first()).toHaveAttribute('data-stage', 'second');
  // The edited note's group moves from last to first and keeps its editor.
  await expect(panel.locator('.note-stage-h')).toHaveText(['Stage second', 'Stage first']);
  await expectDraftKept(editor, 'Saved note, revised', 2, 8, 'backward');
  expect(errors).toEqual([]);
});

test('opening the notes panel from an agent notification keeps the reply being written', async ({ page }) => {
  const now = new Date().toISOString();
  const comment = (id, author, body, createdAt = '2026-10-08T10:00:00Z') => ({ id, author, body, attachments: [], createdAt });
  const target = { kind: 'stage', stageId: 'first', label: 'Stage first' };
  const listening = { session: true, listening: true, stopRequested: false, working: null, requests: [], lastRound: null, serverTime: now };
  const data = { ...fixture(), feedback: [{ id: 'pending', status: 'open', target, comments: [comment('u1', 'user', 'Rename this.')] }], agent: listening };
  const baseline = page.waitForResponse(async (response) => new URL(response.url()).pathname === '/api/review-state' &&
    response.request().method() === 'POST' && (await response.json()).state?.repliesSeenThrough === '');
  const errors = await mount(page, data, { openThreads: { first: true } });
  await baseline;
  const stage = page.locator('.stage[data-stage="first"]');
  await stage.locator('[data-thread-id="pending"] [data-action="thread-reply"]').click();
  const inline = stage.locator('textarea[name="reply-body"]');
  await expect(inline).toBeFocused();
  await inline.fill('A reply in progress');
  await inline.evaluate((el) => el.setSelectionRange(2, 7, 'backward'));
  await page.evaluate(() => {
    window.notices = [];
    window.Notification = class { static permission = 'granted'; constructor(title) { this.title = title; window.notices.push(this); } close() {} };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  });
  data.feedback[0].comments.push(comment('a1', 'agent', 'Renamed it.', '2026-10-08T10:05:00Z'));
  data.agent = { ...listening, lastRound: { id: 'r1', completedAt: now, threadIds: ['pending'] } };
  data.viewerRevision = 'answered';
  await expect.poll(() => page.evaluate(() => window.notices.length), { timeout: 8000 }).toBe(1);
  await expect(inline).toBeFocused();
  await page.evaluate(() => { delete document.hidden; window.notices[0].onclick(); });
  const reply = page.locator('.side.notes textarea[name="reply-body"]');
  await expect(reply).toHaveValue('A reply in progress');
  await expect(inline).toHaveCount(0);
  await expect(reply).toBeFocused();
  expect(await reply.evaluate((el) => [el.selectionStart, el.selectionEnd, el.selectionDirection])).toEqual([2, 7, 'backward']);
  // Focus the reviewer moves elsewhere stays there when the reply moves back.
  const toggle = page.locator('.tb-btn[data-action="toggle-notes"]');
  await toggle.focus();
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(inline).toHaveValue('A reply in progress');
  await expect(toggle).toBeFocused();
  expect(errors).toEqual([]);
});

test('an agent reply waits while a code selection runs through its line thread, then appears', async ({ page }) => {
  const data = fixture();
  const lineId = 'l:first:new:1:shared.js';
  data.feedback = [thread('line', 'open', { kind: 'line', stageId: 'first', nodeId: 'first-one', path: 'shared.js', side: 'new', line: 1, label: 'shared.js:1' })];
  const errors = await mount(page, data, { openStages: { first: true }, activeFiles: { [fileId]: 'first-one' }, openLineThreads: { [lineId]: true } });
  await openFile(page);
  await showNotes(page);
  const lineThread = page.locator(`.line-thread[data-thread="${lineId}"]`);
  const panelThread = page.locator('.side.notes [data-thread-id="line"]');
  await expect(lineThread.locator('.tthread')).toContainText('Feedback line');
  // Select from the first code row to the third, across the line thread between them.
  const selection = () => page.evaluate(() => String(window.getSelection()));
  await page.evaluate(() => {
    const code = (line) => document.querySelector(`[data-line-id="l:first:new:${line}:shared.js"] code`);
    const range = document.createRange();
    range.setStart(code(1), 0); range.setEnd(code(3), code(3).childNodes.length);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  });
  const selected = await selection();
  expect(selected).toContain('Feedback line');
  data.feedback[0].comments.push({ author: 'agent', body: 'Reply during the selection', createdAt: '2026-09-08T10:01:00Z' });
  data.viewerRevision = 'reply-during-selection';
  // The copy in the notes panel is outside the selection and updates at once.
  await expect(panelThread).toContainText('Reply during the selection');
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1500)));
  await expect(lineThread).not.toContainText('Reply during the selection');
  expect(await selection()).toBe(selected);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await expect(lineThread).toContainText('Reply during the selection');
  expect(errors).toEqual([]);
});

test('a thread title cut off in its header is named in full by the header tooltip', async ({ page }) => {
  const data = fixture();
  const label = 'A stage conversation whose title is far too long to fit in the header of the notes panel';
  data.feedback = [thread('long', 'open', { kind: 'stage', stageId: 'first', label }), thread('short', 'open', { kind: 'stage', stageId: 'first', label: 'Short' })];
  const errors = await mount(page, data);
  await showNotes(page);
  const title = (id) => page.locator(`.side.notes [data-thread-id="${id}"] .tthread-title`);
  expect(await title('long').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const tooltip = page.locator('#review-tooltip');
  await title('long').hover();
  await expect(tooltip).toHaveText(`Collapse thread · Stage · ${label} · open · Show what this thread is about`);
  await title('short').hover();
  await expect(tooltip).toHaveText('Collapse thread · Stage · open · Show what this thread is about');
  await expect(page.locator('#app [title]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('deleting a reply draft or a note never passes focus to another one\'s Delete', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('done-a', 'resolved'), thread('done-b', 'resolved'), thread('open-c')];
  const draft = (id, threadId) => ({ id, threadId, body: `Draft ${id}`, attachments: [], createdAt: 2 });
  const note = (body, createdAt) => ({ kind: 'stage', id: 'first', body, mode: 'personal', createdAt });
  const errors = await mount(page, data, {
    notesFilter: 'resolved', threadCollapsed: { 'done-a': false, 'done-b': false },
    replyDrafts: [draft('r-a', 'done-a'), draft('r-b', 'done-b'), draft('r-c', 'open-c')],
    comments: [note('First note', 1), note('Second note', 2), note('Third note', 3)],
  });
  await showNotes(page);
  const panel = page.locator('.side.notes');
  const focusedAction = () => page.evaluate(() => document.activeElement?.getAttribute('data-action') ?? null);
  // A second Enter must not reach another draft's Delete in the Resolved tab.
  const drafts = panel.locator('.notes-col-resolved .tmsg-draft');
  await expect(drafts).toHaveCount(2);
  await panel.locator('[data-reply-id="r-a"] [data-action="reply-del"]').press('Enter');
  await expect(drafts).toHaveCount(1);
  expect(await focusedAction()).toBeNull();
  await page.keyboard.press('Enter');
  await expect(drafts).toHaveAttribute('data-reply-id', 'r-b');
  // Deleting a note shifts the index of the notes after it; none of their controls takes focus.
  await panel.locator('[data-action="notes-filter"][data-filter="active"]').click();
  const notes = panel.locator('.notes-col-active .tnote');
  await expect(notes).toHaveCount(3);
  await notes.filter({ hasText: 'First note' }).locator('[data-action="del-note"]').press('Enter');
  await expect(notes).toHaveCount(2);
  expect(await focusedAction()).toBeNull();
  await page.keyboard.press('Enter');
  await expect(notes).toHaveCount(2);
  await expect(panel.locator('.notes-col-active .tmsg-draft')).toHaveAttribute('data-reply-id', 'r-c');
  expect(errors).toEqual([]);
});

// Selects from the first code row of the open diff to the third, across the line thread under the first.
async function selectAcrossLineThread(page) {
  await page.evaluate(() => {
    const code = (line) => document.querySelector(`[data-line-id="l:first:new:${line}:shared.js"] code`);
    const range = document.createRange();
    range.setStart(code(1), 0); range.setEnd(code(3), code(3).childNodes.length);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  });
  return page.evaluate(() => String(window.getSelection()));
}
const lineTarget = { kind: 'line', stageId: 'first', nodeId: 'first-one', path: 'shared.js', side: 'new', line: 1, label: 'shared.js:1' };

test('a line thread held by a code selection applies the reviewer\'s collapse and busy state at once', async ({ page }) => {
  const data = fixture();
  const lineId = 'l:first:new:1:shared.js';
  data.feedback = [thread('line', 'open', lineTarget)];
  const errors = await mount(page, data, { openStages: { first: true }, activeFiles: { [fileId]: 'first-one' }, openLineThreads: { [lineId]: true } });
  await openFile(page);
  await showNotes(page);
  const lineThread = page.locator(`.line-thread[data-thread="${lineId}"] .tthread`);
  await expect(lineThread).toContainText('Feedback line');
  const selected = await selectAcrossLineThread(page);
  data.feedback[0].comments.push({ author: 'agent', body: 'Reply during the selection', createdAt: '2026-09-08T10:01:00Z' });
  data.viewerRevision = 'reply-during-selection';
  await expect(page.locator('.side.notes [data-thread-id="line"]')).toContainText('Reply during the selection');
  await expect(lineThread).not.toContainText('Reply during the selection');
  // Collapsing from the keyboard applies while the selection still holds the thread.
  const header = lineThread.locator('.tthread-h');
  await header.focus();
  await header.press('Enter');
  await expect(lineThread).toHaveClass(/is-collapsed/);
  await header.press('Enter');
  await expect(lineThread).not.toHaveClass(/is-collapsed/);
  expect(await page.evaluate(() => String(window.getSelection()))).toBe(selected);
  // A resolve in progress disables its button, so a second Enter sends nothing.
  let requests = 0, release;
  const released = new Promise((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === '/api/feedback/resolve', async (route) => { requests += 1; await released; await route.fallback(); });
  const resolve = lineThread.locator('[data-action="thread-resolve"]');
  await resolve.focus();
  await resolve.press('Enter');
  await expect(resolve).toBeDisabled();
  await page.keyboard.press('Enter');
  await page.evaluate(() => new Promise((done) => setTimeout(done, 200)));
  expect(requests).toBe(1);
  release();
  await expect(page.locator('.side.notes .notes-col-resolved [data-thread-id="line"]')).toHaveCount(1);
  await expect(page.locator('.side.notes .notes-col-active [data-thread-id="line"]')).toHaveCount(0);
  expect(requests).toBe(1);
  expect(errors).toEqual([]);
});

test('a line thread a live update removes stays while a code selection holds it', async ({ page }) => {
  const data = fixture();
  const lineId = 'l:first:new:1:shared.js';
  data.feedback = [thread('line', 'open', lineTarget)];
  const errors = await mount(page, data, { openStages: { first: true }, activeFiles: { [fileId]: 'first-one' }, openLineThreads: { [lineId]: true } });
  await openFile(page);
  await showNotes(page);
  const lineThread = page.locator(`.line-thread[data-thread="${lineId}"]`);
  await expect(lineThread.locator('.tthread')).toContainText('Feedback line');
  await lineThread.evaluate((el) => { el.dataset.marker = 'kept'; });
  const selected = await selectAcrossLineThread(page);
  // The line's only thread is removed; another thread shows the update arrived.
  data.feedback = [thread('other')];
  data.viewerRevision = 'line-thread-removed';
  await expect(page.locator('.side.notes [data-thread-id="other"]')).toContainText('Feedback other');
  await expect(lineThread).toHaveAttribute('data-marker', 'kept');
  await expect(lineThread.locator('.tthread')).toContainText('Feedback line');
  expect(await page.evaluate(() => String(window.getSelection()))).toBe(selected);
  // Once the selection clears, the removed thread goes.
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await expect(lineThread).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a thread that leaves a selected list shows its updates where the selection does not reach', async ({ page }) => {
  const data = fixture();
  data.feedback = ['a', 'b', 'c'].map((id) => thread(id));
  const errors = await mount(page, data);
  await showNotes(page);
  const active = page.locator('.side.notes .notes-col-active');
  await expect(active.locator('.tthread')).toHaveCount(3);
  // Select from the first active thread's comment to the last one's.
  const selected = await page.evaluate(() => {
    const bodies = document.querySelectorAll('.side.notes .notes-col-active .tthread .comment-body');
    const range = document.createRange();
    range.setStart(bodies[0], 0); range.setEnd(bodies[bodies.length - 1], bodies[bodies.length - 1].childNodes.length);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    return String(window.getSelection());
  });
  expect(selected).toContain('Feedback b');
  // Resolved elsewhere, and answered.
  data.feedback[1].status = 'resolved';
  data.feedback[1].comments.push({ author: 'agent', body: 'Answered after resolving', createdAt: '2026-09-08T10:01:00Z' });
  data.viewerRevision = 'b-resolved';
  const resolved = page.locator('.side.notes .notes-col-resolved [data-thread-id="b"]');
  await expect(resolved).toContainText('Answered after resolving');
  await expect(resolved).toHaveClass(/status-resolved/);
  // The selected list still shows what was selected.
  await expect(active.locator('[data-thread-id="b"]')).toHaveClass(/status-open/);
  await expect(active.locator('[data-thread-id="b"]')).not.toContainText('Answered after resolving');
  expect(await page.evaluate(() => String(window.getSelection()))).toBe(selected);
  // A later update reaches the resolved copy as well.
  data.feedback[1].comments.push({ author: 'agent', body: 'A second answer', createdAt: '2026-09-08T10:02:00Z' });
  data.viewerRevision = 'b-answered-again';
  await expect(resolved).toContainText('A second answer');
  // The reviewer's own resolve applies to the held list at once.
  const resolveA = active.locator('[data-thread-id="a"] [data-action="thread-resolve"]');
  await resolveA.focus();
  await resolveA.press('Enter');
  await expect(active.locator('[data-thread-id="a"]')).toHaveCount(0);
  await expect(active.locator('[data-thread-id="b"]')).toHaveCount(1);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await expect(active.locator('[data-thread-id="b"]')).toHaveCount(0);
  await expect(active.locator('.tthread')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a code selection holds which threads a line thread shows until it leaves', async ({ page }) => {
  const data = fixture();
  const lineId = 'l:first:new:1:shared.js';
  data.feedback = [thread('line', 'open', lineTarget)];
  const errors = await mount(page, data, { openStages: { first: true }, activeFiles: { [fileId]: 'first-one' }, openLineThreads: { [lineId]: true } });
  await openFile(page);
  await showNotes(page);
  const threads = page.locator(`.line-thread[data-thread="${lineId}"] .tthread`);
  const panel = page.locator('.side.notes');
  await expect(threads).toHaveCount(1);
  const selected = await selectAcrossLineThread(page);
  expect(selected).toContain('Feedback line');
  // Another thread on the same line stays out of the selection.
  data.feedback.push(thread('line-two', 'open', lineTarget));
  data.viewerRevision = 'second-line-thread';
  await expect(panel.locator('[data-thread-id="line-two"]')).toHaveCount(1);
  await expect(threads).toHaveCount(1);
  expect(await page.evaluate(() => String(window.getSelection()))).toBe(selected);
  // The selected thread stays when the server removes it.
  data.feedback.shift();
  data.viewerRevision = 'first-line-thread-removed';
  await expect(panel.locator('[data-thread-id="line"]')).toHaveCount(0);
  await expect(threads).toHaveCount(1);
  await expect(threads).toHaveAttribute('data-thread-id', 'line');
  expect(await page.evaluate(() => String(window.getSelection()))).toBe(selected);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await expect(threads).toHaveCount(1);
  await expect(threads).toHaveAttribute('data-thread-id', 'line-two');
  expect(errors).toEqual([]);
});

// Selects from the start of the first element matching `from` to the end of the first matching `to`.
async function selectBetween(page, from, to) {
  return page.evaluate(([from, to]) => {
    const start = document.querySelector(from), end = document.querySelector(to);
    const range = document.createRange();
    range.setStart(start, 0); range.setEnd(end, end.childNodes.length);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    return String(window.getSelection());
  }, [from, to]);
}

test('a file opened under another step during a selection shows and resolves that step\'s threads', async ({ page }) => {
  const data = fixture();
  const fileTarget = (nodeId) => ({ kind: 'file', stageId: 'first', nodeId, path: 'shared.js', label: 'shared.js' });
  data.feedback = [thread('step-one', 'open', fileTarget('first-one')), thread('step-two', 'open', fileTarget('first-two'))];
  const errors = await mount(page, data, { openStages: { first: true }, activeFiles: { [fileId]: 'first-one' } });
  await openFile(page);
  const two = page.locator('details[data-node="first-two"]');
  if (!await two.evaluate((el) => el.open)) await two.locator('summary').click();
  await expect(page.locator('details[data-node="first-one"] .file-notes .tthread')).toHaveAttribute('data-thread-id', 'step-one');
  const selected = await selectBetween(page, 'details[data-node="first-one"] .file-notes .tthread .comment-body', 'details[data-node="first-two"] .frow-open');
  expect(selected).toContain('Feedback step-one');
  const open = two.locator('.frow-open');
  await open.focus();
  await open.press('Enter');
  await expect(two.locator('.cinema-diff')).toBeVisible();
  const threads = two.locator('.file-notes .tthread');
  await expect(threads).toHaveCount(1);
  await expect(threads).toHaveAttribute('data-thread-id', 'step-two');
  const resolved = [];
  await page.route((url) => url.pathname === '/api/feedback/resolve', (route) => { resolved.push(route.request().postDataJSON().threadId); return route.fallback(); });
  const resolve = threads.locator('[data-action="thread-resolve"]');
  await resolve.focus();
  await resolve.press('Enter');
  await expect.poll(() => resolved).toEqual(['step-two']);
  await expect(threads).toHaveClass(/status-resolved/);
  expect(data.feedback[0].status).toBe('open');
  expect(errors).toEqual([]);
});

test('a closed step reached by a selection shows its latest threads when opened', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('step-a', 'open', { kind: 'node', stageId: 'first', nodeId: 'first-one', label: 'Step one' }), thread('outside')];
  const errors = await mount(page, data, { openStages: { first: true } });
  const one = page.locator('details[data-node="first-one"]');
  // Show the step's threads, then close the step again.
  await one.locator(':scope > summary').click();
  await one.locator('.node-foot .notes-toggle').click();
  await expect(one.locator('[data-thread-id="step-a"]')).toBeVisible();
  await one.locator(':scope > summary').click();
  await expect(one).toHaveJSProperty('open', false);
  await expect(one.locator('[data-thread-id="step-a"]')).toHaveCount(1);
  await showNotes(page);
  // The selection runs across the closed step, from the step before it to the one after.
  const selected = await selectBetween(page, 'details[data-node="first-one"] > summary', 'details[data-node="first-two"] > summary');
  expect(selected).not.toContain('Feedback step-a');
  data.feedback[0].comments.push({ author: 'agent', body: 'Answered while closed', createdAt: '2026-09-08T10:01:00Z' });
  data.feedback[1].comments.push({ author: 'agent', body: 'Outside answered', createdAt: '2026-09-08T10:01:00Z' });
  data.viewerRevision = 'answered-while-closed';
  await expect(page.locator('.side.notes [data-thread-id="outside"]')).toContainText('Outside answered');
  const summary = one.locator(':scope > summary');
  await summary.focus();
  await summary.press('Enter');
  await expect(one).toHaveJSProperty('open', true);
  await expect(one.locator('[data-thread-id="step-a"]')).toContainText('Answered while closed');
  expect(errors).toEqual([]);
});

test('deleting a note never reuses its Delete for another note with the same time', async ({ page }) => {
  const data = fixture();
  const note = (body) => ({ kind: 'stage', id: 'first', body, mode: 'personal', createdAt: 5 });
  const errors = await mount(page, data, { comments: [note('First note'), note('Second note'), note('Third note')] });
  await showNotes(page);
  const notes = page.locator('.side.notes .notes-col-active .tnote');
  await expect(notes).toHaveCount(3);
  await notes.filter({ hasText: 'First note' }).locator('[data-action="del-note"]').press('Enter');
  await expect(notes).toHaveCount(2);
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-action') ?? null)).toBeNull();
  await page.keyboard.press('Enter');
  await page.evaluate(() => new Promise((done) => setTimeout(done, 100)));
  await expect(notes).toHaveCount(2);
  await expect(notes.filter({ hasText: 'Second note' })).toHaveCount(1);
  await expect(notes.filter({ hasText: 'Third note' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a thread resolved during a selection reaching the hidden Resolved tab moves there', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('a'), thread('b'), thread('done', 'resolved')];
  const errors = await mount(page, data);
  await showNotes(page);
  const panel = page.locator('.side.notes');
  const active = panel.locator('.notes-col-active');
  await expect(active.locator('.tthread')).toHaveCount(2);
  // From an Active comment through the footer, across the hidden Resolved column.
  const selected = await selectBetween(page, '.side.notes .notes-col-active .tthread .comment-body', '.side.notes .notes-foot');
  expect(selected).toContain('Feedback b');
  const resolveB = active.locator('[data-thread-id="b"] [data-action="thread-resolve"]');
  await resolveB.focus();
  await resolveB.press('Enter');
  await expect(active.locator('[data-thread-id="b"]')).toHaveCount(0);
  await expect(panel.locator('.notes-col-resolved [data-thread-id="b"]')).toHaveCount(1);
  const filter = panel.locator('[data-action="notes-filter"][data-filter="resolved"]');
  await filter.focus();
  await filter.press('Enter');
  await expect(panel.locator('.notes-col-resolved [data-thread-id="b"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the first collapse of a held thread applies to what the reviewer sees', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('a'), thread('b')];
  const errors = await mount(page, data);
  await showNotes(page);
  const active = page.locator('.side.notes .notes-col-active');
  await expect(active.locator('.tthread')).toHaveCount(2);
  const selected = await page.evaluate(() => {
    const bodies = document.querySelectorAll('.side.notes .notes-col-active .tthread .comment-body');
    const range = document.createRange();
    range.setStart(bodies[0], 0); range.setEnd(bodies[1], bodies[1].childNodes.length);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    return String(window.getSelection());
  });
  // Resolved elsewhere: the held copy stays open and expanded.
  data.feedback[1].status = 'resolved';
  data.viewerRevision = 'b-resolved';
  await expect(page.locator('.side.notes .notes-col-resolved [data-thread-id="b"]')).toHaveCount(1);
  const held = active.locator('[data-thread-id="b"]');
  await expect(held).toHaveClass(/status-open/);
  await expect(held).not.toHaveClass(/is-collapsed/);
  const header = held.locator('.tthread-h');
  await header.focus();
  await header.press('Enter');
  await expect(held).toHaveClass(/is-collapsed/);
  await header.press('Enter');
  await expect(held).not.toHaveClass(/is-collapsed/);
  expect(await page.evaluate(() => String(window.getSelection()))).toBe(selected);
  expect(errors).toEqual([]);
});

test('a tooltip stays open while a code selection defers a review update, which applies once it leaves', async ({ page }) => {
  const data = fixture();
  const lineId = 'l:first:new:1:shared.js';
  data.feedback = [thread('line', 'open', lineTarget)];
  const errors = await mount(page, data, { openStages: { first: true }, activeFiles: { [fileId]: 'first-one' }, openLineThreads: { [lineId]: true } });
  await openFile(page);
  await showNotes(page);
  const selected = await selectAcrossLineThread(page);
  // A comment from the reviewer's other session, so no unread reply is marked read meanwhile.
  data.feedback[0].comments.push({ author: 'user', body: 'Added during the selection', createdAt: '2026-09-08T10:01:00Z' });
  data.stages[1].title = 'Stage second, renamed';
  data.viewerRevision = 'reply-during-selection';
  await expect(page.locator('.side.notes [data-thread-id="line"]')).toContainText('Added during the selection');
  const tooltip = page.locator('#review-tooltip');
  await page.locator('.side.notes [data-thread-id="line"] .tthread-h').hover();
  await expect(tooltip).toHaveClass(/is-shown/);
  // Later polls see the same deferred revision and leave the page alone.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 2500)));
  await expect(tooltip).toHaveClass(/is-shown/);
  await expect(page.locator('#stage-title-second')).toHaveText('Stage second');
  expect(await page.evaluate(() => String(window.getSelection()))).toBe(selected);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await expect(page.locator('#stage-title-second')).toHaveText('Stage second, renamed');
  expect(errors).toEqual([]);
});

test('a sent note in a selected line thread stays until the selection leaves, then its thread replaces it', async ({ page }) => {
  const data = fixture();
  const lineId = 'l:first:new:1:shared.js';
  const errors = await mount(page, data, { openStages: { first: true }, activeFiles: { [fileId]: 'first-one' }, openLineThreads: { [lineId]: true },
    comments: [{ kind: 'line', id: lineId, nodeId: 'first-one', body: 'Sent line note', mode: 'feedback', exported: true, threadId: 'sent', createdAt: 1 }] });
  await openFile(page);
  await showNotes(page);
  const lineThread = page.locator(`.line-thread[data-thread="${lineId}"]`);
  const panel = page.locator('.side.notes');
  await expect(lineThread.locator('.tnote')).toContainText('Sent line note');
  const selected = await selectAcrossLineThread(page);
  expect(selected).toContain('Sent line note');
  data.feedback = [{ ...thread('sent', 'open', lineTarget), comments: [{ author: 'user', body: 'Sent line note', createdAt: '2026-09-08T10:00:00Z' }] }];
  data.viewerRevision = 'sent-thread-arrived';
  // Outside the selection the thread replaces the note.
  await expect(panel.locator('.tthread[data-thread-id="sent"]')).toHaveCount(1);
  await expect(panel.locator('.tnote')).toHaveCount(0);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1500)));
  await expect(lineThread.locator('.tnote')).toContainText('Sent line note');
  await expect(lineThread.locator('.tthread[data-thread-id="sent"]')).toHaveCount(0);
  expect(await page.evaluate(() => String(window.getSelection()))).toBe(selected);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await expect(lineThread.locator('.tthread[data-thread-id="sent"]')).toHaveCount(1);
  await expect(lineThread.locator('.tnote')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a reply sent while a selection holds an earlier copy of its thread shows once in every copy', async ({ page }) => {
  const data = fixture();
  const lineId = 'l:first:new:1:shared.js';
  data.feedback = [thread('line', 'open', lineTarget)];
  const errors = await mount(page, data, { openStages: { first: true }, activeFiles: { [fileId]: 'first-one' }, openLineThreads: { [lineId]: true },
    replyDrafts: [{ id: 'rd-1', threadId: 'line', body: 'My reply', attachments: [], createdAt: 2 }] });
  await openFile(page);
  await showNotes(page);
  const lineThread = page.locator(`.line-thread[data-thread="${lineId}"] .tthread`);
  const panelThread = page.locator('.side.notes [data-thread-id="line"]');
  await expect(lineThread.locator('.tmsg-draft')).toContainText('My reply');
  await selectAcrossLineThread(page);
  data.feedback[0].comments.push({ author: 'agent', body: 'Reply during the selection', createdAt: '2026-09-08T10:01:00Z' });
  data.viewerRevision = 'reply-during-selection';
  await expect(panelThread).toContainText('Reply during the selection');
  await expect(lineThread).not.toContainText('Reply during the selection');
  await page.route('**/api/feedback/export*', (route) => route.fulfill({ json: { ok: true, exported: [], skipped: [],
    replied: [{ ref: 'rd-1', threadId: 'line', comment: { id: 'c-2', author: 'user', body: 'My reply', createdAt: '2026-09-08T10:02:00Z' } }] } }));
  const prepare = page.locator('.notes-export');
  await prepare.focus();
  await prepare.press('Enter');
  await expect(page.locator('.notes-export-msg')).toContainText('Sent 1 reply');
  for (const copy of [lineThread, panelThread]) {
    await expect(copy.locator('.tmsg-draft')).toHaveCount(0);
    await expect(copy.locator('.tmsg', { hasText: 'My reply' })).toHaveCount(1);
  }
  await expect(lineThread).not.toContainText('Reply during the selection');
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await expect(lineThread).toContainText('Reply during the selection');
  await expect(lineThread.locator('.tmsg', { hasText: 'My reply' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('feedback restored to the adopted revision during a selection shows once the selection clears', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('kept'), thread('restored')];
  const errors = await mount(page, data, { openStages: { first: true }, activeFiles: { [fileId]: 'first-one' } });
  await openFile(page);
  await showNotes(page);
  const panel = page.locator('.side.notes');
  await expect(panel.locator('[data-thread-id="restored"]')).toHaveCount(1);
  await selectAcrossLineThread(page);
  const original = data.feedback;
  data.feedback = [original[0]];
  data.viewerRevision = 'without-restored';
  await expect(panel.locator('[data-thread-id="restored"]')).toHaveCount(0);
  // The server returns to the revision the page adopted in full before the selection.
  data.feedback = original;
  data.viewerRevision = 'initial';
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await expect(panel.locator('[data-thread-id="restored"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('feedback for restacked stages waits for a code selection to clear before it shows', async ({ page }) => {
  const data = fixture();
  const lineId = 'l:first:new:1:shared.js';
  const errors = await mount(page, data, { openStages: { first: true }, activeFiles: { [fileId]: 'first-one' }, openLineThreads: { [lineId]: true } });
  await openFile(page);
  await showNotes(page);
  const panel = page.locator('.side.notes');
  const selected = await selectAcrossLineThread(page);
  data.stages[0].headRevision = 'c'.repeat(40);
  data.feedback = [{ ...thread('restacked', 'open', lineTarget), comments: [{ author: 'agent', body: 'About the restacked line', createdAt: '2026-09-08T10:01:00Z' }] }];
  data.viewerRevision = 'restacked';
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 2500)));
  // The shown diff is from the earlier stage head, so the new line thread does not join it yet.
  await expect(panel.locator('[data-thread-id="restacked"]')).toHaveCount(0);
  await expect(page.locator('[data-thread-id="restacked"]')).toHaveCount(0);
  expect(await page.evaluate(() => String(window.getSelection()))).toBe(selected);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await expect(panel.locator('[data-thread-id="restacked"]')).toContainText('About the restacked line');
  await expect(page.locator(`.line-thread[data-thread="${lineId}"] [data-thread-id="restacked"]`)).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a reply a poll already loaded before its send response shows once', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('t')];
  const errors = await mount(page, data, { replyDrafts: [{ id: 'rd-1', threadId: 't', body: 'My reply', attachments: [], createdAt: 2 }] });
  await showNotes(page);
  const panelThread = page.locator('.side.notes [data-thread-id="t"]');
  await expect(panelThread.locator('.tmsg-draft')).toContainText('My reply');
  // An earlier send saved the reply, but its response was lost; a poll loads the saved comment.
  const saved = { id: 'c-2', author: 'user', body: 'My reply', createdAt: '2026-09-08T10:02:00Z' };
  data.feedback[0].comments.push(saved);
  data.viewerRevision = 'reply-saved';
  await expect(panelThread.locator('.tmsg:not(.tmsg-draft)', { hasText: 'My reply' })).toHaveCount(1);
  await expect(panelThread.locator('.tmsg-draft')).toHaveCount(1);
  // The retry returns the same comment.
  await page.route('**/api/feedback/export*', (route) => route.fulfill({ json: { ok: true, exported: [], skipped: [],
    replied: [{ ref: 'rd-1', threadId: 't', comment: saved }] } }));
  const prepare = page.locator('.notes-export');
  await prepare.focus();
  await prepare.press('Enter');
  await expect(page.locator('.notes-export-msg')).toContainText('Sent 1 reply');
  await expect(panelThread.locator('.tmsg-draft')).toHaveCount(0);
  await expect(panelThread.locator('.tmsg', { hasText: 'My reply' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a selection in the Active column does not bring back a sent note whose thread is resolved', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('other'), { ...thread('sent', 'resolved'), comments: [{ author: 'user', body: 'Sent stage note', createdAt: '2026-09-08T10:00:00Z' }] }];
  const errors = await mount(page, data, { comments: [{ kind: 'stage', id: 'first', body: 'Sent stage note', mode: 'feedback', exported: true, threadId: 'sent', createdAt: 1 }] });
  await showNotes(page);
  const panel = page.locator('.side.notes');
  const active = panel.locator('.notes-col-active');
  const activeFilter = panel.locator('[data-action="notes-filter"][data-filter="active"]');
  await expect(active.locator('.tthread')).toHaveCount(1);
  await expect(active.locator('.tnote')).toHaveCount(0);
  await expect(activeFilter.locator('b')).toHaveText('1');
  await selectBetween(page, '.side.notes .notes-col-active .tthread .comment-body', '.side.notes .notes-col-active .tthread .comment-body');
  // A review update renders the page while the Active column is held.
  data.feedback[0].comments.push({ author: 'agent', body: 'Reply during the selection', createdAt: '2026-09-08T10:01:00Z' });
  data.viewerRevision = 'reply-during-selection';
  await expect(page.locator('.review-update')).toHaveText('Review updated');
  await expect(active.locator('.tnote')).toHaveCount(0);
  await expect(activeFilter.locator('b')).toHaveText('1');
  expect(errors).toEqual([]);
});

// Artifact text that would run script or add markup if it were parsed as HTML.
const hostile = (label) => `${label} <img src=x onerror="window.injected='${label}'"><b>bold</b> &lt;i&gt; &amp;`;
// A file name cannot hold a slash.
const hostileName = (label) => `${label} "><img src=x onerror="window.injected='${label}'">&lt;i&gt; &amp;'.js`;

test('diff rows, ownership notices, inline insights and the diff toolbar keep hostile text literal', async ({ page }) => {
  const data = fixture();
  const path = `src/${hostileName('path')}`;
  const source = [`const a = "${hostile('string')}";\r`, `// ${hostile('comment')}`, `x < y && ${hostile('code')}`];
  for (const stage of data.stages) {
    const file = stage.files[0];
    file.path = path;
    file.lines.forEach((row, index) => { row.s = source[index]; });
  }
  data.stages[0].nodes[1].title = hostile('step');
  const insight = codeInsight();
  insight.title = hostile('insight');
  insight.codeTarget.path = path; insight.codeTarget.original.path = path;
  data.stages[0].insights.push(insight);
  const errors = await mount(page, data);
  await openFile(page);
  const panel = page.locator('details[data-node="first-one"] .cinema-diff');
  await expect(page.getByRole('region', { name: `Diff for ${path}`, exact: true })).toBeVisible();
  expect(await panel.locator('[data-line-id] > code').evaluateAll((codes) => codes.map((code) => code.textContent))).toEqual(source);
  await expect(panel.locator('[data-line-id] > code *:not(.tok-com, .tok-str, .tok-num, .tok-key)')).toHaveCount(0);
  await expect(panel.locator('.ownership-notice button')).toHaveText(hostile('step'));
  await expect(panel.locator('.ownership-notice button')).toHaveAttribute('data-node-id', 'first-two');
  await expect(panel.locator('.line-code-insights .inline-insight-text')).toHaveText(hostile('insight'));
  await expect(panel.locator('[data-line-id]').first()).toHaveAttribute('data-line-id', `l:first:new:1:${path}`);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.locator('b', { hasText: 'bold' })).toHaveCount(0);
  await panel.locator('.lact').first().click();
  await expect(panel.locator('.line-thread')).toHaveAttribute('data-thread', `l:first:new:1:${path}`);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  expect(errors).toEqual([]);
});

test('Markdown preview validates link and image targets and keeps its content across renders', async ({ page }) => {
  const data = fixture(); data.stages[0].files[0].path = 'docs/README.md';
  const errors = await mount(page, data);
  const content = [
    '[External](https://example.com/page) [Mail](mailto:team@example.com) [Relative](guide.md#usage)',
    '[Protocol relative](//evil.example/x) [Script](javascript:alert(1)) [Data](data:text/html,<script>alert(1)</script>) [Up](../../../../etc/passwd)',
    '![Remote](https://example.com/i.png) ![Inline](data:image/png;base64,AAAA) ![Local](./i.png)',
  ].join('\n\n');
  await page.route('**/api/file-content*', (route) => route.fulfill({ json: { ok: true, content, revision: 'b'.repeat(40), side: 'head' } }));
  await openFile(page);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.locator('.markdown-preview');
  const link = (name) => preview.getByText(name, { exact: true });
  await expect(link('External')).toHaveAttribute('href', 'https://example.com/page');
  await expect(link('External')).toHaveAttribute('target', '_blank');
  await expect(link('External')).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link('Mail')).toHaveAttribute('href', 'mailto:team@example.com');
  const relative = new URL(await link('Relative').getAttribute('href'));
  expect([relative.searchParams.get('target'), relative.hash]).toEqual(['docs/guide.md', '#usage']);
  // Relative targets resolve inside the repository; the server reads them at the stage revision.
  expect(new URL(await link('Up').getAttribute('href')).searchParams.get('target')).toBe('etc/passwd');
  for (const name of ['Protocol relative', 'Script', 'Data']) {
    await expect(link(name)).not.toHaveAttribute('href', /./);
    await expect(link(name)).toHaveAttribute('aria-disabled', 'true');
  }
  await expect(preview.getByRole('img', { name: 'Remote' })).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(preview.getByRole('img', { name: 'Inline' })).not.toHaveAttribute('src', /./);
  expect(new URL(await preview.getByRole('img', { name: 'Local' }).getAttribute('src')).searchParams.get('target')).toBe('docs/i.png');
  await expect(preview.locator('script')).toHaveCount(0);
  // Unrelated renders keep the rendered preview.
  await preview.evaluate((el) => { el.dataset.marker = 'kept'; window.previewLink = el.querySelector('a'); });
  await page.getByRole('button', { name: /^Notes/ }).click();
  await expect(preview).toHaveAttribute('data-marker', 'kept');
  expect(await page.evaluate(() => window.previewLink.isConnected)).toBe(true);
  expect(errors).toEqual([]);
});

test('Markdown titles show in the viewer tooltip, and a link names the titles of the images it holds', async ({ page }) => {
  const data = fixture(); data.stages[0].files[0].path = 'docs/README.md';
  const errors = await mount(page, data);
  const content = '[Titled](https://example.com/a "Link title") [Same](https://example.com/b "Same") [Script](javascript:alert(1))\n\n'
    + '[![Logo](https://example.com/i.png "Image title")](https://example.com/c "Outer title")';
  await page.route('**/api/file-content*', (route) => route.fulfill({ json: { ok: true, content, revision: 'b'.repeat(40), side: 'head' } }));
  await openFile(page);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.locator('.markdown-preview');
  await expect(preview.getByText('Titled', { exact: true })).toBeVisible();
  await expect(preview.locator('[title]')).toHaveCount(0);
  const tooltip = page.locator('#review-tooltip');
  // Every render closes the tooltip, so focus or hover again if a late one, such as a loaded diff, closed it.
  const shows = (target, text, by = 'focus') => expect(async () => {
    await page.mouse.move(0, 0); await target.blur(); await target[by]();
    await expect(tooltip).toHaveClass(/is-shown/, { timeout: 1000 });
    await expect(tooltip).toHaveText(text, { timeout: 1000 });
    await expect(target).toHaveAttribute('aria-describedby', 'review-tooltip', { timeout: 1000 });
  }).toPass();
  await shows(preview.getByText('Titled', { exact: true }), 'Link title');
  await shows(preview.getByRole('link').filter({ has: page.getByRole('img', { name: 'Logo' }) }), 'Outer title · Image title');
  // A link without a usable target is no keyboard stop.
  await shows(preview.getByText('Script', { exact: true }), 'Target unavailable in this preview', 'hover');
  // A title that repeats the visible text adds nothing while the text shows in full.
  await page.mouse.move(0, 0);
  await preview.getByText('Same', { exact: true }).focus();
  await expect(tooltip).not.toHaveClass(/is-shown/);
  expect(errors).toEqual([]);
});

test('a Markdown link collects the titles of the parts it holds without copying them again for each part', async ({ page }) => {
  const errors = await mount(page);
  // Counts the array elements iterated, as by spreading, while rendering a
  // link that holds `size` titled images: linear work grows with the size.
  const iterated = (size) => page.evaluate((size) => {
    const source = `[${Array.from({ length: size }, (_, i) => `![Image](https://example.com/i.png "Title ${i}")`).join(' ')}](https://example.com/ "Outer")`;
    const values = Array.prototype[Symbol.iterator];
    let count = 0;
    Array.prototype[Symbol.iterator] = function* () { for (const value of values.call(this)) { count++; yield value; } };
    try { window.renderMarkdownPreview(source, () => null); } finally { Array.prototype[Symbol.iterator] = values; }
    return count;
  }, size);
  const small = await iterated(500), large = await iterated(2000);
  expect(large).toBeLessThan(small * 6);
  expect(errors).toEqual([]);
});

// A table whose title repeats its text, and whose cells need more width than a narrow viewport gives.
const tableCells = Array.from({ length: 24 }, (_, i) => `Cell${i}`);
const clippedTableText = tableCells.join('');
const clippedTableMarkdown = `<table title="${clippedTableText}"><tbody><tr>${tableCells.map((cell) => `<td>${cell}</td>`).join('')}</tr></tbody></table>`;
async function previewMarkdown(page, content) {
  const data = fixture(); data.stages[0].files[0].path = 'docs/README.md';
  const errors = await mount(page, data);
  await page.route('**/api/file-content*', (route) => route.fulfill({ json: { ok: true, content, revision: 'b'.repeat(40), side: 'head' } }));
  await openFile(page);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.markdown-preview table')).toBeVisible();
  return errors;
}
const isClipped = (locator) => locator.evaluate((el) => el.scrollWidth > el.clientWidth);

test('a tooltip opened on a cut-off Markdown table closes once the table fits and the pointer leaves', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  const errors = await previewMarkdown(page, clippedTableMarkdown);
  const table = page.locator('.markdown-preview table'), tooltip = page.locator('#review-tooltip');
  expect(await isClipped(table)).toBe(true);
  await expect(async () => {
    await page.mouse.move(0, 0); await table.hover();
    await expect(tooltip).toHaveClass(/is-shown/, { timeout: 1000 });
    await expect(tooltip).toHaveText(clippedTableText, { timeout: 1000 });
  }).toPass();
  await expect(table).toHaveAttribute('aria-describedby', 'review-tooltip');
  await page.setViewportSize({ width: 2400, height: 700 });
  await expect.poll(() => isClipped(table)).toBe(false);
  // The table now shows its whole text, so its hint ends while the pointer still rests on it.
  await expect(tooltip).not.toHaveClass(/is-shown/);
  await expect(table).not.toHaveAttribute('aria-describedby');
  await page.mouse.move(0, 0);
  await expect(tooltip).not.toHaveClass(/is-shown/);
  await expect(table).not.toHaveAttribute('aria-describedby');
  expect(errors).toEqual([]);
});

test('a Markdown link names the title of a table it holds while the table is cut off', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  const errors = await previewMarkdown(page, `<a href="https://example.com/t" title="Link title">\n${clippedTableMarkdown}\n</a>`);
  const link = page.locator('.markdown-preview a'), table = link.locator('table'), tooltip = page.locator('#review-tooltip');
  const shows = (target, expected, by) => expect(async () => {
    await page.mouse.move(0, 0); await page.evaluate(() => document.activeElement?.blur()); await target[by]();
    await expect(tooltip).toHaveClass(/is-shown/, { timeout: 1000 });
    await expect(tooltip).toHaveText(expected, { timeout: 1000 });
  }).toPass();
  expect(await isClipped(table)).toBe(true);
  await shows(link, `Link title · ${clippedTableText}`, 'focus');
  await shows(table, clippedTableText, 'hover');
  // The focused link's open tooltip follows a resize that uncovers the table.
  await shows(link, `Link title · ${clippedTableText}`, 'focus');
  await page.setViewportSize({ width: 2400, height: 700 });
  await expect.poll(() => isClipped(table)).toBe(false);
  await expect(tooltip).toHaveText('Link title');
  await expect(tooltip).toHaveClass(/is-shown/);
  await expect(link).toHaveAttribute('aria-describedby', 'review-tooltip');
  await shows(link, 'Link title', 'focus');
  expect(errors).toEqual([]);
});

test('a cut-off specification reference is a keyboard stop naming it in full', async ({ page }) => {
  const data = fixture();
  const reference = 'A plain reference that runs on well past the width the specification gives it '.repeat(3).trim();
  data.requirements = [
    { id: 'long', title: 'Long', summary: 'Summary', source: { kind: 'text', reference }, acceptance: [] },
    { id: 'short', title: 'Short', summary: 'Summary', source: { kind: 'text', reference: 'Ticket 7' }, acceptance: [] },
  ];
  const errors = await mount(page, data);
  for (const spec of await page.locator('.specification summary').all()) await spec.click();
  const ref = (id) => page.locator(`.specification[data-req-id="${id}"] .req-src-ref`);
  expect(await ref('long').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await ref('short').hover();
  await expect(page.locator('#review-tooltip.is-shown')).toHaveCount(0);
  await page.mouse.move(0, 0);
  await ref('long').focus();
  await expect(page.locator('#review-tooltip')).toHaveText(reference);
  await expect(page.locator('#app [title]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('dialogs and tooltips show hostile artifact text literally', async ({ page }) => {
  const data = fixture();
  const name = hostileName('file'), path = `src/${name}`;
  for (const stage of data.stages) stage.files[0].path = path;
  data.requirements = [{ id: 'story', title: 'Story', acceptance: [{ id: 'works', text: hostile('criterion') }] }];
  data.stages[0].title = hostile('stage');
  data.stages[0].rationale = hostile('rationale');
  data.stages[0].nodes[0].title = hostile('step');
  const insight = codeInsight('mapped');
  Object.assign(insight, { title: hostile('insight'), body: hostile('body') });
  for (const target of [insight.codeTarget, insight.codeTarget.original]) {
    target.path = path; target.context = [hostile('context'), '// context', 'const second = 2;'];
  }
  insight.codeTarget.original = { ...insight.codeTarget.original, revision: 'd'.repeat(40) };
  const evidence = evidenceInsight({ reproduction: hostile('reproduce'), inline: hostile('output') });
  evidence.title = hostile('evidence');
  evidence.evidence.attachments[0].caption = hostile('caption');
  data.stages[0].insights.push(insight, evidence);
  const errors = await mount(page, data);
  await routeEvidence(page);
  await page.locator('.stage[data-stage="first"] .rationale-label').hover();
  await expect(page.getByRole('tooltip')).toHaveText(hostile('rationale'));

  await page.getByRole('button', { name: 'Find file', exact: true }).click();
  const search = page.getByRole('dialog', { name: 'Find a file' });
  await search.getByRole('combobox').fill('file');
  await expect(search.getByRole('option').first().locator('strong')).toHaveText(name);
  await expect(search.getByRole('heading', { level: 3 }).first()).toHaveText(`01 · ${hostile('stage')}`);
  await expect(search.getByRole('heading', { level: 4 }).first()).toHaveText(hostile('step'));
  await expect(search.locator('.file-search-typed')).toHaveText('file');
  await page.keyboard.press('Escape');

  await openFile(page);
  const node = page.locator('details[data-node="first-one"]');
  await node.locator('.node-reasoning').getByRole('button', { name: 'View code', exact: true }).click();
  const insightDialog = page.getByRole('dialog', { name: 'Insight and code' });
  await expect(insightDialog.getByRole('heading', { level: 3 }).first()).toHaveText(hostile('insight'));
  await expect(insightDialog.locator('.insight-full-body')).toHaveText(hostile('body'));
  await expect(insightDialog.locator('.insight-code-location').first()).toHaveText(`${path}:1–1 · ${'b'.repeat(12)}`);
  await expect(insightDialog.locator('.insight-code-line.is-target code').first()).toHaveText(hostile('context'));
  await insightDialog.locator('.insight-original summary').click();
  await expect(insightDialog.locator('.insight-original p')).toHaveText(`${path}:1–1`);
  await page.keyboard.press('Escape');
  await expect(insightDialog).toHaveCount(0);

  await node.getByRole('button', { name: 'View evidence' }).click();
  const evidenceDialog = page.getByRole('dialog', { name: 'Evidence' });
  await expect(evidenceDialog.getByRole('heading', { level: 3 })).toHaveText(hostile('evidence'));
  await expect(evidenceDialog.locator('figcaption').first()).toHaveText(hostile('caption'));
  await expect(evidenceDialog.locator('.evidence-reproduction')).toHaveText(`Reproduce: ${hostile('reproduce')}`);
  await expect(evidenceDialog.locator('.evidence-text').last()).toHaveText(hostile('output'));
  await expect(evidenceDialog.locator('.evidence-links li').first()).toHaveText(`story#works ${hostile('criterion')}`);
  await expect(evidenceDialog.getByRole('button', { name: `Zoom ${hostile('caption')}` })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.locator('b', { hasText: 'bold' })).toHaveCount(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  expect(errors).toEqual([]);
});

test('saved reviews and the review data dialog show hostile names literally', async ({ page }) => {
  const data = { ...fixture(), title: hostile('review') }, other = { ...fixture(), reviewId: 'other', title: hostile('other') };
  const errors = await mount(page, data, {}, [other]);
  await page.route('**/api/reviews/storage*', (route) => route.fulfill({ json: { ok: true, storage: {
    storageDirectory: hostile('directory'), bytes: 2048, categories: [{ label: hostile('label'), bytes: 1024, detail: hostile('detail') }],
    drafts: 0, unresolved: 0, unused: [], unusedBytes: 0, fingerprint: 'unchanged', referenceError: hostile('reference') } } }));
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  const list = page.getByRole('dialog', { name: 'Saved reviews' });
  await expect(list.locator('[data-review="other"] strong')).toHaveText(hostile('other'));
  await expect(list.locator('[data-review="browser-review"] strong')).toHaveText(hostile('review'));
  await expect(list.locator('[data-review="browser-review"]')).toHaveAttribute('aria-current', 'true');
  await list.locator('[data-review="other"]').getByRole('button', { name: 'Delete data…', exact: true }).click();
  const cleanup = page.getByRole('dialog', { name: 'Review data', exact: true });
  await expect(cleanup.locator('> strong')).toHaveText(hostile('other'));
  await expect(cleanup.locator('td').first()).toHaveText(hostile('label'));
  await expect(cleanup.locator('td').last()).toHaveText(hostile('detail'));
  await expect(cleanup).toContainText(`Stored in ${hostile('directory')}`);
  await expect(cleanup.getByRole('alert')).toHaveText(hostile('reference'));
  await expect(cleanup.getByRole('button', { name: 'Clean unused files', exact: true })).toBeDisabled();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.locator('b', { hasText: 'bold' })).toHaveCount(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  expect(errors).toEqual([]);
});

test('selection matches ignore case when lowercasing changes the text length', async ({ page }) => {
  const data = fixture(), lines = data.stages[0].files[0].lines;
  lines[0].s = 'const xy = 1;'; lines[1].s = '// XY context'; lines[2].s = 'const İxy = 2;';
  const errors = await mount(page, data); await openFile(page);
  await page.locator('[data-line-id="l:first:new:1:shared.js"] code').evaluate((code) => {
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (!text.data.includes('xy')) text = walker.nextNode();
    const range = document.createRange(); range.setStart(text, text.data.indexOf('xy')); range.setEnd(text, text.data.indexOf('xy') + 2);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    code.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect.poll(() => selectionHits(page)).toEqual([
    { text: 'XY', line: 'l:first:new:2:shared.js', code: true, connected: true },
    { text: 'xy', line: 'l:first:new:3:shared.js', code: true, connected: true },
  ]);
  expect(errors).toEqual([]);
});

// Selects `token` in a diff line without the mouse, as the keyboard would.
const selectInLine = (page, line, token) => page.locator(`[data-line-id="${line}"] code`).evaluate((code, token) => {
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let text = walker.nextNode();
  while (!text.data.includes(token)) text = walker.nextNode();
  const range = document.createRange(); range.setStart(text, text.data.indexOf(token)); range.setEnd(text, text.data.indexOf(token) + token.length);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  const box = range.getBoundingClientRect();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}, token);

test('dragging selected diff text keeps later keyboard selections matching', async ({ page }) => {
  const data = fixture();
  const errors = await mount(page, data); await openFile(page);
  // Drag the selected word out. Whether a headless browser starts a native
  // drag differs by platform, so the drag's events are sent directly: a
  // mousedown in the diff, then dragstart and dragend, which take the mouseup.
  const word = page.locator('[data-line-id="l:first:new:3:shared.js"] code');
  await selectInLine(page, 'l:first:new:3:shared.js', 'second');
  await word.dispatchEvent('mousedown', { button: 0, buttons: 1 });
  await word.dispatchEvent('dragstart');
  await word.dispatchEvent('dragend');
  await selectInLine(page, 'l:first:new:3:shared.js', 'const');
  await expect.poll(() => selectionHits(page)).toEqual([{ text: 'const', line: 'l:first:new:1:shared.js', code: true, connected: true }]);
  expect(errors).toEqual([]);
});

test('a cancelled selection drag refreshes the matches for the changed selection', async ({ page }) => {
  const data = fixture();
  const errors = await mount(page, data); await openFile(page);
  const hits = (line) => [{ text: 'const', line, code: true, connected: true }];
  await selectInLine(page, 'l:first:new:1:shared.js', 'const');
  await expect.poll(() => selectionHits(page)).toEqual(hits('l:first:new:3:shared.js'));
  // A drag starts in the diff, changes the selection and is cancelled without
  // a mouseup.
  await page.locator('[data-line-id="l:first:new:3:shared.js"] code').dispatchEvent('mousedown', { button: 0 });
  await selectInLine(page, 'l:first:new:3:shared.js', 'const');
  // During the drag the matches stay those of the original selection.
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  expect(await selectionHits(page)).toEqual(hits('l:first:new:3:shared.js'));
  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true })));
  await expect.poll(() => selectionHits(page)).toEqual(hits('l:first:new:1:shared.js'));
  expect(errors).toEqual([]);
});

test('selection matches treat a final sigma as a sigma', async ({ page }) => {
  const data = fixture(), lines = data.stages[0].files[0].lines;
  lines[0].s = 'const ΟΣ = 1;'; lines[1].s = '// ος context'; lines[2].s = 'const σ = 2;';
  const errors = await mount(page, data); await openFile(page);
  await selectInLine(page, 'l:first:new:1:shared.js', 'ΟΣ');
  await expect.poll(() => selectionHits(page)).toEqual([{ text: 'ος', line: 'l:first:new:2:shared.js', code: true, connected: true }]);
  await selectInLine(page, 'l:first:new:2:shared.js', 'ος');
  await expect.poll(() => selectionHits(page)).toEqual([{ text: 'ΟΣ', line: 'l:first:new:1:shared.js', code: true, connected: true }]);
  expect(errors).toEqual([]);
});

test('selection matches span the syntax highlighting of a line', async ({ page }) => {
  const data = fixture(), lines = data.stages[0].files[0].lines;
  lines[2].s = 'const first = 2;';
  const errors = await mount(page, data); await openFile(page);
  // Select `const first`: the keyword is highlighted apart from the name.
  const nodes = await page.locator('[data-line-id="l:first:new:1:shared.js"] code').evaluate((code) => {
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT), texts = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node);
    const start = texts.find((node) => node.data.includes('const')), end = texts.find((node) => node.data.includes('first'));
    const range = document.createRange();
    range.setStart(start, start.data.indexOf('const')); range.setEnd(end, end.data.indexOf('first') + 'first'.length);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    return texts.indexOf(end) - texts.indexOf(start);
  });
  expect(nodes).toBeGreaterThan(0);
  await expect.poll(() => selectionHits(page)).toEqual([{ text: 'const first', line: 'l:first:new:3:shared.js', code: true, connected: true }]);
  expect(await page.evaluate(() => { const [range] = CSS.highlights.get('sel-hit'); return range.startContainer !== range.endContainer; })).toBe(true);
  expect(errors).toEqual([]);
});

test('selection matches in a row of many highlighted tokens are mapped in linear time', async ({ page }) => {
  // Each token is its own highlighted span. Mapping each match by scanning the
  // row's text nodes from the start takes most of a minute for this row; a
  // single pass takes about a second, so the poll times out only for the
  // quadratic mapping.
  const count = 96000;
  const data = fixture(), lines = data.stages[0].files[0].lines;
  lines[0].s = 'const first = this;'; lines[2].s = Array(count).fill('this').join(',');
  const errors = await mount(page, data); await openFile(page);
  expect(await page.locator('[data-line-id="l:first:new:3:shared.js"] code span').count()).toBeGreaterThanOrEqual(count);
  // Record the matches instead of painting them, which takes seconds on its own.
  await page.evaluate(() => { CSS.highlights.set = (name, highlight) => { window.highlighted = highlight.size; return CSS.highlights; }; });
  await selectInLine(page, 'l:first:new:1:shared.js', 'this');
  await expect.poll(() => page.evaluate(() => window.highlighted), { timeout: 15000 }).toBe(count);
  expect(errors).toEqual([]);
});

test('selection matches refresh once per double-click and not while typing in a field', async ({ page }) => {
  const data = fixture();
  const errors = await mount(page, data); await openFile(page);
  // Each refresh clears the matches; each one with a term builds a highlight;
  // and each is scheduled for a frame.
  await page.evaluate(() => {
    const work = window.selectionWork = { refreshes: 0, matches: 0, frames: 0 };
    const highlights = CSS.highlights, remove = highlights.delete.bind(highlights);
    highlights.delete = (name) => { work.refreshes++; return remove(name); };
    window.Highlight = class extends Highlight { constructor(...ranges) { super(...ranges); work.matches++; } };
    const frame = window.testFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => { work.frames++; return frame(callback); };
  });
  const settled = () => page.evaluate(() => new Promise((resolve) => testFrame(() => testFrame(() => setTimeout(() => {
    const work = window.selectionWork, counts = { ...work }; work.refreshes = work.matches = work.frames = 0; resolve(counts);
  }, 50)))));
  await settled();
  const word = page.locator('[data-line-id="l:first:new:3:shared.js"] code');
  await word.scrollIntoViewIfNeeded();
  await settled();
  const box = await word.boundingBox();
  await page.mouse.dblclick(box.x + 4, box.y + box.height / 2);
  // Windows also selects the space after a double-clicked word; matching trims it.
  expect((await page.evaluate(() => String(window.getSelection()))).trim()).toBe('const');
  await expect.poll(() => selectionHits(page)).toEqual([{ text: 'const', line: 'l:first:new:1:shared.js', code: true, connected: true }]);
  expect(await settled()).toMatchObject({ refreshes: 1, matches: 1 });
  await page.locator('.file-notes .thread-add').click();
  const draft = page.locator('textarea[name="nc-body"]');
  await expect(draft).toBeFocused();
  await settled();
  await draft.pressSequentially('hello there');
  await draft.press('ArrowLeft'); await draft.press('Shift+Home');
  expect(await settled()).toEqual({ refreshes: 0, matches: 0, frames: 0 });
  await expect(draft).toHaveValue('hello there');
  expect(errors).toEqual([]);
});

test('a paged diff keeps its page, scroll, rows and code selection across live updates', async ({ page }) => {
  const data = fixture(), file = data.stages[0].files[0];
  const lines = Array.from({ length: 1900 }, (_, i) => ({ t: 'add', n: i + 1, s: `const row${i + 1} = shared(${i + 1});`, h: 1 }));
  file.lines = lines.slice(0, 900); file.nextOffset = 900;
  data.feedback = [thread('live')];
  const errors = await mount(page, data, { fileView: { [fileId]: 'full' }, openThreads: { first: true } });
  await page.route('**/api/diff*', (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    return route.fulfill({ json: { ok: true, lines: lines.slice(offset, offset + 900), offset, nextOffset: offset + 900 < lines.length ? offset + 900 : null, additions: lines.length, deletions: 0 } });
  });
  await openFile(page);
  const panel = page.locator('details[data-node="first-one"] .cinema-diff');
  const scroller = panel.locator('.diff-scroll');
  await panel.getByRole('button', { name: 'Next page', exact: true }).evaluate((el) => el.click());
  await expect(panel.locator('.diff-pages span')).toHaveText('Rows 901–1800');
  await scroller.evaluate((el) => { el.scrollTop = 300; });
  await panel.locator('[data-line-id="l:first:new:950:shared.js"] code').evaluate((code) => {
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (!text.data.includes('shared')) text = walker.nextNode();
    const range = document.createRange(); range.setStart(text, text.data.indexOf('shared')); range.setEnd(text, text.data.indexOf('shared') + 6);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    code.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  // Every other row of the page is a match; the selected occurrence is not.
  await expect.poll(async () => (await selectionHits(page)).length).toBe(899);
  expect((await selectionHits(page)).some((hit) => hit.line === 'l:first:new:950:shared.js')).toBe(false);
  await page.evaluate(() => {
    window.retainedRows = [...document.querySelectorAll('.cinema-diff .drow')];
    window.removedRows = 0;
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.removedNodes) if (node.nodeType === 1 && (node.matches('.drow') || node.querySelector('.drow'))) window.removedRows++;
    }).observe(document.querySelector('.cinema-diff .diff-grid'), { childList: true, subtree: true });
  });
  const expectPageKept = async () => {
    await expect(panel.locator('.diff-pages span')).toHaveText('Rows 901–1800');
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(300);
    expect(await page.evaluate(() => window.retainedRows.length === 900 && window.retainedRows.every((row) => row.isConnected) && window.removedRows === 0)).toBe(true);
  };
  data.feedback[0].comments.push({ author: 'agent', body: 'Reply during a selection', createdAt: '2026-09-08T10:01:00Z' });
  data.viewerRevision = 'selected';
  await expect(page.locator('.stage .tthread')).toContainText('Reply during a selection');
  expect(await page.evaluate(() => String(window.getSelection()))).toBe('shared');
  const hits = await selectionHits(page);
  expect(hits.length === 899 && hits.every((hit) => hit.connected && hit.code && hit.text === 'shared')).toBe(true);
  await expectPageKept();
  // A selection changed without the mouse, such as from the keyboard, updates
  // the matches: another token, then select all, which matches nothing.
  const selectWithoutMouse = (line, token) => panel.locator(`[data-line-id="${line}"] code`).evaluate((code, token) => {
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (!text.data.includes(token)) text = walker.nextNode();
    const range = document.createRange(); range.setStart(text, text.data.indexOf(token)); range.setEnd(text, text.data.indexOf(token) + token.length);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  }, token);
  await selectWithoutMouse('l:first:new:960:shared.js', 'const');
  await expect.poll(async () => (await selectionHits(page)).filter((hit) => hit.text === 'const').length).toBe(899);
  expect((await selectionHits(page)).length).toBe(899);
  await page.keyboard.press('ControlOrMeta+a');
  await expect.poll(() => selectionHits(page)).toEqual([]);
  await expectPageKept();
  // Without a selection the full snapshot is adopted; the loaded page stays.
  await page.evaluate(() => window.getSelection().removeAllRanges());
  data.feedback[0].comments.push({ author: 'agent', body: 'Reply after the selection', createdAt: '2026-09-08T10:02:00Z' });
  data.viewerRevision = 'cleared';
  await expect(page.locator('.stage .tthread')).toContainText('Reply after the selection');
  await expectPageKept();
  // Clicking outside the diff clears the matches.
  await selectWithoutMouse('l:first:new:950:shared.js', 'shared');
  await expect.poll(async () => (await selectionHits(page)).length).toBe(899);
  await page.locator('.hero, header').first().dispatchEvent('mousedown');
  expect(await selectionHits(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('a pinned insight popover stays open while an inline insight highlights its lines', async ({ page }) => {
  const data = fixture(), insight = codeInsight();
  insight.body = 'Short reasoning.';
  data.stages[0].insights.push(insight);
  const errors = await mount(page, data); await openFile(page);
  const node = page.locator('details[data-node="first-one"]');
  await node.locator('.node-reasoning .tag-face').click();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('Check the boundary');
  await node.locator('.line-code-insights button').hover();
  await expect(page.locator('.is-code-insight-target')).toHaveCount(1);
  await expect(tooltip).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.locator('.is-code-insight-target')).toHaveCount(0);
  await expect(tooltip).toBeVisible();
  expect(errors).toEqual([]);
});

test('file approval buttons and notes toggles are named for assistive technology', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('named')];
  const errors = await mount(page, data, { openStages: { first: true } });
  const one = page.locator('details[data-node="first-one"]');
  await one.locator('summary').click();
  await expect(one.getByRole('button', { name: 'Approve file' })).toHaveCount(1);
  await expect(page.locator('.stage[data-stage="first"]').getByRole('button', { name: '1 thread, 1 open' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

// Resolves once the viewer's own unsaved-changes check is clear.
async function settled(page) {
  await expect.poll(() => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }), { message: 'the viewer has unsaved review state' }).toBe(false);
}
async function deleteReviewElsewhere(page, reviewId) {
  await page.evaluate(async (id) => {
    const input = { reviewId: id, generation: 'test' }, query = `?review=${id}&generation=test`;
    const post = async (path, body) => {
      const response = await fetch(path + query, { method: 'POST', body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(`${path} failed with ${response.status}: ${payload.error}`);
      return payload;
    };
    const result = await post('/api/reviews/storage', input);
    await post('/api/reviews/delete', { ...input, fingerprint: result.storage.fingerprint });
  }, reviewId);
}

test('a review deleted during an approval capture ends the approval and a pending switch', async ({ page }) => {
  const a = { ...fixture(), reviewId: 'a' }, b = { ...fixture(), reviewId: 'b' };
  await mount(page, a, {}, [b]);
  await openFile(page);
  // Opening the file saves; a save landing after the deletion's preview would make the deletion stale.
  await settled(page);
  let release;
  const captured = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/approval-snapshots*', async (route) => { await captured; return route.fallback(); });
  await page.locator('details[data-node="first-one"] .mini-approve').click();
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.locator('[data-review="b"]').getByRole('button', { name: 'Open review', exact: true }).click();
  await deleteReviewElsewhere(page, 'a');
  await expect(page.getByRole('heading', { name: 'Review data deleted' })).toBeVisible();
  release();
  await expect(page.locator('#review-list')).toContainText('The review was deleted before its changes were saved.');
  await expect(page).toHaveURL('http://localhost/');
  // A page stuck retrying the save would not answer.
  expect(await page.evaluate(() => 1 + 1)).toBe(2);
});

test('a failed save clears once no change is left to save', async ({ page }) => {
  const a = { ...fixture(), reviewId: 'a' }, b = { ...fixture(), reviewId: 'b' };
  await mount(page, a, {}, [b]);
  await openFile(page);
  await settled(page);
  await page.route('**/api/review-state*', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 500, json: { ok: false, error: 'Storage unavailable' } }) : route.fallback());
  const wrap = page.getByRole('button', { name: 'Wrap lines', exact: true }).first();
  await wrap.click();
  await expect(page.locator('#save-status')).toContainText('Storage unavailable');
  await wrap.click();
  await expect(page.locator('#save-status')).toBeHidden();
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.locator('[data-review="b"]').getByRole('button', { name: 'Open review', exact: true }).click();
  await expect(page).toHaveURL('http://localhost/b');
});

test('reverting a change after a save whose response was lost saves the reversal', async ({ page }) => {
  await mount(page, fixture());
  await openFile(page);
  await settled(page);
  let lose = true;
  await page.route('**/api/review-state*', async (route) => {
    if (route.request().method() !== 'POST' || !lose) return route.fallback();
    lose = false;
    // The server commits the save, but its response never arrives.
    const { url, body } = { url: route.request().url(), body: route.request().postData() };
    await page.evaluate(([input, payload]) => fetch(input, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }), [url, body]);
    await route.abort('failed');
  });
  const wrap = page.getByRole('button', { name: 'Wrap lines', exact: true }).first();
  await expect(wrap).toHaveAttribute('aria-pressed', 'false');
  await wrap.click();
  await expect(page.locator('#save-status')).toBeVisible();
  await wrap.click();
  await expect(page.locator('#save-status')).toBeHidden();
  await reload(page);
  await openFile(page);
  await expect(page.getByRole('button', { name: 'Wrap lines', exact: true }).first()).toHaveAttribute('aria-pressed', 'false');
});

/** Fails the page's next review-state save. With `commit`, the server stores it
 * first, as when only the response is lost; otherwise the request never arrives.
 * `failed` resolves with the save's URL and changes. */
async function failNextSave(page, { commit }) {
  let armed = true, settle;
  const failed = new Promise((resolve) => { settle = resolve; });
  await page.route('**/api/review-state*', async (route) => {
    if (route.request().method() !== 'POST' || !armed) return route.fallback();
    armed = false;
    const url = route.request().url(), body = route.request().postData();
    if (commit) await page.evaluate(([input, payload]) => fetch(input, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }), [url, body]);
    await route.abort('failed');
    settle({ url, changes: JSON.parse(body).changes });
  });
  return failed;
}
/** Saves changes to the review state as another tab would. */
async function saveElsewhere(page, url, changes) {
  await page.evaluate(async ([input, list]) => {
    const response = await fetch(input, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewId: 'browser-review', generation: 'test', changes: list }) });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error);
  }, [url, changes]);
}
const storedOnServer = (page, url) => page.evaluate(async (input) => (await (await fetch(input)).json()).state, url);
/** Opens a message draft and saves `text` as its body. */
async function savedDraft(page, text) {
  await openFile(page);
  await page.locator('.file-notes .thread-add').click();
  const input = page.locator('textarea[name="nc-body"]');
  await saveAction(page, () => input.fill(text), (state) => state.editor?.compose?.body === text);
  await settled(page);
  return input;
}
/** Counts the page's review-state saves from now on. */
function countSaves(page) {
  const counter = { saves: 0 };
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/review-state' && request.method() === 'POST') counter.saves += 1; });
  return counter;
}

test('a save whose response was lost does not overwrite a value another tab restored', async ({ page }) => {
  await mount(page, fixture());
  const input = await savedDraft(page, 'Original');
  const lost = failNextSave(page, { commit: true });
  await input.fill('Edited');
  const { url, changes } = await lost;
  await expect(page.locator('#save-status')).toBeVisible();
  // Another tab, which received the edit, restores the original text.
  await saveElsewhere(page, url, changes.map(({ path, before, after }) => ({ path, before: after, after: before })));
  await page.getByRole('button', { name: 'Wrap lines', exact: true }).first().click();
  await expect(page.locator('#save-status')).toContainText('Review state changed in another tab');
  await expect(input).toHaveValue('Edited');
  const stored = await storedOnServer(page, url);
  expect(stored.editor.compose.body).toBe('Original');
  expect(stored.wrapLines).toBe(false);
});

test('undoing an edit whose save never arrived does not retry it over another tab\'s text', async ({ page }) => {
  await mount(page, fixture());
  const input = await savedDraft(page, 'Original');
  const failed = failNextSave(page, { commit: false });
  await input.fill('Edited');
  const { url } = await failed;
  await expect(page.locator('#save-status')).toBeVisible();
  await saveElsewhere(page, url, [{ path: ['editor', 'compose', 'body'], before: { present: true, value: 'Original' }, after: { present: true, value: 'Other tab' } }]);
  const counter = countSaves(page);
  await input.fill('Original');
  await expect(page.locator('#save-status')).toContainText('Review state changed in another tab');
  await page.getByRole('button', { name: 'Wrap lines', exact: true }).first().click();
  await input.fill('Later text');
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
  expect(counter.saves).toBe(0);
  await expect(page.locator('#save-status')).toContainText('Review state changed in another tab');
  await expect(input).toHaveValue('Later text');
  expect((await storedOnServer(page, url)).editor.compose.body).toBe('Other tab');
});

test('undoing an edit whose save never arrived does not overwrite another tab\'s identical text', async ({ page }) => {
  await mount(page, fixture());
  const input = await savedDraft(page, 'Original');
  const failed = failNextSave(page, { commit: false });
  await input.fill('Edited');
  const { url, changes } = await failed;
  await expect(page.locator('#save-status')).toBeVisible();
  // Another tab saves the same text, which is not this page's save landing.
  await saveElsewhere(page, url, changes);
  const counter = countSaves(page);
  await input.fill('Original');
  await expect(page.locator('#save-status')).toContainText('Review state changed in another tab');
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
  expect(counter.saves).toBe(0);
  expect((await storedOnServer(page, url)).editor.compose.body).toBe('Edited');
});

test('a save whose response was lost is confirmed before the next change saves', async ({ page }) => {
  await mount(page, fixture());
  const input = await savedDraft(page, 'Original');
  const lost = failNextSave(page, { commit: true });
  await input.fill('Edited');
  const { url } = await lost;
  await expect(page.locator('#save-status')).toBeVisible();
  const counter = countSaves(page);
  await page.getByRole('button', { name: 'Wrap lines', exact: true }).first().click();
  await expect(page.locator('#save-status')).toBeHidden();
  await settled(page);
  expect(counter.saves).toBe(1);
  const stored = await storedOnServer(page, url);
  expect(stored.editor.compose.body).toBe('Edited');
  expect(stored.wrapLines).toBe(true);
});

test('turning a failed since-approval comparison off and on loads it again', async ({ page }) => {
  const data = fixture();
  await mount(page, data);
  await openFile(page);
  await saveAction(page, () => page.locator('details[data-node="first-one"] .mini-approve').click(), (state) => !!state.approvals?.[approvalKey('first', 'first-one')]?.snapshotId);
  const endpoint = { path: 'shared.js', headRevision: 'b'.repeat(40), mode: '100644', exists: true, size: 20, sha256: 'hash' };
  let fail = true;
  await page.route('**/api/approval-comparison*', (route) => fail
    ? route.fulfill({ status: 500, json: { ok: false, error: 'Comparison unavailable' } })
    : route.fulfill({ json: { ok: true, approved: endpoint, current: endpoint, baseChanged: false, ownershipChanged: false, lines: [{ t: 'add', n: 1, s: 'new content' }], offset: 0, nextOffset: null } }));
  data.stages[0].files[0].revision = 'changed'; data.viewerRevision = 'after-approval';
  await expect(page.locator('details[data-node="first-one"] .frow')).toHaveClass(/is-stale/);
  await openFile(page);
  const diff = page.locator('details[data-node="first-one"] .cinema-diff');
  await expect(diff).toContainText('Comparison unavailable');
  fail = false;
  const toggle = page.getByRole('button', { name: 'Since approval', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(diff).toContainText('new content');
});

test('a validation check without a passed status does not count as passed', async ({ page }) => {
  const data = fixture();
  data.stages[0].insights = [
    { id: 'unknown', collection: 'validation', type: 'validation', title: 'Unknown check', nodeRefs: ['first-one'] },
    { id: 'passed', collection: 'validation', type: 'validation', title: 'Passed check', meta: 'passed', nodeRefs: ['first-one'] },
  ];
  await mount(page, data);
  await page.locator('.stage-title[data-id="first"]').click();
  const one = page.locator('details[data-node="first-one"]');
  await one.getByRole('button', { name: 'Checks not passed: 1', exact: true }).click();
  await expect(one.locator('.tag-face[data-vstat="notrun"]')).toBeFocused();
  await expect(one.locator('.tag-face[data-vstat="passed"]')).toHaveCount(1);
});

test('closing a file while its line jump loads cancels the jump', async ({ page }) => {
  const data = fixture();
  data.feedback = [thread('far', 'open', { kind: 'line', stageId: 'first', path: 'shared.js', side: 'new', line: 50, label: 'shared.js:50' })];
  await mount(page, data, { comments: [{ kind: 'line', id: 'l:first:new:50:shared.js', nodeId: 'first-one', exported: true, threadId: 'far', body: 'Feedback far' }] });
  await openFile(page);
  let release;
  const loaded = new Promise((resolve) => { release = resolve; });
  let diffRequested;
  const requested = new Promise((resolve) => { diffRequested = resolve; });
  await page.route('**/api/diff*', async (route) => { diffRequested(); await loaded; return route.fallback(); });
  await showNotes(page);
  await page.locator('.side.notes [data-thread-id="far"] [data-action="jump-to"]').click();
  await requested;
  await page.keyboard.press('Escape');
  const node = page.locator('details[data-node="first-one"]');
  await expect(node.locator('.cinema-diff')).toHaveCount(0);
  await node.locator('summary').click();
  await expect(node).not.toHaveAttribute('open', '');
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/diff');
  release();
  await response;
  // Two frames carry the jump; a cancelled one opens nothing.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  await expect(node).not.toHaveAttribute('open', '');
});

test('stage notes and notes on a node named overview keep separate groups', async ({ page }) => {
  const data = fixture();
  data.stages[0].nodes.push({ id: 'overview', title: 'Overview step', description: 'Node description' });
  await mount(page, data, { comments: [
    { kind: 'stage', id: 'first', mode: 'personal', body: 'Stage note', createdAt: 1 },
    { kind: 'node', id: 'overview', stageId: 'first', mode: 'personal', body: 'Node note', createdAt: 1 },
  ] });
  await showNotes(page);
  const headings = page.locator('.side.notes .note-node-h');
  await expect(headings).toHaveCount(2);
  await expect(headings.filter({ hasText: 'Stage overview' })).toHaveCount(1);
  await expect(headings.filter({ hasText: 'Overview step' })).toHaveCount(1);
});

test('a poll response requested before a local resolve does not reopen the thread', async ({ page }) => {
  const data = fixture(); data.feedback = [thread('resolve-me')];
  await mount(page, data, { openThreads: { first: true } });
  let release, requested, fetched = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = new Promise((resolve) => { requested = resolve; });
  page.on('response', (response) => { if (new URL(response.url()).pathname === '/api/implementation') fetched++; });
  await page.route('**/api/implementation*', async (route) => {
    if (fetched || requested === null) return route.fallback();
    const stale = structuredClone(data);
    requested(); requested = null;
    await gate;
    return route.fulfill({ json: { ok: true, implementation: stale } });
  });
  data.viewerRevision = 'changed';
  await seen;
  await page.locator('.stage [data-action="thread-resolve"]').click();
  await expect(page.locator('.tb-btn[data-action="toggle-notes"]')).toHaveText('Notes 0');
  release();
  // The stale response is discarded and the next poll fetches the resolved thread.
  await expect.poll(() => fetched).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.tb-btn[data-action="toggle-notes"]')).toHaveText('Notes 0');
});

test('an older saved-review refresh does not replace a newer list', async ({ page }) => {
  const a = { ...fixture(), reviewId: 'a', title: 'Review A' }, b = { ...fixture(), reviewId: 'b', title: 'Review B' };
  await mount(page, a, {}, [b]);
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await expect(page.locator('[data-review="a"]')).toBeVisible();
  const staleList = { ok: true, reviews: ['a', 'b'].map((id) => ({ id, generation: 'test', title: `Review ${id.toUpperCase()}`, implementationId: 'browser-review', repositoryRoot: `/repos/${id}`, updatedAt: '2026-09-11T10:00:00Z', completedAt: null, available: true })) };
  let calls = 0, release, staleDone;
  const gate = new Promise((resolve) => { release = resolve; });
  const fulfilled = new Promise((resolve) => { staleDone = resolve; });
  await page.route('**/api/reviews?*', async (route) => {
    calls += 1;
    if (calls !== 1) return route.fallback();
    await gate;
    await route.fulfill({ json: staleList });
    staleDone();
  });
  await page.locator('[data-review="a"]').getByRole('button', { name: 'Delete data…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review data', exact: true });
  await dialog.getByRole('button', { name: 'Delete review data', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-review="a"]')).toHaveCount(0);
  release();
  await fulfilled;
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
  await expect(page.locator('[data-review="a"]')).toHaveCount(0);
  await expect(page.locator('[data-review="b"]')).toBeVisible();
});

test('a stale anchor on an old line that is now unchanged jumps to its file', async ({ page }) => {
  const data = fixture();
  data.feedback = [{ ...thread('old-context', 'open', { kind: 'line', stageId: 'first', path: 'shared.js', side: 'old', line: 2, label: 'shared.js:2' }), anchorStale: true }];
  await mount(page, data, { comments: [{ kind: 'line', id: 'l:first:old:2:shared.js', nodeId: 'first-one', exported: true, threadId: 'old-context', body: 'Feedback old-context' }] });
  await showNotes(page);
  const jump = page.locator('.side.notes [data-thread-id="old-context"] [data-action="jump-to"]');
  await expect(jump).toHaveAttribute('data-kind', 'file');
  await jump.click();
  await expect(page.locator('details[data-node="first-one"] .cinema-diff')).toBeVisible();
});

test('a saved composer with a negative edit index does not keep a saved note from sending', async ({ page }) => {
  await mount(page, fixture(), {
    comments: [{ kind: 'stage', id: 'first', mode: 'feedback', body: 'Send me', createdAt: 1 }],
    editor: { compose: { kind: 'stage', id: 'first', editIndex: -1, mode: 'feedback', body: 'Composer text' } },
  });
  await showNotes(page);
  const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/feedback/export');
  await page.getByRole('button', { name: /Prepare feedback/ }).click();
  expect((await request).postDataJSON().notes.map((note) => note.body)).toEqual(['Send me']);
});

test('an unread reply is not read while the page is hidden and is read once it shows again', async ({ page }) => {
  const comment = (id, author, body, createdAt = '2026-10-08T10:00:00Z') => ({ id, author, body, attachments: [], createdAt });
  const target = { kind: 'stage', stageId: 'first', label: 'Stage first' };
  const data = { ...fixture(), feedback: [{ id: 'one', status: 'open', target, comments: [comment('u1', 'user', 'First?')] }] };
  const baseline = page.waitForResponse(async (response) => new URL(response.url()).pathname === '/api/review-state' &&
    response.request().method() === 'POST' && (await response.json()).state?.repliesSeenThrough === '');
  await mount(page, data);
  await baseline;
  data.feedback[0].comments.push(comment('answer', 'agent', 'Short answer.', '2026-10-08T10:05:00Z'));
  data.viewerRevision = 'replied';
  await expect.poll(() => page.title()).toMatch(/^\(1\)/);
  await showNotes(page);
  const reply = page.locator('.side.notes [data-reply-key=\'["one","answer"]\']');
  await expect(reply).toBeInViewport();
  // The dwell has started but not finished when the page hides.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1500)));
  await expect(reply).toHaveClass(/is-unread/);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(reply).not.toHaveClass(/is-unread/, { timeout: 5000 });
});

test('a visibility report that arrives after an unread reply was removed does not read it', async ({ page }) => {
  // The page's observer reports only what the test delivers, as a browser may
  // deliver a queued report after the reply was removed and unobserved.
  await page.addInitScript(() => {
    const Native = window.IntersectionObserver;
    window.IntersectionObserver = class extends Native {
      constructor(callback, options) {
        super(() => {}, options);
        window.reportVisible = (target) => callback([{ target, intersectionRatio: 1, intersectionRect: { height: 100 }, rootBounds: { height: 800 } }], this);
      }
    };
  });
  const comment = (id, author, body, createdAt = '2026-10-08T10:00:00Z') => ({ id, author, body, attachments: [], createdAt });
  const target = { kind: 'stage', stageId: 'first', label: 'Stage first' };
  const data = { ...fixture(), feedback: [{ id: 'one', status: 'open', target, comments: [comment('u1', 'user', 'First?')] }] };
  const baseline = page.waitForResponse(async (response) => new URL(response.url()).pathname === '/api/review-state' &&
    response.request().method() === 'POST' && (await response.json()).state?.repliesSeenThrough === '');
  await mount(page, data, { openThreads: { first: true } });
  await baseline;
  data.feedback[0].comments.push(comment('answer', 'agent', 'Short answer.', '2026-10-08T10:05:00Z'));
  data.viewerRevision = 'replied';
  await expect.poll(() => page.title()).toMatch(/^\(1\)/);
  const reply = page.locator('.stage [data-reply-key=\'["one","answer"]\']');
  await expect(reply).toHaveClass(/is-unread/);
  const removed = await reply.elementHandle();
  await page.locator('.stage [data-action="toggle-thread"]').click();
  await expect(reply).toHaveCount(0);
  await removed.evaluate((element) => window.reportVisible(element));
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1500)));
  expect(await page.title()).toMatch(/^\(1\)/);
});
