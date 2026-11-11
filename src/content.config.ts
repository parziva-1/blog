import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const posts = defineCollection({
  // posts/ is published; drafts/ is gitignored (local only) so unfinished posts never reach the public repo.
  loader: glob({ pattern: "{posts,drafts}/{es,en}/[^_]*.{md,mdx}", base: "./src/content" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    category: z.enum(["ia", "android", "hardware", "gamedev", "code", "homelab", "linux"]),
    draft: z.boolean().default(false),
    lang: z.enum(["es", "en"]),
    translationKey: z.string(),
    repo: z.url().optional(),
    metric: z.object({ value: z.string(), label: z.string() }).optional(),
    specs: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  }),
});

export const collections = { posts };
