#!/usr/bin/env node
/**
 * @fileoverview Ejecutor de Auto-Tuning Continuo para Battlesnake
 * Simula partidas automáticas contra el Campeón de la simulación anterior y variantes
 * con parámetros mutados/alterados (glotón, agresivo, muralla, defensivo, etc.).
 * Analiza los logs e inmendiatamente afina params.json.
 *
 * Uso:
 *   node autotune_runner.js [num_partidas]
 *   npm run autotune
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");

const { app: mainApp, process_move, clear_game_history } = require("../src/index");
const { getWeights, getConfig, resetToDefaults } = require("../src/param_manager");
const { tuneAfterNDJSONGame } = require("../src/autotuner");
const {
  process_cascabel_v102_move,
  process_cascabel_v101_move,
  process_cascabel_v100_move,
  process_cascabel_v41_move,
  process_mutante_move,
} = require("./arena_entrenamiento");

const PORT = 8015;
const serverApp = express();
serverApp.use(express.json());

const BOT_ENDPOINTS = {
  cascabel: { name: "Culebra Cascabel (Tuning)", fn: process_move },
  v102: { name: "Cascabel v102 (Coiling)", fn: process_cascabel_v102_move },
  v101: { name: "Cascabel v101 (Muralla)", fn: process_cascabel_v101_move },
  v100: { name: "Cascabel v100 (Perimeter)", fn: process_cascabel_v100_move },
  v41: { name: "Cascabel v41 (Glotón Rusher)", fn: process_cascabel_v41_move },
  mutante_gloton: { name: "Mutante Glotón", fn: (b) => process_mutante_move(b, "gloton") },
  mutante_agresivo: { name: "Mutante Agresivo", fn: (b) => process_mutante_move(b, "agresivo") },
  mutante_muralla: { name: "Mutante Muralla", fn: (b) => process_mutante_move(b, "muralla") },
  mutante_defensivo: { name: "Mutante Defensivo", fn: (b) => process_mutante_move(b, "defensivo") },
  mutante_random: { name: "Mutante Aleatorio", fn: (b) => process_mutante_move(b, "random") },
};

// Registrar endpoints
for (const [key, bot] of Object.entries(BOT_ENDPOINTS)) {
  serverApp.get(`/${key}`, (req, res) => res.json({ apiversion: "1", author: "avalojandro" }));
  serverApp.post(`/${key}/start`, (req, res) => {
    if (key === "cascabel" && req.body?.game?.id) clear_game_history(req.body.game.id);
    res.status(200).send("ok");
  });
  serverApp.post(`/${key}/move`, (req, res) => res.json(bot.fn(req.body)));
  serverApp.post(`/${key}/end`, (req, res) => {
    if (key === "cascabel" && req.body?.game?.id) clear_game_history(req.body.game.id);
    res.status(200).send("ok");
  });
}

function runMatch(outputLogPath, snakes) {
  return new Promise((resolve, reject) => {
    const args = ["play", "-W", "11", "-H", "11"];
    for (const s of snakes) {
      args.push("-n", s.name, "-u", `http://localhost:${PORT}/${s.endpoint}`);
    }
    args.push("-d", "0", "-t", "500", "-o", outputLogPath);

    const bs = spawn(path.join(__dirname, "../bin/battlesnake"), args);
    bs.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Battlesnake CLI falló con código ${code}`));
    });
    bs.on("error", reject);
  });
}

function selectAutotuneMatchSnakes(isDuel, previousWinnerEndpoint = null) {
  const mySnake = { name: "Culebra Cascabel", endpoint: "cascabel" };
  const availableRivalsKeys = Object.keys(BOT_ENDPOINTS).filter((k) => k !== "cascabel");

  const snakes = [mySnake];
  const selectedKeys = new Set();

  // Incluir obligatoriamente al Campeón de la partida anterior si fue un rival
  if (previousWinnerEndpoint && previousWinnerEndpoint !== "cascabel" && BOT_ENDPOINTS[previousWinnerEndpoint]) {
    snakes.push({
      name: `${BOT_ENDPOINTS[previousWinnerEndpoint].name} 👑 (Campeón Previo)`,
      endpoint: previousWinnerEndpoint,
    });
    selectedKeys.add(previousWinnerEndpoint);
  }

  const targetCount = isDuel ? 2 : 4;
  const shuffledRivals = [...availableRivalsKeys].sort(() => 0.5 - Math.random());

  for (const key of shuffledRivals) {
    if (snakes.length >= targetCount) break;
    if (!selectedKeys.has(key)) {
      snakes.push({
        name: BOT_ENDPOINTS[key].name,
        endpoint: key,
      });
      selectedKeys.add(key);
    }
  }

  return snakes;
}

const os = require("os");
const {
  getChampion,
  saveChampion,
  rollbackToChampion,
  setCandidateWeights,
  mutateWeights,
} = require("../src/param_manager");
const {
  appendEvolutionLog,
  evaluateCandidateVersusChampion,
} = require("../src/autotuner");

async function startAutoTuningSession(totalGames = 30, windowSize = 10) {
  const totalGenerations = Math.max(1, Math.ceil(totalGames / windowSize));

  console.log("================================================================================");
  console.log("🧬 MOTOR DE AUTO-TUNING EVOLUTIVO Y SELECCIÓN NATURAL (3 FASES)");
  console.log("================================================================================");
  console.log(`• Partidas totales programadas : ${totalGames}`);
  console.log(`• Tamaño de ventana (evaluación): ${windowSize} partidas / generación`);
  console.log(`• Generaciones estimadas        : ${totalGenerations}`);

  let currentChampion = getChampion();
  console.log(`• Campeón Inicial               : Gen #${currentChampion.generation} (WR Base: ${currentChampion.winRate}% | Fit: ${currentChampion.fitness})`);
  console.log("================================================================================\n");

  const server = serverApp.listen(PORT);
  const tmpDir = os.tmpdir();

  const globalStats = {
    totalGamesPlayed: 0,
    totalWins: 0,
    totalLosses: 0,
    totalDraws: 0,
    coronations: 0,
    rollbacks: 0,
    deathCauses: {},
  };

  let previousWinnerEndpoint = null;

  for (let gen = 1; gen <= totalGenerations; gen++) {
    const currentChamp = getChampion();

    console.log(`\n╔══════════════════════════════════════════════════════════════════════════════╗`);
    console.log(`║ 🧬 GENERACIÓN #${gen}/${totalGenerations} | Defensor: Campeón Gen #${currentChamp.generation} (WR: ${currentChamp.winRate}%)`);
    console.log(`╚══════════════════════════════════════════════════════════════════════════════╝`);

    // -------------------------------------------------------------
    // FASE 1: MUTACIÓN / GENERACIÓN DE CANDIDATO
    // -------------------------------------------------------------
    const mutation = mutateWeights(currentChamp.weights, null, 0.12);
    setCandidateWeights(mutation.weights);

    console.log(`🧪 [FASE 1: MUTACIÓN] Generando Candidato (Estrategia: ${mutation.type.toUpperCase()})`);
    const mutatedGenesList = Object.entries(mutation.changed)
      .map(([k, c]) => `\n     • ${k.padEnd(24, " ")}: ${c.from} ➔ ${c.to} (${c.diff > 0 ? "+" : ""}${c.diff})`)
      .join("");
    if (mutatedGenesList) {
      console.log(`   Genes mutados:${mutatedGenesList}`);
    } else {
      console.log(`   Genes mutados: Sin cambios notables en esta mutación.`);
    }

    // -------------------------------------------------------------
    // FASE 2: EVALUACIÓN EN VENTANA DE TORNEO
    // -------------------------------------------------------------
    console.log(`\n⚔️ [FASE 2: EVALUACIÓN] Iniciando Torneo de ${windowSize} partidas...`);

    const windowStats = {
      wins: 0,
      losses: 0,
      draws: 0,
      totalTurns: 0,
      fitnessSum: 0,
      deathCauses: {},
    };

    for (let match = 1; match <= windowSize; match++) {
      globalStats.totalGamesPlayed++;
      const gameIdx = (gen - 1) * windowSize + match;
      const logFile = path.join(tmpDir, `autotune_evo_${Date.now()}_${gen}_${match}.json`);
      const isDuel = match % 2 !== 0;

      const allSnakes = selectAutotuneMatchSnakes(isDuel, previousWinnerEndpoint);

      try {
        await runMatch(logFile, allSnakes);

        // Analizar partida y aplicar micro-afinaciones adaptativas
        const tuneResult = tuneAfterNDJSONGame(logFile, "Culebra Cascabel");
        const { diagnosis, changes, reason } = tuneResult;

        // Determinar ganador
        if (diagnosis.outcome === "WIN") {
          previousWinnerEndpoint = "cascabel";
          windowStats.wins++;
          globalStats.totalWins++;
        } else if (diagnosis.outcome === "DRAW") {
          windowStats.draws++;
          globalStats.totalDraws++;
        } else {
          windowStats.losses++;
          globalStats.totalLosses++;

          const content = fs.readFileSync(logFile, "utf8").trim();
          const lines = content.split("\n").filter(Boolean);
          if (lines.length >= 2) {
            const lastLineObj = JSON.parse(lines[lines.length - 1]);
            if (!lastLineObj.isDraw && lastLineObj.winnerName) {
              const rawWinnerName = lastLineObj.winnerName.replace(" 👑 (Campeón Previo)", "");
              const winningSnakeObj = allSnakes.find(
                (s) => s.name === lastLineObj.winnerName || s.name.replace(" 👑 (Campeón Previo)", "") === rawWinnerName
              );
              if (winningSnakeObj) previousWinnerEndpoint = winningSnakeObj.endpoint;
            }
          }
        }

        windowStats.totalTurns += diagnosis.turns;
        windowStats.fitnessSum += diagnosis.fitness;
        windowStats.deathCauses[diagnosis.deathCause] =
          (windowStats.deathCauses[diagnosis.deathCause] || 0) + 1;
        globalStats.deathCauses[diagnosis.deathCause] =
          (globalStats.deathCauses[diagnosis.deathCause] || 0) + 1;

        const icon = diagnosis.outcome === "WIN" ? "👑" : diagnosis.outcome === "DRAW" ? "🤝" : "💀";
        const currentWR = ((windowStats.wins / match) * 100).toFixed(1);
        const rivalsText = allSnakes.map((s) => s.name).join(" vs ");

        console.log(`  🎮 [P${match}/${windowSize} (Global #${gameIdx})] ${icon} [${diagnosis.outcome}] en T${diagnosis.turns} | WR Ventana: ${currentWR}% | ${diagnosis.summary}`);

        try {
          if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
        } catch (_) {}
      } catch (err) {
        console.error(`  ❌ Error en partida ${match}:`, err.message);
      }
    }

    // -------------------------------------------------------------
    // FASE 3: SELECCIÓN NATURAL & VEREDICTO
    // -------------------------------------------------------------
    const windowWinRate = parseFloat(((windowStats.wins / windowSize) * 100).toFixed(1));
    const windowAvgFitness = Math.round(windowStats.fitnessSum / windowSize);
    const windowAvgTurns = (windowStats.totalTurns / windowSize).toFixed(1);

    const evaluation = evaluateCandidateVersusChampion(
      {
        winRate: windowWinRate,
        avgFitness: windowAvgFitness,
        totalGames: windowSize,
        wins: windowStats.wins,
      },
      currentChamp
    );

    console.log(`\n⚖️ [FASE 3: SELECCIÓN NATURAL] Veredicto de la Generación #${gen}`);
    console.log(`   • Rendimiento Candidato : ${windowStats.wins}/${windowSize} victorias (${windowWinRate}%) | Fitness: ${windowAvgFitness} | Turnos: ${windowAvgTurns}`);
    console.log(`   • Rendimiento Campeón   : Win Rate: ${currentChamp.winRate}% | Fitness: ${currentChamp.fitness}`);

    if (evaluation.accepted) {
      globalStats.coronations++;
      const nextGen = (currentChamp.generation || 1) + 1;
      const newChamp = saveChampion({
        generation: nextGen,
        winRate: windowWinRate,
        fitness: windowAvgFitness,
        gamesEvaluated: windowSize,
        weights: getWeights(),
        notes: `Evolución ${mutation.type.toUpperCase()}: ${evaluation.reason}`,
      });

      console.log(`   🏆 ¡CANDIDATO CORONADO COMO NUEVO CAMPEÓN (Gen #${newChamp.generation})!`);
      console.log(`   📜 Motivo: ${evaluation.reason}`);

      appendEvolutionLog(`👑 Coronación de Nuevo Campeón (Gen #${newChamp.generation})`, {
        summary: `El Candidato de la Generación #${gen} superó al Campeón previo con ${windowWinRate}% WR.`,
        accepted: true,
        comparison: {
          champWinRate: currentChamp.winRate,
          candWinRate: windowWinRate,
          champFitness: currentChamp.fitness,
          candFitness: windowAvgFitness,
        },
        changes: mutation.changed,
      });
    } else {
      globalStats.rollbacks++;
      rollbackToChampion();

      console.log(`   ↩️ CANDIDATO RECHAZADO ➔ ROLLBACK AL CAMPEÓN (Gen #${currentChamp.generation})`);
      console.log(`   🛡️ Motivo: ${evaluation.reason} (Genoma intacto preservado en params.json)`);

      appendEvolutionLog(`↩️ Rollback de Candidato Rechazado (Gen #${gen})`, {
        summary: `El Candidato no superó el baseline del Campeón (${windowWinRate}% vs ${currentChamp.winRate}%). Se restauró el Campeón Gen #${currentChamp.generation}.`,
        accepted: false,
        comparison: {
          champWinRate: currentChamp.winRate,
          candWinRate: windowWinRate,
          champFitness: currentChamp.fitness,
          candFitness: windowAvgFitness,
        },
        changes: mutation.changed,
      });
    }
  }

  server.close();

  const finalChamp = getChampion();
  const globalWinRate = ((globalStats.totalWins / globalStats.totalGamesPlayed) * 100).toFixed(1);

  console.log("\n================================================================================");
  console.log("🏁 SESIÓN DE AUTO-TUNING EVOLUTIVO COMPLETADA CON ÉXITO");
  console.log("================================================================================");
  console.log(`• Partidas totales simuladas   : ${globalStats.totalGamesPlayed}`);
  console.log(`• Victorias globales           : ${globalStats.totalWins} (${globalWinRate}%)`);
  console.log(`• Coronaciones de Campeones    : ${globalStats.coronations}`);
  console.log(`• Rollbacks de protección      : ${globalStats.rollbacks}`);
  console.log(`• Campeón Final Activo         : Gen #${finalChamp.generation} (WR: ${finalChamp.winRate}% | Fit: ${finalChamp.fitness})`);
  console.log("• Distribución Global de Causas de Muerte:");
  for (const [cause, count] of Object.entries(globalStats.deathCauses)) {
    const pct = ((count / globalStats.totalGamesPlayed) * 100).toFixed(1);
    console.log(`    - ${cause.padEnd(20, " ")}: ${count} (${pct}%)`);
  }
  console.log("\n💾 Genoma del Campeón protegido y guardado en: params.json");
  console.log("================================================================================\n");

  return globalStats;
}

if (require.main === module) {
  const gamesCount = parseInt(process.argv[2], 10) || 20;
  const windowCount = parseInt(process.argv[3], 10) || 10;
  startAutoTuningSession(gamesCount, windowCount).catch(console.error);
}

module.exports = {
  startAutoTuningSession,
};
