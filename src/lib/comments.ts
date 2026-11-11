import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";
import type { Root, Element } from "hast";
import type { Lang } from "@/i18n";

export interface RawComment {
  id: string;
  author: string;
  avatarUrl?: string;
  url?: string;
  createdAt: string;
  original: { lang: Lang; markdown: string };
  translations: Partial<Record<Lang, string>>;
  replies?: RawComment[];
}
export interface ViewComment {
  id: string;
  author: string;
  authorUrl: string | null;
  avatar: string | null;
  url: string | null;
  createdAt: Date;
  /** Page-language HTML (translation when the original is in the other language). */
  html: string;
  /** Original HTML, only when `html` is a translation. */
  originalHtml: string | null;
  originalLang: Lang;
  htmlLang: Lang;
  replies: ViewComment[];
}

const files = import.meta.glob<RawComment[]>("/src/data/comments/*.json", { eager: true, import: "default" });
export const commentsFor = (key: string): RawComment[] => files[`/src/data/comments/${key}.json`] ?? [];

// GitHub-like schema, minus images (no third-party loads from untrusted content). Raw HTML is dropped
// because remark-rehype is run without allowDangerousHtml.
const schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((n) => n !== "img" && n !== "input"),
};

function linkRel() {
  return (tree: Root) => {
    visit(tree, "element", (n: Element) => {
      if (n.tagName === "a") n.properties = { ...n.properties, rel: ["nofollow", "ugc", "noopener", "noreferrer"], target: "_blank" };
    });
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize, schema)
  .use(linkRel)
  .use(rehypeStringify);

const render = async (md: string) => String(await processor.process(md.slice(0, 20000)));

const safeLogin = (s: string) => (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(s) ? s : "ghost");
const safeAvatar = (u?: string) => {
  try {
    const x = new URL(u ?? "");
    return x.protocol === "https:" && x.hostname === "avatars.githubusercontent.com" ? x.href : null;
  } catch {
    return null;
  }
};
const safeUrl = (u?: string) => {
  try {
    const x = new URL(u ?? "");
    return x.protocol === "https:" && x.hostname === "github.com" ? x.href : null;
  } catch {
    return null;
  }
};

async function view(c: RawComment, lang: Lang): Promise<ViewComment> {
  const o = c.original;
  const tr = c.translations?.[lang];
  const useTr = o.lang !== lang && typeof tr === "string" && tr.length > 0;
  const author = safeLogin(c.author);
  return {
    id: String(c.id).replace(/[^\w-]/g, "").slice(0, 80),
    author,
    authorUrl: author === "ghost" ? null : `https://github.com/${author.replace(/\[bot\]$/, "")}`,
    avatar: safeAvatar(c.avatarUrl),
    url: safeUrl(c.url),
    createdAt: new Date(c.createdAt),
    html: await render(useTr ? tr! : o.markdown),
    originalHtml: useTr ? await render(o.markdown) : null,
    originalLang: o.lang,
    htmlLang: useTr ? lang : o.lang,
    replies: await Promise.all((c.replies ?? []).map((r) => view(r, lang))),
  };
}

export async function loadComments(key: string, lang: Lang): Promise<ViewComment[]> {
  return Promise.all(commentsFor(key).map((c) => view(c, lang)));
}
