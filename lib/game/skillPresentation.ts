import type {
  AbilityTrigger,
  CharacterDefinition,
} from "./types";

export type SkillActivity = "active" | "passive";
export type BuiltInSkillParameterGroup = "panda" | "mole" | "police";
export type BuiltInSkillParameterSource =
  | BuiltInSkillParameterGroup
  | "policePromotion";

export type SkillParameterField = {
  key: string;
  label: string;
  fallback: number;
  min?: number;
  max?: number;
  step?: number;
};

export type BuiltInSkillModule = {
  id: string;
  title: string;
  activity: SkillActivity;
  triggerLabel: string;
  description: string;
  parameterSource: BuiltInSkillParameterSource;
  fields: SkillParameterField[];
  sharedLabel?: string;
};

const pandaModules: BuiltInSkillModule[] = [
  {
    id: "panda-eat",
    title: "食竹恢复",
    activity: "active",
    triggerLabel: "受伤后接触竹子",
    description: "主动抱住附近竹子进食，完成后恢复生命。",
    parameterSource: "panda",
    fields: [
      { key: "eatDuration", label: "进食耗时（秒）", fallback: 5, min: 0.1, step: 0.1 },
      { key: "eatHeal", label: "吃竹回血", fallback: 100, min: 0 },
      { key: "eatCooldown", label: "进食冷却（秒）", fallback: 5, min: 0, step: 0.1 },
      { key: "bambooExtraRange", label: "竹子额外触发距离", fallback: 0, min: 0 },
    ],
  },
  {
    id: "panda-guard",
    title: "护卫警队",
    activity: "passive",
    triggerLabel: "受到直接攻击",
    description: "受击时呼叫警员支援，并允许同阵营警员碰撞合体。",
    parameterSource: "panda",
    fields: [
      {
        key: "policeSummonCooldown",
        label: "受击召警冷却（秒）",
        fallback: 0.5,
        min: 0,
        step: 0.05,
      },
      {
        key: "policeCallDuration",
        label: "呼救动作时长（秒）",
        fallback: 0.7,
        min: 0.1,
        step: 0.05,
      },
      { key: "policeMergePadding", label: "警察碰撞合并余量", fallback: 0, min: 0 },
    ],
  },
  {
    id: "panda-bamboo",
    title: "竹林补给",
    activity: "passive",
    triggerLabel: "熊猫存活期间",
    description: "周期补充地图竹子，并限制场上同时存在的数量。",
    parameterSource: "panda",
    fields: [
      {
        key: "bambooRespawnInterval",
        label: "竹子刷新间隔（秒）",
        fallback: 15,
        min: 0.1,
        step: 0.1,
      },
      {
        key: "bambooRespawnLimit",
        label: "场上竹子上限",
        fallback: 3,
        min: 0,
        max: 99,
        step: 1,
      },
    ],
  },
];

const moleModules: BuiltInSkillModule[] = [
  {
    id: "mole-dig",
    title: "挖掘洞口",
    activity: "active",
    triggerLabel: "冷却完成且距离允许",
    description: "原地完成挖掘动作并留下可长期使用的洞口。",
    parameterSource: "mole",
    fields: [
      { key: "digCooldown", label: "挖洞冷却（秒）", fallback: 10, min: 0, step: 0.1 },
      { key: "digDuration", label: "挖洞动作（秒）", fallback: 0.6, min: 0.1, step: 0.1 },
      { key: "minimumHoleDistance", label: "洞口最小间距", fallback: 220, min: 0 },
      { key: "holeRadius", label: "洞口范围半径", fallback: 80, min: 10 },
    ],
  },
  {
    id: "mole-ambush",
    title: "洞口偷袭",
    activity: "active",
    triggerLabel: "洞口附近存在敌人",
    description: "从洞口潜行至敌人附近发动偷袭，完整出洞后开始冷却。",
    parameterSource: "mole",
    fields: [
      { key: "ambushRange", label: "钻洞偷袭范围", fallback: 150, min: 0 },
      { key: "ambushCooldown", label: "偷袭冷却（秒）", fallback: 3, min: 0, step: 0.1 },
    ],
  },
  {
    id: "mole-tunnel",
    title: "地道穿行",
    activity: "passive",
    triggerLabel: "进入洞口时判定",
    description: "进入洞口时有概率随机穿行；速度参数也作用于偷袭。",
    parameterSource: "mole",
    fields: [
      {
        key: "tunnelSpeedMultiplier",
        label: "钻地速度倍率（相对移速）",
        fallback: 2.5,
        min: 0.1,
        max: 50,
        step: 0.1,
      },
      {
        key: "tunnelDuration",
        label: "钻洞最短动作时长（秒）",
        fallback: 1,
        min: 0.1,
        step: 0.1,
      },
      {
        key: "tunnelChance",
        label: "随机钻洞概率",
        fallback: 0.2,
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
  },
];

const policePromotionModule: BuiltInSkillModule = {
  id: "police-promotion",
  title: "战功升星",
  activity: "passive",
  triggerLabel: "累计击败敌人",
  description: "每次击败获得一格经验，达到门槛后完整切换为下一星角色。",
  parameterSource: "policePromotion",
  sharedLabel: "六角色共享",
  fields: [
    { key: "experienceToStar2", label: "1→2 星所需经验", fallback: 1, min: 1, max: 99 },
    { key: "experienceToStar3", label: "2→3 星所需经验", fallback: 2, min: 1, max: 99 },
    { key: "experienceToStar4", label: "3→4 星所需经验", fallback: 2, min: 1, max: 99 },
    { key: "experienceToStar5", label: "4→5 星所需经验", fallback: 3, min: 1, max: 99 },
    { key: "experienceToStar6", label: "5→6 星所需经验", fallback: 5, min: 1, max: 99 },
  ],
};

const batonRushModule: BuiltInSkillModule = {
  id: "police-baton-rush",
  title: "追击敲击",
  activity: "active",
  triggerLabel: "冷却就绪后锁定最近敌人",
  description: "一星警察按设定倍率追踪目标，贴身后只敲击一次；伤害与普通攻击相同。",
  parameterSource: "police",
  fields: [
    {
      key: "batonRushSpeedMultiplier",
      label: "追击移动速度倍率（相对移速）",
      fallback: 3,
      min: 0.1,
      max: 50,
      step: 0.1,
    },
    {
      key: "batonRushCooldown",
      label: "追击敲击冷却（秒）",
      fallback: 10,
      min: 0,
      step: 0.1,
    },
  ],
};

const sniperModule: BuiltInSkillModule = {
  id: "police-sniper",
  title: "蹲伏狙击",
  activity: "active",
  triggerLabel: "冷却就绪后锁定一名敌人",
  description: "蹲伏瞄准三秒并显示红色引导线，随后发射高速狙击弹；有小概率偏离锁定目标。",
  parameterSource: "police",
  fields: [
    {
      key: "sniperAimDuration",
      label: "瞄准时间（秒）",
      fallback: 3,
      min: 0.1,
      step: 0.1,
    },
    {
      key: "sniperCooldown",
      label: "狙击冷却（秒）",
      fallback: 8,
      min: 0,
      step: 0.1,
    },
    { key: "sniperDamage", label: "狙击伤害", fallback: 60, min: 0 },
    {
      key: "sniperProjectileSpeed",
      label: "子弹速度",
      fallback: 1600,
      min: 1,
    },
    {
      key: "sniperMissChance",
      label: "偏离概率（0–1）",
      fallback: 0.12,
      min: 0,
      max: 1,
      step: 0.01,
    },
    { key: "sniperRange", label: "锁定范围", fallback: 2200, min: 1 },
  ],
};

const gatlingModule: BuiltInSkillModule = {
  id: "police-gatling",
  title: "火力循环",
  activity: "active",
  triggerLabel: "锁定敌人后自动连射",
  description: "管理六星加特林弹仓；弹链耗尽后完成换弹再恢复射击。",
  parameterSource: "police",
  fields: [
    {
      key: "gatlingMagazineSize",
      label: "六星弹仓容量（发）",
      fallback: 150,
      min: 1,
      max: 9999,
    },
    {
      key: "gatlingReloadDuration",
      label: "六星换弹时间（秒）",
      fallback: 3,
      min: 0.05,
      step: 0.05,
    },
  ],
};

const kickModule: BuiltInSkillModule = {
  id: "police-kick",
  title: "近身反制",
  activity: "passive",
  triggerLabel: "近距离受到攻击",
  description: "遭到近身攻击时踹飞敌人；撞上边界会追加眩晕。",
  parameterSource: "police",
  fields: [
    { key: "kickRange", label: "六星踹击范围", fallback: 160, min: 0 },
    { key: "kickDistance", label: "六星踹飞距离", fallback: 140, min: 0 },
    { key: "kickDamage", label: "六星踹击伤害", fallback: 25, min: 0 },
    { key: "kickCooldown", label: "踹击冷却（秒）", fallback: 0.5, min: 0, step: 0.05 },
    { key: "kickDuration", label: "踹击动作（秒）", fallback: 0.35, min: 0.05, step: 0.05 },
    {
      key: "kickWallStunDuration",
      label: "撞墙眩晕（秒）",
      fallback: 0.5,
      min: 0,
      step: 0.05,
    },
  ],
};

export const builtInSkillModulesFor = (
  character: Pick<CharacterDefinition, "pluginId" | "policeStar">,
): BuiltInSkillModule[] => {
  if (character.pluginId === "panda") return pandaModules;
  if (character.pluginId === "mole") return moleModules;
  if (character.pluginId === "police") {
    if (character.policeStar === 1) {
      return [policePromotionModule, batonRushModule];
    }
    if (character.policeStar === 5) {
      return [policePromotionModule, sniperModule];
    }
    if (character.policeStar === 6) {
      return [gatlingModule, kickModule];
    }
    return [policePromotionModule];
  }
  return [];
};

export const abilityActivityForTrigger = (
  trigger: AbilityTrigger,
): SkillActivity => (trigger === "interval" ? "active" : "passive");

export const abilityTriggerLabel = (trigger: AbilityTrigger): string => {
  const labels: Record<AbilityTrigger, string> = {
    interval: "定时自动施放",
    onDamageTaken: "受到攻击时触发",
    onAttack: "发动攻击后触发",
    onDeath: "死亡时触发",
  };
  return labels[trigger];
};
