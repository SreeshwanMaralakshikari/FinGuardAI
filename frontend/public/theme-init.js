/*
 * public/theme-init.js — Round 4 (R4-01). Runs in <head> before the app, so the page is painted in the
 * right theme from the first frame (no light flash). A separate file, not an inline script, because the
 * Content-Security-Policy allows scripts from 'self' only.
 * Choice: the one saved by the theme toggle (localStorage "finguard:theme"), else the OS setting.
 */
(function () {
  var theme = 'light';
  try {
    var saved = window.localStorage.getItem('finguard:theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) theme = 'dark';
  } catch (e) {
    /* storage blocked: keep light */
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
