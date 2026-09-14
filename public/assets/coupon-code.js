export const MAX_BATCH_SIZE = 50;
export const CODE_STORES = Object.freeze({ FUZZY: "fuzzy", FUZZYQZ: "fuzzy_qz", PEANUT: "peanut" });
export const CODE_TYPES = Object.freeze({ ZY: "free_drink", "100": "cash_100" });

export function parseCouponCode(value, expectedStore) {
  const code = typeof value === "string" ? value.trim() : "";
  if (!code || code.length > 200 || !/^[A-Z]+-(?:[A-Z]+|\d+)-\d+$/.test(code)) {
    throw new Error("券码格式无效，应为“门店代码-券类型-数字编号”，最多200字符。");
  }
  const [storeCode, typeCode, number] = code.split("-");
  const store = CODE_STORES[storeCode], type = CODE_TYPES[typeCode];
  if (!store) throw new Error("无法识别券码中的门店代码。");
  if (!type) throw new Error("无法识别券类型，仅支持 ZY（赠饮券）和 100（100元代金券）。");
  if (expectedStore && store !== expectedStore) throw new Error("券码所属门店与当前发放门店不符，请切换门店后再扫描。");
  return { code, store, type, number };
}
