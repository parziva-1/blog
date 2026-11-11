import { es } from "./es";
import { en } from "./en";
import type { Strings } from "./es";

export type Lang = "es" | "en";
export const LANGS: Lang[] = ["es", "en"];
export const CATEGORIES = ["ia", "android", "hardware", "gamedev", "code", "homelab", "linux"] as const;
export type Category = (typeof CATEGORIES)[number];

const dict: Record<Lang, Strings> = { es, en };
export const t = (lang: Lang): Strings => dict[lang];
export const otherLang = (lang: Lang): Lang => (lang === "es" ? "en" : "es");

const prefix = (lang: Lang) => (lang === "es" ? "" : "/en");
export const paths = {
  home: (l: Lang) => `${prefix(l)}/`,
  post: (l: Lang, slug: string) => `${prefix(l)}/posts/${slug}/`,
  tags: (l: Lang) => `${prefix(l)}/tags/`,
  tag: (l: Lang, tag: string) => `${prefix(l)}/tags/${encodeURIComponent(tag)}/`,
  category: (l: Lang, c: Category) => (l === "es" ? `/categoria/${c}/` : `/en/category/${c}/`),
  about: (l: Lang) => `${prefix(l)}/about/`,
  rss: (l: Lang) => `${prefix(l)}/rss.xml`,
  og: (l: Lang, key: string) => `/og/${l}/${key}.png`,
};

export const formatDate = (d: Date, lang: Lang) =>
  new Intl.DateTimeFormat(t(lang).locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(d);
