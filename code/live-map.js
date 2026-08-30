(function () {
  // ⚠️ À ajuster : domaine du conteneur n8n qui expose les webhooks livetrack-proxy / livetrack-runners.
  const PROXY_BASE = 'https://n8n.gcourtot.fr';

  const COLORS = ['#C97A34', '#8FA283', '#5B9BD5', '#D5A85B', '#B57ADB', '#5BC0AE', '#D5715B', '#7A96D5'];

  let map, backdropLayer;
  const state = {
    pollIntervalSec: 20,
    trackers: [] // { id, label, session_id, token, color, points: [], polyline, marker, labelMarker, status, lastUpdate, error }
  };
  let pollTimer = null;
  let selectedId = null;
  let userInteracted = false;

  // ---------- Storage (localStorage natif du navigateur, pas de dépendance Claude) ----------
  async function loadConfig() {
    try {
      const raw = localStorage.getItem('livetrack_config');
      if (raw) {
        const c = JSON.parse(raw);
        state.pollIntervalSec = c.pollIntervalSec || 20;
      }
    } catch (e) { /* pas encore de config sauvegardée */ }
  }
  async function saveConfig() {
    try {
      localStorage.setItem('livetrack_config', JSON.stringify({
        pollIntervalSec: state.pollIntervalSec
      }));
    } catch (e) { console.error('Erreur sauvegarde config', e); }
  }
  async function loadTrackers() {
    try {
      const raw = localStorage.getItem('livetrack_trackers');
      if (raw) {
        const list = JSON.parse(raw);
        list.forEach(t => addTrackerToState(t.label, t.session_id, t.token, t.color, t.id));
      }
    } catch (e) { /* pas encore de trackers sauvegardés */ }
  }
  async function persistTrackers() {
    try {
      const list = state.trackers.map(t => ({ id: t.id, label: t.label, session_id: t.session_id, token: t.token, color: t.color }));
      localStorage.setItem('livetrack_trackers', JSON.stringify(list));
    } catch (e) { console.error('Erreur sauvegarde trackers', e); }
  }

  // ---------- Map setup ----------
  function initMap() {
    map = L.map('map', { zoomControl: true }).setView([46.6, 2.3], 5);
    // Esri Dark Gray Canvas : gratuit, sans clé API requise (contrairement aux tuiles
    // CARTO basemaps.cartocdn.com qui exigent désormais une clé depuis fin août 2026).
    L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
      maxZoom: 16
    }).addTo(map);
    // Couche de labels (villes, routes) par-dessus le fond sombre, même fournisseur.
    L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 16
    }).addTo(map);
    // Dès que l'utilisateur pan/zoom manuellement, on arrête de recentrer automatiquement
    // (sauf clic explicite sur un coureur dans la sidebar, qui reste une action volontaire).
    map.on('dragstart zoomstart', () => { userInteracted = true; });
  }

  function fitAllActiveBounds() {
    const allPoints = [];
    state.trackers.forEach(t => t.points.forEach(p => allPoints.push([p.lat, p.lon])));
    if (!allPoints.length) return;
    if (allPoints.length === 1) { map.setView(allPoints[0], 15); return; }
    map.fitBounds(L.latLngBounds(allPoints), { padding: [50, 50], maxZoom: 16 });
  }

  // ---------- Tracker management ----------
  function nextColor() {
    const used = state.trackers.map(t => t.color);
    return COLORS.find(c => !used.includes(c)) || COLORS[state.trackers.length % COLORS.length];
  }

  function addTrackerToState(label, session_id, token, color, id) {
    const tracker = {
      id: id || (Date.now() + '-' + Math.random().toString(36).slice(2, 7)),
      label, session_id, token,
      color: color || nextColor(),
      points: [],
      polyline: null,
      marker: null,
      labelMarker: null,
      status: 'en attente',
      lastUpdate: null,
      error: null
    };
    tracker.polyline = L.polyline([], { color: tracker.color, weight: 3.5, opacity: 0.85 }).addTo(map);
    state.trackers.push(tracker);
    return tracker;
  }

  function removeTracker(id) {
    const t = state.trackers.find(t => t.id === id);
    if (!t) return;
    if (t.polyline) map.removeLayer(t.polyline);
    if (t.marker) map.removeLayer(t.marker);
    if (t.labelMarker) map.removeLayer(t.labelMarker);
    state.trackers = state.trackers.filter(t => t.id !== id);
    if (selectedId === id) selectedId = null;
    persistTrackers();
    renderSidebar();
  }

  // ---------- Polling ----------
  async function pollTracker(t) {
    if (!state.proxyBase) return;
    const hadNoPoints = t.points.length === 0;
    const lastPointTs = t.points.length ? t.points[t.points.length - 1].t : '1970-01-01T00:00:00.000Z';
    const url = `${webhookUrl('livetrack-proxy')}?session_id=${encodeURIComponent(t.session_id)}&token=${encodeURIComponent(t.token)}&begin=${encodeURIComponent(lastPointTs)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.points && data.points.length) {
        t.points.push(...data.points.filter(p => p.lat != null && p.lon != null));
        updateTrackerVisuals(t);
        if (hadNoPoints && t.points.length && !userInteracted) {
          fitAllActiveBounds();
        }
      }
      t.status = data.ended ? 'terminée' : 'en direct';
      t.error = null;
      t.lastUpdate = Date.now();
    } catch (e) {
      t.status = 'erreur';
      t.error = e.message;
    }
    renderSidebar();
  }

  function updateTrackerVisuals(t) {
    const latlngs = t.points.map(p => [p.lat, p.lon]);
    t.polyline.setLatLngs(latlngs);
    const last = t.points[t.points.length - 1];
    if (!last) return;
    if (t.marker) map.removeLayer(t.marker);
    if (t.labelMarker) map.removeLayer(t.labelMarker);
    t.marker = L.marker([last.lat, last.lon], {
      icon: L.divIcon({ className: '', html: `<div class="runner-marker" style="background:${t.color}"></div>`, iconSize: [16, 16] })
    }).addTo(map);
    t.labelMarker = L.marker([last.lat, last.lon], {
      icon: L.divIcon({ className: '', html: `<div class="runner-label">${escapeHtml(t.label)}</div>`, iconSize: [0, 0] }),
      interactive: false
    }).addTo(map);
  }

  function pollAll() {
    state.trackers.filter(t => t.status !== 'terminée').forEach(pollTracker);
    document.getElementById('poll-status').textContent = 'dernier poll : ' + new Date().toLocaleTimeString('fr-FR');
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollAll();
    pollTimer = setInterval(pollAll, Math.max(5, state.pollIntervalSec) * 1000);
  }

  // ---------- Stats ----------
  function computeStats(t) {
    if (!t.points.length) return { distanceKm: '—', pace: '—', hr: '—' };
    const last = t.points[t.points.length - 1];
    const distanceKm = (last.distance / 1000).toFixed(2);
    let pace = '—';
    const windowPts = t.points.slice(-6);
    if (windowPts.length >= 2) {
      const first = windowPts[0], lastW = windowPts[windowPts.length - 1];
      const dDist = lastW.distance - first.distance;
      const dTime = (new Date(lastW.t) - new Date(first.t)) / 1000;
      if (dDist > 0 && dTime > 0) {
        const paceMinPerKm = (dTime / 60) / (dDist / 1000);
        const min = Math.floor(paceMinPerKm);
        const sec = Math.round((paceMinPerKm - min) * 60);
        pace = `${min}:${String(sec).padStart(2, '0')}/km`;
      }
    }
    const hrVals = windowPts.map(p => p.hr).filter(v => v != null);
    const hr = hrVals.length ? Math.round(hrVals.reduce((a, b) => a + b, 0) / hrVals.length) : '—';
    return { distanceKm, pace, hr };
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `il y a ${s}s`;
    return `il y a ${Math.round(s / 60)}min`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Sidebar rendering ----------
  function renderSidebar() {
    const list = document.getElementById('tracker-list');
    const header = document.getElementById('header-sub');
    header.textContent = state.trackers.length
      ? `${state.trackers.length} coureur${state.trackers.length > 1 ? 's' : ''} suivi${state.trackers.length > 1 ? 's' : ''}`
      : 'Aucun coureur suivi';

    if (!state.trackers.length) {
      list.innerHTML = '<div id="empty-state">Ajoute un lien LiveTrack Garmin pour commencer à suivre une course. Plusieurs coureurs peuvent être suivis en même temps.</div>';
      return;
    }

    list.innerHTML = '';
    state.trackers.forEach(t => {
      const stats = computeStats(t);
      const row = document.createElement('div');
      row.className = 'tracker-row' + (t.id === selectedId ? ' selected' : '');
      row.innerHTML = `
        <div class="tracker-top">
          <div class="swatch" style="background:${t.color}"></div>
          <div class="tracker-name">${escapeHtml(t.label)}</div>
          <div class="tracker-status${t.status === 'terminée' ? ' ended' : ''}${t.status === 'erreur' ? ' error' : ''}">${t.status}</div>
        </div>
        <div class="tracker-stats">
          <div><div class="stat-num">${stats.distanceKm}</div><div class="stat-label">km</div></div>
          <div><div class="stat-num">${stats.pace}</div><div class="stat-label">allure (6 derniers pts)</div></div>
          <div><div class="stat-num">${stats.hr}</div><div class="stat-label">bpm moyen</div></div>
          <div><div class="stat-num">${t.points.length}</div><div class="stat-label">points reçus</div></div>
        </div>
        <div class="tracker-meta">
          <span>${t.lastUpdate ? timeAgo(t.lastUpdate) : (t.error || 'en attente')}</span>
          <button class="remove-btn" data-id="${t.id}">retirer</button>
        </div>
      `;
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('remove-btn')) return;
        selectedId = t.id;
        renderSidebar();
        if (t.points.length) {
          map.fitBounds(t.polyline.getBounds(), { padding: [40, 40], maxZoom: 16 });
        }
      });
      list.appendChild(row);
    });
    list.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTracker(btn.dataset.id);
      });
    });
  }

  // ---------- URL parsing ----------
  function parseLiveTrackUrl(url) {
    const m = url.match(/session\/([a-f0-9-]+)\/token\/([A-Za-z0-9]+)/i);
    if (!m) return null;
    return { session_id: m[1], token: m[2] };
  }

  // ---------- Sheet (add tracker / config) ----------
  const backdrop = document.getElementById('sheet-backdrop');
  const sheetError = document.getElementById('sheet-error');

  function openSheet() {
    sheetError.style.display = 'none';
    document.getElementById('in-interval').value = state.pollIntervalSec;
    backdrop.dataset.mode = 'config';
    backdrop.classList.add('open');
  }
  function closeSheet() { backdrop.classList.remove('open'); }

  document.getElementById('config-btn').addEventListener('click', () => openSheet());
  document.getElementById('sheet-cancel').addEventListener('click', closeSheet);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });

  document.getElementById('sheet-save').addEventListener('click', async () => {
    {
      const interval = parseInt(document.getElementById('in-interval').value, 10);
      state.pollIntervalSec = isNaN(interval) ? 20 : interval;
      await saveConfig();
      startPolling();
      closeSheet();
    }
  });

  // ---------- Synchronisation de la liste des coureurs (côté serveur) ----------
  function webhookUrl(path) {
    return `${PROXY_BASE.replace(/\/$/, '')}/webhook/${path}`;
  }

  async function syncRunnersList() {
    try {
      const res = await fetch(webhookUrl('livetrack-runners'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const runners = data.runners || [];
      runners.forEach(r => {
        const exists = state.trackers.some(t => t.session_id === r.session_id && t.token === r.token);
        if (!exists) {
          addTrackerToState(r.label, r.session_id, r.token);
        }
      });
      renderSidebar();
      if (!pollTimer) startPolling();
    } catch (e) {
      console.error('Erreur synchronisation coureurs', e);
    }
  }

  // ---------- Boot ----------
  async function boot() {
    initMap();
    await loadConfig();
    renderSidebar();
    await syncRunnersList();
    setInterval(syncRunnersList, 60000); // reconsulte la liste serveur toutes les 60s
  }
  boot();
})();
