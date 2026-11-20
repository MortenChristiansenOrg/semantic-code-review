// The viewer page against the real viewer server, started by the CLI on fixture
// repositories: launch links, the page policy, the fresh-link notice, and
// switching between viewers on different ports.
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsRoot = fileURLToPath(new URL('../../', import.meta.url));
const flowCli = fileURLToPath(new URL('../../../skills/semantic-flow/scripts/semantic-flow.mjs', import.meta.url));
const fixtureScript = fileURLToPath(new URL('./real-viewer-fixture.mjs', import.meta.url));
const KEY_HEADER = 'x-semantic-flow-key';
const NOTICE = 'This review page needs a fresh link.';

test.describe.configure({ mode: 'serial' });

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

let home, env;
const reviews = { a: { id: 'review-a', title: 'Review A' }, b: { id: 'review-b', title: 'Review B' } };

/** The viewer's record, as the CLI stores it. */
function record(review) {
  const directory = path.join(home, 'reviews');
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name, 'review.json');
    if (!fs.existsSync(file)) continue;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.implementationId === review.id) return value;
  }
  throw new Error(`No review record for ${review.id}`);
}

/** Runs `review` for a fixture repository; returns the printed launch URL. */
function launch(review) {
  const result = spawnSync(process.execPath, [flowCli, 'review'], {
    cwd: review.root, encoding: 'utf8', timeout: 30_000,
    env: { ...env, SEMANTIC_VIEW_PORT: String(review.port) },
  });
  expect(result.status, result.stderr).toBe(0);
  const url = /^Semantic review viewer: (\S+)$/m.exec(result.stdout)?.[1];
  expect(url, result.stdout).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#launch=[\w-]+$/);
  review.base = url.slice(0, url.indexOf('#'));
  expect(review.base).toBe(`http://127.0.0.1:${review.port}/`);
  return url;
}

async function stop(review) {
  let viewer;
  try { viewer = record(review).viewer; } catch { return; }
  if (!viewer) return;
  await fetch(`http://127.0.0.1:${viewer.port}/api/shutdown`, {
    method: 'POST', headers: { 'content-type': 'application/json', [KEY_HEADER]: viewer.key }, body: '{}',
  }).catch(() => {});
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(viewer.processId, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Viewer ${viewer.processId} did not stop.`);
}

/** A new launch URL from the running viewer, as a reopened review gets one. */
async function freshLaunchUrl(review) {
  const { key } = record(review).viewer;
  const response = await fetch(`${review.base}api/launch`, { method: 'POST', headers: { 'content-type': 'application/json', [KEY_HEADER]: key }, body: '{}' });
  const { code } = await response.json();
  return `${review.base}#launch=${code}`;
}

/** A page in a new browser context that records policy violations. */
async function openPage(browser) {
  const context = await browser.newContext();
  await context.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await context.addInitScript(() => {
    window.policyViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => window.policyViolations.push(`${event.effectiveDirective} ${event.blockedURI}`));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (/Content Security Policy/i.test(message.text())) errors.push(message.text()); });
  return { context, page, errors };
}

const violations = (page) => page.evaluate(() => window.policyViolations);

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'real-viewer-home-'));
  env = { ...process.env, SEMANTIC_FLOW_HOME: home, SEMANTIC_VIEW_NO_OPEN: '1' };
  for (const review of Object.values(reviews)) review.port = await reservePort();
  const created = spawnSync(process.execPath, ['--import', 'tsx', fixtureScript, JSON.stringify({ home, reviews: Object.values(reviews) })], {
    cwd: scriptsRoot, encoding: 'utf8', env, timeout: 120_000,
  });
  expect(created.status, created.stderr).toBe(0);
  const roots = JSON.parse(created.stdout.trim().split('\n').at(-1));
  Object.values(reviews).forEach((review, index) => { review.root = roots[index]; });
  for (const review of Object.values(reviews)) review.launchUrl = launch(review);
});

test.afterAll(async () => {
  for (const review of Object.values(reviews)) await stop(review);
  for (const review of Object.values(reviews)) if (review.root) fs.rmSync(review.root, { recursive: true, force: true });
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

test('a launch link opens the review, leaves the address bar, and works once', async ({ browser }) => {
  const { context, page, errors } = await openPage(browser);
  await page.goto(reviews.a.launchUrl);
  await expect(page.getByRole('heading', { name: 'Review A', exact: true })).toBeVisible();
  expect(page.url()).toBe(reviews.a.base);
  expect(await page.evaluate(() => location.hash)).toBe('');
  // A reload of the same tab keeps working without the link.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Review A', exact: true })).toBeVisible();
  await expect(page.locator('#fresh-link-notice')).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);

  // The same link in another browser is spent.
  const other = await openPage(browser);
  await other.page.goto(reviews.a.launchUrl);
  await expect(other.page.locator('#fresh-link-notice')).toContainText(NOTICE);
  expect(other.page.url()).toBe(reviews.a.base);
  await expect(other.page.locator('.stage')).toHaveCount(0);
  expect(await violations(other.page)).toEqual([]);
  await other.context.close();
  await context.close();
});

test('a page opened without a key shows how to get a fresh link', async ({ browser }) => {
  const { context, page, errors } = await openPage(browser);
  await page.goto(reviews.a.base);
  await expect(page.locator('#fresh-link-notice')).toContainText(NOTICE);
  await expect(page.locator('#fresh-link-notice')).toContainText('Run the review command again');
  await expect(page.locator('.stage')).toHaveCount(0);
  await page.goto(`${reviews.a.base}#launch=not-a-code`);
  await expect(page.locator('#fresh-link-notice')).toContainText(NOTICE);
  expect(await page.evaluate(() => location.hash)).toBe('');
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

test('a Markdown image at the viewer\'s own address is refused while repository images load', async ({ browser }) => {
  const { context, page, errors } = await openPage(browser);
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(await freshLaunchUrl(reviews.a));
  await expect(page.getByRole('heading', { name: 'Review A', exact: true })).toBeVisible();
  await page.locator('.stage-title[data-id="implementation"]').click();
  const node = page.locator('details[data-node="implementation-change"]');
  if (!await node.evaluate((element) => element.open)) await node.locator('summary').click();
  const row = node.locator('.frow').filter({ hasText: 'guide.md' });
  await row.locator('.frow-open').click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.locator('.markdown-preview');
  await expect(preview.locator('h1')).toHaveText('Guide');
  const own = preview.locator('img[alt="Own address"]');
  await expect(own).not.toHaveAttribute('src', /./);
  const pixel = preview.locator('img[alt="Pixel"]');
  await expect(pixel).toHaveAttribute('src', /[?&]read=/);
  await expect.poll(() => pixel.evaluate((image) => image.complete && image.naturalWidth)).toBe(1);
  expect(requests.some((url) => url.endsWith('/api/whoami'))).toBe(false);
  // A link loads nothing until it is followed, so it keeps its target.
  await expect(preview.getByRole('link', { name: 'Own link' })).toHaveAttribute('href', reviews.a.base);
  // Without the read token the server refuses the same image.
  const tokenless = await pixel.evaluate((image) => { const url = new URL(image.src); url.searchParams.delete('read'); return url.href; });
  expect(await page.evaluate((src) => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve('loaded'); image.onerror = () => resolve('refused');
    image.src = src;
  }), tokenless)).toBe('refused');
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

test('another local page cannot read a viewer, and the review list opens a viewer on another port', async ({ browser }) => {
  const { context, page, errors } = await openPage(browser);
  await page.goto(await freshLaunchUrl(reviews.a));
  await expect(page.getByRole('heading', { name: 'Review A', exact: true })).toBeVisible();
  // Review B's viewer is another origin to this page.
  const crossOrigin = await page.evaluate(async (base) => {
    const read = await fetch(`${base}api/bootstrap`).then((response) => response.status, () => 'blocked');
    const script = await new Promise((resolve) => {
      const element = document.createElement('script');
      element.onload = () => resolve('loaded'); element.onerror = () => resolve('blocked');
      element.src = `${base}api/bootstrap`;
      document.body.append(element);
    });
    return { read, script };
  }, reviews.b.base);
  expect(crossOrigin).toEqual({ read: 'blocked', script: 'blocked' });
  expect((await violations(page)).every((entry) => entry.startsWith('connect-src') || entry.startsWith('script-src'))).toBe(true);
  await page.evaluate(() => { window.policyViolations = []; });

  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.locator(`[data-review="${record(reviews.b).id}"]`).getByRole('button', { name: 'Open review', exact: true }).click();
  await expect(page).toHaveURL(reviews.b.base);
  await expect(page.getByRole('heading', { name: 'Review B', exact: true })).toBeVisible();
  await expect(page.locator('#fresh-link-notice')).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
  expect(errors.filter((message) => !/Content Security Policy/i.test(message))).toEqual([]);
  await context.close();
});

test('a page whose viewer restarted asks for a fresh link, and a fresh link in the same tab works', async ({ browser }) => {
  const { context, page, errors } = await openPage(browser);
  await page.goto(await freshLaunchUrl(reviews.a));
  await expect(page.getByRole('heading', { name: 'Review A', exact: true })).toBeVisible();
  await stop(reviews.a);
  const relaunched = launch(reviews.a);
  // The open page's key belongs to the stopped viewer.
  await expect(page.locator('#fresh-link-notice')).toContainText(NOTICE, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Review A', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('#fresh-link-notice')).toContainText(NOTICE);
  // Opening the new link in this tab changes only the fragment.
  await page.goto(relaunched);
  await expect(page.getByRole('heading', { name: 'Review A', exact: true })).toBeVisible();
  await expect(page.locator('#fresh-link-notice')).toHaveCount(0);
  expect(page.url()).toBe(reviews.a.base);
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

/** Opens a launch link in the page; resolves when its code was redeemed or refused. */
async function openLink(page, url) {
  const exchanged = page.waitForResponse((response) => response.url().endsWith('/api/session'));
  await page.goto(url);
  return (await exchanged).status();
}

test('a spent link and then a fresh link in the same tab open the review', async ({ browser }) => {
  const { context, page, errors } = await openPage(browser);
  const spent = await freshLaunchUrl(reviews.a);
  await openLink(page, spent);
  await expect(page.getByRole('heading', { name: 'Review A', exact: true })).toBeVisible();
  await page.close();
  const tab = await context.newPage();
  expect(await openLink(tab, spent)).toBe(403);
  await expect(tab.locator('#fresh-link-notice')).toContainText(NOTICE);
  // The fresh link changes only the fragment of this tab.
  expect(await openLink(tab, await freshLaunchUrl(reviews.a))).toBe(200);
  await expect(tab.getByRole('heading', { name: 'Review A', exact: true })).toBeVisible();
  await expect(tab.locator('#fresh-link-notice')).toHaveCount(0);
  expect(tab.url()).toBe(reviews.a.base);
  expect(await violations(tab)).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

test('an old link opened in a working tab leaves the review working', async ({ browser }) => {
  const { context, page, errors } = await openPage(browser);
  const old = await freshLaunchUrl(reviews.a);
  await openLink(page, old);
  await expect(page.getByRole('heading', { name: 'Review A', exact: true })).toBeVisible();
  // In the same document, the old link changes only the fragment.
  expect(await openLink(page, old)).toBe(403);
  await expect(page.locator('#fresh-link-notice')).toHaveCount(0);
  const revision = page.waitForResponse((response) => response.url().includes('/api/revision') && response.status() === 200);
  await revision;
  // Loaded anew in the tab, it falls back to the access the tab keeps.
  await page.goto('about:blank');
  expect(await openLink(page, old)).toBe(403);
  await expect(page.getByRole('heading', { name: 'Review A', exact: true })).toBeVisible();
  await expect(page.locator('#fresh-link-notice')).toHaveCount(0);
  expect(page.url()).toBe(reviews.a.base);
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

/** Makes session storage of every page of the context unavailable. */
async function disableSessionStorage(context) {
  await context.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Storage is disabled.', 'SecurityError'); } });
  });
}

test('without session storage a fresh link from a restarted viewer keeps the review open in the same tab', async ({ browser }) => {
  const { context, page, errors } = await openPage(browser);
  await disableSessionStorage(context);
  await openLink(page, await freshLaunchUrl(reviews.a));
  await expect(page.getByRole('heading', { name: 'Review A', exact: true })).toBeVisible();
  await page.evaluate(() => { window.sameDocument = true; });
  const before = record(reviews.a).viewer.key;
  await stop(reviews.a);
  const relaunched = launch(reviews.a);
  expect(record(reviews.a).viewer.key).not.toBe(before);
  expect(await openLink(page, relaunched)).toBe(200);
  // The page keeps the new key in memory, as a reload would lose it, and the
  // restarted viewer accepts it.
  await page.waitForResponse((response) => response.url().includes('/api/revision') && response.status() === 200);
  expect(await page.evaluate(() => window.sameDocument)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Review A', exact: true })).toBeVisible();
  await expect(page.locator('#fresh-link-notice')).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

test('a page whose start failed because the viewer restarted starts with a fresh link', async ({ browser }) => {
  const { context, page, errors } = await openPage(browser);
  await disableSessionStorage(context);
  // The viewer restarts after the page loaded the review data and before it
  // loaded the saved review, which the restarted viewer refuses.
  let relaunched;
  await page.route('**/api/review-state**', async (route) => {
    if (!relaunched) {
      await stop(reviews.a);
      relaunched = launch(reviews.a);
    }
    await route.continue();
  });
  const refused = page.waitForResponse((response) => response.url().includes('/api/review-state') && response.status() === 403);
  await openLink(page, await freshLaunchUrl(reviews.a));
  await refused;
  await expect(page.locator('#fresh-link-notice')).toContainText(NOTICE);
  await expect(page.locator('.stage')).toHaveCount(0);
  await page.evaluate(() => { window.sameDocument = true; });
  expect(await openLink(page, relaunched)).toBe(200);
  await expect(page.getByRole('heading', { name: 'Review A', exact: true })).toBeVisible();
  await expect(page.locator('.stage')).not.toHaveCount(0);
  await expect(page.locator('#fresh-link-notice')).toHaveCount(0);
  await page.waitForResponse((response) => response.url().includes('/api/revision') && response.status() === 200);
  expect(await page.evaluate(() => window.sameDocument)).toBe(true);
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

/** A proxy at another port in front of a viewer, which passes requests on under
 * the names the viewer accepts. With `stall` set, it answers revision polls with
 * headers and the start of a body, and then sends nothing more. */
async function stallingProxy(review) {
  const target = new URL(review.base);
  const proxy = { stall: false, stalled: 0 };
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (proxy.stall && request.url.startsWith('/api/revision')) {
      proxy.stalled += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"ok":true,');
      return;
    }
    const headers = { ...request.headers, host: target.host };
    if (headers.origin) headers.origin = target.origin;
    const forwarded = http.request({ host: target.hostname, port: target.port, method: request.method, path: request.url, headers }, (answer) => {
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    });
    forwarded.on('error', () => response.destroy());
    request.pipe(forwarded);
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxy.base = `http://127.0.0.1:${server.address().port}/`;
  proxy.close = () => { for (const socket of sockets) socket.destroy(); server.close(); };
  return proxy;
}

test('polls whose answers stop after the headers count as the viewer being unreachable', async ({ browser }) => {
  const proxy = await stallingProxy(reviews.a);
  const { context, page, errors } = await openPage(browser);
  try {
    const link = new URL(await freshLaunchUrl(reviews.a));
    await openLink(page, `${proxy.base}${link.hash}`);
    await expect(page.getByRole('heading', { name: 'Review A', exact: true })).toBeVisible();
    await page.waitForResponse((response) => response.url().includes('/api/revision') && response.status() === 200);
    await expect(page.locator('#fresh-link-notice')).toHaveCount(0);
    proxy.stall = true;
    // Each poll gives up three seconds after it started; the third failure comes
    // more than five seconds after the first.
    await expect(page.locator('#fresh-link-notice')).toContainText(NOTICE, { timeout: 20_000 });
    expect(proxy.stalled).toBeGreaterThanOrEqual(3);
    await expect(page.getByRole('heading', { name: 'Review A', exact: true })).toBeVisible();
    expect(await violations(page)).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    proxy.close();
  }
});

test('a page from another local server cannot read the viewer, and the viewer refuses its requests', async ({ browser }) => {
  const other = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Other local page</title><p>Another local application.</p>');
  });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  const { context, page } = await openPage(browser);
  try {
    // The browser keeps blocked responses from the page and from Playwright's
    // response events; the DevTools protocol still reports what was sent and answered.
    const devtools = await context.newCDPSession(page);
    const sent = new Map(), headers = new Map(), answers = [];
    devtools.on('Network.requestWillBeSent', ({ requestId, request }) => sent.set(requestId, request.url));
    devtools.on('Network.requestWillBeSentExtraInfo', ({ requestId, headers: actual }) => headers.set(requestId, actual));
    devtools.on('Network.responseReceivedExtraInfo', ({ requestId, statusCode }) => answers.push({ requestId, statusCode }));
    await devtools.send('Network.enable');
    await page.goto(`http://127.0.0.1:${other.address().port}/`);
    const target = `${reviews.a.base}api/bootstrap`;
    const attempt = await page.evaluate(async (url) => {
      const read = await fetch(url).then((response) => response.status, () => 'blocked');
      const script = await new Promise((resolve) => {
        const element = document.createElement('script');
        element.onload = () => resolve('loaded'); element.onerror = () => resolve('blocked');
        element.src = url;
        document.body.append(element);
      });
      return { read, script };
    }, target);
    expect(attempt).toEqual({ read: 'blocked', script: 'blocked' });
    // Both requests reached the viewer, which refused them itself.
    const refusals = () => answers.filter(({ requestId }) => sent.get(requestId) === target).map(({ statusCode }) => statusCode);
    await expect.poll(refusals).toEqual([403, 403]);
    // The same requests are refused for where they come from even with the key.
    const { key } = record(reviews.a).viewer;
    for (const { requestId } of answers.filter(({ requestId }) => sent.get(requestId) === target)) {
      const browserHeaders = Object.fromEntries(Object.entries(headers.get(requestId)).filter(([name]) => !name.startsWith(':')));
      expect(browserHeaders['Sec-Fetch-Site'] ?? browserHeaders['sec-fetch-site']).toBe('same-site');
      const replayed = await new Promise((resolve, reject) => {
        http.get(target, { headers: { ...browserHeaders, [KEY_HEADER]: key } }, (response) => {
          let text = '';
          response.on('data', (chunk) => { text += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
        }).on('error', reject);
      });
      expect(replayed).toEqual({ status: 403, body: { ok: false, error: 'Only the review page can use this service.' } });
    }
  } finally {
    await context.close();
    other.close();
  }
});
