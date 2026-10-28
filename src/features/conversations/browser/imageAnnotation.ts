/** Pixel space of the original attachment, origin top-left. Marks and the text
 * an Agent reads are both expressed in these coordinates. */
export interface ImagePixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface ImageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImagePoint {
  x: number;
  y: number;
}

export type ImageMark =
  | { kind: "region"; box: ImageBox; note: string }
  | { kind: "point"; point: ImagePoint; note: string };

/** Where the picture is drawn, in whatever pixel space the caller renders in. */
export interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Channel difference that still counts as one flat UI block. Only affects how
 * well hover-select fits; typing a note never depends on it. */
const COLOR_TOLERANCE = 18;
const MIN_BLOCK_RATIO = 0.002;
/** The page background is one huge flat region, and hovering it should select
 * nothing rather than the whole screenshot. */
const MAX_BLOCK_RATIO = 0.55;
const MAX_BLOCKS = 1500;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function displayToImage(display: DisplayRect, natural: Size, point: ImagePoint): ImagePoint {
  if (display.width <= 0 || display.height <= 0) return { x: 0, y: 0 };
  return {
    x: clamp(Math.round(((point.x - display.left) / display.width) * natural.width), 0, natural.width - 1),
    y: clamp(Math.round(((point.y - display.top) / display.height) * natural.height), 0, natural.height - 1)
  };
}

export function imageBoxToDisplay(display: DisplayRect, natural: Size, box: ImageBox): DisplayRect {
  const scaleX = display.width / natural.width;
  const scaleY = display.height / natural.height;
  const left = clamp(box.x, 0, natural.width);
  const top = clamp(box.y, 0, natural.height);
  const right = clamp(box.x + box.width, left, natural.width);
  const bottom = clamp(box.y + box.height, top, natural.height);
  return {
    left: display.left + left * scaleX,
    top: display.top + top * scaleY,
    width: (right - left) * scaleX,
    height: (bottom - top) * scaleY
  };
}

/** Bounding boxes of flat colour regions, so hovering a button selects the
 * button instead of the pixel under the cursor. */
export function detectBlocks(pixels: ImagePixels): ImageBox[] {
  const { width, height, data } = pixels;
  const total = width * height;
  if (!width || !height || data.length < total * 4) return [];
  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  const minArea = Math.max(1, Math.floor(total * MIN_BLOCK_RATIO));
  const maxArea = Math.floor(total * MAX_BLOCK_RATIO);
  const blocks: ImageBox[] = [];
  for (let start = 0; start < total; start++) {
    if (visited[start]) continue;
    const seed = start << 2;
    const red = data[seed] ?? 0;
    const green = data[seed + 1] ?? 0;
    const blue = data[seed + 2] ?? 0;
    const same = (index: number): boolean => {
      const at = index << 2;
      return Math.abs((data[at] ?? 0) - red) <= COLOR_TOLERANCE
        && Math.abs((data[at + 1] ?? 0) - green) <= COLOR_TOLERANCE
        && Math.abs((data[at + 2] ?? 0) - blue) <= COLOR_TOLERANCE;
    };
    let top = 0;
    stack[top++] = start;
    visited[start] = 1;
    let count = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    while (top) {
      const index = stack[--top]!;
      const x = index % width;
      const y = (index - x) / width;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && !visited[index - 1] && same(index - 1)) { visited[index - 1] = 1; stack[top++] = index - 1; }
      if (x + 1 < width && !visited[index + 1] && same(index + 1)) { visited[index + 1] = 1; stack[top++] = index + 1; }
      if (y > 0 && !visited[index - width] && same(index - width)) { visited[index - width] = 1; stack[top++] = index - width; }
      if (y + 1 < height && !visited[index + width] && same(index + width)) { visited[index + width] = 1; stack[top++] = index + width; }
    }
    if (count < minArea || count > maxArea) continue;
    blocks.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
    if (blocks.length >= MAX_BLOCKS) break;
  }
  return blocks;
}

/** The smallest block under the cursor: a button inside a card wins over the card. */
export function pickBlock(blocks: readonly ImageBox[], point: ImagePoint): ImageBox | undefined {
  let best: ImageBox | undefined;
  for (const block of blocks) {
    if (point.x < block.x || point.y < block.y) continue;
    if (point.x >= block.x + block.width || point.y >= block.y + block.height) continue;
    if (!best || block.width * block.height < best.width * best.height) best = block;
  }
  return best;
}

/** The box a drag spans. Pure and tested: a zero-size box here is what silently
 * drops hand-drawn regions. */
export function boxFromPoints(from: ImagePoint, to: ImagePoint): ImageBox {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y)
  };
}

export function composeAnnotationText(imagePath: string, marks: readonly ImageMark[]): string {
  const lines = marks.map((mark, index) => {
    const where = mark.kind === "region"
      ? `region (${mark.box.x},${mark.box.y})-(${mark.box.x + mark.box.width},${mark.box.y + mark.box.height})`
      : `point (${mark.point.x},${mark.point.y})`;
    const note = mark.note.trim();
    return `${index + 1}. ${where}${note ? `: ${note}` : ""}`;
  });
  return [`Image annotations for @${imagePath} (pixel coordinates, origin top-left):`, ...lines].join("\n");
}
