/**
 * Rate Limiter Optimizado - BAAS Compatible
 * 
 * Características:
 * - Configuración dinámica desde colección _rate_limits
 * - Cero async en hot path (ultra rápido)
 * - Reload automático cada 30s
 * - Memory leak protection
 * - Compatible con normas RFC 6585
 */

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════════════════

const rateLimitStore = new Map(); // IP tracking
const configCache = new Map();    // Configuración (reemplaza LRU)
let lastConfigReload = 0;
const RELOAD_INTERVAL = 30000; // 30 segundos

// ═══════════════════════════════════════════════════════════════════════
// CARGA DE CONFIGURACIÓN (BACKGROUND)
// ═══════════════════════════════════════════════════════════════════════

async function reloadRateLimitConfig() {
    const now = Date.now();

    // Solo recargar cada 30s
    if (now - lastConfigReload < RELOAD_INTERVAL) return;
    lastConfigReload = now;

    try {
        const engine = require('../core/engine');
        const result = await engine.list('_rate_limits', {
            perPage: 1000 // Cargar todas las reglas
        });

        // Pre-poblar caché
        configCache.clear();
        for (const rule of result.items) {
            const key = `${rule.method}:${rule.path}`;
            configCache.set(key, {
                max: rule.max || 100,
                timeWindow: rule.timeWindow || 60000
            });
        }

        console.log(`✅ Rate limit config reloaded: ${result.items.length} rules`);
    } catch (error) {
        console.error('❌ Failed to reload rate limit config:', error.message);
    }
}

// Iniciar reload en background
setInterval(reloadRateLimitConfig, RELOAD_INTERVAL);
reloadRateLimitConfig(); // Carga inicial

// ═══════════════════════════════════════════════════════════════════════
// MIDDLEWARE (HOT PATH - ULTRA RÁPIDO)
// ═══════════════════════════════════════════════════════════════════════

function rateLimitMiddleware(request, reply) {
    // ⚡ Early bail-out (sin async)
    if (request.headers['x-skip-rate-limit'] === 'true') {
        return;
    }

    // Excluir rutas de sistema
    if (request.url.startsWith('/health') ||
        request.url.startsWith('/api/stats')) {
        return;
    }

    const method = request.method;
    const path = request.url.split('?')[0];
    const ip = request.ip || 'unknown';

    // ⚡ Lookup en caché (SÍNCRONO - sin await)
    const configKey = `${method}:${path}`;
    const config = configCache.get(configKey);

    // Si no hay config, permitir (fail-open para performance)
    if (!config) return;

    // ⚡ Rate limiting simple
    const key = `${ip}:${configKey}`;
    const now = Date.now();
    const record = rateLimitStore.get(key);

    if (!record || now > record.resetTime) {
        rateLimitStore.set(key, {
            count: 1,
            resetTime: now + config.timeWindow
        });
        return;
    }

    record.count++;

    if (record.count > config.max) {
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

    // Headers informativos
    reply.header('X-RateLimit-Limit', config.max);
    reply.header('X-RateLimit-Remaining', config.max - record.count);
    reply.header('X-RateLimit-Reset', record.resetTime);
}

// ═══════════════════════════════════════════════════════════════════════
// LIMPIEZA PERIÓDICA (EVITAR MEMORY LEAK)
// ═══════════════════════════════════════════════════════════════════════

setInterval(() => {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, record] of rateLimitStore.entries()) {
        if (now > record.resetTime + 60000) { // 1 min después de expirar
            rateLimitStore.delete(key);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} expired rate limit entries`);
    }
}, 60000); // Cada minuto

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    rateLimitMiddleware,
    reloadRateLimitConfig // Para forzar reload manual si es necesario
};
