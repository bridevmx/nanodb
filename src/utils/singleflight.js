/**
 * Singleflight Pattern - Previene cache stampede
 * 
 * Cuando múltiples peticiones solicitan el mismo recurso simultáneamente,
 * solo una va a disco y las demás esperan el resultado.
 * 
 * Esto previene el "thundering herd problem" donde 200 peticiones
 * concurrentes del mismo ID causarían 200 lecturas de disco.
 */
class SingleflightCache {
    constructor(baseCache) {
        this.cache = baseCache;
        this.inflight = new Map(); // Peticiones en curso
    }

    /**
     * Obtiene un valor del caché o ejecuta el loader si no existe
     * @param {string} key - Clave a buscar
     * @param {Function} loader - Función async que carga el dato si no está en caché
     * @returns {Promise<any>} El dato solicitado
     */
    async get(key, loader) {
        // 1. Intentar caché primero (fast path)
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            return cached;
        }

        // 2. Verificar si ya hay una petición en curso para esta clave
        if (this.inflight.has(key)) {
            // Esperar a que la petición en curso termine
            // Múltiples peticiones comparten la misma Promise
            return await this.inflight.get(key);
        }

        // 3. Crear nueva petición compartida
        const promise = (async () => {
            try {
                const data = await loader();

                // Solo cachear si el dato existe
                if (data) {
                    this.cache.set(key, data);
                }

                return data;
            } finally {
                // Limpiar la petición en curso cuando termine
                this.inflight.delete(key);
            }
        })();

        // Guardar la Promise para que otras peticiones la compartan
        this.inflight.set(key, promise);

        return await promise;
    }

    /**
     * Limpiar todas las peticiones en curso
     * Útil para testing o reset del sistema
     */
    clear() {
        this.inflight.clear();
    }

    /**
     * Obtener estadísticas de peticiones en curso
     * @returns {Object} Estadísticas
     */
    getStats() {
        return {
            inflightCount: this.inflight.size,
            inflightKeys: Array.from(this.inflight.keys())
        };
    }
}

module.exports = { SingleflightCache };
