(() => {
  async function fetchVersion() {
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      const j = await r.json();
      if (j && j.ok && j.version) return j.version;
    } catch {}
    return 'dev';
  }

  function ensureFooter() {
    let footer = document.querySelector('footer.footer');
    if (!footer) {
      footer = document.createElement('footer');
      footer.className = 'footer';
      footer.style.cssText = 'display:flex;gap:.5rem;align-items:center;justify-content:center;padding:.75rem 1rem;border-top:1px solid #e6e6e6;opacity:.95;font:14px/1.4 system-ui,Segoe UI,Roboto,Helvetica,Arial;';
      const left = document.createElement('span');
      left.textContent = 'Unraid Control';
      const ver = document.createElement('span');
      ver.id = 'app-version';
      ver.style.opacity = '0.7';
      footer.append(left, ver);
      document.body.appendChild(footer);
    } else if (!footer.querySelector('#app-version')) {
      const ver = document.createElement('span');
      ver.id = 'app-version';
      ver.style.opacity = '0.7';
      footer.appendChild(ver);
    }
    return footer.querySelector('#app-version');
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const verEl = ensureFooter();
    const v = await fetchVersion();
    if (verEl) verEl.textContent = ` v${v}`;
  });
})();
