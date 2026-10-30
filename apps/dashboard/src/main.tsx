import React from "react";
import { createRoot } from "react-dom/client";
import { LiveDashboard } from "./LiveDashboard.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<React.StrictMode><LiveDashboard /></React.StrictMode>);
