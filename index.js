const express = require('express');
const app = express();

// ---------------------------------------------------------------------------
// Variables de entorno — configurar en Railway > Variables
// ---------------------------------------------------------------------------
const XTREAM_SERVER  = process.env.XTREAM_SERVER;
const XTREAM_USER    = process.env.XTREAM_USER;
const XTREAM_PASS    = process.env.XTREAM_PASS;
const TMDB_API_KEY   = process.env.TMDB_API_KEY;
const TMDB_READ_TOKEN = process.env.TMDB_READ_TOKEN;
const PORT           = process.env.PORT || 3000;

// Validar variables obligatorias al arrancar
const REQUIRED_VARS = { XTREAM_SERVER, XTREAM_USER, XTREAM_PASS, TMDB_READ_TOKEN };
for (const [k, v] of Object.entries(REQUIRED_VARS)) {
    if (!v) { console.error(`[boot] ERROR: variable de entorno ${k} no definida`); process.exit(1); }
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use((req, res, next) => {
    console.log(`[req] ${req.method} ${req.originalUrl}`);
    next();
});

// ---------------------------------------------------------------------------
// Normalización de texto para matching
// ---------------------------------------------------------------------------
function normalize(str) {
    if (!str) return '';
    return str
        .toLowerCase()
        .normalize('NFD')                        // descompone acentos
        .replace(/[\u0300-\u036f]/g, '')         // elimina diacríticos (á→a, ü→u)
        .replace(/ñ/g, 'n')                      // ñ → n (antes de NFD)
        .replace(/[:"'¡!¿?.,()\[\]{}/\\|@#$%^&*+=<>~`]/g, ' ') // signos → espacio
        .replace(/\s*\(\d{4}\)\s*/g, ' ')        // elimina años (2014)
        .replace(/[-_]+/g, ' ')                  // guiones → espacio
        .replace(/\s+/g, ' ')                    // espacios múltiples → uno
        .trim();
}

// ---------------------------------------------------------------------------
// M3U — descarga, parseo y caché
// ---------------------------------------------------------------------------
// M3U — descarga en streaming, almacenamiento como strings compactos
// ---------------------------------------------------------------------------
// Formato interno: "xuiId\x00name\x00url"
// Usamos \x00 (null byte) como separador — nunca aparece en nombres ni URLs
// Esto evita crear objetos JS por cada item, reduciendo RAM ~5x vs objetos
// ---------------------------------------------------------------------------
const M3U_URL = `${XTREAM_SERVER}/get.php?username=${encodeURIComponent(XTREAM_USER)}&password=${encodeURIComponent(XTREAM_PASS)}&type=m3u_plus&output=m3u8`;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

let m3uCache = { items: [], ts: 0 }; // items = array de strings compactos

function unpack(compact) {
    const [xuiId, name, url] = compact.split('\x00');
    return { xuiId, name, url };
}

async function downloadAndParse() {
    const t0 = Date.now();
    console.log('[m3u] descargando playlist (streaming)...');

    const res = await fetch(M3U_URL);
    if (!res.ok) throw new Error(`m3u HTTP ${res.status}`);

    // Leer el body como stream de texto línea por línea
    // sin cargar el archivo completo en memoria
    const items = [];
    const seen  = new Set(); // dedupe por xuiId
    let pending = null;
    let buffer  = '';

    const decoder = new TextDecoder('utf-8');

    for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        // La última línea puede estar incompleta — la guardamos para el próximo chunk
        buffer = lines.pop();

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (line.startsWith('#EXTINF')) {
                const idMatch   = line.match(/xui-id="([^"]*)"/);
                const nameMatch = line.match(/tvg-name="([^"]*)"/);
                const display   = line.split(',').slice(1).join(',').trim();
                const name      = (nameMatch && nameMatch[1]) || display || '';
                const xuiId     = idMatch ? idMatch[1] : null;
                pending = { xuiId, name };
            } else if (pending && line && !line.startsWith('#')) {
                if (/^https?:\/\//i.test(line) && !line.endsWith('/m3u8')) {
                    const key = pending.xuiId || line;
                    if (!seen.has(key)) {
                        seen.add(key);
                        // Guardar como string compacto en vez de objeto
                        items.push(`${pending.xuiId || ''}\x00${pending.name}\x00${line}`);
                    }
                }
                pending = null;
            }
        }
    }

    // Procesar cualquier línea restante en el buffer
    if (buffer.trim() && pending) {
        const line = buffer.trim();
        if (/^https?:\/\//i.test(line) && !line.endsWith('/m3u8')) {
            const key = pending.xuiId || line;
            if (!seen.has(key)) {
                items.push(`${pending.xuiId || ''}\x00${pending.name}\x00${line}`);
            }
        }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[m3u] completado en ${elapsed}s — ${items.length} items (live descartados, deduplicados)`);
    return items;
}

// Parseo de episodios: "Vikingos: Valhalla S03E02" → { title, season, episode }
function parseEpisode(name) {
    if (!name) return null;
    const m = String(name).match(/^(.*?)[\s._-]*S(\d{1,2})\s*E(\d{1,3})\b/i);
    if (!m) return null;
    const title = m[1].replace(/[-:.\s]+$/, '').trim();
    if (!title) return null;
    return { title, season: parseInt(m[2], 10), episode: parseInt(m[3], 10) };
}

// ---------------------------------------------------------------------------
// TMDB — caché permanente en memoria (los títulos no cambian)
// ---------------------------------------------------------------------------
const tmdbCache = new Map(); // imdbId → { titleEn, titleEs, normalizedEn, normalizedEs }

async function resolveTMDB(imdbId) {
    if (tmdbCache.has(imdbId)) {
        console.log(`[tmdb] cache hit: ${imdbId} → "${tmdbCache.get(imdbId).titleEs || tmdbCache.get(imdbId).titleEn}"`);
        return tmdbCache.get(imdbId);
    }

    console.log(`[tmdb] consultando API para ${imdbId}...`);
    const headers = { Authorization: `Bearer ${TMDB_READ_TOKEN}`, 'Content-Type': 'application/json' };

    // Llamamos dos veces: una en español latinoamericano, otra en inglés (fallback)
    const [resEs, resEn] = await Promise.all([
        fetch(`https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&language=es-419`, { headers }),
        fetch(`https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&language=en-US`, { headers })
    ]);

    if (!resEs.ok || !resEn.ok) {
        console.error(`[tmdb] error HTTP: es=${resEs.status} en=${resEn.status}`);
        return null;
    }

    const dataEs = await resEs.json();
    const dataEn = await resEn.json();

    // /find devuelve resultados en movie_results, tv_results, etc.
    const pickResult = (data) => {
        const candidates = [
            ...(data.movie_results  || []),
            ...(data.tv_results     || []),
            ...(data.tv_episode_results || [])
        ];
        if (!candidates.length) return null;
        return candidates[0];
    };

    const resultEs = pickResult(dataEs);
    const resultEn = pickResult(dataEn);
    const base = resultEs || resultEn;
    if (!base) {
        console.warn(`[tmdb] sin resultados para ${imdbId}`);
        return null;
    }

    const titleEs = resultEs ? (resultEs.title || resultEs.name || resultEs.original_title || resultEs.original_name) : null;
    const titleEn = resultEn ? (resultEn.title || resultEn.name || resultEn.original_title || resultEn.original_name) : null;

    // Extraer año de estreno — release_date (películas) o first_air_date (series)
    const dateStr = base.release_date || base.first_air_date || '';
    const year = dateStr ? parseInt(dateStr.slice(0, 4), 10) : null;

    const result = {
        titleEs,
        titleEn,
        year,
        normalizedEs: normalize(titleEs),
        normalizedEn: normalize(titleEn)
    };
    tmdbCache.set(imdbId, result);
    console.log(`[tmdb] resuelto: ${imdbId} → es="${titleEs}" en="${titleEn}" año=${year || 'desconocido'}`);
    return result;
}

// ---------------------------------------------------------------------------
// Matching M3U
// ---------------------------------------------------------------------------
function findInM3U(items, normalizedTitle, season, episode, year) {
    const isSeries = season !== null && episode !== null;
    console.log(`[match] buscando "${normalizedTitle}"${isSeries ? ` S${season}E${episode}` : ''}${year ? ` (${year})` : ''} en ${items.length} items`);

    const candidates = [];
    for (const compact of items) {
        const { name, url } = unpack(compact);
        if (!isSeries) {
            if (parseEpisode(name)) continue;
            if (normalize(name).includes(normalizedTitle)) candidates.push({ name, url });
        } else {
            const parsed = parseEpisode(name);
            if (!parsed) continue;
            if (parsed.season !== season || parsed.episode !== episode) continue;
            const normParsed = normalize(parsed.title);
            if (normParsed.includes(normalizedTitle) || normalizedTitle.includes(normParsed)) {
                candidates.push({ name, url });
            }
        }
    }

    if (!candidates.length) {
        console.warn(`[match] SIN COINCIDENCIA para "${normalizedTitle}"${isSeries ? ` S${season}E${episode}` : ''}`);
        return null;
    }

    if (year && candidates.length > 1) {
        const withYear = candidates.filter(it => it.name.includes(`(${year})`));
        if (withYear.length) {
            console.log(`[match] ${candidates.length} candidatos → filtrado por año ${year} → ${withYear.length} → usando: "${withYear[0].name}"`);
            return withYear[0];
        }
        console.log(`[match] ${candidates.length} candidatos, ninguno con año (${year}) → usando: "${candidates[0].name}"`);
    } else {
        console.log(`[match] ${candidates.length} coincidencia(s) → usando: "${candidates[0].name}"`);
    }

    return candidates[0];
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
const MANIFEST = {
    id: 'org.xtreamsearch.streams',
    version: '2.0.0',
    name: 'Streams',
    description: 'Streams desde tu Xtream IPTV via búsqueda Cinemeta/AIOMetadata',
    logo: 'https://i.imgur.com/8bZykpk.png',
    background: 'https://i.imgur.com/Gr4xMaZ.jpeg',
    resources: ['stream'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: { configurable: false }
};

app.get('/manifest.json', (req, res) => res.json(MANIFEST));

// ---------------------------------------------------------------------------
// Stream handler
// ---------------------------------------------------------------------------
app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    console.log(`[stream] request → type=${type} id=${id}`);

    try {
        // Parsear ID: "tt3397766" (película) o "tt3397766:3:2" (serie)
        const parts   = id.split(':');
        const imdbId  = parts[0];
        const season  = parts[1] ? parseInt(parts[1], 10) : null;
        const episode = parts[2] ? parseInt(parts[2], 10) : null;

        if (!imdbId.startsWith('tt')) {
            console.warn(`[stream] id no es IMDB: ${id}`);
            return res.json({ streams: [] });
        }

        // Resolver título via TMDB
        const tmdb = await resolveTMDB(imdbId);
        if (!tmdb) {
            console.warn(`[stream] TMDB no devolvió resultados para ${imdbId}`);
            return res.json({ streams: [] });
        }

        const { items } = m3uCache;
        if (!items.length) {
            console.warn('[stream] M3U cache vacía, aún no cargó');
            return res.json({ streams: [] });
        }

        // Intentar match primero en español, luego en inglés
        let found = null;
        if (tmdb.normalizedEs) {
            found = findInM3U(items, tmdb.normalizedEs, season, episode, tmdb.year);
        }
        if (!found && tmdb.normalizedEn) {
            console.log(`[match] reintentando con título en inglés: "${tmdb.normalizedEn}"`);
            found = findInM3U(items, tmdb.normalizedEn, season, episode, tmdb.year);
        }

        if (!found) {
            console.warn(`[stream] sin stream para ${id}`);
            return res.json({ streams: [] });
        }

        const isCam    = /HDTS/i.test(found.name);
        const quality  = isCam ? 'CAM' : 'WEB-DL';
        const typeLabel = (season !== null && episode !== null) ? 'Serie' : 'Película';

        const stream = {
            url: found.url,
            name: 'Streams',
            title: `📺 Xtream | 1080p | ${quality} | ${typeLabel}\n🇲🇽 LATINO`,
            behaviorHints: { notWebReady: true } // http:// → siempre notWebReady
        };
        console.log(`[stream] devolviendo stream: ${found.url}`);
        return res.json({ streams: [stream] });

    } catch (e) {
        console.error(`[stream] error inesperado: ${e.message}`);
        console.error(e.stack);
        res.json({ streams: [] });
    }
});

// ---------------------------------------------------------------------------
// Rutas auxiliares
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    m3uItems: m3uCache.items.length,
    m3uAge: m3uCache.ts ? `${Math.floor((Date.now() - m3uCache.ts) / 60000)}min` : 'no cargado',
    tmdbCacheSize: tmdbCache.size
}));

app.use((req, res) => {
    console.warn(`[404] ruta no encontrada: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: 'not found' });
});

// ---------------------------------------------------------------------------
// Boot — descarga M3U antes de aceptar requests
// ---------------------------------------------------------------------------
async function boot() {
    console.log('[boot] iniciando XtreamStreams...');
    console.log(`[boot] servidor Xtream: ${XTREAM_SERVER}`);

    // Servidor arranca inmediatamente — AlwaysData mata procesos que tardan en responder
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[boot] servidor escuchando en puerto ${PORT}`);
        console.log(`[boot] manifest: http://localhost:${PORT}/manifest.json`);
    });

    // M3U se carga en background — requests durante la carga devuelven streams: []
    console.log('[boot] cargando M3U en background...');
    try {
        const items = await downloadAndParse();
        m3uCache = { items, ts: Date.now() };
        console.log(`[boot] M3U listo — ${items.length} items cargados, addon operativo`);
    } catch (e) {
        console.error(`[boot] ERROR al cargar M3U: ${e.message}`);
    }

    // Refresco periódico cada 6h
    setInterval(async () => {
        console.log('[m3u] refrescando caché en background...');
        try {
            const items = await downloadAndParse();
            m3uCache = { items, ts: Date.now() };
            console.log(`[m3u] caché actualizada — ${items.length} items`);
        } catch (e) {
            console.error(`[m3u] error al refrescar: ${e.message}`);
        }
    }, CACHE_TTL_MS);
}

boot();
