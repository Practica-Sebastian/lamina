/**
 * GET /api/movimientos
 * Historial de movimientos, del más reciente al más antiguo.
 *   ?item=CLAVE                    solo un ítem
 *   ?tipo=entrada|salida|ajuste
 *   ?q=texto                       busca en ítem, nota o usuario
 *   ?desde=AAAA-MM-DD  ?hasta=AAAA-MM-DD
 *   ?limite=100 (máx. 500)  ?pagina=0
 *
 * POST /api/movimientos   (nuevo · lo usa la app Registros "controllamina")
 * Registra un movimiento en la D1 compartida. Cuerpo JSON:
 *   { id, tipo:'entrada'|'salida'|'ajuste', fecha:'AAAA-MM-DD', calibre, cantidad, unidad:'kg',
 *     metros, kg_por_metro, proyecto?, subtipo?, bobina_id?, usuario?, origen?, registrado? }
 * Idempotente: el "id" se guarda como referencia "controllamina:<id>"; si llega otra vez
 * responde 409 y no duplica (la app reintenta cuando no hay conexión).
 *
 * OPTIONS /api/movimientos  → CORS para que Registros (otro dominio) pueda llamar.
 * Variables opcionales del proyecto de Pages (Settings → Variables):
 *   ORIGENES_PERMITIDOS = https://controllamina.pages.dev,https://otro.dominio  (vacío = cualquiera)
 *   BODEGA_LAMINA       = nombre de la bodega donde vive la lámina (vacío = bodega id 1, "Bodega Central")
 */
import { CONFIG, json, ident, clasificarTipo } from '../../lib/config.js';

export async function onRequestGet({ request, env }) {
  const p = new URL(request.url).searchParams;
  const f = {
    item: (p.get('item') || '').trim(),
    tipo: (p.get('tipo') || '').trim().toLowerCase(),
    q: (p.get('q') || '').trim(),
    desde: (p.get('desde') || '').trim(),
    hasta: (p.get('hasta') || '').trim(),
    limite: Math.min(Math.max(parseInt(p.get('limite'), 10) || 100, 1), 500),
    pagina: Math.max(parseInt(p.get('pagina'), 10) || 0, 0),
  };
  const filas = CONFIG.MODO === 'marc_erp' ? await movimientosMarc(env, f) : await movimientosGenerico(env, f);
  return json({ ok: true, modo: CONFIG.MODO, pagina: f.pagina, hayMas: filas.length > f.limite, movimientos: filas.slice(0, f.limite) });
}

async function movimientosGenerico(env, f) {
  const g = CONFIG.generico, c = g.col;
  const where = ['1=1'], binds = [];
  if (f.item) { where.push(`${ident(c.item)} = ?`); binds.push(f.item); }
  if (f.desde && c.fecha) { where.push(`${ident(c.fecha)} >= ?`); binds.push(f.desde); }
  if (f.hasta && c.fecha) { where.push(`${ident(c.fecha)} <= ?`); binds.push(f.hasta + '\uffff'); }
  if (f.q) {
    const campos = [c.item, c.nota, c.usuario].filter(Boolean).map(x => `COALESCE(${ident(x)}, '') LIKE ?`);
    where.push('(' + campos.join(' OR ') + ')');
    campos.forEach(() => binds.push('%' + f.q + '%'));
  }
  if (f.tipo && g.tipos[f.tipo]) {
    const ors = g.tipos[f.tipo].map(() => `LOWER(${ident(c.tipo)}) LIKE ?`);
    where.push('(' + ors.join(' OR ') + ')');
    g.tipos[f.tipo].forEach(t => binds.push(t + '%'));
  }
  const orden = `${c.fecha ? ident(c.fecha) + ' DESC, ' : ''}${c.id ? ident(c.id) : 'rowid'} DESC`;
  const { results } = await env.DB.prepare(
    `SELECT * FROM ${ident(g.tablaMovimientos)} WHERE ${where.join(' AND ')} ORDER BY ${orden} LIMIT ? OFFSET ?`
  ).bind(...binds, f.limite + 1, f.pagina * f.limite).all();

  return (results || []).map(r => {
    const clase = clasificarTipo(r[c.tipo], g.tipos);
    const cant = Number(r[c.cantidad]) || 0;
    return {
      id: c.id ? r[c.id] : null,
      fecha: c.fecha ? r[c.fecha] || '' : '',
      tipo: clase,
      tipoOriginal: String(r[c.tipo] ?? ''),
      clave: String(r[c.item] ?? ''),
      nombre: String(r[c.item] ?? ''),
      // Con signo: + entra, − sale (el ajuste se muestra como se guardó)
      cantidad: clase === 'salida' ? -Math.abs(cant) : clase === 'entrada' ? Math.abs(cant) : cant,
      unidad: c.unidad ? r[c.unidad] || '' : '',
      usuario: c.usuario ? r[c.usuario] || '' : '',
      nota: c.nota ? r[c.nota] || '' : '',
      bodega: '',
    };
  });
}

async function movimientosMarc(env, f) {
  const where = ['1=1'], binds = [];
  if (f.item) { where.push('(a.codigo = ? OR CAST(a.id AS TEXT) = ?)'); binds.push(f.item, f.item); }
  if (f.tipo) { where.push('LOWER(m.tipo) = ?'); binds.push(f.tipo); }
  if (f.desde) { where.push('m.fecha >= ?'); binds.push(f.desde); }
  if (f.hasta) { where.push('m.fecha <= ?'); binds.push(f.hasta + '\uffff'); }
  if (f.q) {
    where.push('(a.nombre LIKE ? OR a.codigo LIKE ? OR m.motivo LIKE ? OR m.por LIKE ?)');
    binds.push(...Array(4).fill('%' + f.q + '%'));
  }
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.tipo, m.cantidad, m.fecha, m.motivo, m.referencia, m.por,
            a.codigo, a.id AS articulo_id, a.nombre, a.unidad, b.nombre AS bodega, bd.nombre AS bodega_destino
     FROM inv_movimientos m
     JOIN inv_articulos a ON a.id = m.articulo_id
     JOIN inv_bodegas b ON b.id = m.bodega_id
     LEFT JOIN inv_bodegas bd ON bd.id = m.bodega_destino_id
     WHERE ${where.join(' AND ')} ORDER BY m.fecha DESC, m.id DESC LIMIT ? OFFSET ?`
  ).bind(...binds, f.limite + 1, f.pagina * f.limite).all();

  return (results || []).map(r => {
    const tipo = String(r.tipo || '').toLowerCase();
    const cant = Number(r.cantidad) || 0;
    return {
      id: r.id,
      fecha: r.fecha || '',
      tipo: ['entrada', 'salida', 'ajuste'].includes(tipo) ? tipo : 'otro',
      tipoOriginal: r.tipo,
      clave: r.codigo || String(r.articulo_id),
      nombre: r.nombre,
      cantidad: tipo === 'salida' ? -Math.abs(cant) : cant,
      unidad: r.unidad || '',
      usuario: r.por || '',
      nota: [r.motivo, r.referencia].filter(Boolean).join(' · '),
      bodega: r.bodega + (r.bodega_destino ? ' → ' + r.bodega_destino : ''),
    };
  });
}


/* ───────────────────────── POST · registrar movimiento ───────────────────────── */

const ORIGEN_APP = 'controllamina';
const LAMINA = {
  codigo: c => `LAM-C${c}`,            // código del artículo en inv_articulos
  nombre: c => `Lámina calibre ${c}`,  // nombre si hay que crearlo
};
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

function cors(request, env) {
  const permitidos = String(env.ORIGENES_PERMITIDOS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origen = request.headers.get('Origin') || '';
  const permitir = !permitidos.length ? '*' : (permitidos.includes(origen) ? origen : permitidos[0]);
  return {
    'Access-Control-Allow-Origin': permitir,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const responder = (request, env, obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(request, env) } });

export async function onRequestOptions({ request, env }) {
  return new Response(null, { status: 204, headers: cors(request, env) });
}

export async function onRequestPost({ request, env }) {
  let b;
  try { b = await request.json(); } catch { return responder(request, env, { ok: false, error: 'JSON inválido' }, 400); }

  // ── Validación
  const id = String(b.id || '').trim();
  const tipo = String(b.tipo || '').trim().toLowerCase();
  const calibre = String(b.calibre ?? '').trim();
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha || '')) ? b.fecha : new Date().toISOString().slice(0, 10);
  if (!id || id.length > 80) return responder(request, env, { ok: false, error: 'id requerido (máx. 80 caracteres)' }, 400);
  if (!['entrada', 'salida', 'ajuste'].includes(tipo)) return responder(request, env, { ok: false, error: 'tipo debe ser entrada, salida o ajuste' }, 400);
  if (!calibre) return responder(request, env, { ok: false, error: 'calibre requerido' }, 400);
  if (!(Number(b.cantidad) > 0) && !(Number(b.metros) > 0)) return responder(request, env, { ok: false, error: 'cantidad o metros debe ser mayor que 0' }, 400);

  const referencia = `${ORIGEN_APP}:${id}`;
  const motivo = tipo === 'entrada'
    ? `Ingreso de bobina calibre ${calibre}` + (b.metros ? ` · ${r2(b.metros)} m` : '')
    : [b.proyecto ? `Proyecto ${b.proyecto}` : '', b.subtipo || '', b.metros ? `${r2(b.metros)} m` : ''].filter(Boolean).join(' · ');
  const usuario = [String(b.usuario || '').trim(), 'Control de lámina'].filter(Boolean).join(' · ');

  try {
    const r = CONFIG.MODO === 'marc_erp'
      ? await registrarMarc(env, { id, tipo, calibre, fecha, b, referencia, motivo, usuario })
      : await registrarGenerico(env, { id, tipo, calibre, fecha, b, referencia, motivo, usuario });
    return responder(request, env, r.cuerpo, r.status);
  } catch (e) {
    // 500 → la app lo deja en cola y reintenta
    return responder(request, env, { ok: false, error: 'Error al guardar: ' + (e && e.message || e) }, 500);
  }
}

/* Modo marc_erp: mismo esquema y reglas que el worker marc-erp
   (inv_articulos · inv_stock · inv_movimientos con stock_antes/stock_despues). */
async function registrarMarc(env, { tipo, calibre, fecha, b, referencia, motivo, usuario }) {
  const DB = env.DB;

  // 1) ¿Ya existe? (idempotencia)
  const dup = await DB.prepare(`SELECT id FROM inv_movimientos WHERE referencia = ? LIMIT 1`).bind(referencia).first();
  if (dup) return { status: 409, cuerpo: { ok: true, duplicado: true, movimiento_id: dup.id } };

  // 2) Bodega
  const nomBodega = String(env.BODEGA_LAMINA || '').trim();
  const bod = nomBodega
    ? await DB.prepare(`SELECT id, nombre FROM inv_bodegas WHERE LOWER(nombre) = LOWER(?) AND activo = 1`).bind(nomBodega).first()
    : await DB.prepare(`SELECT id, nombre FROM inv_bodegas WHERE activo = 1 ORDER BY id LIMIT 1`).first();
  if (!bod) return { status: 422, cuerpo: { ok: false, error: `No existe la bodega ${nomBodega || 'activa'} en Inventario` } };

  // 3) Artículo de lámina por calibre (se crea si no existe, en kg)
  const codigo = LAMINA.codigo(calibre);
  let art = await DB.prepare(`SELECT id, nombre, unidad, costo_promedio, activo FROM inv_articulos WHERE codigo = ?`).bind(codigo).first()
         || await DB.prepare(`SELECT id, nombre, unidad, costo_promedio, activo FROM inv_articulos WHERE LOWER(nombre) = LOWER(?) LIMIT 1`).bind(LAMINA.nombre(calibre)).first();
  let creado = false;
  if (!art) {
    await DB.prepare(`INSERT OR IGNORE INTO inv_articulos (codigo, nombre, categoria, unidad, minimo, empresa_legal, activo, notas, creado_en)
                      VALUES (?, ?, 'Lámina', 'kg', 0, 'Metal MARC', 1, 'Creado automáticamente desde Control de lámina', datetime('now'))`)
      .bind(codigo, LAMINA.nombre(calibre)).run();
    art = await DB.prepare(`SELECT id, nombre, unidad, costo_promedio, activo FROM inv_articulos WHERE codigo = ?`).bind(codigo).first();
    creado = true;
  }
  if (!art) return { status: 500, cuerpo: { ok: false, error: 'No se pudo crear el artículo de lámina' } };

  // 4) Cantidad en la unidad del artículo (metros si el artículo se lleva en metros; si no, kg)
  const enMetros = /^(m|ml|mts?|metros?|metros lineales)$/i.test(String(art.unidad || '').trim());
  const cant = r2(enMetros ? b.metros : (Number(b.cantidad) > 0 ? b.cantidad : Number(b.metros) * Number(b.kg_por_metro)));
  if (!(cant > 0)) return { status: 400, cuerpo: { ok: false, error: 'Cantidad inválida para la unidad ' + art.unidad } };

  // 5) Stock antes/después (la lámina ya se usó en el taller: se registra aunque quede negativo)
  const st = await DB.prepare(`SELECT cantidad FROM inv_stock WHERE articulo_id = ? AND bodega_id = ?`).bind(art.id, bod.id).first();
  const antes = r2(st ? st.cantidad : 0);
  const despues = r2(tipo === 'salida' ? antes - cant : tipo === 'entrada' ? antes + cant : cant); // ajuste = conteo físico
  const costoU = tipo === 'salida' ? r2(art.costo_promedio) : 0;

  // 6) Stock + movimiento en una sola transacción
  await DB.batch([
    DB.prepare(`INSERT INTO inv_stock (articulo_id, bodega_id, cantidad) VALUES (?, ?, ?)
                ON CONFLICT(articulo_id, bodega_id) DO UPDATE SET cantidad = excluded.cantidad`).bind(art.id, bod.id, despues),
    DB.prepare(`INSERT INTO inv_movimientos
                (tipo, articulo_id, bodega_id, cantidad, stock_antes, stock_despues, costo_unitario, costo_total,
                 motivo, referencia, proveedor, por, fecha, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`)
      .bind(tipo, art.id, bod.id, cant, antes, despues, costoU, r2(cant * costoU),
            motivo, referencia, usuario, fecha, String(b.registrado || new Date().toISOString())),
  ]);
  const nuevo = await DB.prepare(`SELECT id FROM inv_movimientos WHERE referencia = ? ORDER BY id DESC LIMIT 1`).bind(referencia).first();

  return { status: 201, cuerpo: {
    ok: true, movimiento_id: nuevo && nuevo.id, articulo: art.nombre, articulo_creado: creado, bodega: bod.nombre,
    cantidad: cant, unidad: art.unidad, stock_antes: antes, stock_despues: despues,
    ...(despues < 0 ? { aviso: `El stock de ${art.nombre} en ${bod.nombre} quedó negativo (${despues}). Falta registrar una entrada.` } : {}),
  } };
}

/* Modo genérico: usa el mapeo de columnas de CONFIG.generico (el mismo del GET). */
async function registrarGenerico(env, { tipo, calibre, fecha, b, referencia, motivo, usuario }) {
  const g = CONFIG.generico, c = g.col, tabla = ident(g.tablaMovimientos);
  const marca = `[${referencia}]`;

  if (c.nota) {
    const dup = await env.DB.prepare(`SELECT 1 FROM ${tabla} WHERE ${ident(c.nota)} LIKE ? LIMIT 1`).bind('%' + marca + '%').first();
    if (dup) return { status: 409, cuerpo: { ok: true, duplicado: true } };
  }
  const cant = r2(Number(b.cantidad) > 0 ? b.cantidad : b.metros);
  const valores = {
    [c.item]: LAMINA.nombre(calibre),
    [c.tipo]: (g.tipos[tipo] && g.tipos[tipo][0]) || tipo, // el primer prefijo configurado para ese tipo
    [c.cantidad]: cant,
  };
  if (c.fecha) valores[c.fecha] = fecha;
  if (c.unidad) valores[c.unidad] = Number(b.cantidad) > 0 ? (b.unidad || 'kg') : 'm';
  if (c.usuario) valores[c.usuario] = usuario;
  if (c.nota) valores[c.nota] = `${motivo} ${marca}`.trim();

  const cols = Object.keys(valores).filter(Boolean);
  await env.DB.prepare(`INSERT INTO ${tabla} (${cols.map(ident).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(...cols.map(k => valores[k])).run();
  return { status: 201, cuerpo: { ok: true, item: LAMINA.nombre(calibre), cantidad: cant } };
}
