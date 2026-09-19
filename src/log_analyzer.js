/**
 * @fileoverview Analizador Diagnóstico de Logs de Battlesnake
 * Extrae causas de muerte, desempeño, métricas de supervivencia y fitness de cada partida.
 */

const fs = require("fs");

/**
 * @typedef {Object} GameDiagnosis
 * @property {string} outcome - 'WIN' | 'LOSS' | 'DRAW'
 * @property {string} deathCause - 'ALIVE' | 'STARVATION' | 'HEAD_COLLISION' | 'BODY_COLLISION' | 'WALL_COLLISION' | 'CORNER_TRAP' | 'SPACE_EXHAUSTION'
 * @property {number} turns - Turnos sobrevividos
 * @property {number} maxLen - Longitud máxima alcanzada
 * @property {number} finalHealth - Salud final al morir o ganar
 * @property {number} fitness - Puntuación numérica ponderada de desempeño
 * @property {string} summary - Explicación humana detallada del diagnóstico
 * @property {Object} details - Datos complementarios de la jugada final
 */

/**
 * Diagnostica una partida analizando la carga útil del evento /end de Battlesnake
 * junto con el historial en memoria de la partida.
 * @param {Object} endBody - Request body de app.post('/end')
 * @param {Array<Object>} [turnHistory=[]] - Historial de turnos registrados en /move
 * @returns {GameDiagnosis}
 */
function analyzeLiveGame(endBody, turnHistory = []) {
  const { board, you, turn = 0 } = endBody || {};
  if (!you) {
    return {
      outcome: "UNKNOWN",
      deathCause: "UNKNOWN",
      turns: turn,
      maxLen: 3,
      finalHealth: 0,
      fitness: 0,
      summary: "Sin datos del jugador 'you' en el evento /end",
      details: {},
    };
  }

  const myId = you.id;
  const myName = you.name || "Culebra Cascabel";
  const survivingSnakes = (board?.snakes || []).filter((s) => s.health > 0);
  const isMeSurviving = survivingSnakes.some((s) => s.id === myId);

  let outcome = "LOSS";
  if (isMeSurviving && survivingSnakes.length === 1) {
    outcome = "WIN";
  } else if (isMeSurviving && survivingSnakes.length > 1) {
    outcome = "DRAW";
  }

  // Calcular longitud máxima
  let maxLen = you.length || 3;
  if (turnHistory && turnHistory.length > 0) {
    for (const h of turnHistory) {
      if (h.length && h.length > maxLen) maxLen = h.length;
    }
  }

  let deathCause = "ALIVE";
  let summary = "";
  const details = {
    turn,
    maxLen,
    finalHealth: you.health,
    snakesLeft: survivingSnakes.length,
  };

  if (outcome === "WIN") {
    deathCause = "ALIVE";
    summary = `🏆 Victoria absoluta en el Turno ${turn}. Longitud máxima: ${maxLen}.`;
  } else {
    // Diagnóstico de la causa de muerte
    if (you.health <= 0) {
      deathCause = "STARVATION";
      summary = `💀 Muerte por Inanición (Hambre) en el Turno ${turn}. Salud llegó a 0 sin alcanzar comida a tiempo.`;
    } else {
      // Analizar posición final de la cabeza
      const head = you.head || (you.body && you.body[0]);
      const isWall = head && (head.x < 0 || head.x >= board.width || head.y < 0 || head.y >= board.height);
      const isCorner = head && (head.x === 0 || head.x === board.width - 1) && (head.y === 0 || head.y === board.height - 1);

      const enemies = (board?.snakes || []).filter((s) => s.id !== myId);
      let headCollision = false;
      for (const enemy of enemies) {
        if (!enemy.head) continue;
        const dist = Math.abs(head.x - enemy.head.x) + Math.abs(head.y - enemy.head.y);
        if (dist <= 1 && enemy.length >= you.length) {
          headCollision = true;
          details.collidedWith = enemy.name;
          details.enemyLength = enemy.length;
          break;
        }
      }

      let bodyCollision = false;
      for (const enemy of enemies) {
        if (enemy.body && enemy.body.some((b) => b.x === head.x && b.y === head.y)) {
          bodyCollision = true;
          details.collidedWith = enemy.name;
          break;
        }
      }
      if (!bodyCollision && you.body && you.body.slice(1).some((b) => b.x === head.x && b.y === head.y)) {
        bodyCollision = true;
        details.collidedWith = "Cuerpo Propio";
      }

      if (headCollision) {
        deathCause = "HEAD_COLLISION";
        summary = `💥 Muerte por Choque Frontal en Turno ${turn} contra ${details.collidedWith} (Longitud ${details.enemyLength} vs nuestra ${you.length}).`;
      } else if (isWall) {
        deathCause = "WALL_COLLISION";
        summary = `🧱 Muerte por Choque contra Pared en Turno ${turn} en (${head.x},${head.y}).`;
      } else if (bodyCollision) {
        deathCause = "BODY_COLLISION";
        summary = `🚗 Muerte por Impacto contra Cuerpo en Turno ${turn} (${details.collidedWith}).`;
      } else if (isCorner) {
        deathCause = "CORNER_TRAP";
        summary = `📦 Muerte por Acorralamiento en Esquina en Turno ${turn} en (${head.x},${head.y}).`;
      } else {
        deathCause = "SPACE_EXHAUSTION";
        summary = `🪤 Muerte por Falta de Espacio o Encierro en Turno ${turn}.`;
      }
    }
  }

  // Cálculo de Fitness (Métrica de Desempeño Cuantitativo)
  // Recompensa: supervivencia prolongada (+15/turno), crecimiento (+35/longitud), victoria (+3000)
  // Penalización: inanición (-1200), muerte prematura turn < 30 (-800)
  let fitness = turn * 15 + maxLen * 35;
  if (outcome === "WIN") fitness += 3000;
  if (outcome === "DRAW") fitness += 1000;
  if (deathCause === "STARVATION") fitness -= 1200;
  if (turn < 30) fitness -= 800;

  return {
    outcome,
    deathCause,
    turns: turn,
    maxLen,
    finalHealth: you.health,
    fitness: Math.max(0, Math.round(fitness)),
    summary,
    details,
  };
}

/**
 * Analiza un archivo NDJSON generado por el simulador de Battlesnake CLI.
 * @param {string} logFilePath - Ruta al archivo logsX.json
 * @param {string} [targetSnakeName='Culebra Cascabel'] - Nombre de nuestra serpiente
 * @returns {GameDiagnosis}
 */
function analyzeNDJSONFile(logFilePath, targetSnakeName = "Culebra Cascabel") {
  if (!fs.existsSync(logFilePath)) {
    throw new Error(`Archivo de log no encontrado: ${logFilePath}`);
  }

  const raw = fs.readFileSync(logFilePath, "utf8").trim();
  const lines = raw.split("\n").filter(Boolean);

  if (lines.length < 2) {
    throw new Error(`Log incompleto o vacío en ${logFilePath}`);
  }

  const lastLine = JSON.parse(lines[lines.length - 1]);
  const lastFrame = JSON.parse(lines[lines.length - 2]);
  const totalTurns = lastFrame.turn || 0;

  // Recorrer frames y detectar tanto el último frame con vida como el frame de eliminación
  let prevFrame = null;
  let deathFrame = null;
  let mySnakeBefore = null;
  let maxLen = 3;
  let boardDim = { width: 11, height: 11 };

  for (let i = 1; i < lines.length - 1; i++) {
    const frame = JSON.parse(lines[i]);
    if (frame.board) {
      boardDim = { width: frame.board.width || 11, height: frame.board.height || 11 };
      const mySnake = frame.board.snakes.find((s) => s.name === targetSnakeName);
      if (mySnake) {
        prevFrame = frame;
        mySnakeBefore = mySnake;
        if (mySnake.length > maxLen) maxLen = mySnake.length;
      } else if (mySnakeBefore && !deathFrame) {
        deathFrame = frame;
      }
    }
  }

  let winnerName = "Empates/SinGanador";
  if (!lastLine.isDraw && lastLine.winnerName) {
    winnerName = lastLine.winnerName;
  }

  const isWin = winnerName === targetSnakeName;
  const outcome = isWin ? "WIN" : winnerName === "Empates/SinGanador" ? "DRAW" : "LOSS";

  let deathCause = "ALIVE";
  let summary = "";
  const lastTurnSeen = prevFrame ? prevFrame.turn : 0;
  const lastHealth = mySnakeBefore ? mySnakeBefore.health : 0;
  const details = {
    totalTurns,
    lastTurnSeen,
    maxLen,
    lastHealth,
    winnerName,
  };

  if (isWin) {
    deathCause = "ALIVE";
    summary = `🏆 Victoria en Turno ${totalTurns}. Longitud máxima: ${maxLen}.`;
  } else if (!mySnakeBefore) {
    deathCause = "SPACE_EXHAUSTION";
    summary = `💀 Muerte en fase inicial antes de registrarse.`;
  } else {
    const myHead = mySnakeBefore.head || mySnakeBefore.body[0];
    const deathTurn = deathFrame ? deathFrame.turn : lastTurnSeen + 1;
    details.deathTurn = deathTurn;

    // 1. Detección de Inanición
    if (lastHealth <= 1) {
      deathCause = "STARVATION";
      summary = `💀 Muerte por Inanición (Hambre) en el Turno ${deathTurn}. La salud se agotó a 0.`;
    } else {
      const attemptedHead = deathFrame && deathFrame.you && deathFrame.you.name === targetSnakeName
        ? deathFrame.you.head
        : null;

      const deathSnakes = deathFrame ? (deathFrame.board?.snakes || []) : [];

      // 2. Detección de Colisión Frontal (HEAD_COLLISION)
      let headCollisionEnemy = null;
      if (attemptedHead) {
        headCollisionEnemy = deathSnakes.find(
          (s) => s.head && s.head.x === attemptedHead.x && s.head.y === attemptedHead.y
        );
      }
      if (!headCollisionEnemy) {
        headCollisionEnemy = deathSnakes.find((s) => {
          if (!s.head) return false;
          const dist = Math.abs(s.head.x - myHead.x) + Math.abs(s.head.y - myHead.y);
          return dist <= 1 && s.length >= mySnakeBefore.length;
        });
      }

      // 3. Detección de Colisión contra Pared (WALL_COLLISION)
      let isWall = false;
      if (attemptedHead) {
        isWall =
          attemptedHead.x < 0 ||
          attemptedHead.x >= boardDim.width ||
          attemptedHead.y < 0 ||
          attemptedHead.y >= boardDim.height;
      }

      // 4. Detección de Colisión contra Cuerpo (BODY_COLLISION)
      let bodyCollisionWith = null;
      if (attemptedHead && !isWall) {
        for (const s of deathSnakes) {
          if (s.body && s.body.some((b) => b.x === attemptedHead.x && b.y === attemptedHead.y)) {
            bodyCollisionWith = s.name;
            break;
          }
        }
        if (!bodyCollisionWith && mySnakeBefore.body && mySnakeBefore.body.slice(1).some((b) => b.x === attemptedHead.x && b.y === attemptedHead.y)) {
          bodyCollisionWith = "Cuerpo Propio";
        }
      }

      // 5. Confinamiento en Esquina (CORNER_TRAP)
      const isCorner =
        myHead &&
        (myHead.x === 0 || myHead.x === boardDim.width - 1) &&
        (myHead.y === 0 || myHead.y === boardDim.height - 1);

      if (headCollisionEnemy) {
        deathCause = "HEAD_COLLISION";
        details.collidedWith = headCollisionEnemy.name;
        details.enemyLength = headCollisionEnemy.length;
        summary = `💥 Choque Frontal en Turno ${deathTurn} contra ${headCollisionEnemy.name} (Len: ${headCollisionEnemy.length} vs ${mySnakeBefore.length}).`;
      } else if (isWall) {
        deathCause = "WALL_COLLISION";
        summary = `🧱 Choque contra Pared en Turno ${deathTurn} en (${attemptedHead.x},${attemptedHead.y}).`;
      } else if (bodyCollisionWith) {
        deathCause = "BODY_COLLISION";
        details.collidedWith = bodyCollisionWith;
        summary = `🚗 Impacto contra Cuerpo en Turno ${deathTurn} (${bodyCollisionWith}).`;
      } else if (isCorner) {
        deathCause = "CORNER_TRAP";
        summary = `📦 Muerte por Confinamiento en Esquina en Turno ${deathTurn} en (${myHead.x},${myHead.y}).`;
      } else {
        deathCause = "SPACE_EXHAUSTION";
        summary = `🪤 Muerte por Falta de Espacio o Asfixia en Turno ${deathTurn}.`;
      }
    }
  }

  let fitness = lastTurnSeen * 15 + maxLen * 35;
  if (outcome === "WIN") fitness += 3000;
  if (outcome === "DRAW") fitness += 1000;
  if (deathCause === "STARVATION") fitness -= 1200;
  if (lastTurnSeen < 30) fitness -= 800;

  return {
    outcome,
    deathCause,
    turns: lastTurnSeen,
    maxLen,
    finalHealth: lastHealth,
    fitness: Math.max(0, Math.round(fitness)),
    summary,
    details,
  };
}

module.exports = {
  analyzeLiveGame,
  analyzeNDJSONFile,
};
