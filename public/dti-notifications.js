/**
 * Notification bell: loads /api/notifications/panel (automation + support inbox).
 * Expects markup: #dtiNotifyWrap, #dtiNotifyBtn, #dtiNotifyBadge, #dtiNotifyPanel, #dtiNotifyList,
 * optional #dtiNotifyRefresh, #dtiNotifyClearAll
 */
(function initDtiNotificationBell() {
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

  function formatWhen(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso || '');
      return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (_) {
      return String(iso || '');
    }
  }

  function renderItems(listEl, items) {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'dti-notify-empty';
      empty.textContent = 'No notifications yet.';
      listEl.appendChild(empty);
      return;
    }
    items.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'dti-notify-row';
      var meta = document.createElement('div');
      meta.className = 'dti-notify-row-meta';
      meta.textContent = (it.kind === 'support' ? 'Support' : 'Activity') + ' · ' + formatWhen(it.at);
      var titleEl = document.createElement('div');
      titleEl.className = 'dti-notify-row-title';
      titleEl.textContent = it.title || 'Notice';
      row.appendChild(meta);
      row.appendChild(titleEl);
      if (it.body) {
        var body = document.createElement('div');
        body.className = 'dti-notify-row-body';
        body.textContent = it.body;
        row.appendChild(body);
      }
      listEl.appendChild(row);
    });
  }

  function setBadge(badge, n) {
    if (!badge) return;
    if (!n) {
      badge.classList.remove('show');
      badge.textContent = '';
      return;
    }
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.classList.add('show');
  }

  function bind() {
    var wrap = document.getElementById('dtiNotifyWrap');
    var btn = document.getElementById('dtiNotifyBtn');
    var panel = document.getElementById('dtiNotifyPanel');
    var list = document.getElementById('dtiNotifyList');
    var badge = document.getElementById('dtiNotifyBadge');
    var refreshBtn = document.getElementById('dtiNotifyRefresh');
    var clearAllBtn = document.getElementById('dtiNotifyClearAll');
    if (!wrap || !btn || !panel || !list) return;

    var open = false;
    var loading = false;

    function closePanel() {
      open = false;
      panel.classList.remove('show');
      btn.setAttribute('aria-expanded', 'false');
    }

    async function loadPanel() {
      if (loading) return;
      loading = true;
      while (list.firstChild) list.removeChild(list.firstChild);
      var loadingEl = document.createElement('div');
      loadingEl.className = 'dti-notify-empty';
      loadingEl.textContent = 'Loading…';
      list.appendChild(loadingEl);
      try {
        var res = await fetch('/api/notifications/panel', { credentials: 'include' });
        var data = await res.json().catch(function () {
          return {};
        });
        if (!res.ok || !data || data.ok !== true) {
          while (list.firstChild) list.removeChild(list.firstChild);
          var err = document.createElement('div');
          err.className = 'dti-notify-empty';
          err.textContent = (data && data.message) || 'Could not load notifications.';
          list.appendChild(err);
          return;
        }
        var items = Array.isArray(data.items) ? data.items : [];
        renderItems(list, items);
        setBadge(badge, items.length);
      } catch (_) {
        while (list.firstChild) list.removeChild(list.firstChild);
        var net = document.createElement('div');
        net.className = 'dti-notify-empty';
        net.textContent = 'Network error.';
        list.appendChild(net);
      } finally {
        loading = false;
      }
    }

    async function refreshBadgeOnly() {
      try {
        var res = await fetch('/api/notifications/panel', { credentials: 'include' });
        var data = await res.json().catch(function () {
          return {};
        });
        if (!res.ok || !data || data.ok !== true) {
          setBadge(badge, 0);
          return;
        }
        var items = Array.isArray(data.items) ? data.items : [];
        setBadge(badge, items.length);
      } catch (_) {}
    }

    async function clearAllNotifications() {
      if (clearAllBtn) clearAllBtn.disabled = true;
      try {
        var res = await fetch('/api/notifications/clear', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        var data = await res.json().catch(function () {
          return {};
        });
        if (!res.ok || !data || data.ok !== true) {
          return;
        }
        if (open) await loadPanel();
        else await refreshBadgeOnly();
      } catch (_) {
      } finally {
        if (clearAllBtn) clearAllBtn.disabled = false;
      }
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!panel.classList.contains('show')) open = false;
      try {
        var inPan = document.getElementById('dtiInnovationPanel');
        var inBtn = document.getElementById('dtiInnovationBtn');
        if (inPan) inPan.classList.remove('show');
        if (inBtn) inBtn.setAttribute('aria-expanded', 'false');
      } catch (_) {}
      open = !open;
      if (open) {
        closeProfileDropdowns();
        panel.classList.add('show');
        btn.setAttribute('aria-expanded', 'true');
        loadPanel();
      } else {
        closePanel();
      }
    });

    if (refreshBtn) {
      refreshBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (open) loadPanel();
        else refreshBadgeOnly();
      });
    }

    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        clearAllNotifications();
      });
    }

    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) closePanel();
    });

    refreshBadgeOnly();
    setInterval(refreshBadgeOnly, 90000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
