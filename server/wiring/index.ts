/**
 * Wave 3 wiring (lane W3-WIRE, docs/plan/WORKSPACE_MODULES.md §D.8, D1040–D1059): flows that need two
 * finished modules and belong to neither. Imported once by server/workspaceModules.ts after every
 * module, so each module's registries are ready. Each file names its §C flow and decision.
 */
import "./tasksCrm";
import "./tasksGoals";
import "./standupGoals";
import "./proposals";
