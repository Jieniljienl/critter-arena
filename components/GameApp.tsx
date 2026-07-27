"use client";

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AudioLines,
  Boxes,
  Check,
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
  Mic,
  MicOff,
  Minimize2,
  Music2,
  Pause,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCcw,
  Save,
  Settings2,
  SkipForward,
  Sparkles,
  Swords,
  Trash2,
  Upload,
  UsersRound,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { ArenaCanvas, type ArenaHandle } from "./ArenaCanvas";
import { BoardPropsPanel } from "./BoardPropsPanel";
import { FormationEditor } from "./FormationEditor";
import { NameLibraryEditor } from "./NameLibraryEditor";
import {
  createDefaultManifest,
  createShowcaseContestants,
} from "@/lib/game/defaultContent";
import type { SkillVoiceMode } from "@/lib/game/audio";
import { removeBoardFromManifest } from "@/lib/game/project";
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
type MobileSidebarPanel = "lineup" | "props" | "feed";
type TeamMenuState = {
  contestantId: string;
  x: number;
  y: number;
};

type WebkitFullscreenDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
};

type WebkitFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

const getFullscreenElement = () =>
  document.fullscreenElement ??
  (document as WebkitFullscreenDocument).webkitFullscreenElement ??
  null;

const requestNativeFullscreen = async () => {
  const element = document.documentElement as WebkitFullscreenElement;
  try {
    if (element.requestFullscreen) {
      await element.requestFullscreen({ navigationUI: "hide" });
    } else if (element.webkitRequestFullscreen) {
      await element.webkitRequestFullscreen();
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

const exitNativeFullscreen = async () => {
  const webkitDocument = document as WebkitFullscreenDocument;
  const exit = document.exitFullscreen ?? webkitDocument.webkitExitFullscreen;
  if (!exit || !getFullscreenElement()) return;
  try {
    await exit.call(document);
  } catch {
    // The CSS immersive view still exits even if the browser rejects its native API.
  }
};

const CharacterEditor = lazy(() =>
  import("./CharacterEditor").then((module) => ({ default: module.CharacterEditor })),
);
const BoardEditor = lazy(() =>
  import("./BoardEditor").then((module) => ({ default: module.BoardEditor })),
);

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

const SIDEBAR_EXPANDED_STORAGE_KEY = "critter-arena:sidebar-expanded";

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

const avoidCardinalAngle = (angle: number, fallbackSign = 1) => {
  const quarterTurn = Math.PI / 2;
  const clearance = (8 * Math.PI) / 180;
  const nearestAxis = Math.round(angle / quarterTurn) * quarterTurn;
  const delta = angle - nearestAxis;
  if (Math.abs(delta) >= clearance) return angle;
  return nearestAxis + (delta === 0 ? fallbackSign : Math.sign(delta)) * clearance;
};

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
  const [battleManifest, setBattleManifest] = useState<ProjectManifest>(() =>
    structuredClone(manifest),
  );
  const [view, setView] = useState<WorkspaceView>("battle");
  const [battleKey, setBattleKey] = useState(0);
  const [snapshot, setSnapshot] = useState<BattleSnapshot>();
  const [speed, setSpeed] = useState(1);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.72);
  const [skillVoicesEnabled, setSkillVoicesEnabled] = useState(true);
  const [skillVoiceVolume, setSkillVoiceVolume] = useState(0.78);
  const [skillVoiceMode, setSkillVoiceMode] =
    useState<SkillVoiceMode>("concise");
  const [hydrated, setHydrated] = useState(false);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(false);
  const [savedAt, setSavedAt] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selectedCharacterId, setSelectedCharacterId] = useState("panda-lazy");
  const [selectedBoardId, setSelectedBoardId] = useState(
    "portrait-aurora-platform",
  );
  const [pendingAutoStart, setPendingAutoStart] = useState(false);
  const [cleanView, setCleanView] = useState(false);
  const [fullscreenControlsVisible, setFullscreenControlsVisible] = useState(false);
  const [mobileSidebarPanel, setMobileSidebarPanel] =
    useState<MobileSidebarPanel>("lineup");
  const [selectedContestantId, setSelectedContestantId] = useState<string>();
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [teamMenu, setTeamMenu] = useState<TeamMenuState>();
  const arenaRef = useRef<ArenaHandle>(null);
  const battleControlBarRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const musicImportRef = useRef<HTMLInputElement>(null);
  const pendingPreviewSetupRef = useRef<MatchSetup | undefined>(undefined);
  const previewSyncFrameRef = useRef<number | undefined>(undefined);
  const fullscreenControlsTimerRef = useRef<number | undefined>(undefined);
  const nativeFullscreenRef = useRef(false);
  const teamMenuRef = useRef<HTMLDivElement>(null);

  const revealFullscreenControls = useCallback(() => {
    if (fullscreenControlsTimerRef.current !== undefined) {
      window.clearTimeout(fullscreenControlsTimerRef.current);
      fullscreenControlsTimerRef.current = undefined;
    }
    setFullscreenControlsVisible(true);
  }, []);

  const scheduleFullscreenControlsHide = useCallback((delay = 900) => {
    if (fullscreenControlsTimerRef.current !== undefined) {
      window.clearTimeout(fullscreenControlsTimerRef.current);
    }
    fullscreenControlsTimerRef.current = window.setTimeout(() => {
      setFullscreenControlsVisible(false);
      fullscreenControlsTimerRef.current = undefined;
    }, delay);
  }, []);

  const enterCleanView = useCallback(async () => {
    setSidebarExpanded(false);
    setTeamMenu(undefined);
    setCleanView(true);
    revealFullscreenControls();
    scheduleFullscreenControlsHide(2600);
    const enteredNative = await requestNativeFullscreen();
    nativeFullscreenRef.current = enteredNative || Boolean(getFullscreenElement());
    if (!enteredNative) {
      setNotice("已进入沉浸式观看；当前手机浏览器不提供网页原生全屏");
    }
  }, [revealFullscreenControls, scheduleFullscreenControlsHide]);

  const exitCleanView = useCallback(async () => {
    setCleanView(false);
    setFullscreenControlsVisible(false);
    nativeFullscreenRef.current = false;
    await exitNativeFullscreen();
  }, []);

  useEffect(() => {
    let alive = true;
    void loadManifest()
      .then((saved) => {
        if (!alive) return;
        if (saved) {
          setManifest(saved);
          setBattleManifest(structuredClone(saved));
          setSelectedCharacterId(
            saved.characters.some((character) => character.id === "panda-lazy")
              ? "panda-lazy"
              : saved.characters[0]?.id ?? "panda",
          );
          setSelectedBoardId(saved.setup.boardId);
        }
        setAutoSaveEnabled(true);
      })
      .catch(() => {
        if (!alive) return;
        setAutoSaveEnabled(false);
        setNotice("本地存档读取失败，为保护原设置已暂停自动保存");
      })
      .finally(() => alive && setHydrated(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!hydrated || !autoSaveEnabled) return;
    const timer = window.setTimeout(() => {
      void saveManifest(manifest)
        .then(() => setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })))
        .catch(() => setNotice("自动保存失败，可先导出资源包备份"));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [autoSaveEnabled, hydrated, manifest]);

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

  useEffect(() => {
    arenaRef.current?.setSkillVoicesEnabled(skillVoicesEnabled);
  }, [skillVoicesEnabled]);

  useEffect(() => {
    arenaRef.current?.setSkillVoiceVolume(skillVoiceVolume);
  }, [skillVoiceVolume]);

  useEffect(() => {
    arenaRef.current?.setSkillVoiceMode(skillVoiceMode);
  }, [skillVoiceMode]);

  useEffect(() => {
    const syncFullscreenState = () => {
      if (getFullscreenElement()) {
        nativeFullscreenRef.current = true;
        setSidebarExpanded(false);
        setTeamMenu(undefined);
        setCleanView(true);
        return;
      }
      if (nativeFullscreenRef.current) {
        nativeFullscreenRef.current = false;
        setCleanView(false);
        setFullscreenControlsVisible(false);
      }
    };
    document.addEventListener("fullscreenchange", syncFullscreenState);
    document.addEventListener("webkitfullscreenchange", syncFullscreenState);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      document.removeEventListener("webkitfullscreenchange", syncFullscreenState);
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("clean-view-active", cleanView);
    document.body.classList.toggle("clean-view-active", cleanView);
    if (!cleanView) {
      window.requestAnimationFrame(() => {
        battleControlBarRef.current?.scrollTo({ left: 0 });
      });
    }
    return () => {
      document.documentElement.classList.remove("clean-view-active");
      document.body.classList.remove("clean-view-active");
    };
  }, [cleanView]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (
        !window.matchMedia("(max-width: 980px)").matches &&
        window.localStorage.getItem(SIDEBAR_EXPANDED_STORAGE_KEY) === "true"
      ) {
        setSidebarExpanded(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 980px)");
    const syncDesktopSidebar = () => {
      if (media.matches) {
        setSidebarExpanded(false);
        setTeamMenu(undefined);
      }
    };
    syncDesktopSidebar();
    media.addEventListener("change", syncDesktopSidebar);
    return () => media.removeEventListener("change", syncDesktopSidebar);
  }, []);

  useEffect(() => {
    if (!teamMenu) return;
    const closeMenu = () => setTeamMenu(undefined);
    const handlePointerDown = (event: PointerEvent) => {
      if (!teamMenuRef.current?.contains(event.target as Node)) closeMenu();
    };
    const focusMenu = window.requestAnimationFrame(() => {
      const items = Array.from(
        teamMenuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitemradio"]',
        ) ?? [],
      );
      const selected = items.find((item) => item.getAttribute("aria-checked") === "true");
      (selected ?? items[0])?.focus({ preventScroll: true });
    });
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      window.cancelAnimationFrame(focusMenu);
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [teamMenu]);

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
      if (event.key === "Escape") {
        if (teamMenu) {
          event.preventDefault();
          setTeamMenu(undefined);
          return;
        }
        if (sidebarExpanded) {
          event.preventDefault();
          setSidebarExpanded(false);
          window.localStorage.setItem(
            SIDEBAR_EXPANDED_STORAGE_KEY,
            "false",
          );
          return;
        }
        if (cleanView && !getFullscreenElement()) {
          event.preventDefault();
          void exitCleanView();
        }
        return;
      }
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "." && view === "battle") arenaRef.current?.step();
      if (event.key.toLowerCase() === "f" && view === "battle") {
        event.preventDefault();
        void (cleanView ? exitCleanView() : enterCleanView());
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    cleanView,
    enterCleanView,
    exitCleanView,
    sidebarExpanded,
    teamMenu,
    view,
  ]);

  const showNotice = useCallback((message: string) => setNotice(message), []);

  const livingFactions = useMemo(() => {
    if (snapshot) {
      return new Set(
        snapshot.units
          .filter(
            (unit) =>
              unit.hp > 0 &&
              unit.action !== "dead" &&
              (unit.main || unit.sustainsFaction),
          )
          .map((unit) => unit.factionId),
      ).size;
    }
    return new Set(
      manifest.setup.contestants.map((contestant) =>
        contestant.teamId ? `team:${contestant.teamId}` : contestant.id,
      ),
    ).size;
  }, [manifest.setup.contestants, snapshot]);
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
  const formationManifest = hasRuntimeBoard ? battleManifest : manifest;
  const formationBoard =
    formationManifest.boards.find(
      (board) => board.id === formationManifest.setup.boardId,
    ) ?? formationManifest.boards[0];

  const beginFreshBattle = useCallback((newSeed = false) => {
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
  }, [manifest]);

  useEffect(() => {
    const handleSpace = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.code !== "Space" ||
        view !== "battle" ||
        target?.matches("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      event.preventDefault();
      if (!snapshot || snapshot.status === "ready" || snapshot.status === "finished") {
        beginFreshBattle(false);
      } else {
        arenaRef.current?.togglePause();
      }
    };
    window.addEventListener("keydown", handleSpace);
    return () => window.removeEventListener("keydown", handleSpace);
  }, [beginFreshBattle, snapshot, view]);

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
    arenaRef.current?.setSkillVoicesEnabled(skillVoicesEnabled);
    arenaRef.current?.setSkillVoiceVolume(skillVoiceVolume);
    arenaRef.current?.setSkillVoiceMode(skillVoiceMode);
    if (!pendingAutoStart) arenaRef.current?.syncReadySetup(manifest.setup);
    if (pendingAutoStart) {
      arenaRef.current?.start();
      setPendingAutoStart(false);
    }
  };

  const queuePreviewSetupSync = useCallback((setup: MatchSetup) => {
    pendingPreviewSetupRef.current = setup;
    if (previewSyncFrameRef.current !== undefined) return;
    previewSyncFrameRef.current = window.requestAnimationFrame(() => {
      previewSyncFrameRef.current = undefined;
      const pendingSetup = pendingPreviewSetupRef.current;
      pendingPreviewSetupRef.current = undefined;
      if (pendingSetup) arenaRef.current?.syncReadySetup(pendingSetup);
    });
  }, []);

  const updateSetup = useCallback((setup: MatchSetup) => {
    setManifest((current) => ({
      ...current,
      setup,
      updatedAt: new Date().toISOString(),
    }));
    queuePreviewSetupSync(setup);
  }, [queuePreviewSetupSync]);

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

  const deleteBoard = (boardId: string) => {
    const removedBoard = manifest.boards.find((board) => board.id === boardId);
    const result = removeBoardFromManifest(manifest, boardId);
    if (!removedBoard || !result) {
      setNotice("棋盘删除失败，棋盘库至少需要保留一张棋盘");
      return;
    }
    setManifest(result.manifest);
    setBattleManifest(structuredClone(result.manifest));
    setSelectedBoardId(result.selectedBoardId);
    setSnapshot(undefined);
    setPendingAutoStart(false);
    setBattleKey((key) => key + 1);
    setNotice(`已删除棋盘“${removedBoard.name}”并切换到下一张棋盘`);
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
    const angle = avoidCardinalAngle(
      (index * 2.3999632297 + 0.65) % (Math.PI * 2),
      index % 2 === 0 ? 1 : -1,
    );
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
    if (selectedContestantId === id) setSelectedContestantId(undefined);
    setTeamMenu((current) =>
      current?.contestantId === id ? undefined : current,
    );
  };

  useEffect(() => {
    const handleDelete = (event: KeyboardEvent) => {
      if (
        event.key !== "Delete" ||
        view !== "battle" ||
        !selectedContestantId
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.matches(
          "input, textarea, select, [contenteditable='true'], [contenteditable='']",
        )
      ) {
        return;
      }
      const contestant = manifest.setup.contestants.find(
        (candidate) => candidate.id === selectedContestantId,
      );
      if (!contestant) {
        setSelectedContestantId(undefined);
        setTeamMenu(undefined);
        return;
      }
      event.preventDefault();
      const nextSetup = {
        ...manifest.setup,
        contestants: manifest.setup.contestants.filter(
          (candidate) => candidate.id !== contestant.id,
        ),
      };
      updateSetup(nextSetup);
      setSelectedContestantId(undefined);
      setTeamMenu(undefined);
      setNotice(`已删除角色实例“${contestant.displayName}”`);
    };
    window.addEventListener("keydown", handleDelete);
    return () => window.removeEventListener("keydown", handleDelete);
  }, [manifest, selectedContestantId, updateSetup, view]);

  const replaceManifestAndResetPreview = (
    next: ProjectManifest,
    message: string,
  ) => {
    next.updatedAt = new Date().toISOString();
    setManifest(next);
    setBattleManifest(structuredClone(next));
    setSnapshot(undefined);
    setPendingAutoStart(false);
    setBattleKey((key) => key + 1);
    setNotice(message);
  };

  const applyShowcaseFormation = () => {
    if (!activeBoard) return;
    const availableDefinitions = new Set(
      manifest.characters.map((character) => character.id),
    );
    const contestants = createShowcaseContestants(
      activeBoard.width,
      activeBoard.height,
    ).filter((contestant) =>
      availableDefinitions.has(contestant.definitionId),
    );
    if (contestants.length < 2) {
      setNotice("缺少默认角色模板，无法部署观赏阵容");
      return;
    }
    const next = structuredClone(manifest);
    next.setup.seed = 20260726;
    next.setup.contestants = contestants;
    replaceManifestAndResetPreview(
      next,
      "已部署观赏阵容：四阵营将展示升星、钻洞、RPG 与定向连发",
    );
  };

  const clearContestants = () => {
    if (!manifest.setup.contestants.length) return;
    if (!window.confirm("确定清空当前全部角色实例吗？角色模板和名字库不会被删除。")) {
      return;
    }
    const next = structuredClone(manifest);
    next.setup.contestants = [];
    replaceManifestAndResetPreview(next, "已清空当前参赛角色实例");
  };

  const updateCurrentBoardProp = (
    propId: string,
    changes: Partial<
      Pick<
        NonNullable<typeof activeBoard>["props"][number],
        "active" | "buffDuration" | "effectPerSecond"
      >
    >,
  ) => {
    const next = structuredClone(manifest);
    const board = next.boards.find((candidate) => candidate.id === next.setup.boardId);
    const prop = board?.props.find((candidate) => candidate.id === propId);
    if (!prop) return;
    Object.assign(prop, changes);
    replaceManifestAndResetPreview(next, "道具实例设置已更新");
  };

  const removeCurrentBoardProp = (propId: string) => {
    const next = structuredClone(manifest);
    const board = next.boards.find((candidate) => candidate.id === next.setup.boardId);
    if (!board) return;
    board.props = board.props.filter((prop) => prop.id !== propId);
    replaceManifestAndResetPreview(next, "已移除当前道具实例");
  };

  const clearCurrentBoardProps = () => {
    const board = manifest.boards.find((candidate) => candidate.id === manifest.setup.boardId);
    if (!board || (!board.props.length && !currentBoardHoles.length)) return;
    if (
      !window.confirm(
        `确定清空“${board.name}”的全部道具吗？当前运行时洞口也会随比赛重置清除。`,
      )
    ) {
      return;
    }
    const next = structuredClone(manifest);
    const nextBoard = next.boards.find((candidate) => candidate.id === next.setup.boardId);
    if (!nextBoard) return;
    nextBoard.props = [];
    replaceManifestAndResetPreview(next, "已清空当前棋盘全部道具");
  };

  const updateContestantHud = (
    id: string,
    changes: Partial<Pick<MatchContestant, "color" | "nameColor">>,
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

  const assignContestantTeam = (
    contestantId: string,
    teamId: string | undefined,
  ) => {
    const contestant = manifest.setup.contestants.find(
      (candidate) => candidate.id === contestantId,
    );
    if (!contestant) return;
    const ally = teamId
      ? manifest.setup.contestants.find(
          (candidate) =>
            candidate.id !== contestantId && candidate.teamId === teamId,
        )
      : undefined;
    const defaultTeamColor = teamOptions.find(
      (team) => team.id === teamId,
    )?.color;
    const color = ally?.color ?? defaultTeamColor ?? contestant.color;
    const nameColor = ally?.nameColor ?? color;
    updateSetup({
      ...manifest.setup,
      contestants: manifest.setup.contestants.map((candidate) =>
        candidate.id === contestantId
          ? { ...candidate, teamId, color, nameColor }
          : candidate,
      ),
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
        const angle = avoidCardinalAngle(
          Math.random() * Math.PI * 2,
          Math.random() < 0.5 ? -1 : 1,
        );
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

  const selectContestantInstance = useCallback((contestantId: string) => {
    setTeamMenu(undefined);
    setSelectedContestantId(contestantId);
    window.requestAnimationFrame(() => {
      document
        .getElementById(`contestant-entry-${contestantId}`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }, []);

  const requestContestantTeam = useCallback(
    (contestantId: string, clientX: number, clientY: number) => {
      setSelectedContestantId(contestantId);
      const menuWidth = 196;
      const menuHeight = 286;
      setTeamMenu({
        contestantId,
        x: Math.max(8, Math.min(clientX, window.innerWidth - menuWidth - 8)),
        y: Math.max(8, Math.min(clientY, window.innerHeight - menuHeight - 8)),
      });
    },
    [],
  );

  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      const imported = await importProjectFile(file);
      setAutoSaveEnabled(true);
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
  const teamMenuContestant = teamMenu
    ? manifest.setup.contestants.find(
        (contestant) => contestant.id === teamMenu.contestantId,
      )
    : undefined;

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
              onClick={() => {
                setView(id);
                if (id !== "battle") {
                  setSidebarExpanded(false);
                  setTeamMenu(undefined);
                }
              }}
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
            {savedAt
              ? `${savedAt} 已保存`
              : !hydrated
                ? "载入中"
                : autoSaveEnabled
                  ? "自动保存"
                  : "自动保存已暂停"}
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
        <div
          className={`battle-workspace ${
            sidebarExpanded ? "is-sidebar-expanded" : ""
          }`}
        >
          <section className="arena-panel">
            <div className="arena-panel-header">
              <div>
                <span className="live-dot" />
                <span className="eyebrow">LIVE SIMULATION</span>
                <h1>{manifest.boards.find((board) => board.id === manifest.setup.boardId)?.name ?? "未选择棋盘"}</h1>
              </div>
              <div className="arena-metrics">
                <span><Clock3 size={15} /><strong>{formatTime(snapshot?.time)}</strong><small>局内时间</small></span>
                <span><UsersRound size={15} /><strong>{livingFactions}</strong><small>存活阵营</small></span>
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
              onPointerUp={(event) => {
                if (!cleanView || event.pointerType === "mouse") return;
                const target = event.target as HTMLElement;
                if (target.closest("button, input, select, label")) return;
                setFullscreenControlsVisible((visible) => !visible);
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
              <button
                type="button"
                className="mobile-stage-fullscreen"
                onClick={() => void enterCleanView()}
                aria-label="全屏观看对战"
              >
                <Maximize2 size={17} />
                全屏观看
              </button>
            </div>

            <div
              ref={battleControlBarRef}
              className={`battle-control-bar ${
                fullscreenControlsVisible ? "is-fullscreen-visible" : ""
              }`}
              onPointerEnter={revealFullscreenControls}
              onPointerLeave={() => scheduleFullscreenControlsHide()}
              onPointerDown={revealFullscreenControls}
              onPointerUp={(event) => {
                if (cleanView && event.pointerType !== "mouse") {
                  scheduleFullscreenControlsHide(2600);
                }
              }}
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
                onClick={() => void (cleanView ? exitCleanView() : enterCleanView())}
                title="隐藏全部界面，只保留对战画面（快捷键 F）"
              >
                {cleanView ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                {cleanView ? "退出全屏" : "纯净全屏"} <kbd>F</kbd>
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
              <div className="announcer-controls" title="角色技能语音">
                <button
                  type="button"
                  className={`icon-control ${skillVoicesEnabled ? "is-active" : ""}`}
                  onClick={() => setSkillVoicesEnabled((enabled) => !enabled)}
                  aria-label={skillVoicesEnabled ? "关闭技能语音" : "开启技能语音"}
                >
                  {skillVoicesEnabled ? <Mic size={17} /> : <MicOff size={17} />}
                </button>
                <input
                  aria-label="技能语音音量"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={skillVoiceVolume}
                  disabled={!skillVoicesEnabled}
                  onChange={(event) => setSkillVoiceVolume(Number(event.target.value))}
                />
                <select
                  className="announcer-mode-select"
                  aria-label="技能语音播报模式"
                  value={skillVoiceMode}
                  disabled={!skillVoicesEnabled}
                  onChange={(event) =>
                    setSkillVoiceMode(event.target.value as SkillVoiceMode)
                  }
                  title={
                    skillVoiceMode === "full"
                      ? "全量播报：保留每次触发，按触发顺序完整播完"
                      : "精简播报：播报期间忽略新触发，结束后再接收"
                  }
                >
                  <option value="concise">精简播报</option>
                  <option value="full">全量播报</option>
                </select>
              </div>
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
            <button
              type="button"
              className="fullscreen-control-hotzone"
              aria-label={
                fullscreenControlsVisible ? "隐藏全屏控制台" : "显示全屏控制台"
              }
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
            >
              <span>控制台</span>
            </button>
          </section>

          <button
            type="button"
            className="sidebar-expand-handle"
            onClick={() => {
              setTeamMenu(undefined);
              setSidebarExpanded((expanded) => {
                const nextExpanded = !expanded;
                window.localStorage.setItem(
                  SIDEBAR_EXPANDED_STORAGE_KEY,
                  String(nextExpanded),
                );
                return nextExpanded;
              });
            }}
            aria-expanded={sidebarExpanded}
            aria-controls="battle-settings-sidebar"
            title={sidebarExpanded ? "收起设置栏" : "展开设置栏"}
          >
            {sidebarExpanded ? (
              <PanelRightClose size={17} />
            ) : (
              <PanelRightOpen size={17} />
            )}
            <span>{sidebarExpanded ? "收起" : "展开"}</span>
          </button>

          <aside
            id="battle-settings-sidebar"
            className={`battle-sidebar mobile-panel-${mobileSidebarPanel} ${
              sidebarExpanded ? "is-expanded" : ""
            }`}
          >
            <nav className="mobile-sidebar-tabs" aria-label="战场设置">
              <button
                type="button"
                className={mobileSidebarPanel === "lineup" ? "is-active" : ""}
                aria-pressed={mobileSidebarPanel === "lineup"}
                onClick={() => setMobileSidebarPanel("lineup")}
              >
                <UsersRound size={17} />
                阵容
              </button>
              <button
                type="button"
                className={mobileSidebarPanel === "props" ? "is-active" : ""}
                aria-pressed={mobileSidebarPanel === "props"}
                onClick={() => setMobileSidebarPanel("props")}
              >
                <Boxes size={17} />
                道具
              </button>
              <button
                type="button"
                className={mobileSidebarPanel === "feed" ? "is-active" : ""}
                aria-pressed={mobileSidebarPanel === "feed"}
                onClick={() => setMobileSidebarPanel("feed")}
              >
                <AudioLines size={17} />
                战报
              </button>
            </nav>
            <section className="sidebar-section lineup-section">
              <div className="sidebar-heading">
                <div>
                  <span className="eyebrow">PRE-MATCH</span>
                  <h2>参赛阵容</h2>
                </div>
                <div className="sidebar-heading-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={applyShowcaseFormation}
                    title="部署包含熊猫呼警、警察升星、地鼠钻洞、RPG 和加特林的四阵营阵容"
                  >
                    <Swords size={14} /> 观赏阵容
                  </button>
                  <button type="button" className="text-button" onClick={randomizeFormation}>
                    <Sparkles size={14} /> 打乱
                  </button>
                  <button
                    type="button"
                    className="sidebar-danger-button"
                    onClick={clearContestants}
                    disabled={!manifest.setup.contestants.length}
                    title="一键清空当前全部角色实例"
                  >
                    <Trash2 size={13} /> 清空
                  </button>
                </div>
              </div>
              <FormationEditor
                setup={formationManifest.setup}
                characters={formationManifest.characters}
                board={formationBoard}
                onChange={updateSetup}
                battleStatus={snapshot?.status}
                selectedContestantId={selectedContestantId}
                onSelectContestant={selectContestantInstance}
                onRequestTeam={requestContestantTeam}
              />
              <div className="contestant-list">
                {manifest.setup.contestants.map((contestant, index) => {
                  const definition = manifest.characters.find(
                    (character) => character.id === contestant.definitionId,
                  );
                  return (
                    <div
                      id={`contestant-entry-${contestant.id}`}
                      className={`contestant-entry ${
                        selectedContestantId === contestant.id
                          ? "is-selected"
                          : ""
                      }`}
                      key={contestant.id}
                      onClick={() => setSelectedContestantId(contestant.id)}
                    >
                      <div className="contestant-row">
                        <span className="contestant-index" style={{ borderColor: contestant.color }}>
                          {index + 1}
                        </span>
                        <span className="contestant-type">
                          {definition?.id.startsWith("panda") ? "🐼" : definition?.id === "mole" ? "🦫" : "👮"}
                        </span>
                        <div className="contestant-identity">
                          <input
                            aria-label={`${contestant.displayName}实例名称`}
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
                          <span
                            className="contestant-definition-name"
                            title={definition?.name ?? "未知角色类型"}
                          >
                            类型 · {definition?.name ?? "未知角色"}
                          </span>
                        </div>
                        <select
                          className="contestant-team"
                          aria-label={`${contestant.displayName}阵营`}
                          value={contestant.teamId ?? ""}
                          onChange={(event) =>
                            assignContestantTeam(
                              contestant.id,
                              event.target.value || undefined,
                            )
                          }
                        >
                          {teamOptions.map((team) => (
                            <option key={team.id || "solo"} value={team.id}>
                              {team.label}
                            </option>
                          ))}
                        </select>
                        <small>{definition?.maxHp ?? 0} HP</small>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            removeContestant(contestant.id);
                          }}
                          title="移除"
                        >
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
                      </div>
                      <div className="contestant-instance-controls">
                        <label>
                          X
                          <input
                            type="number"
                            min={0}
                            max={activeBoard?.width ?? 1600}
                            value={Math.round(contestant.position.x)}
                            onChange={(event) => {
                              const x = Math.max(
                                0,
                                Math.min(
                                  activeBoard?.width ?? 1600,
                                  Number(event.target.value),
                                ),
                              );
                              updateSetup({
                                ...manifest.setup,
                                contestants: manifest.setup.contestants.map((candidate) =>
                                  candidate.id === contestant.id
                                    ? {
                                        ...candidate,
                                        position: { ...candidate.position, x },
                                      }
                                    : candidate,
                                ),
                              });
                            }}
                          />
                        </label>
                        <label>
                          Y
                          <input
                            type="number"
                            min={0}
                            max={activeBoard?.height ?? 900}
                            value={Math.round(contestant.position.y)}
                            onChange={(event) => {
                              const y = Math.max(
                                0,
                                Math.min(
                                  activeBoard?.height ?? 900,
                                  Number(event.target.value),
                                ),
                              );
                              updateSetup({
                                ...manifest.setup,
                                contestants: manifest.setup.contestants.map((candidate) =>
                                  candidate.id === contestant.id
                                    ? {
                                        ...candidate,
                                        position: { ...candidate.position, y },
                                      }
                                    : candidate,
                                ),
                              });
                            }}
                          />
                        </label>
                        <label>
                          朝向°
                          <input
                            type="number"
                            min={0}
                            max={359}
                            value={Math.round(
                              ((Math.atan2(contestant.direction.y, contestant.direction.x) *
                                180) /
                                Math.PI +
                                360) %
                                360,
                            )}
                            onChange={(event) => {
                              const radians = (Number(event.target.value) * Math.PI) / 180;
                              updateSetup({
                                ...manifest.setup,
                                contestants: manifest.setup.contestants.map((candidate) =>
                                  candidate.id === contestant.id
                                    ? {
                                        ...candidate,
                                        direction: {
                                          x: Math.cos(radians),
                                          y: Math.sin(radians),
                                        },
                                      }
                                    : candidate,
                                ),
                              });
                            }}
                          />
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
              onUpdateProp={updateCurrentBoardProp}
              onRemoveProp={removeCurrentBoardProp}
              onClearProps={clearCurrentBoardProps}
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

          {teamMenu && teamMenuContestant && (
            <div
              ref={teamMenuRef}
              className="contestant-team-menu"
              role="menu"
              aria-label={`为${teamMenuContestant.displayName}选择队伍`}
              style={{ left: teamMenu.x, top: teamMenu.y }}
              onContextMenu={(event) => event.preventDefault()}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setTeamMenu(undefined);
                  return;
                }
                if (
                  event.key !== "ArrowDown" &&
                  event.key !== "ArrowUp" &&
                  event.key !== "Home" &&
                  event.key !== "End"
                ) {
                  return;
                }
                event.preventDefault();
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitemradio"]',
                  ),
                );
                if (!items.length) return;
                const currentIndex = Math.max(
                  0,
                  items.indexOf(document.activeElement as HTMLButtonElement),
                );
                const nextIndex =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : event.key === "ArrowDown"
                        ? (currentIndex + 1) % items.length
                        : (currentIndex - 1 + items.length) % items.length;
                items[nextIndex]?.focus();
              }}
            >
              <div className="contestant-team-menu-heading">
                <span>设置队伍</span>
                <strong>{teamMenuContestant.displayName}</strong>
              </div>
              {teamOptions.map((team) => {
                const selectedTeam = (teamMenuContestant.teamId ?? "") === team.id;
                return (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selectedTeam}
                    className={selectedTeam ? "is-selected" : ""}
                    key={team.id || "solo"}
                    onClick={() => {
                      assignContestantTeam(
                        teamMenuContestant.id,
                        team.id || undefined,
                      );
                      setTeamMenu(undefined);
                    }}
                  >
                    <span
                      className="contestant-team-menu-color"
                      style={{
                        backgroundColor: team.color || "rgba(255,255,255,.28)",
                      }}
                    />
                    <span>{team.label}</span>
                    {selectedTeam && <Check size={15} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {view === "characters" && (
        <Suspense fallback={<div className="editor-loading">正在加载角色工作台…</div>}>
          <CharacterEditor
            manifest={manifest}
            selectedId={selectedCharacterId}
            onSelect={setSelectedCharacterId}
            onChange={setManifest}
            onNotice={showNotice}
          />
        </Suspense>
      )}

      {view === "boards" && (
        <Suspense fallback={<div className="editor-loading">正在加载棋盘工作台…</div>}>
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
            onDelete={deleteBoard}
            onNotice={showNotice}
          />
        </Suspense>
      )}

      {notice && <div className="toast"><Settings2 size={16} /> {notice}</div>}
    </main>
  );
}
