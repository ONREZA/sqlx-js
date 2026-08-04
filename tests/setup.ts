import { Temporal } from "@js-temporal/polyfill";

(globalThis as typeof globalThis & { Temporal?: typeof Temporal }).Temporal ??= Temporal;
