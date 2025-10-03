export interface SimulationParams {
  gridSize: number;
  c2: number;
  foodSpawnRate: number;
  mutationRate: number;
  reproductionThreshold: number;
  initialOrganisms: number;
  maxMoveSpeed: number;
  viewRadius: number;
  energyTransferRatio: number;
  metabolismRate: number;
  movementEnergyReserve: number;
  movementEnergyCostMultiplier: number;
  growthEnergyCost: number;
  foodDecayTicks: number; // 먹이 소멸까지 틱 수
  foodDecayReturnRatio: number; // 소멸 시 E_env로 복귀 비율(0..1)
  // 추가 파라미터
  attackEnergyCost: number; // 공격 시도당 에너지 비용
  absorbEnergyCost: number; // 흡수 시도당 에너지 비용
  boundaryMode: "wrap" | "closed"; // 경계 모드: 랩(토러스) 또는 닫힘
  movementEnergyCostExponent: number; // 이동비용 크기 지수(1=선형)
  staminaMax: number; // 최대 지구력
  staminaRecoveryPerTick: number; // 틱당 회복
  staminaDrainPerStep: number; // 스텝당 소모
  terrainEnabled: boolean; // 장애물 맵 사용 여부
  terrainObstacleDensity: number; // 초기 벽 밀도(0..1)
  terrainSmoothingSteps: number; // 스무딩 횟수
}

export interface DebugCounters {
  moving: number;
  growing: number;
  attacking: number;
  starving: number;
}

export interface Genome {
  pattern: number[];
  size: number;
  totalCells: number;
}

export interface Organism {
  id: number;
  eyeX: number;
  eyeY: number;
  pixels: Map<string, number>;
  energy: number;
  moveSpeed: number;
  viewRadius: number;
  hunger: number;
  direction: [number, number];
  genome: Genome;
  growthStage: number;
  speciesMask: number;
  age: number;
  stuckCounter: number;
  stamina: number;
  movedThisTick: boolean;
}

type Reservation = {
  id: number;
  priority: number;
};

const DIRECTIONS: Array<[number, number]> = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

export class Simulation {
  readonly gridSize: number;
  readonly params: SimulationParams;
  readonly grid: Int32Array;
  readonly pixelHP: Uint16Array;
  readonly organisms: Map<number, Organism>;
  readonly foodPixels: Map<string, number>;
  readonly reservations: Map<string, Reservation>;
  readonly obstacleKeys: string[];
  nextID: number;
  tick: number;
  envEnergy: number;
  debugCounters: DebugCounters;

  constructor(gridSize: number, params: SimulationParams) {
    this.gridSize = gridSize;
    this.params = params;
    this.grid = new Int32Array(gridSize * gridSize);
    this.pixelHP = new Uint16Array(gridSize * gridSize);
    this.organisms = new Map();
    this.foodPixels = new Map();
    this.reservations = new Map();
    this.obstacleKeys = [];
    this.nextID = 1;
    this.tick = 0;
    this.envEnergy = 2000;
    this.debugCounters = { moving: 0, growing: 0, attacking: 0, starving: 0 };

    if (this.params.terrainEnabled) {
      this.generateTerrain();
    }
  }

  private idx(x: number, y: number): number {
    return y * this.gridSize + x;
  }

  private wrapCoord(value: number): number {
    const m = this.gridSize;
    let v = value % m;
    if (v < 0) v += m;
    return v;
  }

  private boundX(x: number): number | null {
    if (this.params.boundaryMode === "wrap") return this.wrapCoord(x);
    return x >= 0 && x < this.gridSize ? x : null;
  }

  private boundY(y: number): number | null {
    if (this.params.boundaryMode === "wrap") return this.wrapCoord(y);
    return y >= 0 && y < this.gridSize ? y : null;
  }

  private applyBoundary(x: number, y: number): [number, number] | null {
    const bx = this.boundX(x);
    const by = this.boundY(y);
    if (bx === null || by === null) return null;
    return [bx, by];
  }

  private neighbors8(x: number, y: number): Array<[number, number]> {
    const n: Array<[number, number]> = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const res = this.applyBoundary(x + dx, y + dy);
        if (res) n.push(res);
      }
    }
    return n;
  }

  private hash(tick: number, x: number, y: number, id: number): number {
    return (
      ((tick * 73856093) ^
        (x * 19349663) ^
        (y * 83492791) ^
        (id * 50331653)) >>>
      0
    );
  }

  private randomDirection(): [number, number] {
    return DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)];
  }

  private generateTerrain() {
    const size = this.gridSize;
    const density = Math.min(
      1,
      Math.max(0, this.params.terrainObstacleDensity)
    );
    const steps = Math.max(0, Math.floor(this.params.terrainSmoothingSteps));

    // 1) 초기 랜덤 필
    const wall = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = this.idx(x, y);
        wall[idx] = Math.random() < density ? 1 : 0;
      }
    }

    const countWallNeighbors = (x: number, y: number) => {
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const b = this.applyBoundary(x + dx, y + dy);
          if (!b) {
            // 닫힘 경계에서 바깥은 벽 취급
            c++;
            continue;
          }
          const [nx, ny] = b;
          if (wall[this.idx(nx, ny)] === 1) c++;
        }
      }
      return c;
    };

    // 2) 스무딩 (Cave-like):
    //  - 현재 벽이면 이웃>=4 유지, 아니면 이웃>=5에서 생성
    for (let s = 0; s < steps; s++) {
      const next = new Uint8Array(size * size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const neighbors = countWallNeighbors(x, y);
          const i = this.idx(x, y);
          if (wall[i] === 1) {
            next[i] = neighbors >= 4 ? 1 : 0;
          } else {
            next[i] = neighbors >= 5 ? 1 : 0;
          }
        }
      }
      wall.set(next);
    }

    // 3) grid에 장애물 적용(-2), HP 0, key 목록 구성
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = this.idx(x, y);
        if (wall[i] === 1) {
          this.grid[i] = -2;
          this.pixelHP[i] = 0;
          this.obstacleKeys.push(`${x},${y}`);
        }
      }
    }
    // 보정: 전혀 없는 경우에는 랜덤 점 몇 개 배치
    if (this.obstacleKeys.length === 0) {
      const sprinkle = Math.floor(size * size * 0.02);
      for (let k = 0; k < sprinkle; k++) {
        const x = Math.floor(Math.random() * size);
        const y = Math.floor(Math.random() * size);
        const i = this.idx(x, y);
        if (this.grid[i] === 0) {
          this.grid[i] = -2;
          this.obstacleKeys.push(`${x},${y}`);
        }
      }
    }
  }

  // grid와 organisms.pixels를 일치시키는 최종 검증/동기화 단계
  private verifyAndSync() {
    // 1) 모든 개체의 픽셀 맵을 초기화
    for (const org of this.organisms.values()) {
      org.pixels.clear();
    }
    // 2) grid를 단일 진실로 삼아 재구성
    for (let y = 0; y < this.gridSize; y++) {
      for (let x = 0; x < this.gridSize; x++) {
        const i = this.idx(x, y);
        const owner = this.grid[i];
        if (owner > 0) {
          const org = this.organisms.get(owner);
          if (org) {
            org.pixels.set(`${x},${y}`, this.pixelHP[i] || org.genome.totalCells);
          } else {
            // 고아 셀은 환경 자원으로 재설정
            this.grid[i] = -1;
            this.pixelHP[i] = 1;
            this.foodPixels.set(`${x},${y}`, this.params.foodDecayTicks);
          }
        }
      }
    }
  }

  // 외부 입력(마우스)로 장애물 편집
  public setObstacle(x: number, y: number, blocked: boolean): void {
    const b = this.applyBoundary(x, y);
    if (!b) return;
    const [gx, gy] = b;
    const i = this.idx(gx, gy);
    const key = `${gx},${gy}`;
    if (blocked) {
      if (this.grid[i] === -2) return; // 이미 장애물
      // 기존 점유 제거
      const occ = this.grid[i];
      if (occ > 0) {
        const org = this.organisms.get(occ);
        if (org) {
          org.pixels.delete(key);
          // 눈이 사라지면 바로 연결성 검사에서 제거됨
          this.checkConnectivity(org);
        }
      } else if (occ === -1) {
        // 먹이 제거
        this.foodPixels.delete(key);
      }
      this.grid[i] = -2;
      this.pixelHP[i] = 0;
      if (!this.obstacleKeys.includes(key)) this.obstacleKeys.push(key);
    } else {
      if (this.grid[i] !== -2) return; // 장애물만 해제
      this.grid[i] = 0;
      this.pixelHP[i] = 0;
      // 키 제거
      const idx = this.obstacleKeys.indexOf(key);
      if (idx >= 0) this.obstacleKeys.splice(idx, 1);
    }
  }

  private generateGenome(): Genome {
    const size = 7;
    const pattern = Array<number>(size * size).fill(0);
    const center = Math.floor((size * size) / 2);
    pattern[center] = 1;

    const cellCount = 10 + Math.floor(Math.random() * 15);
    let placed = 1;

    const queue: number[] = [center];
    const visited = new Set<number>([center]);

    while (placed < cellCount && queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      const y = Math.floor(current / size);
      const x = current % size;

      const neighbors: number[] = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
            const nIdx = ny * size + nx;
            if (!visited.has(nIdx)) neighbors.push(nIdx);
          }
        }
      }

      for (const nIdx of neighbors) {
        if (placed >= cellCount) break;
        if (Math.random() > 0.4) {
          pattern[nIdx] = 1;
          placed++;
          visited.add(nIdx);
          queue.push(nIdx);
        }
      }
    }

    return {
      pattern,
      size,
      totalCells: pattern.filter((c) => c === 1).length,
    };
  }

  private speciesMaskFromGenome(genome: Genome): number {
    let mask = 0;
    const { size, pattern } = genome;
    const cx = Math.floor(size / 2);
    const cy = Math.floor(size / 2);
    let bitIndex = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx >= 0 && gx < size && gy >= 0 && gy < size) {
          const gi = gy * size + gx;
          if (pattern[gi] === 1) mask |= 1 << bitIndex;
        }
        bitIndex++;
      }
    }
    return mask >>> 0;
  }

  createOrganism(
    eyeX: number,
    eyeY: number,
    genome: Genome | null = null,
    energy: number | null = null
  ): Organism | null {
    const b = this.applyBoundary(eyeX, eyeY);
    if (!b) return null;
    [eyeX, eyeY] = b;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const res = this.applyBoundary(eyeX + dx, eyeY + dy);
        if (!res) continue;
        const [nx, ny] = res;
        if (this.grid[this.idx(nx, ny)] !== 0) return null;
      }
    }

    const id = this.nextID++;
    const gen = genome ?? this.generateGenome();

    const org: Organism = {
      id,
      eyeX,
      eyeY,
      pixels: new Map(),
      energy: energy ?? 400,
      moveSpeed: 1 + Math.floor(Math.random() * this.params.maxMoveSpeed),
      viewRadius: this.params.viewRadius,
      hunger: 0.5 + Math.random() * 0.3,
      direction: this.randomDirection(),
      genome: gen,
      growthStage: 0,
      speciesMask: 0,
      age: 0,
      stuckCounter: 0,
      stamina: this.params.staminaMax,
      movedThisTick: false,
    };

    const i = this.idx(eyeX, eyeY);
    this.grid[i] = id;
    this.pixelHP[i] = gen.totalCells;
    org.pixels.set(`${eyeX},${eyeY}`, gen.totalCells);

    org.speciesMask = this.speciesMaskFromGenome(gen);
    this.organisms.set(id, org);
    return org;
  }

  private growOrganism(org: Organism): boolean {
    if (org.growthStage >= org.genome.totalCells - 1) return false;
    const growthCost = Math.max(0, this.params.growthEnergyCost);
    if (org.energy < growthCost) return false;

    const { pattern, size } = org.genome;
    const cx = Math.floor(size / 2);
    const cy = Math.floor(size / 2);
    // 링(테두리)을 한 겹씩, 시계방향으로 순회하며 첫 유효 후보를 선택
    for (let r = 1; r <= Math.ceil(size / 2); r++) {
      // 시계방향 순회: 상단 왼→오, 우측 상→하, 하단 오→왼, 좌측 하→상
      const segments: Array<[number, number]> = [];
      for (let dx = -r; dx <= r; dx++) segments.push([dx, -r]);
      for (let dy = -r + 1; dy <= r; dy++) segments.push([r, dy]);
      for (let dx = r - 1; dx >= -r; dx--) segments.push([dx, r]);
      for (let dy = r - 1; dy >= -r + 1; dy--) segments.push([-r, dy]);

      for (const [dx, dy] of segments) {
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx < 0 || gx >= size || gy < 0 || gy >= size) continue;
        const gIdx = gy * size + gx;
        if (pattern[gIdx] === 0) continue;

        const wx = org.eyeX + dx;
        const wy = org.eyeY + dy;
        const b = this.applyBoundary(wx, wy);
        if (!b) continue;
        const [bx, by] = b;
        const key = `${bx},${by}`;
        if (org.pixels.has(key)) continue;
        const index = this.idx(bx, by);
        if (this.grid[index] !== 0) continue;

        let connected = false;
        for (const [nx, ny] of this.neighbors8(bx, by)) {
          if (org.pixels.has(`${nx},${ny}`)) {
            connected = true;
            break;
          }
        }
        if (!connected) continue;

        // 선택 및 커밋
        this.grid[index] = org.id;
        this.pixelHP[index] = org.genome.totalCells;
        org.pixels.set(key, org.genome.totalCells);
        org.growthStage++;
        org.energy -= growthCost;
        this.debugCounters.growing++;
        return true;
      }
    }
    return false;
  }

  private detectTargets(org: Organism) {
    const targets: Array<{
      id: number;
      size: number;
      dx: number;
      dy: number;
      dist: number;
    }> = [];

    for (const [dx, dy] of DIRECTIONS) {
      let selfBlocked = false;
      for (let d = 1; d <= org.viewRadius; d++) {
        const b = this.applyBoundary(org.eyeX + dx * d, org.eyeY + dy * d);
        if (!b) break;
        const [x, y] = b;
        const index = this.idx(x, y);
        const occupantId = this.grid[index];
        if (occupantId === org.id) {
          selfBlocked = true;
          continue;
        }
        if (selfBlocked) break;
        if (occupantId === -2) break; // 장애물 차폐
        if (occupantId > 0) {
          const target = this.organisms.get(occupantId);
          if (target) {
            targets.push({
              id: occupantId,
              size: target.pixels.size,
              dx: dx, // 랩 환경에서도 올바른 진행 방향 유지
              dy: dy,
              dist: d,
            });
          }
          break;
        }
      }
    }

    return targets;
  }

  private detectFood(org: Organism) {
    // 눈 기준 8방향 레이캐스트, 자기 몸으로 차폐, 첫 먹이만 수집
    const foods: Array<{ dx: number; dy: number; dist: number }> = [];
    for (const [dx, dy] of DIRECTIONS) {
      let selfBlocked = false;
      for (let d = 1; d <= org.viewRadius; d++) {
        const b = this.applyBoundary(org.eyeX + dx * d, org.eyeY + dy * d);
        if (!b) break; // 닫힘 경계
        const [x, y] = b;
        const index = this.idx(x, y);
        const occupantId = this.grid[index];
        if (occupantId === org.id) {
          selfBlocked = true;
          continue;
        }
        if (selfBlocked) break;
        if (occupantId === -2) break; // 장애물 차폐
        if (occupantId === -1) {
          foods.push({ dx, dy, dist: d });
          break;
        }
        if (occupantId > 0) break; // 다른 개체가 시야 차폐
      }
    }
    return foods;
  }

  private chooseDirection(org: Organism): [number, number] {
    const targets = this.detectTargets(org);
    const foods = this.detectFood(org);
    const orgSize = org.pixels.size;

    if (
      org.energy < this.params.reproductionThreshold * 0.3 &&
      foods.length > 0
    ) {
      foods.sort((a, b) => a.dist - b.dist);
      const nearest = foods[0];
      return [Math.sign(nearest.dx), Math.sign(nearest.dy)];
    }

    if (targets.length > 0) {
      targets.sort((a, b) => a.dist - b.dist);
      const nearest = targets[0];
      const dx = Math.sign(nearest.dx);
      const dy = Math.sign(nearest.dy);

      if (nearest.size < orgSize) return [dx, dy];
      if (nearest.size > orgSize) return [-dx, -dy];
      return Math.random() < org.hunger ? [dx, dy] : [-dx, -dy];
    }

    if (foods.length > 0 && Math.random() < org.hunger) {
      foods.sort((a, b) => a.dist - b.dist);
      const nearest = foods[0];
      return [Math.sign(nearest.dx), Math.sign(nearest.dy)];
    }

    if (org.hunger > 0.2) {
      if (Math.random() < 0.1 || org.stuckCounter > 5) {
        org.stuckCounter = 0;
        return this.randomDirection();
      }
      return org.direction;
    }

    if (Math.random() < 0.3) {
      return org.direction;
    }

    return [0, 0];
  }

  private moveOrganisms() {
    this.reservations.clear();

    // 1) 각 개체의 방향/최대 스텝 산출
    const orgs = Array.from(this.organisms.values());
    type MoveState = {
      org: Organism;
      dx: number;
      dy: number;
      stepCost: number;
      stepsRemaining: number;
      movedThisTick: boolean;
    };

    const states: MoveState[] = [];
    let starvingCountInitial = 0;
    for (const org of orgs) {
      const [dx, dy] = org.direction;
      const stepCost = Math.max(
        Math.pow(
          Math.max(1, org.pixels.size),
          this.params.movementEnergyCostExponent
        ) * this.params.movementEnergyCostMultiplier,
        0.001
      );
      const energyReserve = Math.max(0, this.params.movementEnergyReserve);
      const availableEnergy = org.energy - energyReserve;
      const energyLimitedSteps =
        availableEnergy > 0 ? Math.floor(availableEnergy / stepCost) : 0;
      const staminaSteps = Math.floor(
        Math.max(0, org.stamina) /
          Math.max(0.0001, this.params.staminaDrainPerStep)
      );
      const actualSteps = Math.min(
        org.moveSpeed,
        energyLimitedSteps,
        staminaSteps
      );
      if (actualSteps <= 0 && (dx !== 0 || dy !== 0)) starvingCountInitial++;
      states.push({
        org,
        dx,
        dy,
        stepCost,
        stepsRemaining: actualSteps,
        movedThisTick: false,
      });
    }

    const priorityOf = (o: Organism, nx: number, ny: number) =>
      (o.moveSpeed << 20) |
      (o.pixels.size << 10) |
      (this.hash(this.tick, nx, ny, o.id) & 0x3ff);

    const sortByPriority = (a: Organism, b: Organism) => {
      if (b.moveSpeed !== a.moveSpeed) return b.moveSpeed - a.moveSpeed;
      if (b.pixels.size !== a.pixels.size) return b.pixels.size - a.pixels.size;
      return (
        this.hash(this.tick, a.eyeX, a.eyeY, a.id) -
        this.hash(this.tick, b.eyeX, b.eyeY, b.id)
      );
    };

    let anyMoved = true;
    while (anyMoved) {
      anyMoved = false;
      // 2) 이번 마이크로스텝에서 이동 후보/비이동 집합
      const moving = states.filter(
        (s) => s.stepsRemaining > 0 && (s.dx !== 0 || s.dy !== 0)
      );
      if (moving.length === 0) break;
      const nonMovingIds = new Set<number>(
        states
          .filter((s) => !(s.stepsRemaining > 0 && (s.dx !== 0 || s.dy !== 0)))
          .map((s) => s.org.id)
      );

      // 3) 정적 예약: 비이동 개체의 현 점유 칸, 먹이, 장애물에 최고 우선순위 예약
      this.reservations.clear();
      const INF = 0x7fffffff;
      for (const org of this.organisms.values()) {
        if (!nonMovingIds.has(org.id)) continue;
        for (const key of org.pixels.keys()) {
          this.reservations.set(key, { id: org.id, priority: INF });
        }
      }
      for (const key of this.foodPixels.keys()) {
        this.reservations.set(key, { id: -1, priority: INF });
      }
      for (const key of this.obstacleKeys) {
        this.reservations.set(key, { id: -2, priority: INF });
      }

      // 4) 이동 제안 수집
      type Proposal = {
        org: Organism;
        ox: number;
        oy: number;
        nx: number;
        ny: number;
      };
      const proposalsByOrg = new Map<number, Proposal[]>();
      const proposalCellMap = new Map<
        string,
        Array<{ org: Organism; priority: number }>
      >();

      const movingSorted = moving.map((s) => s.org).sort(sortByPriority);
      const stateById = new Map(states.map((s) => [s.org.id, s] as const));

      for (const org of movingSorted) {
        const st = stateById.get(org.id)!;
        const [dx, dy] = [st.dx, st.dy];
        const orgProposals: Proposal[] = [];
        let valid = true;
        for (const key of org.pixels.keys()) {
          const [xs, ys] = key.split(",").map(Number);
          const res = this.applyBoundary(xs + dx, ys + dy);
          if (!res) {
            valid = false;
            break;
          }
          const [nx, ny] = res;
          const nKey = `${nx},${ny}`;
          // 겹침 금지 강화: 빈 셀(0) 또는 자신의 셀(org.id)로만 이동 제안 허용
          const occ = this.grid[this.idx(nx, ny)];
          if (occ !== 0 && occ !== org.id) {
            valid = false;
            break;
          }
          // 예약 충돌은 나중에 평가, 여기서는 제안만 모음
          orgProposals.push({ org, ox: xs, oy: ys, nx, ny });
          const pri = priorityOf(org, nx, ny);
          if (!proposalCellMap.has(nKey)) proposalCellMap.set(nKey, []);
          proposalCellMap.get(nKey)!.push({ org, priority: pri });
        }
        if (valid) proposalsByOrg.set(org.id, orgProposals);
      }

      // 5) 셀 단위 승자 결정 (정적 예약 우선)
      const winnersByCell = new Map<string, number>();
      for (const [cell, contenders] of proposalCellMap.entries()) {
        const staticRes = this.reservations.get(cell);
        if (staticRes && staticRes.priority === INF) {
          // 정적 점유가 있으면 이동 불가
          continue;
        }
        let winner: { orgId: number; priority: number } | null = null;
        for (const c of contenders) {
          const pri = c.priority;
          if (
            !winner ||
            pri > winner.priority ||
            (pri === winner.priority && c.org.id > winner.orgId)
          ) {
            winner = { orgId: c.org.id, priority: pri };
          }
        }
        if (winner) winnersByCell.set(cell, winner.orgId);
      }

      // 6) 개체 단위 이동 가능 여부 판정 후 커밋(원자적 적용)
      type Commit = {
        org: Organism;
        props: Proposal[];
        oldPixels: Map<string, number>;
      };
      const commits: Commit[] = [];
      const destIdxSet = new Set<number>();
      for (const org of movingSorted) {
        const props = proposalsByOrg.get(org.id);
        if (!props || props.length !== org.pixels.size) continue; // 경계로 실패
        let allGranted = true;
        for (const p of props) {
          const nKey = `${p.nx},${p.ny}`;
          if (winnersByCell.get(nKey) !== org.id) {
            allGranted = false;
            break;
          }
        }
        if (!allGranted) continue;
        const oldPixels = new Map(org.pixels);
        commits.push({ org, props, oldPixels });
        for (const p of props) destIdxSet.add(this.idx(p.nx, p.ny));
      }

      // 6-1) 원천 셀 정리(목적지가 아닌 셀만 초기화)
      for (const c of commits) {
        for (const [key] of c.oldPixels) {
          const [oxs, oys] = key.split(",").map(Number);
          const oIdx = this.idx(oxs, oys);
          if (!destIdxSet.has(oIdx)) {
            this.grid[oIdx] = 0;
            this.pixelHP[oIdx] = 0;
          }
        }
      }

      // 6-2) 목적지 셀 점유 적용 및 개체 픽셀 갱신
      const movedThisMicro: Organism[] = [];
      for (const c of commits) {
        const { org, props, oldPixels } = c;
        org.pixels.clear();
        for (const p of props) {
          const nIdx = this.idx(p.nx, p.ny);
          const nKey = `${p.nx},${p.ny}`;
          const hp = oldPixels.get(`${p.ox},${p.oy}`) ?? org.genome.totalCells;
          this.grid[nIdx] = org.id;
          this.pixelHP[nIdx] = hp;
          org.pixels.set(nKey, hp);
        }
        const stNow = stateById.get(org.id)!;
        const b = this.applyBoundary(org.eyeX + stNow.dx, org.eyeY + stNow.dy)!;
        org.eyeX = b[0];
        org.eyeY = b[1];
        const st = stateById.get(org.id)!;
        org.energy -= st.stepCost;
        org.stamina = Math.max(
          0,
          org.stamina - this.params.staminaDrainPerStep
        );
        st.stepsRemaining -= 1;
        st.movedThisTick = true;
        org.movedThisTick = true;
        movedThisMicro.push(org);
      }

      if (movedThisMicro.length > 0) {
        anyMoved = true;
      } else {
        // 아무도 못 움직였으면 굶주림 카운트 상승
        for (const st of states) {
          if (st.stepsRemaining > 0 && (st.dx !== 0 || st.dy !== 0))
            this.debugCounters.starving++;
          st.stepsRemaining = 0;
        }
        break;
      }
    }

    // 지구력 회복(정지한 개체만)
    for (const st of states) {
      if (!st.movedThisTick || (st.dx === 0 && st.dy === 0)) {
        st.org.stamina = Math.min(
          this.params.staminaMax,
          st.org.stamina + this.params.staminaRecoveryPerTick
        );
      }
    }

    // 디버그 카운트: 이동/굶주림 합산
    this.debugCounters.moving += states.filter((s) => s.movedThisTick).length;
    this.debugCounters.starving += starvingCountInitial;
  }

  private combat() {
    for (const org of this.organisms.values()) {
      const orgSize = org.pixels.size;
      const attackTargets: Array<[number, number, number]> = [];

      for (const key of org.pixels.keys()) {
        const [xStr, yStr] = key.split(",");
        const x = Number(xStr);
        const y = Number(yStr);

        for (const [nx, ny] of this.neighbors8(x, y)) {
          const nIndex = this.idx(nx, ny);
          const targetID = this.grid[nIndex];

          // 환경 자원(먹이)은 별도 처리
          if (targetID === -1) continue;
          if (targetID <= 0 || targetID === org.id) continue;

          const target = this.organisms.get(targetID);
          if (!target) continue;
          if (target.speciesMask === org.speciesMask) continue;

          const targetSize = target.pixels.size;
          let canAttack = orgSize > targetSize;
          if (orgSize === targetSize) {
            canAttack = Math.random() < org.hunger * 0.6;
          }

          if (canAttack) {
            attackTargets.push([nx, ny, targetID]);
          }
        }
      }

      if (attackTargets.length === 0) continue;

      const [tx, ty, targetID] =
        attackTargets[Math.floor(Math.random() * attackTargets.length)];
      const targetIndex = this.idx(tx, ty);
      // 공격 에너지 비용
      if (this.params.attackEnergyCost > 0) {
        if (
          this.organisms.get(org.id) &&
          org.energy - this.params.attackEnergyCost <= 0
        ) {
          continue; // 에너지 부족으로 공격 불가
        }
        org.energy -= this.params.attackEnergyCost;
      }

      this.pixelHP[targetIndex] = Math.max(0, this.pixelHP[targetIndex] - 1);

      if (this.pixelHP[targetIndex] > 0) continue;

      const energy = this.params.c2;
      org.energy += energy * this.params.energyTransferRatio;
      this.envEnergy += energy * (1 - this.params.energyTransferRatio);

      this.grid[targetIndex] = 0;

      const target = this.organisms.get(targetID);
      if (target) {
        const tKey = `${tx},${ty}`;
        target.pixels.delete(tKey);
        this.checkConnectivity(target);
      }

      this.debugCounters.attacking++;
    }
  }

  // 접촉(8-이웃)한 환경 자원을 한 픽셀만 흡수
  private absorbFood() {
    for (const org of this.organisms.values()) {
      let absorbed = false;
      for (const key of org.pixels.keys()) {
        if (absorbed) break;
        const [xStr, yStr] = key.split(",");
        const x = Number(xStr);
        const y = Number(yStr);
        for (const [nx, ny] of this.neighbors8(x, y)) {
          const nKey = `${nx},${ny}`;
          const ni = this.idx(nx, ny);
          if (this.grid[ni] !== -1) continue;
          // 흡수 에너지 비용
          if (this.params.absorbEnergyCost > 0) {
            if (org.energy - this.params.absorbEnergyCost <= 0) continue;
            org.energy -= this.params.absorbEnergyCost;
          }

          // HP 1 자원 픽셀 흡수
          this.pixelHP[ni] = Math.max(0, this.pixelHP[ni] - 1);
          if (this.pixelHP[ni] === 0) {
            const energy = this.params.c2;
            org.energy += energy * this.params.energyTransferRatio;
            this.envEnergy += energy * (1 - this.params.energyTransferRatio);
            this.grid[ni] = 0;
            this.foodPixels.delete(nKey);
          }
          absorbed = true;
          break;
        }
      }
    }
  }

  private checkConnectivity(org: Organism) {
    if (org.pixels.size === 0) {
      this.removeOrganism(org.id);
      return;
    }

    const eyeKey = `${org.eyeX},${org.eyeY}`;
    if (!org.pixels.has(eyeKey)) {
      this.removeOrganism(org.id);
      return;
    }

    const reachable = new Set<string>([eyeKey]);
    const queue: string[] = [eyeKey];

    while (queue.length > 0) {
      const key = queue.shift();
      if (!key) break;
      const [xStr, yStr] = key.split(",");
      const x = Number(xStr);
      const y = Number(yStr);

      for (const [nx, ny] of this.neighbors8(x, y)) {
        const nKey = `${nx},${ny}`;
        if (org.pixels.has(nKey) && !reachable.has(nKey)) {
          reachable.add(nKey);
          queue.push(nKey);
        }
      }
    }

    for (const key of Array.from(org.pixels.keys())) {
      if (reachable.has(key)) continue;
      const [xStr, yStr] = key.split(",");
      const x = Number(xStr);
      const y = Number(yStr);
      const index = this.idx(x, y);
      this.grid[index] = -1; // 먹이 점유로 전환
      this.pixelHP[index] = 1;
      this.foodPixels.set(key, this.params.foodDecayTicks);
      org.pixels.delete(key);
    }

    if (org.pixels.size === 0) {
      this.removeOrganism(org.id);
    }
  }

  private metabolism() {
    for (const org of this.organisms.values()) {
      org.age++;
      org.energy -= org.pixels.size * this.params.metabolismRate;
      if (org.energy <= 0) {
        this.removeOrganism(org.id);
      }
    }
  }

  private reproduce() {
    const readyToReproduce: Organism[] = [];

    for (const org of this.organisms.values()) {
      if (
        org.energy >= this.params.reproductionThreshold &&
        org.pixels.size >= org.genome.totalCells * 0.8
      ) {
        readyToReproduce.push(org);
      }
    }

    for (const org of readyToReproduce) {
      if (Math.random() > 0.03) continue;

      const dirs: Array<[number, number]> = [];
      for (let d = 3; d <= 6; d++) {
        for (let angle = 0; angle < 360; angle += 45) {
          const rad = (angle * Math.PI) / 180;
          const dx = Math.round(Math.cos(rad) * d);
          const dy = Math.round(Math.sin(rad) * d);
          dirs.push([dx, dy]);
        }
      }

      for (let i = dirs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
      }

      for (const [dx, dy] of dirs) {
        const b = this.applyBoundary(org.eyeX + dx, org.eyeY + dy);
        if (!b) continue;
        const [nx, ny] = b;

        const newGenome = this.mutateGenome(org.genome);
        const childEnergy = this.params.reproductionThreshold * 0.4;
        const child = this.createOrganism(nx, ny, newGenome, childEnergy);

        if (child) {
          org.energy -= this.params.reproductionThreshold * 0.6;
          let newMoveSpeed = org.moveSpeed;
          if (Math.random() < this.params.mutationRate) {
            newMoveSpeed += Math.random() > 0.5 ? 1 : -1;
          }
          child.moveSpeed = Math.max(1, newMoveSpeed);
          child.hunger = Math.max(
            0,
            Math.min(1, org.hunger + (Math.random() - 0.5) * 0.3)
          );
          break;
        }
      }
    }
  }

  private mutateGenome(genome: Genome): Genome {
    const newPattern = [...genome.pattern];
    const size = genome.size;
    const center = Math.floor(newPattern.length / 2);

    for (let i = 0; i < newPattern.length; i++) {
      if (i === center) continue;
      if (Math.random() < this.params.mutationRate) {
        newPattern[i] = 1 - newPattern[i];
      }
    }

    return {
      pattern: newPattern,
      size,
      totalCells: newPattern.filter((c) => c === 1).length,
    };
  }

  private removeOrganism(id: number) {
    const org = this.organisms.get(id);
    if (!org) return;

    for (const [key] of org.pixels) {
      const [xStr, yStr] = key.split(",");
      const x = Number(xStr);
      const y = Number(yStr);
      const index = this.idx(x, y);
      this.grid[index] = -1; // 죽은 픽셀을 먹이로 변환
      this.pixelHP[index] = 1;
      this.foodPixels.set(key, this.params.foodDecayTicks);
    }

    this.organisms.delete(id);
  }

  private spawnFood() {
    const spawnCount = Math.floor(
      (this.envEnergy * this.params.foodSpawnRate) / this.params.c2
    );

    for (let i = 0; i < spawnCount && this.envEnergy > this.params.c2; i++) {
      const x = Math.floor(Math.random() * this.gridSize);
      const y = Math.floor(Math.random() * this.gridSize);
      const index = this.idx(x, y);

      if (this.grid[index] === 0) {
        this.grid[index] = -1; // 환경 자원도 점유로 표시
        this.pixelHP[index] = 1;
        this.foodPixels.set(`${x},${y}`, this.params.foodDecayTicks);
        this.envEnergy -= this.params.c2;
      }
    }
  }

  private updateFoodDecay() {
    const toDelete: string[] = [];
    for (const [key, ttl] of this.foodPixels.entries()) {
      const next = ttl - 1;
      if (next <= 0) {
        toDelete.push(key);
      } else {
        this.foodPixels.set(key, next);
      }
    }

    for (const key of toDelete) {
      const [xStr, yStr] = key.split(",");
      const x = Number(xStr);
      const y = Number(yStr);
      const idx = this.idx(x, y);
      // 먹이 제거 후 에너지는 환경으로 복귀
      this.grid[idx] = 0;
      this.pixelHP[idx] = 0;
      this.foodPixels.delete(key);
      this.envEnergy += this.params.c2 * this.params.foodDecayReturnRatio;
    }
  }

  // 기존 겹침 섭취 방식을 제거하고 접촉 흡수로 일원화

  step() {
    this.tick++;
    this.debugCounters = { moving: 0, growing: 0, attacking: 0, starving: 0 };

    // 0) 방향 계획 및 이동 플래그 초기화
    for (const org of this.organisms.values()) {
      org.direction = this.chooseDirection(org);
      org.movedThisTick = false;
    }

    this.moveOrganisms();
    // 1) 성장: 실제로 이동하지 못한 개체만 시도(확률 없이 1회 시도)
    for (const org of this.organisms.values()) {
      if (!org.movedThisTick) {
        this.growOrganism(org);
      }
    }
    this.combat();

    // 생성된 먹이가 즉시 흡수되도록 생성→흡수 순서로 처리
    if (this.tick % 5 === 0) this.spawnFood();
    this.absorbFood();

    this.metabolism();
    this.reproduce();
    this.updateFoodDecay();

    // 틱 종료 검증/동기화: grid와 개체 픽셀 맵 일치 보장
    this.verifyAndSync();
  }
}

export const DEFAULT_PARAMS: SimulationParams = {
  gridSize: 256,
  c2: 100,
  foodSpawnRate: 0.03,
  mutationRate: 0.05,
  reproductionThreshold: 1000,
  initialOrganisms: 8,
  maxMoveSpeed: 3,
  viewRadius: 20,
  energyTransferRatio: 0.7,
  metabolismRate: 0.08,
  movementEnergyReserve: 20,
  movementEnergyCostMultiplier: 0.9,
  movementEnergyCostExponent: 0.95,
  growthEnergyCost: 12,
  foodDecayTicks: 600,
  foodDecayReturnRatio: 1.0,
  attackEnergyCost: 0.5,
  absorbEnergyCost: 0.2,
  boundaryMode: "wrap",
  staminaMax: 12,
  staminaRecoveryPerTick: 0.6,
  staminaDrainPerStep: 1,
  terrainEnabled: true,
  terrainObstacleDensity: 0.2,
  terrainSmoothingSteps: 4,
};

export function createSimulation(params: SimulationParams): Simulation {
  return new Simulation(params.gridSize, params);
}
