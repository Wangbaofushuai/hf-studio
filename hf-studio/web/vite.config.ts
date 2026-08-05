import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 公网部署：绑 0.0.0.0 才能通过服务器公网 IP 访问（默认只绑 localhost）
    host: "0.0.0.0",
    proxy: { "/api": "http://localhost:8787" },
  },
});
