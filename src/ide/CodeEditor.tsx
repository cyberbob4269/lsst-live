import Editor from "@monaco-editor/react";
import { languageFor } from "./fileKinds";
import "./monacoSetup";

interface CodeEditorProps {
  path: string;
  content: string;
  onChange(value: string): void;
  onSave(): void;
  onCursor(line: number, col: number): void;
  /** Called once on mount with a getter for the current selection text
   *  (null when empty) — IdeView uses it for the chat workspace context. */
  onMountEditor?(getSelection: () => string | null): void;
}

/**
 * Monaco for the active file. The `path` prop gives each file its own model,
 * and @monaco-editor/react saves/restores the view state (cursor, scroll)
 * per model when switching tabs.
 */
export default function CodeEditor({ path, content, onChange, onSave, onCursor, onMountEditor }: CodeEditorProps) {
  return (
    <Editor
      path={path}
      value={content}
      language={languageFor(path)}
      theme="vs-dark"
      onChange={(value) => onChange(value ?? "")}
      onMount={(editor, monaco) => {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave);
        editor.onDidChangeCursorPosition((e) => onCursor(e.position.lineNumber, e.position.column));
        onMountEditor?.(() => {
          const model = editor.getModel();
          const selection = editor.getSelection();
          if (!model || !selection || selection.isEmpty()) return null;
          return model.getValueInRange(selection);
        });
      }}
      options={{
        automaticLayout: true,
        fontSize: 13,
        fontFamily: "Cascadia Code, Consolas, monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: 4,
        insertSpaces: true,
        renderWhitespace: "selection",
        padding: { top: 8 },
      }}
    />
  );
}
