"use client";

import { useMemo, useRef, useState } from "react";
import {
  Check,
  CircleDot,
  CopyPlus,
  Flame,
  ImagePlus,
  MousePointer2,
  Square,
  Trash2,
  Trees,
  Undo2,
  Upload,
  Waves,
  X,
} from "lucide-react";
import { fileToDataUrl } from "@/lib/game/storage";
import type {
  BoardDefinition,
  BoardProp,
  ProjectManifest,
  RegionShape,
  Vec2,
} from "@/lib/game/types";

type BoardEditorProps = {
  manifest: ProjectManifest;
  selectedId: string;
  onSelect: (id: string) => void;
  onChange: (manifest: ProjectManifest) => void;
  onNotice: (message: string) => void;
};

type BoardTool =
  | "select"
  | "bamboo"
  | "lava-circle"
  | "lava-rectangle"
  | "lava-polygon"
  | "spring-circle"
  | "spring-rectangle"
  | "spring-polygon";

type ShapeKind = RegionShape["kind"];
type RectangleCorner = "northWest" | "northEast" | "southEast" | "southWest";

type ShapeHandle =
  | { key: string; kind: "circleCenter" | "circleRadius"; x: number; y: number; label: string }
  | {
      key: string;
      kind: "rectangleCorner";
      corner: RectangleCorner;
      x: number;
      y: number;
      label: string;
    }
  | {
      key: string;
      kind: "polygonPoint";
      pointIndex: number;
      x: number;
      y: number;
      label: string;
    };

type DraggingShapeHandle = ShapeHandle & {
  propId: string;
  anchor?: Vec2;
};

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
  if (!shape.points.length) return { x: 0, y: 0, width: 1, height: 1 };
  const xs = shape.points.map((point) => point.x);
  const ys = shape.points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(1, Math.max(...xs) - x),
    height: Math.max(1, Math.max(...ys) - y),
  };
};

const shapeHandles = (shape: RegionShape): ShapeHandle[] => {
  if (shape.kind === "circle") {
    return [
      {
        key: "circle-center",
        kind: "circleCenter",
        x: shape.x,
        y: shape.y,
        label: "拖动圆心",
      },
      {
        key: "circle-radius",
        kind: "circleRadius",
        x: shape.x + shape.radius,
        y: shape.y,
        label: "拖动调整半径",
      },
    ];
  }
  if (shape.kind === "rectangle") {
    return [
      {
        key: "rectangle-north-west",
        kind: "rectangleCorner",
        corner: "northWest",
        x: shape.x,
        y: shape.y,
        label: "拖动左上角",
      },
      {
        key: "rectangle-north-east",
        kind: "rectangleCorner",
        corner: "northEast",
        x: shape.x + shape.width,
        y: shape.y,
        label: "拖动右上角",
      },
      {
        key: "rectangle-south-east",
        kind: "rectangleCorner",
        corner: "southEast",
        x: shape.x + shape.width,
        y: shape.y + shape.height,
        label: "拖动右下角",
      },
      {
        key: "rectangle-south-west",
        kind: "rectangleCorner",
        corner: "southWest",
        x: shape.x,
        y: shape.y + shape.height,
        label: "拖动左下角",
      },
    ];
  }
  return shape.points.map((point, pointIndex) => ({
    key: `polygon-${pointIndex}`,
    kind: "polygonPoint" as const,
    pointIndex,
    x: point.x,
    y: point.y,
    label: `拖动第 ${pointIndex + 1} 个顶点`,
  }));
};

const rectangleAnchor = (
  shape: Extract<RegionShape, { kind: "rectangle" }>,
  corner: RectangleCorner,
): Vec2 => {
  if (corner === "northWest") return { x: shape.x + shape.width, y: shape.y + shape.height };
  if (corner === "northEast") return { x: shape.x, y: shape.y + shape.height };
  if (corner === "southEast") return { x: shape.x, y: shape.y };
  return { x: shape.x + shape.width, y: shape.y };
};

const moveShape = (shape: RegionShape, x: number, y: number): RegionShape => {
  const bounds = shapeBounds(shape);
  const currentCenter = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const dx = x - currentCenter.x;
  const dy = y - currentCenter.y;
  if (shape.kind === "circle") return { ...shape, x: shape.x + dx, y: shape.y + dy };
  if (shape.kind === "rectangle") return { ...shape, x: shape.x + dx, y: shape.y + dy };
  return {
    ...shape,
    points: shape.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
  };
};

const convertShape = (shape: RegionShape, kind: ShapeKind): RegionShape => {
  if (shape.kind === kind) return shape;
  const bounds = shapeBounds(shape);
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const width = Math.max(40, bounds.width);
  const height = Math.max(40, bounds.height);
  if (kind === "circle") {
    return { kind, ...center, radius: Math.max(20, Math.max(width, height) / 2) };
  }
  if (kind === "rectangle") {
    return {
      kind,
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
    };
  }
  return {
    kind,
    points: [
      { x: center.x, y: center.y - height / 2 },
      { x: center.x + width / 2, y: center.y - height / 6 },
      { x: center.x + width / 3, y: center.y + height / 2 },
      { x: center.x - width / 3, y: center.y + height / 2 },
      { x: center.x - width / 2, y: center.y - height / 6 },
    ],
  };
};

const parsePoints = (value: string): RegionShape | undefined => {
  const points = value
    .split(/[;\n]/)
    .map((pair) => pair.split(",").map((part) => Number(part.trim())))
    .filter((pair) => pair.length === 2 && pair.every(Number.isFinite))
    .map(([x, y]) => ({ x, y }));
  return points.length >= 3 ? { kind: "polygon", points } : undefined;
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
  const [draggingHandle, setDraggingHandle] = useState<DraggingShapeHandle>();
  const [selectedPropId, setSelectedPropId] = useState<string>();
  const [drawingPoints, setDrawingPoints] = useState<Vec2[]>([]);
  const [polygonDrafts, setPolygonDrafts] = useState<Record<string, string>>({});
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

  const updateProp = (propId: string, update: (prop: BoardProp) => void) => {
    updateBoard((board) => {
      const prop = board.props.find((candidate) => candidate.id === propId);
      if (prop) update(prop);
    });
  };

  const createBoard = () => {
    const id = `board-${Date.now()}`;
    const copy = structuredClone(selected);
    copy.id = id;
    copy.name = `${selected.name}副本`;
    const next = structuredClone(manifest);
    next.boards.push(copy);
    next.setup.boardId = id;
    next.updatedAt = new Date().toISOString();
    onChange(next);
    onSelect(id);
    onNotice("已复制棋盘，可继续修改画面比例、背景和区域布局");
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
    if (!rect) return { x: selected.width / 2, y: selected.height / 2 };
    return {
      x: Math.round(
        Math.max(0, Math.min(selected.width, ((clientX - rect.left) / rect.width) * selected.width)),
      ),
      y: Math.round(
        Math.max(0, Math.min(selected.height, ((clientY - rect.top) / rect.height) * selected.height)),
      ),
    };
  };

  const addBoardProp = (propType: BoardProp["type"], shape: RegionShape) => {
    const id = `${propType}-${shape.kind}-${Date.now()}`;
    const prop: BoardProp = {
      id,
      type: propType,
      active: true,
      label:
        propType === "bamboo"
          ? "新竹子"
          : `${shape.kind === "circle" ? "圆形" : shape.kind === "rectangle" ? "矩形" : "点绘"}${
              propType === "lava" ? "岩浆" : "温泉"
            }`,
      shape,
      ...(propType === "bamboo" ? {} : { buffDuration: 3, effectPerSecond: 5 }),
    };
    updateBoard((board) => board.props.push(prop));
    setSelectedPropId(id);
  };

  const chooseTool = (nextTool: BoardTool) => {
    setTool(nextTool);
    setDrawingPoints([]);
    setDraggingPropId(undefined);
    setDraggingHandle(undefined);
  };

  const addProp = (clientX: number, clientY: number) => {
    if (tool === "select") {
      setSelectedPropId(undefined);
      return;
    }
    const point = coordinatesFromPointer(clientX, clientY);
    const propType: BoardProp["type"] =
      tool === "bamboo" ? "bamboo" : tool.startsWith("spring") ? "hotSpring" : "lava";
    const kind: ShapeKind = tool.endsWith("rectangle")
      ? "rectangle"
      : tool.endsWith("polygon")
        ? "polygon"
        : "circle";
    if (kind === "polygon") {
      setDrawingPoints((points) => [...points, point]);
      return;
    }
    const scale = Math.max(0.55, Math.min(selected.width / 1600, selected.height / 900));
    const radius = Math.round((propType === "bamboo" ? 90 : 120) * scale);
    const shape: RegionShape =
      kind === "circle"
        ? { kind, ...point, radius }
        : kind === "rectangle"
          ? {
              kind,
              x: point.x - 120 * scale,
              y: point.y - 80 * scale,
              width: 240 * scale,
              height: 160 * scale,
            }
          : { kind: "polygon", points: [] };
    addBoardProp(propType, shape);
    setTool("select");
  };

  const finishPointDrawing = () => {
    if (drawingPoints.length < 3) {
      onNotice("按点绘制至少需要三个顶点");
      return;
    }
    const propType: BoardProp["type"] = tool.startsWith("spring") ? "hotSpring" : "lava";
    addBoardProp(propType, { kind: "polygon", points: drawingPoints });
    setDrawingPoints([]);
    setTool("select");
    onNotice(`已创建${propType === "lava" ? "岩浆" : "温泉"}点绘区域，可继续拖动每个顶点`);
  };

  const moveSelection = (clientX: number, clientY: number) => {
    const point = coordinatesFromPointer(clientX, clientY);
    if (draggingHandle) {
      updateProp(draggingHandle.propId, (prop) => {
        if (draggingHandle.kind === "circleCenter" && prop.shape.kind === "circle") {
          prop.shape.x = point.x;
          prop.shape.y = point.y;
        } else if (draggingHandle.kind === "circleRadius" && prop.shape.kind === "circle") {
          prop.shape.radius = Math.max(10, Math.hypot(point.x - prop.shape.x, point.y - prop.shape.y));
        } else if (
          draggingHandle.kind === "rectangleCorner" &&
          prop.shape.kind === "rectangle" &&
          draggingHandle.anchor
        ) {
          const anchor = draggingHandle.anchor;
          const width = Math.max(12, Math.abs(point.x - anchor.x));
          const height = Math.max(12, Math.abs(point.y - anchor.y));
          prop.shape.x = point.x < anchor.x ? anchor.x - width : anchor.x;
          prop.shape.y = point.y < anchor.y ? anchor.y - height : anchor.y;
          prop.shape.width = width;
          prop.shape.height = height;
        } else if (
          draggingHandle.kind === "polygonPoint" &&
          prop.shape.kind === "polygon" &&
          prop.shape.points[draggingHandle.pointIndex]
        ) {
          prop.shape.points[draggingHandle.pointIndex] = point;
        }
      });
      return;
    }
    if (!draggingPropId) return;
    updateProp(draggingPropId, (prop) => {
      prop.shape = moveShape(prop.shape, point.x, point.y);
    });
  };

  const propCounts = {
    bamboo: selected.props.filter((prop) => prop.type === "bamboo").length,
    lava: selected.props.filter((prop) => prop.type === "lava").length,
    spring: selected.props.filter((prop) => prop.type === "hotSpring").length,
  };
  const selectedPreviewProp = selected.props.find((prop) => prop.id === selectedPropId);
  const isPointDrawing = tool === "lava-polygon" || tool === "spring-polygon";

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
                <small>
                  {board.width}×{board.height} ·{" "}
                  {board.props.filter((prop) => prop.type === "bamboo").length}竹 ·{" "}
                  {board.props.filter((prop) => prop.type === "lava").length}岩浆 ·{" "}
                  {board.props.filter((prop) => prop.type === "hotSpring").length}温泉
                </small>
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
          <div className="compact-field-grid three">
            <label>
              宽度
              <input
                type="number"
                min={320}
                max={3840}
                value={selected.width}
                onChange={(event) =>
                  updateBoard((board) => (board.width = Math.max(320, Number(event.target.value))))
                }
              />
            </label>
            <label>
              高度
              <input
                type="number"
                min={320}
                max={3840}
                value={selected.height}
                onChange={(event) =>
                  updateBoard((board) => (board.height = Math.max(320, Number(event.target.value))))
                }
              />
            </label>
            <label>
              角色比例
              <input
                type="number"
                min={0.5}
                max={3}
                step={0.05}
                value={selected.unitScale ?? 1}
                onChange={(event) =>
                  updateBoard((board) => (board.unitScale = Math.max(0.5, Number(event.target.value))))
                }
              />
            </label>
          </div>
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
            <span className="eyebrow">
              Board builder · {selected.width} × {selected.height}
            </span>
            <h1>{selected.name}</h1>
            <p>圆形和矩形可快速添加；点绘区域可逐点勾勒，选中后直接拖动圆心、边角或任意顶点。</p>
          </div>
          <div className="board-stats">
            <span><Trees size={15} /> {propCounts.bamboo}</span>
            <span><Flame size={15} /> {propCounts.lava}</span>
            <span><Waves size={15} /> {propCounts.spring}</span>
          </div>
        </div>

        <div className="board-toolbar">
          {([
            ["select", "选择", MousePointer2],
            ["bamboo", "竹子范围", Trees],
            ["lava-circle", "圆形岩浆", CircleDot],
            ["lava-rectangle", "矩形岩浆", Square],
            ["lava-polygon", "点绘岩浆", Flame],
            ["spring-circle", "圆形温泉", CircleDot],
            ["spring-rectangle", "矩形温泉", Square],
            ["spring-polygon", "点绘温泉", Waves],
          ] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              className={`${tool === id ? "is-active" : ""} ${id.startsWith("spring") ? "spring-tool" : ""}`}
              onClick={() => chooseTool(id)}
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

        {isPointDrawing && (
          <div className={`point-draw-guide ${tool.startsWith("spring") ? "is-spring" : "is-lava"}`}>
            <span>
              在棋盘上依次点击顶点
              <strong>{drawingPoints.length} 个点</strong>
            </span>
            <div className="point-draw-actions">
              <button
                type="button"
                onClick={() => setDrawingPoints((points) => points.slice(0, -1))}
                disabled={!drawingPoints.length}
              >
                <Undo2 size={14} /> 撤回一点
              </button>
              <button
                type="button"
                onClick={() => {
                  setDrawingPoints([]);
                  setTool("select");
                }}
              >
                <X size={14} /> 取消
              </button>
              <button
                type="button"
                className="finish-drawing"
                onClick={finishPointDrawing}
                disabled={drawingPoints.length < 3}
              >
                <Check size={14} /> 闭合并创建
              </button>
            </div>
          </div>
        )}

        <div
          ref={previewRef}
          className={`board-preview tool-${tool}`}
          style={{
            aspectRatio: `${selected.width} / ${selected.height}`,
            ...(background
              ? {
                  backgroundImage: `linear-gradient(rgba(10, 15, 13, .06), rgba(10, 15, 13, .18)), url("${background.url}")`,
                }
              : {}),
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) addProp(event.clientX, event.clientY);
          }}
          onPointerMove={(event) => moveSelection(event.clientX, event.clientY)}
          onPointerUp={() => {
            setDraggingPropId(undefined);
            setDraggingHandle(undefined);
          }}
          onPointerCancel={() => {
            setDraggingPropId(undefined);
            setDraggingHandle(undefined);
          }}
          onPointerLeave={() => {
            setDraggingPropId(undefined);
            setDraggingHandle(undefined);
          }}
        >
          {isPointDrawing && drawingPoints.length > 0 && (
            <svg
              className={`board-drawing-layer ${tool.startsWith("spring") ? "is-spring" : "is-lava"}`}
              viewBox={`0 0 ${selected.width} ${selected.height}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {drawingPoints.length >= 3 && (
                <polygon
                  points={drawingPoints.map((point) => `${point.x},${point.y}`).join(" ")}
                  className="draft-region-fill"
                />
              )}
              <polyline
                points={drawingPoints.map((point) => `${point.x},${point.y}`).join(" ")}
                className="draft-region-line"
              />
              {drawingPoints.map((point, index) => (
                <g key={`${point.x}-${point.y}-${index}`}>
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={Math.max(7, selected.width / 190)}
                    className="draft-region-point"
                  />
                  <text
                    x={point.x}
                    y={point.y}
                    dy="0.34em"
                    textAnchor="middle"
                    className="draft-region-index"
                  >
                    {index + 1}
                  </text>
                </g>
              ))}
            </svg>
          )}

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
                className={`board-prop ${prop.type} ${prop.shape.kind} ${
                  selectedPropId === prop.id ? "is-selected" : ""
                }`}
                style={{
                  left: `${(bounds.x / selected.width) * 100}%`,
                  top: `${(bounds.y / selected.height) * 100}%`,
                  width: `${(bounds.width / selected.width) * 100}%`,
                  height: `${(bounds.height / selected.height) * 100}%`,
                  clipPath: polygonClip,
                }}
                title={prop.label}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setSelectedPropId(prop.id);
                  setDraggingHandle(undefined);
                  setDraggingPropId(prop.id);
                }}
              >
                {prop.type === "bamboo" ? (
                  "🎋"
                ) : prop.type === "hotSpring" ? (
                  <Waves size={22} />
                ) : (
                  <Flame size={22} />
                )}
              </button>
            );
          })}

          {tool === "select" &&
            selectedPreviewProp?.active &&
            shapeHandles(selectedPreviewProp.shape).map((handle) => (
              <button
                type="button"
                className={`board-shape-handle handle-${handle.kind}`}
                key={`${selectedPreviewProp.id}-${handle.key}`}
                style={{
                  left: `${(handle.x / selected.width) * 100}%`,
                  top: `${(handle.y / selected.height) * 100}%`,
                }}
                title={handle.label}
                aria-label={handle.label}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setDraggingPropId(undefined);
                  setDraggingHandle({
                    ...handle,
                    propId: selectedPreviewProp.id,
                    ...(handle.kind === "rectangleCorner" &&
                    selectedPreviewProp.shape.kind === "rectangle"
                      ? {
                          anchor: rectangleAnchor(selectedPreviewProp.shape, handle.corner),
                        }
                      : {}),
                  });
                }}
              >
                {handle.kind === "polygonPoint" ? handle.pointIndex + 1 : ""}
              </button>
            ))}
        </div>

        <div className="prop-list">
          {selected.props.map((prop) => (
            <article
              className={`prop-editor ${selectedPropId === prop.id ? "is-selected" : ""}`}
              key={prop.id}
              onClick={() => setSelectedPropId(prop.id)}
            >
              <div className="prop-editor-heading">
                <span className={`prop-icon ${prop.type}`}>
                  {prop.type === "bamboo" ? (
                    <Trees size={16} />
                  ) : prop.type === "hotSpring" ? (
                    <Waves size={16} />
                  ) : (
                    <Flame size={16} />
                  )}
                </span>
                <input
                  value={prop.label ?? ""}
                  aria-label="区域名称"
                  onChange={(event) => updateProp(prop.id, (item) => (item.label = event.target.value))}
                />
                <label className="tiny-toggle">
                  <input
                    type="checkbox"
                    checked={prop.active}
                    onChange={(event) =>
                      updateProp(prop.id, (item) => (item.active = event.target.checked))
                    }
                  />
                  启用
                </label>
                <button
                  type="button"
                  className="icon-button danger"
                  title="删除区域"
                  onClick={() => {
                    updateBoard(
                      (board) =>
                        (board.props = board.props.filter((candidate) => candidate.id !== prop.id)),
                    );
                    if (selectedPropId === prop.id) setSelectedPropId(undefined);
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="prop-editor-fields">
                <label>
                  区域类型
                  <select
                    value={prop.type}
                    onChange={(event) =>
                      updateProp(prop.id, (item) => {
                        item.type = event.target.value as BoardProp["type"];
                        if (item.type !== "bamboo") {
                          item.buffDuration ??= 3;
                          item.effectPerSecond ??= 5;
                        }
                      })
                    }
                  >
                    <option value="bamboo">竹子触发范围</option>
                    <option value="lava">岩浆燃烧区</option>
                    <option value="hotSpring">温泉回血区</option>
                  </select>
                </label>
                <label>
                  边界形状
                  <select
                    value={prop.shape.kind}
                    onChange={(event) =>
                      updateProp(
                        prop.id,
                        (item) =>
                          (item.shape = convertShape(item.shape, event.target.value as ShapeKind)),
                      )
                    }
                  >
                    <option value="circle">圆形</option>
                    <option value="rectangle">矩形</option>
                    <option value="polygon">多边形</option>
                  </select>
                </label>
                {prop.type !== "bamboo" && (
                  <>
                    <label>
                      离开后持续（秒）
                      <input
                        type="number"
                        min={0}
                        max={30}
                        step={0.1}
                        value={prop.buffDuration ?? 3}
                        onChange={(event) =>
                          updateProp(prop.id, (item) => (item.buffDuration = Number(event.target.value)))
                        }
                      />
                    </label>
                    <label>
                      每秒{prop.type === "lava" ? "扣血" : "回血"}
                      <input
                        type="number"
                        min={0}
                        max={500}
                        step={0.5}
                        value={prop.effectPerSecond ?? 5}
                        onChange={(event) =>
                          updateProp(prop.id, (item) => (item.effectPerSecond = Number(event.target.value)))
                        }
                      />
                    </label>
                  </>
                )}
                {prop.shape.kind === "circle" && (
                  <>
                    {(["x", "y", "radius"] as const).map((field) => (
                      <label key={field}>
                        {field === "x" ? "中心 X" : field === "y" ? "中心 Y" : "触发半径"}
                        <input
                          type="number"
                          min={field === "radius" ? 1 : 0}
                          value={Math.round(
                            (prop.shape as Extract<RegionShape, { kind: "circle" }>)[field],
                          )}
                          onChange={(event) =>
                            updateProp(prop.id, (item) => {
                              if (item.shape.kind === "circle") {
                                item.shape[field] = Number(event.target.value);
                              }
                            })
                          }
                        />
                      </label>
                    ))}
                  </>
                )}
                {prop.shape.kind === "rectangle" && (
                  <>
                    {(["x", "y", "width", "height"] as const).map((field) => (
                      <label key={field}>
                        {field === "x"
                          ? "左边界 X"
                          : field === "y"
                            ? "上边界 Y"
                            : field === "width"
                              ? "区域宽度"
                              : "区域高度"}
                        <input
                          type="number"
                          min={field === "width" || field === "height" ? 1 : 0}
                          value={Math.round(
                            (prop.shape as Extract<RegionShape, { kind: "rectangle" }>)[field],
                          )}
                          onChange={(event) =>
                            updateProp(prop.id, (item) => {
                              if (item.shape.kind === "rectangle") {
                                item.shape[field] = Number(event.target.value);
                              }
                            })
                          }
                        />
                      </label>
                    ))}
                  </>
                )}
                {prop.shape.kind === "polygon" && (
                  <label className="polygon-points-field">
                    多边形顶点（X,Y；每点一行或分号分隔）
                    <textarea
                      value={
                        polygonDrafts[prop.id] ??
                        prop.shape.points
                          .map((point) => `${Math.round(point.x)}, ${Math.round(point.y)}`)
                          .join(";\n")
                      }
                      onChange={(event) =>
                        setPolygonDrafts((drafts) => ({
                          ...drafts,
                          [prop.id]: event.target.value,
                        }))
                      }
                      onBlur={(event) => {
                        const parsed = parsePoints(event.currentTarget.value);
                        if (parsed) {
                          updateProp(prop.id, (item) => (item.shape = parsed));
                        } else {
                          onNotice("多边形至少需要三个有效的 X,Y 顶点");
                        }
                        setPolygonDrafts((drafts) => {
                          const next = { ...drafts };
                          delete next[prop.id];
                          return next;
                        });
                      }}
                    />
                  </label>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
