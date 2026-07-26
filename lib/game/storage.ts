import Dexie, { type EntityTable } from "dexie";
import JSZip from "jszip";
import { z } from "zod";
import { upgradeManifest } from "./defaultContent";
import type { ProjectManifest } from "./types";

type StoredProject = {
  id: string;
  manifest: ProjectManifest;
  updatedAt: string;
};

class ArenaDatabase extends Dexie {
  projects!: EntityTable<StoredProject, "id">;

  constructor() {
    super("critter-arena");
    this.version(1).stores({
      projects: "id, updatedAt",
    });
  }
}

let database: ArenaDatabase | undefined;

const getDatabase = (): ArenaDatabase => {
  database ??= new ArenaDatabase();
  return database;
};

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1),
    assets: z.array(
      z.object({
        id: z.string().min(1),
        kind: z.enum(["image", "audio"]),
        url: z.string().min(1),
        name: z.string().optional(),
        mime: z.string().optional(),
      }),
    ),
    characters: z.array(
      z
        .object({
          schemaVersion: z.literal(1),
          id: z.string().min(1),
          name: z.string().min(1),
          role: z.enum(["contestant", "summon"]),
          maxHp: z.number().positive(),
          speed: z.number().nonnegative(),
          radius: z.number().positive(),
          attack: z.object({
            range: z.number().positive(),
            damage: z.number().nonnegative(),
            cooldown: z.number().positive(),
            windup: z.number().nonnegative(),
            mode: z.enum(["melee", "projectile", "burst", "gatling"]),
          }).passthrough(),
        })
        .passthrough(),
    ),
    boards: z.array(
      z
        .object({
          schemaVersion: z.literal(1),
          id: z.string().min(1),
          name: z.string().min(1),
          width: z.number().positive(),
          height: z.number().positive(),
          props: z.array(z.unknown()),
        })
        .passthrough(),
    ),
    setup: z
      .object({
        schemaVersion: z.literal(1),
        boardId: z.string().min(1),
        seed: z.number().int(),
        contestants: z.array(
          z
            .object({
              id: z.string().min(1),
              definitionId: z.string().min(1),
              displayName: z.string().min(1),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
    updatedAt: z.string(),
  })
  .passthrough();

export const validateManifest = (value: unknown): ProjectManifest => {
  const parsed = upgradeManifest(manifestSchema.parse(value) as ProjectManifest);
  const characterIds = new Set(parsed.characters.map((character) => character.id));
  const boardIds = new Set(parsed.boards.map((board) => board.id));
  const assetIds = new Set(parsed.assets.map((asset) => asset.id));
  const errors: string[] = [];

  if (!boardIds.has(parsed.setup.boardId)) errors.push(`开战配置引用了不存在的棋盘：${parsed.setup.boardId}`);
  for (const contestant of parsed.setup.contestants) {
    if (!characterIds.has(contestant.definitionId)) {
      errors.push(`角色实例 ${contestant.displayName} 引用了不存在的角色`);
    }
  }
  for (const character of parsed.characters) {
    if (!assetIds.has(character.portraitAssetId)) {
      errors.push(`角色 ${character.name} 缺少主图片资源`);
    }
  }
  for (const board of parsed.boards) {
    if (!assetIds.has(board.backgroundAssetId)) {
      errors.push(`棋盘 ${board.name} 缺少背景图片资源`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return parsed;
};

export const saveManifest = async (manifest: ProjectManifest): Promise<void> => {
  if (typeof indexedDB === "undefined") return;
  await getDatabase().projects.put({
    id: "active",
    manifest,
    updatedAt: manifest.updatedAt,
  });
};

export const loadManifest = async (): Promise<ProjectManifest | undefined> => {
  if (typeof indexedDB === "undefined") return undefined;
  const saved = await getDatabase().projects.get("active");
  if (!saved) return undefined;
  return validateManifest(saved.manifest);
};

const safeFilename = (value: string): string =>
  value
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "critter-arena";

const triggerDownload = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const exportJson = (manifest: ProjectManifest): void => {
  triggerDownload(
    new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }),
    `${safeFilename(manifest.name)}.json`,
  );
};

const extensionForMime = (mime: string | undefined, kind: "image" | "audio"): string => {
  if (mime?.includes("webp")) return "webp";
  if (mime?.includes("jpeg")) return "jpg";
  if (mime?.includes("ogg")) return "ogg";
  if (mime?.includes("mpeg")) return "mp3";
  if (mime?.includes("wav")) return "wav";
  return kind === "image" ? "png" : "bin";
};

export const exportBundle = async (manifest: ProjectManifest): Promise<void> => {
  const zip = new JSZip();
  const bundled = structuredClone(manifest);
  for (const asset of bundled.assets) {
    try {
      const response = await fetch(asset.url);
      if (!response.ok) continue;
      const blob = await response.blob();
      const extension = extensionForMime(asset.mime ?? blob.type, asset.kind);
      const path = `assets/${safeFilename(asset.id)}.${extension}`;
      zip.file(path, blob);
      asset.url = path;
      asset.mime = asset.mime ?? blob.type;
    } catch {
      // Keep the original URL; import validation will explain a missing remote asset.
    }
  }
  zip.file("manifest.json", JSON.stringify(bundled, null, 2));
  const archive = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  triggerDownload(archive, `${safeFilename(manifest.name)}.critter.zip`);
};

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

export const importProjectFile = async (file: File): Promise<ProjectManifest> => {
  if (file.name.toLowerCase().endsWith(".zip")) {
    const zip = await JSZip.loadAsync(file);
    const entry = zip.file("manifest.json");
    if (!entry) throw new Error("压缩包内缺少 manifest.json");
    const raw = JSON.parse(await entry.async("string")) as ProjectManifest;
    for (const asset of raw.assets) {
      if (!asset.url.startsWith("assets/")) continue;
      const assetEntry = zip.file(asset.url);
      if (!assetEntry) throw new Error(`压缩包缺少素材：${asset.url}`);
      const blob = await assetEntry.async("blob");
      asset.url = await blobToDataUrl(
        new Blob([blob], { type: asset.mime || blob.type || "application/octet-stream" }),
      );
    }
    return validateManifest(raw);
  }
  return validateManifest(JSON.parse(await file.text()));
};

export const fileToDataUrl = blobToDataUrl;
