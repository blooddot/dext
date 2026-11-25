import { apply } from "./apply.ts";
import { archive } from "./archive.ts";
import { explore } from "./explore.ts";
import { propose } from "./propose.ts";
import { sync } from "./sync.ts";
import { update } from "./update.ts";

export const spec = { propose, apply, archive, explore, update, sync };
