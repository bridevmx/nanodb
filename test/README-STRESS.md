# 🔥 NanoDB Stress Test

Script de pruebas de estrés extremo para encontrar los límites de NanoDB.

## 📋 Requisitos

- Node.js 20+
- NanoDB corriendo en `http://localhost:3000`

## 🚀 Uso

### Niveles de Estrés

```bash
# WARM UP - Calentamiento (100 ops, 10 concurrent)
node test/stress-test.js warm crud

# MEDIUM - Estrés medio (500 ops, 50 concurrent)
node test/stress-test.js medium crud

# HIGH - Estrés alto (2000 ops, 100 concurrent)
node test/stress-test.js high crud

# EXTREME - Estrés extremo (5000 ops, 200 concurrent)
node test/stress-test.js extreme crud

# BREAKING - Punto de ruptura (10000 ops, 500 concurrent)
node test/stress-test.js breaking crud
```

### Tipos de Test

#### CRUD Test
Ejecuta operaciones CREATE → READ → UPDATE → DELETE en secuencia:
```bash
node test/stress-test.js <level> crud
```

#### Sustained Test
Carga sostenida durante un tiempo específico:
```bash
node test/stress-test.js <level> sustained
```

## 📊 Métricas

El script reporta:
- **Duration**: Tiempo total de ejecución
- **Total Ops**: Operaciones totales ejecutadas
- **Success Rate**: Porcentaje de éxito
- **Throughput**: Operaciones por segundo
- **Latency**: Min/Avg/Max en milisegundos
- **Errors**: Desglose de errores por tipo

## 🎯 Configuración

Variables de entorno opcionales:

```bash
API_URL=http://localhost:3000 \
EMAIL=admin@local.host \
PASSWORD=password123 \
node test/stress-test.js extreme crud
```

## 📈 Ejemplos de Uso

### Encontrar el límite de throughput
```bash
# Empezar con warm
node test/stress-test.js warm crud

# Ir subiendo gradualmente
node test/stress-test.js medium crud
node test/stress-test.js high crud
node test/stress-test.js extreme crud

# Hasta encontrar el breaking point
node test/stress-test.js breaking crud
```

### Test de carga sostenida
```bash
# 30 segundos con 50 concurrent
node test/stress-test.js medium sustained

# 2 minutos con 200 concurrent
node test/stress-test.js extreme sustained
```

## ⚠️ Advertencias

- Los tests **EXTREME** y **BREAKING** pueden saturar el servidor
- Asegúrate de tener suficiente RAM disponible
- Monitorea el uso de CPU y memoria del servidor
- Los tests **sustained** crean y eliminan registros continuamente

## 🔍 Interpretación de Resultados

### Success Rate
- **100%**: Sistema estable bajo esta carga
- **95-99%**: Límite cercano, algunos errores ocasionales
- **<95%**: Sistema sobrecargado, reducir intensidad

### Throughput
- Compara con tests anteriores para ver degradación
- Si cae drásticamente, has encontrado el límite

### Latency
- **Max Latency** muy alto indica cuellos de botella
- **Avg Latency** creciente indica saturación progresiva

## 💡 Tips

1. **Empezar bajo**: Siempre empieza con `warm` y sube gradualmente
2. **Monitorear**: Usa `htop` o similar para ver recursos del servidor
3. **Limpiar**: Entre tests, reinicia el servidor para limpiar caché
4. **Comparar**: Guarda los resultados para comparar optimizaciones
