import type { CharacterDefinition } from "./types";

export type EntranceStyle =
  | "lazy-settle"
  | "burrow-pop"
  | "patrol-run"
  | "swagger"
  | "tactical-rush"
  | "heavy-march"
  | "sniper-infiltration"
  | "heavy-drop"
  | "standard";

export type EntrancePresentation = {
  style: EntranceStyle;
  xOffset: number;
  yOffset: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  alpha: number;
  effectStrength: number;
};

type EntranceCharacter = Pick<CharacterDefinition, "pluginId" | "policeStar">;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const smoothstep = (value: number): number => {
  const progress = clamp01(value);
  return progress * progress * (3 - 2 * progress);
};
const easeOutCubic = (value: number): number => {
  const remaining = 1 - clamp01(value);
  return 1 - remaining * remaining * remaining;
};
const easeOutQuart = (value: number): number => {
  const remaining = 1 - clamp01(value);
  return 1 - remaining * remaining * remaining * remaining;
};

export const entranceStyleFor = (
  definition: EntranceCharacter,
): EntranceStyle => {
  if (definition.pluginId === "panda") return "lazy-settle";
  if (definition.pluginId === "mole") return "burrow-pop";
  if (definition.pluginId !== "police") return "standard";
  if (definition.policeStar === 1) return "patrol-run";
  if (definition.policeStar === 2) return "swagger";
  if (definition.policeStar === 3) return "tactical-rush";
  if (definition.policeStar === 4) return "heavy-march";
  if (definition.policeStar === 5) return "sniper-infiltration";
  if (definition.policeStar === 6) return "heavy-drop";
  return "standard";
};

export const entrancePresentationFor = (
  definition: EntranceCharacter,
  rawProgress: number,
  radius: number,
  facingLeft: boolean,
): EntrancePresentation => {
  const progress = clamp01(rawProgress);
  const style = entranceStyleFor(definition);
  const facing = facingLeft ? -1 : 1;
  const fadeIn = clamp01(progress / 0.16);

  if (style === "lazy-settle") {
    const settle = smoothstep(progress);
    const cushion = Math.sin(progress * Math.PI);
    return {
      style,
      xOffset: -facing * radius * 0.82 * (1 - settle),
      yOffset: radius * (0.42 * (1 - settle) + cushion * 0.08),
      scaleX: 0.86 + settle * 0.14 + cushion * 0.11,
      scaleY: 0.72 + settle * 0.28 - cushion * 0.08,
      angle: -facing * (7 * (1 - settle) + cushion * 2),
      alpha: fadeIn,
      effectStrength: Math.sin(progress * Math.PI),
    };
  }

  if (style === "burrow-pop") {
    const emerge = smoothstep(progress / 0.68);
    const rebound = Math.sin(clamp01((progress - 0.42) / 0.58) * Math.PI);
    return {
      style,
      xOffset:
        facing *
        Math.sin(progress * Math.PI * 3) *
        radius *
        0.09 *
        (1 - progress),
      yOffset: radius * 1.82 * (1 - emerge) - radius * rebound * 0.18,
      scaleX: 0.56 + emerge * 0.44 + rebound * 0.15,
      scaleY: 0.46 + emerge * 0.54 - rebound * 0.1,
      angle:
        facing *
        Math.sin(progress * Math.PI * 4) *
        4 *
        (1 - progress),
      alpha: clamp01(progress / 0.1),
      effectStrength: 1 - smoothstep(progress),
    };
  }

  if (style === "patrol-run") {
    const arrival = easeOutCubic(progress);
    const stride = Math.abs(Math.sin(progress * Math.PI * 3));
    return {
      style,
      xOffset: -facing * radius * 2.35 * (1 - arrival),
      yOffset: -radius * stride * 0.17 * (1 - progress * 0.45),
      scaleX: 0.88 + arrival * 0.12 + stride * 0.07,
      scaleY: 0.91 + arrival * 0.09 - stride * 0.05,
      angle: facing * (9 * (1 - arrival) - stride * 2),
      alpha: fadeIn,
      effectStrength: (1 - progress) * 0.9,
    };
  }

  if (style === "swagger") {
    const arrival = smoothstep(progress);
    const sway = Math.sin(progress * Math.PI * 2);
    return {
      style,
      xOffset: -facing * radius * 1.42 * (1 - arrival),
      yOffset: -Math.abs(sway) * radius * 0.08,
      scaleX: 0.9 + arrival * 0.1 + Math.abs(sway) * 0.035,
      scaleY: 0.9 + arrival * 0.1 - Math.abs(sway) * 0.025,
      angle: -facing * sway * 5 * (1 - progress * 0.5),
      alpha: fadeIn,
      effectStrength: Math.sin(progress * Math.PI),
    };
  }

  if (style === "tactical-rush") {
    const arrival = easeOutQuart(progress);
    const stride = Math.abs(Math.sin(progress * Math.PI * 3.5));
    return {
      style,
      xOffset: -facing * radius * 3.15 * (1 - arrival),
      yOffset: -radius * stride * 0.2 * (1 - progress * 0.5),
      scaleX: 0.84 + arrival * 0.16 + stride * 0.1,
      scaleY: 0.92 + arrival * 0.08 - stride * 0.06,
      angle: facing * (12 * (1 - arrival) - stride * 2.5),
      alpha: fadeIn,
      effectStrength: (1 - progress) * 1.1,
    };
  }

  if (style === "heavy-march") {
    const arrival = smoothstep(progress);
    const step = Math.abs(Math.sin(progress * Math.PI * 2.25));
    const stomp = Math.pow(1 - step, 5) * Math.sin(progress * Math.PI);
    return {
      style,
      xOffset: -facing * radius * 1.85 * (1 - arrival),
      yOffset: -radius * step * 0.08,
      scaleX: 0.91 + arrival * 0.09 + stomp * 0.09,
      scaleY: 0.88 + arrival * 0.12 - stomp * 0.07,
      angle: facing * (5.5 * (1 - arrival) + step * 1.8),
      alpha: fadeIn,
      effectStrength: Math.max(stomp, (1 - progress) * 0.18),
    };
  }

  if (style === "sniper-infiltration") {
    const arrival = easeOutQuart(progress);
    const lowStep = Math.abs(Math.sin(progress * Math.PI * 2.8));
    const settle = smoothstep(
      Math.max(0, (progress - 0.62) / 0.38),
    );
    return {
      style,
      xOffset: -facing * radius * 2.7 * (1 - arrival),
      yOffset:
        radius * (0.2 + lowStep * 0.07) * (1 - settle) -
        radius * settle * 0.04,
      scaleX: 0.9 + arrival * 0.1 + lowStep * 0.035,
      scaleY: 0.82 + arrival * 0.18 - lowStep * 0.035,
      angle: facing * (7 * (1 - arrival) - lowStep * 1.5),
      alpha: fadeIn,
      effectStrength: (1 - progress) * 0.52,
    };
  }

  if (style === "heavy-drop") {
    const touchdownAt = 0.3;
    const drop = smoothstep(progress / touchdownAt);
    const impactProgress = clamp01((progress - 0.26) / 0.34);
    const impact =
      progress >= 0.26 && progress <= 0.6
        ? Math.sin(impactProgress * Math.PI)
        : 0;
    const rise = smoothstep((progress - 0.48) / 0.35);
    const recoil =
      Math.sin(clamp01((progress - 0.46) / 0.34) * Math.PI) *
      (1 - smoothstep((progress - 0.78) / 0.22));
    const brace =
      progress >= 0.7
        ? Math.sin(clamp01((progress - 0.7) / 0.3) * Math.PI)
        : 0;
    return {
      style,
      xOffset:
        -facing * radius * 0.12 * (1 - drop) +
        Math.sin(progress * Math.PI * 12) * radius * 0.035 * impact,
      yOffset:
        progress < touchdownAt
          ? -radius * 4.2 * (1 - drop)
          : radius * (0.14 * (1 - rise) - recoil * 0.07),
      scaleX: 0.76 + drop * 0.24 + impact * 0.2 + brace * 0.045,
      scaleY: 0.84 + drop * 0.16 - impact * 0.18 - brace * 0.025,
      angle:
        -facing * 6.5 * (1 - drop) + facing * recoil * 1.6,
      alpha: clamp01(progress / 0.06),
      effectStrength: Math.max(
        impact,
        (1 - drop) * 0.28,
        brace * 0.5,
      ),
    };
  }

  const arrival = smoothstep(progress);
  return {
    style,
    xOffset: 0,
    yOffset: radius * 0.7 * (1 - arrival),
    scaleX: 0.72 + arrival * 0.28,
    scaleY: 0.72 + arrival * 0.28,
    angle: (facingLeft ? 8 : -8) * (1 - arrival),
    alpha: clamp01(progress / 0.24),
    effectStrength: Math.sin(progress * Math.PI),
  };
};
