"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Boxes,
  ChevronRight,
  CirclePlay,
  Clock3,
  Download,
  FileArchive,
  FileJson,
  Gamepad2,
  Gauge,
  ImagePlus,
  Maximize2,
  Minimize2,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Save,
  Settings2,
  SkipForward,
  Sparkles,
  Swords,
  Upload,
  UsersRound,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { ArenaCanvas, type ArenaHandle } from "./ArenaCanvas";
import { BoardEditor } from "./BoardEditor";
import { BoardPropsPanel } from "./BoardPropsPanel";
import { CharacterEditor } from "./CharacterEditor";
import { FormationEditor } from "./FormationEditor";
import { NameLibraryEditor } from "./NameLibraryEditor";
import { createDefaultManifest } from "@/lib/game/defaultContent";
import {
  exportBundle,
  exportJson,
  importProjectFile,
  loadManifest,
  saveManifest,
  fileToDataUrl,
} from "@/lib/game/storage";
import type {
  BattleSnapshot,
  MatchContestant,
  MatchSetup,
  ProjectManifest,
} from "@/lib/game/types";

type WorkspaceView = "battle" | "characters" | "boards";

const statusLabel = (status: BattleSnapshot["status"] | undefined) => {
  if (status === "running") return "战斗中";
  if (status === "paused") return "已暂停";
  if (status === "finished") return "已结束";
  return "等待开战";
};

const formatTime = (seconds: number | undefined) => {
  const value = Math.max(0, seconds ?? 0);
  const minutes = Math.floor(value / 60);
  return `${String(minutes).padStart(2, "0")}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
};

const colorPalette = [
  "#f6d85f",
  "#ff8b62",
  "#72d4af",
  "#8fb8ff",
  "#c596ff",
  "#ff6f91",
  "#78e2f2",
  "#f0a35a",
];

const teamOptions = [
  { id: "", label: "独立阵营", color: "" },
  { id: "red", label: "红队", color: "#ff5968" },
  { id: "blue", label: "蓝队", color: "#55a7ff" },
  { id: "green", label: "绿队", color: "#55d68a" },
  { id: "purple", label: "紫队", color: "#b58aff" },
  { id: "gold", label: "金队", color: "#f6d85f" },
];

const spawnRatios = [
  { x: 0.11, y: 0.17 },
  { x: 0.89, y: 0.17 },
  { x: 0.11, y: 0.83 },
  { x: 0.89, y: 0.83 },
  { x: 0.5, y: 0.12 },
  { x: 0.5, y: 0.88 },
  { x: 0.08, y: 0.5 },
  { x: 0.92, y: 0.5 },
];

let contestantIdCounter = 0;
const createContestantId = () => {
  contestantIdCounter += 1;
  const randomPart =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `local-${contestantIdCounter}`;
  return `fighter-${randomPart}`;
};

export function GameApp() {
  const [manifest, setManifest] = useState<ProjectManifest>(() => createDefaultManifest());
  const [battleManifest, setBattleManifest] = useState<ProjectManifest>(() => createDefaultManifest());
  const [view, setView] = useState<WorkspaceView>("battle");
  const [battleKey, setBattleKey] = useState(0);
  const [snapshot, setSnapshot] = useState<BattleSnapshot>();
  const [speed, setSpeed] = useState(1);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.72);
  const [hydrated, setHydrated] = useState(false);
  const [savedAt, setSavedAt] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selectedCharacterId, setSelectedCharacterId] = useState("panda-lazy");
  const [selectedBoardId, setSelectedBoardId] = useState("stream-landscape");
  const [pendingAutoStart, setPendingAutoStart] = useState(false);
  const [cleanView, setCleanView] = useState(false);
  const [fullscreenControlsVisible, setFullscreenControlsVisible] = useState(false);
  const arenaRef = useRef<ArenaHandle>(null);
  const arenaStageRef = useRef<HTMLElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const musicImportRef = useRef<HTMLInputElement>(null);
  const pendingPreviewSetupRef = useRef<MatchSetup>();
  const previewSyncFrameRef = useRef<number>();
  const fullscreenControlsTimerRef = useRef<number>();

  useEffect(() => {
    let alive = true;
    void loadManifest()
      .then((saved) => {
        if (!alive || !saved) return;
        setManifest(saved);
        setBattleManifest(structuredClone(saved));
        setSelectedCharacterId(
          saved.characters.some((character) => character.id === "panda-lazy")
            ? "panda-lazy"
            : saved.characters[0]?.id ?? "panda",
        );
        setSelectedBoardId(saved.setup.boardId);
      })
      .catch(() => setNotice("本地存档读取失败，已载入默认内容"))
      .finally(() => alive && setHydrated(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      void saveManifest(manifest)
        .then(() => setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })))
        .catch(() => setNotice("自动保存失败，可先导出资源包备份"));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [hydrated, manifest]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 2800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    arenaRef.current?.setSpeed(speed);
  }, [speed]);

  useEffect(() => {
    arenaRef.current?.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    arenaRef.current?.setVolume(volume);
  }, [volume]);

  useEffect(
    () => () => {
      if (previewSyncFrameRef.current !== undefined) {
        window.cancelAnimationFrame(previewSyncFrameRef.current);
      }
      if (fullscreenControlsTimerRef.current !== undefined) {
        window.clearTimeout(fullscreenControlsTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      if (event.code === "Space" && view === "battle") {
        event.preventDefault();
        arenaRef.current?.togglePause();
      }
      if (event.key === "." && view === "battle") arenaRef.current?.step();
      if (event.key.toLowerCase() === "f" && view === "battle") {
        event.preventDefault();
        if (document.fullscreenElement) {
          void document.exitFullscreen();
          setCleanView(false);
          setFullscreenControlsVisible(false);
        } else {
          setCleanView(true);
          setFullscreenControlsVisible(false);
          void arenaStageRef.current?.requestFullscreen().catch(() => {
            setCleanView(false);
          });
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [view]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        setCleanView(false);
        setFullscreenControlsVisible(false);
      }
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const showNotice = useCallback((message: string) => setNotice(message), []);

  const livingMain = useMemo(
    () =>
      snapshot?.units.filter((unit) => unit.main && unit.hp > 0 && unit.action !== "dead").length ??
      manifest.setup.contestants.length,
    [manifest.setup.contestants.length, snapshot],
  );
  const activeBoard = useMemo(
    () =>
      manifest.boards.find((board) => board.id === manifest.setup.boardId) ??
      manifest.boards[0],
    [manifest.boards, manifest.setup.boardId],
  );
  const hasRuntimeBoard = Boolean(snapshot && snapshot.status !== "ready");
  const runtimeBoard = hasRuntimeBoard
    ? battleManifest.boards.find((board) => board.id === battleManifest.setup.boardId)
    : undefined;
  const currentBoard = runtimeBoard ?? activeBoard;
  const currentBoardProps = hasRuntimeBoard
    ? snapshot?.props ?? currentBoard?.props ?? []
    : currentBoard?.props ?? [];
  const currentBoardHoles = hasRuntimeBoard ? snapshot?.holes ?? [] : [];

  const beginFreshBattle = (newSeed = false) => {
    if (manifest.setup.contestants.length < 2) {
      setNotice("至少添加两名主角色才能开战");
      return;
    }
    const next = structuredClone(manifest);
    if (newSeed) {
      next.setup.seed = Math.floor(Math.random() * 2_147_483_647);
      next.updatedAt = new Date().toISOString();
      setManifest(structuredClone(next));
    }
    setBattleManifest(next);
    setSnapshot(undefined);
    setPendingAutoStart(true);
    setBattleKey((key) => key + 1);
  };

  const resetBattle = () => {
    const next = structuredClone(manifest);
    setBattleManifest(next);
    setSnapshot(undefined);
    setPendingAutoStart(false);
    setBattleKey((key) => key + 1);
    setNotice("比赛已重置，可以重新调整站位、阵营和角色配置");
  };

  const onArenaReady = () => {
    arenaRef.current?.setSpeed(speed);
    arenaRef.current?.setMuted(muted);
    arenaRef.current?.setVolume(volume);
    if (!pendingAutoStart) arenaRef.current?.syncReadySetup(manifest.setup);
    if (pendingAutoStart) {
      arenaRef.current?.start();
      setPendingAutoStart(false);
    }
  };

  const queuePreviewSetupSync = (setup: MatchSetup) => {
    pendingPreviewSetupRef.current = setup;
    if (previewSyncFrameRef.current !== undefined) return;
    previewSyncFrameRef.current = window.requestAnimationFrame(() => {
      previewSyncFrameRef.current = undefined;
      const pendingSetup = pendingPreviewSetupRef.current;
      pendingPreviewSetupRef.current = undefined;
      if (pendingSetup) arenaRef.current?.syncReadySetup(pendingSetup);
    });
  };

  const updateSetup = (setup: MatchSetup) => {
    const next = structuredClone(manifest);
    next.setup = setup;
    next.updatedAt = new Date().toISOString();
    setManifest(next);
    queuePreviewSetupSync(setup);
  };

  const switchBoard = (boardId: string) => {
    const nextBoard = manifest.boards.find((board) => board.id === boardId);
    const previousBoard = activeBoard;
    if (!nextBoard || !previousBoard) return;
    const nextSetup: MatchSetup = {
      ...manifest.setup,
      boardId,
      contestants: manifest.setup.contestants.map((contestant) => ({
        ...contestant,
        position: {
          x: Math.max(
            60,
            Math.min(
              nextBoard.width - 60,
              (contestant.position.x / previousBoard.width) * nextBoard.width,
            ),
          ),
          y: Math.max(
            60,
            Math.min(
              nextBoard.height - 60,
              (contestant.position.y / previousBoard.height) * nextBoard.height,
            ),
          ),
        },
      })),
    };
    const nextManifest = structuredClone(manifest);
    nextManifest.setup = nextSetup;
    nextManifest.updatedAt = new Date().toISOString();
    setManifest(nextManifest);
    setBattleManifest(structuredClone(nextManifest));
    setSnapshot(undefined);
    setPendingAutoStart(false);
    setBattleKey((key) => key + 1);
    setSelectedBoardId(boardId);
    setNotice(`已切换为${nextBoard.name}`);
  };

  const enterCleanView = () => {
    setCleanView(true);
    setFullscreenControlsVisible(false);
    void arenaStageRef.current?.requestFullscreen().catch(() => {
      setCleanView(false);
    });
  };

  const exitCleanView = () => {
    setCleanView(false);
    setFullscreenControlsVisible(false);
    if (document.fullscreenElement) void document.exitFullscreen();
  };

  const revealFullscreenControls = () => {
    if (fullscreenControlsTimerRef.current !== undefined) {
      window.clearTimeout(fullscreenControlsTimerRef.current);
      fullscreenControlsTimerRef.current = undefined;
    }
    setFullscreenControlsVisible(true);
  };

  const scheduleFullscreenControlsHide = () => {
    if (fullscreenControlsTimerRef.current !== undefined) {
      window.clearTimeout(fullscreenControlsTimerRef.current);
    }
    fullscreenControlsTimerRef.current = window.setTimeout(() => {
      setFullscreenControlsVisible(false);
      fullscreenControlsTimerRef.current = undefined;
    }, 900);
  };

  const addContestant = (definitionId: string) => {
    const definition = manifest.characters.find((character) => character.id === definitionId);
    if (!definition) return;
    const index = manifest.setup.contestants.length;
    const ratio = spawnRatios[index % spawnRatios.length];
    const point = {
      x: ratio.x * (activeBoard?.width ?? 1600),
      y: ratio.y * (activeBoard?.height ?? 900),
    };
    const angle = (index * 2.3999632297 + 0.65) % (Math.PI * 2);
    const library =
      manifest.nameLibraries.find((candidate) => candidate.definitionId === definitionId)?.names
        .map((name) => name.trim())
        .filter(Boolean) ?? [];
    const usedNames = new Set(
      manifest.setup.contestants
        .filter((candidate) => candidate.definitionId === definitionId)
        .map((candidate) => candidate.displayName),
    );
    const availableName = library.find((name) => !usedNames.has(name));
    const fallbackName = library.length
      ? `${library[index % library.length]}·${usedNames.size + 1}`
      : `${definition.name}·${index + 1}`;
    const fighterColor = colorPalette[index % colorPalette.length];
    const contestant: MatchContestant = {
      id: createContestantId(),
      definitionId,
      displayName: availableName ?? fallbackName,
      position: { ...point },
      direction: { x: Math.cos(angle), y: Math.sin(angle) },
      color: fighterColor,
      nameColor: fighterColor,
      namePlacement: "above",
    };
    updateSetup({
      ...manifest.setup,
      contestants: [...manifest.setup.contestants, contestant],
    });
  };

  const removeContestant = (id: string) => {
    updateSetup({
      ...manifest.setup,
      contestants: manifest.setup.contestants.filter((contestant) => contestant.id !== id),
    });
  };

  const updateContestantHud = (
    id: string,
    changes: Partial<Pick<MatchContestant, "color" | "nameColor" | "namePlacement">>,
    syncTeam = false,
  ) => {
    const source = manifest.setup.contestants.find((contestant) => contestant.id === id);
    if (!source) return;
    updateSetup({
      ...manifest.setup,
      contestants: manifest.setup.contestants.map((contestant) => {
        const sharesTeam =
          Boolean(syncTeam && source.teamId) && contestant.teamId === source.teamId;
        return contestant.id === id || sharesTeam
          ? { ...contestant, ...changes }
          : contestant;
      }),
    });
  };

  const randomizeFormation = () => {
    const boardWidth = activeBoard?.width ?? 1600;
    const boardHeight = activeBoard?.height ?? 900;
    updateSetup({
      ...manifest.setup,
      contestants: manifest.setup.contestants.map((contestant, index) => {
        const ratio = spawnRatios[index % spawnRatios.length];
        const point = { x: ratio.x * boardWidth, y: ratio.y * boardHeight };
        const angle = Math.random() * Math.PI * 2;
        return {
          ...contestant,
          position: {
            x: Math.max(
              90,
              Math.min(boardWidth - 90, point.x + (Math.random() - 0.5) * 80),
            ),
            y: Math.max(
              90,
              Math.min(boardHeight - 90, point.y + (Math.random() - 0.5) * 80),
            ),
          },
          direction: { x: Math.cos(angle), y: Math.sin(angle) },
        };
      }),
    });
    setNotice("出生位置与方向已重新打乱");
  };

  const applyMusicConfig = (
    backgroundMusic: ProjectManifest["backgroundMusic"],
    assets = manifest.assets,
  ) => {
    const next = {
      ...manifest,
      assets,
      backgroundMusic,
      updatedAt: new Date().toISOString(),
    };
    setManifest(next);
    arenaRef.current?.setMusic(backgroundMusic, assets);
  };

  const uploadBackgroundMusic = async (file?: File) => {
    if (!file || !file.type.startsWith("audio/")) return;
    const assetId = `background-music-${Date.now()}`;
    const url = await fileToDataUrl(file);
    const assets = [
      ...manifest.assets,
      {
        id: assetId,
        kind: "audio" as const,
        url,
        name: file.name,
        mime: file.type,
      },
    ];
    applyMusicConfig(
      {
        enabled: true,
        source: "asset",
        assetId,
        title: file.name.replace(/\.[^.]+$/, ""),
        volume: manifest.backgroundMusic.volume,
      },
      assets,
    );
    setNotice(`背景音乐已切换为：${file.name}`);
  };

  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      const imported = await importProjectFile(file);
      setManifest(imported);
      setBattleManifest(structuredClone(imported));
      setSelectedCharacterId(
        imported.characters.some((character) => character.id === "panda-lazy")
          ? "panda-lazy"
          : imported.characters[0]?.id ?? "panda",
      );
      setSelectedBoardId(imported.setup.boardId);
      setBattleKey((key) => key + 1);
      setSnapshot(undefined);
      setNotice("项目导入成功");
    } catch (error) {
      setNotice(error instanceof Error ? error.message.split("\n")[0] : "项目导入失败");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  const navItems: Array<{ id: WorkspaceView; label: string; icon: typeof Swords; hint: string }> = [
    { id: "battle", label: "自动斗场", icon: Swords, hint: "布阵与观战" },
    { id: "characters", label: "角色工坊", icon: UsersRound, hint: "数值、动作与音效" },
    { id: "boards", label: "棋盘工坊", icon: ImagePlus, hint: "背景、道具与区域" },
  ];

  return (
    <main className={`app-shell ${cleanView ? "clean-spectator" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Swords size={21} />
          </span>
          <span>
            <strong>电子斗蛐蛐</strong>
            <small>CRITTER ARENA LAB</small>
          </span>
        </div>
        <nav className="top-nav" aria-label="工作区导航">
          {navItems.map(({ id, label, icon: Icon, hint }) => (
            <button
              type="button"
              key={id}
              className={view === id ? "is-active" : ""}
              onClick={() => setView(id)}
            >
              <Icon size={17} />
              <span>
                {label}
                <small>{hint}</small>
              </span>
            </button>
          ))}
        </nav>
        <div className="top-actions">
          <span className="save-state">
            <Save size={14} />
            {savedAt ? `${savedAt} 已保存` : hydrated ? "自动保存" : "载入中"}
          </span>
          <button className="header-button" type="button" onClick={() => importRef.current?.click()}>
            <Upload size={15} /> 导入
          </button>
          <input
            ref={importRef}
            hidden
            type="file"
            accept=".json,.zip,application/json,application/zip"
            onChange={(event) => void importFile(event.target.files?.[0])}
          />
          <div className="export-menu">
            <button className="header-button" type="button">
              <Download size={15} /> 导出 <ChevronRight size={13} />
            </button>
            <div className="export-popover">
              <button type="button" onClick={() => exportJson(manifest)}>
                <FileJson size={16} />
                <span><strong>配置 JSON</strong><small>适合版本管理与手工编辑</small></span>
              </button>
              <button type="button" onClick={() => void exportBundle(manifest)}>
                <FileArchive size={16} />
                <span><strong>完整资源包</strong><small>包含图片、音效与 manifest</small></span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {view === "battle" && (
        <div className="battle-workspace">
          <section ref={arenaStageRef} className="arena-panel">
            <div className="arena-panel-header">
              <div>
                <span className="live-dot" />
                <span className="eyebrow">LIVE SIMULATION</span>
                <h1>{manifest.boards.find((board) => board.id === manifest.setup.boardId)?.name ?? "未选择棋盘"}</h1>
              </div>
              <div className="arena-metrics">
                <span><Clock3 size={15} /><strong>{formatTime(snapshot?.time)}</strong><small>局内时间</small></span>
                <span><UsersRound size={15} /><strong>{livingMain}</strong><small>主角色存活</small></span>
                <span><Boxes size={15} /><strong>{snapshot?.units.length ?? manifest.setup.contestants.length}</strong><small>场上单位</small></span>
                <span><Gauge size={15} /><strong>{speed}×</strong><small>模拟速度</small></span>
              </div>
            </div>

            <div
              className={`arena-stage ${
                currentBoard && currentBoard.height > currentBoard.width
                  ? "is-portrait-board"
                  : "is-landscape-board"
              }`}
              style={{
                aspectRatio: `${currentBoard?.width ?? 1600} / ${currentBoard?.height ?? 900}`,
              }}
            >
              <ArenaCanvas
                key={`${battleKey}-${battleManifest.setup.seed}`}
                ref={arenaRef}
                manifest={battleManifest}
                muted={muted}
                volume={volume}
                onSnapshot={setSnapshot}
                onReady={onArenaReady}
              />
              <div className={`match-status-badge status-${snapshot?.status ?? "ready"}`}>
                <span />
                {statusLabel(snapshot?.status)}
              </div>
            </div>

            <div
              className={`battle-control-bar ${
                fullscreenControlsVisible ? "is-fullscreen-visible" : ""
              }`}
              onPointerEnter={revealFullscreenControls}
              onPointerLeave={scheduleFullscreenControlsHide}
              onFocusCapture={revealFullscreenControls}
            >
              <button
                type="button"
                className="primary-control"
                onClick={() => {
                  if (!snapshot || snapshot.status === "ready" || snapshot.status === "finished") {
                    beginFreshBattle(false);
                  } else if (snapshot.status === "paused") {
                    arenaRef.current?.resume();
                  } else {
                    arenaRef.current?.pause();
                  }
                }}
              >
                {!snapshot || snapshot.status === "ready" || snapshot.status === "finished" ? (
                  <><CirclePlay size={20} /> 部署并开战</>
                ) : snapshot.status === "paused" ? (
                  <><Play size={20} /> 继续</>
                ) : (
                  <><Pause size={20} /> 暂停</>
                )}
              </button>
              <div className="control-divider" />
              <button type="button" className="icon-control" onClick={() => arenaRef.current?.step()} title="单步">
                <SkipForward size={18} />
              </button>
              <button type="button" className="icon-control" onClick={resetBattle} title="重置比赛并返回赛前布阵">
                <RefreshCcw size={17} />
              </button>
              <button type="button" className="icon-control" onClick={() => beginFreshBattle(true)} title="换个种子再来一局">
                <Sparkles size={17} />
              </button>
              <div className="speed-switcher">
                {[0.5, 1, 2, 4].map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={speed === value ? "is-active" : ""}
                    onClick={() => {
                      setSpeed(value);
                      arenaRef.current?.setSpeed(value);
                    }}
                  >
                    {value}×
                  </button>
                ))}
              </div>
              <div className="control-divider" />
              <label className="board-quick-select">
                <span>画面比例</span>
                <select
                  value={manifest.setup.boardId}
                  onChange={(event) => switchBoard(event.target.value)}
                >
                  {manifest.boards.map((board) => (
                    <option key={board.id} value={board.id}>
                      {board.name} · {board.width}×{board.height}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="clean-view-control"
                onClick={cleanView ? exitCleanView : enterCleanView}
                title="隐藏全部界面，只保留对战画面（快捷键 F）"
              >
                {cleanView ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                纯净全屏 <kbd>F</kbd>
              </button>
              <div className="control-divider" />
              <button
                type="button"
                className="icon-control"
                onClick={() => setMuted((value) => !value)}
                title={muted ? "开启声音" : "静音"}
              >
                {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>
              <input
                className="volume-slider"
                aria-label="音效音量"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
              <div className="music-controls">
                <button
                  type="button"
                  className={`icon-control ${manifest.backgroundMusic.enabled ? "is-active" : ""}`}
                  onClick={() =>
                    applyMusicConfig({
                      ...manifest.backgroundMusic,
                      enabled: !manifest.backgroundMusic.enabled,
                    })
                  }
                  title={manifest.backgroundMusic.enabled ? "关闭背景音乐" : "开启背景音乐"}
                >
                  <Music2 size={17} />
                </button>
                <input
                  className="music-volume-slider"
                  aria-label="背景音乐音量"
                  type="range"
                  min={0}
                  max={0.75}
                  step={0.01}
                  value={manifest.backgroundMusic.volume}
                  onChange={(event) => {
                    const nextVolume = Number(event.target.value);
                    setManifest((current) => ({
                      ...current,
                      backgroundMusic: { ...current.backgroundMusic, volume: nextVolume },
                      updatedAt: new Date().toISOString(),
                    }));
                    arenaRef.current?.setMusicVolume(nextVolume);
                  }}
                />
                <button
                  type="button"
                  className="music-file-button"
                  onClick={() => musicImportRef.current?.click()}
                  title="上传 WAV / MP3 / OGG 背景音乐"
                >
                  <Upload size={13} /> 换音乐
                </button>
                <button
                  type="button"
                  className="music-file-button"
                  onClick={() => {
                    applyMusicConfig({
                      enabled: true,
                      source: "synth",
                      title: "竹林乱斗曲（原创默认）",
                      volume: manifest.backgroundMusic.volume,
                    });
                    setNotice("已恢复原创默认背景音乐");
                  }}
                  title="恢复原创默认音乐"
                >
                  默认曲
                </button>
                <input
                  ref={musicImportRef}
                  hidden
                  type="file"
                  accept="audio/wav,audio/mpeg,audio/ogg"
                  onChange={(event) => {
                    void uploadBackgroundMusic(event.target.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                />
                <span title={manifest.backgroundMusic.title}>
                  {manifest.backgroundMusic.title}
                </span>
              </div>
              <span className="seed-label">SEED {battleManifest.setup.seed}</span>
            </div>
            <div
              className="fullscreen-control-hotzone"
              aria-hidden="true"
              onPointerEnter={(event) => {
                if (event.pointerType === "mouse") revealFullscreenControls();
              }}
              onPointerDown={(event) => {
                if (event.pointerType === "mouse") {
                  revealFullscreenControls();
                } else {
                  setFullscreenControlsVisible((visible) => !visible);
                }
              }}
            />
          </section>

          <aside className="battle-sidebar">
            <section className="sidebar-section lineup-section">
              <div className="sidebar-heading">
                <div>
                  <span className="eyebrow">PRE-MATCH</span>
                  <h2>参赛阵容</h2>
                </div>
                <button type="button" className="text-button" onClick={randomizeFormation}>
                  <Sparkles size={14} /> 打乱
                </button>
              </div>
              <FormationEditor
                setup={manifest.setup}
                characters={manifest.characters}
                board={activeBoard}
                onChange={updateSetup}
                liveUnits={snapshot?.units}
                battleStatus={snapshot?.status}
              />
              <div className="contestant-list">
                {manifest.setup.contestants.map((contestant, index) => {
                  const definition = manifest.characters.find(
                    (character) => character.id === contestant.definitionId,
                  );
                  return (
                    <div className="contestant-entry" key={contestant.id}>
                      <div className="contestant-row">
                        <span className="contestant-index" style={{ borderColor: contestant.color }}>
                          {index + 1}
                        </span>
                        <span className="contestant-type">
                          {definition?.id.startsWith("panda") ? "🐼" : definition?.id === "mole" ? "🦫" : "👮"}
                        </span>
                        <input
                          value={contestant.displayName}
                          onChange={(event) =>
                            updateSetup({
                              ...manifest.setup,
                              contestants: manifest.setup.contestants.map((candidate) =>
                                candidate.id === contestant.id
                                  ? { ...candidate, displayName: event.target.value }
                                  : candidate,
                              ),
                            })
                          }
                        />
                        <select
                          className="contestant-team"
                          aria-label={`${contestant.displayName}阵营`}
                          value={contestant.teamId ?? ""}
                          onChange={(event) => {
                            const teamId = event.target.value || undefined;
                            const ally = teamId
                              ? manifest.setup.contestants.find(
                                  (candidate) =>
                                    candidate.id !== contestant.id &&
                                    candidate.teamId === teamId,
                                )
                              : undefined;
                            const defaultTeamColor =
                              teamOptions.find((team) => team.id === teamId)?.color;
                            const color = ally?.color ?? defaultTeamColor ?? contestant.color;
                            const nameColor = ally?.nameColor ?? color;
                            updateSetup({
                              ...manifest.setup,
                              contestants: manifest.setup.contestants.map((candidate) =>
                                candidate.id === contestant.id
                                  ? { ...candidate, teamId, color, nameColor }
                                  : candidate,
                              ),
                            });
                          }}
                        >
                          {teamOptions.map((team) => (
                            <option key={team.id || "solo"} value={team.id}>
                              {team.label}
                            </option>
                          ))}
                        </select>
                        <small>{definition?.maxHp ?? 0} HP</small>
                        <button type="button" onClick={() => removeContestant(contestant.id)} title="移除">
                          <X size={14} />
                        </button>
                      </div>
                      <div className="contestant-hud-controls">
                        <label title={contestant.teamId ? "修改后同步到同阵营角色" : "血条颜色"}>
                          <span>血条</span>
                          <input
                            type="color"
                            value={contestant.color}
                            aria-label={`${contestant.displayName}血条颜色`}
                            onChange={(event) =>
                              updateContestantHud(
                                contestant.id,
                                { color: event.target.value },
                                true,
                              )
                            }
                          />
                        </label>
                        <label title={contestant.teamId ? "修改后同步到同阵营角色" : "名字颜色"}>
                          <span>名字</span>
                          <input
                            type="color"
                            value={contestant.nameColor ?? contestant.color}
                            aria-label={`${contestant.displayName}名字颜色`}
                            onChange={(event) =>
                              updateContestantHud(
                                contestant.id,
                                { nameColor: event.target.value },
                                true,
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>位置</span>
                          <select
                            value={contestant.namePlacement ?? "above"}
                            aria-label={`${contestant.displayName}名字位置`}
                            onChange={(event) =>
                              updateContestantHud(contestant.id, {
                                namePlacement: event.target.value as "above" | "inside",
                              })
                            }
                          >
                            <option value="above">血条上方</option>
                            <option value="inside">血条内</option>
                          </select>
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="add-fighter-grid">
                {manifest.characters
                  .map((character) => (
                    <button type="button" key={character.id} onClick={() => addContestant(character.id)}>
                      <Plus size={14} /> {character.name}
                    </button>
                  ))}
              </div>
              <NameLibraryEditor
                characters={manifest.characters}
                libraries={manifest.nameLibraries}
                onChange={(nameLibraries) =>
                  setManifest((current) => ({
                    ...current,
                    nameLibraries,
                    updatedAt: new Date().toISOString(),
                  }))
                }
              />
            </section>

            <BoardPropsPanel
              boardName={currentBoard?.name ?? "未选择棋盘"}
              props={currentBoardProps}
              holes={currentBoardHoles}
            />

            <section className="sidebar-section event-section">
              <div className="sidebar-heading">
                <div>
                  <span className="eyebrow">BATTLE FEED</span>
                  <h2>战况播报</h2>
                </div>
                <AudioLines size={18} />
              </div>
              <div className="event-feed">
                {(snapshot?.events ?? [])
                  .slice(-20)
                  .reverse()
                  .map((event) => (
                    <div className={`event-item type-${event.type}`} key={event.id}>
                      <span>{formatTime(event.time)}</span>
                      <p>{event.message}</p>
                    </div>
                  ))}
                {!snapshot?.events.length && (
                  <div className="empty-feed">
                    <Gamepad2 size={24} />
                    <p>部署阵容并开战后，攻击、技能、合成和死亡事件会出现在这里。</p>
                  </div>
                )}
              </div>
            </section>
          </aside>
        </div>
      )}

      {view === "characters" && (
        <CharacterEditor
          manifest={manifest}
          selectedId={selectedCharacterId}
          onSelect={setSelectedCharacterId}
          onChange={setManifest}
          onNotice={showNotice}
        />
      )}

      {view === "boards" && (
        <BoardEditor
          manifest={manifest}
          selectedId={selectedBoardId}
          onSelect={(id) => {
            if (manifest.boards.some((board) => board.id === id)) {
              switchBoard(id);
            } else {
              setSelectedBoardId(id);
            }
          }}
          onChange={setManifest}
          onNotice={showNotice}
        />
      )}

      {notice && <div className="toast"><Settings2 size={16} /> {notice}</div>}
    </main>
  );
}
