import type { ProjectManifest } from "./types";

export type BoardRemovalResult = {
  manifest: ProjectManifest;
  selectedBoardId: string;
};

export const removeBoardFromManifest = (
  manifest: ProjectManifest,
  boardId: string,
): BoardRemovalResult | undefined => {
  if (manifest.boards.length <= 1) return undefined;

  const removedIndex = manifest.boards.findIndex((board) => board.id === boardId);
  if (removedIndex < 0) return undefined;

  const next = structuredClone(manifest);
  next.boards = next.boards.filter((board) => board.id !== boardId);
  const fallbackBoard =
    next.boards[Math.min(removedIndex, next.boards.length - 1)] ??
    next.boards[0];
  if (!fallbackBoard) return undefined;

  if (next.setup.boardId === boardId) {
    const removedBoard = manifest.boards[removedIndex];
    next.setup = {
      ...next.setup,
      boardId: fallbackBoard.id,
      contestants: next.setup.contestants.map((contestant) => ({
        ...contestant,
        position: {
          x: Math.max(
            60,
            Math.min(
              fallbackBoard.width - 60,
              (contestant.position.x / removedBoard.width) *
                fallbackBoard.width,
            ),
          ),
          y: Math.max(
            60,
            Math.min(
              fallbackBoard.height - 60,
              (contestant.position.y / removedBoard.height) *
                fallbackBoard.height,
            ),
          ),
        },
      })),
    };
  }
  next.updatedAt = new Date().toISOString();

  return {
    manifest: next,
    selectedBoardId: fallbackBoard.id,
  };
};
