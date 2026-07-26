"use client";

import { useMemo, useState } from "react";
import {
  AudioLines,
  CopyPlus,
  ImagePlus,
  Plus,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { removeFlatBackground } from "@/lib/game/imageProcessing";
import { fileToDataUrl } from "@/lib/game/storage";
import {
  type AbilityAction,
  type AbilityModule,
  type AnimationClip,
  type AssetRef,
  type CharacterDefinition,
  type ProjectManifest,
  type SoundCue,
  type SynthPreset,
} from "@/lib/game/types";

type CharacterEditorProps = {
  manifest: ProjectManifest;
  selectedId: string;
  onSelect: (id: string) => void;
  onChange: (manifest: ProjectManifest) => void;
  onNotice: (message: string) => void;
};

const numeric = (value: string, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

let localIdCounter = 0;
const makeLocalId = (prefix: string) => {
  localIdCounter += 1;
  const randomPart =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `local-${localIdCounter}`;
  return `${prefix}-${randomPart}`;
};

type SoundSlot = "attack" | "hit" | "hurt" | "skill" | "death";
type SkillGroup = "panda" | "mole" | "police";

const soundSlots: Array<[SoundSlot, string]> = [
  ["attack", "攻击"],
  ["hit", "命中"],
  ["hurt", "受伤"],
  ["skill", "技能"],
  ["death", "死亡"],
];

const synthPresetOptions: Array<{ value: SynthPreset; label: string }> = [
  { value: "swipe", label: "挥击（破风声）" },
  { value: "baton", label: "警棍（钝击声）" },
  { value: "pistol", label: "手枪（单发）" },
  { value: "rifle", label: "步枪（三连发）" },
  { value: "rocket", label: "火箭发射（低沉尾焰）" },
  { value: "explosion", label: "爆炸（范围冲击）" },
  { value: "gatling", label: "加特林（高速连射）" },
  { value: "reload", label: "换弹（机械装填）" },
  { value: "kick", label: "踹击（重击）" },
  { value: "chew", label: "咀嚼（吃竹子）" },
  { value: "dig", label: "挖洞（土石声）" },
  { value: "tunnel", label: "钻洞（地下穿行）" },
  { value: "hurt", label: "受伤（短促反馈）" },
  { value: "heal", label: "治疗（柔和提示）" },
  { value: "merge", label: "升星合并（上升音）" },
  { value: "death", label: "死亡（低沉结束）" },
  { value: "lava", label: "燃烧（柔和灼烧）" },
  { value: "spring", label: "温泉回血（柔和水声）" },
  { value: "pandaGrunt", label: "熊猫叫声（低声哼哼）" },
  { value: "moleSqueak", label: "地鼠叫声（短促吱声）" },
];

const skillPhrases = (character: CharacterDefinition): string[] => {
  if (character.pluginId === "panda") {
    return ["SOS，保护动物申请场外支援。", "别催技能，饭点到了。"];
  }
  if (character.pluginId === "mole") {
    return ["地图没有路，我自己打个洞。", "你在地上秀，我从地下溜。"];
  }
  if (character.pluginId === "police") {
    if (character.policeStar === 5) {
      return ["无畏模式上线，先把音量调低。", "弹仓见底，暂停营业，马上换好。"];
    }
    return ["保护动物执法现场。", "功劳簿先记上，升星再说。"];
  }
  return ["技能开张，节目效果来了。", "这一招先记在小本本上。"];
};

const skillFields: Record<
  SkillGroup,
  Array<{ key: string; label: string; fallback: number; min?: number; max?: number; step?: number }>
> = {
  panda: [
    { key: "eatDuration", label: "进食耗时（秒）", fallback: 5, min: 0.1, step: 0.1 },
    { key: "eatHeal", label: "吃竹回血", fallback: 100, min: 0 },
    { key: "eatCooldown", label: "进食冷却（秒）", fallback: 5, min: 0, step: 0.1 },
    { key: "bambooExtraRange", label: "竹子额外触发距离", fallback: 0, min: 0 },
    { key: "policeSummonCooldown", label: "受击召警冷却（秒）", fallback: 0.5, min: 0, step: 0.05 },
    { key: "policeCallDuration", label: "呼救动作时长（秒）", fallback: 0.7, min: 0.1, step: 0.05 },
    { key: "policeMergePadding", label: "警察碰撞合并余量", fallback: 0, min: 0 },
    { key: "bambooRespawnInterval", label: "竹子刷新间隔（秒）", fallback: 15, min: 0.1, step: 0.1 },
    { key: "bambooRespawnLimit", label: "场上竹子上限", fallback: 3, min: 0, max: 99, step: 1 },
  ],
  mole: [
    { key: "digCooldown", label: "挖洞冷却（秒）", fallback: 10, min: 0, step: 0.1 },
    { key: "digDuration", label: "挖洞动作（秒）", fallback: 0.6, min: 0.1, step: 0.1 },
    { key: "minimumHoleDistance", label: "洞口最小间距", fallback: 220, min: 0 },
    { key: "holeRadius", label: "洞口范围半径", fallback: 80, min: 10 },
    { key: "ambushRange", label: "钻洞偷袭范围", fallback: 150, min: 0 },
    { key: "ambushCooldown", label: "偷袭冷却（秒）", fallback: 3, min: 0, step: 0.1 },
    { key: "tunnelSpeedMultiplier", label: "钻地速度倍率（相对移速）", fallback: 2.5, min: 0.1, max: 50, step: 0.1 },
    { key: "tunnelDuration", label: "钻洞最短动作时长（秒）", fallback: 1, min: 0.1, step: 0.1 },
    { key: "tunnelChance", label: "随机钻洞概率", fallback: 0.2, min: 0, max: 1, step: 0.05 },
  ],
  police: [
    { key: "killsToStar2", label: "1→2星经验格", fallback: 1, min: 1, max: 99 },
    { key: "killsToStar3", label: "2→3星经验格", fallback: 2, min: 1, max: 99 },
    { key: "killsToStar4", label: "3→4星经验格", fallback: 2, min: 1, max: 99 },
    { key: "killsToStar5", label: "4→5星经验格", fallback: 3, min: 1, max: 99 },
    { key: "gatlingMagazineSize", label: "五星弹仓容量（发）", fallback: 150, min: 1, max: 9999 },
    { key: "gatlingReloadDuration", label: "五星换弹时间（秒）", fallback: 3, min: 0.05, step: 0.05 },
    { key: "kickRange", label: "五星踹击范围", fallback: 160, min: 0 },
    { key: "kickDistance", label: "五星踹飞距离", fallback: 140, min: 0 },
    { key: "kickDamage", label: "五星踹击伤害", fallback: 25, min: 0 },
    { key: "kickCooldown", label: "踹击冷却（秒）", fallback: 0.5, min: 0, step: 0.05 },
    { key: "kickDuration", label: "踹击动作（秒）", fallback: 0.35, min: 0.05, step: 0.05 },
    { key: "kickWallStunDuration", label: "撞墙眩晕（秒）", fallback: 0.5, min: 0, step: 0.05 },
  ],
};

const defaultAction = (kind: AbilityAction["kind"]): AbilityAction => {
  if (kind === "heal") return { kind, amount: 20 };
  if (kind === "damageNearby") return { kind, amount: 10, radius: 180 };
  if (kind === "spawnUnit") return { kind, definitionId: "police-1", count: 1 };
  if (kind === "knockbackNearby") return { kind, distance: 120, radius: 160 };
  return { kind, cue: "swipe" };
};

export function CharacterEditor({
  manifest,
  selectedId,
  onSelect,
  onChange,
  onNotice,
}: CharacterEditorProps) {
  const [removeBackground, setRemoveBackground] = useState(true);
  const selected =
    manifest.characters.find((character) => character.id === selectedId) ??
    manifest.characters[0];
  const imageById = useMemo(
    () => new Map(manifest.assets.map((asset) => [asset.id, asset])),
    [manifest.assets],
  );

  const updateCharacter = (update: (character: CharacterDefinition) => void) => {
    const next = structuredClone(manifest);
    const character = next.characters.find((candidate) => candidate.id === selected.id);
    if (!character) return;
    update(character);
    next.updatedAt = new Date().toISOString();
    onChange(next);
  };

  const createCharacter = () => {
    const id = makeLocalId("custom");
    const clone = structuredClone(selected);
    clone.id = id;
    clone.name = `${selected.name}副本`;
    clone.subtitle = "自定义角色";
    clone.role = "contestant";
    clone.pluginId = undefined;
    clone.policeStar = undefined;
    clone.skillParameters = undefined;
    const next = structuredClone(manifest);
    next.characters.push(clone);
    next.updatedAt = new Date().toISOString();
    onChange(next);
    onSelect(id);
    onNotice("已创建可编辑角色副本");
  };

  const deleteCharacter = () => {
    if (manifest.characters.length <= 1) {
      onNotice("角色库至少需要保留一个角色");
      return;
    }
    const password = window.prompt(`删除“${selected.name}”需要输入密码`);
    if (password === null) return;
    if (password !== "123") {
      onNotice("密码错误，角色未删除");
      return;
    }
    const next = structuredClone(manifest);
    next.characters = next.characters.filter((character) => character.id !== selected.id);
    next.nameLibraries = next.nameLibraries.filter(
      (library) => library.definitionId !== selected.id,
    );
    next.setup.contestants = next.setup.contestants.filter(
      (contestant) => contestant.definitionId !== selected.id,
    );
    for (const character of next.characters) {
      character.abilities = character.abilities
        .map((ability) => ({
          ...ability,
          actions: ability.actions.filter(
            (action) =>
              action.kind !== "spawnUnit" || action.definitionId !== selected.id,
          ),
        }))
        .filter((ability) => ability.actions.length > 0);
    }
    next.updatedAt = new Date().toISOString();
    onChange(next);
    onSelect(next.characters[0].id);
    onNotice(`已删除角色“${selected.name}”及其当前参赛实例`);
  };

  const uploadAnimation = async (
    files: File[],
    clipName:
      | "idle"
      | "attack"
      | "skill"
      | "callPolice"
      | "tunnelAttack"
      | "reload",
  ) => {
    if (!files.length) return;
    const newAssets: AssetRef[] = [];
    const frames: AnimationClip["frames"] = [];
    for (const [index, file] of files.entries()) {
      if (!file.type.startsWith("image/")) continue;
      const url = removeBackground
        ? await removeFlatBackground(file)
        : await fileToDataUrl(file);
      const id = makeLocalId(`${selected.id}-${clipName}-${index}`);
      newAssets.push({
        id,
        kind: "image",
        url,
        name: file.name,
        mime: "image/png",
      });
      frames.push({
        assetId: id,
        durationMs: clipName === "idle" ? 500 : 140,
        marker:
          index === Math.floor(files.length / 2)
            ? clipName === "attack" || clipName === "tunnelAttack"
              ? "attack"
              : "skill"
            : undefined,
      });
    }
    if (!frames.length) return;
    const next = structuredClone(manifest);
    next.assets.push(...newAssets);
    const character = next.characters.find((candidate) => candidate.id === selected.id);
    if (!character) return;
    character.animations[clipName] = {
      id: clipName,
      loop: clipName === "idle",
      frames,
    };
    if (clipName === "idle") {
      character.animations.move = {
        id: "move",
        loop: true,
        frames: structuredClone(frames),
      };
      character.portraitAssetId = frames[0].assetId;
    }
    next.updatedAt = new Date().toISOString();
    onChange(next);
    onNotice(
      `已更新${
        clipName === "idle"
          ? "待机"
          : clipName === "attack"
            ? "普攻"
            : clipName === "tunnelAttack"
              ? "钻洞攻击"
              : clipName === "reload"
                ? "换弹"
              : "技能"
      }动作`,
    );
  };

  const uploadSound = async (
    file: File | undefined,
    slot: "attack" | "hit" | "hurt" | "skill" | "death",
  ) => {
    if (!file || !file.type.startsWith("audio/")) return;
    const url = await fileToDataUrl(file);
    const assetId = makeLocalId(`${selected.id}-${slot}-sound`);
    const next = structuredClone(manifest);
    next.assets.push({
      id: assetId,
      kind: "audio",
      url,
      name: file.name,
      mime: file.type,
    });
    const character = next.characters.find((candidate) => candidate.id === selected.id);
    if (!character) return;
    character.sounds[slot] = {
      id: `${selected.id}-${slot}`,
      source: "asset",
      assetId,
      volume: 0.75,
      maxVoices: 8,
    };
    next.updatedAt = new Date().toISOString();
    onChange(next);
    onNotice(`已绑定${slot}音效`);
  };

  const addAbility = (preset: "heal" | "pulse" | "summon") => {
    const abilityModule: AbilityModule =
      preset === "heal"
        ? {
            id: makeLocalId("ability"),
            name: "负伤恢复",
            trigger: "onDamageTaken",
            cooldown: 5,
            hpBelowRatio: 0.6,
            actions: [{ kind: "heal", amount: 20 }],
          }
        : preset === "pulse"
          ? {
              id: makeLocalId("ability"),
              name: "定时冲击波",
              trigger: "interval",
              cooldown: 8,
              interval: 8,
              actions: [{ kind: "damageNearby", amount: 10, radius: 180 }],
            }
          : {
              id: makeLocalId("ability"),
              name: "受击援军",
              trigger: "onDamageTaken",
              cooldown: 4,
              actions: [{ kind: "spawnUnit", definitionId: "police-1", count: 1 }],
            };
    updateCharacter((character) => character.abilities.push(abilityModule));
  };

  const updateSkillParameter = (group: SkillGroup, key: string, value: number) => {
    updateCharacter((character) => {
      character.skillParameters ??= {};
      const parameters = character.skillParameters as unknown as Record<
        string,
        Record<string, number> | undefined
      >;
      parameters[group] ??= {};
      parameters[group]![key] = value;
    });
  };

  const setSoundStyle = (slot: SoundSlot, source: "synth" | "speech") => {
    if (source === "speech" && slot !== "skill") {
      onNotice("语音播报只用于技能；其他动作请使用合成或上传音效");
      return;
    }
    updateCharacter((character) => {
      const existing = character.sounds[slot];
      character.sounds[slot] =
        source === "speech"
          ? {
              id: `${character.id}-${slot}-speech`,
              source,
              phrases: existing?.phrases?.length
                ? existing.phrases
                : skillPhrases(character),
              speechRate: existing?.speechRate ?? 1.08,
              speechPitch: existing?.speechPitch ?? (character.pluginId === "mole" ? 1.35 : 1),
              volume: existing?.volume ?? 0.78,
              maxVoices: 2,
            }
          : {
              id: `${character.id}-${slot}-synth`,
              source,
              preset: existing?.preset ?? (slot === "hurt" ? "hurt" : slot === "death" ? "death" : "swipe"),
              volume: existing?.volume ?? 0.72,
              pitchVariance: existing?.pitchVariance ?? 0.08,
              maxVoices: existing?.maxVoices ?? 8,
            };
    });
  };

  const updateSound = (slot: SoundSlot, update: (cue: SoundCue) => void) => {
    updateCharacter((character) => {
      const cue = character.sounds[slot];
      if (cue) update(cue);
    });
  };

  const updateAbility = (abilityId: string, update: (ability: AbilityModule) => void) => {
    updateCharacter((character) => {
      const ability = character.abilities.find((candidate) => candidate.id === abilityId);
      if (ability) update(ability);
    });
  };

  const selectedSkillValues =
    selected.pluginId && selected.skillParameters?.[selected.pluginId]
      ? (selected.skillParameters[selected.pluginId] as unknown as Record<string, number>)
      : undefined;

  return (
    <div className="editor-layout">
      <aside className="editor-library">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">角色库</span>
            <h2>{manifest.characters.length} 个定义</h2>
          </div>
          <button className="icon-button" type="button" onClick={createCharacter} title="复制为新角色">
            <CopyPlus size={18} />
          </button>
        </div>
        <div className="library-list">
          {manifest.characters.map((character) => {
            const portrait = imageById.get(character.portraitAssetId);
            return (
              <button
                type="button"
                key={character.id}
                className={`library-item ${character.id === selected.id ? "is-active" : ""}`}
                onClick={() => onSelect(character.id)}
              >
                <span
                  className="library-avatar"
                  style={portrait ? { backgroundImage: `url("${portrait.url}")` } : undefined}
                >
                  {!portrait &&
                    (character.id.startsWith("panda")
                      ? "🐼"
                      : character.id === "mole"
                        ? "🦫"
                        : "👮")}
                </span>
                <span>
                  <strong>{character.name}</strong>
                  <small>{character.role === "contestant" ? "主角色" : "附属单位"} · {character.maxHp} HP</small>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="editor-main">
        <div className="editor-title-row">
          <div>
            <span className="eyebrow">角色定义</span>
            <h1>{selected.name}</h1>
            <p>{selected.subtitle}</p>
          </div>
          <div className="editor-title-actions">
            <button className="secondary-button" type="button" onClick={createCharacter}>
              <Plus size={16} /> 复制并扩展
            </button>
            <button
              className="secondary-button danger"
              type="button"
              onClick={deleteCharacter}
              title="输入密码 123 后删除"
            >
              <Trash2 size={16} /> 删除角色
            </button>
          </div>
        </div>

        <div className="editor-grid">
          <div className="editor-card">
            <div className="card-title">
              <Sparkles size={17} />
              <span>身份与基础属性</span>
            </div>
            <div className="form-grid two-columns">
              <label>
                名称
                <input
                  value={selected.name}
                  onChange={(event) => updateCharacter((character) => (character.name = event.target.value))}
                />
              </label>
              <label>
                定位说明
                <input
                  value={selected.subtitle}
                  onChange={(event) => updateCharacter((character) => (character.subtitle = event.target.value))}
                />
              </label>
              <label>
                最大血量
                <input
                  type="number"
                  min={1}
                  value={selected.maxHp}
                  onChange={(event) =>
                    updateCharacter((character) => (character.maxHp = numeric(event.target.value, character.maxHp)))
                  }
                />
              </label>
              <label>
                移动速度
                <input
                  type="number"
                  min={0}
                  value={selected.speed}
                  onChange={(event) =>
                    updateCharacter((character) => (character.speed = numeric(event.target.value, character.speed)))
                  }
                />
              </label>
              <label>
                碰撞半径
                <input
                  type="number"
                  min={8}
                  value={selected.radius}
                  onChange={(event) =>
                    updateCharacter((character) => (character.radius = numeric(event.target.value, character.radius)))
                  }
                />
              </label>
              <label>
                角色色
                <input
                  type="color"
                  value={selected.accent}
                  onChange={(event) =>
                    updateCharacter((character) => (character.accent = event.target.value))
                  }
                />
              </label>
              <label>
                获胜姿势
                <select
                  value={selected.victoryStyle ?? "cool"}
                  onChange={(event) =>
                    updateCharacter(
                      (character) =>
                        (character.victoryStyle = event.target.value as
                          | "dance"
                          | "cool"
                          | "taunt"
                          | "spotlight"),
                    )
                  }
                >
                  <option value="dance">跳舞</option>
                  <option value="cool">装酷</option>
                  <option value="taunt">嘲讽</option>
                  <option value="spotlight">聚光灯</option>
                </select>
              </label>
            </div>
          </div>

          <div className="editor-card">
            <div className="card-title">
              <Sparkles size={17} />
              <span>普通攻击</span>
            </div>
            <div className="form-grid two-columns">
              <label>
                普攻伤害
                <input
                  type="number"
                  min={0}
                  value={selected.attack.damage}
                  onChange={(event) =>
                    updateCharacter(
                      (character) =>
                        (character.attack.damage = numeric(event.target.value, character.attack.damage)),
                    )
                  }
                />
              </label>
              <label>
                {selected.attack.mode === "melee" ? "近战触发距离" : "攻击距离"}
                <input
                  type="number"
                  min={1}
                  value={selected.attack.range}
                  onChange={(event) =>
                    updateCharacter(
                      (character) =>
                        (character.attack.range = numeric(event.target.value, character.attack.range)),
                    )
                  }
                />
              </label>
              {selected.attack.mode === "melee" && (
                <label>
                  正面攻击扇区（度）
                  <input
                    type="number"
                    min={10}
                    max={360}
                    step={1}
                    value={selected.attack.frontArcDegrees ?? 120}
                    onChange={(event) =>
                      updateCharacter(
                        (character) =>
                          (character.attack.frontArcDegrees = Math.max(
                            10,
                            Math.min(
                              360,
                              numeric(
                                event.target.value,
                                character.attack.frontArcDegrees ?? 120,
                              ),
                            ),
                          )),
                      )
                    }
                  />
                </label>
              )}
              <label>
                {selected.attack.mode === "gatling" ? "射击周期（秒）" : "攻击间隔（秒）"}
                <input
                  type="number"
                  min={0}
                  step={0.001}
                  value={selected.attack.cooldown}
                  onChange={(event) =>
                    updateCharacter(
                      (character) =>
                        (character.attack.cooldown = numeric(event.target.value, character.attack.cooldown)),
                    )
                  }
                />
              </label>
              <label>
                攻击类型
                <select
                  value={selected.attack.mode}
                  onChange={(event) =>
                    updateCharacter(
                      (character) =>
                        (character.attack.mode = event.target.value as CharacterDefinition["attack"]["mode"]),
                    )
                  }
                >
                  <option value="melee">近战</option>
                  <option value="projectile">弹丸</option>
                  <option value="burst">连发</option>
                  <option value="gatling">周期射击</option>
                </select>
              </label>
              <label>
                出手前摇（秒）
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={selected.attack.windup}
                  onChange={(event) =>
                    updateCharacter(
                      (character) =>
                        (character.attack.windup = numeric(
                          event.target.value,
                          character.attack.windup,
                        )),
                    )
                  }
                />
              </label>
              {selected.attack.mode !== "melee" && (
                <>
                  <label>
                    弹丸外观
                    <select
                      value={selected.attack.projectileKind ?? "bullet"}
                      onChange={(event) =>
                        updateCharacter(
                          (character) =>
                            (character.attack.projectileKind = event.target.value as
                              | "bullet"
                              | "rocket"),
                        )
                      }
                    >
                      <option value="bullet">普通子弹</option>
                      <option value="rocket">火箭弹（RPG）</option>
                    </select>
                  </label>
                  <label>
                    弹丸速度
                    <input
                      type="number"
                      min={1}
                      value={selected.attack.projectileSpeed ?? 650}
                      onChange={(event) =>
                        updateCharacter(
                          (character) =>
                            (character.attack.projectileSpeed = numeric(
                              event.target.value,
                              character.attack.projectileSpeed ?? 650,
                            )),
                        )
                      }
                    />
                  </label>
                  <label>
                    子弹散布（±角度）
                    <input
                      type="number"
                      min={0}
                      max={90}
                      step={0.1}
                      value={selected.attack.spreadDegrees ?? 0}
                      onChange={(event) =>
                        updateCharacter(
                          (character) =>
                            (character.attack.spreadDegrees = Math.max(
                              0,
                              numeric(
                                event.target.value,
                                character.attack.spreadDegrees ?? 0,
                              ),
                            )),
                        )
                      }
                    />
                  </label>
                </>
              )}
            </div>
            {selected.attack.mode === "melee" && (
              <p className="editor-card-note">
                近战只会在接近身体时触发，并在命中帧再次检查目标是否仍位于角色正面扇区。
              </p>
            )}
          </div>

          {(selected.attack.mode === "burst" || selected.attack.mode === "gatling") && (
            <div className="editor-card">
              <div className="card-title">
                <Sparkles size={17} />
                <span>
                  {selected.attack.mode === "gatling" ? "周期连发" : "单次连发"}
                </span>
              </div>
              <p className="editor-card-note">
                {selected.attack.mode === "gatling"
                  ? "每轮只锁定一次方向；本轮全部子弹沿同一方向飞行。射击周期从本轮开始计到下一轮开始。"
                  : "同一次攻击按固定间隔连续发射多颗弹丸。"}
                小于一帧的间隔会在固定帧内按顺序批处理，并受性能预算保护。
              </p>
              <div className="form-grid two-columns">
                <label>
                  {selected.attack.mode === "gatling" ? "每轮子弹数（连发数量）" : "连发数量"}
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={selected.attack.burstCount ?? (selected.attack.mode === "gatling" ? 18 : 3)}
                    onChange={(event) =>
                      updateCharacter(
                        (character) =>
                          (character.attack.burstCount = Math.max(
                            1,
                            Math.round(
                              numeric(
                                event.target.value,
                                character.attack.burstCount ??
                                  (character.attack.mode === "gatling" ? 18 : 3),
                              ),
                            ),
                          )),
                      )
                    }
                  />
                </label>
                <label>
                  连发间隔（秒）
                  <input
                    type="number"
                    min={0}
                    step={0.001}
                    value={selected.attack.burstGap ?? (selected.attack.mode === "gatling" ? 0.2 : 0.3)}
                    onChange={(event) =>
                      updateCharacter(
                        (character) =>
                          (character.attack.burstGap = numeric(
                            event.target.value,
                            character.attack.burstGap ??
                              (character.attack.mode === "gatling" ? 0.2 : 0.3),
                          )),
                      )
                    }
                  />
                </label>
              </div>
            </div>
          )}

          {(selected.attack.projectileKind === "rocket" ||
            (selected.attack.splashRadius ?? 0) > 0) && (
            <div className="editor-card">
              <div className="card-title">
                <Sparkles size={17} />
                <span>火箭与爆炸</span>
              </div>
              <p className="editor-card-note">
                火箭直击造成普攻伤害；其他敌人进入爆炸半径时承受溅射伤害。
              </p>
              <div className="form-grid two-columns">
                <label>
                  爆炸溅射伤害
                  <input
                    type="number"
                    min={0}
                    value={selected.attack.splashDamage ?? 0}
                    onChange={(event) =>
                      updateCharacter(
                        (character) =>
                          (character.attack.splashDamage = numeric(
                            event.target.value,
                            character.attack.splashDamage ?? 0,
                          )),
                      )
                    }
                  />
                </label>
                <label>
                  爆炸半径
                  <input
                    type="number"
                    min={0}
                    value={selected.attack.splashRadius ?? 0}
                    onChange={(event) =>
                      updateCharacter(
                        (character) =>
                          (character.attack.splashRadius = numeric(
                            event.target.value,
                            character.attack.splashRadius ?? 0,
                          )),
                      )
                    }
                  />
                </label>
                <label>
                  火箭加速前时长（秒）
                  <input
                    type="number"
                    min={0}
                    step={0.05}
                    value={selected.attack.projectileBoostAfter ?? 1.5}
                    onChange={(event) =>
                      updateCharacter(
                        (character) =>
                          (character.attack.projectileBoostAfter = Math.max(
                            0,
                            numeric(
                              event.target.value,
                              character.attack.projectileBoostAfter ?? 1.5,
                            ),
                          )),
                      )
                    }
                  />
                </label>
                <label>
                  加速段速度倍率
                  <input
                    type="number"
                    min={0.1}
                    step={0.05}
                    value={selected.attack.projectileBoostMultiplier ?? 1.5}
                    onChange={(event) =>
                      updateCharacter(
                        (character) =>
                          (character.attack.projectileBoostMultiplier = Math.max(
                            0.1,
                            numeric(
                              event.target.value,
                              character.attack.projectileBoostMultiplier ?? 1.5,
                            ),
                          )),
                      )
                    }
                  />
                </label>
              </div>
            </div>
          )}

          {selected.pluginId && (
            <div className="editor-card">
              <div className="card-title">
                <Sparkles size={17} />
                <span>
                  {selected.pluginId === "panda"
                    ? "熊猫内置技能参数"
                    : selected.pluginId === "mole"
                      ? "地鼠内置技能参数"
                      : "警察击杀升星与近身反制"}
                </span>
              </div>
              <p className="editor-card-note">
                内置行为也完全参数化；修改后重新部署战斗生效。
                {selected.pluginId === "mole" && " 洞口创建后会持续存在，直到地鼠所属阵营彻底退场。"}
              </p>
              <div className="form-grid two-columns">
                {skillFields[selected.pluginId].map((field) => (
                  <label key={field.key}>
                    {field.label}
                    <input
                      type="number"
                      min={field.min}
                      max={field.max}
                      step={field.step ?? 1}
                      value={selectedSkillValues?.[field.key] ?? field.fallback}
                      onChange={(event) =>
                        updateSkillParameter(
                          selected.pluginId as SkillGroup,
                          field.key,
                          numeric(event.target.value, field.fallback),
                        )
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="editor-card">
            <div className="card-title">
              <ImagePlus size={17} />
              <span>透明角色与动作帧</span>
            </div>
            <label className="inline-toggle">
              <input
                type="checkbox"
                checked={removeBackground}
                onChange={(event) => setRemoveBackground(event.target.checked)}
              />
              自动去除四角同色背景
            </label>
            <div className="upload-grid">
              {([
                ["idle", "待机 / 移动", false],
                ["attack", "普攻动作", true],
                ["skill", "技能动作", true],
                ["callPolice", "熊猫呼救动作", true],
                ["tunnelAttack", "钻洞攻击动作", true],
                ["reload", "五星换弹动作", true],
              ] as const)
                .filter(
                  ([clipName]) =>
                    (clipName !== "callPolice" || selected.pluginId === "panda") &&
                    (clipName !== "reload" || selected.policeStar === 5),
                )
                .map(([clipName, label, multiple]) => (
                <label className="upload-tile" key={clipName}>
                  <Upload size={18} />
                  <strong>{label}</strong>
                  <small>
                    {selected.animations[clipName]?.frames.length ?? 0} 帧 ·{" "}
                    {multiple ? "可多选并按顺序播放" : "主形象"}
                  </small>
                  <input
                    type="file"
                    accept="image/png,image/webp,image/jpeg"
                    multiple={multiple}
                    onChange={(event) =>
                      void uploadAnimation(Array.from(event.target.files ?? []), clipName)
                    }
                  />
                </label>
                ))}
            </div>
            <div className="animation-strip">
              {(selected.animations.attack?.frames ?? []).map((frame) => {
                const frameAsset = imageById.get(frame.assetId);
                return (
                  <div className="frame-chip" key={frame.assetId}>
                    {frameAsset ? (
                      // User-supplied data URLs are intentionally rendered directly in the frame editor.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={frameAsset.url} alt="" />
                    ) : (
                      <span>?</span>
                    )}
                    <small>{frame.durationMs}ms</small>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="editor-card">
            <div className="card-title">
              <AudioLines size={17} />
              <span>动作音效</span>
            </div>
            <p className="editor-card-note">
              只有技能会播放角色台词；普攻、命中、受伤和死亡使用合成音或上传音频，避免播报干扰战况。
            </p>
            <div className="sound-list">
              {soundSlots.map(([slot, label]) => {
                const cue = selected.sounds[slot];
                return (
                  <div className="sound-editor-row" key={slot}>
                    <div className="sound-editor-heading">
                      <span>
                        <strong>{label}</strong>
                        <small>
                          {cue?.source === "asset"
                            ? "自定义音频"
                            : cue?.source === "speech"
                              ? "搞笑台词 / 说话"
                              : "程序合成 / 动物叫声"}
                        </small>
                      </span>
                      <select
                        aria-label={`${label}声音类型`}
                        value={
                          cue?.source === "asset"
                            ? "asset"
                            : cue?.source === "speech" && slot === "skill"
                              ? "speech"
                              : "synth"
                        }
                        onChange={(event) => {
                          if (event.target.value !== "asset") {
                            setSoundStyle(slot, event.target.value as "synth" | "speech");
                          }
                        }}
                      >
                        <option value="synth">合成 / 动物叫声</option>
                        {slot === "skill" && <option value="speech">搞笑技能台词</option>}
                        {cue?.source === "asset" && <option value="asset">已上传音频</option>}
                      </select>
                      <label className="upload-pill">
                        <Upload size={14} /> 上传
                        <input
                          type="file"
                          accept="audio/wav,audio/mpeg,audio/ogg"
                          onChange={(event) => void uploadSound(event.target.files?.[0], slot)}
                        />
                      </label>
                    </div>
                    {cue?.source === "speech" && (
                      <div className="sound-detail-grid speech-grid">
                        <label>
                          候选台词（每行一句，播放时随机）
                          <textarea
                            value={(cue.phrases ?? []).join("\n")}
                            onChange={(event) =>
                              updateSound(slot, (sound) => {
                                sound.phrases = event.target.value
                                  .split("\n")
                                  .map((phrase) => phrase.trim())
                                  .filter(Boolean);
                                sound.phrasesBySound = undefined;
                              })
                            }
                          />
                        </label>
                        <label>
                          语速
                          <input
                            type="number"
                            min={0.5}
                            max={2}
                            step={0.05}
                            value={cue.speechRate ?? 1}
                            onChange={(event) =>
                              updateSound(
                                slot,
                                (sound) => (sound.speechRate = Number(event.target.value)),
                              )
                            }
                          />
                        </label>
                        <label>
                          音调
                          <input
                            type="number"
                            min={0.5}
                            max={2}
                            step={0.05}
                            value={cue.speechPitch ?? 1}
                            onChange={(event) =>
                              updateSound(
                                slot,
                                (sound) => (sound.speechPitch = Number(event.target.value)),
                              )
                            }
                          />
                        </label>
                      </div>
                    )}
                    {cue?.source === "synth" && (
                      <div className="sound-detail-grid">
                        <label>
                          合成预设
                          <select
                            value={cue.preset ?? "swipe"}
                            onChange={(event) =>
                              updateSound(
                                slot,
                                (sound) => (sound.preset = event.target.value as SynthPreset),
                              )
                            }
                          >
                            {synthPresetOptions.map((preset) => (
                              <option key={preset.value} value={preset.value}>
                                {preset.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          随机音高
                          <input
                            type="number"
                            min={0}
                            max={1}
                            step={0.01}
                            value={cue.pitchVariance ?? 0}
                            onChange={(event) =>
                              updateSound(
                                slot,
                                (sound) => (sound.pitchVariance = Number(event.target.value)),
                              )
                            }
                          />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="editor-card">
            <div className="card-title">
              <Sparkles size={17} />
              <span>技能模块</span>
            </div>
            <div className="ability-list">
              {selected.abilities.length === 0 && (
                <div className="empty-inline">内置特殊技能由插件提供；可继续叠加通用模块。</div>
              )}
              {selected.abilities.map((ability) => {
                const action = ability.actions[0] ?? defaultAction("heal");
                return (
                  <article className="ability-editor" key={ability.id}>
                    <div className="ability-editor-heading">
                      <input
                        aria-label="技能名称"
                        value={ability.name}
                        onChange={(event) =>
                          updateAbility(ability.id, (item) => (item.name = event.target.value))
                        }
                      />
                      <button
                        type="button"
                        className="icon-button danger"
                        title="删除技能"
                        onClick={() =>
                          updateCharacter(
                            (character) =>
                              (character.abilities = character.abilities.filter(
                                (candidate) => candidate.id !== ability.id,
                              )),
                          )
                        }
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <div className="ability-editor-fields">
                      <label>
                        触发器
                        <select
                          value={ability.trigger}
                          onChange={(event) =>
                            updateAbility(
                              ability.id,
                              (item) =>
                                (item.trigger = event.target.value as AbilityModule["trigger"]),
                            )
                          }
                        >
                          <option value="interval">定时触发</option>
                          <option value="onDamageTaken">受到攻击</option>
                          <option value="onAttack">发动攻击</option>
                          <option value="onDeath">死亡时</option>
                        </select>
                      </label>
                      <label>
                        冷却（秒）
                        <input
                          type="number"
                          min={0}
                          step={0.001}
                          value={ability.cooldown}
                          onChange={(event) =>
                            updateAbility(
                              ability.id,
                              (item) => (item.cooldown = Number(event.target.value)),
                            )
                          }
                        />
                      </label>
                      <label>
                        定时间隔（秒）
                        <input
                          type="number"
                          min={0}
                          step={0.001}
                          value={ability.interval ?? ability.cooldown}
                          onChange={(event) =>
                            updateAbility(
                              ability.id,
                              (item) => (item.interval = Number(event.target.value)),
                            )
                          }
                        />
                      </label>
                      <label>
                        血量条件（0–1）
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={ability.hpBelowRatio ?? 1}
                          onChange={(event) =>
                            updateAbility(
                              ability.id,
                              (item) => (item.hpBelowRatio = Number(event.target.value)),
                            )
                          }
                        />
                      </label>
                      <label>
                        效果
                        <select
                          value={action.kind}
                          onChange={(event) =>
                            updateAbility(
                              ability.id,
                              (item) =>
                                (item.actions = [
                                  defaultAction(event.target.value as AbilityAction["kind"]),
                                ]),
                            )
                          }
                        >
                          <option value="heal">治疗自己</option>
                          <option value="damageNearby">范围伤害</option>
                          <option value="spawnUnit">召唤单位</option>
                          <option value="knockbackNearby">范围击退</option>
                          <option value="playSound">播放音效</option>
                        </select>
                      </label>
                      {(action.kind === "heal" || action.kind === "damageNearby") && (
                        <label>
                          {action.kind === "heal" ? "治疗量" : "伤害"}
                          <input
                            type="number"
                            min={0}
                            value={action.amount}
                            onChange={(event) =>
                              updateAbility(ability.id, (item) => {
                                const effect = item.actions[0];
                                if (effect?.kind === "heal" || effect?.kind === "damageNearby") {
                                  effect.amount = Number(event.target.value);
                                }
                              })
                            }
                          />
                        </label>
                      )}
                      {(action.kind === "damageNearby" || action.kind === "knockbackNearby") && (
                        <label>
                          作用半径
                          <input
                            type="number"
                            min={0}
                            value={action.radius}
                            onChange={(event) =>
                              updateAbility(ability.id, (item) => {
                                const effect = item.actions[0];
                                if (
                                  effect?.kind === "damageNearby" ||
                                  effect?.kind === "knockbackNearby"
                                ) {
                                  effect.radius = Number(event.target.value);
                                }
                              })
                            }
                          />
                        </label>
                      )}
                      {action.kind === "knockbackNearby" && (
                        <label>
                          击退距离
                          <input
                            type="number"
                            min={0}
                            value={action.distance}
                            onChange={(event) =>
                              updateAbility(ability.id, (item) => {
                                const effect = item.actions[0];
                                if (effect?.kind === "knockbackNearby") {
                                  effect.distance = Number(event.target.value);
                                }
                              })
                            }
                          />
                        </label>
                      )}
                      {action.kind === "spawnUnit" && (
                        <>
                          <label>
                            召唤单位
                            <select
                              value={action.definitionId}
                              onChange={(event) =>
                                updateAbility(ability.id, (item) => {
                                  const effect = item.actions[0];
                                  if (effect?.kind === "spawnUnit") {
                                    effect.definitionId = event.target.value;
                                  }
                                })
                              }
                            >
                              {manifest.characters.map((character) => (
                                <option value={character.id} key={character.id}>
                                  {character.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            召唤数量
                            <input
                              type="number"
                              min={1}
                              step={1}
                              value={action.count}
                              onChange={(event) =>
                                updateAbility(ability.id, (item) => {
                                  const effect = item.actions[0];
                                  if (effect?.kind === "spawnUnit") {
                                    effect.count = Math.max(1, Math.round(Number(event.target.value)));
                                  }
                                })
                              }
                            />
                          </label>
                        </>
                      )}
                      {action.kind === "playSound" && (
                        <label>
                          音效预设
                          <select
                            value={action.cue}
                            onChange={(event) =>
                              updateAbility(ability.id, (item) => {
                                const effect = item.actions[0];
                                if (effect?.kind === "playSound") {
                                  effect.cue = event.target.value as SynthPreset;
                                }
                              })
                            }
                          >
                            {synthPresetOptions.map((preset) => (
                              <option key={preset.value} value={preset.value}>
                                {preset.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="button-cluster">
              <button type="button" className="secondary-button" onClick={() => addAbility("heal")}>
                <Plus size={15} /> 受伤回血
              </button>
              <button type="button" className="secondary-button" onClick={() => addAbility("pulse")}>
                <Plus size={15} /> 定时冲击波
              </button>
              <button type="button" className="secondary-button" onClick={() => addAbility("summon")}>
                <Plus size={15} /> 受击呼叫支援
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
