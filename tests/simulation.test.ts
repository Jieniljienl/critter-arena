import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultManifest } from "../lib/game/defaultContent";
import { BattleSimulation, circleOverlapsRegion } from "../lib/game/simulation";
import type { ProjectManifest } from "../lib/game/types";


const runSteps = (simulation: BattleSimulation, count: number, dt = 1 / 60): void => {
  for (let index = 0; index < count; index += 1) simulation.step(dt);
};

const twoFighterManifest = (): ProjectManifest => {
  const manifest = createDefaultManifest();
  manifest.boards[0].props = [];
  manifest.setup.contestants = structuredClone(manifest.setup.contestants.slice(0, 2));
  return manifest;
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
  const panda = manifest.characters.find((character) => character.id === "panda");
  const mole = manifest.characters.find((character) => character.id === "mole");
  assert.ok(panda && mole);
  panda.speed = 120;
  panda.attack.range = 0;
  mole.speed = 0;
  mole.pluginId = undefined;
  mole.attack.range = 0;
  manifest.setup.contestants[0].position = { x: 1550, y: 450 };
  manifest.setup.contestants[0].direction = { x: 1, y: 0 };
  manifest.setup.contestants[1].position = { x: 200, y: 450 };

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 24);
  const movingPanda = simulation
    .getSnapshot()
    .units.find((unit) => unit.id === manifest.setup.contestants[0].id);
  assert.ok(movingPanda);
  assert.ok(movingPanda.vx < 0);
  assert.ok(movingPanda.x >= movingPanda.radius);
  assert.ok(movingPanda.x <= manifest.boards[0].width - movingPanda.radius);
});

test("lava deals five damage per second without triggering panda police support", () => {
  const manifest = twoFighterManifest();
  manifest.boards[0].props = [
    {
      id: "all-lava",
      type: "lava",
      active: true,
      label: "测试岩浆",
      shape: { kind: "rectangle", x: 0, y: 0, width: 1600, height: 900 },
    },
  ];
  for (const character of manifest.characters) {
    character.speed = 0;
    character.attack.range = 0;
  }
  const mole = manifest.characters.find((character) => character.id === "mole");
  assert.ok(mole);
  mole.pluginId = undefined;

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 60);
  const snapshot = simulation.getSnapshot();
  const panda = snapshot.units.find((unit) => unit.definitionId === "panda");
  assert.ok(panda);
  assert.ok(Math.abs(panda.hp - 345) < 0.001);
  assert.equal(snapshot.units.some((unit) => unit.policeStar !== undefined), false);
});

test("sixteen qualifying attacks call human police support and merge to five stars", () => {
  const manifest = twoFighterManifest();
  const panda = manifest.characters.find((character) => character.id === "panda");
  const attacker = manifest.characters.find((character) => character.id === "mole");
  assert.ok(panda && attacker);
  panda.maxHp = 10_000;
  panda.speed = 0;
  panda.attack.range = 0;
  panda.attack.damage = 0;
  attacker.pluginId = undefined;
  attacker.maxHp = 10_000;
  attacker.speed = 0;
  attacker.attack = {
    range: 1,
    damage: 1,
    cooldown: 0.5,
    windup: 0,
    mode: "melee",
  };
  for (const police of manifest.characters.filter((character) => character.policeStar)) {
    police.speed = 0;
    police.radius = 0;
    police.attack.range = 0;
    police.attack.damage = 0;
  }
  manifest.setup.contestants[0].position = { x: 800, y: 450 };
  manifest.setup.contestants[1].position = { x: 800, y: 450 };

  const simulation = new BattleSimulation(manifest);
  simulation.start();
  runSteps(simulation, 620);
  const snapshot = simulation.getSnapshot();
  assert.ok(snapshot.units.some((unit) => unit.policeStar === 5));
  assert.ok(
    snapshot.events.some(
      (event) => event.type === "spawn" && event.message.includes("人类警察赶来保护"),
    ),
  );
});

test("a mole's holes are removed with the owner and the death fade completes", () => {
  const manifest = twoFighterManifest();
  const panda = manifest.characters.find((character) => character.id === "panda");
  const mole = manifest.characters.find((character) => character.id === "mole");
  assert.ok(panda && mole);
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
  const rocketOfficer = manifest.characters.find((character) => character.id === "police-4");
  const panda = manifest.characters.find((character) => character.id === "panda");
  assert.ok(rocketOfficer && panda);
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
      definitionId: "panda",
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
