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

type DamageSource = "attack" | "environment";

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
  private readonly props: BoardProp[];
  private readonly scheduledShots: ScheduledShot[] = [];
  private readonly eventLog: CombatEvent[] = [];
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

  step(dt = 1 / 60, force = false): void {
    if ((!force && this.status !== "running") || this.status === "finished") return;
    this.time += dt;
    this.completeTimedActions();
    this.processScheduledShots();
    this.updateUnits(dt);
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
      if (!definition || definition.role !== "contestant") continue;
      const direction = normalize(contestant.direction);
      const unit = this.createUnit({
        id: contestant.id,
        definition,
        name: contestant.displayName,
        ownerId: contestant.id,
        factionId: contestant.id,
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
      x: Math.max(definition.radius, Math.min(this.board.width - definition.radius, options.x)),
      y: Math.max(definition.radius, Math.min(this.board.height - definition.radius, options.y)),
      vx: direction.x * definition.speed,
      vy: direction.y * definition.speed,
      radius: definition.radius,
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
      moduleCooldowns: Object.fromEntries(
        definition.abilities.map((module) => [
          module.id,
          this.time + (module.trigger === "interval" ? module.interval ?? module.cooldown : 0),
        ]),
      ),
      ...(definition.policeStar === 5
        ? {
            gatling: {
              phase: "fire" as const,
              phaseRemaining: 5,
              shotsRemaining: 15,
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

      this.runIntervalModules(unit);
      this.updateSpecialAbility(unit, definition, dt);

      const immobilized = ["eating", "digging", "tunneling", "kick"].includes(unit.action);
      if (!immobilized) this.moveUnit(unit, dt, definition.speed);

      if (this.touchesLava(unit)) {
        this.damageUnit(unit.id, 5 * dt, undefined, "environment");
        if (Math.floor((this.time - dt) * 2) !== Math.floor(this.time * 2)) {
          this.emit("sound", "岩浆滋滋作响", unit, undefined, "lava");
        }
      }
      if (unit.action === "dead") continue;

      if (definition.attack.mode !== "gatling" && this.canBeginAttack(unit)) {
        this.beginAttack(unit, definition);
      }
    }
  }

  private updateSpecialAbility(
    unit: RuntimeUnit,
    definition: CharacterDefinition,
    dt: number,
  ): void {
    if (definition.pluginId === "panda") this.updatePanda(unit);
    if (definition.pluginId === "mole") this.updateMole(unit);
    if (definition.pluginId === "police" && definition.policeStar === 5) {
      this.updateGatling(unit, definition, dt);
    }
  }

  private updatePanda(unit: RuntimeUnit): void {
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
        circleOverlapsRegion(unit, unit.radius, prop.shape),
    );
    if (!bamboo) return;
    unit.action = "eating";
    unit.actionStartedAt = this.time;
    unit.actionUntil = this.time + 5;
    unit.reservedBambooId = bamboo.id;
    this.emit("skill", `${unit.name} 抱住竹子，开始猛吃`, unit, undefined, "chew");
  }

  private updateMole(unit: RuntimeUnit): void {
    if (unit.action !== "move" && unit.action !== "attack" && unit.action !== "hurt") return;
    const definition = this.definitions.get(unit.definitionId);
    if (!definition) return;
    const ownHoles = [...this.holes.values()].filter((hole) => hole.ownerId === unit.ownerId);
    const currentHole = ownHoles.find(
      (hole) => distance(unit, hole) <= hole.radius + unit.radius,
    );
    const justEntered = Boolean(currentHole && currentHole.id !== unit.lastHoleId);

    if (!currentHole) {
      unit.lastHoleId = undefined;
    } else {
      unit.lastHoleId = currentHole.id;
      if (this.time >= unit.nextAmbushAt) {
        const candidates = ownHoles
          .filter((hole) => hole.id !== currentHole.id)
          .flatMap((hole) =>
            this.validTargets(unit, definition.attack.range, hole).map((target) => ({
              hole,
              target,
            })),
          );
        const selection = this.random.pick(candidates);
        if (selection) {
          unit.action = "tunneling";
          unit.actionStartedAt = this.time;
          unit.actionUntil = this.time + 1;
          unit.targetable = false;
          unit.nextAmbushAt = this.time + 3;
          unit.tunnelData = {
            mode: "ambush",
            origin: { x: unit.x, y: unit.y },
            destination: { x: selection.hole.x, y: selection.hole.y },
            targetId: selection.target.id,
            hitAt: this.time + 0.5,
            hitDone: false,
          };
          this.scheduledShots.push({
            id: this.nextId("ambush"),
            at: this.time + 0.5,
            sourceId: unit.id,
            targetId: selection.target.id,
            from: { x: selection.hole.x, y: selection.hole.y },
            damage: definition.attack.damage,
            range: definition.attack.range,
            ambush: true,
          });
          this.emit(
            "skill",
            `${unit.name} 潜入地道，准备从另一处洞口偷袭`,
            unit,
            selection.target,
            "tunnel",
          );
          return;
        }
      }

      if (justEntered && ownHoles.length >= 2 && this.random.next() < 0.2) {
        const destination = this.random.pick(
          ownHoles.filter((hole) => hole.id !== currentHole.id),
        );
        if (destination) {
          unit.action = "tunneling";
          unit.actionStartedAt = this.time;
          unit.actionUntil = this.time + 1;
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
      (hole) => distance(unit, hole) >= 220,
    );
    if (!farEnough) return;
    unit.action = "digging";
    unit.actionStartedAt = this.time;
    unit.actionUntil = this.time + 0.6;
    unit.digPosition = { x: unit.x, y: unit.y };
    unit.nextDigAt = this.time + 10;
    this.emit("skill", `${unit.name} 开始挖洞`, unit, undefined, "dig");
  }

  private updateGatling(
    unit: RuntimeUnit,
    definition: CharacterDefinition,
    dt: number,
  ): void {
    const gatling = unit.gatling;
    if (!gatling || unit.action === "kick" || unit.action === "dead") return;
    gatling.phaseRemaining -= dt;
    if (gatling.phase === "fire") {
      gatling.nextShotIn -= dt;
      while (gatling.nextShotIn <= 0 && gatling.shotsRemaining > 0) {
        const target = this.random.pick(this.validTargets(unit, definition.attack.range));
        if (target) this.launchProjectile(unit, target, definition);
        gatling.shotsRemaining -= 1;
        gatling.nextShotIn += 5 / 15;
      }
      if (gatling.phaseRemaining <= 0) {
        gatling.phase = "rest";
        gatling.phaseRemaining += 5;
        gatling.shotsRemaining = 0;
        gatling.nextShotIn = 0;
      }
    } else if (gatling.phaseRemaining <= 0) {
      gatling.phase = "fire";
      gatling.phaseRemaining += 5;
      gatling.shotsRemaining = 15;
      gatling.nextShotIn = 0;
      this.emit("skill", `${unit.name} 的加特林再次开火`, unit, undefined, "gatling");
    }
  }

  private completeTimedActions(): void {
    for (const unit of this.units.values()) {
      if (unit.actionUntil <= 0 || this.time < unit.actionUntil) continue;
      if (unit.action === "eating") {
        const bamboo = this.props.find((prop) => prop.id === unit.reservedBambooId);
        if (bamboo?.active) {
          bamboo.active = false;
          const amount = Math.min(100, unit.maxHp - unit.hp);
          unit.hp += amount;
          unit.nextEatAt = this.time + 5;
          this.emit("heal", `${unit.name} 吃完竹子，回复 ${Math.round(amount)} 点血`, unit, undefined, "heal");
          this.emit("prop", `${bamboo.label ?? "竹子"} 被吃光了`, unit);
        }
        unit.reservedBambooId = undefined;
        this.resetAction(unit);
      } else if (unit.action === "digging") {
        const position = unit.digPosition ?? { x: unit.x, y: unit.y };
        const hole: RuntimeHole = {
          id: this.nextId("hole"),
          ownerId: unit.ownerId,
          x: position.x,
          y: position.y,
          radius: 80,
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
              (hole) =>
                hole.ownerId === unit.ownerId &&
                distance(hole, tunnel.destination) < 1,
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
      } else if (unit.action === "kick" || unit.action === "attack" || unit.action === "hurt") {
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
            "attack",
          );
          this.emit("attack", `${source.name} 从洞口偷袭 ${target.name}`, source, target, "swipe");
          this.runModules(source, "onAttack");
        }
        continue;
      }

      if (definition.attack.mode === "melee") {
        if (distance(source, target) <= definition.attack.range + target.radius) {
          this.damageUnit(target.id, definition.attack.damage, source.id, "attack");
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
        this.damageUnit(hit.id, projectile.damage, projectile.sourceUnitId, "attack");
        this.explodeRocket(projectile, hit.id);
      } else {
        this.damageUnit(hit.id, projectile.damage, projectile.sourceUnitId, "attack");
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
        this.damageUnit(unit.id, splash, projectile.sourceUnitId, "attack");
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
    target.hp = Math.max(0, target.hp - amount);
    if (source === "attack") {
      this.emit(
        "damage",
        `${target.name} 受到 ${Math.round(amount)} 点伤害`,
        target,
        sourceUnitId ? this.units.get(sourceUnitId) : undefined,
        "hurt",
      );
      this.runModules(target, "onDamageTaken");
      this.handleDamagePassive(target, sourceUnitId, amount);
    }
    if (target.hp <= 0) this.killUnit(target, sourceUnitId);
  }

  private handleDamagePassive(
    target: RuntimeUnit,
    sourceUnitId: string | undefined,
    _amount: number,
  ): void {
    const definition = this.definitions.get(target.definitionId);
    if (!definition || target.hp <= 0) return;
    if (definition.pluginId === "panda" && this.time >= target.nextPandaSummonAt) {
      target.nextPandaSummonAt = this.time + 0.5;
      this.spawnPolice(target, 1);
      this.mergePolice(target.ownerId);
    }
    if (definition.pluginId === "police" && definition.policeStar === 5) {
      const attacker = sourceUnitId ? this.units.get(sourceUnitId) : undefined;
      const gatling = target.gatling;
      if (
        attacker &&
        attacker.targetable &&
        gatling &&
        this.time >= gatling.nextKickAt &&
        distance(target, attacker) <= 160 + attacker.radius
      ) {
        gatling.nextKickAt = this.time + 0.5;
        const direction = normalize({ x: attacker.x - target.x, y: attacker.y - target.y });
        attacker.x = Math.max(
          attacker.radius,
          Math.min(this.board.width - attacker.radius, attacker.x + direction.x * 140),
        );
        attacker.y = Math.max(
          attacker.radius,
          Math.min(this.board.height - attacker.radius, attacker.y + direction.y * 140),
        );
        const attackerDefinition = this.definitions.get(attacker.definitionId);
        const speed = attackerDefinition?.speed ?? Math.hypot(attacker.vx, attacker.vy);
        attacker.vx = direction.x * speed;
        attacker.vy = direction.y * speed;
        target.action = "kick";
        target.actionStartedAt = this.time;
        target.actionUntil = this.time + 0.35;
        this.emit("skill", `${target.name} 一脚踹开 ${attacker.name}`, target, attacker, "kick");
      }
    }
  }

  private spawnPolice(owner: RuntimeUnit, star: 1 | 2 | 3 | 4 | 5): RuntimeUnit | undefined {
    const definition = this.definitions.get(`police-${star}`);
    if (!definition) return undefined;
    const angle = this.random.angle();
    const spawnDistance = owner.radius + definition.radius + 16;
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

  private mergePolice(ownerId: string): void {
    for (let star = 1 as 1 | 2 | 3 | 4; star <= 4; star = (star + 1) as 1 | 2 | 3 | 4) {
      let candidates = [...this.units.values()]
        .filter(
          (unit) =>
            !unit.main &&
            unit.ownerId === ownerId &&
            unit.policeStar === star &&
            unit.action !== "dead",
        )
        .sort((left, right) => left.bornAt - right.bornAt || left.id.localeCompare(right.id));
      while (candidates.length >= 2) {
        const left = candidates.shift();
        const right = candidates.shift();
        if (!left || !right) break;
        const nextStar = (star + 1) as 2 | 3 | 4 | 5;
        const owner = this.units.get(ownerId);
        const definition = this.definitions.get(`police-${nextStar}`);
        if (!definition || !owner) break;
        this.units.delete(left.id);
        this.units.delete(right.id);
        const merged = this.createUnit({
          definition,
          ownerId,
          factionId: owner.factionId,
          main: false,
          name: `${owner.name}的${nextStar}星警察`,
          x: (left.x + right.x) / 2,
          y: (left.y + right.y) / 2,
        });
        this.units.set(merged.id, merged);
        this.emit(
          "merge",
          `两名${star}星警察合成为${nextStar}星`,
          merged,
          undefined,
          "merge",
        );
        candidates = [...this.units.values()]
          .filter(
            (unit) =>
              !unit.main &&
              unit.ownerId === ownerId &&
              unit.policeStar === star &&
              unit.action !== "dead",
          )
          .sort((a, b) => a.bornAt - b.bornAt || a.id.localeCompare(b.id));
      }
    }
  }

  private flattenHoles(): void {
    for (const hole of [...this.holes.values()]) {
      const enemy = [...this.units.values()].find(
        (unit) =>
          unit.targetable &&
          unit.factionId !== hole.ownerId &&
          distance(unit, hole) <= unit.radius + hole.radius,
      );
      if (!enemy) continue;
      this.holes.delete(hole.id);
      this.emitAt(
        "prop",
        `${enemy.name} 踩平了一处地鼠洞`,
        hole.x,
        hole.y,
        "dig",
      );
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
    this.emit(
      "death",
      source ? `${target.name} 被 ${source.name} 击败` : `${target.name} 倒下了`,
      target,
      source,
      "death",
    );
    this.runModules(target, "onDeath");

    if (target.main) {
      for (const unit of [...this.units.values()]) {
        if (!unit.main && unit.ownerId === target.ownerId) this.units.delete(unit.id);
      }
      for (const hole of [...this.holes.values()]) {
        if (hole.ownerId === target.ownerId) this.holes.delete(hole.id);
      }
      for (const projectile of [...this.projectiles.values()]) {
        if (projectile.ownerId === target.ownerId) this.projectiles.delete(projectile.id);
      }
    }
  }

  private cleanupDeadUnits(): void {
    for (const unit of [...this.units.values()]) {
      if (unit.action === "dead" && this.time >= unit.actionUntil) this.units.delete(unit.id);
    }
  }

  private checkVictory(): void {
    if (this.status === "finished" || this.time < 0.5) return;
    const livingMain = [...this.units.values()].filter(
      (unit) => unit.main && unit.targetable && unit.action !== "dead",
    );
    if (livingMain.length > 1) {
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
    if (livingMain.length === 1) {
      this.winnerId = livingMain[0].id;
      this.winnerName = livingMain[0].name;
      this.emit("victory", `${livingMain[0].name} 成为最后赢家！`, livingMain[0]);
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

  private touchesLava(unit: RuntimeUnit): boolean {
    return this.props.some(
      (prop) =>
        prop.active &&
        prop.type === "lava" &&
        circleOverlapsRegion(unit, unit.radius, prop.shape),
    );
  }

  private runIntervalModules(unit: RuntimeUnit): void {
    const definition = this.definitions.get(unit.definitionId);
    if (!definition) return;
    for (const module of definition.abilities) {
      if (module.trigger !== "interval") continue;
      if (this.time < (unit.moduleCooldowns[module.id] ?? 0)) continue;
      this.executeModule(unit, module);
    }
  }

  private runModules(
    unit: RuntimeUnit,
    trigger: "onDamageTaken" | "onAttack" | "onDeath",
  ): void {
    const definition = this.definitions.get(unit.definitionId);
    if (!definition) return;
    for (const module of definition.abilities) {
      if (module.trigger !== trigger) continue;
      if (this.time < (unit.moduleCooldowns[module.id] ?? 0)) continue;
      this.executeModule(unit, module);
    }
  }

  private executeModule(unit: RuntimeUnit, module: AbilityModule): void {
    if (module.hpBelowRatio !== undefined && unit.hp / unit.maxHp > module.hpBelowRatio) return;
    for (const action of module.actions) this.executeModuleAction(unit, action);
    unit.moduleCooldowns[module.id] =
      this.time + (module.trigger === "interval" ? module.interval ?? module.cooldown : module.cooldown);
    this.emit("skill", `${unit.name} 触发技能「${module.name}」`, unit);
  }

  private executeModuleAction(unit: RuntimeUnit, action: AbilityAction): void {
    if (action.kind === "heal") {
      const amount = Math.min(action.amount, unit.maxHp - unit.hp);
      unit.hp += amount;
      this.emit("heal", `${unit.name} 回复 ${Math.round(amount)} 点血`, unit, undefined, "heal");
    } else if (action.kind === "damageNearby") {
      for (const target of this.validTargets(unit, action.radius)) {
        this.damageUnit(target.id, action.amount, unit.id, "attack");
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
          x: unit.x + Math.cos(angle) * (unit.radius + definition.radius + 10),
          y: unit.y + Math.sin(angle) * (unit.radius + definition.radius + 10),
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
