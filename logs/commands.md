### 📋 Accesos Directos Disponibles en package.json

npm start # Inicia el servidor de la serpiente
npm run simulate # Ejecuta el simulador continuo y genera reporte MD
npm run autotune # Ejecuta la sesión de auto-tuning continuo
npm run royale # Ejecuta el torneo Battle Royale 100 partidas
npm run arena # Ejecuta la arena de entrenamiento histórico

# Ejecutar 100 partidas en ventanas de 10 partidas (10 generaciones evolutivas)

node simulations/autotune_runner.js 100 10

# Ejecutar 500 partidas en ventanas de 15 partidas

node simulations/autotune_runner.js 500 15

# Ejecutar 1000 partidas en ventanas de 20 partidas (50 generaciones evolutivas)

node simulations/autotune_runner.js 1000 20

# O mediante el comando npm (por defecto 20 partidas / 10 por

ventana)
npm run autotune

# Jugadores

waryferryman
rattler
