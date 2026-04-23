(function () {
  const DEFAULT_BASE = 'http://localhost:3000';

  function getBaseUrl() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.get({ baseUrl: DEFAULT_BASE }, (o) => resolve(o.baseUrl || DEFAULT_BASE));
      } else {
        resolve(DEFAULT_BASE);
      }
    });
  }

  function setBaseUrl(url) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ baseUrl: url || DEFAULT_BASE });
    }
  }

  const baseInput = document.getElementById('baseUrl');
  const links = document.querySelectorAll('.links a[data-path]');

  getBaseUrl().then((url) => {
    baseInput.value = url;
  });

  baseInput.addEventListener('change', () => {
    const v = (baseInput.value || '').trim();
    if (v) setBaseUrl(v.replace(/\/$/, ''));
  });

  links.forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const path = a.getAttribute('data-path');
      getBaseUrl().then((base) => {
        const url = base.replace(/\/$/, '') + path;
        chrome.tabs.create({ url });
        window.close();
      });
    });
  });
})();
