import { SeededRandom } from "./rng";
import {
  type AbilityAction,
  type AbilityModule,
  type BattleSnapshot,
  type BattleStatus,
  type BoardDefinition,
  type BoardProp,
  type CharacterDefinition,
  type CombatEvent,
  type MatchSetup,
  type PolicePromotionConfig,
  type ProjectManifest,
  type RegionShape,
  type RuntimeHole,
  type RuntimeProjectile,
  type RuntimeUnit,
  type SynthPreset,
  type Vec2,
} from "./types";

type DamageSource = "directAttack" | "effect" | "environment" | "existingBuff";

type ScheduledShot = {
  id: string;
  sequence: number;
  at: number;
  sourceId: string;
  targetId: string;
  from?: Vec2;
  damage?: number;
  range?: number;
  ambush?: boolean;
};

const EPSILON = 0.0001;
const SPATIAL_CELL_SIZE = 240;
const MAX_EVENT_LOG = 240;
const EVENT_LOG_TRIM_TO = 200;
const MAX_EVENTS_PER_STEP = 128;
const MAX_ACTIVE_UNITS = 512;
const MAX_UNIT_SPAWNS_PER_STEP = 64;
const MAX_ACTIVE_PROJECTILES = 900;
const MAX_PROJECTILES_PER_STEP = 320;
const MAX_QUEUED_SHOTS = 4_096;
const MAX_SCHEDULED_SHOTS_PER_STEP = 512;
const MAX_SHOTS_PER_BURST = 240;
const MAX_GATLING_SHOTS_PER_STEP = 24;
const MAX_MERGES_PER_STEP = 64;
const MAX_MODULE_EXECUTIONS_PER_STEP = 128;
const MOLE_TUNNEL_ENTRY_DURATION = 0.12;
const MOLE_TUNNEL_ATTACK_WINDUP = 0.08;
const MOLE_TUNNEL_RETURN_DELAY = 0.12;
const MOLE_TUNNEL_EXIT_DURATION = 0.18;
const MIN_MOLE_TUNNEL_TRAVEL_DURATION = 1 / 60;
const MIN_HORIZONTAL_DEVIATION_RADIANS = (8 * Math.PI) / 180;
const MAX_HORIZONTAL_DEVIATION_RADIANS = (65 * Math.PI) / 180;
const HORIZONTAL_DEVIATION_BIAS_POWER = 3;
const MELEE_CONTACT_TOLERANCE = 4;
const MIN_MELEE_PURSUIT_BUFFER = 24;
export const UNIT_ENTRANCE_DURATION = 0.8;

export type SimulationDiagnostics = {
  activeUnits: number;
  activeProjectiles: number;
  queuedShots: number;
  events: number;
  droppedProjectiles: number;
  droppedShots: number;
  droppedSpawns: number;
  skippedAbilityModules: number;
  suppressedEvents: number;
};

const teamName = (factionId: string): string => {
  const names: Record<string, string> = {
    "team:red": "红队",
    "team:blue": "蓝队",
    "team:green": "绿队",
    "team:purple": "紫队",
    "team:gold": "金队",
  };
  return names[factionId] ?? "同盟";
};

const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

const normalize = (value: Vec2): Vec2 => {
  const length = Math.hypot(value.x, value.y);
  if (length < EPSILON) return { x: 1, y: 0 };
  return { x: value.x / length, y: value.y / length };
};

const pointInPolygon = (point: Vec2, points: Vec2[]): boolean => {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const currentPoint = points[index];
    const previousPoint = points[previous];
    const intersects =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y || EPSILON) +
          currentPoint.x;
    if (intersects) inside = !inside;
  }
  return inside;
};

const distanceToSegment = (point: Vec2, start: Vec2, end: Vec2): number => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, start);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  return distance(point, { x: start.x + t * dx, y: start.y + t * dy });
};

export const circleOverlapsRegion = (
  point: Vec2,
  radius: number,
  shape: RegionShape,
): boolean => {
  if (shape.kind === "circle") {
    return distance(point, shape) <= radius + shape.radius;
  }
  if (shape.kind === "rectangle") {
    const nearestX = Math.max(shape.x, Math.min(point.x, shape.x + shape.width));
    const nearestY = Math.max(shape.y, Math.min(point.y, shape.y + shape.height));
    return distance(point, { x: nearestX, y: nearestY }) <= radius;
  }
  if (shape.points.length < 3) return false;
  if (pointInPolygon(point, shape.points)) return true;
  return shape.points.some((start, index) => {
    const end = shape.points[(index + 1) % shape.points.length];
    return distanceToSegment(point, start, end) <= radius;
  });
};

const cloneProps = (board: BoardDefinition): BoardProp[] => structuredClone(board.props);

export class BattleSimulation {
  readonly definitions = new Map<string, CharacterDefinition>();
  readonly board: BoardDefinition;
  readonly setup: MatchSetup;

  private readonly random: SeededRandom;
  private readonly policePromotion: PolicePromotionConfig;
  private readonly units = new Map<string, RuntimeUnit>();
  private readonly holes = new Map<string, RuntimeHole>();
  private readonly projectiles = new Map<string, RuntimeProjectile>();
  private readonly props: BoardProp[];
  private readonly bambooProps: BoardProp[];
  private readonly lavaProps: BoardProp[];
  private readonly springProps: BoardProp[];
  private readonly reservedBambooIds = new Set<string>();
  private readonly scheduledShots: ScheduledShot[] = [];
  private readonly eventLog: CombatEvent[] = [];
  private readonly killChains = new Map<string, { count: number; lastKillAt: number }>();
  private readonly spatialCells = new Map<string, RuntimeUnit[]>();
  private orderedUnitsCache: RuntimeUnit[] = [];
  private orderedUnitsDirty = true;
  private maxUnitRadius = 0;
  private scheduledSequence = 0;
  private projectilesCreatedThisStep = 0;
  private unitsSpawnedThisStep = 0;
  private eventsCreatedThisStep = 0;
  private modulesExecutedThisStep = 0;
  private droppedProjectiles = 0;
  private droppedShots = 0;
  private droppedSpawns = 0;
  private skippedAbilityModules = 0;
  private suppressedEvents = 0;
  private serial = 0;
  private time = 0;
  private status: BattleStatus = "ready";
  private winnerId: string | undefined;
  private winnerName: string | undefined;
  private draw = false;
  private finishAt: number | undefined;
  private lastMainKillerId: string | undefined;
  private nextBambooRespawnAt: number | undefined;

  constructor(manifest: ProjectManifest, setup: MatchSetup = manifest.setup) {
    manifest.characters.forEach((definition) => this.definitions.set(definition.id, definition));
    const board = manifest.boards.find((candidate) => candidate.id === setup.boardId);
    if (!board) throw new Error(`找不到棋盘：${setup.boardId}`);
    this.board = structuredClone(board);
    this.setup = structuredClone(setup);
    this.policePromotion = structuredClone(manifest.policePromotion);
    this.props = cloneProps(board);
    this.bambooProps = this.props.filter((prop) => prop.type === "bamboo");
    this.lavaProps = this.props.filter((prop) => prop.type === "lava");
    this.springProps = this.props.filter((prop) => prop.type === "hotSpring");
    this.random = new SeededRandom(setup.seed);
    this.initializeContestants();
  }

  start(): void {
    if (this.setup.contestants.length < 2) {
      throw new Error("至少需要两名主角色才能开战");
    }
    if (this.status === "ready" || this.status === "paused") this.status = "running";
  }

  pause(): void {
    if (this.status === "running") this.status = "paused";
  }

  resume(): void {
    if (this.status === "paused") this.status = "running";
  }

  syncReadySetup(setup: MatchSetup): boolean {
    if (this.status !== "ready" || setup.boardId !== this.setup.boardId) return false;
    this.setup.seed = setup.seed;
    this.setup.contestants = structuredClone(setup.contestants);
    this.units.clear();
    this.orderedUnitsCache = [];
    this.orderedUnitsDirty = true;
    this.holes.clear();
    this.projectiles.clear();
    this.reservedBambooIds.clear();
    this.spatialCells.clear();
    this.scheduledShots.length = 0;
    this.eventLog.length = 0;
    this.killChains.clear();
    this.scheduledSequence = 0;
    this.droppedProjectiles = 0;
    this.droppedShots = 0;
    this.droppedSpawns = 0;
    this.skippedAbilityModules = 0;
    this.suppressedEvents = 0;
    this.winnerId = undefined;
    this.winnerName = undefined;
    this.draw = false;
    this.finishAt = undefined;
    this.lastMainKillerId = undefined;
    this.nextBambooRespawnAt = undefined;
    this.initializeContestants();
    return true;
  }

  step(dt = 1 / 60, force = false): void {
    if ((!force && this.status !== "running") || this.status === "finished") return;
    this.projectilesCreatedThisStep = 0;
    this.unitsSpawnedThisStep = 0;
    this.eventsCreatedThisStep = 0;
    this.modulesExecutedThisStep = 0;
    this.time += dt;
    this.completeTimedActions();
    this.processScheduledShots(dt);
    this.rebuildSpatialIndex();
    this.updateUnits(dt);
    this.updatePandaBambooRespawn();
    this.rebuildSpatialIndex();
    this.mergeCollidingPolice();
    this.rebuildSpatialIndex();
    this.updateProjectiles(dt);
    this.cleanupDeadUnits();
    this.checkVictory();
  }

  getSnapshot(): BattleSnapshot {
    return {
      time: this.time,
      status: this.status,
      winnerId: this.winnerId,
      winnerName: this.winnerName,
      draw: this.draw,
      units: this.orderedUnits().map((unit) => ({
        ...unit,
        moduleCooldowns: { ...unit.moduleCooldowns },
        tunnelData: unit.tunnelData
          ? {
              ...unit.tunnelData,
              origin: { ...unit.tunnelData.origin },
              destination: { ...unit.tunnelData.destination },
              returnDestination: unit.tunnelData.returnDestination
                ? { ...unit.tunnelData.returnDestination }
                : undefined,
            }
          : undefined,
        gatling: unit.gatling
          ? {
              ...unit.gatling,
              roundDirection: unit.gatling.roundDirection
                ? { ...unit.gatling.roundDirection }
                : undefined,
            }
          : undefined,
        knockbackData: unit.knockbackData
          ? {
              ...unit.knockbackData,
              origin: { ...unit.knockbackData.origin },
              destination: { ...unit.knockbackData.destination },
            }
          : undefined,
      })),
      holes: [...this.holes.values()].map((hole) => ({ ...hole })),
      projectiles: [...this.projectiles.values()].map((projectile) => ({ ...projectile })),
      props: this.props.map((prop) => ({ ...prop })),
      events: this.eventLog.slice(-80),
    };
  }

  getDiagnostics(): SimulationDiagnostics {
    return {
      activeUnits: this.units.size,
      activeProjectiles: this.projectiles.size,
      queuedShots: this.scheduledShots.length,
      events: this.eventLog.length,
      droppedProjectiles: this.droppedProjectiles,
      droppedShots: this.droppedShots,
      droppedSpawns: this.droppedSpawns,
      skippedAbilityModules: this.skippedAbilityModules,
      suppressedEvents: this.suppressedEvents,
    };
  }

  private initializeContestants(): void {
    for (const contestant of this.setup.contestants) {
      const definition = this.definitions.get(contestant.definitionId);
      if (!definition) continue;
      const unit = this.createUnit({
        id: contestant.id,
        definition,
        name: contestant.displayName,
        ownerId: contestant.id,
        factionId: contestant.teamId ? `team:${contestant.teamId}` : contestant.id,
        main: true,
        x: contestant.position.x,
        y: contestant.position.y,
        direction: contestant.direction,
        playEntrance: true,
      });
      this.addUnit(unit);
    }
  }

  private createUnit(options: {
    id?: string;
    definition: CharacterDefinition;
    appearanceDefinitionId?: string;
    name?: string;
    ownerId: string;
    factionId: string;
    main: boolean;
    sustainsFaction?: boolean;
    x: number;
    y: number;
    direction?: Vec2;
    playEntrance?: boolean;
  }): RuntimeUnit {
    const direction = this.createHorizontalBiasedDirection(
      options.direction?.x,
    );
    const definition = options.definition;
    const radius = definition.radius * (this.board.unitScale ?? 1);
    const entering = options.playEntrance === true;
    const unit: RuntimeUnit = {
      id: options.id ?? this.nextId(definition.id),
      definitionId: definition.id,
      appearanceDefinitionId:
        options.appearanceDefinitionId ?? definition.id,
      name: options.name ?? definition.name,
      ownerId: options.ownerId,
      factionId: options.factionId,
      main: options.main,
      policeStar: definition.policeStar,
      policeKillProgress: 0,
      hp: definition.maxHp,
      maxHp: definition.maxHp,
      x: Math.max(radius, Math.min(this.board.width - radius, options.x)),
      y: Math.max(radius, Math.min(this.board.height - radius, options.y)),
      vx: direction.x * definition.speed,
      vy: direction.y * definition.speed,
      radius,
      bornAt: this.time,
      nextAttackAt: this.time + 0.4 + this.random.next() * 0.4,
      targetable: !entering,
      action: entering ? "entering" : "move",
      actionStartedAt: this.time,
      actionUntil: entering ? this.time + UNIT_ENTRANCE_DURATION : 0,
      promotionStartedAt: 0,
      promotionUntil: 0,
      nextPandaSummonAt: 0,
      pandaCallStartedAt: 0,
      pandaCallUntil: 0,
      sustainsFaction: options.sustainsFaction ?? false,
      nextEatAt: 0,
      meleeTargetId: undefined,
      nextDigAt: definition.pluginId === "mole" ? this.time : Number.POSITIVE_INFINITY,
      nextAmbushAt: 0,
      burnUntil: 0,
      burnDamagePerSecond: 0,
      springUntil: 0,
      springHealPerSecond: 0,
      nextBurnFeedbackAt: 0,
      nextSpringFeedbackAt: 0,
      stunnedUntil: 0,
      moduleCooldowns: Object.fromEntries(
        definition.abilities.map((ability) => [
          ability.id,
          this.time + (ability.trigger === "interval" ? ability.interval ?? ability.cooldown : 0),
        ]),
      ),
      ...(definition.policeStar === 5
        ? {
            gatling: {
              nextRoundIn: 0.08,
              shotsRemaining: 0,
              nextShotIn: 0,
              nextKickAt: 0,
              magazineSize: Math.max(
                1,
                Math.round(
                  definition.skillParameters?.police?.gatlingMagazineSize ?? 150,
                ),
              ),
              ammoRemaining: Math.max(
                1,
                Math.round(
                  definition.skillParameters?.police?.gatlingMagazineSize ?? 150,
                ),
              ),
            },
          }
        : {}),
    };
    return unit;
  }

  private updateUnits(dt: number): void {
    for (const unit of this.orderedUnits()) {
      if (unit.hp <= 0) continue;
      const definition = this.definitions.get(unit.definitionId);
      if (!definition) continue;
      if (unit.action === "entering") continue;

      const controlled =
        unit.action === "knockback" || unit.action === "stunned";
      if (unit.action === "knockback") this.updateKnockbackPosition(unit);
      if (unit.action !== "tunneling" && !controlled) {
        this.runIntervalModules(unit);
      }
      if (!controlled) this.updateSpecialAbility(unit, definition, dt);

      const immobilized = [
        "eating",
        "satisfied",
        "digging",
        "tunneling",
        "reloading",
        "kick",
        "knockback",
        "stunned",
        "merge",
        "victory",
      ].includes(unit.action);
      if (unit.action === "meleeApproach") {
        this.updateMeleeApproach(unit, definition, dt);
      } else if (
        unit.action === "attack" &&
        definition.attack.mode === "melee" &&
        unit.meleeTargetId
      ) {
        this.updateMeleeStrikeContact(unit, definition, dt);
      } else if (!immobilized) {
        this.moveUnit(unit, dt, definition.speed);
      }

      this.updateAreaBuffs(unit);
      if (unit.action === "dead") continue;

      if (
        definition.attack.mode !== "gatling" &&
        !(definition.attack.mode === "melee" && unit.action === "attack") &&
        this.canBeginAttack(unit)
      ) {
        this.beginAttack(unit, definition);
      }
    }
  }

  private updateAreaBuffs(unit: RuntimeUnit): void {
    const canReceiveNewEffects = unit.action !== "tunneling";
    let lavaDuration = 0;
    let lavaDamage = 0;
    if (canReceiveNewEffects) {
      for (const prop of this.lavaProps) {
        if (!prop.active || !circleOverlapsRegion(unit, unit.radius, prop.shape)) continue;
        lavaDuration = Math.max(lavaDuration, prop.buffDuration ?? 3);
        lavaDamage = Math.max(lavaDamage, prop.effectPerSecond ?? 5);
      }
    }
    const wasBurning = this.time < unit.burnUntil;
    if (lavaDuration > 0) {
      unit.burnUntil = this.time + lavaDuration;
      unit.burnDamagePerSecond = lavaDamage;
      if (!wasBurning) unit.nextBurnFeedbackAt = this.time + 1;
    }
    if (this.time <= unit.burnUntil + EPSILON && unit.burnDamagePerSecond > 0) {
      while (
        unit.nextBurnFeedbackAt > 0 &&
        this.time + EPSILON >= unit.nextBurnFeedbackAt &&
        unit.nextBurnFeedbackAt <= unit.burnUntil + EPSILON
      ) {
        const amount = unit.burnDamagePerSecond;
        this.damageUnit(unit.id, amount, undefined, "existingBuff");
        if (unit.action === "dead") break;
        this.emit(
          "damage",
          `${unit.name} 的燃烧每秒结算，损失 ${amount.toFixed(1)} 点血`,
          unit,
          undefined,
          "lava",
          -amount,
        );
        unit.nextBurnFeedbackAt += 1;
      }
    }
    if (unit.action === "dead") return;

    let springDuration = 0;
    let springHealing = 0;
    if (canReceiveNewEffects) {
      for (const prop of this.springProps) {
        if (!prop.active || !circleOverlapsRegion(unit, unit.radius, prop.shape)) continue;
        springDuration = Math.max(springDuration, prop.buffDuration ?? 3);
        springHealing = Math.max(springHealing, prop.effectPerSecond ?? 5);
      }
    }
    const hadSpringBuff = this.time < unit.springUntil;
    if (springDuration > 0) {
      unit.springUntil = this.time + springDuration;
      unit.springHealPerSecond = springHealing;
      if (!hadSpringBuff) unit.nextSpringFeedbackAt = this.time + 1;
    }
    if (this.time <= unit.springUntil + EPSILON && unit.springHealPerSecond > 0) {
      while (
        unit.nextSpringFeedbackAt > 0 &&
        this.time + EPSILON >= unit.nextSpringFeedbackAt &&
        unit.nextSpringFeedbackAt <= unit.springUntil + EPSILON
      ) {
        const amount = Math.min(unit.springHealPerSecond, unit.maxHp - unit.hp);
        if (amount > 0) {
          unit.hp += amount;
          this.emit(
            "heal",
            `${unit.name} 的温泉回血每秒结算，回复 ${amount.toFixed(1)} 点血`,
            unit,
            undefined,
            "spring",
            amount,
          );
        }
        unit.nextSpringFeedbackAt += 1;
      }
    }
  }

  private updateSpecialAbility(
    unit: RuntimeUnit,
    definition: CharacterDefinition,
    dt: number,
  ): void {
    if (definition.pluginId === "panda") this.updatePanda(unit, definition);
    if (definition.pluginId === "mole") this.updateMole(unit);
    if (definition.pluginId === "police" && definition.policeStar === 5) {
      this.updateGatling(unit, definition, dt);
    }
  }

  private updatePanda(unit: RuntimeUnit, definition: CharacterDefinition): void {
    const parameters = definition.skillParameters?.panda;
    if (
      unit.action !== "move" &&
      unit.action !== "attack" &&
      unit.action !== "hurt"
    ) {
      return;
    }
    if (unit.hp >= unit.maxHp || this.time < unit.nextEatAt) return;
    const bamboo = this.bambooProps.find(
      (prop) =>
        prop.active &&
        !this.reservedBambooIds.has(prop.id) &&
        circleOverlapsRegion(unit, unit.radius + (parameters?.bambooExtraRange ?? 0), prop.shape),
    );
    if (!bamboo) return;
    unit.meleeTargetId = undefined;
    unit.action = "eating";
    unit.actionStartedAt = this.time;
    unit.actionUntil = this.time + (parameters?.eatDuration ?? 5);
    unit.reservedBambooId = bamboo.id;
    this.reservedBambooIds.add(bamboo.id);
    this.emit("skill", `${unit.name} 抱住竹子，开始猛吃`, unit, undefined, "chew");
  }

  private updatePandaBambooRespawn(): void {
    const pandas = this.orderedUnits().filter((unit) => {
      if (unit.hp <= 0 || unit.action === "dead") return false;
      return this.definitions.get(unit.definitionId)?.pluginId === "panda";
    });
    if (!pandas.length) {
      this.nextBambooRespawnAt = undefined;
      return;
    }

    const configurations = pandas.map((panda) => {
      const parameters = this.definitions.get(panda.definitionId)?.skillParameters?.panda;
      return {
        interval: Math.max(0.1, parameters?.bambooRespawnInterval ?? 15),
        limit: Math.max(0, Math.round(parameters?.bambooRespawnLimit ?? 3)),
      };
    });
    const interval = Math.min(...configurations.map((item) => item.interval));
    const limit = Math.max(...configurations.map((item) => item.limit));
    const activeBamboo = this.bambooProps.filter((prop) => prop.active);
    if (activeBamboo.length > limit) {
      const keepIds = new Set(
        Array.from({ length: limit }, (_, index) => {
          const evenlySpacedIndex = Math.min(
            activeBamboo.length - 1,
            Math.floor((index * activeBamboo.length) / Math.max(1, limit)),
          );
          return activeBamboo[evenlySpacedIndex]?.id;
        }).filter((id): id is string => Boolean(id)),
      );
      for (const bamboo of activeBamboo) {
        if (!keepIds.has(bamboo.id)) bamboo.active = false;
      }
    }
    this.nextBambooRespawnAt ??= this.time + interval;
    if (this.time + EPSILON < this.nextBambooRespawnAt) return;
    this.nextBambooRespawnAt = this.time + interval;
    if (limit <= 0) return;
    const activeBambooCount = this.bambooProps.filter((prop) => prop.active).length;
    if (activeBambooCount >= limit) return;

    let bamboo = this.bambooProps.find(
      (prop) => !prop.active && !this.reservedBambooIds.has(prop.id),
    );
    if (bamboo) {
      bamboo.active = true;
    } else {
      const radius = 78;
      let position = {
        x: radius + this.random.next() * Math.max(1, this.board.width - radius * 2),
        y: radius + this.random.next() * Math.max(1, this.board.height - radius * 2),
      };
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const candidate = {
          x: radius + this.random.next() * Math.max(1, this.board.width - radius * 2),
          y: radius + this.random.next() * Math.max(1, this.board.height - radius * 2),
        };
        const overlapsHazard = [...this.lavaProps, ...this.springProps].some((prop) =>
          circleOverlapsRegion(candidate, radius, prop.shape),
        );
        const overlapsBamboo = this.bambooProps.some(
          (prop) =>
            prop.active &&
            prop.shape.kind === "circle" &&
            distance(candidate, prop.shape) < radius + prop.shape.radius + 40,
        );
        if (!overlapsHazard && !overlapsBamboo) {
          position = candidate;
          break;
        }
      }
      bamboo = {
        id: this.nextId("bamboo-refresh"),
        type: "bamboo",
        active: true,
        shape: { kind: "circle", ...position, radius },
        label: "熊猫补给竹子",
      };
      this.props.push(bamboo);
      this.bambooProps.push(bamboo);
    }
    this.emit(
      "skill",
      `${pandas[0].name} 在场，地图补充了一份竹子`,
      pandas[0],
      undefined,
      "heal",
    );
  }

  private updateMole(unit: RuntimeUnit): void {
    if (unit.action === "tunneling") {
      this.updateMoleTunnelPosition(unit);
      return;
    }
    if (unit.action !== "move" && unit.action !== "attack" && unit.action !== "hurt") return;
    const definition = this.definitions.get(unit.definitionId);
    if (!definition) return;
    const parameters = definition.skillParameters?.mole;
    const availableHoles = [...this.holes.values()];
    const currentHole = availableHoles.find(
      (hole) => distance(unit, hole) <= hole.radius + unit.radius,
    );
    const justEntered = Boolean(currentHole && currentHole.id !== unit.lastHoleId);

    if (!currentHole) {
      unit.lastHoleId = undefined;
    } else {
      unit.lastHoleId = currentHole.id;
      if (this.time >= unit.nextAmbushAt) {
        const ambushHoles =
          availableHoles.length > 1
            ? availableHoles.filter((hole) => hole.id !== currentHole.id)
            : [currentHole];
        const candidates = ambushHoles
          .flatMap((hole) =>
            this.validTargets(unit, parameters?.ambushRange ?? definition.attack.range, hole).map((target) => ({
              hole,
              target,
            })),
          );
        const selection = this.random.pick(candidates);
        if (selection) {
          const origin = { x: unit.x, y: unit.y };
          const destination = { x: selection.hole.x, y: selection.hole.y };
          const travelStartedAt = this.time + MOLE_TUNNEL_ENTRY_DURATION;
          const arrivalAt =
            travelStartedAt +
            this.moleTunnelTravelDuration(definition, origin, destination);
          const attackAt = arrivalAt + MOLE_TUNNEL_ATTACK_WINDUP;
          unit.meleeTargetId = undefined;
          unit.action = "tunneling";
          unit.actionStartedAt = this.time;
          unit.actionUntil = Math.max(
            attackAt + MOLE_TUNNEL_EXIT_DURATION,
            this.time + (parameters?.tunnelDuration ?? 1),
          );
          unit.targetable = false;
          unit.tunnelData = {
            mode: "ambush",
            origin,
            destination,
            travelStartedAt,
            arrivalAt,
            attackAt,
            destinationHoleId: selection.hole.id,
            targetId: selection.target.id,
            hitSucceeded: false,
          };
          this.enqueueShot({
            id: this.nextId("ambush"),
            at: attackAt,
            sourceId: unit.id,
            targetId: selection.target.id,
            from: destination,
            damage: definition.attack.damage,
            range: parameters?.ambushRange ?? definition.attack.range,
            ambush: true,
          });
          this.emit(
            "skill",
            selection.hole.id === currentHole.id
              ? `${unit.name} 钻入脚下洞口，准备从同一洞口突袭`
              : `${unit.name} 潜入地道，准备从另一处洞口偷袭`,
            unit,
            selection.target,
            "tunnel",
          );
          return;
        }
      }

      if (
        justEntered &&
        availableHoles.length >= 2 &&
        this.random.next() < (parameters?.tunnelChance ?? 0.2)
      ) {
        const destination = this.random.pick(
          availableHoles.filter((hole) => hole.id !== currentHole.id),
        );
        if (destination) {
          const origin = { x: unit.x, y: unit.y };
          const destinationPosition = { x: destination.x, y: destination.y };
          const travelStartedAt = this.time + MOLE_TUNNEL_ENTRY_DURATION;
          const arrivalAt =
            travelStartedAt +
            this.moleTunnelTravelDuration(
              definition,
              origin,
              destinationPosition,
            );
          unit.meleeTargetId = undefined;
          unit.action = "tunneling";
          unit.actionStartedAt = this.time;
          unit.actionUntil = Math.max(
            arrivalAt + MOLE_TUNNEL_EXIT_DURATION,
            this.time + (parameters?.tunnelDuration ?? 1),
          );
          unit.targetable = false;
          unit.tunnelData = {
            mode: "travel",
            origin,
            destination: destinationPosition,
            travelStartedAt,
            arrivalAt,
            destinationHoleId: destination.id,
          };
          this.emit("skill", `${unit.name} 随机钻向另一处洞口`, unit, undefined, "tunnel");
          return;
        }
      }
    }

    if (this.time < unit.nextDigAt) return;
    const farEnough = [...this.holes.values()].every(
      (hole) => distance(unit, hole) >= (parameters?.minimumHoleDistance ?? 220),
    );
    if (!farEnough) return;
    unit.meleeTargetId = undefined;
    unit.action = "digging";
    unit.actionStartedAt = this.time;
    unit.actionUntil = this.time + (parameters?.digDuration ?? 0.6);
    unit.digPosition = { x: unit.x, y: unit.y };
    this.emit("skill", `${unit.name} 开始挖洞`, unit, undefined, "dig");
  }

  private updateMoleTunnelPosition(unit: RuntimeUnit): void {
    const tunnel = unit.tunnelData;
    if (!tunnel) return;
    if (this.time < tunnel.arrivalAt) {
      unit.x = tunnel.origin.x;
      unit.y = tunnel.origin.y;
      return;
    }
    if (
      tunnel.hitSucceeded &&
      tunnel.returnDestination &&
      tunnel.returnArrivalAt !== undefined &&
      this.time >= tunnel.returnArrivalAt
    ) {
      unit.x = tunnel.returnDestination.x;
      unit.y = tunnel.returnDestination.y;
      return;
    }
    unit.x = tunnel.destination.x;
    unit.y = tunnel.destination.y;
  }

  private moleTunnelTravelDuration(
    definition: CharacterDefinition,
    origin: Vec2,
    destination: Vec2,
  ): number {
    const parameters = definition.skillParameters?.mole;
    const multiplier = Math.max(
      0.1,
      parameters?.tunnelSpeedMultiplier ?? 2.5,
    );
    const tunnelSpeed = definition.speed * multiplier;
    if (tunnelSpeed <= EPSILON) {
      return Math.max(
        MIN_MOLE_TUNNEL_TRAVEL_DURATION,
        parameters?.tunnelDuration ?? 1,
      );
    }
    return Math.max(
      MIN_MOLE_TUNNEL_TRAVEL_DURATION,
      distance(origin, destination) / tunnelSpeed,
    );
  }

  private updateGatling(
    unit: RuntimeUnit,
    definition: CharacterDefinition,
    dt: number,
  ): void {
    const gatling = unit.gatling;
    if (
      !gatling ||
      unit.action === "kick" ||
      unit.action === "reloading" ||
      unit.action === "dead"
    ) {
      return;
    }
    const attack = definition.attack;
    const shotCount = Math.min(
      MAX_SHOTS_PER_BURST,
      Math.max(1, Math.round(attack.burstCount ?? 18)),
    );
    const shotGap = Math.max(EPSILON, attack.burstGap ?? 0.2);

    gatling.nextRoundIn = Math.max(0, gatling.nextRoundIn - dt);
    if (gatling.ammoRemaining <= 0) {
      this.startGatlingReload(unit, definition);
      return;
    }
    if (gatling.shotsRemaining <= 0) {
      if (gatling.nextRoundIn > EPSILON) return;
      const target = this.random.pick(this.validTargets(unit, attack.range));
      if (!target) {
        gatling.nextRoundIn = 0.1;
        return;
      }
      gatling.roundDirection = normalize({
        x: target.x - unit.x,
        y: target.y - unit.y,
      });
      gatling.roundTargetId = target.id;
      gatling.shotsRemaining = Math.min(shotCount, gatling.ammoRemaining);
      gatling.nextShotIn = Math.max(0, attack.windup);
      gatling.nextRoundIn = Math.max(0.1, attack.cooldown);
      this.emit(
        "skill",
        `${unit.name} 锁定 ${target.name} 的方向，开始一轮 ${gatling.shotsRemaining} 发连射`,
        unit,
        target,
        "gatling",
      );
    }

    gatling.nextShotIn -= dt;
    let shotsThisStep = 0;
    while (
      gatling.nextShotIn <= EPSILON &&
      gatling.shotsRemaining > 0 &&
      gatling.roundDirection &&
      shotsThisStep < MAX_GATLING_SHOTS_PER_STEP
    ) {
      const target = gatling.roundTargetId
        ? this.units.get(gatling.roundTargetId)
        : undefined;
      this.launchProjectileInDirection(
        unit,
        gatling.roundDirection,
        definition,
        target,
      );
      unit.action = "attack";
      unit.actionStartedAt = this.time;
      unit.actionUntil = Math.max(unit.actionUntil, this.time + 0.16);
      gatling.shotsRemaining -= 1;
      gatling.ammoRemaining = Math.max(0, gatling.ammoRemaining - 1);
      gatling.nextShotIn += shotGap;
      shotsThisStep += 1;
    }
    if (
      gatling.shotsRemaining > 0 &&
      gatling.nextShotIn <= EPSILON &&
      shotsThisStep >= MAX_GATLING_SHOTS_PER_STEP
    ) {
      gatling.nextShotIn = 0;
    }
    if (gatling.shotsRemaining <= 0) {
      gatling.roundDirection = undefined;
      gatling.roundTargetId = undefined;
      gatling.nextShotIn = 0;
      if (gatling.ammoRemaining <= 0) {
        this.startGatlingReload(unit, definition);
      }
    }
  }

  private startGatlingReload(
    unit: RuntimeUnit,
    definition: CharacterDefinition,
  ): void {
    const gatling = unit.gatling;
    if (!gatling || unit.action === "reloading" || gatling.ammoRemaining > 0) {
      return;
    }
    gatling.shotsRemaining = 0;
    gatling.nextShotIn = 0;
    gatling.roundDirection = undefined;
    gatling.roundTargetId = undefined;
    unit.action = "reloading";
    unit.actionStartedAt = this.time;
    unit.actionUntil =
      this.time +
      Math.max(
        0.05,
        definition.skillParameters?.police?.gatlingReloadDuration ?? 3,
      );
    this.emit(
      "skill",
      `${unit.name} 弹仓打空，开始更换加特林弹链`,
      unit,
      undefined,
      "reload",
    );
  }

  private completeTimedActions(): void {
    for (const unit of this.units.values()) {
      if (unit.actionUntil <= 0 || this.time < unit.actionUntil) continue;
      if (unit.action === "entering") {
        unit.targetable = true;
        unit.action = "move";
        unit.actionStartedAt = this.time;
        unit.actionUntil = 0;
      } else if (unit.action === "eating") {
        const definition = this.definitions.get(unit.definitionId);
        const parameters = definition?.skillParameters?.panda;
        const bamboo = this.props.find((prop) => prop.id === unit.reservedBambooId);
        let ateBamboo = false;
        if (bamboo?.active) {
          bamboo.active = false;
          ateBamboo = true;
          const amount = Math.min(parameters?.eatHeal ?? 100, unit.maxHp - unit.hp);
          unit.hp += amount;
          unit.nextEatAt = this.time + (parameters?.eatCooldown ?? 5);
          this.emit(
            "heal",
            `${unit.name} 吃完竹子，回复 ${Math.round(amount)} 点血`,
            unit,
            undefined,
            "heal",
            amount,
          );
          this.emit("prop", `${bamboo.label ?? "竹子"} 被吃光了`, unit);
        }
        if (unit.reservedBambooId) {
          this.reservedBambooIds.delete(unit.reservedBambooId);
        }
        unit.reservedBambooId = undefined;
        if (ateBamboo) {
          unit.action = "satisfied";
          unit.actionStartedAt = this.time;
          unit.actionUntil = this.time + 0.65;
        } else {
          this.resetAction(unit);
        }
      } else if (unit.action === "digging") {
        const definition = this.definitions.get(unit.definitionId);
        const parameters = definition?.skillParameters?.mole;
        const position = unit.digPosition ?? { x: unit.x, y: unit.y };
        const hole: RuntimeHole = {
          id: this.nextId("hole"),
          ownerId: unit.ownerId,
          x: position.x,
          y: position.y,
          radius: parameters?.holeRadius ?? 80,
          bornAt: this.time,
        };
        this.holes.set(hole.id, hole);
        unit.lastHoleId = hole.id;
        unit.digPosition = undefined;
        unit.nextDigAt =
          this.time + Math.max(0, parameters?.digCooldown ?? 10);
        this.emit("prop", `${unit.name} 挖出了一处新洞`, unit, undefined, "dig");
        this.resetAction(unit);
      } else if (unit.action === "tunneling") {
        const tunnel = unit.tunnelData;
        const completedAmbush = tunnel?.mode === "ambush";
        if (tunnel) {
          if (tunnel.mode === "travel") {
            unit.x = tunnel.destination.x;
            unit.y = tunnel.destination.y;
            unit.lastHoleId = tunnel.destinationHoleId;
          } else if (tunnel.hitSucceeded && tunnel.returnDestination) {
            unit.x = tunnel.returnDestination.x;
            unit.y = tunnel.returnDestination.y;
            unit.lastHoleId = tunnel.returnHoleId;
          } else {
            unit.x = tunnel.destination.x;
            unit.y = tunnel.destination.y;
            unit.lastHoleId = tunnel.destinationHoleId;
          }
        }
        unit.targetable = true;
        unit.tunnelData = undefined;
        if (completedAmbush) {
          const definition = this.definitions.get(unit.definitionId);
          unit.nextAmbushAt =
            this.time +
            Math.max(
              0,
              definition?.skillParameters?.mole?.ambushCooldown ?? 3,
            );
        }
        this.emit("sound", `${unit.name} 钻出地面`, unit, undefined, "tunnel");
        this.resetAction(unit);
      } else if (unit.action === "reloading") {
        const definition = this.definitions.get(unit.definitionId);
        const gatling = unit.gatling;
        if (gatling) {
          gatling.magazineSize = Math.max(
            1,
            Math.round(
              definition?.skillParameters?.police?.gatlingMagazineSize ??
                gatling.magazineSize ??
                150,
            ),
          );
          gatling.ammoRemaining = gatling.magazineSize;
          gatling.nextRoundIn = Math.max(0.08, gatling.nextRoundIn);
        }
        this.emit(
          "sound",
          `${unit.name} 完成换弹`,
          unit,
          undefined,
          "reload",
        );
        this.resetAction(unit);
      } else if (unit.action === "knockback") {
        const knockback = unit.knockbackData;
        if (knockback) {
          unit.x = knockback.destination.x;
          unit.y = knockback.destination.y;
        }
        unit.knockbackData = undefined;
        if (knockback?.hitBoundary) {
          const stunDuration = knockback.wallStunDuration;
          unit.action = "stunned";
          unit.actionStartedAt = this.time;
          unit.stunnedUntil = this.time + Math.max(0, stunDuration);
          unit.actionUntil = unit.stunnedUntil;
          this.emit(
            "skill",
            `${unit.name} 被踹到边界，眩晕 ${stunDuration.toFixed(1)} 秒`,
            unit,
            undefined,
            "kick",
          );
          if (stunDuration <= EPSILON) this.resetAction(unit);
        } else {
          this.resetAction(unit);
        }
      } else if (unit.action === "stunned") {
        unit.stunnedUntil = 0;
        this.resetAction(unit);
      } else if (
        unit.action === "kick" ||
        unit.action === "attack" ||
        unit.action === "hurt" ||
        unit.action === "satisfied" ||
        unit.action === "merge" ||
        unit.action === "kill"
      ) {
        this.resetAction(unit);
      }
    }
  }

  private resetAction(unit: RuntimeUnit): void {
    unit.meleeTargetId = undefined;
    this.rerollMovementDirection(unit);
    unit.action = "move";
    unit.actionStartedAt = this.time;
    unit.actionUntil = 0;
  }

  private createHorizontalBiasedDirection(preferredHorizontal?: number): Vec2 {
    const horizontalSign =
      preferredHorizontal !== undefined && Math.abs(preferredHorizontal) > EPSILON
        ? Math.sign(preferredHorizontal)
        : this.random.next() < 0.5
          ? -1
          : 1;
    const verticalSign = this.random.next() < 0.5 ? -1 : 1;
    const deviationProgress =
      this.random.next() ** HORIZONTAL_DEVIATION_BIAS_POWER;
    const deviation =
      MIN_HORIZONTAL_DEVIATION_RADIANS +
      deviationProgress *
        (MAX_HORIZONTAL_DEVIATION_RADIANS - MIN_HORIZONTAL_DEVIATION_RADIANS);
    const horizontalAngle = horizontalSign < 0 ? Math.PI : 0;
    const angle = horizontalAngle + verticalSign * deviation;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  }

  private rerollMovementDirection(unit: RuntimeUnit): void {
    const definition = this.definitions.get(unit.definitionId);
    if (!definition || definition.speed <= EPSILON) return;
    const direction = this.createHorizontalBiasedDirection(unit.vx);
    unit.vx = direction.x * definition.speed;
    unit.vy = direction.y * definition.speed;
  }

  private moveUnit(unit: RuntimeUnit, dt: number, speed: number): void {
    const direction = normalize({ x: unit.vx, y: unit.vy });
    unit.vx = direction.x * speed;
    unit.vy = direction.y * speed;
    unit.x += unit.vx * dt;
    unit.y += unit.vy * dt;

    if (unit.x - unit.radius < 0) {
      unit.x = unit.radius;
      unit.vx = Math.abs(unit.vx);
    } else if (unit.x + unit.radius > this.board.width) {
      unit.x = this.board.width - unit.radius;
      unit.vx = -Math.abs(unit.vx);
    }
    if (unit.y - unit.radius < 0) {
      unit.y = unit.radius;
      unit.vy = Math.abs(unit.vy);
    } else if (unit.y + unit.radius > this.board.height) {
      unit.y = this.board.height - unit.radius;
      unit.vy = -Math.abs(unit.vy);
    }
  }

  private updateMeleeApproach(
    unit: RuntimeUnit,
    definition: CharacterDefinition,
    dt: number,
  ): void {
    const target = unit.meleeTargetId
      ? this.units.get(unit.meleeTargetId)
      : undefined;
    if (!this.isChaseableMeleeTarget(unit, target)) {
      this.resetAction(unit);
      return;
    }
    if (
      this.meleeSurfaceGap(unit, target) >
      this.meleePursuitLimit(unit, definition) + EPSILON
    ) {
      this.resetAction(unit);
      return;
    }

    this.moveTowardMeleeContact(unit, target, dt, definition.speed);
    if (this.isMeleeContact(unit, target)) {
      this.startAttack(unit, definition, target);
    }
  }

  private updateMeleeStrikeContact(
    unit: RuntimeUnit,
    definition: CharacterDefinition,
    dt: number,
  ): void {
    const target = unit.meleeTargetId
      ? this.units.get(unit.meleeTargetId)
      : undefined;
    if (!this.isChaseableMeleeTarget(unit, target)) {
      unit.meleeTargetId = undefined;
      return;
    }
    if (
      this.meleeSurfaceGap(unit, target) >
      this.meleePursuitLimit(unit, definition) + EPSILON
    ) {
      unit.meleeTargetId = undefined;
      return;
    }
    const targetSpeed = Math.hypot(target.vx, target.vy);
    this.moveTowardMeleeContact(
      unit,
      target,
      dt,
      Math.max(0, definition.speed) + targetSpeed,
    );
  }

  private meleePursuitLimit(
    unit: RuntimeUnit,
    definition: CharacterDefinition,
  ): number {
    return (
      Math.max(0, definition.attack.range) +
      Math.max(MIN_MELEE_PURSUIT_BUFFER, unit.radius * 0.5)
    );
  }

  private moveTowardMeleeContact(
    unit: RuntimeUnit,
    target: RuntimeUnit,
    dt: number,
    speed: number,
  ): void {
    const offset = { x: target.x - unit.x, y: target.y - unit.y };
    const centerDistance = Math.hypot(offset.x, offset.y);
    const direction =
      centerDistance > EPSILON
        ? { x: offset.x / centerDistance, y: offset.y / centerDistance }
        : normalize({ x: unit.vx, y: unit.vy });
    unit.vx = direction.x * speed;
    unit.vy = direction.y * speed;
    const remainingGap = Math.max(
      0,
      centerDistance - unit.radius - target.radius,
    );
    const travelDistance = Math.min(
      remainingGap,
      Math.max(0, speed) * Math.max(0, dt),
    );
    unit.x = Math.max(
      unit.radius,
      Math.min(
        this.board.width - unit.radius,
        unit.x + direction.x * travelDistance,
      ),
    );
    unit.y = Math.max(
      unit.radius,
      Math.min(
        this.board.height - unit.radius,
        unit.y + direction.y * travelDistance,
      ),
    );
  }

  private updateKnockbackPosition(unit: RuntimeUnit): void {
    const knockback = unit.knockbackData;
    if (!knockback) return;
    const duration = Math.max(
      EPSILON,
      knockback.arrivalAt - knockback.startedAt,
    );
    const progress = Math.max(
      0,
      Math.min(1, (this.time - knockback.startedAt) / duration),
    );
    const eased = 1 - (1 - progress) ** 3;
    unit.x =
      knockback.origin.x +
      (knockback.destination.x - knockback.origin.x) * eased;
    unit.y =
      knockback.origin.y +
      (knockback.destination.y - knockback.origin.y) * eased;
  }

  private canBeginAttack(unit: RuntimeUnit): boolean {
    return (
      unit.targetable &&
      unit.action !== "eating" &&
      unit.action !== "satisfied" &&
      unit.action !== "meleeApproach" &&
      unit.action !== "digging" &&
      unit.action !== "tunneling" &&
      unit.action !== "reloading" &&
      unit.action !== "kick" &&
      unit.action !== "knockback" &&
      unit.action !== "stunned" &&
      this.time >= unit.nextAttackAt
    );
  }

  private beginAttack(unit: RuntimeUnit, definition: CharacterDefinition): void {
    const target = this.random.pick(this.validAttackTargets(unit, definition));
    if (!target) return;
    if (definition.attack.mode === "melee") {
      unit.meleeTargetId = target.id;
      if (this.isMeleeContact(unit, target)) {
        this.startAttack(unit, definition, target);
      } else {
        unit.action = "meleeApproach";
        unit.actionStartedAt = this.time;
        unit.actionUntil = 0;
        this.moveTowardMeleeContact(unit, target, 0, definition.speed);
      }
      return;
    }
    this.startAttack(unit, definition, target);
  }

  private startAttack(
    unit: RuntimeUnit,
    definition: CharacterDefinition,
    target: RuntimeUnit,
  ): void {
    const attack = definition.attack;
    if (attack.mode !== "melee") unit.meleeTargetId = undefined;
    unit.action = "attack";
    unit.actionStartedAt = this.time;
    unit.actionUntil = this.time + Math.max(0.28, attack.windup + 0.18);
    unit.nextAttackAt = this.time + attack.cooldown;
    const count =
      attack.mode === "burst"
        ? Math.min(MAX_SHOTS_PER_BURST, Math.max(1, Math.round(attack.burstCount ?? 3)))
        : 1;
    const gap = Math.max(0, attack.burstGap ?? 0);
    for (let index = 0; index < count; index += 1) {
      if (
        !this.enqueueShot({
        id: this.nextId("shot"),
        at: this.time + attack.windup + gap * index,
        sourceId: unit.id,
        targetId: target.id,
        })
      ) {
        break;
      }
    }
  }

  private processScheduledShots(dt: number): void {
    let processed = 0;
    while (
      this.scheduledShots[0]?.at <= this.time + EPSILON &&
      processed < MAX_SCHEDULED_SHOTS_PER_STEP
    ) {
      const shot = this.popScheduledShot();
      if (!shot) break;
      processed += 1;
      const source = this.units.get(shot.sourceId);
      const target = this.units.get(shot.targetId);
      if (
        !source ||
        source.action === "dead" ||
        source.action === "knockback" ||
        source.action === "stunned"
      ) {
        continue;
      }
      const definition = this.definitions.get(source.definitionId);
      if (!definition) continue;

      if (shot.ambush) {
        const tunnel = source.tunnelData;
        if (
          !target ||
          !target.targetable ||
          source.action !== "tunneling" ||
          tunnel?.mode !== "ambush"
        ) {
          if (tunnel?.mode === "ambush") {
            tunnel.hitSucceeded = false;
            source.actionUntil = Math.min(source.actionUntil, this.time + 0.18);
          }
          continue;
        }
        const origin = shot.from ?? source;
        if (distance(origin, target) <= (shot.range ?? definition.attack.range) + target.radius) {
          this.damageUnit(
            target.id,
            shot.damage ?? definition.attack.damage,
            source.id,
            "directAttack",
          );
          this.emit("attack", `${source.name} 从洞口偷袭 ${target.name}`, source, target, "swipe");
          this.runModules(source, "onAttack");
          tunnel.hitSucceeded = true;
          const returnHole = this.random.pick([...this.holes.values()]);
          if (returnHole) {
            tunnel.returnDestination = { x: returnHole.x, y: returnHole.y };
            tunnel.returnHoleId = returnHole.id;
            tunnel.returnStartedAt = this.time + MOLE_TUNNEL_RETURN_DELAY;
            tunnel.returnArrivalAt =
              tunnel.returnStartedAt +
              this.moleTunnelTravelDuration(
                definition,
                tunnel.destination,
                tunnel.returnDestination,
              );
            source.actionUntil = Math.max(
              source.actionUntil,
              tunnel.returnArrivalAt + MOLE_TUNNEL_EXIT_DURATION,
            );
          }
        } else {
          tunnel.hitSucceeded = false;
          source.actionUntil = Math.min(source.actionUntil, this.time + 0.18);
        }
        continue;
      }

      if (!target || !target.targetable) continue;
      if (definition.attack.mode === "melee") {
        if (
          source.action === "attack" &&
          source.meleeTargetId === target.id
        ) {
          this.moveTowardMeleeContact(
            source,
            target,
            dt,
            Math.max(0, definition.speed) + Math.hypot(target.vx, target.vy),
          );
        }
        if (
          source.action === "attack" &&
          source.meleeTargetId === target.id &&
          this.isValidMeleeTarget(source, target, definition)
        ) {
          this.damageUnit(target.id, definition.attack.damage, source.id, "directAttack");
          this.emit(
            "attack",
            `${source.name} 命中 ${target.name}，造成 ${definition.attack.damage} 点伤害`,
            source,
            target,
            definition.sounds.attack?.preset ?? "swipe",
          );
          this.runModules(source, "onAttack");
        }
      } else {
        this.launchProjectile(source, target, definition);
        this.runModules(source, "onAttack");
      }
    }
  }

  private enqueueShot(shot: Omit<ScheduledShot, "sequence">): boolean {
    if (this.scheduledShots.length >= MAX_QUEUED_SHOTS) {
      this.droppedShots += 1;
      return false;
    }
    const queued: ScheduledShot = {
      ...shot,
      sequence: this.scheduledSequence,
    };
    this.scheduledSequence += 1;
    this.scheduledShots.push(queued);
    let index = this.scheduledShots.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.shotComesBefore(queued, this.scheduledShots[parent])) break;
      this.scheduledShots[index] = this.scheduledShots[parent];
      index = parent;
    }
    this.scheduledShots[index] = queued;
    return true;
  }

  private popScheduledShot(): ScheduledShot | undefined {
    const first = this.scheduledShots[0];
    const last = this.scheduledShots.pop();
    if (!first || !last || this.scheduledShots.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.scheduledShots.length) break;
      let child = left;
      if (
        right < this.scheduledShots.length &&
        this.shotComesBefore(this.scheduledShots[right], this.scheduledShots[left])
      ) {
        child = right;
      }
      if (!this.shotComesBefore(this.scheduledShots[child], last)) break;
      this.scheduledShots[index] = this.scheduledShots[child];
      index = child;
    }
    this.scheduledShots[index] = last;
    return first;
  }

  private shotComesBefore(left: ScheduledShot, right: ScheduledShot): boolean {
    return left.at < right.at || (left.at === right.at && left.sequence < right.sequence);
  }

  private purgeScheduledShots(unitIds: Set<string>): void {
    if (!unitIds.size || !this.scheduledShots.length) return;
    const remaining = this.scheduledShots.filter(
      (shot) => !unitIds.has(shot.sourceId) && !unitIds.has(shot.targetId),
    );
    if (remaining.length === this.scheduledShots.length) return;
    remaining.sort((left, right) => left.at - right.at || left.sequence - right.sequence);
    this.scheduledShots.length = 0;
    this.scheduledShots.push(...remaining);
  }

  private launchProjectile(
    source: RuntimeUnit,
    target: RuntimeUnit,
    definition: CharacterDefinition,
  ): void {
    const direction = normalize({ x: target.x - source.x, y: target.y - source.y });
    this.launchProjectileInDirection(source, direction, definition, target);
  }

  private launchProjectileInDirection(
    source: RuntimeUnit,
    direction: Vec2,
    definition: CharacterDefinition,
    target?: RuntimeUnit,
  ): void {
    if (
      this.projectiles.size >= MAX_ACTIVE_PROJECTILES ||
      this.projectilesCreatedThisStep >= MAX_PROJECTILES_PER_STEP
    ) {
      this.droppedProjectiles += 1;
      return;
    }
    const attack = definition.attack;
    const speed = attack.projectileSpeed ?? 650;
    const kind = attack.projectileKind ?? "bullet";
    const spreadRadians =
      Math.max(0, attack.spreadDegrees ?? 0) * (Math.PI / 180);
    const spreadOffset =
      spreadRadians > 0 ? (this.random.next() * 2 - 1) * spreadRadians : 0;
    const directionAngle = Math.atan2(direction.y, direction.x) + spreadOffset;
    const shotDirection = {
      x: Math.cos(directionAngle),
      y: Math.sin(directionAngle),
    };
    const projectile: RuntimeProjectile = {
      id: this.nextId(kind),
      ownerId: source.ownerId,
      factionId: source.factionId,
      sourceUnitId: source.id,
      kind,
      bornAt: this.time,
      ...(kind === "rocket"
        ? {
            boostAt:
              this.time + Math.max(0, attack.projectileBoostAfter ?? 1.5),
            boostMultiplier: Math.max(
              0.1,
              attack.projectileBoostMultiplier ?? 1.5,
            ),
            boosted: false,
          }
        : {}),
      x: source.x + shotDirection.x * (source.radius + 8),
      y: source.y + shotDirection.y * (source.radius + 8),
      vx: shotDirection.x * speed,
      vy: shotDirection.y * speed,
      radius: kind === "rocket" ? 14 : 7,
      damage: attack.damage,
      splashDamage: attack.splashDamage,
      splashRadius: attack.splashRadius,
    };
    this.projectiles.set(projectile.id, projectile);
    this.projectilesCreatedThisStep += 1;
    const sound =
      definition.policeStar === 2
        ? "pistol"
        : definition.policeStar === 3
          ? "rifle"
          : definition.policeStar === 4
            ? "rocket"
            : definition.policeStar === 5
              ? "gatling"
              : definition.sounds.attack?.preset ?? "swipe";
    this.emit(
      "attack",
      target
        ? `${source.name} 向 ${target.name} 的锁定方向开火`
        : `${source.name} 沿锁定方向开火`,
      source,
      target,
      sound,
    );
  }

  private updateProjectiles(dt: number): void {
    for (const projectile of [...this.projectiles.values()]) {
      if (
        projectile.kind === "rocket" &&
        !projectile.boosted &&
        projectile.boostAt !== undefined &&
        this.time + EPSILON >= projectile.boostAt
      ) {
        const multiplier = Math.max(0.1, projectile.boostMultiplier ?? 1.5);
        projectile.vx *= multiplier;
        projectile.vy *= multiplier;
        projectile.boosted = true;
      }
      projectile.x += projectile.vx * dt;
      projectile.y += projectile.vy * dt;

      const outOfBounds =
        projectile.x < -projectile.radius ||
        projectile.x > this.board.width + projectile.radius ||
        projectile.y < -projectile.radius ||
        projectile.y > this.board.height + projectile.radius;
      if (outOfBounds) {
        if (projectile.kind === "rocket") {
          projectile.x = Math.max(0, Math.min(this.board.width, projectile.x));
          projectile.y = Math.max(0, Math.min(this.board.height, projectile.y));
          this.explodeRocket(projectile);
        }
        this.projectiles.delete(projectile.id);
        continue;
      }

      const hit = this.queryUnitCandidates(
        projectile,
        projectile.radius + this.maxUnitRadius,
      ).find(
        (unit) =>
          unit.targetable &&
          unit.factionId !== projectile.factionId &&
          distance(unit, projectile) <= unit.radius + projectile.radius,
      );
      if (!hit) continue;

      if (projectile.kind === "rocket") {
        this.damageUnit(hit.id, projectile.damage, projectile.sourceUnitId, "directAttack");
        this.explodeRocket(projectile, hit.id);
      } else {
        this.damageUnit(hit.id, projectile.damage, projectile.sourceUnitId, "directAttack");
      }
      this.projectiles.delete(projectile.id);
    }
  }

  private explodeRocket(projectile: RuntimeProjectile, directTargetId?: string): void {
    const radius = projectile.splashRadius ?? 150;
    const splash = projectile.splashDamage ?? 50;
    for (const unit of this.queryUnitCandidates(projectile, radius + this.maxUnitRadius)) {
      if (
        !unit.targetable ||
        unit.factionId === projectile.factionId ||
        unit.id === directTargetId
      ) {
        continue;
      }
      if (distance(unit, projectile) <= radius + unit.radius) {
        this.damageUnit(unit.id, splash, projectile.sourceUnitId, "directAttack");
      }
    }
    this.emitAt(
      "attack",
      directTargetId ? "RPG 命中并爆炸" : "RPG 撞上棋盘边界并爆炸",
      projectile.x,
      projectile.y,
      "explosion",
    );
  }

  private damageUnit(
    targetId: string,
    amount: number,
    sourceUnitId: string | undefined,
    source: DamageSource,
  ): void {
    const target = this.units.get(targetId);
    if (!target || target.action === "dead" || amount <= 0) return;
    if (target.action === "tunneling" && source !== "existingBuff") return;
    const sourceUnit = sourceUnitId ? this.units.get(sourceUnitId) : undefined;
    if (
      source !== "environment" &&
      source !== "existingBuff" &&
      sourceUnit &&
      sourceUnit.factionId === target.factionId
    ) {
      return;
    }
    target.hp = Math.max(0, target.hp - amount);
    if (source === "directAttack" || source === "effect") {
      this.emit(
        "damage",
        `${target.name} 受到 ${Math.round(amount)} 点伤害`,
        target,
        sourceUnitId ? this.units.get(sourceUnitId) : undefined,
        "hurt",
        -amount,
      );
      this.runModules(target, "onDamageTaken");
      if (source === "directAttack" && sourceUnitId) {
        this.handleDamagePassive(target, sourceUnitId);
      }
    }
    if (target.hp <= 0) this.killUnit(target, sourceUnitId);
  }

  private handleDamagePassive(
    target: RuntimeUnit,
    sourceUnitId: string | undefined,
  ): void {
    const definition = this.definitions.get(target.definitionId);
    if (!definition || target.hp <= 0) return;
    if (definition.pluginId === "panda" && this.time >= target.nextPandaSummonAt) {
      target.nextPandaSummonAt =
        this.time + (definition.skillParameters?.panda?.policeSummonCooldown ?? 0.5);
      const police = this.spawnPolice(target, 1);
      if (police) {
        target.pandaCallStartedAt = this.time;
        target.pandaCallUntil =
          this.time + (definition.skillParameters?.panda?.policeCallDuration ?? 0.7);
      }
    }
    if (definition.pluginId === "police" && definition.policeStar === 5) {
      const attacker = sourceUnitId ? this.units.get(sourceUnitId) : undefined;
      const gatling = target.gatling;
      const parameters = definition.skillParameters?.police;
      if (
        attacker &&
        attacker.targetable &&
        target.action !== "knockback" &&
        target.action !== "stunned" &&
        gatling &&
        this.time >= gatling.nextKickAt &&
        distance(target, attacker) <= (parameters?.kickRange ?? 160) + attacker.radius
      ) {
        gatling.nextKickAt = this.time + (parameters?.kickCooldown ?? 0.5);
        const direction = normalize({ x: attacker.x - target.x, y: attacker.y - target.y });
        const desiredX =
          attacker.x + direction.x * (parameters?.kickDistance ?? 140);
        const desiredY =
          attacker.y + direction.y * (parameters?.kickDistance ?? 140);
        const destinationX = Math.max(
          attacker.radius,
          Math.min(
            this.board.width - attacker.radius,
            desiredX,
          ),
        );
        const destinationY = Math.max(
          attacker.radius,
          Math.min(
            this.board.height - attacker.radius,
            desiredY,
          ),
        );
        const attackerDefinition = this.definitions.get(attacker.definitionId);
        const speed = attackerDefinition?.speed ?? Math.hypot(attacker.vx, attacker.vy);
        attacker.vx = direction.x * speed;
        attacker.vy = direction.y * speed;
        attacker.meleeTargetId = undefined;
        const kickDuration = Math.max(
          0.05,
          parameters?.kickDuration ?? 0.35,
        );
        attacker.action = "knockback";
        attacker.actionStartedAt = this.time;
        attacker.actionUntil = this.time + kickDuration;
        attacker.knockbackData = {
          origin: { x: attacker.x, y: attacker.y },
          destination: { x: destinationX, y: destinationY },
          startedAt: this.time,
          arrivalAt: this.time + kickDuration,
          hitBoundary:
            Math.abs(destinationX - desiredX) > EPSILON ||
            Math.abs(destinationY - desiredY) > EPSILON,
          wallStunDuration: Math.max(
            0,
            parameters?.kickWallStunDuration ?? 0.5,
          ),
        };
        const kickDamage = Math.max(0, parameters?.kickDamage ?? 25);
        if (kickDamage > EPSILON) {
          this.damageUnit(
            attacker.id,
            kickDamage,
            target.id,
            "directAttack",
          );
        }
        target.meleeTargetId = undefined;
        target.action = "kick";
        target.actionStartedAt = this.time;
        target.actionUntil = this.time + kickDuration;
        this.emit("skill", `${target.name} 一脚踹开 ${attacker.name}`, target, attacker, "kick");
      }
    }
  }

  private spawnPolice(owner: RuntimeUnit, star: 1 | 2 | 3 | 4 | 5): RuntimeUnit | undefined {
    const definition = this.definitions.get(`police-${star}`);
    if (!definition) return undefined;
    if (
      this.unitsSpawnedThisStep >= MAX_UNIT_SPAWNS_PER_STEP ||
      this.units.size >= MAX_ACTIVE_UNITS
    ) {
      this.droppedSpawns += 1;
      return undefined;
    }
    const angle = this.random.angle();
    const spawnDistance =
      owner.radius + definition.radius * (this.board.unitScale ?? 1) + 16;
    const unit = this.createUnit({
      definition,
      ownerId: owner.ownerId,
      factionId: owner.factionId,
      main: false,
      sustainsFaction: true,
      name: `${owner.name}的${star}星警察`,
      x: owner.x + Math.cos(angle) * spawnDistance,
      y: owner.y + Math.sin(angle) * spawnDistance,
      playEntrance: true,
    });
    if (!this.addUnit(unit)) {
      this.droppedSpawns += 1;
      return undefined;
    }
    this.unitsSpawnedThisStep += 1;
    this.emit(
      "spawn",
      `${owner.name} 是保护动物：遭到攻击后，一名人类警察赶来保护`,
      owner,
      unit,
    );
    return unit;
  }

  private mergeCollidingPolice(): void {
    let merges = 0;
    while (merges < MAX_MERGES_PER_STEP) {
      const police = this.orderedUnits().filter(
        (unit) =>
          unit.targetable &&
          unit.policeStar !== undefined &&
          unit.policeStar < 5 &&
          unit.action !== "dead" &&
          unit.action !== "merge",
      );
      const policeOrder = new Map(police.map((unit, index) => [unit.id, index]));
      let pair: [RuntimeUnit, RuntimeUnit] | undefined;

      for (let leftIndex = 0; leftIndex < police.length && !pair; leftIndex += 1) {
        const left = police[leftIndex];
        const owner = this.units.get(left.ownerId);
        const ownerDefinition = owner
          ? this.definitions.get(owner.definitionId)
          : undefined;
        const mergePadding =
          ownerDefinition?.skillParameters?.panda?.policeMergePadding ?? 0;
        const candidates = [
          ...this.queryUnitCandidates(
            left,
            left.radius + this.maxUnitRadius + mergePadding,
          ),
        ].sort(
          (first, second) =>
            (policeOrder.get(first.id) ?? Number.MAX_SAFE_INTEGER) -
            (policeOrder.get(second.id) ?? Number.MAX_SAFE_INTEGER),
        );
        for (const right of candidates) {
          if (
            (policeOrder.get(right.id) ?? -1) <= leftIndex ||
            right.factionId !== left.factionId ||
            right.policeStar !== left.policeStar
          ) {
            continue;
          }
          if (distance(left, right) <= left.radius + right.radius + mergePadding) {
            pair = [left, right];
            break;
          }
        }
      }
      if (!pair) return;

      const [left, right] = pair;
      const star = left.policeStar;
      if (!star || star >= 5) return;
      const nextStar = (star + 1) as 2 | 3 | 4 | 5;
      const definition = this.definitions.get(`police-${nextStar}`);
      if (!definition) return;
      const main = left.main || right.main;
      const mergedId = this.nextId(`police-${nextStar}-merged`);
      const inheritedOwnerId = left.main
        ? left.ownerId
        : right.main
          ? right.ownerId
          : left.ownerId === right.ownerId
            ? left.ownerId
            : left.factionId;
      this.deleteUnit(left.id);
      this.deleteUnit(right.id);
      this.purgeScheduledShots(new Set([left.id, right.id]));
      const merged = this.createUnit({
        id: mergedId,
        definition,
        ownerId: main ? mergedId : inheritedOwnerId,
        factionId: left.factionId,
        main,
        sustainsFaction: left.sustainsFaction || right.sustainsFaction,
        name: main ? `${left.main ? left.name : right.name}★${nextStar}` : `${nextStar}星合体警察`,
        x: (left.x + right.x) / 2,
        y: (left.y + right.y) / 2,
      });
      merged.action = "merge";
      merged.actionStartedAt = this.time;
      merged.actionUntil = this.time + 0.62;
      merged.promotionStartedAt = this.time;
      merged.promotionUntil = this.time + 1.1;
      this.addUnit(merged);
      for (const projectile of this.projectiles.values()) {
        if (projectile.sourceUnitId === left.id || projectile.sourceUnitId === right.id) {
          projectile.sourceUnitId = merged.id;
        }
      }
      if (main) {
        const formerOwnerIds = new Set([left.id, right.id, left.ownerId, right.ownerId]);
        for (const unit of this.units.values()) {
          if (!unit.main && formerOwnerIds.has(unit.ownerId)) unit.ownerId = merged.id;
        }
        for (const hole of this.holes.values()) {
          if (formerOwnerIds.has(hole.ownerId)) hole.ownerId = merged.id;
        }
        for (const projectile of this.projectiles.values()) {
          if (formerOwnerIds.has(projectile.ownerId)) projectile.ownerId = merged.id;
        }
      }
      this.emit(
        "merge",
        `同阵营的两名${star}星警察撞到一起，升为${nextStar}星`,
        merged,
        undefined,
        "merge",
        undefined,
        `升星成功！${nextStar}星警察登场`,
      );
      this.emit(
        "skill",
        `${merged.name} 触发碰撞升星`,
        merged,
        undefined,
        "merge",
      );
      merges += 1;
      this.rebuildSpatialIndex();
    }
  }

  private killUnit(target: RuntimeUnit, sourceUnitId?: string): void {
    if (target.action === "dead") return;
    target.hp = 0;
    target.targetable = false;
    target.meleeTargetId = undefined;
    target.action = "dead";
    target.actionStartedAt = this.time;
    target.actionUntil = this.time + 0.45;
    if (target.reservedBambooId) {
      this.reservedBambooIds.delete(target.reservedBambooId);
      target.reservedBambooId = undefined;
    }
    const removedUnitIds = new Set([target.id]);
    const source = sourceUnitId ? this.units.get(sourceUnitId) : undefined;
    for (const pursuer of this.units.values()) {
      if (pursuer.meleeTargetId !== target.id) continue;
      pursuer.meleeTargetId = undefined;
      if (pursuer.id !== source?.id && pursuer.action === "meleeApproach") {
        this.resetAction(pursuer);
      }
    }
    if (
      source &&
      source.action !== "dead" &&
      source.action !== "tunneling" &&
      source.action !== "knockback" &&
      source.action !== "stunned"
    ) {
      source.action = "kill";
      source.actionStartedAt = this.time;
      source.actionUntil = Math.max(source.actionUntil, this.time + 0.58);
    }
    let announcement: string | undefined;
    let message = source ? `${target.name} 被 ${source.name} 击败` : `${target.name} 倒下了`;
    if (source && target.main) {
      this.lastMainKillerId = source.id;
      const chain = this.recordMainKill(source);
      const chainLabel = this.killChainLabel(chain);
      announcement = `${source.name} 击败了 ${target.name}${chainLabel ? `，完成${chainLabel}` : ""}`;
      message = announcement;
    }
    this.emit(
      "death",
      message,
      target,
      source,
      "death",
      undefined,
      announcement,
    );
    if (source && source.id !== target.id && source.factionId !== target.factionId) {
      this.recordPoliceKill(source);
    }
    this.runModules(target, "onDeath");

    if (target.main) {
      for (const unit of [...this.units.values()]) {
        if (
          !unit.main &&
          unit.ownerId === target.ownerId &&
          !unit.sustainsFaction
        ) {
          removedUnitIds.add(unit.id);
          this.deleteUnit(unit.id);
        }
      }
      for (const hole of [...this.holes.values()]) {
        if (hole.ownerId === target.ownerId) {
          this.holes.delete(hole.id);
        }
      }
    }
    this.purgeScheduledShots(removedUnitIds);
  }

  private recordMainKill(source: RuntimeUnit): number {
    const previous = this.killChains.get(source.id);
    const count =
      previous && this.time - previous.lastKillAt <= 8 + EPSILON ? previous.count + 1 : 1;
    this.killChains.set(source.id, { count, lastKillAt: this.time });
    return count;
  }

  private recordPoliceKill(source: RuntimeUnit): void {
    const currentStar = source.policeStar;
    if (
      !currentStar ||
      currentStar >= 5 ||
      source.hp <= 0 ||
      source.action === "dead"
    ) {
      return;
    }
    const killsRequired = this.policePromotionRequirement(
      currentStar as 1 | 2 | 3 | 4,
    );
    source.policeKillProgress += 1;
    if (source.policeKillProgress < killsRequired) return;
    this.promotePoliceAfterKills(source, killsRequired);
  }

  private policePromotionRequirement(
    currentStar: 1 | 2 | 3 | 4,
  ): number {
    const configured =
      currentStar === 1
        ? this.policePromotion.experienceToStar2
        : currentStar === 2
          ? this.policePromotion.experienceToStar3
          : currentStar === 3
            ? this.policePromotion.experienceToStar4
            : this.policePromotion.experienceToStar5;
    return Math.max(1, Math.round(configured));
  }

  private promotePoliceAfterKills(source: RuntimeUnit, killsRequired: number): void {
    const currentStar = source.policeStar;
    if (!currentStar || currentStar >= 5) return;
    const nextStar = (currentStar + 1) as 2 | 3 | 4 | 5;
    const definition = this.definitions.get(`police-${nextStar}`);
    if (!definition) return;

    const direction = normalize({ x: source.vx, y: source.vy });
    const nextRadius = definition.radius * (this.board.unitScale ?? 1);
    this.purgeScheduledShots(new Set([source.id]));
    source.definitionId = definition.id;
    source.appearanceDefinitionId = definition.id;
    source.policeStar = nextStar;
    source.policeKillProgress = 0;
    source.maxHp = definition.maxHp;
    source.hp = definition.maxHp;
    source.radius = nextRadius;
    source.x = Math.max(nextRadius, Math.min(this.board.width - nextRadius, source.x));
    source.y = Math.max(nextRadius, Math.min(this.board.height - nextRadius, source.y));
    source.vx = direction.x * definition.speed;
    source.vy = direction.y * definition.speed;
    source.nextAttackAt = this.time + 0.4;
    source.meleeTargetId = undefined;
    source.action = "merge";
    source.actionStartedAt = this.time;
    source.actionUntil = this.time + 0.62;
    source.promotionStartedAt = this.time;
    source.promotionUntil = this.time + 1.1;
    source.burnUntil = 0;
    source.burnDamagePerSecond = 0;
    source.springUntil = 0;
    source.springHealPerSecond = 0;
    source.moduleCooldowns = Object.fromEntries(
      definition.abilities.map((ability) => [
        ability.id,
        this.time + (ability.trigger === "interval" ? ability.interval ?? ability.cooldown : 0),
      ]),
    );
    source.gatling =
      nextStar === 5
        ? {
            nextRoundIn: 0.08,
            shotsRemaining: 0,
            nextShotIn: 0,
            nextKickAt: 0,
            magazineSize: Math.max(
              1,
              Math.round(
                definition.skillParameters?.police?.gatlingMagazineSize ?? 150,
              ),
            ),
            ammoRemaining: Math.max(
              1,
              Math.round(
                definition.skillParameters?.police?.gatlingMagazineSize ?? 150,
              ),
            ),
          }
        : undefined;
    if (!source.main) {
      source.name = `${definition.name}·战功晋升`;
    }
    this.emit(
      "merge",
      `${source.name}累计击杀${killsRequired}名敌人，战功升为${nextStar}星`,
      source,
      undefined,
      "merge",
      undefined,
      `${source.name}完成战功升星，晋升为${nextStar}星警察`,
    );
    this.emit(
      "skill",
      `${source.name} 触发战功升星`,
      source,
      undefined,
      "merge",
    );
  }

  private killChainLabel(count: number): string | undefined {
    const labels: Record<number, string> = {
      2: "二连击败",
      3: "三连击败",
      4: "四连击败",
      5: "五连击败",
    };
    if (count < 2) return undefined;
    return labels[count] ?? `${count}连击败`;
  }

  private cleanupDeadUnits(): void {
    const projectileSourceIds = new Set(
      [...this.projectiles.values()].map((projectile) => projectile.sourceUnitId),
    );
    for (const unit of [...this.units.values()]) {
      if (
        unit.action === "dead" &&
        this.time >= unit.actionUntil &&
        !projectileSourceIds.has(unit.id)
      ) {
        this.deleteUnit(unit.id);
      }
    }
  }

  private checkVictory(): void {
    if (this.status === "finished" || this.time < 0.5) return;
    const livingCombatants = [...this.units.values()].filter(
      (unit) => unit.hp > 0 && unit.action !== "dead",
    );
    const livingFactionAnchors = livingCombatants.filter(
      (unit) => unit.main || unit.sustainsFaction,
    );
    const livingFactions = new Set(
      livingFactionAnchors.map((unit) => unit.factionId),
    );
    if (livingFactions.size > 1) {
      this.finishAt = undefined;
      return;
    }
    const soleLivingFaction = livingFactions.values().next().value as
      | string
      | undefined;
    if (
      soleLivingFaction &&
      [...this.projectiles.values()].some(
        (projectile) => projectile.factionId !== soleLivingFaction,
      )
    ) {
      this.finishAt = undefined;
      return;
    }
    if (this.finishAt === undefined) {
      this.finishAt = this.time + 0.45;
      return;
    }
    if (this.time + EPSILON < this.finishAt) return;
    if (
      [...this.units.values()].some(
        (unit) => unit.action === "dead" && this.time < unit.actionUntil,
      )
    ) {
      return;
    }
    this.status = "finished";
    if (livingFactionAnchors.length >= 1 && livingFactions.size === 1) {
      const factionId = livingFactionAnchors[0].factionId;
      const livingMain = livingFactionAnchors.filter((unit) => unit.main);
      const winningCombatants = livingCombatants.filter(
        (unit) => unit.factionId === factionId,
      );
      const isTeam = factionId.startsWith("team:");
      const originalContestant = this.setup.contestants.find(
        (contestant) => contestant.id === factionId,
      );
      const featuredWinner =
        winningCombatants.find((unit) => unit.id === this.lastMainKillerId) ??
        livingMain[0] ??
        livingFactionAnchors[0];
      this.winnerId = featuredWinner.id;
      this.winnerName = isTeam
        ? livingMain.length > 0
          ? `${teamName(factionId)} · ${livingMain.map((unit) => unit.name).join("、")}`
          : `${teamName(factionId)} · 警察护卫队`
        : livingMain[0]?.name ??
          (originalContestant
            ? `${originalContestant.displayName}的警察护卫队`
            : featuredWinner.name);
      for (const winner of winningCombatants) {
        winner.meleeTargetId = undefined;
        winner.action = "victory";
        winner.actionStartedAt = this.time;
        winner.actionUntil = Number.POSITIVE_INFINITY;
      }
      this.emit(
        "victory",
        `${this.winnerName} 获得胜利！`,
        featuredWinner,
        undefined,
        "merge",
        undefined,
        `${this.winnerName} 获得胜利`,
      );
    } else {
      this.draw = true;
      this.emitAt(
        "victory",
        "所有仍可代表阵营的单位同时倒下，本局平局",
        this.board.width / 2,
        this.board.height / 2,
      );
    }
  }

  private addUnit(unit: RuntimeUnit): boolean {
    if (this.units.size >= MAX_ACTIVE_UNITS) return false;
    this.units.set(unit.id, unit);
    this.orderedUnitsDirty = true;
    return true;
  }

  private deleteUnit(id: string): boolean {
    const deleted = this.units.delete(id);
    if (deleted) this.orderedUnitsDirty = true;
    return deleted;
  }

  private orderedUnits(): RuntimeUnit[] {
    if (!this.orderedUnitsDirty) return this.orderedUnitsCache;
    this.orderedUnitsCache = [...this.units.values()].sort(
      (left, right) => left.bornAt - right.bornAt || left.id.localeCompare(right.id),
    );
    this.orderedUnitsDirty = false;
    return this.orderedUnitsCache;
  }

  private rebuildSpatialIndex(): void {
    this.spatialCells.clear();
    this.maxUnitRadius = 0;
    for (const unit of this.orderedUnits()) {
      if (!unit.targetable || unit.action === "dead") continue;
      this.maxUnitRadius = Math.max(this.maxUnitRadius, unit.radius);
      const key = this.spatialKey(unit.x, unit.y);
      const bucket = this.spatialCells.get(key);
      if (bucket) bucket.push(unit);
      else this.spatialCells.set(key, [unit]);
    }
  }

  private queryUnitCandidates(origin: Vec2, radius: number): RuntimeUnit[] {
    if (
      this.spatialCells.size === 0 ||
      !Number.isFinite(radius) ||
      radius >= Math.hypot(this.board.width, this.board.height)
    ) {
      return this.orderedUnits();
    }
    const searchRadius = Math.max(0, radius);
    const minCellX = Math.floor((origin.x - searchRadius) / SPATIAL_CELL_SIZE);
    const maxCellX = Math.floor((origin.x + searchRadius) / SPATIAL_CELL_SIZE);
    const minCellY = Math.floor((origin.y - searchRadius) / SPATIAL_CELL_SIZE);
    const maxCellY = Math.floor((origin.y + searchRadius) / SPATIAL_CELL_SIZE);
    const candidates: RuntimeUnit[] = [];
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        const bucket = this.spatialCells.get(`${cellX}:${cellY}`);
        if (bucket) candidates.push(...bucket);
      }
    }
    return candidates;
  }

  private spatialKey(x: number, y: number): string {
    return `${Math.floor(x / SPATIAL_CELL_SIZE)}:${Math.floor(y / SPATIAL_CELL_SIZE)}`;
  }

  private validTargets(unit: RuntimeUnit, range: number, origin: Vec2 = unit): RuntimeUnit[] {
    return this.queryUnitCandidates(origin, range + this.maxUnitRadius).filter(
      (candidate) =>
        candidate.id !== unit.id &&
        candidate.targetable &&
        candidate.action !== "dead" &&
        candidate.factionId !== unit.factionId &&
        distance(origin, candidate) <= range + candidate.radius,
    );
  }

  private validAttackTargets(
    unit: RuntimeUnit,
    definition: CharacterDefinition,
  ): RuntimeUnit[] {
    if (definition.attack.mode !== "melee") {
      return this.validTargets(unit, definition.attack.range);
    }
    if (definition.attack.range < 0) return [];
    const searchRadius =
      definition.attack.range + unit.radius + this.maxUnitRadius;
    return this.queryUnitCandidates(unit, searchRadius).filter(
      (target) =>
        this.isChaseableMeleeTarget(unit, target) &&
        this.meleeSurfaceGap(unit, target) <=
          definition.attack.range + EPSILON &&
        this.isInMeleeFrontArc(unit, target, definition),
    );
  }

  private isChaseableMeleeTarget(
    source: RuntimeUnit,
    target: RuntimeUnit | undefined,
  ): target is RuntimeUnit {
    return Boolean(
      target &&
        target.id !== source.id &&
        target.targetable &&
        target.action !== "dead" &&
        target.factionId !== source.factionId,
    );
  }

  private meleeSurfaceGap(source: RuntimeUnit, target: RuntimeUnit): number {
    return Math.max(
      0,
      distance(source, target) - source.radius - target.radius,
    );
  }

  private isMeleeContact(source: RuntimeUnit, target: RuntimeUnit): boolean {
    return (
      distance(source, target) <=
      source.radius + target.radius + MELEE_CONTACT_TOLERANCE
    );
  }

  private isValidMeleeTarget(
    source: RuntimeUnit,
    target: RuntimeUnit,
    definition: CharacterDefinition,
  ): boolean {
    return (
      this.isChaseableMeleeTarget(source, target) &&
      this.isMeleeContact(source, target) &&
      this.isInMeleeFrontArc(source, target, definition)
    );
  }

  private isInMeleeFrontArc(
    source: RuntimeUnit,
    target: RuntimeUnit,
    definition: CharacterDefinition,
  ): boolean {
    const arcDegrees = Math.max(
      10,
      Math.min(360, definition.attack.frontArcDegrees ?? 120),
    );
    if (arcDegrees >= 360 - EPSILON) return true;
    const facing = normalize({ x: source.vx, y: source.vy });
    const toTarget = normalize({ x: target.x - source.x, y: target.y - source.y });
    const minimumDot = Math.cos((arcDegrees * Math.PI) / 360);
    return facing.x * toTarget.x + facing.y * toTarget.y >= minimumDot - EPSILON;
  }

  private runIntervalModules(unit: RuntimeUnit): void {
    const definition = this.definitions.get(unit.definitionId);
    if (!definition) return;
    for (const ability of definition.abilities) {
      if (ability.trigger !== "interval") continue;
      if (this.time < (unit.moduleCooldowns[ability.id] ?? 0)) continue;
      this.executeModule(unit, ability);
    }
  }

  private runModules(
    unit: RuntimeUnit,
    trigger: "onDamageTaken" | "onAttack" | "onDeath",
  ): void {
    const definition = this.definitions.get(unit.definitionId);
    if (!definition) return;
    for (const ability of definition.abilities) {
      if (ability.trigger !== trigger) continue;
      if (this.time < (unit.moduleCooldowns[ability.id] ?? 0)) continue;
      this.executeModule(unit, ability);
    }
  }

  private executeModule(unit: RuntimeUnit, ability: AbilityModule): void {
    if (ability.hpBelowRatio !== undefined && unit.hp / unit.maxHp > ability.hpBelowRatio) return;
    if (this.modulesExecutedThisStep >= MAX_MODULE_EXECUTIONS_PER_STEP) {
      this.skippedAbilityModules += 1;
      unit.moduleCooldowns[ability.id] = this.time + 1 / 60;
      return;
    }
    this.modulesExecutedThisStep += 1;
    for (const action of ability.actions) this.executeModuleAction(unit, action);
    unit.moduleCooldowns[ability.id] =
      this.time +
      (ability.trigger === "interval" ? ability.interval ?? ability.cooldown : ability.cooldown);
    this.emit("skill", `${unit.name} 触发技能「${ability.name}」`, unit);
  }

  private executeModuleAction(unit: RuntimeUnit, action: AbilityAction): void {
    if (action.kind === "heal") {
      const amount = Math.min(action.amount, unit.maxHp - unit.hp);
      unit.hp += amount;
      this.emit(
        "heal",
        `${unit.name} 回复 ${Math.round(amount)} 点血`,
        unit,
        undefined,
        "heal",
        amount,
      );
    } else if (action.kind === "damageNearby") {
      for (const target of this.validTargets(unit, action.radius)) {
        this.damageUnit(target.id, action.amount, unit.id, "effect");
      }
    } else if (action.kind === "spawnUnit") {
      const definition = this.definitions.get(action.definitionId);
      if (!definition) return;
      const requestedCount = Number.isFinite(action.count)
        ? Math.min(100_000, Math.max(0, Math.round(action.count)))
        : MAX_UNIT_SPAWNS_PER_STEP;
      const count = Math.min(
        requestedCount,
        MAX_UNIT_SPAWNS_PER_STEP - this.unitsSpawnedThisStep,
        MAX_ACTIVE_UNITS - this.units.size,
      );
      if (count < requestedCount) {
        this.droppedSpawns += requestedCount - count;
      }
      for (let index = 0; index < count; index += 1) {
        const angle = this.random.angle();
        const spawned = this.createUnit({
          definition,
          ownerId: unit.ownerId,
          factionId: unit.factionId,
          main: false,
          x:
            unit.x +
            Math.cos(angle) *
              (unit.radius + definition.radius * (this.board.unitScale ?? 1) + 10),
          y:
            unit.y +
            Math.sin(angle) *
              (unit.radius + definition.radius * (this.board.unitScale ?? 1) + 10),
          playEntrance: true,
        });
        if (!this.addUnit(spawned)) break;
        this.unitsSpawnedThisStep += 1;
      }
    } else if (action.kind === "knockbackNearby") {
      for (const target of this.validTargets(unit, action.radius)) {
        const direction = normalize({ x: target.x - unit.x, y: target.y - unit.y });
        target.x += direction.x * action.distance;
        target.y += direction.y * action.distance;
      }
    } else if (action.kind === "playSound") {
      this.emit("sound", `${unit.name} 播放技能音效`, unit, undefined, action.cue);
    }
  }

  private emit(
    type: CombatEvent["type"],
    message: string,
    unit?: RuntimeUnit,
    target?: RuntimeUnit,
    sound?: SynthPreset,
    amount?: number,
    announcement?: string,
  ): void {
    const essential =
      type === "death" || type === "victory" || type === "merge" || Boolean(announcement);
    if (!essential && this.eventsCreatedThisStep >= MAX_EVENTS_PER_STEP) {
      this.suppressedEvents += 1;
      return;
    }
    this.eventsCreatedThisStep += 1;
    this.eventLog.push({
      id: this.nextId("event"),
      time: this.time,
      type,
      message,
      x: unit?.x,
      y: unit?.y,
      unitId: unit?.id,
      targetId: target?.id,
      unitName: unit?.name,
      targetName: target?.name,
      unitDefinitionId: unit?.definitionId,
      targetDefinitionId: target?.definitionId,
      sound,
      amount,
      announcement,
    });
    this.trimEventLog();
  }

  private emitAt(
    type: CombatEvent["type"],
    message: string,
    x: number,
    y: number,
    sound?: SynthPreset,
  ): void {
    const essential = type === "death" || type === "victory" || type === "merge";
    if (!essential && this.eventsCreatedThisStep >= MAX_EVENTS_PER_STEP) {
      this.suppressedEvents += 1;
      return;
    }
    this.eventsCreatedThisStep += 1;
    this.eventLog.push({
      id: this.nextId("event"),
      time: this.time,
      type,
      message,
      x,
      y,
      sound,
    });
    this.trimEventLog();
  }

  private trimEventLog(): void {
    if (this.eventLog.length <= MAX_EVENT_LOG) return;
    this.eventLog.splice(0, this.eventLog.length - EVENT_LOG_TRIM_TO);
  }

  private nextId(prefix: string): string {
    this.serial += 1;
    return `${prefix}-${this.serial}`;
  }
}
