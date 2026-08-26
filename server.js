const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'campos.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'vendedor',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  notes TEXT,
  origin_key TEXT UNIQUE,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  crop TEXT,
  campaign TEXT,
  area_ha REAL NOT NULL,
  geojson TEXT NOT NULL,
  partido TEXT,
  origin_key TEXT UNIQUE,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(client_id) REFERENCES clients(id)
);
`);

// Migración liviana para bases ya existentes (creadas antes de agregar origin_key)
function ensureColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}
ensureColumn('clients', 'origin_key', 'TEXT');
ensureColumn('fields', 'origin_key', 'TEXT');
// backfill origin_key para filas viejas que no lo tengan
db.prepare("UPDATE clients SET origin_key = 'c-' || lower(hex(randomblob(8))) WHERE origin_key IS NULL").run();
db.prepare("UPDATE fields SET origin_key = 'f-' || lower(hex(randomblob(8))) WHERE origin_key IS NULL").run();

// Seed default admin if no users exist
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  const hash = bcrypt.hashSync('iturriaga2026', 10);
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)')
    .run('admin', hash, 'admin');
  console.log('Usuario admin creado -> usuario: admin  contraseña: iturriaga2026 (cambiarla despues de ingresar)');
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieSession({
  name: 'campos_session',
  secret: process.env.SESSION_SECRET || 'iturriaga-campos-secret-cambiar-en-render',
  maxAge: 30 * 24 * 60 * 60 * 1000 // 30 dias
}));

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  next();
}

function requireAdmin(req, res, next) {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo administradores' });
  }
  next();
}

// ---------- AUTH ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username || '');
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  req.session.userId = user.id;
  res.json({ id: user.id, username: user.username, role: user.role });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.json(null);
  const user = db.prepare('SELECT id, username, role FROM users WHERE id=?').get(req.session.userId);
  res.json(user || null);
});

// ---------- USERS (admin only) ----------
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all());
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Faltan datos' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)')
      .run(username, hash, role === 'admin' ? 'admin' : 'vendedor');
    res.json({ id: info.lastInsertRowid, username, role: role || 'vendedor' });
  } catch (e) {
    res.status(400).json({ error: 'Ese usuario ya existe' });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.session.userId) {
    return res.status(400).json({ error: 'No podes borrar tu propio usuario' });
  }
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/users/:id/password', requireAuth, requireAdmin, (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Falta contraseña' });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, req.params.id);
  res.json({ ok: true });
});

// ---------- CLIENTS ----------
app.get('/api/clients', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM clients ORDER BY name').all());
});

app.post('/api/clients', requireAuth, (req, res) => {
  const { name, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Falta nombre de cliente' });
  const origin_key = 'c-' + crypto.randomUUID();
  const info = db.prepare('INSERT INTO clients (name, notes, origin_key, created_by) VALUES (?,?,?,?)')
    .run(name.trim(), notes || '', origin_key, req.session.userId);
  res.json(db.prepare('SELECT * FROM clients WHERE id=?').get(info.lastInsertRowid));
});

app.put('/api/clients/:id', requireAuth, (req, res) => {
  const { name, notes } = req.body || {};
  db.prepare('UPDATE clients SET name=?, notes=? WHERE id=?')
    .run(name, notes || '', req.params.id);
  res.json(db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.id));
});

app.delete('/api/clients/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM fields WHERE client_id=?').run(req.params.id);
  db.prepare('DELETE FROM clients WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- FIELDS (polygons) ----------
app.get('/api/fields', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM fields ORDER BY created_at DESC').all();
  res.json(rows.map(r => ({ ...r, geojson: JSON.parse(r.geojson) })));
});

app.post('/api/fields', requireAuth, (req, res) => {
  const { client_id, name, crop, campaign, area_ha, geojson, partido } = req.body || {};
  if (!client_id || !name || !area_ha || !geojson) {
    return res.status(400).json({ error: 'Faltan datos del lote' });
  }
  const origin_key = 'f-' + crypto.randomUUID();
  const info = db.prepare(`INSERT INTO fields (client_id, name, crop, campaign, area_ha, geojson, partido, origin_key, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(client_id, name, crop || '', campaign || '', area_ha, JSON.stringify(geojson), partido || '', origin_key, req.session.userId);
  const row = db.prepare('SELECT * FROM fields WHERE id=?').get(info.lastInsertRowid);
  res.json({ ...row, geojson: JSON.parse(row.geojson) });
});

app.put('/api/fields/:id', requireAuth, (req, res) => {
  const { name, crop, campaign } = req.body || {};
  db.prepare('UPDATE fields SET name=?, crop=?, campaign=? WHERE id=?')
    .run(name, crop || '', campaign || '', req.params.id);
  const row = db.prepare('SELECT * FROM fields WHERE id=?').get(req.params.id);
  res.json({ ...row, geojson: JSON.parse(row.geojson) });
});

app.delete('/api/fields/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM fields WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- BACKUP / RESTORE ----------
// Exporta todo lo guardado (clientes + lotes) para poder bajarlo y guardarlo a mano.
app.get('/api/backup', requireAuth, (req, res) => {
  const clientsRows = db.prepare('SELECT id, name, notes, origin_key FROM clients').all();
  const fieldsRows = db.prepare('SELECT * FROM fields').all();
  const clientById = new Map(clientsRows.map(c => [c.id, c]));

  const backup = {
    app: 'campos-iturriaga',
    version: 1,
    exported_at: new Date().toISOString(),
    clients: clientsRows.map(c => ({
      origin_key: c.origin_key,
      name: c.name,
      notes: c.notes || ''
    })),
    fields: fieldsRows.map(f => ({
      origin_key: f.origin_key,
      client_origin_key: clientById.get(f.client_id) ? clientById.get(f.client_id).origin_key : null,
      name: f.name,
      crop: f.crop || '',
      campaign: f.campaign || '',
      area_ha: f.area_ha,
      partido: f.partido || '',
      geojson: JSON.parse(f.geojson)
    })).filter(f => f.client_origin_key) // descarta huerfanos, no deberian existir
  };
  res.setHeader('Content-Disposition', `attachment; filename="backup-campos-${new Date().toISOString().slice(0,10)}.json"`);
  res.json(backup);
});

// Restaura un backup: hace MERGE, nunca pisa ni duplica lo que ya esta en esta base.
// Un registro se identifica por su origin_key: si ya existe, se ignora; si no existe, se agrega.
app.post('/api/backup/restore', requireAuth, requireAdmin, (req, res) => {
  const backup = req.body || {};
  if (!Array.isArray(backup.clients) || !Array.isArray(backup.fields)) {
    return res.status(400).json({ error: 'Archivo de backup inválido' });
  }

  const insertClient = db.prepare('INSERT INTO clients (name, notes, origin_key, created_by) VALUES (?,?,?,?)');
  const insertField = db.prepare(`INSERT INTO fields (client_id, name, crop, campaign, area_ha, geojson, partido, origin_key, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const findClientByOrigin = db.prepare('SELECT id FROM clients WHERE origin_key=?');
  const findFieldByOrigin = db.prepare('SELECT id FROM fields WHERE origin_key=?');

  let clientsAdded = 0, clientsSkipped = 0, fieldsAdded = 0, fieldsSkipped = 0;

  const run = db.transaction(() => {
    // 1) clientes: mapa origin_key -> id local (existente o recien creado)
    const originToLocalId = new Map();
    for (const c of backup.clients) {
      if (!c.origin_key || !c.name) continue;
      const existing = findClientByOrigin.get(c.origin_key);
      if (existing) {
        originToLocalId.set(c.origin_key, existing.id);
        clientsSkipped++;
      } else {
        const info = insertClient.run(c.name, c.notes || '', c.origin_key, req.session.userId);
        originToLocalId.set(c.origin_key, info.lastInsertRowid);
        clientsAdded++;
      }
    }
    // 2) lotes
    for (const f of backup.fields) {
      if (!f.origin_key || !f.client_origin_key) continue;
      if (findFieldByOrigin.get(f.origin_key)) { fieldsSkipped++; continue; }
      const clientLocalId = originToLocalId.get(f.client_origin_key);
      if (!clientLocalId) { fieldsSkipped++; continue; } // cliente no vino en este backup
      insertField.run(clientLocalId, f.name, f.crop || '', f.campaign || '', f.area_ha,
        JSON.stringify(f.geojson), f.partido || '', f.origin_key, req.session.userId);
      fieldsAdded++;
    }
  });
  run();

  res.json({ ok: true, clientsAdded, clientsSkipped, fieldsAdded, fieldsSkipped });
});

// ---------- STATIC ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
