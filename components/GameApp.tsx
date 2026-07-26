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
  Flame,
  Gamepad2,
  Gauge,
  ImagePlus,
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
import { CharacterEditor } from "./CharacterEditor";
import { FormationEditor } from "./FormationEditor";
import { createDefaultManifest } from "@/lib/game/defaultContent";
import {
  exportBundle,
  exportJson,
  importProjectFile,
  loadManifest,
  saveManifest,
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

const spawnPoints = [
  { x: 170, y: 150 },
  { x: 1430, y: 150 },
  { x: 180, y: 750 },
  { x: 1420, y: 750 },
  { x: 800, y: 110 },
  { x: 800, y: 790 },
  { x: 120, y: 450 },
  { x: 1480, y: 450 },
];

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
  const [selectedCharacterId, setSelectedCharacterId] = useState("panda");
  const [selectedBoardId, setSelectedBoardId] = useState("bamboo-lava-arena");
  const [pendingAutoStart, setPendingAutoStart] = useState(false);
  const arenaRef = useRef<ArenaHandle>(null);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void loadManifest()
      .then((saved) => {
        if (!alive || !saved) return;
        setManifest(saved);
        setBattleManifest(structuredClone(saved));
        setSelectedCharacterId(saved.characters[0]?.id ?? "panda");
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

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      if (event.code === "Space" && view === "battle") {
        event.preventDefault();
        arenaRef.current?.togglePause();
      }
      if (event.key === "." && view === "battle") arenaRef.current?.step();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [view]);

  const showNotice = useCallback((message: string) => setNotice(message), []);

  const livingMain = useMemo(
    () => snapshot?.units.filter((unit) => unit.main && unit.targetable).length ?? manifest.setup.contestants.length,
    [manifest.setup.contestants.length, snapshot],
  );

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

  const onArenaReady = () => {
    arenaRef.current?.setSpeed(speed);
    arenaRef.current?.setMuted(muted);
    arenaRef.current?.setVolume(volume);
    if (pendingAutoStart) {
      arenaRef.current?.start();
      setPendingAutoStart(false);
    }
  };

  const updateSetup = (setup: MatchSetup) => {
    const next = structuredClone(manifest);
    next.setup = setup;
    next.updatedAt = new Date().toISOString();
    setManifest(next);
  };

  const addContestant = (definitionId: string) => {
    const definition = manifest.characters.find((character) => character.id === definitionId);
    if (!definition || definition.role !== "contestant") return;
    const index = manifest.setup.contestants.length;
    const point = spawnPoints[index % spawnPoints.length];
    const angle = (index * 2.3999632297 + 0.65) % (Math.PI * 2);
    const contestant: MatchContestant = {
      id: `fighter-${Date.now()}-${index}`,
      definitionId,
      displayName: `${definition.name}·${index + 1}`,
      position: { ...point },
      direction: { x: Math.cos(angle), y: Math.sin(angle) },
      color: colorPalette[index % colorPalette.length],
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

  const randomizeFormation = () => {
    updateSetup({
      ...manifest.setup,
      contestants: manifest.setup.contestants.map((contestant, index) => {
        const point = spawnPoints[index % spawnPoints.length];
        const angle = Math.random() * Math.PI * 2;
        return {
          ...contestant,
          position: {
            x: Math.max(90, Math.min(1510, point.x + (Math.random() - 0.5) * 80)),
            y: Math.max(90, Math.min(810, point.y + (Math.random() - 0.5) * 80)),
          },
          direction: { x: Math.cos(angle), y: Math.sin(angle) },
        };
      }),
    });
    setNotice("出生位置与方向已重新打乱");
  };

  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      const imported = await importProjectFile(file);
      setManifest(imported);
      setBattleManifest(structuredClone(imported));
      setSelectedCharacterId(imported.characters[0]?.id ?? "panda");
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
    <main className="app-shell">
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
          <section className="arena-panel">
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

            <div className="arena-stage">
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
              {snapshot?.status === "finished" && (
                <div className="winner-overlay">
                  <span className="winner-kicker">{snapshot.draw ? "DOUBLE K.O." : "ARENA CHAMPION"}</span>
                  <h2>{snapshot.draw ? "本局平局" : snapshot.winnerName}</h2>
                  <p>{snapshot.draw ? "所有主角色同时倒下" : "坚持到最后，成为唯一幸存者"}</p>
                  <button type="button" onClick={() => beginFreshBattle(true)}>
                    <RefreshCcw size={17} /> 换个种子再来一局
                  </button>
                </div>
              )}
            </div>

            <div className="battle-control-bar">
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
              <button type="button" className="icon-control" onClick={() => beginFreshBattle(false)} title="同种子重开">
                <RefreshCcw size={17} />
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
              <span className="seed-label">SEED {battleManifest.setup.seed}</span>
            </div>
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
                onChange={updateSetup}
              />
              <div className="contestant-list">
                {manifest.setup.contestants.map((contestant, index) => {
                  const definition = manifest.characters.find(
                    (character) => character.id === contestant.definitionId,
                  );
                  return (
                    <div className="contestant-row" key={contestant.id}>
                      <span className="contestant-index" style={{ borderColor: contestant.color }}>
                        {index + 1}
                      </span>
                      <span className="contestant-type">
                        {definition?.id === "panda" ? "🐼" : definition?.id === "mole" ? "🦫" : "🐾"}
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
                      <small>{definition?.maxHp ?? 0} HP</small>
                      <button type="button" onClick={() => removeContestant(contestant.id)} title="移除">
                        <X size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="add-fighter-grid">
                {manifest.characters
                  .filter((character) => character.role === "contestant")
                  .slice(0, 6)
                  .map((character) => (
                    <button type="button" key={character.id} onClick={() => addContestant(character.id)}>
                      <Plus size={14} /> {character.name}
                    </button>
                  ))}
              </div>
            </section>

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
            setSelectedBoardId(id);
            const next = structuredClone(manifest);
            next.setup.boardId = id;
            next.updatedAt = new Date().toISOString();
            setManifest(next);
          }}
          onChange={setManifest}
          onNotice={showNotice}
        />
      )}

      {notice && <div className="toast"><Settings2 size={16} /> {notice}</div>}
    </main>
  );
}
