"use client";

import { useRef, useState } from "react";
import type { BoardDefinition, CharacterDefinition, MatchSetup } from "@/lib/game/types";

type FormationEditorProps = {
  setup: MatchSetup;
  characters: CharacterDefinition[];
  board: BoardDefinition;
  onChange: (setup: MatchSetup) => void;
};

export function FormationEditor({ setup, characters, board, onChange }: FormationEditorProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string>();

  const moveContestant = (clientX: number, clientY: number) => {
    if (!draggingId || !boardRef.current) return;
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
      className="formation-board"
      style={{ aspectRatio: `${board.width} / ${board.height}` }}
      onPointerMove={(event) => moveContestant(event.clientX, event.clientY)}
      onPointerUp={() => setDraggingId(undefined)}
      onPointerLeave={() => setDraggingId(undefined)}
    >
      <span className="formation-grid-label">赛前拖动布阵</span>
      {setup.contestants.map((contestant, index) => {
        const definition = characters.find(
          (candidate) => candidate.id === contestant.definitionId,
        );
        return (
          <button
            key={contestant.id}
            type="button"
            className="formation-token"
            style={{
              left: `${(contestant.position.x / board.width) * 100}%`,
              top: `${(contestant.position.y / board.height) * 100}%`,
              borderColor: contestant.color,
              background: `color-mix(in srgb, ${contestant.color} 32%, #17151c)`,
            }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              setDraggingId(contestant.id);
            }}
            aria-label={`拖动 ${contestant.displayName}`}
            title={`${contestant.displayName} · ${Math.round(contestant.position.x)}, ${Math.round(contestant.position.y)}`}
          >
            <span>{definition?.id.startsWith("panda") ? "🐼" : definition?.id === "mole" ? "🦫" : "🐾"}</span>
            <small>{index + 1}</small>
          </button>
        );
      })}
    </div>
  );
}
