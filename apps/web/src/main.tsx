import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import "./rc1.css";
import "./rc2.css";

if (window.localFileTransfer) {
   document.documentElement.classList.add("desktop-transfer-document");
}

createRoot(document.getElementById("root") as HTMLElement).render(
   <React.StrictMode>
      <App />
   </React.StrictMode>
);
