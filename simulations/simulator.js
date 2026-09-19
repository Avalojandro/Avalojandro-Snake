const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// Importar lógica de Cascabel y variantes
const { process_move: process_cascabel_move } = require("../src/index");
const {
  process_cascabel_v102_move,
  process_cascabel_v101_move,
  process_cascabel_v100_move,
  process_cascabel_v41_move,
  process_mutante_move,
} = require("./arena_entrenamiento");

// ==========================================
// 1. SERVIDOR EXPRESS CON VARIANTES HISTÓRICAS Y MUTANTES
// ==========================================

const app = express();
app.use(express.json());

const BOT_ENDPOINTS = {
  cascabel: { name: "Cascabel Actual", color: "#E70A77", fn: process_cascabel_move },
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

// Registrar endpoints para cada variante
for (const [key, bot] of Object.entries(BOT_ENDPOINTS)) {
  app.get(`/${key}`, (req, res) => res.json({ apiversion: "1", author: "Avalojandro", color: bot.color }));
  app.post(`/${key}/start`, (req, res) => res.send("ok"));
  app.post(`/${key}/move`, (req, res) => res.json(bot.fn(req.body)));
  app.post(`/${key}/end`, (req, res) => res.send("ok"));
}

// ==========================================
// 2. EJECUTOR DE SIMULACIONES Y GENERADOR DE REPORTE MARKDOWN
// ==========================================

function runMatch(port, snakes) {
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

      let winner = "Empates/SinGanador";
      if (winMatch) {
        winner = winMatch[1].trim();
      } else if (isDraw) {
        winner = "Empates/SinGanador";
      }

      const turns = turnMatch ? parseInt(turnMatch[1], 10) : 0;
      resolve({ winner, turns, isDraw: winner === "Empates/SinGanador" });
    });

    bs.on("error", reject);
  });
}

function pickMatchSnakes(previousWinnerEndpoint = null) {
  const snakes = [{ name: BOT_ENDPOINTS.cascabel.name, endpoint: "cascabel" }];
  const availableRivalsKeys = Object.keys(BOT_ENDPOINTS).filter((k) => k !== "cascabel");
  const selectedKeys = new Set();

  if (previousWinnerEndpoint && previousWinnerEndpoint !== "cascabel" && BOT_ENDPOINTS[previousWinnerEndpoint]) {
    snakes.push({
      name: `${BOT_ENDPOINTS[previousWinnerEndpoint].name} 👑 (Campeón Previo)`,
      endpoint: previousWinnerEndpoint,
    });
    selectedKeys.add(previousWinnerEndpoint);
  }

  const shuffledRivals = [...availableRivalsKeys].sort(() => 0.5 - Math.random());
  for (const key of shuffledRivals) {
    if (snakes.length >= 4) break;
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

async function runTournament(totalGames = 75) {
  const PORT = 8010;
  const server = app.listen(PORT);

  console.log("\n================================================================================");
  console.log(`TORNEO CONTINUO CONTRA CAMPEON PREVIO Y VARIANTES MUTADAS (${totalGames} PARTIDAS)`);
  console.log("================================================================================");
  console.log(`Servidor activo en http://localhost:${PORT}\n`);

  const results = {};
  for (const bot of Object.values(BOT_ENDPOINTS)) {
    results[bot.name] = { wins: 0, totalTurns: 0 };
  }
  results["Empates/SinGanador"] = { wins: 0, totalTurns: 0 };

  const gameHistory = [];
  let previousWinnerEndpoint = null;
  const startTime = Date.now();

  for (let i = 1; i <= totalGames; i++) {
    const matchSnakes = pickMatchSnakes(previousWinnerEndpoint);

    try {
      const res = await runMatch(PORT, matchSnakes);

      let rawWinnerName = "Empates/SinGanador";
      if (!res.isDraw && res.winner) {
        rawWinnerName = res.winner.replace(" 👑 (Campeón Previo)", "");
      }

      const winningSnakeObj = matchSnakes.find((s) => s.name === res.winner || s.name.replace(" 👑 (Campeón Previo)", "") === rawWinnerName);
      if (winningSnakeObj) {
        previousWinnerEndpoint = winningSnakeObj.endpoint;
      } else {
        previousWinnerEndpoint = null;
      }

      if (results[rawWinnerName]) {
        results[rawWinnerName].wins++;
        results[rawWinnerName].totalTurns += res.turns;
      } else {
        results["Empates/SinGanador"].wins++;
      }

      const prevChampName = matchSnakes.find((s) => s.name.includes("(Campeón Previo)"))?.name || "N/A";
      const rivalsText = matchSnakes.map((s) => s.name).join(" vs ");
      
      gameHistory.push({
        gameNum: i,
        turns: res.turns,
        winner: rawWinnerName,
        prevChamp: prevChampName,
        matchup: rivalsText,
      });

      const icon = rawWinnerName === "Cascabel Actual" ? "👑" : rawWinnerName === "Empates/SinGanador" ? "🤝" : "🐍";
      const progress = `[${String(i).padStart(2, " ")}/${totalGames}]`;
      console.log(`${progress} Partida (T:${String(res.turns).padStart(3, " ")}) -> Ganador: ${icon} ${rawWinnerName.padEnd(25, " ")} | Rivales: ${rivalsText}`);
    } catch (err) {
      console.error(`❌ Error en partida ${i}:`, err.message);
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  server.close();

  // -------------------------------------------------------------
  // GENERAR REPORTE MARKDOWN EN logs/simulation_report.md
  // -------------------------------------------------------------
  const logsDir = path.join(__dirname, "../logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const reportPath = path.join(logsDir, "simulation_report.md");
  const timestamp = new Date().toISOString();

  let md = `# 🏆 Reporte de Simulación de Battlesnake\n\n`;
  md += `- **Fecha de Ejecución:** \`${timestamp}\`\n`;
  md += `- **Total de Partidas:** ${totalGames}\n`;
  md += `- **Duración Total:** ${durationSec}s\n\n`;

  md += `## 📊 Tabla de Posiciones y Desempeño\n\n`;
  md += `| Posición | Serpiente / Variante | Victorias | Win Rate % | Promedio Turnos |\n`;
  md += `| :---: | :--- | :---: | :---: | :---: |\n`;

  const sorted = Object.entries(results).sort((a, b) => (b[1].wins || 0) - (a[1].wins || 0));
  let rank = 1;

  for (const [name, data] of sorted) {
    if (data.wins === 0 && name !== "Cascabel Actual") continue;
    const wr = ((data.wins / totalGames) * 100).toFixed(1);
    const avgT = data.wins > 0 ? (data.totalTurns / data.wins).toFixed(1) : "0";
    const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `${rank}`;
    md += `| ${medal} | **${name}** | ${data.wins} | ${wr}% | ${avgT} |\n`;
    rank++;
  }

  md += `\n---\n\n`;
  md += `## 🎮 Historial Partida por Partida\n\n`;
  md += `| Partida | Turnos | Ganador | Campeón Defensor Previo | Enfrentamiento |\n`;
  md += `| :---: | :---: | :--- | :--- | :--- |\n`;

  for (const g of gameHistory) {
    const icon = g.winner === "Cascabel Actual" ? "👑" : "🐍";
    md += `| #${g.gameNum} | ${g.turns} | ${icon} **${g.winner}** | ${g.prevChamp} | ${g.matchup} |\n`;
  }

  fs.writeFileSync(reportPath, md, "utf8");
  console.log(`\n📝 Reporte Markdown guardado en: logs/simulation_report.md`);

  console.log("\n================================================================================");
  console.log(`RESULTADOS FINALES DE SIMULACION Y TORNEO (${totalGames} PARTIDAS en ${durationSec}s)`);
  console.log("================================================================================");

  for (const [name, data] of sorted) {
    if (data.wins === 0 && name !== "Cascabel Actual") continue;
    const wr = ((data.wins / totalGames) * 100).toFixed(1);
    const bar = "█".repeat(Math.round((data.wins / totalGames) * 40));
    console.log(` • ${name.padEnd(30, " ")}: ${String(data.wins).padStart(3, " ")} victorias (${wr.padStart(5, " ")}%) | ${bar}`);
  }
  console.log("================================================================================\n");

  return results;
}

if (require.main === module) {
  runTournament(75).catch(console.error);
}

module.exports = {
  app,
  runTournament,
  pickMatchSnakes,
  BOT_ENDPOINTS,
};
