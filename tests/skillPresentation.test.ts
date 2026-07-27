import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultManifest } from "../lib/game/defaultContent";
import {
  abilityActivityForTrigger,
  abilityTriggerLabel,
  builtInSkillModulesFor,
} from "../lib/game/skillPresentation";

const character = (id: string) => {
  const found = createDefaultManifest().characters.find(
    (candidate) => candidate.id === id,
  );
  assert.ok(found);
  return found;
};

test("built-in skills are split into stable active/passive workshop modules", () => {
  const pandaModules = builtInSkillModulesFor(character("panda-lazy"));
  assert.deepEqual(
    pandaModules.map(({ title, activity }) => ({ title, activity })),
    [
      { title: "食竹恢复", activity: "active" },
      { title: "护卫警队", activity: "passive" },
      { title: "竹林补给", activity: "passive" },
    ],
  );

  const moleModules = builtInSkillModulesFor(character("mole"));
  assert.deepEqual(
    moleModules.map(({ title, activity }) => ({ title, activity })),
    [
      { title: "挖掘洞口", activity: "active" },
      { title: "洞口偷袭", activity: "active" },
      { title: "地道穿行", activity: "passive" },
    ],
  );

  const lowStarPolice = builtInSkillModulesFor(character("police-1"));
  assert.deepEqual(
    lowStarPolice.map(({ title, activity, sharedLabel }) => ({
      title,
      activity,
      sharedLabel,
    })),
    [
      {
        title: "战功升星",
        activity: "passive",
        sharedLabel: "五角色共享",
      },
    ],
  );

  const fiveStarPolice = builtInSkillModulesFor(character("police-5"));
  assert.deepEqual(
    fiveStarPolice.map(({ title, activity }) => ({ title, activity })),
    [
      { title: "战功升星", activity: "passive" },
      { title: "火力循环", activity: "active" },
      { title: "近身反制", activity: "passive" },
    ],
  );
});

test("each built-in parameter belongs to exactly one displayed skill card", () => {
  for (const id of ["panda-lazy", "mole", "police-5"]) {
    const fields = builtInSkillModulesFor(character(id)).flatMap((module) =>
      module.fields.map((field) => `${module.parameterSource}:${field.key}`),
    );
    assert.equal(
      new Set(fields).size,
      fields.length,
      `${id} should not repeat a parameter across skill cards`,
    );
  }
});

test("extension skill activity and trigger summaries are derived from combat triggers", () => {
  assert.equal(abilityActivityForTrigger("interval"), "active");
  assert.equal(abilityTriggerLabel("interval"), "定时自动施放");

  for (const trigger of [
    "onDamageTaken",
    "onAttack",
    "onDeath",
  ] as const) {
    assert.equal(abilityActivityForTrigger(trigger), "passive");
    assert.ok(abilityTriggerLabel(trigger).includes("触发"));
  }
});
