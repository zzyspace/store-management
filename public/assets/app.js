"use strict";
import { MAX_BATCH_SIZE, parseCouponCode } from "./coupon-code.js";
import { CouponScanner } from "./coupon-scanner.js";
const $ = (id) => document.getElementById(id);
const state = { session: null, store: "", page: 1, total: 0, items: [], request: 0, issuing: false, redeeming: false, issueStore: "", redeemItem: null, loading: false, codes: [], candidate: null, pendingBatch: null };
const dateFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const dateText = (value) => value ? dateFormat.format(new Date(value)) : "—";
const storeLabel = (id) => state.session?.stores.find((store) => store.id === id)?.label || id;
const can = (permission) => state.session?.permissions.includes(permission);
function status(id, text = "", error = false) { $(id).textContent = text; $(id).classList.toggle("error", error); }

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) }, cache: "no-store" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.success) {
    if (response.status === 401) {
      finishScanning();
      $("issueDialog").close();
      state.session = null;
      $("issueOpen").hidden = true;
      $("storeSelect").disabled = true;
      $("couponRows").replaceChildren();
      status("pageStatus", "登录或授权已失效，请重新登录。", true);
      const login = document.createElement("a"); login.href = "/login?returnTo=/store"; login.textContent = "重新登录"; $("pageStatus").append(" ", login);
    }
    const error = new Error(result.error?.message || "请求失败，请稍后重试。");
    error.field = result.error?.field; error.status = response.status;
    throw error;
  }
  return result;
}

function renderPagination() {
  $("totalPill").textContent = `总数 ${state.total}`;
  $("pageInfo").textContent = `第 ${state.page} / ${Math.max(1, Math.ceil(state.total / 50))} 页`;
  $("previousPage").disabled = state.loading || state.page <= 1;
  $("nextPage").disabled = state.loading || state.page * 50 >= state.total;
}

function emptyRow(message) {
  const row = document.createElement("tr"), cell = document.createElement("td");
  cell.colSpan = 8; cell.className = "empty"; cell.textContent = message; row.append(cell); $("couponRows").replaceChildren(row);
}

function renderRows() {
  if (!state.items.length) { emptyRow("该门店暂无优惠券"); return; }
  const rows = state.items.map((item) => {
    const row = document.createElement("tr");
    const values = [item.status === "redeemed" ? "已核销" : "未核销", state.session.types[item.type], item.code, item.reason, item.operator, dateText(item.issuedAt), dateText(item.redeemedAt)];
    for (const [index, value] of values.entries()) {
      const cell = document.createElement("td");
      if (index < 2) {
        const tag = document.createElement("span"); tag.className = `tag ${index === 0 ? item.status : item.type}`; tag.textContent = value; cell.append(tag);
      } else { cell.textContent = value; }
      if (index === 2) cell.className = "code";
      if ([3, 4].includes(index)) cell.className = "wrapping";
      row.append(cell);
    }
    const actions = document.createElement("td");
    if (item.status === "unredeemed" && can("coupon:redeem")) {
      const button = document.createElement("button"); button.textContent = "核销"; button.className = "redeem-button"; button.addEventListener("click", () => openRedeem(item)); actions.append(button);
    } else actions.textContent = "—";
    row.append(actions); return row;
  });
  $("couponRows").replaceChildren(...rows);
}

async function loadList() {
  const request = ++state.request, store = state.store, page = state.page;
  state.loading = true; state.items = []; state.total = 0;
  emptyRow("正在加载…"); renderPagination(); status("pageStatus");
  $("storeDescription").textContent = `${storeLabel(store)} · 查看优惠券发放与核销记录。`;
  try {
    const result = await api(`/store/api/coupons?store=${encodeURIComponent(store)}&page=${page}`);
    if (request !== state.request || store !== state.store) return;
    state.items = result.items; state.total = result.total; renderRows(); return true;
  } catch (error) {
    if (request !== state.request) return;
    emptyRow("未能加载优惠券");
    if (error.status !== 401) {
      status("pageStatus", error.message, true);
      const retry = document.createElement("button"); retry.textContent = "重试"; retry.addEventListener("click", loadList); $("pageStatus").append(" ", retry);
    }
  } finally {
    if (request === state.request) { state.loading = false; renderPagination(); }
  }
}

function setBusy(dialogId, busy) {
  const dialog = $(dialogId); dialog.dataset.busy = String(busy);
  dialog.querySelectorAll("button, input, textarea, select").forEach((control) => { control.disabled = busy; });
}

$("issueOpen").addEventListener("click", () => {
  if (!can("coupon:issue")) return;
  const form = $("issueForm"); form.reset();
  state.codes = []; state.pendingBatch = null;
  for (const name of ["reason", "operator"]) form.elements[name].setCustomValidity("");
  state.issueStore = state.store; $("issueStore").textContent = storeLabel(state.issueStore);
  form.elements.operator.value = state.session.account.displayName;
  form.elements.issuedAt.value = dateText(new Date()).slice(0, 16).replace(" ", "T");
  renderScannedCodes(); syncIssueControls();
  status("issueStatus"); $("issueDialog").showModal();
});

for (const name of ["reason", "operator"]) {
  const input = $("issueForm").elements[name];
  input.addEventListener("input", () => input.setCustomValidity(""));
}

$("issueForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.issuing) return;
  const form = event.currentTarget;
  if (!state.pendingBatch) {
    for (const [name, label] of [["reason", "赠送原因"], ["operator", "操作人"]]) {
      form.elements[name].setCustomValidity(form.elements[name].value.trim() ? "" : `请填写${label}。`);
    }
    if (!form.reportValidity()) return;
    if (!state.codes.length) { status("issueStatus", "请先批量扫码并确认至少一张优惠券。", true); return; }
    state.pendingBatch = { requestId: crypto.randomUUID(), store: state.issueStore, codes: state.codes.map((item) => item.code), reason: form.elements.reason.value, operator: form.elements.operator.value, issuedAt: `${form.elements.issuedAt.value}+08:00` };
  }
  state.issuing = true; syncIssueControls(); status("issueStatus", "正在发放…");
  try {
    const result = await api("/store/api/coupons/batch", { method: "POST", body: JSON.stringify(state.pendingBatch) });
    if (!Array.isArray(result.results) || result.results.length !== state.pendingBatch.codes.length) throw new Error("未收到完整的发放结果。");
    state.pendingBatch = null;
    state.codes = result.results.filter((item) => !item.success).map((item) => ({ ...state.codes[item.index], error: item.error.message }));
    renderScannedCodes();
    const message = `已发放 ${result.issuedCount} 张${result.failedCount ? `，${result.failedCount} 张失败，请核对下方原因。` : "。"}`;
    if (result.failedCount) status("issueStatus", message, true);
    else $("issueDialog").close();
    state.page = 1;
    const loaded = await loadList();
    if (loaded) status("pageStatus", message, Boolean(result.failedCount));
    else if (state.session) $("pageStatus").prepend(`${message} `);
  } catch (error) {
    if (error.status >= 400 && error.status < 500) state.pendingBatch = null;
    status("issueStatus", state.pendingBatch ? "尚未确认发放结果。请点击“重试发放”查询原批次结果，确认结果前暂不可修改内容。" : error.message, true);
  }
  finally { state.issuing = false; syncIssueControls(); }
});

function syncIssueControls() {
  setBusy("issueDialog", state.issuing);
  const locked = state.issuing || Boolean(state.pendingBatch);
  $("issueForm").querySelectorAll("input, textarea, [data-remove-code]").forEach((control) => { control.disabled = locked; });
  $("scanOpen").disabled = locked || state.codes.length >= MAX_BATCH_SIZE;
  $("issueSubmit").textContent = state.issuing ? "正在发放…" : state.pendingBatch ? "重试发放" : "发放";
}

function renderScannedCodes() {
  $("scanCount").textContent = `已扫描 ${state.codes.length} / ${MAX_BATCH_SIZE} 张`;
  $("scanConfirmedCount").textContent = state.codes.length;
  $("scannedCodes").replaceChildren(...state.codes.map((item) => {
    const row = document.createElement("li"), content = document.createElement("div"), code = document.createElement("strong"), type = document.createElement("span"), remove = document.createElement("button");
    code.textContent = item.code; code.className = "scanned-code";
    type.textContent = state.session.types[item.type]; type.className = "muted";
    content.append(code, type);
    if (item.error) { const error = document.createElement("p"); error.className = "coupon-error"; error.textContent = item.error; content.append(error); }
    remove.type = "button"; remove.textContent = "移除"; remove.dataset.removeCode = item.code; remove.setAttribute("aria-label", `移除 ${item.code}`);
    remove.addEventListener("click", () => { if (state.issuing || state.pendingBatch) return; state.codes = state.codes.filter((entry) => entry.code !== item.code); renderScannedCodes(); syncIssueControls(); });
    row.append(content, remove); return row;
  }));
}

const scanner = new CouponScanner({ video: $("scanVideo"), onCode: confirmScannedCode, onError(message) {
  state.candidate = null; $("scanConfirmation").hidden = true; $("scanEnd").disabled = false;
  status("scanStatus", message, true); $("scanRetry").hidden = false; $("scanRetry").disabled = false;
} });

function confirmScannedCode(value) {
  try {
    const item = parseCouponCode(value, state.issueStore);
    if (state.codes.some((entry) => entry.code === item.code)) throw new Error("该券码已加入，请扫描下一张。");
    if (state.codes.length >= MAX_BATCH_SIZE) throw new Error(`已达到${MAX_BATCH_SIZE}张上限，请结束扫码并发放。`);
    state.candidate = item;
    const nodes = [];
    for (const [label, value] of [["券码", item.code], ["门店", storeLabel(item.store)], ["类型", state.session.types[item.type]]]) {
      const term = document.createElement("dt"), detail = document.createElement("dd"); term.textContent = label; detail.textContent = value; nodes.push(term, detail);
    }
    $("scanSummary").replaceChildren(...nodes); status("scanStatus");
    $("scanConfirmation").hidden = false; $("scanEnd").disabled = true; $("scanConfirm").focus();
  } catch (error) { status("scanStatus", error.message, true); scanner.resume(); }
}

function dismissScanConfirmation(accept) {
  if (accept && state.candidate) state.codes.push(state.candidate);
  state.candidate = null; $("scanConfirmation").hidden = true; $("scanEnd").disabled = false;
  renderScannedCodes(); syncIssueControls(); scanner.resume();
  status("scanStatus", state.codes.length >= MAX_BATCH_SIZE ? "已达到50张上限，请结束扫码并发放。" : "请将下一张二维码对准相机。继续扫描同一码前请先将其移出画面。");
  $("scanEnd").focus();
}

async function startScanning() {
  $("scanRetry").hidden = true; $("scanRetry").disabled = true;
  status("scanStatus", "正在启动相机…");
  if (await scanner.start()) status("scanStatus", "请将二维码对准相机，识别后逐张确认。");
}

function finishScanning() {
  scanner.stop(); state.candidate = null; $("scanConfirmation").hidden = true; $("scanEnd").disabled = false;
  if ($("scanDialog").open) $("scanDialog").close();
}

$("scanOpen").addEventListener("click", () => {
  if (state.issuing || state.pendingBatch || !can("coupon:issue")) return;
  $("scanStore").textContent = storeLabel(state.issueStore); $("scanDialog").showModal(); startScanning();
});
$("scanRetry").addEventListener("click", startScanning);
$("scanConfirm").addEventListener("click", () => dismissScanConfirmation(true));
$("scanCancel").addEventListener("click", () => dismissScanConfirmation(false));
$("scanEnd").addEventListener("click", finishScanning);
$("scanDialog").addEventListener("cancel", (event) => { event.preventDefault(); if (state.candidate) dismissScanConfirmation(false); else finishScanning(); });
$("scanDialog").addEventListener("close", () => { scanner.stop(); if ($("issueDialog").open) $("scanOpen").focus(); });
$("scanConfirmation").addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  event.preventDefault(); (document.activeElement === $("scanConfirm") ? $("scanCancel") : $("scanConfirm")).focus();
});
$("issueDialog").addEventListener("close", () => { finishScanning(); state.codes = []; state.pendingBatch = null; });
window.addEventListener("pagehide", finishScanning);
document.addEventListener("visibilitychange", () => { if (document.hidden && $("scanDialog").open) scanner.fail("相机已暂停，已确认券码仍保留。返回后请点击“重试相机”。"); });

function openRedeem(item) {
  if (!can("coupon:redeem")) return;
  state.redeemItem = item;
  const nodes = [];
  for (const [label, value] of [["门店", storeLabel(item.store)], ["券码", item.code], ["类型", state.session.types[item.type]]]) {
    const term = document.createElement("dt"), detail = document.createElement("dd"); term.textContent = label; detail.textContent = value; nodes.push(term, detail);
  }
  $("redeemSummary").replaceChildren(...nodes); status("redeemStatus"); $("redeemDialog").showModal();
}

$("redeemForm").addEventListener("submit", async (event) => {
  event.preventDefault(); if (state.redeeming) return;
  const item = state.redeemItem;
  state.redeeming = true; setBusy("redeemDialog", true); status("redeemStatus", "正在核销…");
  try {
    await api(`/store/api/coupons/${item.id}/redeem`, { method: "POST", body: JSON.stringify({ store: item.store }) });
    $("redeemDialog").close(); if (await loadList()) status("pageStatus", "优惠券已核销。");
  } catch (error) { status("redeemStatus", error.message, true); }
  finally { state.redeeming = false; setBusy("redeemDialog", false); }
});

for (const dialog of [$("issueDialog"), $("redeemDialog")]) {
  dialog.addEventListener("cancel", (event) => { if (dialog.dataset.busy === "true") event.preventDefault(); });
  dialog.addEventListener("close", () => { (dialog.id === "issueDialog" ? $("issueOpen") : $("couponRows").querySelector("button"))?.focus(); });
}
for (const button of document.querySelectorAll("[data-close]")) button.addEventListener("click", () => $(button.dataset.close).close());
$("storeSelect").addEventListener("change", () => { state.store = $("storeSelect").value; state.page = 1; loadList(); });
$("previousPage").addEventListener("click", () => { if (state.page > 1) { state.page--; loadList(); } });
$("nextPage").addEventListener("click", () => { if (state.page * 50 < state.total) { state.page++; loadList(); } });

function renderTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  $("themeIcon").textContent = dark ? "☀️" : "🌙";
  $("themeToggle").setAttribute("aria-label", dark ? "切换到浅色模式" : "切换到深色模式");
  $("themeToggle").setAttribute("aria-pressed", String(dark));
}
$("themeToggle").addEventListener("click", () => {
  const root = document.documentElement; root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark"; root.style.colorScheme = root.dataset.theme;
  try { localStorage.setItem("store-management-theme", root.dataset.theme); } catch {}
  renderTheme();
}); renderTheme();

function setCenters(open) {
  $("centerSwitcherMenu").hidden = !open; $("centerSwitcherBackdrop").hidden = !open;
  $("centerSwitcherTrigger").setAttribute("aria-expanded", String(open));
  $("centerSwitcher").classList.toggle("is-open", open); document.body.classList.toggle("switcher-open", open);
  if (open) $("centerSwitcherMenu").querySelector('[aria-current="page"]')?.focus();
  else $("centerSwitcherTrigger").focus();
}
$("centerSwitcherTrigger").addEventListener("click", () => setCenters($("centerSwitcherMenu").hidden));
$("centerSwitcherBackdrop").addEventListener("click", () => setCenters(false));
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("centerSwitcherMenu").hidden) setCenters(false); });
async function loadCenters() {
  for (const link of $("centerSwitcherMenu").querySelectorAll("[data-center]")) link.hidden = link.dataset.center !== "store";
  try {
    const response = await fetch("/auth/api/session", { cache: "no-store" });
    if (!response.ok) return;
    const session = await response.json();
    for (const link of $("centerSwitcherMenu").querySelectorAll("[data-center]")) {
      link.hidden = !session.apps?.includes(link.dataset.center);
      if (session.destinations?.[link.dataset.center]) link.href = session.destinations[link.dataset.center];
    }
    if (session.canManageAccounts && !$("centerSwitcherMenu").querySelector("[data-management]")) {
      const link = document.createElement("a"); link.className = "center-switcher-option"; link.href = "/auth/accounts"; link.setAttribute("role", "menuitem"); link.dataset.management = "true";
      link.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9.5" r="4.25" fill="currentColor" fill-opacity=".16"/><path d="M4.5 25.5c.65-5.8 3.15-8.5 7.5-8.5 3.25 0 5.45 1.5 6.65 4.55"/><circle cx="23.25" cy="22.75" r="3.25" fill="currentColor" fill-opacity=".16"/><path d="M23.25 17.5v1.15M23.25 26.85V28M18 22.75h1.15M27.35 22.75h1.15M19.55 19.05l.8.8M26.15 25.65l.8.8M26.95 19.05l-.8.8M20.35 25.65l-.8.8"/><circle cx="23.25" cy="22.75" r="1.05" fill="currentColor" stroke="none"/></svg><span>账号管理</span><span></span>';
      $("centerSwitcherMenu").append(link);
    }
    $("centerSwitcherTrigger").disabled = !session.apps?.some((app) => app !== "store") && !session.canManageAccounts;
  } catch { /* Current center remains usable while navigation discovery is unavailable. */ }
  $("centerSwitcherTrigger").querySelector(".center-switcher-chevron").toggleAttribute("hidden", $("centerSwitcherTrigger").disabled);
}

async function initialize() {
  loadCenters();
  try {
    const session = await api("/store/api/session"); state.session = session;
    $("storeSelect").replaceChildren(...session.stores.map((store) => new Option(store.label, store.id)));
    $("storeSelect").disabled = session.stores.length <= 1;
    $("featureSelect").replaceChildren(...session.features.map((feature) => new Option(feature.label, feature.id)));
    $("featureSelect").disabled = session.features.length <= 1;
    $("issueOpen").hidden = !can("coupon:issue");
    state.store = session.stores[0].id; await loadList();
  } catch (error) {
    emptyRow("暂时无法加载门店权限"); if (error.status !== 401) status("pageStatus", error.message, true);
  }
}
initialize();
