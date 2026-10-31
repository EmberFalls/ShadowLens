import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { mockClient } from "./api/mock.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App client={mockClient} mode="MOCK" /></React.StrictMode>,
);
