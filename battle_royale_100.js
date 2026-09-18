#!/usr/bin/env node
/**
 * BATTLE ROYALE 100: Simulación de 100 partidas de 4 serpientes en tablero 11x11.
 * Evalúa el desempeño competitivo de Cascabel Actual frente a distintos perfiles de rivales.
 */

const { spawn } = require("child_process");
const express = require("express");
const { process_move, clear_game_history } = require("./index");
const {
  process_cascabel_v102_move,
  process_cascabel_v101_move,
  process_cascabel_v100_move,
  process_cascabel_v41_move,
} = require("./arena_entrenamiento");

const app = express();
app.use(express.json());

// Endpoint serpiente actual
app.post("/actual/move", (req, res) => res.json(process_move(req.body)));
app.post("/actual/start", (req, res) => {
  if (req.body?.game?.id) clear_game_history(req.body.game.id);
  res.status(200).send("ok");
});
app.post("/actual/end", (req, res) => {
  if (req.body?.game?.id) clear_game_history(req.body.game.id);
  res.status(200).send("ok");
});
app.get("/actual", (req, res) => res.json({ apiversion: "1", color: "#E70A77", head: "silly", tail: "mlh-gene" }));

// Endpoints rivales históricos
app.post("/v102/move", (req, res) => res.json(process_cascabel_v102_move(req.body)));
app.post("/v102/start", (req, res) => res.status(200).send("ok"));
app.post("/v102/end", (req, res) => res.status(200).send("ok"));
app.get("/v102", (req, res) => res.json({ apiversion: "1", color: "#6d28d9", head: "curled", tail: "curled" }));

app.post("/v101/move", (req, res) => res.json(process_cascabel_v101_move(req.body)));
app.post("/v101/start", (req, res) => res.status(200).send("ok"));
app.post("/v101/end", (req, res) => res.status(200).send("ok"));
app.get("/v101", (req, res) => res.json({ apiversion: "1", color: "#ef4444", head: "fang", tail: "sharp" }));

app.post("/v100/move", (req, res) => res.json(process_cascabel_v100_move(req.body)));
app.post("/v100/start", (req, res) => res.status(200).send("ok"));
app.post("/v100/end", (req, res) => res.status(200).send("ok"));
app.get("/v100", (req, res) => res.json({ apiversion: "1", color: "#f59e0b", head: "beluga", tail: "round-bum" }));

app.post("/v41/move", (req, res) => res.json(process_cascabel_v41_move(req.body)));
app.post("/v41/start", (req, res) => res.status(200).send("ok"));
app.post("/v41/end", (req, res) => res.status(200).send("ok"));
app.get("/v41", (req, res) => res.json({ apiversion: "1", color: "#10b981", head: "shades", tail: "bolt" }));

function runSingleBattleRoyale(port, snakes) {
  return new Promise((resolve, reject) => {
    const args = ["play", "-W", "11", "-H", "11"];
    for (const s of snakes) {
      args.push("-n", s.name, "-u", `http://localhost:${port}/${s.endpoint}`);
    }
    args.push("-d", "0", "-t", "500");

    const bs = spawn("./bin/battlesnake", args);
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

async function main() {
  const PORT = 8045;
  const server = app.listen(PORT);

  const TOTAL_GAMES = 100;
  console.log("\n" + "=".repeat(80));
  console.log("🎮 SIMULACIÓN DE 100 PARTIDAS BATTLE ROYALE 4P (11x11)");
  console.log("=".repeat(80));
  console.log(`📡 Servidor de simulación listo en http://localhost:${PORT}`);
  console.log(`🏟️  Formato: 4 Serpientes Simultáneas | Tablero: 11x11 Standard | Total: ${TOTAL_GAMES} partidas\n`);

  const currentSnake = { name: "Cascabel Actual", endpoint: "actual" };
  const botPool = [
    { name: "Cascabel v102 (Coiling/Hold)", endpoint: "v102" },
    { name: "Cascabel v101 (Muralla Slicer)", endpoint: "v101" },
    { name: "Cascabel v100 (Perimeter Jagwire)", endpoint: "v100" },
    { name: "Cascabel v41 (Glotón Rusher)", endpoint: "v41" },
  ];

  const results = {
    "Cascabel Actual": { wins: 0, totalTurns: 0 },
    "Cascabel v102 (Coiling/Hold)": { wins: 0, totalTurns: 0 },
    "Cascabel v101 (Muralla Slicer)": { wins: 0, totalTurns: 0 },
    "Cascabel v100 (Perimeter Jagwire)": { wins: 0, totalTurns: 0 },
    "Cascabel v41 (Glotón Rusher)": { wins: 0, totalTurns: 0 },
    Empate: { wins: 0, totalTurns: 0 },
  };

  let totalTurnsAll = 0;
  const startTime = Date.now();

  // Ejecutamos las 100 partidas con rotación de rivales para máxima diversidad táctica
  for (let i = 1; i <= TOTAL_GAMES; i++) {
    // 70% partidas con el cuarteto clásico (v102, v101, v100), 30% rotando con v41
    let matchSnakes = [currentSnake];
    if (i % 3 === 0) {
      matchSnakes.push(botPool[0], botPool[1], botPool[3]); // v102, v101, v41
    } else if (i % 3 === 1) {
      matchSnakes.push(botPool[0], botPool[2], botPool[3]); // v102, v100, v41
    } else {
      matchSnakes.push(botPool[0], botPool[1], botPool[2]); // v102, v101, v100
    }

    const res = await runSingleBattleRoyale(PORT, matchSnakes);
    totalTurnsAll += res.turns;

    if (results[res.winner]) {
      results[res.winner].wins++;
      results[res.winner].totalTurns += res.turns;
    } else {
      results["Empate"].wins++;
      results["Empate"].totalTurns += res.turns;
    }

    const icon = res.winner === currentSnake.name ? "👑" : res.winner === "Empate" ? "🤝" : "🐍";
    const paddedIndex = String(i).padStart(3, " ");
    const paddedTurns = String(res.turns).padStart(3, " ");
    
    // Mostramos reporte en vivo cada 5 partidas
    if (i % 5 === 0 || i === 1 || i === TOTAL_GAMES) {
      const currentWinRate = ((results["Cascabel Actual"].wins / i) * 100).toFixed(1);
      console.log(
        ` [Partida ${paddedIndex}/${TOTAL_GAMES}] (${paddedTurns} turnos) -> Ganador: ${icon} ${res.winner.padEnd(30, " ")} | WR Acumulado: ${currentWinRate}%`
      );
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  server.close();

  // -------------------------------------------------------------
  // ESTADÍSTICAS Y EVALUACIÓN FINAL
  // -------------------------------------------------------------
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
    const wr = ((data.wins / TOTAL_GAMES) * 100).toFixed(1);
    const avgWinTurns = data.wins > 0 ? (data.totalTurns / data.wins).toFixed(1) : "0";
    const bar = "█".repeat(Math.round(data.wins / 2));
    console.log(`   • ${name.padEnd(35, " ")}: ${String(data.wins).padStart(3, " ")} wins (${wr.padStart(5, " ")}%) | Prom: ${avgWinTurns.padStart(5, " ")} t | ${bar}`);
  }

  console.log("\n" + "=".repeat(80));
  if (actualWins >= 60) {
    console.log(`✅ VEREDICTO: ¡EXCELENTE! Culebra Cascabel está MÁS QUE LISTA para batallas reales 4x4 (${actualWR}% WR).`);
  } else if (actualWins >= 45) {
    console.log(`✅ VEREDICTO: ¡LISTA! Culebra Cascabel supera ampliamente el promedio competitivo esperado en 4P (25%) con ${actualWR}% WR.`);
  } else {
    console.log(`⚠️ VEREDICTO: RENDIMIENTO MODERADO (${actualWR}% WR). Se recomiendan ajustes adicionales.`);
  }
  console.log("=".repeat(80) + "\n");
}

main().catch(console.error);
