/** Provider-level access used internally for conversations and typed calls. */
export type AgentPermission = "read-only" | "workspace-write" | "full-access";

/** Agent and Plan expose write scopes only. Ask is the dedicated read-only
 * mode; the internal `read-only` permission remains available to it and to
 * preview-only typed Agent calls. */
export type WritableAgentPermission = Exclude<AgentPermission, "read-only">;
