"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from "lucide-react";
import type { CharacterDefinition, CharacterNameLibrary } from "@/lib/game/types";

type NameLibraryEditorProps = {
  characters: CharacterDefinition[];
  libraries: CharacterNameLibrary[];
  onChange: (libraries: CharacterNameLibrary[]) => void;
};

export function NameLibraryEditor({
  characters,
  libraries,
  onChange,
}: NameLibraryEditorProps) {
  const [selectedId, setSelectedId] = useState(
    characters[0]?.id ?? "",
  );
  const [draggingIndex, setDraggingIndex] = useState<number>();
  const selectable = characters;
  const selected =
    selectable.find((character) => character.id === selectedId) ?? selectable[0];
  const names =
    libraries.find((library) => library.definitionId === selected?.id)?.names ?? [];

  if (!selected) return null;

  const replaceNames = (nextNames: string[]) => {
    const next = structuredClone(libraries);
    const library = next.find((item) => item.definitionId === selected.id);
    if (library) {
      library.names = nextNames;
    } else {
      next.push({ definitionId: selected.id, names: nextNames });
    }
    onChange(next);
  };

  const moveName = (from: number, to: number) => {
    if (to < 0 || to >= names.length || from === to) return;
    const next = [...names];
    const [name] = next.splice(from, 1);
    next.splice(to, 0, name);
    replaceNames(next);
  };

  return (
    <details className="name-library-editor">
      <summary>角色名字库 · 可排序</summary>
      <label className="name-library-kind">
        角色类别
        <select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
          {selectable.map((character) => (
            <option key={character.id} value={character.id}>
              {character.name}
            </option>
          ))}
        </select>
      </label>
      <div className="name-library-list">
        {names.map((name, index) => (
          <div
            className="name-library-row"
            key={`${selected.id}-${index}`}
            draggable
            onDragStart={() => setDraggingIndex(index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (draggingIndex !== undefined) moveName(draggingIndex, index);
              setDraggingIndex(undefined);
            }}
            onDragEnd={() => setDraggingIndex(undefined)}
          >
            <GripVertical size={13} />
            <input
              value={name}
              aria-label={`${selected.name}名字 ${index + 1}`}
              onChange={(event) =>
                replaceNames(
                  names.map((candidate, candidateIndex) =>
                    candidateIndex === index ? event.target.value : candidate,
                  ),
                )
              }
            />
            <button
              type="button"
              title="上移"
              disabled={index === 0}
              onClick={() => moveName(index, index - 1)}
            >
              <ArrowUp size={12} />
            </button>
            <button
              type="button"
              title="下移"
              disabled={index === names.length - 1}
              onClick={() => moveName(index, index + 1)}
            >
              <ArrowDown size={12} />
            </button>
            <button
              type="button"
              title="删除名字"
              onClick={() => replaceNames(names.filter((_, candidateIndex) => candidateIndex !== index))}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="add-name-button"
        onClick={() => replaceNames([...names, `${selected.name}新选手${names.length + 1}`])}
      >
        <Plus size={13} /> 添加名字
      </button>
      <p>添加同类角色时按这里的顺序取名；也可拖动左侧把手排序。</p>
    </details>
  );
}
