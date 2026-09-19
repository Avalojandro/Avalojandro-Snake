#!/usr/bin/env node
/**
 * BATTLE ROYALE 100: Simulación de 100 partidas de 4 serpientes en tablero 11x11.
 * Enfrenta a Cascabel Actual contra el Campeón de la simulación anterior y variantes
 * aleatorias con parámetros alterados (Glotón, Agresiva, Muralla, Defensiva, Mutaciones).
 */

const { spawn } = require("child_process");
const express = require("express");
const path = require("path");
const { process_move, clear_game_history } = require("../src/index");
const {
  process_cascabel_v102_move,
  process_cascabel_v101_move,
  process_cascabel_v100_move,
  process_cascabel_v41_move,
  process_mutante_move,
} = require("./arena_entrenamiento");

const app = express();
app.use(express.json());

const BOT_ENDPOINTS = {
  actual: { name: "Cascabel Actual", color: "#E70A77", fn: process_move },
  v102: { name: "Cascabel v102 (Coiling)", color: "#6D28D9", fn: process_cascabel_v102_move },
  v101: { name: "Cascabel v101 (Muralla)", color: "#00CCCC", fn: process_cascabel_v101_move },
  v100: { name: "Cascabel v100 (Perimeter)", color: "#FFE58F", fn: process_cascabel_v100_move },
  v41: { name: "Cascabel v41 (Glotón Rusher)", color: "#00CC44", fn: process_cascabel_v41_move },
  mutante_gloton: { name: "Mutante Glotón", color: "#22c55e", fn: (b) => process_mutante_move(b, "gloton") },
  mutante_agresivo: { name: "Mutante Agresivo", color: "#ef4444", fn: (b) => process_mutante_move(b, "agresivo") },
  mutante_muralla: { name: "Mutante Muralla", color: "#3b82f6", fn: (b) => process_mutante_move(b, "muralla") },
  mutante_defensivo: { name: "Mutante Defensivo", color: "#8b5cf6", fn: (b) => process_mutante_move(b, "defensivo") },
  mutante_random: { name: "Mutante Aleatorio", color: "#ec4899", fn: (b) => process_mutante_move(b, "random") },
};

// Registrar endpoints
for (const [key, bot] of Object.entries(BOT_ENDPOINTS)) {
  app.get(`/${key}`, (req, res) => res.json({ apiversion: "1", color: bot.color }));
  app.post(`/${key}/start`, (req, res) => {
    if (key === "actual" && req.body?.game?.id) clear_game_history(req.body.game.id);
    res.status(200).send("ok");
  });
  app.post(`/${key}/move`, (req, res) => res.json(bot.fn(req.body)));
  app.post(`/${key}/end`, (req, res) => {
    if (key === "actual" && req.body?.game?.id) clear_game_history(req.body.game.id);
    res.status(200).send("ok");
  });
}

function runSingleBattleRoyale(port, snakes) {
  return new Promise((resolve, reject) => {
    const args = ["play", "-W", "11", "-H", "11"];
    for (const s of snakes) {
      args.push("-n", s.name, "-u", `http://localhost:${port}/${s.endpoint}`);
    }
    args.push("-d", "0", "-t", "500");

    const bs = spawn(path.join(__dirname, "../bin/battlesnake"), args);
    let output = "";
    bs.stdout.on("data", (d) => (output += d));
    bs.stderr.on("data", (d) => (output += d));

    bs.on("close", () => {
      const winMatch =
        output.match(/Game completed after \d+ turns\.\s*(.+?)\s*was the winner\./i) ||
        output.match(/(.+?)\s+was the winner\./i);
      const turnMatch = output.match(/Game completed after (\d+) turns/i);
      const isDraw = output.includes("Game completed") && !winMatch;

      let winner = "Empate";
      if (winMatch) {
        winner = winMatch[1].trim();
      } else if (isDraw) {
        winner = "Empate";
      } else {
        winner = "Desconocido";
      }

      const turns = turnMatch ? parseInt(turnMatch[1], 10) : 0;
      resolve({ winner, turns, isDraw: winner === "Empate" });
    });

    bs.on("error", reject);
  });
}

function pickRoyaleSnakes(previousWinnerEndpoint = null) {
  const currentSnake = { name: "Cascabel Actual", endpoint: "actual" };
  const availableKeys = Object.keys(BOT_ENDPOINTS).filter((k) => k !== "actual");

  const snakes = [currentSnake];
  const selected = new Set();

  // Campeón de la simulación anterior
  if (previousWinnerEndpoint && previousWinnerEndpoint !== "actual" && BOT_ENDPOINTS[previousWinnerEndpoint]) {
    snakes.push({
      name: `${BOT_ENDPOINTS[previousWinnerEndpoint].name} 👑 (Campeón Previo)`,
      endpoint: previousWinnerEndpoint,
    });
    selected.add(previousWinnerEndpoint);
  }

  const shuffled = [...availableKeys].sort(() => 0.5 - Math.random());
  for (const k of shuffled) {
    if (snakes.length >= 4) break;
    if (!selected.has(k)) {
      snakes.push({ name: BOT_ENDPOINTS[k].name, endpoint: k });
      selected.add(k);
    }
  }

  return snakes;
}

async function main() {
  const PORT = 8045;
  const server = app.listen(PORT);

  const TOTAL_GAMES = 100;
  console.log("\n" + "=".repeat(80));
  console.log("🎮 BATTLE ROYALE 100 CON CAMPEÓN PREVIO Y PARÁMETROS MUTADOS (11x11)");
  console.log("=".repeat(80));
  console.log(`📡 Servidor de simulación listo en http://localhost:${PORT}`);
  console.log(`🏟️  Formato: 4 Serpientes Simultáneas | Tablero: 11x11 Standard | Total: ${TOTAL_GAMES} partidas\n`);

  const results = {};
  for (const bot of Object.values(BOT_ENDPOINTS)) {
    results[bot.name] = { wins: 0, totalTurns: 0 };
  }
  results["Empate"] = { wins: 0, totalTurns: 0 };

  let totalTurnsAll = 0;
  let previousWinnerEndpoint = null;
  const startTime = Date.now();

  for (let i = 1; i <= TOTAL_GAMES; i++) {
    const matchSnakes = pickRoyaleSnakes(previousWinnerEndpoint);

    const res = await runSingleBattleRoyale(PORT, matchSnakes);
    totalTurnsAll += res.turns;

    let rawWinner = res.winner.replace(" 👑 (Campeón Previo)", "");
    const winSnakeObj = matchSnakes.find((s) => s.name === res.winner || s.name.replace(" 👑 (Campeón Previo)", "") === rawWinner);
    if (winSnakeObj) {
      previousWinnerEndpoint = winSnakeObj.endpoint;
    } else {
      previousWinnerEndpoint = null;
    }

    if (results[rawWinner]) {
      results[rawWinner].wins++;
      results[rawWinner].totalTurns += res.turns;
    } else {
      results["Empate"].wins++;
      results["Empate"].totalTurns += res.turns;
    }

    const icon = rawWinner === "Cascabel Actual" ? "👑" : rawWinner === "Empate" ? "🤝" : "🐍";
    const paddedIndex = String(i).padStart(3, " ");
    const paddedTurns = String(res.turns).padStart(3, " ");

    if (i % 5 === 0 || i === 1 || i === TOTAL_GAMES) {
      const currentWinRate = ((results["Cascabel Actual"].wins / i) * 100).toFixed(1);
      console.log(
        ` [Partida ${paddedIndex}/${TOTAL_GAMES}] (${paddedTurns} t) -> Ganador: ${icon} ${rawWinner.padEnd(25, " ")} | WR Actual: ${currentWinRate}%`
      );
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  server.close();

  console.log("\n" + "=".repeat(80));
  console.log(`🏆 RESULTADOS FINALES DE LAS 100 PARTIDAS BATTLE ROYALE (${durationSec}s)`);
  console.log("=".repeat(80));

  const actualWins = results["Cascabel Actual"].wins;
  const actualWR = ((actualWins / TOTAL_GAMES) * 100).toFixed(1);
  const avgTurns = (totalTurnsAll / TOTAL_GAMES).toFixed(1);

  console.log(`\n👑 CASCABEL ACTUAL:`);
  console.log(`   • Victorias: ${actualWins} de ${TOTAL_GAMES} (${actualWR}% WinRate)`);
  console.log(`   • Turnos promedio de partida: ${avgTurns} turnos`);

  console.log("\n📊 DESGLOSE DE TODOS LOS PARTICIPANTES:");
  const sorted = Object.entries(results).sort((a, b) => b[1].wins - a[1].wins);
  for (const [name, data] of sorted) {
    if (data.wins === 0 && name !== "Cascabel Actual") continue;
    const wr = ((data.wins / TOTAL_GAMES) * 100).toFixed(1);
    const avgWinTurns = data.wins > 0 ? (data.totalTurns / data.wins).toFixed(1) : "0";
    const bar = "█".repeat(Math.round((data.wins / TOTAL_GAMES) * 40));
    console.log(`   • ${name.padEnd(30, " ")}: ${String(data.wins).padStart(3, " ")} wins (${wr.padStart(5, " ")}%) | Prom: ${avgWinTurns.padStart(5, " ")} t | ${bar}`);
  }

  console.log("\n" + "=".repeat(80));
  if (actualWins >= 40) {
    console.log(`✅ VEREDICTO: ¡EXCELENTE! Culebra Cascabel domina el torneo dinámico contra campeones previos y mutaciones (${actualWR}% WR).`);
  } else if (actualWins >= 25) {
    console.log(`✅ VEREDICTO: ¡COMPETITIVA! Culebra Cascabel mantiene un nivel superior al promedio (25%) contra mutaciones y campeones.`);
  } else {
    console.log(`⚠️ VEREDICTO: RENDIMIENTO MODERADO (${actualWR}% WR). Se recomiendan ajustes de tuning.`);
  }
  console.log("=".repeat(80) + "\n");
}

main().catch(console.error);
