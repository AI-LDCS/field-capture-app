// Runs before the page paints, so a saved theme never flashes the wrong colours. An external file,
// because the Content-Security-Policy blocks inline scripts. web/src/theme.tsx takes over after this.
(() => {
  let choice = null;
  try {
    choice = localStorage.getItem("fc-theme");
  } catch {
    /* storage blocked: follow the system */
  }
  const dark = choice === "dark" || (choice !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#1b1f25" : "#1d4ed8");
})();
