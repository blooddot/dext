import { describe, expect, it } from "vitest";
import {
  boxFromPoints,
  clampZoom,
  composeAnnotationText,
  detectBlocks,
  displayToImage,
  fitScale,
  imageBoxToDisplay,
  keepAnchor,
  pickBlock,
  type ImagePixels
} from "../src/features/conversations/browser/imageAnnotation.js";

/** 40x20: a dark left half (too big to be a block), a light right half with a
 * darker 6x6 button inside it. */
function syntheticPixels(): ImagePixels {
  const width = 40, height = 20;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const button = x >= 28 && x <= 33 && y >= 9 && y <= 14;
      const shade = x < 24 ? 20 : button ? 40 : 220;
      data[at] = shade; data[at + 1] = shade; data[at + 2] = shade; data[at + 3] = 255;
    }
  }
  return { width, height, data };
}

describe("image annotation coordinates", () => {
  it("maps a displayed point to original image pixels and back", () => {
    const display = { left: 0, top: 0, width: 800, height: 400 };
    const natural = { width: 1600, height: 800 };
    expect(displayToImage(display, natural, { x: 200, y: 100 })).toEqual({ x: 400, y: 200 });
    expect(imageBoxToDisplay(display, natural, { x: 400, y: 200, width: 200, height: 100 }))
      .toEqual({ left: 200, top: 100, width: 100, height: 50 });
  });

  it("clamps to the image when the pointer leaves it or the image is offset", () => {
    const display = { left: 100, top: 50, width: 400, height: 200 };
    const natural = { width: 800, height: 400 };
    expect(displayToImage(display, natural, { x: 100, y: 50 })).toEqual({ x: 0, y: 0 });
    expect(displayToImage(display, natural, { x: 900, y: 900 })).toEqual({ x: 799, y: 399 });
    // The result keeps the caller's space: an offset image still draws at its offset.
    expect(imageBoxToDisplay(display, natural, { x: -10, y: -10, width: 200, height: 200 }))
      .toEqual({ left: 100, top: 50, width: 95, height: 95 });
  });
});

describe("detectBlocks", () => {
  it("keeps the button and the panel but drops the oversized background", () => {
    expect(detectBlocks(syntheticPixels())).toEqual([
      { x: 24, y: 0, width: 16, height: 20 },
      { x: 28, y: 9, width: 6, height: 6 }
    ]);
  });

  it("picks the smallest block under the cursor", () => {
    const blocks = detectBlocks(syntheticPixels());
    expect(pickBlock(blocks, { x: 30, y: 10 })).toEqual({ x: 28, y: 9, width: 6, height: 6 });
    expect(pickBlock(blocks, { x: 25, y: 2 })).toEqual({ x: 24, y: 0, width: 16, height: 20 });
    expect(pickBlock(blocks, { x: 10, y: 10 })).toBeUndefined();
  });

  it("returns nothing for mismatched pixel data", () => {
    expect(detectBlocks({ width: 4, height: 4, data: new Uint8ClampedArray(4) })).toEqual([]);
  });
});

describe("boxFromPoints", () => {
  it("gives a real box for a drag in any direction", () => {
    expect(boxFromPoints({ x: 40, y: 429 }, { x: 106, y: 494 }))
      .toEqual({ x: 40, y: 429, width: 66, height: 65 });
    expect(boxFromPoints({ x: 106, y: 494 }, { x: 40, y: 429 }))
      .toEqual({ x: 40, y: 429, width: 66, height: 65 });
  });
});

describe("zoom", () => {
  it("fits a large picture down and leaves a small one at its own size", () => {
    expect(fitScale({ width: 2560, height: 1440 }, { width: 1280, height: 720 })).toBe(0.5);
    expect(fitScale({ width: 2560, height: 1440 }, { width: 1280, height: 2000 })).toBe(0.5);
    expect(fitScale({ width: 200, height: 100 }, { width: 1280, height: 720 })).toBe(1);
    expect(fitScale({ width: 0, height: 0 }, { width: 1280, height: 720 })).toBe(1);
    expect(clampZoom(1000)).toBe(8);
    expect(clampZoom(0)).toBe(0.05);
  });

  it("keeps the pixel under the cursor while the picture grows around it", () => {
    // A 1000x500 picture shown at 1000px, then at 2000px, both starting at the same point.
    const before = { left: 0, top: 0, width: 1000, height: 500 };
    const after = { left: 0, top: 0, width: 2000, height: 1000 };
    // The pointer sits a quarter across the picture: it must stay a quarter across.
    const scroll = keepAnchor(before, after, { x: 250, y: 125 }, { left: 0, top: 0 });
    expect(scroll).toEqual({ left: 250, top: 125 });
    expect({ x: after.left + 0.25 * after.width - scroll.left, y: after.top + 0.25 * after.height - scroll.top })
      .toEqual({ x: 250, y: 125 });
  });
});

describe("composeAnnotationText", () => {
  it("writes one numbered line per mark and omits an empty note", () => {
    const text = composeAnnotationText(".dext/attachments/a.png", [
      { kind: "region", box: { x: 1002, y: 156, width: 462, height: 228 }, note: " make the rate red" },
      { kind: "point", point: { x: 1830, y: 80 }, note: "" }
    ]);
    expect(text).toBe([
      "Image annotations for @.dext/attachments/a.png (pixel coordinates, origin top-left):",
      "1. region (1002,156)-(1464,384): make the rate red",
      "2. point (1830,80)"
    ].join("\n"));
  });
});
