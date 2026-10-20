import type { ReaderApi } from "./projectReader.js";
import { startProjectReader } from "./projectReader.js";

const root = document.querySelector<HTMLElement>("[data-project-reader]");
const api = (window as Window & { __dextApi?: ReaderApi }).__dextApi;
if (root && api) startProjectReader(root, api);
