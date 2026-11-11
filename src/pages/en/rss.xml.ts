import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { SITE } from "@/config/site";
import { t, paths } from "@/i18n";
import { getPosts, slugOf } from "@/lib/posts";

export async function GET(context: APIContext) {
  const lang = "en";
  const posts = await getPosts(lang);
  return rss({
    title: t(lang).siteTitle,
    description: t(lang).tagline,
    site: context.site ?? SITE.url,
    customData: `<language>${lang}</language>`,
    items: posts.map((p) => ({
      title: p.data.title,
      description: p.data.description,
      pubDate: p.data.pubDate,
      link: paths.post(lang, slugOf(p)),
      categories: [p.data.category, ...p.data.tags],
    })),
  });
}
