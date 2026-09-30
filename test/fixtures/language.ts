import { ask } from "dext";

const a = await ask({ input: "x" });
console.log(a.text);
console.error("boom");
