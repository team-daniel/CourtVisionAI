import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        home: resolve(__dirname, "index.html"),
        notFound: resolve(__dirname, "404.html"),

        upload: resolve(
          __dirname,
          "pages/upload.html",
        ),

        history: resolve(
          __dirname,
          "pages/history.html",
        ),

        session: resolve(
          __dirname,
          "pages/session.html",
        ),
      },
    },
  },
});