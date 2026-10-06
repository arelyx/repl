import { useEffect, useState } from "react";
import { templatesApi } from "@/lib/repls";
import type { Template } from "@/lib/types";

let cache: Template[] | null = null;

export function useTemplates() {
  const [templates, setTemplates] = useState<Template[] | null>(cache);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (cache) return;
    templatesApi
      .list()
      .then((t) => {
        cache = t;
        setTemplates(t);
      })
      .catch((e) => setError(String(e?.message ?? e)));
  }, []);
  return { templates, error };
}

export const CATEGORY_LABELS: Record<string, string> = {
  language: "Languages",
  web: "Web servers",
  framework: "Frameworks",
  static: "Static sites",
  gui: "GUI apps",
};

export const CATEGORY_ORDER = ["language", "web", "framework", "static", "gui"];
