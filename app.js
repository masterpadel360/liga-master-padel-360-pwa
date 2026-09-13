/**
 * MASTER PÁDEL 360 — app.js
 * =======================================================================
 * Cliente HTTP contra la Web App de Apps Script (fetch con respaldo
 * JSONP). Esta parte NO cambió respecto de la versión anterior que ya
 * comprobaste funcionando: mismo API_URL, mismo apiFetch, mismos nombres
 * de acción, mismo caché de 45s del lado del servidor.
 *
 * IMPORTANTE: reemplazá la constante API_URL de acá abajo por la URL de
 * TU deployment de Apps Script (la misma que ya tenías configurada).
 */
var API_URL = 'https://script.google.com/macros/s/AKfycbxebUf2uSFTtcyrySuK_budugkr4Ai5gV8R5gBgYabgO0relQ0jaC7ljvLX6wz_rU0t/exec';

// Antes, este fetch() no tenía ningún límite de tiempo propio: si
// colgaba (una red móvil rara, un DNS lento, etc.) el navegador podía
// tardar decenas de segundos en darse por vencido solo, y recién ahí
// caía al respaldo JSONP -- toda la app se sentía "trabada" mientras
// tanto. Ahora, si no responde en API_TIMEOUT_MS_, se corta solo y pasa
// al respaldo mucho antes. No cambia nada cuando la red funciona bien:
// simplemente deja de haber un cuelgue sin techo cuando no.
//
// 15s y no menos: medido en vivo contra el backend real, una llamada
// normal (sin caché del lado del servidor todavía) puede tardar
// tranquilamente 6-8s. Un timeout más corto (7s, el valor anterior)
// llegaba a cortar pedidos que iban a responder bien solos, y el
// "respaldo" JSONP no es gratis -- rehace la misma llamada lenta desde
// cero. Cortar antes de tiempo termina saliendo más lento, no más rápido.
var API_TIMEOUT_MS_ = 15000;

// ============================================================
// Cliente de API: intenta fetch() normal; si falla, cae a JSONP.
// ============================================================
function apiFetch(accion, params) {
  params = params || {};
  var qs = Object.keys(params).reduce(function (arr, k) {
    if (params[k] !== undefined && params[k] !== null) {
      arr.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
    return arr;
  }, ['accion=' + encodeURIComponent(accion)]).join('&');
  var url = API_URL + '?' + qs;

  return apiFetchJson_(url).catch(function () { return apiFetchJsonp_(url); });
}

function apiFetchJson_(url) {
  return fetchConTimeout_(url, { method: 'GET' }, API_TIMEOUT_MS_)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (payload) {
      if (!payload || !payload.ok) throw new Error((payload && payload.error) || 'Error desconocido');
      return payload.data;
    });
}

var jsonpContador_ = 0;
function apiFetchJsonp_(url) {
  return new Promise(function (resolve, reject) {
    var cb = 'mp360cb_' + (jsonpContador_++);
    var script = document.createElement('script');
    var resuelto = false;

    function limpiar() {
      delete window[cb];
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[cb] = function (payload) {
      resuelto = true;
      limpiar();
      if (payload && payload.ok) resolve(payload.data);
      else reject(new Error((payload && payload.error) || 'Error desconocido'));
    };
    script.src = url + '&callback=' + cb;
    script.onerror = function () { limpiar(); reject(new Error('No se pudo conectar con el servidor.')); };
    document.body.appendChild(script);

    setTimeout(function () {
      if (!resuelto) { limpiar(); reject(new Error('Tiempo de espera agotado.')); }
    }, 12000);
  });
}

// ============================================================
// Estado global de la SPA
// ============================================================
var CATEGORIAS = [];
var categoriaActual = null;
var pantallaActual = 'inicio';
var cache_ = {};
var fechaPorCategoria = {};
var fotosCache_ = [];
var filtroFotoActual = 'Todas';

// ============================================================
// Caché con deduplicado de pedidos en vuelo.
// =======================================================================
// Antes, cada pantalla chequeaba "cache_[clave]" antes de pedir red, pero
// eso solo evita un pedido SI EL ANTERIOR YA TERMINÓ. Si el jugador
// elegía categoría (dispara la precarga en segundo plano de Posiciones/
// Fixture/Resultados) y enseguida tocaba "Posiciones" antes de que esa
// precarga terminara, "cache_" todavía estaba vacío y se disparaba un
// SEGUNDO pedido idéntico en paralelo -- el doble de tráfico y el doble
// de consumo de cuota de Apps Script por la misma pantalla. Acá se
// recuerda también la PROMESA en vuelo (no solo el resultado ya
// resuelto): un segundo pedido a la misma clave mientras el primero
// sigue viajando reutiliza esa misma promesa en vez de disparar otro
// fetch.
var cachePromesas_ = {};
function pedirConCache_(clave, pedirFn) {
  if (cache_[clave]) return Promise.resolve(cache_[clave]);
  if (cachePromesas_[clave]) return cachePromesas_[clave];
  var p = pedirFn().then(function (datos) {
    cache_[clave] = datos;
    delete cachePromesas_[clave];
    return datos;
  }).catch(function (err) {
    delete cachePromesas_[clave];
    throw err;
  });
  cachePromesas_[clave] = p;
  return p;
}

// Igual que pedirConCache_, pero SIN el atajo de "si ya está en cache_,
// devolvelo sin pedir nada" -- lo usan los pings de "entrada en calor"
// (calentarReservasApi_ y el refresco silencioso tras un retenerTurno
// fallido), que a propósito quieren datos frescos de la red aunque ya
// haya algo en caché. Lo que SÍ comparten con pedirConCache_ es
// cachePromesas_: si para la misma clave ya hay un pedido reciclado en
// vuelo (sea de acá o de un pedirConCache_ normal), lo reutilizan en vez
// de disparar un fetch nuevo.
//
// Por qué hace falta esto -- bug real medido en producción, no una
// suposición: el keep-alive (cada 4 minutos, ver iniciarKeepAlive_) y una
// acción real del jugador (por ejemplo, tocar "Elegir otro turno" después
// de que venciera una retención) pueden coincidir casi en el mismo
// instante. Antes de este arreglo, cada uno disparaba su PROPIO fetch()
// independiente a "disponibilidad" -- y se confirmó en vivo que cuando
// eso pasa, Apps Script/Google devuelven 404 ("No se pudo abrir el
// archivo en este momento") en LOS DOS pedidos, no en uno solo. No hace
// falta que el jugador haga nada raro para toparse con esto: alcanza con
// tener la pestaña abierta el tiempo suficiente para que el keep-alive
// tickee justo cuando se vuelve a pedir disponibilidad.
function pedirSinDuplicarEnVuelo_(clave, pedirFn) {
  if (cachePromesas_[clave]) return cachePromesas_[clave];
  var p = pedirFn().then(function (datos) {
    delete cachePromesas_[clave];
    return datos;
  }).catch(function (err) {
    delete cachePromesas_[clave];
    throw err;
  });
  cachePromesas_[clave] = p;
  return p;
}

// ============================================================
// Categoría guardada del jugador (localStorage)
// ============================================================
var LS_CATEGORIA_ = 'mp360_categoria';
function guardarCategoriaElegida_(cat) {
  try { localStorage.setItem(LS_CATEGORIA_, cat); } catch (e) { /* storage no disponible: no rompe la app */ }
}
function borrarCategoriaGuardada_() {
  try { localStorage.removeItem(LS_CATEGORIA_); } catch (e) { /* nada que borrar si no hay storage */ }
}
function leerCategoriaGuardada_() {
  try { return localStorage.getItem(LS_CATEGORIA_); } catch (e) { return null; }
}

// ============================================================
// Caché de CATEGORIAS entre visitas (localStorage, "stale-while-revalidate")
// ============================================================
// CATEGORIAS casi no cambia (solo cuando el admin arma una liga nueva),
// pero arrancarApp_ la pedía de cero en CADA carga de página vía
// apiFetch('bootstrap') -- el jugador se quedaba mirando el selector de
// categoría vacío varios segundos en cada visita, aunque fuera la MISMA
// lista de siempre. Ahora, si hay una copia local de menos de
// CATEGORIAS_CACHE_TTL_MS_, se usa para pintar el selector DE INMEDIATO,
// sin esperar red. El pedido real a apiFetch('bootstrap') sigue
// disparándose igual que antes, sin excepción -- sigue siendo la fuente
// de verdad: cuando responde, pisa CATEGORIAS/categoriaActual con el dato
// fresco (ver arrancarApp_) y vuelve a guardar la copia local. Si el
// admin borra o agrega una categoría, el jugador la ve apenas esa
// respuesta real llegue -- unos segundos más tarde, nunca más que eso.
var LS_CATEGORIAS_CACHE_ = 'mp360_categorias_cache';
var CATEGORIAS_CACHE_TTL_MS_ = 10 * 60 * 1000;
function leerCategoriasCache_() {
  try {
    var raw = localStorage.getItem(LS_CATEGORIAS_CACHE_);
    if (!raw) return null;
    var obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.categorias) || !obj.ts) return null;
    if (Date.now() - obj.ts > CATEGORIAS_CACHE_TTL_MS_) return null;
    return obj.categorias;
  } catch (e) { return null; }
}
function guardarCategoriasCache_(categorias) {
  try {
    localStorage.setItem(LS_CATEGORIAS_CACHE_, JSON.stringify({ categorias: categorias, ts: Date.now() }));
  } catch (e) { /* storage no disponible: no rompe la app, solo no hay caché */ }
}

// "premios", "sobre-liga" y "contacto" son pantallas nuevas de este
// rediseño; "sobre-liga" y "contacto" no piden nada al backend (son
// contenido fijo editable directo en index.html), por eso no tienen
// caso en cargarPantalla_ más abajo.
var NAV_GRUPO = {
  inicio: 'inicio', posiciones: 'posiciones', fixture: 'fixture', resultados: 'resultados',
  mas: 'mas', playoffs: 'mas', fotos: 'mas', reglamento: 'mas', premios: 'mas',
  sponsors: 'mas', 'sobre-liga': 'mas', contacto: 'mas', reservar: 'mas', 'reserva-gestion': 'mas',
  'buscar-reserva': 'mas',
};

function esc_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function iniciales_(nombre) {
  return String(nombre || '').split(' / ').map(function (p) { return p.trim().charAt(0); }).join('').toUpperCase().slice(0, 2);
}
function uniq_(arr) {
  var visto = {}, out = [];
  arr.forEach(function (v) { if (v && !visto[v]) { visto[v] = true; out.push(v); } });
  return out;
}
function parsearSet_(texto) {
  var m = /^(\d{1,2})[-/\s]+(\d{1,2})$/.exec(String(texto || '').trim());
  return m ? { a: parseInt(m[1], 10), b: parseInt(m[2], 10) } : null;
}

// Una fila por pareja, una columna por set: nunca una secuencia de
// números pegada a un solo nombre que se pueda leer al revés.
function renderScoreboard_(parejaA, parejaB, sets, ganador) {
  var parsed = sets.map(parsearSet_);
  var aGana = ganador === parejaA;
  function celdas(lado) {
    return parsed.map(function (s) {
      if (!s) return '<span class="scoreboard-set">–</span>';
      var v = lado === 'a' ? s.a : s.b, o = lado === 'a' ? s.b : s.a;
      return '<span class="scoreboard-set' + (v > o ? ' mayor' : '') + '">' + v + '</span>';
    }).join('');
  }
  return '<div class="scoreboard">' +
    '<div class="scoreboard-row ' + (aGana ? 'win' : 'lose') + '">' +
    '<span class="avatar">' + iniciales_(parejaA) + '</span>' +
    '<span class="scoreboard-nombre">' + esc_(parejaA) + '</span>' +
    '<span class="scoreboard-sets">' + celdas('a') + '</span></div>' +
    '<div class="scoreboard-row ' + (aGana ? 'lose' : 'win') + '">' +
    '<span class="avatar">' + iniciales_(parejaB) + '</span>' +
    '<span class="scoreboard-nombre">' + esc_(parejaB) + '</span>' +
    '<span class="scoreboard-sets">' + celdas('b') + '</span></div>' +
    '</div>';
}

// ============================================================
// Navegación
// ============================================================
function irA(pantalla) {
  document.getElementById('screen-' + pantallaActual).hidden = true;
  pantallaActual = pantalla;
  document.getElementById('screen-' + pantalla).hidden = false;
  document.querySelectorAll('.nav-item').forEach(function (el) {
    el.classList.toggle('active', el.getAttribute('data-nav') === NAV_GRUPO[pantalla]);
  });
  cargarPantalla_(pantalla);
  document.getElementById('body').scrollTop = 0;
}

document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-go]');
  if (el) irA(el.getAttribute('data-go'));
});

function cargarPantalla_(pantalla) {
  // Sin categoría elegida todavía no hay nada que filtrar en estas tres
  // pantallas: mandamos al jugador de vuelta a Inicio a elegirla.
  if (!categoriaActual && (pantalla === 'posiciones' || pantalla === 'fixture' || pantalla === 'resultados')) {
    irA('inicio');
    return;
  }
  if (pantalla === 'posiciones') cargarPosiciones_();
  else if (pantalla === 'fixture') cargarFixture_();
  else if (pantalla === 'resultados') cargarResultados_();
  else if (pantalla === 'playoffs' || pantalla === 'reglamento' || pantalla === 'premios') cargarMas_();
  else if (pantalla === 'fotos') cargarFotos_();
  else if (pantalla === 'sponsors') cargarSponsors_();
  else if (pantalla === 'reservar') { calentarReservasApi_(); iniciarReservarSiHaceFalta_(); }
  else if (pantalla === 'buscar-reserva') { calentarReservasApi_(); buscarReservaResetForm_(); }
  // 'sobre-liga', 'contacto' y 'reserva-gestion' no piden nada acá: la
  // gestión de reserva se carga aparte, directo desde el arranque (ver
  // más abajo), porque depende del token de la URL, no de la navegación.
}

// ============================================================
// Selector de categoría (chips, compartido entre 3 pantallas)
// ============================================================
function pintarChipsCategoria_(contId) {
  document.getElementById(contId).innerHTML = CATEGORIAS.map(function (cat) {
    return '<button class="chip' + (cat === categoriaActual ? ' active' : '') + '" data-cat="' + esc_(cat) + '">' + esc_(cat) + '</button>';
  }).join('');
}
function elegirCategoria_(cat) {
  categoriaActual = cat;
  document.querySelectorAll('.cat-chips .chip').forEach(function (c) {
    c.classList.toggle('active', c.getAttribute('data-cat') === categoriaActual);
  });
  guardarCategoriaElegida_(categoriaActual);
  // Elegido el chip, el selector se cierra/compacta (patrón tap-para-
  // desplegar: la próxima vez que haga falta elegir, arranca cerrado).
  actualizarSelectorInicio_(false);
  precargarPantallasCategoria_(categoriaActual);
  cargarPantalla_(pantallaActual);
}

// ============================================================
// Tap robusto sobre los chips de categoría (Pointer Events)
// ============================================================
// #inicioCats tiene scroll horizontal: el navegador suprime el click
// nativo apenas el dedo se mueve más de ~12-15px entre el touchstart y
// el touchend, algo muy común ahí (arrastre parcial para ver más
// categorías, inercia de scroll que no terminó de asentarse). Por eso
// medimos nosotros mismos el desplazamiento real del puntero: si fue
// chico, es un tap y elegimos la categoría; si fue grande, es un swipe
// real y no hacemos nada (nunca llamamos preventDefault, así que el
// scroll nativo de los chips sigue funcionando igual que siempre).
// El mouse sigue resuelto por el click de siempre, que ya es
// confiable, para no cambiar nada ahí.
var UMBRAL_TAP_PX_ = 10;
var tapPointerInicio_ = null;
var tapChipManejadoEl_ = null;
var tapChipManejadoTs_ = 0;

document.addEventListener('pointerdown', function (e) {
  if (tapPointerInicio_) return; // ya estamos siguiendo otro puntero
  var el = e.target.closest('#inicioCats [data-cat]');
  if (!el) return;
  tapPointerInicio_ = { x: e.clientX, y: e.clientY, el: el, id: e.pointerId, tipo: e.pointerType };
});
document.addEventListener('pointerup', function (e) {
  if (!tapPointerInicio_ || e.pointerId !== tapPointerInicio_.id) return;
  var inicio = tapPointerInicio_;
  tapPointerInicio_ = null;
  if (inicio.tipo === 'mouse') return;
  var dist = Math.hypot(e.clientX - inicio.x, e.clientY - inicio.y);
  if (dist > UMBRAL_TAP_PX_) return; // swipe real: se deja pasar, no es un tap
  elegirCategoria_(inicio.el.getAttribute('data-cat'));
  // Marca este chip como ya resuelto: el navegador todavía puede
  // disparar un click sintético después del touchend, y no queremos
  // procesar la selección dos veces.
  tapChipManejadoEl_ = inicio.el;
  tapChipManejadoTs_ = Date.now();
});
document.addEventListener('pointercancel', function () { tapPointerInicio_ = null; });

document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-cat]');
  if (!el) return;
  if (el === tapChipManejadoEl_ && (Date.now() - tapChipManejadoTs_) < 800) return;
  elegirCategoria_(el.getAttribute('data-cat'));
});

// ============================================================
// Selector de categoría de Inicio (independiente del resto del
// contenido de Inicio: novedades/sponsors/galería rotos NUNCA deben
// impedir que esto se pinte).
//
// Patrón "tap para desplegar": sin categoría elegida, Inicio arranca
// mostrando solo el CTA "Seleccioná tu categoría" -- los chips de
// CATEGORIAS NO están desplegados todavía. Recién al tocar el CTA (o,
// con categoría ya elegida, la fila compacta) se despliegan.
// ============================================================
var selectorInicioAbierto_ = false;

// abrir: true/false para forzar el estado de los chips; se omite para
// dejar el estado tal cual está (usado al repintar por otros motivos,
// como al cambiar de pantalla).
function actualizarSelectorInicio_(abrir) {
  var cta = document.getElementById('cat-select-cta');
  var expandido = document.getElementById('cat-select-expanded');
  var bloque = document.getElementById('cat-select-block');
  var filaActiva = document.getElementById('cat-active-row');
  var valorActivo = document.getElementById('cat-active-value');

  if (typeof abrir === 'boolean') selectorInicioAbierto_ = abrir;

  pintarChipsCategoria_('inicioCats');

  var hayCategoria = !!categoriaActual;
  var mostrarChips = selectorInicioAbierto_;

  cta.hidden = hayCategoria || mostrarChips;
  expandido.hidden = !mostrarChips;
  filaActiva.hidden = !hayCategoria || mostrarChips;
  bloque.classList.toggle('is-compact', hayCategoria && !mostrarChips);
  bloque.classList.toggle('needs-choice', !hayCategoria);
  valorActivo.textContent = hayCategoria ? categoriaActual : '';
}
document.getElementById('cat-select-cta').addEventListener('click', function () {
  actualizarSelectorInicio_(true);
});
document.getElementById('cat-active-row').addEventListener('click', function () {
  actualizarSelectorInicio_(true);
});

// ============================================================
// Inicio
// ============================================================
// Robusto frente a datos opcionales rotos (null/undefined/vacíos/
// elementos null/objetos incompletos): un problema acá jamás debe
// afectar el selector de categoría, que se pinta aparte.
function renderInicio_(datos) {
  datos = datos || {};
  var novedades = (Array.isArray(datos.novedades) ? datos.novedades : []).filter(Boolean);
  var sponsors = (Array.isArray(datos.sponsors) ? datos.sponsors : []).filter(Boolean);

  var elStatus = document.getElementById('hero-status');
  if (datos.banner && datos.banner.titulo) {
    elStatus.hidden = false;
    elStatus.textContent = datos.banner.titulo;
  } else {
    elStatus.hidden = true;
  }

  document.getElementById('novedades').innerHTML = novedades.map(function (n) {
    return '<div class="news-card"><b>' + esc_(n.titulo) + '</b><span>' + esc_(n.texto) + '</span></div>';
  }).join('');

  var elSp = document.getElementById('ini-sponsors');
  if (sponsors.length) {
    elSp.hidden = false;
    document.getElementById('ini-sponsors-logos').innerHTML = sponsors.map(sponsorChipHtml_).join('');
  } else {
    elSp.hidden = true;
  }
}

// Un sponsor-chip muestra el logo real (logoUrl de la hoja SPONSORS) si
// existe; si esa fila todavía no tiene logo cargado, muestra el nombre
// como texto -- nunca queda un chip vacío ni una imagen rota.
function sponsorChipHtml_(s) {
  s = s || {};
  if (s.logoUrl) {
    return '<div class="sponsor-chip has-img" style="background-image:url(\'' + esc_(s.logoUrl) + '\')" title="' + esc_(s.nombre) + '"></div>';
  }
  return '<div class="sponsor-chip">' + esc_(s.nombre) + '</div>';
}

// Banner "Más que una liga": usa la primera foto real de GALERIA como
// fondo. Se pide aparte del bootstrap (no bloquea ni rompe Inicio si la
// galería tarda o todavía no tiene fotos cargadas).
function cargarFotosInicio_() {
  // Comparte caché con cargarFotos_ (pantalla Fotos): sin esto, entrar a
  // Inicio y después a Fotos pedía "galeria" dos veces por separado.
  pedirConCache_('fotos', function () { return apiFetch('galeria'); }).then(function (fotos) {
    if (!Array.isArray(fotos) || !fotos.length) return;
    var foto = fotos[0] || {};
    var banner = document.getElementById('community-banner');
    var bg = document.getElementById('community-bg');
    var img = new Image();
    img.onload = function () {
      bg.style.backgroundImage = "url('" + foto.url + "')";
      banner.hidden = false;
    };
    img.onerror = function () { /* la foto no cargó: el banner sigue oculto */ };
    img.src = foto.url;
  }).catch(function () { /* sin fotos no rompe Inicio */ });
}

// ============================================================
// Precarga en segundo plano de Posiciones/Fixture/Resultados para la
// categoría activa. Usa exactamente el mismo cache_ y las mismas
// claves ('pos|cat', 'fix|cat', 'res|cat') que ya consultan
// cargarPosiciones_/cargarFixture_/cargarResultados_ antes de pedir
// red -- por eso alcanza con completar cache_ acá: si el jugador
// después entra a esas pantallas y la precarga ya terminó, las va a
// ver instantáneas, sin tocar en nada su lógica de carga ni de
// render. Nunca renderiza nada ella misma (eso lo sigue haciendo cada
// pantalla la primera vez que se visita, cache_ mediante).
// Si una petición falla, el catch la ignora en silencio: no rompe
// Inicio ni muestra ningún error, y esa pantalla simplemente va a
// pedir sus datos de nuevo (como si no hubiese precarga) cuando el
// jugador la visite.
function precargarPantallasCategoria_(cat) {
  if (!cat) return;
  pedirConCache_('pos|' + cat, function () { return apiFetch('posiciones', { categoria: cat }); }).catch(function () { /* sin precarga, cargarPosiciones_ pide los datos igual */ });
  pedirConCache_('fix|' + cat, function () { return apiFetch('fixture', { categoria: cat }); }).catch(function () { /* idem */ });
  pedirConCache_('res|' + cat, function () { return apiFetch('resultados', { categoria: cat }); }).catch(function () { /* idem */ });
}

// ============================================================
// Posiciones
// ============================================================
function cargarPosiciones_() {
  var cat = categoriaActual; if (!cat) return;
  var clave = 'pos|' + cat;
  if (cache_[clave]) { renderPosiciones_(cache_[clave]); return; }
  document.getElementById('posRows').innerHTML = '<div class="state-loading">Cargando…</div>';
  pedirConCache_(clave, function () { return apiFetch('posiciones', { categoria: cat }); }).then(function (filas) {
    if (categoriaActual === cat) renderPosiciones_(filas);
  }).catch(function () {
    if (categoriaActual === cat) document.getElementById('posRows').innerHTML =
      '<p class="state-empty">No se pudo cargar la tabla. Probá de nuevo en un momento.</p>';
  });
}
function renderPosiciones_(filas) {
  var cont = document.getElementById('posRows');
  if (!filas.length) { cont.innerHTML = '<p class="state-empty">Todavía no hay parejas activas en esta categoría.</p>'; return; }
  cont.innerHTML = filas.map(function (f, i) {
    var rankClass = i === 0 ? ' g1' : i === 1 ? ' g2' : i === 2 ? ' g3' : '';
    return '<div class="standing-row' + (i < 3 ? ' top' : '') + '">' +
      '<button class="standing-main" data-toggle-row>' +
        '<span class="standing-rank' + rankClass + '">' + f.pos + '</span>' +
        '<span class="standing-pareja">' + esc_(f.pareja) + '</span>' +
        '<span class="standing-num">' + f.pj + '</span><span class="standing-num">' + f.pg + '</span><span class="standing-num">' + f.pp + '</span>' +
        '<span class="standing-pts">' + f.pts + '</span>' +
      '</button>' +
      '<div class="standing-detail"><div class="standing-detail-inner">' +
        '<div><span class="v">' + f.setsFavor + '–' + f.setsContra + '</span><span class="l">Sets</span></div>' +
        '<div><span class="v">' + (f.difSets > 0 ? '+' : '') + f.difSets + '</span><span class="l">Dif. sets</span></div>' +
        '<div><span class="v">' + f.gamesFavor + '–' + f.gamesContra + '</span><span class="l">Games</span></div>' +
      '</div></div>' +
    '</div>';
  }).join('');
}
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-toggle-row]');
  if (btn) btn.closest('.standing-row').classList.toggle('open');
});

// ============================================================
// Fixture
// ============================================================
function cargarFixture_() {
  var cat = categoriaActual; if (!cat) return;
  var clave = 'fix|' + cat;
  if (cache_[clave]) { renderFixture_(cache_[clave]); return; }
  document.getElementById('fixMatches').innerHTML = '<div class="state-loading">Cargando…</div>';
  document.getElementById('fixFechas').innerHTML = '';
  pedirConCache_(clave, function () { return apiFetch('fixture', { categoria: cat }); }).then(function (datos) {
    if (categoriaActual === cat) renderFixture_(datos);
  }).catch(function () {
    if (categoriaActual === cat) document.getElementById('fixMatches').innerHTML =
      '<p class="state-empty">No se pudo cargar el fixture. Probá de nuevo en un momento.</p>';
  });
}
function renderFixture_(datos) {
  var contFechas = document.getElementById('fixFechas');
  var contM = document.getElementById('fixMatches');
  if (!datos.fechas.length) {
    contFechas.innerHTML = '';
    contM.innerHTML = '<p class="state-empty">Todavía no se generó el fixture de esta categoría.</p>';
    return;
  }
  if (!fechaPorCategoria[categoriaActual]) {
    fechaPorCategoria[categoriaActual] = datos.fechas[datos.fechas.length - 1].numero;
  }
  var sel = fechaPorCategoria[categoriaActual];
  contFechas.innerHTML = datos.fechas.map(function (f) {
    return '<button class="chip' + (f.numero === sel ? ' active' : '') + '" data-fecha="' + f.numero + '">Fecha ' + f.numero + '</button>';
  }).join('');
  var fecha = datos.fechas.filter(function (f) { return f.numero === sel; })[0] || datos.fechas[0];
  // Nota: acá NO se muestran horario ni cancha porque PARTIDOS no trae
  // esos datos hoy. Apenas existan en la planilla, se agregan sin tocar
  // el resto de la tarjeta.
  var html = fecha.partidos.map(function (p) {
    if (p.estado === 'JUGADO') return '<div class="match-card">' + renderScoreboard_(p.parejaA, p.parejaB, p.sets, p.ganador) + '</div>';
    return '<div class="match-card"><span class="match-pending-tag">Pendiente</span>' +
      '<div class="match-pair"><span class="avatar">' + iniciales_(p.parejaA) + '</span><span class="nm">' + esc_(p.parejaA) + '</span></div>' +
      '<div class="vs-div">VS</div>' +
      '<div class="match-pair"><span class="avatar">' + iniciales_(p.parejaB) + '</span><span class="nm">' + esc_(p.parejaB) + '</span></div>' +
    '</div>';
  }).join('');
  html += fecha.libres.map(function (nombre) {
    return '<div class="bye-card">Libre esta fecha: <b>' + esc_(nombre) + '</b></div>';
  }).join('');
  contM.innerHTML = html;
}
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-fecha]');
  if (!el) return;
  fechaPorCategoria[categoriaActual] = Number(el.getAttribute('data-fecha'));
  var datos = cache_['fix|' + categoriaActual];
  if (datos) renderFixture_(datos);
});

// ============================================================
// Resultados
// ============================================================
function cargarResultados_() {
  var cat = categoriaActual; if (!cat) return;
  var clave = 'res|' + cat;
  if (cache_[clave]) { renderResultados_(cache_[clave]); return; }
  document.getElementById('resMatches').innerHTML = '<div class="state-loading">Cargando…</div>';
  pedirConCache_(clave, function () { return apiFetch('resultados', { categoria: cat }); }).then(function (lista) {
    if (categoriaActual === cat) renderResultados_(lista);
  }).catch(function () {
    if (categoriaActual === cat) document.getElementById('resMatches').innerHTML =
      '<p class="state-empty">No se pudo cargar los resultados. Probá de nuevo en un momento.</p>';
  });
}
function renderResultados_(lista) {
  var cont = document.getElementById('resMatches');
  if (!lista.length) { cont.innerHTML = '<p class="state-empty">Todavía no hay resultados cargados en esta categoría.</p>'; return; }
  var porFecha = {}, orden = [];
  lista.forEach(function (r) {
    if (!porFecha[r.fecha]) { porFecha[r.fecha] = []; orden.push(r.fecha); }
    porFecha[r.fecha].push(r);
  });
  cont.innerHTML = orden.map(function (fecha) {
    var tarjetas = porFecha[fecha].map(function (r) {
      return '<div class="match-card">' + renderScoreboard_(r.parejaA, r.parejaB, r.sets, r.ganador) + '</div>';
    }).join('');
    return '<div class="fecha-block-label">Fecha ' + fecha + '</div>' + tarjetas;
  }).join('');
}

// ============================================================
// Más: Playoffs + Reglamento + Premios
// (una sola llamada a mp360GetMas() alimenta las tres pantallas)
// ============================================================
function cargarMas_() {
  if (cache_.mas) { renderMas_(cache_.mas); return; }
  pedirConCache_('mas', function () { return apiFetch('mas'); }).then(function (datos) {
    renderMas_(datos);
  }).catch(function () {
    document.getElementById('premios-bloques').innerHTML = '<p class="state-empty">No se pudieron cargar los premios.</p>';
  });
}
// El reglamento ya no se arma con bloques de texto de la planilla: la
// pantalla de Reglamento ahora es el PDF oficial completo (ver
// index.html), así que datos.reglamento no se usa acá. Se sigue
// pidiendo igual porque esta misma llamada alimenta Playoffs y Premios.
function renderMas_(datos) {
  document.getElementById('playoffs-mensaje').textContent = datos.playoffsMensaje;

  var premios = datos.premios.map(function (p) {
    return '<div class="reg-block"><b>' + esc_(p.titulo) + '</b><p>' + esc_(p.texto) + '</p></div>';
  }).join('');
  document.getElementById('premios-bloques').innerHTML = premios || '<p class="state-empty">Todavía no se cargaron los premios.</p>';
}

// ============================================================
// Fotos
// ============================================================
function cargarFotos_() {
  if (cache_.fotos) { renderFotos_(cache_.fotos); return; }
  document.getElementById('fotosGrid').innerHTML = '<div class="state-loading">Cargando…</div>';
  pedirConCache_('fotos', function () { return apiFetch('galeria'); }).then(function (datos) {
    renderFotos_(datos);
  }).catch(function () {
    document.getElementById('fotosGrid').innerHTML = '<p class="state-empty">No se pudieron cargar las fotos.</p>';
  });
}
function renderFotos_(fotos) {
  fotosCache_ = fotos;
  var categorias = ['Todas'].concat(uniq_(fotos.map(function (f) { return f.categoria; })));
  document.getElementById('fotosFiltros').innerHTML = categorias.map(function (c) {
    return '<button class="chip' + (c === filtroFotoActual ? ' active' : '') + '" data-foto-cat="' + esc_(c) + '">' + esc_(c) + '</button>';
  }).join('');
  pintarGrillaFotos_();
}
function pintarGrillaFotos_() {
  var lista = filtroFotoActual === 'Todas' ? fotosCache_ : fotosCache_.filter(function (f) { return f.categoria === filtroFotoActual; });
  var cont = document.getElementById('fotosGrid');
  if (!lista.length) { cont.innerHTML = '<p class="state-empty">Todavía no hay fotos cargadas.</p>'; return; }
  cont.innerHTML = lista.map(function (f) {
    return '<div class="photo-swatch"><img loading="lazy" src="' + esc_(f.url) + '" alt="' + esc_(f.titulo) + '" onerror="this.parentElement.remove()"><span>' + esc_(f.titulo || f.categoria) + '</span></div>';
  }).join('');
}
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-foto-cat]');
  if (!el) return;
  filtroFotoActual = el.getAttribute('data-foto-cat');
  renderFotos_(fotosCache_);
});

// ============================================================
// Sponsors
// ============================================================
function cargarSponsors_() {
  if (cache_.sponsors) { renderSponsors_(cache_.sponsors); return; }
  pedirConCache_('sponsors', function () { return apiFetch('sponsors'); }).then(function (datos) {
    renderSponsors_(datos);
  }).catch(function () {
    var el = document.getElementById('sponsors-empty');
    el.hidden = false;
    el.textContent = 'No se pudo cargar esta sección.';
  });
}
function renderSponsors_(datos) {
  var elDest = document.getElementById('sponsor-destacado');
  if (datos.destacado) {
    elDest.hidden = false;
    document.getElementById('sponsor-destacado-nombre').textContent = datos.destacado.nombre;
    var logo = document.getElementById('sponsor-destacado-logo');
    if (datos.destacado.logoUrl) {
      logo.classList.add('has-img');
      logo.style.backgroundImage = "url('" + datos.destacado.logoUrl + "')";
      logo.textContent = '';
    }
  } else {
    elDest.hidden = true;
  }
  document.getElementById('sponsor-resto').innerHTML = datos.resto.map(function (s) {
    var chip = sponsorChipHtml_(s);
    if (!s.link) return chip;
    // Envolvemos el mismo chip en un link cuando la fila tiene LINK cargado.
    return chip.replace('<div class="sponsor-chip', '<a href="' + esc_(s.link) + '" target="_blank" rel="noopener" class="sponsor-chip').replace(/<\/div>$/, '</a>');
  }).join('');
  document.getElementById('sponsors-empty').hidden = !!(datos.destacado || datos.resto.length);
}

// ============================================================
// Reservas API — cliente HTTP (proyecto de Apps Script SEPARADO)
// =======================================================================
// RESERVAS_API_URL es una URL nueva y aparte de API_URL: apunta al
// deployment de "MASTER PÁDEL 360 - Reservas API" (CodigoReservasAPI.gs),
// que es el único backend que escribe datos de reservas. API_URL de
// arriba (CodigoWebApp.gs) NO se toca ni se reutiliza para esto.
//
// Mismo patrón fetch+JSONP que apiFetch para las acciones de lectura
// (GET). Las acciones que escriben (retenerTurno/confirmarReserva/
// cancelarReserva) van por POST -- no existe forma de mandar JSONP con
// body, y confirmarReserva necesita mandar el comprobante en base64, que
// no entra cómodo en una URL de GET.
//
// El POST se manda con Content-Type "text/plain" a propósito: si fuera
// "application/json" el navegador dispara antes un preflight OPTIONS,
// que una Web App de Apps Script no contesta como espera el estándar
// CORS, y el pedido real nunca llega. "text/plain" es un content-type
// "simple" (no dispara preflight) y el backend igual lo interpreta bien,
// porque lee e.postData.contents y lo parsea como JSON sin mirar el
// Content-Type declarado (ver CodigoReservasAPI.gs, ejecutarAccion_).
// ============================================================
var RESERVAS_API_URL = 'https://script.google.com/macros/s/AKfycbxWpBJOCBr8oNLYfoaPAGUbB4KDjDaLJ4ars9B6Zv_f3prrCC-Tz1j-xEELxvvZlaJICQ/exec';
// Mismo criterio que API_TIMEOUT_MS_ arriba: 15s de margen real contra
// el backend, medido en vivo, en vez de un valor corto que termina
// provocando un reintento completo (más lento, no más rápido).
var RSV_TIMEOUT_GET_MS_ = 15000;
var RSV_TIMEOUT_POST_MS_ = 25000;
var ALIAS_TRANSFERENCIA_TX_ = 'masterpadel.360';
var RSV_COMPROBANTE_MAX_BYTES_ = 5 * 1024 * 1024; // 5 MB

function fetchConTimeout_(url, opciones, ms) {
  var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var opts = Object.assign({}, opciones);
  if (controller) opts.signal = controller.signal;
  var timer = setTimeout(function () { if (controller) controller.abort(); }, ms);
  return fetch(url, opts).then(function (r) { clearTimeout(timer); return r; }, function (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') throw new Error('El servidor de reservas no respondió a tiempo. Probá de nuevo.');
    throw err;
  });
}

function reservasApiGetJson_(url) {
  return fetchConTimeout_(url, { method: 'GET' }, RSV_TIMEOUT_GET_MS_)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (payload) {
      if (!payload || !payload.ok) throw new Error((payload && payload.error) || 'Error desconocido');
      return payload.data;
    });
}

var rsvJsonpContador_ = 0;
function reservasApiGetJsonp_(url) {
  return new Promise(function (resolve, reject) {
    var cb = 'mp360rsvcb_' + (rsvJsonpContador_++);
    var script = document.createElement('script');
    var resuelto = false;
    function limpiar() { delete window[cb]; if (script.parentNode) script.parentNode.removeChild(script); }
    window[cb] = function (payload) {
      resuelto = true; limpiar();
      if (payload && payload.ok) resolve(payload.data);
      else reject(new Error((payload && payload.error) || 'Error desconocido'));
    };
    script.src = url + '&callback=' + cb;
    script.onerror = function () { limpiar(); reject(new Error('No se pudo conectar con el servidor de reservas.')); };
    document.body.appendChild(script);
    setTimeout(function () { if (!resuelto) { limpiar(); reject(new Error('Tiempo de espera agotado.')); } }, RSV_TIMEOUT_GET_MS_);
  });
}

function reservasApiGet_(accion, params) {
  params = params || {};
  var qs = Object.keys(params).reduce(function (arr, k) {
    if (params[k] !== undefined && params[k] !== null) {
      arr.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
    return arr;
  }, ['accion=' + encodeURIComponent(accion)]).join('&');
  var url = RESERVAS_API_URL + '?' + qs;
  return reservasApiGetJson_(url).catch(function () { return reservasApiGetJsonp_(url); });
}

// respuestaDelBackend=true marca un error que es una respuesta REAL del
// backend (payload {ok:false, error:"..."}) -- el pedido llegó, se
// procesó, y la razón del rechazo es de negocio (retención vencida, cupo
// ocupado, datos inválidos, etc.). Cualquier otro error (HTTP no-2xx,
// timeout, corte de red, JSON roto) queda SIN esta marca: significa que
// no sabemos si el pedido llegó a procesarse o no, así que es
// potencialmente seguro reintentarlo en una acción idempotente (ver
// confirmarReservaConReintento_ más abajo) -- nunca al revés: un error
// marcado respuestaDelBackend NUNCA debe reintentarse solo, porque ya es
// una respuesta definitiva y reintentar no cambiaría nada.
function reservasApiPost_(accion, datos) {
  var url = RESERVAS_API_URL + '?accion=' + encodeURIComponent(accion);
  return fetchConTimeout_(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(datos || {}),
  }, RSV_TIMEOUT_POST_MS_)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (payload) {
      if (!payload || !payload.ok) {
        var err = new Error((payload && payload.error) || 'Error desconocido');
        err.respuestaDelBackend = true;
        throw err;
      }
      return payload.data;
    });
}

// ============================================================
// Keep-alive: mantener "tibios" los dos backends de Apps Script
// =======================================================================
// Causa real medida en vivo (no una suposición): Google Apps Script
// recicla la instancia de ejecución de un proyecto que no recibe pedidos
// por un rato -- la PRÓXIMA vez que sí llega uno, paga un "arranque en
// frío" (levantar el runtime + volver a abrir la planilla desde cero)
// que puede tardar bastante más que una llamada normal. Esto es
// exactamente lo que pasó con "Buscar mi reserva": el primer toque cayó
// en frío, y el segundo, inmediato, ya encontró todo tibio.
//
// Esto NO se soluciona agrandando un timeout -- un timeout más largo
// solo esperaría más tiempo al mismo arranque en frío, no lo evita. Lo
// que sí ayuda desde el frontend es reducir las CHANCES de que la
// próxima acción real del jugador sea la que le toque pagar ese
// arranque: mientras la app está abierta y a la vista, se manda cada
// tanto un pedido liviano y de solo lectura a cada backend para
// mantenerlos tibios. Además, al entrar a "Reservar turno" o "Buscar mi
// reserva" se dispara un pedido extra de entrada en calor de inmediato,
// en paralelo, sin bloquear nada -- si el backend estaba frío, así tiene
// el tiempo que el jugador tarda en leer la pantalla o tipear sus datos
// para terminar de arrancar antes de que se necesite la respuesta real.
// Antes, esto pedía "disponibilidad" de nuevo cada vez que se entraba a
// "Reservar turno" o "Buscar mi reserva" -- aunque hiciera 3 segundos que
// ya se había pedido (por ejemplo, yendo y viniendo entre pantallas). Con
// el backend de reservas bajo carga (medido en vivo: un mismo pedido
// pasó de ~2.5s a 10-30s en un rato de uso intenso), machacarlo con
// pedidos redundantes empeora exactamente el problema que se quiere
// evitar. Ahora se respeta un dato ya fresco por RSV_DISPONIBILIDAD_FRESCO_MS_
// y no se vuelve a pedir -- igual sigue sirviendo como "entrada en calor"
// cuando hace falta de verdad (primera vez, o pasado ese ratito).
var RSV_DISPONIBILIDAD_FRESCO_MS_ = 20000;
var disponibilidadUltimoFetchTs_ = 0;
function calentarReservasApi_() {
  if (cache_.disponibilidad && (Date.now() - disponibilidadUltimoFetchTs_) < RSV_DISPONIBILIDAD_FRESCO_MS_) return;
  pedirSinDuplicarEnVuelo_('disponibilidad', function () { return reservasApiGet_('disponibilidad', {}); }).then(function (datos) {
    disponibilidadUltimoFetchTs_ = Date.now();
    cache_.disponibilidad = datos; // de paso, refresca el caché con datos frescos
  }).catch(function () { /* esto es solo un ping de entrada en calor: si falla, no pasa nada */ });
}

// 6 minutos y no 4: bajo carga real (varias personas probando/reservando
// a la vez) cada ping de "entrada en calor" es un pedido más compitiendo
// por el mismo LockService/cuota que las acciones reales del jugador --
// espaciarlo reduce ese ruido de fondo sin perder gran cosa: 6 minutos
// sigue siendo bastante menos que lo que tarda Apps Script en "enfriarse"
// del todo.
var RSV_KEEPALIVE_MS_ = 6 * 60 * 1000; // 6 minutos
function iniciarKeepAlive_() {
  setInterval(function () {
    // No gastar cuota de Apps Script con la pestaña en segundo plano --
    // ahí no hay ninguna acción real inminente que "proteger" del frío.
    if (document.visibilityState !== 'visible') return;
    apiFetch('categorias').catch(function () { /* idem: solo calienta */ });
    calentarReservasApi_();
  }, RSV_KEEPALIVE_MS_);
}

function formatearFechaLarga_(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? (m[3] + '/' + m[2]) : String(iso || '');
}
function formatearMonto_(n) {
  return '$' + Number(n || 0).toLocaleString('es-AR');
}
// Defensa extra en el frontend (el arreglo de raíz está en el backend,
// ver normalizarHorario_ en CodigoReservasAPI.gs): si alguna vez llegara
// un horario mal formado -- un ISO/Date en vez de "HH:MM" -- esto lo
// recorta a HH:MM en vez de mostrar texto técnico. Un "17:00" normal
// pasa sin tocarlo.
function formatearHorarioSeguro_(valor) {
  var texto = String(valor === null || valor === undefined ? '' : valor);
  if (/^\d{2}:\d{2}$/.test(texto)) return texto;
  var m = /(\d{2}):(\d{2}):\d{2}/.exec(texto);
  return m ? (m[1] + ':' + m[2]) : texto;
}

// ============================================================
// Reservar turno — estado del wizard
// ============================================================
var reservaCategoria_ = null;
var reservaPartido_ = null;
var reservaRetencion_ = null;
var reservaComprobante_ = null;
var reservaCruces_ = [];
var reservaCountdownTimer_ = null;
var reservaEnvioEnCurso_ = false;

var RSV_PASOS_ = ['categoria', 'cruce', 'turno', 'checkout'];

function reservarIrAPaso_(paso) {
  RSV_PASOS_.concat(['exito']).forEach(function (p) {
    var panel = document.getElementById('rsv-panel-' + p);
    if (panel) panel.hidden = (p !== paso);
  });
  var idxActual = RSV_PASOS_.indexOf(paso);
  document.getElementById('rsv-steps').hidden = (paso === 'exito');
  document.querySelectorAll('#rsv-steps .rsv-step').forEach(function (el) {
    var idx = RSV_PASOS_.indexOf(el.getAttribute('data-step'));
    el.classList.toggle('active', idx === idxActual);
    el.classList.toggle('done', idxActual > -1 && idx > -1 && idx < idxActual);
  });
}

function iniciarReservarSiHaceFalta_() {
  if (reservaCategoria_) return; // ya hay progreso en curso: no reiniciar
  reservarRenderCategorias_();
  reservarIrAPaso_('categoria');
}

// ---------- Paso 1: categoría ----------
function reservarRenderCategorias_() {
  document.getElementById('rsvCats').innerHTML = CATEGORIAS.map(function (cat) {
    return '<button class="chip' + (cat === reservaCategoria_ ? ' active' : '') + '" data-rsv-cat="' + esc_(cat) + '">' + esc_(cat) + '</button>';
  }).join('');
}
document.addEventListener('click', function (e) {
  var el = e.target.closest('#rsvCats [data-rsv-cat]');
  if (!el) return;
  reservaCategoria_ = el.getAttribute('data-rsv-cat');
  reservarRenderCategorias_();
  reservarCargarCruces_();
  reservarIrAPaso_('cruce');
});

// ---------- Paso 2: cruce ----------
// La "fecha en juego" de cada categoría es un valor 100% administrativo
// -- lo carga a mano el organizador en la hoja CATEGORIAS (columna
// FECHA EN JUEGO), NUNCA se calcula de la última fecha del fixture ni
// del texto editorial del banner de Inicio. Ese filtro ya lo aplica el
// propio backend de reservas (ver mp360ReservasGetPartidosDisponibles /
// leerFechaEnJuegoPorCategoria_ en CodigoReservasAPI.gs): lo que llega
// acá en "partidosDisponibles" ya viene acotado a esa fecha exacta, así
// que este lado solo tiene que mostrarlo -- no hace falta pedir ni cruzar
// contra el fixture.
function reservarCargarCruces_() {
  var cont = document.getElementById('rsvCruces');
  var catPedida = reservaCategoria_;
  var clave = 'cruces|' + catPedida;
  if (!cache_[clave]) cont.innerHTML = '<div class="state-loading">Cargando…</div>';
  pedirConCache_(clave, function () { return reservasApiGet_('partidosDisponibles', { categoria: catPedida }); }).then(function (lista) {
    if (reservaCategoria_ !== catPedida) return;
    reservaCruces_ = Array.isArray(lista) ? lista : [];
    if (!reservaCruces_.length) {
      cont.innerHTML = '<p class="state-empty">No hay partidos disponibles para reservar en la fecha actual.</p>';
      return;
    }
    cont.innerHTML = reservaCruces_.map(function (p) {
      return '<button class="rsv-cruce-card" data-rsv-partido="' + esc_(p.idPartido) + '">' +
        '<span class="rsv-cruce-pareja">' + esc_(p.parejaA) + '</span>' +
        '<span class="rsv-cruce-vs">vs</span>' +
        '<span class="rsv-cruce-pareja">' + esc_(p.parejaB) + '</span>' +
      '</button>';
    }).join('');
  }).catch(function (err) {
    if (reservaCategoria_ !== catPedida) return;
    cont.innerHTML = '<p class="state-empty">' + esc_((err && err.message) || 'No se pudieron cargar los cruces. Probá de nuevo.') + '</p>';
  });
}
document.addEventListener('click', function (e) {
  var el = e.target.closest('#rsvCruces [data-rsv-partido]');
  if (!el) return;
  var id = el.getAttribute('data-rsv-partido');
  reservaPartido_ = reservaCruces_.filter(function (p) { return p.idPartido === id; })[0] || null;
  if (!reservaPartido_) return;
  reservarCargarDisponibilidad_();
  reservarIrAPaso_('turno');
});

// ---------- Paso 3: día + horario ----------
function reservarCargarDisponibilidad_() {
  var cont = document.getElementById('rsvDias');
  if (cache_.disponibilidad) { reservarRenderDias_(cache_.disponibilidad); return; }
  cont.innerHTML = '<div class="state-loading">Cargando…</div>';
  pedirConCache_('disponibilidad', function () { return reservasApiGet_('disponibilidad', {}); }).then(function (datos) {
    disponibilidadUltimoFetchTs_ = Date.now();
    reservarRenderDias_(datos);
  }).catch(function (err) {
    cont.innerHTML = '<p class="state-empty">' + esc_((err && err.message) || 'No se pudo cargar la disponibilidad. Probá de nuevo.') + '</p>';
  });
}
function reservarRenderDias_(datos) {
  var cont = document.getElementById('rsvDias');
  var dias = (datos && Array.isArray(datos.dias)) ? datos.dias : [];
  if (!dias.length) {
    cont.innerHTML = '<p class="state-empty">No hay turnos disponibles en los próximos días.</p>';
    return;
  }
  cont.innerHTML = dias.map(function (d) {
    var franjas = (d.franjas || []).map(function (f) {
      return '<button class="rsv-turno-btn" data-rsv-fecha="' + esc_(d.fecha) + '" data-rsv-inicio="' + esc_(f.inicio) + '" data-rsv-fin="' + esc_(f.fin) + '">' +
        '<span class="rsv-turno-hora">' + esc_(f.inicio) + ' - ' + esc_(f.fin) + '</span>' +
        '<span class="rsv-turno-cupo">' + f.disponibles + (f.disponibles === 1 ? ' turno disponible' : ' turnos disponibles') + '</span>' +
      '</button>';
    }).join('');
    return '<div class="rsv-dia-block">' +
      '<div class="rsv-dia-label">' + esc_(d.diaSemana) + ' ' + esc_(formatearFechaLarga_(d.fecha)) + '</div>' +
      '<div class="rsv-turno-list">' + franjas + '</div>' +
    '</div>';
  }).join('');
}
document.addEventListener('click', function (e) {
  var el = e.target.closest('#rsvDias [data-rsv-fecha]');
  if (!el || reservaEnvioEnCurso_) return;
  var fecha = el.getAttribute('data-rsv-fecha');
  var horarioInicio = el.getAttribute('data-rsv-inicio');
  var horarioFin = el.getAttribute('data-rsv-fin');

  // Guarda defensiva: sin esto, si reservaPartido_ (o su idPartido) se
  // perdiera por cualquier motivo entre elegir el cruce y tocar un
  // horario, "reservaPartido_.idPartido" de más abajo tiraría un
  // TypeError sin capturar ("Cannot read properties of null") -- ni
  // siquiera se armaría el pedido, y el jugador quedaría con los
  // botones deshabilitados para siempre, sin ningún mensaje. Acá se
  // corta ANTES de eso: se avisa y se manda de nuevo al paso de elegir
  // cruce (nunca se llega a mandar un pedido con datos incompletos).
  if (!reservaPartido_ || !reservaPartido_.idPartido) {
    reservarIrAPaso_('cruce');
    document.getElementById('rsvCruces').innerHTML =
      '<p class="state-empty">Se perdió la selección del cruce. Elegilo de nuevo.</p>';
    return;
  }

  reservaEnvioEnCurso_ = true;

  // Feedback inmediato al tocar: sin esto, mientras retenerTurno está en
  // vuelo (puede tardar varios segundos contra el backend real) la
  // pantalla se queda exactamente igual y da la sensación de que el toque
  // no hizo nada -- especialmente confuso si el pedido termina fallando
  // (por ejemplo por lentitud del backend), porque no había ninguna señal
  // de que algo se había disparado en primer lugar.
  var botonesTurno = document.querySelectorAll('#rsvDias .rsv-turno-btn');
  botonesTurno.forEach(function (b) { b.disabled = true; });
  el.classList.add('rsv-turno-en-vuelo');
  var horaSpan = el.querySelector('.rsv-turno-hora');
  var horaTextoOriginal = horaSpan ? horaSpan.textContent : '';
  if (horaSpan) horaSpan.textContent = 'Reservando…';

  reservasApiPost_('retenerTurno', {
    idPartido: reservaPartido_.idPartido, fecha: fecha, horarioInicio: horarioInicio, horarioFin: horarioFin,
  }).then(function (datos) {
    reservaEnvioEnCurso_ = false;
    reservaRetencion_ = datos;
    reservarIniciarCountdown_(datos.minutos);
    reservarPintarResumenCheckout_();
    reservarIrAPaso_('checkout');
  }).catch(function (err) {
    reservaEnvioEnCurso_ = false;
    botonesTurno.forEach(function (b) { b.disabled = false; });
    el.classList.remove('rsv-turno-en-vuelo');
    if (horaSpan) horaSpan.textContent = horaTextoOriginal;
    // BUG real encontrado acá: antes, esta rama pintaba el mensaje de
    // error y en la misma respiración llamaba a reservarCargarDisponibilidad_(),
    // que -- como el caché ya se había borrado -- pisaba ese mismo
    // innerHTML con "Cargando…" de forma SINCRÓNICA, en el mismo tick.
    // El navegador nunca llegaba a pintar el error: el jugador solo veía
    // un parpadeo y la lista de turnos de vuelta, como si el toque no
    // hubiera hecho nada (y si volvía a tocar, se repetía igual). Ahora
    // el error queda visible de verdad, y el refresco de disponibilidad
    // pasa en segundo plano (silencioso, sin pisar lo que se está
    // mostrando) para que la próxima vez que se entre a este paso el
    // cupo ya esté actualizado.
    document.getElementById('rsvDias').innerHTML =
      '<p class="state-empty">' + esc_((err && err.message) || 'No se pudo retener ese turno. Probá de nuevo.') + '</p>';
    delete cache_.disponibilidad;
    pedirSinDuplicarEnVuelo_('disponibilidad', function () { return reservasApiGet_('disponibilidad', {}); }).then(function (datos) { disponibilidadUltimoFetchTs_ = Date.now(); cache_.disponibilidad = datos; }).catch(function () { /* si falla, se vuelve a pedir sola la próxima vez que haga falta */ });
  });
});

// ---------- Paso 4: checkout ----------
function reservarIniciarCountdown_(minutos) {
  if (reservaCountdownTimer_) { clearInterval(reservaCountdownTimer_); reservaCountdownTimer_ = null; }
  var fin = Date.now() + minutos * 60000;
  function tick() {
    var el = document.getElementById('rsv-hold-timer');
    var restanteMs = fin - Date.now();
    if (restanteMs <= 0) {
      if (el) el.textContent = '0:00';
      clearInterval(reservaCountdownTimer_);
      reservaCountdownTimer_ = null;
      // El contador visual es solo orientativo -- el backend es quien
      // manda de verdad: si igual se llega a confirmar, confirmarReserva
      // va a rechazarlo con su propio mensaje de vencimiento. Este aviso
      // local solo evita que el jugador siga completando el formulario
      // a lo pedo.
      reservarMostrarErrorCheckout_('La retención venció. Elegí el turno nuevamente.', true);
      var btn = document.getElementById('rsvConfirmarBtn');
      if (btn) btn.disabled = true;
      return;
    }
    if (el) {
      var totalSeg = Math.ceil(restanteMs / 1000);
      var m = Math.floor(totalSeg / 60), s = totalSeg % 60;
      el.textContent = m + ':' + String(s).padStart(2, '0');
    }
  }
  tick();
  reservaCountdownTimer_ = setInterval(tick, 1000);
}
function reservarMostrarErrorCheckout_(mensaje, conAccionElegirOtro) {
  var err = document.getElementById('rsv-checkout-error');
  err.hidden = false;
  err.textContent = mensaje;
  document.getElementById('rsv-checkout-err-actions').hidden = !conAccionElegirOtro;
}
function reservarPintarResumenCheckout_() {
  document.getElementById('rsv-checkout-error').hidden = true;
  document.getElementById('rsv-checkout-err-actions').hidden = true;
  var btn = document.getElementById('rsvConfirmarBtn');
  btn.disabled = false;
  btn.textContent = 'Confirmar reserva';
  var r = reservaRetencion_;
  document.getElementById('rsv-summary').innerHTML =
    '<div class="rsv-summary-row"><span>Categoría</span><b>' + esc_(r.categoria) + '</b></div>' +
    '<div class="rsv-summary-row"><span>Cruce</span><b>' + esc_(r.parejaA) + ' vs ' + esc_(r.parejaB) + '</b></div>' +
    '<div class="rsv-summary-row"><span>Día</span><b>' + esc_(formatearFechaLarga_(r.fecha)) + '</b></div>' +
    '<div class="rsv-summary-row"><span>Horario</span><b>' + esc_(formatearHorarioSeguro_(r.horarioInicio)) + ' - ' + esc_(formatearHorarioSeguro_(r.horarioFin)) + '</b></div>';
  document.getElementById('rsvNombre').value = '';
  document.getElementById('rsvTelefono').value = '';
  document.getElementById('rsvComprobante').value = '';
  document.getElementById('rsvUploadTx').textContent = 'Subí una captura de pantalla del comprobante (JPG o PNG, máx. 5 MB)';
  reservaComprobante_ = null;
}
document.getElementById('rsvElegirOtroTurno').addEventListener('click', function () {
  if (reservaCountdownTimer_) { clearInterval(reservaCountdownTimer_); reservaCountdownTimer_ = null; }
  reservaRetencion_ = null;
  delete cache_.disponibilidad;
  document.getElementById('rsv-checkout-err-actions').hidden = true;
  reservarCargarDisponibilidad_();
  reservarIrAPaso_('turno');
});
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-rsv-back]');
  if (!el) return;
  reservarIrAPaso_(el.getAttribute('data-rsv-back'));
});
// Copia "texto" al portapapeles y muestra un texto de confirmación breve
// en el botón -- compartido entre "Copiar alias" y "Copiar código".
// textoConfirmacion es opcional (default "¡Copiado!") para poder mostrar
// un mensaje específico por botón (ej. "Alias copiado") sin duplicar
// esta función.
function copiarAlPortapapeles_(texto, btn, textoConfirmacion) {
  var original = btn.textContent;
  function marcar() { btn.textContent = textoConfirmacion || '¡Copiado!'; setTimeout(function () { btn.textContent = original; }, 1500); }
  function copiarFallback() {
    var ta = document.createElement('textarea');
    ta.value = texto;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* nada más que intentar acá */ }
    document.body.removeChild(ta);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(texto).then(marcar).catch(function () { copiarFallback(); marcar(); });
  } else {
    copiarFallback(); marcar();
  }
}
document.getElementById('rsvCopyAlias').addEventListener('click', function () {
  copiarAlPortapapeles_(ALIAS_TRANSFERENCIA_TX_, this, 'Alias copiado');
});
document.getElementById('rsvCopyCodigo').addEventListener('click', function () {
  copiarAlPortapapeles_(document.getElementById('rsv-exito-codigo').textContent, this, 'Código copiado');
});
document.getElementById('rsvComprobante').addEventListener('change', function (e) {
  var file = e.target.files && e.target.files[0];
  var tx = document.getElementById('rsvUploadTx');
  document.getElementById('rsv-checkout-error').hidden = true;
  document.getElementById('rsv-checkout-err-actions').hidden = true;
  if (!file) return;
  // El "accept" del input ya filtra en el selector de archivos, pero
  // algunos navegadores/flujos (arrastrar y soltar, cámara) lo pueden
  // saltear -- se revalida acá antes de subir nada.
  if (['image/jpeg', 'image/png'].indexOf(file.type) === -1) {
    reservarMostrarErrorCheckout_('Subí una captura en JPG o PNG (el archivo elegido es ' + (file.type || 'de otro tipo') + ').', false);
    reservaComprobante_ = null;
    e.target.value = '';
    tx.textContent = 'Subí una captura de pantalla del comprobante (JPG o PNG, máx. 5 MB)';
    return;
  }
  if (file.size > RSV_COMPROBANTE_MAX_BYTES_) {
    reservarMostrarErrorCheckout_('La imagen pesa demasiado (máximo 5 MB). Elegí otra o sacale una captura más chica.', false);
    reservaComprobante_ = null;
    e.target.value = '';
    tx.textContent = 'Subí una captura de pantalla del comprobante (JPG o PNG, máx. 5 MB)';
    return;
  }
  var lector = new FileReader();
  lector.onload = function () {
    reservaComprobante_ = { base64: lector.result, nombreArchivo: file.name, tipoMime: file.type || 'image/jpeg' };
    tx.textContent = 'Seleccionado: ' + file.name;
  };
  lector.onerror = function () {
    reservarMostrarErrorCheckout_('No se pudo leer el archivo. Probá con otra imagen.', false);
  };
  lector.readAsDataURL(file);
});
document.getElementById('rsvConfirmarBtn').addEventListener('click', function () {
  if (reservaEnvioEnCurso_) return; // evita doble click / doble envío
  document.getElementById('rsv-checkout-error').hidden = true;
  document.getElementById('rsv-checkout-err-actions').hidden = true;

  var nombre = document.getElementById('rsvNombre').value.trim();
  var telefono = document.getElementById('rsvTelefono').value.trim();
  if (!nombre || !telefono) { reservarMostrarErrorCheckout_('Completá nombre y teléfono.', false); return; }
  if (!reservaComprobante_) { reservarMostrarErrorCheckout_('Subí el comprobante de la seña antes de confirmar.', false); return; }
  if (!reservaRetencion_) { reservarMostrarErrorCheckout_('Tu retención ya no está activa. Elegí el turno de nuevo.', true); return; }

  reservaEnvioEnCurso_ = true;
  var btn = this;
  btn.disabled = true;
  btn.textContent = 'Confirmando…';

  var payloadConfirmar = {
    idRetencion: reservaRetencion_.idRetencion,
    nombre: nombre,
    telefono: telefono,
    comprobanteBase64: reservaComprobante_.base64,
    comprobanteNombreArchivo: reservaComprobante_.nombreArchivo,
    comprobanteTipoMime: reservaComprobante_.tipoMime,
  };

  confirmarReservaConReintento_(payloadConfirmar, btn).then(function (datos) {
    reservaEnvioEnCurso_ = false;
    if (reservaCountdownTimer_) { clearInterval(reservaCountdownTimer_); reservaCountdownTimer_ = null; }
    reservarPintarExito_(datos);
    reservarIrAPaso_('exito');
  }).catch(function (err) {
    reservaEnvioEnCurso_ = false;
    btn.disabled = false;
    btn.textContent = 'Confirmar reserva';
    reservarMostrarErrorCheckout_((err && err.message) || 'No se pudo confirmar la reserva. Probá de nuevo.', true);
  });
});

// Reintento automático SOLO para confirmarReserva -- es la única acción de
// escritura que el backend garantiza idempotente por idRetencion (ver
// CodigoReservasAPI.gs, mp360ReservasConfirmar_ y
// buscarReservaPorIdRetencionOrigen_): un segundo POST con el mismo
// idRetencion nunca crea una reserva duplicada, devuelve la reserva ya
// creada tal cual. Por eso acá es seguro reintentar automáticamente ante
// un fallo de ENTREGA (HTTP 404 del redirect de Apps Script -- confirmado
// en vivo esta misma investigación --, HTTP 5xx, timeout, corte de red):
// no sabemos si el intento anterior llegó a procesarse, pero reintentar
// con el MISMO idRetencion y el MISMO comprobante nunca genera una
// segunda reserva. Un error marcado respuestaDelBackend (ver
// reservasApiPost_) es una respuesta real y definitiva del servidor
// (retención vencida, cupo ocupado, datos inválidos) -- ESO nunca se
// reintenta solo, se muestra tal cual.
// retenerTurno_ (elegir un turno) NO tiene este mismo reintento: no es
// idempotente todavía, así que reintentarlo a ciegas podría generar dos
// retenciones para el mismo turno. Si algún día hace falta, necesitaría
// su propio diseño de idempotencia en el backend, igual que este.
var RSV_CONFIRMAR_REINTENTOS_MS_ = [2000, 4000];
function confirmarReservaConReintento_(payload, btn) {
  function intentar(numIntento) {
    return reservasApiPost_('confirmarReserva', payload).catch(function (err) {
      if (err && err.respuestaDelBackend) throw err;
      if (numIntento >= RSV_CONFIRMAR_REINTENTOS_MS_.length) throw err;
      btn.textContent = 'Reintentando…';
      return new Promise(function (resolve) {
        setTimeout(resolve, RSV_CONFIRMAR_REINTENTOS_MS_[numIntento]);
      }).then(function () { return intentar(numIntento + 1); });
    });
  }
  return intentar(0);
}

// ---------- Paso final: éxito ----------
var WHATSAPP_NUMERO_ADMIN_ = '5493516234487';
// El mensaje va prearmado en la URL de wa.me -- WhatsApp lo abre listo
// para tocar enviar, nunca lo manda solo (así lo pidieron a propósito:
// le sirve al jugador para tener el código guardado en su propio chat, y
// al organizador le llega el aviso, pero SIEMPRE es el jugador quien
// decide tocar "Enviar" del lado de WhatsApp).
function construirMensajeWhatsapp_(datos) {
  return '🎾 Reserva Liga Master Pádel 360\n\n' +
    'Estado: Pendiente de aprobación\n' +
    'Categoría: ' + datos.categoria + '\n' +
    'Partido: ' + datos.parejaA + ' vs ' + datos.parejaB + '\n' +
    'Fecha: ' + formatearFechaLarga_(datos.fecha) + '\n' +
    'Horario: ' + formatearHorarioSeguro_(datos.horarioInicio) + ' - ' + formatearHorarioSeguro_(datos.horarioFin) + '\n' +
    'Seña enviada: $9.000\n' +
    'Código de reserva: ' + datos.codigoReserva + '\n\n' +
    'Quedo a la espera de confirmación.';
}

function reservarPintarExito_(datos) {
  document.getElementById('rsv-exito-resumen').innerHTML =
    '<div class="rsv-summary-row"><span>Categoría</span><b>' + esc_(datos.categoria) + '</b></div>' +
    '<div class="rsv-summary-row"><span>Cruce</span><b>' + esc_(datos.parejaA) + ' vs ' + esc_(datos.parejaB) + '</b></div>' +
    '<div class="rsv-summary-row"><span>Fecha</span><b>' + esc_(formatearFechaLarga_(datos.fecha)) + '</b></div>' +
    '<div class="rsv-summary-row"><span>Horario</span><b>' + esc_(formatearHorarioSeguro_(datos.horarioInicio)) + ' - ' + esc_(formatearHorarioSeguro_(datos.horarioFin)) + '</b></div>' +
    (datos.cancha ? '<div class="rsv-summary-row"><span>Cancha</span><b>Cancha ' + esc_(datos.cancha) + '</b></div>' : '') +
    '<div class="rsv-summary-row"><span>Seña pagada</span><b>' + formatearMonto_(datos.montoPagado) + '</b></div>' +
    '<div class="rsv-summary-row"><span>Saldo pendiente</span><b>' + formatearMonto_(datos.saldoPendiente) + '</b></div>' +
    // El backend siempre devuelve PENDIENTE_APROBACION acá (confirmarReserva
    // nunca deja una reserva RESERVADA de una) -- se muestra igual como dato
    // explícito, con el mismo texto amigable que ya usa reservarPintarGestion_,
    // para que quede clarísimo que todavía falta la aprobación del organizador.
    '<div class="rsv-summary-row"><span>Estado</span><b>' + esc_(RSV_ESTADO_RESERVA_TX_[datos.estadoReserva] || datos.estadoReserva) + '</b></div>';
  document.getElementById('rsv-exito-codigo').textContent = datos.codigoReserva || '';
  var link = document.getElementById('rsvGestionarLink');
  link.href = location.pathname + '?token=' + encodeURIComponent(datos.tokenGestion);
  var linkWa = document.getElementById('rsvWhatsappLink');
  linkWa.href = 'https://wa.me/' + WHATSAPP_NUMERO_ADMIN_ + '?text=' + encodeURIComponent(construirMensajeWhatsapp_(datos));

  // La disponibilidad y la lista de cruces de esta categoría acaban de
  // cambiar de verdad (este turno ya no está libre) -- se invalida el
  // caché para que, si el jugador reserva otro turno en la misma
  // sesión, no vea un cupo/cruce que ya no existe (la próxima carga pide
  // datos frescos; retenerTurno_ igual revalida todo server-side pase lo
  // que pase acá).
  delete cache_.disponibilidad;
  delete cache_['cruces|' + datos.categoria];

  // La retención ya se usó -- se limpia todo el estado del wizard para
  // que la próxima vez que entren a "Reservar turno" arranque de cero.
  reservaCategoria_ = null;
  reservaPartido_ = null;
  reservaRetencion_ = null;
  reservaComprobante_ = null;
}
// "Volver a Reservas": el estado del wizard ya quedó limpio arriba, en
// reservarPintarExito_, apenas se pintó esta pantalla -- acá solo hace
// falta volver a mostrar el paso 1 (categoría) y repintar sus chips.
// A propósito NO se usa irA('reservar') ni cargarPantalla_ (eso
// dispararía calentarReservasApi_ de nuevo) -- ya estamos adentro de
// screen-reservar, así que alcanza con cambiar de paso, sin ningún
// pedido de red.
document.getElementById('rsvVolverAReservar').addEventListener('click', function () {
  reservaCruces_ = [];
  reservarRenderCategorias_();
  reservarIrAPaso_('categoria');
});

// ============================================================
// Gestión de reserva vía ?token=... (link privado de cancelación)
// ============================================================
function reservaGestionToken_() {
  try { return new URLSearchParams(location.search).get('token'); } catch (e) { return null; }
}
function cargarReservaGestion_(token) {
  var cont = document.getElementById('rsvGestionContenido');
  cont.innerHTML = '<div class="state-loading">Cargando…</div>';
  reservasApiGet_('consultarReserva', { token: token }).then(function (r) {
    reservarPintarGestion_(r, token);
  }).catch(function (err) {
    cont.innerHTML = '<p class="state-empty">' + esc_((err && err.message) || 'No se encontró esa reserva.') + '</p>';
  });
}
var RSV_ESTADO_RESERVA_TX_ = {
  PENDIENTE_APROBACION: 'Pendiente de aprobación',
  RESERVADO: 'Reservado',
  RECHAZADO: 'Rechazado',
  CANCELADO: 'Cancelado',
  FINALIZADO: 'Finalizado',
};
var RSV_ESTADO_PAGO_TX_ = { SALDO_PENDIENTE: 'Falta saldo', PAGO_COMPLETO: 'Pago completo' };
function reservarPintarGestion_(r, token) {
  var cont = document.getElementById('rsvGestionContenido');
  var estado = r.estadoReserva;

  // Tres formas distintas de mostrar la plata, según el estado -- nunca
  // se muestra "falta saldo"/"saldo pendiente" salvo en RESERVADO o
  // FINALIZADO (los únicos donde ese dato sigue siendo información real
  // y accionable; en cualquier otro estado el turno ya no se juega, así
  // que "cuánto falta pagar" deja de tener sentido y solo confunde).
  var filasPago;
  var notaEstado = '';
  if (estado === 'CANCELADO') {
    // El jugador canceló algo que ya estaba aprobado: la seña se pierde,
    // eso sí es un hecho firme.
    filasPago = '<div class="rsv-summary-row"><span>Seña pagada</span><b>' + formatearMonto_(r.montoPagado) + ' (no reembolsable)</b></div>';
  } else if (estado === 'PENDIENTE_APROBACION') {
    // Todavía no se decidió nada -- se muestra la seña como un hecho
    // neutral (se pagó), sin afirmar si se devuelve o no.
    filasPago = '<div class="rsv-summary-row"><span>Seña pagada</span><b>' + formatearMonto_(r.montoPagado) + '</b></div>';
    notaEstado = '<p class="rsv-pendiente-note">Tu solicitud está pendiente de aprobación. Te vamos a confirmar por WhatsApp apenas el organizador la revise.</p>';
  } else if (estado === 'RECHAZADO') {
    // A propósito NO se afirma "no reembolsable" acá: un rechazo puede
    // deberse a muchos motivos (comprobante ilegible, datos que no
    // coinciden, etc.) y la devolución de la seña es una conversación
    // aparte con el organizador, no algo que la web deba dar por hecho.
    filasPago = '<div class="rsv-summary-row"><span>Seña pagada</span><b>' + formatearMonto_(r.montoPagado) + '</b></div>';
    notaEstado = '<p class="rsv-pendiente-note">Esta solicitud fue rechazada. El horario ya está disponible nuevamente. Si tenés dudas sobre tu seña, contactanos por WhatsApp.</p>';
  } else {
    // RESERVADO o FINALIZADO: acá sí importa cuánto falta pagar.
    filasPago = '<div class="rsv-summary-row"><span>Pago</span><b>' + esc_(RSV_ESTADO_PAGO_TX_[r.estadoPago] || r.estadoPago) + '</b></div>' +
      '<div class="rsv-summary-row"><span>Pagado</span><b>' + formatearMonto_(r.montoPagado) + '</b></div>' +
      '<div class="rsv-summary-row"><span>Saldo pendiente</span><b>' + formatearMonto_(r.saldoPendiente) + '</b></div>';
  }

  var html = notaEstado +
    '<div class="rsv-summary">' +
      '<div class="rsv-summary-row"><span>Categoría</span><b>' + esc_(r.categoria) + '</b></div>' +
      '<div class="rsv-summary-row"><span>Cruce</span><b>' + esc_(r.parejaA) + ' vs ' + esc_(r.parejaB) + '</b></div>' +
      '<div class="rsv-summary-row"><span>Fecha</span><b>' + esc_(formatearFechaLarga_(r.fecha)) + '</b></div>' +
      '<div class="rsv-summary-row"><span>Horario</span><b>' + esc_(formatearHorarioSeguro_(r.horarioInicio)) + ' - ' + esc_(formatearHorarioSeguro_(r.horarioFin)) + '</b></div>' +
      '<div class="rsv-summary-row"><span>Estado</span><b>' + esc_(RSV_ESTADO_RESERVA_TX_[estado] || estado) + '</b></div>' +
      filasPago +
    '</div>';
  // Cancelar: SOLO disponible para RESERVADO -- lista blanca a propósito
  // (mismo criterio que el backend en mp360ReservasCancelar_), para que
  // un estado nuevo el día de mañana no quede cancelable por accidente.
  if (r.estadoReserva === 'RESERVADO') {
    html +=
      '<div id="rsv-cancel-zone">' +
        '<button class="back-row" id="rsvPedirCancelar" style="color:var(--warn)">Cancelar este turno</button>' +
        '<div id="rsv-cancel-confirm" hidden>' +
          '<p class="rsv-warn-text">Al cancelar el turno, la seña de $9.000 no es reembolsable y el horario volverá a quedar disponible.</p>' +
          '<div class="rsv-cancel-actions">' +
            '<button class="rsv-btn-ghost" id="rsvCancelarNo" type="button">No, mantener</button>' +
            '<button class="rsv-btn-danger" id="rsvCancelarSi" type="button">Sí, cancelar turno</button>' +
          '</div>' +
          '<p class="rsv-error" id="rsv-cancel-error" hidden></p>' +
        '</div>' +
      '</div>';
  }
  cont.innerHTML = html;
  if (r.estadoReserva !== 'RESERVADO') return;

  document.getElementById('rsvPedirCancelar').addEventListener('click', function () {
    document.getElementById('rsv-cancel-confirm').hidden = false;
    this.hidden = true;
  });
  document.getElementById('rsvCancelarNo').addEventListener('click', function () {
    document.getElementById('rsv-cancel-confirm').hidden = true;
    document.getElementById('rsvPedirCancelar').hidden = false;
  });
  document.getElementById('rsvCancelarSi').addEventListener('click', function () {
    if (reservaEnvioEnCurso_) return;
    reservaEnvioEnCurso_ = true;
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Cancelando…';
    reservasApiPost_('cancelarReserva', { token: token }).then(function () {
      reservaEnvioEnCurso_ = false;
      // El horario y el cruce quedan libres de nuevo -- mismo motivo que
      // en reservarPintarExito_.
      delete cache_.disponibilidad;
      delete cache_['cruces|' + r.categoria];
      cargarReservaGestion_(token);
    }).catch(function (err) {
      reservaEnvioEnCurso_ = false;
      btn.disabled = false;
      btn.textContent = 'Sí, cancelar turno';
      var errEl = document.getElementById('rsv-cancel-error');
      errEl.hidden = false;
      errEl.textContent = (err && err.message) || 'No se pudo cancelar. Probá de nuevo.';
    });
  });
}

// ============================================================
// Buscar mi reserva (teléfono + código, sin el link privado)
// ============================================================
// V1: para cuando el jugador cerró la app y no guardó el link de
// "Gestionar mi reserva". Requiere los DOS datos -- el backend
// (mp360ReservasBuscarPorTelefono_) ya rechaza si falta cualquiera de
// los dos o si no coinciden en la misma reserva.
function buscarReservaResetForm_() {
  document.getElementById('buscarTelefono').value = '';
  document.getElementById('buscarCodigo').value = '';
  document.getElementById('buscar-reserva-error').hidden = true;
  var btn = document.getElementById('buscarReservaBtn');
  btn.disabled = false;
  btn.textContent = 'Buscar mi reserva';
}
document.getElementById('buscarReservaBtn').addEventListener('click', function () {
  if (reservaEnvioEnCurso_) return; // evita doble click
  var err = document.getElementById('buscar-reserva-error');
  err.hidden = true;

  var telefono = document.getElementById('buscarTelefono').value.trim();
  var codigo = document.getElementById('buscarCodigo').value.trim();
  if (!telefono || !codigo) {
    err.hidden = false;
    err.textContent = 'Ingresá el teléfono y el código de tu reserva.';
    return;
  }

  reservaEnvioEnCurso_ = true;
  var btn = this;
  btn.disabled = true;
  btn.textContent = 'Buscando…';

  reservasApiPost_('buscarReserva', { telefono: telefono, codigo: codigo }).then(function (datos) {
    reservaEnvioEnCurso_ = false;
    buscarReservaResetForm_();
    // Deja el link bookmarkeable/recargable sin volver a pedir nada --
    // no dispara ninguna navegación real, solo actualiza la barra de
    // direcciones (reservarPintarGestion_ ya pinta todo client-side).
    try { history.replaceState(null, '', location.pathname + '?token=' + encodeURIComponent(datos.tokenGestion)); } catch (e) { /* no crítico si el navegador lo bloquea */ }
    irA('reserva-gestion');
    reservarPintarGestion_(datos, datos.tokenGestion);
  }).catch(function (e) {
    reservaEnvioEnCurso_ = false;
    btn.disabled = false;
    btn.textContent = 'Buscar mi reserva';
    err.hidden = false;
    err.textContent = (e && e.message) || 'No se pudo buscar la reserva. Probá de nuevo.';
  });
});

// ============================================================
// Acceso general a la liga (contraseña compartida a toda la web)
// =======================================================================
// El HTML crudo muestra #access-gate y deja #app oculto por defecto --
// así nunca hay un parpadeo mostrando contenido protegido antes de que
// este script decida si hace falta pedir la contraseña. El backend
// (verificarAcceso/validarTokenAcceso, ver CodigoReservasAPI.gs) es el
// que de verdad conoce la contraseña -- acá nunca se guarda ni se
// compara contra un valor fijo en el código, solo se guarda el TOKEN que
// devuelve el servidor cuando acierta.
// ============================================================
var LS_ACCESO_ = 'mp360_acceso';
function leerAccesoGuardado_() {
  try {
    var raw = localStorage.getItem(LS_ACCESO_);
    if (!raw) return null;
    var datos = JSON.parse(raw);
    return (datos && datos.token && datos.version) ? datos : null;
  } catch (e) { return null; }
}
function guardarAcceso_(token, version) {
  try { localStorage.setItem(LS_ACCESO_, JSON.stringify({ token: token, version: version })); } catch (e) { /* sin storage no rompe nada -- solo vuelve a pedir la próxima vez */ }
}
function borrarAcceso_() {
  try { localStorage.removeItem(LS_ACCESO_); } catch (e) { /* nada que borrar si no hay storage */ }
}

document.getElementById('accesoBtn').addEventListener('click', function () {
  var err = document.getElementById('access-error');
  err.hidden = true;
  var clave = document.getElementById('accesoClave').value;
  if (!clave) { err.hidden = false; err.textContent = 'Ingresá la contraseña.'; return; }

  var btn = this;
  btn.disabled = true;
  btn.textContent = 'Verificando…';
  reservasApiPost_('verificarAcceso', { clave: clave }).then(function (r) {
    btn.disabled = false;
    btn.textContent = 'ENTRAR A LA LIGA';
    guardarAcceso_(r.token, r.version);
    document.getElementById('access-gate').hidden = true;
    document.getElementById('app').hidden = false;
    // true = saltar la revalidación: el token que acabamos de guardar lo
    // emitió el servidor hace un instante, contra la contraseña que el
    // jugador tipeó recién -- no puede estar desactualizado todavía, así
    // que volver a pedirle al servidor que lo revalide (validarTokenAcceso)
    // acá sería un pedido de red 100% redundante compitiendo por cuota con
    // el bootstrap real que arranca a continuación.
    arrancarRuteoInicial_(true);
  }).catch(function (e) {
    btn.disabled = false;
    btn.textContent = 'ENTRAR A LA LIGA';
    err.hidden = false;
    err.textContent = (e && e.message) || 'No se pudo verificar el acceso. Probá de nuevo.';
  });
});
document.getElementById('accesoClave').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('accesoBtn').click();
});

// ============================================================
// Panel admin: reservas pendientes (solo vía ?admin=1, sin link en
// ningún menú). Contraseña separada de la general -- se guarda en
// sessionStorage (se borra sola al cerrar la pestaña, a propósito: es
// más sensible que el acceso general, así que no conviene que quede
// guardada indefinidamente como la otra).
// ============================================================
var SS_ADMIN_CLAVE_ = 'mp360_admin_clave';
function leerClaveAdminGuardada_() {
  try { return sessionStorage.getItem(SS_ADMIN_CLAVE_) || ''; } catch (e) { return ''; }
}
function guardarClaveAdmin_(clave) {
  try { sessionStorage.setItem(SS_ADMIN_CLAVE_, clave); } catch (e) { /* si no se puede guardar, vuelve a pedir la clave dentro de esta misma sesión */ }
}
function esRutaAdmin_() {
  try { return new URLSearchParams(location.search).get('admin') === '1'; } catch (e) { return false; }
}

function mostrarPanelAdmin_() {
  irA('admin-reservas');
  var claveGuardada = leerClaveAdminGuardada_();
  if (claveGuardada) {
    document.getElementById('admin-gate').hidden = true;
    document.getElementById('admin-panel').hidden = false;
    adminCargarPendientes_(claveGuardada);
  } else {
    document.getElementById('admin-gate').hidden = false;
    document.getElementById('admin-panel').hidden = true;
  }
}
function adminCargarPendientes_(clave, alTerminar) {
  var cont = document.getElementById('adminPendientesLista');
  cont.innerHTML = '<div class="state-loading">Cargando…</div>';
  reservasApiPost_('listarPendientes', { clave: clave }).then(function (lista) {
    if (alTerminar) alTerminar(true);
    adminRenderPendientes_(lista);
  }).catch(function (e) {
    if (alTerminar) { alTerminar(false); return; } // el gate ya muestra el error -- no pisar el panel
    cont.innerHTML = '<p class="state-empty">' + esc_((e && e.message) || 'No se pudo cargar la lista.') + '</p>';
  });
}
function adminRenderPendientes_(lista) {
  var cont = document.getElementById('adminPendientesLista');
  if (!lista.length) {
    cont.innerHTML = '<p class="state-empty">No hay reservas pendientes de aprobación por ahora.</p>';
    return;
  }
  cont.innerHTML = lista.map(function (r) {
    return '<div class="admin-card" data-admin-card="' + esc_(r.idReserva) + '">' +
      '<div class="admin-card-row"><span>Categoría</span><b>' + esc_(r.categoria) + '</b></div>' +
      '<div class="admin-card-row"><span>Cruce</span><b>' + esc_(r.parejaA) + ' vs ' + esc_(r.parejaB) + '</b></div>' +
      '<div class="admin-card-row"><span>Fecha</span><b>' + esc_(formatearFechaLarga_(r.fecha)) + '</b></div>' +
      '<div class="admin-card-row"><span>Horario</span><b>' + esc_(formatearHorarioSeguro_(r.horarioInicio)) + ' - ' + esc_(formatearHorarioSeguro_(r.horarioFin)) + '</b></div>' +
      '<div class="admin-card-row"><span>Cancha</span><b>' + (r.cancha ? 'Cancha ' + esc_(r.cancha) : '—') + '</b></div>' +
      '<div class="admin-card-row"><span>Nombre</span><b>' + esc_(r.nombreSolicitante) + '</b></div>' +
      '<div class="admin-card-row"><span>Teléfono</span><b>' + esc_(r.telefonoSolicitante) + '</b></div>' +
      '<div class="admin-card-row"><span>Monto</span><b>' + formatearMonto_(r.montoPagado) + '</b></div>' +
      '<div class="admin-card-row"><span>Código</span><b>' + esc_(r.codigoReserva) + '</b></div>' +
      (r.comprobanteUrl
        ? '<a class="admin-comprobante-link" href="' + esc_(r.comprobanteUrl) + '" target="_blank" rel="noopener">Ver comprobante</a>'
        : '<span class="hint-line">Sin comprobante</span>') +
      '<p class="rsv-error" id="admin-error-' + esc_(r.idReserva) + '" hidden></p>' +
      '<div class="admin-card-actions">' +
        '<button class="rsv-btn-ghost" data-admin-rechazar="' + esc_(r.idReserva) + '" type="button">Rechazar</button>' +
        '<button class="rsv-btn-aprobar" data-admin-aprobar="' + esc_(r.idReserva) + '" type="button">Aprobar</button>' +
      '</div>' +
    '</div>';
  }).join('');
}
document.getElementById('adminEntrarBtn').addEventListener('click', function () {
  var err = document.getElementById('admin-gate-error');
  err.hidden = true;
  var clave = document.getElementById('adminClave').value;
  if (!clave) { err.hidden = false; err.textContent = 'Ingresá la contraseña de administrador.'; return; }

  var btn = this;
  btn.disabled = true;
  btn.textContent = 'Entrando…';
  adminCargarPendientes_(clave, function (ok) {
    btn.disabled = false;
    btn.textContent = 'Entrar';
    if (ok) {
      guardarClaveAdmin_(clave);
      document.getElementById('admin-gate').hidden = true;
      document.getElementById('admin-panel').hidden = false;
    } else {
      err.hidden = false;
      err.textContent = 'Contraseña incorrecta.';
    }
  });
});
document.getElementById('adminClave').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('adminEntrarBtn').click();
});
document.getElementById('adminRefrescarBtn').addEventListener('click', function () {
  adminCargarPendientes_(leerClaveAdminGuardada_());
});
// Aprobar/rechazar: deshabilita TODOS los botones de esa tarjeta mientras
// procesa (evita doble click) y, si sale bien, saca la tarjeta de la
// lista -- ya dejó de estar pendiente, no hace falta refrescar todo.
var adminProcesando_ = {};
document.addEventListener('click', function (e) {
  var elAprobar = e.target.closest('[data-admin-aprobar]');
  var elRechazar = e.target.closest('[data-admin-rechazar]');
  var el = elAprobar || elRechazar;
  if (!el) return;
  var idReserva = el.getAttribute(elAprobar ? 'data-admin-aprobar' : 'data-admin-rechazar');
  if (adminProcesando_[idReserva]) return;
  adminProcesando_[idReserva] = true;

  var accion = elAprobar ? 'aprobarReserva' : 'rechazarReserva';
  var card = el.closest('.admin-card');
  var errEl = document.getElementById('admin-error-' + idReserva);
  if (errEl) errEl.hidden = true;
  if (card) card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
  el.textContent = elAprobar ? 'Aprobando…' : 'Rechazando…';

  reservasApiPost_(accion, { clave: leerClaveAdminGuardada_(), idReserva: idReserva }).then(function () {
    delete adminProcesando_[idReserva];
    if (card) card.remove();
    var lista = document.getElementById('adminPendientesLista');
    if (lista && !lista.querySelector('.admin-card')) {
      lista.innerHTML = '<p class="state-empty">No hay reservas pendientes de aprobación por ahora.</p>';
    }
  }).catch(function (err) {
    delete adminProcesando_[idReserva];
    if (card) card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
    el.textContent = elAprobar ? 'Aprobar' : 'Rechazar';
    if (errEl) { errEl.hidden = false; errEl.textContent = (err && err.message) || 'No se pudo procesar. Probá de nuevo.'; }
  });
});

// ============================================================
// Arranque
// ============================================================
// Primero decide si hace falta pedir la contraseña general -- recién
// después de eso arranca cualquier otra cosa (ruteo admin o la app
// normal). Un acceso ya guardado entra directo, sin red: la validación
// contra el servidor pasa en segundo plano, sin bloquear nada (ver
// arrancarRuteoInicial_).
window.addEventListener('DOMContentLoaded', function () {
  var guardado = leerAccesoGuardado_();
  if (guardado) {
    document.getElementById('access-gate').hidden = true;
    document.getElementById('app').hidden = false;
    arrancarRuteoInicial_();
  }
  // Si no hay acceso guardado, no hace falta hacer nada más acá: el
  // gate ya es lo único visible por defecto en el HTML crudo.
});

// saltarRevalidacion: true cuando se llega acá desde un login recién
// verificado (el token no puede estar desactualizado todavía -- ver el
// handler de accesoBtn). Sin este parámetro (el caso normal: acceso ya
// guardado de una visita anterior, revalidado en DOMContentLoaded), sí
// se revalida en segundo plano por si la contraseña general cambió
// desde entonces.
function arrancarRuteoInicial_(saltarRevalidacion) {
  var guardado = leerAccesoGuardado_();
  if (guardado && !saltarRevalidacion) {
    // Revalidación silenciosa en segundo plano: si la contraseña general
    // cambió desde que se guardó este acceso, no interrumpe la sesión
    // actual, pero deja de estar guardado para la próxima vez que abra
    // la web (ver obtenerVersionAccesoLiga_ en el backend).
    reservasApiPost_('validarTokenAcceso', { token: guardado.token, version: guardado.version }).then(function (r) {
      if (!r || !r.valido) borrarAcceso_();
    }).catch(function () { /* si falla la red no se toca nada -- no hay motivo para desconfiar */ });
  }
  if (esRutaAdmin_()) {
    mostrarPanelAdmin_();
    return;
  }
  arrancarApp_();
}

function arrancarApp_() {
  var tokenGestion = reservaGestionToken_();

  // La gestión de una reserva (link privado ?token=...) es independiente
  // del bootstrap deportivo de abajo (CATEGORIAS/novedades/sponsors, que
  // vive en API_URL / CodigoWebApp.gs): solo necesita la Reservas API. Se
  // muestra YA, sin esperar a que ese bootstrap resuelva -- si esperara,
  // un bootstrap lento (la latencia real de Apps Script puede ser de
  // varios segundos) o caído dejaría al jugador viendo Inicio en vez de
  // su reserva, aunque el token sea perfectamente válido. Esto es lo que
  // causaba el bug: la pantalla de gestión quedaba tapada por Inicio
  // (visible por HTML mientras no se llame a irA()) hasta que bootstrap
  // terminara, y si fallaba, no aparecía nunca.
  if (tokenGestion) {
    irA('reserva-gestion');
    cargarReservaGestion_(tokenGestion);
  }

  // Precarga en segundo plano de datos que NO dependen de categoría ni
  // del bootstrap deportivo -- "mas" (Playoffs/Reglamento/Premios) y la
  // disponibilidad de la Reservas API. Arrancan YA, en paralelo con todo
  // lo demás, así que cuando el jugador toca "Más" o "Reservar turno" lo
  // más probable es que ya estén resueltas (pedirConCache_ evita el
  // pedido duplicado si la pantalla real se abre antes de que termine).
  pedirConCache_('mas', function () { return apiFetch('mas'); }).catch(function () { /* cargarMas_ la pide de nuevo si hace falta */ });
  pedirConCache_('disponibilidad', function () { return reservasApiGet_('disponibilidad', {}); }).then(function () { disponibilidadUltimoFetchTs_ = Date.now(); }).catch(function () { /* reservarCargarDisponibilidad_ la pide de nuevo si hace falta */ });

  // Arranca ya (no hace falta esperar el bootstrap): mientras el jugador
  // tenga la app abierta y a la vista, mantiene tibios los dos backends
  // para que la próxima acción real no le toque pagar un arranque en frío.
  iniciarKeepAlive_();

  // Pintado inmediato del selector de categoría con la última lista
  // conocida (localStorage, ver leerCategoriasCache_) mientras el
  // bootstrap real todavía viaja -- así el selector no se queda vacío
  // varios segundos en cada visita. Es solo un adelanto visual: el
  // apiFetch('bootstrap') de abajo sigue siendo la fuente de verdad y
  // pisa esto apenas responde (misma lógica de siempre, sin cambios).
  var categoriasCacheadas = leerCategoriasCache_();
  if (categoriasCacheadas && categoriasCacheadas.length) {
    CATEGORIAS = categoriasCacheadas;
    var guardadaCache = leerCategoriaGuardada_();
    categoriaActual = (guardadaCache && CATEGORIAS.indexOf(guardadaCache) !== -1) ? guardadaCache : null;
    actualizarSelectorInicio_();
    precargarPantallasCategoria_(categoriaActual);
  }

  apiFetch('bootstrap').then(function (boot) {
  boot = boot || {};
  CATEGORIAS = Array.isArray(boot.categorias) ? boot.categorias.filter(Boolean) : [];
  guardarCategoriasCache_(CATEGORIAS);

  // Categoría guardada de una visita anterior: solo se respeta si sigue
  // existiendo en CATEGORIAS (la fuente de verdad real del backend).
  var guardada = leerCategoriaGuardada_();
  if (guardada && CATEGORIAS.indexOf(guardada) !== -1) {
    categoriaActual = guardada;
  } else {
    if (guardada) borrarCategoriaGuardada_();
    categoriaActual = null;
  }

  // El selector de categoría se pinta siempre, sin importar si el resto
  // del contenido de Inicio (novedades, sponsors, banner) falla.
  actualizarSelectorInicio_();

  // Si ya había una categoría válida guardada, arrancamos a precargar
  // Posiciones/Fixture/Resultados en segundo plano (no-op si no hay
  // categoría: precargarPantallasCategoria_ corta sola).
  precargarPantallasCategoria_(categoriaActual);

  try {
    renderInicio_(boot.inicio || {});
  } catch (e) {
    console.error('No se pudo pintar el contenido dinámico de Inicio:', e);
  }
  cargarFotosInicio_();

  // Si había un token de gestión, la pantalla de esa reserva ya se
  // mostró arriba, antes de este bootstrap -- acá NO hay que pisarla
  // volviendo a Inicio. Este bootstrap solo dejó CATEGORIAS/novedades
  // listas por si el jugador navega a otra pantalla después.
  if (!tokenGestion) irA('inicio');
  }).catch(function (err) {
    // Mismo cuidado acá: si había token, la pantalla de gestión ya está
    // mostrada y no depende de este bootstrap -- no hay que reemplazar
    // Inicio por un error que ni siquiera se está mostrando.
    if (!tokenGestion) {
      document.getElementById('screen-inicio').innerHTML =
        '<p class="state-empty">No se pudo conectar con el servidor. Si esto persiste, revisá API_URL en app.js.</p>';
    }
    console.error(err);
  });
}
