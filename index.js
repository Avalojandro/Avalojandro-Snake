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

    // Un movimiento solo es viable si el espacio libre es al menos igual a nuestra longitud,
    // y no nos mete en trampas de túnel, ataúd perimetral, estrangulamiento ni confinamiento angosto.
    const isViable =
      !isTrap && !isSqueeze && !isCoffin && !isConfinement && (effectiveSpace >= myLength || (rawSpaceInfo.count >= myLength && myLength >= 10 && canReachTail));

    return {
      ...m,
      space: effectiveSpace,
      rawSpace: rawSpaceInfo.count,
      canReachTail,
      isTrap,
      isSqueeze,
      isCoffin,
      isConfinement,
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
    ? myLength <= maxEnemyLength + 2 || myLength < 12
    : myLength <= maxEnemyLength + 1 || myLength < 10 || maxEnemyLength >= myLength + 3;

  const isHungry =
    (isDuel && myLength < 12) ||
    you.health < 80 ||
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
    if (candidate.canReachTail) {
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
      score -= 1500; // Callejón sin salida total
    } else if (futureFreeMoves.length === 1) {
      score -= 350; // Solo 1 salida restante
    }

    // 4. Evasión de Zonas de Pinza (Multi-Enemy)
    if (isMultiSnake) {
      let nearbyEnemies = 0;
      for (const enemy of enemies) {
        const dist = manhattan_distance(candidate.coord, enemy.head);
        if (dist <= 2) nearbyEnemies++;
      }
      if (nearbyEnemies >= 2) {
        score -= 400;
      }
    }

    // 5. Evasión de Proximidad 2-Step contra rivales ESTRICTAMENTE más grandes en 1v1
    if (isDuel) {
      for (const enemy of enemies) {
        if (enemy.length > myLength) {
          const distToEnemyHead = manhattan_distance(candidate.coord, enemy.head);
          if (distToEnemyHead === 2) {
            score -= 220;
          }
        }
      }
    }

    // 6. Space Packing / Coiling estilo Geriatric Jagwire (adaptativo)
    const coilingBonus = calculate_coiling_bonus(candidate.coord, you, board);
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

      score -= edgePen;
      if (isCorner) score -= cornerPen;

      // Si estamos en un borde y hay un enemigo cerca (distancia <= 4): ¡ALERTA MÁXIMA DE ENCIERRO!
      for (const enemy of enemies) {
        const distToEnemy = manhattan_distance(candidate.coord, enemy.head);
        if (distToEnemy <= 4) {
          const enemyNearPen = enemy.length > myLength ? 650 : 400;
          score -= isCriticalHunger ? enemyNearPen * 0.4 : enemyNearPen;
        }
      }
    }

    // Riesgo directo de estrangulamiento pared-cuerpo enemigo (Anti-Wall Squeeze)
    if (is_wall_squeeze_risk(candidate.coord, enemies, board)) {
      score -= 600; // No entrar jamás a un canal entre pared y cuerpo rival
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

      if (isEscapeMove) {
        score += 450; // Salir de la trampa perimetral hacia el interior del tablero
      }
    }

    if (is_perimeter_coffin_trap(candidate.coord, myHead, enemies, board)) {
      score -= 850; // No entrar jamás a un ataúd perimetral paralelo
    }

    if (is_corner_pocket_trap(candidate.coord, enemies, myLength, board)) {
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

    if (is_narrow_band_confinement(candidate.coord, you, board, enemies)) {
      score -= 750; // Evitar auto-confinarse en franjas angostas de 2 columnas/filas
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
    } else if (isDuel && myLength > maxEnemyLength) {
      // Como líderes, mantener ventaja de comida y aislar al rival sin auto-encerrarnos
      if (bestFoodTarget && (you.health < 75 || myLength < 20)) {
        const pathToFood = bfs_shortest_path(
          candidate.coord,
          bestFoodTarget,
          extendedObstacles,
          board
        );
        if (pathToFood) {
          score += (40 - pathToFood.distance) * 45;
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
        // Escalado dinámico de crecimiento
        let growthWeight = 40;
        if (isDuel) {
          growthWeight = myLength < 12 ? 90 : 70;
        } else {
          // En 4 jugadores, si un rival es más largo, el peso de crecimiento es alto
          growthWeight = myLength <= maxEnemyLength ? 75 : 45;
          if (maxEnemyLength >= myLength + 3) growthWeight = 95;
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
        if (distToPredicted <= 1 && enemy.length > myLength) {
          // Estamos a 1 paso de donde un rival ESTRICTAMENTE más grande probablemente estará
          const stepPenalty = step === 0 ? 180 : step === 1 ? 90 : 40;
          const stepConfidence = prediction.confidences[step] || 0.5;
          score -= stepPenalty * stepConfidence;
        }
      }
    }

    // 13. ESTRATEGIA PASIVO-AGRESIVA DE ENCIERRO (Cut-off Scoring)
    // Cuando somos más largos o iguales, premiar movimientos que recortan territorio al rival
    if (isDuel && enemies.length > 0) {
      const mainEnemy = enemies[0];
      // Solo aplicar encierro si somos >= longitud enemiga (no suicidarnos persiguiendo)
      if (myLength >= mainEnemy.length) {
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
      } else {
        // Somos más cortos: maximizar distancia y espacio, no buscar confrontación
        const distToEnemy = manhattan_distance(candidate.coord, mainEnemy.head);
        if (distToEnemy <= 2) {
          score -= 120; // Evitar acercarnos demasiado al rival más grande
        }
      }
    }

    // 14. ANTI-ENCIERRO TERRITORIAL PROPIO
    // Comparar nuestro Voronoi vs el del enemigo. Si estamos perdiendo territorio, priorizar escape
    if (isDuel && voronoi.myTerritory < voronoi.enemyTerritory) {
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

    return { ...candidate, score };
  });

  scoredMoves.sort((a, b) => b.score - a.score);
  const bestDecision = scoredMoves[0];

  let mode = "Control";
  if (isEarlyGame) mode = "Periferia/Early";
  else if (isDuel && myLength > maxEnemyLength) mode = "AlphaDominance/Encierro";
  else if (isCriticalHunger) mode = "InanicionCritica";
  else if (isDuel && isHungry) mode = "1v1-ParidadCrecimiento";
  else if (isGiant && bestDecision.canReachTail && bestDecision.space >= myLength) mode = "Coiling/SafeLoop";
  else if (isHungry) mode = "Crecimiento";

  return {
    move: bestDecision.move,
    shout: `T${turn} [${mode}] Esp:${bestDecision.space} Sc:${Math.round(bestDecision.score)}`,
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
  res.status(200).send("ok");
});

app.post("/move", (req, res) => {
  const decision = process_move(req.body);
  res.json(decision);
});

app.post("/end", (req, res) => {
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
  is_tunnel_trap,
  is_wall_squeeze_risk,
  is_perimeter_coffin_trap,
  is_narrow_band_confinement,
  is_corner_pocket_trap,
  predict_enemy_moves,
  process_move,
  manhattan_distance,
};
