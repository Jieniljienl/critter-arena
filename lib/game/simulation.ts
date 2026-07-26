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
  private readonly units = new Map<string, RuntimeUnit>();
  private readonly holes = new Map<string, RuntimeHole>();
  private readonly projectiles = new Map<string, RuntimeProjectile>();
  private readonly holeOccupants = new Map<string, Set<string>>();
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

  constructor(manifest: ProjectManifest, setup: MatchSetup = manifest.setup) {
    manifest.characters.forEach((definition) => this.definitions.set(definition.id, definition));
    const board = manifest.boards.find((candidate) => candidate.id === setup.boardId);
    if (!board) throw new Error(`找不到棋盘：${setup.boardId}`);
    this.board = structuredClone(board);
    this.setup = structuredClone(setup);
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
    this.holeOccupants.clear();
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
    this.processScheduledShots();
    this.rebuildSpatialIndex();
    this.updateUnits(dt);
    this.rebuildSpatialIndex();
    this.mergeCollidingPolice();
    this.rebuildSpatialIndex();
    this.updateProjectiles(dt);
    this.flattenHoles();
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
      const direction = normalize(contestant.direction);
      const unit = this.createUnit({
        id: contestant.id,
        definition,
        name: contestant.displayName,
        ownerId: contestant.id,
        factionId: contestant.teamId ? `team:${contestant.teamId}` : contestant.id,
        main: true,
        x: contestant.position.x,
        y: contestant.position.y,
        direction,
      });
      this.addUnit(unit);
    }
  }

  private createUnit(options: {
    id?: string;
    definition: CharacterDefinition;
    name?: string;
    ownerId: string;
    factionId: string;
    main: boolean;
    x: number;
    y: number;
    direction?: Vec2;
  }): RuntimeUnit {
    const direction =
      options.direction ??
      normalize({ x: Math.cos(this.random.angle()), y: Math.sin(this.random.angle()) });
    const definition = options.definition;
    const radius = definition.radius * (this.board.unitScale ?? 1);
    const unit: RuntimeUnit = {
      id: options.id ?? this.nextId(definition.id),
      definitionId: definition.id,
      name: options.name ?? definition.name,
      ownerId: options.ownerId,
      factionId: options.factionId,
      main: options.main,
      policeStar: definition.policeStar,
      hp: definition.maxHp,
      maxHp: definition.maxHp,
      x: Math.max(radius, Math.min(this.board.width - radius, options.x)),
      y: Math.max(radius, Math.min(this.board.height - radius, options.y)),
      vx: direction.x * definition.speed,
      vy: direction.y * definition.speed,
      radius,
      bornAt: this.time,
      nextAttackAt: this.time + 0.4 + this.random.next() * 0.4,
      targetable: true,
      action: "move",
      actionStartedAt: this.time,
      actionUntil: 0,
      nextPandaSummonAt: 0,
      nextEatAt: 0,
      nextDigAt: definition.pluginId === "mole" ? this.time : Number.POSITIVE_INFINITY,
      nextAmbushAt: 0,
      burnUntil: 0,
      burnDamagePerSecond: 0,
      springUntil: 0,
      springHealPerSecond: 0,
      nextBurnFeedbackAt: 0,
      nextSpringFeedbackAt: 0,
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

      if (unit.action !== "tunneling") this.runIntervalModules(unit);
      this.updateSpecialAbility(unit, definition, dt);

      const immobilized = [
        "eating",
        "satisfied",
        "digging",
        "tunneling",
        "kick",
        "merge",
        "victory",
      ].includes(unit.action);
      if (!immobilized) this.moveUnit(unit, dt, definition.speed);

      this.updateAreaBuffs(unit);
      if (unit.action === "dead") continue;

      if (definition.attack.mode !== "gatling" && this.canBeginAttack(unit)) {
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
    unit.action = "eating";
    unit.actionStartedAt = this.time;
    unit.actionUntil = this.time + (parameters?.eatDuration ?? 5);
    unit.reservedBambooId = bamboo.id;
    this.reservedBambooIds.add(bamboo.id);
    this.emit("skill", `${unit.name} 抱住竹子，开始猛吃`, unit, undefined, "chew");
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
        const candidates = availableHoles
          .flatMap((hole) =>
            this.validTargets(unit, parameters?.ambushRange ?? definition.attack.range, hole).map((target) => ({
              hole,
              target,
            })),
          );
        const selection = this.random.pick(candidates);
        if (selection) {
          unit.action = "tunneling";
          unit.actionStartedAt = this.time;
          const tunnelDuration = parameters?.tunnelDuration ?? 1;
          unit.actionUntil = this.time + tunnelDuration;
          unit.targetable = false;
          unit.nextAmbushAt = this.time + (parameters?.ambushCooldown ?? 3);
          unit.tunnelData = {
            mode: "ambush",
            origin: { x: unit.x, y: unit.y },
            destination: { x: selection.hole.x, y: selection.hole.y },
            targetId: selection.target.id,
          };
          this.enqueueShot({
            id: this.nextId("ambush"),
            at: this.time + tunnelDuration * 0.5,
            sourceId: unit.id,
            targetId: selection.target.id,
            from: { x: selection.hole.x, y: selection.hole.y },
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
          unit.action = "tunneling";
          unit.actionStartedAt = this.time;
          unit.actionUntil = this.time + (parameters?.tunnelDuration ?? 1);
          unit.targetable = false;
          unit.tunnelData = {
            mode: "travel",
            origin: { x: unit.x, y: unit.y },
            destination: { x: destination.x, y: destination.y },
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
    unit.action = "digging";
    unit.actionStartedAt = this.time;
    unit.actionUntil = this.time + (parameters?.digDuration ?? 0.6);
    unit.digPosition = { x: unit.x, y: unit.y };
    unit.nextDigAt = this.time + (parameters?.digCooldown ?? 10);
    this.emit("skill", `${unit.name} 开始挖洞`, unit, undefined, "dig");
  }

  private updateMoleTunnelPosition(unit: RuntimeUnit): void {
    const tunnel = unit.tunnelData;
    if (!tunnel) return;
    const duration = Math.max(EPSILON, unit.actionUntil - unit.actionStartedAt);
    const progress = Math.max(0, Math.min(1, (this.time - unit.actionStartedAt) / duration));
    if (tunnel.mode === "travel") {
      const position = progress >= 0.62 ? tunnel.destination : tunnel.origin;
      unit.x = position.x;
      unit.y = position.y;
      return;
    }
    const position = progress >= 0.34 && progress < 0.78 ? tunnel.destination : tunnel.origin;
    unit.x = position.x;
    unit.y = position.y;
  }

  private updateGatling(
    unit: RuntimeUnit,
    definition: CharacterDefinition,
    dt: number,
  ): void {
    const gatling = unit.gatling;
    if (!gatling || unit.action === "kick" || unit.action === "dead") return;
    const attack = definition.attack;
    const shotCount = Math.min(
      MAX_SHOTS_PER_BURST,
      Math.max(1, Math.round(attack.burstCount ?? 15)),
    );
    const shotGap = Math.max(EPSILON, attack.burstGap ?? 0.33);

    gatling.nextRoundIn = Math.max(0, gatling.nextRoundIn - dt);
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
      gatling.shotsRemaining = shotCount;
      gatling.nextShotIn = Math.max(0, attack.windup);
      gatling.nextRoundIn = Math.max(0.1, attack.cooldown);
      this.emit(
        "skill",
        `${unit.name} 锁定 ${target.name} 的方向，开始一轮 ${shotCount} 发连射`,
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
    }
  }

  private completeTimedActions(): void {
    for (const unit of this.units.values()) {
      if (unit.actionUntil <= 0 || this.time < unit.actionUntil) continue;
      if (unit.action === "eating") {
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
        const stompsRequired = Math.max(1, Math.round(parameters?.stompsToFlatten ?? 3));
        const hole: RuntimeHole = {
          id: this.nextId("hole"),
          ownerId: unit.ownerId,
          x: position.x,
          y: position.y,
          radius: parameters?.holeRadius ?? 80,
          stompsRequired,
          stompsRemaining: stompsRequired,
          bornAt: this.time,
        };
        this.holes.set(hole.id, hole);
        unit.lastHoleId = hole.id;
        unit.digPosition = undefined;
        this.emit("prop", `${unit.name} 挖出了一处新洞`, unit, undefined, "dig");
        this.resetAction(unit);
      } else if (unit.action === "tunneling") {
        const tunnel = unit.tunnelData;
        if (tunnel) {
          if (tunnel.mode === "travel") {
            unit.x = tunnel.destination.x;
            unit.y = tunnel.destination.y;
            unit.lastHoleId = undefined;
            for (const hole of this.holes.values()) {
              if (distance(hole, tunnel.destination) < 1) {
                unit.lastHoleId = hole.id;
                break;
              }
            }
          } else {
            unit.x = tunnel.origin.x;
            unit.y = tunnel.origin.y;
          }
        }
        unit.targetable = true;
        unit.tunnelData = undefined;
        this.emit("sound", `${unit.name} 钻出地面`, unit, undefined, "tunnel");
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
    unit.action = "move";
    unit.actionStartedAt = this.time;
    unit.actionUntil = 0;
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

  private canBeginAttack(unit: RuntimeUnit): boolean {
    return (
      unit.targetable &&
      unit.action !== "eating" &&
      unit.action !== "satisfied" &&
      unit.action !== "digging" &&
      unit.action !== "tunneling" &&
      unit.action !== "kick" &&
      this.time >= unit.nextAttackAt
    );
  }

  private beginAttack(unit: RuntimeUnit, definition: CharacterDefinition): void {
    const target = this.random.pick(this.validTargets(unit, definition.attack.range));
    if (!target) return;
    const attack = definition.attack;
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

  private processScheduledShots(): void {
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
      if (!source || source.action === "dead" || !target || !target.targetable) continue;
      const definition = this.definitions.get(source.definitionId);
      if (!definition) continue;

      if (shot.ambush) {
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
        }
        continue;
      }

      if (definition.attack.mode === "melee") {
        if (distance(source, target) <= definition.attack.range + target.radius) {
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
    const projectile: RuntimeProjectile = {
      id: this.nextId(kind),
      ownerId: source.ownerId,
      factionId: source.factionId,
      sourceUnitId: source.id,
      kind,
      x: source.x + direction.x * (source.radius + 8),
      y: source.y + direction.y * (source.radius + 8),
      vx: direction.x * speed,
      vy: direction.y * speed,
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
      this.spawnPolice(target, 1);
    }
    if (definition.pluginId === "police" && definition.policeStar === 5) {
      const attacker = sourceUnitId ? this.units.get(sourceUnitId) : undefined;
      const gatling = target.gatling;
      const parameters = definition.skillParameters?.police;
      if (
        attacker &&
        attacker.targetable &&
        gatling &&
        this.time >= gatling.nextKickAt &&
        distance(target, attacker) <= (parameters?.kickRange ?? 160) + attacker.radius
      ) {
        gatling.nextKickAt = this.time + (parameters?.kickCooldown ?? 0.5);
        const direction = normalize({ x: attacker.x - target.x, y: attacker.y - target.y });
        attacker.x = Math.max(
          attacker.radius,
          Math.min(
            this.board.width - attacker.radius,
            attacker.x + direction.x * (parameters?.kickDistance ?? 140),
          ),
        );
        attacker.y = Math.max(
          attacker.radius,
          Math.min(
            this.board.height - attacker.radius,
            attacker.y + direction.y * (parameters?.kickDistance ?? 140),
          ),
        );
        const attackerDefinition = this.definitions.get(attacker.definitionId);
        const speed = attackerDefinition?.speed ?? Math.hypot(attacker.vx, attacker.vy);
        attacker.vx = direction.x * speed;
        attacker.vy = direction.y * speed;
        target.action = "kick";
        target.actionStartedAt = this.time;
        target.actionUntil = this.time + (parameters?.kickDuration ?? 0.35);
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
      name: `${owner.name}的${star}星警察`,
      x: owner.x + Math.cos(angle) * spawnDistance,
      y: owner.y + Math.sin(angle) * spawnDistance,
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
      "pistol",
    );
    return unit;
  }

  private mergeCollidingPolice(): void {
    let merges = 0;
    while (merges < MAX_MERGES_PER_STEP) {
      const police = this.orderedUnits().filter(
        (unit) =>
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
        name: main ? `${left.main ? left.name : right.name}★${nextStar}` : `${nextStar}星合体警察`,
        x: (left.x + right.x) / 2,
        y: (left.y + right.y) / 2,
      });
      merged.action = "merge";
      merged.actionStartedAt = this.time;
      merged.actionUntil = this.time + 0.62;
      this.addUnit(merged);
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
      merges += 1;
      this.rebuildSpatialIndex();
    }
  }

  private flattenHoles(): void {
    for (const hole of [...this.holes.values()]) {
      const occupants = this.queryUnitCandidates(
        hole,
        hole.radius + this.maxUnitRadius,
      ).filter(
        (unit) => {
          const definition = this.definitions.get(unit.definitionId);
          return (
            unit.targetable &&
            definition?.pluginId !== "mole" &&
            distance(unit, hole) <= unit.radius + hole.radius
          );
        },
      );
      const previous = this.holeOccupants.get(hole.id) ?? new Set<string>();
      const current = new Set(occupants.map((unit) => unit.id));
      const entrants = occupants.filter((unit) => !previous.has(unit.id));
      let collapsed = false;
      for (const entrant of entrants) {
        hole.stompsRemaining = Math.max(0, hole.stompsRemaining - 1);
        if (hole.stompsRemaining <= 0) {
          this.holes.delete(hole.id);
          this.holeOccupants.delete(hole.id);
          this.emitAt(
            "prop",
            `${entrant.name} 第 ${hole.stompsRequired} 次踩中洞口，洞被踩平了`,
            hole.x,
            hole.y,
            "dig",
          );
          collapsed = true;
          break;
        }
        this.emitAt(
          "prop",
          `${entrant.name} 踩中洞口，剩余 ${hole.stompsRemaining}/${hole.stompsRequired} 次耐久`,
          hole.x,
          hole.y,
          "dig",
        );
      }
      if (!collapsed) this.holeOccupants.set(hole.id, current);
    }
  }

  private killUnit(target: RuntimeUnit, sourceUnitId?: string): void {
    if (target.action === "dead") return;
    target.hp = 0;
    target.targetable = false;
    target.action = "dead";
    target.actionStartedAt = this.time;
    target.actionUntil = this.time + 0.45;
    if (target.reservedBambooId) {
      this.reservedBambooIds.delete(target.reservedBambooId);
      target.reservedBambooId = undefined;
    }
    const removedUnitIds = new Set([target.id]);
    const source = sourceUnitId ? this.units.get(sourceUnitId) : undefined;
    if (source && source.action !== "dead") {
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
    this.runModules(target, "onDeath");

    if (target.main) {
      for (const unit of [...this.units.values()]) {
        if (!unit.main && unit.ownerId === target.ownerId) {
          removedUnitIds.add(unit.id);
          this.deleteUnit(unit.id);
        }
      }
      for (const hole of [...this.holes.values()]) {
        if (hole.ownerId === target.ownerId) {
          this.holes.delete(hole.id);
          this.holeOccupants.delete(hole.id);
        }
      }
      for (const projectile of [...this.projectiles.values()]) {
        if (projectile.ownerId === target.ownerId) this.projectiles.delete(projectile.id);
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
    for (const unit of [...this.units.values()]) {
      if (unit.action === "dead" && this.time >= unit.actionUntil) this.deleteUnit(unit.id);
    }
  }

  private checkVictory(): void {
    if (this.status === "finished" || this.time < 0.5) return;
    const livingMain = [...this.units.values()].filter(
      (unit) => unit.main && unit.hp > 0 && unit.action !== "dead",
    );
    const livingFactions = new Set(livingMain.map((unit) => unit.factionId));
    if (livingFactions.size > 1) {
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
    if (livingMain.length >= 1 && livingFactions.size === 1) {
      const factionId = livingMain[0].factionId;
      const isTeam = factionId.startsWith("team:");
      this.winnerId = livingMain[0].id;
      this.winnerName = isTeam
        ? `${teamName(factionId)} · ${livingMain.map((unit) => unit.name).join("、")}`
        : livingMain[0].name;
      for (const winner of livingMain) {
        winner.action = "victory";
        winner.actionStartedAt = this.time;
        winner.actionUntil = Number.POSITIVE_INFINITY;
      }
      const featuredWinner =
        livingMain.find((unit) => unit.id === this.lastMainKillerId) ?? livingMain[0];
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
      this.emitAt("victory", "所有主角色同时倒下，本局平局", this.board.width / 2, this.board.height / 2);
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
