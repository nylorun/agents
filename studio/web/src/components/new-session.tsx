import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentView } from "@nylorun/agents";
import { NEW_SESSION } from "@/session-open";
import { sessionPath } from "@/session-list";

/**
 * Starts a new session on `agent` (protocol 16): a new session id under the Agent's route, opened
 * with Studio's own New session state, so the session page creates it
 * (`PUT /v1/sessions/{id} { agent }`). The session runs on the Agent: its compute, its vault's
 * credentials, and the manifest version it runs, which the session pins.
 */
export function useStartSession(): (agent: Pick<AgentView, "id">) => void {
  const navigate = useNavigate();
  return useCallback(
    (agent: Pick<AgentView, "id">) =>
      void navigate(sessionPath(agent.id, crypto.randomUUID()), { state: NEW_SESSION }),
    [navigate],
  );
}
