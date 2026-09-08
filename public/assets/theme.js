(() => {
  let theme;
  try { theme = localStorage.getItem("store-management-theme"); } catch {}
  theme = ["light", "dark"].includes(theme) ? theme : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
