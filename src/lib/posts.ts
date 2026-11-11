import { getCollection, type CollectionEntry } from "astro:content";
import type { Lang } from "@/i18n";

export type Post = CollectionEntry<"posts">;

// Drafts are visible in `astro dev`, hidden in production builds (SHOW_DRAFTS=1 forces them for local checks).
const includeDrafts = import.meta.env.DEV || process.env.SHOW_DRAFTS === "1";

export const slugOf = (p: Post) => (p.id.split("/").at(-1) ?? p.id).replace(/\.(md|mdx)$/, "");

export async function getPosts(lang?: Lang): Promise<Post[]> {
  const all = await getCollection("posts", (p) => (includeDrafts || !p.data.draft) && (!lang || p.data.lang === lang));
  return all.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export async function getCounterpart(post: Post): Promise<Post | undefined> {
  const other = post.data.lang === "es" ? "en" : "es";
  return (await getPosts(other)).find((p) => p.data.translationKey === post.data.translationKey);
}

export const readingMinutes = (post: Post) =>
  Math.max(1, Math.round((post.body ?? "").split(/\s+/).filter(Boolean).length / 210));

export const uniqueTags = (posts: Post[]) => [...new Set(posts.flatMap((p) => p.data.tags))].sort();
