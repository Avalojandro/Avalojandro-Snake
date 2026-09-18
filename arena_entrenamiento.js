/**
 * @fileoverview Arena de Entrenamiento y Enfrentamiento Histórico para Battlesnake
 * Enfrenta a "Culebra Cascabel Actual" (con Ruptura de Bucle y todas las mejoras)
 * contra sus versiones anteriores de partidas reales:
 * - Cascabel v102 (Bucle Infinito / Coiler Conservador pre-ruptura)
 * - Cascabel v101 (Muralla Slicer Ofensivo / Partición de Tablero)
 * - Cascabel v100 (Jagwire Defensivo / Space Packer de Perímetro)
 * - Cascabel v41  (Glotón Crecimiento / Food Rusher)
 * 
 * Ejecutar con: node arena_entrenamiento.js
 */

const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const {
  process_move: process_cascabel_actual_move,
  get_safe_moves,
  evaluate_space,
  bfs_shortest_path,
  calculate_voronoi,
  calculate_coiling_bonus,
  calculate_cutoff_score,
  evaluate_board_partition,
  calculate_wall_slicing_bonus,
  detect_anti_partition_danger,
  is_tunnel_trap,
  is_wall_squeeze_risk,
  is_perimeter_coffin_trap,
  is_narrow_band_confinement,
  is_corner_pocket_trap,
  predict_enemy_moves,
  manhattan_distance,
  to_key,
  get_cardinal_neighbors,
  is_valid_coord,
} = require("./index");

// ==========================================
// 1. PERSONAS HISTÓRICAS DE NUESTRA SERPIENTE
// ==========================================

/**
 * Versión 102: La serpiente previa al cambio actual.
 * Excelente en Voronoi y Cut-off, pero NO tiene detector de bucles repetitivos.
 * Tiende a quedarse en círculos seguros (coiling / tail chasing) y muere de inanición ante bloqueos.
 */
function process_cascabel_v102_move(gameState) {
  const { board, you, turn } = gameState;
  const myLength = you.length;
  const myHead = you.head;
  const myTail = you.body[you.body.length - 1];

  const enemies = board.snakes.filter((s) => s.id !== you.id);
  const maxEnemyLength = enemies.length > 0 ? Math.max(...enemies.map((s) => s.length)) : 0;
  const isMultiSnake = enemies.length >= 2;
  const isDuel = enemies.length === 1;
  const isEarlyGame = turn < 35 && isMultiSnake;
  const isGiant = myLength >= 14;

  const { safeMoves, legalMoves, solidObstacles, lethalDangerZones, enemyHeads } = get_safe_moves(board, you);

  if (safeMoves.length === 0) {
    if (legalMoves.length > 0) return { move: legalMoves[0].move, shout: `v102 T${turn} Fallback` };
    return { move: "up", shout: `v102 T${turn} RIP` };
  }

  const extendedObstacles = new Set(solidObstacles);
  for (const dangerKey of lethalDangerZones) extendedObstacles.add(dangerKey);

  const movesEvaluated = safeMoves.map((m) => {
    const spaceInfo = evaluate_space(m.coord, extendedObstacles, board, myTail);
    const rawSpaceInfo = evaluate_space(m.coord, solidObstacles, board, myTail);
    const isTrap = is_tunnel_trap(m.coord, extendedObstacles, lethalDangerZones, board);
    const isSqueeze = is_wall_squeeze_risk(m.coord, enemies, board);
    const isCoffin = is_perimeter_coffin_trap(m.coord, myHead, enemies, board);
    const isConfinement = is_narrow_band_confinement(m.coord, you, board, enemies);

    const effectiveSpace = spaceInfo.count;
    const canReachTail = spaceInfo.canReachTail || rawSpaceInfo.canReachTail;
    const isViable = !isTrap && !isSqueeze && !isCoffin && !isConfinement && (effectiveSpace >= myLength || (rawSpaceInfo.count >= myLength && myLength >= 10 && canReachTail));

    return { ...m, space: effectiveSpace, canReachTail, isTrap, isSqueeze, isCoffin, isConfinement, isViable };
  });

  const strictlyViableMoves = movesEvaluated.filter((m) => m.isViable);
  let candidateMoves = strictlyViableMoves.length > 0 ? strictlyViableMoves : movesEvaluated;

  if (candidateMoves.length === 1) {
    return { move: candidateMoves[0].move, shout: `v102 T${turn} Unica` };
  }

  const isCriticalHunger = you.health <= 35;
  const isHungry = you.health < 80;
  const centerCoord = { x: Math.floor(board.width / 2), y: Math.floor(board.height / 2) };

  const scoredMoves = candidateMoves.map((cand) => {
    let score = cand.space * 25;
    if (cand.canReachTail) score += myLength >= 10 ? 450 : 250;

    const voronoi = calculate_voronoi(cand.coord, enemies, extendedObstacles, board);
    score += voronoi.myTerritory * 25;

    // Coiling obsesivo (propicia el bucle infinito)
    score += calculate_coiling_bonus(cand.coord, you, board);

    // Evasión de proximidad estricta (no se atreve a salir del bucle si el rival está cerca)
    if (isDuel) {
      for (const enemy of enemies) {
        if (enemy.length > myLength && manhattan_distance(cand.coord, enemy.head) === 2) {
          score -= 220;
        }
      }
    }

    if (isHungry && board.food && board.food.length > 0) {
      let nearestFoodDist = Infinity;
      for (const f of board.food) {
        const d = manhattan_distance(cand.coord, f);
        if (d < nearestFoodDist) nearestFoodDist = d;
      }
      score += (30 - nearestFoodDist) * 35;
    }

    return { ...cand, score };
  });

  scoredMoves.sort((a, b) => b.score - a.score);
  return { move: scoredMoves[0].move, shout: `v102 T${turn} Loop/Hold` };
}

/**
 * Versión 101: Particionador Agresivo (Muralla Slicer).
 * Obsesionado con cortar el mapa por la mitad y acorralar rivales.
 */
function process_cascabel_v101_move(gameState) {
  const { board, you, turn } = gameState;
  const { safeMoves, legalMoves, solidObstacles, lethalDangerZones } = get_safe_moves(board, you);
  const pool = safeMoves.length > 0 ? safeMoves : legalMoves;

  if (pool.length === 0) return { move: "up", shout: `v101 RIP` };
  if (pool.length === 1) return { move: pool[0].move, shout: `v101 Unico` };

  const enemies = board.snakes.filter((s) => s.id !== you.id);
  const mainEnemy = enemies[0];

  let bestMove = pool[0];
  let bestScore = -Infinity;

  for (const cand of pool) {
    let score = 0;
    const space = evaluate_space(cand.coord, solidObstacles, board, you.body[you.body.length - 1]);
    score += space.count * 20;

    if (mainEnemy) {
      // Bono masivo de Muralla Slicing
      const partition = evaluate_board_partition(cand.coord, you, mainEnemy, solidObstacles, board);
      score += partition.scoreBonus * 2.5;
      const wallBonus = calculate_wall_slicing_bonus(cand.coord, you, mainEnemy, solidObstacles, board);
      score += wallBonus * 2;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMove = cand;
    }
  }

  return { move: bestMove.move, shout: `v101 T${turn} MurallaSlicing` };
}

/**
 * Versión 100: Jagwire Defensivo (Perimeter Packer).
 * Se abraza a los bordes, busca empaquetar espacio ordenadamente.
 */
function process_cascabel_v100_move(gameState) {
  const { board, you, turn } = gameState;
  const { safeMoves, legalMoves, solidObstacles } = get_safe_moves(board, you);
  const pool = safeMoves.length > 0 ? safeMoves : legalMoves;

  if (pool.length === 0) return { move: "up", shout: `v100 RIP` };
  if (pool.length === 1) return { move: pool[0].move, shout: `v100 Unico` };

  let bestMove = pool[0];
  let bestScore = -Infinity;

  for (const cand of pool) {
    let score = 0;
    const space = evaluate_space(cand.coord, solidObstacles, board, you.body[you.body.length - 1]);
    score += space.count * 30;
    if (space.canReachTail) score += 350;

    // Preferencia por bordes y empaquetamiento
    const isEdge = cand.coord.x === 0 || cand.coord.x === board.width - 1 || cand.coord.y === 0 || cand.coord.y === board.height - 1;
    if (isEdge) score += 100;

    if (score > bestScore) {
      bestScore = score;
      bestMove = cand;
    }
  }

  return { move: bestMove.move, shout: `v100 T${turn} PerimeterPack` };
}

/**
 * Versión 41: Glotón de Crecimiento Rápido.
 * Devora comida a toda costa sin calcular trampas avanzadas.
 */
function process_cascabel_v41_move(gameState) {
  const { board, you, turn } = gameState;
  const { safeMoves, legalMoves, solidObstacles } = get_safe_moves(board, you);
  const pool = safeMoves.length > 0 ? safeMoves : legalMoves;

  if (pool.length === 0) return { move: "up", shout: `v41 RIP` };
  if (pool.length === 1) return { move: pool[0].move, shout: `v41 Unico` };

  let bestFood = null;
  let minFoodDist = Infinity;
  if (board.food && board.food.length > 0) {
    for (const f of board.food) {
      const d = manhattan_distance(you.head, f);
      if (d < minFoodDist) {
        minFoodDist = d;
        bestFood = f;
      }
    }
  }

  if (bestFood) {
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
    return { move: bestMove.move, shout: `v41 T${turn} FoodRush` };
  }

  return { move: pool[0].move, shout: `v41 T${turn} Wander` };
}

// ==========================================
// 2. SERVIDOR DE ARENA MULTI-PUERTO
// ==========================================

const app = express();
app.use(express.json());

// Serpiente Actual (Gran Maestro v103+)
app.get("/actual", (req, res) => res.json({ apiversion: "1", author: "Avalojandro", color: "#E70A77", head: "silly", tail: "mlh-gene" }));
app.post("/actual/start", (req, res) => res.send("ok"));
app.post("/actual/move", (req, res) => res.json(process_cascabel_actual_move(req.body)));
app.post("/actual/end", (req, res) => res.send("ok"));

// Serpiente v102 (Bucle / Pre-Ruptura)
app.get("/v102", (req, res) => res.json({ apiversion: "1", author: "Historical", color: "#6D28D9", head: "mlh-gene", tail: "mlh-gene" }));
app.post("/v102/start", (req, res) => res.send("ok"));
app.post("/v102/move", (req, res) => res.json(process_cascabel_v102_move(req.body)));
app.post("/v102/end", (req, res) => res.send("ok"));

// Serpiente v101 (Muralla Slicer)
app.get("/v101", (req, res) => res.json({ apiversion: "1", author: "Historical", color: "#00CCCC", head: "beluga", tail: "bolt" }));
app.post("/v101/start", (req, res) => res.send("ok"));
app.post("/v101/move", (req, res) => res.json(process_cascabel_v101_move(req.body)));
app.post("/v101/end", (req, res) => res.send("ok"));

// Serpiente v100 (Jagwire Perimeter)
app.get("/v100", (req, res) => res.json({ apiversion: "1", author: "Historical", color: "#FFE58F", head: "glasses", tail: "freckled" }));
app.post("/v100/start", (req, res) => res.send("ok"));
app.post("/v100/move", (req, res) => res.json(process_cascabel_v100_move(req.body)));
app.post("/v100/end", (req, res) => res.send("ok"));

// Serpiente v41 (Glotón Crecimiento)
app.get("/v41", (req, res) => res.json({ apiversion: "1", author: "Historical", color: "#00CC44", head: "eat-food", tail: "curled" }));
app.post("/v41/start", (req, res) => res.send("ok"));
app.post("/v41/move", (req, res) => res.json(process_cascabel_v41_move(req.body)));
app.post("/v41/end", (req, res) => res.send("ok"));

// ==========================================
// 3. MOTOR DE SIMULACIÓN Y TORNEO
// ==========================================

function playDuel(port, snake1, snake2) {
  return new Promise((resolve, reject) => {
    const bs = spawn("./bin/battlesnake", [
      "play",
      "-W", "11", "-H", "11",
      "-n", snake1.name, "-u", `http://localhost:${port}/${snake1.endpoint}`,
      "-n", snake2.name, "-u", `http://localhost:${port}/${snake2.endpoint}`,
      "-d", "0",
      "-t", "500",
    ]);

    let output = "";
    bs.stdout.on("data", (d) => output += d);
    bs.stderr.on("data", (d) => output += d);

    bs.on("close", (code) => {
      // Extraer ganador y turnos de la salida
      const winMatch = output.match(/Game completed after \d+ turns\.\s*(.+?)\s*was the winner\./i) || output.match(/(.+?)\s+was the winner\./i);
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

function playBattleRoyale(port, snakes) {
  return new Promise((resolve, reject) => {
    const args = ["play", "-W", "11", "-H", "11"];
    for (const s of snakes) {
      args.push("-n", s.name, "-u", `http://localhost:${port}/${s.endpoint}`);
    }
    args.push("-d", "0", "-t", "500");

    const bs = spawn("./bin/battlesnake", args);
    let output = "";
    bs.stdout.on("data", (d) => output += d);
    bs.stderr.on("data", (d) => output += d);

    bs.on("close", (code) => {
      const winMatch = output.match(/Game completed after \d+ turns\.\s*(.+?)\s*was the winner\./i) || output.match(/(.+?)\s+was the winner\./i);
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

async function runTrainingArena() {
  const PORT = 8030;
  const server = app.listen(PORT);

  console.log("\n================================================================================");
  console.log("⚔️  ARENA DE ENTRENAMIENTO HISTÓRICO: CASCABEL ACTUAL vs VERSIONES ANTERIORES");
  console.log("================================================================================");
  console.log(`📡 Servidor de bots listo en http://localhost:${PORT}\n`);

  const currentSnake = { name: "Cascabel Actual (v103+)", endpoint: "actual" };
  const opponents = [
    { name: "Cascabel v102 (Bucle / Pre-Ruptura)", endpoint: "v102", desc: "Coiling infinito y aversión a romper franjas" },
    { name: "Cascabel v101 (Muralla Slicer)", endpoint: "v101", desc: "Partición ofensiva agresiva de tablero" },
    { name: "Cascabel v100 (Jagwire Perimeter)", endpoint: "v100", desc: "Empaquetado defensivo en bordes" },
    { name: "Cascabel v41  (Glotón Crecimiento)", endpoint: "v41", desc: "Búsqueda ciega de comida" },
  ];

  const totalDuelGames = 10;
  const arenaStats = {
    totalPlayed: 0,
    totalWinsActual: 0,
    opponents: {},
  };

  const startTime = Date.now();

  // -------------------------------------------------------------
  // FASE 1: DUELOS 1v1 DIRECTOS CONTRA CADA VERSIÓN HISTÓRICA
  // -------------------------------------------------------------
  for (const opp of opponents) {
    console.log(`🥊 ENFRENTAMIENTO 1v1: ${currentSnake.name} vs ${opp.name}`);
    console.log(`   Perfil rival: ${opp.desc}`);
    console.log(`   Disputando ${totalDuelGames} partidas consecutivas...\n`);

    const stats = { winsActual: 0, winsRival: 0, draws: 0, totalTurns: 0 };

    for (let g = 1; g <= totalDuelGames; g++) {
      const res = await playDuel(PORT, currentSnake, opp);
      stats.totalTurns += res.turns;

      let icon = "❓";
      if (res.winner === currentSnake.name) {
        stats.winsActual++;
        arenaStats.totalWinsActual++;
        icon = "👑 [VICTORIA ACTUAL]";
      } else if (res.winner === opp.name) {
        stats.winsRival++;
        icon = "💀 [DERROTA]";
      } else {
        stats.draws++;
        icon = "🤝 [EMPATE]";
      }

      arenaStats.totalPlayed++;
      console.log(`   • Partida ${String(g).padStart(2, " ")}/${totalDuelGames} (${String(res.turns).padStart(3, " ")} turnos) -> Ganador: ${icon} ${res.winner}`);
    }

    const winRate = ((stats.winsActual / totalDuelGames) * 100).toFixed(1);
    const avgTurns = (stats.totalTurns / totalDuelGames).toFixed(1);
    arenaStats.opponents[opp.name] = { winRate, avgTurns, ...stats };

    console.log(`\n   📊 Balance vs ${opp.name}:`);
    console.log(`      Victorias Actual: ${stats.winsActual}/${totalDuelGames} (${winRate}%) | Victorias Rival: ${stats.winsRival} | Turnos Prom: ${avgTurns}`);
    console.log("--------------------------------------------------------------------------------\n");
  }

  // -------------------------------------------------------------
  // FASE 2: GRAN BATTLE ROYALE (4 SERPIENTES SIMULTÁNEAS)
  // -------------------------------------------------------------
  console.log("👑 FASE FINAL: BATTLE ROYALE (Cascabel Actual vs v102 vs v101 vs v100)");
  console.log("   10 Partidas todos contra todos a 4 bandas...\n");

  const brSnakes = [
    currentSnake,
    { name: "Cascabel v102", endpoint: "v102" },
    { name: "Cascabel v101", endpoint: "v101" },
    { name: "Cascabel v100", endpoint: "v100" },
  ];

  const brResults = { [currentSnake.name]: 0, "Cascabel v102": 0, "Cascabel v101": 0, "Cascabel v100": 0, "Empate": 0 };

  for (let g = 1; g <= 10; g++) {
    const res = await playBattleRoyale(PORT, brSnakes);
    if (brResults[res.winner] !== undefined) {
      brResults[res.winner]++;
    } else {
      brResults["Empate"]++;
    }
    const icon = res.winner === currentSnake.name ? "👑" : "🐍";
    console.log(`   • Royale ${String(g).padStart(2, " ")}/10 (${String(res.turns).padStart(3, " ")} turnos) -> Ganador: ${icon} ${res.winner}`);
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  server.close();

  // -------------------------------------------------------------
  // RESUMEN GLOBAL DE ENTRENAMIENTO
  // -------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(`🏆 RESUMEN GLOBAL DEL ENTRENAMIENTO HISTÓRICO (${arenaStats.totalPlayed + 10} partidas en ${durationSec}s)`);
  console.log("================================================================================");
  console.log(`🥇 Efectividad Global de Cascabel Actual en 1v1: ${arenaStats.totalWinsActual}/${arenaStats.totalPlayed} (${((arenaStats.totalWinsActual / arenaStats.totalPlayed) * 100).toFixed(1)}% de victorias)`);
  
  for (const [oppName, st] of Object.entries(arenaStats.opponents)) {
    console.log(`   • vs ${oppName.padEnd(35, " ")}: ${st.winRate}% WinRate (${st.winsActual}/${totalDuelGames}) | ${st.avgTurns} turnos prom.`);
  }

  console.log("\n🎮 Resultados Battle Royale (4P):");
  for (const [sName, wins] of Object.entries(brResults)) {
    console.log(`   • ${sName.padEnd(28, " ")}: ${wins}/10 victorias (${((wins / 10) * 100).toFixed(0)}%)`);
  }
  console.log("================================================================================\n");

  return arenaStats;
}

if (require.main === module) {
  runTrainingArena().catch(console.error);
}

module.exports = {
  app,
  process_cascabel_v102_move,
  process_cascabel_v101_move,
  process_cascabel_v100_move,
  process_cascabel_v41_move,
  runTrainingArena,
};
