"use strict";
import { MAX_BATCH_SIZE, parseCouponCode } from "./coupon-code.js";
import { CouponScanner } from "./coupon-scanner.js";
const $ = (id) => document.getElementById(id);
const state = { session: null, store: "", page: 1, total: 0, items: [], request: 0, loading: false, candidate: null, scanMode: null, detailItem: null, detailTrigger: null };
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
      closeCouponDetail();
      finishScanning();
      $("issueDialog").close(); $("redeemDialog").close();
      state.session = null;
      $("issueOpen").hidden = true; $("redeemOpen").hidden = true;
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
  $("totalPill").textContent = `共 ${state.total} 张`;
  $("pageInfo").textContent = `第 ${state.page} / ${Math.max(1, Math.ceil(state.total / 50))} 页`;
  $("previousPage").disabled = state.loading || state.page <= 1;
  $("nextPage").disabled = state.loading || state.page * 50 >= state.total;
}

function emptyRow(message) {
  const row = document.createElement("li");
  row.className = "empty"; row.textContent = message; $("couponRows").replaceChildren(row);
}

function renderRows() {
  if (!state.items.length) { emptyRow("该门店暂无优惠券"); return; }
  const rows = state.items.map((item) => {
    const row = document.createElement("li"), button = document.createElement("button"), identity = document.createElement("span");
    button.type = "button"; button.className = "coupon-row"; button.dataset.couponId = item.id;
    button.setAttribute("aria-label", `查看 ${item.code} 详情`); button.setAttribute("aria-haspopup", "dialog"); button.setAttribute("aria-controls", "couponDetailDialog");
    identity.className = "coupon-identity";
    const code = document.createElement("span"), type = document.createElement("span"), tag = document.createElement("span"), reason = document.createElement("span"), audit = document.createElement("span"), chevron = document.createElement("span");
    code.className = "coupon-code"; code.textContent = item.code; code.title = item.code;
    type.className = `coupon-type ${item.type}`; type.textContent = state.session.types[item.type]; identity.append(code, type);
    tag.className = `tag coupon-state ${item.status}`; tag.textContent = item.status === "redeemed" ? "已核销" : "未核销";
    reason.className = "coupon-reason"; reason.textContent = item.reason; reason.title = item.reason;
    audit.className = "coupon-issue-summary"; audit.textContent = `${item.operator} · ${dateText(item.issuedAt).slice(0, 16)} 激活`;
    chevron.className = "coupon-chevron"; chevron.setAttribute("aria-hidden", "true");
    button.append(identity, tag, reason, audit, chevron); button.addEventListener("click", () => openCouponDetail(item, button)); row.append(button);
    return row;
  });
  $("couponRows").replaceChildren(...rows);
}

function openCouponDetail(item, trigger) {
  if (!can("coupon:view") || state.loading || item.store !== state.store) return;
  state.detailItem = { ...item }; state.detailTrigger = trigger;
  $("detailType").className = `tag ${item.type}`; $("detailType").textContent = state.session.types[item.type];
  $("detailState").className = `tag coupon-state ${item.status}`; $("detailState").textContent = item.status === "redeemed" ? "已核销" : "未核销";
  $("detailCode").textContent = item.code; $("detailStore").textContent = `门店：${storeLabel(item.store)}`;
  $("detailReason").textContent = item.reason; $("detailIssueOperator").textContent = item.operator;
  $("detailIssuedAt").textContent = dateText(item.issuedAt); $("detailIssuedAt").dateTime = item.issuedAt;
  $("detailRedeemOperator").textContent = item.redeemedAt ? item.redeemedOperator || "—" : "暂无核销记录";
  $("detailRedeemedAt").textContent = item.redeemedAt ? dateText(item.redeemedAt) : "";
  $("detailRedeemedAt").dateTime = item.redeemedAt || ""; $("detailRedeemedAt").hidden = !item.redeemedAt;
  $("deleteCouponCode").hidden = !can("coupon:delete"); $("deleteCouponCode").disabled = false;
  $("copyCouponCode").disabled = false; status("detailStatus"); $("couponDetailDialog").showModal();
  $("couponDetailDialog").querySelector(".coupon-detail-content").scrollTop = 0;
  $("couponDetailDialog").querySelector("[data-close]").focus({ preventScroll: true });
}

function clearCouponDetail() {
  state.detailItem = null;
  for (const id of ["detailType", "detailState", "detailCode", "detailStore", "detailReason", "detailIssueOperator", "detailIssuedAt", "detailRedeemOperator", "detailRedeemedAt"]) $(id).textContent = "";
  $("detailIssuedAt").removeAttribute("datetime"); $("detailRedeemedAt").removeAttribute("datetime"); status("detailStatus");
}

function closeCouponDetail() {
  clearCouponDetail();
  if ($("couponDetailDialog").open) $("couponDetailDialog").close();
}

$("couponDetailDialog").addEventListener("close", () => {
  if ($("couponDetailDialog").open) return;
  clearCouponDetail();
  (state.detailTrigger?.isConnected ? state.detailTrigger : $("storeSelect")).focus({ preventScroll: true }); state.detailTrigger = null;
});
$("couponDetailDialog").addEventListener("click", (event) => {
  if (event.target !== event.currentTarget) return;
  const rect = event.currentTarget.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeCouponDetail();
});
$("couponDetailDialog").addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const buttons = [...event.currentTarget.querySelectorAll("button:not(:disabled):not([hidden])")];
  const first = buttons[0], last = buttons.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
$("deleteCouponCode").addEventListener("click", async () => {
  const item = state.detailItem;
  if (!item || !can("coupon:delete") || $("deleteCouponCode").disabled) return;
  if (!window.confirm(`确认删除 ${storeLabel(item.store)} 的券码 ${item.code}？\n删除后将清除当前激活和核销状态，可重新激活后再核销。`)) return;
  $("deleteCouponCode").disabled = true;
  status("detailStatus", "正在删除…");
  try {
    await api(`/store/api/coupons/${item.id}`, { method: "DELETE", body: JSON.stringify({ store: item.store }) });
    if (state.detailItem !== item) return;
    if (state.items.length === 1 && state.page > 1) state.page--;
    if (await loadList()) status("pageStatus", `券码 ${item.code} 已删除。`);
  } catch (error) {
    if (state.detailItem === item) status("detailStatus", error.message, true);
  } finally { if (state.detailItem === item) $("deleteCouponCode").disabled = false; }
});

$("copyCouponCode").addEventListener("click", async () => {
  const item = state.detailItem;
  if (!item || !can("coupon:view")) return;
  $("copyCouponCode").disabled = true;
  try {
    await navigator.clipboard.writeText(item.code);
    if (state.detailItem === item) status("detailStatus", "券码已复制。");
  } catch {
    if (state.detailItem === item) status("detailStatus", "复制失败，请长按或选中券码复制。", true);
  } finally { if (state.detailItem === item) $("copyCouponCode").disabled = false; }
});

async function loadList() {
  closeCouponDetail();
  const request = ++state.request, store = state.store, page = state.page;
  state.loading = true; state.items = []; state.total = 0;
  emptyRow("正在加载…"); renderPagination(); status("pageStatus");
  $("storeDescription").textContent = `${storeLabel(store)} · 查看优惠券激活与核销记录。`;
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

const batchViews = {
  issue: { label: "激活", permission: "coupon:issue", form: "issueForm", dialog: "issueDialog", open: "issueOpen", store: "issueStore", scanOpen: "scanOpen", list: "scannedCodes", count: "scanCount", status: "issueStatus", submit: "issueSubmit", time: "issuedAt", endpoint: "/store/api/coupons/batch", successCount: "issuedCount" },
  redeem: { label: "核销", permission: "coupon:redeem", form: "redeemForm", dialog: "redeemDialog", open: "redeemOpen", store: "redeemStore", scanOpen: "redeemScanOpen", list: "redeemScannedCodes", count: "redeemScanCount", status: "redeemStatus", submit: "redeemSubmit", time: "redeemedAt", endpoint: "/store/api/coupons/redeem-batch", successCount: "redeemedCount" },
};
const emptyDraft = () => ({ store: "", codes: [], pending: null, busy: false, step: 1 });
const drafts = { issue: emptyDraft(), redeem: emptyDraft() };

function syncBatchControls(mode) {
  const view = batchViews[mode], draft = drafts[mode];
  setBusy(view.dialog, draft.busy);
  const locked = draft.busy || Boolean(draft.pending);
  $(view.form).querySelectorAll("input, textarea, [data-remove-code]").forEach((control) => { control.disabled = locked; });
  $(view.scanOpen).disabled = locked || draft.codes.length >= MAX_BATCH_SIZE;
  $(view.submit).textContent = draft.busy ? `正在${view.label}…` : draft.pending ? `重试${view.label}` : view.label;
  if (mode === "issue") {
    const scanning = draft.step === 1, empty = draft.codes.length === 0;
    $("issueForm").dataset.step = String(draft.step);
    $("issueInformation").hidden = scanning;
    $("issueInformation").querySelectorAll("input, textarea").forEach((control) => { control.disabled = scanning || locked; });
    $("issueCouponsTitle").textContent = scanning ? "优惠券" : "本次激活的优惠券";
    $("issueScanStep").toggleAttribute("data-complete", !scanning);
    $("issueScanStepNumber").textContent = scanning ? "1" : "✓";
    for (const [id, active] of [["issueScanStep", scanning], ["issueInfoStep", !scanning]]) {
      if (active) $(id).setAttribute("aria-current", "step"); else $(id).removeAttribute("aria-current");
    }
    $("issueCancel").hidden = !scanning;
    $("issueBack").hidden = scanning; $("issueBack").disabled = locked;
    $("issueNext").hidden = !scanning; $("issueNext").disabled = locked || empty;
    $("issueSubmit").hidden = scanning; $("issueSubmit").disabled = scanning || draft.busy || empty;
    if (!draft.busy && !draft.pending) $("issueSubmit").textContent = empty ? "激活" : `激活 ${draft.codes.length} 张`;
    $("issueEmptyScan").hidden = !empty; $("issueEmptyScan").disabled = locked;
    $("scanOpen").hidden = empty; $("scannedCodes").hidden = empty;
  } else {
    const empty = draft.codes.length === 0;
    $("redeemEmptyScan").hidden = !empty; $("redeemEmptyScan").disabled = locked;
    $("redeemScanOpen").hidden = empty; $("redeemScannedCodes").hidden = empty;
    $("redeemSubmit").disabled = draft.busy || empty;
    if (!draft.busy && !draft.pending) $("redeemSubmit").textContent = empty ? "核销" : `${draft.codes.some(item => item.error) ? "重试核销" : "核销"} ${draft.codes.length} 张`;
  }
}

function setIssueStep(step) {
  const draft = drafts.issue;
  if (draft.busy || draft.pending || step === 2 && !draft.codes.length) return;
  draft.step = step; syncBatchControls("issue");
  $("issueForm").querySelector(".issue-fields").scrollTop = 0;
  $(step === 1 ? "issueCouponsTitle" : "issueInformationTitle").focus({ preventScroll: true });
}
$("issueNext").addEventListener("click", () => setIssueStep(2));
$("issueBack").addEventListener("click", () => setIssueStep(1));
$("issueEmptyScan").addEventListener("click", () => openBatchScanner("issue"));
$("redeemEmptyScan").addEventListener("click", () => openBatchScanner("redeem"));

function renderScannedCodes(mode) {
  const view = batchViews[mode], draft = drafts[mode];
  $(view.count).textContent = `${draft.codes.length} / ${MAX_BATCH_SIZE} 张`;
  if (state.scanMode === mode) $("scanConfirmedCount").textContent = draft.codes.length;
  $(view.list).replaceChildren(...draft.codes.map((item) => {
    const row = document.createElement("li"), content = document.createElement("div"), code = document.createElement("strong"), type = document.createElement("span"), remove = document.createElement("button");
    code.textContent = item.code; code.className = "scanned-code";
    type.textContent = state.session.types[item.type]; type.className = `coupon-type ${item.type}`;
    content.append(code, type);
    if (item.error) { const error = document.createElement("p"); error.className = "coupon-error"; error.textContent = item.error; content.append(error); }
    remove.type = "button"; remove.textContent = "移除"; remove.dataset.removeCode = item.code; remove.setAttribute("aria-label", `移除 ${item.code}`);
    remove.addEventListener("click", () => { if (draft.busy || draft.pending) return; draft.codes = draft.codes.filter((entry) => entry.code !== item.code); renderScannedCodes(mode); syncBatchControls(mode); });
    row.append(content, remove); return row;
  }));
}

async function submitBatch(event, mode) {
  event.preventDefault();
  const view = batchViews[mode], draft = drafts[mode], form = $(view.form);
  if (draft.busy) return;
  // Advancing from scanning must never validate hidden fields or submit a batch.
  if (mode === "issue" && draft.step === 1) { setIssueStep(2); return; }
  if (!draft.pending) {
    const fields = mode === "issue" ? [["reason", "赠送原因"], ["operator", "操作人"]] : [["operator", "操作人"]];
    for (const [name, label] of fields) form.elements[name].setCustomValidity(form.elements[name].value.trim() ? "" : `请填写${label}。`);
    if (!form.reportValidity()) return;
    if (!draft.codes.length) { status(view.status, "请先批量扫码并确认至少一张优惠券。", true); return; }
    draft.pending = { requestId: crypto.randomUUID(), store: draft.store, codes: draft.codes.map((item) => item.code), operator: form.elements.operator.value,
      [view.time]: `${form.elements[view.time].value}+08:00`, ...(mode === "issue" ? { reason: form.elements.reason.value } : {}) };
  }
  draft.busy = true; syncBatchControls(mode); status(view.status, `正在${view.label}…`);
  try {
    const result = await api(view.endpoint, { method: "POST", body: JSON.stringify(draft.pending) });
    if (result.requestId !== draft.pending.requestId || !Array.isArray(result.results) || result.results.length !== draft.pending.codes.length ||
      !result.results.every((item, index) => item.index === index && typeof item.success === "boolean" && (item.success || typeof item.error?.message === "string"))) {
      throw new Error(`未收到完整的${view.label}结果。`);
    }
    draft.pending = null;
    draft.codes = result.results.filter((item) => !item.success).map((item) => ({ ...draft.codes[item.index], error: item.error.message }));
    renderScannedCodes(mode);
    const message = `已${view.label} ${result[view.successCount]} 张${result.failedCount ? `，${result.failedCount} 张失败，请核对${mode === "issue" ? "失败券的" : "下方"}原因。` : "。"}`;
    if (result.failedCount) {
      status(view.status, message, true);
      if (mode === "issue") $("issueForm").querySelector(".issue-fields").scrollTop = 0;
    }
    else $(view.dialog).close();
    state.page = 1;
    if (await loadList()) status("pageStatus", message, Boolean(result.failedCount));
    else if (state.session) $("pageStatus").prepend(`${message} `);
  } catch (error) {
    if (error.status >= 400 && error.status < 500) draft.pending = null;
    status(view.status, draft.pending ? `尚未确认${view.label}结果。请点击“重试${view.label}”查询原批次结果，确认结果前暂不可修改内容。` : error.message, true);
  } finally { draft.busy = false; syncBatchControls(mode); }
}

for (const [mode, view] of Object.entries(batchViews)) {
  $(view.open).addEventListener("click", () => {
    if (!can(view.permission)) return;
    const form = $(view.form); form.reset(); drafts[mode] = emptyDraft();
    for (const input of form.querySelectorAll("input, textarea")) input.setCustomValidity("");
    drafts[mode].store = state.store; $(view.store).textContent = storeLabel(state.store);
    form.elements.operator.value = state.session.account.displayName;
    form.elements[view.time].value = dateText(new Date()).slice(0, 16).replace(" ", "T");
    renderScannedCodes(mode); syncBatchControls(mode); status(view.status); $(view.dialog).showModal();
  });
  for (const input of $(view.form).querySelectorAll("input, textarea")) input.addEventListener("input", () => input.setCustomValidity(""));
  $(view.form).addEventListener("submit", (event) => submitBatch(event, mode));
  $(view.scanOpen).addEventListener("click", () => openBatchScanner(mode));
  $(view.dialog).addEventListener("cancel", (event) => { if (drafts[mode].busy) event.preventDefault(); });
  $(view.dialog).addEventListener("close", () => {
    if (state.scanMode === mode) finishScanning();
    drafts[mode] = emptyDraft(); $(view.open).focus();
  });
}

function openBatchScanner(mode) {
  const view = batchViews[mode], draft = drafts[mode];
  if (draft.busy || draft.pending || !can(view.permission) || state.scanMode || draft.codes.length >= MAX_BATCH_SIZE) return;
  state.scanMode = mode;
  $("scanStore").textContent = storeLabel(draft.store); $("scanPurpose").textContent = `${view.label}优惠券`;
  $("scanConfirmedCount").textContent = draft.codes.length;
  $("scanDialog").showModal(); startScanning();
}

const scanner = new CouponScanner({ video: $("scanVideo"), onCode: confirmScannedCode, onError(message) {
  state.candidate = null; $("scanConfirmation").hidden = true; $("scanEnd").disabled = false;
  setScanUiState("error");
  status("scanStatus", message, true); $("scanRetry").hidden = false; $("scanRetry").disabled = false;
} });

function confirmScannedCode(value) {
  if (!state.scanMode) return;
  const mode = state.scanMode, draft = drafts[mode], view = batchViews[mode];
  try {
    const item = parseCouponCode(value, draft.store);
    if (draft.codes.some((entry) => entry.code === item.code)) throw new Error("该券码已加入，请扫描下一张。");
    if (draft.codes.length >= MAX_BATCH_SIZE) throw new Error(`已达到${MAX_BATCH_SIZE}张上限，请结束扫码并${view.label}。`);
    state.candidate = item;
    $("scanCode").textContent = item.code;
    $("scanCouponType").className = `tag ${item.type}`; $("scanCouponType").textContent = state.session.types[item.type];
    $("scanCouponStore").textContent = storeLabel(item.store);
    $("scanConfirmHint").textContent = `确认后加入待${view.label}清单，不会立即${view.label}。`;
    status("scanStatus"); setScanUiState("confirm");
    $("scanConfirmation").hidden = false; $("scanEnd").disabled = true; $("scanConfirm").focus();
    $("scanConfirmation").querySelector(".scan-confirmation-body").scrollTop = 0;
  } catch (error) { setScanUiState("ready"); status("scanStatus", error.message, true); scanner.resume(); }
}

function dismissScanConfirmation(accept) {
  if (!state.scanMode) return;
  const mode = state.scanMode, draft = drafts[mode], view = batchViews[mode];
  if (accept && state.candidate) draft.codes.push(state.candidate);
  state.candidate = null; $("scanConfirmation").hidden = true; $("scanEnd").disabled = false;
  setScanUiState("ready");
  renderScannedCodes(mode); syncBatchControls(mode); scanner.resume();
  status("scanStatus", draft.codes.length >= MAX_BATCH_SIZE ? `已达到50张上限，请结束扫码并${view.label}。` : "请将下一张二维码对准相机。继续扫描同一码前请先将其移出画面。");
  $("scanEnd").focus();
}

async function startScanning() {
  setScanUiState("starting");
  $("scanRetry").hidden = true; $("scanRetry").disabled = true;
  status("scanStatus", "正在启动相机…");
  if (await scanner.start()) { setScanUiState("ready"); status("scanStatus", "请将二维码对准相机，识别后逐张确认。"); }
}

function setScanUiState(value) {
  $("scanDialog").dataset.scanState = value;
  $("scanPhase").textContent = { idle: "准备扫码", starting: "正在启动相机", ready: "扫描中", confirm: "等待确认", error: "相机未开启" }[value];
  $("scanClose").disabled = value === "confirm";
  $("scanEnd").hidden = value === "confirm";
}

function finishScanning() {
  const mode = state.scanMode;
  scanner.stop(); state.candidate = null; state.scanMode = null;
  $("scanConfirmation").hidden = true; $("scanEnd").disabled = false;
  setScanUiState("idle");
  if ($("scanDialog").open) $("scanDialog").close();
  if (mode && $(batchViews[mode].dialog).open) $(!drafts[mode].codes.length ? `${mode}EmptyScan` : batchViews[mode].scanOpen).focus({ preventScroll: true });
}

$("scanRetry").addEventListener("click", startScanning);
$("scanConfirm").addEventListener("click", () => dismissScanConfirmation(true));
$("scanCancel").addEventListener("click", () => dismissScanConfirmation(false));
$("scanEnd").addEventListener("click", finishScanning);
$("scanClose").addEventListener("click", finishScanning);
$("scanDialog").addEventListener("cancel", (event) => { event.preventDefault(); if (state.candidate) dismissScanConfirmation(false); else finishScanning(); });
$("scanDialog").addEventListener("close", () => { if (!$("scanDialog").open) finishScanning(); });
$("scanConfirmation").addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  event.preventDefault(); (document.activeElement === $("scanConfirm") ? $("scanCancel") : $("scanConfirm")).focus();
});
window.addEventListener("pagehide", finishScanning);
document.addEventListener("visibilitychange", () => { if (document.hidden && $("scanDialog").open) scanner.fail("相机已暂停，已确认券码仍保留。返回后请点击“重试相机”。"); });

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
  try { localStorage.setItem("comeover-admin-theme", root.dataset.theme); } catch {}
  renderTheme();
}); renderTheme();
window.addEventListener("storage", (event) => {
  if (event.key !== "comeover-admin-theme" || !["light", "dark"].includes(event.newValue)) return;
  document.documentElement.dataset.theme = event.newValue;
  document.documentElement.style.colorScheme = event.newValue;
  renderTheme();
});

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
    $("redeemOpen").hidden = !can("coupon:redeem");
    state.store = session.stores[0].id; await loadList();
  } catch (error) {
    emptyRow("暂时无法加载门店权限"); if (error.status !== 401) status("pageStatus", error.message, true);
  }
}
initialize();
