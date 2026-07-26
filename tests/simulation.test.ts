import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultManifest } from "../lib/game/defaultContent";
import { BattleSimulation, circleOverlapsRegion } from "../lib/game/simulation";
import type { BoardDefinition, CharacterDefinition, ProjectManifest } from "../lib/game/types";

const runSteps = (simulation: BattleSimulation, count: number, dt = 1 / 60): void => {
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
  const board = selectedBoard(manifest);
  board.props = [];
  board.unitScale = 1;
  manifest.setup.contestants = structuredClone(manifest.setup.contestants.slice(0, 2));
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
  assert.ok(runtimePanda.hp < runtimePanda.maxHp - 8);
  assert.equal(snapshot.units.some((unit) => unit.policeStar !== undefined), false);
});

test("hot spring healing persists for three seconds after leaving the region", () => {
  const manifest = twoFighterManifest();
  const board = selectedBoard(manifest);
  board.props = [
    {
      id: "damage-strip",
      type: "lava",
      active: true,
      shape: { kind: "rectangle", x: 40, y: 150, width: 80, height: 100 },
      buffDuration: 0.1,
      effectPerSecond: 60,
    },
    {
      id: "spring-strip",
      type: "hotSpring",
      active: true,
      shape: { kind: "rectangle", x: 160, y: 150, width: 80, height: 100 },
      buffDuration: 3,
      effectPerSecond: 12,
    },
  ];
  disableCombat(manifest);
  const panda = definition(manifest, "panda-lazy");
  const mole = definition(manifest, "mole");
  panda.speed = 120;
  panda.pluginId = undefined;
  mole.speed = 0;
  mole.pluginId = undefined;
  manifest.setup.contestants[0].position = { x: 70, y: 200 };
  manifest.setup.contestants[0].direction = { x: 1, y: 0 };
  manifest.setup.contestants[1].position = { x: 1200, y: 700 };

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 130);
  const before = simulation
    .getSnapshot()
    .units.find((unit) => unit.definitionId === "panda-lazy");
  assert.ok(before);
  assert.ok(before.x > 300, "the panda should have left the spring");
  assert.ok(before.springUntil > simulation.getSnapshot().time);
  const hpBefore = before.hp;
  runSteps(simulation, 30);
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
  assert.ok(
    chainSnapshot.units.some((unit) => unit.policeStar === 5),
    `remaining police: ${JSON.stringify(
      chainSnapshot.units
        .filter((unit) => unit.policeStar)
        .map((unit) => ({ star: unit.policeStar, hp: unit.hp })),
    )}; merges=${chainSnapshot.events.filter((event) => event.type === "merge").length}; spawns=${
      chainSnapshot.events.filter((event) => event.type === "spawn").length
    }`,
  );
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

test("a hole loses durability only on three distinct entries before collapsing", () => {
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
  mole.skillParameters!.mole!.stompsToFlatten = 3;
  mole.skillParameters!.mole!.digCooldown = 100;
  manifest.setup.contestants[0].position = { x: 80, y: 150 };
  manifest.setup.contestants[0].direction = { x: 1, y: 0 };
  manifest.setup.contestants[1].position = { x: 250, y: 150 };
  manifest.setup.contestants[1].direction = { x: 0, y: 1 };

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 60);
  let snapshot = simulation.getSnapshot();
  assert.equal(snapshot.holes.length, 1);
  assert.equal(snapshot.holes[0].stompsRemaining, 2);

  runSteps(simulation, 240);
  snapshot = simulation.getSnapshot();
  assert.equal(snapshot.holes.length, 1);
  assert.equal(snapshot.holes[0].stompsRemaining, 1);

  runSteps(simulation, 250);
  snapshot = simulation.getSnapshot();
  assert.equal(snapshot.holes.length, 0);
  assert.equal(
    snapshot.events.filter((event) => event.message.includes("踩中洞口")).length,
    3,
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
    mode: "melee",
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
      position: { x: 1400, y: 120 },
      direction: { x: 0, y: 1 },
      color: "#ff9f58",
    },
    {
      id: "moving-target",
      definitionId: "panda-lazy",
      displayName: "移动靶",
      position: { x: 1550, y: 120 },
      direction: { x: 0, y: 1 },
      color: "#f6d85f",
    },
  ];

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 150);
  assert.ok(
    simulation
      .getSnapshot()
      .events.some((event) => event.message.includes("RPG 撞上棋盘边界并爆炸")),
  );
});
