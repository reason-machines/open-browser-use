import { homedir } from "node:os";
import { join } from "node:path";

/** ~/Library/Application Support/Reason/browser/<profile>/ (brand dir from OBU_BRAND_DIR, default "Reason"). */
export function agentDir(profile: string, brandDir: string = process.env.OBU_BRAND_DIR ?? "Reason"): string {
  return join(homedir(), "Library", "Application Support", brandDir, "browser", profile);
}

export function agentSocketPath(profile: string): string {
  return join(agentDir(profile), "agent.sock");
}

export function agentTokenPath(profile: string): string {
  return join(agentDir(profile), "agent.token");
}
