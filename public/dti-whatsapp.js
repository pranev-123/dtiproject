/**
 * WhatsApp support: loads /api/whatsapp/support and wires profile menu + optional .dti-whatsapp-link anchors.
 */
(function initDtiWhatsappSupport() {
  var DEFAULT_TEXT = 'REC SmartAssist query';
  var DEFAULT_WA =
    'https://wa.me/916383596165?text=' + encodeURIComponent(DEFAULT_TEXT);
  var DEFAULT_PHONE_LABEL = '6383596165';

  var cachedUrl = DEFAULT_WA;

  function closeProfileDropdowns() {
    try {
      var s = document.getElementById('studentProfileDropdownMenu');
      var sb = document.getElementById('studentProfileMenuBtn');
      if (s && s.classList.contains('show')) {
        s.classList.remove('show');
        if (sb) sb.setAttribute('aria-expanded', 'false');
        s.setAttribute('aria-hidden', 'true');
      }
    } catch (_) {}
    try {
      var p = document.getElementById('profileDropdownMenu');
      var pb = document.getElementById('profileMenuBtn');
      if (p && p.classList.contains('show')) {
        p.classList.remove('show');
        if (pb) pb.setAttribute('aria-expanded', 'false');
        p.setAttribute('aria-hidden', 'true');
      }
    } catch (_) {}
    try {
      var l = document.getElementById('leaderProfileDropdownMenu');
      var lb = document.getElementById('leaderProfileMenuBtn');
      if (l && l.classList.contains('show')) {
        l.classList.remove('show');
        if (lb) lb.setAttribute('aria-expanded', 'false');
        l.setAttribute('aria-hidden', 'true');
      }
    } catch (_) {}
  }

  function applyConfig(data) {
    var url = DEFAULT_WA;
    var phoneLabel = DEFAULT_PHONE_LABEL;
    if (data && data.ok && data.waUrl) {
      url = data.waUrl;
      if (data.phoneDisplay) phoneLabel = String(data.phoneDisplay);
    }
    cachedUrl = url;

    document.querySelectorAll('a.dti-whatsapp-link').forEach(function (a) {
      a.href = url;
    });
    document.querySelectorAll('.dti-wa-phone-label').forEach(function (el) {
      el.textContent = phoneLabel;
    });
  }

  function openWhatsApp() {
    window.open(cachedUrl || DEFAULT_WA, '_blank', 'noopener,noreferrer');
    closeProfileDropdowns();
  }

  function bindProfileButtons() {
    document.querySelectorAll('.dti-profile-open-whatsapp').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openWhatsApp();
      });
    });
  }

  function init() {
    bindProfileButtons();
    fetch('/api/whatsapp/support', { credentials: 'include' })
      .then(function (r) {
        return r.json().catch(function () {
          return {};
        });
      })
      .then(function (data) {
        applyConfig(data);
      })
      .catch(function () {
        applyConfig(null);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
