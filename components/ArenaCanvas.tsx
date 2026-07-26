"use client";

import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
} from "react";
import type PhaserType from "phaser";
import { ArenaAudio } from "@/lib/game/audio";
import { BattleSimulation, circleOverlapsRegion } from "@/lib/game/simulation";
import type {
  AnimationClip,
  AssetRef,
  BackgroundMusicConfig,
  BattleSnapshot,
  BoardProp,
  CombatEvent,
  MatchSetup,
  ProjectManifest,
  RegionShape,
  RuntimeUnit,
} from "@/lib/game/types";

export type ArenaHandle = {
  start: () => void;
  pause: () => void;
  resume: () => void;
  togglePause: () => void;
  step: () => void;
  setSpeed: (speed: number) => void;
  setMuted: (muted: boolean) => void;
  setVolume: (volume: number) => void;
  setAnnouncementsEnabled: (enabled: boolean) => void;
  setAnnouncementVolume: (volume: number) => void;
  setMusic: (config: BackgroundMusicConfig, assets: AssetRef[]) => void;
  setMusicVolume: (volume: number) => void;
  syncReadySetup: (setup: ProjectManifest["setup"]) => boolean;
  getSnapshot: () => BattleSnapshot | undefined;
};

type ArenaCanvasProps = {
  manifest: ProjectManifest;
  muted: boolean;
  volume: number;
  onSnapshot: (snapshot: BattleSnapshot) => void;
  onReady?: () => void;
};

type PhaserModule = typeof PhaserType;
type ShapeBounds = { x: number; y: number; width: number; height: number };

const clipDurationCache = new WeakMap<AnimationClip, number>();
const shapeCenterCache = new WeakMap<object, { x: number; y: number }>();
const shapeBoundsCache = new WeakMap<object, ShapeBounds>();

const indexContestants = (setup: MatchSetup) => {
  const index = new Map<string, MatchSetup["contestants"][number]>();
  for (const contestant of setup.contestants) {
    index.set(contestant.id, contestant);
    index.set(contestant.teamId ? `team:${contestant.teamId}` : contestant.id, contestant);
  }
  return index;
};

const collectBattleImageAssets = (
  manifest: ProjectManifest,
  setup: MatchSetup,
): AssetRef[] => {
  const definitionIds = new Set(setup.contestants.map((contestant) => contestant.definitionId));
  const definitions = new Map(
    manifest.characters.map((definition) => [definition.id, definition]),
  );
  for (const definitionId of [...definitionIds]) {
    const definition = definitions.get(definitionId);
    if (!definition) continue;
    const linkedDefinitionIds = definition.abilities.flatMap((ability) =>
      ability.actions.flatMap((action) =>
        action.kind === "spawnUnit" ? [action.definitionId] : [],
      ),
    );
    if (definition.pluginId === "panda") linkedDefinitionIds.push("police-1");
    for (const linkedId of linkedDefinitionIds) {
      definitionIds.add(linkedId);
    }
  }

  const assetIds = new Set<string>(["bamboo", "hole", "rocket", "explosion"]);
  const board = manifest.boards.find((candidate) => candidate.id === setup.boardId);
  if (board?.backgroundAssetId) assetIds.add(board.backgroundAssetId);
  for (const definitionId of definitionIds) {
    const definition = definitions.get(definitionId);
    if (!definition) continue;
    assetIds.add(definition.portraitAssetId);
    for (const clip of Object.values(definition.animations)) {
      for (const frame of clip.frames) assetIds.add(frame.assetId);
    }
  }
  return manifest.assets.filter(
    (asset) => asset.kind === "image" && assetIds.has(asset.id),
  );
};

const collectDefinitionImageAssets = (
  manifest: ProjectManifest,
  definitionIds: Iterable<string>,
): AssetRef[] => {
  const wantedAssetIds = new Set<string>();
  const definitions = new Map(
    manifest.characters.map((definition) => [definition.id, definition]),
  );
  for (const definitionId of definitionIds) {
    const definition = definitions.get(definitionId);
    if (!definition) continue;
    wantedAssetIds.add(definition.portraitAssetId);
    for (const clip of Object.values(definition.animations)) {
      for (const frame of clip.frames) wantedAssetIds.add(frame.assetId);
    }
  }
  return manifest.assets.filter(
    (asset) => asset.kind === "image" && wantedAssetIds.has(asset.id),
  );
};

const fallbackGlyph = (definitionId: string): string => {
  if (definitionId.startsWith("panda")) return "🐼";
  if (definitionId === "mole") return "🦫";
  if (definitionId.startsWith("police-")) return "👮";
  return "🐾";
};

const frameForClip = (
  clip: AnimationClip | undefined,
  elapsedMs: number,
): string | undefined => {
  if (!clip?.frames.length) return undefined;
  let duration = clipDurationCache.get(clip);
  if (duration === undefined) {
    duration = clip.frames.reduce((total, frame) => total + frame.durationMs, 0);
    clipDurationCache.set(clip, duration);
  }
  const position = clip.loop ? elapsedMs % duration : Math.min(elapsedMs, duration - 1);
  let cursor = 0;
  for (const frame of clip.frames) {
    cursor += frame.durationMs;
    if (position < cursor) return frame.assetId;
  }
  return clip.frames.at(-1)?.assetId;
};

const actionClipName = (
  unit: RuntimeUnit,
  callingForHelp = false,
): string => {
  if (callingForHelp) return "callPolice";
  if (unit.action === "tunneling") return "tunnelAttack";
  if (unit.action === "victory") return "victory";
  if (unit.action === "eating") return "eat";
  if (unit.action === "satisfied") return "eatComplete";
  if (unit.action === "digging" || unit.action === "kick") {
    return "skill";
  }
  if (unit.action === "attack" || unit.action === "kill") return "attack";
  return "move";
};

export const ArenaCanvas = forwardRef<ArenaHandle, ArenaCanvasProps>(
  function ArenaCanvas({ manifest, muted, volume, onSnapshot, onReady }, ref) {
    const containerId = `arena-${useId().replace(/:/g, "")}`;
    const simulationRef = useRef<BattleSimulation | undefined>(undefined);
    const loadSetupAssetsRef = useRef<((setup: MatchSetup) => void) | undefined>(undefined);
    const speedRef = useRef(1);
    const snapshotRef = useRef<BattleSnapshot | undefined>(undefined);
    const audioRef = useRef(new ArenaAudio());
    const mutedRef = useRef(muted);
    const volumeRef = useRef(volume);
    const musicConfigRef = useRef(manifest.backgroundMusic);
    const musicAssetsRef = useRef(manifest.assets);
    const contestantIndexRef = useRef(indexContestants(manifest.setup));
    const onSnapshotRef = useRef(onSnapshot);
    const onReadyRef = useRef(onReady);

    mutedRef.current = muted;
    volumeRef.current = volume;
    musicConfigRef.current = manifest.backgroundMusic;
    musicAssetsRef.current = manifest.assets;
    onSnapshotRef.current = onSnapshot;
    onReadyRef.current = onReady;

    useImperativeHandle(
      ref,
      () => ({
        start: () => {
          void audioRef.current.startMusic(musicConfigRef.current, musicAssetsRef.current);
          simulationRef.current?.start();
        },
        pause: () => simulationRef.current?.pause(),
        resume: () => simulationRef.current?.resume(),
        togglePause: () => {
          const snapshot = simulationRef.current?.getSnapshot();
          if (!snapshot) return;
          if (snapshot.status === "running") simulationRef.current?.pause();
          else if (snapshot.status === "paused") simulationRef.current?.resume();
        },
        step: () => {
          simulationRef.current?.step(1 / 60, true);
          if (simulationRef.current) {
            const snapshot = simulationRef.current.getSnapshot();
            snapshotRef.current = snapshot;
            onSnapshotRef.current(snapshot);
          }
        },
        setSpeed: (speed: number) => {
          speedRef.current = speed;
        },
        setMuted: (nextMuted: boolean) => {
          mutedRef.current = nextMuted;
          audioRef.current.setMuted(nextMuted);
        },
        setVolume: (nextVolume: number) => {
          volumeRef.current = nextVolume;
          audioRef.current.setVolume(nextVolume);
        },
        setAnnouncementsEnabled: (enabled: boolean) => {
          audioRef.current.setAnnouncementsEnabled(enabled);
        },
        setAnnouncementVolume: (nextVolume: number) => {
          audioRef.current.setAnnouncementVolume(nextVolume);
        },
        setMusic: (config: BackgroundMusicConfig, assets: AssetRef[]) => {
          void audioRef.current.setMusic(config, assets);
        },
        setMusicVolume: (nextVolume: number) => {
          audioRef.current.setMusicVolume(nextVolume);
        },
        syncReadySetup: (setup: ProjectManifest["setup"]) => {
          const simulation = simulationRef.current;
          if (!simulation?.syncReadySetup(setup)) return false;
          contestantIndexRef.current = indexContestants(setup);
          loadSetupAssetsRef.current?.(setup);
          const nextSnapshot = simulation.getSnapshot();
          snapshotRef.current = nextSnapshot;
          onSnapshotRef.current(nextSnapshot);
          return true;
        },
        getSnapshot: () => snapshotRef.current,
      }),
      [],
    );

    useEffect(() => {
      let disposed = false;
      let game: PhaserType.Game | undefined;
      const audio = audioRef.current;
      const simulation = new BattleSimulation(manifest);
      const board =
        manifest.boards.find((candidate) => candidate.id === manifest.setup.boardId) ??
        manifest.boards[0];
      const characterById = new Map(
        manifest.characters.map((definition) => [definition.id, definition]),
      );
      const assetById = new Map(manifest.assets.map((asset) => [asset.id, asset]));
      const queuedTextureIds = new Set<string>();
      simulationRef.current = simulation;
      audio.setMuted(mutedRef.current);
      audio.setVolume(volumeRef.current);
      void audio.setMusic(manifest.backgroundMusic, manifest.assets);
      let lastSnapshotPushMs = 0;
      let lastPushedStatus: BattleSnapshot["status"] | undefined;
      let previousEventIds = new Set<string>();

      const boot = async () => {
        const phaserModule = (await import("phaser")) as unknown as {
          default?: PhaserModule;
        } & PhaserModule;
        const Phaser = (phaserModule.default ?? phaserModule) as PhaserModule;
        if (disposed) return;

        class ArenaScene extends Phaser.Scene {
          private propGraphics!: PhaserType.GameObjects.Graphics;
          private arenaGraphics!: PhaserType.GameObjects.Graphics;
          private overlayGraphics!: PhaserType.GameObjects.Graphics;
          private unitImages = new Map<string, PhaserType.GameObjects.Image>();
          private projectileImages = new Map<string, PhaserType.GameObjects.Image>();
          private holeImages = new Map<string, PhaserType.GameObjects.Image>();
          private effectImages = new Map<string, PhaserType.GameObjects.Image>();
          private unitFallbacks = new Map<string, PhaserType.GameObjects.Text>();
          private unitLabels = new Map<string, PhaserType.GameObjects.Text>();
          private healthLabels = new Map<string, PhaserType.GameObjects.Text>();
          private buffLabels = new Map<string, PhaserType.GameObjects.Text>();
          private promotionLabels = new Map<string, PhaserType.GameObjects.Text>();
          private callLabels = new Map<string, PhaserType.GameObjects.Text>();
          private holeLabels = new Map<string, PhaserType.GameObjects.Text>();
          private eventLabels = new Map<string, PhaserType.GameObjects.Text>();
          private announcementLabels = new Map<string, PhaserType.GameObjects.Text>();
          private announcementDetailLabels = new Map<string, PhaserType.GameObjects.Text>();
          private announcementImages = new Map<string, PhaserType.GameObjects.Image>();
          private accumulatedMs = 0;
          private finishedVisualTime = 0;
          private failedTextures = new Set<string>();
          private seenRuntimeDefinitionIds = new Set<string>();
          private propSignature = "";

          constructor() {
            super("arena");
          }

          preload() {
            this.load.on(
              "loaderror",
              (file: { key?: string }) => file.key && this.failedTextures.add(file.key),
            );
            this.queueImageAssets(manifest.setup);
          }

          create() {
            const backgroundKey = `asset:${board?.backgroundAssetId ?? ""}`;
            if (this.textures.exists(backgroundKey) && !this.failedTextures.has(backgroundKey)) {
              const image = this.add.image((board?.width ?? 1600) / 2, (board?.height ?? 900) / 2, backgroundKey);
              image.setDisplaySize(board?.width ?? 1600, board?.height ?? 900);
              image.setDepth(-20);
            } else {
              const background = this.add.graphics();
              background.fillGradientStyle(0x183c2f, 0x244f37, 0x4b2920, 0x241d1d, 1);
              background.fillRect(0, 0, board?.width ?? 1600, board?.height ?? 900);
              background.setDepth(-20);
            }
            this.propGraphics = this.add.graphics().setDepth(-10);
            this.arenaGraphics = this.add.graphics().setDepth(-9);
            this.overlayGraphics = this.add.graphics().setDepth(20);
            loadSetupAssetsRef.current = (setup) => this.loadSetupAssets(setup);
            const initial = simulation.getSnapshot();
            snapshotRef.current = initial;
            lastPushedStatus = initial.status;
            onSnapshotRef.current(initial);
            onReadyRef.current?.();
          }

          update(time: number, delta: number) {
            const fixedMs = 1000 / 60;
            const maxCatchUpSteps = 12;
            this.accumulatedMs = Math.min(
              this.accumulatedMs + delta * speedRef.current,
              fixedMs * maxCatchUpSteps,
            );
            let safety = 0;
            while (this.accumulatedMs >= fixedMs && safety < maxCatchUpSteps) {
              simulation.step(1 / 60);
              this.accumulatedMs -= fixedMs;
              safety += 1;
            }
            const snapshot = simulation.getSnapshot();
            snapshotRef.current = snapshot;
            if (snapshot.status === "finished") {
              this.finishedVisualTime += delta / 1000;
            } else {
              this.finishedVisualTime = 0;
            }
            this.renderArena(snapshot, this.finishedVisualTime);

            const statusChanged = snapshot.status !== lastPushedStatus;
            const liveRefreshDue =
              snapshot.status === "running" && time - lastSnapshotPushMs >= 100;
            if (statusChanged || liveRefreshDue) {
              lastSnapshotPushMs = time;
              lastPushedStatus = snapshot.status;
              onSnapshotRef.current(snapshot);
              const freshEvents = snapshot.events.filter((event) => !previousEventIds.has(event.id));
              previousEventIds = new Set(snapshot.events.map((event) => event.id));
              if (freshEvents.length) {
                const unitById = new Map(snapshot.units.map((unit) => [unit.id, unit]));
                for (const event of freshEvents) {
                  void audio.playEvent(
                    event,
                    unitById,
                    characterById,
                    assetById,
                  );
                }
              }
            }
          }

          private queueAssets(assets: AssetRef[]): number {
            let queued = 0;
            for (const asset of assets) {
              const textureKey = `asset:${asset.id}`;
              if (
                queuedTextureIds.has(asset.id) ||
                this.textures.exists(textureKey) ||
                this.failedTextures.has(textureKey)
              ) {
                continue;
              }
              queuedTextureIds.add(asset.id);
              this.load.image(textureKey, asset.url);
              queued += 1;
            }
            return queued;
          }

          private queueImageAssets(setup: MatchSetup): number {
            return this.queueAssets(collectBattleImageAssets(manifest, setup));
          }

          private loadSetupAssets(setup: MatchSetup): void {
            if (this.queueImageAssets(setup) > 0) this.load.start();
          }

          private loadRuntimeUnitAssets(units: RuntimeUnit[]): void {
            const newDefinitionIds = new Set<string>();
            for (const unit of units) {
              for (const definitionId of [
                unit.definitionId,
                unit.appearanceDefinitionId,
              ]) {
                if (this.seenRuntimeDefinitionIds.has(definitionId)) continue;
                this.seenRuntimeDefinitionIds.add(definitionId);
                newDefinitionIds.add(definitionId);
              }
            }
            if (
              newDefinitionIds.size > 0 &&
              this.queueAssets(
                collectDefinitionImageAssets(manifest, newDefinitionIds),
              ) > 0
            ) {
              this.load.start();
            }
          }

          private renderArena(snapshot: BattleSnapshot, finishedVisualTime: number) {
            this.loadRuntimeUnitAssets(snapshot.units);
            this.arenaGraphics.clear();
            this.overlayGraphics.clear();
            this.drawProps(snapshot.props, snapshot.time + finishedVisualTime);
            this.drawHoles(snapshot);
            this.drawProjectiles(snapshot);
            this.drawAnnouncementBanner(snapshot, finishedVisualTime);
            this.drawEventEffects(snapshot, finishedVisualTime);

            const activeIds = new Set(snapshot.units.map((unit) => unit.id));
            const activePropIds = new Set(
              snapshot.props.filter((prop) => prop.active).map((prop) => `prop:${prop.id}`),
            );
            for (const [id, image] of this.unitImages) {
              if (id.startsWith("prop:")) {
                if (!activePropIds.has(id)) {
                  image.destroy();
                  this.unitImages.delete(id);
                }
                continue;
              }
              if (!activeIds.has(id)) {
                image.destroy();
                this.unitImages.delete(id);
              }
            }
            for (const [id, fallback] of this.unitFallbacks) {
              if (!activeIds.has(id)) {
                fallback.destroy();
                this.unitFallbacks.delete(id);
              }
            }
            const activeProjectileIds = new Set(
              snapshot.projectiles
                .filter((projectile) => projectile.kind === "rocket")
                .map((projectile) => projectile.id),
            );
            for (const [id, image] of this.projectileImages) {
              if (!activeProjectileIds.has(id)) {
                image.destroy();
                this.projectileImages.delete(id);
              }
            }
            const activeHoleIds = new Set(snapshot.holes.map((hole) => hole.id));
            for (const [id, image] of this.holeImages) {
              if (!activeHoleIds.has(id)) {
                image.destroy();
                this.holeImages.delete(id);
              }
            }
            for (const [id, label] of this.unitLabels) {
              if (!activeIds.has(id)) {
                label.destroy();
                this.unitLabels.delete(id);
              }
            }
            for (const [id, label] of this.healthLabels) {
              if (!activeIds.has(id)) {
                label.destroy();
                this.healthLabels.delete(id);
              }
            }
            for (const [id, label] of this.buffLabels) {
              if (!activeIds.has(id)) {
                label.destroy();
                this.buffLabels.delete(id);
              }
            }
            for (const [id, label] of this.promotionLabels) {
              if (!activeIds.has(id)) {
                label.destroy();
                this.promotionLabels.delete(id);
              }
            }
            for (const [id, label] of this.callLabels) {
              if (!activeIds.has(id)) {
                label.destroy();
                this.callLabels.delete(id);
              }
            }
            for (const [id, label] of this.holeLabels) {
              if (!activeHoleIds.has(id)) {
                label.destroy();
                this.holeLabels.delete(id);
              }
            }
            const visibleEventIds = new Set(
              snapshot.events
                .filter(
                  (event) =>
                    snapshot.time + finishedVisualTime - event.time <= 0.9 &&
                    event.amount !== undefined,
                )
                .map((event) => event.id),
            );
            for (const [id, label] of this.eventLabels) {
              if (!visibleEventIds.has(id)) {
                label.destroy();
                this.eventLabels.delete(id);
              }
            }
            const visibleExplosionIds = new Set(
              snapshot.events
                .filter(
                  (event) =>
                    event.sound === "explosion" &&
                    snapshot.time + finishedVisualTime - event.time <= 0.85,
                )
                .map((event) => event.id),
            );
            for (const [id, image] of this.effectImages) {
              if (!visibleExplosionIds.has(id)) {
                image.destroy();
                this.effectImages.delete(id);
              }
            }

            for (const unit of snapshot.units) {
              this.drawUnit(unit, snapshot.time + finishedVisualTime);
            }
          }

          private drawProps(props: BoardProp[], time: number) {
            const nextSignature = props
              .map((prop) => `${prop.id}:${prop.active ? 1 : 0}`)
              .join("|");
            const shouldRedrawShapes = nextSignature !== this.propSignature;
            if (shouldRedrawShapes) {
              this.propSignature = nextSignature;
              this.propGraphics.clear();
            }
            for (const prop of props) {
              if (!prop.active) continue;
              if (prop.type === "lava") {
                if (shouldRedrawShapes) {
                  this.drawShape(this.propGraphics, prop.shape, 0xff5a35, 0.34, 0xffc04a);
                }
                this.drawAreaTexture(prop, time);
              } else if (prop.type === "hotSpring") {
                if (shouldRedrawShapes) {
                  this.drawShape(this.propGraphics, prop.shape, 0x43cbd3, 0.32, 0xa5fbff);
                }
                this.drawAreaTexture(prop, time);
              } else {
                const center = this.shapeCenter(prop.shape);
                const key = "asset:bamboo";
                if (this.textures.exists(key) && !this.failedTextures.has(key)) {
                  const markerKey = `prop:${prop.id}`;
                  let image = this.unitImages.get(markerKey);
                  if (!image) {
                    image = this.add.image(center.x, center.y, key).setDepth(-5);
                    this.unitImages.set(markerKey, image);
                  }
                  const scale = board?.unitScale ?? 1;
                  image
                    .setPosition(center.x, center.y)
                    .setDisplaySize(78 * scale, 96 * scale)
                    .setAlpha(0.94);
                } else {
                  this.arenaGraphics.fillStyle(0x79cf71, 1);
                  this.arenaGraphics.fillRoundedRect(center.x - 11, center.y - 36, 22, 72, 7);
                }
              }
            }
          }

          private drawAreaTexture(prop: BoardProp, time: number) {
            const bounds = this.shapeBounds(prop.shape);
            const seed = [...prop.id].reduce(
              (total, character) => (total * 31 + character.charCodeAt(0)) >>> 0,
              2166136261,
            );
            const count = Math.max(5, Math.min(18, Math.round((bounds.width + bounds.height) / 95)));
            for (let index = 0; index < count; index += 1) {
              const xRatio = ((seed * (index + 3) * 0.000013 + index * 0.618033) % 1 + 1) % 1;
              const yRatio = ((seed * (index + 7) * 0.000019 + index * 0.381966) % 1 + 1) % 1;
              const x = bounds.x + bounds.width * (0.08 + xRatio * 0.84);
              const y = bounds.y + bounds.height * (0.08 + yRatio * 0.84);
              if (!circleOverlapsRegion({ x, y }, 0, prop.shape)) continue;
              const phase = (time * (prop.type === "lava" ? 1.65 : 0.86) + index * 0.37) % 1;
              if (prop.type === "lava") {
                const radius = 3 + phase * 8;
                this.arenaGraphics.fillStyle(index % 2 ? 0xffc247 : 0xff742f, 0.48 * (1 - phase));
                this.arenaGraphics.fillCircle(x, y - phase * 12, radius);
                this.arenaGraphics.lineStyle(2, 0xffef8c, 0.24 * (1 - phase));
                this.arenaGraphics.strokeCircle(x, y - phase * 12, radius + 3);
              } else {
                const radius = 5 + phase * 16;
                this.arenaGraphics.lineStyle(2, 0xd8ffff, 0.36 * (1 - phase));
                this.arenaGraphics.strokeEllipse(x, y, radius * 2, radius * 0.72);
                if (index % 3 === 0) {
                  this.arenaGraphics.fillStyle(0xeaffff, 0.28 * (1 - phase));
                  this.arenaGraphics.fillCircle(x + 5, y - phase * 16, 3 + phase * 2);
                }
              }
            }
          }

          private drawShape(
            graphics: PhaserType.GameObjects.Graphics,
            shape: RegionShape,
            fill: number,
            alpha: number,
            line: number,
          ) {
            graphics.fillStyle(fill, alpha);
            graphics.lineStyle(3, line, 0.42);
            if (shape.kind === "circle") {
              graphics.fillCircle(shape.x, shape.y, shape.radius);
              graphics.strokeCircle(shape.x, shape.y, shape.radius);
            } else if (shape.kind === "rectangle") {
              graphics.fillRoundedRect(shape.x, shape.y, shape.width, shape.height, 22);
              graphics.strokeRoundedRect(shape.x, shape.y, shape.width, shape.height, 22);
            } else {
              graphics.fillPoints(shape.points, true);
              graphics.strokePoints(shape.points, true, true);
            }
          }

          private shapeCenter(shape: RegionShape) {
            const cached = shapeCenterCache.get(shape);
            if (cached) return cached;
            let center: { x: number; y: number };
            if (shape.kind === "circle") {
              center = { x: shape.x, y: shape.y };
            } else if (shape.kind === "rectangle") {
              center = {
                x: shape.x + shape.width / 2,
                y: shape.y + shape.height / 2,
              };
            } else {
              center = shape.points.reduce(
                (nextCenter, point) => ({
                  x: nextCenter.x + point.x / shape.points.length,
                  y: nextCenter.y + point.y / shape.points.length,
                }),
                { x: 0, y: 0 },
              );
            }
            shapeCenterCache.set(shape, center);
            return center;
          }

          private shapeBounds(shape: RegionShape): ShapeBounds {
            const cached = shapeBoundsCache.get(shape);
            if (cached) return cached;
            let bounds: ShapeBounds;
            if (shape.kind === "circle") {
              bounds = {
                x: shape.x - shape.radius,
                y: shape.y - shape.radius,
                width: shape.radius * 2,
                height: shape.radius * 2,
              };
            } else if (shape.kind === "rectangle") {
              bounds = shape;
            } else if (!shape.points.length) {
              bounds = { x: 0, y: 0, width: 1, height: 1 };
            } else {
              let minX = shape.points[0].x;
              let maxX = minX;
              let minY = shape.points[0].y;
              let maxY = minY;
              for (let index = 1; index < shape.points.length; index += 1) {
                const point = shape.points[index];
                minX = Math.min(minX, point.x);
                maxX = Math.max(maxX, point.x);
                minY = Math.min(minY, point.y);
                maxY = Math.max(maxY, point.y);
              }
              bounds = {
                x: minX,
                y: minY,
                width: Math.max(1, maxX - minX),
                height: Math.max(1, maxY - minY),
              };
            }
            shapeBoundsCache.set(shape, bounds);
            return bounds;
          }

          private drawHoles(snapshot: BattleSnapshot) {
            for (const hole of snapshot.holes) {
              const holeKey = "asset:hole";
              if (this.textures.exists(holeKey) && !this.failedTextures.has(holeKey)) {
                let image = this.holeImages.get(hole.id);
                if (!image) {
                  image = this.add.image(hole.x, hole.y, holeKey).setDepth(-4);
                  this.holeImages.set(hole.id, image);
                }
                image
                  .setPosition(hole.x, hole.y)
                  .setDisplaySize(hole.radius * 1.2, hole.radius * 0.72)
                  .setAlpha(0.96);
              } else {
                this.arenaGraphics.fillStyle(0x17110e, 0.9);
                this.arenaGraphics.fillEllipse(
                  hole.x,
                  hole.y,
                  hole.radius * 1.18,
                  hole.radius * 0.66,
                );
              }
              let label = this.holeLabels.get(hole.id);
              if (!label) {
                label = this.add
                  .text(hole.x, hole.y, "", {
                    fontSize: "16px",
                    fontFamily: "Arial",
                    fontStyle: "bold",
                    color: "#fff0c4",
                    stroke: "#1a1412",
                    strokeThickness: 4,
                  })
                  .setOrigin(0.5)
                  .setDepth(19);
                this.holeLabels.set(hole.id, label);
              }
              const holeText = `${hole.stompsRemaining}/${hole.stompsRequired}`;
              if (label.text !== holeText) label.setText(holeText);
              label.setPosition(hole.x, hole.y + hole.radius * 0.42);
            }
          }

          private drawProjectiles(snapshot: BattleSnapshot) {
            for (const projectile of snapshot.projectiles) {
              if (projectile.kind === "rocket") {
                const rocketKey = "asset:rocket";
                if (this.textures.exists(rocketKey) && !this.failedTextures.has(rocketKey)) {
                  let image = this.projectileImages.get(projectile.id);
                  if (!image) {
                    image = this.add.image(projectile.x, projectile.y, rocketKey).setDepth(34);
                    this.projectileImages.set(projectile.id, image);
                  }
                  image
                    .setPosition(projectile.x, projectile.y)
                    .setDisplaySize(projectile.radius * 8.2, projectile.radius * 4.2)
                    .setRotation(Math.atan2(projectile.vy, projectile.vx));
                } else {
                  const angle = Math.atan2(projectile.vy, projectile.vx);
                  const noseX = projectile.x + Math.cos(angle) * 22;
                  const noseY = projectile.y + Math.sin(angle) * 22;
                  this.overlayGraphics.fillStyle(0xd93c32, 1);
                  this.overlayGraphics.fillTriangle(
                    noseX,
                    noseY,
                    projectile.x + Math.cos(angle + 2.15) * 17,
                    projectile.y + Math.sin(angle + 2.15) * 17,
                    projectile.x + Math.cos(angle - 2.15) * 17,
                    projectile.y + Math.sin(angle - 2.15) * 17,
                  );
                }
              } else {
                this.overlayGraphics.fillStyle(0xffe888, 1);
                this.overlayGraphics.fillCircle(projectile.x, projectile.y, 7);
                this.overlayGraphics.lineStyle(3, 0xffffff, 0.45);
                this.overlayGraphics.lineBetween(
                  projectile.x,
                  projectile.y,
                  projectile.x - projectile.vx / 65,
                  projectile.y - projectile.vy / 65,
                );
              }
            }
          }

          private drawEventEffects(snapshot: BattleSnapshot, finishedVisualTime: number) {
            for (const event of snapshot.events) {
              const age = snapshot.time + finishedVisualTime - event.time;
              const maxAge =
                event.type === "victory" && event.unitId
                  ? Number.POSITIVE_INFINITY
                  : event.type === "victory"
                    ? 2.8
                    : event.type === "merge"
                      ? 1.25
                      : 0.9;
              if (age < 0 || age > maxAge || event.x === undefined || event.y === undefined) continue;
              const progress = Math.min(1, age / 0.55);
              const color =
                event.sound === "explosion"
                  ? 0xff653f
                  : event.type === "heal"
                    ? 0x70e19a
                    : event.type === "merge"
                      ? 0xffdf70
                      : 0xffffff;
              if (
                age <= 0.55 &&
                event.type !== "attack" &&
                event.type !== "merge"
              ) {
                this.overlayGraphics.lineStyle(5 * (1 - progress), color, 0.8 * (1 - progress));
                this.overlayGraphics.strokeCircle(event.x, event.y, 18 + progress * 95);
              }
              if (event.sound === "explosion" && age <= 0.85) {
                const explosionKey = "asset:explosion";
                const explosionProgress = Math.min(1, age / 0.85);
                if (
                  this.textures.exists(explosionKey) &&
                  !this.failedTextures.has(explosionKey)
                ) {
                  let image = this.effectImages.get(event.id);
                  if (!image) {
                    image = this.add.image(event.x, event.y, explosionKey).setDepth(45);
                    this.effectImages.set(event.id, image);
                  }
                  image
                    .setPosition(event.x, event.y)
                    .setDisplaySize(
                      105 + explosionProgress * 165,
                      105 + explosionProgress * 165,
                    )
                    .setRotation(age * 0.7)
                    .setAlpha(Math.max(0, 1 - explosionProgress ** 1.6));
                }
                this.overlayGraphics.lineStyle(
                  10 * (1 - explosionProgress),
                  0xffe26f,
                  0.9 * (1 - explosionProgress),
                );
                this.overlayGraphics.strokeCircle(
                  event.x,
                  event.y,
                  30 + explosionProgress * 150,
                );
                for (let spark = 0; spark < 12; spark += 1) {
                  const angle = spark * (Math.PI * 2 / 12) + event.time;
                  const reach = 35 + explosionProgress * (90 + (spark % 3) * 28);
                  this.overlayGraphics.fillStyle(
                    spark % 2 ? 0xffd45c : 0xff6b38,
                    Math.max(0, 1 - explosionProgress),
                  );
                  this.overlayGraphics.fillCircle(
                    event.x + Math.cos(angle) * reach,
                    event.y + Math.sin(angle) * reach,
                    3 + (spark % 3),
                  );
                }
              }
              if (event.type === "death" && age <= 0.75) {
                const fade = Math.max(0, 1 - age / 0.75);
                this.overlayGraphics.lineStyle(6, 0xff5968, fade);
                const reach = 35 + age * 95;
                this.overlayGraphics.lineBetween(
                  event.x - reach,
                  event.y - reach,
                  event.x + reach,
                  event.y + reach,
                );
                this.overlayGraphics.lineBetween(
                  event.x + reach,
                  event.y - reach,
                  event.x - reach,
                  event.y + reach,
                );
              } else if (event.type === "victory") {
                const pulse = 0.5 + Math.sin(age * 7) * 0.5;
                this.overlayGraphics.lineStyle(5, 0xffdf70, 0.72 - pulse * 0.2);
                this.overlayGraphics.strokeCircle(event.x, event.y, 70 + pulse * 35);
                this.overlayGraphics.lineStyle(3, 0xffffff, 0.45);
                this.overlayGraphics.strokeCircle(event.x, event.y, 112 + (1 - pulse) * 42);
                for (let ray = 0; ray < 14; ray += 1) {
                  const angle = ray * (Math.PI * 2 / 14) - age * 0.8;
                  const radius = 125 + (ray % 3) * 18;
                  this.overlayGraphics.fillStyle(ray % 2 ? 0xffdf70 : 0x83e7ef, 0.75);
                  this.overlayGraphics.fillCircle(
                    event.x + Math.cos(angle) * radius,
                    event.y + Math.sin(angle) * radius,
                    4 + (ray % 3),
                  );
                }
              }
              if (event.amount !== undefined && Math.abs(event.amount) > 0.01) {
                let label = this.eventLabels.get(event.id);
                if (!label) {
                  label = this.add
                    .text(event.x, event.y, "", {
                      fontSize: "27px",
                      fontFamily: "Arial",
                      fontStyle: "bold",
                      color: event.amount > 0 ? "#7ef5ad" : "#ff7b72",
                      stroke: "#130f16",
                      strokeThickness: 6,
                    })
                    .setOrigin(0.5)
                    .setDepth(40);
                  this.eventLabels.set(event.id, label);
                }
                const displayAmount =
                  Math.abs(event.amount) >= 10
                    ? Math.round(Math.abs(event.amount)).toString()
                    : Math.abs(event.amount).toFixed(1).replace(/\.0$/, "");
                label
                  .setText(`${event.amount > 0 ? "+" : "-"}${displayAmount}`)
                  .setPosition(event.x, event.y - 28 - age * 70)
                  .setAlpha(Math.max(0, 1 - age / 0.9));
              }
            }
          }

          private drawAnnouncementBanner(
            snapshot: BattleSnapshot,
            finishedVisualTime: number,
          ) {
            const now = snapshot.time + finishedVisualTime;
            const durationFor = (type: CombatEvent["type"]) =>
              type === "victory" ? 4 : type === "death" ? 2.3 : 1.8;
            const event = snapshot.events
              .filter(
                (candidate) =>
                  candidate.announcement &&
                  now >= candidate.time &&
                  now - candidate.time <= durationFor(candidate.type),
              )
              .at(-1);
            const visibleIds = new Set(event ? [event.id] : []);
            for (const [id, label] of this.announcementLabels) {
              if (!visibleIds.has(id)) {
                label.destroy();
                this.announcementLabels.delete(id);
              }
            }
            for (const [id, label] of this.announcementDetailLabels) {
              if (!visibleIds.has(id)) {
                label.destroy();
                this.announcementDetailLabels.delete(id);
              }
            }
            for (const [key, image] of this.announcementImages) {
              const eventId = key.split(":")[0];
              if (!visibleIds.has(eventId)) {
                image.destroy();
                this.announcementImages.delete(key);
              }
            }
            if (!event?.announcement) return;

            const age = now - event.time;
            const duration = durationFor(event.type);
            const fadeIn = Math.min(1, age / 0.14);
            const fadeOut = Math.min(1, Math.max(0, (duration - age) / 0.42));
            const alpha = fadeIn * fadeOut;
            const centerX = board.width / 2;
            const centerY = Math.max(68, board.height * 0.082);
            const bannerWidth = Math.max(
              410,
              Math.min(760, board.width * (board.height > board.width ? 0.72 : 0.56)),
            );
            const bannerHeight = Math.max(82, Math.min(104, board.height * 0.115));
            const left = centerX - bannerWidth / 2;
            const right = centerX + bannerWidth / 2;
            const top = centerY - bannerHeight / 2;
            const isDeath = event.type === "death";
            const isVictory = event.type === "victory";
            const accent = isVictory ? 0xdfff68 : isDeath ? 0xff5b62 : 0xffd666;

            this.overlayGraphics.fillStyle(0x0d0c12, 0.92 * alpha);
            this.overlayGraphics.fillRoundedRect(
              left + 44,
              top,
              bannerWidth - 88,
              bannerHeight,
              14,
            );
            this.overlayGraphics.fillStyle(isVictory ? 0x455b25 : 0x601d2a, 0.76 * alpha);
            this.overlayGraphics.fillTriangle(
              left + 44,
              top + 8,
              left - 6,
              centerY,
              left + 44,
              top + bannerHeight - 8,
            );
            this.overlayGraphics.fillTriangle(
              right - 44,
              top + 8,
              right + 6,
              centerY,
              right - 44,
              top + bannerHeight - 8,
            );
            this.overlayGraphics.lineStyle(3, accent, 0.72 * alpha);
            this.overlayGraphics.strokeRoundedRect(
              left + 44,
              top,
              bannerWidth - 88,
              bannerHeight,
              14,
            );
            this.overlayGraphics.lineStyle(2, 0xffffff, 0.25 * alpha);
            this.overlayGraphics.lineBetween(left + 112, centerY, centerX - 110, centerY);
            this.overlayGraphics.lineBetween(centerX + 110, centerY, right - 112, centerY);

            const chain = event.announcement.match(/完成([^，。！]+)$/)?.[1];
            const headline = isVictory
              ? "获得胜利！"
              : isDeath
                ? `${chain ?? "击败"}！`
                : event.type === "merge"
                  ? "升星成功！"
                  : "战况播报";
            const attackerName = isDeath ? event.targetName : event.unitName;
            const victimName = isDeath ? event.unitName : undefined;
            const detail =
              isDeath && attackerName && victimName
                ? `${attackerName}  击败  ${victimName}`
                : isVictory
                  ? event.unitName ?? snapshot.winnerName ?? event.announcement
                  : event.announcement;
            const fontSize = Math.round(
              Math.max(20, Math.min(34, Math.min(board.width, board.height) * 0.038)),
            );
            let label = this.announcementLabels.get(event.id);
            if (!label) {
              label = this.add
                .text(centerX, centerY - 10, "", {
                  fontSize: `${fontSize}px`,
                  fontFamily: '"Microsoft YaHei", Arial, sans-serif',
                  fontStyle: "bold",
                  color: isVictory ? "#e8ff72" : "#fff1c7",
                  stroke: "#130f16",
                  strokeThickness: 6,
                  align: "center",
                })
                .setOrigin(0.5)
                .setDepth(64);
              this.announcementLabels.set(event.id, label);
            }
            label
              .setText(headline)
              .setPosition(centerX, centerY - 12)
              .setAlpha(alpha)
              .setScale(0.92 + fadeIn * 0.08);

            let detailLabel = this.announcementDetailLabels.get(event.id);
            if (!detailLabel) {
              detailLabel = this.add
                .text(centerX, centerY + 23, "", {
                  fontSize: `${Math.max(12, Math.round(fontSize * 0.48))}px`,
                  fontFamily: '"Microsoft YaHei", Arial, sans-serif',
                  fontStyle: "bold",
                  color: "#f4edf2",
                  stroke: "#130f16",
                  strokeThickness: 4,
                  align: "center",
                })
                .setOrigin(0.5)
                .setDepth(64);
              this.announcementDetailLabels.set(event.id, detailLabel);
            }
            detailLabel
              .setText(detail)
              .setPosition(centerX, centerY + 23)
              .setAlpha(alpha);

            const placePortrait = (
              slot: "attacker" | "victim",
              definitionId: string | undefined,
              x: number,
            ) => {
              if (!definitionId) return;
              const character = characterById.get(definitionId);
              const textureKey = character
                ? `asset:${character.portraitAssetId}`
                : undefined;
              if (
                !textureKey ||
                !this.textures.exists(textureKey) ||
                this.failedTextures.has(textureKey)
              ) {
                return;
              }
              const key = `${event.id}:${slot}`;
              let image = this.announcementImages.get(key);
              if (!image) {
                image = this.add.image(x, centerY, textureKey).setDepth(63);
                this.announcementImages.set(key, image);
              }
              const portraitSize = Math.min(68, bannerHeight * 0.72);
              this.overlayGraphics.fillStyle(0x15131c, 0.96 * alpha);
              this.overlayGraphics.fillCircle(x, centerY, portraitSize * 0.58);
              this.overlayGraphics.lineStyle(
                4,
                slot === "attacker" ? accent : 0xd8d6df,
                0.95 * alpha,
              );
              this.overlayGraphics.strokeCircle(x, centerY, portraitSize * 0.58);
              image
                .setTexture(textureKey)
                .setPosition(x, centerY + 2)
                .setDisplaySize(portraitSize, portraitSize)
                .setAlpha(alpha)
                .setScale((0.9 + fadeIn * 0.1) * image.scaleX);
            };

            if (isDeath) {
              placePortrait("attacker", event.targetDefinitionId, left + 78);
              placePortrait("victim", event.unitDefinitionId, right - 78);
            } else {
              placePortrait("attacker", event.unitDefinitionId, left + 78);
            }
          }

          private drawUnit(unit: RuntimeUnit, time: number) {
            const combatDefinition = characterById.get(unit.definitionId);
            if (!combatDefinition) return;
            const definition =
              characterById.get(unit.appearanceDefinitionId) ??
              combatDefinition;
            const callingForHelp =
              unit.action !== "dead" && time < unit.pandaCallUntil;
            const requestedClip = actionClipName(unit, callingForHelp);
            const clip =
              definition.animations[requestedClip] ??
              (unit.action === "eating" || unit.action === "satisfied"
                ? definition.animations.skill
                : undefined) ??
              definition.animations.idle;
            const clipStartedAt = callingForHelp
              ? unit.pandaCallStartedAt
              : unit.actionStartedAt;
            const frameId =
              frameForClip(clip, Math.max(0, (time - clipStartedAt) * 1000)) ??
              definition.portraitAssetId;
            const textureKey = `asset:${frameId}`;
            const hasTexture = this.textures.exists(textureKey) && !this.failedTextures.has(textureKey);
            let visualX = unit.x;
            let visualY = unit.y;
            if (unit.action === "tunneling" && unit.tunnelData) {
              const duration = Math.max(0.001, unit.actionUntil - unit.actionStartedAt);
              const progress = Math.max(0, Math.min(1, (time - unit.actionStartedAt) / duration));
              const origin = unit.tunnelData.origin;
              const destination = unit.tunnelData.destination;
              if (unit.tunnelData.mode === "travel") {
                const travelProgress = Math.max(
                  0,
                  Math.min(1, (progress - 0.12) / 0.72),
                );
                const eased =
                  travelProgress *
                  travelProgress *
                  (3 - 2 * travelProgress);
                visualX = origin.x + (destination.x - origin.x) * eased;
                visualY = origin.y + (destination.y - origin.y) * eased;
              } else if (progress < 0.16) {
                visualX = origin.x;
                visualY = origin.y;
              } else if (progress < 0.36) {
                const travelProgress = (progress - 0.16) / 0.2;
                const eased =
                  travelProgress *
                  travelProgress *
                  (3 - 2 * travelProgress);
                visualX = origin.x + (destination.x - origin.x) * eased;
                visualY = origin.y + (destination.y - origin.y) * eased;
              } else if (
                progress < 0.68 ||
                !unit.tunnelData.hitSucceeded ||
                !unit.tunnelData.returnDestination
              ) {
                visualX = destination.x;
                visualY = destination.y;
              } else {
                const returnDestination = unit.tunnelData.returnDestination;
                const returnProgress = Math.max(
                  0,
                  Math.min(1, (progress - 0.68) / 0.2),
                );
                const eased =
                  returnProgress *
                  returnProgress *
                  (3 - 2 * returnProgress);
                visualX =
                  destination.x +
                  (returnDestination.x - destination.x) * eased;
                visualY =
                  destination.y +
                  (returnDestination.y - destination.y) * eased;
              }
            }
            if (callingForHelp) {
              const callElapsed = Math.max(0, time - unit.pandaCallStartedAt);
              const pulse = (Math.sin(callElapsed * 18) + 1) / 2;
              const ringRadius = unit.radius * (1.18 + pulse * 0.28);
              this.arenaGraphics.lineStyle(5, 0x4da9ff, 0.8 - pulse * 0.18);
              this.arenaGraphics.strokeCircle(
                visualX - unit.radius * 0.72,
                visualY - unit.radius * 0.78,
                ringRadius * 0.42,
              );
              this.arenaGraphics.lineStyle(5, 0xff5f64, 0.8 - pulse * 0.18);
              this.arenaGraphics.strokeCircle(
                visualX + unit.radius * 0.72,
                visualY - unit.radius * 0.78,
                ringRadius * 0.42,
              );
              this.arenaGraphics.lineStyle(3, 0xffef9a, 0.5 - pulse * 0.18);
              this.arenaGraphics.strokeEllipse(
                visualX,
                visualY,
                unit.radius * (3.2 + pulse * 0.45),
                unit.radius * (2.6 + pulse * 0.35),
              );
            }
            const bob =
              unit.action === "victory"
                ? 0
                : Math.sin(time * 8 + unit.bornAt * 2) * 3;
            const alpha =
              unit.action === "dead"
                ? Math.max(0, (unit.actionUntil - time) / 0.45)
                : 1;
            const scaleBump =
              callingForHelp
                ? 1.1
                : unit.action === "attack" || unit.action === "kick"
                ? 1.12
                : unit.action === "kill"
                  ? 1.22
                  : unit.action === "victory"
                      ? 1.18
                : unit.action === "eating" ||
                    unit.action === "satisfied" ||
                    unit.action === "digging"
                  ? 1.06
                  : 1;
            const displayScale = scaleBump;

            if (unit.action === "victory") {
              const victoryStyle = definition.victoryStyle ?? "spotlight";
              const glowColor =
                victoryStyle === "dance"
                  ? 0x83e7ef
                  : victoryStyle === "taunt"
                    ? 0xff8b62
                    : 0xffdf70;
              this.arenaGraphics.fillStyle(
                glowColor,
                victoryStyle === "spotlight" ? 0.2 : 0.12,
              );
              this.arenaGraphics.fillEllipse(
                visualX,
                visualY + unit.radius * 0.72,
                unit.radius * 4.8,
                unit.radius * 1.5,
              );
              this.arenaGraphics.lineStyle(4, glowColor, 0.62);
              this.arenaGraphics.strokeEllipse(
                visualX,
                visualY + unit.radius * 0.72,
                unit.radius * 4.3,
                unit.radius * 1.22,
              );
            }

            if (hasTexture) {
              let image = this.unitImages.get(unit.id);
              if (!image) {
                image = this.add.image(visualX, visualY, textureKey).setDepth(5);
                this.unitImages.set(unit.id, image);
              }
              if (image.texture.key !== textureKey) image.setTexture(textureKey);
              const spriteSize =
                unit.radius *
                (unit.appearanceDefinitionId === "mole" ? 2.78 : 3) *
                displayScale;
              image
                .setVisible(true)
                .setPosition(visualX, visualY + bob)
                .setDisplaySize(spriteSize, spriteSize)
                .setFlipX(unit.vx < 0)
                .setAlpha(alpha)
                .setAngle(
                  unit.action === "kick"
                    ? unit.vx < 0
                      ? -12
                      : 12
                    : 0,
                );
              this.unitFallbacks.get(unit.id)?.setVisible(false);
            } else {
              this.unitImages.get(unit.id)?.setVisible(false);
              let fallback = this.unitFallbacks.get(unit.id);
              if (!fallback) {
                fallback = this.add
                  .text(visualX, visualY, fallbackGlyph(unit.appearanceDefinitionId), {
                    fontSize: `${Math.round(unit.radius * 1.7)}px`,
                    fontFamily: "Arial",
                  })
                  .setOrigin(0.5)
                  .setDepth(5);
                this.unitFallbacks.set(unit.id, fallback);
              }
              fallback
                .setVisible(true)
                .setPosition(visualX, visualY + bob)
                .setScale(displayScale)
                .setAlpha(alpha);
            }

            let callLabel = this.callLabels.get(unit.id);
            if (callingForHelp) {
              if (!callLabel) {
                callLabel = this.add
                  .text(visualX, visualY, "警察叔叔！", {
                    fontSize: "16px",
                    fontFamily: "Arial",
                    fontStyle: "bold",
                    color: "#19141b",
                    backgroundColor: "#fff2c9",
                    stroke: "#ffffff",
                    strokeThickness: 2,
                  })
                  .setOrigin(0.5, 1)
                  .setPadding(10, 5, 10, 5)
                  .setDepth(24);
                this.callLabels.set(unit.id, callLabel);
              }
              const labelPulse =
                1 + Math.sin((time - unit.pandaCallStartedAt) * 18) * 0.035;
              callLabel
                .setVisible(true)
                .setPosition(
                  visualX,
                  Math.max(28, visualY - unit.radius * 2.6),
                )
                .setScale(labelPulse)
                .setAlpha(alpha);
            } else {
              callLabel?.setVisible(false);
            }

            const ownerContestant =
              contestantIndexRef.current.get(unit.ownerId) ??
              contestantIndexRef.current.get(unit.factionId);
            const ownerColor = ownerContestant?.color ?? definition.accent;
            const nameColor = ownerContestant?.nameColor ?? ownerColor;
            const color = Phaser.Display.Color.HexStringToColor(ownerColor).color;
            const healthWidth = Math.max(84, unit.radius * 2.6);
            const healthRatio = Math.max(0, unit.hp / unit.maxHp);
            const healthY = Math.max(24, visualY - unit.radius - 31);
            this.overlayGraphics.fillStyle(0x100e13, 0.82);
            this.overlayGraphics.lineStyle(2, color, 0.95);
            this.overlayGraphics.fillRoundedRect(
              visualX - healthWidth / 2,
              healthY,
              healthWidth,
              18,
              7,
            );
            this.overlayGraphics.strokeRoundedRect(
              visualX - healthWidth / 2,
              healthY,
              healthWidth,
              18,
              7,
            );
            this.overlayGraphics.fillStyle(color, 1);
            this.overlayGraphics.fillRoundedRect(
              visualX - healthWidth / 2 + 3,
              healthY + 3,
              Math.max(0, (healthWidth - 6) * healthRatio),
              12,
              5,
            );
            let healthLabel = this.healthLabels.get(unit.id);
            if (!healthLabel) {
              healthLabel = this.add
                .text(visualX, healthY, "", {
                  fontSize: "12px",
                  fontFamily: "Arial",
                  fontStyle: "bold",
                  color: "#ffffff",
                  stroke: "#161118",
                  strokeThickness: 3,
                })
                .setOrigin(0.5)
                .setDepth(24);
              this.healthLabels.set(unit.id, healthLabel);
            }
            const healthText = `${Math.ceil(unit.hp)} / ${Math.ceil(unit.maxHp)}`;
            if (healthLabel.text !== healthText) healthLabel.setText(healthText);

            const buffs: string[] = [];
            if (time < unit.burnUntil) buffs.push("🔥 灼烧");
            if (time < unit.springUntil) buffs.push("♨ 疗愈");
            if (!unit.targetable && unit.action !== "dead") {
              buffs.push("◌ 不可选");
            }
            const buffText = buffs.join("  ");
            let buffLabel = this.buffLabels.get(unit.id);
            if (buffText) {
              if (!buffLabel) {
                buffLabel = this.add
                  .text(visualX, healthY, buffText, {
                    fontSize: "10px",
                    fontFamily: '"Microsoft YaHei", Arial, sans-serif',
                    fontStyle: "bold",
                    color: "#fff2cf",
                    backgroundColor: "rgba(14, 12, 17, 0.86)",
                    stroke: "#151218",
                    strokeThickness: 2,
                  })
                  .setPadding(6, 3, 6, 3)
                  .setDepth(25);
                this.buffLabels.set(unit.id, buffLabel);
              }
              if (buffLabel.text !== buffText) buffLabel.setText(buffText);
              const boardWidth = board?.width ?? 1600;
              const placeRight =
                visualX + healthWidth / 2 + 10 + buffLabel.width <=
                boardWidth - 8;
              buffLabel
                .setVisible(true)
                .setOrigin(placeRight ? 0 : 1, 0.5)
                .setPosition(
                  visualX + (placeRight ? 1 : -1) * (healthWidth / 2 + 8),
                  healthY + 9,
                )
                .setAlpha(alpha);
            } else {
              buffLabel?.setVisible(false);
            }

            let label = this.unitLabels.get(unit.id);
            if (!label) {
              label = this.add
                .text(visualX, visualY, unit.name, {
                  fontSize: unit.main ? "19px" : "14px",
                  fontFamily: "Arial",
                  color: "#fff7df",
                  stroke: "#151218",
                  strokeThickness: 4,
                })
                .setOrigin(0.5)
                .setDepth(21);
              this.unitLabels.set(unit.id, label);
            }
            if (label.text !== unit.name) label.setText(unit.name);
            label
              .setFontSize(unit.main ? 16 : 12)
              .setOrigin(0.5)
              .setPosition(visualX, healthY - 11);
            healthLabel.setOrigin(0.5).setPosition(visualX, healthY + 9);
            label.setColor(nameColor).setAlpha(alpha);
            healthLabel.setAlpha(alpha);

            const promotionActive =
              unit.policeStar !== undefined &&
              time >= unit.promotionStartedAt &&
              time < unit.promotionUntil;
            let promotionLabel = this.promotionLabels.get(unit.id);
            if (promotionActive) {
              if (!promotionLabel) {
                promotionLabel = this.add
                  .text(visualX, healthY - 30, "", {
                    fontSize: "14px",
                    fontFamily: '"Microsoft YaHei", Arial, sans-serif',
                    fontStyle: "bold",
                    color: "#ffe477",
                    backgroundColor: "rgba(45, 34, 11, 0.9)",
                    stroke: "#4c3109",
                    strokeThickness: 3,
                  })
                  .setOrigin(0.5)
                  .setPadding(9, 4, 9, 4)
                  .setDepth(27);
                this.promotionLabels.set(unit.id, promotionLabel);
              }
              const duration = Math.max(
                0.001,
                unit.promotionUntil - unit.promotionStartedAt,
              );
              const progress = Math.max(
                0,
                Math.min(1, (time - unit.promotionStartedAt) / duration),
              );
              const fadeIn = Math.min(1, progress / 0.14);
              const fadeOut = Math.min(1, (1 - progress) / 0.22);
              const pulse = 1 + Math.sin(progress * Math.PI * 8) * 0.06;
              const promotionText = `★ 升至 ${unit.policeStar} 星`;
              if (promotionLabel.text !== promotionText) {
                promotionLabel.setText(promotionText);
              }
              promotionLabel
                .setVisible(true)
                .setPosition(
                  visualX,
                  healthY - 34 - Math.sin(progress * Math.PI) * 8,
                )
                .setScale(pulse)
                .setAlpha(Math.min(fadeIn, fadeOut) * alpha);
            } else {
              promotionLabel?.setVisible(false);
            }
          }
        }

        game = new Phaser.Game({
          type: Phaser.AUTO,
          parent: containerId,
          width: board?.width ?? 1600,
          height: board?.height ?? 900,
          transparent: true,
          render: {
            antialias: true,
            pixelArt: false,
            roundPixels: false,
          },
          scale: {
            mode: Phaser.Scale.FIT,
            autoCenter: Phaser.Scale.CENTER_BOTH,
          },
          scene: ArenaScene,
        });
      };
      void boot();

      return () => {
        disposed = true;
        game?.destroy(true);
        loadSetupAssetsRef.current = undefined;
        simulationRef.current = undefined;
        audio.dispose();
      };
    }, [containerId, manifest]);

    useEffect(() => {
      audioRef.current.setMuted(muted);
    }, [muted]);

    useEffect(() => {
      audioRef.current.setVolume(volume);
    }, [volume]);

    return <div id={containerId} className="arena-canvas" aria-label="自动战斗棋盘" />;
  },
);
