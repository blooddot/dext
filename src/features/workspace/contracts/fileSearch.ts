import { z } from "zod";
export const fileSearchRequestSchema = z.object({ type: z.literal("searchFiles"), requestId: z.number().int().nonnegative(), query: z.string().max(120) });
export type FileSearchRequest = z.infer<typeof fileSearchRequestSchema>;
export interface FileSearchResponse { type: "searchFilesResult"; requestId: number; files: string[] }
