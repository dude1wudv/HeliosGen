"use client";

import type { ReactNode } from "react";

export function WorkflowSyncGate({ loaded, error, retry, children }: {
  loaded: boolean; error: string; retry: () => void; children: ReactNode;
}) {
  if (loaded) return children;
  return <main className="mx-auto w-full max-w-2xl p-8">
    <h1 className="text-xl font-semibold">读取账户工作流</h1>
    {error ? <><p role="alert" className="my-5 text-sm leading-6">{error} 读取成功前已暂停自动保存，本机数据仍保留。</p>
      <button className="rounded-xl border border-white/20 px-4 py-2" onClick={retry}>重试加载</button></>
      : <p role="status" className="my-5 text-sm">正在读取服务器数据，完成后再开启编辑与自动保存…</p>}
  </main>;
}
