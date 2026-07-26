"use client";

import { useMemo, useRef, useState } from "react";
import {
  CircleDot,
  CopyPlus,
  Flame,
  ImagePlus,
  MousePointer2,
  Square,
  Trash2,
  Trees,
  Upload,
} from "lucide-react";
import { fileToDataUrl } from "@/lib/game/storage";
import type {
  BoardDefinition,
  BoardProp,
  ProjectManifest,
  RegionShape,
} from "@/lib/game/types";

type BoardEditorProps = {
  manifest: ProjectManifest;
  selectedId: string;
  onSelect: (id: string) => void;
  onChange: (manifest: ProjectManifest) => void;
  onNotice: (message: string) => void;
};

type BoardTool = "select" | "bamboo" | "lava-circle" | "lava-rectangle" | "lava-polygon";

const shapeBounds = (shape: RegionShape) => {
  if (shape.kind === "circle") {
    return {
      x: shape.x - shape.radius,
      y: shape.y - shape.radius,
      width: shape.radius * 2,
      height: shape.radius * 2,
    };
  }
  if (shape.kind === "rectangle") return shape;
  const xs = shape.points.map((point) => point.x);
  const ys = shape.points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
};

const moveShape = (shape: RegionShape, x: number, y: number): RegionShape => {
  const bounds = shapeBounds(shape);
  const currentCenter = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const dx = x - currentCenter.x;
  const dy = y - currentCenter.y;
  if (shape.kind === "circle") return { ...shape, x: shape.x + dx, y: shape.y + dy };
  if (shape.kind === "rectangle") return { ...shape, x: shape.x + dx, y: shape.y + dy };
  return {
    ...shape,
    points: shape.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
  };
};

export function BoardEditor({
  manifest,
  selectedId,
  onSelect,
  onChange,
  onNotice,
}: BoardEditorProps) {
  const selected = manifest.boards.find((board) => board.id === selectedId) ?? manifest.boards[0];
  const [tool, setTool] = useState<BoardTool>("select");
  const [draggingPropId, setDraggingPropId] = useState<string>();
  const previewRef = useRef<HTMLDivElement>(null);
  const background = useMemo(
    () => manifest.assets.find((asset) => asset.id === selected.backgroundAssetId),
    [manifest.assets, selected.backgroundAssetId],
  );

  const updateBoard = (update: (board: BoardDefinition) => void) => {
    const next = structuredClone(manifest);
    const board = next.boards.find((candidate) => candidate.id === selected.id);
    if (!board) return;
    update(board);
    next.updatedAt = new Date().toISOString();
    onChange(next);
  };

  const createBoard = () => {
    const id = `board-${Date.now()}`;
    const copy = structuredClone(selected);
    copy.id = id;
    copy.name = `${selected.name}副本`;
    const next = structuredClone(manifest);
    next.boards.push(copy);
    next.updatedAt = new Date().toISOString();
    onChange(next);
    onSelect(id);
    onNotice("已复制棋盘，可继续修改背景和布局");
  };

  const uploadBackground = async (file?: File) => {
    if (!file || !file.type.startsWith("image/")) return;
    const url = await fileToDataUrl(file);
    const assetId = `board-background-${Date.now()}`;
    const next = structuredClone(manifest);
    next.assets.push({
      id: assetId,
      kind: "image",
      url,
      name: file.name,
      mime: file.type,
    });
    const board = next.boards.find((candidate) => candidate.id === selected.id);
    if (!board) return;
    board.backgroundAssetId = assetId;
    next.updatedAt = new Date().toISOString();
    onChange(next);
    onNotice("棋盘背景已更新");
  };

  const coordinatesFromPointer = (clientX: number, clientY: number) => {
    const rect = previewRef.current?.getBoundingClientRect();
    if (!rect) return { x: 800, y: 450 };
    return {
      x: Math.round(Math.max(0, Math.min(1600, ((clientX - rect.left) / rect.width) * 1600))),
      y: Math.round(Math.max(0, Math.min(900, ((clientY - rect.top) / rect.height) * 900))),
    };
  };

  const addProp = (clientX: number, clientY: number) => {
    if (tool === "select") return;
    const point = coordinatesFromPointer(clientX, clientY);
    const id = `${tool}-${Date.now()}`;
    const prop: BoardProp =
      tool === "bamboo"
        ? {
            id,
            type: "bamboo",
            active: true,
            label: "新竹子",
            shape: { kind: "circle", ...point, radius: 90 },
          }
        : tool === "lava-circle"
          ? {
              id,
              type: "lava",
              active: true,
              label: "圆形岩浆",
              shape: { kind: "circle", ...point, radius: 110 },
            }
          : tool === "lava-rectangle"
            ? {
                id,
                type: "lava",
                active: true,
                label: "矩形岩浆",
                shape: {
                  kind: "rectangle",
                  x: point.x - 100,
                  y: point.y - 70,
                  width: 200,
                  height: 140,
                },
              }
            : {
                id,
                type: "lava",
                active: true,
                label: "多边形岩浆",
                shape: {
                  kind: "polygon",
                  points: [
                    { x: point.x, y: point.y - 110 },
                    { x: point.x + 130, y: point.y - 10 },
                    { x: point.x + 60, y: point.y + 110 },
                    { x: point.x - 100, y: point.y + 80 },
                    { x: point.x - 130, y: point.y - 40 },
                  ],
                },
              };
    updateBoard((board) => board.props.push(prop));
    setTool("select");
  };

  const moveProp = (clientX: number, clientY: number) => {
    if (!draggingPropId) return;
    const point = coordinatesFromPointer(clientX, clientY);
    updateBoard((board) => {
      const prop = board.props.find((candidate) => candidate.id === draggingPropId);
      if (prop) prop.shape = moveShape(prop.shape, point.x, point.y);
    });
  };

  return (
    <div className="board-editor-layout">
      <aside className="board-sidebar">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">棋盘库</span>
            <h2>{manifest.boards.length} 张棋盘</h2>
          </div>
          <button className="icon-button" type="button" onClick={createBoard} title="复制棋盘">
            <CopyPlus size={18} />
          </button>
        </div>
        <div className="library-list">
          {manifest.boards.map((board) => (
            <button
              type="button"
              className={`board-library-item ${board.id === selected.id ? "is-active" : ""}`}
              key={board.id}
              onClick={() => onSelect(board.id)}
            >
              <span className="board-miniature">
                <Trees size={18} />
              </span>
              <span>
                <strong>{board.name}</strong>
                <small>{board.props.filter((prop) => prop.type === "bamboo").length}竹 · {board.props.filter((prop) => prop.type === "lava").length}岩浆</small>
              </span>
            </button>
          ))}
        </div>
        <div className="board-form">
          <label>
            棋盘名称
            <input
              value={selected.name}
              onChange={(event) => updateBoard((board) => (board.name = event.target.value))}
            />
          </label>
          <label>
            简介
            <textarea
              value={selected.description}
              onChange={(event) => updateBoard((board) => (board.description = event.target.value))}
            />
          </label>
          <label className="upload-wide">
            <Upload size={16} /> 上传背景图
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => void uploadBackground(event.target.files?.[0])}
            />
          </label>
        </div>
      </aside>

      <section className="board-workspace">
        <div className="editor-title-row">
          <div>
            <span className="eyebrow">Board builder · 1600 × 900</span>
            <h1>{selected.name}</h1>
            <p>选择工具后点击棋盘添加区域；切回指针即可拖动。</p>
          </div>
          <div className="board-stats">
            <span><Trees size={15} /> {selected.props.filter((prop) => prop.type === "bamboo").length}</span>
            <span><Flame size={15} /> {selected.props.filter((prop) => prop.type === "lava").length}</span>
          </div>
        </div>

        <div className="board-toolbar">
          {([
            ["select", "选择", MousePointer2],
            ["bamboo", "竹子", Trees],
            ["lava-circle", "圆形岩浆", CircleDot],
            ["lava-rectangle", "矩形岩浆", Square],
            ["lava-polygon", "多边形岩浆", Flame],
          ] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              className={tool === id ? "is-active" : ""}
              onClick={() => setTool(id)}
            >
              <Icon size={16} /> {label}
            </button>
          ))}
          <label className="toolbar-upload">
            <ImagePlus size={16} /> 背景
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => void uploadBackground(event.target.files?.[0])}
            />
          </label>
        </div>

        <div
          ref={previewRef}
          className={`board-preview tool-${tool}`}
          style={
            background
              ? {
                  backgroundImage: `linear-gradient(rgba(10, 15, 13, .06), rgba(10, 15, 13, .18)), url("${background.url}")`,
                }
              : undefined
          }
          onClick={(event) => {
            if (event.target === event.currentTarget) addProp(event.clientX, event.clientY);
          }}
          onPointerMove={(event) => moveProp(event.clientX, event.clientY)}
          onPointerUp={() => setDraggingPropId(undefined)}
          onPointerLeave={() => setDraggingPropId(undefined)}
        >
          <div className="safe-corner top-left">安全出生区</div>
          <div className="safe-corner top-right">安全出生区</div>
          <div className="safe-corner bottom-left">安全出生区</div>
          <div className="safe-corner bottom-right">安全出生区</div>
          {selected.props.map((prop) => {
            if (!prop.active) return null;
            const bounds = shapeBounds(prop.shape);
            const polygonClip =
              prop.shape.kind === "polygon"
                ? `polygon(${prop.shape.points
                    .map(
                      (point) =>
                        `${((point.x - bounds.x) / bounds.width) * 100}% ${((point.y - bounds.y) / bounds.height) * 100}%`,
                    )
                    .join(",")})`
                : undefined;
            return (
              <button
                type="button"
                key={prop.id}
                className={`board-prop ${prop.type} ${prop.shape.kind}`}
                style={{
                  left: `${(bounds.x / 1600) * 100}%`,
                  top: `${(bounds.y / 900) * 100}%`,
                  width: `${(bounds.width / 1600) * 100}%`,
                  height: `${(bounds.height / 900) * 100}%`,
                  clipPath: polygonClip,
                }}
                title={prop.label}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setDraggingPropId(prop.id);
                }}
              >
                {prop.type === "bamboo" ? "🎋" : <Flame size={22} />}
              </button>
            );
          })}
        </div>

        <div className="prop-list">
          {selected.props.map((prop) => (
            <div className="prop-row" key={prop.id}>
              <span className={`prop-icon ${prop.type}`}>
                {prop.type === "bamboo" ? <Trees size={16} /> : <Flame size={16} />}
              </span>
              <input
                value={prop.label ?? ""}
                onChange={(event) =>
                  updateBoard((board) => {
                    const item = board.props.find((candidate) => candidate.id === prop.id);
                    if (item) item.label = event.target.value;
                  })
                }
              />
              <small>{prop.shape.kind === "circle" ? `半径 ${Math.round(prop.shape.radius)}` : prop.shape.kind === "rectangle" ? `${Math.round(prop.shape.width)} × ${Math.round(prop.shape.height)}` : `${prop.shape.points.length} 个顶点`}</small>
              <label className="tiny-toggle">
                <input
                  type="checkbox"
                  checked={prop.active}
                  onChange={(event) =>
                    updateBoard((board) => {
                      const item = board.props.find((candidate) => candidate.id === prop.id);
                      if (item) item.active = event.target.checked;
                    })
                  }
                />
                启用
              </label>
              <button
                type="button"
                className="icon-button danger"
                onClick={() =>
                  updateBoard(
                    (board) =>
                      (board.props = board.props.filter((candidate) => candidate.id !== prop.id)),
                  )
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
