// @ts-expect-error GateSleep is an internal alias; gate decisions remain part of ToolHooks.
import type { GateSleep } from "../src/index.ts";

export type InternalGateSleep = GateSleep;
