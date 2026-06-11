# EPUB2FB2

Static TypeScript web app for converting EPUB files to FB2 in the browser.

## Features

- Client-side conversion: files are not uploaded to a server.
- Reads EPUB `container.xml`, OPF metadata, manifest and spine.
- Preserves text, cover image, NCX / EPUB 3 navigation, footnote links and binary images.
- Supports two image modes:
  - `Inline images`: images are inserted directly into the FB2 body.
  - `Image notes`: images are moved to FB2 notes and referenced from the text.

## Development

```bash
npm run typecheck
npm run build
npm run dev
```
