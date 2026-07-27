import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultManifest,
  upgradeManifest,
} from "../lib/game/defaultContent";
import { removeBoardFromManifest } from "../lib/game/project";
import {
  BattleSimulation,
  UNIT_ENTRANCE_DURATION,
  circleOverlapsRegion,
} from "../lib/game/simulation";
import { actionClipName } from "../lib/game/unitAnimation";
import { isSkillVoiceEvent } from "../lib/game/audio";
import type {
  BoardDefinition,
  CharacterDefinition,
  ProjectManifest,
  RuntimeUnit,
} from "../lib/game/types";

const preparedSimulations = new WeakSet<BattleSimulation>();

const runSteps = (simulation: BattleSimulation, count: number, dt = 1 / 60): void => {
  const snapshot = simulation.getSnapshot();
  if (
    snapshot.status === "running" &&
    snapshot.units.some((unit) => unit.action === "entering") &&
    !preparedSimulations.has(simulation)
  ) {
    const leadInSteps = Math.max(
      0,
      Math.ceil(UNIT_ENTRANCE_DURATION / dt) - 1,
    );
    for (let index = 0; index < leadInSteps; index += 1) {
      simulation.step(dt);
    }
    preparedSimulations.add(simulation);
  }
  for (let index = 0; index < count; index += 1) simulation.step(dt);
};

const selectedBoard = (manifest: ProjectManifest): BoardDefinition => {
  const board = manifest.boards.find((candidate) => candidate.id === manifest.setup.boardId);
  assert.ok(board);
  return board;
};

const definition = (manifest: ProjectManifest, id: string): CharacterDefinition => {
  const character = manifest.characters.find((candidate) => candidate.id === id);
  assert.ok(character);
  return character;
};

const twoFighterManifest = (): ProjectManifest => {
  const manifest = createDefaultManifest();
  manifest.setup.boardId = "stream-landscape";
  const board = selectedBoard(manifest);
  board.props = [];
  board.unitScale = 1;
  manifest.setup.contestants = [
    {
      id: "test-panda",
      definitionId: "panda-lazy",
      displayName: "测试熊猫",
      position: { x: 180, y: 180 },
      direction: { x: 0.82, y: 0.57 },
      color: "#f6d85f",
    },
    {
      id: "test-mole",
      definitionId: "mole",
      displayName: "测试地鼠",
      position: { x: 1_420, y: 720 },
      direction: { x: -0.76, y: -0.65 },
      color: "#ff8b62",
    },
  ];
  return manifest;
};

const disableCombat = (manifest: ProjectManifest): void => {
  for (const character of manifest.characters) {
    character.attack.range = 0;
    character.attack.damage = 0;
  }
};

test("circle/rectangle/polygon regions use area intersections rather than point triggers", () => {
  assert.equal(
    circleOverlapsRegion({ x: 145, y: 100 }, 10, {
      kind: "circle",
      x: 100,
      y: 100,
      radius: 35,
    }),
    true,
  );
  assert.equal(
    circleOverlapsRegion({ x: 80, y: 120 }, 22, {
      kind: "rectangle",
      x: 100,
      y: 100,
      width: 80,
      height: 60,
    }),
    true,
  );
  assert.equal(
    circleOverlapsRegion({ x: 125, y: 125 }, 8, {
      kind: "polygon",
      points: [
        { x: 100, y: 100 },
        { x: 150, y: 100 },
        { x: 100, y: 150 },
      ],
    }),
    true,
  );
});

test("fixed-step simulation is deterministic for a repeated seed", () => {
  const manifest = createDefaultManifest();
  const first = new BattleSimulation(structuredClone(manifest));
  const second = new BattleSimulation(structuredClone(manifest));
  first.start();
  second.start();
  runSteps(first, 900);
  runSteps(second, 900);
  assert.deepEqual(first.getSnapshot(), second.getSnapshot());
});

test("initial contestants finish a protected 0.8 second entrance before combat", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.props = [];
  disableCombat(manifest);
  for (const character of manifest.characters) character.speed = 0;

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  const initial = simulation.getSnapshot();
  const initialPositions = initial.units.map((unit) => ({
    id: unit.id,
    x: unit.x,
    y: unit.y,
    hp: unit.hp,
  }));
  assert.ok(initial.units.every((unit) => unit.action === "entering"));
  assert.ok(initial.units.every((unit) => unit.targetable === false));

  simulation.step(UNIT_ENTRANCE_DURATION - 0.01);
  const protectedSnapshot = simulation.getSnapshot();
  assert.ok(protectedSnapshot.units.every((unit) => unit.action === "entering"));
  assert.ok(protectedSnapshot.units.every((unit) => unit.targetable === false));
  assert.deepEqual(
    protectedSnapshot.units.map((unit) => ({
      id: unit.id,
      x: unit.x,
      y: unit.y,
      hp: unit.hp,
    })),
    initialPositions,
  );

  simulation.step(0.02);
  const activeSnapshot = simulation.getSnapshot();
  assert.ok(activeSnapshot.units.every((unit) => unit.action !== "entering"));
  assert.ok(activeSnapshot.units.every((unit) => unit.targetable === true));
});

test("movement headings reroll with seeded horizontal-biased angular variation", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.props = [];
  const panda = definition(manifest, "panda-lazy");
  const mole = definition(manifest, "mole");
  panda.pluginId = undefined;
  panda.speed = 120;
  panda.attack = {
    range: 2_000,
    damage: 0,
    cooldown: 100,
    windup: 0,
    mode: "melee",
    frontArcDegrees: 360,
  };
  mole.pluginId = undefined;
  mole.speed = 0;
  mole.attack.range = 0;
  mole.attack.damage = 0;
  manifest.setup.contestants[0].position = { x: 300, y: 300 };
  manifest.setup.contestants[0].direction = { x: 1, y: 0 };
  manifest.setup.contestants[1].position = { x: 900, y: 500 };

  const first = new BattleSimulation(structuredClone(manifest));
  const second = new BattleSimulation(structuredClone(manifest));
  const initialFirst = first.getSnapshot().units.find((unit) => unit.definitionId === "panda-lazy");
  const initialSecond = second.getSnapshot().units.find((unit) => unit.definitionId === "panda-lazy");
  assert.ok(initialFirst);
  assert.ok(initialSecond);
  const initialHorizontalDeviation = Math.atan2(
    Math.abs(initialFirst.vy),
    Math.abs(initialFirst.vx),
  );
  assert.ok(initialHorizontalDeviation >= (8 * Math.PI) / 180);
  assert.ok(initialHorizontalDeviation <= (65 * Math.PI) / 180);
  assert.equal(initialFirst.vx, initialSecond.vx);
  assert.equal(initialFirst.vy, initialSecond.vy);

  first.start();
  runSteps(first, 90);
  const resumed = first.getSnapshot().units.find((unit) => unit.id === initialFirst.id);
  assert.ok(resumed);
  const initialAngle = Math.atan2(initialFirst.vy, initialFirst.vx);
  const resumedAngle = Math.atan2(resumed.vy, resumed.vx);
  const difference = Math.atan2(
    Math.sin(resumedAngle - initialAngle),
    Math.cos(resumedAngle - initialAngle),
  );
  assert.ok(Math.abs(difference) > 0.0001);
  const resumedHorizontalDeviation = Math.atan2(
    Math.abs(resumed.vy),
    Math.abs(resumed.vx),
  );
  assert.ok(resumedHorizontalDeviation >= (8 * Math.PI) / 180);
  assert.ok(resumedHorizontalDeviation <= (65 * Math.PI) / 180);
  assert.equal(Math.sign(resumed.vx), Math.sign(initialFirst.vx));
});

test("vertical-dominant movement remains uncommon across seeded headings", () => {
  const manifest = createDefaultManifest();
  const panda = definition(manifest, "panda-lazy");
  panda.pluginId = undefined;
  panda.speed = 100;
  manifest.setup.contestants = Array.from({ length: 320 }, (_, index) => ({
    id: `heading-sample-${index}`,
    definitionId: panda.id,
    displayName: `方向样本 ${index}`,
    position: { x: 450, y: 800 },
    direction: { x: 0, y: 1 },
    color: "#ffffff",
  }));

  const simulation = new BattleSimulation(manifest);
  const units = simulation.getSnapshot().units;
  assert.equal(units.length, 320);
  const deviations = units.map((unit) =>
    Math.atan2(Math.abs(unit.vy), Math.abs(unit.vx)),
  );
  assert.ok(
    deviations.every(
      (deviation) =>
        deviation >= (8 * Math.PI) / 180 &&
        deviation <= (65 * Math.PI) / 180,
    ),
  );
  const verticalDominant = deviations.filter(
    (deviation) => deviation > Math.PI / 4,
  ).length;
  assert.ok(verticalDominant / deviations.length < 0.2);
  assert.ok(units.some((unit) => unit.vx < 0));
  assert.ok(units.some((unit) => unit.vx > 0));
});

test("mole tunneling uses travel art underground and attack art only after a successful ambush", () => {
  const unit: Pick<RuntimeUnit, "action" | "tunnelData"> = {
    action: "tunneling" as const,
    tunnelData: {
      mode: "ambush" as const,
      origin: { x: 0, y: 0 },
      destination: { x: 100, y: 100 },
      travelStartedAt: 0.12,
      arrivalAt: 0.9,
      attackAt: 1,
      hitSucceeded: false,
    },
  };
  assert.equal(actionClipName(unit, 0.05), "tunnelEnter");
  assert.equal(actionClipName(unit, 0.5), "tunnelMove");
  assert.equal(actionClipName(unit, 0.95), "tunnelEmerge");
  assert.equal(actionClipName(unit, 1.02), "tunnelEmerge");

  const tunnel = unit.tunnelData;
  assert.ok(tunnel);
  tunnel.hitSucceeded = true;
  assert.equal(actionClipName(unit, 1.02), "tunnelAttack");
  tunnel.returnStartedAt = 1.12;
  tunnel.returnArrivalAt = 1.8;
  assert.equal(actionClipName(unit, 1.3), "tunnelMove");
  assert.equal(actionClipName(unit, 1.81), "tunnelEmerge");
});

test("units mirror their velocity at a rectangular boundary and remain inside it", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  const panda = definition(manifest, "panda-lazy");
  const mole = definition(manifest, "mole");
  panda.speed = 120;
  panda.attack.range = 0;
  mole.speed = 0;
  mole.pluginId = undefined;
  mole.attack.range = 0;
  manifest.setup.contestants[0].position = { x: board.width - 50, y: board.height / 2 };
  manifest.setup.contestants[0].direction = { x: 1, y: 0 };
  manifest.setup.contestants[1].position = { x: 200, y: board.height / 2 };

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 24);
  const movingPanda = simulation
    .getSnapshot()
    .units.find((unit) => unit.id === manifest.setup.contestants[0].id);
  assert.ok(movingPanda);
  assert.ok(movingPanda.vx < 0);
  assert.ok(movingPanda.x >= movingPanda.radius);
  assert.ok(movingPanda.x <= board.width - movingPanda.radius);
});

test("lava applies a three-second burning buff and does not summon police", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.props = [
    {
      id: "start-lava",
      type: "lava",
      active: true,
      label: "测试岩浆",
      shape: { kind: "circle", x: 100, y: 200, radius: 30 },
      buffDuration: 3,
      effectPerSecond: 5,
    },
  ];
  disableCombat(manifest);
  const panda = definition(manifest, "panda-lazy");
  const mole = definition(manifest, "mole");
  panda.speed = 120;
  mole.speed = 0;
  mole.pluginId = undefined;
  manifest.setup.contestants[0].position = { x: 100, y: 200 };
  manifest.setup.contestants[0].direction = { x: 1, y: 0 };
  manifest.setup.contestants[1].position = { x: 1200, y: 700 };

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 120);
  const snapshot = simulation.getSnapshot();
  const runtimePanda = snapshot.units.find((unit) => unit.definitionId === "panda-lazy");
  assert.ok(runtimePanda);
  assert.ok(runtimePanda.x > 250, "the panda should already be outside the lava circle");
  assert.ok(runtimePanda.burnUntil > snapshot.time, "burning should persist after leaving");
  assert.ok(runtimePanda.hp <= runtimePanda.maxHp - 5);
  assert.equal(snapshot.units.some((unit) => unit.policeStar !== undefined), false);
});

test("hot spring healing persists for three seconds after leaving the region", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.props = [
    {
      id: "spring-strip",
      type: "hotSpring",
      active: true,
      shape: { kind: "rectangle", x: 40, y: 150, width: 100, height: 100 },
      buffDuration: 3,
      effectPerSecond: 12,
    },
  ];
  const panda = definition(manifest, "panda-lazy");
  const mole = definition(manifest, "mole");
  panda.speed = 120;
  panda.pluginId = undefined;
  mole.speed = 0;
  mole.pluginId = undefined;
  mole.attack = {
    range: 9999,
    damage: 60,
    cooldown: 100,
    windup: 0,
    mode: "projectile",
    projectileKind: "bullet",
    projectileSpeed: 2_000,
  };
  panda.attack.range = 0;
  panda.attack.damage = 0;
  manifest.setup.contestants[0].position = { x: 70, y: 200 };
  manifest.setup.contestants[0].direction = { x: 1, y: 0 };
  manifest.setup.contestants[1].position = { x: 1200, y: 700 };

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 80);
  const before = simulation
    .getSnapshot()
    .units.find((unit) => unit.definitionId === "panda-lazy");
  assert.ok(before);
  assert.ok(before.x > 180, "the panda should have left the spring");
  assert.ok(before.springUntil > simulation.getSnapshot().time);
  const hpBefore = before.hp;
  runSteps(simulation, 65);
  const after = simulation
    .getSnapshot()
    .units.find((unit) => unit.definitionId === "panda-lazy");
  assert.ok(after);
  assert.ok(after.hp > hpBefore, "the spring buff should keep healing outside the spring");
});

test("police only merge on collision and can chain to five stars", () => {
  const separatedManifest = twoFighterManifest();
  const separatedPanda = definition(separatedManifest, "panda-lazy");
  const separatedAttacker = definition(separatedManifest, "mole");
  separatedPanda.maxHp = 10_000;
  separatedPanda.speed = 0;
  separatedPanda.radius = 300;
  separatedPanda.attack.range = 0;
  separatedPanda.attack.damage = 0;
  separatedPanda.skillParameters!.panda!.policeMergePadding = 0;
  separatedAttacker.pluginId = undefined;
  separatedAttacker.speed = 0;
  separatedAttacker.attack = {
    range: 1,
    damage: 1,
    cooldown: 0.5,
    windup: 0,
    mode: "melee",
  };
  for (const police of separatedManifest.characters.filter((character) => character.policeStar)) {
    police.speed = 0;
    police.radius = 1;
    police.attack.range = 0;
    police.attack.damage = 0;
  }
  separatedManifest.setup.contestants[0].position = { x: 800, y: 450 };
  separatedManifest.setup.contestants[1].position = { x: 800, y: 450 };
  const separated = new BattleSimulation(separatedManifest);
  separated.start();
  runSteps(separated, 80);
  const separatedSnapshot = separated.getSnapshot();
  assert.ok(
    separatedSnapshot.units.filter((unit) => unit.policeStar === 1).length >= 2,
    "two one-star police should coexist before touching",
  );
  assert.equal(separatedSnapshot.units.some((unit) => unit.policeStar === 2), false);

  const chainManifest = structuredClone(separatedManifest);
  definition(chainManifest, "panda-lazy").skillParameters!.panda!.policeMergePadding = 10_000;
  const chain = new BattleSimulation(chainManifest);
  chain.start();
  runSteps(chain, 1_000);
  const chainSnapshot = chain.getSnapshot();
  const fiveStarProtectionPolice = chainSnapshot.units.find(
    (unit) => unit.policeStar === 5,
  );
  assert.ok(
    fiveStarProtectionPolice,
    `remaining police: ${JSON.stringify(
      chainSnapshot.units
        .filter((unit) => unit.policeStar)
        .map((unit) => ({ star: unit.policeStar, hp: unit.hp })),
    )}; merges=${chainSnapshot.events.filter((event) => event.type === "merge").length}; spawns=${
      chainSnapshot.events.filter((event) => event.type === "spawn").length
    }`,
  );
  assert.equal(fiveStarProtectionPolice.sustainsFaction, true);
  assert.ok(
    chainSnapshot.events.some(
      (event) => event.type === "spawn" && event.message.includes("人类警察赶来保护"),
    ),
  );
});

test("a mole can use another mole's hole for a cross-owner ambush", () => {
  const manifest = twoFighterManifest();
  const mole = definition(manifest, "mole");
  disableCombat(manifest);
  mole.speed = 0;
  mole.attack.damage = 15;
  mole.skillParameters!.mole!.digCooldown = 100;
  mole.skillParameters!.mole!.minimumHoleDistance = 220;
  manifest.setup.contestants = [
    {
      id: "mole-a",
      definitionId: "mole",
      displayName: "A地鼠",
      position: { x: 250, y: 450 },
      direction: { x: 1, y: 0 },
      color: "#ff8b62",
    },
    {
      id: "mole-b",
      definitionId: "mole",
      displayName: "B地鼠",
      position: { x: 1350, y: 450 },
      direction: { x: -1, y: 0 },
      color: "#8fb8ff",
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 70);
  const snapshot = simulation.getSnapshot();
  assert.equal(snapshot.holes.length, 2);
  assert.ok(
    snapshot.events.some(
      (event) =>
        event.type === "skill" &&
        event.message.includes("另一处洞口偷袭") &&
        event.unitId !== event.targetId,
    ),
  );
});

test("holes remain open after repeated enemy crossings", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.width = 500;
  board.height = 300;
  disableCombat(manifest);
  const panda = definition(manifest, "panda-lazy");
  const mole = definition(manifest, "mole");
  panda.pluginId = undefined;
  panda.speed = 100;
  mole.speed = 0;
  mole.skillParameters!.mole!.holeRadius = 80;
  mole.skillParameters!.mole!.digCooldown = 100;
  manifest.setup.contestants[0].position = { x: 80, y: 150 };
  manifest.setup.contestants[0].direction = { x: 1, y: 0 };
  manifest.setup.contestants[1].position = { x: 250, y: 150 };
  manifest.setup.contestants[1].direction = { x: 0, y: 1 };

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 720);
  const snapshot = simulation.getSnapshot();
  assert.equal(snapshot.holes.length, 1);
  assert.ok(
    snapshot.events.every(
      (event) =>
        !event.message.includes("踩中洞口") &&
        !event.message.includes("踩平"),
    ),
  );
});

test("mole dig cooldown begins only after the new hole is completed", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.props = [];
  disableCombat(manifest);
  const panda = definition(manifest, "panda-lazy");
  const mole = definition(manifest, "mole");
  panda.pluginId = undefined;
  panda.speed = 0;
  mole.speed = 0;
  mole.skillParameters!.mole!.digDuration = 0.6;
  mole.skillParameters!.mole!.digCooldown = 2;
  mole.skillParameters!.mole!.minimumHoleDistance = 10_000;

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 1);
  let snapshot = simulation.getSnapshot();
  let runtimeMole = snapshot.units.find((unit) => unit.definitionId === "mole");
  assert.ok(runtimeMole);
  assert.equal(runtimeMole.action, "digging");
  assert.ok(
    runtimeMole.nextDigAt <= snapshot.time,
    "the cooldown must not be consumed when the dig animation starts",
  );

  for (let step = 0; step < 60; step += 1) {
    simulation.step(1 / 60);
    snapshot = simulation.getSnapshot();
    runtimeMole = snapshot.units.find((unit) => unit.definitionId === "mole");
    assert.ok(runtimeMole);
    if (snapshot.holes.length === 1 && runtimeMole.action !== "digging") break;
  }

  assert.equal(snapshot.holes.length, 1);
  assert.ok(runtimeMole);
  assert.notEqual(runtimeMole.action, "digging");
  assert.ok(
    Math.abs(runtimeMole.nextDigAt - snapshot.time - 2) <= 1 / 60 + 1e-9,
    "the full configured cooldown should remain at hole completion",
  );
});

test("a mole's holes are removed with the owner and the death fade completes", () => {
  const manifest = twoFighterManifest();
  const panda = definition(manifest, "panda-lazy");
  const mole = definition(manifest, "mole");
  panda.pluginId = undefined;
  panda.speed = 0;
  panda.attack = {
    range: 9999,
    damage: 999,
    cooldown: 10,
    windup: 1.2,
    mode: "projectile",
    projectileKind: "bullet",
    projectileSpeed: 2_000,
  };
  mole.speed = 0;
  mole.attack.range = 0;
  manifest.setup.contestants[0].position = { x: 150, y: 150 };
  manifest.setup.contestants[1].position = { x: 1400, y: 700 };

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 50);
  assert.equal(simulation.getSnapshot().holes.length, 1);
  runSteps(simulation, 140);
  const snapshot = simulation.getSnapshot();
  assert.equal(snapshot.holes.length, 0);
  assert.equal(snapshot.status, "finished");
  assert.equal(snapshot.units.some((unit) => unit.definitionId === "mole"), false);
});

test("an RPG that misses its moving target explodes on the board edge", () => {
  const manifest = twoFighterManifest();
  const rocketOfficer = definition(manifest, "police-4");
  const panda = definition(manifest, "panda-lazy");
  rocketOfficer.role = "contestant";
  rocketOfficer.speed = 0;
  rocketOfficer.attack.windup = 0;
  rocketOfficer.attack.cooldown = 10;
  panda.pluginId = undefined;
  panda.speed = 220;
  panda.attack.range = 0;
  manifest.setup.contestants = [
    {
      id: "rocket-officer",
      definitionId: "police-4",
      displayName: "火箭警员",
      position: { x: 800, y: 120 },
      direction: { x: 1, y: 0 },
      color: "#ff9f58",
    },
    {
      id: "moving-target",
      definitionId: "panda-lazy",
      displayName: "移动靶",
      position: { x: 800, y: 300 },
      direction: { x: 1, y: 0 },
      color: "#f6d85f",
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 300);
  assert.ok(
    simulation
      .getSnapshot()
      .events.some((event) => event.message.includes("RPG 撞上棋盘边界并爆炸")),
  );
});

test("five-star police keeps one round direction while applying configurable spread", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.width = 2_000;
  board.height = 1_200;
  const officer = definition(manifest, "police-5");
  const target = definition(manifest, "mole");
  officer.speed = 0;
  officer.attack.damage = 0;
  officer.attack.range = 2_000;
  officer.attack.cooldown = 3;
  officer.attack.windup = 0;
  officer.attack.projectileSpeed = 20;
  officer.attack.burstCount = 4;
  officer.attack.burstGap = 0.1;
  target.pluginId = undefined;
  target.speed = 120;
  target.attack.range = 0;
  target.attack.damage = 0;
  manifest.setup.contestants = [
    {
      id: "direction-lock-officer",
      definitionId: "police-5",
      displayName: "无畏测试员",
      position: { x: 150, y: 500 },
      direction: { x: 1, y: 0 },
      color: "#f6d85f",
    },
    {
      id: "moving-lock-target",
      definitionId: "mole",
      displayName: "移动方向靶",
      position: { x: 1_600, y: 300 },
      direction: { x: 0, y: 1 },
      color: "#72d4af",
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 35);
  let projectiles = simulation.getSnapshot().projectiles;
  assert.equal(projectiles.length, 4);
  const lockedAngle = Math.atan2(300 - 500, 1_600 - 150);
  const shotAngles = projectiles.map((projectile) =>
    Math.atan2(projectile.vy, projectile.vx),
  );
  for (const angle of shotAngles) {
    const difference = Math.atan2(
      Math.sin(angle - lockedAngle),
      Math.cos(angle - lockedAngle),
    );
    assert.ok(
      Math.abs(difference) <= ((officer.attack.spreadDegrees ?? 0) * Math.PI) / 180 + 1e-9,
    );
  }
  assert.ok(
    new Set(shotAngles.map((angle) => angle.toFixed(6))).size > 1,
    "gatling spread should vary individual bullets without reacquiring the target",
  );

  runSteps(simulation, 125);
  assert.equal(simulation.getSnapshot().projectiles.length, 4);
  runSteps(simulation, 35);
  projectiles = simulation.getSnapshot().projectiles;
  assert.ok(projectiles.length > 4, "the next round should begin only after its period");
});

test("five-star kick moves the attacker over time and stuns it after a boundary impact", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.width = 500;
  board.height = 600;
  board.props = [];
  const officer = definition(manifest, "police-5");
  const attacker = definition(manifest, "panda-lazy");
  officer.speed = 0;
  officer.attack.damage = 0;
  officer.attack.cooldown = 100;
  officer.skillParameters!.police!.kickDistance = 180;
  officer.skillParameters!.police!.kickDamage = 25;
  officer.skillParameters!.police!.kickDuration = 0.35;
  officer.skillParameters!.police!.kickWallStunDuration = 0.5;
  attacker.pluginId = undefined;
  attacker.speed = 80;
  attacker.attack = {
    range: 300,
    damage: 1,
    cooldown: 100,
    windup: 0,
    mode: "melee",
  };
  manifest.setup.contestants = [
    {
      id: "wall-kicker",
      definitionId: "police-5",
      displayName: "边界测试无畏",
      position: { x: 330, y: 300 },
      direction: { x: -0.8, y: 0.6 },
      color: "#b58aff",
    },
    {
      id: "wall-kick-target",
      definitionId: "panda-lazy",
      displayName: "撞墙测试员",
      position: { x: 430, y: 300 },
      direction: { x: -0.9, y: 0.3 },
      color: "#f6d85f",
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  let knockedAt: number | undefined;
  let knockedX = 0;
  for (let index = 0; index < 120; index += 1) {
    simulation.step();
    const unit = simulation
      .getSnapshot()
      .units.find((candidate) => candidate.id === "wall-kick-target");
    assert.ok(unit);
    if (unit.action === "knockback") {
      knockedAt = simulation.getSnapshot().time;
      knockedX = unit.x;
      assert.equal(unit.knockbackData?.hitBoundary, true);
      assert.equal(unit.meleeTargetId, undefined);
      break;
    }
  }
  assert.ok(knockedAt !== undefined, "the close-range attacker should be kicked");

  runSteps(simulation, 6);
  const moving = simulation
    .getSnapshot()
    .units.find((unit) => unit.id === "wall-kick-target");
  assert.ok(moving);
  assert.equal(moving.action, "knockback");
  assert.ok(moving.x > knockedX, "knockback should visibly move across multiple steps");
  assert.equal(moving.hp, moving.maxHp - 25);

  let stunned;
  for (let index = 0; index < 30; index += 1) {
    simulation.step();
    const unit = simulation
      .getSnapshot()
      .units.find((candidate) => candidate.id === "wall-kick-target");
    assert.ok(unit);
    if (unit.action === "stunned") {
      stunned = unit;
      break;
    }
  }
  assert.ok(stunned);
  assert.equal(stunned.x, board.width - stunned.radius);
  assert.equal(stunned.meleeTargetId, undefined);
  assert.ok(stunned.stunnedUntil - simulation.getSnapshot().time > 0.45);

  const stunnedPosition = stunned.x;
  runSteps(simulation, 20);
  const stillStunned = simulation
    .getSnapshot()
    .units.find((unit) => unit.id === "wall-kick-target");
  assert.ok(stillStunned);
  assert.equal(stillStunned.action, "stunned");
  assert.equal(stillStunned.x, stunnedPosition);
});

test("burning and spring buffs settle exactly once per second", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.props = [
    {
      id: "tick-lava",
      type: "lava",
      active: true,
      shape: { kind: "circle", x: 180, y: 180, radius: 120 },
      buffDuration: 3,
      effectPerSecond: 5,
    },
  ];
  disableCombat(manifest);
  const panda = definition(manifest, "panda-lazy");
  const mole = definition(manifest, "mole");
  panda.pluginId = undefined;
  panda.speed = 0;
  mole.pluginId = undefined;
  mole.speed = 0;
  manifest.setup.contestants[0].position = { x: 180, y: 180 };
  manifest.setup.contestants[1].position = { x: 1200, y: 700 };

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 59);
  let runtimePanda = simulation
    .getSnapshot()
    .units.find((unit) => unit.definitionId === "panda-lazy");
  assert.ok(runtimePanda);
  assert.equal(runtimePanda.hp, runtimePanda.maxHp);

  runSteps(simulation, 2);
  runtimePanda = simulation
    .getSnapshot()
    .units.find((unit) => unit.definitionId === "panda-lazy");
  assert.ok(runtimePanda);
  assert.equal(runtimePanda.hp, runtimePanda.maxHp - 5);

  runSteps(simulation, 60);
  runtimePanda = simulation
    .getSnapshot()
    .units.find((unit) => unit.definitionId === "panda-lazy");
  assert.ok(runtimePanda);
  assert.equal(runtimePanda.hp, runtimePanda.maxHp - 10);
});

test("a panda remains targetable and keeps taking direct attacks while eating bamboo", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.props = [
    {
      id: "meal-bamboo",
      type: "bamboo",
      active: true,
      shape: { kind: "circle", x: 250, y: 250, radius: 90 },
    },
  ];
  const panda = definition(manifest, "panda-lazy");
  const mole = definition(manifest, "mole");
  panda.speed = 0;
  panda.attack.damage = 0;
  for (const police of manifest.characters.filter((character) => character.policeStar)) {
    police.speed = 0;
    police.attack.damage = 0;
    police.attack.range = 0;
  }
  mole.pluginId = undefined;
  mole.speed = 0;
  mole.attack = {
    range: 9999,
    damage: 10,
    cooldown: 0.25,
    windup: 0,
    mode: "projectile",
    projectileKind: "bullet",
    projectileSpeed: 2_000,
  };
  manifest.setup.contestants[0].position = { x: 250, y: 250 };
  manifest.setup.contestants[1].position = { x: 1200, y: 700 };

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  let callSnapshot = simulation.getSnapshot();
  let sawPoliceCall = false;
  for (let index = 0; index < 120; index += 1) {
    simulation.step();
    const currentSnapshot = simulation.getSnapshot();
    if (currentSnapshot.events.some((event) => event.type === "spawn")) {
      callSnapshot = currentSnapshot;
      sawPoliceCall = true;
      break;
    }
  }
  assert.equal(sawPoliceCall, true);
  simulation.step();
  callSnapshot = simulation.getSnapshot();
  const callingPanda = callSnapshot.units.find(
    (unit) => unit.definitionId === "panda-lazy",
  );
  assert.ok(callingPanda);
  assert.equal(callingPanda.action, "eating");
  assert.ok(callingPanda.pandaCallUntil > callSnapshot.time);
  const protectivePolice = callSnapshot.units.find(
    (unit) => unit.policeStar === 1 && !unit.main,
  );
  assert.ok(protectivePolice);
  assert.equal(protectivePolice.action, "entering");
  assert.equal(protectivePolice.targetable, false);
  assert.equal(protectivePolice.sustainsFaction, true);
  assert.equal(protectivePolice.factionId, callingPanda.factionId);

  runSteps(simulation, 100);
  const runtimePanda = simulation
    .getSnapshot()
    .units.find((unit) => unit.definitionId === "panda-lazy");
  assert.ok(runtimePanda);
  assert.equal(runtimePanda.action, "eating");
  assert.equal(runtimePanda.targetable, true);
  assert.ok(runtimePanda.hp <= runtimePanda.maxHp - 20);

  let completedPanda = runtimePanda;
  let finishedEating = false;
  for (let index = 0; index < 360; index += 1) {
    simulation.step();
    const currentSnapshot = simulation.getSnapshot();
    if (currentSnapshot.events.some((event) => event.message.includes("吃完竹子"))) {
      completedPanda =
        currentSnapshot.units.find((unit) => unit.definitionId === "panda-lazy") ??
        completedPanda;
      finishedEating = true;
      break;
    }
  }
  assert.equal(finishedEating, true);
  assert.equal(completedPanda.action, "satisfied");
  const pandaDefinition = definition(manifest, "panda-lazy");
  assert.equal(pandaDefinition.animations.eat.loop, true);
  assert.equal(
    pandaDefinition.animations.eat.frames.some(
      (frame) => frame.assetId === "panda-lazy-skill-4",
    ),
    false,
  );
  assert.deepEqual(
    pandaDefinition.animations.eatComplete.frames.map((frame) => frame.assetId),
    ["panda-lazy-skill-4"],
  );
  assert.deepEqual(
    pandaDefinition.animations.callPolice.frames.map((frame) => frame.assetId),
    [
      "panda-lazy-sos",
      "panda-lazy-sos-2",
      "panda-lazy-idle",
    ],
  );
});

test("a mole can ambush through a single nearby hole and stays immune to new damage while tunneling", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.props = [
    {
      id: "mole-lava",
      type: "lava",
      active: true,
      shape: { kind: "circle", x: 250, y: 250, radius: 120 },
      buffDuration: 3,
      effectPerSecond: 5,
    },
  ];
  const mole = definition(manifest, "mole");
  const panda = definition(manifest, "panda-lazy");
  mole.speed = 0;
  mole.attack.damage = 15;
  mole.skillParameters!.mole!.digCooldown = 100;
  mole.skillParameters!.mole!.tunnelDuration = 1;
  panda.pluginId = undefined;
  panda.speed = 0;
  panda.attack = {
    range: 9999,
    damage: 100,
    cooldown: 100,
    windup: 0.75,
    mode: "melee",
  };
  manifest.setup.contestants = [
    {
      id: "single-hole-mole",
      definitionId: "mole",
      displayName: "单洞地鼠",
      position: { x: 250, y: 250 },
      direction: { x: 1, y: 0 },
      color: "#ff8b62",
    },
    {
      id: "single-hole-target",
      definitionId: "panda-lazy",
      displayName: "洞边目标",
      position: { x: 420, y: 250 },
      direction: { x: -1, y: 0 },
      color: "#f6d85f",
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 78);
  const snapshot = simulation.getSnapshot();
  const runtimeMole = snapshot.units.find((unit) => unit.id === "single-hole-mole");
  assert.ok(runtimeMole);
  assert.equal(snapshot.holes.length, 1);
  assert.equal(runtimeMole.action, "tunneling");
  assert.equal(runtimeMole.targetable, false);
  assert.equal(runtimeMole.hp, runtimeMole.maxHp - 5, "existing burn should continue underground");
  assert.ok(
    snapshot.events.some((event) => event.message.includes("同一洞口突袭")),
    "the single-hole ambush animation path should be selected",
  );
});

test("mole ambush cooldown begins after emergence or a completed return", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.props = [];
  const mole = definition(manifest, "mole");
  const panda = definition(manifest, "panda-lazy");
  mole.speed = 150;
  mole.attack.range = -100;
  mole.skillParameters!.mole!.digDuration = 0.1;
  mole.skillParameters!.mole!.digCooldown = 100;
  mole.skillParameters!.mole!.ambushRange = 300;
  mole.skillParameters!.mole!.ambushCooldown = 2;
  mole.skillParameters!.mole!.tunnelDuration = 0.2;
  panda.pluginId = undefined;
  panda.speed = 0;
  panda.maxHp = 10_000;
  panda.attack.range = 0;
  panda.attack.damage = 0;
  manifest.setup.contestants[0].position = { x: 250, y: 250 };
  manifest.setup.contestants[1].position = { x: 390, y: 250 };

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  let sawAmbush = false;
  let completedAt: number | undefined;
  let completedMole: RuntimeUnit | undefined;
  for (let step = 0; step < 240; step += 1) {
    simulation.step(1 / 60);
    const snapshot = simulation.getSnapshot();
    const runtimeMole = snapshot.units.find(
      (unit) => unit.definitionId === "mole",
    );
    assert.ok(runtimeMole);
    if (runtimeMole.tunnelData?.mode === "ambush") {
      sawAmbush = true;
      assert.ok(
        runtimeMole.nextAmbushAt <= snapshot.time,
        "ambush cooldown must remain unused throughout the tunnel action",
      );
    } else if (sawAmbush && runtimeMole.action !== "tunneling") {
      completedAt = snapshot.time;
      completedMole = runtimeMole;
      break;
    }
  }

  assert.equal(sawAmbush, true);
  assert.ok(completedAt !== undefined);
  assert.ok(completedMole);
  assert.ok(
    Math.abs(completedMole.nextAmbushAt - completedAt - 2) <=
      1 / 60 + 1e-9,
    "the full cooldown should remain when the mole becomes targetable again",
  );
});

test("random tunnel travel does not consume the ambush cooldown", () => {
  const manifest = createDefaultManifest();
  const board = selectedBoard(manifest);
  board.props = [];
  board.unitScale = 1;
  const mole = definition(manifest, "mole");
  const panda = definition(manifest, "panda-lazy");
  mole.speed = 0;
  mole.attack.range = -100;
  mole.skillParameters!.mole!.digDuration = 0.1;
  mole.skillParameters!.mole!.digCooldown = 100;
  mole.skillParameters!.mole!.ambushRange = 0;
  mole.skillParameters!.mole!.ambushCooldown = 7;
  mole.skillParameters!.mole!.tunnelDuration = 0.2;
  mole.skillParameters!.mole!.tunnelChance = 1;
  panda.pluginId = undefined;
  panda.speed = 0;
  panda.attack.range = 0;
  panda.attack.damage = 0;
  manifest.setup.contestants = [
    {
      id: "travel-mole-a",
      definitionId: "mole",
      displayName: "地道甲",
      position: { x: 250, y: 450 },
      direction: { x: 1, y: 0 },
      color: "#ff8b62",
      teamId: "red",
    },
    {
      id: "travel-mole-b",
      definitionId: "mole",
      displayName: "地道乙",
      position: { x: 800, y: 450 },
      direction: { x: -1, y: 0 },
      color: "#ff8b62",
      teamId: "red",
    },
    {
      id: "travel-observer",
      definitionId: "panda-lazy",
      displayName: "远处观察员",
      position: { x: 1_400, y: 750 },
      direction: { x: -1, y: 0 },
      color: "#55a7ff",
      teamId: "blue",
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  const runtimeHarness = simulation as unknown as {
    units: Map<string, RuntimeUnit>;
  };
  let primedEntry = false;
  let travelerId: string | undefined;
  let completedTraveler: RuntimeUnit | undefined;
  for (let step = 0; step < 240; step += 1) {
    simulation.step(1 / 60);
    const snapshot = simulation.getSnapshot();
    if (!primedEntry && snapshot.holes.length >= 2) {
      const runtimeMole = runtimeHarness.units.get("travel-mole-a");
      assert.ok(runtimeMole);
      runtimeMole.lastHoleId = undefined;
      primedEntry = true;
      continue;
    }
    const traveler = snapshot.units.find(
      (unit) => unit.tunnelData?.mode === "travel",
    );
    if (traveler) travelerId = traveler.id;
    if (travelerId) {
      const current = snapshot.units.find((unit) => unit.id === travelerId);
      assert.ok(current);
      if (current.action !== "tunneling") {
        completedTraveler = current;
        break;
      }
    }
  }

  assert.equal(primedEntry, true);
  assert.ok(completedTraveler);
  assert.equal(completedTraveler.nextAmbushAt, 0);
});

test("mole tunnel travel uses the editable movement-speed multiplier", () => {
  const tunnelTravelDuration = (multiplier: number): number => {
    const manifest = twoFighterManifest();
    const mole = definition(manifest, "mole");
    const panda = definition(manifest, "panda-lazy");
    disableCombat(manifest);
    mole.speed = 100;
    mole.skillParameters!.mole!.digCooldown = 100;
    mole.skillParameters!.mole!.tunnelDuration = 0.1;
    mole.skillParameters!.mole!.tunnelChance = 0;
    mole.skillParameters!.mole!.tunnelSpeedMultiplier = multiplier;
    panda.pluginId = undefined;
    panda.speed = 0;
    manifest.setup.contestants = [
      {
        id: "speed-mole",
        definitionId: "mole",
        displayName: "测速地鼠",
        position: { x: 250, y: 450 },
        direction: { x: 1, y: 0 },
        color: "#ff8b62",
        teamId: "red",
      },
      {
        id: "speed-helper",
        definitionId: "mole",
        displayName: "测速洞友",
        position: { x: 750, y: 450 },
        direction: { x: -1, y: 0 },
        color: "#ff8b62",
        teamId: "red",
      },
      {
        id: "speed-target",
        definitionId: "panda-lazy",
        displayName: "洞边测速靶",
        position: { x: 750, y: 450 },
        direction: { x: 1, y: 0 },
        color: "#55a7ff",
        teamId: "blue",
      },
    ];

    const simulation = new BattleSimulation(manifest);
    simulation.start();
    for (let step = 0; step < 120; step += 1) {
      simulation.step(1 / 60);
      const runtimeMole = simulation
        .getSnapshot()
        .units.find((unit) => unit.id === "speed-mole");
      assert.ok(runtimeMole);
      if (runtimeMole.action === "tunneling" && runtimeMole.tunnelData) {
        return (
          runtimeMole.tunnelData.arrivalAt -
          runtimeMole.tunnelData.travelStartedAt
        );
      }
    }
    assert.fail("mole should start a cross-hole tunnel");
  };

  const defaultManifest = createDefaultManifest();
  assert.equal(
    definition(defaultManifest, "mole").skillParameters?.mole
      ?.tunnelSpeedMultiplier,
    2.5,
  );
  const defaultDuration = tunnelTravelDuration(2.5);
  const fasterDuration = tunnelTravelDuration(5);
  assert.ok(Math.abs(defaultDuration - 2) < 0.001);
  assert.ok(Math.abs(fasterDuration - 1) < 0.001);
});

test("a missed cross-hole ambush emerges at its destination and becomes targetable", () => {
  const manifest = twoFighterManifest();
  const mole = definition(manifest, "mole");
  const panda = definition(manifest, "panda-lazy");
  mole.speed = 0;
  mole.attack.range = -100;
  mole.attack.damage = 15;
  mole.skillParameters!.mole!.digCooldown = 100;
  mole.skillParameters!.mole!.ambushCooldown = 100;
  mole.skillParameters!.mole!.tunnelDuration = 1;
  panda.pluginId = undefined;
  panda.speed = 400;
  panda.attack.range = 0;
  panda.attack.damage = 0;
  manifest.setup.contestants = [
    {
      id: "miss-mole",
      definitionId: "mole",
      displayName: "扑空地鼠",
      position: { x: 250, y: 450 },
      direction: { x: 1, y: 0 },
      color: "#ff8b62",
      teamId: "red",
    },
    {
      id: "helper-mole",
      definitionId: "mole",
      displayName: "挖洞队友",
      position: { x: 800, y: 450 },
      direction: { x: -1, y: 0 },
      color: "#ff8b62",
      teamId: "red",
    },
    {
      id: "fast-target",
      definitionId: "panda-lazy",
      displayName: "快速路过目标",
      position: { x: 560, y: 450 },
      direction: { x: 1, y: 0 },
      color: "#55a7ff",
      teamId: "blue",
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  let enteredTunnel = false;
  let emerged:
    | ReturnType<BattleSimulation["getSnapshot"]>["units"][number]
    | undefined;
  for (let step = 0; step < 180; step += 1) {
    simulation.step(1 / 60);
    const current = simulation
      .getSnapshot()
      .units.find((unit) => unit.id === "miss-mole");
    assert.ok(current);
    if (current.action === "tunneling") enteredTunnel = true;
    if (enteredTunnel && current.action !== "tunneling") {
      emerged = current;
      break;
    }
  }
  assert.equal(enteredTunnel, true);
  assert.ok(emerged);
  assert.equal(emerged.targetable, true);
  assert.ok(Math.abs(emerged.x - 800) < 1);
  assert.ok(Math.abs(emerged.y - 450) < 1);
  const target = simulation
    .getSnapshot()
    .units.find((unit) => unit.id === "fast-target");
  assert.ok(target);
  assert.equal(target.hp, target.maxHp);
});

test("a successful cross-hole ambush returns to a random surviving hole", () => {
  const manifest = twoFighterManifest();
  const mole = definition(manifest, "mole");
  const panda = definition(manifest, "panda-lazy");
  mole.speed = 0;
  mole.attack.range = -100;
  mole.attack.damage = 15;
  mole.skillParameters!.mole!.digCooldown = 100;
  mole.skillParameters!.mole!.ambushCooldown = 100;
  mole.skillParameters!.mole!.tunnelDuration = 1;
  panda.pluginId = undefined;
  panda.speed = 0;
  panda.attack.range = 0;
  panda.attack.damage = 0;
  manifest.setup.contestants = [
    {
      id: "return-mole",
      definitionId: "mole",
      displayName: "回洞地鼠",
      position: { x: 250, y: 450 },
      direction: { x: 1, y: 0 },
      color: "#ff8b62",
      teamId: "red",
    },
    {
      id: "return-helper",
      definitionId: "mole",
      displayName: "另一洞队友",
      position: { x: 800, y: 450 },
      direction: { x: -1, y: 0 },
      color: "#ff8b62",
      teamId: "red",
    },
    {
      id: "stationary-target",
      definitionId: "panda-lazy",
      displayName: "洞边固定靶",
      position: { x: 800, y: 450 },
      direction: { x: 1, y: 0 },
      color: "#55a7ff",
      teamId: "blue",
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  let enteredTunnel = false;
  let returned:
    | ReturnType<BattleSimulation["getSnapshot"]>["units"][number]
    | undefined;
  for (let step = 0; step < 360; step += 1) {
    simulation.step(1 / 60);
    const current = simulation
      .getSnapshot()
      .units.find((unit) => unit.id === "return-mole");
    assert.ok(current);
    if (current.action === "tunneling") enteredTunnel = true;
    if (enteredTunnel && current.action !== "tunneling") {
      returned = current;
      break;
    }
  }
  assert.equal(enteredTunnel, true);
  assert.ok(returned);
  assert.equal(returned.targetable, true);
  assert.ok(
    simulation
      .getSnapshot()
      .holes.some(
        (hole) =>
          Math.abs(hole.x - returned.x) < 1 &&
          Math.abs(hole.y - returned.y) < 1,
      ),
  );
  const target = simulation
    .getSnapshot()
    .units.find((unit) => unit.id === "stationary-target");
  assert.ok(target);
  assert.equal(target.hp, target.maxHp - 15);
});

test("allied projectiles pass through allies and team victory waits only for enemy factions", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.width = 900;
  board.height = 400;
  board.unitScale = 1;
  const officer = definition(manifest, "police-2");
  const panda = definition(manifest, "panda-lazy");
  const mole = definition(manifest, "mole");
  officer.speed = 0;
  officer.attack.windup = 0;
  officer.attack.cooldown = 100;
  officer.attack.damage = 60;
  panda.pluginId = undefined;
  panda.speed = 0;
  panda.attack.damage = 0;
  mole.pluginId = undefined;
  mole.speed = 0;
  mole.maxHp = 50;
  mole.attack.damage = 0;
  manifest.setup.contestants = [
    {
      id: "red-officer",
      definitionId: "police-2",
      displayName: "红队枪手",
      position: { x: 100, y: 200 },
      direction: { x: 1, y: 0 },
      color: "#ff6b6b",
      teamId: "red",
    },
    {
      id: "red-ally",
      definitionId: "panda-lazy",
      displayName: "红队挡路队友",
      position: { x: 340, y: 200 },
      direction: { x: 1, y: 0 },
      color: "#ff9a9a",
      teamId: "red",
    },
    {
      id: "blue-target",
      definitionId: "mole",
      displayName: "蓝队目标",
      position: { x: 620, y: 200 },
      direction: { x: -1, y: 0 },
      color: "#69a7ff",
      teamId: "blue",
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 150);
  const snapshot = simulation.getSnapshot();
  const ally = snapshot.units.find((unit) => unit.id === "red-ally");
  assert.ok(ally);
  assert.equal(ally.hp, ally.maxHp, "the allied projectile must not collide with its ally");
  assert.equal(snapshot.status, "finished");
  assert.match(snapshot.winnerName ?? "", /红队/);
  assert.ok(snapshot.events.some((event) => event.type === "victory" && event.announcement));
});

test("a panda's summoned police keeps its faction alive after the panda dies", () => {
  const manifest = createDefaultManifest();
  const board = selectedBoard(manifest);
  board.props = [];
  board.unitScale = 1;

  const panda = definition(manifest, "panda-lazy");
  panda.maxHp = 2;
  panda.speed = 0;
  panda.attack.range = 0;
  panda.attack.damage = 0;
  const attacker = definition(manifest, "mole");
  attacker.pluginId = undefined;
  attacker.maxHp = 1_000;
  attacker.speed = 0;
  attacker.attack = {
    range: 2_000,
    damage: 1,
    cooldown: 0.05,
    windup: 0,
    mode: "projectile",
    projectileKind: "bullet",
    projectileSpeed: 2_000,
  };
  for (const police of manifest.characters.filter((character) => character.policeStar)) {
    police.maxHp = 1_000;
    police.speed = 0;
    police.attack.range = 0;
    police.attack.damage = 0;
  }
  manifest.setup.contestants = [
    {
      id: "protected-panda",
      definitionId: "panda-lazy",
      displayName: "受保护的熊猫",
      position: { x: 450, y: 450 },
      direction: { x: 1, y: 0 },
      color: "#f4d35e",
    },
    {
      id: "panda-attacker",
      definitionId: "mole",
      displayName: "动手的地鼠",
      position: { x: 1_150, y: 450 },
      direction: { x: -1, y: 0 },
      color: "#ef5f6d",
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  let survivalSnapshot = simulation.getSnapshot();
  let foundOrphanedPolice = false;
  for (let index = 0; index < 1_200; index += 1) {
    simulation.step();
    const currentSnapshot = simulation.getSnapshot();
    const pandaAlive = currentSnapshot.units.some(
      (unit) => unit.id === "protected-panda" && unit.hp > 0,
    );
    const policeAlive = currentSnapshot.units.some(
      (unit) =>
        !unit.main &&
        unit.policeStar === 1 &&
        unit.ownerId === "protected-panda" &&
        unit.hp > 0,
    );
    if (!pandaAlive && policeAlive) {
      survivalSnapshot = currentSnapshot;
      foundOrphanedPolice = true;
      break;
    }
  }

  assert.equal(foundOrphanedPolice, true);
  assert.equal(survivalSnapshot.status, "running");
  const survivingPolice = survivalSnapshot.units.find(
    (unit) =>
      !unit.main &&
      unit.policeStar === 1 &&
      unit.ownerId === "protected-panda" &&
      unit.hp > 0,
  );
  assert.ok(survivingPolice);
  assert.equal(survivingPolice.factionId, "protected-panda");
  assert.equal(survivingPolice.sustainsFaction, true);

  runSteps(simulation, 40);
  const afterPandaRemoval = simulation.getSnapshot();
  assert.equal(
    afterPandaRemoval.units.some((unit) => unit.id === "protected-panda"),
    false,
  );
  const persistentPolice = afterPandaRemoval.units.find(
    (unit) => unit.id === survivingPolice.id,
  );
  assert.ok(persistentPolice);
  assert.equal(afterPandaRemoval.status, "running");

  const damageHarness = simulation as unknown as {
    damageUnit(
      targetId: string,
      amount: number,
      sourceUnitId: string | undefined,
      source: "directAttack",
    ): void;
  };
  damageHarness.damageUnit(
    persistentPolice.id,
    persistentPolice.maxHp,
    "panda-attacker",
    "directAttack",
  );
  runSteps(simulation, 60);
  const finishedSnapshot = simulation.getSnapshot();
  assert.equal(finishedSnapshot.status, "finished");
  assert.equal(finishedSnapshot.winnerId, "panda-attacker");
});

test("main-character kills use concise announcements and report rapid multi-kills", () => {
  const manifest = createDefaultManifest();
  const board = selectedBoard(manifest);
  board.props = [];
  board.width = 900;
  board.height = 500;
  board.unitScale = 1;

  const attacker = definition(manifest, "police-1");
  attacker.pluginId = undefined;
  attacker.speed = 0;
  attacker.attack = {
    range: 2_000,
    damage: 999,
    cooldown: 0.35,
    windup: 0,
    mode: "projectile",
    projectileKind: "bullet",
    projectileSpeed: 2_000,
  };

  for (const target of [
    definition(manifest, "mole"),
    definition(manifest, "panda-lazy"),
  ]) {
    target.pluginId = undefined;
    target.maxHp = 10;
    target.speed = 0;
    target.attack.range = 0;
    target.attack.damage = 0;
  }

  manifest.setup.contestants = [
    {
      id: "announcer-killer",
      definitionId: "police-1",
      displayName: "老王",
      position: { x: 120, y: 250 },
      direction: { x: 1, y: 0 },
      color: "#f6d85f",
      teamId: "red",
    },
    {
      id: "announcer-target-one",
      definitionId: "mole",
      displayName: "鼠老弟",
      position: { x: 420, y: 180 },
      direction: { x: 0, y: 1 },
      color: "#72d4af",
      teamId: "blue",
    },
    {
      id: "announcer-target-two",
      definitionId: "panda-lazy",
      displayName: "熊师傅",
      position: { x: 650, y: 320 },
      direction: { x: 0, y: -1 },
      color: "#8fb8ff",
      teamId: "blue",
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 180);
  const deathEvents = simulation
    .getSnapshot()
    .events.filter((event) => event.type === "death" && event.announcement);
  const announcements = deathEvents.map((event) => event.announcement ?? "");

  assert.equal(announcements.length, 2);
  assert.match(announcements[0], /^老王 击败了 /);
  assert.doesNotMatch(announcements.join(" "), /击杀播报/);
  assert.match(announcements[1], /完成二连击败$/);
  assert.equal(deathEvents[0].targetName, "老王");
  assert.equal(deathEvents[0].targetDefinitionId, "police-1");
  assert.ok(["mole", "panda-lazy"].includes(deathEvents[0].unitDefinitionId ?? ""));
});

test("allied selectable police merge on contact and play a star-up action", () => {
  const manifest = twoFighterManifest();
  const officer = definition(manifest, "police-1");
  const enemy = definition(manifest, "mole");
  assert.equal(officer.role, "contestant");
  officer.speed = 0;
  officer.attack.damage = 0;
  enemy.pluginId = undefined;
  enemy.speed = 0;
  enemy.attack.damage = 0;
  manifest.setup.contestants = [
    {
      id: "red-police-a",
      definitionId: "police-1",
      displayName: "红队警察甲",
      position: { x: 300, y: 300 },
      direction: { x: 1, y: 0 },
      color: "#ff6b6b",
      teamId: "red",
    },
    {
      id: "red-police-b",
      definitionId: "police-1",
      displayName: "红队警察乙",
      position: { x: 300, y: 300 },
      direction: { x: -1, y: 0 },
      color: "#ff9a9a",
      teamId: "red",
    },
    {
      id: "blue-observer",
      definitionId: "mole",
      displayName: "蓝队观众",
      position: { x: 1200, y: 700 },
      direction: { x: 1, y: 0 },
      color: "#69a7ff",
      teamId: "blue",
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 1);
  const snapshot = simulation.getSnapshot();
  const merged = snapshot.units.find((unit) => unit.policeStar === 2 && unit.factionId === "team:red");
  assert.ok(merged);
  assert.equal(merged.main, true);
  assert.equal(merged.action, "merge");
  assert.equal(
    merged.appearanceDefinitionId,
    "police-2",
    "collision promotions should switch to the promoted officer appearance",
  );
  assert.ok(merged.promotionUntil > merged.promotionStartedAt);
  assert.ok(snapshot.events.some((event) => event.type === "merge" && event.announcement));
});

test("a police officer uses 1, 2, 2, and 3 experience cells to reach five stars", () => {
  const manifest = createDefaultManifest();
  const board = selectedBoard(manifest);
  board.props = [];
  board.unitScale = 1;

  for (let star = 1; star <= 5; star += 1) {
    const police = definition(manifest, `police-${star}`);
    police.speed = 0;
    police.attack = {
      range: 2_000,
      damage: 100,
      cooldown: 0.05,
      windup: 0,
      mode: "projectile",
      projectileKind: "bullet",
      projectileSpeed: 2_000,
    };
  }
  const target = definition(manifest, "mole");
  target.pluginId = undefined;
  target.maxHp = 1;
  target.speed = 0;
  target.attack.range = 0;
  target.attack.damage = 0;
  target.abilities = [];

  manifest.setup.contestants = [
    {
      id: "decorated-officer",
      definitionId: "police-1",
      displayName: "战功警员",
      position: { x: 800, y: 450 },
      direction: { x: 1, y: 0 },
      color: "#ffd55e",
      teamId: "red",
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `promotion-target-${index}`,
      definitionId: "mole",
      displayName: `训练目标${index + 1}`,
      position: {
        x: 620 + (index % 5) * 90,
        y: 330 + Math.floor(index / 5) * 180,
      },
      direction: { x: -1, y: 0 },
      color: "#69a7ff",
      teamId: "blue",
    })),
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 900);
  const snapshot = simulation.getSnapshot();
  const officer = snapshot.units.find((unit) => unit.id === "decorated-officer");
  assert.ok(officer);
  assert.equal(officer.policeStar, 5);
  assert.equal(officer.definitionId, "police-5");
  assert.equal(
    officer.appearanceDefinitionId,
    "police-5",
    "personal kill promotions should switch to the promoted officer appearance",
  );
  assert.equal(officer.policeKillProgress, 0);
  assert.equal(officer.maxHp, definition(manifest, "police-5").maxHp);
  assert.equal(officer.hp, officer.maxHp);
  assert.equal(
    Math.round(Math.hypot(officer.vx, officer.vy)),
    definition(manifest, "police-5").speed,
  );
  assert.equal(officer.factionId, "team:red");
  assert.equal(officer.main, true);
  const promotions = snapshot.events.filter(
    (event) =>
      event.type === "merge" &&
      event.unitId === officer.id &&
      event.message.includes("战功升为"),
  );
  assert.equal(promotions.length, 4);
  assert.deepEqual(
    promotions.map((event) => event.unitDefinitionId),
    ["police-2", "police-3", "police-4", "police-5"],
  );
  assert.deepEqual(
    promotions.map((event) => Number(event.message.match(/累计击杀(\d+)名/)?.[1])),
    [1, 2, 2, 3],
  );
});

test("default character name libraries provide ordered, playful names for every selectable type", () => {
  const manifest = createDefaultManifest();
  for (const character of manifest.characters.filter((candidate) => candidate.role === "contestant")) {
    const library = manifest.nameLibraries.find((candidate) => candidate.definitionId === character.id);
    assert.ok(library, `${character.name} should have a name library`);
    assert.ok(library.names.length >= 3);
  }
  assert.match(manifest.nameLibraries.find((item) => item.definitionId === "mole")!.names[0], /鼠鼠/);
});

test("default movement speeds match character weight while saved speeds remain unchanged", () => {
  const manifest = createDefaultManifest();
  const expectedDefaults = new Map([
    ["panda-lazy", 110],
    ["mole", 150],
    ["police-1", 130],
    ["police-2", 115],
    ["police-3", 110],
    ["police-4", 95],
    ["police-5", 65],
  ]);

  for (const [definitionId, speed] of expectedDefaults) {
    assert.equal(definition(manifest, definitionId).speed, speed);
  }
  assert.ok(definition(manifest, "mole").speed > definition(manifest, "police-1").speed);
  assert.ok(definition(manifest, "police-4").speed > definition(manifest, "police-5").speed);

  const savedSpeeds = new Map<string, number>();
  for (const [index, character] of manifest.characters.entries()) {
    const savedSpeed = 41 + index * 7;
    character.speed = savedSpeed;
    savedSpeeds.set(character.id, savedSpeed);
  }

  const upgraded = upgradeManifest(manifest);
  for (const [definitionId, speed] of savedSpeeds) {
    assert.equal(definition(upgraded, definitionId).speed, speed);
  }
});

test("legacy per-character police experience migrates once into the shared promotion table", () => {
  const legacy = createDefaultManifest() as Omit<
    ProjectManifest,
    "policePromotion"
  > & {
    policePromotion?: ProjectManifest["policePromotion"];
  };
  delete legacy.policePromotion;
  const legacyRequirements = [4, 5, 6, 7];
  for (const [index, requirement] of legacyRequirements.entries()) {
    const character = definition(legacy as ProjectManifest, `police-${index + 1}`);
    character.skillParameters ??= {};
    character.skillParameters.police = {
      killsPerPromotion: requirement,
    } as NonNullable<
      NonNullable<CharacterDefinition["skillParameters"]>["police"]
    >;
  }

  const upgraded = upgradeManifest(legacy as ProjectManifest);
  assert.deepEqual(upgraded.policePromotion, {
    experienceToStar2: 4,
    experienceToStar3: 5,
    experienceToStar4: 6,
    experienceToStar5: 7,
  });
  assert.deepEqual(
    upgradeManifest(upgraded).policePromotion,
    upgraded.policePromotion,
  );
});

test("ready formation positions can sync without advancing or rebuilding the battle clock", () => {
  const manifest = twoFighterManifest();
  const simulation = new BattleSimulation(manifest);
  const nextSetup = structuredClone(manifest.setup);
  nextSetup.contestants[0].position = { x: 620, y: 330 };
  nextSetup.contestants[0].displayName = "同步后的熊猫";
  nextSetup.contestants[0].teamId = "green";

  assert.equal(simulation.syncReadySetup(nextSetup), true);
  const snapshot = simulation.getSnapshot();
  const synced = snapshot.units.find((unit) => unit.id === nextSetup.contestants[0].id);
  assert.ok(synced);
  assert.equal(snapshot.time, 0);
  assert.equal(snapshot.status, "ready");
  assert.equal(synced.x, 620);
  assert.equal(synced.y, 330);
  assert.equal(synced.name, "同步后的熊猫");
  assert.equal(synced.factionId, "team:green");

  simulation.start();
  assert.equal(simulation.syncReadySetup(manifest.setup), false);
});

test("every character definition can be explicitly added as a main contestant", () => {
  const manifest = twoFighterManifest();
  const officer = definition(manifest, "police-1");
  officer.role = "summon";
  manifest.setup.contestants[0] = {
    ...manifest.setup.contestants[0],
    id: "manual-police",
    definitionId: "police-1",
    displayName: "手动参赛警察",
  };
  const simulation = new BattleSimulation(manifest);
  const runtimeOfficer = simulation
    .getSnapshot()
    .units.find((unit) => unit.id === "manual-police");
  assert.ok(runtimeOfficer);
  assert.equal(runtimeOfficer.main, true);
});

test("legacy panda entries and references remain unchanged during upgrades", () => {
  const manifest = createDefaultManifest();
  const canonical = definition(manifest, "panda-lazy");
  delete canonical.animations.callPolice;
  delete (
    canonical.skillParameters!.panda as {
      policeCallDuration?: number;
    }
  ).policeCallDuration;
  manifest.characters.push({ ...structuredClone(canonical), id: "panda", name: "活力熊猫（旧版）" });
  manifest.nameLibraries.push({ definitionId: "panda", names: ["旧熊猫名字"] });
  manifest.setup.contestants[0].definitionId = "panda";
  const legacyPanda = structuredClone(definition(manifest, "panda"));
  const legacyLibrary = structuredClone(
    manifest.nameLibraries.find((library) => library.definitionId === "panda"),
  );

  const upgraded = upgradeManifest(manifest);
  assert.deepEqual(definition(upgraded, "panda"), legacyPanda);
  assert.deepEqual(
    upgraded.nameLibraries.find((library) => library.definitionId === "panda"),
    legacyLibrary,
  );
  assert.equal(upgraded.setup.contestants[0].definitionId, "panda");
  const upgradedPanda = definition(upgraded, "panda-lazy");
  assert.equal(upgradedPanda.name, "熊猫");
  assert.equal(upgradedPanda.skillParameters?.panda?.policeCallDuration, 0.7);
  assert.ok(upgradedPanda.animations.callPolice);
});

test("legacy and custom mole definitions gain the default tunnel speed multiplier", () => {
  const manifest = createDefaultManifest();
  const canonical = definition(manifest, "mole");
  const custom = {
    ...structuredClone(canonical),
    id: "mole-custom",
    name: "自定义地鼠",
  };
  delete (
    canonical.skillParameters!.mole as {
      tunnelSpeedMultiplier?: number;
    }
  ).tunnelSpeedMultiplier;
  delete (
    custom.skillParameters!.mole as {
      tunnelSpeedMultiplier?: number;
    }
  ).tunnelSpeedMultiplier;
  manifest.characters.push(custom);

  const upgraded = upgradeManifest(manifest);
  assert.equal(
    definition(upgraded, "mole").skillParameters?.mole
      ?.tunnelSpeedMultiplier,
    2.5,
  );
  assert.equal(
    definition(upgraded, "mole-custom").skillParameters?.mole
      ?.tunnelSpeedMultiplier,
    2.5,
  );
});

test("default melee attacks use wider contact ranges without changing saved legacy values", () => {
  const manifest = createDefaultManifest();
  assert.equal(definition(manifest, "panda-lazy").attack.range, 68);
  assert.equal(definition(manifest, "mole").attack.range, 55);
  assert.equal(definition(manifest, "police-1").attack.range, 56);

  definition(manifest, "panda-lazy").attack.range = 58;
  definition(manifest, "mole").attack.range = 45;
  definition(manifest, "police-1").attack.range = 46;

  const upgraded = upgradeManifest(manifest);
  assert.equal(definition(upgraded, "panda-lazy").attack.range, 58);
  assert.equal(definition(upgraded, "mole").attack.range, 45);
  assert.equal(definition(upgraded, "police-1").attack.range, 46);
});

test("custom basic attack ranges survive manifest upgrades", () => {
  const manifest = createDefaultManifest();
  definition(manifest, "panda-lazy").attack.range = 83;
  definition(manifest, "police-3").attack.range = 1_337;

  const upgraded = upgradeManifest(manifest);
  assert.equal(definition(upgraded, "panda-lazy").attack.range, 83);
  assert.equal(definition(upgraded, "police-3").attack.range, 1_337);
});

test("manifest upgrades preserve all existing project, character, board, and setup settings", () => {
  const manifest = upgradeManifest(createDefaultManifest());
  manifest.name = "我的长期存档";
  manifest.updatedAt = "2026-01-02T03:04:05.000Z";
  manifest.backgroundMusic = {
    enabled: false,
    source: "synth",
    title: "我的静音配置",
    volume: 0.17,
  };

  const panda = definition(manifest, "panda-lazy");
  panda.name = "自定义熊猫";
  panda.subtitle = "不要用新版默认文案覆盖";
  panda.role = "summon";
  panda.maxHp = 777;
  panda.speed = 23;
  panda.radius = 32;
  panda.victoryStyle = "spotlight";
  panda.attack.range = 58;
  panda.attack.damage = 41;
  panda.attack.cooldown = 6.2;
  panda.attack.windup = 0.91;
  panda.attack.frontArcDegrees = 87;
  panda.skillParameters!.panda!.eatDuration = 8.5;
  panda.animations.attack = {
    id: "attack",
    loop: false,
    frames: [{ assetId: "panda-lazy-attack-3", durationMs: 1_234 }],
  };
  panda.animations.callPolice = {
    id: "callPolice",
    loop: false,
    frames: [{ assetId: "panda-lazy-sos", durationMs: 2_345 }],
  };
  panda.animations.victory = {
    id: "victory",
    loop: true,
    frames: [{ assetId: "panda-lazy-idle", durationMs: 3_456 }],
  };
  panda.sounds.attack = {
    id: "panda-lazy-user-attack",
    source: "speech",
    phrases: ["保留我的攻击台词"],
    volume: 0.42,
  };
  panda.sounds.skill = {
    id: "panda-lazy-chew",
    source: "synth",
    preset: "chew",
    volume: 0.31,
  };

  const mole = definition(manifest, "mole");
  (
    mole.skillParameters!.mole as NonNullable<
      NonNullable<CharacterDefinition["skillParameters"]>["mole"]
    > & { stompsToFlatten?: number }
  ).stompsToFlatten = 9;

  const gatling = definition(manifest, "police-5");
  gatling.role = "summon";
  gatling.maxHp = 200;
  gatling.attack.cooldown = 10;
  gatling.attack.burstCount = 15;
  gatling.attack.burstGap = 0.33;
  gatling.victoryStyle = "spotlight";
  const gatlingParameters = gatling.skillParameters!.police as NonNullable<
    NonNullable<CharacterDefinition["skillParameters"]>["police"]
  > & { killsPerPromotion?: number };
  gatlingParameters.killsPerPromotion = 9;
  gatlingParameters.gatlingFireDuration = 6;
  gatlingParameters.gatlingRestDuration = 4;
  gatlingParameters.gatlingShots = 21;

  const builtInAsset = manifest.assets.find((asset) => asset.id === "mole-idle");
  assert.ok(builtInAsset);
  builtInAsset.url = "/assets/my-mole-idle.png";
  builtInAsset.name = "我的地鼠图片";
  builtInAsset.mime = "image/png";

  const board = manifest.boards.find((candidate) => candidate.id === "bamboo-lava-arena");
  assert.ok(board);
  board.name = "我的自定义地图";
  board.description = "尺寸、缩放和道具都必须保留";
  board.width = 1_234;
  board.height = 987;
  board.unitScale = 1.2;
  board.props = [];
  const streamBoard = manifest.boards.find((candidate) => candidate.id === "stream-landscape");
  assert.ok(streamBoard);
  streamBoard.unitScale = 0.9;

  const policeNames = manifest.nameLibraries.find(
    (library) => library.definitionId === "police-5",
  );
  assert.ok(policeNames);
  policeNames.names = ["突突五秒钟", "我的五星警察"];

  const firstContestant = manifest.setup.contestants[0];
  firstContestant.color = "#123456";
  firstContestant.nameColor = "#abcdef";
  firstContestant.displayName = "我的场上角色";
  firstContestant.position = { x: 321, y: 654 };
  firstContestant.direction = { x: 0.25, y: -0.75 };
  (
    firstContestant as typeof firstContestant & {
      namePlacement?: string;
    }
  ).namePlacement = "inside";

  const legacyPanda = structuredClone(panda);
  legacyPanda.id = "panda";
  legacyPanda.name = "旧版自定义熊猫";
  manifest.characters.push(legacyPanda);
  manifest.nameLibraries.push({
    definitionId: "panda",
    names: ["旧熊猫名字"],
  });
  firstContestant.definitionId = "panda";

  const beforeUpgrade = structuredClone(manifest);
  const upgraded = upgradeManifest(manifest);

  assert.deepEqual(upgraded, beforeUpgrade);
  assert.notEqual(upgraded, manifest);
});

test("deleting the active board selects a valid fallback and survives future upgrades", () => {
  const manifest = createDefaultManifest();
  manifest.setup.boardId = "stream-landscape";
  manifest.setup.contestants[0].position = { x: 800, y: 450 };
  const original = structuredClone(manifest);

  const result = removeBoardFromManifest(
    manifest,
    "stream-landscape",
  );
  assert.ok(result);
  assert.equal(
    result.manifest.boards.some((board) => board.id === "stream-landscape"),
    false,
  );
  assert.equal(result.selectedBoardId, "stream-portrait");
  assert.equal(result.manifest.setup.boardId, "stream-portrait");
  assert.deepEqual(result.manifest.setup.contestants[0].position, {
    x: 450,
    y: 800,
  });
  assert.equal(
    upgradeManifest(result.manifest).boards.some(
      (board) => board.id === "stream-landscape",
    ),
    false,
  );
  assert.equal(
    original.boards.some((board) => board.id === "stream-landscape"),
    true,
  );

  const oneBoard = structuredClone(result.manifest);
  oneBoard.boards = [oneBoard.boards[0]];
  oneBoard.setup.boardId = oneBoard.boards[0].id;
  assert.equal(
    removeBoardFromManifest(oneBoard, oneBoard.boards[0].id),
    undefined,
  );
});

test("deleted built-in characters stay deleted across future upgrades", () => {
  const manifest = createDefaultManifest();
  manifest.characters = manifest.characters.filter(
    (character) => character.id !== "police-2",
  );
  manifest.nameLibraries = manifest.nameLibraries.filter(
    (library) => library.definitionId !== "police-2",
  );
  manifest.setup.contestants = manifest.setup.contestants.filter(
    (contestant) => contestant.definitionId !== "police-2",
  );

  const upgraded = upgradeManifest(manifest);
  assert.equal(
    upgraded.characters.some((character) => character.id === "police-2"),
    false,
  );
  assert.equal(
    upgraded.nameLibraries.some(
      (library) => library.definitionId === "police-2",
    ),
    false,
  );
});

test("legacy team HUD settings gain missing name colors without replacing saved values", () => {
  const manifest = createDefaultManifest();
  manifest.setup.contestants[0].teamId = "red";
  manifest.setup.contestants[0].color = "#111111";
  delete manifest.setup.contestants[0].nameColor;
  manifest.setup.contestants[1].teamId = "blue";
  manifest.setup.contestants[1].color = "#222222";
  delete manifest.setup.contestants[1].nameColor;

  const upgraded = upgradeManifest(manifest);
  assert.equal(upgraded.setup.contestants[0].color, "#111111");
  assert.equal(upgraded.setup.contestants[0].nameColor, "#111111");
  assert.equal(upgraded.setup.contestants[1].color, "#222222");

  upgraded.setup.contestants[0].color = "#123456";
  upgraded.setup.contestants[0].nameColor = "#abcdef";
  (
    upgraded.setup.contestants[0] as typeof upgraded.setup.contestants[number] & {
      namePlacement?: string;
    }
  ).namePlacement = "inside";
  const reloaded = upgradeManifest(upgraded);
  assert.equal(reloaded.setup.contestants[0].color, "#123456");
  assert.equal(reloaded.setup.contestants[0].nameColor, "#abcdef");
  assert.equal(
    (
      reloaded.setup.contestants[0] as typeof reloaded.setup.contestants[number] & {
        namePlacement?: string;
      }
    ).namePlacement,
    "inside",
  );
});

test("the default board library includes three restrained new portrait arenas", () => {
  const manifest = createDefaultManifest();
  const expectedBoards = [
    "portrait-moon-observatory",
    "portrait-desert-oasis",
    "portrait-aurora-platform",
  ];

  for (const boardId of expectedBoards) {
    const board = manifest.boards.find((candidate) => candidate.id === boardId);
    assert.ok(board, `missing portrait board ${boardId}`);
    assert.equal(board.width, 900);
    assert.equal(board.height, 1600);
    assert.ok(board.props.length >= 4);
    assert.ok(board.props.length <= 6);
    assert.ok(board.props.some((prop) => prop.type === "hotSpring"));
    assert.ok(board.props.some((prop) => prop.type === "lava"));
  }
});

test("the default project opens on a simple portrait showcase with updated gatling defaults", () => {
  const manifest = createDefaultManifest();
  const board = selectedBoard(manifest);
  assert.equal(board.id, "portrait-aurora-platform");
  assert.equal(board.width, 900);
  assert.equal(board.height, 1600);
  assert.equal(manifest.setup.contestants.length, 8);
  assert.deepEqual(
    new Set(manifest.setup.contestants.map((contestant) => contestant.teamId)),
    new Set(["gold", "blue", "red", "purple"]),
  );
  assert.ok(
    ["panda-lazy", "mole", "police-1", "police-3", "police-4", "police-5"].every(
      (definitionId) =>
        manifest.setup.contestants.some(
          (contestant) => contestant.definitionId === definitionId,
        ),
    ),
  );

  const gatling = definition(manifest, "police-5");
  assert.equal(gatling.maxHp, 1_000);
  assert.equal(gatling.attack.cooldown, 7);
  assert.equal(gatling.attack.burstCount, 18);
  assert.equal(gatling.attack.burstGap, 0.2);
  assert.ok(
    manifest.characters.every(
      (character) => (character.victoryStyle ?? "cool") !== "spotlight",
    ),
  );
});

test("new gatling defaults do not replace saved legacy health and firing cadence", () => {
  const manifest = createDefaultManifest();
  const gatling = definition(manifest, "police-5");
  gatling.maxHp = 200;
  gatling.attack.cooldown = 10;
  gatling.attack.burstCount = 15;
  gatling.attack.burstGap = 0.33;
  gatling.victoryStyle = "spotlight";

  const upgraded = upgradeManifest(manifest);
  const upgradedGatling = definition(upgraded, "police-5");
  assert.equal(upgradedGatling.maxHp, 200);
  assert.equal(upgradedGatling.attack.cooldown, 10);
  assert.equal(upgradedGatling.attack.burstCount, 15);
  assert.equal(upgradedGatling.attack.burstGap, 0.33);
  assert.equal(upgradedGatling.victoryStyle, "spotlight");
  assert.equal(
    upgradedGatling.skillParameters?.police?.kickWallStunDuration,
    0.5,
  );
  assert.equal(upgradedGatling.skillParameters?.police?.kickDamage, 25);
});

test("extreme sub-frame burst settings stay deterministic and within runtime budgets", () => {
  const createStressManifest = () => {
    const manifest = twoFighterManifest();
    const board = selectedBoard(manifest);
    const fighterIds = ["panda-lazy", "mole"];
    for (const fighterId of fighterIds) {
      const fighter = definition(manifest, fighterId);
      fighter.pluginId = undefined;
      fighter.maxHp = 1_000_000;
      fighter.speed = 0;
      fighter.abilities = [];
      fighter.attack = {
        range: 9_999,
        damage: 1,
        cooldown: 0.000_001,
        windup: 0,
        mode: "burst",
        projectileKind: "bullet",
        projectileSpeed: 1,
        burstCount: 100_000,
        burstGap: 0.000_001,
      };
    }
    manifest.setup.contestants = Array.from({ length: 16 }, (_, index) => ({
      id: `stress-${index}`,
      definitionId: fighterIds[index % fighterIds.length],
      displayName: `压力角色${index}`,
      position: {
        x: 170 + (index % 4) * ((board.width - 340) / 3),
        y: 120 + Math.floor(index / 4) * ((board.height - 240) / 3),
      },
      direction: { x: index % 2 ? 1 : -1, y: 0 },
      color: "#ffffff",
    }));
    return manifest;
  };

  const first = new BattleSimulation(createStressManifest());
  const second = new BattleSimulation(createStressManifest());
  first.start();
  second.start();
  runSteps(first, 120);
  runSteps(second, 120);

  const diagnostics = first.getDiagnostics();
  assert.equal(first.getSnapshot().status, "running");
  assert.ok(diagnostics.activeProjectiles <= 900);
  assert.ok(diagnostics.queuedShots <= 4_096);
  assert.ok(diagnostics.events <= 240);
  assert.ok(diagnostics.droppedShots > 0);
  assert.ok(diagnostics.droppedProjectiles > 0);
  assert.deepEqual(first.getSnapshot(), second.getSnapshot());
  assert.deepEqual(first.getDiagnostics(), second.getDiagnostics());
});

test("extreme interval spawn skills cannot grow the unit pool without bounds", () => {
  const manifest = twoFighterManifest();
  disableCombat(manifest);
  const summoner = definition(manifest, "panda-lazy");
  const summon = definition(manifest, "mole");
  summoner.pluginId = undefined;
  summon.pluginId = undefined;
  summon.abilities = [];
  summoner.abilities = [
    {
      id: "stress-spawn",
      name: "极限召唤",
      trigger: "interval",
      interval: 0.000_001,
      cooldown: 0.000_001,
      actions: [{ kind: "spawnUnit", definitionId: summon.id, count: 100_000 }],
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 30);
  const diagnostics = simulation.getDiagnostics();
  assert.ok(diagnostics.activeUnits <= 512);
  assert.ok(diagnostics.droppedSpawns > 0);
  assert.equal(simulation.getSnapshot().status, "running");
});

test("spoken voice is restricted to skill events and every default role has skill lines", () => {
  assert.equal(isSkillVoiceEvent({ type: "skill" }), true);
  assert.equal(isSkillVoiceEvent({ type: "spawn" }), true);
  for (const type of ["attack", "damage", "death", "merge", "victory"] as const) {
    assert.equal(isSkillVoiceEvent({ type }), false);
  }

  const manifest = createDefaultManifest();
  for (const character of manifest.characters) {
    assert.equal(
      character.sounds.skill?.source,
      "speech",
      `${character.name} should have spoken skill lines`,
    );
    for (const slot of ["attack", "hit", "hurt", "death"] as const) {
      assert.notEqual(
        character.sounds[slot]?.source,
        "speech",
        `${character.name} ${slot} should not use spoken announcements`,
      );
    }
  }
});

test("default settlement and rescue/reload actions use distinct animation frames", () => {
  const manifest = createDefaultManifest();
  for (const character of manifest.characters) {
    const entranceFrames = character.animations.entrance?.frames.map(
      (frame) => frame.assetId,
    );
    assert.ok(entranceFrames);
    assert.equal(entranceFrames.length, 4);
    assert.ok(entranceFrames.slice(0, 3).every((frame) => frame.includes("-entrance-v2-")));
    const frames = character.animations.victory?.frames.map(
      (frame) => frame.assetId,
    );
    assert.ok(frames);
    assert.equal(frames.length, 6);
    assert.ok(frames.some((frame) => frame.includes("-victory-v2-")));
  }
  const panda = definition(manifest, "panda-lazy");
  assert.deepEqual(
    panda.animations.callPolice.frames.map((frame) => frame.assetId),
    ["panda-lazy-sos", "panda-lazy-sos-2", "panda-lazy-idle"],
  );
  const heavy = definition(manifest, "police-5");
  assert.deepEqual(
    heavy.animations.reload.frames.map((frame) => frame.assetId),
    [
      "police-5-reload-v2-1",
      "police-5-reload-v2-2",
      "police-5-reload-v2-3",
      "police-5-reload-v2-4",
      "police-5-reload-v2-5",
      "police-5-reload-v2-6",
      "police-5-idle",
    ],
  );
});

test("a five-star officer spends its magazine, performs a voiced reload skill, and refills", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.props = [];
  board.width = 1_200;
  board.height = 700;
  const officer = definition(manifest, "police-5");
  officer.speed = 0;
  officer.attack.range = 1_200;
  officer.attack.cooldown = 100;
  officer.attack.windup = 0;
  officer.attack.burstCount = 8;
  officer.attack.burstGap = 0.01;
  officer.attack.projectileSpeed = 20;
  officer.skillParameters!.police!.gatlingMagazineSize = 3;
  officer.skillParameters!.police!.gatlingReloadDuration = 0.2;
  const target = definition(manifest, "mole");
  target.pluginId = undefined;
  target.speed = 0;
  target.maxHp = 10_000;
  target.attack.range = 0;
  target.attack.damage = 0;
  manifest.setup.contestants = [
    {
      id: "reload-officer",
      definitionId: "police-5",
      displayName: "换弹测试员",
      position: { x: 180, y: 350 },
      direction: { x: 1, y: 0 },
      color: "#f6d85f",
    },
    {
      id: "reload-target",
      definitionId: "mole",
      displayName: "远处靶子",
      position: { x: 1_000, y: 350 },
      direction: { x: -1, y: 0 },
      color: "#ff8b62",
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 15);
  let snapshot = simulation.getSnapshot();
  const reloading = snapshot.units.find((unit) => unit.id === "reload-officer");
  assert.ok(reloading);
  assert.equal(reloading.action, "reloading");
  assert.equal(reloading.gatling?.ammoRemaining, 0);
  assert.equal(reloading.gatling?.magazineSize, 3);
  assert.equal(actionClipName(reloading, snapshot.time), "reload");
  assert.ok(
    snapshot.events.some(
      (event) =>
        event.type === "skill" &&
        event.unitId === reloading.id &&
        event.sound === "reload",
    ),
  );

  runSteps(simulation, 20);
  snapshot = simulation.getSnapshot();
  const refilled = snapshot.units.find((unit) => unit.id === "reload-officer");
  assert.ok(refilled);
  assert.notEqual(refilled.action, "reloading");
  assert.equal(refilled.gatling?.ammoRemaining, 3);
});

test("a living panda globally refreshes one bamboo at a time up to the configured cap", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.props = [];
  disableCombat(manifest);
  const panda = definition(manifest, "panda-lazy");
  panda.speed = 0;
  panda.skillParameters!.panda!.bambooRespawnInterval = 0.2;
  panda.skillParameters!.panda!.bambooRespawnLimit = 3;
  const mole = definition(manifest, "mole");
  mole.pluginId = undefined;
  mole.speed = 0;

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 60);
  let snapshot = simulation.getSnapshot();
  assert.equal(
    snapshot.props.filter((prop) => prop.type === "bamboo" && prop.active).length,
    3,
  );
  assert.ok(
    snapshot.events.some(
      (event) =>
        event.type === "skill" &&
        event.message.includes("补充了一份竹子"),
    ),
  );
  runSteps(simulation, 120);
  snapshot = simulation.getSnapshot();
  assert.equal(
    snapshot.props.filter((prop) => prop.type === "bamboo" && prop.active).length,
    3,
  );
});

test("melee pursuit reaches physical contact before the hit frame can deal damage", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.props = [];
  board.width = 800;
  board.height = 400;
  board.unitScale = 1;
  const panda = definition(manifest, "panda-lazy");
  const mole = definition(manifest, "mole");
  panda.pluginId = undefined;
  panda.speed = 120;
  panda.attack = {
    range: 500,
    damage: 25,
    cooldown: 100,
    windup: 0.3,
    mode: "melee",
    frontArcDegrees: 360,
  };
  mole.pluginId = undefined;
  mole.speed = 0;
  mole.maxHp = 100;
  mole.attack.range = -100;
  mole.attack.damage = 0;
  manifest.setup.contestants[0].position = { x: 100, y: 200 };
  manifest.setup.contestants[0].direction = { x: 1, y: 0 };
  manifest.setup.contestants[1].position = { x: 500, y: 200 };

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 1);
  let snapshot = simulation.getSnapshot();
  let attacker = snapshot.units.find(
    (unit) => unit.definitionId === "panda-lazy",
  );
  let target = snapshot.units.find((unit) => unit.definitionId === "mole");
  assert.ok(attacker);
  assert.ok(target);
  assert.equal(attacker.action, "meleeApproach");
  assert.equal(target.hp, target.maxHp);

  runSteps(simulation, 60);
  snapshot = simulation.getSnapshot();
  attacker = snapshot.units.find((unit) => unit.definitionId === "panda-lazy");
  target = snapshot.units.find((unit) => unit.definitionId === "mole");
  assert.ok(attacker);
  assert.ok(target);
  assert.equal(target.hp, target.maxHp, "configured range must not deal remote damage");

  let contactSnapshot: ReturnType<BattleSimulation["getSnapshot"]> | undefined;
  for (let step = 0; step < 180; step += 1) {
    simulation.step(1 / 60);
    const current = simulation.getSnapshot();
    const currentAttacker = current.units.find(
      (unit) => unit.definitionId === "panda-lazy",
    );
    if (currentAttacker?.action === "attack") {
      contactSnapshot = current;
      break;
    }
  }
  assert.ok(contactSnapshot);
  attacker = contactSnapshot.units.find(
    (unit) => unit.definitionId === "panda-lazy",
  );
  target = contactSnapshot.units.find((unit) => unit.definitionId === "mole");
  assert.ok(attacker);
  assert.ok(target);
  assert.equal(target.hp, target.maxHp);
  assert.ok(
    Math.hypot(target.x - attacker.x, target.y - attacker.y) <=
      attacker.radius + target.radius + 4 + 1e-9,
    "the attack animation should begin at circle contact",
  );

  let hitSnapshot: ReturnType<BattleSimulation["getSnapshot"]> | undefined;
  for (let step = 0; step < 30; step += 1) {
    simulation.step(1 / 60);
    const current = simulation.getSnapshot();
    const currentTarget = current.units.find(
      (unit) => unit.definitionId === "mole",
    );
    if (currentTarget && currentTarget.hp < currentTarget.maxHp) {
      hitSnapshot = current;
      break;
    }
  }
  assert.ok(hitSnapshot);
  attacker = hitSnapshot.units.find(
    (unit) => unit.definitionId === "panda-lazy",
  );
  target = hitSnapshot.units.find((unit) => unit.definitionId === "mole");
  assert.ok(attacker);
  assert.ok(target);
  assert.ok(
    Math.hypot(target.x - attacker.x, target.y - attacker.y) <=
      attacker.radius + target.radius + 4 + 1e-9,
    "the hit frame must revalidate physical contact",
  );
});

test("zero-range melee still attacks on contact and abandons invalid pursuits", () => {
  const contactManifest = twoFighterManifest();
  const contactBoard = selectedBoard(contactManifest);
  contactBoard.props = [];
  contactBoard.width = 700;
  contactBoard.height = 400;
  contactBoard.unitScale = 1;
  const contactPanda = definition(contactManifest, "panda-lazy");
  const contactMole = definition(contactManifest, "mole");
  contactPanda.pluginId = undefined;
  contactPanda.speed = 0;
  contactPanda.attack = {
    range: 0,
    damage: 20,
    cooldown: 100,
    windup: 0,
    mode: "melee",
    frontArcDegrees: 360,
  };
  contactMole.pluginId = undefined;
  contactMole.speed = 0;
  contactMole.attack.range = -100;
  contactMole.attack.damage = 0;
  contactManifest.setup.contestants[0].position = { x: 300, y: 200 };
  contactManifest.setup.contestants[1].position = { x: 368, y: 200 };

  const contactSimulation = new BattleSimulation(contactManifest);
  contactSimulation.start();
  runSteps(contactSimulation, 3);
  const contactedTarget = contactSimulation
    .getSnapshot()
    .units.find((unit) => unit.definitionId === "mole");
  assert.ok(contactedTarget);
  assert.equal(contactedTarget.hp, contactedTarget.maxHp - 20);

  const pursuitManifest = structuredClone(contactManifest);
  const pursuitPanda = definition(pursuitManifest, "panda-lazy");
  pursuitPanda.speed = 30;
  pursuitPanda.attack.range = 100;
  pursuitPanda.attack.windup = 0.2;
  pursuitManifest.setup.contestants[0].position = { x: 300, y: 200 };
  pursuitManifest.setup.contestants[1].position = { x: 450, y: 200 };
  const pursuitSimulation = new BattleSimulation(pursuitManifest);
  pursuitSimulation.start();
  runSteps(pursuitSimulation, 1);
  let pursuitSnapshot = pursuitSimulation.getSnapshot();
  let pursuingUnit = pursuitSnapshot.units.find(
    (unit) => unit.definitionId === "panda-lazy",
  );
  assert.ok(pursuingUnit);
  assert.equal(pursuingUnit.action, "meleeApproach");
  assert.ok(pursuingUnit.meleeTargetId);

  const pursuitHarness = pursuitSimulation as unknown as {
    units: Map<string, RuntimeUnit>;
  };
  const runtimeTarget = [...pursuitHarness.units.values()].find(
    (unit) => unit.definitionId === "mole",
  );
  assert.ok(runtimeTarget);
  runtimeTarget.x = 650;
  pursuitSimulation.step(1 / 60);
  pursuitSnapshot = pursuitSimulation.getSnapshot();
  pursuingUnit = pursuitSnapshot.units.find(
    (unit) => unit.definitionId === "panda-lazy",
  );
  assert.ok(pursuingUnit);
  assert.equal(pursuingUnit.action, "move");
  assert.equal(pursuingUnit.meleeTargetId, undefined);

  const tunnelingManifest = structuredClone(pursuitManifest);
  const tunnelingSimulation = new BattleSimulation(tunnelingManifest);
  tunnelingSimulation.start();
  runSteps(tunnelingSimulation, 1);
  const tunnelingHarness = tunnelingSimulation as unknown as {
    units: Map<string, RuntimeUnit>;
  };
  const tunnelingTarget = [...tunnelingHarness.units.values()].find(
    (unit) => unit.definitionId === "mole",
  );
  assert.ok(tunnelingTarget);
  tunnelingTarget.targetable = false;
  tunnelingTarget.action = "tunneling";
  tunnelingSimulation.step(1 / 60);
  const interruptedByTunnel = tunnelingSimulation
    .getSnapshot()
    .units.find((unit) => unit.definitionId === "panda-lazy");
  assert.ok(interruptedByTunnel);
  assert.equal(interruptedByTunnel.action, "move");
  assert.equal(interruptedByTunnel.meleeTargetId, undefined);

  const deathManifest = structuredClone(pursuitManifest);
  const deathSimulation = new BattleSimulation(deathManifest);
  deathSimulation.start();
  runSteps(deathSimulation, 1);
  const deathSnapshot = deathSimulation.getSnapshot();
  const deathAttacker = deathSnapshot.units.find(
    (unit) => unit.definitionId === "panda-lazy",
  );
  const deathTarget = deathSnapshot.units.find(
    (unit) => unit.definitionId === "mole",
  );
  assert.ok(deathAttacker);
  assert.ok(deathTarget);
  const deathHarness = deathSimulation as unknown as {
    damageUnit(
      targetId: string,
      amount: number,
      sourceUnitId: string | undefined,
      source: "directAttack",
    ): void;
  };
  deathHarness.damageUnit(
    deathTarget.id,
    deathTarget.maxHp,
    deathAttacker.id,
    "directAttack",
  );
  deathSimulation.step(1 / 60);
  const interruptedByDeath = deathSimulation
    .getSnapshot()
    .units.find((unit) => unit.definitionId === "panda-lazy");
  assert.ok(interruptedByDeath);
  assert.equal(interruptedByDeath.meleeTargetId, undefined);
});

test("melee attacks only begin against close targets in the front arc", () => {
  const createMeleeManifest = (targetX: number) => {
    const manifest = twoFighterManifest();
    const board = selectedBoard(manifest);
    board.props = [];
    board.width = 600;
    board.height = 400;
    board.unitScale = 1;
    const panda = definition(manifest, "panda-lazy");
    panda.pluginId = undefined;
    panda.speed = 0;
    panda.attack = {
      range: 90,
      damage: 20,
      cooldown: 0.1,
      windup: 0,
      mode: "melee",
      frontArcDegrees: 90,
    };
    const mole = definition(manifest, "mole");
    mole.pluginId = undefined;
    mole.speed = 0;
    mole.attack.range = 0;
    mole.attack.damage = 0;
    manifest.setup.contestants[0].position = { x: 300, y: 200 };
    manifest.setup.contestants[0].direction = { x: 1, y: 0 };
    manifest.setup.contestants[1].position = { x: targetX, y: 200 };
    return manifest;
  };

  const behind = new BattleSimulation(createMeleeManifest(240));
  behind.start();
  runSteps(behind, 60);
  const behindTarget = behind
    .getSnapshot()
    .units.find((unit) => unit.definitionId === "mole");
  assert.ok(behindTarget);
  assert.equal(behindTarget.hp, behindTarget.maxHp);

  const ahead = new BattleSimulation(createMeleeManifest(360));
  ahead.start();
  runSteps(ahead, 60);
  const aheadTarget = ahead
    .getSnapshot()
    .units.find((unit) => unit.definitionId === "mole");
  assert.ok(aheadTarget);
  assert.ok(aheadTarget.hp < aheadTarget.maxHp);
});

test("rockets accelerate once to 1.5x speed after their first 1.5 seconds", () => {
  const manifest = createDefaultManifest();
  const board = selectedBoard(manifest);
  board.props = [];
  board.width = 5_000;
  board.height = 1_000;
  board.unitScale = 1;
  const officer = definition(manifest, "police-4");
  officer.speed = 0;
  officer.attack.range = 5_000;
  officer.attack.cooldown = 100;
  officer.attack.windup = 0;
  officer.attack.projectileSpeed = 100;
  officer.attack.projectileBoostAfter = 1.5;
  officer.attack.projectileBoostMultiplier = 1.5;
  officer.attack.spreadDegrees = 0;
  const target = definition(manifest, "mole");
  target.pluginId = undefined;
  target.speed = 0;
  target.maxHp = 10_000;
  target.attack.range = 0;
  target.attack.damage = 0;
  manifest.setup.contestants = [
    {
      id: "boost-rpg",
      definitionId: "police-4",
      displayName: "两段火箭",
      position: { x: 150, y: 500 },
      direction: { x: 1, y: 0 },
      color: "#ff9f58",
    },
    {
      id: "boost-target",
      definitionId: "mole",
      displayName: "远距离靶",
      position: { x: 4_800, y: 500 },
      direction: { x: -1, y: 0 },
      color: "#72d4af",
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 60);
  let rocket = simulation
    .getSnapshot()
    .projectiles.find((projectile) => projectile.kind === "rocket");
  assert.ok(rocket);
  assert.ok(Math.abs(Math.hypot(rocket.vx, rocket.vy) - 100) < 0.001);
  assert.equal(rocket.boosted, false);

  runSteps(simulation, 120);
  rocket = simulation
    .getSnapshot()
    .projectiles.find((projectile) => projectile.kind === "rocket");
  assert.ok(rocket);
  assert.ok(Math.abs(Math.hypot(rocket.vx, rocket.vy) - 150) < 0.001);
  assert.equal(rocket.boosted, true);
});

test("already-fired projectiles survive their shooter's death with attribution intact", () => {
  const manifest = createDefaultManifest();
  const board = selectedBoard(manifest);
  board.width = 2_000;
  board.height = 800;
  board.unitScale = 1;
  board.props = [
    {
      id: "shooter-lava",
      type: "lava",
      active: true,
      shape: { kind: "circle", x: 200, y: 400, radius: 80 },
      buffDuration: 3,
      effectPerSecond: 10,
    },
  ];
  const shooter = definition(manifest, "police-2");
  shooter.maxHp = 5;
  shooter.speed = 0;
  shooter.attack.range = 2_000;
  shooter.attack.cooldown = 100;
  shooter.attack.windup = 0;
  shooter.attack.projectileSpeed = 20;
  shooter.attack.spreadDegrees = 0;
  const ally = definition(manifest, "panda-lazy");
  ally.pluginId = undefined;
  ally.speed = 0;
  ally.attack.range = 0;
  ally.attack.damage = 0;
  const target = definition(manifest, "mole");
  target.pluginId = undefined;
  target.speed = 0;
  target.attack.range = 0;
  target.attack.damage = 0;
  target.maxHp = 10_000;
  manifest.setup.contestants = [
    {
      id: "doomed-shooter",
      definitionId: "police-2",
      displayName: "阵亡射手",
      position: { x: 200, y: 400 },
      direction: { x: 1, y: 0 },
      color: "#ff5968",
      teamId: "red",
    },
    {
      id: "red-anchor",
      definitionId: "panda-lazy",
      displayName: "红队留场",
      position: { x: 200, y: 700 },
      direction: { x: 1, y: 0 },
      color: "#ff5968",
      teamId: "red",
    },
    {
      id: "distant-target",
      definitionId: "mole",
      displayName: "远处目标",
      position: { x: 1_800, y: 400 },
      direction: { x: -1, y: 0 },
      color: "#55a7ff",
      teamId: "blue",
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 55);
  const fired = simulation
    .getSnapshot()
    .projectiles.find(
      (projectile) => projectile.sourceUnitId === "doomed-shooter",
    );
  assert.ok(fired);

  runSteps(simulation, 40);
  const snapshot = simulation.getSnapshot();
  const deadShooter = snapshot.units.find(
    (unit) => unit.id === "doomed-shooter",
  );
  assert.ok(deadShooter);
  assert.equal(deadShooter.action, "dead");
  const survivingProjectile = snapshot.projectiles.find(
    (projectile) => projectile.id === fired.id,
  );
  assert.ok(survivingProjectile);
  assert.equal(survivingProjectile.sourceUnitId, deadShooter.id);
  assert.equal(survivingProjectile.factionId, deadShooter.factionId);
});
