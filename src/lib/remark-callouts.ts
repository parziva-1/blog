import { visit } from "unist-util-visit";
import type { Root, Blockquote, Paragraph, Text } from "mdast";
import type { VFile } from "vfile";
import { es } from "@/i18n/es";
import { en } from "@/i18n/en";

// `> [!NOTE]`, `> [!WARNING]`, `> [!FAIL]` -> <div class="callout callout-*"> with a localized title.
const KINDS: Record<string, "note" | "warn" | "fail"> = { NOTE: "note", TIP: "note", WARNING: "warn", FAIL: "fail" };

export default function remarkCallouts() {
  return (tree: Root, file: VFile) => {
    const lang = /[\\/]posts[\\/]en[\\/]/.test(file.path ?? "") ? en : es;
    visit(tree, "blockquote", (node: Blockquote) => {
      const first = node.children[0] as Paragraph | undefined;
      const text = first?.type === "paragraph" ? (first.children[0] as Text | undefined) : undefined;
      if (!text || text.type !== "text") return;
      const m = /^\[!(NOTE|TIP|WARNING|FAIL)\][ \t]*\n?/.exec(text.value);
      if (!m) return;
      const kind = KINDS[m[1]];
      text.value = text.value.slice(m[0].length);
      if (!text.value) first!.children.shift();
      if (first!.children.length === 0) node.children.shift();
      const title: Paragraph = {
        type: "paragraph",
        children: [{ type: "text", value: lang.callout[kind] }],
        data: { hName: "p", hProperties: { className: ["callout-title"] } },
      };
      node.children.unshift(title);
      node.data = { hName: "div", hProperties: { className: ["callout", `callout-${kind}`], role: "note" } };
    });
  };
}
