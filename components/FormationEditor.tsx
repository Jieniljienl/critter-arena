"use client";

import { useRef, useState } from "react";
import type {
  BattleStatus,
  BoardDefinition,
  CharacterDefinition,
  MatchSetup,
} from "@/lib/game/types";

type FormationEditorProps = {
  setup: MatchSetup;
  characters: CharacterDefinition[];
  board: BoardDefinition;
  onChange: (setup: MatchSetup) => void;
  battleStatus?: BattleStatus;
  selectedContestantId?: string;
  onSelectContestant?: (contestantId: string) => void;
  onRequestTeam?: (contestantId: string, clientX: number, clientY: number) => void;
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
  battleStatus,
  selectedContestantId,
  onSelectContestant,
  onRequestTeam,
}: FormationEditorProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<FormationDrag | undefined>(undefined);
  const [draggingId, setDraggingId] = useState<string>();
  const [touchDragging, setTouchDragging] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const isLive =
    battleStatus === "running" || battleStatus === "paused" || battleStatus === "finished";

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
          ? "开局站位 · 战斗中固定展示"
          : selectedId
            ? "已选中 · 按住棋子拖动位置"
            : "按住棋子拖动 · 单击仅选中"}
      </span>
      {setup.contestants.map((contestant, index) => {
        const setupDefinition = characters.find(
          (candidate) => candidate.id === contestant.definitionId,
        );
        const definition = setupDefinition;
        const policeStar = definition?.policeStar;
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
        const displayPosition = contestant.position;
        return (
          <button
            key={contestant.id}
            type="button"
            className={`formation-token ${
              (selectedContestantId ?? (!isLive ? selectedId : undefined)) ===
              contestant.id
                ? "is-selected"
                : ""
            } ${draggingId === contestant.id ? "is-dragging" : ""} ${
              draggingId === contestant.id && touchDragging ? "is-touch-dragging" : ""
            }`}
            style={{
              left: `${(displayPosition.x / board.width) * 100}%`,
              top: `${(displayPosition.y / board.height) * 100}%`,
              borderColor: contestant.color,
              background: `color-mix(in srgb, ${contestant.color} 32%, #17151c)`,
            }}
            onPointerDown={(event) => {
              onSelectContestant?.(contestant.id);
              if (isLive || event.button !== 0) return;
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
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelectContestant?.(contestant.id);
              onRequestTeam?.(contestant.id, event.clientX, event.clientY);
            }}
            onLostPointerCapture={(event) => {
              const drag = dragRef.current;
              if (drag?.pointerId !== event.pointerId) return;
              dragRef.current = undefined;
              setDraggingId(undefined);
              setTouchDragging(false);
            }}
            aria-pressed={
              (selectedContestantId ?? (!isLive ? selectedId : undefined)) ===
              contestant.id
            }
            aria-label={
              isLive
                ? `${contestant.displayName}（${definition?.name ?? "未知角色"}）开局站位`
                : `拖动或选中 ${contestant.displayName}（${definition?.name ?? "未知角色"}）`
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
