/**
 * The one import point of the workspace modules' client files (D801, D832). Lanes fill their own
 * `src/<module>/module.tsx`; nothing here changes when a module ships.
 */
import { module as forms } from "../forms/module";
import { module as time } from "../time/module";
import { module as goals } from "../goals/module";
import { module as checkins } from "../checkins/module";
import { module as crm } from "../crm/module";
import { module as bookings } from "../bookings/module";
import { module as townhall } from "../townhall/module";
import { registerWorkspaceClientModule } from "./registry";

for (const module of [forms, time, goals, checkins, crm, bookings, townhall]) registerWorkspaceClientModule(module);

export * from "./registry";
export * from "./types";
