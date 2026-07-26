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
  setMusic: (config: BackgroundMusicConfig, assets: AssetRef[]) => void;
  setMusicVolume: (volume: number) => void;
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
  const duration = clip.frames.reduce((total, frame) => total + frame.durationMs, 0);
  const position = clip.loop ? elapsedMs % duration : Math.min(elapsedMs, duration - 1);
  let cursor = 0;
  for (const frame of clip.frames) {
    cursor += frame.durationMs;
    if (position < cursor) return frame.assetId;
  }
  return clip.frames.at(-1)?.assetId;
};

const actionClipName = (unit: RuntimeUnit): string => {
  if (unit.action === "tunneling") return "tunnelAttack";
  if (unit.action === "eating" || unit.action === "digging" || unit.action === "kick") {
    return "skill";
  }
  if (unit.action === "attack" || unit.action === "kill") return "attack";
  return "move";
};

export const ArenaCanvas = forwardRef<ArenaHandle, ArenaCanvasProps>(
  function ArenaCanvas({ manifest, muted, volume, onSnapshot, onReady }, ref) {
    const containerId = `arena-${useId().replace(/:/g, "")}`;
    const gameRef = useRef<PhaserType.Game | undefined>(undefined);
    const simulationRef = useRef<BattleSimulation | undefined>(undefined);
    const speedRef = useRef(1);
    const snapshotRef = useRef<BattleSnapshot | undefined>(undefined);
    const audioRef = useRef(new ArenaAudio());
    const mutedRef = useRef(muted);
    const volumeRef = useRef(volume);
    const musicConfigRef = useRef(manifest.backgroundMusic);
    const musicAssetsRef = useRef(manifest.assets);
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
        setMusic: (config: BackgroundMusicConfig, assets: AssetRef[]) => {
          void audioRef.current.setMusic(config, assets);
        },
        setMusicVolume: (nextVolume: number) => {
          audioRef.current.setMusicVolume(nextVolume);
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
      simulationRef.current = simulation;
      audio.setMuted(mutedRef.current);
      audio.setVolume(volumeRef.current);
      void audio.setMusic(manifest.backgroundMusic, manifest.assets);
      let lastSnapshotPush = 0;
      let previousEventIds = new Set<string>();

      const boot = async () => {
        const phaserModule = (await import("phaser")) as unknown as {
          default?: PhaserModule;
        } & PhaserModule;
        const Phaser = (phaserModule.default ?? phaserModule) as PhaserModule;
        if (disposed) return;

        class ArenaScene extends Phaser.Scene {
          private arenaGraphics!: PhaserType.GameObjects.Graphics;
          private overlayGraphics!: PhaserType.GameObjects.Graphics;
          private unitImages = new Map<string, PhaserType.GameObjects.Image>();
          private unitFallbacks = new Map<string, PhaserType.GameObjects.Text>();
          private unitLabels = new Map<string, PhaserType.GameObjects.Text>();
          private healthLabels = new Map<string, PhaserType.GameObjects.Text>();
          private holeLabels = new Map<string, PhaserType.GameObjects.Text>();
          private eventLabels = new Map<string, PhaserType.GameObjects.Text>();
          private accumulatedMs = 0;
          private finishedVisualTime = 0;
          private failedTextures = new Set<string>();

          constructor() {
            super("arena");
          }

          preload() {
            this.load.on(
              "loaderror",
              (file: { key?: string }) => file.key && this.failedTextures.add(file.key),
            );
            for (const asset of manifest.assets.filter((candidate) => candidate.kind === "image")) {
              this.load.image(`asset:${asset.id}`, asset.url);
            }
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
            this.arenaGraphics = this.add.graphics().setDepth(-10);
            this.overlayGraphics = this.add.graphics().setDepth(20);
            const initial = simulation.getSnapshot();
            snapshotRef.current = initial;
            onSnapshotRef.current(initial);
            onReadyRef.current?.();
          }

          update(_time: number, delta: number) {
            this.accumulatedMs += delta * speedRef.current;
            const fixedMs = 1000 / 60;
            let safety = 0;
            while (this.accumulatedMs >= fixedMs && safety < 20) {
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

            if (snapshot.time - lastSnapshotPush >= 0.08 || snapshot.status === "finished") {
              lastSnapshotPush = snapshot.time;
              onSnapshotRef.current(snapshot);
              const freshEvents = snapshot.events.filter((event) => !previousEventIds.has(event.id));
              previousEventIds = new Set(snapshot.events.map((event) => event.id));
              for (const event of freshEvents) {
                void audio.playEvent(
                  event,
                  snapshot.units,
                  manifest.characters,
                  manifest.assets,
                );
              }
            }
          }

          private renderArena(snapshot: BattleSnapshot, finishedVisualTime: number) {
            this.arenaGraphics.clear();
            this.overlayGraphics.clear();
            this.drawProps(snapshot.props, snapshot.time + finishedVisualTime);
            this.drawHoles(snapshot);
            this.drawProjectiles(snapshot);
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
            const activeHoleIds = new Set(snapshot.holes.map((hole) => hole.id));
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

            for (const unit of snapshot.units) {
              this.drawUnit(unit, snapshot.time + finishedVisualTime);
            }
          }

          private drawProps(props: BoardProp[], time: number) {
            for (const prop of props) {
              if (!prop.active) continue;
              if (prop.type === "lava") {
                this.drawShape(prop.shape, 0xff5a35, 0.34, 0xffc04a);
                this.drawAreaTexture(prop, time);
              } else if (prop.type === "hotSpring") {
                this.drawShape(prop.shape, 0x43cbd3, 0.32, 0xa5fbff);
                this.drawAreaTexture(prop, time);
              } else {
                const center = this.shapeCenter(prop.shape);
                this.drawShape(prop.shape, 0x2d6f4a, 0.18, 0x79cf71);
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

          private drawShape(shape: RegionShape, fill: number, alpha: number, line: number) {
            this.arenaGraphics.fillStyle(fill, alpha);
            this.arenaGraphics.lineStyle(3, line, 0.42);
            if (shape.kind === "circle") {
              this.arenaGraphics.fillCircle(shape.x, shape.y, shape.radius);
              this.arenaGraphics.strokeCircle(shape.x, shape.y, shape.radius);
            } else if (shape.kind === "rectangle") {
              this.arenaGraphics.fillRoundedRect(shape.x, shape.y, shape.width, shape.height, 22);
              this.arenaGraphics.strokeRoundedRect(shape.x, shape.y, shape.width, shape.height, 22);
            } else {
              const points = shape.points.map((point) => new Phaser.Geom.Point(point.x, point.y));
              this.arenaGraphics.fillPoints(points, true);
              this.arenaGraphics.strokePoints(points, true, true);
            }
          }

          private shapeCenter(shape: RegionShape) {
            if (shape.kind === "circle") return { x: shape.x, y: shape.y };
            if (shape.kind === "rectangle") {
              return {
                x: shape.x + shape.width / 2,
                y: shape.y + shape.height / 2,
              };
            }
            return shape.points.reduce(
              (center, point) => ({
                x: center.x + point.x / shape.points.length,
                y: center.y + point.y / shape.points.length,
              }),
              { x: 0, y: 0 },
            );
          }

          private shapeBounds(shape: RegionShape) {
            if (shape.kind === "circle") {
              return {
                x: shape.x - shape.radius,
                y: shape.y - shape.radius,
                width: shape.radius * 2,
                height: shape.radius * 2,
              };
            }
            if (shape.kind === "rectangle") return shape;
            if (!shape.points.length) return { x: 0, y: 0, width: 1, height: 1 };
            const xs = shape.points.map((point) => point.x);
            const ys = shape.points.map((point) => point.y);
            const x = Math.min(...xs);
            const y = Math.min(...ys);
            return {
              x,
              y,
              width: Math.max(1, Math.max(...xs) - x),
              height: Math.max(1, Math.max(...ys) - y),
            };
          }

          private drawHoles(snapshot: BattleSnapshot) {
            for (const hole of snapshot.holes) {
              this.arenaGraphics.fillStyle(0x1a1412, 0.88);
              this.arenaGraphics.lineStyle(4, 0x7d5f3b, 0.9);
              this.arenaGraphics.fillEllipse(hole.x, hole.y, hole.radius * 1.65, hole.radius * 0.72);
              this.arenaGraphics.strokeEllipse(hole.x, hole.y, hole.radius * 1.65, hole.radius * 0.72);
              this.arenaGraphics.lineStyle(2, 0xe1b76b, 0.18);
              this.arenaGraphics.strokeCircle(hole.x, hole.y, hole.radius);
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
              label
                .setText(`洞口 ${hole.stompsRemaining}/${hole.stompsRequired}`)
                .setPosition(hole.x, hole.y + hole.radius * 0.55);
            }
          }

          private drawProjectiles(snapshot: BattleSnapshot) {
            for (const projectile of snapshot.projectiles) {
              if (projectile.kind === "rocket") {
                this.overlayGraphics.fillStyle(0xffc66b, 1);
                this.overlayGraphics.fillCircle(projectile.x, projectile.y, 14);
                this.overlayGraphics.fillStyle(0xff573a, 0.75);
                this.overlayGraphics.fillCircle(
                  projectile.x - projectile.vx / 45,
                  projectile.y - projectile.vy / 45,
                  8,
                );
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
              const maxAge = event.type === "victory" ? 2.8 : event.type === "merge" ? 1.25 : 0.9;
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
              if (age <= 0.55) {
                this.overlayGraphics.lineStyle(5 * (1 - progress), color, 0.8 * (1 - progress));
                this.overlayGraphics.strokeCircle(event.x, event.y, 18 + progress * 95);
              }
              if (event.type === "merge" && age <= 1.1) {
                const fade = Math.max(0, 1 - age / 1.1);
                this.overlayGraphics.lineStyle(4, 0xffe783, fade);
                for (let ray = 0; ray < 10; ray += 1) {
                  const angle = ray * (Math.PI * 2 / 10) + age * 2.4;
                  const inner = 34 + age * 22;
                  const outer = 72 + age * 56;
                  this.overlayGraphics.lineBetween(
                    event.x + Math.cos(angle) * inner,
                    event.y + Math.sin(angle) * inner,
                    event.x + Math.cos(angle) * outer,
                    event.y + Math.sin(angle) * outer,
                  );
                }
              } else if (event.type === "death" && age <= 0.75) {
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

          private drawUnit(unit: RuntimeUnit, time: number) {
            const definition = manifest.characters.find(
              (candidate) => candidate.id === unit.definitionId,
            );
            if (!definition) return;
            const clip = definition.animations[actionClipName(unit)] ?? definition.animations.idle;
            const frameId =
              frameForClip(clip, Math.max(0, (time - unit.actionStartedAt) * 1000)) ??
              definition.portraitAssetId;
            const textureKey = `asset:${frameId}`;
            const hasTexture = this.textures.exists(textureKey) && !this.failedTextures.has(textureKey);
            let visualX = unit.x;
            let visualY = unit.y;
            let tunnelAlpha = 1;
            let tunnelScale = 1;
            if (unit.action === "tunneling" && unit.tunnelData) {
              const duration = Math.max(0.001, unit.actionUntil - unit.actionStartedAt);
              const progress = Math.max(0, Math.min(1, (time - unit.actionStartedAt) / duration));
              const origin = unit.tunnelData.origin;
              const destination = unit.tunnelData.destination;
              if (unit.tunnelData.mode === "travel") {
                if (progress < 0.24) {
                  visualX = origin.x;
                  visualY = origin.y;
                  tunnelAlpha = 1 - progress / 0.24;
                  tunnelScale = Math.max(0.18, 1 - progress / 0.3);
                } else if (progress < 0.62) {
                  visualX = origin.x;
                  visualY = origin.y;
                  tunnelAlpha = 0;
                } else {
                  visualX = destination.x;
                  visualY = destination.y;
                  tunnelAlpha = Math.min(1, (progress - 0.62) / 0.22);
                  tunnelScale = 0.38 + tunnelAlpha * 0.62;
                }
              } else if (progress < 0.2) {
                visualX = origin.x;
                visualY = origin.y;
                tunnelAlpha = 1 - progress / 0.2;
                tunnelScale = Math.max(0.2, 1 - progress / 0.26);
              } else if (progress < 0.34) {
                visualX = origin.x;
                visualY = origin.y;
                tunnelAlpha = 0;
              } else if (progress < 0.64) {
                visualX = destination.x;
                visualY = destination.y;
                const emerge = Math.min(1, (progress - 0.34) / 0.1);
                const leave = progress > 0.56 ? Math.max(0, 1 - (progress - 0.56) / 0.08) : 1;
                tunnelAlpha = Math.min(emerge, leave);
                tunnelScale = 0.35 + tunnelAlpha * 0.78;
              } else if (progress < 0.84) {
                visualX = destination.x;
                visualY = destination.y;
                tunnelAlpha = 0;
              } else {
                visualX = origin.x;
                visualY = origin.y;
                tunnelAlpha = Math.min(1, (progress - 0.84) / 0.13);
                tunnelScale = 0.35 + tunnelAlpha * 0.65;
              }
            }
            const bob =
              Math.sin(time * (unit.action === "victory" ? 12 : 8) + unit.bornAt * 2) *
              (unit.action === "victory" ? 9 : 3);
            const alpha =
              unit.action === "dead"
                ? Math.max(0, (unit.actionUntil - time) / 0.45)
                : unit.action === "tunneling"
                  ? tunnelAlpha
                  : unit.targetable
                    ? 1
                    : 0.16;
            const scaleBump =
              unit.action === "attack" || unit.action === "kick"
                ? 1.12
                : unit.action === "kill"
                  ? 1.22
                  : unit.action === "merge"
                    ? 1.12 + Math.sin((time - unit.actionStartedAt) * 20) * 0.12
                    : unit.action === "victory"
                      ? 1.18 + Math.sin(time * 10) * 0.08
                : unit.action === "eating" || unit.action === "digging"
                  ? 1.06
                  : 1;
            const displayScale = scaleBump * tunnelScale;

            if (hasTexture) {
              let image = this.unitImages.get(unit.id);
              if (!image) {
                image = this.add.image(visualX, visualY, textureKey).setDepth(5);
                this.unitImages.set(unit.id, image);
              }
              if (image.texture.key !== textureKey) image.setTexture(textureKey);
              image
                .setPosition(visualX, visualY + bob)
                .setDisplaySize(unit.radius * 3 * displayScale, unit.radius * 3 * displayScale)
                .setFlipX(unit.vx < 0)
                .setAlpha(alpha)
                .setAngle(
                  unit.action === "kick"
                    ? unit.vx < 0
                      ? -12
                      : 12
                    : unit.action === "victory"
                      ? Math.sin(time * 6) * 7
                      : 0,
                );
              this.unitFallbacks.get(unit.id)?.setVisible(false);
            } else {
              let fallback = this.unitFallbacks.get(unit.id);
              if (!fallback) {
                fallback = this.add
                  .text(visualX, visualY, fallbackGlyph(unit.definitionId), {
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

            const ownerColor =
              manifest.setup.contestants.find((contestant) => {
                const factionId = contestant.teamId
                  ? `team:${contestant.teamId}`
                  : contestant.id;
                return contestant.id === unit.ownerId || factionId === unit.factionId;
              })?.color ?? definition.accent;
            const color = Phaser.Display.Color.HexStringToColor(ownerColor).color;
            const healthWidth = Math.max(76, unit.radius * 2.6);
            const healthRatio = Math.max(0, unit.hp / unit.maxHp);
            const healthY = visualY - unit.radius - 31;
            this.overlayGraphics.fillStyle(0x100e13, 0.82);
            this.overlayGraphics.lineStyle(2, color, unit.targetable ? 0.95 : 0.3);
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
            this.overlayGraphics.fillStyle(
              healthRatio > 0.55 ? 0x69db83 : healthRatio > 0.25 ? 0xffc857 : 0xff5b68,
              1,
            );
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
            const status =
              time < unit.burnUntil ? "🔥 " : time < unit.springUntil ? "♨ " : "";
            healthLabel
              .setText(`${status}${Math.ceil(unit.hp)} / ${Math.ceil(unit.maxHp)}`)
              .setPosition(visualX, healthY + 9)
              .setAlpha(alpha);

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
            label
              .setText(unit.name)
              .setPosition(visualX, visualY + unit.radius + 21)
              .setColor(ownerColor)
              .setAlpha(alpha);
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
        gameRef.current = game;
      };
      void boot();

      return () => {
        disposed = true;
        game?.destroy(true);
        gameRef.current = undefined;
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
