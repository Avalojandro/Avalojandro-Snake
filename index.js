const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8000;

// 1. Información y personalización de la serpiente
app.get('/', (req, res) => {
  res.json({
    apiversion: '1',
    author: 'avalojandro',
    color: '#0984e3', // Azul eléctrico
    head: 'pixel',    // Cabeza pixel art
    tail: 'sharp'     // Cola afilada
  });
});

// 2. Inicio de partida
app.post('/start', (req, res) => {
  console.log(`[START] Partida iniciada: ${req.body.game.id}`);
  res.status(200).send('ok');
});

// Helpers de coordenadas y distancias
function isSamePos(p1, p2) {
  return p1.x === p2.x && p1.y === p2.y;
}

function toKey(pos) {
  return `${pos.x},${pos.y}`;
}

function fromKey(key) {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
}

function manhattanDist(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function isInsideBoard(pos, board) {
  return pos.x >= 0 && pos.x < board.width && pos.y >= 0 && pos.y < board.height;
}

function getNeighbors(pos, board) {
  const directions = [
    { x: pos.x, y: pos.y + 1 }, // up
    { x: pos.x, y: pos.y - 1 }, // down
    { x: pos.x - 1, y: pos.y }, // left
    { x: pos.x + 1, y: pos.y }  // right
  ];
  return directions.filter((p) => isInsideBoard(p, board));
}

/**
 * Obtiene el conjunto de obstáculos sólidos en el tablero.
 * Tiene en cuenta que las colas se vacían al avanzar salvo que la serpiente
 * acabe de comer (salud 100 o cola duplicada).
 */
function getSolidObstacles(board, you) {
  const solid = new Set();

  board.snakes.forEach((snake) => {
    const body = snake.body;
    const isTailStacked =
      body.length > 1 && isSamePos(body[body.length - 1], body[body.length - 2]);
    const willTailMove = !isTailStacked && snake.health < 100;

    const obstacles = willTailMove ? body.slice(0, -1) : body;
    obstacles.forEach((seg) => solid.add(toKey(seg)));
  });

  return solid;
}

/**
 * Lookahead a 2 pasos:
 * Simula el paso a candidatePos y verifica si existen salidas legales en T+2.
 * Evita entrar en casillas donde la muerte en el turno inmediato siguiente es inevitable.
 */
function hasLegalExitsInTurn2(candidatePos, board, you, solidObstacles) {
  // En T+1, la nueva cabeza está en candidatePos y la vieja cabeza se convierte en cuello
  const simulatedObstacles = new Set(solidObstacles);
  simulatedObstacles.add(toKey(you.head)); // nuestra vieja cabeza ahora es cuerpo
  simulatedObstacles.delete(toKey(candidatePos));

  // Si no comemos en este paso, nuestra cola se liberaría en T+2
  const myTail = you.body[you.body.length - 1];
  const myTailStacked =
    you.body.length > 1 && isSamePos(myTail, you.body[you.body.length - 2]);
  if (!myTailStacked && you.health < 100) {
    simulatedObstacles.delete(toKey(myTail));
  }

  const turn2Neighbors = getNeighbors(candidatePos, board);
  const legalExits = turn2Neighbors.filter((n) => !simulatedObstacles.has(toKey(n)));

  return legalExits.length > 0;
}

/**
 * Cálculo de Territorio Voronoi y BFS Avanzado:
 * Evalúa el espacio al que nosotros llegamos ANTES que cualquier oponente.
 * Esto detecta si los rivales nos están cortando el paso dinámicamente.
 */
function analyzeVoronoiAndReach(startPos, board, you, solidObstacles) {
  const myTail = you.body[you.body.length - 1];
  const myTailKey = toKey(myTail);

  // 1. BFS desde nuestra posición propuesta (startPos)
  const myDistances = new Map();
  const myQueue = [{ pos: startPos, dist: 0 }];
  myDistances.set(toKey(startPos), 0);

  let canReachOwnTail = false;
  let nearestFoodDist = null;
  const foodKeys = new Set((board.food || []).map(toKey));

  while (myQueue.length > 0) {
    const { pos, dist } = myQueue.shift();

    if (foodKeys.has(toKey(pos)) && nearestFoodDist === null) {
      nearestFoodDist = dist;
    }

    if (toKey(pos) === myTailKey) {
      canReachOwnTail = true;
    }

    for (const neighbor of getNeighbors(pos, board)) {
      const nKey = toKey(neighbor);
      const isMyMovingTail = nKey === myTailKey && you.health < 100;

      if (!myDistances.has(nKey)) {
        if (!solidObstacles.has(nKey) || isMyMovingTail) {
          myDistances.set(nKey, dist + 1);
          myQueue.push({ pos: neighbor, dist: dist + 1 });
        }
      }
    }
  }

  // 2. BFS multi-origen desde las cabezas de todas las serpientes rivales
  const opponentDistances = new Map();
  const oppQueue = [];

  board.snakes.forEach((other) => {
    if (other.id === you.id) return;
    const key = toKey(other.head);
    opponentDistances.set(key, 0);
    oppQueue.push({ pos: other.head, dist: 0 });
  });

  while (oppQueue.length > 0) {
    const { pos, dist } = oppQueue.shift();

    for (const neighbor of getNeighbors(pos, board)) {
      const nKey = toKey(neighbor);
      if (!opponentDistances.has(nKey) && !solidObstacles.has(nKey)) {
        opponentDistances.set(nKey, dist + 1);
        oppQueue.push({ pos: neighbor, dist: dist + 1 });
      }
    }
  }

  // 3. Contar casillas de territorio exclusivo (Voronoi)
  let exclusiveTerritory = 0;
  let sharedOrControlledSpace = 0;

  for (const [cellKey, myD] of myDistances.entries()) {
    sharedOrControlledSpace++;
    const oppD = opponentDistances.get(cellKey);

    if (oppD === undefined || myD < oppD) {
      // Llegamos estrictamente antes que cualquier enemigo
      exclusiveTerritory++;
    }
  }

  return {
    reachableSpace: sharedOrControlledSpace,
    exclusiveTerritory,
    canReachTail: canReachOwnTail,
    nearestFoodDist
  };
}

// 3. Lógica de decisión de movimiento por turno
app.post('/move', (req, res) => {
  const { board, you } = req.body;
  const myHead = you.head;
  const myLength = you.length;

  const moveDirections = {
    up: { x: myHead.x, y: myHead.y + 1 },
    down: { x: myHead.x, y: myHead.y - 1 },
    left: { x: myHead.x - 1, y: myHead.y },
    right: { x: myHead.x + 1, y: myHead.y }
  };

  const solidObstacles = getSolidObstacles(board, you);
  const hazardKeys = new Set((board.hazards || []).map(toKey));

  // FILTRO 1: Movimientos físicamente posibles (No paredes, no cuerpos sólidos)
  const physicallySafeMoves = Object.keys(moveDirections).filter((move) => {
    const target = moveDirections[move];
    if (!isInsideBoard(target, board)) return false;
    if (solidObstacles.has(toKey(target))) return false;
    return true;
  });

  if (physicallySafeMoves.length === 0) {
    console.log('[MOVE] 💀 ¡Sin movimientos legales! Movimiento de emergencia hacia up');
    return res.json({ move: 'up', shout: 'Sin salida 💀' });
  }

  // FILTRO 2: Lookahead a 2 pasos (Descartar callejones con muerte garantizada en T+2)
  const movesWithTurn2Exit = physicallySafeMoves.filter((move) => {
    return hasLegalExitsInTurn2(moveDirections[move], board, you, solidObstacles);
  });

  // Si hay movimientos con salida garantizada en T+2, descartamos los suicidas
  const viableTurn2Moves = movesWithTurn2Exit.length > 0 ? movesWithTurn2Exit : physicallySafeMoves;

  // FILTRO 3: Choques de cabeza contra rivales iguales o mayores
  const lethalHeadZones = new Set();
  const huntingTargets = [];

  let maxOpponentLength = 0;

  board.snakes.forEach((other) => {
    if (other.id === you.id) return;
    if (other.length > maxOpponentLength) {
      maxOpponentLength = other.length;
    }

    const otherPotentialMoves = getNeighbors(other.head, board);

    if (other.length >= myLength) {
      // Enemigo igual o mayor: sus posibles movimientos son ZONAS MORTALES
      otherPotentialMoves.forEach((sq) => lethalHeadZones.add(toKey(sq)));
    } else {
      // Enemigo menor: sus posibles movimientos son oportunidades de intercepción
      otherPotentialMoves.forEach((sq) => {
        huntingTargets.push({ pos: sq, enemyId: other.id, enemyLength: other.length });
      });
    }
  });

  // Excluir casillas amenazadas por rivales mayores si existen opciones seguras
  const safeFromHeadCollisionMoves = viableTurn2Moves.filter(
    (move) => !lethalHeadZones.has(toKey(moveDirections[move]))
  );

  const candidates =
    safeFromHeadCollisionMoves.length > 0
      ? safeFromHeadCollisionMoves
      : viableTurn2Moves;

  // Parámetros estratégicos del estado actual
  const center = { x: Math.floor(board.width / 2), y: Math.floor(board.height / 2) };
  const isStarving = you.health <= 35;
  const isLeader = myLength > maxOpponentLength;
  const needsGrowth = !isLeader || myLength < 8;
  const isSatiated = isLeader && you.health > 60; // Evitar sobrealimentación si ya dominamos

  // EVALUACIÓN Y PUNTUACIÓN DE CADA MOVIMIENTO CANDIDATO
  const scoredMoves = candidates.map((move) => {
    const nextPos = moveDirections[move];
    const nextKey = toKey(nextPos);
    let score = 0;

    // Análisis de Territorio Voronoi y BFS
    const { reachableSpace, exclusiveTerritory, canReachTail, nearestFoodDist } =
      analyzeVoronoiAndReach(nextPos, board, you, solidObstacles);

    // 1. ESPACIO Y CONTROL DE TERRITORIO (Voronoi + BFS)
    // El territorio exclusivo (Voronoi) nos asegura que no seremos acorralados por rivales
    score += exclusiveTerritory * 25;
    score += Math.min(reachableSpace, 80) * 10;

    if (reachableSpace < myLength) {
      if (canReachTail) {
        // Conexión segura a la cola: el callejón se abrirá al movernos
        score += 300 + reachableSpace * 5;
      } else {
        // Trampa mortal sin salida: penalización crítica
        score -= 2500 - reachableSpace * 10;
      }
    }

    // 2. LIBERTADES Y PROTECCIÓN CONTRA EL "SQUEEZE" (Paredes)
    const openNeighbors = getNeighbors(nextPos, board).filter(
      (n) => !solidObstacles.has(toKey(n))
    ).length;
    score += openNeighbors * 30;

    // Penalización por pegarse al borde si hay rivales cerca (evita ser comprimido contra la pared)
    const isAtEdge =
      nextPos.x === 0 ||
      nextPos.x === board.width - 1 ||
      nextPos.y === 0 ||
      nextPos.y === board.height - 1;

    if (isAtEdge) {
      const nearEnemies = board.snakes.some(
        (s) => s.id !== you.id && manhattanDist(nextPos, s.head) <= 3
      );
      if (nearEnemies) {
        score -= 80; // Peligro de squeeze
      }
    }

    // 3. ESTRATEGIA DE ALIMENTACIÓN INTELIGENTE (Sin sobrealimentación)
    if (nearestFoodDist !== null) {
      if (isStarving) {
        // Supervivencia pura: comida de forma urgente
        score += (350 - nearestFoodDist * 30);
      } else if (needsGrowth && reachableSpace >= myLength) {
        // Crecimiento necesario para superar al rival más largo
        score += (140 - nearestFoodDist * 10);
      } else if (isSatiated) {
        // Ya somos el líder y tenemos buena salud: NO sobrealimentarnos
        // Leve penalización por comer comida innecesaria que ocupe espacio
        if (nearestFoodDist === 0) {
          score -= 40;
        }
      } else if (reachableSpace >= myLength * 1.5) {
        // Modo estándar
        score += (50 - nearestFoodDist * 4);
      }
    }

    // 4. CONTROL DEL CENTRO DEL TABLERO
    const distToCenter = manhattanDist(nextPos, center);
    score += (20 - distToCenter * 3);

    // 5. PENALIZACIÓN POR HAZARDS (Lava / Áreas de daño)
    if (hazardKeys.has(nextKey)) {
      score -= 400;
    }

    // 6. CAZA Y EMBOSCADA PREDICTIVA A SERPIENTES PEQUEÑAS
    if (huntingTargets.length > 0 && reachableSpace >= myLength) {
      huntingTargets.forEach((target) => {
        if (isSamePos(nextPos, target.pos)) {
          // Si interceptamos la casilla a la que puede ir un rival más pequeño: ¡eliminación!
          score += 600;
        } else if (manhattanDist(nextPos, target.pos) === 1) {
          score += 80; // Presionar su salida
        }
      });
    }

    return {
      move,
      score,
      exclusiveTerritory,
      reachableSpace,
      canReachTail,
      nearestFoodDist,
      openNeighbors
    };
  });

  // Ordenar movimientos por mayor puntuación
  scoredMoves.sort((a, b) => b.score - a.score);

  const best = scoredMoves[0];
  console.log(
    `[MOVE T${req.body.turn}] HP: ${you.health} | Len: ${myLength} (Líder: ${isLeader}) | Elegido: ${best.move} (Score: ${best.score}) | Voronoi: ${best.exclusiveTerritory} | Espacio: ${best.reachableSpace} | Cola: ${best.canReachTail}`
  );

  res.json({
    move: best.move,
    shout: `T${req.body.turn} 👾`
  });
});

// 4. Fin de partida
app.post('/end', (req, res) => {
  console.log(`[END] Partida finalizada: ${req.body.game.id}`);
  res.status(200).send('ok');
});

app.listen(PORT, () => {
  console.log(`🐍 Servidor Battlesnake escuchando en http://localhost:${PORT}`);
});
