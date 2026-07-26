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

type FormationDrag = {
  id: string;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  moved: boolean;
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
  const dragRef = useRef<FormationDrag | undefined>(undefined);
  const [draggingId, setDraggingId] = useState<string>();
  const [touchDragging, setTouchDragging] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const isLive =
    battleStatus === "running" || battleStatus === "paused" || battleStatus === "finished";
  const liveMainById = new Map(
    (liveUnits ?? []).filter((unit) => unit.main).map((unit) => [unit.id, unit]),
  );

  const moveContestant = (
    contestantId: string,
    clientX: number,
    clientY: number,
    liftPixels = 0,
  ) => {
    if (isLive || !boardRef.current) return;
    const rect = boardRef.current.getBoundingClientRect();
    const margin = 50 * (board.unitScale ?? 1);
    const x = Math.max(
      margin,
      Math.min(board.width - margin, ((clientX - rect.left) / rect.width) * board.width),
    );
    const y = Math.max(
      margin,
      Math.min(
        board.height - margin,
        ((clientY - liftPixels - rect.top) / rect.height) * board.height,
      ),
    );
    const nextPosition = { x: Math.round(x), y: Math.round(y) };
    const current = setup.contestants.find((contestant) => contestant.id === contestantId);
    if (
      !current ||
      (current.position.x === nextPosition.x && current.position.y === nextPosition.y)
    ) {
      return;
    }
    onChange({
      ...setup,
      contestants: setup.contestants.map((contestant) =>
        contestant.id === contestantId
          ? { ...contestant, position: nextPosition }
          : contestant,
      ),
    });
  };

  const finishDrag = (
    pointerId: number,
    clientX: number,
    clientY: number,
    cancelled = false,
  ) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    if (!cancelled && drag.moved) {
      moveContestant(
        drag.id,
        clientX,
        clientY,
        drag.pointerType === "touch" ? 36 : 0,
      );
    }
    dragRef.current = undefined;
    setDraggingId(undefined);
    setTouchDragging(false);
  };

  return (
    <div
      ref={boardRef}
      className={`formation-board ${isLive ? "is-live" : "is-editing"} ${
        board.height > board.width ? "is-portrait-board" : "is-landscape-board"
      }`}
      style={{ aspectRatio: `${board.width} / ${board.height}` }}
      onPointerDown={(event) => {
        if (
          isLive ||
          !selectedId ||
          (event.target as HTMLElement).closest(".formation-token")
        ) {
          return;
        }
        event.preventDefault();
        moveContestant(selectedId, event.clientX, event.clientY);
        setSelectedId(undefined);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        if (
          !drag.moved &&
          Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4
        ) {
          return;
        }
        drag.moved = true;
        moveContestant(
          drag.id,
          event.clientX,
          event.clientY,
          drag.pointerType === "touch" ? 36 : 0,
        );
      }}
      onPointerUp={(event) =>
        finishDrag(event.pointerId, event.clientX, event.clientY)
      }
      onPointerCancel={(event) =>
        finishDrag(event.pointerId, event.clientX, event.clientY, true)
      }
    >
      <span className="formation-grid-label">
        {isLive
          ? "战斗位置 · 约 12 FPS 同步"
          : selectedId
            ? "已选中 · 轻触空白处放置"
            : "按住拖动 · 或点选角色后轻触落点"}
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
            className={`formation-token ${
              !isLive && selectedId === contestant.id ? "is-selected" : ""
            } ${draggingId === contestant.id ? "is-dragging" : ""} ${
              draggingId === contestant.id && touchDragging ? "is-touch-dragging" : ""
            } ${eliminated ? "is-eliminated" : ""} ${missing ? "is-missing" : ""}`}
            style={{
              left: `${(displayPosition.x / board.width) * 100}%`,
              top: `${(displayPosition.y / board.height) * 100}%`,
              borderColor: contestant.color,
              background: `color-mix(in srgb, ${contestant.color} 32%, #17151c)`,
            }}
            onPointerDown={(event) => {
              if (isLive) return;
              event.preventDefault();
              event.stopPropagation();
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                // Older mobile browsers may still deliver the pointer sequence normally.
              }
              dragRef.current = {
                id: contestant.id,
                pointerId: event.pointerId,
                pointerType: event.pointerType,
                startX: event.clientX,
                startY: event.clientY,
                moved: false,
              };
              setSelectedId(contestant.id);
              setDraggingId(contestant.id);
              setTouchDragging(event.pointerType === "touch");
            }}
            onLostPointerCapture={(event) => {
              const drag = dragRef.current;
              if (drag?.pointerId !== event.pointerId) return;
              dragRef.current = undefined;
              setDraggingId(undefined);
              setTouchDragging(false);
            }}
            aria-pressed={!isLive && selectedId === contestant.id}
            aria-label={
              isLive
                ? `${contestant.displayName}（${definition?.name ?? "未知角色"}）战斗位置`
                : `拖动或点选 ${contestant.displayName}（${definition?.name ?? "未知角色"}）`
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
