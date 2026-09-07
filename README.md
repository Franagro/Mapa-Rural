# Campos Iturriaga SA

App web para delimitar campos de clientes sobre imagen satelital, con overlay de los partidos
de Chascomús, Gral. Belgrano, Pila, Castelli, Gral. Paz, Punta Indio y Brandsen.

- Mapa satelital (Esri World Imagery) + capa de límites de partidos
- Herramienta de dibujo de polígonos, con cálculo automático de hectáreas
- Cada lote se guarda asociado a un cliente, con cultivo y campaña
- Login con usuario/contraseña, panel de administración de usuarios (rol admin)
- Base de datos SQLite persistente (no se pierde nada al reiniciar el servidor)
- Backup/restauración manual (botón "Backup" en la barra superior)

## Uso local

```bash
npm install
npm start
```

Abrir `http://localhost:3000`. Usuario inicial: `admin` / contraseña: `iturriaga2026`
(cambiala después de entrar, desde el botón "Usuarios" arriba a la derecha).

## Deploy en Render (gratis)

1. Subí esta carpeta a un repositorio de GitHub (podés arrastrar los archivos en
   github.com > New repository > "uploading an existing file").
2. En [render.com](https://render.com) → **New +** → **Web Service** → conectá el repositorio.
3. Configuración:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Importante — el plan free de Render **borra el disco en cada redeploy**. Antes de tocar el
   servicio (redeploy, cambio de configuración, etc.) entrá a la app y usá el botón **Backup →
   Descargar backup**. Si después de un cambio la base quedó vacía, volvé a entrar y usá
   **Backup → Restaurar backup** con ese mismo archivo: repone todo sin duplicar nada.
   Si preferís no depender de este paso manual, en la pestaña **Disks** del servicio podés
   agregar un disco persistente (requiere el plan Starter, ~$7/mes) montado en
   `/opt/render/project/src/data`.
5. Deploy. Te va a quedar una URL tipo `https://campos-iturriaga.onrender.com`.

## Estructura

- `server.js` — backend Express + SQLite (usuarios, clientes, lotes, backup)
- `public/index.html` / `app.js` / `style.css` — frontend (Leaflet)
- `public/logo.png` — logo de Iturriaga SA
- `public/partidos.geojson` — límites oficiales (IGN/CONAE) de los 7 partidos, ya filtrados y
  simplificados para carga rápida
