const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8000;

// 1. Información de la serpiente
app.get('/', (req, res) => {
  res.json({
    apiversion: '1',
    author: 'avalojandro',
    color: '#0984e3', // Color azul eléctrico
    head: 'pixel',    // Cabeza estilo pixel art
    tail: 'sharp'     // Cola afilada
  });
});

// 2. Inicio de partida
app.post('/start', (req, res) => {
  console.log(`[START] Nueva partida iniciada: ${req.body.game.id}`);
  res.status(200).send('ok');
});

// Helper: Comprueba si dos posiciones son idénticas
function isSamePos(p1, p2) {
  return p1.x === p2.x && p1.y === p2.y;
}

// Helper: Convierte coordenadas a clave string "x,y"
function toKey(pos) {
  return `${pos.x},${pos.y}`;
}

// Helper: Distancia Manhattan (rápida para cálculos secundarios)
function manhattanDistance(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// Helper: Verifica si una coordenada está dentro del tablero
function isInsideBoard(pos, board) {
  return pos.x >= 0 && pos.x < board.width && pos.y >= 0 && pos.y < board.height;
}

// Helper: Obtiene vecinos válidos en el tablero
function getAdjacentNeighbors(pos, board) {
  const candidates = [
    { x: pos.x, y: pos.y + 1 }, // up
    { x: pos.x, y: pos.y - 1 }, // down
    { x: pos.x - 1, y: pos.y }, // left
    { x: pos.x + 1, y: pos.y }  // right
  ];
  return candidates.filter((p) => isInsideBoard(p, board));
}

/**
 * BFS Avanzado:
 * Evalúa el espacio accesible desde una casilla, detecta si puede regresar a su cola
 * (lo que garantiza que NO es un callejón sin salida) y encuentra la distancia real a la comida.
 */
function analyzePathWithBFS(startPos, board, you) {
  const width = board.width;
  const height = board.height;

  // Conjunto de obstáculos rígidos (cuerpos de serpientes)
  const solidObstacles = new Set();

  board.snakes.forEach((snake) => {
    const isYou = snake.id === you.id;
    const body = snake.body;

    // Detectar si la cola se moverá en el siguiente turno.
    // La cola NO se moverá si la serpiente acaba de comer (longitud duplicada al final o salud 100).
    const tailIsStacked =
      body.length > 1 &&
      isSamePos(body[body.length - 1], body[body.length - 2]);

    const willTailVacate = !tailIsStacked && snake.health < 100;

    // Los segmentos que son obstáculos ineludibles
    const obstacleSegments = willTailVacate ? body.slice(0, -1) : body;
    obstacleSegments.forEach((segment) => {
      solidObstacles.add(toKey(segment));
    });
  });

  const visited = new Set();
  const queue = [{ pos: startPos, dist: 0 }];
  visited.add(toKey(startPos));

  let reachableSquares = 0;
  let canReachOwnTail = false;
  let nearestFoodRealDist = null;

  const myTail = you.body[you.body.length - 1];
  const myTailKey = toKey(myTail);

  const foodKeys = new Set((board.food || []).map(toKey));

  while (queue.length > 0) {
    const current = queue.shift();
    reachableSquares++;

    // ¿Llegamos a comida accesible?
    if (foodKeys.has(toKey(current.pos)) && nearestFoodRealDist === null) {
      nearestFoodRealDist = current.dist;
    }

    // ¿Podemos alcanzar nuestra propia cola? (Estrategia de escape infalible)
    if (toKey(current.pos) === myTailKey) {
      canReachOwnTail = true;
    }

    const neighbors = getAdjacentNeighbors(current.pos, board);

    for (const next of neighbors) {
      const nextKey = toKey(next);

      // La cola propia siempre es transitable si se va a mover
      const isMyMovingTail = nextKey === myTailKey && !isSamePos(myTail, you.body[you.body.length - 2]);

      if (!visited.has(nextKey)) {
        if (!solidObstacles.has(nextKey) || isMyMovingTail) {
          visited.add(nextKey);
          queue.push({ pos: next, dist: current.dist + 1 });
        }
      }
    }
  }

  return {
    reachableSpace: reachableSquares,
    canReachTail: canReachOwnTail,
    nearestFoodDist: nearestFoodRealDist
  };
}

// 3. Decisión de movimiento
app.post('/move', (req, res) => {
  const { board, you } = req.body;
  const myHead = you.head;
  const myLength = you.length;

  const moves = {
    up: { x: myHead.x, y: myHead.y + 1 },
    down: { x: myHead.x, y: myHead.y - 1 },
    left: { x: myHead.x - 1, y: myHead.y },
    right: { x: myHead.x + 1, y: myHead.y }
  };

  // Conjunto de obstáculos actuales
  const impassable = new Set();

  board.snakes.forEach((snake) => {
    const body = snake.body;
    const tailIsStacked =
      body.length > 1 && isSamePos(body[body.length - 1], body[body.length - 2]);
    const segments = (tailIsStacked || snake.health === 100) ? body : body.slice(0, -1);

    segments.forEach((seg) => impassable.add(toKey(seg)));
  });

  // Peligros del mapa (Hazards)
  const hazardKeys = new Set((board.hazards || []).map(toKey));

  // Paso 1: Filtrar movimientos inmediatamente fatales (Paredes y cuerpos sólidos)
  const physicallySafeMoves = Object.keys(moves).filter((move) => {
    const target = moves[move];
    if (!isInsideBoard(target, board)) return false;
    if (impassable.has(toKey(target))) return false;
    return true;
  });

  if (physicallySafeMoves.length === 0) {
    console.log('[MOVE] ⚠️ ¡Sin salida! Movimiento de emergencia a up');
    return res.json({ move: 'up', shout: 'Sin salida 💀' });
  }

  // Paso 2: Identificar amenazas de choque de cabezas (Head-to-Head)
  // Las casillas donde serpientes rivales >= a nosotros pueden moverse en el turno 1
  const lethalOpponentZones = new Set();
  const smallerOpponentHeads = [];

  board.snakes.forEach((other) => {
    if (other.id === you.id) return;

    const opponentNeighbors = getAdjacentNeighbors(other.head, board);

    if (other.length >= myLength) {
      opponentNeighbors.forEach((sq) => lethalOpponentZones.add(toKey(sq)));
    } else {
      smallerOpponentHeads.push(other.head);
    }
  });

  // Separar los movimientos que garantizan CERO riesgo de choque contra rivales más grandes
  const guaranteedNoHeadCollisionMoves = physicallySafeMoves.filter(
    (move) => !lethalOpponentZones.has(toKey(moves[move]))
  );

  // Si existen movimientos sin riesgo de choque frontal, DESCARTAMOS por completo los riesgosos.
  // Solo consideramos casillas de choque frontal si no nos queda absolutamente ninguna otra opción.
  const candidateMoves =
    guaranteedNoHeadCollisionMoves.length > 0
      ? guaranteedNoHeadCollisionMoves
      : physicallySafeMoves;

  // Centro del tablero
  const center = { x: Math.floor(board.width / 2), y: Math.floor(board.height / 2) };

  // Paso 3: Evaluar y puntuar rigurosamente cada movimiento candidato
  const scoredMoves = candidateMoves.map((move) => {
    const nextPos = moves[move];
    const nextKey = toKey(nextPos);
    let score = 0;

    // Análisis de BFS: espacio disponible, si conecta con la cola y distancia real a comida
    const { reachableSpace, canReachTail, nearestFoodDist } = analyzePathWithBFS(nextPos, board, you);

    // A. ESPACIO Y CONTROL DE ENCIERRO (Evitar trampas mortales)
    if (reachableSpace >= myLength) {
      // Espacio amplio suficiente para todo nuestro cuerpo
      score += Math.min(reachableSpace, 80) * 15;
    } else {
      // Espacio menor que nuestra longitud: callejón potencialmente mortal
      if (canReachTail) {
        // Si podemos perseguir nuestra propia cola, el callejón se irá abriendo a nuestro paso
        score += 200 + reachableSpace * 5;
      } else {
        // Trampa mortal sin salida: penalización masiva
        score -= 2000 - reachableSpace * 10;
      }
    }

    // B. LIBERTADES (Grados de libertad en la siguiente casilla)
    // Evita entrar en cuellos de botella estrechos donde puedan emboscarnos
    const openNeighbors = getAdjacentNeighbors(nextPos, board).filter(
      (n) => !impassable.has(toKey(n))
    ).length;
    score += openNeighbors * 25;

    // C. GESTIÓN DE COMIDA (Alimentación estratégica)
    const enemiesAreLonger = board.snakes.some((s) => s.id !== you.id && s.length >= myLength);
    const isStarving = you.health <= 35;
    const needGrowth = enemiesAreLonger || you.length < 8;

    if (nearestFoodDist !== null) {
      if (isStarving) {
        // Supervivencia crítica: ir directo a la comida más cercana
        score += (250 - nearestFoodDist * 20);
      } else if (needGrowth && reachableSpace >= myLength) {
        // Modo desarrollo: comer para superar a los rivales si el camino es seguro
        score += (120 - nearestFoodDist * 8);
      } else if (reachableSpace >= myLength * 1.5) {
        // Modo tranquilo: solo si no compromete espacio
        score += (40 - nearestFoodDist * 3);
      }
    }

    // D. POSICIONAMIENTO Y CONTROL CENTRAL
    // Evita pegarse a las paredes donde es más fácil ser acorralado
    const distToCenter = manhattanDistance(nextPos, center);
    score += (15 - distToCenter * 2);

    // E. PENALIZACIÓN POR HAZARDS (Lava / Peligros)
    if (hazardKeys.has(nextKey)) {
      score -= 350; // Evitar entrar en zonas de daño salvo que sea inevitable
    }

    // F. MODO CAZADOR (Si un rival más pequeño está cerca y tenemos espacio seguro)
    if (smallerOpponentHeads.length > 0 && reachableSpace >= myLength) {
      smallerOpponentHeads.forEach((enemyHead) => {
        const distToEnemyHead = manhattanDistance(nextPos, enemyHead);
        if (distToEnemyHead === 1) {
          // ¡Podemos eliminarlo con choque frontal!
          score += 500;
        } else if (distToEnemyHead === 2) {
          score += 60; // Presionar al rival
        }
      });
    }

    return {
      move,
      score,
      reachableSpace,
      canReachTail,
      nearestFoodDist,
      openNeighbors
    };
  });

  // Ordenar de mayor a menor puntuación
  scoredMoves.sort((a, b) => b.score - a.score);

  const bestChoice = scoredMoves[0];
  console.log(
    `[MOVE T${req.body.turn}] Salud: ${you.health} | Elegido: ${bestChoice.move} (Score: ${bestChoice.score}) | Espacio: ${bestChoice.reachableSpace} | ConectaCola: ${bestChoice.canReachTail}`
  );

  res.json({
    move: bestChoice.move,
    shout: `T${req.body.turn} ⚡`
  });
});

// 4. Fin de partida
app.post('/end', (req, res) => {
  console.log(`[END] Juego terminado: ${req.body.game.id}`);
  res.status(200).send('ok');
});

app.listen(PORT, () => {
  console.log(`🐍 Servidor Battlesnake escuchando en http://localhost:${PORT}`);
});
