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
import { BattleSimulation } from "@/lib/game/simulation";
import type {
  AnimationClip,
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
  if (unit.action === "attack") return "attack";
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
    const onSnapshotRef = useRef(onSnapshot);
    const onReadyRef = useRef(onReady);

    mutedRef.current = muted;
    volumeRef.current = volume;
    onSnapshotRef.current = onSnapshot;
    onReadyRef.current = onReady;

    useImperativeHandle(
      ref,
      () => ({
        start: () => {
          void audioRef.current.unlock();
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
        getSnapshot: () => snapshotRef.current,
      }),
      [],
    );

    useEffect(() => {
      let disposed = false;
      let game: PhaserType.Game | undefined;
      const simulation = new BattleSimulation(manifest);
      const board =
        manifest.boards.find((candidate) => candidate.id === manifest.setup.boardId) ??
        manifest.boards[0];
      simulationRef.current = simulation;
      audioRef.current.setMuted(mutedRef.current);
      audioRef.current.setVolume(volumeRef.current);
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
            this.renderArena(snapshot);

            if (snapshot.time - lastSnapshotPush >= 0.08 || snapshot.status === "finished") {
              lastSnapshotPush = snapshot.time;
              onSnapshotRef.current(snapshot);
              const freshEvents = snapshot.events.filter((event) => !previousEventIds.has(event.id));
              previousEventIds = new Set(snapshot.events.map((event) => event.id));
              for (const event of freshEvents) {
                void audioRef.current.playEvent(
                  event,
                  snapshot.units,
                  manifest.characters,
                  manifest.assets,
                );
              }
            }
          }

          private renderArena(snapshot: BattleSnapshot) {
            this.arenaGraphics.clear();
            this.overlayGraphics.clear();
            this.drawProps(snapshot.props);
            this.drawHoles(snapshot);
            this.drawProjectiles(snapshot);
            this.drawEventEffects(snapshot);

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
                .filter((event) => snapshot.time - event.time <= 0.9 && event.amount !== undefined)
                .map((event) => event.id),
            );
            for (const [id, label] of this.eventLabels) {
              if (!visibleEventIds.has(id)) {
                label.destroy();
                this.eventLabels.delete(id);
              }
            }

            for (const unit of snapshot.units) this.drawUnit(unit, snapshot.time);
          }

          private drawProps(props: BoardProp[]) {
            for (const prop of props) {
              if (!prop.active) continue;
              if (prop.type === "lava") {
                this.drawShape(prop.shape, 0xff5a35, 0.34, 0xffc04a);
              } else if (prop.type === "hotSpring") {
                this.drawShape(prop.shape, 0x43cbd3, 0.32, 0xa5fbff);
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

          private drawEventEffects(snapshot: BattleSnapshot) {
            for (const event of snapshot.events) {
              const age = snapshot.time - event.time;
              if (age < 0 || age > 0.9 || event.x === undefined || event.y === undefined) continue;
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
            const bob = Math.sin(time * 8 + unit.bornAt * 2) * 3;
            const alpha = unit.action === "dead" ? Math.max(0, (unit.actionUntil - time) / 0.45) : unit.targetable ? 1 : 0.16;
            const scaleBump =
              unit.action === "attack" || unit.action === "kick"
                ? 1.12
                : unit.action === "eating" || unit.action === "digging"
                  ? 1.06
                  : 1;

            if (hasTexture) {
              let image = this.unitImages.get(unit.id);
              if (!image) {
                image = this.add.image(unit.x, unit.y, textureKey).setDepth(5);
                this.unitImages.set(unit.id, image);
              }
              if (image.texture.key !== textureKey) image.setTexture(textureKey);
              image
                .setPosition(unit.x, unit.y + bob)
                .setDisplaySize(unit.radius * 3 * scaleBump, unit.radius * 3 * scaleBump)
                .setFlipX(unit.vx < 0)
                .setAlpha(alpha)
                .setAngle(unit.action === "kick" ? (unit.vx < 0 ? -12 : 12) : 0);
              this.unitFallbacks.get(unit.id)?.setVisible(false);
            } else {
              let fallback = this.unitFallbacks.get(unit.id);
              if (!fallback) {
                fallback = this.add
                  .text(unit.x, unit.y, fallbackGlyph(unit.definitionId), {
                    fontSize: `${Math.round(unit.radius * 1.7)}px`,
                    fontFamily: "Arial",
                  })
                  .setOrigin(0.5)
                  .setDepth(5);
                this.unitFallbacks.set(unit.id, fallback);
              }
              fallback
                .setVisible(true)
                .setPosition(unit.x, unit.y + bob)
                .setScale(scaleBump)
                .setAlpha(alpha);
            }

            const ownerColor =
              manifest.setup.contestants.find((contestant) => contestant.id === unit.ownerId)
                ?.color ?? definition.accent;
            const color = Phaser.Display.Color.HexStringToColor(ownerColor).color;
            const healthWidth = Math.max(76, unit.radius * 2.6);
            const healthRatio = Math.max(0, unit.hp / unit.maxHp);
            const healthY = unit.y - unit.radius - 31;
            this.overlayGraphics.fillStyle(0x100e13, 0.82);
            this.overlayGraphics.lineStyle(2, color, unit.targetable ? 0.95 : 0.3);
            this.overlayGraphics.fillRoundedRect(
              unit.x - healthWidth / 2,
              healthY,
              healthWidth,
              18,
              7,
            );
            this.overlayGraphics.strokeRoundedRect(
              unit.x - healthWidth / 2,
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
              unit.x - healthWidth / 2 + 3,
              healthY + 3,
              Math.max(0, (healthWidth - 6) * healthRatio),
              12,
              5,
            );
            let healthLabel = this.healthLabels.get(unit.id);
            if (!healthLabel) {
              healthLabel = this.add
                .text(unit.x, healthY, "", {
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
              .setPosition(unit.x, healthY + 9)
              .setAlpha(alpha);

            let label = this.unitLabels.get(unit.id);
            if (!label) {
              label = this.add
                .text(unit.x, unit.y, unit.name, {
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
              .setPosition(unit.x, unit.y + unit.radius + 21)
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
