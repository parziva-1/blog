// Gráfica "todo lo que probé" de Inkling 2 Mini en la RTX 3050 Laptop, con la estética del blog (satori + sharp,
// mismas fuentes y colores que src/lib/og.ts). Uso: node scripts/chart-inkling.mjs es|en salida.png
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import satori from "satori";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const font = (pkg, file) => readFileSync(require.resolve(`${pkg}/files/${file}`));
const fonts = [
  { name: "Space Grotesk", data: font("@fontsource/space-grotesk", "space-grotesk-latin-700-normal.woff"), weight: 700, style: "normal" },
  { name: "Space Grotesk", data: font("@fontsource/space-grotesk", "space-grotesk-latin-500-normal.woff"), weight: 500, style: "normal" },
  { name: "IBM Plex Sans", data: font("@fontsource/ibm-plex-sans", "ibm-plex-sans-latin-400-normal.woff"), weight: 400, style: "normal" },
  { name: "JetBrains Mono", data: font("@fontsource/jetbrains-mono", "jetbrains-mono-latin-400-normal.woff"), weight: 400, style: "normal" },
  { name: "JetBrains Mono", data: font("@fontsource/jetbrains-mono", "jetbrains-mono-latin-700-normal.woff"), weight: 700, style: "normal" },
];

const INK = "#23222b", BG = "#f7f5ef", MUTED = "#625f6e", RULE = "#dcd8cc", ACCENT = "#c2531c", IA = "#7b5cd6";
const lang = process.argv[2] === "en" ? "en" : "es";
const out = process.argv[3] ?? `inkling-${lang}.png`;
const T = {
  es: {
    kicker: "IA · RTX 3050 LAPTOP · 6 GB VRAM",
    title: "Inkling 2 Mini: todo lo que probé en 6 GB de VRAM",
    sub: "Mismo prompt de 2385 tokens · llama-server · Ryzen 5 7535HS + 32 GB DDR5",
    pp: "Prefill (tok/s)", tg: "Generación (tok/s)",
    note: "Referencia en la misma GPU: Qwen3.6-35B-A3B Q4_K + MTP, 400-557 de prefill y 32-34 generando.",
    rows: [
      ["Q3_K_XL", "llama.cpp b12703 · 7 de 12 capas del bucle en GPU"],
      ["Q3_K_XL", "build de Unsloth b12675-mix"],
      ["Q3_K_XL + DSpark", "Unsloth · borrador especulativo"],
      ["Q3_K_XL", "Strata 0.1.69 (motor propio)"],
      ["UD-IQ2_XXS", "bucle entero en GPU · sin op offload"],
      ["UD-IQ2_XXS", "bucle entero en GPU · op offload · 16k"],
      ["UD-IQ2_XXS + LoRA", "LoRA sin censura de AtomicChat"],
      ["AD-IQ2_M sin censura", "AtomicChat · mismo setup · 32k"],
    ],
    x: (k) => `${k}× vs oficial`,
  },
  en: {
    kicker: "AI · RTX 3050 LAPTOP · 6 GB VRAM",
    title: "Inkling 2 Mini: everything I tried on 6 GB of VRAM",
    sub: "Same 2,385-token prompt · llama-server · Ryzen 5 7535HS + 32 GB DDR5",
    pp: "Prefill (tok/s)", tg: "Generation (tok/s)",
    note: "Reference on the same GPU: Qwen3.6-35B-A3B Q4_K + MTP, 400-557 prefill and 32-34 generation.",
    rows: [
      ["Q3_K_XL", "llama.cpp b12703 · 7 of 12 loop layers on GPU"],
      ["Q3_K_XL", "Unsloth b12675-mix build"],
      ["Q3_K_XL + DSpark", "Unsloth · speculative drafter"],
      ["Q3_K_XL", "Strata 0.1.69 (own engine)"],
      ["UD-IQ2_XXS", "full loop on GPU · no op offload"],
      ["UD-IQ2_XXS", "full loop on GPU · op offload · 16k"],
      ["UD-IQ2_XXS + LoRA", "AtomicChat uncensored LoRA"],
      ["AD-IQ2_M uncensored", "AtomicChat · same setup · 32k"],
    ],
    x: (k) => `${k}× vs mainline`,
  },
}[lang];

// prefill, generación, resaltar
const DATA = [[38, 17.6], [48, 19.5], [42, 11.2], [94, 9.5], [138, 27.2], [436, 27.2, true], [343, 20.7], [370, 23.8]];
const fmt = (v, dec) => (lang === "es" ? v.toFixed(dec).replace(".", ",") : v.toFixed(dec));

const W = 1600, H = 1000;
const LABEL_W = 470, PP_W = 470, TG_W = 330, PP_MAX = 500, TG_MAX = 30, ROW_H = 74, BAR_H = 34;

const h = (type, style, children, extra = {}) => ({
  type, props: { style: { display: "flex", ...style }, ...(children !== undefined ? { children } : {}), ...extra },
});

const bar = (v, max, w, hi, dec, ratio) =>
  h("div", { width: w + 90, alignItems: "center" }, [
    h("div", {
      width: Math.max(4, Math.round((v / max) * w)), height: BAR_H,
      backgroundColor: hi ? ACCENT : RULE, border: `2px solid ${INK}`,
      boxShadow: `3px 3px 0 ${INK}`, alignItems: "center", justifyContent: "flex-end", paddingRight: 10,
    }, ratio ? h("div", { fontFamily: "JetBrains Mono", fontWeight: 700, fontSize: 17, color: "#ffffff" }, ratio) : ""),
    h("div", {
      fontFamily: hi ? "Space Grotesk" : "JetBrains Mono", fontWeight: 700, fontSize: hi ? 30 : 22,
      color: hi ? ACCENT : INK, marginLeft: 14,
    }, fmt(v, dec)),
  ]);

const rows = DATA.map(([pp, tg, hi], i) => {
  const [name, detail] = T.rows[i];
  return h("div", { height: ROW_H, alignItems: "center" }, [
    h("div", { width: LABEL_W, flexDirection: "column", alignItems: "flex-end", paddingRight: 28 }, [
      h("div", { fontFamily: "Space Grotesk", fontWeight: 700, fontSize: hi ? 28 : 24, color: INK }, name),
      h("div", { fontFamily: "IBM Plex Sans", fontSize: 16, color: hi ? ACCENT : MUTED, marginTop: 2 }, detail),
    ]),
    bar(pp, PP_MAX, PP_W, hi, 0, hi ? T.x(fmt(pp / DATA[0][0], 1)) : null),
    h("div", { width: 40 }, ""),
    bar(tg, TG_MAX, TG_W, hi, 1, hi ? T.x(fmt(tg / DATA[0][1], 1)) : null),
  ]);
});

const head = h("div", { height: 40, alignItems: "flex-end", marginBottom: 6 }, [
  h("div", { width: LABEL_W }, ""),
  h("div", { width: PP_W + 90, fontFamily: "JetBrains Mono", fontSize: 20, color: MUTED, textTransform: "uppercase", letterSpacing: 1 }, T.pp),
  h("div", { width: 40 }, ""),
  h("div", { width: TG_W + 90, fontFamily: "JetBrains Mono", fontSize: 20, color: MUTED, textTransform: "uppercase", letterSpacing: 1 }, T.tg),
]);

const tree = h("div", {
  width: W, height: H, backgroundColor: BG, flexDirection: "column",
  backgroundImage: "linear-gradient(rgba(35,34,43,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(35,34,43,0.07) 1px, transparent 1px)",
  backgroundSize: "24px 24px",
}, [
  h("div", { width: W, height: 16, backgroundColor: IA }),
  h("div", { flexDirection: "column", padding: "40px 64px 0" }, [
    h("div", { fontFamily: "JetBrains Mono", fontSize: 22, color: ACCENT, letterSpacing: 3 }, T.kicker),
    h("div", { fontFamily: "Space Grotesk", fontWeight: 700, fontSize: 56, color: INK, letterSpacing: -1, marginTop: 12, lineHeight: 1.05 }, T.title),
    h("div", { fontFamily: "IBM Plex Sans", fontSize: 21, color: MUTED, marginTop: 10 }, T.sub),
  ]),
  h("div", { flexDirection: "column", padding: "34px 64px 0 0" }, [head, ...rows]),
  h("div", { flex: 1 }, ""),
  h("div", { padding: "0 64px 34px", justifyContent: "space-between", alignItems: "flex-end" }, [
    h("div", { fontFamily: "IBM Plex Sans", fontSize: 18, color: MUTED, width: 1100 }, T.note),
    h("div", { fontFamily: "JetBrains Mono", fontSize: 24, color: INK }, "parziva1.qzz.io"),
  ]),
]);

const svg = await satori(tree, { width: W, height: H, fonts });
writeFileSync(out, await sharp(Buffer.from(svg)).png().toBuffer());
console.log(out);
