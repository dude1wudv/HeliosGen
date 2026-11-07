"use client";
import WorkflowDashboard from "@/components/WorkflowDashboard";
import { useSpaceSync } from "@/lib/useSpaceSync";
import { WorkflowSyncGate } from "@/components/WorkflowSyncGate";

export default function WorkflowPage() {
  const { loaded, loadError, retryLoad } = useSpaceSync();
  return <WorkflowSyncGate loaded={loaded} error={loadError} retry={retryLoad}><WorkflowDashboard /></WorkflowSyncGate>;
}
