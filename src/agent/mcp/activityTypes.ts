import type { QuoteCitation } from "../../shared/types";
import type { AgentActionReceipt } from "../contracts/types";
import type {
  TrustedReadObservation,
  VerifiedReadSource,
} from "../plans/types";
import type { AgentToolArtifact } from "../types";

export type ZoteroMcpToolActivityEvent = {
  requestId: string;
  runId?: string;
  conversationGeneration?: number;
  phase: "started" | "completed";
  toolName: string;
  toolLabel?: string;
  serverName: string;
  arguments?: unknown;
  ok?: boolean;
  error?: string;
  artifacts?: AgentToolArtifact[];
  actionReceipts?: AgentActionReceipt[];
  mutability?: "read" | "write";
  profileSignature?: string;
  conversationKey?: number;
  libraryID?: number;
  kind?: "global" | "paper";
  quoteCitations?: QuoteCitation[];
  verifiedReadSources?: VerifiedReadSource[];
  readObservations?: readonly TrustedReadObservation[];
  timestamp: number;
};
