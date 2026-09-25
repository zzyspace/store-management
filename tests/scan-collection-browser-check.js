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
    await showQr(page, "FUZZY-100-9001"); await page.locator("#scanConfirmation").waitFor({ state: "visible" });
    // Freeze actual WAAPI animations for deterministic geometry and visual checks.
    await page.evaluate(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) { const a = animate.apply(this, args); a.pause(); return a; };
    });
    const start = await page.locator("#scanConfirmation").boundingBox();
    await page.locator("#scanConfirm").click();
    assert.equal(await page.locator("#scanConfirmedCount").innerText(), "1");
    assert.equal(await page.locator("#scanConfirmation").isVisible(), false);
    assert.equal(await page.locator(".scan-collection").count(), 1);
    const geometry = await page.evaluate(() => {
      const card = document.querySelector(".scan-collection"), a = card.getAnimations()[0];
      a.currentTime = 240;
      const r = card.getBoundingClientRect(), t = document.querySelector(".scan-count").getBoundingClientRect();
      a.currentTime = 75;
      return { rect: [r.x, r.y, r.width, r.height], target: [t.x, t.y, t.width, t.height], inert: card.inert, ids: card.querySelectorAll("[id]").length };
    });
    geometry.rect.forEach((value, i) => assert.ok(Math.abs(value - geometry.target[i]) < 1));
    assert.ok(start.y > geometry.target[1]); assert.equal(geometry.inert, true); assert.equal(geometry.ids, 0);
    await page.screenshot({ path: `outputs/scan-collection/mid-${width}.png` });
    // A new code must be confirmable while the previous animation is still paused.
    await showQr(page, "FUZZY-ZY-9002"); await page.locator("#scanConfirmation").waitFor({ state: "visible" });
    assert.equal(await page.locator(".scan-collection").count(), 0);
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
  assert.deepEqual(errors, []);
  console.log("PASS: target geometry at 3 widths, immediate count, continuous scanning, keyboard, reduced motion and close cleanup");
} finally { await browser.close(); await f.close(); }
