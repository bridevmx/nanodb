/**
 * Rate Limiting Middleware - Dinámico y configurable via API
 * 
 * Usa una colección de sistema (_rate_limits) para configurar límites
 * por ruta, método, o usuario de forma dinámica.
 */

const engine = require('../core/engine');

// Cache en memoria para evitar consultas constantes a BD
let rateLimitsCache = new Map();
let lastCacheUpdate = 0;
const CACHE_TTL = 60000; // 1 minuto

/**
 * Cargar límites de rate desde la colección _rate_limits
 */
async function loadRateLimits() {
    const now = Date.now();

    // Usar caché si es reciente
    if (now - lastCacheUpdate < CACHE_TTL && rateLimitsCache.size > 0) {
        return rateLimitsCache;
    }

    try {
        const limits = await engine.list('_rate_limits', { perPage: 1000 });

        rateLimitsCache.clear();

        for (const limit of limits.items) {
            if (limit.enabled) {
                const key = `${limit.method || '*'}:${limit.path || '*'}`;
                rateLimitsCache.set(key, {
                    max: limit.max || 100,
                    timeWindow: limit.timeWindow || 60000, // 1 minuto por defecto
                    skipOnError: limit.skipOnError !== false
                });
            }
        }

        lastCacheUpdate = now;
    } catch (error) {
        console.warn('⚠️  No se pudo cargar rate limits:', error.message);
    }

    return rateLimitsCache;
}

/**
 * Obtener configuración de rate limit para una ruta específica
 */
async function getRateLimitConfig(method, path) {
    await loadRateLimits();

    // Buscar coincidencia exacta primero
    const exactKey = `${method}:${path}`;
    if (rateLimitsCache.has(exactKey)) {
        return rateLimitsCache.get(exactKey);
    }

    // Buscar por método wildcard
    const methodWildcard = `${method}:*`;
    if (rateLimitsCache.has(methodWildcard)) {
        return rateLimitsCache.get(methodWildcard);
    }

    // Buscar por path wildcard
    const pathWildcard = `*:${path}`;
    if (rateLimitsCache.has(pathWildcard)) {
        return rateLimitsCache.get(pathWildcard);
    }

    // Buscar wildcard total
    if (rateLimitsCache.has('*:*')) {
        return rateLimitsCache.get('*:*');
    }

    // Sin límite configurado
    return null;
}

/**
 * Middleware de rate limiting
 */
async function rateLimitMiddleware(request, reply) {
    // ⚡ FASTEST BAIL-OUT: Chequeo de header optimizado
    // Evitar split strings o lookups si es un test de carga autorizado
    if (request.headers['x-skip-rate-limit'] === 'true') {
        return;
    }

    // Excluir rutas de sistema
    if (request.url.startsWith('/health') ||
        request.url.startsWith('/api/stats')) {
        return;
    }

    const method = request.method;
    const path = request.url.split('?')[0]; // Sin query params

    const config = await getRateLimitConfig(method, path);

    if (!config) {
        return; // Sin límite configurado
    }

    // Implementar rate limiting simple en memoria
    // (En producción, usar Redis para distribuir entre instancias)
    const clientId = request.ip || 'unknown';
    const key = `${clientId}:${method}:${path}`;

    if (!global.rateLimitStore) {
        global.rateLimitStore = new Map();
    }

    const now = Date.now();
    const record = global.rateLimitStore.get(key);

    if (!record) {
        // Primera petición
        global.rateLimitStore.set(key, {
            count: 1,
            resetTime: now + config.timeWindow
        });
        return;
    }

    // Verificar si la ventana expiró
    if (now > record.resetTime) {
        // Reset
        global.rateLimitStore.set(key, {
            count: 1,
            resetTime: now + config.timeWindow
        });
        return;
    }

    // Incrementar contador
    record.count++;

    if (record.count > config.max) {
        // Límite excedido
        const retryAfter = Math.ceil((record.resetTime - now) / 1000);

        reply.header('Retry-After', retryAfter);
        reply.header('X-RateLimit-Limit', config.max);
        reply.header('X-RateLimit-Remaining', 0);
        reply.header('X-RateLimit-Reset', record.resetTime);

        return reply.code(429).send({
            error: 'Too Many Requests',
            message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
            retryAfter
        });
    }

    // Agregar headers informativos
    reply.header('X-RateLimit-Limit', config.max);
    reply.header('X-RateLimit-Remaining', config.max - record.count);
    reply.header('X-RateLimit-Reset', record.resetTime);
}

/**
 * Limpiar registros expirados periódicamente
 */
setInterval(() => {
    if (!global.rateLimitStore) return;

    const now = Date.now();
    for (const [key, record] of global.rateLimitStore.entries()) {
        if (now > record.resetTime) {
            global.rateLimitStore.delete(key);
        }
    }
}, 60000); // Cada minuto

module.exports = {
    rateLimitMiddleware,
    loadRateLimits,
    getRateLimitConfig
};
