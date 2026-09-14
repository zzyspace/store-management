import assert from "node:assert/strict";
import { showQr, scanAndConfirm } from "./scanner-browser-fixture.js";

export async function checkScanner({ page, f, checkSize }) {
  const form = page.locator("#issueForm");
  await page.locator("#issueOpen").click();
  await form.locator('[name="reason"]').fill("连续扫码批量赠送");
  await page.evaluate(() => {
    const decode = window.jsQR;
    window.decodeCalls = 0;
    window.jsQR = (...args) => { window.decodeCalls++; return decode(...args); };
    window.cameraCallsBefore = window.testCamera.calls;
  });
  await page.locator("#scanOpen").click();
  await showQr(page, "FUZZY-100-9001");
  await page.locator("#scanConfirmation").getByText("FUZZY-100-9001", { exact: true }).waitFor();
  const before = await page.evaluate(() => ({ calls: window.decodeCalls, time: document.getElementById("scanVideo").currentTime, track: document.getElementById("scanVideo").srcObject.getVideoTracks()[0].id }));
  await page.waitForTimeout(650);
  const after = await page.evaluate(() => ({ calls: window.decodeCalls, time: document.getElementById("scanVideo").currentTime, track: document.getElementById("scanVideo").srcObject.getVideoTracks()[0].id, ready: document.getElementById("scanVideo").srcObject.getVideoTracks()[0].readyState }));
  assert.equal(before.calls, after.calls, "decoding pauses during confirmation");
  assert.ok(after.time > before.time, "video keeps playing during confirmation");
  assert.equal(before.track, after.track); assert.equal(after.ready, "live");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }, theme);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : width === 390 ? 844 : 640 });
      await checkSize(`scanner-confirm-${theme}-${width}`, width);
      const rect = await page.locator("#scanConfirmation").boundingBox();
      assert.ok(rect.x >= 0 && rect.x + rect.width <= width);
      assert.ok(await page.locator("#scanConfirm").isVisible());
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#scanCancel").click();
  await page.waitForTimeout(650);
  assert.equal(await page.locator("#scanConfirmation").isVisible(), false, "cancelled stationary QR does not reopen");
  await showQr(page, null); await page.waitForTimeout(650);
  await scanAndConfirm(page, "FUZZY-100-9001");
  await scanAndConfirm(page, "FUZZY-ZY-9002");
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#scanConfirmedCount").innerText(), "2");
  assert.equal(await page.locator("#scanConfirmation").isVisible(), false);
  await showQr(page, "PEANUT-ZY-9001");
  await page.waitForFunction(() => document.getElementById("scanStatus").textContent.includes("不符"));
  await showQr(page, "NOT-A-COUPON");
  await page.waitForFunction(() => document.getElementById("scanStatus").textContent.includes("格式无效"));
  await scanAndConfirm(page, "FUZZY-ZY-9003");
  assert.equal(await page.evaluate(() => window.testCamera.calls - window.cameraCallsBefore), 1);
  assert.equal(await page.evaluate(() => window.testCamera.constraints.at(-1).video.facingMode.ideal), "environment");
  await checkSize("scanner-ready-dark-390", 390);
  await page.locator("#scanEnd").click();
  assert.equal(await page.evaluate(() => window.testCamera.tracks.every((track) => track.readyState === "ended")), true);
  assert.equal(await form.locator('[name="reason"]').inputValue(), "连续扫码批量赠送");
  assert.equal(await page.locator("#scannedCodes input, #scannedCodes textarea").count(), 0);
  await page.getByRole("button", { name: "移除 FUZZY-ZY-9003", exact: true }).click();
  assert.equal(await page.locator("#scannedCodes li").count(), 2);
  await page.locator("#scanOpen").click(); await scanAndConfirm(page, "FUZZY-ZY-9003"); await page.locator("#scanEnd").click();
  assert.equal(await page.locator("#scannedCodes li").count(), 3);
  assert.equal(await page.evaluate(() => window.testCamera.calls - window.cameraCallsBefore), 2);
  await checkSize("batch-issue-dark-390", 390);

  const bodies = [];
  await page.route("**/store/api/coupons/batch", async (route) => {
    bodies.push(route.request().postDataJSON());
    const response = await route.fetch();
    // Server commits, but client loses the reply. Retry must replay the saved result.
    if (bodies.length === 1) await route.abort("failed");
    else await route.fulfill({ response });
  });
  await page.locator("#issueSubmit").click();
  await page.getByRole("button", { name: "重试发放", exact: true }).waitFor();
  assert.equal(await form.locator('[name="reason"]').isDisabled(), true);
  assert.equal(await page.locator("#scanOpen").isDisabled(), true);
  await page.locator("#issueSubmit").click();
  await page.waitForFunction(() => document.getElementById("issueStatus").textContent.includes("2 张") && document.getElementById("issueStatus").textContent.includes("1 张失败"));
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(await page.locator("#issueDialog").isVisible(), true);
  assert.equal(await page.locator("#scannedCodes li").count(), 1);
  assert.match(await page.locator("#scannedCodes").innerText(), /FUZZY-100-9001.*已存在/s);
  assert.equal(f.repository.list("fuzzy", 1).items.filter((item) => ["FUZZY-ZY-9002", "FUZZY-ZY-9003"].includes(item.code)).length, 2);
  await checkSize("batch-partial-dark-390", 390);
  await page.getByRole("button", { name: "移除 FUZZY-100-9001", exact: true }).click();
  await page.locator("#scanOpen").click(); await scanAndConfirm(page, "FUZZY-ZY-9004"); await page.locator("#scanEnd").click();
  await page.locator("#issueSubmit").click();
  await page.locator("#issueDialog").waitFor({ state: "hidden" });
  await page.locator("#couponRows").getByText("FUZZY-ZY-9004", { exact: true }).waitFor();
  assert.notEqual(bodies[2].requestId, bodies[0].requestId);
  assert.deepEqual(bodies[2].codes, ["FUZZY-ZY-9004"]);
  await page.unroute("**/store/api/coupons/batch");

  // Permission failure, interrupted device, and a late permission grant after closing.
  await page.locator("#issueOpen").click();
  await page.evaluate(() => { window.testCamera.error = "NotAllowedError"; window.testCamera.draw(null); });
  await page.locator("#scanOpen").click();
  await page.locator("#scanRetry").waitFor();
  assert.match(await page.locator("#scanStatus").innerText(), /权限/);
  await page.evaluate(() => { window.testCamera.error = null; });
  await page.locator("#scanRetry").click(); await scanAndConfirm(page, "FUZZY-ZY-9002");
  await page.evaluate(() => { document.getElementById("scanVideo").srcObject.getVideoTracks()[0].dispatchEvent(new Event("ended")); });
  await page.locator("#scanRetry").waitFor();
  assert.equal(await page.locator("#scanConfirmedCount").innerText(), "1");
  await page.locator("#scanEnd").click();
  await page.evaluate(() => { window.testCamera.defer = true; });
  await page.locator("#scanOpen").click();
  await page.waitForFunction(() => typeof window.testCamera.resolveStart === "function");
  await page.locator("#scanEnd").click();
  await page.evaluate(() => { window.testCamera.resolveStart(); window.testCamera.defer = false; });
  await page.waitForFunction(() => window.testCamera.tracks.every((track) => track.readyState === "ended"));
  assert.equal(await page.locator("#scannedCodes li").count(), 1);
  await page.locator('#issueDialog [data-close]').first().click();
  await page.locator("#issueOpen").click();
  assert.equal(await page.locator("#scannedCodes li").count(), 0, "closing issuance discards draft");
  await page.locator("#scanOpen").click();
  await page.waitForFunction(() => document.getElementById("scanVideo").srcObject !== null);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  assert.equal(await page.locator("#scanDialog").isVisible(), false);
  assert.equal(await page.evaluate(() => window.testCamera.tracks.every((track) => track.readyState === "ended")), true);
  await page.locator("#scanOpen").click();
  await page.waitForFunction(() => document.getElementById("scanVideo").srcObject !== null);
  await page.route("**/store/api/coupons?**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ success: false, error: { message: "登录已失效" } }) }));
  // Trigger the existing list request while the scanner is open to observe a 401.
  await page.evaluate(() => { const select = document.getElementById("storeSelect"); select.dispatchEvent(new Event("change")); });
  await page.locator("#scanDialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.testCamera.tracks.every((track) => track.readyState === "ended")), true);
  await page.unroute("**/store/api/coupons?**");
  await page.goto(f.base + "/store");
  await page.locator("#couponRows").getByText("FUZZY-100-9001", { exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
}
