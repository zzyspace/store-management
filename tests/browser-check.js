import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./integration-fixture.js";

const { chromium } = await import(process.env.STORE_PLAYWRIGHT_MODULE || "playwright");
const f = await fixture();
const browser = await chromium.launch({ ...(process.env.STORE_CHROME_PATH ? { executablePath: process.env.STORE_CHROME_PATH } : {}), headless: true });
const output = path.resolve(process.env.STORE_BROWSER_OUTPUT || "outputs/browser-check"); fs.mkdirSync(output, { recursive: true });
const errors = [], measurements = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "America/Los_Angeles" });
const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
async function loginAs(role) { await context.clearCookies(); await context.addCookies([{ name: "admin_session", value: f.cookies[role].split("=")[1], url: f.base }]); }
const seed = { type: "cash_100", reason: "周年活动回馈老客", operator: "测试操作人", issuedAt: Date.parse("2026-09-09T14:20:00+08:00") };
for (const [store, code, type] of [["fuzzy", "FZ-20260909-001", "cash_100"], ["fuzzy", "FZ-20260909-002", "free_drink"], ["peanut", "PN-20260909-001", "free_drink"]]) f.repository.issue(store, { ...seed, code, type }, "fixture");
f.repository.redeem(2, "fuzzy", "fixture");

async function checkSize(label, width) {
  const size = await page.evaluate(() => {
    const rect = (selector) => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null; };
    return { viewport: innerWidth, viewportHeight: innerHeight, scroll: document.documentElement.scrollWidth, topbar: rect(".topbar"), table: rect(".table-scroll"), dialog: rect("dialog[open]") };
  });
  assert.ok(size.scroll <= width, `${label} page overflows: ${JSON.stringify(size)}`);
  if (size.dialog) assert.ok(size.dialog.left >= 0 && size.dialog.right <= width && size.dialog.top >= 0 && size.dialog.bottom <= size.viewportHeight);
  measurements.push({ label, ...size });
  await page.screenshot({ path: path.join(output, `${label}.png`), fullPage: true });
}

try {
  await loginAs("admin"); await page.goto(f.base + "/store");
  await page.getByText("FZ-20260909-001", { exact: true }).waitFor();
  assert.equal(await page.title(), "门店管理");
  assert.equal(await page.locator("#centerSwitcherTrigger").isDisabled(), true);
  assert.equal(await page.locator("#centerSwitcherChevron").isVisible(), false);
  assert.equal(await page.locator("#storeSelect option").count(), 3);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }, theme);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width >= 760 ? 1000 : width === 390 ? 844 : 640 });
      await checkSize(`coupons-${theme}-${width}`, width);
      await page.locator("#issueOpen").click();
      const form = page.locator("#issueForm");
      assert.equal(await form.locator('[name="operator"]').inputValue(), "测试admin");
      const issuedAt = await form.locator('[name="issuedAt"]').inputValue();
      assert.ok(Math.abs(Date.parse(issuedAt + "+08:00") - Date.now()) < 61000, "defaults to Shanghai time even on a foreign-timezone browser");
      await checkSize(`issue-${theme}-${width}`, width);
      await page.locator('#issueDialog [data-close]').first().click();
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#issueOpen").click();
  const form = page.locator("#issueForm");
  await form.locator('[name="type"]').selectOption("cash_100");
  await form.locator('[name="code"]').fill("BROWSER-001");
  await page.locator("#issueSubmit").click();
  assert.equal(await form.locator('[name="reason"]').evaluate((input) => input.validity.valueMissing), true);
  await form.locator('[name="reason"]').fill("   "); await page.locator("#issueSubmit").click();
  assert.equal(await form.locator('[name="reason"]').evaluate((input) => input.validity.customError), true);
  await form.locator('[name="reason"]').fill("浏览器验收赠送");
  await form.locator('[name="operator"]').fill("指定操作人");
  await page.locator("#issueSubmit").click();
  await page.getByText("BROWSER-001", { exact: true }).waitFor();
  const row = page.locator("#couponRows tr").filter({ hasText: "BROWSER-001" });
  assert.match(await row.innerText(), /指定操作人/);
  await row.getByRole("button", { name: "核销", exact: true }).click();
  await checkSize("redeem-confirmation", 1440);
  await page.locator("#redeemSubmit").click();
  await page.waitForFunction(() => [...document.querySelectorAll("#couponRows tr")].some((row) => row.textContent.includes("BROWSER-001") && row.textContent.includes("已核销")));
  assert.equal(await row.locator("button").count(), 0);

  // Release an older store response after a newer selection has already rendered.
  await page.locator("#storeSelect").selectOption("peanut"); await page.getByText("PN-20260909-001", { exact: true }).waitFor();
  let release, started;
  const delay = new Promise((resolve) => { release = resolve; }), pending = new Promise((resolve) => { started = resolve; });
  await page.route("**/store/api/coupons?store=fuzzy&*", async (route) => { const response = await route.fetch(); started(); await delay; await route.fulfill({ response }); });
  await page.locator("#storeSelect").selectOption("fuzzy"); await pending;
  await page.locator("#storeSelect").selectOption("peanut"); await page.getByText("PN-20260909-001", { exact: true }).waitFor();
  const stale = page.waitForResponse((response) => response.url().includes("coupons?store=fuzzy")); release(); await stale;
  await page.waitForTimeout(100);
  assert.equal(await page.getByText("FZ-20260909-001", { exact: true }).count(), 0);
  assert.equal(await page.locator("#storeSelect").inputValue(), "peanut"); await page.unrouteAll();

  await loginAs("manager"); await page.goto(f.base + "/store"); await page.getByText("BROWSER-001", { exact: true }).waitFor();
  assert.equal(await page.locator("#storeSelect").isDisabled(), true);
  assert.equal(await page.locator("#storeSelect option").count(), 1);
  await loginAs("partner"); await page.goto(f.base + "/store"); await page.getByText("BROWSER-001", { exact: true }).waitFor();
  assert.equal(await page.locator("#issueOpen").isVisible(), false); assert.equal(await page.locator(".redeem-button").count(), 0);

  // Exercise the real account management form and its per-role scope controls.
  await loginAs("owner"); await page.goto(f.base + "/auth/accounts?account=manager");
  const access = page.locator('form[data-app="store"]');
  await access.locator('[name="role"]').selectOption("partner");
  assert.equal(await access.locator('[name="viewStores"]:checked').count(), 3);
  assert.equal(await access.locator('[name="viewStores"]:disabled').count(), 3);
  await access.locator('[name="role"]').selectOption("manager");
  await access.locator('[name="viewStores"][value="fuzzy_qz"]').uncheck();
  await access.locator('[name="viewStores"][value="peanut"]').uncheck();
  await access.locator('[name="permissions"][value="coupon:redeem"]').uncheck();
  await access.getByRole("button", { name: "保存门店管理权限", exact: true }).click();
  await page.waitForLoadState("load");
  assert.deepEqual(f.accounts.getAccess("manager", "store").config.viewScope.stores, ["fuzzy"]);
  assert.deepEqual(f.accounts.getAccess("manager", "store").permissions, ["coupon:issue", "coupon:view"]);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width >= 760 ? 1000 : width === 390 ? 844 : 640 });
    if (width === 390) await access.locator(".section-toggle").click();
    await checkSize(`account-store-${width}`, width);
  }
  // New grant/version requires login again; verify the actual password flow returns to /store.
  await context.clearCookies(); await page.goto(f.base + "/login?returnTo=/store");
  await page.locator("#username").fill("manager"); await page.locator("#password").fill("local-fixture-password");
  await page.getByRole("button", { name: "登录", exact: true }).click(); await page.waitForURL("**/store");
  await page.getByText("BROWSER-001", { exact: true }).waitFor();
  // Verify actual SVG visibility and shared icon appearance for a switchable account.
  f.grant("owner", "admin", "all");
  for (const [app, permission] of [["invoice", "submission:view"], ["staff", "employee:view"], ["expense", "report:view"]]) {
    f.accounts.putAccess({ accountId: "owner", app, role: "admin", permissions: [permission], config: { viewScope: { ownership: "any", stores: "all", ...(app === "expense" ? { channels: "all" } : {}) } } }, { actor: "fixture", expectedVersion: 0 });
  }
  f.cookies.owner = `admin_session=${f.sessions.login("owner", "local-fixture-password").token}`;
  await loginAs("owner"); await page.goto(f.base + "/store");
  await page.waitForFunction(() => !document.getElementById("centerSwitcherTrigger").disabled);
  assert.equal(await page.locator("#centerSwitcherChevron").isVisible(), true);
  assert.equal(await page.locator("#centerSwitcherChevron").getAttribute("hidden"), null);
  const reference = fs.readFileSync(path.resolve(import.meta.dirname, "../../wechat-claw/src/admin/public/admin.html"), "utf8").match(/link.innerHTML = '(<svg[^\n]+?<\/svg>)<span>账号管理/)[1];
  assert.equal(await page.locator('[data-management] svg').evaluate((svg, reference) => svg.outerHTML === new DOMParser().parseFromString(reference, "text/html").querySelector("svg").outerHTML, reference), true);
  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }, theme);
      await page.locator("#centerSwitcherTrigger").click();
      assert.equal(await page.locator('[data-management]').isVisible(), true);
      await page.locator("#centerSwitcherChevron").evaluate(async (svg) => { await Promise.all(svg.getAnimations().map(animation => animation.finished)); });
      const colors = await page.evaluate(() => ({
        header: getComputedStyle(document.querySelector(".center-icon")).color,
        store: getComputedStyle(document.querySelector('[data-center="store"] svg')).color,
        accounts: getComputedStyle(document.querySelector('[data-management] svg')).color,
        other: [...document.querySelectorAll('[data-center]:not([data-center="store"]) svg')].map(svg => getComputedStyle(svg).color),
      }));
      assert.equal(colors.header, theme === "light" ? "rgb(232, 93, 142)" : "rgb(244, 134, 173)");
      assert.equal(colors.header, colors.store);
      assert.equal(colors.accounts, "rgb(167, 139, 250)");
      assert.ok(!colors.other.includes(colors.store));
      await checkSize(`navigation-${theme}-${width}`, width);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#centerSwitcherMenu").isVisible(), false);
    }
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, "measurements.json"), JSON.stringify(measurements, null, 2));
  console.log(`Browser checks passed (${measurements.length} screenshots): ${output}`);
} finally { await browser.close(); await f.close(); }
