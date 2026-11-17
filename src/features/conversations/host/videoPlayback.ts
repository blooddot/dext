import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import type { DextStorage } from "../../../platform/vscode/dextStorage.js";

/** VS Code's Chromium has no H.265/HEVC decoder, and no flag or store extension
 * adds one, so a file the player refuses is converted once to H.264 and played
 * from the copy. */
const CACHE_DIR = "video-cache";
/** Enough for the videos one conversation still argues about, small enough to
 * forget about. */
const CACHE_FILES = 3;
/** Dext does not ship a decoder: 100 MB of FFmpeg in a VS Code extension costs
 * more than the one video it would rescue. */
const INSTALL_HINT = "This video's codec cannot be played in the editor, and converting it needs FFmpeg."
  + " Run `winget install Gyan.FFmpeg`, restart VS Code, and open the video again.";

const converting = new Map<string, Promise<vscode.Uri>>();

/** Where converted copies live: global storage, never the workspace or the
 * attachments directory, because they are only a cache. */
export function videoCache(storage: DextStorage): vscode.Uri {
  return vscode.Uri.joinPath(storage.globalStorageUri, CACHE_DIR);
}

/** The copy the player can decode. Keyed by path, size and mtime, so the same
 * video converts once and an edited one converts again. */
export async function playableVideo(storage: DextStorage, source: vscode.Uri): Promise<vscode.Uri> {
  const copy = await copyOf(storage, source);
  if (await isFile(copy.fsPath)) return copy;
  // Two tabs on the same video convert it once.
  const running = converting.get(copy.fsPath);
  if (running) return running;
  const conversion = convert(source.fsPath, copy.fsPath)
    .then(() => copy)
    .finally(() => converting.delete(copy.fsPath));
  converting.set(copy.fsPath, conversion);
  return conversion;
}

/** A copy already converted by an earlier visit, if there is one. A caller that
 * cannot afford to convert on its own (an agent asking for stills) takes this or
 * the original and nothing else. */
export async function cachedVideo(storage: DextStorage, source: vscode.Uri): Promise<vscode.Uri | undefined> {
  const copy = await copyOf(storage, source);
  return (await isFile(copy.fsPath)) ? copy : undefined;
}

async function copyOf(storage: DextStorage, source: vscode.Uri): Promise<vscode.Uri> {
  const info = await stat(source.fsPath);
  const key = createHash("sha1").update(`${source.fsPath}:${info.size}:${info.mtimeMs}`).digest("hex").slice(0, 16);
  return vscode.Uri.joinPath(videoCache(storage), `${key}.mp4`);
}

async function convert(input: string, output: string): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  // A killed conversion must not look like a finished copy to the next open.
  const partial = `${output}.part`;
  try {
    // H.264 + AAC is what every Chromium plays. Subtitles and data streams are
    // dropped: mp4 would refuse them, and nobody annotates them.
    await ffmpeg([
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", input,
      "-map", "0:v:0", "-map", "0:a?", "-sn", "-dn",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
      partial
    ]);
  } catch (failure) {
    await rm(partial, { force: true });
    throw failure;
  }
  await rename(partial, output);
  await prune(dirname(output));
}

function ffmpeg(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [...args], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-600); });
    child.once("error", (failure: NodeJS.ErrnoException) =>
      reject(failure.code === "ENOENT" ? new Error(INSTALL_HINT) : failure));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg could not convert this video. ${stderr.trim().split("\n").pop() ?? ""}`.trim()));
    });
  });
}

/** Oldest copies go first; a panel still playing one has already fetched it. */
async function prune(directory: string): Promise<void> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".mp4"));
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(directory, name))).mtimeMs })));
  dated.sort((left, right) => right.at - left.at);
  await Promise.all(dated.slice(CACHE_FILES).map((older) => rm(join(directory, older.name), { force: true })));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
