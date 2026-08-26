let map, drawnLayer, drawControl, partidosLayer;
let currentUser = null;
let clients = [];
let fields = [];
let pendingLayer = null; // polygon being saved
let editingFieldId = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------------- AUTH ----------------
async function checkSession() {
  const r = await fetch('/api/me');
  const user = await r.json();
  if (user) {
    currentUser = user;
    showApp();
  } else {
    showLogin();
  }
}

function showLogin() {
  $('#loginScreen').classList.remove('hidden');
  $('#app').classList.add('hidden');
}

async function showApp() {
  $('#loginScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#userLabel').textContent = `👤 ${currentUser.username}`;
  if (currentUser.role === 'admin') $('#adminBtn').classList.remove('hidden');
  if (!map) initMap();
  await loadClients();
  await loadFields();
  renderFieldsList();
  renderClientsList();
  setTimeout(() => map.invalidateSize(), 200);
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#loginUser').value.trim();
  const password = $('#loginPass').value;
  $('#loginError').textContent = '';
  const r = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (r.ok) {
    currentUser = await r.json();
    showApp();
  } else {
    const err = await r.json().catch(() => ({}));
    $('#loginError').textContent = err.error || 'Error al iniciar sesión';
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  currentUser = null;
  location.reload();
});

// ---------------- MAP ----------------
function initMap() {
  map = L.map('map', { zoomControl: true, minZoom: 6 }).setView([-35.79, -58.14], 9);

  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri', maxZoom: 19
  }).addTo(map);

  const labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, opacity: 0.9
  }).addTo(map);

  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap', maxZoom: 19
  });

  // Partidos overlay
  partidosLayer = L.geoJSON(null, {
    style: { color: '#FFD400', weight: 2, dashArray: '6,4', fillOpacity: 0.02, fillColor: '#FFD400' }
  }).addTo(map);

  fetch('/partidos.geojson').then(r => r.json()).then(gj => {
    partidosLayer.addData(gj);
    gj.features.forEach(f => {
      try {
        const centroid = turf.centroid(f);
        const [lng, lat] = centroid.geometry.coordinates;
        L.marker([lat, lng], {
          icon: L.divIcon({ className: 'partido-label', html: f.properties.nombre, iconSize: [140, 16] }),
          interactive: false
        }).addTo(map);
      } catch (e) {}
    });
  });

  drawnLayer = new L.FeatureGroup().addTo(map);

  drawControl = new L.Control.Draw({
    position: 'topleft',
    draw: {
      polygon: { allowIntersection: false, showArea: true, shapeOptions: { color: '#ff8f00', weight: 3, fillOpacity: 0.25, fillColor: '#ff8f00' } },
      polyline: false, rectangle: false, circle: false, marker: false, circlemarker: false
    },
    edit: { featureGroup: drawnLayer, remove: false }
  });
  map.addControl(drawControl);

  L.control.layers({ 'Satélite': satellite, 'Calles': osm }, { 'Partidos': partidosLayer }, { position: 'topright' }).addTo(map);

  map.on(L.Draw.Event.CREATED, (e) => {
    pendingLayer = e.layer;
    drawnLayer.addLayer(pendingLayer);
    openDrawForm(pendingLayer);
  });
}

function openDrawForm(layer) {
  const geojson = layer.toGeoJSON();
  const areaM2 = turf.area(geojson);
  const areaHa = (areaM2 / 10000).toFixed(2);
  $('#areaDisplay').textContent = areaHa;

  // detect partido
  let partidoName = '';
  if (partidosLayer) {
    partidosLayer.eachLayer(pl => {
      try {
        if (turf.booleanIntersects(geojson, pl.toGeoJSON())) {
          partidoName = pl.feature.properties.nombre;
        }
      } catch (e) {}
    });
  }
  $('#partidoDisplay').textContent = partidoName ? `Partido: ${partidoName}` : '';

  editingFieldId = null;
  $('#fieldName').value = '';
  $('#fieldCrop').value = '';
  $('#fieldCampaign').value = '';
  fillClientSelect();
  $('#drawForm').classList.remove('hidden');
  switchTab('draw');

  $('#saveFieldBtn').onclick = () => saveField(geojson, parseFloat(areaHa), partidoName);
  $('#cancelFieldBtn').onclick = () => {
    drawnLayer.removeLayer(layer);
    $('#drawForm').classList.add('hidden');
  };
}

async function saveField(geojson, areaHa, partidoName) {
  const client_id = $('#fieldClient').value;
  const name = $('#fieldName').value.trim();
  if (!client_id) return alert('Elegí o creá un cliente');
  if (!name) return alert('Poné un nombre para el lote');

  const body = {
    client_id, name, area_ha: areaHa, geojson,
    crop: $('#fieldCrop').value.trim(),
    campaign: $('#fieldCampaign').value.trim(),
    partido: partidoName
  };
  const r = await fetch('/api/fields', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (r.ok) {
    $('#drawForm').classList.add('hidden');
    drawnLayer.clearLayers();
    await loadFields();
    renderFieldsList();
    switchTab('list');
  } else {
    const err = await r.json().catch(() => ({}));
    alert(err.error || 'Error al guardar');
  }
}

// ---------------- CLIENTS ----------------
async function loadClients() {
  const r = await fetch('/api/clients');
  clients = await r.json();
}

function fillClientSelect() {
  const sel = $('#fieldClient');
  sel.innerHTML = '<option value="">-- elegir cliente --</option>' +
    clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

$('#newClientBtn').addEventListener('click', () => {
  openModal('Nuevo cliente', `
    <label>Nombre</label><input id="modalClientName" placeholder="Nombre del cliente/productor">
    <label>Notas (opcional)</label><input id="modalClientNotes" placeholder="Zona, contacto, etc.">
  `, async () => {
    const name = $('#modalClientName').value.trim();
    if (!name) return false;
    const r = await fetch('/api/clients', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, notes: $('#modalClientNotes').value.trim() })
    });
    if (r.ok) {
      await loadClients();
      fillClientSelect();
      $('#fieldClient').value = clients[clients.length - 1]?.id || '';
      renderClientsList();
      return true;
    }
    return false;
  });
});

$('#addClientBtn').addEventListener('click', () => $('#newClientBtn').click());

function renderClientsList() {
  const el = $('#clientsList');
  if (!clients.length) { el.innerHTML = '<p class="hint">Todavía no hay clientes cargados.</p>'; return; }
  el.innerHTML = clients.map(c => {
    const fieldCount = fields.filter(f => f.client_id === c.id).length;
    const totalHa = fields.filter(f => f.client_id === c.id).reduce((s, f) => s + f.area_ha, 0);
    return `<div class="item-card">
      <div class="item-title">${escapeHtml(c.name)}<span class="chip">${fieldCount} lote${fieldCount === 1 ? '' : 's'}</span></div>
      <div class="item-meta">${totalHa ? totalHa.toFixed(1) + ' ha totales' : 'Sin lotes'} ${c.notes ? '· ' + escapeHtml(c.notes) : ''}</div>
      <div class="item-actions">
        <button class="btn-ghost" onclick="editClient(${c.id})">Editar</button>
        <button class="btn-ghost" onclick="deleteClient(${c.id})">Eliminar</button>
      </div>
    </div>`;
  }).join('');
}

window.editClient = function (id) {
  const c = clients.find(x => x.id === id);
  openModal('Editar cliente', `
    <label>Nombre</label><input id="modalClientName" value="${escapeAttr(c.name)}">
    <label>Notas</label><input id="modalClientNotes" value="${escapeAttr(c.notes || '')}">
  `, async () => {
    const name = $('#modalClientName').value.trim();
    if (!name) return false;
    await fetch(`/api/clients/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, notes: $('#modalClientNotes').value.trim() })
    });
    await loadClients();
    renderClientsList();
    return true;
  });
};

window.deleteClient = async function (id) {
  if (!confirm('Esto borra el cliente y todos sus lotes guardados. ¿Continuar?')) return;
  await fetch(`/api/clients/${id}`, { method: 'DELETE' });
  await loadClients();
  await loadFields();
  renderClientsList();
  renderFieldsList();
  redrawSavedFields();
};

// ---------------- FIELDS ----------------
async function loadFields() {
  const r = await fetch('/api/fields');
  fields = await r.json();
  redrawSavedFields();
}

let savedFieldsLayer = null;
function redrawSavedFields() {
  if (savedFieldsLayer) map.removeLayer(savedFieldsLayer);
  savedFieldsLayer = L.geoJSON(fields.map(f => f.geojson), {
    style: { color: '#52C22F', weight: 2, fillOpacity: 0.2, fillColor: '#52C22F' }
  });
  fields.forEach((f, i) => {
    const layer = savedFieldsLayer.getLayers()[i];
    if (!layer) return;
    const client = clients.find(c => c.id === f.client_id);
    layer.bindPopup(`<b>${escapeHtml(f.name)}</b><br>${client ? escapeHtml(client.name) : ''}<br>${f.area_ha} ha ${f.crop ? '· ' + escapeHtml(f.crop) : ''}${f.partido ? '<br><small>' + escapeHtml(f.partido) + '</small>' : ''}`);
  });
  savedFieldsLayer.addTo(map);
}

function renderFieldsList() {
  const el = $('#fieldsList');
  const q = ($('#fieldSearch').value || '').toLowerCase();
  const filtered = fields.filter(f => {
    const client = clients.find(c => c.id === f.client_id);
    return f.name.toLowerCase().includes(q) || (client && client.name.toLowerCase().includes(q));
  });
  if (!filtered.length) { el.innerHTML = '<p class="hint">No hay lotes guardados todavía.</p>'; return; }
  el.innerHTML = filtered.map(f => {
    const client = clients.find(c => c.id === f.client_id);
    return `<div class="item-card">
      <div class="item-title">${escapeHtml(f.name)}<span class="chip">${f.area_ha} ha</span></div>
      <div class="item-meta">${client ? escapeHtml(client.name) : '—'} ${f.crop ? '· ' + escapeHtml(f.crop) : ''} ${f.campaign ? '· ' + escapeHtml(f.campaign) : ''}</div>
      <div class="item-meta">${f.partido ? escapeHtml(f.partido) : ''}</div>
      <div class="item-actions">
        <button class="btn-ghost" onclick="zoomToField(${f.id})">Ver en mapa</button>
        <button class="btn-ghost" onclick="deleteField(${f.id})">Eliminar</button>
      </div>
    </div>`;
  }).join('');
}

window.zoomToField = function (id) {
  const f = fields.find(x => x.id === id);
  if (!f) return;
  switchTab('draw');
  $('#drawForm').classList.add('hidden');
  const layer = L.geoJSON(f.geojson);
  map.fitBounds(layer.getBounds(), { maxZoom: 15, padding: [40, 40] });
  savedFieldsLayer.eachLayer(l => {
    if (l.getBounds && layer.getBounds().equals(l.getBounds())) l.openPopup();
  });
};

window.deleteField = async function (id) {
  if (!confirm('¿Eliminar este lote?')) return;
  await fetch(`/api/fields/${id}`, { method: 'DELETE' });
  await loadFields();
  renderFieldsList();
  renderClientsList();
};

$('#fieldSearch').addEventListener('input', renderFieldsList);

// ---------------- TABS ----------------
function switchTab(name) {
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach(p => p.classList.add('hidden'));
  $(`#tab-${name}`).classList.remove('hidden');
}
$$('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// ---------------- BACKUP / RESTORE ----------------
$('#backupBtn').addEventListener('click', () => {
  const isAdmin = currentUser.role === 'admin';
  openModal('Backup de clientes y lotes', `
    <p class="hint">Bajá este archivo antes de actualizar la app en Render (el plan gratis borra
    los datos guardados en cada redeploy). Después lo volvés a subir acá y se agrega todo lo que
    falte, sin duplicar ni pisar nada.</p>
    <button id="downloadBackupBtn" class="btn-primary full" type="button" style="margin-top:6px;">⬇️ Descargar backup</button>
    ${isAdmin ? `
      <label style="margin-top:16px;">Restaurar backup (archivo .json)</label>
      <input type="file" id="restoreFile" accept="application/json">
      <div id="restoreResult" class="hint" style="margin-top:8px;"></div>
    ` : `<p class="hint" style="margin-top:14px;">Solo un administrador puede restaurar un backup.</p>`}
  `, async () => true, 'Cerrar');

  $('#downloadBackupBtn').addEventListener('click', () => {
    window.location.href = '/api/backup';
  });

  if (isAdmin) {
    $('#restoreFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const resultEl = $('#restoreResult');
      resultEl.textContent = 'Restaurando...';
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const r = await fetch('/api/backup/restore', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Error al restaurar');
        resultEl.textContent = `Listo: ${data.clientsAdded} cliente(s) y ${data.fieldsAdded} lote(s) agregados (${data.clientsSkipped + data.fieldsSkipped} ya existían y se omitieron).`;
        await loadClients();
        await loadFields();
        renderFieldsList();
        renderClientsList();
      } catch (err) {
        resultEl.textContent = 'Error: ' + err.message;
      }
    });
  }
});

// ---------------- ADMIN (usuarios) ----------------
$('#adminBtn').addEventListener('click', async () => {
  const r = await fetch('/api/users');
  const users = await r.json();
  openModal('Usuarios del equipo', `
    <div id="usersListModal" style="max-height:220px; overflow-y:auto; margin-bottom:10px;">
      ${users.map(u => `<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid #eee; font-size:13px;">
        <span>${escapeHtml(u.username)} ${u.role === 'admin' ? '👑' : ''}</span>
        <span>
          <button class="btn-ghost" style="font-size:11px; padding:3px 7px;" onclick="resetUserPass(${u.id})">Reset pass</button>
          ${u.username !== currentUser.username ? `<button class="btn-ghost" style="font-size:11px; padding:3px 7px;" onclick="deleteUser(${u.id})">Borrar</button>` : ''}
        </span>
      </div>`).join('')}
    </div>
    <label>Nuevo usuario</label><input id="newUserName" placeholder="usuario">
    <label>Contraseña</label><input id="newUserPass" type="text" placeholder="contraseña">
    <label>Rol</label>
    <select id="newUserRole" style="width:100%; padding:9px 10px; border:1px solid #d7e2e6; border-radius:7px; margin-top:6px;">
      <option value="vendedor">Vendedor</option>
      <option value="admin">Administrador</option>
    </select>
  `, async () => {
    const username = $('#newUserName').value.trim();
    const password = $('#newUserPass').value;
    if (!username || !password) return true; // just close if empty, list already shown
    await fetch('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role: $('#newUserRole').value })
    });
    return true;
  }, 'Crear / Cerrar');
});

window.deleteUser = async function (id) {
  if (!confirm('¿Eliminar este usuario?')) return;
  await fetch(`/api/users/${id}`, { method: 'DELETE' });
  $('#adminBtn').click();
};
window.resetUserPass = async function (id) {
  const pass = prompt('Nueva contraseña para este usuario:');
  if (!pass) return;
  await fetch(`/api/users/${id}/password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pass })
  });
  alert('Contraseña actualizada');
};

// ---------------- MODAL HELPER ----------------
function openModal(title, bodyHtml, onOk, okLabel) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalOk').textContent = okLabel || 'Guardar';
  $('#modalOverlay').classList.remove('hidden');
  $('#modalOk').onclick = async () => {
    const ok = await onOk();
    if (ok !== false) $('#modalOverlay').classList.add('hidden');
  };
  $('#modalCancel').onclick = () => $('#modalOverlay').classList.add('hidden');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

checkSession();
