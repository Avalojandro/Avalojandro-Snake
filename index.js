const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8000;

// 1. Información y personalización de la serpiente
app.get("/", (req, res) => {
  res.json({
    apiversion: "1",
    author: "avalojandro",
    color: "#E70A77",
    head: "silly",
    tail: "mlh-gene",
  });
});

// 2. Inicio de partida
app.post("/start", (req, res) => {
  console.log(`[START] Partida iniciada: ${req.body.game.id}`);
  res.status(200).send("ok");
});

// Helpers de coordenadas y distancias
function isSamePos(p1, p2) {
  return p1.x === p2.x && p1.y === p2.y;
}

function toKey(pos) {
  return `${pos.x},${pos.y}`;
}

function fromKey(key) {
  const [x, y] = key.split(",").map(Number);
  return { x, y };
}

function manhattanDist(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function isInsideBoard(pos, board) {
  return (
    pos.x >= 0 && pos.x < board.width && pos.y >= 0 && pos.y < board.height
  );
}

function getNeighbors(pos, board) {
  const directions = [
    { x: pos.x, y: pos.y + 1 }, // up
    { x: pos.x, y: pos.y - 1 }, // down
    { x: pos.x - 1, y: pos.y }, // left
    { x: pos.x + 1, y: pos.y }, // right
  ];
  return directions.filter((p) => isInsideBoard(p, board));
}

/**
 * Obtiene los movimientos legales y seguros inmediatos para cualquier serpiente.
 * Descarta salirse del tablero, revertir hacia el propio cuello y entrar en obstáculos sólidos.
 */
function getLegalMovesForSnake(snake, board, allObstacles) {
  const head = snake.head;
  const neck = snake.body[1];
  const moves = getNeighbors(head, board);
  return moves.filter((m) => {
    if (neck && m.x === neck.x && m.y === neck.y) return false;
    if (allObstacles.has(toKey(m))) return false;
    return true;
  });
}

/**
 * Obtiene los obstáculos sólidos del tablero considerando el avance de colas.
 * - Para nuestra serpiente: la cola se liberará si no comemos este turno y no está apilada.
 * - Para oponentes: la cola se considera sólida si acaban de comer (salud 100),
 *   su cola está apilada, o tienen comida adyacente (podrían comer y retener la cola).
 */
function getBoardObstacles(board, you, willEatFood = false) {
  const solid = new Set();

  board.snakes.forEach((snake) => {
    const isYou = snake.id === you.id;
    const body = snake.body;
    const isTailStacked =
      body.length > 1 &&
      isSamePos(body[body.length - 1], body[body.length - 2]);

    if (isYou) {
      const ourTailWillMove = !willEatFood && !isTailStacked;
      const obstacles = ourTailWillMove ? body.slice(0, -1) : body;
      obstacles.forEach((seg) => solid.add(toKey(seg)));
    } else {
      const enemyHead = snake.head;
      const nearFood = (board.food || []).some(
        (f) => manhattanDist(enemyHead, f) === 1,
      );
      const enemyTailWillMove =
        !isTailStacked && snake.health < 100 && !nearFood;
      const obstacles = enemyTailWillMove ? body.slice(0, -1) : body;
      obstacles.forEach((seg) => solid.add(toKey(seg)));
    }
  });

  return solid;
}

/**
 * Análisis de Espacio y Flood Fill Temporal (Anti-Acorralamiento):
 * Evalúa cuántas casillas reales son accesibles desde startPos y si existe un camino
 * de regreso a nuestra propia cola que se va liberando con cada turno.
 */
function analyzeSpaceAndFloodFill(startPos, board, you, willEatFood) {
  const foodSet = new Set((board.food || []).map(toKey));
  const myTail = you.body[you.body.length - 1];
  const myTailKey = toKey(myTail);

  // Mapeo temporal de liberación de segmentos de nuestro propio cuerpo:
  // El segmento i se libera en el turno (you.body.length - 1 - i + shift)
  const bodyClearance = new Map();
  const shift = willEatFood ? 1 : 0;
  for (let i = 0; i < you.body.length; i++) {
    const key = toKey(you.body[i]);
    const turnsUntilFree = you.body.length - 1 - i + shift;
    const existing = bodyClearance.get(key) || 0;
    bodyClearance.set(key, Math.max(existing, turnsUntilFree));
  }

  // Obstáculos estáticos del resto de serpientes
  const otherSnakesObstacles = new Set();
  board.snakes.forEach((snake) => {
    if (snake.id !== you.id) {
      snake.body.forEach((p) => otherSnakesObstacles.add(toKey(p)));
    }
  });

  const visited = new Set();
  const queue = [{ pos: startPos, dist: 1 }]; // startPos se ocupa en el turno 1
  visited.add(toKey(startPos));

  let reachableCount = 0;
  let canReachTail = false;
  let tailDistance = null;
  const reachableFoods = [];

  while (queue.length > 0) {
    const { pos, dist } = queue.shift();
    reachableCount++;
    const posKey = toKey(pos);

    // Registro de comida alcanzable
    if (foodSet.has(posKey)) {
      reachableFoods.push({ pos, dist });
    }

    // Comprobar conexión con la cola propia
    if (posKey === myTailKey && !canReachTail) {
      canReachTail = true;
      tailDistance = dist;
    }

    for (const neighbor of getNeighbors(pos, board)) {
      const nKey = toKey(neighbor);
      if (visited.has(nKey)) continue;
      if (otherSnakesObstacles.has(nKey)) continue;

      // Comprobar si nuestro propio cuerpo ya se liberó en el turno dist + 1
      if (bodyClearance.has(nKey)) {
        const turnsNeeded = bodyClearance.get(nKey);
        if (dist + 1 <= turnsNeeded) {
          continue; // Todavía ocupado por nuestro cuerpo
        }
      }

      visited.add(nKey);
      queue.push({ pos: neighbor, dist: dist + 1 });
    }
  }

  return {
    reachableSpace: reachableCount,
    canReachTail,
    tailDistance,
    reachableFoods,
  };
}

/**
 * Cálculo de Territorio Voronoi Sincronizado en T+1:
 * Ambos frentes (nuestro movimiento propuesto y los movimientos legales de los rivales)
 * inician en el turno 1, evitando desfases temporales.
 */
function calculateSynchronizedVoronoi(candidatePos, board, you, baseObstacles) {
  const myQueue = [{ pos: candidatePos, dist: 1 }];
  const myDistances = new Map();
  myDistances.set(toKey(candidatePos), 1);

  while (myQueue.length > 0) {
    const { pos, dist } = myQueue.shift();
    for (const n of getNeighbors(pos, board)) {
      const nKey = toKey(n);
      if (!myDistances.has(nKey) && !baseObstacles.has(nKey)) {
        myDistances.set(nKey, dist + 1);
        myQueue.push({ pos: n, dist: dist + 1 });
      }
    }
  }

  const oppQueue = [];
  const oppDistances = new Map();
  const oppLengths = new Map();

  board.snakes.forEach((other) => {
    if (other.id === you.id) return;
    const legalMoves = getLegalMovesForSnake(other, board, baseObstacles);
    legalMoves.forEach((m) => {
      const mKey = toKey(m);
      if (!oppDistances.has(mKey)) {
        oppDistances.set(mKey, 1);
        oppLengths.set(mKey, other.length);
        oppQueue.push({ pos: m, dist: 1, length: other.length });
      } else {
        oppLengths.set(mKey, Math.max(oppLengths.get(mKey), other.length));
      }
    });
  });

  while (oppQueue.length > 0) {
    const { pos, dist, length } = oppQueue.shift();
    for (const n of getNeighbors(pos, board)) {
      const nKey = toKey(n);
      if (!oppDistances.has(nKey) && !baseObstacles.has(nKey)) {
        oppDistances.set(nKey, dist + 1);
        oppLengths.set(nKey, length);
        oppQueue.push({ pos: n, dist: dist + 1, length });
      }
    }
  }

  let myExclusive = 0;

  for (const [key, myD] of myDistances.entries()) {
    const oppD = oppDistances.get(key);
    if (oppD === undefined) {
      myExclusive++;
    } else if (myD < oppD) {
      myExclusive++;
    } else if (myD === oppD) {
      const enemyLen = oppLengths.get(key) || 0;
      if (you.length > enemyLen) {
        myExclusive++; // En empate de distancia ganamos si somos más largos
      }
    }
  }

  return { myExclusive, oppDistances };
}

// 3. Lógica de decisión de movimiento por turno
app.post("/move", (req, res) => {
  const { board, you } = req.body;
  const turn = req.body.turn || 0;
  const myHead = you.head;
  const myLength = you.length;

  const moveDirections = {
    up: { x: myHead.x, y: myHead.y + 1 },
    down: { x: myHead.x, y: myHead.y - 1 },
    left: { x: myHead.x - 1, y: myHead.y },
    right: { x: myHead.x + 1, y: myHead.y },
  };

  const initialObstacles = getBoardObstacles(board, you, false);

  // FILTRO 1: Movimientos físicamente posibles (No paredes, no cuello, no cuerpos sólidos)
  const neck = you.body[1];
  const physicallySafeMoves = Object.keys(moveDirections).filter((m) => {
    const target = moveDirections[m];
    if (!isInsideBoard(target, board)) return false;
    if (neck && target.x === neck.x && target.y === neck.y) return false;
    if (initialObstacles.has(toKey(target))) return false;
    return true;
  });

  if (physicallySafeMoves.length === 0) {
    console.log(
      `[MOVE T${turn}] 💀 ¡Sin movimientos físicos legales! Movimiento de emergencia hacia up`,
    );
    return res.json({ move: "up", shout: "Sin salida 💀" });
  }

  let maxOpponentLength = 0;
  board.snakes.forEach((s) => {
    if (s.id !== you.id && s.length > maxOpponentLength) {
      maxOpponentLength = s.length;
    }
  });
  const isLeader = myLength > maxOpponentLength;

  const foodSet = new Set((board.food || []).map(toKey));
  const hazardSet = new Set((board.hazards || []).map(toKey));
  const center = {
    x: Math.floor(board.width / 2),
    y: Math.floor(board.height / 2),
  };

  // EVALUACIÓN DETALLADA DE CADA MOVIMIENTO CANDIDATO
  const scoredMoves = physicallySafeMoves.map((move) => {
    const nextPos = moveDirections[move];
    const willEatFood = foodSet.has(toKey(nextPos));
    const baseObstacles = getBoardObstacles(board, you, willEatFood);
    let score = 0;

    // 1. SEGURIDAD ANTE CHOQUES DE CABEZA (Head-to-Head)
    let inLethalDanger = false;
    let inEqualDanger = false;
    let canTrapSmaller = false;

    board.snakes.forEach((other) => {
      if (other.id === you.id) return;
      const otherLegalMoves = getLegalMovesForSnake(
        other,
        board,
        baseObstacles,
      );
      otherLegalMoves.forEach((m) => {
        if (m.x === nextPos.x && m.y === nextPos.y) {
          if (other.length > myLength) {
            inLethalDanger = true; // Muerte segura ante rival mayor
          } else if (other.length === myLength) {
            inEqualDanger = true; // Eliminación mutua
          } else {
            canTrapSmaller = true; // El rival menor moriría al chocar
          }
        }
      });
    });

    if (inLethalDanger) {
      score -= 100000;
    } else if (inEqualDanger) {
      score -= 40000;
    } else if (canTrapSmaller) {
      score += 600;
    }

    // 2. CONTROL DE ESPACIO Y ANTI-ACORRALAMIENTO (Flood Fill + Tail Reach)
    const spaceAnalysis = analyzeSpaceAndFloodFill(
      nextPos,
      board,
      you,
      willEatFood,
    );
    const { reachableSpace, canReachTail, reachableFoods } = spaceAnalysis;

    if (reachableSpace < myLength) {
      if (!canReachTail) {
        // Callejón sin salida menor que nuestro cuerpo: Muerte segura
        score -= 500000;
      } else {
        // Espacio estrecho pero bucle continuo siguiendo la cola
        score += 200 + reachableSpace * 10;
      }
    } else if (reachableSpace < myLength * 1.5) {
      if (!canReachTail) {
        // Bolsillo estrecho con riesgo alto de encierro
        score -= 30000;
      } else {
        score += 500 + reachableSpace * 15;
      }
    } else {
      // Espacio abierto y seguro
      score += 1500 + Math.min(reachableSpace, 100) * 20;
      if (canReachTail) score += 300;
    }

    // 3. CONTROL DE TERRITORIO VORONOI
    const { myExclusive, oppDistances } = calculateSynchronizedVoronoi(
      nextPos,
      board,
      you,
      baseObstacles,
    );
    score += myExclusive * 15;

    // 4. ALIMENTACIÓN INTELIGENTE Y ACTIVA (Sin esquivar comida)
    if (reachableFoods.length > 0) {
      let foodDrive = 0;
      if (you.health <= 30) {
        foodDrive = 25000; // Emergencia: inanición inminente
      } else if (
        you.health <= 65 ||
        !isLeader ||
        myLength <= maxOpponentLength + 1
      ) {
        foodDrive = 7000; // Hambre activa / necesidad de crecer para superar rivales
      } else {
        foodDrive = 2500; // Líder dominante: seguir comiendo para ampliar ventaja
      }

      // Filtrar comidas: detectar si un rival mayor llega antes o al mismo tiempo
      const safeFoods = [];
      const contestedFoods = [];

      reachableFoods.forEach((rf) => {
        const fKey = toKey(rf.pos);
        const enemyDist = oppDistances.get(fKey);
        if (enemyDist !== undefined && enemyDist <= rf.dist) {
          contestedFoods.push(rf);
        } else {
          safeFoods.push(rf);
        }
      });

      const candidateFoods = safeFoods.length > 0 ? safeFoods : contestedFoods;
      candidateFoods.sort((a, b) => a.dist - b.dist);
      const targetFood = candidateFoods[0];

      if (willEatFood) {
        // Solo penalizamos comer si nos encerraría en un espacio mortal
        if (reachableSpace < myLength + 1 && !canReachTail) {
          score -= 200000;
        } else {
          score += foodDrive;
        }
      } else {
        score += Math.max(0, foodDrive - targetFood.dist * 200);
      }
    }

    // 5. MOVILIDAD Y LIBERTADES (Open Neighbors)
    const openNeighbors = getNeighbors(nextPos, board).filter(
      (n) => !baseObstacles.has(toKey(n)),
    ).length;

    if (openNeighbors === 0) score -= 100000;
    else if (openNeighbors === 1) score -= 400; // Entrada a túnel
    else score += openNeighbors * 50;

    // 6. PROTECCIÓN CONTRA EL "SQUEEZE" (Bordes y Esquinas)
    const isCorner =
      (nextPos.x === 0 || nextPos.x === board.width - 1) &&
      (nextPos.y === 0 || nextPos.y === board.height - 1);
    const isEdge =
      nextPos.x === 0 ||
      nextPos.x === board.width - 1 ||
      nextPos.y === 0 ||
      nextPos.y === board.height - 1;

    const enemyNear = board.snakes.some(
      (s) => s.id !== you.id && manhattanDist(nextPos, s.head) <= 3,
    );

    if (isCorner) {
      score -= enemyNear ? 600 : 300;
    } else if (isEdge && enemyNear) {
      score -= 200;
    }

    // 7. PREFERENCIA POR EL CENTRO DEL TABLERO
    score -= manhattanDist(nextPos, center) * 8;

    // 8. PENALIZACIÓN POR HAZARDS
    if (hazardSet.has(toKey(nextPos))) {
      score -= you.health <= 30 ? 50000 : 1000;
    }

    return {
      move,
      score,
      reachableSpace,
      canReachTail,
      exclusiveTerritory: myExclusive,
      willEatFood,
    };
  });

  // Ordenar movimientos por mayor puntuación
  scoredMoves.sort((a, b) => b.score - a.score);

  const best = scoredMoves[0];
  console.log(
    `[MOVE T${turn}] HP: ${you.health} | Len: ${myLength} (Líder: ${isLeader}) | Elegido: ${best.move} (Score: ${best.score}) | Voronoi: ${best.exclusiveTerritory} | Espacio: ${best.reachableSpace} | Cola: ${best.canReachTail} | Come: ${best.willEatFood}`,
  );

  res.json({
    move: best.move,
    shout: `T${turn} 👾`,
  });
});

// 4. Fin de partida
app.post("/end", (req, res) => {
  console.log(`[END] Partida finalizada: ${req.body.game.id}`);
  res.status(200).send("ok");
});

app.listen(PORT, () => {
  console.log(`🐍 Servidor Battlesnake escuchando en http://localhost:${PORT}`);
});
