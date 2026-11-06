/** One recorded API call a Code retry may replay instead of running again. */
export interface DextReplayEntry {
  method: string;
  arguments: Record<string, unknown>;
  response: unknown;
}
