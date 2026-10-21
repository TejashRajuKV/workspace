import tailwindcss from "@tailwindcss/postcss";

// Vite (and any other PostCSS host) resolves plugin entries itself; importing
// the plugin explicitly keeps the config portable across ESM loaders.
export default {
  plugins: [tailwindcss],
};