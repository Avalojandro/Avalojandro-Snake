/**
 * @fileoverview Servidor Battlesnake de Nivel Gran Maestro / Competición Mundial
 * Arquitectura de producción con:
 * - Voronoi territorial de largo alcance
 * - Predicción multi-paso de movimientos enemigos (inercia + BFS + patrones)
 * - Estrategia pasivo-agresiva de encierro territorial (cut-off scoring)
 * - Anti-encierro propio (detección de pérdida territorial y escape preventivo)
 * - Paridad de Crecimiento Estricta en 1v1
 * - Evasión Preventiva de Choques (Buffer 2-Step & Grados de Libertad)
 * - Space Packing / Coiling Adaptativo y Tail Chasing Infinito
 */

const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8000;

// Direcciones cardinales estándar en Battlesnake
const DIRECTIONS = {
  up: { x: 0, y: 1 },
  down: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/**
 * @typedef {Object} Coord
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {Object} Battlesnake
 * @property {string} id
 * @property {string} name
 * @property {number} health
 * @property {Coord[]} body
 * @property {Coord} head
 * @property {number} length
 * @property {string} shout
 */

/**
 * @typedef {Object} Board
 * @property {number} height
 * @property {number} width
 * @property {Coord[]} food
 * @property {Coord[]} hazards
 * @property {Battlesnake[]} snakes
 */

/**
 * @typedef {Object} GameState
 * @property {Object} game
 * @property {number} turn
 * @property {Board} board
 * @property {Battlesnake} you
 */

// ==========================================
// 1. HELPERS MATEMÁTICOS Y DE COORDENADAS
// ==========================================

function to_key(coord) {
  return `${coord.x},${coord.y}`;
}

function from_key(key) {
  const parts = key.split(",");
  return { x: parseInt(parts[0], 10), y: parseInt(parts[1], 10) };
}

function manhattan_distance(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function is_valid_coord(coord, board) {
  return (
    coord.x >= 0 &&
    coord.x < board.width &&
    coord.y >= 0 &&
    coord.y < board.height
  );
}

function get_cardinal_neighbors(coord, board) {
  const neighbors = [
    { x: coord.x, y: coord.y + 1 }, // up
    { x: coord.x, y: coord.y - 1 }, // down
    { x: coord.x - 1, y: coord.y }, // left
    { x: coord.x + 1, y: coord.y }, // right
  ];
  return neighbors.filter((c) => is_valid_coord(c, board));
}

// ==========================================
// 2. PATHFINDING BFS Y EVALUACIÓN DE ESPACIO
// ==========================================

/**
 * Encuentra el camino más corto (BFS) desde startCoord hasta targetCoord evitando obstáculos.
 * @param {Coord} startCoord
 * @param {Coord} targetCoord
 * @param {Set<string>} obstacles
 * @param {Board} board
 * @returns {{ path: Coord[], distance: number } | null}
 */
function bfs_shortest_path(startCoord, targetCoord, obstacles, board) {
  const startKey = to_key(startCoord);
  const targetKey = to_key(targetCoord);

  if (startKey === targetKey) {
    return { path: [startCoord], distance: 0 };
  }

  const visited = new Set([startKey]);
  const parentMap = new Map();
  const queue = [startCoord];
  let headIdx = 0;
  let foundEnd = false;

  while (headIdx < queue.length) {
    const current = queue[headIdx++];
    const curKey = to_key(current);

    if (curKey === targetKey) {
      foundEnd = true;
      break;
    }

    const neighbors = get_cardinal_neighbors(current, board);
    for (let i = 0; i < neighbors.length; i++) {
      const neighbor = neighbors[i];
      const nKey = to_key(neighbor);

      const isTarget = nKey === targetKey;
      if (!visited.has(nKey) && (!obstacles.has(nKey) || isTarget)) {
        visited.add(nKey);
        parentMap.set(nKey, current);
        queue.push(neighbor);
      }
    }
  }

  if (!foundEnd) return null;

  const path = [];
  let curr = targetCoord;
  while (curr) {
    path.push(curr);
    const pKey = to_key(curr);
    curr = parentMap.get(pKey);
  }
  path.reverse();

  return { path, distance: path.length - 1 };
}

/**
 * Evalúa el espacio accesible (Flood Fill) y comprueba conectividad real con la cola propia (Tail Chasing).
 * @param {Coord} startCoord
 * @param {Set<string>} obstacles
 * @param {Board} board
 * @param {Coord} myTail
 * @returns {{ count: number, canReachTail: boolean }}
 */
function evaluate_space(startCoord, obstacles, board, myTail) {
  const startKey = to_key(startCoord);
  if (obstacles.has(startKey)) return { count: 0, canReachTail: false };

  const tailKey = myTail ? to_key(myTail) : null;
  const visited = new Set([startKey]);
  const queue = [startCoord];
  let reachableCount = 0;
  let canReachTail = false;

  let headIdx = 0;
  while (headIdx < queue.length) {
    const coord = queue[headIdx++];
    reachableCount++;

    if (tailKey && to_key(coord) === tailKey) {
      canReachTail = true;
    }

    const neighbors = get_cardinal_neighbors(coord, board);
    for (let i = 0; i < neighbors.length; i++) {
      const neighbor = neighbors[i];
      const key = to_key(neighbor);

      const isTail = tailKey && key === tailKey;
      if (!visited.has(key) && (!obstacles.has(key) || isTail)) {
        visited.add(key);
        queue.push(neighbor);
      }
    }
  }

  return { count: reachableCount, canReachTail };
}

/**
 * Calcula el control territorial Voronoi desde múltiples orígenes.
 * @param {Coord} myCandidateCoord
 * @param {Battlesnake[]} enemies
 * @param {Set<string>} obstacles
 * @param {Board} board
 * @returns {{ myTerritory: number, enemyTerritory: number, contestedTerritory: number }}
 */
function calculate_voronoi(myCandidateCoord, enemies, obstacles, board) {
  const distanceMap = new Map();
  const queue = [];

  const myKey = to_key(myCandidateCoord);
  distanceMap.set(myKey, { owner: "me", dist: 0 });
  queue.push({ coord: myCandidateCoord, owner: "me", dist: 0 });

  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i];
    const eKey = to_key(enemy.head);
    if (!distanceMap.has(eKey)) {
      distanceMap.set(eKey, { owner: "enemy", dist: 0 });
      queue.push({ coord: enemy.head, owner: "enemy", dist: 0 });
    }
  }

  let headIdx = 0;
  while (headIdx < queue.length) {
    const { coord, owner, dist } = queue[headIdx++];
    const neighbors = get_cardinal_neighbors(coord, board);

    for (let i = 0; i < neighbors.length; i++) {
      const neighbor = neighbors[i];
      const nKey = to_key(neighbor);

      if (obstacles.has(nKey)) continue;

      const existing = distanceMap.get(nKey);
      if (!existing) {
        distanceMap.set(nKey, { owner, dist: dist + 1 });
        queue.push({ coord: neighbor, owner, dist: dist + 1 });
      } else if (existing.dist === dist + 1 && existing.owner !== owner) {
        existing.owner = "contested";
      }
    }
  }

  let myTerritory = 0;
  let enemyTerritory = 0;
  let contestedTerritory = 0;

  for (const val of distanceMap.values()) {
    if (val.owner === "me") myTerritory++;
    else if (val.owner === "enemy") enemyTerritory++;
    else if (val.owner === "contested") contestedTerritory++;
  }

  return { myTerritory, enemyTerritory, contestedTerritory };
}

/**
 * Detecta si una casilla candidata conduce a una trampa de túnel o borde emboscada por un rival más grande.
 * @param {Coord} candidateCoord
 * @param {Set<string>} obstacles
 * @param {Set<string>} lethalDangerZones
 * @param {Board} board
 * @returns {boolean}
 */
function is_tunnel_trap(candidateCoord, obstacles, lethalDangerZones, board) {
  const freeNeighbors = get_cardinal_neighbors(candidateCoord, board).filter(
    (n) => !obstacles.has(to_key(n))
  );

  if (freeNeighbors.length <= 1) {
    if (freeNeighbors.length === 1) {
      const nextStep = freeNeighbors[0];
      if (lethalDangerZones.has(to_key(nextStep))) {
        return true;
      }
    } else {
      return true;
    }
  }

  // Lookahead a 2 pasos: verificar si todas las salidas futuras están bloqueadas o son letales
  let viableExits = 0;
  for (let i = 0; i < freeNeighbors.length; i++) {
    const n = freeNeighbors[i];
    const nKey = to_key(n);
    if (lethalDangerZones.has(nKey)) continue;

    const nextNeighbors = get_cardinal_neighbors(n, board).filter(
      (nn) => !obstacles.has(to_key(nn)) && to_key(nn) !== to_key(candidateCoord)
    );
    if (nextNeighbors.length > 0) {
      viableExits++;
    }
  }

  if (viableExits === 0) {
    return true; // Trampa ciega: ninguna salida tiene continuación segura
  }

  return false;
}

/**
 * Detecta si una casilla candidata pone a la serpiente en un sándwich o estrangulamiento peligroso
 * entre una pared exterior y el cuerpo de una serpiente enemiga.
 * @param {Coord} candidateCoord
 * @param {Battlesnake[]} enemies
 * @param {Board} board
 * @returns {boolean}
 */
function is_wall_squeeze_risk(candidateCoord, enemies, board) {
  const isNearWallX = candidateCoord.x <= 1 || candidateCoord.x >= board.width - 2;
  const isNearWallY = candidateCoord.y <= 1 || candidateCoord.y >= board.height - 2;

  if (!isNearWallX && !isNearWallY) return false;

  for (let e = 0; e < enemies.length; e++) {
    const enemy = enemies[e];
    for (let b = 0; b < enemy.body.length; b++) {
      const seg = enemy.body[b];
      const dist = manhattan_distance(candidateCoord, seg);
      if (dist <= 2) {
        // Pared izquierda y enemigo bloqueando escape hacia la derecha
        if (candidateCoord.x <= 1 && seg.x > candidateCoord.x && Math.abs(seg.y - candidateCoord.y) <= 1) {
          return true;
        }
        // Pared derecha y enemigo bloqueando escape hacia la izquierda
        if (candidateCoord.x >= board.width - 2 && seg.x < candidateCoord.x && Math.abs(seg.y - candidateCoord.y) <= 1) {
          return true;
        }
        // Pared inferior y enemigo bloqueando escape hacia arriba
        if (candidateCoord.y <= 1 && seg.y > candidateCoord.y && Math.abs(seg.x - candidateCoord.x) <= 1) {
          return true;
        }
        // Pared superior y enemigo bloqueando escape hacia abajo
        if (candidateCoord.y >= board.height - 2 && seg.y < candidateCoord.y && Math.abs(seg.x - candidateCoord.x) <= 1) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Detecta la trampa firma de Geriatric Jagwire: el "Ataúd Perimetral" (Parallel Wall Constriction).
 * Ocurre cuando nos movemos a una casilla perimetral exterior (X=0, X=W-1, Y=0, Y=H-1)
 * y un enemigo tiene un cuerpo alineado o avanzando en la línea paralela interior (X=1, X=W-2, Y=1, Y=H-2),
 * creando un túnel ciego de 1 celda de ancho que termina en muerte por choque frontal o pared.
 * @param {Coord} candidateCoord
 * @param {Coord} myHead
 * @param {Battlesnake[]} enemies
 * @param {Board} board
 * @returns {boolean}
 */
function is_perimeter_coffin_trap(candidateCoord, myHead, enemies, board) {
  const isOuterX0 = candidateCoord.x === 0;
  const isOuterXMax = candidateCoord.x === board.width - 1;
  const isOuterY0 = candidateCoord.y === 0;
  const isOuterYMax = candidateCoord.y === board.height - 1;

  if (!isOuterX0 && !isOuterXMax && !isOuterY0 && !isOuterYMax) {
    return false; // No estamos en el perímetro exterior absoluto
  }

  for (let e = 0; e < enemies.length; e++) {
    const enemy = enemies[e];
    const enemyHead = enemy.head;
    const enemyBody = enemy.body;

    // Caso 1: Borde izquierdo (X=0). Verificar si el enemigo tiene muro en X=1
    if (isOuterX0) {
      let parallelSegments = 0;
      for (let b = 0; b < enemyBody.length; b++) {
        const seg = enemyBody[b];
        if (seg.x === 1 && Math.abs(seg.y - candidateCoord.y) <= 3) {
          parallelSegments++;
        }
      }
      if (parallelSegments >= 2 || (enemyHead.x === 1 && Math.abs(enemyHead.y - candidateCoord.y) <= 4)) {
        return true;
      }
    }

    // Caso 2: Borde derecho (X = width - 1). Verificar si el enemigo tiene muro en X = width - 2
    if (isOuterXMax) {
      const parallelX = board.width - 2;
      let parallelSegments = 0;
      for (let b = 0; b < enemyBody.length; b++) {
        const seg = enemyBody[b];
        if (seg.x === parallelX && Math.abs(seg.y - candidateCoord.y) <= 3) {
          parallelSegments++;
        }
      }
      if (parallelSegments >= 2 || (enemyHead.x === parallelX && Math.abs(enemyHead.y - candidateCoord.y) <= 4)) {
        return true;
      }
    }

    // Caso 3: Borde inferior (Y=0). Verificar si el enemigo tiene muro en Y=1
    if (isOuterY0) {
      let parallelSegments = 0;
      for (let b = 0; b < enemyBody.length; b++) {
        const seg = enemyBody[b];
        if (seg.y === 1 && Math.abs(seg.x - candidateCoord.x) <= 3) {
          parallelSegments++;
        }
      }
      if (parallelSegments >= 2 || (enemyHead.y === 1 && Math.abs(enemyHead.x - candidateCoord.x) <= 4)) {
        return true;
      }
    }

    // Caso 4: Borde superior (Y = height - 1). Verificar si el enemigo tiene muro en Y = height - 2
    if (isOuterYMax) {
      const parallelY = board.height - 2;
      let parallelSegments = 0;
      for (let b = 0; b < enemyBody.length; b++) {
        const seg = enemyBody[b];
        if (seg.y === parallelY && Math.abs(seg.x - candidateCoord.x) <= 3) {
          parallelSegments++;
        }
      }
      if (parallelSegments >= 2 || (enemyHead.y === parallelY && Math.abs(enemyHead.x - candidateCoord.x) <= 4)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Detecta si un movimiento nos auto-confinaría en una franja angosta de 2 o 3 celdas pegada a la pared
 * (ej. X=0,1 o Y=0,1) donde nuestro propio cuerpo ya ocupa gran parte de la franja (Logs 21 y 22),
 * facilitándole a Jagwire sellar la única salida con un bloqueo en L o compuerta.
 * @param {Coord} candidateCoord
 * @param {Battlesnake} you
 * @param {Board} board
 * @param {Battlesnake[]} enemies
 * @returns {boolean}
 */
function is_narrow_band_confinement(candidateCoord, you, board, enemies) {
  // Franja vertical izquierda (X <= 1)
  if (candidateCoord.x <= 1) {
    let ownSegmentsInBand = 0;
    for (let b = 0; b < you.body.length; b++) {
      if (you.body[b].x <= 1) ownSegmentsInBand++;
    }
    if (ownSegmentsInBand >= 4 && ownSegmentsInBand >= you.body.length * 0.4) {
      for (let e = 0; e < enemies.length; e++) {
        for (let eb = 0; eb < enemies[e].body.length; eb++) {
          const eseg = enemies[e].body[eb];
          if ((eseg.x === 2 || eseg.x === 3) && Math.abs(eseg.y - candidateCoord.y) <= 3) {
            return true;
          }
        }
      }
    }
  }

  // Franja vertical derecha (X >= width - 2)
  if (candidateCoord.x >= board.width - 2) {
    let ownSegmentsInBand = 0;
    for (let b = 0; b < you.body.length; b++) {
      if (you.body[b].x >= board.width - 2) ownSegmentsInBand++;
    }
    if (ownSegmentsInBand >= 4 && ownSegmentsInBand >= you.body.length * 0.4) {
      for (let e = 0; e < enemies.length; e++) {
        for (let eb = 0; eb < enemies[e].body.length; eb++) {
          const eseg = enemies[e].body[eb];
          if ((eseg.x === board.width - 3 || eseg.x === board.width - 4) && Math.abs(eseg.y - candidateCoord.y) <= 3) {
            return true;
          }
        }
      }
    }
  }

  // Franja horizontal inferior (Y <= 1)
  if (candidateCoord.y <= 1) {
    let ownSegmentsInBand = 0;
    for (let b = 0; b < you.body.length; b++) {
      if (you.body[b].y <= 1) ownSegmentsInBand++;
    }
    if (ownSegmentsInBand >= 4 && ownSegmentsInBand >= you.body.length * 0.4) {
      for (let e = 0; e < enemies.length; e++) {
        for (let eb = 0; eb < enemies[e].body.length; eb++) {
          const eseg = enemies[e].body[eb];
          if ((eseg.y === 2 || eseg.y === 3) && Math.abs(eseg.x - candidateCoord.x) <= 3) {
            return true;
          }
        }
      }
    }
  }

  // Franja horizontal superior (Y >= height - 2)
  if (candidateCoord.y >= board.height - 2) {
    let ownSegmentsInBand = 0;
    for (let b = 0; b < you.body.length; b++) {
      if (you.body[b].y >= board.height - 2) ownSegmentsInBand++;
    }
    if (ownSegmentsInBand >= 4 && ownSegmentsInBand >= you.body.length * 0.4) {
      for (let e = 0; e < enemies.length; e++) {
        for (let eb = 0; eb < enemies[e].body.length; eb++) {
          const eseg = enemies[e].body[eb];
          if ((eseg.y === board.height - 3 || eseg.y === board.height - 4) && Math.abs(eseg.x - candidateCoord.x) <= 3) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Detecta si una casilla candidateCoord conduce a una trampa mortal en esquina (0,0), (0,H-1), (W-1,0), (W-1,H-1)
 * cuando un enemigo igual o mayor está a distancia de corte <= 3.
 * @param {Coord} candidateCoord
 * @param {Battlesnake[]} enemies
 * @param {number} myLength
 * @param {Board} board
 * @returns {boolean}
 */
function is_corner_pocket_trap(candidateCoord, enemies, myLength, board) {
  const corners = [
    { x: 0, y: 0 },
    { x: 0, y: board.height - 1 },
    { x: board.width - 1, y: 0 },
    { x: board.width - 1, y: board.height - 1 },
  ];

  for (let i = 0; i < corners.length; i++) {
    const corner = corners[i];
    const distToCorner = manhattan_distance(candidateCoord, corner);
    // Si la casilla candidata está en la esquina o a 1 paso de la esquina
    if (distToCorner <= 1) {
      for (let e = 0; e < enemies.length; e++) {
        const enemy = enemies[e];
        if (enemy.length >= myLength) {
          const enemyDistToCorner = manhattan_distance(enemy.head, corner);
          const enemyDistToCand = manhattan_distance(enemy.head, candidateCoord);
          // Si el enemigo grande está cerca del acceso a esa esquina (distancia <= 3)
          if (enemyDistToCorner <= 3 || enemyDistToCand <= 3) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

// ==========================================
// 2.5 PREDICCIÓN MULTI-PASO DEL ENEMIGO Y ENCIERRO PASIVO-AGRESIVO
// ==========================================

/**
 * Predice las posiciones futuras del enemigo (2-3 pasos) basándose en:
 * 1. Inercia lineal (dirección actual)
 * 2. Atracción hacia comida cercana
 * 3. Espacio disponible (evita paredes y obstáculos)
 * @param {Battlesnake} enemy
 * @param {Set<string>} obstacles
 * @param {Board} board
 * @param {Coord[]} food
 * @returns {{ predictedPositions: Coord[], confidence: number }}
 */
function predict_enemy_moves(enemy, obstacles, board, food) {
  const predictions = [];
  const confidences = [];
  if (enemy.body.length < 2) return { predictedPositions: [], confidences: [], confidence: 0 };

  const head = enemy.head;
  const neck = enemy.body[1];

  // Paso 1: Calcular todas las opciones del enemigo en cada paso
  let currentPos = { ...head };
  let prevPos = { ...neck };
  let confidence = 0.8;

  for (let step = 0; step < 3; step++) {
    const stepDx = currentPos.x - prevPos.x;
    const stepDy = currentPos.y - prevPos.y;

    // Candidatos: continuar recto, girar izquierda, girar derecha
    const candidates = [];

    // Movimiento recto (inercia)
    const straight = { x: currentPos.x + stepDx, y: currentPos.y + stepDy };
    if (is_valid_coord(straight, board) && !obstacles.has(to_key(straight))) {
      candidates.push({ coord: straight, priority: 3 }); // Mayor prioridad
    }

    // Giros perpendiculares
    const perp1 = { x: currentPos.x + stepDy, y: currentPos.y - stepDx };
    const perp2 = { x: currentPos.x - stepDy, y: currentPos.y + stepDx };

    if (is_valid_coord(perp1, board) && !obstacles.has(to_key(perp1))) {
      candidates.push({ coord: perp1, priority: 1 });
    }
    if (is_valid_coord(perp2, board) && !obstacles.has(to_key(perp2))) {
      candidates.push({ coord: perp2, priority: 1 });
    }

    if (candidates.length === 0) break;

    // Bonus de atracción hacia comida cercana
    if (food && food.length > 0 && enemy.health < 80) {
      for (const cand of candidates) {
        let minFoodDist = Infinity;
        for (const f of food) {
          const dist = manhattan_distance(cand.coord, f);
          if (dist < minFoodDist) minFoodDist = dist;
        }
        if (minFoodDist <= 3) cand.priority += 2;
      }
    }

    // Bonus por espacio abierto (evitar callejones)
    for (const cand of candidates) {
      const freeNeighbors = get_cardinal_neighbors(cand.coord, board).filter(
        (n) => !obstacles.has(to_key(n))
      );
      cand.priority += freeNeighbors.length * 0.5;
    }

    // Elegir el candidato con mayor prioridad
    candidates.sort((a, b) => b.priority - a.priority);
    const best = candidates[0];

    predictions.push(best.coord);
    confidences.push(confidence);
    prevPos = { ...currentPos };
    currentPos = { ...best.coord };
    confidence *= 0.7; // La confianza decrece con cada paso
  }

  return { predictedPositions: predictions, confidences, confidence: confidences[0] || 0 };
}

/**
 * Calcula el score de encierro pasivo-agresivo (cut-off scoring).
 * Mide cuánto territorio le quitamos al oponente al movernos a una posición candidata.
 * @param {Coord} candidateCoord - Nuestra posición candidata
 * @param {Battlesnake} enemy - El rival principal
 * @param {Set<string>} obstacles - Obstáculos actuales
 * @param {Board} board
 * @param {number} myLength - Nuestra longitud
 * @returns {{ cutoffScore: number, enemySpaceAfter: number, mySpaceAfter: number }}
 */
function calculate_cutoff_score(candidateCoord, enemy, obstacles, board, myLength) {
  // Calcular el espacio del enemigo SIN nuestro movimiento
  const enemySpaceBefore = evaluate_space(enemy.head, obstacles, board, null);

  // Calcular el espacio del enemigo CON nuestro movimiento bloqueando
  const obstaclesWithUs = new Set(obstacles);
  obstaclesWithUs.add(to_key(candidateCoord));

  const enemySpaceAfter = evaluate_space(enemy.head, obstaclesWithUs, board, null);

  // Cuánto territorio le recortamos
  const spaceLost = enemySpaceBefore.count - enemySpaceAfter.count;

  // Calcular nuestro propio espacio después del movimiento
  const mySpaceAfter = evaluate_space(candidateCoord, obstacles, board, null);

  let cutoffScore = 0;

  // Solo premiamos el encierro si:
  // 1. Nosotros no nos encerramos en el proceso (nuestro espacio sigue siendo viable)
  // 2. Le quitamos territorio significativo al rival
  if (mySpaceAfter.count >= myLength && spaceLost > 3) {
    cutoffScore = spaceLost * 8; // Cada casilla que le quitamos vale puntos

    // Bonus extra si lo dejamos con espacio crítico
    if (enemySpaceAfter.count < enemy.length) {
      cutoffScore += 300; // ¡Lo estamos encerrando fatalmente!
    } else if (enemySpaceAfter.count < enemy.length * 2) {
      cutoffScore += 150; // Lo estamos apretando
    }

    // Bonus si le cortamos el acceso a su cola (no puede hacer tail chase)
    if (!enemySpaceAfter.canReachTail && enemySpaceBefore.canReachTail) {
      cutoffScore += 200;
    }
  }

  return { cutoffScore, enemySpaceAfter: enemySpaceAfter.count, mySpaceAfter: mySpaceAfter.count };
}

// ==========================================
// 2.5. EVALUACIÓN Y CONSTRUCCIÓN DE MURALLA / PARTICIÓN DE TABLERO (ESTILO FIRSTTRY / LOG 101)
// ==========================================

/**
 * Evalúa si un movimiento candidato completa o avanza una partición topológica que divide
 * el tablero en dos componentes disjuntas, atrapando al rival en un sub-espacio menor a su tamaño.
 * @param {Coord} candidateCoord
 * @param {Battlesnake} you
 * @param {Battlesnake} enemy
 * @param {Set<string>} solidObstacles
 * @param {Board} board
 * @returns {{ isLethalPartition: boolean, isPartition: boolean, enemySubSpace: number, mySubSpace: number, scoreBonus: number }}
 */
function evaluate_board_partition(candidateCoord, you, enemy, solidObstacles, board) {
  // 1. Calcular espacio del enemigo ANTES de nuestro movimiento
  const enemySpaceBefore = evaluate_space(enemy.head, solidObstacles, board, null);

  const obstaclesWithCandidate = new Set(solidObstacles);
  obstaclesWithCandidate.add(to_key(candidateCoord));

  // 2. Calcular espacio del enemigo DESPUÉS de nuestro movimiento bloqueando
  const enemySpaceAfter = evaluate_space(enemy.head, obstaclesWithCandidate, board, null);

  const spaceLost = enemySpaceBefore.count - enemySpaceAfter.count;

  // Nuestro propio espacio tras este movimiento (con nuestra cola como salida segura si aplica)
  const myTail = you.body[you.body.length - 1];
  const mySpace = evaluate_space(candidateCoord, obstaclesWithCandidate, board, myTail);

  let scoreBonus = 0;
  let isLethalPartition = false;
  let isPartition = false;

  // Solo consideramos partición si nuestro propio espacio es viable y seguro
  const isSafeForUs = mySpace.count >= you.length && (mySpace.canReachTail || mySpace.count >= you.length * 1.5);

  if (isSafeForUs && spaceLost >= 4) {
    if (enemySpaceAfter.count < enemy.length) {
      // Jaque mate absoluto: el rival no cabe físicamente en el sub-espacio
      isLethalPartition = true;
      isPartition = true;
      scoreBonus = 2400 + (enemy.length - enemySpaceAfter.count) * 60;
    } else if (spaceLost >= 25 || enemySpaceAfter.count < enemy.length * 1.8) {
      // Partición masiva de tablero: le arrebatamos un tercio o más del tablero y lo dejamos atrapado
      isLethalPartition = true;
      isPartition = true;
      scoreBonus = 1800 + spaceLost * 25;
    } else if (enemySpaceAfter.count < enemy.length * 2.5) {
      isPartition = true;
      scoreBonus = 600 + spaceLost * 15;
    }
  }

  return {
    isLethalPartition,
    isPartition,
    enemySubSpace: enemySpaceAfter.count,
    mySubSpace: mySpace.count,
    scoreBonus,
  };
}

/**
 * Premia la construcción y extensión activa de murallas horizontales o verticales continuas
 * de borde a borde (Wall Slicing) inspirada en firsttry (Log 101).
 * @param {Coord} candidateCoord
 * @param {Battlesnake} you
 * @param {Battlesnake} enemy
 * @param {Set<string>} solidObstacles
 * @param {Board} board
 * @returns {number}
 */
function calculate_wall_slicing_bonus(candidateCoord, you, enemy, solidObstacles, board) {
  // Solo activar muralla slicing cuando tenemos longitud suficiente (>= 13) y ventaja o paridad
  if (you.length < 13 || you.length < enemy.length) return 0;

  // No premiar muralla si el movimiento es un riesgo directo de estrangulamiento
  if (is_wall_squeeze_risk(candidateCoord, [enemy], board)) return 0;

  let slicingBonus = 0;

  // Detección de la orientación de corte según la posición del enemigo:
  const isEnemyTop = enemy.head.y >= 7;
  const isEnemyBottom = enemy.head.y <= 3;
  const isEnemyLeft = enemy.head.x <= 3;
  const isEnemyRight = enemy.head.x >= 7;

  if (isEnemyTop || isEnemyBottom) {
    let bodyCountInRow = 0;
    for (let i = 1; i < you.body.length; i++) {
      if (Math.abs(you.body[i].y - candidateCoord.y) <= 1) {
        bodyCountInRow++;
      }
    }

    if (bodyCountInRow >= 4) {
      slicingBonus += 250;
      // Bono de sellado perimetral contra la pared lateral (Door-Cap)
      if (candidateCoord.x === 0 || candidateCoord.x === board.width - 1) {
        slicingBonus += 600;
      }
    }
  }

  if (isEnemyLeft || isEnemyRight) {
    let bodyCountInCol = 0;
    for (let i = 1; i < you.body.length; i++) {
      if (Math.abs(you.body[i].x - candidateCoord.x) <= 1) {
        bodyCountInCol++;
      }
    }

    if (bodyCountInCol >= 4) {
      slicingBonus += 250;
      // Bono de sellado perimetral contra la pared superior/inferior (Door-Cap)
      if (candidateCoord.y === 0 || candidateCoord.y === board.height - 1) {
        slicingBonus += 600;
      }
    }
  }

  return slicingBonus;
}

/**
 * Detecta si el rival está intentando una partición o corte que nos atraparía en un sub-espacio mortal,
 * y premia fuertemente el cruce/fuga hacia el lado abierto antes de que se selle.
 * @param {Coord} candidateCoord
 * @param {Battlesnake} you
 * @param {Battlesnake} enemy
 * @param {Set<string>} solidObstacles
 * @param {Board} board
 * @returns {number}
 */
function detect_anti_partition_danger(candidateCoord, you, enemy, solidObstacles, board) {
  // Evaluamos si el candidato nos lleva al área abierta o al bolsillo cerrado
  const spaceCandidate = evaluate_space(candidateCoord, solidObstacles, board, null);
  const myHeadSpace = evaluate_space(you.head, solidObstacles, board, null);

  // Si nuestro espacio actual ya está reducido o bajo amenaza
  if (myHeadSpace.count <= you.length * 2.5) {
    // Si este movimiento nos expande significativamente el espacio (brecha de escape)
    if (spaceCandidate.count > myHeadSpace.count + 5 && spaceCandidate.count >= you.length * 1.5) {
      return 850; // ¡Fuga hacia espacio abierto!
    }

    // Si el movimiento nos internaría más profundo en una bolsa donde no cabemos
    if (spaceCandidate.count < you.length) {
      return -1500; // Rechazo categórico a entrar en el fondo del cerco
    }
  }

  return 0;
}

// ==========================================
// 3. PIPELINE DE DECISIÓN ALGORÍTMICO
// ==========================================

/**
 * Obtiene los movimientos seguros, obstáculos sólidos y zonas de peligro.
 */
function get_safe_moves(board, you) {
  const solidObstacles = new Set();
  const lethalDangerZones = new Set();
  const huntingZones = new Set();
  const enemyHeads = [];
  const vacatingTails = new Set();
  const threatCountPerCoord = new Map();

  // 1. Cuerpos de todas las serpientes
  for (let s = 0; s < board.snakes.length; s++) {
    const snake = board.snakes[s];
    const body = snake.body;
    const bodyLen = body.length;

    const isTailStacked =
      bodyLen > 1 &&
      body[bodyLen - 1].x === body[bodyLen - 2].x &&
      body[bodyLen - 1].y === body[bodyLen - 2].y;

    const tailWillVacate = snake.health < 100 && !isTailStacked;
    const tailCoord = body[bodyLen - 1];

    if (tailWillVacate) {
      vacatingTails.add(to_key(tailCoord));
    }

    for (let i = 0; i < body.length; i++) {
      solidObstacles.add(to_key(body[i]));
    }

    // 2. Análisis de cabezas rivales
    if (snake.id !== you.id) {
      enemyHeads.push(snake);
      const enemyNeighbors = get_cardinal_neighbors(snake.head, board);
      const isDangerous = snake.length >= you.length;

      for (let i = 0; i < enemyNeighbors.length; i++) {
        const neighbor = enemyNeighbors[i];
        const neighborKey = to_key(neighbor);

        threatCountPerCoord.set(
          neighborKey,
          (threatCountPerCoord.get(neighborKey) || 0) + 1
        );

        if (isDangerous) {
          lethalDangerZones.add(neighborKey);
        } else {
          huntingZones.add(neighborKey);
        }
      }
    }
  }

  // 3. Filtrar las 4 direcciones para nuestra cabeza
  const myHead = you.head;
  const legalMoves = [];
  const safeMoves = [];

  const directionsList = Object.keys(DIRECTIONS);
  for (let i = 0; i < directionsList.length; i++) {
    const move = directionsList[i];
    const offset = DIRECTIONS[move];
    const targetCoord = { x: myHead.x + offset.x, y: myHead.y + offset.y };
    const targetKey = to_key(targetCoord);

    if (!is_valid_coord(targetCoord, board)) continue;

    if (you.body.length > 1) {
      const neck = you.body[1];
      if (targetCoord.x === neck.x && targetCoord.y === neck.y) continue;
    }

    const isSolid = solidObstacles.has(targetKey);
    const isVacating = vacatingTails.has(targetKey);

    if (isSolid && !isVacating) continue;

    legalMoves.push({ move, coord: targetCoord });

    if (!lethalDangerZones.has(targetKey)) {
      safeMoves.push({
        move,
        coord: targetCoord,
        isHunting: huntingZones.has(targetKey),
        threats: threatCountPerCoord.get(targetKey) || 0,
      });
    }
  }

  return {
    safeMoves,
    legalMoves,
    solidObstacles,
    lethalDangerZones,
    enemyHeads,
    vacatingTails,
    threatCountPerCoord,
  };
}

/**
 * Calcula el bono de empaquetado espacial adaptativo (solo para serpientes de longitud >= 10).
 * @param {Coord} targetCoord
 * @param {Battlesnake} you
 * @param {Board} board
 * @returns {number}
 */
function calculate_coiling_bonus(targetCoord, you, board) {
  // Solo aplicar coiling si la serpiente tiene suficiente longitud para justificar empaquetamiento
  if (you.length < 10) return 0;

  let adjacentBodySegments = 0;
  let adjacentWalls = 0;

  const neighbors = [
    { x: targetCoord.x + 1, y: targetCoord.y },
    { x: targetCoord.x - 1, y: targetCoord.y },
    { x: targetCoord.x, y: targetCoord.y + 1 },
    { x: targetCoord.x, y: targetCoord.y - 1 },
  ];

  for (let i = 0; i < neighbors.length; i++) {
    const n = neighbors[i];
    if (!is_valid_coord(n, board)) {
      adjacentWalls++;
    } else {
      for (let b = 2; b < you.body.length; b++) {
        if (you.body[b].x === n.x && you.body[b].y === n.y) {
          adjacentBodySegments++;
          break;
        }
      }
    }
  }

  // NUNCA premiar empaquetarse contra paredes exteriores (conduce a trampas de encierro mortal)
  if (adjacentWalls > 0) return 0;

  if (adjacentBodySegments === 1) return 20;
  if (adjacentBodySegments === 2) return 40;
  if (adjacentBodySegments >= 3) return -200;

  return 0;
}

// ==========================================
// 2.7.5. DETECCIÓN DE CARRERA MORTAL EN PARED (Wall-Race Trap - LOG 103)
// ==========================================

/**
 * Detecta cuando nuestra serpiente corre a lo largo de un borde del tablero con un enemigo
 * persiguiendo en paralelo por el interior. Si somos más cortos que el enemigo, continuar
 * hacia la esquina garantiza muerte por colisión de cabezas o encierro en esquina.
 *
 * @param {Coord} candidateCoord - Posición candidata a evaluar
 * @param {Coord} myHead - Posición actual de nuestra cabeza
 * @param {number} myLength - Nuestra longitud
 * @param {Array} enemies - Lista de serpientes enemigas
 * @param {Board} board - Estado del tablero
 * @param {Set<string>} solidObstacles - Obstáculos sólidos
 * @returns {{ isWallRace: boolean, penalty: number, escapeBonus: number, cornerDist: number, wallAxis: string }}
 */
function detect_wall_race_trap(candidateCoord, myHead, myLength, enemies, board, solidObstacles) {
  const result = { isWallRace: false, penalty: 0, escapeBonus: 0, cornerDist: Infinity, wallAxis: "" };
  if (enemies.length === 0) return result;

  const W = board.width;
  const H = board.height;

  const headOnLeftWall = myHead.x === 0;
  const headOnRightWall = myHead.x === W - 1;
  const headOnBottomWall = myHead.y === 0;
  const headOnTopWall = myHead.y === H - 1;
  const headOnVerticalWall = headOnLeftWall || headOnRightWall;
  const headOnHorizontalWall = headOnBottomWall || headOnTopWall;

  if (!headOnVerticalWall && !headOnHorizontalWall) return result;

  for (const enemy of enemies) {
    if (enemy.length < myLength) continue;

    const eHead = enemy.head;
    const eNeck = enemy.body.length > 1 ? enemy.body[1] : eHead;

    if (headOnVerticalWall) {
      const colDist = Math.abs(eHead.x - myHead.x);
      if (colDist < 1 || colDist > 2) continue;

      const yDist = Math.abs(eHead.y - myHead.y);
      if (yDist > 4) continue;

      // Si el candidato se mueve FUERA de la pared → bonus de escape
      const candidateMovesAlongWall = candidateCoord.x === myHead.x;
      if (!candidateMovesAlongWall) {
        result.escapeBonus = 600;
        if (enemy.length > myLength) result.escapeBonus = 900;
        result.isWallRace = true;
        result.wallAxis = "vertical";
        return result;
      }

      const movingUp = candidateCoord.y > myHead.y;
      const movingDown = candidateCoord.y < myHead.y;

      let cornerDist = Infinity;
      if (movingUp) cornerDist = (H - 1) - candidateCoord.y;
      else if (movingDown) cornerDist = candidateCoord.y;

      const enemyMovingUp = eHead.y > eNeck.y;
      const enemyMovingDown = eHead.y < eNeck.y;
      const enemyParallel = (movingUp && enemyMovingUp) || (movingDown && enemyMovingDown);
      const enemyCouldCutCorner = (movingUp && eHead.y >= myHead.y - 1) || (movingDown && eHead.y <= myHead.y + 1);

      if ((enemyParallel || enemyCouldCutCorner) && cornerDist <= 6) {
        result.isWallRace = true;
        result.wallAxis = "vertical";
        result.cornerDist = cornerDist;

        if (cornerDist <= 1) result.penalty = 3500;
        else if (cornerDist <= 2) result.penalty = 2800;
        else if (cornerDist <= 3) result.penalty = 2200;
        else if (cornerDist <= 4) result.penalty = 1600;
        else if (cornerDist <= 5) result.penalty = 1200;
        else result.penalty = 900;

        if (enemy.length > myLength) result.penalty += 800;

        // Sin escape al interior → peor
        const interiorX = headOnLeftWall ? 1 : W - 2;
        const interiorKey = to_key({ x: interiorX, y: myHead.y });
        if (solidObstacles.has(interiorKey)) result.penalty += 500;

        return result;
      }
    }

    if (headOnHorizontalWall) {
      const rowDist = Math.abs(eHead.y - myHead.y);
      if (rowDist < 1 || rowDist > 2) continue;

      const xDist = Math.abs(eHead.x - myHead.x);
      if (xDist > 4) continue;

      const candidateMovesAlongWall = candidateCoord.y === myHead.y;
      if (!candidateMovesAlongWall) {
        result.escapeBonus = 600;
        if (enemy.length > myLength) result.escapeBonus = 900;
        result.isWallRace = true;
        result.wallAxis = "horizontal";
        return result;
      }

      const movingRight = candidateCoord.x > myHead.x;
      const movingLeft = candidateCoord.x < myHead.x;

      let cornerDist = Infinity;
      if (movingRight) cornerDist = (W - 1) - candidateCoord.x;
      else if (movingLeft) cornerDist = candidateCoord.x;

      const enemyMovingRight = eHead.x > eNeck.x;
      const enemyMovingLeft = eHead.x < eNeck.x;
      const enemyParallel = (movingRight && enemyMovingRight) || (movingLeft && enemyMovingLeft);
      const enemyCouldCutCorner = (movingRight && eHead.x >= myHead.x - 1) || (movingLeft && eHead.x <= myHead.x + 1);

      if ((enemyParallel || enemyCouldCutCorner) && cornerDist <= 6) {
        result.isWallRace = true;
        result.wallAxis = "horizontal";
        result.cornerDist = cornerDist;

        if (cornerDist <= 1) result.penalty = 3500;
        else if (cornerDist <= 2) result.penalty = 2800;
        else if (cornerDist <= 3) result.penalty = 2200;
        else if (cornerDist <= 4) result.penalty = 1600;
        else if (cornerDist <= 5) result.penalty = 1200;
        else result.penalty = 900;

        if (enemy.length > myLength) result.penalty += 800;

        const interiorY = headOnBottomWall ? 1 : H - 2;
        const interiorKey = to_key({ x: myHead.x, y: interiorY });
        if (solidObstacles.has(interiorKey)) result.penalty += 500;

        return result;
      }
    }
  }

  return result;
}

// ==========================================
// 2.8. DETECCIÓN DE BUCLES / CICLOS REPETITIVOS Y ÁREA ABIERTA (LOG 102)
// ==========================================

// Almacén de historial de movimientos en memoria por partida
const gameHistoryMap = new Map();

/**
 * Limpia historiales antiguos si el mapa supera un límite razonable.
 */
function clean_old_game_history() {
  if (gameHistoryMap.size > 100) {
    const keys = Array.from(gameHistoryMap.keys());
    for (let i = 0; i < 30; i++) {
      gameHistoryMap.delete(keys[i]);
    }
  }
}

/**
 * Limpia el historial de una partida finalizada o iniciada.
 * @param {string} gameId
 */
function clear_game_history(gameId) {
  if (gameId && gameHistoryMap.has(gameId)) {
    gameHistoryMap.delete(gameId);
  }
}

/**
 * Analiza el historial de movimientos de la serpiente en la partida actual para detectar
 * si ha completado 4 o más vueltas/ciclos repetitivos en una misma zona/corredor.
 * @param {string} gameId
 * @param {number} turn
 * @param {Coord} head
 * @param {number} health
 * @param {number} length
 * @returns {{ isLooping: boolean, laps: number, period: number, bounds: { minX: number, maxX: number, minY: number, maxY: number } | null }}
 */
function track_and_detect_loops(gameId, turn, head, health, length) {
  if (!gameId) {
    return { isLooping: false, laps: 0, period: 0, bounds: null };
  }

  let record = gameHistoryMap.get(gameId);
  if (!record) {
    clean_old_game_history();
    record = {
      positions: [],
      lastLength: length,
      lastGrowthTurn: turn,
    };
    gameHistoryMap.set(gameId, record);
  }

  // Si crecimos de tamaño, actualizamos el turno de crecimiento
  if (length > record.lastLength) {
    record.lastLength = length;
    record.lastGrowthTurn = turn;
  }

  // Registrar posición actual (evitar duplicar si el mismo turno se llama más de una vez)
  const lastPos = record.positions.length > 0 ? record.positions[record.positions.length - 1] : null;
  if (!lastPos || lastPos.turn !== turn) {
    record.positions.push({ turn, x: head.x, y: head.y });
    if (record.positions.length > 250) {
      record.positions.shift();
    }
  }

  const positions = record.positions;
  const N = positions.length;
  if (N < 16) {
    return { isLooping: false, laps: 0, period: 0, bounds: null };
  }

  const curr = positions[N - 1];

  // 1. Detección por retornos periódicos exactos/casi exactos al punto actual
  const matches = [];
  for (let i = N - 2; i >= 0; i--) {
    if (positions[i].x === curr.x && positions[i].y === curr.y) {
      matches.push(i);
    }
  }

  if (matches.length >= 3) {
    // Calcular intervalos entre retornos
    const intervals = [];
    intervals.push(N - 1 - matches[0]);
    for (let m = 0; m < matches.length - 1; m++) {
      intervals.push(matches[m] - matches[m + 1]);
    }

    const basePeriod = intervals[0];
    if (basePeriod >= 4 && basePeriod <= 35) {
      let consistentLaps = 1;
      for (let k = 1; k < intervals.length; k++) {
        if (Math.abs(intervals[k] - basePeriod) <= 3) {
          consistentLaps++;
        } else {
          break;
        }
      }

      if (consistentLaps >= 3) { // 3 intervalos periódicos = 4 visitas completas = 4 vueltas
        const cycleTurns = basePeriod;
        const recent = positions.slice(Math.max(0, N - cycleTurns));
        const minX = Math.min(...recent.map((p) => p.x));
        const maxX = Math.max(...recent.map((p) => p.x));
        const minY = Math.min(...recent.map((p) => p.y));
        const maxY = Math.max(...recent.map((p) => p.y));

        return {
          isLooping: true,
          laps: consistentLaps + 1,
          period: basePeriod,
          bounds: { minX, maxX, minY, maxY },
        };
      }
    }
  }

  // 2. Detección secundaria: Confinamiento persistente en franja angosta con múltiples oscilaciones
  // Si en los últimos 40+ turnos sin crecer, el rango de X o Y ha sido <= 2 y se han visitado las mismas casillas >= 4 veces
  if (N >= 40 && turn - record.lastGrowthTurn >= 30) {
    const window = positions.slice(N - 40);
    const minX = Math.min(...window.map((p) => p.x));
    const maxX = Math.max(...window.map((p) => p.x));
    const minY = Math.min(...window.map((p) => p.y));
    const maxY = Math.max(...window.map((p) => p.y));

    const isNarrowCorridor = (maxX - minX <= 2) || (maxY - minY <= 2);
    if (isNarrowCorridor) {
      const freqMap = {};
      let maxFreq = 0;
      window.forEach((p) => {
        const k = `${p.x},${p.y}`;
        freqMap[k] = (freqMap[k] || 0) + 1;
        if (freqMap[k] > maxFreq) maxFreq = freqMap[k];
      });

      if (maxFreq >= 4) {
        return {
          isLooping: true,
          laps: maxFreq,
          period: Math.round(40 / maxFreq),
          bounds: { minX, maxX, minY, maxY },
        };
      }
    }
  }

  return { isLooping: false, laps: 0, period: 0, bounds: null };
}

/**
 * Encuentra el centroide y tamaño de la región conexa libre más grande del tablero (Área más abierta).
 * @param {Board} board
 * @param {Set<string>} solidObstacles
 * @returns {{ x: number, y: number, size: number, tiles: Coord[] }}
 */
function find_largest_open_area(board, solidObstacles) {
  const visited = new Set();
  let largestRegion = [];

  for (let x = 0; x < board.width; x++) {
    for (let y = 0; y < board.height; y++) {
      const key = `${x},${y}`;
      if (solidObstacles.has(key) || visited.has(key)) continue;

      const region = [];
      const queue = [{ x, y }];
      visited.add(key);

      while (queue.length > 0) {
        const curr = queue.shift();
        region.push(curr);
        const neighbors = get_cardinal_neighbors(curr, board);
        for (let i = 0; i < neighbors.length; i++) {
          const n = neighbors[i];
          const nKey = to_key(n);
          if (!visited.has(nKey) && !solidObstacles.has(nKey)) {
            visited.add(nKey);
            queue.push(n);
          }
        }
      }

      if (region.length > largestRegion.length) {
        largestRegion = region;
      }
    }
  }

  if (largestRegion.length === 0) {
    return {
      x: Math.floor(board.width / 2),
      y: Math.floor(board.height / 2),
      size: 0,
      tiles: [],
    };
  }

  const avgX = Math.round(
    largestRegion.reduce((sum, c) => sum + c.x, 0) / largestRegion.length
  );
  const avgY = Math.round(
    largestRegion.reduce((sum, c) => sum + c.y, 0) / largestRegion.length
  );

  return {
    x: avgX,
    y: avgY,
    size: largestRegion.length,
    tiles: largestRegion,
  };
}

/**
 * Handler central `/move` ejecutado en cada turno de la partida.
 * @param {GameState} gameState
 * @returns {{ move: string, shout: string }}
 */
function process_move(gameState) {
  const { board, you, turn } = gameState;
  const myLength = you.length;
  const myHead = you.head;
  const myTail = you.body[you.body.length - 1];

  const enemies = board.snakes.filter((s) => s.id !== you.id);
  const maxEnemyLength =
    enemies.length > 0 ? Math.max(...enemies.map((s) => s.length)) : 0;
  const isMultiSnake = enemies.length >= 2;
  const isDuel = enemies.length === 1;

  // FASES DE JUEGO
  const isEarlyGame = turn < 35 && isMultiSnake;
  const isGiant = myLength >= 14;

  // -------------------------------------------------------------
  // ETAPA 1: FILTRADO DE CASILLAS LETALES
  // -------------------------------------------------------------
  const {
    safeMoves,
    legalMoves,
    solidObstacles,
    lethalDangerZones,
    enemyHeads,
  } = get_safe_moves(board, you);

  // DETECCIÓN DE BUCLES REPETITIVOS (4+ VUELTAS - LOG 102)
  const gameId = (gameState.game && gameState.game.id) || "default-game";
  const loopInfo = track_and_detect_loops(gameId, turn, myHead, you.health, myLength);
  const isLoopBreakoutActive = loopInfo.isLooping && loopInfo.laps >= 4;

  let openTarget = {
    x: Math.floor(board.width / 2),
    y: Math.floor(board.height / 2),
  };
  if (isLoopBreakoutActive) {
    const openAreaInfo = find_largest_open_area(board, solidObstacles);
    openTarget = { x: openAreaInfo.x, y: openAreaInfo.y };
  }

  // -------------------------------------------------------------
  // ETAPA 4: FALLBACK INTELIGENTE CON PREDICCIÓN MULTI-PASO
  // -------------------------------------------------------------
  if (safeMoves.length === 0) {
    if (legalMoves.length > 0) {
      let bestFallback = legalMoves[0];
      let bestScore = -Infinity;

      // Pre-calcular predicciones multi-paso de todos los enemigos
      const enemyPredictions = enemyHeads.map((enemy) => ({
        enemy,
        ...predict_enemy_moves(enemy, solidObstacles, board, board.food),
      }));

      for (let i = 0; i < legalMoves.length; i++) {
        const candidate = legalMoves[i];
        const spaceInfo = evaluate_space(
          candidate.coord,
          solidObstacles,
          board,
          myTail
        );

        let score = spaceInfo.count * 20;
        if (spaceInfo.canReachTail) score += 200;

        let threatPenalty = 0;
        let distToHeads = 0;

        for (const { enemy, predictedPositions, confidences } of enemyPredictions) {
          const dist = manhattan_distance(enemy.head, candidate.coord);
          if (dist === 1 && enemy.length >= myLength) {
            threatPenalty += 300;

            // Predicción multi-paso: penalizar choques en T+1, T+2, T+3
            for (let step = 0; step < predictedPositions.length; step++) {
              const predicted = predictedPositions[step];
              if (candidate.coord.x === predicted.x && candidate.coord.y === predicted.y) {
                const stepWeight = step === 0 ? 5000 : step === 1 ? 2000 : 800;
                const stepConfidence = confidences[step] || 0.5;
                threatPenalty += stepWeight * stepConfidence;
              }
            }
          }
          distToHeads += dist;
        }

        score -= threatPenalty;
        score += distToHeads * 20;

        if (score > bestScore) {
          bestScore = score;
          bestFallback = candidate;
        }
      }

      return {
        move: bestFallback.move,
        shout: `T${turn} Riesgo forzado | Score: ${Math.round(bestScore)}`,
      };
    }

    return {
      move: "up",
      shout: `T${turn} Muerte inevitable`,
    };
  }

  // -------------------------------------------------------------
  // ETAPA 2: EVALUACIÓN DE ESPACIO, TRAMPAS DE BORDE Y TAIL CHASING
  // -------------------------------------------------------------
  const extendedObstacles = new Set(solidObstacles);
  for (const dangerKey of lethalDangerZones) {
    extendedObstacles.add(dangerKey);
  }

  const movesEvaluated = safeMoves.map((m) => {
    const spaceInfo = evaluate_space(
      m.coord,
      extendedObstacles,
      board,
      myTail
    );
    const rawSpaceInfo = evaluate_space(
      m.coord,
      solidObstacles,
      board,
      myTail
    );

    const isTrap = is_tunnel_trap(
      m.coord,
      extendedObstacles,
      lethalDangerZones,
      board
    );

    const isSqueeze = is_wall_squeeze_risk(m.coord, enemies, board);
    const isCoffin = is_perimeter_coffin_trap(m.coord, myHead, enemies, board);
    const isConfinement = is_narrow_band_confinement(m.coord, you, board, enemies);

    const effectiveSpace = spaceInfo.count;
    const canReachTail = spaceInfo.canReachTail || rawSpaceInfo.canReachTail;

    // Si estamos en ruptura de bucle y este movimiento rompe el confinamiento hacia el área abierta,
    // evitamos que sea bloqueado por filtros conservadores
    const isBreakingOut =
      isLoopBreakoutActive &&
      loopInfo.bounds &&
      ((loopInfo.bounds.minX > 0 && m.coord.x < loopInfo.bounds.minX) ||
       (loopInfo.bounds.maxX < board.width - 1 && m.coord.x > loopInfo.bounds.maxX) ||
       (loopInfo.bounds.minY > 0 && m.coord.y < loopInfo.bounds.minY) ||
       (loopInfo.bounds.maxY < board.height - 1 && m.coord.y > loopInfo.bounds.maxY) ||
       (manhattan_distance(m.coord, openTarget) < manhattan_distance(myHead, openTarget)));

    let isViable =
      !isTrap && !isSqueeze && !isCoffin && !isConfinement && (effectiveSpace >= myLength || (rawSpaceInfo.count >= myLength && myLength >= 10 && canReachTail));

    if (isBreakingOut && !isTrap && (effectiveSpace >= 2 || rawSpaceInfo.count >= 2)) {
      isViable = true;
    }

    return {
      ...m,
      space: effectiveSpace,
      rawSpace: rawSpaceInfo.count,
      canReachTail,
      isTrap,
      isSqueeze,
      isCoffin,
      isConfinement,
      isBreakingOut,
      isViable,
    };
  });

  const strictlyViableMoves = movesEvaluated.filter((m) => m.isViable);
  let candidateMoves;
  if (strictlyViableMoves.length > 0) {
    candidateMoves = strictlyViableMoves;
  } else {
    // Si no hay estrictamente viables, evitar ataúdes, confinamientos y trampas antes de caer en lo peor
    const nonTrapMoves = movesEvaluated.filter((m) => !m.isTrap && !m.isSqueeze && !m.isCoffin && !m.isConfinement);
    const pool = nonTrapMoves.length > 0 ? nonTrapMoves : movesEvaluated;

    pool.sort((a, b) => b.space - a.space);
    const maxSpace = pool[0].space;
    candidateMoves = pool.filter((m) => m.space === maxSpace);
  }

  if (candidateMoves.length === 1) {
    return {
      move: candidateMoves[0].move,
      shout: `T${turn} Vía segura única | Esp:${candidateMoves[0].space}`,
    };
  }

  // -------------------------------------------------------------
  // ETAPA 3: EVALUACIÓN ESTRATÉGICA Y CONTROL DE PARIDAD DE TAMAÑO
  // -------------------------------------------------------------
  const isCriticalHunger = you.health <= 35;
  const needGrowth = isDuel
    ? myLength <= maxEnemyLength + 4 || myLength < 18
    : myLength <= maxEnemyLength + 2 || myLength < 14 || maxEnemyLength >= myLength + 2;

  const isHungry =
    turn < 40 ||
    (isDuel && myLength < 18) ||
    you.health < 85 ||
    needGrowth ||
    isCriticalHunger;

  // Búsqueda de comida BFS segura con fallback persistente
  let bestFoodTarget = null;
  let minFoodDist = Infinity;

  if (board.food && board.food.length > 0) {
    // Intento 1: Buscar comida que podamos ganar antes que un rival más grande
    for (const food of board.food) {
      const foodKey = to_key(food);
      if (lethalDangerZones.has(foodKey)) continue;

      const pathInfo = bfs_shortest_path(
        myHead,
        food,
        extendedObstacles,
        board
      );
      if (!pathInfo) continue;

      const myDist = pathInfo.distance;

      let enemyBeatsUs = false;
      for (const enemy of enemies) {
        if (enemy.length > myLength) {
          const enemyDist = manhattan_distance(enemy.head, food);
          if (enemyDist <= myDist) {
            enemyBeatsUs = true;
            break;
          }
        }
      }

      if (!enemyBeatsUs && myDist < minFoodDist) {
        minFoodDist = myDist;
        bestFoodTarget = food;
      }
    }

    // Intento 2 (FALLBACK DE COMIDA): Si el rival está más cerca de todas las comidas,
    // NO rendirnos ni quedarnos en una esquina. Dirigirnos hacia la comida más cercana
    // que no esté en zona letal directa para mantener presencia activa y disputar el centro.
    if (!bestFoodTarget) {
      for (const food of board.food) {
        const foodKey = to_key(food);
        if (lethalDangerZones.has(foodKey)) continue;

        const pathInfo = bfs_shortest_path(
          myHead,
          food,
          extendedObstacles,
          board
        );
        if (pathInfo && pathInfo.distance < minFoodDist) {
          minFoodDist = pathInfo.distance;
          bestFoodTarget = food;
        }
      }
    }
  }

  const centerCoord = {
    x: Math.floor(board.width / 2),
    y: Math.floor(board.height / 2),
  };

  const scoredMoves = candidateMoves.map((candidate) => {
    let score = 0;

    // 1. Espacio y conectividad a la cola
    score += candidate.space * 25;
    if (candidate.canReachTail && !isLoopBreakoutActive) {
      score += myLength >= 10 ? 450 : 250;
    }

    // 2. Control territorial Voronoi de largo alcance
    const voronoi = calculate_voronoi(
      candidate.coord,
      enemies,
      extendedObstacles,
      board
    );
    score += voronoi.myTerritory * 25;

    // 3. Anticipación de Grados de Libertad Futuros (Degrees of Freedom Foresight)
    // Contar cuántos movimientos libres no letales tendremos en T+2
    const futureFreeMoves = get_cardinal_neighbors(candidate.coord, board).filter((n) => {
      const nKey = to_key(n);
      return !extendedObstacles.has(nKey) && nKey !== to_key(myHead);
    });
    if (futureFreeMoves.length === 0) {
      score -= 2200; // Callejón sin salida total
    } else if (futureFreeMoves.length === 1) {
      // Si solo queda 1 salida (corredor angosto de 1 casilla), penalizar fuertemente si hay un rival cerca
      let corridorPen = 800;
      for (const enemy of enemies) {
        const dist = manhattan_distance(candidate.coord, enemy.head);
        if (dist <= 4) {
          corridorPen += 1200; // Peligro crítico de estrangulamiento o choque contra cuerpo en corredor
        }
      }
      score -= corridorPen;
    }

    // 4. Evasión de Zonas de Pinza (Multi-Enemy) y Fuga a Espacio Abierto
    if (isMultiSnake) {
      let nearbyEnemies = 0;
      for (const enemy of enemies) {
        const dist = manhattan_distance(candidate.coord, enemy.head);
        if (dist <= 2) nearbyEnemies++;
      }
      if (nearbyEnemies >= 2) {
        score -= 600;
      }
    }

    // 5. Evasión Activa y Fuga Táctica contra rivales mayores o de igual tamaño
    if (!isLoopBreakoutActive) {
      for (const enemy of enemies) {
        const isDangerousCollision = enemy.length >= myLength;
        const isStrictlyLarger = enemy.length > myLength;
        const distToEnemyHead = manhattan_distance(candidate.coord, enemy.head);
        const myHeadDistToEnemy = manhattan_distance(myHead, enemy.head);

        if (isDangerousCollision) {
          // Penalizar cercanía a 2 pasos de un rival, moderando si vamos directo a comida segura
          let dist2Pen = isDuel ? 300 : 250;
          if (bestFoodTarget) {
            const myDistToFood = manhattan_distance(myHead, bestFoodTarget);
            const candDistToFood = manhattan_distance(candidate.coord, bestFoodTarget);
            if (candDistToFood < myDistToFood && myLength >= enemy.length) {
              dist2Pen *= 0.3; // No abandonar comida si somos iguales o mayores
            }
          }

          if (distToEnemyHead === 2) {
            score -= dist2Pen;
          } else if (distToEnemyHead === 3 && isStrictlyLarger) {
            score -= 100;
          }
        }

        // Fuga Táctica activa: Solo huir deliberadamente cuando el enemigo es ESTRICTAMENTE más grande
        if (isStrictlyLarger) {
          if (distToEnemyHead > myHeadDistToEnemy) {
            score += isDuel ? 220 : 160; // Bono por ganar distancia frente a rival mayor
          } else if (distToEnemyHead < myHeadDistToEnemy) {
            score -= isDuel ? 200 : 140; // Penalizar acortar distancia hacia rival mayor
          }
        }
      }
    }

    // 6. Space Packing / Coiling estilo Geriatric Jagwire (adaptativo)
    const coilingBonus = isLoopBreakoutActive ? 0 : calculate_coiling_bonus(candidate.coord, you, board);
    score += coilingBonus;

    // 7. Prevención Drástica de Compresión en Bordes (Anti-Parallel Squeeze)
    const isEdge =
      candidate.coord.x === 0 ||
      candidate.coord.x === board.width - 1 ||
      candidate.coord.y === 0 ||
      candidate.coord.y === board.height - 1;

    const isCorner =
      (candidate.coord.x === 0 || candidate.coord.x === board.width - 1) &&
      (candidate.coord.y === 0 || candidate.coord.y === board.height - 1);

    if (isEdge) {
      let edgePen = isGiant ? 150 : 280;
      let cornerPen = 480;

      // Si un rival es estrictamente más grande que nosotros, el riesgo de ser aplastado en pared es mucho mayor
      if (maxEnemyLength > myLength) {
        edgePen += 200;
        cornerPen += 300;
      }

      // Si estamos en inanición crítica (health <= 35) y este movimiento nos acerca a la comida, moderar la penalización
      if (isCriticalHunger && bestFoodTarget) {
        const myDistToFood = manhattan_distance(myHead, bestFoodTarget);
        const candDistToFood = manhattan_distance(candidate.coord, bestFoodTarget);
        if (candDistToFood < myDistToFood) {
          edgePen *= 0.2;
          cornerPen *= 0.2;
        }
      }

      if (isLoopBreakoutActive) {
        edgePen *= 0.3;
        cornerPen *= 0.3;
      }

      score -= edgePen;
      if (isCorner) score -= cornerPen;

      // Si estamos en un borde y hay un enemigo cerca (distancia <= 4): ¡ALERTA MÁXIMA DE ENCIERRO!
      for (const enemy of enemies) {
        const distToEnemy = manhattan_distance(candidate.coord, enemy.head);
        if (distToEnemy <= 4 && !isLoopBreakoutActive) {
          const enemyNearPen = enemy.length > myLength ? 650 : 400;
          score -= isCriticalHunger ? enemyNearPen * 0.4 : enemyNearPen;
        }
      }
    }

    // Riesgo directo de estrangulamiento pared-cuerpo enemigo (Anti-Wall Squeeze)
    if (is_wall_squeeze_risk(candidate.coord, enemies, board) && !isLoopBreakoutActive) {
      score -= 600; // No entrar jamás a un canal entre pared y cuerpo rival en juego normal
    }

    // 7.5. Prevención de Ataúd Perimetral y Bono de Fuga Interior
    const isCurrentlyOnPerimeter =
      myHead.x === 0 || myHead.x === board.width - 1 ||
      myHead.y === 0 || myHead.y === board.height - 1;

    if (isCurrentlyOnPerimeter) {
      const isEscapeMove =
        (myHead.x === 0 && candidate.coord.x === 1) ||
        (myHead.x === board.width - 1 && candidate.coord.x === board.width - 2) ||
        (myHead.y === 0 && candidate.coord.y === 1) ||
        (myHead.y === board.height - 1 && candidate.coord.y === board.height - 2);

      if (isEscapeMove && futureFreeMoves.length >= 2) {
        score += 450; // Salir de la trampa perimetral hacia el interior del tablero abierto
      }
    }

    if (is_perimeter_coffin_trap(candidate.coord, myHead, enemies, board) && !isLoopBreakoutActive) {
      score -= 850; // No entrar jamás a un ataúd perimetral paralelo
    }

    if (is_corner_pocket_trap(candidate.coord, enemies, myLength, board) && !isLoopBreakoutActive) {
      score -= 900; // Rechazo categórico a entrar en una esquina bajo amenaza de corte de rival mayor
    }

    // 7.6. Anti-Encierro en Esquinas y Bono de Ruptura hacia el Centro (Logs 21 y 22)
    const isCornerQuadrant =
      (candidate.coord.x <= 2 && candidate.coord.y <= 2) ||
      (candidate.coord.x >= board.width - 3 && candidate.coord.y <= 2) ||
      (candidate.coord.x <= 2 && candidate.coord.y >= board.height - 3) ||
      (candidate.coord.x >= board.width - 3 && candidate.coord.y >= board.height - 3);

    if (isCornerQuadrant) {
      const distToCenter = manhattan_distance(candidate.coord, centerCoord);
      const headDistToCenter = manhattan_distance(myHead, centerCoord);
      if (distToCenter < headDistToCenter) {
        score += 300; // Romper cerco de esquina hacia el centro
      } else if (distToCenter > headDistToCenter) {
        let quadrantPen = 250;
        if (maxEnemyLength > myLength) quadrantPen = 400;
        if (isCriticalHunger && bestFoodTarget) {
          const myDistToFood = manhattan_distance(myHead, bestFoodTarget);
          const candDistToFood = manhattan_distance(candidate.coord, bestFoodTarget);
          if (candDistToFood < myDistToFood) quadrantPen *= 0.2;
        }
        score -= quadrantPen;
      }
    }

    if (is_narrow_band_confinement(candidate.coord, you, board, enemies) && !isLoopBreakoutActive) {
      score -= 750; // Evitar auto-confinarse en franjas angostas de 2 columnas/filas en juego normal
    }

    // 7.7. DETECCIÓN DE CARRERA MORTAL EN PARED (Wall-Race Trap - LOG 103)
    // Penalizar movimientos que continúan a lo largo de una pared hacia una esquina
    // cuando un enemigo más grande/igual corre en paralelo (garantiza muerte por colisión de cabezas)
    if (!isLoopBreakoutActive) {
      const wallRace = detect_wall_race_trap(candidate.coord, myHead, myLength, enemies, board, solidObstacles);
      if (wallRace.isWallRace) {
        if (wallRace.penalty > 0) {
          score -= wallRace.penalty;
        }
        if (wallRace.escapeBonus > 0) {
          score += wallRace.escapeBonus;
        }
      }
    }

    // 8. Fases de Juego y Dominio del Centro
    if (isEarlyGame) {
      const distToCenter = manhattan_distance(candidate.coord, centerCoord);
      if (distToCenter <= 1) score -= 120;
    } else if (isDuel && turn < 40) {
      // En 1v1 temprano, dominar el centro es clave para tener espacio y acceso a comida
      const distToCenter = manhattan_distance(candidate.coord, centerCoord);
      score -= distToCenter * 25;
    } else if (!isGiant) {
      const distToCenter = manhattan_distance(candidate.coord, centerCoord);
      score -= distToCenter * 10;
    }

    // 9. Caza y Bloqueo Ofensivo de Rivales Menores (Killer Cut-off)
    if (candidate.isHunting && myLength > maxEnemyLength) {
      score += 550;
    }

    // 10. Prioridad en Superioridad de Tamaño (Alpha Dominance) vs Crecimiento vs Inanición
    if (isCriticalHunger && bestFoodTarget) {
      const pathToFood = bfs_shortest_path(
        candidate.coord,
        bestFoodTarget,
        extendedObstacles,
        board
      );
      if (pathToFood) {
        // En hambre crítica (hp <= 35), el bono de comida es MASIVO para evitar inanición
        const starvationUrgency = (100 - you.health) * 90;
        score += (40 - pathToFood.distance) * starvationUrgency;
      }
    } else if (isDuel && myLength > maxEnemyLength + 1) {
      // Como líderes con ventaja clara (+2 o más), seguir alimentándonos para ampliar ventaja sin arriesgar
      if (bestFoodTarget && (you.health < 85 || myLength < 25)) {
        const pathToFood = bfs_shortest_path(
          candidate.coord,
          bestFoodTarget,
          extendedObstacles,
          board
        );
        if (pathToFood) {
          score += (40 - pathToFood.distance) * 70;
        }
      }
      // Dominio del centro y apertura de espacio para el líder
      const distToCenter = manhattan_distance(candidate.coord, centerCoord);
      score -= distToCenter * 15;
    } else if (isHungry && bestFoodTarget) {
      const pathToFood = bfs_shortest_path(
        candidate.coord,
        bestFoodTarget,
        extendedObstacles,
        board
      );
      if (pathToFood) {
        // Escalado dinámico de crecimiento activo (buscar comida y crecer)
        let growthWeight = 70;
        if (isDuel) {
          growthWeight = myLength <= maxEnemyLength ? 130 : (myLength < 16 ? 100 : 75);
        } else {
          // En 4 jugadores, alta prioridad a crecer
          growthWeight = myLength <= maxEnemyLength ? 105 : 70;
          if (maxEnemyLength >= myLength + 2) growthWeight = 125;
        }
        score += (40 - pathToFood.distance) * growthWeight;
      }
    }

    // 11. Hazards
    if (board.hazards && board.hazards.length > 0) {
      const inHazard = board.hazards.some(
        (h) => h.x === candidate.coord.x && h.y === candidate.coord.y
      );
      if (inHazard) score -= 400;
    }

    // 12. PREDICCIÓN MULTI-PASO DEL ENEMIGO (Evasión preventiva en movimiento normal)
    // Penalizar movimientos que nos acerquen a donde el enemigo probablemente estará
    for (const enemy of enemies) {
      const prediction = predict_enemy_moves(enemy, solidObstacles, board, board.food);
      for (let step = 0; step < prediction.predictedPositions.length; step++) {
        const predicted = prediction.predictedPositions[step];
        const distToPredicted = manhattan_distance(candidate.coord, predicted);
        if (distToPredicted <= 1 && enemy.length >= myLength && !isLoopBreakoutActive) {
          // Estamos a 1 paso de donde un rival peligroso probablemente estará
          const stepPenalty = step === 0 ? 250 : step === 1 ? 120 : 60;
          const stepConfidence = prediction.confidences[step] || 0.5;
          score -= stepPenalty * stepConfidence;
        }
      }
    }

    // 13. ESTRATEGIA PASIVO-AGRESIVA DE ENCIERRO (Cut-off Scoring)
    // Solo aplicar encierro agresivo si tenemos ventaja de longitud (> rival)
    if (isDuel && enemies.length > 0) {
      const mainEnemy = enemies[0];
      if (myLength > mainEnemy.length) {
        const cutoff = calculate_cutoff_score(
          candidate.coord,
          mainEnemy,
          solidObstacles,
          board,
          myLength
        );
        score += cutoff.cutoffScore;

        // Anti-encierro: Si nuestro espacio tras este movimiento es peligrosamente bajo, penalizar
        if (cutoff.mySpaceAfter < myLength * 1.5) {
          score -= 300; // No sacrificar nuestra seguridad por encerrar al rival
        }

        // 13.5. PARTICIÓN OFENSIVA DE TABLERO Y CONSTRUCCIÓN DE MURALLA (Wall Slicing estilo Firsttry / Log 101)
        const partition = evaluate_board_partition(
          candidate.coord,
          you,
          mainEnemy,
          solidObstacles,
          board
        );
        score += partition.scoreBonus;
        if (partition.isLethalPartition) {
          candidate.isLethalPartition = true;
        }

        const wallBonus = calculate_wall_slicing_bonus(
          candidate.coord,
          you,
          mainEnemy,
          solidObstacles,
          board
        );
        score += wallBonus;
      } else if (!isLoopBreakoutActive) {
        // Somos menores o iguales: maximizar distancia y espacio, buscar crecer, no buscar confrontación
        const distToEnemy = manhattan_distance(candidate.coord, mainEnemy.head);
        if (distToEnemy <= 2) {
          score -= 250; // Evitar acercarnos demasiado al rival igual o más grande
        } else if (distToEnemy <= 3) {
          score -= 100;
        }
      }
    }

    // 14. ANTI-ENCIERRO TERRITORIAL PROPIO
    // Comparar nuestro Voronoi vs el del enemigo. Si estamos perdiendo territorio, priorizar escape
    if (isDuel && voronoi.myTerritory < voronoi.enemyTerritory && !isLoopBreakoutActive) {
      const territoryRatio = voronoi.myTerritory / Math.max(voronoi.enemyTerritory, 1);
      if (territoryRatio < 0.4) {
        // Estamos muy encerrados — dar bonus a movimientos que abren espacio
        score += candidate.space * 15; // Bonus extra por espacio cuando estamos apretados
        // Penalizar fuertemente movimientos hacia bordes si estamos encerrados
        if (isEdge) score -= 200;
      } else if (territoryRatio < 0.7) {
        // Perdiendo terreno pero no crítico — favorecer centro
        const distToCenter = manhattan_distance(candidate.coord, centerCoord);
        score -= distToCenter * 12;
      }
    }

    // 14.5. DETECCIÓN Y FUGA ANTI-PARTICIÓN (Escape de Cerco)
    if (isDuel && enemies.length > 0 && !isLoopBreakoutActive) {
      const mainEnemy = enemies[0];
      const antiPartitionScore = detect_anti_partition_danger(
        candidate.coord,
        you,
        mainEnemy,
        solidObstacles,
        board
      );
      score += antiPartitionScore;
    }

    // 14.8. ESTRATEGIA DE RUPTURA DE BUCLE Y ESCAPE A ZONA ABIERTA (4+ VUELTAS DETECTADAS - LOG 102)
    if (isLoopBreakoutActive && loopInfo.bounds) {
      const distToOpen = manhattan_distance(candidate.coord, openTarget);
      const headDistToOpen = manhattan_distance(myHead, openTarget);

      // 1. Bono por acercarse activamente al centroide de la mayor región abierta del tablero
      score += (20 - distToOpen) * 85;
      if (distToOpen < headDistToOpen) {
        score += 1500;
      }

      // 2. Bono masivo por salir de los límites del bucle repetitivo
      const isOutsideLoopBounds =
        candidate.coord.x < loopInfo.bounds.minX ||
        candidate.coord.x > loopInfo.bounds.maxX ||
        candidate.coord.y < loopInfo.bounds.minY ||
        candidate.coord.y > loopInfo.bounds.maxY;

      if (isOutsideLoopBounds) {
        score += 3500;
      } else {
        // Penalización severa por mantenerse girando en el mismo circuito estéril
        score -= 2000;
      }
    }

    return { ...candidate, score };
  });

  scoredMoves.sort((a, b) => b.score - a.score);
  const bestDecision = scoredMoves[0];

  let mode = "Control";
  if (isLoopBreakoutActive) mode = "RupturaBucle-4Vueltas";
  else if (isEarlyGame) mode = "Periferia/Early";
  else if (bestDecision.isLethalPartition) mode = "MurallaSlicing/Cutoff";
  else if (isDuel && myLength > maxEnemyLength) mode = "AlphaDominance/Encierro";
  else if (isCriticalHunger) mode = "InanicionCritica";
  else if (isDuel && isHungry) mode = "1v1-ParidadCrecimiento";
  else if (isGiant && bestDecision.canReachTail && bestDecision.space >= myLength) mode = "Coiling/SafeLoop";
  else if (isHungry) mode = "Crecimiento";

  let shoutText = `T${turn} [${mode}] Esp:${bestDecision.space} Sc:${Math.round(bestDecision.score)}`;
  if (isLoopBreakoutActive) {
    shoutText = `T${turn} [RupturaBucle-4Vueltas] Rompiendo cerco hacia (${openTarget.x},${openTarget.y}) | Esp:${bestDecision.space}`;
  }

  return {
    move: bestDecision.move,
    shout: shoutText,
  };
}

// ==========================================
// 4. CONTROLADORES HTTP EXPRESS
// ==========================================

app.get("/", (req, res) => {
  res.json({
    apiversion: "1",
    author: "avalojandro",
    color: "#E70A77",
    head: "silly",
    tail: "mlh-gene",
  });
});

app.post("/start", (req, res) => {
  if (req.body && req.body.game && req.body.game.id) {
    clear_game_history(req.body.game.id);
  }
  res.status(200).send("ok");
});

app.post("/move", (req, res) => {
  const decision = process_move(req.body);
  res.json(decision);
});

app.post("/end", (req, res) => {
  if (req.body && req.body.game && req.body.game.id) {
    clear_game_history(req.body.game.id);
  }
  res.status(200).send("ok");
});

// Inicio del servidor
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🐍 Battlesnake Engine listo en http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  is_valid_coord,
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
  track_and_detect_loops,
  find_largest_open_area,
  clear_game_history,
  gameHistoryMap,
  detect_wall_race_trap,
  process_move,
  manhattan_distance,
  to_key,
};
