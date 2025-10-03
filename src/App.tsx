import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  Plus,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
} from "lucide-react";
import { createSimulation, DEFAULT_PARAMS, Simulation } from "./simulation";
import type { DebugCounters, SimulationParams } from "./simulation";

interface SimulationStats {
  organisms: number;
  food: number;
  tick: number;
  energy: number;
  species: number;
}

type NumericParamKey = {
  [K in keyof SimulationParams]: SimulationParams[K] extends number ? K : never;
}[keyof SimulationParams];

const PixelOrganismSimulation = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const simRef = useRef<Simulation | null>(null);

  const [isRunning, setIsRunning] = useState(false);
  const [stats, setStats] = useState<SimulationStats>({
    organisms: 0,
    food: 0,
    tick: 0,
    energy: 0,
    species: 0,
  });
  const [debugInfo, setDebugInfo] = useState<DebugCounters>({
    moving: 0,
    growing: 0,
    attacking: 0,
    starving: 0,
  });
  const [speed, setSpeed] = useState<number>(1);
  const [editTerrain, setEditTerrain] = useState<boolean>(false);
  const [eraseMode, setEraseMode] = useState<boolean>(false);
  const [brush, setBrush] = useState<number>(2);
  const paintingRef = useRef<boolean>(false);
  const [showPanel, setShowPanel] = useState(true);
  const [params, setParams] = useState<SimulationParams>({ ...DEFAULT_PARAMS });

  const updateParam = useCallback((key: NumericParamKey, value: number) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  }, []);

  const renderScene = useCallback(() => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    if (!canvas || !sim) return;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const scale = canvas.width / sim.gridSize;

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 지형(장애물) 렌더링
    ctx.fillStyle = "#3a3a3a";
    for (let y = 0; y < sim.gridSize; y++) {
      for (let x = 0; x < sim.gridSize; x++) {
        const i = y * sim.gridSize + x;
        if (sim.grid[i] === -2) {
          ctx.fillRect(x * scale, y * scale, scale, scale);
        }
      }
    }

    // 음식 렌더
    ctx.fillStyle = "#1a3a1a";
    for (const key of sim.foodPixels.keys()) {
      const [x, y] = key.split(",").map(Number);
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }

    // grid 기반으로 개체 렌더(겹침 시각 오해 방지)
    for (let y = 0; y < sim.gridSize; y++) {
      for (let x = 0; x < sim.gridSize; x++) {
        const i = y * sim.gridSize + x;
        const owner = sim.grid[i];
        if (owner > 0) {
          const org = sim.organisms.get(owner);
          if (!org) continue;
          const hue = (org.speciesMask / 256) * 360;
          const energyRatio = Math.min(1, org.energy / params.reproductionThreshold);
          const lightness = 30 + energyRatio * 35;
          ctx.fillStyle = `hsl(${hue}, 90%, ${lightness}%)`;
          ctx.fillRect(x * scale, y * scale, scale, scale);
        }
      }
    }

    // 눈 강조(eye)
    ctx.fillStyle = "#ffffff";
    for (const org of sim.organisms.values()) {
      ctx.fillRect(org.eyeX * scale, org.eyeY * scale, scale, scale);
    }
  }, [params.reproductionThreshold]);

  const initSimulation = useCallback(() => {
    const sim = createSimulation({ ...params });
    const spacing = Math.max(
      4,
      Math.floor(params.gridSize / Math.ceil(Math.sqrt(params.initialOrganisms))),
    );
    let created = 0;

    for (
      let y = spacing;
      y < params.gridSize - spacing && created < params.initialOrganisms;
      y += spacing
    ) {
      for (
        let x = spacing;
        x < params.gridSize - spacing && created < params.initialOrganisms;
        x += spacing
      ) {
        const jitterX = x + Math.floor((Math.random() - 0.5) * spacing * 0.5);
        const jitterY = y + Math.floor((Math.random() - 0.5) * spacing * 0.5);
        if (sim.createOrganism(jitterX, jitterY)) {
          created++;
        }
      }
    }

    simRef.current = sim;
    renderScene();
  }, [params, renderScene]);

  const paintAt = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      const sim = simRef.current;
      if (!canvas || !sim) return;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const scale = canvas.width / sim.gridSize;
      const gx = Math.floor(x / scale);
      const gy = Math.floor(y / scale);
      const r = Math.max(0, Math.floor(brush));
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          sim.setObstacle(gx + dx, gy + dy, !eraseMode);
        }
      }
      renderScene();
    },
    [brush, eraseMode, renderScene],
  );

  useEffect(() => {
    initSimulation();
  }, [initSimulation]);

  useEffect(() => {
    const resizeCanvas = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const container = canvas.parentElement;
      if (!container) return;
      const size = Math.min(container.clientWidth, container.clientHeight);
      if (size <= 0) return;
      canvas.width = size;
      canvas.height = size;
      renderScene();
    };

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    return () => window.removeEventListener("resize", resizeCanvas);
  }, [showPanel, renderScene]);

  useEffect(() => {
    let lastTime = performance.now();
    let frameCount = 0;
    let elapsed = 0;
    let accumulator = 0;
    const stepMs = 1000 / 60; // 기준 틱 시간(60Hz)

    const loop = () => {
      const sim = simRef.current;
      if (!sim) {
        animationRef.current = requestAnimationFrame(loop);
        return;
      }

      const now = performance.now();
      const delta = now - lastTime;
      lastTime = now;
      frameCount++;
      elapsed += delta;

      if (isRunning) {
        accumulator += delta * Math.max(0.1, speed);
        let safety = 0;
        while (accumulator >= stepMs && safety++ < 120) {
          sim.step();
          accumulator -= stepMs;
        }
      } else {
        accumulator = 0;
      }

      if (elapsed >= 250) {
        const speciesCount = new Set(
          Array.from(sim.organisms.values()).map((o) => o.speciesMask),
        ).size;
        setStats({
          organisms: sim.organisms.size,
          food: sim.foodPixels.size,
          tick: sim.tick,
          energy: Math.floor(sim.envEnergy),
          species: speciesCount,
        });
        setDebugInfo({ ...sim.debugCounters });
        frameCount = 0;
        elapsed = 0;
      }

      renderScene();
      animationRef.current = requestAnimationFrame(loop);
    };

    animationRef.current = requestAnimationFrame(loop);
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [isRunning, renderScene]);

  useEffect(() => {
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  const sliderConfigs = useMemo(
    () => [
      {
        key: "gridSize" as const,
        label: "격자 크기",
        value: params.gridSize,
        disabled: isRunning,
        step: 16,
      },
      {
        key: "initialOrganisms" as const,
        label: "초기 개체",
        value: params.initialOrganisms,
        disabled: isRunning,
      },
      {
        key: "c2" as const,
        label: "에너지 상수 (c²)",
        value: params.c2,
        step: 10,
      },
      {
        key: "foodSpawnRate" as const,
        label: "먹이 생성률",
        value: params.foodSpawnRate,
        step: 0.001,
        display: (v: number) => `${(v * 100).toFixed(1)}%`,
      },
      {
        key: "mutationRate" as const,
        label: "변이율",
        value: params.mutationRate,
        step: 0.001,
        display: (v: number) => `${(v * 100).toFixed(1)}%`,
      },
      {
        key: "reproductionThreshold" as const,
        label: "번식 임계값",
        value: params.reproductionThreshold,
        step: 50,
      },
      {
        key: "maxMoveSpeed" as const,
        label: "최대 이동속도",
        value: params.maxMoveSpeed,
      },
      {
        key: "viewRadius" as const,
        label: "시야 반경",
        value: params.viewRadius,
      },
      {
        key: "energyTransferRatio" as const,
        label: "에너지 전달률",
        value: params.energyTransferRatio,
        step: 0.01,
        display: (v: number) => `${(v * 100).toFixed(0)}%`,
      },
      {
        key: "metabolismRate" as const,
        label: "대사율",
        value: params.metabolismRate,
        step: 0.001,
        display: (v: number) => v.toFixed(3),
      },
      {
        key: "movementEnergyReserve" as const,
        label: "이동 에너지 예비",
        value: params.movementEnergyReserve,
        step: 5,
      },
      {
        key: "movementEnergyCostMultiplier" as const,
        label: "이동 에너지 배수",
        value: params.movementEnergyCostMultiplier,
        step: 0.05,
        display: (v: number) => v.toFixed(2),
      },
      {
        key: "growthEnergyCost" as const,
        label: "성장 에너지 비용",
        value: params.growthEnergyCost,
        step: 1,
      },
      {
        key: "foodDecayTicks" as const,
        label: "먹이 소멸 틱",
        value: params.foodDecayTicks,
        step: 1,
      },
      {
        key: "foodDecayReturnRatio" as const,
        label: "먹이 소멸 환원률",
        value: params.foodDecayReturnRatio,
        step: 0.01,
        display: (v: number) => `${(v * 100).toFixed(0)}%`,
      },
    ],
    [isRunning, params],
  );

  const handleToggleRun = () => setIsRunning((prev) => !prev);

  const handleReset = () => {
    setIsRunning(false);
    initSimulation();
  };

  const handleAddOrganism = () => {
    const sim = simRef.current;
    if (!sim) return;
    const margin = 20;
    const x = margin + Math.floor(Math.random() * (sim.gridSize - margin * 2));
    const y = margin + Math.floor(Math.random() * (sim.gridSize - margin * 2));
    sim.createOrganism(x, y);
  };

  return (
    <div className="flex h-screen bg-black text-gray-100 overflow-hidden">
      <div className="flex-1 flex flex-col items-center justify-center p-4 relative">
        <canvas
          ref={canvasRef}
          className="max-w-full max-h-full"
          style={{ imageRendering: "pixelated", cursor: editTerrain ? "cell" : "crosshair" }}
          onMouseDown={(e) => {
            if (!editTerrain) return;
            paintingRef.current = true;
            paintAt(e.clientX, e.clientY);
          }}
          onMouseMove={(e) => {
            if (!editTerrain || !paintingRef.current) return;
            paintAt(e.clientX, e.clientY);
          }}
          onMouseUp={() => {
            paintingRef.current = false;
          }}
          onMouseLeave={() => {
            paintingRef.current = false;
          }}
        />

        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-gray-900/90 backdrop-blur rounded-full px-4 py-3 flex gap-2 shadow-2xl border border-gray-700">
          <button
            onClick={handleToggleRun}
            className="p-3 bg-blue-600 hover:bg-blue-700 rounded-full transition-transform hover:scale-110"
          >
            {isRunning ? <Pause size={22} /> : <Play size={22} />}
          </button>

          <button
            onClick={handleReset}
            className="p-3 bg-gray-700 hover:bg-gray-600 rounded-full transition-transform hover:scale-110"
          >
            <RotateCcw size={22} />
          </button>

          <button
            onClick={handleAddOrganism}
            className="p-3 bg-green-600 hover:bg-green-700 rounded-full transition-transform hover:scale-110"
          >
            <Plus size={22} />
          </button>

          <div className="w-px bg-gray-600 mx-1" />

          <button
            onClick={() => setEditTerrain((v) => !v)}
            className={`px-3 py-2 rounded-full transition ${editTerrain ? "bg-amber-600 hover:bg-amber-500" : "bg-gray-700 hover:bg-gray-600"}`}
          >
            {editTerrain ? "지형 편집: 켜짐" : "지형 편집: 꺼짐"}
          </button>
          {editTerrain && (
            <button
              onClick={() => setEraseMode((v) => !v)}
              className={`px-3 py-2 rounded-full transition ${eraseMode ? "bg-red-600 hover:bg-red-500" : "bg-green-700 hover:bg-green-600"}`}
            >
              {eraseMode ? "지우개" : "벽 그리기"}
            </button>
          )}

          <button
            onClick={() => setShowPanel((prev) => !prev)}
            className="p-3 bg-gray-700 hover:bg-gray-600 rounded-full transition-transform hover:scale-110"
          >
            {showPanel ? <ChevronRight size={22} /> : <ChevronLeft size={22} />}
          </button>
        </div>

        <div className="absolute top-6 left-6 space-y-3">
          <InfoPanel stats={stats} />
          <DebugPanel debugInfo={debugInfo} />
        </div>
      </div>

      {showPanel && (
        <div className="w-80 bg-gray-900 border-l border-gray-800 overflow-y-auto">
          <div className="p-6 space-y-6">
            <h2 className="text-2xl font-bold text-cyan-400">시뮬레이션 제어</h2>

            <div className="space-y-4">
              <ParamSlider
                label="배속"
                value={speed}
                onChange={(v) => setSpeed(Math.max(0.1, Math.min(4, v)))}
                step={0.1}
                min={0.1}
                max={4}
                display={(v) => `x${v.toFixed(1)}`}
              />
              {editTerrain && (
                <ParamSlider
                  label="브러시 크기"
                  value={brush}
                  onChange={(v) => setBrush(Math.max(0, Math.min(12, v)))}
                  step={1}
                  min={0}
                  max={12}
                />
              )}
              {sliderConfigs.map(({ key, label, value, step, display, disabled }) => (
                <ParamSlider
                  key={key}
                  label={label}
                  value={value}
                  onChange={(v) => updateParam(key, v)}
                  disabled={disabled}
                  step={step}
                  display={display}
                />
              ))}
            </div>

            <RuleSummary />
          </div>
        </div>
      )}
    </div>
  );
};

interface InfoPanelProps {
  stats: SimulationStats;
}

const InfoPanel = ({ stats }: InfoPanelProps) => (
  <div className="bg-gray-900/80 backdrop-blur rounded-lg px-4 py-3 text-sm font-mono border border-gray-700">
    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
      <div className="text-gray-400">Tick:</div>
      <div className="text-cyan-400">{stats.tick}</div>
      <div className="text-gray-400">개체:</div>
      <div className="text-green-400">{stats.organisms}</div>
      <div className="text-gray-400">종:</div>
      <div className="text-purple-400">{stats.species}</div>
      <div className="text-gray-400">먹이:</div>
      <div className="text-yellow-400">{stats.food}</div>
      <div className="text-gray-400">환경E:</div>
      <div className="text-orange-400">{stats.energy}</div>
    </div>
  </div>
);

interface DebugPanelProps {
  debugInfo: DebugCounters;
}

const DebugPanel = ({ debugInfo }: DebugPanelProps) => (
  <div className="bg-gray-900/80 backdrop-blur rounded-lg px-4 py-3 text-xs font-mono border border-gray-700">
    <div className="flex items-center gap-2 mb-2 text-gray-400">
      <AlertCircle size={14} />
      <span>디버그</span>
    </div>
    <div className="grid grid-cols-2 gap-x-3 gap-y-1">
      <div className="text-gray-500">이동(개체수):</div>
      <div className="text-blue-400">{debugInfo.moving}</div>
      <div className="text-gray-500">성장(개체수):</div>
      <div className="text-green-400">{debugInfo.growing}</div>
      <div className="text-gray-500">공격(개체수):</div>
      <div className="text-red-400">{debugInfo.attacking}</div>
      <div className="text-gray-500">굶주림(이동불가 개체수):</div>
      <div className="text-orange-400">{debugInfo.starving}</div>
    </div>
  </div>
);

const RuleSummary = () => (
  <div className="bg-gray-800 rounded-lg p-4 text-sm space-y-2 border border-gray-700">
    <h3 className="font-bold text-cyan-400 mb-2">핵심 규칙</h3>
    <ul className="space-y-1 text-gray-300 text-xs leading-relaxed">
      <li>• 개체는 8-연결 픽셀 덩어리</li>
      <li>• 이동은 마이크로스텝으로 처리</li>
      <li>• 예약/커밋으로 충돌 방지</li>
      <li>• 연결 끊어지면 즉시 먹이화</li>
      <li>• 동종은 서로 공격 안함</li>
      <li>• 에너지 부족 시 굶주림</li>
      <li>• 먹이를 찾아 탐색</li>
    </ul>
  </div>
);

interface ParamSliderProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  step?: number;
  display?: (value: number) => string | number;
  min?: number;
  max?: number;
}

const ParamSlider = ({
  label,
  value,
  onChange,
  disabled = false,
  step = 1,
  display,
  min,
  max,
}: ParamSliderProps) => {
  const displayValue = display ? display(value) : value;

  const pad = Math.max(10, Math.abs(value) || 10) * 1.0;
  const effMin = typeof min === "number" ? min : value - pad;
  const effMax = typeof max === "number" ? max : value + pad;

  const clampValue = (next: number) => {
    let result = next;
    if (typeof effMin === "number") {
      result = Math.max(effMin, result);
    }
    if (typeof effMax === "number") {
      result = Math.min(effMax, result);
    }
    return result;
  };

  const handleNumberChange = (raw: string) => {
    const parsed = parseFloat(raw);
    if (Number.isNaN(parsed)) return;
    onChange(parsed);
  };

  const handleSliderChange = (raw: string) => {
    const parsed = parseFloat(raw);
    if (Number.isNaN(parsed)) return;
    onChange(clampValue(parsed));
  };

  return (
    <div>
      <div className="flex justify-between mb-2">
        <label className="text-sm text-gray-400">{label}</label>
        <input
          type="number"
          value={value}
          onChange={(e) => handleNumberChange(e.target.value)}
          disabled={disabled}
          step={step}
          min={effMin}
          max={effMax}
          className="w-24 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-right disabled:opacity-50"
        />
      </div>
      <input
        type="range"
        value={value}
        onChange={(e) => handleSliderChange(e.target.value)}
        disabled={disabled}
        step={step}
        min={effMin}
        max={effMax}
        className="w-full accent-cyan-500 disabled:opacity-50"
      />
      <div className="text-xs text-gray-500 text-center mt-1">{displayValue}</div>
    </div>
  );
};

export default PixelOrganismSimulation;
