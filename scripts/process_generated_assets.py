from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "tmp" / "imagegen"
OUTPUT = ROOT / "public" / "assets"
OUTPUT.mkdir(parents=True, exist_ok=True)


def split_grid(source_name: str, columns: int, rows: int) -> list[Image.Image]:
    sheet = Image.open(SOURCE / source_name).convert("RGBA")
    width, height = sheet.size
    cells: list[Image.Image] = []
    for row in range(rows):
        top = round(row * height / rows)
        bottom = round((row + 1) * height / rows)
        for column in range(columns):
            left = round(column * width / columns)
            right = round((column + 1) * width / columns)
            cells.append(sheet.crop((left, top, right, bottom)))
    return cells


def normalize_sprite(cell: Image.Image, size: int = 512, padding: int = 28) -> Image.Image:
    alpha_box = cell.getchannel("A").getbbox()
    if alpha_box is None:
        raise ValueError("Sprite cell has no visible pixels")
    left, top, right, bottom = alpha_box
    subject = cell.crop(
        (
            max(0, left - 4),
            max(0, top - 4),
            min(cell.width, right + 4),
            min(cell.height, bottom + 4),
        )
    )
    available = size - padding * 2
    scale = min(available / subject.width, available / subject.height)
    resized = subject.resize(
        (max(1, round(subject.width * scale)), max(1, round(subject.height * scale))),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
    return canvas


def save_sprite(cell: Image.Image, filename: str) -> None:
    normalize_sprite(cell).save(OUTPUT / filename, optimize=True)


def process_replacement_assets() -> None:
    """Process the smaller, independently regenerated replacement sheets."""
    mole = split_grid("mole-v2-sheet-alpha.png", 4, 2)
    save_sprite(mole[0], "mole-idle.png")
    for index, cell_index in enumerate((1, 2, 6), start=1):
        save_sprite(mole[cell_index], f"mole-attack-{index}.png")
    for index, cell_index in enumerate((3, 4, 5, 6), start=1):
        save_sprite(mole[cell_index], f"mole-skill-{index}.png")
        save_sprite(mole[cell_index], f"mole-tunnel-{index}.png")
    save_sprite(mole[7], "mole-victory.png")

    police_four = split_grid("police-4-v2-sheet-alpha.png", 4, 1)
    save_sprite(police_four[0], "police-4-idle.png")
    for index, cell in enumerate(police_four[1:], start=1):
        save_sprite(cell, f"police-4-attack-{index}.png")

    save_sprite(
        Image.open(SOURCE / "hole-v2-alpha.png").convert("RGBA"),
        "hole.png",
    )
    save_sprite(
        Image.open(SOURCE / "rocket-v2-alpha.png").convert("RGBA"),
        "rocket.png",
    )


def process_units() -> None:
    panda = split_grid("panda-sheet-alpha.png", 4, 2)
    lazy_panda = split_grid("panda-lazy-sheet-alpha.png", 4, 2)
    mole = split_grid("mole-sheet-alpha.png", 4, 2)
    for prefix, cells in (("panda", panda), ("panda-lazy", lazy_panda), ("mole", mole)):
        save_sprite(cells[0], f"{prefix}-idle.png")
        for index in range(3):
            save_sprite(cells[index + 1], f"{prefix}-attack-{index + 1}.png")
        for index in range(4):
            save_sprite(cells[index + 4], f"{prefix}-skill-{index + 1}.png")

    mole_tunnel = split_grid("mole-tunnel-sheet-alpha.png", 4, 1)
    for index, cell in enumerate(mole_tunnel, start=1):
        save_sprite(cell, f"mole-tunnel-{index}.png")

    police = split_grid("police-sheet-alpha.png", 4, 5)
    # Five-star police uses separately curated heavy-soldier artwork already
    # tracked in public/assets. Do not overwrite it with the legacy sheet.
    for row in range(4):
        star = row + 1
        base = row * 4
        save_sprite(police[base], f"police-{star}-idle.png")
        for frame in range(3):
            save_sprite(police[base + frame + 1], f"police-{star}-attack-{frame + 1}.png")


def process_props() -> None:
    props = split_grid("props-sheet-alpha.png", 4, 1)
    for cell, filename in zip(
        props,
        ("bamboo.png", "hole.png", "rocket.png", "explosion.png"),
        strict=True,
    ):
        save_sprite(cell, filename)


def process_large_art() -> None:
    board = Image.open(SOURCE / "board-source.png").convert("RGB")
    ImageOps.fit(board, (1600, 900), method=Image.Resampling.LANCZOS).save(
        OUTPUT / "board-bamboo-lava.webp",
        "WEBP",
        quality=90,
        method=6,
    )
    landscape = Image.open(SOURCE / "board-stream-landscape-source.png").convert("RGB")
    ImageOps.fit(landscape, (1600, 900), method=Image.Resampling.LANCZOS).save(
        OUTPUT / "board-stream-landscape.webp",
        "WEBP",
        quality=90,
        method=6,
    )
    portrait = Image.open(SOURCE / "board-stream-portrait-source.png").convert("RGB")
    ImageOps.fit(portrait, (900, 1600), method=Image.Resampling.LANCZOS).save(
        OUTPUT / "board-stream-portrait.webp",
        "WEBP",
        quality=90,
        method=6,
    )
    for source_name, output_name in (
        ("board-moon-observatory-source.png", "board-portrait-moon-observatory.webp"),
        ("board-desert-oasis-source.png", "board-portrait-desert-oasis.webp"),
        ("board-aurora-platform-source.png", "board-portrait-aurora-platform.webp"),
    ):
        portrait_board = Image.open(SOURCE / source_name).convert("RGB")
        ImageOps.fit(
            portrait_board,
            (900, 1600),
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        ).save(
            OUTPUT / output_name,
            "WEBP",
            quality=90,
            method=6,
        )
    social = Image.open(SOURCE / "og-source.png").convert("RGB")
    ImageOps.fit(social, (1200, 630), method=Image.Resampling.LANCZOS).save(
        ROOT / "public" / "og.png",
        optimize=True,
    )
    panda_icon = Image.open(OUTPUT / "panda-lazy-idle.png").convert("RGBA")
    panda_icon.resize((192, 192), Image.Resampling.LANCZOS).save(
        ROOT / "public" / "icon.png",
        optimize=True,
    )


if __name__ == "__main__":
    process_units()
    process_props()
    process_large_art()
    process_replacement_assets()
    print(f"Generated game assets in {OUTPUT}")
