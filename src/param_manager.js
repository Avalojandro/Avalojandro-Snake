/**
 * @fileoverview Gestor de Parámetros Dinámicos para Battlesnake (Culebra Cascabel)
 * Maneja la lectura, persistencia, límites y actualización de pesos heurísticos.
 */

const fs = require("fs");
const path = require("path");

const PARAMS_FILE = path.join(__dirname, "../config/params.json");

const DEFAULT_CONFIG = {
  version: 1,
  gamesPlayed: 0,
  totalWins: 0,
  totalDraws: 0,
  totalLosses: 0,
  lastUpdated: new Date().toISOString(),
  lastAdjustmentReason: "Configuración inicial por defecto",
  weights: {
    spaceWeight: 25,
    tailBonus: 450,
    voronoiWeight: 25,
    voronoiNetWeight: 45,
    deadEndPenalty: 2500,
    corridorPenalty: 900,
    edgePenalty: 180,
    cornerPenalty: 350,
    wallSqueezePenalty: 500,
    coffinPenalty: 650,
    cornerPocketPenalty: 800,
    foodBaseMultiplier: 90,
    foodEarlyMultiplier: 160,
    foodHungryMultiplier: 110,
    threatProximityPenalty: 250,
    chokepointBonus: 450,
    cutoffMultiplier: 1.8,
    partitionMultiplier: 1.6,
    wallSlicingMultiplier: 1.5,
    coilingMultiplier: 0.8,
  },
  bounds: {
    spaceWeight: { min: 10, max: 150, step: 1 },
    tailBonus: { min: 100, max: 2000, step: 25 },
    voronoiWeight: { min: 10, max: 150, step: 1 },
    voronoiNetWeight: { min: 10, max: 200, step: 2 },
    deadEndPenalty: { min: 1000, max: 15000, step: 100 },
    corridorPenalty: { min: 300, max: 8000, step: 50 },
    edgePenalty: { min: 20, max: 1200, step: 20 },
    cornerPenalty: { min: 100, max: 2500, step: 25 },
    wallSqueezePenalty: { min: 100, max: 3000, step: 50 },
    coffinPenalty: { min: 100, max: 3500, step: 50 },
    cornerPocketPenalty: { min: 100, max: 4000, step: 50 },
    foodBaseMultiplier: { min: 20, max: 300, step: 5 },
    foodEarlyMultiplier: { min: 40, max: 400, step: 5 },
    foodHungryMultiplier: { min: 30, max: 350, step: 5 },
    threatProximityPenalty: { min: 50, max: 1200, step: 25 },
    chokepointBonus: { min: 50, max: 2000, step: 25 },
    cutoffMultiplier: { min: 0.2, max: 4.0, step: 0.05 },
    partitionMultiplier: { min: 0.2, max: 4.0, step: 0.05 },
    wallSlicingMultiplier: { min: 0.2, max: 3.5, step: 0.05 },
    coilingMultiplier: { min: 0.1, max: 3.5, step: 0.05 },
  },
  recentHistory: [],
};

let cachedConfig = null;

/**
 * Carga los parámetros desde params.json. Si no existe, lo crea con los valores por defecto.
 * @returns {typeof DEFAULT_CONFIG}
 */
function loadParams() {
  try {
    if (fs.existsSync(PARAMS_FILE)) {
      const raw = fs.readFileSync(PARAMS_FILE, "utf8");
      cachedConfig = JSON.parse(raw);
      // Validar que existan todos los campos por defecto
      for (const [key, val] of Object.entries(DEFAULT_CONFIG.weights)) {
        if (cachedConfig.weights[key] === undefined) {
          cachedConfig.weights[key] = val;
        }
      }
      // Sincronizar límites (bounds) actualizados
      if (!cachedConfig.bounds) cachedConfig.bounds = {};
      for (const [key, val] of Object.entries(DEFAULT_CONFIG.bounds)) {
        cachedConfig.bounds[key] = val;
      }
      return cachedConfig;
    }
  } catch (err) {
    console.error("⚠️ Error cargando params.json, restableciendo a valores por defecto:", err.message);
  }

  cachedConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  saveParams(cachedConfig);
  return cachedConfig;
}

/**
 * Guarda los parámetros en el archivo params.json.
 * @param {typeof DEFAULT_CONFIG} config
 */
function saveParams(config) {
  try {
    fs.writeFileSync(PARAMS_FILE, JSON.stringify(config, null, 2), "utf8");
    cachedConfig = config;
  } catch (err) {
    console.error("❌ Error guardando params.json:", err.message);
  }
}

/**
 * Obtiene los pesos heurísticos vigentes para evaluar jugadas.
 * @returns {typeof DEFAULT_CONFIG.weights}
 */
function getWeights() {
  if (!cachedConfig) {
    loadParams();
  }
  return cachedConfig.weights;
}

/**
 * Obtiene la configuración completa (pesos, límites, estadísticas).
 */
function getConfig() {
  if (!cachedConfig) {
    loadParams();
  }
  return cachedConfig;
}

/**
 * Ajusta parámetros de acuerdo a los deltas solicitados, aplicando límites (clamping).
 * @param {Record<string, number>} deltas - Ej: { foodBaseMultiplier: +5, edgePenalty: -10 }
 * @param {string} reason - Motivo del ajuste
 * @param {Object} [gameMeta] - Metadatos de la partida analizada
 * @returns {{ previous: Record<string, number>, current: Record<string, number>, changes: Record<string, { from: number, to: number, diff: number }> }}
 */
function updateWeights(deltas, reason, gameMeta = {}) {
  const config = getConfig();
  const previous = { ...config.weights };
  const changes = {};

  for (const [key, delta] of Object.entries(deltas)) {
    if (config.weights[key] !== undefined && config.bounds[key]) {
      const oldVal = config.weights[key];
      let newVal = oldVal + delta;

      // Clamping dentro de bounds
      const { min, max, step } = config.bounds[key];
      newVal = Math.max(min, Math.min(max, newVal));

      // Redondear según la escala del step
      if (step < 1) {
        newVal = parseFloat(newVal.toFixed(2));
      } else {
        newVal = Math.round(newVal);
      }

      if (newVal !== oldVal) {
        config.weights[key] = newVal;
        changes[key] = { from: oldVal, to: newVal, diff: parseFloat((newVal - oldVal).toFixed(2)) };
      }
    }
  }

  // Actualizar contadores
  config.gamesPlayed++;
  if (gameMeta.outcome === "WIN") config.totalWins++;
  else if (gameMeta.outcome === "DRAW") config.totalDraws++;
  else if (gameMeta.outcome === "LOSS") config.totalLosses++;

  config.lastUpdated = new Date().toISOString();
  config.lastAdjustmentReason = reason;

  // Registrar en historial reciente (máximo 50 entradas)
  if (!config.recentHistory) config.recentHistory = [];
  config.recentHistory.unshift({
    gameNum: config.gamesPlayed,
    timestamp: config.lastUpdated,
    reason,
    outcome: gameMeta.outcome || "UNKNOWN",
    turns: gameMeta.turns || 0,
    fitness: gameMeta.fitness || 0,
    deathCause: gameMeta.deathCause || "ALIVE",
    changes,
  });
  if (config.recentHistory.length > 50) {
    config.recentHistory = config.recentHistory.slice(0, 50);
  }

  saveParams(config);
  return { previous, current: config.weights, changes };
}

/**
 * Valida y ajusta cualquier objeto de pesos a sus límites (clamping y step).
 * @param {Record<string, number>} weights
 * @returns {Record<string, number>}
 */
function clampWeights(weights) {
  const config = getConfig();
  const clamped = { ...weights };

  for (const [key, val] of Object.entries(clamped)) {
    if (config.bounds[key]) {
      const { min, max, step } = config.bounds[key];
      let newVal = Math.max(min, Math.min(max, val));
      if (step < 1) {
        newVal = parseFloat(newVal.toFixed(2));
      } else {
        newVal = Math.round(newVal);
      }
      clamped[key] = newVal;
    }
  }
  return clamped;
}

const MUTATION_TYPES = [
  "gaussian",
  "aggressive_cut",
  "food_rusher",
  "spatial_packer",
  "perimeter_navigator",
  "holistic",
];

/**
 * Genera una nueva variante de pesos mutados dentro de los límites válidos.
 * @param {Record<string, number>} baseWeights
 * @param {string|null} [mutationType=null]
 * @param {number} [intensity=0.15]
 * @returns {{ weights: Record<string, number>, type: string, changed: Record<string, any> }}
 */
function mutateWeights(baseWeights, mutationType = null, intensity = 0.15) {
  const config = getConfig();
  const W = { ...baseWeights };
  const type = mutationType || MUTATION_TYPES[Math.floor(Math.random() * MUTATION_TYPES.length)];
  const changed = {};

  let targetKeys = [];
  if (type === "aggressive_cut") {
    targetKeys = ["cutoffMultiplier", "wallSlicingMultiplier", "partitionMultiplier", "voronoiNetWeight", "chokepointBonus"];
  } else if (type === "food_rusher") {
    targetKeys = ["foodEarlyMultiplier", "foodBaseMultiplier", "foodHungryMultiplier", "threatProximityPenalty"];
  } else if (type === "spatial_packer") {
    targetKeys = ["spaceWeight", "tailBonus", "coilingMultiplier", "voronoiWeight"];
  } else if (type === "perimeter_navigator") {
    targetKeys = ["edgePenalty", "cornerPenalty", "wallSqueezePenalty", "coffinPenalty", "cornerPocketPenalty", "corridorPenalty"];
  } else if (type === "holistic") {
    targetKeys = [
      ["cutoffMultiplier", "wallSlicingMultiplier"][Math.floor(Math.random() * 2)],
      ["foodEarlyMultiplier", "foodBaseMultiplier"][Math.floor(Math.random() * 2)],
      ["edgePenalty", "cornerPenalty", "corridorPenalty"][Math.floor(Math.random() * 3)],
      ["spaceWeight", "tailBonus"][Math.floor(Math.random() * 2)],
    ];
  } else {
    // Gaussian / Multi-Genómica: perturba de 2 a 4 parámetros al azar
    const allKeys = Object.keys(W);
    const count = Math.floor(Math.random() * 3) + 2;
    const shuffled = [...allKeys].sort(() => 0.5 - Math.random());
    targetKeys = shuffled.slice(0, count);
  }

  for (const key of targetKeys) {
    if (W[key] !== undefined && config.bounds[key]) {
      const bound = config.bounds[key];
      const factor = 1 + (Math.random() * 2 - 1) * intensity;
      let newVal = W[key] * factor;

      newVal = Math.max(bound.min, Math.min(bound.max, newVal));
      if (bound.step < 1) {
        newVal = parseFloat(newVal.toFixed(2));
      } else {
        newVal = Math.round(newVal);
      }

      if (newVal !== W[key]) {
        changed[key] = { from: W[key], to: newVal, diff: parseFloat((newVal - W[key]).toFixed(2)) };
        W[key] = newVal;
      }
    }
  }

  return { weights: W, type, changed };
}

/**
 * Obtiene el genoma de la versión Campeona confirmada.
 */
function getChampion() {
  const config = getConfig();
  if (!config.champion) {
    config.champion = {
      generation: 1,
      winRate: 50.0,
      fitness: 3500,
      gamesEvaluated: 10,
      timestamp: config.lastUpdated,
      weights: { ...config.weights },
      notes: "Campeón Inicial Base",
    };
    saveParams(config);
  }
  return config.champion;
}

/**
 * Guarda y corona un nuevo Campeón en params.json y lo archiva en evolutionHistory.
 */
function saveChampion(championData) {
  const config = getConfig();
  const currentChamp = getChampion();
  const nextGen = (currentChamp.generation || 1) + 1;

  config.champion = {
    generation: championData.generation || nextGen,
    winRate: championData.winRate !== undefined ? championData.winRate : currentChamp.winRate,
    fitness: championData.fitness !== undefined ? championData.fitness : currentChamp.fitness,
    gamesEvaluated: championData.gamesEvaluated || 0,
    timestamp: new Date().toISOString(),
    weights: { ...championData.weights },
    notes: championData.notes || `Nuevo Campeón Gen #${nextGen}`,
  };

  config.weights = { ...championData.weights };
  config.lastUpdated = config.champion.timestamp;
  config.lastAdjustmentReason = `👑 Coronación Gen #${config.champion.generation}: Win Rate ${config.champion.winRate}% | Fitness: ${config.champion.fitness}`;

  if (!config.evolutionHistory) config.evolutionHistory = [];
  config.evolutionHistory.unshift({ ...config.champion });
  if (config.evolutionHistory.length > 50) {
    config.evolutionHistory = config.evolutionHistory.slice(0, 50);
  }

  saveParams(config);
  return config.champion;
}

/**
 * Revierte la configuración activa al genoma del Campeón actual.
 */
function rollbackToChampion() {
  const config = getConfig();
  const champ = getChampion();
  config.weights = { ...champ.weights };
  config.lastUpdated = new Date().toISOString();
  config.lastAdjustmentReason = `↩️ Rollback al Campeón Gen #${champ.generation} (${champ.winRate}%)`;
  saveParams(config);
  return config.weights;
}

/**
 * Asigna temporalmente pesos de un candidato para su ventana de evaluación.
 */
function setCandidateWeights(weights) {
  const config = getConfig();
  config.weights = clampWeights(weights);
  cachedConfig = config;
  return config.weights;
}

/**
 * Restablece los parámetros a la configuración original de fábrica.
 */
function resetToDefaults() {
  cachedConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cachedConfig.champion = {
    generation: 1,
    winRate: 50.0,
    fitness: 3500,
    gamesEvaluated: 10,
    timestamp: cachedConfig.lastUpdated,
    weights: { ...cachedConfig.weights },
    notes: "Configuración Base",
  };
  saveParams(cachedConfig);
  return cachedConfig;
}

module.exports = {
  loadParams,
  saveParams,
  getWeights,
  getConfig,
  updateWeights,
  resetToDefaults,
  clampWeights,
  mutateWeights,
  getChampion,
  saveChampion,
  rollbackToChampion,
  setCandidateWeights,
  DEFAULT_CONFIG,
};
