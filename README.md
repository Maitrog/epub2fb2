# EPUB2FB2

EPUB2FB2 is a static TypeScript web app for converting EPUB files to FB2 directly in the browser.

You can try it right now [here](https://maitrog.github.io/epub2fb2/)

## Features

- Client-side conversion: files are not uploaded to a server.
- Reads EPUB `container.xml`, OPF metadata, manifest, and spine.
- Preserves text, cover image, NCX / EPUB 3 navigation, footnote links, and binary images.
- Supports two image modes:
  - `Inline images`: images are inserted directly into the FB2 body.
  - `Image notes`: images are moved to FB2 notes and referenced from the text.
- Generates downloadable `.fb2` files locally.

## Development

```bash
npm install
npm run dev
```

Vite serves the app locally and watches TypeScript/CSS changes.

## Checks

```bash
npm run typecheck
npm run build
```

`npm run build` creates a production build in `dist`.

## Limitations

- EPUB ZIP entries must be unencrypted.
- Compressed EPUB files require browser `DecompressionStream` support.
- Very large EPUB files may be limited by browser memory.
- FB2 reader compatibility can vary, especially for inline images.

## Support
If you like the project, I would appreciate your [support](https://www.donationalerts.com/r/maitrog).
