/**
 * Innovation highlights: panel in header + optional on-page spotlights (data-innovation).
 * List content is loaded from POST /api/innovation/highlights when signed in (AI or curated fallback).
 */
(function initDtiInnovationHighlights() {
  var STORAGE_KEY = 'dtiInnovationSpotlight';
  var CACHE_PREFIX = 'dtiInnovationAiCache_v1_';
  var CACHE_TTL_MS = 12 * 60 * 1000;

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

  function closeNotifyPanel() {
    try {
      var np = document.getElementById('dtiNotifyPanel');
      var nb = document.getElementById('dtiNotifyBtn');
      if (np) np.classList.remove('show');
      if (nb) nb.setAttribute('aria-expanded', 'false');
    } catch (_) {}
  }

  function pageKey() {
    var p = (location.pathname || '').toLowerCase();
    if (p.indexOf('student') !== -1) return 'student';
    if (p.indexOf('leadership') !== -1) return 'leadership';
    return 'faculty';
  }

  /** Local fallback when offline, 401, or before first fetch. */
  var STATIC_FALLBACK = {
    student: [
      {
        id: 'studentMainLiveCard',
        title: 'Live preview & WebRTC',
        text: 'Encrypted path from your device to faculty: camera preview, streaming controls, and session status in one place.',
      },
      {
        id: 'studentSessionControlsSection',
        title: 'End-to-end encrypted session',
        text: 'Attention signals are protected in transit; session controls gate camera and streaming while class is active.',
      },
      {
        id: 'studentAttentionSection',
        title: 'On-device AI attention (privacy-first)',
        text: 'Gaze and posture signals are processed locally into an anonymised score—no facial recognition storage.',
      },
      {
        id: 'studentLearningModeSection',
        title: 'Learning mode (device-local)',
        text: 'Listening, note-taking, or discussion mode stays on this device and is not shared as identity.',
      },
      {
        id: 'studentAttendanceSection',
        title: 'Smart attendance & history',
        text: 'Hybrid Present / Absent / OD with session history and refresh—aligned with faculty and leadership views.',
      },
      {
        id: 'studentOdSection',
        title: 'OD proof workflow',
        text: 'Structured on-duty uploads with Assistant HoD / HoD visibility and status tracking on your dashboard.',
      },
      {
        id: 'studentConnectionSection',
        title: 'Timetable & venue awareness',
        text: 'Connection panel ties faculty presence to timetable-synced venue hints for the right class context.',
      },
    ],
    faculty: [
      {
        id: 'cameraVideoWrap',
        title: 'Live student stream',
        text: 'Low-latency view of the signed-in student device with connection health for teaching decisions.',
      },
      {
        id: 'facultySessionDetailsSection',
        title: 'Smart Classroom Locator sessions',
        text: 'Block–floor–room venue capture, multi-session list, and encrypted attention for each class.',
      },
      {
        id: 'facultyTeachingPulseSection',
        title: 'Live Teaching Pulse & Digital Twin',
        text: 'Rolling attention, trend chart, zone heatmap, and AI insight—designed for formative feedback, not grading.',
      },
      {
        id: 'teachingCoachSection',
        title: 'Adaptive Teaching Coach',
        text: 'Context-aware teaching tips from current attention and classroom signals to support pacing and checks.',
      },
      {
        id: 'facultySmartAttendanceSection',
        title: 'Smart Attendance (hybrid)',
        text: 'Hand-raise window, face/attention signals, OD visibility, edit mode, and resilient refresh for busy networks.',
      },
    ],
    leadership: [
      {
        id: 'leaderE2eBanner',
        title: 'Encryption in transit',
        text: 'Leadership overview and approvals are served over HTTPS with server-side protection of session data.',
      },
      {
        id: 'leaderOverviewSection',
        title: 'Engagement summary',
        text: 'Cross-session attention aggregates, low-attention flags, and OD counts scoped to your responsibility.',
      },
      {
        id: 'leaderSessionsSection',
        title: 'Recent sessions lens',
        text: 'Topic, faculty, department, and attention snapshots for operational awareness across the college.',
      },
      {
        id: 'leaderDeptAttendanceSection',
        title: 'Department attendance (HoD)',
        text: 'Hybrid Present | Absent | OD roll-ups by session for departmental oversight.',
      },
      {
        id: 'leaderOdQueueSection',
        title: 'OD approval queue',
        text: 'Assistant HoD and HoD staged decisions with proof links—mirrors the workflow students and faculty use.',
      },
    ],
  };

  function cacheStorageKey() {
    return CACHE_PREFIX + pageKey();
  }

  function readSessionCache() {
    try {
      var raw = sessionStorage.getItem(cacheStorageKey());
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || typeof o.t !== 'number' || !Array.isArray(o.items) || !o.items.length) return null;
      if (Date.now() - o.t > CACHE_TTL_MS) return null;
      return o;
    } catch (_) {
      return null;
    }
  }

  function writeSessionCache(entry) {
    try {
      sessionStorage.setItem(
        cacheStorageKey(),
        JSON.stringify({
          t: Date.now(),
          source: entry.source,
          provider: entry.provider || null,
          items: entry.items,
        })
      );
    } catch (_) {}
  }

  function applySpotlight(on) {
    if (on) {
      document.body.classList.add('dti-innovation-spotlight');
    } else {
      document.body.classList.remove('dti-innovation-spotlight');
    }
    try {
      localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch (_) {}
  }

  function flashTarget(el) {
    if (!el) return;
    el.classList.remove('dti-innovation-flash');
    void el.offsetWidth;
    el.classList.add('dti-innovation-flash');
    setTimeout(function () {
      el.classList.remove('dti-innovation-flash');
    }, 1400);
  }

  function setSourcePill(pill, source, provider) {
    if (!pill) return;
    pill.classList.remove('dti-innovation-source-ai', 'dti-innovation-source-loading');
    if (source === 'loading') {
      pill.textContent = 'Loading…';
      pill.classList.add('dti-innovation-source-loading');
      return;
    }
    if (source === 'ai') {
      var p = provider ? String(provider).trim() : '';
      pill.textContent = p ? 'AI · ' + p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : 'AI';
      pill.classList.add('dti-innovation-source-ai');
      return;
    }
    pill.textContent = 'Curated';
  }

  function renderItemList(list, items) {
    while (list.firstChild) list.removeChild(list.firstChild);
    (items || []).forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dti-innovation-item';
      var t = document.createElement('div');
      t.className = 'dti-innovation-item-title';
      t.textContent = it.title;
      var x = document.createElement('div');
      x.className = 'dti-innovation-item-text';
      x.textContent = it.text;
      b.appendChild(t);
      b.appendChild(x);
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var el = document.getElementById(it.id);
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          flashTarget(el);
        }
      });
      list.appendChild(b);
    });
  }

  function bind() {
    var wrap = document.getElementById('dtiInnovationWrap');
    var btn = document.getElementById('dtiInnovationBtn');
    var panel = document.getElementById('dtiInnovationPanel');
    var list = document.getElementById('dtiInnovationList');
    var cb = document.getElementById('dtiInnovationSpotlightCb');
    var pill = document.getElementById('dtiInnovationSourcePill');
    var refreshBtn = document.getElementById('dtiInnovationAiRefresh');
    if (!wrap || !btn || !panel || !list) return;

    var open = false;
    var staticItems = STATIC_FALLBACK[pageKey()] || STATIC_FALLBACK.faculty;
    var fetchGen = 0;

    var cached = readSessionCache();
    if (cached && cached.items.length) {
      renderItemList(list, cached.items);
      setSourcePill(pill, cached.source === 'ai' ? 'ai' : 'static', cached.provider);
    } else {
      renderItemList(list, staticItems);
      setSourcePill(pill, 'static', null);
    }

    function closePanel() {
      open = false;
      panel.classList.remove('show');
      btn.setAttribute('aria-expanded', 'false');
    }

    function loadHighlights(forceRefresh) {
      if (forceRefresh) {
        try {
          sessionStorage.removeItem(cacheStorageKey());
        } catch (_) {}
      } else {
        var c = readSessionCache();
        if (c && c.items.length) {
          renderItemList(list, c.items);
          setSourcePill(pill, c.source === 'ai' ? 'ai' : 'static', c.provider);
          return;
        }
      }

      var myGen = ++fetchGen;
      setSourcePill(pill, 'loading', null);
      list.classList.add('dti-innovation-loading');
      if (refreshBtn) refreshBtn.disabled = true;

      fetch('/api/innovation/highlights', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboard: pageKey() }),
      })
        .then(function (r) {
          return r.json().then(function (data) {
            return { ok: r.ok, status: r.status, data: data };
          });
        })
        .then(function (res) {
          if (myGen !== fetchGen) return;
          var d = res.data || {};
          if (!res.ok || !d.ok) {
            renderItemList(list, staticItems);
            setSourcePill(pill, 'static', null);
            return;
          }
          var items = Array.isArray(d.items) ? d.items : [];
          if (!items.length) {
            renderItemList(list, staticItems);
            setSourcePill(pill, 'static', null);
            return;
          }
          renderItemList(list, items);
          var src = d.source === 'ai' ? 'ai' : 'static';
          setSourcePill(pill, src, d.provider);
          writeSessionCache({ source: src, provider: d.provider, items: items });
        })
        .catch(function () {
          if (myGen !== fetchGen) return;
          renderItemList(list, staticItems);
          setSourcePill(pill, 'static', null);
        })
        .finally(function () {
          if (myGen !== fetchGen) return;
          list.classList.remove('dti-innovation-loading');
          if (refreshBtn) refreshBtn.disabled = false;
        });
    }

    function openPanel() {
      closeProfileDropdowns();
      closeNotifyPanel();
      open = true;
      panel.classList.add('show');
      btn.setAttribute('aria-expanded', 'true');
      loadHighlights(false);
    }

    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      var spotlightOn = saved === '1';
      if (cb) cb.checked = spotlightOn;
      applySpotlight(spotlightOn);
    } catch (_) {
      if (cb) cb.checked = false;
    }

    if (cb) {
      cb.addEventListener('change', function () {
        applySpotlight(!!cb.checked);
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        loadHighlights(true);
      });
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!panel.classList.contains('show')) open = false;
      open = !open;
      if (open) openPanel();
      else closePanel();
    });

    var profileInnovationBtns = document.querySelectorAll('.dti-profile-open-innovation');
    for (var pi = 0; pi < profileInnovationBtns.length; pi += 1) {
      profileInnovationBtns[pi].addEventListener('click', function (e) {
        e.stopPropagation();
        open = true;
        openPanel();
      });
    }

    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) closePanel();
    });

    if (!panel.querySelector('.dti-innovation-foot')) {
      var foot = document.createElement('div');
      foot.className = 'dti-innovation-foot';
      foot.textContent =
        'Highlights are tailored to this dashboard (AI when signed in, otherwise curated). Tap AI refresh for a new set. Spotlights add a gentle animated rim on highlighted areas; tap an item to scroll there.';
      panel.appendChild(foot);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
