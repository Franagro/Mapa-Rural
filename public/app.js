let map, drawnLayer, drawControl, partidosLayer, parcelasCatastroLayer;
let currentUser = null;
let clients = [];
let fields = [];
let pendingLayer = null; // polygon being saved
let editingFieldId = null;
let selectedColor = '#52C22F';
let fieldsOpacity = 0.55;
let tableSort = { col: null, dir: 1 };

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
  await loadOverlays();
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

  // Catastro rural oficial (ARBA) - limite real de cada parcela. Se ve al acercar el zoom.
  const parcelasCatastro = L.tileLayer.wms('https://geo.arba.gov.ar/geoserver/idera/wms', {
    layers: 'Parcela',
    format: 'image/png',
    transparent: true,
    version: '1.1.1',
    attribution: 'Catastro: ARBA',
    opacity: 0.9
  }).addTo(map);
  parcelasCatastroLayer = parcelasCatastro;

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

  L.control.layers(
    { 'Satélite': satellite, 'Calles': osm },
    { 'Parcelas (catastro ARBA)': parcelasCatastro, 'Partidos': partidosLayer },
    { position: 'topright' }
  ).addTo(map);

  // Aviso: el catastro solo se ve al acercar el zoom (asi lo limita el servicio de ARBA)
  const catastroHint = L.control({ position: 'bottomleft' });
  catastroHint.onAdd = function () {
    const div = L.DomUtil.create('div', 'catastro-hint');
    div.innerHTML = '🔍 Acercá el zoom para ver los límites de catastro (ARBA)';
    return div;
  };
  catastroHint.addTo(map);
  function toggleCatastroHint() {
    const hintEl = document.querySelector('.catastro-hint');
    if (hintEl) hintEl.style.display = map.getZoom() < 13 ? 'block' : 'none';
  }
  map.on('zoomend', toggleCatastroHint);
  setTimeout(toggleCatastroHint, 300);

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
  $('#fieldStatus').value = '';
  $('#fieldStatus1').value = '';
  $('#fieldStatus2').value = '';
  $('#fieldStatus3').value = '';
  selectedColor = '#52C22F';
  $('#fieldColorCustom').value = selectedColor;
  updateColorSwatchSelection();
  fillClientSelect();
  $('#drawForm').classList.remove('hidden');
  switchTab('draw');

  $('#saveFieldBtn').onclick = () => saveField(geojson, parseFloat(areaHa), partidoName);
  $('#cancelFieldBtn').onclick = () => {
    drawnLayer.removeLayer(layer);
    $('#drawForm').classList.add('hidden');
  };
}

function updateColorSwatchSelection() {
  $$('#colorPicker .swatch').forEach(s => s.classList.toggle('selected', s.dataset.color.toLowerCase() === selectedColor.toLowerCase()));
}
$$('#colorPicker .swatch').forEach(s => {
  s.addEventListener('click', () => {
    selectedColor = s.dataset.color;
    $('#fieldColorCustom').value = selectedColor;
    updateColorSwatchSelection();
  });
});
$('#fieldColorCustom').addEventListener('input', (e) => {
  selectedColor = e.target.value;
  updateColorSwatchSelection();
});

async function saveField(geojson, areaHa, partidoName) {
  const client_id = $('#fieldClient').value;
  const name = $('#fieldName').value.trim();
  if (!client_id) return alert('Elegí o creá un cliente');
  if (!name) return alert('Poné un nombre para el lote');

  const body = {
    client_id, name, area_ha: areaHa, geojson,
    crop: $('#fieldCrop').value.trim(),
    campaign: $('#fieldCampaign').value.trim(),
    partido: partidoName,
    status: $('#fieldStatus').value.trim(),
    status1: $('#fieldStatus1').value.trim(),
    status2: $('#fieldStatus2').value.trim(),
    status3: $('#fieldStatus3').value.trim(),
    color: selectedColor
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
    style: (geojsonFeature) => {
      const idx = fields.findIndex(f => f.geojson === geojsonFeature);
      const color = (fields[idx] && fields[idx].color) || '#52C22F';
      return { color: color, weight: 2, fillOpacity: fieldsOpacity, fillColor: color };
    }
  });
  fields.forEach((f, i) => {
    const layer = savedFieldsLayer.getLayers()[i];
    if (!layer) return;
    const client = clients.find(c => c.id === f.client_id);
    const statusLine = [f.status, f.status1, f.status2, f.status3].filter(Boolean).join(' · ');
    layer.bindPopup(`<b>${escapeHtml(f.name)}</b><br>${client ? escapeHtml(client.name) : ''}<br>${f.area_ha} ha ${f.crop ? '· ' + escapeHtml(f.crop) : ''}${f.partido ? '<br><small>' + escapeHtml(f.partido) + '</small>' : ''}${statusLine ? '<br><small>' + escapeHtml(statusLine) + '</small>' : ''}`);
  });
  savedFieldsLayer.addTo(map);
}

$('#opacitySlider').addEventListener('input', (e) => {
  fieldsOpacity = Number(e.target.value) / 100;
  $('#opacityValue').textContent = `${e.target.value}%`;
  if (savedFieldsLayer) {
    savedFieldsLayer.eachLayer((l, i) => {
      const f = fields[i];
      if (f) l.setStyle({ fillOpacity: fieldsOpacity });
    });
  }
});

$('#catastroOpacitySlider').addEventListener('input', (e) => {
  $('#catastroOpacityValue').textContent = `${e.target.value}%`;
  if (parcelasCatastroLayer) parcelasCatastroLayer.setOpacity(Number(e.target.value) / 100);
});

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

// ---------------- TABLA COMPLETA ----------------
const PRESET_COLORS = ['#52C22F', '#00E5E5', '#E53935', '#FDD835', '#8E24AA', '#FB8C00', '#9E9E9E', '#FFFFFF'];

$('#openTableBtn').addEventListener('click', () => {
  $('#tableView').classList.remove('hidden');
  renderDataTable();
});
$('#closeTableBtn').addEventListener('click', () => {
  $('#tableView').classList.add('hidden');
});
$('#clearFiltersBtn').addEventListener('click', () => {
  $$('#tableFilters input').forEach(i => i.value = '');
  renderDataTable();
});
$$('#tableFilters input').forEach(i => i.addEventListener('input', renderDataTable));
$$('#dataTable thead th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    tableSort.dir = tableSort.col === col ? -tableSort.dir : 1;
    tableSort.col = col;
    renderDataTable();
  });
});

function fieldRowValue(f, col) {
  if (col === 'client') {
    const c = clients.find(x => x.id === f.client_id);
    return c ? c.name : '';
  }
  return f[col] != null ? f[col] : '';
}

function renderDataTable() {
  const filters = {};
  $$('#tableFilters input').forEach(i => {
    if (i.value.trim()) filters[i.dataset.filter] = i.value.trim().toLowerCase();
  });

  let rows = fields.filter(f => {
    return Object.entries(filters).every(([col, val]) => String(fieldRowValue(f, col)).toLowerCase().includes(val));
  });

  if (tableSort.col) {
    rows = rows.slice().sort((a, b) => {
      let va = fieldRowValue(a, tableSort.col), vb = fieldRowValue(b, tableSort.col);
      if (tableSort.col === 'area_ha') { va = Number(va) || 0; vb = Number(vb) || 0; return (va - vb) * tableSort.dir; }
      return String(va).localeCompare(String(vb), 'es') * tableSort.dir;
    });
  }

  const tbody = $('#dataTableBody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="hint" style="padding:16px;">No hay lotes que coincidan.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(f => {
    const client = clients.find(c => c.id === f.client_id);
    return `<tr data-id="${f.id}">
      <td contenteditable="true" data-field="name">${escapeHtml(f.name)}</td>
      <td>${client ? escapeHtml(client.name) : '—'}</td>
      <td>${f.area_ha}</td>
      <td contenteditable="true" data-field="crop">${escapeHtml(f.crop || '')}</td>
      <td contenteditable="true" data-field="campaign">${escapeHtml(f.campaign || '')}</td>
      <td contenteditable="true" data-field="status">${escapeHtml(f.status || '')}</td>
      <td contenteditable="true" data-field="status1">${escapeHtml(f.status1 || '')}</td>
      <td contenteditable="true" data-field="status2">${escapeHtml(f.status2 || '')}</td>
      <td contenteditable="true" data-field="status3">${escapeHtml(f.status3 || '')}</td>
      <td contenteditable="true" data-field="partido">${escapeHtml(f.partido || '')}</td>
      <td><span class="table-color-dot" style="background:${f.color || '#52C22F'}" data-id="${f.id}" data-current="${f.color || '#52C22F'}"></span></td>
      <td class="table-actions-cell">
        <button class="btn-ghost" onclick="zoomToField(${f.id}); $('#tableView').classList.add('hidden');">Ver</button>
        <button class="btn-ghost" onclick="deleteFieldFromTable(${f.id})">Eliminar</button>
      </td>
    </tr>`;
  }).join('');

  // edicion inline: guarda al perder foco
  tbody.querySelectorAll('td[contenteditable="true"]').forEach(td => {
    td.addEventListener('blur', async () => {
      const tr = td.closest('tr');
      const id = Number(tr.dataset.id);
      const field = td.dataset.field;
      const value = td.textContent.trim();
      const f = fields.find(x => x.id === id);
      if (!f || f[field] === value) return;
      await updateFieldInline(id, { [field]: value });
    });
    td.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); td.blur(); }
    });
  });

  // color dot: ciclo de colores preset al click, shift+click abre selector custom
  tbody.querySelectorAll('.table-color-dot').forEach(dot => {
    dot.addEventListener('click', async (e) => {
      const id = Number(dot.dataset.id);
      if (e.shiftKey) {
        const input = document.createElement('input');
        input.type = 'color';
        input.value = dot.dataset.current;
        input.style.position = 'fixed'; input.style.opacity = '0';
        document.body.appendChild(input);
        input.click();
        input.addEventListener('change', async () => {
          await updateFieldInline(id, { color: input.value });
          document.body.removeChild(input);
        });
        return;
      }
      const currentIdx = PRESET_COLORS.findIndex(c => c.toLowerCase() === dot.dataset.current.toLowerCase());
      const next = PRESET_COLORS[(currentIdx + 1) % PRESET_COLORS.length];
      await updateFieldInline(id, { color: next });
    });
  });
}

async function updateFieldInline(id, patch) {
  const r = await fetch(`/api/fields/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
  });
  if (r.ok) {
    const updated = await r.json();
    const idx = fields.findIndex(f => f.id === id);
    if (idx >= 0) fields[idx] = updated;
    renderDataTable();
    renderFieldsList();
    redrawSavedFields();
  }
}

window.deleteFieldFromTable = async function (id) {
  if (!confirm('¿Eliminar este lote?')) return;
  await fetch(`/api/fields/${id}`, { method: 'DELETE' });
  await loadFields();
  renderDataTable();
  renderFieldsList();
  renderClientsList();
};

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

// ---------------- MAPAS DE REFERENCIA (georreferenciacion manual) ----------------
let refOverlayLayer = null;
let refCornerMarkers = [];
let refEditingId = null; // null = mapa nuevo sin guardar
let refPendingDataUrl = null;
let savedOverlays = [];
const visibleOverlayLayers = {}; // id -> layer (solo lectura, mostrados en el mapa)

function resizeImageToDataUrl(file, maxDim) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => { img.src = e.target.result; };
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) { height = height * (maxDim / width); width = maxDim; }
      else if (height > maxDim) { width = width * (maxDim / height); height = maxDim; }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function lerpLatLng(a, b, t) {
  return L.latLng(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t);
}

function startRefEditing(dataUrl, corners, name, opacity, editingId) {
  clearRefEditing();
  refPendingDataUrl = dataUrl;
  refEditingId = editingId || null;

  refOverlayLayer = L.imageOverlay.rotated(dataUrl, corners.tl, corners.tr, corners.bl, {
    opacity: opacity, interactive: false
  }).addTo(map);

  const markerDefs = [
    { key: 'tl', color: '#e53935', label: 'Arriba-izq' },
    { key: 'tr', color: '#43a047', label: 'Arriba-der' },
    { key: 'bl', color: '#1e88e5', label: 'Abajo-izq' }
  ];
  refCornerMarkers = markerDefs.map(def => {
    const marker = L.circleMarker(corners[def.key], {
      radius: 9, color: '#fff', weight: 2, fillColor: def.color, fillOpacity: 1, draggable: false
    }).addTo(map);
    // circleMarker no soporta drag nativo: usamos un marker invisible con icono para poder arrastrar
    const dragMarker = L.marker(corners[def.key], {
      icon: L.divIcon({ className: 'ref-corner-handle', html: `<div style="background:${def.color}"></div>`, iconSize: [20, 20] }),
      draggable: true, title: def.label
    }).addTo(map);
    map.removeLayer(marker);
    dragMarker.on('drag', () => {
      const c = getCurrentCornerLatLngs();
      refOverlayLayer.reposition(c.tl, c.tr, c.bl);
    });
    return { key: def.key, marker: dragMarker };
  });

  $('#refName').value = name || '';
  $('#refOpacitySlider').value = Math.round(opacity * 100);
  $('#refActiveControls').classList.remove('hidden');
  switchTab('ref');
}

function getCurrentCornerLatLngs() {
  const result = {};
  refCornerMarkers.forEach(m => { result[m.key] = m.marker.getLatLng(); });
  return result;
}

function clearRefEditing() {
  if (refOverlayLayer) { map.removeLayer(refOverlayLayer); refOverlayLayer = null; }
  refCornerMarkers.forEach(m => map.removeLayer(m.marker));
  refCornerMarkers = [];
  refEditingId = null;
  refPendingDataUrl = null;
  $('#refActiveControls').classList.add('hidden');
}

$('#refImageInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('#refUploadStatus').textContent = 'Procesando imagen...';
  try {
    const dataUrl = await resizeImageToDataUrl(file, 1800);
    const bounds = map.getBounds();
    const nw = bounds.getNorthWest(), ne = bounds.getNorthEast(), sw = bounds.getSouthWest(), center = bounds.getCenter();
    const corners = {
      tl: lerpLatLng(nw, center, 0.12),
      tr: lerpLatLng(ne, center, 0.12),
      bl: lerpLatLng(sw, center, 0.12)
    };
    startRefEditing(dataUrl, corners, file.name.replace(/\.[^.]+$/, ''), 0.7, null);
    $('#refUploadStatus').textContent = 'Arrastrá los 3 puntos de colores sobre el mapa para alinearlo.';
  } catch (err) {
    $('#refUploadStatus').textContent = 'No se pudo procesar la imagen.';
  }
});

$('#refOpacitySlider').addEventListener('input', (e) => {
  if (refOverlayLayer) refOverlayLayer.setOpacity(Number(e.target.value) / 100);
});

$('#refDiscardBtn').addEventListener('click', () => {
  clearRefEditing();
  $('#refImageInput').value = '';
  $('#refUploadStatus').textContent = '';
});

$('#refSaveBtn').addEventListener('click', async () => {
  const name = $('#refName').value.trim();
  if (!name) return alert('Ponele un nombre a este mapa');
  const corners = getCurrentCornerLatLngs();
  const opacity = Number($('#refOpacitySlider').value) / 100;
  const payload = {
    name, opacity,
    corner_tl: [corners.tl.lat, corners.tl.lng],
    corner_tr: [corners.tr.lat, corners.tr.lng],
    corner_bl: [corners.bl.lat, corners.bl.lng]
  };
  if (!refEditingId) payload.image_data = refPendingDataUrl;

  const url = refEditingId ? `/api/overlays/${refEditingId}` : '/api/overlays';
  const method = refEditingId ? 'PUT' : 'POST';
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (r.ok) {
    clearRefEditing();
    $('#refImageInput').value = '';
    $('#refUploadStatus').textContent = 'Guardado.';
    await loadOverlays();
  } else {
    const err = await r.json().catch(() => ({}));
    alert(err.error || 'Error al guardar');
  }
});

async function loadOverlays() {
  const r = await fetch('/api/overlays');
  if (!r.ok) return;
  savedOverlays = await r.json();
  renderOverlaysList();
}

function renderOverlaysList() {
  const el = $('#refList');
  if (!savedOverlays.length) { el.innerHTML = '<p class="hint">Todavía no subiste ningún mapa.</p>'; return; }
  const isAdmin = currentUser && currentUser.role === 'admin';
  el.innerHTML = savedOverlays.map(o => `
    <div class="item-card">
      <div class="item-title">
        <label style="display:flex; align-items:center; gap:6px; font-weight:600;">
          <input type="checkbox" class="ref-toggle" data-id="${o.id}"> ${escapeHtml(o.name)}
        </label>
      </div>
      ${isAdmin ? `<div class="item-actions">
        <button class="btn-ghost" onclick="editOverlay(${o.id})">Editar posición</button>
        <button class="btn-ghost" onclick="deleteOverlay(${o.id})">Eliminar</button>
      </div>` : ''}
    </div>`).join('');

  el.querySelectorAll('.ref-toggle').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.id);
      const o = savedOverlays.find(x => x.id === id);
      if (cb.checked) {
        const layer = L.imageOverlay.rotated(o.image_data,
          L.latLng(o.corner_tl[0], o.corner_tl[1]),
          L.latLng(o.corner_tr[0], o.corner_tr[1]),
          L.latLng(o.corner_bl[0], o.corner_bl[1]),
          { opacity: o.opacity, interactive: false }
        ).addTo(map);
        visibleOverlayLayers[id] = layer;
      } else if (visibleOverlayLayers[id]) {
        map.removeLayer(visibleOverlayLayers[id]);
        delete visibleOverlayLayers[id];
      }
    });
  });
}

window.editOverlay = function (id) {
  const o = savedOverlays.find(x => x.id === id);
  if (!o) return;
  if (visibleOverlayLayers[id]) { map.removeLayer(visibleOverlayLayers[id]); delete visibleOverlayLayers[id]; }
  startRefEditing(o.image_data, {
    tl: L.latLng(o.corner_tl[0], o.corner_tl[1]),
    tr: L.latLng(o.corner_tr[0], o.corner_tr[1]),
    bl: L.latLng(o.corner_bl[0], o.corner_bl[1])
  }, o.name, o.opacity, id);
};

window.deleteOverlay = async function (id) {
  if (!confirm('¿Eliminar este mapa de referencia?')) return;
  if (visibleOverlayLayers[id]) { map.removeLayer(visibleOverlayLayers[id]); delete visibleOverlayLayers[id]; }
  await fetch(`/api/overlays/${id}`, { method: 'DELETE' });
  await loadOverlays();
};
