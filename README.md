# parziva1 — blog bilingüe

Sitio estático en Astro 7 (ES en la raíz, EN bajo `/en/`), tema propio "pixel lab". Solo local por ahora: sin remoto configurado.

```bash
pnpm install
pnpm dev        # los borradores (draft: true) se ven aquí
pnpm build      # astro check + build; los borradores se excluyen
```

## Escribir una nota en los dos idiomas

1. Escribe el borrador en `src/content/drafts/es/<slug>.md` y `src/content/drafts/en/<slug>.md` **con el mismo nombre de archivo** y `draft: true`. Esa carpeta no se sube a GitHub.
   Para publicar: muévelos a `src/content/posts/es/` y `src/content/posts/en/` y pon `draft: false`.
2. Frontmatter en ambos: `title`, `description`, `pubDate`, `tags`, `category` (`ia|android|hardware|gamedev|code|homelab|linux`), `draft`, `lang` (`es`/`en`), `translationKey` (**el mismo valor en ambos**), y opcionales `updatedDate`, `repo`, `metric: {value, label}`, `specs: [{label, value}]`.
3. `translationKey` enlaza las dos versiones (selector de idioma, hreflang) y es el término del hilo de comentarios compartido.
4. Callouts: `> [!NOTE]`, `> [!WARNING]`, `> [!FAIL]`. Bloques de código con título: ` ```bash title="serve.sh" `.
5. Cuando esté lista, pon `draft: false` en ambas.

## Comentarios (giscus + traducción)

- Pon `repoId` y `categoryId` en `src/config/comments.ts` (obtenlos en <https://giscus.app>). Mientras estén vacíos solo se muestra la lista estática.
- Las dos versiones de una nota comparten UN hilo de Discussions (`mapping=specific`, término = `translationKey`).
- `scripts/sync-comments.mjs` copia los comentarios a `src/data/comments/<translationKey>.json` y guarda siempre original y traducción (es + en). `.github/workflows/comments.yml` lo ejecuta ante cada comentario y cada 6 h, hace commit del JSON y despliega Pages.
- Traductor (cualquier API compatible con OpenAI chat-completions). El predeterminado es el plan gratuito de Groq. Variables del repo (Settings → Secrets and variables → Actions):
  - Variable `TRANSLATOR` = `openai` (o `none` para guardar solo originales, marcados sin traducir).
  - Variable `TRANSLATE_MODEL` = id del modelo de tu proveedor (obligatoria con `openai`).
  - Variable `TRANSLATE_BASE_URL` (opcional, por defecto `https://api.groq.com/openai/v1`).
  - Secreto `TRANSLATE_API_KEY`.
- Los comentarios son datos no confiables: se sanitizan al renderizar y el prompt del traductor prohíbe seguir instrucciones del texto. Máximo 4000 caracteres por comentario y 50 traducciones por ejecución.

## Publicar en GitHub Pages

1. Crea el repo `parziva-1/blog`, súbelo y en Settings → Pages elige **Source: GitHub Actions**.
2. Settings → General → activa **Discussions** y crea la categoría `Comments` (formato Announcement recomendado).
3. Instala la app giscus en el repo. `public/CNAME` ya apunta a `parziva1.qzz.io`.
