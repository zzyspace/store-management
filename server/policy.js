export const STORES = Object.freeze({ fuzzy: "Fuzzy", fuzzy_qz: "Fuzzy泉州店", peanut: "Peanut" });
export const TYPES = Object.freeze({ cash_100: "100元代金券", free_drink: "赠饮券" });
export const PERMISSIONS = Object.freeze(["coupon:view", "coupon:issue", "coupon:redeem"]);

export function validateAuthorization(data) {
  const access = data.access;
  const scope = access.config?.viewScope;
  if (!["admin", "partner", "manager"].includes(access.role) ||
      !Array.isArray(access.permissions) || !access.permissions.includes("coupon:view") ||
      access.permissions.some((permission) => !PERMISSIONS.includes(permission)) ||
      Object.keys(access.config ?? {}).some((key) => key !== "viewScope") ||
      !scope || scope.ownership !== "any" || Object.keys(scope).some((key) => !["ownership", "stores"].includes(key)) ||
      !(scope.stores === "all" || Array.isArray(scope.stores) && scope.stores.length > 0 && scope.stores.every((store) => Object.hasOwn(STORES, store))) ||
      (["admin", "partner"].includes(access.role) && scope.stores !== "all")) {
    throw new Error("Unsupported store authorization.");
  }
  return data;
}

export function allowedStores(auth) {
  return Object.keys(STORES).filter((store) => auth.access.config.viewScope.stores === "all" || auth.access.config.viewScope.stores.includes(store));
}

export class OperationError extends Error {
  constructor(status, message, field) { super(message); this.status = status; this.field = field; }
}

export function requireStore(auth, store) {
  if (typeof store !== "string" || !Object.hasOwn(STORES, store)) throw new OperationError(400, "请选择有效门店。", "store");
  if (!allowedStores(auth).includes(store)) throw new OperationError(403, "当前账号无权访问此门店。", "store");
  return store;
}

export function requirePermission(auth, permission) {
  if (!auth.access.permissions.includes(permission)) throw new OperationError(403, "当前账号无权执行此操作。");
}
