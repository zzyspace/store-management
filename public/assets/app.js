"use strict";
const $ = (id) => document.getElementById(id);
const state = { session: null, store: "", page: 1, total: 0, items: [], request: 0, issuing: false, redeeming: false, issueStore: "", redeemItem: null, loading: false };
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
  for (const name of ["code", "reason", "operator"]) form.elements[name].setCustomValidity("");
  state.issueStore = state.store; $("issueStore").textContent = storeLabel(state.issueStore);
  form.elements.operator.value = state.session.account.displayName;
  form.elements.issuedAt.value = dateText(new Date()).slice(0, 16).replace(" ", "T");
  status("issueStatus"); $("issueDialog").showModal();
});

for (const name of ["code", "reason", "operator"]) {
  const input = $("issueForm").elements[name];
  input.addEventListener("input", () => input.setCustomValidity(""));
}

$("issueForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.issuing) return;
  const form = event.currentTarget;
  for (const [name, label] of [["code", "券码"], ["reason", "赠送原因"], ["operator", "操作人"]]) {
    form.elements[name].setCustomValidity(form.elements[name].value.trim() ? "" : `请填写${label}。`);
  }
  if (!form.reportValidity()) return;
  const body = { store: state.issueStore, type: form.elements.type.value, code: form.elements.code.value, reason: form.elements.reason.value, operator: form.elements.operator.value, issuedAt: `${form.elements.issuedAt.value}+08:00` };
  state.issuing = true; setBusy("issueDialog", true); status("issueStatus", "正在发放…");
  try {
    await api("/store/api/coupons", { method: "POST", body: JSON.stringify(body) });
    $("issueDialog").close(); state.page = 1;
    if (await loadList()) status("pageStatus", "优惠券已发放。");
  } catch (error) { status("issueStatus", error.message, true); }
  finally { state.issuing = false; setBusy("issueDialog", false); }
});

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

for (const dialog of document.querySelectorAll("dialog")) {
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
    if (session.canManageAccounts) {
      const link = document.createElement("a"); link.className = "center-switcher-option"; link.href = "/auth/accounts"; link.setAttribute("role", "menuitem");
      link.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="10" r="5"/><path d="M3 28c0-14 18-14 18 0M25 17v12M19 23h12"/></svg><span>账号管理</span><span></span>';
      $("centerSwitcherMenu").append(link);
    }
    $("centerSwitcherTrigger").disabled = !session.apps?.some((app) => app !== "store") && !session.canManageAccounts;
  } catch { /* Current center remains usable while navigation discovery is unavailable. */ }
  $("centerSwitcherTrigger").querySelector(".center-switcher-chevron").hidden = $("centerSwitcherTrigger").disabled;
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
