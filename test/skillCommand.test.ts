import { describe, expect, it } from "vitest";
import { expandCommandArguments, parseCommandMetadata, parseCommandSource } from "../src/features/workflow/domain/skillCommand.js";
import { canonicalCommandToken, splitCommandInput } from "../src/features/workflow/contracts/skill.js";

describe("command metadata", () => {
  it("reads description, argument hint and skill mapping", () => {
    const command = parseCommandMetadata("---\ndescription: Review changes\nargument-hint: <paths>\nskill: ponytail-review\nagent: build\n---\n\nReview $ARGUMENTS.");
    expect(command).toMatchObject({
      description: "Review changes",
      argumentHint: "<paths>",
      skillId: "ponytail-review",
      body: "Review $ARGUMENTS.",
      unsupportedKeys: [],
      ignoredKeys: ["agent"]
    });
  });

  it("marks unknown front matter and positional arguments unavailable", () => {
    const unknown = parseCommandSource("deploy", "---\ndescription: Deploy\nallowed-tools: Bash\n---\nDeploy.");
    expect(unknown.supported).toBe(false);
    expect(unknown.diagnostics.join(" ")).toMatch(/Unsupported command front matter: allowed-tools/);

    const positional = parseCommandSource("review", "Review $1 against $2.");
    expect(positional.supported).toBe(false);
    expect(positional.unsupported).toEqual(["positional arguments ($1-$9) are not supported"]);

    const bash = parseCommandSource("run", "Run $(git status)\n! rm -rf build");
    expect(bash.supported).toBe(false);
    expect(bash.unsupported).toEqual([
      "shell or variable expansion is not supported",
      "shell execution (!) is not supported"
    ]);
  });

  it("accepts a plain prompt template", () => {
    const command = parseCommandSource("ponytail-review", "# Review\n\nReview the current change.");
    expect(command).toMatchObject({ id: "ponytail-review", title: "Review", supported: true });
  });

  it("accepts markdown code spans and an unquoted description with a colon", () => {
    const command = parseCommandSource("ponytail-debt", "---\ndescription: Harvest `shortcut:` comments: into a ledger\n---\n\nGrep for `shortcut:` markers.");
    expect(command.supported).toBe(true);
    expect(command.description).toBe("Harvest `shortcut:` comments: into a ledger");
  });

  it("rejects an empty command and an invalid id", () => {
    const command = parseCommandSource("bad/id", "---\ndescription: Empty\n---\n");
    expect(command.supported).toBe(false);
    expect(command.diagnostics.join(" ")).toMatch(/Invalid command id/);
    expect(command.diagnostics.join(" ")).toMatch(/no prompt body/);
  });
});

describe("expandCommandArguments", () => {
  it("replaces every $ARGUMENTS placeholder", () => {
    expect(expandCommandArguments("Review $ARGUMENTS, then explain $ARGUMENTS.", "src/a.ts")).toBe("Review src/a.ts, then explain src/a.ts.");
  });

  it("appends arguments when the template has no placeholder", () => {
    expect(expandCommandArguments("Review the change.", "src/a.ts")).toBe("Review the change.\n\nsrc/a.ts");
    expect(expandCommandArguments("Review the change.", "  ")).toBe("Review the change.");
  });
});

describe("canonical command token", () => {
  it("normalizes the slash form and rejects prose slashes", () => {
    expect(canonicalCommandToken("/ponytail-review")).toBe("/ponytail-review");
    expect(canonicalCommandToken("  /review   src/a.ts")).toBe("/review");
    expect(canonicalCommandToken("please /review")).toBeUndefined();
    expect(canonicalCommandToken("/review/deeper")).toBeUndefined();
  });

  it("splits the token from the arguments", () => {
    expect(splitCommandInput("/review src/a.ts")).toEqual({ token: "/review", commandId: "review", arguments: "src/a.ts" });
    expect(splitCommandInput("plain text")).toBeUndefined();
  });
});
