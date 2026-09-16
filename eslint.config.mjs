import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["main.js", "node_modules/**", "coverage/**"] },
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			globals: globals.browser,
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
		},
		rules: {
			"@typescript-eslint/consistent-type-imports": "error"
		}
	}
);

