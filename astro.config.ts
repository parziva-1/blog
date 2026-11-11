import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { unified } from "@astrojs/markdown-remark";
import remarkCallouts from "./src/lib/remark-callouts";
import rehypeHeadings from "./src/lib/rehype-headings";
import rehypeTables from "./src/lib/rehype-tables";
import rehypeFutureLinks from "./src/lib/rehype-future-links";
import { codeBlockTransformer } from "./src/lib/shiki-code-block";

export default defineConfig({
  site: "https://parziva1.qzz.io",
  trailingSlash: "ignore",
  integrations: [
    sitemap({
      i18n: {
        defaultLocale: "es",
        locales: { es: "es", en: "en" },
      },
      // The 404 page is emitted as /404.html and never listed; this is a guard for future utility pages.
      filter: (page) => !page.endsWith("/404/"),
    }),
  ],
  i18n: {
    locales: ["es", "en"],
    defaultLocale: "es",
    routing: { prefixDefaultLocale: false },
  },
  markdown: {
    processor: unified({
      remarkPlugins: [remarkCallouts],
      rehypePlugins: [rehypeHeadings, rehypeTables, rehypeFutureLinks],
    }),
    shikiConfig: {
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
      wrap: false,
      transformers: [codeBlockTransformer()],
    },
  },
});
