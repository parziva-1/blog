import { visit } from "unist-util-visit";
import GithubSlugger from "github-slugger";
import { toString } from "hast-util-to-string";
import type { Root, Element } from "hast";

// Assign ids to h2/h3 (same slugger Astro uses, so TOC links match) and append an empty anchor link.
// The anchor has no text on purpose: Astro collects heading text after user plugins run.
export default function rehypeHeadings() {
  return (tree: Root) => {
    const slugger = new GithubSlugger();
    visit(tree, "element", (node: Element) => {
      if (!/^h[1-6]$/.test(node.tagName)) return;
      const id = typeof node.properties?.id === "string" ? node.properties.id : slugger.slug(toString(node));
      node.properties = { ...node.properties, id };
      if (node.tagName === "h2" || node.tagName === "h3") {
        node.children.push({
          type: "element",
          tagName: "a",
          properties: { className: ["anchor"], href: `#${id}`, "aria-label": "Link" },
          children: [],
        });
      }
    });
  };
}
