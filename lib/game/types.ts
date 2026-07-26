export const BOARD_WIDTH = 1600;
export const BOARD_HEIGHT = 900;
export const SCHEMA_VERSION = 1 as const;

export type Vec2 = { x: number; y: number };

export type CircleRegion = {
  kind: "circle";
  x: number;
  y: number;
  radius: number;
};

export type RectangleRegion = {
  kind: "rectangle";
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PolygonRegion = {
  kind: "polygon";
  points: Vec2[];
};

export type RegionShape = CircleRegion | RectangleRegion | PolygonRegion;

export type AssetRef = {
  id: string;
  kind: "image" | "audio";
  url: string;
  name?: string;
  mime?: string;
};

export type AnimationFrame = {
  assetId: string;
  durationMs: number;
  marker?: "attack" | "skill" | "sound";
};

export type AnimationClip = {
  id: string;
  loop: boolean;
  frames: AnimationFrame[];
};

export type SoundCue = {
  id: string;
  source: "synth" | "asset" | "speech";
  preset?: SynthPreset;
  assetId?: string;
  phrases?: string[];
  speechRate?: number;
  speechPitch?: number;
  volume: number;
  pitchVariance?: number;
  maxVoices?: number;
};

export type BackgroundMusicConfig = {
  enabled: boolean;
  source: "synth" | "asset";
  assetId?: string;
  title: string;
  volume: number;
};

export type SynthPreset =
  | "swipe"
  | "baton"
  | "pistol"
  | "rifle"
  | "rocket"
  | "explosion"
  | "gatling"
  | "kick"
  | "chew"
  | "dig"
  | "tunnel"
  | "hurt"
  | "heal"
  | "merge"
  | "death"
  | "lava"
  | "spring"
  | "pandaGrunt"
  | "moleSqueak";

export type AttackDefinition = {
  range: number;
  damage: number;
  cooldown: number;
  windup: number;
  mode: "melee" | "projectile" | "burst" | "gatling";
  projectileSpeed?: number;
  projectileKind?: "bullet" | "rocket";
  /** 每颗弹丸围绕锁定方向产生的最大随机偏角。 */
  spreadDegrees?: number;
  burstCount?: number;
  burstGap?: number;
  splashDamage?: number;
  splashRadius?: number;
};

export type AbilityTrigger =
  | "interval"
  | "onDamageTaken"
  | "onAttack"
  | "onDeath";

export type AbilityAction =
  | { kind: "heal"; amount: number }
  | { kind: "damageNearby"; amount: number; radius: number }
  | { kind: "spawnUnit"; definitionId: string; count: number }
  | { kind: "knockbackNearby"; distance: number; radius: number }
  | { kind: "playSound"; cue: SynthPreset };

export type AbilityModule = {
  id: string;
  name: string;
  trigger: AbilityTrigger;
  cooldown: number;
  interval?: number;
  hpBelowRatio?: number;
  actions: AbilityAction[];
};

export type PandaSkillParameters = {
  eatDuration: number;
  eatHeal: number;
  eatCooldown: number;
  bambooExtraRange: number;
  policeSummonCooldown: number;
  policeCallDuration: number;
  policeMergePadding: number;
};

export type MoleSkillParameters = {
  digCooldown: number;
  digDuration: number;
  minimumHoleDistance: number;
  holeRadius: number;
  stompsToFlatten: number;
  ambushRange: number;
  ambushCooldown: number;
  tunnelSpeedMultiplier: number;
  tunnelDuration: number;
  tunnelChance: number;
};

export type PoliceSkillParameters = {
  killsPerPromotion: number;
  kickRange: number;
  kickDistance: number;
  kickDamage: number;
  kickCooldown: number;
  kickDuration: number;
  kickWallStunDuration: number;
  /** 旧版五星警察参数，仅用于导入迁移。 */
  gatlingFireDuration?: number;
  /** 旧版五星警察参数，仅用于导入迁移。 */
  gatlingRestDuration?: number;
  /** 旧版五星警察参数，仅用于导入迁移。 */
  gatlingShots?: number;
};

export type CharacterDefinition = {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  subtitle: string;
  role: "contestant" | "summon";
  pluginId?: "panda" | "mole" | "police";
  policeStar?: 1 | 2 | 3 | 4 | 5;
  maxHp: number;
  speed: number;
  radius: number;
  accent: string;
  portraitAssetId: string;
  victoryStyle?: "dance" | "cool" | "taunt" | "spotlight";
  attack: AttackDefinition;
  skillParameters?: {
    panda?: PandaSkillParameters;
    mole?: MoleSkillParameters;
    police?: PoliceSkillParameters;
  };
  animations: Record<string, AnimationClip>;
  sounds: Partial<Record<"attack" | "hit" | "hurt" | "skill" | "death", SoundCue>>;
  abilities: AbilityModule[];
};

export type BoardProp = {
  id: string;
  type: "bamboo" | "lava" | "hotSpring";
  shape: RegionShape;
  active: boolean;
  label?: string;
  buffDuration?: number;
  effectPerSecond?: number;
};

export type BoardDefinition = {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  unitScale?: number;
  backgroundAssetId: string;
  props: BoardProp[];
};

export type MatchContestant = {
  id: string;
  definitionId: string;
  displayName: string;
  position: Vec2;
  direction: Vec2;
  color: string;
  nameColor?: string;
  teamId?: string;
};

export type MatchSetup = {
  schemaVersion: typeof SCHEMA_VERSION;
  boardId: string;
  seed: number;
  contestants: MatchContestant[];
};

export type CharacterNameLibrary = {
  definitionId: string;
  names: string[];
};

export type ProjectManifest = {
  schemaVersion: typeof SCHEMA_VERSION;
  name: string;
  assets: AssetRef[];
  characters: CharacterDefinition[];
  nameLibraries: CharacterNameLibrary[];
  boards: BoardDefinition[];
  setup: MatchSetup;
  backgroundMusic: BackgroundMusicConfig;
  updatedAt: string;
};

export type UnitAction =
  | "move"
  | "attack"
  | "skill"
  | "hurt"
  | "eating"
  | "satisfied"
  | "digging"
  | "tunneling"
  | "kick"
  | "knockback"
  | "stunned"
  | "merge"
  | "kill"
  | "victory"
  | "dead";

export type RuntimeUnit = {
  id: string;
  definitionId: string;
  /** 当前外观使用的角色定义；升星等形态变化会同步更新。 */
  appearanceDefinitionId: string;
  name: string;
  ownerId: string;
  factionId: string;
  main: boolean;
  policeStar?: 1 | 2 | 3 | 4 | 5;
  policeKillProgress: number;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  bornAt: number;
  nextAttackAt: number;
  targetable: boolean;
  action: UnitAction;
  actionStartedAt: number;
  actionUntil: number;
  promotionStartedAt: number;
  promotionUntil: number;
  nextPandaSummonAt: number;
  pandaCallStartedAt: number;
  pandaCallUntil: number;
  /** 该附属单位存活时仍代表所属阵营参与胜负判定。 */
  sustainsFaction: boolean;
  nextEatAt: number;
  reservedBambooId?: string;
  nextDigAt: number;
  nextAmbushAt: number;
  burnUntil: number;
  burnDamagePerSecond: number;
  springUntil: number;
  springHealPerSecond: number;
  nextBurnFeedbackAt: number;
  nextSpringFeedbackAt: number;
  stunnedUntil: number;
  knockbackData?: {
    origin: Vec2;
    destination: Vec2;
    startedAt: number;
    arrivalAt: number;
    hitBoundary: boolean;
    wallStunDuration: number;
  };
  lastHoleId?: string;
  tunnelData?: {
    mode: "ambush" | "travel";
    origin: Vec2;
    destination: Vec2;
    travelStartedAt: number;
    arrivalAt: number;
    attackAt?: number;
    destinationHoleId?: string;
    targetId?: string;
    hitSucceeded?: boolean;
    returnStartedAt?: number;
    returnArrivalAt?: number;
    returnDestination?: Vec2;
    returnHoleId?: string;
  };
  digPosition?: Vec2;
  gatling?: {
    nextRoundIn: number;
    shotsRemaining: number;
    nextShotIn: number;
    nextKickAt: number;
    roundDirection?: Vec2;
    roundTargetId?: string;
  };
  moduleCooldowns: Record<string, number>;
};

export type RuntimeHole = {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  radius: number;
  stompsRequired: number;
  stompsRemaining: number;
  bornAt: number;
};

export type RuntimeProjectile = {
  id: string;
  ownerId: string;
  factionId: string;
  sourceUnitId: string;
  kind: "bullet" | "rocket";
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  damage: number;
  splashDamage?: number;
  splashRadius?: number;
};

export type CombatEvent = {
  id: string;
  time: number;
  type:
    | "attack"
    | "damage"
    | "heal"
    | "spawn"
    | "merge"
    | "skill"
    | "death"
    | "prop"
    | "victory"
    | "sound";
  message: string;
  x?: number;
  y?: number;
  unitId?: string;
  targetId?: string;
  unitName?: string;
  targetName?: string;
  unitDefinitionId?: string;
  targetDefinitionId?: string;
  sound?: SynthPreset;
  amount?: number;
  announcement?: string;
};

export type BattleStatus = "ready" | "running" | "paused" | "finished";

export type BattleSnapshot = {
  time: number;
  status: BattleStatus;
  winnerId?: string;
  winnerName?: string;
  draw: boolean;
  units: RuntimeUnit[];
  holes: RuntimeHole[];
  projectiles: RuntimeProjectile[];
  props: BoardProp[];
  events: CombatEvent[];
};

export type AbilityPluginContext = {
  now: number;
  dt: number;
  unit: RuntimeUnit;
};

export interface AbilityPlugin {
  id: string;
  onSpawn?: (context: AbilityPluginContext) => void;
  onTick?: (context: AbilityPluginContext) => void;
  onDamageTaken?: (
    context: AbilityPluginContext,
    sourceUnitId: string | undefined,
    amount: number,
  ) => void;
  onDispose?: (context: AbilityPluginContext) => void;
}
