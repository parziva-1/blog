import type { ShikiTransformer } from "shiki";

// Wrap each highlighted <pre> in .code-block with a title bar (from ```lang title="file") and a copy button.
export function codeBlockTransformer(): ShikiTransformer {
  return {
    name: "code-block",
    root(root) {
      const raw = (this.options.meta as { __raw?: string } | undefined)?.__raw ?? "";
      const m = /title=(?:"([^"]+)"|'([^']+)')/.exec(raw);
      const title = m?.[1] ?? m?.[2] ?? String(this.options.lang ?? "text");
      root.children = [
        {
          type: "element",
          tagName: "div",
          properties: { className: ["code-block"] },
          children: [
            { type: "element", tagName: "div", properties: { className: ["code-title"] }, children: [{ type: "text", value: title }] },
            ...(root.children as never[]),
            {
              type: "element",
              tagName: "button",
              properties: { className: ["copy-btn"], type: "button", "data-copy": "" },
              children: [{ type: "text", value: "Copy" }],
            },
          ],
        },
      ];
    },
  };
}
