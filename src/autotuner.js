/**
 * @fileoverview Motor de Auto-Tuning y Aprendizaje Continuo para Battlesnake
 * Ajusta pesos y parámetros analizando diagnósticos de partidas y registrando la evolución.
 */

const fs = require("fs");
const path = require("path");
const { updateWeights, getWeights, getConfig } = require("./param_manager");
const { analyzeLiveGame, analyzeNDJSONFile } = require("./log_analyzer");

const LOGS_DIR = path.join(__dirname, "../logs");
const HISTORY_LOG_FILE = path.join(LOGS_DIR, "autotune_history.log");
const HISTORY_MD_FILE = path.join(LOGS_DIR, "autotune_history.md");

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Registra auditoría en autotune_history.log y autotune_history.md
 * @param {string} message
 * @param {Object} [details]
 */
function appendHistoryLog(message, details = null) {
  ensureLogsDir();
  const timestamp = new Date().toISOString();
  fs.appendFileSync(HISTORY_LOG_FILE, `[${timestamp}] ${message}\n`, "utf8");

  let mdContent = "";
  if (!fs.existsSync(HISTORY_MD_FILE)) {
    mdContent += "# 🧠 Historial de Auditoría de Auto-Tuning\n\n";
  }

  mdContent += `### 🕒 [${timestamp}] ${message}\n\n`;
  if (details && details.changes && Object.keys(details.changes).length > 0) {
    mdContent += "**Modificaciones de Parámetros:**\n";
    for (const [key, c] of Object.entries(details.changes)) {
      mdContent += `- \`${key}\`: \`${c.from}\` ➔ \`${c.to}\` (${c.diff > 0 ? "+" : ""}${c.diff})\n`;
    }
    mdContent += "\n";
  }
  fs.appendFileSync(HISTORY_MD_FILE, mdContent, "utf8");
}

/**
 * Calcula los deltas de ajuste en base a la causa de muerte y desempeño de la partida.
 * @param {import('./log_analyzer').GameDiagnosis} diagnosis
 * @returns {{ deltas: Record<string, number>, reason: string }}
 */
function calculateDeltas(diagnosis) {
  const { outcome, deathCause, turns, maxLen } = diagnosis;
  const deltas = {};
  let reason = "";

  if (outcome === "WIN") {
    reason = `Victoria en Turno ${turns} (Len: ${maxLen}). Refuerzo ofensivo y descompresión perimetral.`;
    deltas.partitionMultiplier = 0.05;
    deltas.cutoffMultiplier = 0.05;
    deltas.wallSlicingMultiplier = 0.05;
    deltas.voronoiNetWeight = 2;
    // Descomprimir penalizaciones defensivas excesivas para no volver a la fobia perimetral
    deltas.edgePenalty = -15;
    deltas.cornerPenalty = -20;
    deltas.corridorPenalty = -30;
    deltas.deadEndPenalty = -50;
    if (maxLen >= 14) {
      deltas.coilingMultiplier = 0.05;
    }
    return { deltas, reason };
  }

  const details = diagnosis.details || {};

  switch (deathCause) {
    case "STARVATION":
      reason = `Inanición en T${turns}. Aumento de prioridad de alimento y descompresión de bordes/esquinas.`;
      deltas.foodBaseMultiplier = 15;
      deltas.foodHungryMultiplier = 20;
      deltas.foodEarlyMultiplier = 15;
      deltas.edgePenalty = -25;
      deltas.cornerPenalty = -25;
      deltas.coilingMultiplier = -0.05;
      break;

    case "HEAD_COLLISION":
      if (details.enemyLength && details.enemyLength > maxLen) {
        reason = `Choque frontal con rival superior en T${turns} (Len ${details.enemyLength} vs ${maxLen}). Impulso alimenticio temprano y prudencia.`;
        deltas.foodEarlyMultiplier = 15;
        deltas.foodBaseMultiplier = 10;
        deltas.foodHungryMultiplier = 10;
        deltas.threatProximityPenalty = 30;
        deltas.cutoffMultiplier = -0.05;
      } else {
        reason = `Choque frontal disputado en T${turns}. Aumento de distancia preventiva ante cabezas.`;
        deltas.threatProximityPenalty = 35;
        deltas.corridorPenalty = 40;
      }
      break;

    case "BODY_COLLISION":
      reason = `Colisión contra cuerpo (${details.collidedWith || "cuerpo"}) en T${turns}. Aumento de cautela en corredores y callejones.`;
      deltas.deadEndPenalty = 100;
      deltas.corridorPenalty = 60;
      deltas.wallSqueezePenalty = 50;
      deltas.coffinPenalty = 40;
      deltas.coilingMultiplier = -0.05;
      break;

    case "CORNER_TRAP":
      reason = `Acorralamiento en esquina en T${turns}. Incremento de penalización de bolsillo de esquina.`;
      deltas.cornerPocketPenalty = 40;
      deltas.cornerPenalty = 25;
      deltas.deadEndPenalty = 80;
      deltas.edgePenalty = -10;
      break;

    case "SPACE_EXHAUSTION":
      reason = `Agotamiento de espacio en T${turns}. Refuerzo de control territorial Voronoi, tail chase y crecimiento.`;
      deltas.spaceWeight = 2;
      deltas.tailBonus = 30;
      deltas.voronoiWeight = 2;
      deltas.voronoiNetWeight = 2;
      deltas.foodEarlyMultiplier = 10;
      deltas.coilingMultiplier = -0.05;
      break;

    case "WALL_COLLISION":
      reason = `Colisión contra pared en T${turns}. Aumento de penalización de muro y anti-squeeze.`;
      deltas.wallSqueezePenalty = 60;
      deltas.coffinPenalty = 50;
      deltas.edgePenalty = 30;
      deltas.partitionMultiplier = -0.05;
      break;

    default:
      reason = `Derrota general en T${turns}. Ajuste equilibrado.`;
      deltas.spaceWeight = 2;
      deltas.threatProximityPenalty = 20;
      deltas.foodEarlyMultiplier = 10;
      break;
  }

  return { deltas, reason };
}

/**
 * Ejecuta el ciclo completo de auto-tuning para una partida en vivo (evento /end).
 * @param {Object} endBody - Request payload de /end
 * @param {Array<Object>} turnHistory - Registro turno a turno de la partida
 * @returns {Object} Resultado del auto-tuning con cambios aplicados
 */
function tuneAfterLiveGame(endBody, turnHistory = []) {
  const diagnosis = analyzeLiveGame(endBody, turnHistory);
  const { deltas, reason } = calculateDeltas(diagnosis);

  const updateResult = updateWeights(deltas, reason, {
    outcome: diagnosis.outcome,
    turns: diagnosis.turns,
    fitness: diagnosis.fitness,
    deathCause: diagnosis.deathCause,
  });

  const changesSummary = Object.entries(updateResult.changes)
    .map(([k, c]) => `${k}: ${c.from} -> ${c.to} (${c.diff > 0 ? "+" : ""}${c.diff})`)
    .join(", ") || "Sin cambios (valores en límites)";

  const logMessage = `Partida #${getConfig().gamesPlayed} [${diagnosis.outcome}]: ${diagnosis.summary} | Fitness: ${diagnosis.fitness} | Cambios: ${changesSummary}`;
  console.log(`\n🧠 [AUTO-TUNER] ${logMessage}`);
  appendHistoryLog(logMessage);

  return {
    diagnosis,
    changes: updateResult.changes,
    currentWeights: updateResult.current,
    reason,
  };
}

/**
 * Ejecuta el auto-tuning a partir de un archivo NDJSON generado en simulaciones.
 * @param {string} logFilePath - Ruta al archivo logsX.json
 * @param {string} [snakeName='Culebra Cascabel'] - Nombre de nuestra serpiente
 * @returns {Object} Resultado del auto-tuning
 */
function tuneAfterNDJSONGame(logFilePath, snakeName = "Culebra Cascabel") {
  const diagnosis = analyzeNDJSONFile(logFilePath, snakeName);
  const { deltas, reason } = calculateDeltas(diagnosis);

  const updateResult = updateWeights(deltas, reason, {
    outcome: diagnosis.outcome,
    turns: diagnosis.turns,
    fitness: diagnosis.fitness,
    deathCause: diagnosis.deathCause,
  });

  const changesSummary = Object.entries(updateResult.changes)
    .map(([k, c]) => `${k}: ${c.from} -> ${c.to} (${c.diff > 0 ? "+" : ""}${c.diff})`)
    .join(", ") || "Sin cambios";

  const logMessage = `Simulación #${getConfig().gamesPlayed} [${diagnosis.outcome}]: ${diagnosis.summary} | Fitness: ${diagnosis.fitness} | Cambios: ${changesSummary}`;
  appendHistoryLog(logMessage);

  return {
    diagnosis,
    changes: updateResult.changes,
    currentWeights: updateResult.current,
    reason,
  };
}

/**
 * Registra eventos evolutivos en autotune_history.md
 */
function appendEvolutionLog(eventTitle, details = {}) {
  ensureLogsDir();
  const timestamp = new Date().toISOString();
  fs.appendFileSync(HISTORY_LOG_FILE, `[${timestamp}] [EVOLUCIÓN] ${eventTitle}\n`, "utf8");

  let mdContent = "";
  if (!fs.existsSync(HISTORY_MD_FILE)) {
    mdContent += "# 🧠 Historial de Auditoría de Auto-Tuning y Selección Natural\n\n";
  }

  mdContent += `### 🧬 [${timestamp}] ${eventTitle}\n\n`;
  if (details.summary) {
    mdContent += `> ${details.summary}\n\n`;
  }
  if (details.comparison) {
    mdContent += `| Métrica | Campeón Anterior | Candidato Evaluado | Resultado |\n`;
    mdContent += `| :--- | :---: | :---: | :---: |\n`;
    mdContent += `| **Win Rate** | ${details.comparison.champWinRate}% | ${details.comparison.candWinRate}% | ${details.accepted ? "✅ SUPERIOR" : "❌ INFERIOR"} |\n`;
    mdContent += `| **Fitness Promedio** | ${details.comparison.champFitness} | ${details.comparison.candFitness} | ${details.comparison.candFitness >= details.comparison.champFitness ? "📈 +" : "📉 -"} |\n\n`;
  }
  if (details.changes && Object.keys(details.changes).length > 0) {
    mdContent += "**Genes Mutados / Modificados:**\n";
    for (const [key, c] of Object.entries(details.changes)) {
      mdContent += `- \`${key}\`: \`${c.from}\` ➔ \`${c.to}\` (${c.diff > 0 ? "+" : ""}${c.diff})\n`;
    }
    mdContent += "\n";
  }
  fs.appendFileSync(HISTORY_MD_FILE, mdContent, "utf8");
}

/**
 * Evalúa estadísticamente si un Candidato supera al Campeón actual.
 * @param {{ winRate: number, avgFitness: number, totalGames: number, wins: number }} candidateStats
 * @param {{ winRate: number, fitness: number, generation: number }} champion
 * @param {{ toleranceMargin?: number }} [options={}]
 * @returns {{ accepted: boolean, verdict: string, reason: string }}
 */
function evaluateCandidateVersusChampion(candidateStats, champion, options = {}) {
  const tolerance = options.toleranceMargin || 0; // Margen de tolerancia
  const candWR = candidateStats.winRate;
  const champWR = champion.winRate || 0;
  const candFit = candidateStats.avgFitness;
  const champFit = champion.fitness || 0;

  let accepted = false;
  let verdict = "";
  let reason = "";

  if (candWR > champWR) {
    accepted = true;
    verdict = "CORONADO";
    reason = `Win Rate superior (${candWR}% vs ${champWR}%). El Candidato demostró superioridad estadística.`;
  } else if (candWR === champWR && candFit > champFit) {
    accepted = true;
    verdict = "CORONADO";
    reason = `Mismo Win Rate (${candWR}%), pero mayor Fitness promedio (${candFit} vs ${champFit}). Eficiencia optimizada.`;
  } else if (candWR >= champWR - tolerance && candFit >= champFit * 1.1) {
    // Caso especial de salto cualitativo de fitness con margen mínimo
    accepted = true;
    verdict = "CORONADO";
    reason = `Fitness significativamente mayor (+10%) con Win Rate dentro del margen de tolerancia (${candWR}% vs ${champWR}%).`;
  } else {
    accepted = false;
    verdict = "RECHAZADO";
    reason = `Rendimiento inferior o no concluyente (WR: ${candWR}% vs ${champWR}%, Fitness: ${candFit} vs ${champFit}). Se aplica Rollback inmediato.`;
  }

  return { accepted, verdict, reason };
}

module.exports = {
  calculateDeltas,
  tuneAfterLiveGame,
  tuneAfterNDJSONGame,
  appendHistoryLog,
  appendEvolutionLog,
  evaluateCandidateVersusChampion,
};
