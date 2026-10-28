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

/** The annotator samples pixels on a canvas, which a `vscode-webview` image URL
 * would taint, so the host hands out the bytes as a `data:` URL instead. */
export async function attachmentImageDataUrl(storage: DextStorage, relativePath: string): Promise<string> {
  const uri = storage.uriForReference("attachments", relativePath.replaceAll("\\", "/"));
  const mimeType = uri ? IMAGE_MIME_TYPES[extname(uri.fsPath).toLowerCase()] : undefined;
  if (!uri || !mimeType) throw new Error("That attachment is not a Dext image.");
  const bytes = await vscode.workspace.fs.readFile(uri);
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}
