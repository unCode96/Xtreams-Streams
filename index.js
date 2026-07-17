const express = require('express');
const app = express();

// ---------------------------------------------------------------------------
// Variables de entorno
// ---------------------------------------------------------------------------
const TMDB_READ_TOKEN  = process.env.TMDB_READ_TOKEN;
const RENDER_INDEX_URL = process.env.RENDER_INDEX_URL; // ej: https://tu-app.onrender.com/index.json
const INDEX_SECRET     = process.env.INDEX_SECRET;
const PORT             = process.env.PORT || 3000;

for (const [k, v] of Object.entries({ TMDB_READ_TOKEN, RENDER_INDEX_URL, INDEX_SECRET })) {
    if (!v) { console.error(`[boot] ERROR: variable ${k} no definida`); process.exit(1); }
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
// Normalización — debe ser idéntica a la del indexer
// ---------------------------------------------------------------------------
function normalize(str) {
    if (!str) return '';
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ñ/g, 'n')
        .replace(/[:"'¡!¿?.,()\[\]{}/\\|@#$%^&*+=<>~`]/g, ' ')
        .replace(/\s*\(\d{4}\)\s*/g, ' ')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ---------------------------------------------------------------------------
// Índice en memoria — cargado desde Render
// ---------------------------------------------------------------------------
let moviesMap = new Map(); // "titulo normalizado:año" → url
let seriesMap = new Map(); // "titulo normalizado:s:e"  → url
let indexLoadedAt = null;

const INDEX_TTL_MS = 6 * 60 * 60 * 1000; // 6h

async function loadIndex() {
    console.log(`[index] descargando índice desde Render...`);
    const t0 = Date.now();
    const res = await fetch(RENDER_INDEX_URL, {
        headers: { 'X-Api-Key': INDEX_SECRET }
    });
    if (res.status === 503) {
        throw new Error('índice aún no está listo en Render');
    }
    if (!res.ok) throw new Error(`índice HTTP ${res.status}`);

    const data = await res.json();
    moviesMap = new Map(Object.entries(data.movies || {}));
    seriesMap = new Map(Object.entries(data.series || {}));
    indexLoadedAt = new Date().toISOString();

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[index] cargado en ${elapsed}s — ${moviesMap.size} películas, ${seriesMap.size} episodios (generado: ${data.generatedAt})`);
}

// ---------------------------------------------------------------------------
// TMDB — caché permanente en memoria
// ---------------------------------------------------------------------------
const tmdbCache = new Map();

async function resolveTMDB(imdbId) {
    if (tmdbCache.has(imdbId)) {
        const cached = tmdbCache.get(imdbId);
        console.log(`[tmdb] cache hit: ${imdbId} → "${cached.titleEs || cached.titleEn}" (${cached.year || '?'})`);
        return cached;
    }

    console.log(`[tmdb] consultando API para ${imdbId}...`);
    const headers = { Authorization: `Bearer ${TMDB_READ_TOKEN}` };

    const [resEs, resEn] = await Promise.all([
        fetch(`https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&language=es-419`, { headers }),
        fetch(`https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&language=en-US`,  { headers })
    ]);

    if (!resEs.ok || !resEn.ok) {
        console.error(`[tmdb] error HTTP: es=${resEs.status} en=${resEn.status}`);
        return null;
    }

    const dataEs = await resEs.json();
    const dataEn = await resEn.json();

    const pickResult = (data) => {
        const c = [...(data.movie_results||[]), ...(data.tv_results||[]), ...(data.tv_episode_results||[])];
        return c[0] || null;
    };

    const resultEs = pickResult(dataEs);
    const resultEn = pickResult(dataEn);
    const base = resultEs || resultEn;
    if (!base) { console.warn(`[tmdb] sin resultados para ${imdbId}`); return null; }

    const titleEs = resultEs ? (resultEs.title || resultEs.name || resultEs.original_name) : null;
    const titleEn = resultEn ? (resultEn.title || resultEn.name || resultEn.original_name) : null;
    const dateStr = base.release_date || base.first_air_date || '';
    const year    = dateStr ? parseInt(dateStr.slice(0, 4), 10) : null;

    const result = { titleEs, titleEn, year, normalizedEs: normalize(titleEs), normalizedEn: normalize(titleEn) };
    tmdbCache.set(imdbId, result);
    console.log(`[tmdb] resuelto: ${imdbId} → es="${titleEs}" en="${titleEn}" año=${year || '?'}`);
    return result;
}

// ---------------------------------------------------------------------------
// Lookup en el índice — O(1) con fallbacks
// ---------------------------------------------------------------------------
function lookupMovie(tmdb) {
    // Intento 1: título español + año
    if (tmdb.normalizedEs && tmdb.year) {
        const url = moviesMap.get(`${tmdb.normalizedEs}:${tmdb.year}`);
        if (url) { console.log(`[lookup] película hit es+año`); return url; }
    }
    // Intento 2: título español sin año
    if (tmdb.normalizedEs) {
        const url = moviesMap.get(tmdb.normalizedEs);
        if (url) { console.log(`[lookup] película hit es`); return url; }
    }
    // Intento 3: título inglés + año
    if (tmdb.normalizedEn && tmdb.year) {
        const url = moviesMap.get(`${tmdb.normalizedEn}:${tmdb.year}`);
        if (url) { console.log(`[lookup] película hit en+año`); return url; }
    }
    // Intento 4: título inglés sin año
    if (tmdb.normalizedEn) {
        const url = moviesMap.get(tmdb.normalizedEn);
        if (url) { console.log(`[lookup] película hit en`); return url; }
    }
    console.warn(`[lookup] película NO encontrada: "${tmdb.normalizedEs || tmdb.normalizedEn}" (${tmdb.year || '?'})`);
    return null;
}

function lookupEpisode(tmdb, season, episode) {
    // Intento 1: título español
    if (tmdb.normalizedEs) {
        const url = seriesMap.get(`${tmdb.normalizedEs}:${season}:${episode}`);
        if (url) { console.log(`[lookup] episodio hit es`); return url; }
    }
    // Intento 2: título inglés
    if (tmdb.normalizedEn) {
        const url = seriesMap.get(`${tmdb.normalizedEn}:${season}:${episode}`);
        if (url) { console.log(`[lookup] episodio hit en`); return url; }
    }
    console.warn(`[lookup] episodio NO encontrado: "${tmdb.normalizedEs || tmdb.normalizedEn}" S${season}E${episode}`);
    return null;
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
    console.log(`[stream] type=${type} id=${id}`);

    try {
        const parts   = id.split(':');
        const imdbId  = parts[0];
        const season  = parts[1] ? parseInt(parts[1], 10) : null;
        const episode = parts[2] ? parseInt(parts[2], 10) : null;

        if (!imdbId.startsWith('tt')) {
            console.warn(`[stream] id no es IMDB: ${id}`);
            return res.json({ streams: [] });
        }

        if (!indexLoadedAt) {
            console.warn('[stream] índice aún no cargado');
            return res.json({ streams: [] });
        }

        const tmdb = await resolveTMDB(imdbId);
        if (!tmdb) return res.json({ streams: [] });

        const isSeries = season !== null && episode !== null;
        const url = isSeries
            ? lookupEpisode(tmdb, season, episode)
            : lookupMovie(tmdb);

        if (!url) return res.json({ streams: [] });

        const isCam    = /HDTS/i.test(url) || (tmdb.titleEs && /HDTS/i.test(tmdb.titleEs));
        const quality  = isCam ? 'CAM' : 'WEB-DL';
        const typeLabel = isSeries ? 'Serie' : 'Película';

        console.log(`[stream] devolviendo: ${url}`);
        return res.json({
            streams: [{
                url,
                name: 'Streams',
                title: `📺 Xtream | 1080p | ${quality} | ${typeLabel}\n🇲🇽 LATINO`,
                behaviorHints: { notWebReady: true }
            }]
        });

    } catch (e) {
        console.error(`[stream] error: ${e.message}`);
        console.error(e.stack);
        res.json({ streams: [] });
    }
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    indexLoadedAt,
    movies: moviesMap.size,
    series: seriesMap.size,
    tmdbCacheSize: tmdbCache.size
}));

app.use((req, res) => {
    console.warn(`[404] ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: 'not found' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
    console.log('[boot] iniciando Streams addon...');

    // Servidor arranca inmediatamente
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[boot] servidor escuchando en puerto ${PORT}`);
    });

    // Cargar índice desde Render en background con reintentos
    const tryLoad = async (attempts = 5, delayMs = 10000) => {
        for (let i = 1; i <= attempts; i++) {
            try {
                await loadIndex();
                return;
            } catch (e) {
                console.warn(`[index] intento ${i}/${attempts} fallido: ${e.message}`);
                if (i < attempts) {
                    console.log(`[index] reintentando en ${delayMs / 1000}s...`);
                    await new Promise(r => setTimeout(r, delayMs));
                }
            }
        }
        console.error('[index] no se pudo cargar el índice después de todos los intentos');
    };

    await tryLoad();

    // Refresco cada 6h
    setInterval(async () => {
        console.log('[index] refrescando desde Render...');
        try {
            await loadIndex();
        } catch (e) {
            console.error(`[index] error al refrescar: ${e.message}`);
        }
    }, INDEX_TTL_MS);
}

boot();
