// FE-10: resolve the persisted theme BEFORE the stylesheet applies, so a
// dark-mode owner never sees a light flash on reload. Kept as an external
// same-origin file: the server's strict script-src 'self' CSP blocks inline
// scripts, and a hash allowlist would silently break on every edit.
(function () {
  try {
    var stored = localStorage.getItem('cloudnest.theme');
    var theme = stored === 'dark' || stored === 'light' ? stored : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
  } catch (e) {
    // storage unavailable: the default light theme applies
  }
})();
