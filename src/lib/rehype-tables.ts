import { visit } from "unist-util-visit";
import { toString } from "hast-util-to-string";
import type { Root, Element } from "hast";

const NUMERIC = /^[\s~≈<>±+-]*\d[\d.,\s/%]*[a-zA-Z%]{0,4}\s*$/;

const rowsOf = (table: Element): Element[] => {
  const out: Element[] = [];
  visit(table, "element", (n: Element) => {
    if (n.tagName === "tr") out.push(n);
  });
  return out;
};
const cellsOf = (tr: Element) =>
  tr.children.filter((c): c is Element => c.type === "element" && (c.tagName === "td" || c.tagName === "th"));
const addClass = (el: Element, cls: string) => {
  const cur = el.properties?.className;
  el.properties = { ...el.properties, className: [...(Array.isArray(cur) ? cur : cur ? [String(cur)] : []), cls] };
};

// Wrap tables in .table-wrap and mark columns whose body cells are all numeric (td.num / th.num).
export default function rehypeTables() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "table" || !parent || index === undefined) return;
      const rows = rowsOf(node);
      const body = rows.filter((r) => cellsOf(r).every((c) => c.tagName === "td"));
      const cols = Math.max(0, ...rows.map((r) => cellsOf(r).length));
      for (let i = 0; i < cols; i++) {
        const cells = body.map((r) => cellsOf(r)[i]).filter(Boolean);
        if (cells.length && cells.every((c) => NUMERIC.test(toString(c)))) {
          for (const r of rows) {
            const c = cellsOf(r)[i];
            if (c) addClass(c, "num");
          }
        }
      }
      parent.children[index] = {
        type: "element",
        tagName: "div",
        properties: { className: ["table-wrap"], tabindex: 0, role: "region", "aria-label": "table" },
        children: [node],
      };
      return "skip";
    });
  };
}
