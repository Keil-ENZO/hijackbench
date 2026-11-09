import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./src/store/schema.ts",
	// Inside src: the Docker image ships src only, migrations included.
	out: "./src/store/migrations",
});
