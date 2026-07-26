"use client";

import { useRef, useState } from "react";
import type {
  BattleStatus,
  BoardDefinition,
  CharacterDefinition,
  MatchSetup,
  RuntimeUnit,
} from "@/lib/game/types";

type FormationEditorProps = {
  setup: MatchSetup;
  characters: CharacterDefinition[];
  board: BoardDefinition;
  onChange: (setup: MatchSetup) => void;
  liveUnits?: RuntimeUnit[];
  battleStatus?: BattleStatus;
};

export function FormationEditor({
  setup,
  characters,
  board,
  onChange,
  liveUnits,
  battleStatus,
}: FormationEditorProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string>();
  const isLive =
    battleStatus === "running" || battleStatus === "paused" || battleStatus === "finished";
  const liveMainById = new Map(
    (liveUnits ?? []).filter((unit) => unit.main).map((unit) => [unit.id, unit]),
  );

  const moveContestant = (clientX: number, clientY: number) => {
    if (isLive || !draggingId || !boardRef.current) return;
    const rect = boardRef.current.getBoundingClientRect();
    const margin = 50 * (board.unitScale ?? 1);
    const x = Math.max(
      margin,
      Math.min(board.width - margin, ((clientX - rect.left) / rect.width) * board.width),
    );
    const y = Math.max(
      margin,
      Math.min(board.height - margin, ((clientY - rect.top) / rect.height) * board.height),
    );
    onChange({
      ...setup,
      contestants: setup.contestants.map((contestant) =>
        contestant.id === draggingId
          ? { ...contestant, position: { x: Math.round(x), y: Math.round(y) } }
          : contestant,
      ),
    });
  };

  return (
    <div
      ref={boardRef}
      className={`formation-board ${isLive ? "is-live" : "is-editing"} ${
        board.height > board.width ? "is-portrait-board" : "is-landscape-board"
      }`}
      style={{ aspectRatio: `${board.width} / ${board.height}` }}
      onPointerMove={(event) => moveContestant(event.clientX, event.clientY)}
      onPointerUp={() => setDraggingId(undefined)}
      onPointerCancel={() => setDraggingId(undefined)}
      onPointerLeave={() => setDraggingId(undefined)}
    >
      <span className="formation-grid-label">
        {isLive ? "战斗位置 · 约 12 FPS 同步" : "赛前拖动布阵 · 左右实时同步"}
      </span>
      {setup.contestants.map((contestant, index) => {
        const setupDefinition = characters.find(
          (candidate) => candidate.id === contestant.definitionId,
        );
        const liveUnit = liveMainById.get(contestant.id);
        const definition =
          (liveUnit
            ? characters.find(
                (candidate) => candidate.id === liveUnit.definitionId,
              )
            : undefined) ?? setupDefinition;
        const policeStar = liveUnit?.policeStar ?? definition?.policeStar;
        const icon = definition?.id.startsWith("panda")
          ? "🐼"
          : definition?.id === "mole"
            ? "🦫"
            : policeStar
              ? "👮"
              : "🐾";
        const typeLabel = policeStar
          ? `${policeStar}★`
          : definition?.id.startsWith("panda")
            ? "熊猫"
            : definition?.id === "mole"
              ? "地鼠"
              : (definition?.name ?? "角色").slice(0, 3);
        const displayPosition =
          isLive && liveUnit ? { x: liveUnit.x, y: liveUnit.y } : contestant.position;
        const missing = isLive && !liveUnit;
        const eliminated = isLive && Boolean(liveUnit && (liveUnit.hp <= 0 || liveUnit.action === "dead"));
        return (
          <button
            key={contestant.id}
            type="button"
            className={`formation-token ${eliminated ? "is-eliminated" : ""} ${
              missing ? "is-missing" : ""
            }`}
            style={{
              left: `${(displayPosition.x / board.width) * 100}%`,
              top: `${(displayPosition.y / board.height) * 100}%`,
              borderColor: contestant.color,
              background: `color-mix(in srgb, ${contestant.color} 32%, #17151c)`,
            }}
            onPointerDown={(event) => {
              if (isLive) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              setDraggingId(contestant.id);
            }}
            aria-label={
              isLive
                ? `${contestant.displayName}（${definition?.name ?? "未知角色"}）战斗位置`
                : `拖动 ${contestant.displayName}（${definition?.name ?? "未知角色"}）`
            }
            title={`${contestant.displayName} · ${definition?.name ?? "未知角色"} · ${Math.round(displayPosition.x)}, ${Math.round(displayPosition.y)}`}
          >
            <span className="formation-token-icon" aria-hidden="true">
              {icon}
            </span>
            <span
              className={`formation-token-kind ${policeStar ? "is-police" : ""}`}
              aria-hidden="true"
            >
              {typeLabel}
            </span>
            <small>{index + 1}</small>
          </button>
        );
      })}
    </div>
  );
}
