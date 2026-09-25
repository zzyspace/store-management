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
  return { reason, operator, issuedAt: normalizeTime(body.issuedAt, "激活时间", "issuedAt") };
}

function normalizeTime(value, label, field) {
  // Require an explicit offset so server/device local time zones cannot change meaning.
  const match = typeof value === "string" && value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/);
  const timestamp = match ? Date.parse(value) : NaN;
  const wallClock = match ? `${match[1]}T${match[2]}:${match[3] ?? "00"}` : "";
  const wallTime = Date.parse(`${wallClock}Z`);
  if (!Number.isFinite(timestamp) || !Number.isFinite(wallTime) || new Date(wallTime).toISOString().slice(0, 19) !== wallClock) {
    throw new OperationError(400, `请选择有效的${label}。`, field);
  }
  return timestamp;
}

function normalizeBatchEnvelope(body) {
  if (typeof body?.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) {
    throw new OperationError(400, "批次标识无效，请重新打开操作页面。", "requestId");
  }
  if (!Array.isArray(body.codes) || !body.codes.length || body.codes.length > MAX_BATCH_SIZE) {
    throw new OperationError(400, `每批需包含1至${MAX_BATCH_SIZE}张优惠券。`, "codes");
  }
  return { requestId: body.requestId, codes: body.codes };
}

export function normalizeBatch(body) {
  return { ...normalizeBatchEnvelope(body), ...normalizeIssueFields(body) };
}

export function normalizeRedeemBatch(body) {
  return { ...normalizeBatchEnvelope(body), operator: requiredText(body.operator, "操作人", "operator", 200),
    redeemedAt: normalizeTime(body.redeemedAt, "核销时间", "redeemedAt") };
}

function validateRedeemTime(value, currentTime) {
  if (!Number.isFinite(value)) throw new OperationError(400, "请选择有效的核销时间。", "redeemedAt");
  if (value > currentTime) throw new OperationError(400, "核销时间不能晚于当前时间。", "redeemedAt");
}

function serialize(row) {
  return { id: row.id, store: row.store, type: row.type, code: row.code, reason: row.reason,
    operator: row.operator, issuedAt: new Date(row.issued_at).toISOString(),
    redeemedOperator: row.redeemed_operator ?? null,
    redeemedAt: row.redeemed_at === null ? null : new Date(row.redeemed_at).toISOString(),
    status: row.redeemed_at === null ? "unredeemed" : "redeemed" };
}

export function createRepository({ stateDir, now = Date.now }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const filename = path.join(stateDir, "coupons.db");
  const fd = fs.openSync(filename, "a", 0o600); fs.closeSync(fd); fs.chmodSync(filename, 0o600);
  const db = new Database(filename);
  db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000");
  const couponSchema = `CREATE TABLE IF NOT EXISTS coupons (
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
    redeemed_operator TEXT,
    deleted_at INTEGER,
    deleted_by_account_id TEXT,
    CHECK((redeemed_at IS NULL AND redeemed_by_account_id IS NULL) OR
          (redeemed_at IS NOT NULL AND redeemed_by_account_id IS NOT NULL))
  );`;
  db.exec(couponSchema);
  db.exec(`
  CREATE INDEX IF NOT EXISTS coupons_store_issued ON coupons(store, issued_at DESC, id DESC);
  CREATE TABLE IF NOT EXISTS coupon_issue_batches (
    account_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(account_id, request_id)
  );
  CREATE TABLE IF NOT EXISTS coupon_redeem_batches (
    account_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(account_id, request_id)
  );`);
  // Additive, repeatable migration: historical names remain unknown rather than inferred.
  db.transaction(() => {
    if (!db.pragma("table_info(coupons)").some((column) => column.name === "redeemed_operator")) {
      db.exec("ALTER TABLE coupons ADD COLUMN redeemed_operator TEXT");
    }
    if (!db.pragma("table_info(coupons)").some((column) => column.name === "deleted_at")) {
      db.exec("ALTER TABLE coupons ADD COLUMN deleted_at INTEGER; ALTER TABLE coupons ADD COLUMN deleted_by_account_id TEXT");
    }
    // Legacy UNIQUE(store, code) also reserved deleted codes. Only live rows
    // should reserve a code; keep historical rows and IDs for audit and stale clients.
    if (db.pragma("index_list(coupons)").some((index) => index.origin === "u")) {
      db.exec(couponSchema.replace("IF NOT EXISTS coupons", "coupons_next"));
      const columns = "id,store,type,code,reason,operator,issued_at,created_at,created_by_account_id,redeemed_at,redeemed_by_account_id,redeemed_operator,deleted_at,deleted_by_account_id";
      db.exec(`INSERT INTO coupons_next (${columns}) SELECT ${columns} FROM coupons;
        DROP TABLE coupons;
        ALTER TABLE coupons_next RENAME TO coupons;`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS coupons_live_store_code ON coupons(store, code) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS coupons_store_issued ON coupons(store, issued_at DESC, id DESC);`);
  }).immediate();
  const find = db.prepare("SELECT * FROM coupons WHERE id = ? AND deleted_at IS NULL");
  const insert = db.prepare(`INSERT INTO coupons (store,type,code,reason,operator,issued_at,created_at,created_by_account_id)
    VALUES (?,?,?,?,?,?,?,?)`);
  function issue(store, input, accountId) {
    try {
      const result = insert.run(store, input.type, input.code, input.reason, input.operator, input.issuedAt, now(), accountId);
      return serialize(find.get(result.lastInsertRowid));
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") throw new OperationError(409, "该门店已存在相同券码，请核对后再激活。", "code");
      throw error;
    }
  }
  const issueBatch = db.transaction((store, input, accountId) => {
    const digest = createHash("sha256").update(JSON.stringify({ store, codes: input.codes, reason: input.reason, operator: input.operator, issuedAt: input.issuedAt })).digest("hex");
    const previous = db.prepare("SELECT * FROM coupon_issue_batches WHERE account_id = ? AND request_id = ?").get(accountId, input.requestId);
    if (previous) {
      if (previous.request_digest !== digest) throw new OperationError(409, "该批次标识已用于不同的激活内容。", "requestId");
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
  function redeemOne(row, store, accountId, operator, redeemedAt) {
    if (!row || row.store !== store) throw new OperationError(404, "该门店未激活此券，无法核销。", "code");
    if (row.redeemed_at !== null) throw new OperationError(409, "该优惠券已核销。", "code");
    if (redeemedAt < row.issued_at) throw new OperationError(409, "核销时间不能早于该券的激活时间。", "redeemedAt");
    const result = db.prepare(`UPDATE coupons SET redeemed_at = ?, redeemed_by_account_id = ?, redeemed_operator = ?
      WHERE id = ? AND store = ? AND redeemed_at IS NULL AND issued_at <= ?`).run(redeemedAt, accountId, operator, row.id, store, redeemedAt);
    if (!result.changes) throw new OperationError(409, "该优惠券状态已变化，请刷新后重试。", "code");
    return serialize(find.get(row.id));
  }
  const redeem = db.transaction((id, store, accountId, operator) => {
    const redeemedAt = now();
    validateRedeemTime(redeemedAt, redeemedAt);
    return redeemOne(find.get(id), store, accountId, requiredText(operator, "操作人", "operator", 200), redeemedAt);
  });
  const redeemBatch = db.transaction((store, input, accountId) => {
    const currentTime = now();
    validateRedeemTime(input.redeemedAt, currentTime);
    const digest = createHash("sha256").update(JSON.stringify({ store, codes: input.codes, operator: input.operator, redeemedAt: input.redeemedAt })).digest("hex");
    const previous = db.prepare("SELECT * FROM coupon_redeem_batches WHERE account_id = ? AND request_id = ?").get(accountId, input.requestId);
    if (previous) {
      if (previous.request_digest !== digest) throw new OperationError(409, "该批次标识已用于不同的核销内容。", "requestId");
      return JSON.parse(previous.result_json);
    }
    const seen = new Set();
    const results = input.codes.map((value, index) => {
      let parsed;
      try { parsed = parseCouponCode(value, store); }
      catch (error) { return { index, code: typeof value === "string" ? value : null, success: false, error: { message: error.message, field: "code" } }; }
      if (seen.has(parsed.code)) return { index, code: parsed.code, success: false, error: { message: "本批次中券码重复。", field: "code" } };
      seen.add(parsed.code);
      try {
        const row = db.prepare("SELECT * FROM coupons WHERE store = ? AND code = ? AND deleted_at IS NULL").get(store, parsed.code);
        return { index, code: parsed.code, success: true, item: redeemOne(row, store, accountId, input.operator, input.redeemedAt) };
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        return { index, code: parsed.code, success: false, error: { message: error.message, field: error.field } };
      }
    });
    const redeemedCount = results.filter((result) => result.success).length;
    const result = { requestId: input.requestId, results, redeemedCount, failedCount: results.length - redeemedCount };
    db.prepare("INSERT INTO coupon_redeem_batches (account_id,request_id,request_digest,result_json,created_at) VALUES (?,?,?,?,?)")
      .run(accountId, input.requestId, digest, JSON.stringify(result), currentTime);
    return result;
  });
  return {
    close: () => db.close(),
    list(store, page) {
      const total = db.prepare("SELECT count(*) AS total FROM coupons WHERE store = ? AND deleted_at IS NULL").get(store).total;
      const items = db.prepare("SELECT * FROM coupons WHERE store = ? AND deleted_at IS NULL ORDER BY issued_at DESC, id DESC LIMIT 50 OFFSET ?").all(store, (page - 1) * 50).map(serialize);
      return { items, total, page, pageSize: 50 };
    },
    get(id) { const row = find.get(id); return row ? serialize(row) : null; },
    remove(id, store, accountId) {
      const result = db.prepare("UPDATE coupons SET deleted_at = ?, deleted_by_account_id = ? WHERE id = ? AND store = ? AND deleted_at IS NULL").run(now(), accountId, id, store);
      if (!result.changes) throw new OperationError(404, "未找到该门店的优惠券，可能已被删除。");
    },
    issue,
    issueBatch: (store, input, accountId) => issueBatch.immediate(store, input, accountId),
    redeem: (id, store, accountId, operator = accountId) => redeem.immediate(id, store, accountId, operator),
    redeemBatch: (store, input, accountId) => redeemBatch.immediate(store, input, accountId),
  };
}
