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
  at: number;
  sourceId: string;
  targetId: string;
  from?: Vec2;
  damage?: number;
  range?: number;
  ambush?: boolean;
};

const EPSILON = 0.0001;

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
  private readonly scheduledShots: ScheduledShot[] = [];
  private readonly eventLog: CombatEvent[] = [];
  private readonly killChains = new Map<string, { count: number; lastKillAt: number }>();
  private serial = 0;
  private time = 0;
  private status: BattleStatus = "ready";
  private winnerId: string | undefined;
  private winnerName: string | undefined;
  private draw = false;
  private finishAt: number | undefined;

  constructor(manifest: ProjectManifest, setup: MatchSetup = manifest.setup) {
    manifest.characters.forEach((definition) => this.definitions.set(definition.id, definition));
    const board = manifest.boards.find((candidate) => candidate.id === setup.boardId);
    if (!board) throw new Error(`找不到棋盘：${setup.boardId}`);
    this.board = structuredClone(board);
    this.setup = structuredClone(setup);
    this.props = cloneProps(board);
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
    this.holes.clear();
    this.projectiles.clear();
    this.holeOccupants.clear();
    this.scheduledShots.length = 0;
    this.eventLog.length = 0;
    this.killChains.clear();
    this.winnerId = undefined;
    this.winnerName = undefined;
    this.draw = false;
    this.finishAt = undefined;
    this.initializeContestants();
    return true;
  }

  step(dt = 1 / 60, force = false): void {
    if ((!force && this.status !== "running") || this.status === "finished") return;
    this.time += dt;
    this.completeTimedActions();
    this.processScheduledShots();
    this.updateUnits(dt);
    this.mergeCollidingPolice();
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
      units: [...this.units.values()].map((unit) => ({
        ...unit,
        moduleCooldowns: { ...unit.moduleCooldowns },
        tunnelData: unit.tunnelData ? structuredClone(unit.tunnelData) : undefined,
        gatling: unit.gatling ? { ...unit.gatling } : undefined,
      })),
      holes: [...this.holes.values()].map((hole) => ({ ...hole })),
      projectiles: [...this.projectiles.values()].map((projectile) => ({ ...projectile })),
      props: structuredClone(this.props),
      events: this.eventLog.slice(-80).map((event) => ({ ...event })),
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
      this.units.set(unit.id, unit);
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
    const policeParameters = definition.skillParameters?.police;
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
              phase: "fire" as const,
              phaseRemaining: policeParameters?.gatlingFireDuration ?? 5,
              shotsRemaining: policeParameters?.gatlingShots ?? 15,
              nextShotIn: 0.08,
              nextKickAt: 0,
            },
          }
        : {}),
    };
    return unit;
  }

  private updateUnits(dt: number): void {
    const orderedUnits = [...this.units.values()].sort(
      (left, right) => left.bornAt - right.bornAt || left.id.localeCompare(right.id),
    );

    for (const unit of orderedUnits) {
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
    const touchingLava = canReceiveNewEffects
      ? this.props.filter(
          (prop) =>
            prop.active &&
            prop.type === "lava" &&
            circleOverlapsRegion(unit, unit.radius, prop.shape),
        )
      : [];
    const wasBurning = this.time < unit.burnUntil;
    if (touchingLava.length) {
      unit.burnUntil =
        this.time + Math.max(...touchingLava.map((prop) => prop.buffDuration ?? 3));
      unit.burnDamagePerSecond = Math.max(
        ...touchingLava.map((prop) => prop.effectPerSecond ?? 5),
      );
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

    const touchingSpring = canReceiveNewEffects
      ? this.props.filter(
          (prop) =>
            prop.active &&
            prop.type === "hotSpring" &&
            circleOverlapsRegion(unit, unit.radius, prop.shape),
        )
      : [];
    const hadSpringBuff = this.time < unit.springUntil;
    if (touchingSpring.length) {
      unit.springUntil =
        this.time + Math.max(...touchingSpring.map((prop) => prop.buffDuration ?? 3));
      unit.springHealPerSecond = Math.max(
        ...touchingSpring.map((prop) => prop.effectPerSecond ?? 5),
      );
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
    const reserved = new Set(
      [...this.units.values()]
        .map((candidate) => candidate.reservedBambooId)
        .filter((id): id is string => Boolean(id)),
    );
    const bamboo = this.props.find(
      (prop) =>
        prop.type === "bamboo" &&
        prop.active &&
        !reserved.has(prop.id) &&
        circleOverlapsRegion(unit, unit.radius + (parameters?.bambooExtraRange ?? 0), prop.shape),
    );
    if (!bamboo) return;
    unit.action = "eating";
    unit.actionStartedAt = this.time;
    unit.actionUntil = this.time + (parameters?.eatDuration ?? 5);
    unit.reservedBambooId = bamboo.id;
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
            hitAt: this.time + tunnelDuration * 0.5,
            hitDone: false,
          };
          this.scheduledShots.push({
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
    const parameters = definition.skillParameters?.police;
    const fireDuration = parameters?.gatlingFireDuration ?? 5;
    const restDuration = parameters?.gatlingRestDuration ?? 5;
    const shotCount = Math.max(1, Math.round(parameters?.gatlingShots ?? 15));
    gatling.phaseRemaining -= dt;
    if (gatling.phase === "fire") {
      gatling.nextShotIn -= dt;
      while (gatling.nextShotIn <= 0 && gatling.shotsRemaining > 0) {
        const target = this.random.pick(this.validTargets(unit, definition.attack.range));
        if (target) this.launchProjectile(unit, target, definition);
        gatling.shotsRemaining -= 1;
        gatling.nextShotIn += fireDuration / shotCount;
      }
      if (gatling.phaseRemaining <= 0) {
        gatling.phase = "rest";
        gatling.phaseRemaining += restDuration;
        gatling.shotsRemaining = 0;
        gatling.nextShotIn = 0;
      }
    } else if (gatling.phaseRemaining <= 0) {
      gatling.phase = "fire";
      gatling.phaseRemaining += fireDuration;
      gatling.shotsRemaining = shotCount;
      gatling.nextShotIn = 0;
      this.emit("skill", `${unit.name} 的加特林再次开火`, unit, undefined, "gatling");
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
            const destinationHole = [...this.holes.values()].find(
              (hole) => distance(hole, tunnel.destination) < 1,
            );
            unit.lastHoleId = destinationHole?.id;
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
    const count = attack.mode === "burst" ? attack.burstCount ?? 3 : 1;
    const gap = attack.burstGap ?? 0;
    for (let index = 0; index < count; index += 1) {
      this.scheduledShots.push({
        id: this.nextId("shot"),
        at: this.time + attack.windup + gap * index,
        sourceId: unit.id,
        targetId: target.id,
      });
    }
  }

  private processScheduledShots(): void {
    this.scheduledShots.sort((left, right) => left.at - right.at);
    while (this.scheduledShots[0]?.at <= this.time + EPSILON) {
      const shot = this.scheduledShots.shift();
      if (!shot) break;
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

  private launchProjectile(
    source: RuntimeUnit,
    target: RuntimeUnit,
    definition: CharacterDefinition,
  ): void {
    const attack = definition.attack;
    const direction = normalize({ x: target.x - source.x, y: target.y - source.y });
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
    this.emit("attack", `${source.name} 向 ${target.name} 开火`, source, target, sound);
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

      const hit = [...this.units.values()].find(
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
    for (const unit of this.units.values()) {
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
    this.units.set(unit.id, unit);
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
    while (true) {
      const police = [...this.units.values()]
        .filter(
          (unit) =>
            unit.policeStar !== undefined &&
            unit.policeStar < 5 &&
            unit.action !== "dead" &&
            unit.action !== "merge",
        )
        .sort((left, right) => left.bornAt - right.bornAt || left.id.localeCompare(right.id));
      let pair: [RuntimeUnit, RuntimeUnit] | undefined;

      for (let leftIndex = 0; leftIndex < police.length && !pair; leftIndex += 1) {
        const left = police[leftIndex];
        const owner = this.units.get(left.ownerId);
        const ownerDefinition = owner
          ? this.definitions.get(owner.definitionId)
          : undefined;
        const mergePadding =
          ownerDefinition?.skillParameters?.panda?.policeMergePadding ?? 0;
        for (let rightIndex = leftIndex + 1; rightIndex < police.length; rightIndex += 1) {
          const right = police[rightIndex];
          if (
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
      this.units.delete(left.id);
      this.units.delete(right.id);
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
      this.units.set(merged.id, merged);
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
    }
  }

  private flattenHoles(): void {
    for (const hole of [...this.holes.values()]) {
      const occupants = [...this.units.values()].filter(
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
    const source = sourceUnitId ? this.units.get(sourceUnitId) : undefined;
    if (source && source.action !== "dead") {
      source.action = "kill";
      source.actionStartedAt = this.time;
      source.actionUntil = Math.max(source.actionUntil, this.time + 0.58);
    }
    let announcement: string | undefined;
    let message = source ? `${target.name} 被 ${source.name} 击败` : `${target.name} 倒下了`;
    if (source && target.main) {
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
        if (!unit.main && unit.ownerId === target.ownerId) this.units.delete(unit.id);
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
      if (unit.action === "dead" && this.time >= unit.actionUntil) this.units.delete(unit.id);
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
      this.emit(
        "victory",
        `${this.winnerName} 获得胜利！`,
        livingMain[0],
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

  private validTargets(unit: RuntimeUnit, range: number, origin: Vec2 = unit): RuntimeUnit[] {
    return [...this.units.values()].filter(
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
      for (let index = 0; index < action.count; index += 1) {
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
        this.units.set(spawned.id, spawned);
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
    this.eventLog.push({
      id: this.nextId("event"),
      time: this.time,
      type,
      message,
      x: unit?.x,
      y: unit?.y,
      unitId: unit?.id,
      targetId: target?.id,
      sound,
      amount,
      announcement,
    });
    if (this.eventLog.length > 200) this.eventLog.splice(0, this.eventLog.length - 200);
  }

  private emitAt(
    type: CombatEvent["type"],
    message: string,
    x: number,
    y: number,
    sound?: SynthPreset,
  ): void {
    this.eventLog.push({
      id: this.nextId("event"),
      time: this.time,
      type,
      message,
      x,
      y,
      sound,
    });
    if (this.eventLog.length > 200) this.eventLog.splice(0, this.eventLog.length - 200);
  }

  private nextId(prefix: string): string {
    this.serial += 1;
    return `${prefix}-${this.serial}`;
  }
}
