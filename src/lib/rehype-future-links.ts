import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { visit } from "unist-util-visit";
import type { Root, Element, ElementContent } from "hast";

// Posts are published on a schedule (future pubDate), so a series post may link to a part that is not
// live yet. Such links become plain text with a "coming soon" note until the target goes live.
const SHOW_ALL = process.env.SHOW_DRAFTS === "1" || process.env.NODE_ENV === "development";
const POSTS_DIR = join(process.cwd(), "src", "content", "posts");
const LINK = /^\/(en\/)?posts\/([a-z0-9-]+)\/?(#.*)?$/;

function liveSlugs(): Set<string> {
  const live = new Set<string>();
  for (const lang of ["es", "en"]) {
    let files: string[] = [];
    try {
      files = readdirSync(join(POSTS_DIR, lang)).filter((f) => /^[^_].*\.mdx?$/.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const fm = readFileSync(join(POSTS_DIR, lang, f), "utf8").split(/^---$/m)[1] ?? "";
      const draft = /^draft:\s*true\s*$/m.test(fm);
      const date = Date.parse((fm.match(/^pubDate:\s*["']?([^"'\n]+)/m)?.[1] ?? "").trim());
      if (!draft && !Number.isNaN(date) && date <= Date.now()) live.add(`${lang}/${f.replace(/\.mdx?$/, "")}`);
    }
  }
  return live;
}

export default function rehypeFutureLinks() {
  return (tree: Root) => {
    if (SHOW_ALL) return;
    const live = liveSlugs();
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "a" || !parent || index === undefined) return;
      const m = String(node.properties?.href ?? "").match(LINK);
      if (!m) return;
      const lang = m[1] ? "en" : "es";
      if (live.has(`${lang}/${m[2]}`)) return;
      const note: ElementContent = { type: "text", value: lang === "en" ? " (coming soon)" : " (próximamente)" };
      parent.children[index] = {
        type: "element",
        tagName: "span",
        properties: { className: ["link-soon"] },
        children: [...node.children, note],
      };
    });
  };
}
