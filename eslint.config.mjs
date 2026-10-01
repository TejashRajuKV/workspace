import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [...nextCoreWebVitals, {
  rules: {
    "react-hooks/exhaustive-deps": "off",
    "react/no-unescaped-entities": "off",
    "@next/next/no-img-element": "off",
    "prefer-const": "off",
    "no-unused-vars": "off",
    "no-console": "off",
    "no-empty": "off",
    "no-case-declarations": "off",
    "no-fallthrough": "off",
  },
}, {
  ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "examples/**", "skills", "mini-services/**", "public/monaco/**", "scripts/**", "tests/**", "docs/**"]
}];

export default eslintConfig;
