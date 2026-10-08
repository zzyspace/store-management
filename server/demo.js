import { DEMO_STORE } from "./policy.js";

const DAY = 24 * 60 * 60 * 1000;
const COUPONS = [
  ["DEMO-ZY-1001", "free_drink", "新客到店体验", 1, true],
  ["DEMO-ZY-1002", "free_drink", "会员生日赠饮", 2, false],
  ["DEMO-100-2001", "cash_100", "老顾客回馈", 3, true],
  ["DEMO-ZY-1003", "free_drink", "活动抽奖", 4, false],
  ["DEMO-100-2002", "cash_100", "服务补偿", 6, false],
  ["DEMO-ZY-1004", "free_drink", "新客到店体验", 8, true],
];

// Fills an empty demo database with fictional coupons; reviewers can then
// view, activate and redeem without touching any real store's data.
export function seedDemoCoupons(repository, now = Date.now()) {
  if (repository.list(DEMO_STORE, 1).total > 0) return;
  for (const [code, type, reason, daysAgo, redeemed] of COUPONS) {
    const item = repository.issue(DEMO_STORE, { type, code, reason, operator: "演示店员", issuedAt: now - daysAgo * DAY }, "demo-seed");
    if (redeemed) repository.redeem(item.id, DEMO_STORE, "demo-seed", "演示店员");
  }
}
