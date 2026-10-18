/**
 * Renders the PWA icon set from the vector definition below.
 *
 * Icons are checked in under public/ — this script exists so they can be
 * regenerated after a brand change rather than re-exported by hand.
 *
 *   node scripts/generate-icons.mjs
 *
 * Requires Playwright's Chromium (already a devDependency for the UI tests).
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Matches --brand in app/globals.css. */
const BRAND = "#2a55d4";
const BRAND_DARK = "#1e40ae";
const CANVAS = 512;

/**
 * The 3x3 board, drawn in a 512-unit space and scaled by the caller.
 *
 * `pad` is the margin left around the grid. Maskable icons need the art inside
 * the inner 80% safe zone, so they use a larger pad than the `any` icons —
 * Android crops maskable icons to a circle, a squircle or a teardrop, and any
 * tighter grid would have its outer corners sheared off.
 */
function boardSvg({ pad, stroke }) {
  const side = CANVAS - pad * 2;
  const cell = side / 3;
  const line = (i) => pad + cell * i;

  return `
    <g>
      ${[0, 1, 2, 3]
        .map(
          (i) =>
            `<line x1="${line(i)}" y1="${pad}" x2="${line(i)}" y2="${
              pad + side
            }" stroke="white" stroke-width="${stroke}" />`
        )
        .join("")}
      ${[0, 1, 2, 3]
        .map(
          (i) =>
            `<line x1="${pad}" y1="${line(i)}" x2="${
              pad + side
            }" y2="${line(i)}" stroke="white" stroke-width="${stroke}" />`
        )
        .join("")}
      <rect x="${pad}" y="${pad}" width="${side}" height="${side}"
            fill="none" stroke="white" stroke-width="${
              stroke * 1.6
            }" stroke-linejoin="round" />
      <rect x="${line(1)}" y="${line(0)}" width="${cell}" height="${cell}"
            fill="white" />
    </g>`;
}

/**
 * @param variant "any"     — rounded plate, art inset, used by desktop/Android launchers.
 * @param variant "maskable" — full bleed background, art inside the 80% safe zone.
 * @param variant "apple"    — full bleed, no rounding: iOS applies its own mask and
 *                             composites transparent corners onto black.
 */
function markup(variant, size) {
  const maskable = variant === "maskable";
  const plate = maskable || variant === "apple" ? "0" : CANVAS * 0.22;
  const pad = maskable ? 118 : 110;

  // The art stays in the 512-unit viewBox; only the rendered size changes, so
  // every icon in the set is the same drawing at a different resolution.
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: transparent; }
  svg { display: block; }
</style></head>
<body>
  <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"
       viewBox="0 0 ${CANVAS} ${CANVAS}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${BRAND}" />
        <stop offset="100%" stop-color="${BRAND_DARK}" />
      </linearGradient>
    </defs>
    <rect width="${CANVAS}" height="${CANVAS}" rx="${plate}" fill="url(#bg)" />
    ${boardSvg({ pad, stroke: 18 })}
  </svg>
</body></html>`;
}

const TARGETS = [
  // iOS home screen icon. iOS masks and composites this itself, so it must be
  // opaque and full bleed.
  { file: "apple-touch-icon.png", size: 180, variant: "apple" },
  { file: "icon-192.png", size: 192, variant: "any" },
  { file: "icon-512.png", size: 512, variant: "any" },
  { file: "icon-maskable-192.png", size: 192, variant: "maskable" },
  { file: "icon-maskable-512.png", size: 512, variant: "maskable" },
];

const browser = await chromium.launch();
try {
  await mkdir(OUT_DIR, { recursive: true });
  const page = await browser.newPage({ viewport: { width: CANVAS, height: CANVAS } });

  for (const { file, size, variant } of TARGETS) {
    await page.setContent(markup(variant, size));
    const element = await page.locator("svg");
    await element.screenshot({ path: join(OUT_DIR, file), omitBackground: true });
    console.log(`public/${file}  ${size}x${size}`);
  }
} finally {
  await browser.close();
}