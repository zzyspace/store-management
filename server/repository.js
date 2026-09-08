import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { OperationError, TYPES } from "./policy.js";

function requiredText(value, label, field, max) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new OperationError(400, `请填写${label}，最多 ${max} 个字符。`, field);
  }
  return value.trim();
}

export function normalizeCoupon(body) {
  if (!Object.hasOwn(TYPES, body.type)) throw new OperationError(400, "请选择优惠券类型。", "type");
  const code = requiredText(body.code, "券码", "code", 200);
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
  return { type: body.type, code, reason, operator, issuedAt };
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
  CREATE INDEX IF NOT EXISTS coupons_store_issued ON coupons(store, issued_at DESC, id DESC);`);
  const find = db.prepare("SELECT * FROM coupons WHERE id = ?");
  return {
    close: () => db.close(),
    list(store, page) {
      const total = db.prepare("SELECT count(*) AS total FROM coupons WHERE store = ?").get(store).total;
      const items = db.prepare("SELECT * FROM coupons WHERE store = ? ORDER BY issued_at DESC, id DESC LIMIT 50 OFFSET ?").all(store, (page - 1) * 50).map(serialize);
      return { items, total, page, pageSize: 50 };
    },
    get(id) { const row = find.get(id); return row ? serialize(row) : null; },
    issue(store, input, accountId) {
      try {
        const result = db.prepare(`INSERT INTO coupons (store,type,code,reason,operator,issued_at,created_at,created_by_account_id)
          VALUES (?,?,?,?,?,?,?,?)`).run(store, input.type, input.code, input.reason, input.operator, input.issuedAt, now(), accountId);
        return serialize(find.get(result.lastInsertRowid));
      } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") throw new OperationError(409, "该门店已存在相同券码，请核对后再发放。", "code");
        throw error;
      }
    },
    redeem(id, store, accountId) {
      const result = db.prepare("UPDATE coupons SET redeemed_at = ?, redeemed_by_account_id = ? WHERE id = ? AND store = ? AND redeemed_at IS NULL").run(now(), accountId, id, store);
      if (!result.changes) throw new OperationError(409, "该优惠券已核销，请刷新列表。");
      return serialize(find.get(id));
    },
  };
}
