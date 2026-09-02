(function () {
  // ⚠️ À ajuster : domaine du conteneur n8n qui expose les webhooks livetrack-proxy / livetrack-runners.
  const PROXY_BASE = 'https://n8n.gcourtot.fr';
  // Backend du service de messages vocaux (projet séparé "VoiceMessage" / walkie).
  const WALKIE_BASE = 'https://walkie.gcourtot.fr';

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

  function addTrackerToState(label, session_id, token, color, id, walkieChannel) {
    const tracker = {
      id: id || (Date.now() + '-' + Math.random().toString(36).slice(2, 7)),
      label, session_id, token,
      walkieChannel: walkieChannel || null,
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
          <div class="tracker-quick">${stats.distanceKm} km</div>
          <div class="tracker-status${t.status === 'terminée' ? ' ended' : ''}${t.status === 'erreur' ? ' error' : ''}">${t.status}</div>
          ${t.walkieChannel ? `<button type="button" class="walkie-icon-btn" title="Envoyer un message vocal à ${escapeHtml(t.label)}">🎙️</button>` : ''}
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
        ${t.walkieChannel ? `<button type="button" class="walkie-btn">🎙️ Envoyer un message vocal à ${escapeHtml(t.label)}</button>` : ''}
      `;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.remove-btn') || e.target.closest('.walkie-icon-btn') || e.target.closest('.walkie-btn')) return;
        const isMobile = window.matchMedia('(max-width: 720px)').matches;
        if (isMobile && selectedId === t.id) {
          selectedId = null;
          renderSidebar();
          return;
        }
        selectedId = t.id;
        renderSidebar();
        if (t.points.length) {
          map.fitBounds(t.polyline.getBounds(), { padding: [40, 40], maxZoom: 16 });
        }
      });
      row.querySelectorAll('.walkie-icon-btn, .walkie-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openWalkieSheet(t);
        });
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

  // ---------- Sheet (config / message vocal) ----------
  const backdrop = document.getElementById('sheet-backdrop');
  const sheetError = document.getElementById('sheet-error');
  const sheetTitle = document.getElementById('sheet-title');
  const configFields = document.getElementById('config-fields');
  const walkieFields = document.getElementById('walkie-fields');
  const sheetSaveBtn = document.getElementById('sheet-save');
  const sheetCancelBtn = document.getElementById('sheet-cancel');

  function openSheet() {
    abortWalkieRecording();
    resetWalkieRecorder();
    sheetError.style.display = 'none';
    sheetTitle.textContent = 'Réglages';
    configFields.hidden = false;
    walkieFields.hidden = true;
    sheetSaveBtn.hidden = false;
    sheetCancelBtn.textContent = 'Annuler';
    document.getElementById('in-interval').value = state.pollIntervalSec;
    backdrop.dataset.mode = 'config';
    backdrop.classList.add('open');
  }
  function closeSheet() {
    backdrop.classList.remove('open');
    if (backdrop.dataset.mode === 'walkie') {
      abortWalkieRecording();
      resetWalkieRecorder();
    }
  }

  document.getElementById('config-btn').addEventListener('click', () => openSheet());
  document.getElementById('sheet-cancel').addEventListener('click', closeSheet);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });

  // ---------- Message vocal (enregistrement + envoi, in-page) ----------
  const WALKIE_MAX_DURATION_SECONDS = 120;
  const WALKIE_AUDIO_BITS_PER_SECOND = 24000;
  const WALKIE_MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const WALKIE_SENDER_KEY = 'walkie:sender-name';

  const walkieSenderInput = document.getElementById('walkie-sender');
  const walkieRecordBtn = document.getElementById('walkie-record-btn');
  const walkieTimerEl = document.getElementById('walkie-timer');
  const walkiePreview = document.getElementById('walkie-preview');
  const walkieReviewActions = document.getElementById('walkie-review-actions');
  const walkieSendBtn = document.getElementById('walkie-send-btn');
  const walkieDiscardBtn = document.getElementById('walkie-discard-btn');
  const walkieStatus = document.getElementById('walkie-status');

  let walkieChannel = null;
  let walkieStream = null;
  let walkieMediaRecorder = null;
  let walkieChunks = [];
  let walkieRecordedBlob = null;
  let walkieStartedAt = 0;
  let walkieTimerHandle = null;
  let walkieAutoStopHandle = null;

  walkieSenderInput.value = localStorage.getItem(WALKIE_SENDER_KEY) ?? '';
  walkieSenderInput.addEventListener('change', () => {
    localStorage.setItem(WALKIE_SENDER_KEY, walkieSenderInput.value.trim());
  });

  function pickWalkieMimeType() {
    return WALKIE_MIME_CANDIDATES.find(type => window.MediaRecorder?.isTypeSupported?.(type)) ?? '';
  }
  function formatWalkieTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }
  function updateWalkieTimer() {
    const elapsed = (Date.now() - walkieStartedAt) / 1000;
    walkieTimerEl.textContent = `${formatWalkieTime(elapsed)} / ${formatWalkieTime(WALKIE_MAX_DURATION_SECONDS)}`;
  }

  async function startWalkieRecording() {
    walkieStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickWalkieMimeType();
    walkieMediaRecorder = new MediaRecorder(walkieStream, mimeType ? { mimeType, audioBitsPerSecond: WALKIE_AUDIO_BITS_PER_SECOND } : {});
    walkieChunks = [];
    walkieMediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) walkieChunks.push(e.data); };
    walkieMediaRecorder.onstop = () => {
      walkieStream.getTracks().forEach(tr => tr.stop());
      walkieStream = null;
      walkieRecordedBlob = new Blob(walkieChunks, { type: walkieMediaRecorder.mimeType || mimeType || 'audio/webm' });
      walkiePreview.src = URL.createObjectURL(walkieRecordedBlob);
      walkiePreview.hidden = false;
      walkieReviewActions.hidden = false;
      walkieRecordBtn.hidden = true;
    };
    walkieMediaRecorder.start();
    walkieStartedAt = Date.now();
    walkieTimerEl.hidden = false;
    updateWalkieTimer();
    walkieTimerHandle = setInterval(updateWalkieTimer, 500);
    walkieAutoStopHandle = setTimeout(stopWalkieRecording, WALKIE_MAX_DURATION_SECONDS * 1000);
    walkieRecordBtn.textContent = 'Arrêter';
    walkieRecordBtn.classList.add('recording');
  }

  function stopWalkieRecording() {
    clearInterval(walkieTimerHandle);
    clearTimeout(walkieAutoStopHandle);
    if (walkieMediaRecorder && walkieMediaRecorder.state !== 'inactive') walkieMediaRecorder.stop();
  }

  // Coupe court sans mettre à jour l'UI (sheet en train de se fermer) : évite que le
  // onstop asynchrone de startWalkieRecording ne réaffiche la preview après un reset.
  function abortWalkieRecording() {
    clearInterval(walkieTimerHandle);
    clearTimeout(walkieAutoStopHandle);
    if (walkieMediaRecorder) {
      walkieMediaRecorder.onstop = null;
      if (walkieMediaRecorder.state !== 'inactive') walkieMediaRecorder.stop();
      walkieMediaRecorder = null;
    }
    if (walkieStream) {
      walkieStream.getTracks().forEach(tr => tr.stop());
      walkieStream = null;
    }
  }

  function resetWalkieRecorder() {
    walkieRecordedBlob = null;
    walkiePreview.hidden = true;
    walkiePreview.removeAttribute('src');
    walkieReviewActions.hidden = true;
    walkieRecordBtn.hidden = false;
    walkieRecordBtn.disabled = false;
    walkieRecordBtn.textContent = 'Enregistrer';
    walkieRecordBtn.classList.remove('recording');
    walkieTimerEl.hidden = true;
    walkieStatus.textContent = '';
  }

  walkieRecordBtn.addEventListener('click', async () => {
    if (!walkieMediaRecorder || walkieMediaRecorder.state === 'inactive') {
      walkieRecordBtn.disabled = true;
      try {
        await startWalkieRecording();
      } catch (e) {
        walkieStatus.textContent = "Impossible d'accéder au microphone.";
      } finally {
        walkieRecordBtn.disabled = false;
      }
    } else {
      stopWalkieRecording();
    }
  });
  walkieDiscardBtn.addEventListener('click', resetWalkieRecorder);

  async function uploadWalkieRecording() {
    if (!walkieRecordedBlob || !walkieChannel) return;
    walkieSendBtn.disabled = true;
    walkieDiscardBtn.disabled = true;
    walkieStatus.textContent = 'Envoi en cours…';
    try {
      const form = new FormData();
      const ext = (walkieRecordedBlob.type.split('/')[1] || 'webm').split(';')[0];
      form.append('audio', walkieRecordedBlob, `recording.${ext}`);
      form.append('sender', walkieSenderInput.value.trim());
      const res = await fetch(`${WALKIE_BASE}/channels/${encodeURIComponent(walkieChannel)}/messages`, { method: 'POST', body: form });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      resetWalkieRecorder();
      walkieStatus.textContent = 'Message envoyé !';
    } catch (e) {
      walkieStatus.textContent = "Échec de l'envoi. Vérifie ta connexion et réessaie.";
    } finally {
      walkieSendBtn.disabled = false;
      walkieDiscardBtn.disabled = false;
    }
  }
  walkieSendBtn.addEventListener('click', uploadWalkieRecording);

  async function openWalkieSheet(t) {
    abortWalkieRecording();
    resetWalkieRecorder();
    walkieChannel = t.walkieChannel;
    sheetError.style.display = 'none';
    sheetTitle.textContent = `Message vocal — ${t.label}`;
    configFields.hidden = true;
    walkieFields.hidden = false;
    sheetSaveBtn.hidden = true;
    sheetCancelBtn.textContent = 'Fermer';
    backdrop.dataset.mode = 'walkie';
    backdrop.classList.add('open');

    walkieRecordBtn.disabled = true;
    walkieStatus.textContent = 'Vérification du lien…';
    try {
      const res = await fetch(`${WALKIE_BASE}/channels/${encodeURIComponent(walkieChannel)}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      walkieStatus.textContent = '';
      walkieRecordBtn.disabled = false;
    } catch (e) {
      walkieStatus.textContent = 'Lien invalide ou expiré.';
    }
  }

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
        const existing = state.trackers.find(t => t.session_id === r.session_id && t.token === r.token);
        if (!existing) {
          addTrackerToState(r.label, r.session_id, r.token, null, null, r.walkie_channel);
        } else {
          // Le channel walkie peut avoir été ajouté/modifié depuis le dernier sync
          existing.walkieChannel = r.walkie_channel || null;
        }
      });
      renderSidebar();
      if (!pollTimer) startPolling();
    } catch (e) {
      console.error('Erreur synchronisation coureurs', e);
    }
  }

  // ---------- Debug (temporaire) ----------
  window.debugState = () => ({
    proxyBase: PROXY_BASE,
    pollTimer,
    trackerCount: state.trackers.length,
    trackers: state.trackers.map(t => ({ label: t.label, status: t.status, points: t.points.length, error: t.error }))
  });

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
