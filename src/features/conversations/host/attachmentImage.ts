import { extname } from "node:path";
import * as vscode from "vscode";
import type { DextStorage } from "../../../platform/vscode/dextStorage.js";

/** The reverse of `imageExtension` in `app/sidebarProvider.ts`: an attachment's
 * file extension is what says whether the annotator can open it at all. */
export const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp"
};

/** Videos are attachments too, and open in the same annotation tab, where the
 * page plays them instead of painting a still. */
export const VIDEO_MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm"
};

export function isVideoAttachment(path: string): boolean {
  return Boolean(VIDEO_MIME_TYPES[extname(path).toLowerCase()]);
}

/** The annotator samples pixels on a canvas, which a `vscode-webview` image URL
 * would taint, so the host hands out the bytes as a `data:` URL instead. */
export async function attachmentImageDataUrl(storage: DextStorage, relativePath: string): Promise<string> {
  const uri = storage.uriForReference("attachments", relativePath.replaceAll("\\", "/"));
  const mimeType = uri ? IMAGE_MIME_TYPES[extname(uri.fsPath).toLowerCase()] : undefined;
  if (!uri || !mimeType) throw new Error("That attachment is not a Dext image.");
  const bytes = await vscode.workspace.fs.readFile(uri);
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}
