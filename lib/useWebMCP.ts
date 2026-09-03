"use client";

import { useEffect, useRef, useState } from "react";
import { createWebMCPTools, type ModelContextTool, type WebMCPConfig } from "./webmcp-tools";

interface ModelContext {
  registerTool: (tool: ModelContextTool, options?: { signal?: AbortSignal }) => Promise<void> | void;
}

declare global {
  interface Document { modelContext?: ModelContext; }
}

export type WebMCPStatus = "checking" | "ready" | "unavailable" | "blocked" | "error" | "signed-out";

export function useWebMCP(config: WebMCPConfig, enabled = true): WebMCPStatus {
  const latest = useRef(config);
  const [status, setStatus] = useState<WebMCPStatus>("checking");
  useEffect(() => { latest.current = config; }, [config]);

  useEffect(() => {
    if (!enabled) {
      const disabledTimer = window.setTimeout(() => setStatus("signed-out"), 0);
      return () => window.clearTimeout(disabledTimer);
    }
    if (window.top !== window.self) {
      const blockedTimer = window.setTimeout(() => setStatus("blocked"), 0);
      return () => window.clearTimeout(blockedTimer);
    }
    const controllers: AbortController[] = [];
    let stopped = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const register = async () => {
      if (stopped) return;
      const context = document.modelContext;
      if (!context) {
        attempts += 1;
        if (attempts < 60) timer = setTimeout(register, 250);
        else setStatus("unavailable");
        return;
      }
      try {
        const tools = createWebMCPTools(() => latest.current);
        await Promise.all(tools.map(async (tool) => {
          const controller = new AbortController(); controllers.push(controller);
          await context.registerTool(tool, { signal: controller.signal });
        }));
        if (!stopped) setStatus("ready");
      } catch {
        controllers.splice(0).forEach((controller) => controller.abort());
        if (!stopped) setStatus("error");
      }
    };
    void register();
    return () => { stopped = true; if (timer) clearTimeout(timer); controllers.forEach((controller) => controller.abort()); };
  }, [enabled]);
  return status;
}
