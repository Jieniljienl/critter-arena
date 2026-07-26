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
  SCHEMA_VERSION,
  type AbilityModule,
  type AnimationClip,
  type AssetRef,
  type CharacterDefinition,
  type ProjectManifest,
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
    const id = `custom-${Date.now()}`;
    const clone = structuredClone(selected);
    clone.id = id;
    clone.name = `${selected.name}副本`;
    clone.subtitle = "自定义角色";
    clone.role = "contestant";
    clone.pluginId = undefined;
    clone.policeStar = undefined;
    const next = structuredClone(manifest);
    next.characters.push(clone);
    next.updatedAt = new Date().toISOString();
    onChange(next);
    onSelect(id);
    onNotice("已创建可编辑角色副本");
  };

  const uploadAnimation = async (files: File[], clipName: "idle" | "attack" | "skill") => {
    if (!files.length) return;
    const newAssets: AssetRef[] = [];
    const frames: AnimationClip["frames"] = [];
    for (const [index, file] of files.entries()) {
      if (!file.type.startsWith("image/")) continue;
      const url = removeBackground
        ? await removeFlatBackground(file)
        : await fileToDataUrl(file);
      const id = `${selected.id}-${clipName}-${Date.now()}-${index}`;
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
            ? clipName === "attack"
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
      loop: clipName !== "attack",
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
    onNotice(`已更新${clipName === "idle" ? "待机" : clipName === "attack" ? "普攻" : "技能"}动作`);
  };

  const uploadSound = async (
    file: File | undefined,
    slot: "attack" | "hit" | "hurt" | "skill" | "death",
  ) => {
    if (!file || !file.type.startsWith("audio/")) return;
    const url = await fileToDataUrl(file);
    const assetId = `${selected.id}-${slot}-sound-${Date.now()}`;
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
    const module: AbilityModule =
      preset === "heal"
        ? {
            id: `ability-${Date.now()}`,
            name: "负伤恢复",
            trigger: "onDamageTaken",
            cooldown: 5,
            hpBelowRatio: 0.6,
            actions: [{ kind: "heal", amount: 20 }],
          }
        : preset === "pulse"
          ? {
              id: `ability-${Date.now()}`,
              name: "定时冲击波",
              trigger: "interval",
              cooldown: 8,
              interval: 8,
              actions: [{ kind: "damageNearby", amount: 10, radius: 180 }],
            }
          : {
              id: `ability-${Date.now()}`,
              name: "受击援军",
              trigger: "onDamageTaken",
              cooldown: 4,
              actions: [{ kind: "spawnUnit", definitionId: "police-1", count: 1 }],
            };
    updateCharacter((character) => character.abilities.push(module));
  };

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
                  {!portrait && (character.id === "panda" ? "🐼" : character.id === "mole" ? "🦫" : "👮")}
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
            <span className="eyebrow">Character definition</span>
            <h1>{selected.name}</h1>
            <p>{selected.subtitle}</p>
          </div>
          <button className="secondary-button" type="button" onClick={createCharacter}>
            <Plus size={16} /> 复制并扩展
          </button>
        </div>

        <div className="editor-grid">
          <div className="editor-card">
            <div className="card-title">
              <Sparkles size={17} />
              <span>基础与战斗数值</span>
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
                攻击距离
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
              <label>
                攻击间隔（秒）
                <input
                  type="number"
                  min={0.1}
                  step={0.05}
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
                角色色
                <input
                  type="color"
                  value={selected.accent}
                  onChange={(event) => updateCharacter((character) => (character.accent = event.target.value))}
                />
              </label>
            </div>
          </div>

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
              ] as const).map(([clipName, label, multiple]) => (
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
                    {frameAsset ? <img src={frameAsset.url} alt="" /> : <span>?</span>}
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
            <div className="sound-list">
              {([
                ["attack", "攻击"],
                ["hit", "命中"],
                ["hurt", "受伤"],
                ["skill", "技能"],
                ["death", "死亡"],
              ] as const).map(([slot, label]) => (
                <label className="sound-row" key={slot}>
                  <span>
                    <strong>{label}</strong>
                    <small>
                      {selected.sounds[slot]?.source === "asset" ? "自定义音频" : "程序合成"}
                    </small>
                  </span>
                  <span className="upload-pill">
                    <Upload size={14} /> 替换
                    <input
                      type="file"
                      accept="audio/wav,audio/mpeg,audio/ogg"
                      onChange={(event) => void uploadSound(event.target.files?.[0], slot)}
                    />
                  </span>
                </label>
              ))}
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
              {selected.abilities.map((ability) => (
                <div className="ability-row" key={ability.id}>
                  <span>
                    <strong>{ability.name}</strong>
                    <small>{ability.trigger} · 冷却 {ability.cooldown}s</small>
                  </span>
                  <button
                    type="button"
                    className="icon-button danger"
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
              ))}
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
