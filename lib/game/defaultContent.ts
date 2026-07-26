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
  mime: "image/png",
});

export const defaultAssets: AssetRef[] = [
  asset("board-bamboo-lava", "/assets/board-bamboo-lava.webp", "竹林熔岩竞技场"),
  asset("panda-idle", "/assets/panda-idle.png", "熊猫待机"),
  asset("panda-attack-1", "/assets/panda-attack-1.png", "熊猫攻击蓄力"),
  asset("panda-attack-2", "/assets/panda-attack-2.png", "熊猫攻击命中"),
  asset("panda-attack-3", "/assets/panda-attack-3.png", "熊猫攻击收势"),
  asset("panda-skill-1", "/assets/panda-skill-1.png", "熊猫拿竹子"),
  asset("panda-skill-2", "/assets/panda-skill-2.png", "熊猫咀嚼一"),
  asset("panda-skill-3", "/assets/panda-skill-3.png", "熊猫咀嚼二"),
  asset("panda-skill-4", "/assets/panda-skill-4.png", "熊猫满足"),
  asset("mole-idle", "/assets/mole-idle.png", "地鼠待机"),
  asset("mole-attack-1", "/assets/mole-attack-1.png", "地鼠攻击蓄力"),
  asset("mole-attack-2", "/assets/mole-attack-2.png", "地鼠攻击命中"),
  asset("mole-attack-3", "/assets/mole-attack-3.png", "地鼠攻击收势"),
  asset("mole-skill-1", "/assets/mole-skill-1.png", "地鼠挖洞一"),
  asset("mole-skill-2", "/assets/mole-skill-2.png", "地鼠挖洞二"),
  asset("mole-skill-3", "/assets/mole-skill-3.png", "地鼠钻地"),
  asset("mole-skill-4", "/assets/mole-skill-4.png", "地鼠偷袭"),
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

const policeDefinition = (
  star: 1 | 2 | 3 | 4 | 5,
  data: Pick<CharacterDefinition, "maxHp" | "speed" | "radius" | "attack">,
): CharacterDefinition => {
  const names = ["", "巡逻警员", "手枪警员", "步枪警员", "火箭警员", "加特林警长"];
  const subtitles = [
    "",
    "人类警员 · 警棍近身压制",
    "人类警员 · 手枪全图弹道",
    "人类警员 · 步枪三连发",
    "人类警员 · RPG范围爆破",
    "人类警长 · 加特林与踹击",
  ];
  const attackSounds: SynthPreset[] = ["baton", "baton", "pistol", "rifle", "rocket", "gatling"];

  return {
    schemaVersion: SCHEMA_VERSION,
    id: `police-${star}`,
    name: `${star}星${names[star]}`,
    subtitle: subtitles[star],
    role: "summon",
    pluginId: "police",
    policeStar: star,
    ...data,
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
    id: "panda",
    name: "熊猫",
    subtitle: "国家保护动物 · 受击呼叫人类警察",
    role: "contestant",
    pluginId: "panda",
    maxHp: 350,
    speed: 115,
    radius: 38,
    accent: "#f4d35e",
    portraitAssetId: "panda-idle",
    attack: {
      range: 150,
      damage: 30,
      cooldown: 1.25,
      windup: 0.32,
      mode: "melee",
    },
    animations: {
      ...baseAnimations("panda"),
      skill: clip(
        "skill",
        ["panda-skill-1", "panda-skill-2", "panda-skill-3", "panda-skill-4"],
        true,
        180,
      ),
    },
    sounds: {
      attack: synth("panda-attack", "swipe"),
      hit: synth("panda-hit", "hurt", 0.6),
      hurt: synth("panda-hurt", "hurt", 0.5),
      skill: synth("panda-chew", "chew", 0.65),
      death: synth("panda-death", "death", 0.7),
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
    radius: 32,
    accent: "#ed8f63",
    portraitAssetId: "mole-idle",
    attack: {
      range: 150,
      damage: 15,
      cooldown: 1,
      windup: 0.25,
      mode: "melee",
    },
    animations: {
      ...baseAnimations("mole"),
      skill: clip(
        "skill",
        ["mole-skill-1", "mole-skill-2", "mole-skill-3", "mole-skill-4"],
        false,
        150,
      ),
    },
    sounds: {
      attack: synth("mole-attack", "swipe", 0.65),
      hit: synth("mole-hit", "hurt", 0.55),
      hurt: synth("mole-hurt", "hurt", 0.5),
      skill: synth("mole-dig", "dig", 0.7),
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
    },
  }),
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
  description: "六处竹子补给与三片岩浆险区，四角保留安全出生空间。",
  width: BOARD_WIDTH,
  height: BOARD_HEIGHT,
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
    },
    {
      id: "lava-left",
      type: "lava",
      active: true,
      shape: { kind: "circle", x: 430, y: 450, radius: 95 },
      label: "左侧岩浆",
    },
    {
      id: "lava-right",
      type: "lava",
      active: true,
      shape: { kind: "rectangle", x: 1130, y: 380, width: 150, height: 150 },
      label: "右侧岩浆",
    },
  ],
};

export const defaultSetup: MatchSetup = {
  schemaVersion: SCHEMA_VERSION,
  boardId: defaultBoard.id,
  seed: 20260726,
  contestants: [
    {
      id: "fighter-panda-a",
      definitionId: "panda",
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
      definitionId: "panda",
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
  boards: [structuredClone(defaultBoard)],
  setup: structuredClone(defaultSetup),
  updatedAt: new Date().toISOString(),
});
