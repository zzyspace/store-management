import assert from 'node:assert/strict';
import { openIssueScanner, scanAndConfirm } from './scanner-browser-fixture.js';

export async function checkIssueWizard({ page, f, checkSize }) {
  const writes = [];
  const observe = request => { if (request.method() === 'POST' && request.url().includes('/store/api/coupons')) writes.push(request.url()); };
  page.on('request', observe);
  const total = f.repository.list('fuzzy', 1).total;
  try {
    await page.locator('#issueOpen').click();
    const form = page.locator('#issueForm');
    assert.equal(await form.getAttribute('data-step'), '1');
    assert.equal(await page.locator('#issueInformation').isVisible(), false);
    assert.equal(await form.locator('[name="reason"]').isDisabled(), true);
    assert.equal(await page.locator('#issueNext').isDisabled(), true);
    await form.evaluate(form => form.requestSubmit());
    assert.equal(await form.getAttribute('data-step'), '1');
    await openIssueScanner(page); await scanAndConfirm(page, 'FUZZY-ZY-9199'); await page.locator('#scanEnd').click();
    assert.equal(await form.getAttribute('data-step'), '1');
    assert.equal(await page.locator('#issueSubmit').isVisible(), false);
    await page.locator('#issueNext').click();
    assert.equal(await form.getAttribute('data-step'), '2');
    assert.equal(await page.locator('#issueInfoStep').getAttribute('aria-current'), 'step');
    assert.equal(await form.locator('[name="reason"]').isDisabled(), false);
    await form.locator('[name="reason"]').fill('步骤往返和扫码后保留');
    await form.locator('[name="operator"]').fill('指定发放人');
    await form.locator('[name="issuedAt"]').fill('2026-09-15T12:34');
    const sections = await form.locator('.issue-flow-body > section').evaluateAll(sections => sections.map(section => section.id || section.className));
    assert.equal(sections[0], 'issueInformation');
    await page.locator('#issueBack').click();
    assert.equal(await page.locator('#issueInformation').isVisible(), false);
    await openIssueScanner(page); await scanAndConfirm(page, 'FUZZY-ZY-9002'); await page.locator('#scanEnd').click();
    await page.locator('#issueNext').click();
    assert.equal(await form.locator('[name="reason"]').inputValue(), '步骤往返和扫码后保留');
    assert.equal(await form.locator('[name="operator"]').inputValue(), '指定发放人');
    assert.equal(await form.locator('[name="issuedAt"]').inputValue(), '2026-09-15T12:34');
    assert.equal(await page.locator('#issueSubmit').innerText(), '发放 2 张');
    for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : width === 390 ? 844 : 640 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }, theme);
      await checkSize(`issue-b-review-${theme}-${width}`, width);
      await page.locator('#issueBack').click(); await checkSize(`issue-b-scan-${theme}-${width}`, width); await page.locator('#issueNext').click();
    }
    for (const code of ['FUZZY-ZY-9199','FUZZY-ZY-9002']) await page.getByRole('button', { name: `移除 ${code}`, exact: true }).click();
    assert.equal(await form.getAttribute('data-step'), '2');
    assert.equal(await page.locator('#issueSubmit').isDisabled(), true);
    assert.equal(await page.locator('#issueEmptyScan').isVisible(), true);
    await openIssueScanner(page); await scanAndConfirm(page, 'FUZZY-ZY-9199'); await page.locator('#scanEnd').click();
    assert.equal(await form.getAttribute('data-step'), '2');
    assert.equal(await form.locator('[name="reason"]').inputValue(), '步骤往返和扫码后保留');
    assert.deepEqual(writes, [], 'steps and scan confirmation must never issue a coupon');
    assert.equal(f.repository.list('fuzzy', 1).total, total);
    await page.locator('#issueDialog [data-close]').first().click();
    await page.locator('#issueOpen').click();
    assert.equal(await form.getAttribute('data-step'), '1');
    assert.equal(await page.locator('#scannedCodes li').count(), 0);
    assert.equal(await form.locator('[name="reason"]').inputValue(), '');
    assert.equal(await form.locator('[name="operator"]').inputValue(), '测试admin');
    await page.locator('#issueDialog [data-close]').first().click();
    await page.setViewportSize({ width: 1440, height: 1000 });
  } finally { page.off('request', observe); }
}
