import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import satori from "satori";
import sharp from "sharp";
import type { Category } from "@/i18n";

const require = createRequire(import.meta.url);
const font = (pkg: string, file: string) => readFileSync(require.resolve(`${pkg}/files/${file}`));

const CAT_COLOR: Record<Category, string> = {
  ia: "#7b5cd6", android: "#3e9b4f", hardware: "#c98200", gamedev: "#d9487d", code: "#2f6fdb", homelab: "#1f8a8a", linux: "#e8743b",
};
const sprites = import.meta.glob<string>("/src/assets/sprites/*.svg", { eager: true, query: "?raw", import: "default" });
const INK = "#23222b";
const BG = "#f7f5ef";
const ACCENT = "#c2531c";

let fonts: { name: string; data: Buffer; weight: 400 | 700; style: "normal" }[] | undefined;
const loadFonts = () =>
  (fonts ??= [
    { name: "Pixelify Sans", data: font("@fontsource/pixelify-sans", "pixelify-sans-latin-700-normal.woff"), weight: 700, style: "normal" },
    { name: "Space Grotesk", data: font("@fontsource/space-grotesk", "space-grotesk-latin-700-normal.woff"), weight: 700, style: "normal" },
    { name: "JetBrains Mono", data: font("@fontsource/jetbrains-mono", "jetbrains-mono-latin-400-normal.woff"), weight: 400, style: "normal" },
  ]);

// Sprite SVG -> list of rects with colors resolved for the paper background.
function spriteRects(cat: Category) {
  const svg = Object.entries(sprites).find(([k]) => k.endsWith(`/.svg`))?.[1] ?? "";
  const out: { x: number; y: number; fill: string }[] = [];
  for (const m of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="1" height="1" fill="([^"]+)"/g)) {
    const f = m[3];
    out.push({ x: +m[1], y: +m[2], fill: f === "currentColor" ? INK : f.startsWith("var(--cat") ? CAT_COLOR[cat] : "#ffffff" });
  }
  return out;
}

type N = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): N => ({
  type,
  props: { style: { display: "flex", ...style }, ...(children !== undefined ? { children } : {}), ...extra },
});

export interface OgInput {
  title: string;
  category: Category;
  metric?: { value: string; label: string };
  kicker?: string;
}

export async function renderOg({ title, category, metric, kicker }: OgInput): Promise<Buffer> {
  const px = 18; // 16 cells * 18 = 288px sprite
  const sprite = h(
    "div",
    { position: "relative", width: 16 * px, height: 16 * px },
    spriteRects(category).map((r) =>
      h("div", { position: "absolute", left: r.x * px, top: r.y * px, width: px, height: px, backgroundColor: r.fill }),
    ),
  );
  const size = title.length > 70 ? 54 : title.length > 40 ? 64 : 76;
  const tree = h(
    "div",
    {
      width: 1200, height: 630, backgroundColor: BG, position: "relative", flexDirection: "column",
      backgroundImage: `linear-gradient(rgba(35,34,43,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(35,34,43,0.07) 1px, transparent 1px)`,
      backgroundSize: "24px 24px",
    },
    [
      h("div", { width: 1200, height: 16, backgroundColor: CAT_COLOR[category] }),
      h("div", { flex: 1, padding: "48px 64px 40px", justifyContent: "space-between" }, [
        h("div", { flexDirection: "column", justifyContent: "space-between", width: 700 }, [
          h("div", { flexDirection: "column" }, [
            h("div", { fontFamily: "JetBrains Mono", fontSize: 24, color: ACCENT, textTransform: "uppercase", letterSpacing: 3 }, kicker ?? category),
            h("div", { fontFamily: "Space Grotesk", fontWeight: 700, fontSize: size, lineHeight: 1.1, letterSpacing: -1, color: INK, marginTop: 24 }, title),
          ]),
          metric
            ? h("div", { flexDirection: "column" }, [
                h("div", { fontFamily: "Pixelify Sans", fontWeight: 700, fontSize: 84, color: ACCENT, lineHeight: 1 }, metric.value),
                h("div", { fontFamily: "JetBrains Mono", fontSize: 24, color: "#625f6e", marginTop: 8 }, metric.label),
              ])
            : h("div", {}, ""),
        ]),
        h("div", { flexDirection: "column", alignItems: "flex-end", justifyContent: "space-between" }, [
          sprite,
          h("div", { fontFamily: "JetBrains Mono", fontSize: 28, color: INK }, "parziva1.qzz.io"),
        ]),
      ]),
    ],
  );
  const svg = await satori(tree as never, { width: 1200, height: 630, fonts: loadFonts() });
  return sharp(Buffer.from(svg)).png().toBuffer();
}
