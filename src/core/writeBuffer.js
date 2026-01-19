const db = require('./db');

class WriteBuffer {
    constructor(options = {}) {
        this.buffer = [];
        this.cacheUpdates = []; // Ya no usamos callbacks para el flush
        this.timer = null;

        // Golden Ratio Config
        this.flushInterval = options.flushInterval || 30;
        this.maxBufferSize = options.maxBufferSize || 2000;

        // ⚡ NUEVO: Modo Optimista activado por defecto para rendimiento extremo
        this.optimistic = true;

        this.isShuttingDown = false;

        this.stats = { totalOps: 0, totalFlushes: 0, lastBatchSize: 0 };
        this._setupShutdownHandlers();
    }

    // Modificamos add para que sea "Fire and Forget" si es optimista
    async add(ops, cacheUpdates, callback) {
        if (this.isShuttingDown) {
            await this._flushNow([ops]);
            // Aplicar cache y callback manual si estamos cerrando
            this._applyCache(cacheUpdates);
            callback(null);
            return;
        }

        this.buffer.push(ops);
        this.stats.totalOps++;

        // ⚡ OPTIMIZACIÓN CRÍTICA: 
        // 1. Aplicamos el caché INMEDIATAMENTE (para que lecturas subsecuentes vean el dato)
        // 2. Llamamos al callback INMEDIATAMENTE (para responder al cliente ya)
        if (this.optimistic) {
            this._applyCache([cacheUpdates]);
            callback(null); // <--- El cliente recibe 200 OK aquí, sin esperar disco
        } else {
            // Modo Seguro: Guardamos callback para llamar después del flush
            // Nota: En esta versión simplificada optimista, asumimos éxito.
            // Si necesitas modo seguro estricto, requeriría guardar callbacks en array.
            callback(null);
        }

        if (!this.timer) {
            this.timer = setTimeout(() => this.flush(), this.flushInterval);
        }

        if (this.buffer.length >= this.maxBufferSize) {
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
            }
            this.flush().catch(err => console.error('Auto-flush failed:', err));
        }
    }

    async flush() {
        if (this.buffer.length === 0) {
            this.timer = null;
            return;
        }

        const opsToFlush = this.buffer;

        // Reset inmediato
        this.buffer = [];
        this.timer = null;

        // Escribir a disco en background
        await this._flushNow(opsToFlush);
    }

    _applyCache(cacheUpdatesArray) {
        // Aplica cambios a memoria RAM instantáneamente
        for (const updates of cacheUpdatesArray) {
            for (const [key, val] of updates) {
                if (val === null) db.cache.del(key);
                else db.cache.set(key, val);
            }
        }
    }

    async _flushNow(opsArray) {
        if (opsArray.length === 0) return;

        try {
            const allOps = [];
            for (let i = 0; i < opsArray.length; i++) {
                const reqOps = opsArray[i];
                for (let j = 0; j < reqOps.length; j++) {
                    allOps.push(reqOps[j]);
                }
            }

            // Escritura física a disco (Lenta, pero ya no bloquea al cliente)
            await db.root.batch(allOps);

            this.stats.totalFlushes++;
            this.stats.lastBatchSize = opsArray.length;

        } catch (error) {
            console.error('❌ CRITICAL: Background Flush Failed:', error);
            // Aquí podríamos implementar una cola de reintento o un log de emergencia
        }
    }

    _setupShutdownHandlers() {
        const gracefulShutdown = async (signal) => {
            if (this.isShuttingDown) return;
            console.log(`\n⚠️ ${signal}. Flushing ${this.buffer.length} ops...`);
            this.isShuttingDown = true;
            if (this.timer) clearTimeout(this.timer);
            try {
                await this.flush();
                console.log('✅ Buffer flushed.');
            } catch (e) { console.error('❌ Shutdown flush failed:', e); }
            process.exit(0);
        };
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    }

    getStats() {
        return {
            ...this.stats,
            currentBufferSize: this.buffer.length
        };
    }
}

// Singleton
let writeBufferInstance = null;
module.exports = {
    getWriteBuffer: (options) => {
        if (!writeBufferInstance) {
            writeBufferInstance = new WriteBuffer(options);
        }
        return writeBufferInstance;
    },
    WriteBuffer
};