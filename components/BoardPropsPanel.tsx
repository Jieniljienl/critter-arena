import { Boxes, Eraser, Trash2 } from "lucide-react";
import type { BoardProp, RegionShape, RuntimeHole } from "@/lib/game/types";

type BoardPropsPanelProps = {
  boardName: string;
  props: BoardProp[];
  holes: RuntimeHole[];
  onUpdateProp?: (
    propId: string,
    changes: Partial<Pick<BoardProp, "active" | "buffDuration" | "effectPerSecond">>,
  ) => void;
  onRemoveProp?: (propId: string) => void;
  onClearProps?: () => void;
};

const propMeta: Record<
  BoardProp["type"],
  { name: string; shortName: string; glyph: string; className: string }
> = {
  bamboo: {
    name: "竹子",
    shortName: "竹子",
    glyph: "竹",
    className: "prop-bamboo",
  },
  lava: {
    name: "岩浆",
    shortName: "岩浆",
    glyph: "火",
    className: "prop-lava",
  },
  hotSpring: {
    name: "温泉",
    shortName: "温泉",
    glyph: "泉",
    className: "prop-hot-spring",
  },
};

const readableNumber = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

const describeShape = (shape: RegionShape) => {
  if (shape.kind === "circle") {
    return `圆形范围 · 半径 ${Math.round(shape.radius)}`;
  }
  if (shape.kind === "rectangle") {
    return `矩形范围 · ${Math.round(shape.width)} × ${Math.round(shape.height)}`;
  }
  if (!shape.points.length) return "多边形范围";
  const xs = shape.points.map((point) => point.x);
  const ys = shape.points.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return `多边形 · ${shape.points.length} 点 · ${Math.round(width)} × ${Math.round(height)}`;
};

const describeEffect = (prop: BoardProp) => {
  if (prop.type === "bamboo") return "熊猫靠近后可触发进食";
  const duration = readableNumber(prop.buffDuration ?? 3);
  const rate = readableNumber(prop.effectPerSecond ?? 5);
  if (prop.type === "lava") return `燃烧 -${rate} HP/秒 · 离开后持续 ${duration} 秒`;
  return `回血 +${rate} HP/秒 · 离开后持续 ${duration} 秒`;
};

const propState = (prop: BoardProp) => {
  if (prop.active) return prop.type === "bamboo" ? "可进食" : "生效中";
  return prop.type === "bamboo" ? "已吃完" : "已关闭";
};

export function BoardPropsPanel({
  boardName,
  props,
  holes,
  onUpdateProp,
  onRemoveProp,
  onClearProps,
}: BoardPropsPanelProps) {
  const counts = {
    bamboo: props.filter((prop) => prop.type === "bamboo"),
    lava: props.filter((prop) => prop.type === "lava"),
    hotSpring: props.filter((prop) => prop.type === "hotSpring"),
  };
  const activePropCount = props.filter((prop) => prop.active).length;
  const currentCount = activePropCount + holes.length;

  return (
    <section className="sidebar-section current-props-section">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">CURRENT BOARD</span>
          <h2>当前棋盘道具</h2>
        </div>
        <div className="sidebar-heading-actions">
          <span className="current-props-total" title="当前仍在棋盘上生效的道具数量">
            <Boxes size={15} />
            <strong>{currentCount}</strong>
          </span>
          {onClearProps && (
            <button
              type="button"
              className="sidebar-danger-button"
              onClick={onClearProps}
              disabled={!props.length && !holes.length}
              title="清空当前棋盘的全部初始道具，并重置本局运行时洞口"
            >
              <Eraser size={13} /> 清空
            </button>
          )}
        </div>
      </div>

      <p className="current-board-name" title={boardName}>
        {boardName}
      </p>

      <div className="current-props-overview" aria-label="当前棋盘道具数量">
        {(Object.keys(counts) as Array<keyof typeof counts>).map((type) => {
          const entries = counts[type];
          const active = entries.filter((prop) => prop.active).length;
          return (
            <span className={`prop-count-chip ${propMeta[type].className}`} key={type}>
              <small>{propMeta[type].shortName}</small>
              <strong>
                {active}/{entries.length}
              </strong>
            </span>
          );
        })}
        <span className="prop-count-chip prop-hole">
          <small>洞口</small>
          <strong>{holes.length}</strong>
        </span>
      </div>

      <div className="current-props-list">
        {props.map((prop) => {
          const meta = propMeta[prop.type];
          return (
            <article
              className={`current-prop-item ${meta.className}${prop.active ? "" : " is-inactive"}`}
              key={prop.id}
            >
              <span className="current-prop-mark" aria-hidden="true">
                {meta.glyph}
              </span>
              <div className="current-prop-copy">
                <div className="current-prop-name">
                  <strong>{prop.label || meta.name}</strong>
                  <span>{propState(prop)}</span>
                </div>
                <p>{describeEffect(prop)}</p>
                <small>{describeShape(prop.shape)}</small>
                {(onUpdateProp || onRemoveProp) && (
                  <div className="current-prop-controls">
                    {onUpdateProp && (
                      <label>
                        <input
                          type="checkbox"
                          checked={prop.active}
                          onChange={(event) =>
                            onUpdateProp(prop.id, { active: event.target.checked })
                          }
                        />
                        启用
                      </label>
                    )}
                    {onUpdateProp && prop.type !== "bamboo" && (
                      <>
                        <label>
                          每秒
                          <input
                            type="number"
                            min={0}
                            step={0.5}
                            value={prop.effectPerSecond ?? 5}
                            onChange={(event) =>
                              onUpdateProp(prop.id, {
                                effectPerSecond: Number(event.target.value),
                              })
                            }
                          />
                        </label>
                        <label>
                          离场
                          <input
                            type="number"
                            min={0}
                            step={0.1}
                            value={prop.buffDuration ?? 3}
                            onChange={(event) =>
                              onUpdateProp(prop.id, {
                                buffDuration: Number(event.target.value),
                              })
                            }
                          />
                        </label>
                      </>
                    )}
                    {onRemoveProp && (
                      <button
                        type="button"
                        onClick={() => onRemoveProp(prop.id)}
                        title={`移除${prop.label || meta.name}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </article>
          );
        })}

        {holes.map((hole, index) => (
          <article className="current-prop-item prop-hole" key={hole.id}>
            <span className="current-prop-mark" aria-hidden="true">
              洞
            </span>
            <div className="current-prop-copy">
              <div className="current-prop-name">
                <strong>通用洞口 {index + 1}</strong>
                <span>
                  耐久 {hole.stompsRemaining}/{hole.stompsRequired}
                </span>
              </div>
              <p>双方地鼠均可借道偷袭</p>
              <small>圆形范围 · 半径 {Math.round(hole.radius)}</small>
            </div>
          </article>
        ))}

        {!props.length && !holes.length && (
          <div className="current-props-empty">
            <Boxes size={22} />
            <p>当前棋盘没有配置道具。</p>
          </div>
        )}
      </div>
    </section>
  );
}
