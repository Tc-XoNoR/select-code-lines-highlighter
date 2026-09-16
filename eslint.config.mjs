import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
	globalIgnores([
		"node_modules",
		"coverage",
		"esbuild.config.mjs",
		"main.js",
		"manifest.json",
		"package.json",
		"versions.json"
	]),
	{
		languageOptions: {
			globals: { ...globals.browser },
			parserOptions: {
				projectService: { allowDefaultProject: ["eslint.config.mjs"] },
				tsconfigRootDir: import.meta.dirname
			}
		}
	},
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		rules: {
			"@typescript-eslint/consistent-type-imports": "error",
			"obsidianmd/settings-tab/prefer-setting-definitions": "off"
		}
	}
);
