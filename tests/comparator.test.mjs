import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "_site");
const artifacts = resolve(process.env.COMPARATOR_ARTIFACT_DIR || resolve(output, "test-artifacts"));
const storageKey = "robot-comparator-be-v1";

async function loadPhotos(page) {
  await page.locator("img[data-photo-model]").evaluateAll(images => {
    images.forEach(image => { image.loading = "eager"; });
  });
  await page.waitForFunction(() => [...document.querySelectorAll("img[data-photo-model]")].every(image => image.complete), null, { timeout: 60000 });
  await page.locator("img[data-photo-model]").evaluateAll(async images => {
    await Promise.all(images.map(image => image.decode()));
    await new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)));
  });
  await page.waitForFunction(() => [...document.querySelectorAll(".photo-frame")].every(frame => frame.dataset.photoState === "loaded"));
  const photos = await page.locator("img[data-photo-model]").evaluateAll(images => images.map(image => ({
    id: image.dataset.photoModel,
    width: image.naturalWidth,
    height: image.naturalHeight,
    state: image.closest(".photo-frame").dataset.photoState,
    referrerPolicy: image.referrerPolicy
  })));
  assert.equal(photos.length, 26);
  assert.deepEqual(photos.filter(photo => !photo.width || !photo.height || photo.state !== "loaded"), [], "Every exact-model photo must decode with the real CSP");
  assert.ok(photos.every(photo => photo.referrerPolicy === "no-referrer"));
  assert.ok(photos.every(photo => photo.width <= 480 && photo.height <= 480), "Use real reduced-size CDN images, not ignored resize parameters");
  return photos;
}

async function click(page, selector) {
  await page.locator(selector).first().click();
}

async function noPageOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "Tables must scroll within their container, not the page");
}

async function swipe(page, x1, y1, x2, y2) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x1, y: y1 }] });
    for (let step = 1; step <= 8; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x1 + (x2 - x1) * step / 8, y: y1 + (y2 - y1) * step / 8 }] });
      await new Promise(resolveMove => setTimeout(resolveMove, 16));
    }
    await new Promise(resolveStop => setTimeout(resolveStop, 80));
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.detach();
  }
}

async function stickyComparison(page, width, touch, filename) {
  await page.setViewportSize({ width, height: width === 360 ? 740 : width < 600 ? 844 : 1100 });
  await click(page, '[data-nav="models"]');
  if (await page.evaluate(() => RobotComparator.getState().selected.length)) await click(page, '[data-act="clear-selection"]');
  for (const id of ["rr-edge2", "rr-flow", "dr-l50s", "dr-aqua"]) await click(page, `[data-select="${id}"]`);
  await click(page, '[data-nav="compare"]');
  if (await page.locator('[data-action-setting="differences"]').isChecked()) await page.locator('[data-action-setting="differences"]').uncheck();
  await click(page, ".comparison-section > details > summary");
  await page.evaluate(() => {
    const board = document.querySelector('[data-comparison="complete"]');
    const bar = document.querySelector(".topbar").getBoundingClientRect();
    window.scrollTo(0, board.getBoundingClientRect().top + window.scrollY - bar.height - 16);
  });
  const start = await page.evaluate(() => window.scrollY);
  const barBottom = await page.locator(".topbar").evaluate(bar => bar.getBoundingClientRect().bottom);
  const headHeight = await page.locator('.compare-complete .comparison-sticky').evaluate(header => header.getBoundingClientRect().height);
  if (touch) {
    await swipe(page, width / 2, 650, width / 2, barBottom + headHeight + 70);
  } else {
    await page.mouse.move(width / 2, barBottom + headHeight + 80);
    await page.mouse.wheel(0, 600);
  }
  await page.waitForFunction(previous => window.scrollY > previous + 150, start);
  const vertical = await page.evaluate(() => {
    const board = document.querySelector('[data-comparison="complete"]');
    const head = board.querySelector(".comparison-sticky").getBoundingClientRect();
    return { top: head.top, height: head.height, bar: document.querySelector(".topbar").getBoundingClientRect().bottom, innerScrollTop: board.querySelector("[data-compare-body]").scrollTop };
  });
  assert.ok(Math.abs(vertical.top - vertical.bar) < 1, `Sticky header must follow real page scroll at ${width}px: ${JSON.stringify(vertical)}`);
  assert.equal(vertical.innerScrollTop, 0, "The regression concerns document scrolling, not an artificial nested vertical scroll");
  if (width < 600) assert.ok(vertical.height <= 110, "Names must not consume the phone viewport");

  const body = page.locator('.compare-complete [data-compare-body]');
  const bodyBox = await body.boundingBox();
  const x = Math.min(width - 30, bodyBox.x + bodyBox.width / 2);
  const y = vertical.bar + vertical.height + 80;
  if (touch) await swipe(page, width - 25, y, 30, y);
  else { await page.mouse.move(x, y); await page.mouse.wheel(500, 0); }
  await page.waitForFunction(() => {
    const body = document.querySelector('.compare-complete [data-compare-body]');
    return body.scrollLeft > 5 && Math.abs(body.scrollWidth - body.clientWidth - body.scrollLeft) < 1;
  });
  await page.waitForFunction(() => {
    const board = document.querySelector('[data-comparison="complete"]');
    return Math.abs(board.querySelector("[data-compare-head]").scrollLeft - board.querySelector("[data-compare-body]").scrollLeft) < 1;
  });
  await page.waitForTimeout(180);
  const alignment = await page.evaluate(() => {
    const board = document.querySelector('[data-comparison="complete"]');
    const headings = [...board.querySelectorAll(".compare-heading-table th")];
    const cells = [...board.querySelector(".compare-data-table tbody tr:not(.group-row)").children];
    const viewport = board.querySelector("[data-compare-body]").getBoundingClientRect();
    const headerViewport = board.querySelector("[data-compare-head]").getBoundingClientRect();
    const visibleModels = headings.slice(1).map(heading => heading.getBoundingClientRect()).filter(rect => rect.left >= headings[0].getBoundingClientRect().right - 1 && rect.right <= headerViewport.right);
    return {
      errors: headings.map((heading, index) => Math.abs(heading.getBoundingClientRect().left - cells[index].getBoundingClientRect().left)),
      criterionLeft: cells[0].getBoundingClientRect().left,
      viewportLeft: viewport.left,
      names: headings.slice(1).map(heading => heading.innerText.trim()),
      unclippedNames: headings.slice(1).every(heading => { const name = heading.querySelector("button"); return name.scrollWidth <= name.clientWidth + 1 && name.scrollHeight <= name.clientHeight + 1; }),
      visibleCriteria: [...board.querySelectorAll(".compare-data-table th[scope=row]")].filter(cell => { const rect = cell.getBoundingClientRect(); return rect.bottom > headings[0].getBoundingClientRect().bottom && rect.top < innerHeight; }).map(cell => ({ left: cell.getBoundingClientRect().left, fits: cell.scrollWidth <= cell.clientWidth + 1, text: cell.textContent })),
      visibleModelColumns: visibleModels.length,
      frozenBoundaryGap: visibleModels[0]?.left - headings[0].getBoundingClientRect().right,
      scrollLeft: board.querySelector("[data-compare-body]").scrollLeft
    };
  });
  assert.ok(alignment.errors.every(error => error < 1), `Header and body columns must align at ${width}px: ${JSON.stringify(alignment)}`);
  assert.ok(Math.abs(alignment.criterionLeft - alignment.viewportLeft - 1) < 1, "The criterion column must remain frozen and readable");
  assert.ok(alignment.names.some(name => name.includes("Aqua10 Ultra Roller Complete")));
  assert.ok(alignment.unclippedNames, "Full model names and suffixes must not be clipped");
  assert.ok(alignment.visibleCriteria.length > 0);
  assert.ok(alignment.visibleCriteria.every(cell => cell.fits && Math.abs(cell.left - alignment.viewportLeft - 1) < 1), `Visible criterion labels must fit and stay frozen: ${JSON.stringify(alignment.visibleCriteria)}`);
  if (width < 600) {
    assert.ok(alignment.visibleModelColumns >= 2, "Two complete phone columns must fit beside the frozen criteria");
    assert.ok(Math.abs(alignment.frozenBoundaryGap) < 1, "Do not leave an unidentified partial-column strip beside the frozen criterion");
  }
  await noPageOverflow(page);
  await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
  await page.screenshot({ path: resolve(artifacts, filename), animations: "disabled" });

  const headY = vertical.bar + vertical.height / 2;
  if (touch) await swipe(page, 40, headY, width - 25, headY);
  else { await page.mouse.move(x, headY); await page.mouse.wheel(-500, 0); }
  await page.waitForFunction(previous => document.querySelector('.compare-complete [data-compare-body]').scrollLeft < previous - 2, alignment.scrollLeft);
  return { width, touch, pageScroll: await page.evaluate(() => window.scrollY), headerHeight: vertical.height, maximumAlignmentError: Math.max(...alignment.errors), names: alignment.names };
}

test("Dreame additions preserve exact variants, dated prices and offline comparison", { timeout: 120000 }, async () => {
  execFileSync(process.execPath, ["build.mjs", output], { cwd: root });
  const html = await readFile(resolve(output, "comparateur-aspirateurs.html"), "utf8");
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route("https://**/*", route => route.abort("internetdisconnected"));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => !!window.RobotComparator);
    const data = await page.evaluate(() => RobotComparator.getData());
    assert.equal(data.models.filter(model => model.id === "dr-l50s").length, 1, "Update the existing L50s rather than duplicate it");
    const l60 = data.models.find(model => model.id === "dr-l60ce");
    assert.equal(l60.tested, false);
    assert.equal(l60.frandroid.score, null, "Never transfer an adjacent L60's rating");
    assert.equal(l60.frandroid.checkedAt, "2026-11-21");
    assert.equal(data.models.find(model => model.id === "dr-l50s").frandroid.checkedAt, "2026-11-15", "Do not redatestamp the original research");
    assert.ok(l60.haConditional, "Do not inherit confirmed HACS support from the brand");
    assert.equal(l60.release.month, null, "The screenshot is not a launch date");
    assert.equal(l60.photo, undefined, "Do not use another L60 variant's photo");
    assert.ok(data.recommendations.some(item => item.id === "dr-l60ce"));
    assert.ok(data.recommendations.some(item => item.id === "dr-l50s"));
    assert.equal(await page.locator('[data-model-card="dr-l60ce"] .photo-missing').count(), 1);
    for (const [id, query] of [["dr-l50s", "L50s Pro Ultra-A"], ["dr-l60ce", "L60 Ultra CE"]]) {
      await page.locator("#search").fill(query);
      await page.waitForFunction(expected => RobotComparator.getFiltered().join() === expected, id);
      assert.match(await page.locator(`[data-model-card="${id}"]`).innerText(), /21 novembre 2026/);
      const offer = await page.evaluate(modelId => RobotComparator.bestOffer(modelId), id);
      assert.equal(offer.price + offer.shipping, 499);
      assert.equal(offer.level, "capture fournie");
      assert.equal(offer.seller, undefined);
      assert.match(offer.delivery, /Prime/);
      await click(page, `[data-select="${id}"]`);
    }
    await click(page, '[data-act="reset-filters"]');
    await page.locator('[data-setting="stretch"]').uncheck();
    await page.locator("#budget-number").fill("499");
    assert.ok(await page.evaluate(() => ["dr-l50s", "dr-l60ce"].every(id => RobotComparator.getFiltered().includes(id))));
    await page.locator("#budget-number").fill("498");
    assert.ok(await page.evaluate(() => ["dr-l50s", "dr-l60ce"].every(id => !RobotComparator.getFiltered().includes(id))));
    await click(page, '[data-act="reset-filters"]');
    await click(page, ".filter-details:has(#camera-filter) > summary");
    await page.locator("#camera-filter").selectOption("yes");
    assert.ok(!(await page.evaluate(() => RobotComparator.getFiltered())).includes("dr-l60ce"));
    await page.locator("#camera-filter").selectOption("no");
    assert.ok((await page.evaluate(() => RobotComparator.getFiltered())).includes("dr-l60ce"));
    await click(page, '[data-act="reset-filters"]');
    await page.locator('[data-setting="ha"]').selectOption("hacs");
    assert.ok(!(await page.evaluate(() => RobotComparator.getFiltered())).includes("dr-l60ce"));
    await click(page, '[data-act="reset-filters"]');
    await click(page, '[data-nav="compare"]');
    assert.equal(await page.locator(".compare-core [data-model=dr-l60ce]").count(), 2);
    assert.match(await page.locator(".compare-core").innerText(), /L50s Pro Ultra-A/);
    await noPageOverflow(page);
    await click(page, '.compare-core [data-model="dr-l60ce"]');
    await click(page, '.detail-page > details:has-text("Notre avis & les réserves") > summary');
    assert.match(await page.locator(".detail-page .disclosure-body .prose").innerText(), /pas mon premier choix/);
    assert.match(await page.locator(".detail-summary").innerText(), /21 novembre 2026/);
    await click(page, '.detail-page > details:has-text("Prix & offres") > summary');
    assert.match(await page.locator(".offer-table").innerText(), /Vendeur non relevé/);
    assert.match(await page.locator(".offer-table").innerText(), /RPL71FE0/);
    const markdown = await page.evaluate(() => RobotComparator.reportMarkdown());
    assert.match(markdown, /complément du \*\*21 novembre 2026\*\*/);
    assert.match(markdown, /L60 Ultra CE à 499 € : pas recommandé en priorité/);
    assert.match(markdown, /aucun test Frandroid du L60 Ultra CE exact repéré/);
    assert.match(markdown, /Les autres prix n'ont pas été actualisés/);
    await page.reload();
    await page.waitForFunction(() => !!window.RobotComparator);
    assert.deepEqual(await page.evaluate(() => RobotComparator.getState().selected), ["dr-l50s", "dr-l60ce"]);

    await mkdir(artifacts, { recursive: true });
    await stickyComparison(page, 1440, false, "dreame-update-desktop-sticky.png");
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mobile.route("https://**/*", route => route.abort("internetdisconnected"));
    const phone = await mobile.newPage();
    phone.on("pageerror", error => errors.push(error.message));
    await phone.goto(`http://127.0.0.1:${server.address().port}/`);
    await phone.waitForFunction(() => !!window.RobotComparator);
    await click(phone, '[data-select="dr-l50s"]');
    await click(phone, '[data-select="dr-l60ce"]');
    await click(phone, '[data-nav="compare"]');
    await noPageOverflow(phone);
    await click(phone, '.compare-core [data-model="dr-l60ce"]');
    await noPageOverflow(phone);
    await stickyComparison(phone, 390, true, "dreame-update-mobile-sticky-390.png");
    await stickyComparison(phone, 360, true, "dreame-update-mobile-sticky-360.png");
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  }
});

test("the comparator preserves research, works responsively and loads all 26 official photos", { timeout: 240000 }, async () => {
  execFileSync(process.execPath, ["build.mjs", output], { cwd: root });
  const html = await readFile(resolve(output, "comparateur-aspirateurs.html"), "utf8");
  const data = JSON.parse(html.match(/<script id="market-data"[^>]*>([\s\S]*?)<\/script>/u)[1]);
  const market = JSON.parse(await readFile(resolve(root, "market-data.json"), "utf8"));
  assert.equal(data.models.length, 27);
  assert.equal(data.sources.length, 156);
  assert.equal(data.reviewResearch.tested, 12);
  assert.equal(data.models.reduce((count, model) => count + model.offers.length, 0), 60);
  assert.deepEqual(data.models.map(model => model.offers), market.models.map(model => model.offers));
  assert.deepEqual([...new Set(data.models.map(model => model.mop))].sort(), ["rotatifs", "rouleau"]);
  assert.deepEqual(data.models.find(model => model.id === "dr-l40s").dock, [457, 340, 590]);
  assert.equal(data.models.find(model => model.id === "dr-l40s").dimState, "qualified");
  assert.equal(data.photoResearch.available, 26);
  assert.deepEqual(data.photoResearch.missing, ["dr-l60ce"]);
  assert.ok(Buffer.byteLength(html) < 450000, "Keep the application HTML below 450 KB");
  assert.ok(!html.includes("__IMAGE_HOSTS__"));
  assert.ok(!/(?:file:\/\/|C:\\Users\\|\.copilot)/i.test(html));
  const imageOrigins = [...new Set(data.models.filter(model => model.photo).map(model => new URL(model.photo.imageUrl).origin))].sort();
  const imagePolicy = html.match(/img-src ([^;]+);/u)[1].split(/\s+/).filter(value => value.startsWith("https:")).sort();
  assert.deepEqual(imagePolicy, imageOrigins);
  await mkdir(artifacts, { recursive: true });

  const server = createServer((request, response) => {
    if (!["/comparateur-aspirateurs/", "/comparateur-aspirateurs/index.html"].includes(request.url)) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/comparateur-aspirateurs/`;
  let browser;
  const report = { htmlBytes: Buffer.byteLength(html), imageOrigins, checks: [], photos: {} };
  const pass = name => report.checks.push(name);
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.platform === "win32" ? { channel: "msedge" } : {})
    });
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const page = await desktop.newPage();
    const pageErrors = [];
    const photoHeaders = [];
    const photoTransfers = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("request", request => {
      if (request.resourceType() === "image") photoHeaders.push(request.allHeaders());
    });
    const recordPhoto = response => {
      if (response.request().resourceType() === "image") photoTransfers.push(response.body().then(body => ({ url: response.url(), bytes: body.length })));
    };
    page.on("response", recordPhoto);
    await page.goto(url);
    await page.waitForFunction(() => !!window.RobotComparator);
    assert.equal(await page.locator(".robot-card").count(), 27);
    assert.ok(await page.locator("img[data-photo-model]").evaluateAll(images => images.every(image => image.loading === "lazy")));
    report.photos.desktop = await loadPhotos(page);
    page.off("response", recordPhoto);
    report.photoTransfers = await Promise.all(photoTransfers);
    assert.ok((await Promise.all(photoHeaders)).every(headers => !headers.referer));
    await noPageOverflow(page);
    pass("26 photos, exact-host CSP, deferred loading and no referrer");
    await page.screenshot({ path: resolve(artifacts, "desktop-inventory.png"), animations: "disabled" });

    const contactSheetStyle = await page.addStyleTag({ content: `
      .topbar,.sidebar,.page-heading,.snapshot,.tabs,footer,.result-head,.inventory-context,.disclosure,.card-top,.compact-price,.mini-specs,.ha-mark,.sensor-strip,.card-bottom,.buying-note,.risk-brief,.photo-origin,.photo-note { display:none!important }
      .shell { display:block } main { padding:12px } .card-grid { grid-template-columns:repeat(6,minmax(0,1fr));gap:8px }
      .robot-card { padding:8px } .card-photo { margin:0;padding:0 } .photo-frame { height:110px }
      .robot-card h3 { margin:8px 0 0 } .robot-card .name-button { font-size:12px } .brand { font-size:11px }
    ` });
    await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
    await page.screenshot({ path: resolve(artifacts, "photo-contact-sheet.png"), fullPage: true, animations: "disabled" });
    await contactSheetStyle.evaluate(style => style.remove());

    await page.locator("#search").fill("L40s");
    await page.waitForFunction(() => RobotComparator.getFiltered().length === 1);
    assert.deepEqual(await page.evaluate(() => RobotComparator.getFiltered()), ["dr-l40s"]);
    await click(page, '[data-act="reset-filters"]');
    await page.locator("#budget-number").fill("300");
    assert.ok((await page.locator("#content .badge.warning").allInnerTexts()).some(text => text.includes("budget")));
    await click(page, '[data-act="reset-filters"]');
    pass("Search and reset without pagination");
    await click(page, ".filter-details:has(#camera-filter) > summary");
    await page.locator("#camera-filter").selectOption("yes");
    assert.ok(await page.evaluate(() => RobotComparator.getFiltered().every(id => RobotComparator.getData().models.find(model => model.id === id).camera === true)));
    await page.locator("#remote-camera-filter").selectOption("yes");
    assert.ok(await page.evaluate(() => RobotComparator.getFiltered().every(id => RobotComparator.getData().models.find(model => model.id === id).remoteCamera.available === true)));
    await page.locator('[data-setting="frandroidOnly"]').check();
    assert.ok(await page.evaluate(() => RobotComparator.getFiltered().every(id => RobotComparator.getData().models.find(model => model.id === id).frandroid.status === "tested")));
    await click(page, '[data-act="reset-filters"]');
    pass("RGB, remote video and exact Frandroid filters remain distinct");

    await click(page, '[data-select="rr-10r"]');
    await click(page, '[data-select="dr-l40s"]');
    await click(page, '[data-nav="compare"]');
    assert.equal(await page.locator(".compare-core [data-compare-body] img").count(), 2);
    assert.equal(await page.locator(".compare-core tbody > tr").count(), 12);
    assert.equal(await page.locator(".comparison-section > details[open]").count(), 0);
    assert.ok((await page.locator(".comparison-section").innerText()).includes("Vidéo de l'app ≠ vidéo dans Home Assistant"));
    await noPageOverflow(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: resolve(artifacts, "desktop-compare.png"), animations: "disabled" });
    await click(page, ".comparison-section > details > summary");
    assert.ok(await page.locator(".compare-complete tbody > tr").count() > 45);
    assert.ok((await page.locator(".compare-complete").innerText()).includes("Date de sortie (mois et année)"));
    await page.locator('[data-action-setting="differences"]').check();
    assert.equal(await page.locator(".compare-complete .same-row").count(), 0);
    pass("Compact photo comparison, complete research and differences filter");

    await click(page, '.compare-core [data-model="dr-l40s"]');
    assert.equal(await page.locator(".detail-page > details[open]").count(), 0);
    assert.ok((await page.locator(".detail-facts").innerText()).includes("45,7 × 34 × 59"));
    assert.ok(!(await page.locator(".detail-summary").innerText()).includes("cotes à confirmer"));
    assert.ok((await page.locator(".detail-summary").innerText()).includes("7 janvier"));
    await noPageOverflow(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: resolve(artifacts, "desktop-detail.png"), animations: "disabled" });
    await click(page, '.detail-page > details:has-text("Prix & offres") > summary');
    await page.locator(".personal-price > summary").click();
    assert.equal(await page.locator("#personal-form").count(), 1);
    await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
    assert.equal(await page.locator("#content details:not([open])").count(), 0);
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    pass("Progressive details, accepted L40s dimensions, delivery warning and full print");

    for (const view of ["ranges", "sizes", "offers", "analysis", "ha", "sources"]) {
      await click(page, `[data-nav="${view}"]`);
      assert.equal(await page.evaluate(() => RobotComparator.getState().view), view);
      assert.ok((await page.locator("#content").innerText()).length > 100);
    }
    await click(page, '#content details:has-text("Photos & crédits") > summary');
    assert.equal(await page.locator(".photo-credits-list > li").count(), 26);
    assert.ok(await page.evaluate(() => RobotComparator.reportMarkdown().includes("## Sources documentées")));
    pass("All secondary tools, source credits and Markdown export");

    await page.evaluate(key => {
      const legacy = RobotComparator.getState();
      Object.assign(legacy, { view: "models", cards: false, q: "", budget: 501, selected: ["dr-l40s"] });
      delete legacy.remoteCamera;
      delete legacy.frandroidOnly;
      delete legacy.rangeBrand;
      legacy.overrides = { "dr-l40s": { price: 523, shipping: 2, be: true, shop: "Test local fictif", note: "", url: "", at: "2026-11-15T12:00:00Z" } };
      localStorage.setItem(key, JSON.stringify(legacy));
    }, storageKey);
    await page.reload();
    await page.waitForFunction(() => !!window.RobotComparator);
    assert.deepEqual(await page.evaluate(() => {
      const state = RobotComparator.getState();
      return { version: state.version, cards: state.cards, budget: state.budget, selected: state.selected, remoteCamera: state.remoteCamera, frandroidOnly: state.frandroidOnly, price: RobotComparator.bestOffer("dr-l40s").price };
    }), { version: 1, cards: false, budget: 501, selected: ["dr-l40s"], remoteCamera: "", frandroidOnly: false, price: 523 });
    assert.equal(await page.locator(".models-table img").count(), 26);
    await page.evaluate(key => localStorage.removeItem(key), storageKey);
    pass("Version-1 imports, saved list view and local personal prices");

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const phone = await mobile.newPage();
    phone.on("pageerror", error => pageErrors.push(error.message));
    await phone.goto(url);
    await phone.waitForFunction(() => !!window.RobotComparator);
    report.photos.mobile = await loadPhotos(phone);
    assert.equal(await phone.locator("#filter-panel[open]").count(), 0);
    await noPageOverflow(phone);
    await phone.screenshot({ path: resolve(artifacts, "mobile-inventory.png"), animations: "disabled" });
    await click(phone, "#filter-panel > summary");
    await phone.locator("#search").fill("L40s");
    await phone.waitForFunction(() => RobotComparator.getFiltered().length === 1);
    await click(phone, '[data-act="reset-filters"]');
    await click(phone, "#filter-panel > summary");
    await click(phone, '[data-select="rr-10r"]');
    await click(phone, '[data-select="dr-l40s"]');
    await click(phone, '[data-nav="compare"]');
    await noPageOverflow(phone);
    await phone.evaluate(() => window.scrollTo(0, 0));
    await phone.screenshot({ path: resolve(artifacts, "mobile-compare.png"), animations: "disabled" });
    await click(phone, '.compare-core [data-model="dr-l40s"]');
    await noPageOverflow(phone);
    await phone.evaluate(() => window.scrollTo(0, 0));
    await phone.screenshot({ path: resolve(artifacts, "mobile-detail.png"), animations: "disabled" });
    pass("390px mobile filters, all 26 photos, comparison and details");
    report.sticky = [
      await stickyComparison(page, 1440, false, "desktop-sticky-comparison.png"),
      await stickyComparison(phone, 390, true, "mobile-sticky-comparison-390.png"),
      await stickyComparison(phone, 360, true, "mobile-sticky-comparison-360.png")
    ];
    pass("Real document wheel/touch scrolling and synchronized columns at desktop, 390px and 360px");

    const disconnected = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await disconnected.route("https://**/*", route => route.abort("internetdisconnected"));
    const offline = await disconnected.newPage();
    await offline.goto(url);
    await offline.waitForFunction(() => !!window.RobotComparator);
    await offline.locator("img[data-photo-model]").evaluateAll(images => images.forEach(image => { image.loading = "eager"; }));
    await offline.waitForFunction(() => [...document.querySelectorAll(".photo-frame")].every(frame => frame.dataset.photoState === "error"));
    assert.equal(await offline.locator(".photo-status[role=img]").count(), 26);
    assert.equal(await offline.evaluate(() => RobotComparator.getFiltered().length), 27);
    assert.equal(await offline.evaluate(() => RobotComparator.getData().sources.length), 156);
    pass("Explicit photo failures without blocking offline comparison data");

    assert.deepEqual(pageErrors, []);
    await writeFile(resolve(artifacts, "validation.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ checks: report.checks.length, desktopPhotos: report.photos.desktop.length, mobilePhotos: report.photos.mobile.length, htmlBytes: report.htmlBytes, photoBytes: report.photoTransfers.reduce((sum, photo) => sum + photo.bytes, 0), sticky: report.sticky.map(({ width, maximumAlignmentError }) => ({ width, maximumAlignmentError })), screenshots: 10 }));
  } finally {
    if (browser) await browser.close();
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  }
});
