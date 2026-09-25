import assert from "node:assert/strict";
import fs from "node:fs";
import { fixture } from "./integration-fixture.js";
import { installCamera, openIssueScanner, showQr } from "./scanner-browser-fixture.js";
const { chromium } = await import(process.env.STORE_PLAYWRIGHT_MODULE || "playwright");
const f = await fixture();
const browser = await chromium.launch({ headless: true, ...(process.env.STORE_CHROME_PATH ? { executablePath: process.env.STORE_CHROME_PATH } : {}) });
try {
  const context = await browser.newContext(); await installCamera(context);
  await context.addCookies([{ name: "admin_session", value: f.cookies.manager.split("=")[1], url: f.base }]);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  fs.mkdirSync("outputs/scan-collection", { recursive: true });
  for (const width of [390, 1440, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
    await page.goto(f.base + "/store"); await page.locator("#issueOpen").click(); await openIssueScanner(page);
    const cameraBefore = await page.locator(".camera-stage").boundingBox();
    await showQr(page, "FUZZY-100-9001"); await page.locator("#scanConfirmation").waitFor({ state: "visible" });
    // Freeze actual WAAPI animations for deterministic geometry and visual checks.
    await page.evaluate(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) { const a = animate.apply(this, args); a.pause(); return a; };
    });
    await page.screenshot({ path: `outputs/scan-collection/confirm-${width}.png` });
    const start = await page.locator("#scanConfirmation").boundingBox();
    assert.deepEqual(await page.locator(".camera-stage").boundingBox(), cameraBefore);
    await page.locator("#scanConfirm").click();
    assert.equal(await page.locator("#scanConfirmedCount").innerText(), "1");
    assert.deepEqual(await page.locator(".camera-stage").boundingBox(), cameraBefore);
    assert.equal(await page.locator("#scanConfirmation").isVisible(), false);
    assert.equal(await page.locator(".scan-collection").count(), 1);
    const geometry = await page.evaluate(() => {
      const card = document.querySelector(".scan-collection"), a = card.getAnimations()[0];
      const duration = a.effect.getTiming().duration;
      a.currentTime = 400;
      const r = card.getBoundingClientRect(), t = document.querySelector(".scan-count").getBoundingClientRect();
      a.currentTime = 120;
      for (const child of card.children) for (const animation of child.getAnimations()) animation.currentTime = 80;
      return { duration, contentsHidden: [...card.children].every(child => getComputedStyle(child).opacity === "0"), rect: [r.x, r.y, r.width, r.height], target: [t.x, t.y, t.width, t.height], inert: card.inert, ids: card.querySelectorAll("[id]").length };
    });
    assert.equal(geometry.duration, 400);
    assert.ok(geometry.contentsHidden);
    assert.ok(Math.abs(geometry.rect[0] + geometry.rect[2] / 2 - geometry.target[0] - geometry.target[2] / 2) < 1);
    assert.ok(Math.abs(geometry.rect[1] + geometry.rect[3] / 2 - geometry.target[1] - geometry.target[3] / 2) < 1);
    assert.ok(Math.abs(geometry.rect[2] / geometry.rect[3] - start.width / start.height) < .01);
    assert.ok(start.y > geometry.target[1]); assert.equal(geometry.inert, true); assert.equal(geometry.ids, 0);
    await page.screenshot({ path: `outputs/scan-collection/mid-${width}.png` });
    const receipt = await page.locator(".scan-count-receipt").evaluate(node => {
      const animation = node.getAnimations()[0], timing = animation.effect.getTiming();
      animation.currentTime = 310;
      return { duration: timing.duration, delay: timing.delay, opacity: Number(getComputedStyle(node).opacity) };
    });
    assert.equal(receipt.duration, 120); assert.equal(receipt.delay, 280); assert.ok(receipt.opacity > .8);
    // A new code must be confirmable while the previous animation is still paused.
    await showQr(page, "FUZZY-ZY-9002"); await page.locator("#scanConfirmation").waitFor({ state: "visible" });
    assert.equal(await page.locator(".scan-collection").count(), 1, "interrupted card fades from its current position");
    assert.equal(await page.locator(".scan-count-receipt").count(), 0);
    await page.locator(".scan-collection").evaluate(card => card.getAnimations().forEach(a => a.finish()));
    await page.locator(".scan-collection").waitFor({ state: "detached" });
    await page.locator("#scanConfirm").press("Enter");
    assert.equal(await page.locator(".scan-collection").count(), 0);
    assert.equal(await page.locator("#scanConfirmedCount").innerText(), "2");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await showQr(page, "FUZZY-ZY-9003"); await page.locator("#scanConfirmation").waitFor({ state: "visible" });
    await page.locator("#scanConfirm").click();
    const keyframes = await page.locator(".scan-collection").evaluate(card => card.getAnimations()[0].effect.getKeyframes());
    assert.ok(keyframes.every(frame => !("transform" in frame)));
    await page.locator("#scanEnd").click();
    assert.equal(await page.locator(".scan-collection").count(), 0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
  // Let the unmodified animation run to completion: it must leave no visual copies.
  await page.goto(f.base + "/store"); await page.locator("#issueOpen").click(); await openIssueScanner(page);
  await showQr(page, "FUZZY-100-9001"); await page.locator("#scanConfirmation").waitFor({ state: "visible" });
  await page.locator("#scanConfirm").click();
  await page.waitForFunction(() => document.querySelectorAll(".scan-collection, .scan-count-receipt").length === 0);
  assert.equal(await page.locator("#scanConfirmedCount").innerText(), "1");
  assert.deepEqual(errors, []);
  console.log("PASS: 400ms motion, uniform scale, stable camera, content fade, continuous scanning, soft interruption, keyboard, reduced motion and close cleanup");
} finally { await browser.close(); await f.close(); }
