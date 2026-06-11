import "./styles.css";

type ImageMode = "inline" | "footnotes";

type ZipEntry = {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

type ManifestItem = {
  id: string;
  href: string;
  mediaType: string;
  properties: string;
  fullPath: string;
};

type TocItem = {
  href: string;
  title: string;
};

type BinaryResource = {
  id: string;
  contentType: string;
  data: Uint8Array;
};

type Note = {
  id: string;
  title: string;
  body: string;
};

type ConvertResult = {
  fileName: string;
  fb2: string;
  stats: {
    sections: number;
    images: number;
    notes: number;
  };
};

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const textDecoder = new TextDecoder("utf-8");

const form = requireElement<HTMLFormElement>("#converter-form");
const fileInput = requireElement<HTMLInputElement>("#file-input");
const dropzone = requireElement<HTMLElement>("#dropzone");
const fileTitle = requireElement<HTMLElement>("#file-title");
const fileSubtitle = requireElement<HTMLElement>("#file-subtitle");
const statusEl = requireElement<HTMLElement>("#status");
const convertButton = requireElement<HTMLButtonElement>("#convert-button");

let selectedFile: File | null = null;

fileInput.addEventListener("change", () => {
  setSelectedFile(fileInput.files?.[0] ?? null);
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("is-dragover");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("is-dragover");
});

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("is-dragover");
  setSelectedFile(event.dataTransfer?.files?.[0] ?? null);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!selectedFile) {
    setStatus("Select an EPUB file.", "error");
    return;
  }

  const formData = new FormData(form);
  const imageMode = (formData.get("images") ?? "inline") as ImageMode;

  try {
    convertButton.disabled = true;
    setStatus("Reading EPUB archive...");
    const result = await convertEpubToFb2(selectedFile, imageMode);
    downloadText(result.fileName, result.fb2, "application/x-fictionbook+xml;charset=utf-8");
    setStatus(
      `Done. Sections: ${result.stats.sections}, images: ${result.stats.images}, notes: ${result.stats.notes}.`,
      "success",
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Conversion failed.", "error");
  } finally {
    convertButton.disabled = false;
  }
});

function setSelectedFile(file: File | null): void {
  selectedFile = file;
  if (!file) {
    fileTitle.textContent = "Click to select an EPUB file";
    fileSubtitle.textContent = "EPUB files processed locally in your browser";
    return;
  }

  fileTitle.textContent = file.name;
  fileSubtitle.textContent = `${formatBytes(file.size)} selected`;
  setStatus("Ready.");
}

async function convertEpubToFb2(file: File, imageMode: ImageMode): Promise<ConvertResult> {
  const archive = new EpubArchive(new Uint8Array(await file.arrayBuffer()));
  const container = parseXml(await archive.readText("META-INF/container.xml"), "container.xml");
  const opfPath = getAttr(
    elementsByLocalName(container, "rootfile").find((item) => getAttr(item, "media-type") === "application/oebps-package+xml") ??
      firstByLocalName(container, "rootfile"),
    "full-path",
  );

  if (!opfPath) {
    throw new Error("EPUB container.xml does not point to an OPF package.");
  }

  const opf = parseXml(await archive.readText(opfPath), opfPath);
  const baseDir = dirname(opfPath);
  const manifest = readManifest(opf, baseDir);
  const metadata = readMetadata(opf);
  const spine = readSpine(opf, manifest);
  const toc = await readToc(archive, opf, manifest);
  const state = new ConversionState(archive, manifest, imageMode);
  const sections: string[] = [];

  for (const item of spine) {
    const xhtml = parseHtml(await archive.readText(item.fullPath));
    const body = xhtml.body;
    const title = findSectionTitle(toc, item.fullPath, body, metadata.title);
    const content = await convertChildren(body, state, item.fullPath);
    const normalized = content.trim() || "<empty-line/>";
    const titleXml = title ? `<title><p>${xmlText(title)}</p></title>` : "";
    sections.push(`<section id="${xmlAttr(safeId(item.id))}">${titleXml}${normalized}</section>`);
  }

  const cover = await state.resolveCover(opf);
  const binaries = state.getBinaries();
  const notes = state.getNotes();
  const notesBody = notes.length > 0 ? `<body name="notes">${notes.map(renderNote).join("")}</body>` : "";
  const fb2 = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">',
    renderDescription(metadata, cover),
    `<body>${sections.join("")}</body>`,
    notesBody,
    binaries.map(renderBinary).join(""),
    "</FictionBook>",
  ].join("");

  return {
    fileName: `${stripExtension(file.name)}.fb2`,
    fb2,
    stats: {
      sections: sections.length,
      images: binaries.length,
      notes: notes.length,
    },
  };
}

class EpubArchive {
  private readonly entries = new Map<string, ZipEntry>();

  constructor(private readonly data: Uint8Array) {
    this.readCentralDirectory();
  }

  async readText(path: string): Promise<string> {
    return textDecoder.decode(await this.readBytes(path));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const normalized = normalizeZipPath(path);
    const entry = this.entries.get(normalized);
    if (!entry) {
      throw new Error(`EPUB resource not found: ${path}`);
    }

    const view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    if (view.getUint32(entry.localHeaderOffset, true) !== ZIP_LOCAL_FILE_HEADER) {
      throw new Error(`Invalid local ZIP header for ${path}.`);
    }

    const nameLength = view.getUint16(entry.localHeaderOffset + 26, true);
    const extraLength = view.getUint16(entry.localHeaderOffset + 28, true);
    const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const compressed = this.data.slice(dataOffset, dataOffset + entry.compressedSize);

    if (entry.compression === 0) {
      return compressed;
    }

    if (entry.compression === 8) {
      return inflateRaw(compressed, entry.uncompressedSize);
    }

    throw new Error(`Unsupported ZIP compression method ${entry.compression} for ${path}.`);
  }

  private readCentralDirectory(): void {
    const view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    const eocdOffset = findEndOfCentralDirectory(view);
    const entryCount = view.getUint16(eocdOffset + 10, true);
    const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
    let offset = centralDirectoryOffset;

    for (let index = 0; index < entryCount; index += 1) {
      if (view.getUint32(offset, true) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
        throw new Error("Invalid ZIP central directory.");
      }

      const compression = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localHeaderOffset = view.getUint32(offset + 42, true);
      const nameBytes = this.data.slice(offset + 46, offset + 46 + nameLength);
      const name = normalizeZipPath(textDecoder.decode(nameBytes));

      this.entries.set(name, {
        name,
        compression,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });

      offset += 46 + nameLength + extraLength + commentLength;
    }
  }
}

class ConversionState {
  private readonly binaries = new Map<string, BinaryResource>();
  private readonly notes: Note[] = [];
  private readonly noteIds = new Set<string>();

  constructor(
    private readonly archive: EpubArchive,
    private readonly manifest: Map<string, ManifestItem>,
    private readonly imageMode: ImageMode,
  ) {}

  getBinaries(): BinaryResource[] {
    return [...this.binaries.values()];
  }

  getNotes(): Note[] {
    return this.notes;
  }

  async addImage(src: string, currentPath: string, alt: string): Promise<string> {
    const resourcePath = resolvePath(dirname(currentPath), src.split("#")[0]);
    const manifestItem = [...this.manifest.values()].find((item) => normalizeZipPath(item.fullPath) === normalizeZipPath(resourcePath));
    const contentType = manifestItem?.mediaType ?? guessImageType(resourcePath);
    const id = uniqueBinaryId(basename(resourcePath), this.binaries);

    if (!this.binaries.has(id)) {
      this.binaries.set(id, {
        id,
        contentType,
        data: await this.archive.readBytes(resourcePath),
      });
    }

    if (this.imageMode === "footnotes") {
      const noteId = uniqueNoteId(`img-${id}`, this.noteIds);
      const title = alt || "Image";
      this.notes.push({
        id: noteId,
        title,
        body: `<p>${xmlText(title)}</p><image l:href="#${xmlAttr(id)}"/>`,
      });
      return `<a l:href="#${xmlAttr(noteId)}" type="note">[image]</a>`;
    }

    return `<image l:href="#${xmlAttr(id)}"/>`;
  }

  async addFootnote(reference: Element, currentPath: string): Promise<string | null> {
    const href = getAttr(reference, "href") || getAttr(reference, "xlink:href");
    if (!href || !href.includes("#")) {
      return null;
    }

    const [filePart, hash] = href.split("#");
    const noteId = safeId(hash);
    if (!noteId) {
      return null;
    }

    const targetPath = filePart ? resolvePath(dirname(currentPath), filePart) : currentPath;

    if (!this.noteIds.has(noteId)) {
      const doc = parseHtml(await this.archive.readText(targetPath));
      const target = doc.getElementById(hash);
      if (!target) {
        return null;
      }

      this.noteIds.add(noteId);
      this.notes.push({
        id: noteId,
        title: reference.textContent?.trim() || hash,
        body: await convertChildren(target, this, targetPath),
      });
    }

    return `<a l:href="#${xmlAttr(noteId)}" type="note">${xmlText(reference.textContent?.trim() || "*")}</a>`;
  }

  async resolveCover(opf: Document): Promise<BinaryResource | null> {
    const coverMetaId = getAttr(
      elementsByLocalName(opf, "meta").find((item) => getAttr(item, "name") === "cover") ?? null,
      "content",
    );
    const coverItem =
      (coverMetaId ? this.manifest.get(coverMetaId) : undefined) ??
      [...this.manifest.values()].find((item) => item.properties.split(/\s+/).includes("cover-image")) ??
      [...this.manifest.values()].find((item) => item.id.toLowerCase().includes("cover") && item.mediaType.startsWith("image/"));

    if (!coverItem) {
      return null;
    }

    const id = uniqueBinaryId(basename(coverItem.fullPath), this.binaries);
    if (!this.binaries.has(id)) {
      this.binaries.set(id, {
        id,
        contentType: coverItem.mediaType,
        data: await this.archive.readBytes(coverItem.fullPath),
      });
    }

    return this.binaries.get(id) ?? null;
  }
}

async function convertChildren(parent: ParentNode, state: ConversionState, currentPath: string): Promise<string> {
  const parts: string[] = [];
  for (const node of [...parent.childNodes]) {
    parts.push(await convertNode(node, state, currentPath));
  }

  return parts.join("");
}

async function convertNode(node: Node, state: ConversionState, currentPath: string): Promise<string> {
  if (node.nodeType === Node.TEXT_NODE) {
    return xmlText(node.textContent ?? "");
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node as Element;
  const tag = element.localName.toLowerCase();

  if (["script", "style", "head", "title"].includes(tag)) {
    return "";
  }

  if (tag === "img" || tag === "image") {
    const src = getAttr(element, "src") || getAttr(element, "href") || getAttr(element, "xlink:href");
    return src ? state.addImage(src, currentPath, getAttr(element, "alt") ?? "") : "";
  }

  if (tag === "a") {
    const type = getAttr(element, "epub:type") ?? "";
    const href = getAttr(element, "href") ?? "";
    if (type.includes("noteref") || /(^|[#/])(note|footnote|fn)[-_]?\d*/i.test(href)) {
      const note = await state.addFootnote(element, currentPath);
      if (note) {
        return note;
      }
    }
    return convertChildren(element, state, currentPath);
  }

  const semanticType = getAttr(element, "epub:type") ?? "";
  if (semanticType.includes("footnote") || semanticType.includes("endnote")) {
    return "";
  }

  const content = await convertChildren(element, state, currentPath);
  if (!content.trim() && !["br", "hr"].includes(tag)) {
    return "";
  }

  if (/^h[1-6]$/.test(tag)) {
    return `<section><title><p>${content}</p></title></section>`;
  }

  switch (tag) {
    case "p":
    case "div":
    case "aside":
      return `<p>${content}</p>`;
    case "br":
      return "<empty-line/>";
    case "hr":
      return "<empty-line/>";
    case "strong":
    case "b":
      return `<strong>${content}</strong>`;
    case "em":
    case "i":
      return `<emphasis>${content}</emphasis>`;
    case "sub":
      return `<sub>${content}</sub>`;
    case "sup":
      return `<sup>${content}</sup>`;
    case "blockquote":
      return `<cite><p>${content}</p></cite>`;
    case "li":
      return `<p>${content}</p>`;
    case "ul":
      return content;
    case "ol":
      return content;
    case "body":
    case "main":
    case "section":
    case "article":
    case "nav":
    case "span":
      return content;
    default:
      return content;
  }
}

function readManifest(opf: Document, baseDir: string): Map<string, ManifestItem> {
  const result = new Map<string, ManifestItem>();
  for (const item of elementsByLocalName(opf, "item")) {
    const id = getAttr(item, "id");
    const href = getAttr(item, "href");
    const mediaType = getAttr(item, "media-type") ?? "";
    if (!id || !href) {
      continue;
    }

    result.set(id, {
      id,
      href,
      mediaType,
      properties: getAttr(item, "properties") ?? "",
      fullPath: resolvePath(baseDir, href),
    });
  }

  return result;
}

function readSpine(opf: Document, manifest: Map<string, ManifestItem>): ManifestItem[] {
  const result: ManifestItem[] = [];
  for (const itemRef of elementsByLocalName(opf, "itemref")) {
    const item = manifest.get(getAttr(itemRef, "idref") ?? "");
    if (item && /x?html|xml/.test(item.mediaType)) {
      result.push(item);
    }
  }

  if (result.length === 0) {
    throw new Error("OPF spine does not contain readable XHTML documents.");
  }

  return result;
}

function readMetadata(opf: Document): Record<string, string> {
  return {
    title: textByLocalName(opf, "title") || "Untitled",
    creator: textByLocalName(opf, "creator") || "Unknown",
    language: textByLocalName(opf, "language") || "ru",
    publisher: textByLocalName(opf, "publisher"),
    date: textByLocalName(opf, "date"),
    description: textByLocalName(opf, "description"),
  };
}

async function readToc(archive: EpubArchive, opf: Document, manifest: Map<string, ManifestItem>): Promise<TocItem[]> {
  const spine = firstByLocalName(opf, "spine");
  const ncxId = getAttr(spine, "toc");
  const ncxItem =
    (ncxId ? manifest.get(ncxId) : undefined) ?? [...manifest.values()].find((item) => item.mediaType === "application/x-dtbncx+xml");

  if (ncxItem) {
    const ncx = parseXml(await archive.readText(ncxItem.fullPath), ncxItem.fullPath);
    return elementsByLocalName(ncx, "navPoint")
      .map((point) => ({
        title: textByLocalName(point, "text") || "Untitled",
        href: resolvePath(dirname(ncxItem.fullPath), getAttr(firstByLocalName(point, "content"), "src") ?? ""),
      }))
      .filter((item) => item.href);
  }

  const navItem = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes("nav"));
  if (!navItem) {
    return [];
  }

  const navDoc = parseHtml(await archive.readText(navItem.fullPath));
  return [...navDoc.querySelectorAll("nav a")]
    .map((link) => ({
      title: link.textContent?.trim() || "Untitled",
      href: resolvePath(dirname(navItem.fullPath), getAttr(link, "href") ?? ""),
    }))
    .filter((item) => item.href);
}

function renderDescription(metadata: Record<string, string>, cover: BinaryResource | null): string {
  const coverXml = cover ? `<coverpage><image l:href="#${xmlAttr(cover.id)}"/></coverpage>` : "";
  const annotation = metadata.description ? `<annotation><p>${xmlText(metadata.description)}</p></annotation>` : "";
  const publishInfo = metadata.publisher ? `<publish-info><publisher>${xmlText(metadata.publisher)}</publisher></publish-info>` : "";

  return [
    "<description><title-info>",
    "<genre>prose_contemporary</genre>",
    `<author><last-name>${xmlText(metadata.creator)}</last-name></author>`,
    `<book-title>${xmlText(metadata.title)}</book-title>`,
    annotation,
    `<lang>${xmlText(metadata.language.slice(0, 2).toLowerCase())}</lang>`,
    coverXml,
    "</title-info>",
    `<document-info><program-used>epub2fb2 web converter</program-used><date>${new Date().toISOString().slice(0, 10)}</date></document-info>`,
    publishInfo,
    "</description>",
  ].join("");
}

function renderNote(note: Note): string {
  return `<section id="${xmlAttr(note.id)}"><title><p>${xmlText(note.title)}</p></title>${note.body}</section>`;
}

function renderBinary(binary: BinaryResource): string {
  return `<binary id="${xmlAttr(binary.id)}" content-type="${xmlAttr(binary.contentType)}">${base64(binary.data)}</binary>`;
}

async function inflateRaw(compressed: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  const Decompression = (globalThis as { DecompressionStream?: new (format: string) => TransformStream }).DecompressionStream;

  if (!Decompression) {
    throw new Error("This browser cannot decompress EPUB files. Use a current Chrome, Edge, or Firefox build.");
  }

  const stream = new Blob([new Uint8Array(compressed)]).stream().pipeThrough(new Decompression("deflate-raw"));
  const buffer = await new Response(stream).arrayBuffer();
  const result = new Uint8Array(buffer);
  if (expectedSize > 0 && result.length !== expectedSize) {
    return result;
  }

  return result;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minOffset = Math.max(0, view.byteLength - 0xffff - 22);
  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }

  throw new Error("Invalid ZIP archive: end of central directory not found.");
}

function parseXml(source: string, label: string): Document {
  const doc = new DOMParser().parseFromString(source, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error(`Could not parse ${label}.`);
  }

  return doc;
}

function parseHtml(source: string): Document {
  return new DOMParser().parseFromString(source, "text/html");
}

function getAttr(element: Element | null, name: string): string | null {
  if (!element) {
    return null;
  }

  return element.getAttribute(name) ?? element.getAttributeNS("http://www.w3.org/1999/xlink", name.replace("xlink:", ""));
}

function textOf(parent: ParentNode, selector: string): string {
  return parent.querySelector(selector)?.textContent?.trim() ?? "";
}

function elementsByLocalName(parent: ParentNode, localName: string): Element[] {
  const root = parent instanceof Document ? parent.documentElement : parent;
  return [...root.querySelectorAll("*")].filter((element) => element.localName === localName);
}

function firstByLocalName(parent: ParentNode, localName: string): Element | null {
  const root = parent instanceof Document ? parent.documentElement : parent;
  if (root instanceof Element && root.localName === localName) {
    return root;
  }

  return elementsByLocalName(parent, localName)[0] ?? null;
}

function textByLocalName(parent: ParentNode, localName: string): string {
  return firstByLocalName(parent, localName)?.textContent?.trim() ?? "";
}

function findSectionTitle(toc: TocItem[], path: string, body: HTMLElement, bookTitle: string): string | null {
  const tocTitle = toc.find((tocItem) => sameDoc(tocItem.href, path) && isUsefulTitle(tocItem.title, bookTitle))?.title;
  if (tocTitle) {
    return tocTitle.trim();
  }

  const visibleTitle = body.querySelector("h1, h2, h3, h4, h5, h6, [epub\\:type~='title'], [type~='title']")?.textContent?.trim();
  return isUsefulTitle(visibleTitle, bookTitle) ? visibleTitle.trim() : null;
}

function isUsefulTitle(title: string | null | undefined, bookTitle: string): title is string {
  if (!title) {
    return false;
  }

  const normalizedTitle = normalizeTitle(title);
  return normalizedTitle.length > 0 && normalizedTitle !== "untitled" && normalizedTitle !== normalizeTitle(bookTitle);
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

function sameDoc(href: string, path: string): boolean {
  return normalizeZipPath(href.split("#")[0]) === normalizeZipPath(path);
}

function normalizeZipPath(path: string): string {
  return decodeURIComponent(path).replace(/\\/g, "/").replace(/^\/+/, "");
}

function resolvePath(baseDir: string, path: string): string {
  if (!baseDir) {
    return normalizePath(path);
  }

  return normalizePath(`${baseDir}/${path}`);
}

function normalizePath(path: string): string {
  const result: string[] = [];
  for (const part of normalizeZipPath(path).split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      result.pop();
    } else {
      result.push(part);
    }
  }

  return result.join("/");
}

function dirname(path: string): string {
  const normalized = normalizeZipPath(path);
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? "" : normalized.slice(0, slash);
}

function basename(path: string): string {
  return normalizeZipPath(path).split("/").pop() || "resource";
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[^A-Za-z_]+/, "id_");
}

function uniqueBinaryId(name: string, existing: Map<string, BinaryResource>): string {
  const clean = safeId(name || "image");
  if (!existing.has(clean)) {
    return clean;
  }

  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  let index = 2;
  while (existing.has(`${stem}-${index}${ext}`)) {
    index += 1;
  }

  return `${stem}-${index}${ext}`;
}

function uniqueNoteId(base: string, existing: Set<string>): string {
  const clean = safeId(base);
  let candidate = clean;
  let index = 2;
  while (existing.has(candidate)) {
    candidate = `${clean}-${index}`;
    index += 1;
  }
  existing.add(candidate);
  return candidate;
}

function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlAttr(value: string): string {
  return xmlText(value).replace(/"/g, "&quot;");
}

function base64(data: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.slice(offset, offset + chunkSize));
  }

  return btoa(binary);
}

function guessImageType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function setStatus(message: string, type?: "error" | "success"): void {
  statusEl.textContent = message;
  statusEl.classList.toggle("is-error", type === "error");
  statusEl.classList.toggle("is-success", type === "success");
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Required UI element is missing: ${selector}`);
  }

  return element;
}

function downloadText(fileName: string, content: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
