const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// Importar la lógica principal de Culebra Cascabel
const {
  process_move: process_cascabel_move,
  get_safe_moves,
  evaluate_space,
  bfs_shortest_path,
  manhattan_distance,
  is_valid_coord,
  to_key,
} = require("./index");

// ==========================================
// 1. VARIANTES DE BOTS DE PRUEBA
// ==========================================

/**
 * 1. Bot Random: Elige movimientos aleatorios entre las opciones seguras/legales.
 */
function process_random_move(gameState) {
  const { board, you, turn } = gameState;
  const { safeMoves, legalMoves } = get_safe_moves(board, you);
  const pool = safeMoves.length > 0 ? safeMoves : legalMoves;

  if (pool.length === 0) {
    return { move: "up", shout: `T${turn} Random RIP` };
  }

  const chosen = pool[Math.floor(Math.random() * pool.length)];
  return { move: chosen.move, shout: `T${turn} Random (${chosen.move})` };
}

/**
 * 2. Bot Glotón: Obsesionado con la comida, corre en línea recta o BFS hacia la comida más cercana.
 */
function process_gloton_move(gameState) {
  const { board, you, turn } = gameState;
  const { safeMoves, legalMoves, solidObstacles } = get_safe_moves(board, you);
  const pool = safeMoves.length > 0 ? safeMoves : legalMoves;

  if (pool.length === 0) {
    return { move: "up", shout: `T${turn} Glotón RIP` };
  }

  if (pool.length === 1) {
    return { move: pool[0].move, shout: `T${turn} ¡Comida única!` };
  }

  // Buscar la comida más cercana
  let bestFood = null;
  let minFoodDist = Infinity;

  if (board.food && board.food.length > 0) {
    for (const f of board.food) {
      const dist = manhattan_distance(you.head, f);
      if (dist < minFoodDist) {
        minFoodDist = dist;
        bestFood = f;
      }
    }
  }

  if (bestFood) {
    // Evaluar cada candidato buscando minimizar distancia a la comida
    let bestMove = pool[0];
    let bestDist = Infinity;

    for (const cand of pool) {
      const path = bfs_shortest_path(cand.coord, bestFood, solidObstacles, board);
      const dist = path ? path.distance : manhattan_distance(cand.coord, bestFood) + 10;
      if (dist < bestDist) {
        bestDist = dist;
        bestMove = cand;
      }
    }

    return { move: bestMove.move, shout: `T${turn} ¡Comida a ${bestDist} paso(s)!` };
  }

  // Si no hay comida, ir hacia el centro
  const center = { x: Math.floor(board.width / 2), y: Math.floor(board.height / 2) };
  let bestMove = pool[0];
  let bestCenterDist = Infinity;
  for (const cand of pool) {
    const dist = manhattan_distance(cand.coord, center);
    if (dist < bestCenterDist) {
      bestCenterDist = dist;
      bestMove = cand;
    }
  }

  return { move: bestMove.move, shout: `T${turn} Buscando comida...` };
}

/**
 * 3. Bot Defensivo: Conservador, maximiza espacio libre, huye de otros y busca su cola.
 */
function process_defensivo_move(gameState) {
  const { board, you, turn } = gameState;
  const { safeMoves, legalMoves, solidObstacles, lethalDangerZones } = get_safe_moves(board, you);
  const pool = safeMoves.length > 0 ? safeMoves : legalMoves;

  if (pool.length === 0) {
    return { move: "up", shout: `T${turn} Defensivo RIP` };
  }

  if (pool.length === 1) {
    return { move: pool[0].move, shout: `T${turn} Vía defensiva` };
  }

  const enemies = board.snakes.filter((s) => s.id !== you.id);
  const myTail = you.body[you.body.length - 1];

  let bestMove = pool[0];
  let bestScore = -Infinity;

  for (const cand of pool) {
    let score = 0;
    const spaceInfo = evaluate_space(cand.coord, solidObstacles, board, myTail);

    // 1. Espacio accesible
    score += spaceInfo.count * 30;

    // 2. Conectividad con la cola
    if (spaceInfo.canReachTail) score += 200;

    // 3. Evasión de proximidad de todos los rivales
    for (const enemy of enemies) {
      const distToEnemyHead = manhattan_distance(cand.coord, enemy.head);
      if (distToEnemyHead <= 2) score -= 400;
      else if (distToEnemyHead === 3) score -= 150;
    }

    // 4. Solo comer si salud < 30
    if (you.health < 30 && board.food && board.food.length > 0) {
      let nearestFoodDist = Infinity;
      for (const f of board.food) {
        const d = manhattan_distance(cand.coord, f);
        if (d < nearestFoodDist) nearestFoodDist = d;
      }
      score += (20 - nearestFoodDist) * 20;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMove = cand;
    }
  }

  return { move: bestMove.move, shout: `T${turn} Defendiendo (Esp:${bestScore})` };
}

// ==========================================
// 2. SERVIDOR EXPRESS MULTI-BOT
// ==========================================

const app = express();
app.use(express.json());

// Bot 1: Culebra Cascabel (Principal)
app.get("/cascabel", (req, res) => res.json({ apiversion: "1", author: "Avalojandro", color: "#E70A77", head: "silly", tail: "mlh-gene" }));
app.post("/cascabel/start", (req, res) => res.send("ok"));
app.post("/cascabel/move", (req, res) => res.json(process_cascabel_move(req.body)));
app.post("/cascabel/end", (req, res) => res.send("ok"));

// Bot 2: Bot Random
app.get("/random", (req, res) => res.json({ apiversion: "1", author: "TestBot", color: "#888888", head: "pixel", tail: "pixel" }));
app.post("/random/start", (req, res) => res.send("ok"));
app.post("/random/move", (req, res) => res.json(process_random_move(req.body)));
app.post("/random/end", (req, res) => res.send("ok"));

// Bot 3: Bot Glotón
app.get("/gloton", (req, res) => res.json({ apiversion: "1", author: "TestBot", color: "#00CC44", head: "eat-food", tail: "curled" }));
app.post("/gloton/start", (req, res) => res.send("ok"));
app.post("/gloton/move", (req, res) => res.json(process_gloton_move(req.body)));
app.post("/gloton/end", (req, res) => res.send("ok"));

// Bot 4: Bot Defensivo
app.get("/defensivo", (req, res) => res.json({ apiversion: "1", author: "TestBot", color: "#3366FF", head: "safe", tail: "round-bum" }));
app.post("/defensivo/start", (req, res) => res.send("ok"));
app.post("/defensivo/move", (req, res) => res.json(process_defensivo_move(req.body)));
app.post("/defensivo/end", (req, res) => res.send("ok"));

// ==========================================
// 3. EJECUTOR DE TORNEO (75 PARTIDAS)
// ==========================================

function runSingleGame(port, outputFile) {
  return new Promise((resolve, reject) => {
    const bs = spawn("./bin/battlesnake", [
      "play",
      "-W", "11",
      "-H", "11",
      "-n", "Culebra Cascabel", "-u", `http://localhost:${port}/cascabel`,
      "-n", "Bot Random", "-u", `http://localhost:${port}/random`,
      "-n", "Bot Gloton", "-u", `http://localhost:${port}/gloton`,
      "-n", "Bot Defensivo", "-u", `http://localhost:${port}/defensivo`,
      "-d", "0",
      "-t", "500",
      "-o", outputFile,
    ]);

    bs.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Battlesnake falló con código ${code}`));
    });

    bs.on("error", (err) => reject(err));
  });
}

async function runTournament(totalGames = 75, startLogNum = 23) {
  const PORT = 8010;
  const server = app.listen(PORT);

  console.log(`\n🏆 INICIANDO TORNEO MULTI-BOT (4 SERPIENTES x ${totalGames} PARTIDAS)...`);
  console.log(`📍 Servidor de bots activo en http://localhost:${PORT}\n`);

  const results = {
    "Culebra Cascabel": { wins: 0, totalTurns: 0, totalMaxLen: 0, deaths: {} },
    "Bot Random": { wins: 0, totalTurns: 0, totalMaxLen: 0, deaths: {} },
    "Bot Gloton": { wins: 0, totalTurns: 0, totalMaxLen: 0, deaths: {} },
    "Bot Defensivo": { wins: 0, totalTurns: 0, totalMaxLen: 0, deaths: {} },
    "Empates/SinGanador": 0,
  };

  const logsDir = "./logs";
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const startTime = Date.now();

  for (let i = 0; i < totalGames; i++) {
    const logIndex = startLogNum + i;
    const logFileName = `logs${logIndex}.json`;
    const logFilePath = path.join(logsDir, logFileName);

    try {
      await runSingleGame(PORT, logFilePath);

      // Leer el resultado del juego desde el NDJSON
      const content = fs.readFileSync(logFilePath, "utf8").trim();
      const lines = content.split("\n").filter(Boolean);

      if (lines.length < 2) {
        throw new Error("Archivo de log incompleto o vacío");
      }

      const lastLineObj = JSON.parse(lines[lines.length - 1]);
      const lastBoardFrame = JSON.parse(lines[lines.length - 2]);
      const turn = lastBoardFrame.turn || 0;

      let winnerName = "Empates/SinGanador";
      if (!lastLineObj.isDraw && lastLineObj.winnerName) {
        winnerName = lastLineObj.winnerName;
      }

      if (results[winnerName]) {
        results[winnerName].wins++;
      } else {
        results["Empates/SinGanador"]++;
      }

      // Rastrear estadísticas individuales
      const snakeGameStats = {};
      for (let f = 1; f < lines.length - 1; f++) {
        const frame = JSON.parse(lines[f]);
        for (const s of frame.board.snakes) {
          if (!snakeGameStats[s.name]) {
            snakeGameStats[s.name] = { maxLen: s.length, lastTurn: frame.turn, lastHealth: s.health };
          }
          if (s.length > snakeGameStats[s.name].maxLen) {
            snakeGameStats[s.name].maxLen = s.length;
          }
          snakeGameStats[s.name].lastTurn = frame.turn;
          snakeGameStats[s.name].lastHealth = s.health;
        }
      }

      for (const [sName, sData] of Object.entries(snakeGameStats)) {
        if (results[sName]) {
          results[sName].totalTurns += sData.lastTurn;
          results[sName].totalMaxLen += sData.maxLen;
          if (sName !== winnerName) {
            const reason = sData.lastHealth <= 0 ? "hambre" : "colision/encerrona";
            results[sName].deaths[reason] = (results[sName].deaths[reason] || 0) + 1;
          }
        }
      }

      const icon = winnerName === "Culebra Cascabel" ? "👑" : "🐍";
      const progress = `[${String(i + 1).padStart(2, " ")}/${totalGames}]`;
      console.log(`${progress} Partida ${logFileName} (Turno ${String(turn).padStart(3, " ")}) -> Ganador: ${icon} ${winnerName}`);
    } catch (err) {
      console.error(`❌ Error en partida ${logFileName}:`, err.message);
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  server.close();

  console.log("\n=======================================================");
  console.log(`📊 RESULTADOS FINALES DEL TORNEO (${totalGames} PARTIDAS en ${durationSec}s)`);
  console.log("=======================================================");
  for (const [name, stats] of Object.entries(results)) {
    if (name === "Empates/SinGanador") {
      console.log(`• ${name}: ${stats} partida(s)`);
    } else {
      const winRate = ((stats.wins / totalGames) * 100).toFixed(1);
      const avgTurns = (stats.totalTurns / totalGames).toFixed(1);
      const avgMaxLen = (stats.totalMaxLen / totalGames).toFixed(1);
      console.log(`• ${name.padEnd(18, " ")}: ${String(stats.wins).padStart(2, " ")} victorias (${winRate.padStart(5, " ")}%) | Turnos prom: ${avgTurns.padStart(5, " ")} | Longitud prom: ${avgMaxLen.padStart(4, " ")} | Muertes: ${JSON.stringify(stats.deaths)}`);
    }
  }
  console.log("=======================================================\n");

  return results;
}

if (require.main === module) {
  runTournament(75, 23).catch(console.error);
}

module.exports = {
  app,
  process_random_move,
  process_gloton_move,
  process_defensivo_move,
  runTournament,
};
