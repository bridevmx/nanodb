/**
 * Write Buffer - Group Commit Pattern (OPTIMIZED)
 * * v2 Changes:
 * - Removed blocking console.logs in hot path
 * - Optimized stats calculation
 * - Better error handling
 */

const db = require('./db');

class WriteBuffer {
    constructor(options = {}) {
        this.buffer = [];
        this.cacheUpdates = [];
        this.callbacks = [];
        this.timer = null;

        // TUNING: Aumentado para carga 'BREAKING'
        this.flushInterval = options.flushInterval || 50; // 50ms (antes 20)
        this.maxBufferSize = options.maxBufferSize || 1000; // 1000 ops (antes 100)

        this.isShuttingDown = false;

        // Stats simplificados para menor overhead
        this.stats = {
            totalOps: 0,
            totalFlushes: 0,
            lastBatchSize: 0
        };

        this._setupShutdownHandlers();
    }

    async add(ops, cacheUpdates, callback) {
        if (this.isShuttingDown) {
            await this._flushNow([ops], [cacheUpdates], [callback]);
            return;
        }

        this.buffer.push(ops);
        this.cacheUpdates.push(cacheUpdates);
        this.callbacks.push(callback);
        this.stats.totalOps++;

        if (!this.timer) {
            this.timer = setTimeout(() => this.flush(), this.flushInterval);
        }

        if (this.buffer.length >= this.maxBufferSize) {
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
            }
            // Fire and forget (con catch) para no bloquear
            this.flush().catch(err => {
                // Solo loguear errores reales, no info
                console.error('CRITICAL: Auto-flush failed:', err);
            });
        }
    }

    async flush() {
        if (this.buffer.length === 0) {
            this.timer = null;
            return;
        }

        // Swap atómico de buffers
        const opsToFlush = this.buffer;
        const cacheToFlush = this.cacheUpdates;
        const callbacksToFlush = this.callbacks;

        // Reiniciar estado inmediatamente para aceptar nuevas escrituras
        // mientras procesamos el batch anterior (concurrencia real)
        this.buffer = [];
        this.cacheUpdates = [];
        this.callbacks = [];
        this.timer = null;

        await this._flushNow(opsToFlush, cacheToFlush, callbacksToFlush);
    }

    async _flushNow(opsArray, cacheArray, callbackArray) {
        if (opsArray.length === 0) return;

        try {
            const allOps = [];
            // Optimización: Loop simple es más rápido que flatMap
            for (let i = 0; i < opsArray.length; i++) {
                const reqOps = opsArray[i];
                for (let j = 0; j < reqOps.length; j++) {
                    allOps.push(reqOps[j]);
                }
            }

            // EXTREME PERFORMANCE: Sin logs aquí. Solo escritura pura.
            await db.root.batch(allOps);

            // Actualizar caché solo tras éxito
            for (let i = 0; i < cacheArray.length; i++) {
                const updates = cacheArray[i];
                for (let j = 0; j < updates.length; j++) {
                    const [key, val] = updates[j];
                    if (val === null) db.cache.del(key);
                    else db.cache.set(key, val);
                }
            }

            // Notificar éxito
            for (let i = 0; i < callbackArray.length; i++) {
                if (callbackArray[i]) callbackArray[i](null);
            }

            this.stats.totalFlushes++;
            this.stats.lastBatchSize = opsArray.length;

        } catch (error) {
            console.error('❌ Batch Write Error:', error);
            // Notificar error
            for (let i = 0; i < callbackArray.length; i++) {
                if (callbackArray[i]) callbackArray[i](error);
            }
        }
    }

    _setupShutdownHandlers() {
        const gracefulShutdown = async (signal) => {
            if (this.isShuttingDown) return;
            console.log(`\n⚠️ ${signal} received. Flushing remaining ${this.buffer.length} ops...`);
            this.isShuttingDown = true;
            if (this.timer) clearTimeout(this.timer);

            try {
                await this.flush();
                console.log('✅ Buffer flushed.');
            } catch (e) {
                console.error('❌ Shutdown flush failed:', e);
            }
            process.exit(0);
        };

        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    }

    getStats() {
        return {
            ...this.stats,
            currentBufferSize: this.buffer.length,
            config: {
                batchSize: this.maxBufferSize,
                interval: this.flushInterval
            }
        };
    }
}

// Singleton con configuración actualizada
let writeBufferInstance = null;

module.exports = {
    getWriteBuffer: (options) => {
        if (!writeBufferInstance) {
            // Ignorar opciones viejas, forzar tuning agresivo
            writeBufferInstance = new WriteBuffer({
                flushInterval: 50,    // 50ms window
                maxBufferSize: 2000   // Gran capacidad
            });
        }
        return writeBufferInstance;
    },
    WriteBuffer
};