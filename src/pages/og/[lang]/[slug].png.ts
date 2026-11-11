import type { APIRoute, GetStaticPaths } from "astro";
import { LANGS, t, type Category } from "@/i18n";
import { getPosts, slugOf } from "@/lib/posts";
import { renderOg, type OgInput } from "@/lib/og";

export const getStaticPaths = (async () => {
  const out: { params: { lang: string; slug: string }; props: Record<string, unknown> }[] = [];
  for (const lang of LANGS) {
    out.push({ params: { lang, slug: "home" }, props: { title: t(lang).hero.title.join(""), category: "ia" as Category, kicker: "parziva1.qzz.io", metric: undefined } });
    for (const p of await getPosts(lang)) {
      out.push({
        params: { lang, slug: slugOf(p) },
        props: { title: p.data.title, category: p.data.category, metric: p.data.metric, kicker: t(lang).categoryLabel[p.data.category] },
      });
    }
  }
  return out;
}) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props }) => {
  const png = await renderOg(props as OgInput);
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
};
