// Shared Monaco theme so every editor surface (code panel, diff viewers)
// renders with the same warm palette.

export const IW_DARK_THEME = {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#201317",
    "editorGutter.background": "#201317",
    "editor.lineHighlightBackground": "#2a181d",
    "editorLineNumber.foreground": "#7a5a52",
    "editorLineNumber.activeForeground": "#f6c177",
    "editorCursor.foreground": "#f4a261",
    "editor.selectionBackground": "#7a4a3a66",
    "editor.inactiveSelectionBackground": "#7a4a3a33",
    "editor.selectionHighlightBackground": "#7a4a3a44",
    "editorWidget.background": "#2a181d",
    "editorWidget.border": "#43272e",
    "editorSuggestWidget.background": "#2a181d",
    "editorHoverWidget.background": "#2a181d",
    "editorIndentGuide.background1": "#3a252b",
    "editorIndentGuide.activeBackground1": "#5a3a3a",
    "editorWhitespace.foreground": "#3a252b",
    "scrollbarSlider.background": "#4a2c3380",
    "scrollbarSlider.hoverBackground": "#65394180",
    "diffEditor.insertedTextBackground": "#3f6b4a55",
    "diffEditor.removedTextBackground": "#8a3b3b55",
  },
};

export function defineIwTheme(monaco) {
  monaco.editor.defineTheme("iw-dark", IW_DARK_THEME);
  monaco.editor.setTheme("iw-dark");
}
