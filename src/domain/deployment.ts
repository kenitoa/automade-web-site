export interface DeploymentSettings {
  endpoint: string;
  allowedHost: string;
  secretRef: string;
  publicOrigin: string;
}
export interface DeploymentEntry {
  id: string;
  requestKey: string;
  releaseId: string;
  revision: number;
  sha256: string;
  status: "preparing" | "verifying" | "verified" | "failed" | "unknown";
  operation: "publish" | "rollback";
  deploymentId: string | null;
  createdAt: string;
  verifiedAt: string | null;
  errorCode: string | null;
}
export interface DeploymentState {
  settings: DeploymentSettings | null;
  configured: boolean;
  history: DeploymentEntry[];
}
