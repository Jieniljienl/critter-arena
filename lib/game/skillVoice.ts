import type {
  AbilityAction,
  CharacterDefinition,
  SkillVoiceProfile,
  SoundCue,
  SynthPreset,
} from "./types";

export const SKILL_VOICE_IDS = {
  pandaEat: "panda:eat",
  pandaGuard: "panda:guard",
  pandaBamboo: "panda:bamboo",
  moleDig: "mole:dig",
  moleAmbush: "mole:ambush",
  moleTunnel: "mole:tunnel",
  policePromotion: "police:promotion",
  policeGatling: "police:gatling",
  policeReload: "police:reload",
  policeKick: "police:kick",
} as const;

export const abilitySkillVoiceId = (abilityId: string): string =>
  `ability:${abilityId}`;

export type SkillVoiceDescriptor = {
  id: string;
  label: string;
  effect: string;
  defaultProfile: SkillVoiceProfile;
  legacySound?: SynthPreset;
  legacyPhraseIndex?: number;
};

type SkillVoiceCharacter = Pick<
  CharacterDefinition,
  "pluginId" | "policeStar" | "abilities"
>;

const profile = (
  phrase: string,
  speechRate: number,
  speechPitch: number,
): SkillVoiceProfile => ({
  phrase,
  speechRate,
  speechPitch,
});

const pandaVoiceDescriptors: SkillVoiceDescriptor[] = [
  {
    id: SKILL_VOICE_IDS.pandaEat,
    label: "食竹恢复",
    effect: "抱竹进食 · 咀嚼音效",
    defaultProfile: profile("竹子开席，我边吃边回血。", 0.9, 0.84),
    legacySound: "chew",
  },
  {
    id: SKILL_VOICE_IDS.pandaGuard,
    label: "护卫警队",
    effect: "受击呼救 · 警员入场",
    defaultProfile: profile("保护动物遇袭，警员立刻支援！", 1.04, 0.9),
    legacyPhraseIndex: 0,
  },
  {
    id: SKILL_VOICE_IDS.pandaBamboo,
    label: "竹林补给",
    effect: "竹子刷新 · 治疗光效",
    defaultProfile: profile("竹林补给刷新，开饭不排队。", 0.98, 0.88),
    legacySound: "heal",
  },
];

const moleVoiceDescriptors: SkillVoiceDescriptor[] = [
  {
    id: SKILL_VOICE_IDS.moleDig,
    label: "挖掘洞口",
    effect: "扬土挖掘 · 洞口生成",
    defaultProfile: profile("开工挖洞，土路马上通。", 1.08, 1.18),
    legacySound: "dig",
  },
  {
    id: SKILL_VOICE_IDS.moleAmbush,
    label: "洞口偷袭",
    effect: "地下突进 · 出洞突袭",
    defaultProfile: profile("地道突袭，我从你脚下出来！", 1.18, 1.26),
    legacySound: "tunnel",
    legacyPhraseIndex: 0,
  },
  {
    id: SKILL_VOICE_IDS.moleTunnel,
    label: "地道穿行",
    effect: "钻入地面 · 换洞出现",
    defaultProfile: profile("地面太挤，我换个洞口走。", 1.12, 1.24),
    legacySound: "tunnel",
    legacyPhraseIndex: 1,
  },
];

const policePromotionProfile = (
  star: CharacterDefinition["policeStar"],
): SkillVoiceProfile => {
  const profiles: Partial<Record<NonNullable<CharacterDefinition["policeStar"]>, SkillVoiceProfile>> = {
    1: profile("战功到账，准备升职。", 1.02, 1.05),
    2: profile("手枪到位，二星报到。", 1.04, 1),
    3: profile("步枪接管，三连压制。", 1.02, 0.94),
    4: profile("火箭就位，爆破清场。", 0.96, 0.86),
    5: profile("重装晋升，火力全开。", 0.9, 0.72),
  };
  return profiles[star ?? 1] ?? profiles[1]!;
};

const policeVoiceDescriptors = (
  star: CharacterDefinition["policeStar"],
): SkillVoiceDescriptor[] => [
  {
    id: SKILL_VOICE_IDS.policePromotion,
    label: "战功升星",
    effect: "升星闪光 · 角色完整切换",
    defaultProfile: policePromotionProfile(star),
    legacySound: "merge",
    legacyPhraseIndex: 0,
  },
  ...(star === 5
    ? [
        {
          id: SKILL_VOICE_IDS.policeGatling,
          label: "加特林连射",
          effect: "定向锁定 · 弹链高速开火",
          defaultProfile: profile("目标方向锁定，弹链开始咆哮。", 0.92, 0.72),
          legacySound: "gatling" as const,
          legacyPhraseIndex: 0,
        },
        {
          id: SKILL_VOICE_IDS.policeReload,
          label: "重装换弹",
          effect: "弹仓清空 · 连贯更换弹链",
          defaultProfile: profile("弹链打空，掩护我完成换装。", 0.86, 0.68),
          legacySound: "reload" as const,
          legacyPhraseIndex: 0,
        },
        {
          id: SKILL_VOICE_IDS.policeKick,
          label: "近身反制",
          effect: "重装踹击 · 击退撞墙",
          defaultProfile: profile("贴身危险，重装反制！", 1.12, 0.74),
          legacySound: "kick" as const,
          legacyPhraseIndex: 0,
        },
      ]
    : []),
];

const firstAbilityAction = (
  character: SkillVoiceCharacter,
  abilityId: string,
): AbilityAction | undefined =>
  character.abilities.find((ability) => ability.id === abilityId)?.actions[0];

const abilityEffect = (action: AbilityAction | undefined): string => {
  if (!action) return "扩展技能动作";
  if (action.kind === "heal") return "恢复光效 · 生命回复";
  if (action.kind === "damageNearby") return "范围冲击 · 群体伤害";
  if (action.kind === "spawnUnit") return "召唤法阵 · 单位入场";
  if (action.kind === "knockbackNearby") return "冲击波 · 范围击退";
  return `技能音效 · ${action.cue}`;
};

const abilityProfile = (
  name: string,
  action: AbilityAction | undefined,
): SkillVoiceProfile => {
  if (action?.kind === "heal") return profile(`${name}，恢复生效。`, 0.94, 1.04);
  if (action?.kind === "damageNearby") {
    return profile(`${name}，冲击展开！`, 1.12, 0.92);
  }
  if (action?.kind === "spawnUnit") {
    return profile(`${name}，支援单位入场！`, 1.04, 0.98);
  }
  if (action?.kind === "knockbackNearby") {
    return profile(`${name}，全部退开！`, 1.14, 0.9);
  }
  return profile(`${name}，发动！`, 1.04, 1);
};

export const skillVoiceDescriptorsFor = (
  character: SkillVoiceCharacter,
): SkillVoiceDescriptor[] => {
  const builtIn =
    character.pluginId === "panda"
      ? pandaVoiceDescriptors
      : character.pluginId === "mole"
        ? moleVoiceDescriptors
        : character.pluginId === "police"
          ? policeVoiceDescriptors(character.policeStar)
          : [];
  const custom = character.abilities.map((ability, index) => {
    const action = firstAbilityAction(character, ability.id);
    return {
      id: abilitySkillVoiceId(ability.id),
      label: ability.name,
      effect: abilityEffect(action),
      defaultProfile: abilityProfile(ability.name, action),
      legacyPhraseIndex: builtIn.length + index,
    };
  });
  return [...builtIn, ...custom];
};

export const defaultSkillVoiceProfilesFor = (
  character: SkillVoiceCharacter,
): Record<string, SkillVoiceProfile> =>
  Object.fromEntries(
    skillVoiceDescriptorsFor(character).map((descriptor) => [
      descriptor.id,
      structuredClone(descriptor.defaultProfile),
    ]),
  );

const cleanPhrases = (phrases: string[] | undefined): string[] =>
  (phrases ?? []).map((phrase) => phrase.trim()).filter(Boolean);

/**
 * Converts legacy candidate arrays into stable one-line mappings without
 * replacing any skill voice the user has already edited.
 */
export const upgradeSkillVoiceProfiles = (
  character: SkillVoiceCharacter,
  cue: SoundCue,
): Record<string, SkillVoiceProfile> => {
  const upgraded = structuredClone(cue.skillVoices ?? {});
  const genericPhrases = cleanPhrases(cue.phrases);
  for (const descriptor of skillVoiceDescriptorsFor(character)) {
    if (Object.prototype.hasOwnProperty.call(upgraded, descriptor.id)) continue;
    const soundPhrases = descriptor.legacySound
      ? cleanPhrases(cue.phrasesBySound?.[descriptor.legacySound])
      : [];
    const legacyPhrase =
      soundPhrases[descriptor.legacyPhraseIndex ?? 0] ??
      genericPhrases[descriptor.legacyPhraseIndex ?? 0];
    upgraded[descriptor.id] = legacyPhrase
      ? { phrase: legacyPhrase }
      : structuredClone(descriptor.defaultProfile);
  }
  return upgraded;
};
