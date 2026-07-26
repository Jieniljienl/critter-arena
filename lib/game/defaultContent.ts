import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  SCHEMA_VERSION,
  type AnimationClip,
  type AssetRef,
  type BoardDefinition,
  type CharacterDefinition,
  type MatchSetup,
  type ProjectManifest,
  type SoundCue,
  type SynthPreset,
} from "./types";

const synth = (id: string, preset: SynthPreset, volume = 0.75): SoundCue => ({
  id,
  source: "synth",
  preset,
  volume,
  pitchVariance: 0.06,
  maxVoices: 8,
});

const speech = (id: string, phrases: string[], volume = 0.8): SoundCue => ({
  id,
  source: "speech",
  phrases,
  speechRate: 1.05,
  speechPitch: 0.92,
  volume,
  maxVoices: 1,
});

const clip = (
  id: string,
  frames: string[],
  loop = false,
  durationMs = 130,
): AnimationClip => ({
  id,
  loop,
  frames: frames.map((assetId, index) => ({
    assetId,
    durationMs,
    marker: index === Math.floor(frames.length / 2) ? "attack" : undefined,
  })),
});

const asset = (id: string, url: string, name: string): AssetRef => ({
  id,
  kind: "image",
  url,
  name,
  mime: url.endsWith(".webp") ? "image/webp" : "image/png",
});

export const defaultAssets: AssetRef[] = [
  asset("board-bamboo-lava", "/assets/board-bamboo-lava.webp", "竹林熔岩竞技场"),
  asset("board-stream-landscape", "/assets/board-stream-landscape.webp", "横屏直播竞技场"),
  asset("board-stream-portrait", "/assets/board-stream-portrait.webp", "竖屏直播竞技场"),
  asset("panda-idle", "/assets/panda-idle.png", "熊猫待机"),
  asset("panda-attack-1", "/assets/panda-attack-1.png", "熊猫攻击蓄力"),
  asset("panda-attack-2", "/assets/panda-attack-2.png", "熊猫攻击命中"),
  asset("panda-attack-3", "/assets/panda-attack-3.png", "熊猫攻击收势"),
  asset("panda-skill-1", "/assets/panda-skill-1.png", "熊猫拿竹子"),
  asset("panda-skill-2", "/assets/panda-skill-2.png", "熊猫咀嚼一"),
  asset("panda-skill-3", "/assets/panda-skill-3.png", "熊猫咀嚼二"),
  asset("panda-skill-4", "/assets/panda-skill-4.png", "熊猫满足"),
  asset("panda-lazy-idle", "/assets/panda-lazy-idle.png", "懒洋洋熊猫待机"),
  asset("panda-lazy-attack-1", "/assets/panda-lazy-attack-1.png", "懒洋洋熊猫随手蓄力"),
  asset("panda-lazy-attack-2", "/assets/panda-lazy-attack-2.png", "懒洋洋熊猫随手拍"),
  asset("panda-lazy-attack-3", "/assets/panda-lazy-attack-3.png", "懒洋洋熊猫摊手"),
  asset("panda-lazy-skill-1", "/assets/panda-lazy-skill-1.png", "懒洋洋熊猫够竹子"),
  asset("panda-lazy-skill-2", "/assets/panda-lazy-skill-2.png", "懒洋洋熊猫躺吃一"),
  asset("panda-lazy-skill-3", "/assets/panda-lazy-skill-3.png", "懒洋洋熊猫躺吃二"),
  asset("panda-lazy-skill-4", "/assets/panda-lazy-skill-4.png", "懒洋洋熊猫揉肚子"),
  asset("mole-idle", "/assets/mole-idle.png", "地鼠待机"),
  asset("mole-attack-1", "/assets/mole-attack-1.png", "地鼠攻击蓄力"),
  asset("mole-attack-2", "/assets/mole-attack-2.png", "地鼠攻击命中"),
  asset("mole-attack-3", "/assets/mole-attack-3.png", "地鼠攻击收势"),
  asset("mole-skill-1", "/assets/mole-skill-1.png", "地鼠挖洞一"),
  asset("mole-skill-2", "/assets/mole-skill-2.png", "地鼠挖洞二"),
  asset("mole-skill-3", "/assets/mole-skill-3.png", "地鼠钻地"),
  asset("mole-skill-4", "/assets/mole-skill-4.png", "地鼠偷袭"),
  asset("mole-tunnel-1", "/assets/mole-tunnel-1.png", "地鼠钻洞起手"),
  asset("mole-tunnel-2", "/assets/mole-tunnel-2.png", "地鼠地下突进"),
  asset("mole-tunnel-3", "/assets/mole-tunnel-3.png", "地鼠出洞攻击"),
  asset("mole-tunnel-4", "/assets/mole-tunnel-4.png", "地鼠返回洞口"),
  asset("bamboo", "/assets/bamboo.png", "竹子"),
  asset("hole", "/assets/hole.png", "洞"),
  asset("rocket", "/assets/rocket.png", "火箭"),
  asset("explosion", "/assets/explosion.png", "爆炸"),
];

for (let star = 1; star <= 5; star += 1) {
  defaultAssets.push(
    asset(`police-${star}-idle`, `/assets/police-${star}-idle.png`, `${star}星警察待机`),
    asset(`police-${star}-attack-1`, `/assets/police-${star}-attack-1.png`, `${star}星警察攻击一`),
    asset(`police-${star}-attack-2`, `/assets/police-${star}-attack-2.png`, `${star}星警察攻击二`),
    asset(`police-${star}-attack-3`, `/assets/police-${star}-attack-3.png`, `${star}星警察攻击三`),
  );
}
defaultAssets.push(
  asset("police-5-skill-1", "/assets/police-5-skill-1.png", "五星警察踹击一"),
  asset("police-5-skill-2", "/assets/police-5-skill-2.png", "五星警察踹击二"),
  asset("police-5-skill-3", "/assets/police-5-skill-3.png", "五星警察踹击三"),
);

const baseAnimations = (prefix: string): Record<string, AnimationClip> => ({
  idle: clip("idle", [`${prefix}-idle`], true, 500),
  move: clip("move", [`${prefix}-idle`], true, 500),
  attack: clip("attack", [
    `${prefix}-attack-1`,
    `${prefix}-attack-2`,
    `${prefix}-attack-3`,
  ]),
});

const pandaSkillParameters = {
  eatDuration: 5,
  eatHeal: 100,
  eatCooldown: 5,
  bambooExtraRange: 0,
  policeSummonCooldown: 0.5,
  policeMergePadding: 0,
};

const moleSkillParameters = {
  digCooldown: 10,
  digDuration: 0.6,
  minimumHoleDistance: 220,
  holeRadius: 80,
  stompsToFlatten: 3,
  ambushRange: 150,
  ambushCooldown: 3,
  tunnelDuration: 1,
  tunnelChance: 0.2,
};

const policeSkillParameters = {
  kickRange: 160,
  kickDistance: 140,
  kickCooldown: 0.5,
  kickDuration: 0.35,
};

const policeDefinition = (
  star: 1 | 2 | 3 | 4 | 5,
  data: Pick<CharacterDefinition, "maxHp" | "speed" | "radius" | "attack">,
): CharacterDefinition => {
  const names = ["", "巡逻警员", "手枪警员", "步枪警员", "火箭警员", "重装无畏战士"];
  const subtitles = [
    "",
    "人类警员 · 警棍近身压制",
    "人类警员 · 手枪全图弹道",
    "人类警员 · 步枪三连发",
    "人类警员 · RPG范围爆破",
    "人类重装警察 · 定向周期连发与踹击",
  ];
  const attackSounds: SynthPreset[] = ["baton", "baton", "pistol", "rifle", "rocket", "gatling"];

  return {
    schemaVersion: SCHEMA_VERSION,
    id: `police-${star}`,
    name: `${star}星${names[star]}`,
    subtitle: subtitles[star],
    role: "contestant",
    pluginId: "police",
    policeStar: star,
    ...data,
    skillParameters: { police: structuredClone(policeSkillParameters) },
    accent: ["", "#83c96f", "#5eb8ff", "#a58aff", "#ff9f58", "#ffd55e"][star],
    portraitAssetId: `police-${star}-idle`,
    animations: {
      ...baseAnimations(`police-${star}`),
      ...(star === 5
        ? {
            skill: clip("skill", [
              "police-5-skill-1",
              "police-5-skill-2",
              "police-5-skill-3",
            ]),
          }
        : {}),
    },
    sounds: {
      attack: synth(`police-${star}-attack`, attackSounds[star], 0.7),
      hit: synth(`police-${star}-hit`, star === 4 ? "explosion" : "hurt", 0.65),
      hurt: synth(`police-${star}-hurt`, "hurt", 0.45),
      skill: synth(`police-${star}-skill`, star === 5 ? "kick" : attackSounds[star], 0.75),
      death: synth(`police-${star}-death`, "death", 0.55),
    },
    abilities: [],
  };
};

export const defaultCharacters: CharacterDefinition[] = [
  {
    schemaVersion: SCHEMA_VERSION,
    id: "panda-lazy",
    name: "熊猫",
    subtitle: "懒洋洋但清醒 · 躺着吃竹子 · 受击呼叫人类警察",
    role: "contestant",
    pluginId: "panda",
    maxHp: 350,
    speed: 100,
    radius: 42,
    accent: "#f4d35e",
    portraitAssetId: "panda-lazy-idle",
    attack: {
      range: 150,
      damage: 30,
      cooldown: 1.25,
      windup: 0.32,
      mode: "melee",
    },
    skillParameters: { panda: structuredClone(pandaSkillParameters) },
    animations: {
      ...baseAnimations("panda-lazy"),
      skill: clip(
        "skill",
        [
          "panda-lazy-skill-1",
          "panda-lazy-skill-2",
          "panda-lazy-skill-3",
        ],
        true,
        180,
      ),
      eat: clip(
        "eat",
        ["panda-lazy-skill-2", "panda-lazy-skill-3"],
        true,
        220,
      ),
      eatComplete: clip("eatComplete", ["panda-lazy-skill-4"], false, 650),
    },
    sounds: {
      attack: speech("panda-lazy-attack", ["别催，我打了。", "躺着也能拍到你。"]),
      hit: synth("panda-lazy-hit", "pandaGrunt", 0.55),
      hurt: speech("panda-lazy-hurt", ["保护动物也敢打？", "警察叔叔，有人动手。"]),
      skill: speech("panda-lazy-chew", ["竹子拿近点，我不想起来。", "躺着吃，味道也一样。"]),
      death: speech("panda-lazy-death", ["先躺一会儿，别叫我。"], 0.72),
    },
    abilities: [],
  },
  {
    schemaVersion: SCHEMA_VERSION,
    id: "mole",
    name: "地鼠",
    subtitle: "挖洞偷袭 · 随机地道",
    role: "contestant",
    pluginId: "mole",
    maxHp: 180,
    speed: 135,
    radius: 26,
    accent: "#ed8f63",
    portraitAssetId: "mole-idle",
    attack: {
      range: 150,
      damage: 15,
      cooldown: 1,
      windup: 0.25,
      mode: "melee",
    },
    skillParameters: { mole: structuredClone(moleSkillParameters) },
    animations: {
      ...baseAnimations("mole"),
      skill: clip(
        "skill",
        ["mole-skill-1", "mole-skill-2", "mole-skill-3", "mole-skill-4"],
        false,
        150,
      ),
      tunnelAttack: clip(
        "tunnelAttack",
        ["mole-tunnel-1", "mole-tunnel-2", "mole-tunnel-3", "mole-tunnel-4"],
        false,
        180,
      ),
    },
    sounds: {
      attack: synth("mole-attack", "moleSqueak", 0.65),
      hit: synth("mole-hit", "swipe", 0.55),
      hurt: speech("mole-hurt", ["谁踩我洞口？", "我的洞还有耐久呢。"], 0.72),
      skill: speech("mole-dig", ["借个洞，我马上回来。", "地下通道，人人能用。"], 0.72),
      death: synth("mole-death", "death", 0.65),
    },
    abilities: [],
  },
  policeDefinition(1, {
    maxHp: 30,
    speed: 120,
    radius: 24,
    attack: { range: 210, damage: 20, cooldown: 1.2, windup: 0.28, mode: "melee" },
  }),
  policeDefinition(2, {
    maxHp: 30,
    speed: 105,
    radius: 24,
    attack: {
      range: 9999,
      damage: 30,
      cooldown: 1.8,
      windup: 0.24,
      mode: "projectile",
      projectileKind: "bullet",
      projectileSpeed: 650,
    },
  }),
  policeDefinition(3, {
    maxHp: 30,
    speed: 100,
    radius: 24,
    attack: {
      range: 9999,
      damage: 30,
      cooldown: 2.8,
      windup: 0.2,
      mode: "burst",
      projectileKind: "bullet",
      projectileSpeed: 650,
      burstCount: 3,
      burstGap: 0.3,
    },
  }),
  policeDefinition(4, {
    maxHp: 30,
    speed: 85,
    radius: 27,
    attack: {
      range: 9999,
      damage: 100,
      cooldown: 4,
      windup: 0.52,
      mode: "projectile",
      projectileKind: "rocket",
      projectileSpeed: 300,
      splashDamage: 50,
      splashRadius: 150,
    },
  }),
  policeDefinition(5, {
    maxHp: 200,
    speed: 60,
    radius: 40,
    attack: {
      range: 9999,
      damage: 5,
      cooldown: 10,
      windup: 0,
      mode: "gatling",
      projectileKind: "bullet",
      projectileSpeed: 800,
      burstCount: 15,
      burstGap: 0.33,
    },
  }),
];

export const defaultNameLibraries: ProjectManifest["nameLibraries"] = [
  {
    definitionId: "panda-lazy",
    names: [
      "功夫阿宝（今日休假）",
      "五条滚滚",
      "竹林躺平王",
      "成都显眼包",
      "不想翻身的团子",
      "吃完再营业",
      "熊猫村村长",
      "懒得出招",
    ],
  },
  {
    definitionId: "mole",
    names: [
      "鼠鼠我呀",
      "土行孙隔壁老王",
      "提莫的地下邻居",
      "挖穿秋叶原",
      "洞洞幺",
      "地底包工头",
      "别踩我井盖",
      "钻出来吓你一跳",
    ],
  },
  {
    definitionId: "police-1",
    names: ["片警老王", "警棍小李", "正义路人甲", "派出所新星", "下班前一棍"],
  },
  {
    definitionId: "police-2",
    names: ["神枪阿强", "西部片临时工", "弹无虚发老张", "柯南片场保安", "一枪一个问号"],
  },
  {
    definitionId: "police-3",
    names: ["三连发老六", "突突突队长", "使命召唤邻居", "步枪班显眼包", "压枪全靠缘分"],
  },
  {
    definitionId: "police-4",
    names: ["火箭筒刘能", "RPG快递员", "爆破鬼才老赵", "峡谷拆迁办", "一炮泯恩仇"],
  },
  {
    definitionId: "police-5",
    names: ["加特林菩萨", "五星麦克阿瑟", "火力不足恐惧症", "重装门神", "一轮十五响"],
  },
];

const bambooPositions = [
  [250, 170],
  [800, 125],
  [1350, 180],
  [270, 735],
  [800, 785],
  [1330, 720],
];

export const defaultBoard: BoardDefinition = {
  schemaVersion: SCHEMA_VERSION,
  id: "bamboo-lava-arena",
  name: "竹林熔岩竞技场",
  description: "六处竹子补给、三片持续燃烧岩浆与一处温泉，四角保留安全出生空间。",
  width: BOARD_WIDTH,
  height: BOARD_HEIGHT,
  unitScale: 1.72,
  backgroundAssetId: "board-bamboo-lava",
  props: [
    ...bambooPositions.map(([x, y], index) => ({
      id: `bamboo-${index + 1}`,
      type: "bamboo" as const,
      active: true,
      shape: { kind: "circle" as const, x, y, radius: 90 },
      label: `竹子 ${index + 1}`,
    })),
    {
      id: "lava-center",
      type: "lava",
      active: true,
      shape: {
        kind: "polygon",
        points: [
          { x: 690, y: 350 },
          { x: 900, y: 330 },
          { x: 990, y: 455 },
          { x: 870, y: 585 },
          { x: 650, y: 545 },
          { x: 610, y: 425 },
        ],
      },
      label: "中央岩浆",
      buffDuration: 3,
      effectPerSecond: 5,
    },
    {
      id: "lava-left",
      type: "lava",
      active: true,
      shape: { kind: "circle", x: 430, y: 450, radius: 95 },
      label: "左侧岩浆",
      buffDuration: 3,
      effectPerSecond: 5,
    },
    {
      id: "lava-right",
      type: "lava",
      active: true,
      shape: { kind: "rectangle", x: 1130, y: 380, width: 150, height: 150 },
      label: "右侧岩浆",
      buffDuration: 3,
      effectPerSecond: 5,
    },
    {
      id: "spring-north",
      type: "hotSpring",
      active: true,
      shape: { kind: "circle", x: 1080, y: 160, radius: 76 },
      label: "北侧温泉",
      buffDuration: 3,
      effectPerSecond: 5,
    },
  ],
};

export const streamLandscapeBoard: BoardDefinition = {
  schemaVersion: SCHEMA_VERSION,
  id: "stream-landscape",
  name: "横屏直播竞技场",
  description: "为 OBS、直播伴侣和横屏视频设计的 16:9 纯净观战棋盘。",
  width: 1600,
  height: 900,
  unitScale: 1.82,
  backgroundAssetId: "board-stream-landscape",
  props: [
    ...[
      [250, 160],
      [1350, 160],
      [250, 740],
      [1350, 740],
    ].map(([x, y], index) => ({
      id: `stream-bamboo-${index + 1}`,
      type: "bamboo" as const,
      active: true,
      shape: { kind: "circle" as const, x, y, radius: 92 },
      label: `直播竹子 ${index + 1}`,
    })),
    {
      id: "stream-lava-left",
      type: "lava",
      active: true,
      shape: { kind: "circle", x: 510, y: 455, radius: 105 },
      label: "左侧燃烧区",
      buffDuration: 3,
      effectPerSecond: 5,
    },
    {
      id: "stream-lava-right",
      type: "lava",
      active: true,
      shape: {
        kind: "polygon",
        points: [
          { x: 1040, y: 340 },
          { x: 1225, y: 375 },
          { x: 1260, y: 520 },
          { x: 1090, y: 565 },
          { x: 990, y: 455 },
        ],
      },
      label: "右侧燃烧区",
      buffDuration: 3,
      effectPerSecond: 5,
    },
    {
      id: "stream-spring",
      type: "hotSpring",
      active: true,
      shape: { kind: "circle", x: 800, y: 180, radius: 85 },
      label: "直播温泉",
      buffDuration: 3,
      effectPerSecond: 5,
    },
  ],
};

export const streamPortraitBoard: BoardDefinition = {
  schemaVersion: SCHEMA_VERSION,
  id: "stream-portrait",
  name: "手机竖屏直播竞技场",
  description: "为抖音等 9:16 手机竖屏直播设计，中央保留清晰战斗通道。",
  width: 900,
  height: 1600,
  unitScale: 1.78,
  backgroundAssetId: "board-stream-portrait",
  props: [
    ...[
      [155, 205],
      [745, 205],
      [145, 800],
      [755, 800],
      [155, 1390],
      [745, 1390],
    ].map(([x, y], index) => ({
      id: `portrait-bamboo-${index + 1}`,
      type: "bamboo" as const,
      active: true,
      shape: { kind: "circle" as const, x, y, radius: 78 },
      label: `竖屏竹子 ${index + 1}`,
    })),
    {
      id: "portrait-lava-upper",
      type: "lava",
      active: true,
      shape: { kind: "rectangle", x: 290, y: 430, width: 320, height: 120 },
      label: "上段燃烧区",
      buffDuration: 3,
      effectPerSecond: 5,
    },
    {
      id: "portrait-lava-lower",
      type: "lava",
      active: true,
      shape: { kind: "circle", x: 450, y: 1110, radius: 115 },
      label: "下段燃烧区",
      buffDuration: 3,
      effectPerSecond: 5,
    },
    {
      id: "portrait-spring",
      type: "hotSpring",
      active: true,
      shape: { kind: "circle", x: 450, y: 760, radius: 90 },
      label: "竖屏温泉",
      buffDuration: 3,
      effectPerSecond: 5,
    },
  ],
};

export const defaultSetup: MatchSetup = {
  schemaVersion: SCHEMA_VERSION,
  boardId: streamLandscapeBoard.id,
  seed: 20260726,
  contestants: [
    {
      id: "fighter-panda-a",
      definitionId: "panda-lazy",
      displayName: "熊猫·团团",
      position: { x: 170, y: 160 },
      direction: { x: 0.88, y: 0.47 },
      color: "#f6d85f",
    },
    {
      id: "fighter-mole-a",
      definitionId: "mole",
      displayName: "地鼠·钻钻",
      position: { x: 1430, y: 160 },
      direction: { x: -0.82, y: 0.57 },
      color: "#ff8b62",
    },
    {
      id: "fighter-panda-b",
      definitionId: "panda-lazy",
      displayName: "熊猫·滚滚",
      position: { x: 180, y: 740 },
      direction: { x: 0.75, y: -0.66 },
      color: "#72d4af",
    },
    {
      id: "fighter-mole-b",
      definitionId: "mole",
      displayName: "地鼠·挖挖",
      position: { x: 1420, y: 740 },
      direction: { x: -0.71, y: -0.7 },
      color: "#8fb8ff",
    },
  ],
};

export const createDefaultManifest = (): ProjectManifest => ({
  schemaVersion: SCHEMA_VERSION,
  name: "电子斗蛐蛐",
  assets: structuredClone(defaultAssets),
  characters: structuredClone(defaultCharacters),
  nameLibraries: structuredClone(defaultNameLibraries),
  boards: [
    structuredClone(defaultBoard),
    structuredClone(streamLandscapeBoard),
    structuredClone(streamPortraitBoard),
  ],
  setup: structuredClone(defaultSetup),
  backgroundMusic: {
    enabled: true,
    source: "synth",
    title: "竹林乱斗曲（原创默认）",
    volume: 0.28,
  },
  updatedAt: new Date().toISOString(),
});

export const upgradeManifest = (manifest: ProjectManifest): ProjectManifest => {
  const upgraded = structuredClone(manifest);
  const defaults = createDefaultManifest();

  upgraded.nameLibraries ??= [];
  upgraded.backgroundMusic ??= structuredClone(defaults.backgroundMusic);
  const teamColors: Record<string, string> = {
    red: "#ff5968",
    blue: "#55a7ff",
    green: "#55d68a",
    purple: "#b58aff",
    gold: "#f6d85f",
  };
  for (const contestant of upgraded.setup.contestants) {
    if (contestant.definitionId === "panda") contestant.definitionId = "panda-lazy";
    const needsHudMigration = !contestant.nameColor && !contestant.namePlacement;
    if (needsHudMigration && contestant.teamId && teamColors[contestant.teamId]) {
      contestant.color = teamColors[contestant.teamId];
    }
    contestant.nameColor ??= contestant.color;
    contestant.namePlacement ??= "above";
  }
  upgraded.characters = upgraded.characters.filter((character) => character.id !== "panda");
  upgraded.nameLibraries = upgraded.nameLibraries.filter(
    (library) => library.definitionId !== "panda",
  );

  for (const assetDefinition of defaults.assets) {
    if (!upgraded.assets.some((assetItem) => assetItem.id === assetDefinition.id)) {
      upgraded.assets.push(structuredClone(assetDefinition));
    }
  }
  for (const defaultCharacter of defaults.characters) {
    const character = upgraded.characters.find((item) => item.id === defaultCharacter.id);
    if (!character) {
      upgraded.characters.push(structuredClone(defaultCharacter));
      continue;
    }
    if (defaultCharacter.policeStar && character.role === "summon") {
      character.role = "contestant";
    }
    if (defaultCharacter.id === "panda-lazy") {
      character.name = defaultCharacter.name;
      character.subtitle = defaultCharacter.subtitle;
    }
    if (
      defaultCharacter.id === "police-5" &&
      (character.name === "5星加特林警长" ||
        character.subtitle === "人类警长 · 加特林与踹击")
    ) {
      character.name = defaultCharacter.name;
      character.subtitle = defaultCharacter.subtitle;
    }
    character.skillParameters ??= structuredClone(defaultCharacter.skillParameters);
    if (defaultCharacter.id === "mole" && character.radius === 32) {
      character.radius = defaultCharacter.radius;
    }
    if (defaultCharacter.id === "police-5") {
      const legacyPolice = character.skillParameters?.police;
      const legacyShots = Math.max(
        1,
        Math.round(legacyPolice?.gatlingShots ?? defaultCharacter.attack.burstCount ?? 15),
      );
      const legacyFireDuration = legacyPolice?.gatlingFireDuration ?? 5;
      character.attack.burstCount ??= legacyShots;
      character.attack.burstGap ??= Number(
        (legacyFireDuration / legacyShots).toFixed(2),
      );
      if (Math.abs(character.attack.burstGap - 1 / 3) < 0.0001) {
        character.attack.burstGap = 0.33;
      }
      if (legacyPolice) {
        delete legacyPolice.gatlingFireDuration;
        delete legacyPolice.gatlingRestDuration;
        delete legacyPolice.gatlingShots;
      }
    }
    for (const [clipId, animation] of Object.entries(defaultCharacter.animations)) {
      character.animations[clipId] ??= structuredClone(animation);
    }
  }
  for (const library of defaults.nameLibraries) {
    const existingLibrary = upgraded.nameLibraries.find(
      (item) => item.definitionId === library.definitionId,
    );
    if (!existingLibrary) {
      upgraded.nameLibraries.push(structuredClone(library));
    } else if (
      library.definitionId === "police-5" &&
      existingLibrary.names.includes("突突五秒钟")
    ) {
      existingLibrary.names = structuredClone(library.names);
    }
  }
  for (const character of upgraded.characters) {
    if (!upgraded.nameLibraries.some((item) => item.definitionId === character.id)) {
      upgraded.nameLibraries.push({
        definitionId: character.id,
        names: [`${character.name}一号`, `${character.name}二号`, `${character.name}三号`],
      });
    }
  }
  for (const defaultBoardDefinition of defaults.boards) {
    const board = upgraded.boards.find((item) => item.id === defaultBoardDefinition.id);
    if (!board) {
      upgraded.boards.push(structuredClone(defaultBoardDefinition));
      continue;
    }
    board.unitScale ??= defaultBoardDefinition.unitScale ?? 1;
    for (const defaultProp of defaultBoardDefinition.props) {
      if (!board.props.some((prop) => prop.id === defaultProp.id)) {
        board.props.push(structuredClone(defaultProp));
      }
    }
  }
  for (const board of upgraded.boards) {
    if (board.id === defaultBoard.id && (board.unitScale ?? 0) <= 1.35) {
      board.unitScale = defaultBoard.unitScale;
    }
    if (board.id === streamLandscapeBoard.id && (board.unitScale ?? 0) <= 1.45) {
      board.unitScale = streamLandscapeBoard.unitScale;
    }
    if (board.id === streamPortraitBoard.id && (board.unitScale ?? 0) <= 1.42) {
      board.unitScale = streamPortraitBoard.unitScale;
    }
    board.unitScale ??= 1.35;
    for (const prop of board.props) {
      if (prop.type !== "lava" && prop.type !== "hotSpring") continue;
      prop.buffDuration ??= 3;
      prop.effectPerSecond ??= 5;
    }
  }
  upgraded.updatedAt = new Date().toISOString();
  return upgraded;
};
