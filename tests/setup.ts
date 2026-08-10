import { Temporal } from "temporal-polyfill";

(globalThis as typeof globalThis & { Temporal?: typeof Temporal }).Temporal ??= Temporal;
