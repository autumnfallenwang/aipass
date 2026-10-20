import * as generated from "./auth-schema.ts";

/** Better Auth's tables (generated). Passed to Better Auth's Drizzle adapter. */
export const authSchema = generated;
export const users = generated.user;
