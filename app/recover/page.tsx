"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { parseWorkflowRecovery } from "@/lib/workflowRecovery";
import { useWorkflowStore } from "@/lib/store";
import { useSpaceSync } from "@/lib/useSpaceSync";
import { importWorkflowZip } from "@/lib/importWorkflow";

export default function RecoverWorkflows() {
  const { loaded, loadError, retryLoad, recoveryBackup } = useSpaceSync();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function importFile(file?: File) {
    if (!file || busy || !loaded) return;
    setBusy(true);
    setMessage("");
    try {
      const zipped = file.name.toLowerCase().endsWith(".zip");
      const imported = zipped ? await importWorkflowZip(file) : null;
      if (imported?.skipped) throw new Error(`有 ${imported.skipped} 个媒体未能导入，未创建工作流。请保留原 ZIP 后重试。`);
      const workflows = imported ? [{ ...imported, name: `${imported.name}（导入副本）` }] : parseWorkflowRecovery(await file.text());
      for (const workflow of workflows) {
        useWorkflowStore.getState().createSpace(workflow.name, workflow);
        const current = useWorkflowStore.getState();
        if (workflow.viewport) {
          useWorkflowStore.setState({ spaces: current.spaces.map((space) => space.id === current.activeSpaceId ? { ...space, viewport: workflow.viewport } : space) });
        }
      }
      setMessage(`已导入 ${workflows.length} 个工作流副本。原文件和已有工作流均已保留；请核对媒体及同步状态。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导入失败，请保留原文件后重试。");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return <main className="mx-auto w-full max-w-2xl overflow-auto p-6 md:p-10">
    <h1 className="text-2xl font-semibold">恢复旧画布工作流</h1>
    <p className="my-5 text-sm leading-6 text-white/70">在旧域恢复页导出本地工作流后，在这里导入。每个工作流都会创建独立副本，不覆盖已有内容；媒体仍按当前账户验证访问权限。</p>
    {loadError ? <p role="alert" className="my-4 text-sm">{loadError} <button className="underline" onClick={retryLoad}>重试加载</button></p>
      : !loaded && <p role="status" className="my-4 text-sm">正在读取当前账户工作流，完成前暂停导入与自动保存…</p>}
    {recoveryBackup && <p className="my-4 text-sm">发现未确认归属的本机工作流，已单独保留，未自动合并到当前账户。<button className="ml-2 underline" onClick={() => {
      const url = URL.createObjectURL(new Blob([recoveryBackup], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "helios-unclaimed-workflows.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }}>导出本机恢复文件</button></p>}
    <label className="block rounded-xl border border-white/20 p-5">选择恢复文件（JSON）或完整工作流（ZIP）
      <input ref={input} className="mt-4 block w-full text-sm" type="file" accept=".json,.zip,application/json,application/zip" disabled={busy || !loaded} onChange={(event) => { void importFile(event.target.files?.[0]); }} />
    </label>
    {busy && <p role="status" className="mt-4">正在导入副本…</p>}
    {message && <p role="status" className="mt-4 rounded-xl border border-white/20 p-4 text-sm">{message}</p>}
    <Link className="mt-8 inline-block underline" href="/workflow">返回工作流</Link>
  </main>;
}
