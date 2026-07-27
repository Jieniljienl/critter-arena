import type { RuntimeUnit } from "./types";

type AnimationState = Pick<RuntimeUnit, "action" | "tunnelData">;

export const actionClipName = (
  unit: AnimationState,
  time: number,
  callingForHelp = false,
): string => {
  if (callingForHelp) return "callPolice";
  if (unit.action === "entering") return "entrance";
  if (unit.action === "tunneling") {
    const tunnel = unit.tunnelData;
    if (!tunnel) return "tunnelMove";
    if (time < tunnel.travelStartedAt) return "tunnelEnter";
    if (time < tunnel.arrivalAt) return "tunnelMove";
    if (
      tunnel.returnStartedAt !== undefined &&
      tunnel.returnArrivalAt !== undefined
    ) {
      if (time < tunnel.returnStartedAt) {
        return tunnel.hitSucceeded ? "tunnelAttack" : "tunnelEmerge";
      }
      if (time < tunnel.returnArrivalAt) return "tunnelMove";
      return "tunnelEmerge";
    }
    if (
      tunnel.mode === "ambush" &&
      tunnel.attackAt !== undefined &&
      time >= tunnel.attackAt &&
      tunnel.hitSucceeded
    ) {
      return "tunnelAttack";
    }
    return "tunnelEmerge";
  }
  if (unit.action === "reloading") return "reload";
  if (unit.action === "victory") return "victory";
  if (unit.action === "eating") return "eat";
  if (unit.action === "satisfied") return "eatComplete";
  if (unit.action === "meleeApproach") return "move";
  if (unit.action === "digging" || unit.action === "kick") return "skill";
  if (unit.action === "attack" || unit.action === "kill") return "attack";
  return "move";
};
