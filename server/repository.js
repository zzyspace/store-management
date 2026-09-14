import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { OperationError, TYPES } from "./policy.js";
import { MAX_BATCH_SIZE, parseCouponCode } from "../public/assets/coupon-code.js";

function requiredText(value, label, field, max) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new OperationError(400, `请填写${label}，最多 ${max} 个字符。`, field);
  }
  return value.trim();
}

export function normalizeCoupon(body) {
  if (!Object.hasOwn(TYPES, body.type)) throw new OperationError(400, "请选择优惠券类型。", "type");
  const code = requiredText(body.code, "券码", "code", 200);
  return { type: body.type, code, ...normalizeIssueFields(body) };
}

function normalizeIssueFields(body) {
  const reason = requiredText(body.reason, "赠送原因", "reason", 1000);
  const operator = requiredText(body.operator, "操作人", "operator", 200);
  // Require an explicit offset so server/device local time zones cannot change meaning.
  const match = typeof body.issuedAt === "string" && body.issuedAt.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/);
  const issuedAt = match ? Date.parse(body.issuedAt) : NaN;
  const wallClock = match ? `${match[1]}T${match[2]}:${match[3] ?? "00"}` : "";
  const wallTime = Date.parse(`${wallClock}Z`);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(wallTime) || new Date(wallTime).toISOString().slice(0, 19) !== wallClock) {
    throw new OperationError(400, "请选择有效的发放时间。", "issuedAt");
  }
  return { reason, operator, issuedAt };
}

export function normalizeBatch(body) {
  if (typeof body?.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) {
    throw new OperationError(400, "批次标识无效，请重新打开发放页面。", "requestId");
  }
  if (!Array.isArray(body.codes) || !body.codes.length || body.codes.length > MAX_BATCH_SIZE) {
    throw new OperationError(400, `每批需包含1至${MAX_BATCH_SIZE}张优惠券。`, "codes");
  }
  return { requestId: body.requestId, codes: body.codes, ...normalizeIssueFields(body) };
}

function serialize(row) {
  return { id: row.id, store: row.store, type: row.type, code: row.code, reason: row.reason,
    operator: row.operator, issuedAt: new Date(row.issued_at).toISOString(),
    redeemedAt: row.redeemed_at === null ? null : new Date(row.redeemed_at).toISOString(),
    status: row.redeemed_at === null ? "unredeemed" : "redeemed" };
}

export function createRepository({ stateDir, now = Date.now }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const filename = path.join(stateDir, "coupons.db");
  const fd = fs.openSync(filename, "a", 0o600); fs.closeSync(fd); fs.chmodSync(filename, 0o600);
  const db = new Database(filename);
  db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY,
    store TEXT NOT NULL CHECK(store IN ('fuzzy','fuzzy_qz','peanut')),
    type TEXT NOT NULL CHECK(type IN ('cash_100','free_drink')),
    code TEXT NOT NULL CHECK(length(trim(code)) > 0),
    reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
    operator TEXT NOT NULL CHECK(length(trim(operator)) > 0),
    issued_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    created_by_account_id TEXT NOT NULL,
    redeemed_at INTEGER,
    redeemed_by_account_id TEXT,
    UNIQUE(store, code),
    CHECK((redeemed_at IS NULL AND redeemed_by_account_id IS NULL) OR
          (redeemed_at IS NOT NULL AND redeemed_by_account_id IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS coupons_store_issued ON coupons(store, issued_at DESC, id DESC);
  CREATE TABLE IF NOT EXISTS coupon_issue_batches (
    account_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(account_id, request_id)
  );`);
  const find = db.prepare("SELECT * FROM coupons WHERE id = ?");
  const insert = db.prepare(`INSERT INTO coupons (store,type,code,reason,operator,issued_at,created_at,created_by_account_id)
    VALUES (?,?,?,?,?,?,?,?)`);
  function issue(store, input, accountId) {
    try {
      const result = insert.run(store, input.type, input.code, input.reason, input.operator, input.issuedAt, now(), accountId);
      return serialize(find.get(result.lastInsertRowid));
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") throw new OperationError(409, "该门店已存在相同券码，请核对后再发放。", "code");
      throw error;
    }
  }
  const issueBatch = db.transaction((store, input, accountId) => {
    const digest = createHash("sha256").update(JSON.stringify({ store, codes: input.codes, reason: input.reason, operator: input.operator, issuedAt: input.issuedAt })).digest("hex");
    const previous = db.prepare("SELECT * FROM coupon_issue_batches WHERE account_id = ? AND request_id = ?").get(accountId, input.requestId);
    if (previous) {
      if (previous.request_digest !== digest) throw new OperationError(409, "该批次标识已用于不同的发放内容。", "requestId");
      return JSON.parse(previous.result_json);
    }
    const seen = new Set();
    const results = input.codes.map((value, index) => {
      let parsed;
      try { parsed = parseCouponCode(value, store); }
      catch (error) { return { index, code: typeof value === "string" ? value : null, success: false, error: { message: error.message, field: "code" } }; }
      if (seen.has(parsed.code)) return { index, code: parsed.code, success: false, error: { message: "本批次中券码重复。", field: "code" } };
      seen.add(parsed.code);
      try { return { index, code: parsed.code, success: true, item: issue(store, { ...input, ...parsed }, accountId) }; }
      catch (error) {
        if (!(error instanceof OperationError)) throw error;
        return { index, code: parsed.code, success: false, error: { message: error.message, field: error.field } };
      }
    });
    const issuedCount = results.filter((result) => result.success).length;
    const result = { requestId: input.requestId, results, issuedCount, failedCount: results.length - issuedCount };
    db.prepare("INSERT INTO coupon_issue_batches (account_id,request_id,request_digest,result_json,created_at) VALUES (?,?,?,?,?)")
      .run(accountId, input.requestId, digest, JSON.stringify(result), now());
    return result;
  });
  return {
    close: () => db.close(),
    list(store, page) {
      const total = db.prepare("SELECT count(*) AS total FROM coupons WHERE store = ?").get(store).total;
      const items = db.prepare("SELECT * FROM coupons WHERE store = ? ORDER BY issued_at DESC, id DESC LIMIT 50 OFFSET ?").all(store, (page - 1) * 50).map(serialize);
      return { items, total, page, pageSize: 50 };
    },
    get(id) { const row = find.get(id); return row ? serialize(row) : null; },
    issue,
    issueBatch: (store, input, accountId) => issueBatch.immediate(store, input, accountId),
    redeem(id, store, accountId) {
      const result = db.prepare("UPDATE coupons SET redeemed_at = ?, redeemed_by_account_id = ? WHERE id = ? AND store = ? AND redeemed_at IS NULL").run(now(), accountId, id, store);
      if (!result.changes) throw new OperationError(409, "该优惠券已核销，请刷新列表。");
      return serialize(find.get(id));
    },
  };
}
