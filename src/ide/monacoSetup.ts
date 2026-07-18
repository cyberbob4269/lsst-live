// Monaco is bundled locally — no CDN. The ESM build is handed to the React
// wrapper via loader.config, and web workers resolve through Vite ?worker
// imports. Only editor + TypeScript workers are wired; other languages fall
// back to the editor worker (syntax highlighting is in-process anyway).

import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "typescript" || label === "javascript") {
      return new TsWorker();
    }
    return new EditorWorker();
  },
};

loader.config({ monaco });
